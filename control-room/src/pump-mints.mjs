// A pool of pre-ground mint keypairs whose address ends with the Autonom suffix —
// the same brand mark pump.fun ("pump") and Bonk ("bonk") stamp on their coins, so
// anyone can tell where a coin was launched by looking at its mint. Grinding runs in a
// low-priority child process (tools/pump-mint-grinder.mjs); the pool lives beside the
// other secrets (mode 0600). A mint's secret is used exactly once, to co-sign its own
// create_v2, and is deleted from the pool once the launch is confirmed.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { DATA_DIR, env } from "./env.mjs";
import { base58Encode, isSolanaAddress } from "./solana.mjs";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{1,6}$/;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const fail = (message, code) => Object.assign(new Error(message), { code });

/// The suffix every Autonom mint ends with. Four base58 characters take ~11 million
/// tries (a few seconds on the server's cores); five would take fifty times longer.
export const MINT_SUFFIX = (() => { const s = env("PUMP_MINT_SUFFIX", "meta"); if (!B58.test(s)) throw fail("PUMP_MINT_SUFFIX must be 1..6 base58 characters", "pump_suffix_invalid"); return s; })();
export const POOL_TARGET = Math.max(1, Math.min(64, Number(env("PUMP_MINT_POOL", "8")) || 8));
/// Grinder processes run in parallel while the pool is short (each ≈ one core at nice 19).
export const POOL_WORKERS = Math.max(1, Math.min(8, Number(env("PUMP_MINT_WORKERS", "4")) || 4));
export const RESERVATION_TTL_MS = 60 * 60_000;
const GRINDER = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "pump-mint-grinder.mjs");

export const hasSuffix = (address, suffix = MINT_SUFFIX) => typeof address === "string" && address.endsWith(suffix);

/// A `{ address, sign }` signer from a 32-byte ed25519 seed; the key stays in the closure.
export function signerFromSeed(seedBase64) {
  const seed = Buffer.from(String(seedBase64 || ""), "base64");
  if (seed.length !== 32) throw fail("mint seed is corrupt", "pump_mint_corrupt");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const address = base58Encode(Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url"));
  return Object.freeze({ address, chain: "solana", sign: async (message) => Uint8Array.from(edSign(null, Buffer.from(message), key)) });
}

/// The pool. `path` and `spawnGrinder` are injectable for tests; production uses the defaults.
export function createMintPool({ path = join(DATA_DIR, "secrets", "pump-mints.json"), suffix = MINT_SUFFIX, target = POOL_TARGET, workers = POOL_WORKERS, spawnGrinder = defaultSpawn, now = Date.now } = {}) {
  const empty = () => ({ version: 1, suffix, mints: [] });
  const read = () => {
    if (!existsSync(path)) return empty();
    let j = null;
    try { j = JSON.parse(readFileSync(path, "utf8")); } catch { j = null; }
    if (!j || typeof j !== "object" || !Array.isArray(j.mints) || j.mints.some((m) => !m || typeof m.address !== "string" || typeof m.seed !== "string")) {
      // The pool is a regenerable cache: park the unreadable file and start again rather than crash the gateway.
      try { renameSync(path, `${path}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`); } catch { /* nothing to park */ }
      return empty();
    }
    if (j.suffix !== suffix) return empty();   // a suffix change retires the old pool
    return j;
  };
  const write = (j) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path + ".tmp", JSON.stringify(j, null, 1), { mode: 0o600 });
    renameSync(path + ".tmp", path);
    chmodSync(path, 0o600);
  };
  const free = (j) => j.mints.filter((m) => !m.reservedBy || now() - Date.parse(m.reservedAt || 0) > RESERVATION_TTL_MS);
  let children = [], stopped = false;

  function add(address, seedBase64) {
    if (!isSolanaAddress(address) || !hasSuffix(address, suffix)) return false;
    const signer = signerFromSeed(seedBase64);
    if (signer.address !== address) return false;      // never file a seed that does not produce its address
    const j = read();
    if (j.mints.some((m) => m.address === address)) return false;
    j.mints.push({ address, seed: seedBase64, createdAt: new Date(now()).toISOString() });
    write(j);
    return true;
  }
  /// Reserves one free mint for a launch id and returns its signer; the same id gets the same mint back.
  function reserve(id) {
    const j = read();
    let m = j.mints.find((x) => x.reservedBy === id) || free(j)[0];
    if (!m) return null;
    m.reservedBy = id; m.reservedAt = new Date(now()).toISOString();
    write(j);
    return signerFromSeed(m.seed);
  }
  function release(id) { const j = read(); for (const m of j.mints) if (m.reservedBy === id) { delete m.reservedBy; delete m.reservedAt; } write(j); }
  /// Deletes the mint once its create_v2 is on chain: the secret is never needed again.
  function consume(id) { const j = read(); j.mints = j.mints.filter((m) => m.reservedBy !== id); write(j); }
  function status() { const j = read(); return { suffix, target, ready: free(j).length, reserved: j.mints.length - free(j).length, grinding: children.length > 0, workers: children.length }; }

  function attach(child) {
    let buf = "";
    child.stdout.on("data", (d) => {
      try {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const [address, seed] = buf.slice(0, i).trim().split(/\s+/); buf = buf.slice(i + 1);
          if (status().ready >= target) { stop(); break; }     // a burst never overfills the pool
          try { add(address, seed); } catch { /* a bad line is dropped */ }
        }
      } catch { /* a pool file problem is parked by read(); the next line is handled fresh */ }
    });
    child.on("exit", () => { children = children.filter((c) => c !== child); });
    child.on("error", () => { children = children.filter((c) => c !== child); });
    return child;
  }
  /// Keeps `target` free mints ready; `workers` grinders run only while the pool is short.
  function tick() {
    if (stopped) return;
    try {
      const short = status().ready < target;
      if (short) { while (children.length < workers) children.push(attach(spawnGrinder(suffix))); }
      else if (children.length) stop();
    } catch (e) { console.error("[pump-mints]", String(e.message || e).slice(0, 160)); }
  }
  function stop() { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } children = []; }
  function start(everyMs = 30_000) { stopped = false; tick(); const timer = setInterval(tick, everyMs); return () => { stopped = true; clearInterval(timer); stop(); }; }
  return Object.freeze({ path, suffix, target, workers, add, reserve, release, consume, status, tick, start, stop });
}

function defaultSpawn(suffix) {
  const args = [process.execPath, GRINDER, suffix];
  const child = spawn("nice", ["-n", "19", ...args], { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => { /* no `nice`: the caller's next tick respawns without it */ });
  return child;
}

let shared = null;
export const mintPool = () => (shared ||= createMintPool());
