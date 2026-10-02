// Public launches on pump.fun. The launcher's own wallet pays rent and a small gas seed
// for the AI wallet; the project's treasury is the coin's `creator` (so the creator fee
// is the AI's from the first trade); the mint ends with the Autonom suffix (so anyone
// can see where the coin came from). prepare() reserves a mint, files a pending treasury,
// uploads the metadata and returns a transaction the launcher signs in their wallet;
// confirm() proves the landed transaction is ours and files the project; reconcile()
// finishes launches the browser never confirmed. No key of ours pays.
//
// Lifecycle rule (review 2026-09-21): once a mint has been embedded in a transaction that
// left the server, it is never returned to the free pool — it is consumed on success and on
// abandonment alike, because a copy of that transaction may still land.
import { createHash, randomBytes } from "node:crypto";
import { get, save, event } from "./store.mjs";
import { env } from "./env.mjs";
import * as wallets from "./wallets.mjs";
import * as pump from "./pump.mjs";
import { mintPool as defaultPool, MINT_SUFFIX, hasSuffix } from "./pump-mints.mjs";
import { partialSign, instructions as sys, isSolanaAddress, isSolanaSignature, base58Decode, base58Encode, DEFAULT_COMPUTE_UNIT_PRICE, LAMPORTS_PER_SOL, LOOKUP_TABLE_PROGRAM } from "./solana.mjs";
import { solanaRpc } from "./solana-billing.mjs";
import { quotePlan } from "./plan.mjs";
import { summary } from "./launch.mjs";
import { newLaunchPackage, assertLaunchPackage, publicLaunchPackage } from "./launch-package.mjs";
import { registerSolanaProject, ensurePlan, SOLSCAN } from "./launch-solana.mjs";
import { tokenKey } from "./solana-auth.mjs";
import { normalizeLaunchLogo } from "./launch-logo.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
// No up-front SOL from the creator to the AI wallet (owner 2026-09-25: "önden 0.02 sol veriyor onu kes").
// The wallet pays its first creator-fee sweep (0.00005 SOL) from the first deposit it receives.
export const GAS_SEED_LAMPORTS = 0;
export const CREATE_COMPUTE_UNITS = 250_000;        // a real create_v2 used ~105k
export const FIRST_BUY_COMPUTE_UNITS = 400_000;
export const MAX_FIRST_BUY_LAMPORTS = 100_000_000_000n;
// Public Pump table seen in our pinned CreateV2+BuyV2 receipt. Its immutable prefix is
// read and validated on every use; no table is created and no authority is delegated.
export const FIRST_BUY_LOOKUP_TABLE = "Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP";
export const RENT_ESTIMATE_LAMPORTS = 5_700_000;    // mint + curve token account + mayhem state, measured 2026-09-21
export const LOGO_MAX_BYTES = 500 * 1024;           // base64 logo travels in the JSON body (1 MB cap)
export const MEMO_PREFIX = "metahuman.launch v1";
export const FIRST_BUY_MEMO = "autonom"; // preserve packet space for full-length metadata
export const PENDING_TTL_MS = 60 * 60_000;
export const FRESH_TX_MS = 45_000;                  // a blockhash is good for ~60–90 s; re-sign after this
export const MAX_PENDING = 16;                      // unconfirmed launches the server keeps at once
export const PREPARE_GAP_MS = 60_000, PREPARE_PER_IP_10MIN = 4, PREPARES_PER_HOUR = 60, PER_WALLET_MS = 10 * 60_000;
const ID_RE = /^[0-9a-f]{16}$/;
const recent = { byWallet: new Map(), prepares: new Map(), byIp: new Map(), all: [] };
const preparing = new Map();
const MAGIC = [["image/png", "89504e47"], ["image/jpeg", "ffd8ff"], ["image/gif", "47494638"], ["image/webp", "52494646"]];

export const launchesEnabled = () => env("PUMP_LAUNCH_ENABLED", "1") === "1";
const pendingKey = (id) => `pending:pump:${id}`;
const pendingOf = () => { const s = get(); s.pendingPumpLaunches ||= {}; return s.pendingPumpLaunches; };
const pendingById = (id) => { const p = pendingOf(); return ID_RE.test(id) && Object.hasOwn(p, id) ? p[id] : null; };   // never an inherited key
const keyOf = (k) => (typeof k === "string" ? k : k?.pubkey);
let infoCache = null;

export function parseFirstBuySol(value = "0") {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,9})?$/.test(value)) throw fail(400, "first buy must be a SOL decimal with at most 9 decimal places");
  const [whole, fraction = ""] = value.split(".");
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (lamports > MAX_FIRST_BUY_LAMPORTS) throw fail(400, "first buy must be 0–100 SOL");
  const tail = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return { firstBuySol: `${lamports / 1_000_000_000n}${tail ? `.${tail}` : ""}`, firstBuyLamports: lamports.toString() };
}

const ixProof = ix => ({ programId: ix.programAddress, accounts: ix.accounts.map(a => a.address), data: base58Encode(ix.data) });
async function verifiedFirstBuyTable(rpc) {
  const info = await rpc.getAccountInfo(FIRST_BUY_LOOKUP_TABLE, { encoding: "base64", commitment: "confirmed" });
  if (!info || info.owner !== LOOKUP_TABLE_PROGRAM || info.executable === true || !Array.isArray(info.data) || info.data[1] !== "base64") throw fail(503, "Pump first-buy address table could not be verified");
  const b = Buffer.from(info.data[0], "base64");
  if (b.length < 88 || b.length > 56 + 256 * 32 || (b.length - 56) % 32 || b.readUInt32LE(0) !== 1 || b.readBigUInt64LE(4) !== (1n << 64n) - 1n) throw fail(503, "Pump first-buy address table is invalid or deactivated");
  const slot = await rpc.call("getSlot", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(slot) || BigInt(slot) <= b.readBigUInt64LE(12)) throw fail(503, "Pump first-buy address table is not active yet");
  const addresses = [];
  for (let i = 56; i < b.length; i += 32) addresses.push(base58Encode(b.subarray(i, i + 32)));
  return { [FIRST_BUY_LOOKUP_TABLE]: addresses };
}

async function readPumpAccount(rpc, address, owner, name) {
  const info = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" });
  if (!info || info.owner !== owner || info.executable === true || !Array.isArray(info.data) || info.data[1] !== "base64") throw fail(503, `Pump ${name} could not be verified`);
  const bytes = Buffer.from(info.data[0], "base64");
  const disc = createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
  if (bytes.length < 8 || bytes.length > 16384 || !bytes.subarray(0, 8).equals(disc)) throw fail(503, `Pump ${name} has an invalid layout`);
  return bytes;
}

// Spend is a HARD upper bound including Pump fees. Exact-output tokens are reduced by
// 1% so configuration/rounding cannot silently raise the user's SOL authorization.
// Create and buy are atomic: no other trade can change this newly created curve.
export function quoteFirstBuy(global, feeConfig, maxLamports) {
  const cap = BigInt(maxLamports);
  if (cap <= 0n || cap > MAX_FIRST_BUY_LAMPORTS) throw fail(400, "first buy must be greater than 0 and at most 100 SOL");
  const curve = { virtualTokenReserves: global.initialVirtualTokenReserves, virtualQuoteReserves: global.initialVirtualSolReserves, realTokenReserves: global.initialRealTokenReserves, tokenTotalSupply: global.tokenTotalSupply };
  if (Object.values(curve).some(n => typeof n !== "bigint" || n <= 0n) || curve.realTokenReserves >= curve.virtualTokenReserves) throw fail(503, "Pump initial reserves could not be verified");
  const fees = pump.feeTierFor(feeConfig, pump.marketCapLamports(curve));
  if ([fees.protocolFeeBps, fees.creatorFeeBps].some(n => typeof n !== "bigint" || n < 0n || n > 10_000n)) throw fail(503, "Pump fees could not be verified");
  const total = sol => sol + (sol * fees.protocolFeeBps + 9999n) / 10000n + (sol * fees.creatorFeeBps + 9999n) / 10000n;
  let lo = 0n, hi = cap;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (total(mid) <= cap) lo = mid; else hi = mid - 1n; }
  let tokens = lo * curve.virtualTokenReserves / (curve.virtualQuoteReserves + lo);
  if (tokens > curve.realTokenReserves) tokens = curve.realTokenReserves;
  tokens = tokens * 9900n / 10000n;
  if (tokens <= 0n) throw fail(400, "first buy is too small to receive tokens after fees");
  return { tokenAmount: tokens.toString(), maxSolCost: cap.toString(), protocolFeeBps: fees.protocolFeeBps.toString(), creatorFeeBps: fees.creatorFeeBps.toString() };
}

async function firstBuyQuote(pend, rpc) {
  const global = pump.decodeGlobal(await readPumpAccount(rpc, await pump.pdas.global(), pump.PUMP_PROGRAM, "Global"));
  const fees = pump.decodeFeeConfig(await readPumpAccount(rpc, await pump.pdas.feeConfig(), pump.PUMP_FEE_PROGRAM, "FeeConfig"));
  if (!global.initialized || !global.createV2Enabled) throw fail(503, "Pump coin creation is not enabled");
  const volume = await rpc.getAccountInfo(await pump.pdas.userVolumeAccumulator(pend.creator), { encoding: "base64", commitment: "confirmed" });
  if (volume && volume.owner !== pump.PUMP_PROGRAM) throw fail(503, "Pump buyer volume account could not be verified");
  return { ...quoteFirstBuy(global, fees, pend.firstBuyLamports), ...pump.pickFeeRecipients(global, 0), initializeVolume: !volume };
}

function checkFields(p) {
  const name = String(p.name || "").trim(), symbol = String(p.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (name.length < 2 || name.length > pump.NAME_MAX) throw fail(400, `name must be 2–${pump.NAME_MAX} characters`);
  if (symbol.length < 2 || symbol.length > 10) throw fail(400, "symbol must be 2–10 letters or digits");
  if (Object.values(get().tokens).some((t) => t.symbol === symbol)) throw fail(409, `$${symbol} is already launched here — pick another symbol`);
  const description = String(p.description || "").trim().slice(0, 400);
  const link = (v, what) => { const s = String(v || "").trim(); if (s && !/^https:\/\/[^\s]{1,190}$/.test(s)) throw fail(400, `${what} must be an https:// link`); return s; };
  return { name, symbol, description, website: link(p.website, "website"), twitter: link(p.twitter, "twitter"), telegram: link(p.telegram, "telegram") };
}

/// The logo arrives as base64 (a data URL is accepted); bytes are typed by their magic number.
export function decodeLogo(value) {
  const text = String(value || "").replace(/^data:image\/[a-z]+;base64,/, "").trim();
  if (!text) throw fail(400, "a logo image is required");
  if (text.length > Math.ceil(LOGO_MAX_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/=]+$/.test(text)) throw fail(400, `logo must be a PNG, JPEG, GIF or WebP up to ${LOGO_MAX_BYTES / 1024} KB`);
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) throw fail(400, `logo must be 1 byte to ${LOGO_MAX_BYTES / 1024} KB`);
  const head = bytes.subarray(0, 4).toString("hex");
  const type = MAGIC.find(([, magic]) => head.startsWith(magic))?.[0];
  if (!type) throw fail(400, "logo must be a PNG, JPEG, GIF or WebP image");
  return { bytes: Uint8Array.from(bytes), type };
}

/// Limits count PREPARES (not only confirmed launches): per wallet, per IP, globally, and by
/// how many unconfirmed launches the server already holds.
function rateLimit(wallet, ip, now = Date.now()) {
  recent.all = recent.all.filter((t) => now - t < 3_600_000);
  if (recent.all.length >= PREPARES_PER_HOUR) throw fail(429, "too many launches right now — try again in a while");
  const lastPrepare = recent.prepares.get(wallet) || 0;
  if (now - lastPrepare < PREPARE_GAP_MS) throw fail(429, "wait a minute before preparing another launch from this wallet");
  const lastLaunch = recent.byWallet.get(wallet) || 0;
  if (now - lastLaunch < PER_WALLET_MS) throw fail(429, `this wallet launched ${Math.round((now - lastLaunch) / 60_000)} min ago — wait ${Math.ceil((PER_WALLET_MS - (now - lastLaunch)) / 60_000)} min`);
  if (ip) {
    const hits = (recent.byIp.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    if (hits.length >= PREPARE_PER_IP_10MIN) throw fail(429, "too many launch attempts from this connection — try again later");
    recent.byIp.set(ip, [...hits, now]);
  }
  const open = Object.values(pendingOf()).filter((p) => !p.token && !p.failed).length;
  if (open >= MAX_PENDING) throw fail(503, "the launchpad is busy with unconfirmed launches — try again in a few minutes");
  recent.prepares.set(wallet, now); recent.all.push(now);
}

/// The launch transaction: gas seed to the treasury, create_v2 with the treasury as creator,
/// a memo naming the platform and the treasury. Fee payer = the launcher; the reserved mint co-signs.
async function buildLaunchTransaction(pend, mintSigner, rpc) {
  if (mintSigner.address !== pend.mint) throw fail(503, "the reserved mint changed under this launch");
  const buying = BigInt(pend.firstBuyLamports || "0") > 0n;
  const lookupTables = buying ? await verifiedFirstBuyTable(rpc) : {};
  if (buying && !pend.firstBuyQuote) pend.firstBuyQuote = await firstBuyQuote(pend, rpc);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const create = await pump.createV2({ mint: pend.mint, user: pend.creator, creator: pend.treasury, name: pend.name, symbol: pend.symbol, uri: pend.metadataUri });
  const instructions = [...(GAS_SEED_LAMPORTS > 0 ? [sys.systemTransfer(pend.creator, pend.treasury, GAS_SEED_LAMPORTS)] : []), create];
  if (buying) {
    const q = pend.firstBuyQuote;
    if (q.maxSolCost !== pend.firstBuyLamports) throw fail(409, "the saved first-buy amount changed; start a new launch");
    instructions.push(await pump.createAtaIdempotent({ payer: pend.creator, owner: pend.creator, mint: pend.mint }));
    if (q.initializeVolume) instructions.push(await pump.initUserVolumeAccumulator({ payer: pend.creator, user: pend.creator }));
    instructions.push(await pump.buyV2({ mint: pend.mint, user: pend.creator, creator: pend.treasury, feeRecipient: q.feeRecipient, buybackFeeRecipient: q.buybackFeeRecipient, amount: q.tokenAmount, maxSolCost: pend.firstBuyLamports }));
  }
  instructions.push(sys.memo(buying ? FIRST_BUY_MEMO : `${MEMO_PREFIX} ${pend.treasury}`));
  const message = pump.buildMessage({ feePayer: pend.creator, blockhash, lastValidBlockHeight, instructions, computeUnitLimit: buying ? FIRST_BUY_COMPUTE_UNITS : CREATE_COMPUTE_UNITS, computeUnitPrice: DEFAULT_COMPUTE_UNIT_PRICE, lookupTables });
  const { wire } = await partialSign(message, mintSigner);
  if (Buffer.from(wire, "base64").length > 1232) throw fail(400, "launch transaction is too large; shorten the coin name or choose no first buy");
  if (buying) {
    const simulated = await rpc.simulateTransaction(wire, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
    if (!simulated || simulated.err != null) throw fail(409, "Pump create + first buy simulation failed. Check your SOL balance including rent and network fees, or choose no first buy");
  }
  return { transaction: wire, blockhash, lastValidBlockHeight, bondingCurve: create.bondingCurve, builtAt: new Date().toISOString(),
    ...(buying ? { expectedInstructions: message.instructions.map(ixProof) } : {}) };
}

function response(pend) {
  const firstBuy = parseFirstBuySol(pend.firstBuySol || "0"), buying = BigInt(firstBuy.firstBuyLamports) > 0n;
  const buyAccountRentEstimateLamports = buying ? 6_000_000 : 0;
  const networkFeeEstimateLamports = 10_000 + Math.ceil((buying ? FIRST_BUY_COMPUTE_UNITS : CREATE_COMPUTE_UNITS) * DEFAULT_COMPUTE_UNIT_PRICE / 1e6);
  return { id: pend.id, mint: pend.mint, treasury: pend.treasury, suffix: pend.suffix, transaction: pend.tx.transaction, blockhash: pend.tx.blockhash, lastValidBlockHeight: pend.tx.lastValidBlockHeight,
    builtAt: pend.tx.builtAt, freshForMs: FRESH_TX_MS, metadataUri: pend.metadataUri, memo: buying ? FIRST_BUY_MEMO : `${MEMO_PREFIX} ${pend.treasury}`,
    costs: { gasSeedLamports: GAS_SEED_LAMPORTS, rentEstimateLamports: RENT_ESTIMATE_LAMPORTS, buyAccountRentEstimateLamports, networkFeeEstimateLamports, ...firstBuy,
      totalEstimateSol: (GAS_SEED_LAMPORTS + RENT_ESTIMATE_LAMPORTS + buyAccountRentEstimateLamports + networkFeeEstimateLamports + Number(firstBuy.firstBuyLamports)) / LAMPORTS_PER_SOL },
    firstBuy: buying ? { maxSolCost: pend.firstBuyLamports, tokenAmount: pend.firstBuyQuote.tokenAmount, recipient: pend.creator, atomic: true } : null,
    launchPackage: publicLaunchPackage({ launchPackage: pend.launchPackage }), plan: pend.plan };
}

/// Reserves a mint and a treasury, uploads the metadata, builds and mint-signs the transaction.
export async function prepare(body, { rpc = solanaRpc(), pool = defaultPool(), upload = pump.uploadMetadata, quote = quotePlan, ip = null, now = Date.now } = {}) {
  if (!launchesEnabled()) throw fail(503, "pump.fun launches are switched off right now");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "launch fields required");
  const allowed = ["creator", "name", "symbol", "description", "website", "twitter", "telegram", "logo", "model", "offerId", "launchPackageVersion", "firstBuySol"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, "unexpected launch field");
  if (body.launchPackageVersion !== newLaunchPackage().version) throw fail(400, "Launch package changed. Refresh and review the current package before launching");
  for (const key of ["creator", "name", "symbol", "description", "website", "twitter", "telegram", "logo", "model"]) if (Object.hasOwn(body, key) && typeof body[key] !== "string") throw fail(400, `launch ${key} must be text`);
  const creator = String(body.creator || "");
  if (!isSolanaAddress(creator)) throw fail(400, "creator must be a Solana wallet address");
  const fields = checkFields(body);
  const firstBuy = parseFirstBuySol(body.firstBuySol);
  const logo = decodeLogo(body.logo);
  const model = String(body.model || ""), offerId = Number(body.offerId);
  if (!model || model.length > 160 || !Number.isSafeInteger(offerId) || offerId <= 0) throw fail(400, "valid model and machine are required");
  const launchPackage = assertLaunchPackage(newLaunchPackage());
  const requestHash = createHash("sha256").update(JSON.stringify({ creator, ...fields, logo: createHash("sha256").update(logo.bytes).digest("hex"), model, offerId, v: launchPackage.version, ...(firstBuy.firstBuyLamports !== "0" ? { firstBuyLamports: firstBuy.firstBuyLamports } : {}) })).digest("hex");
  const pending = pendingOf();
  const again = Object.values(pending).find((p) => p.requestHash === requestHash && !p.token && !p.failed);
  if (again) {
    // A launch whose transaction may already be on chain is never re-signed: the client resumes confirm.
    if (again.signature || again.mintOnChain) return { ...response(again), duplicate: true, resume: true, signature: again.signature || null };
    if (now() - Date.parse(again.tx.builtAt) < FRESH_TX_MS) return { ...response(again), duplicate: true };
    again.tx = await buildLaunchTransaction(again, pool.reserve(again.id), rpc); save();   // same mint and treasury, fresh blockhash
    return { ...response(again), duplicate: true, rebuilt: true };
  }
  if (preparing.has(requestHash)) return { ...await preparing.get(requestHash), duplicate: true };
  rateLimit(creator, ip, now());
  const operation = (async () => {
    // Validate and retain site artwork before allocating any wallet or mint.
    const logoPng = await normalizeLaunchLogo(logo.bytes);
    const runtime = await quote({ model, offerId });
    const plan = { activationUsd: launchPackage.activationMicros / 1e6, runtimeActivationUsd: runtime.activationUsd, dailyUsd: runtime.dailyUsd, modelName: runtime.modelName, machine: runtime.machine, dph: runtime.dph ?? null };
    const id = randomBytes(8).toString("hex");
    const mintSigner = pool.reserve(id);
    if (!mintSigner) throw fail(503, "no Autonom address is ready yet — try again in a minute");
    if (!hasSuffix(mintSigner.address, pool.suffix)) { pool.release(id); throw fail(503, "the mint pool handed out an address without the Autonom suffix"); }
    try {
      const treasury = wallets.createSolanaTreasury(pendingKey(id));
      const { metadataUri } = await upload({ name: fields.name, symbol: fields.symbol, description: fields.description, image: logo.bytes, imageType: logo.type, website: fields.website || undefined, twitter: fields.twitter || undefined, telegram: fields.telegram || undefined });
      const pend = { id, creator, ...fields, ...firstBuy, model, offerId, treasury, mint: mintSigner.address, suffix: pool.suffix, metadataUri, logoPng, requestHash, launchPackage, plan, createdAt: new Date(now()).toISOString(), signature: null, signatures: [], token: null, failed: false, mintOnChain: false };
      pend.tx = await buildLaunchTransaction(pend, mintSigner, rpc);
      pending[id] = pend; save();
      return response(pend);
    } catch (e) { pool.release(id); throw e; }   // nothing left the server: the mint may be reused
  })();
  preparing.set(requestHash, operation);
  try { return await operation; } finally { preparing.delete(requestHash); }
}

/// Proves a landed transaction is THIS launch: first signature, fee payer = launcher, a
/// create_v2 whose mint is the reserved mint, whose payer is the launcher and whose creator
/// argument is the pending treasury. Only then is the on-chain outcome (meta.err, seed) read.
function proveLaunch(pend, signature, tx) {
  const msg = tx.transaction?.message || {};
  const keys = [...(msg.accountKeys || []).map(keyOf), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const instructions = (msg.instructions || []).map(ins => typeof ins.programIdIndex === "number" ? {
    programId: keys[ins.programIdIndex], accounts: (ins.accounts || []).map(i => keys[i]), data: ins.data,
  } : { programId: keyOf(ins.programId), accounts: (ins.accounts || []).map(keyOf), data: ins.data });
  if (tx.transaction?.signatures?.[0] !== signature) return { ok: false, reason: "the transaction's first signature differs" };
  if (keys[0] !== pend.creator) return { ok: false, reason: "the launch was paid by a different wallet" };
  if (BigInt(pend.firstBuyLamports || "0") > 0n && !Array.isArray(pend.tx.expectedInstructions)) return { ok: false, reason: "the first-buy authorization proof is missing" };
  if (pend.tx.expectedInstructions && JSON.stringify(instructions) !== JSON.stringify(pend.tx.expectedInstructions)) return { ok: false, reason: "the launch instructions or first-buy amount differ from the wallet authorization" };
  const create = instructions.find((ins) => ins.programId === pump.PUMP_PROGRAM && typeof ins.data === "string" && Buffer.from(base58Decode(ins.data)).subarray(0, 8).equals(Buffer.from(pump.DISCRIMINATORS.create_v2)));
  if (!create) return { ok: false, reason: "no create_v2 in this transaction" };
  const accounts = (create.accounts || []).map(keyOf);
  if (accounts[0] !== pend.mint || accounts[5] !== pend.creator) return { ok: false, reason: "create_v2 names a different mint or payer" };
  const data = Buffer.from(base58Decode(create.data));
  let o = 8; for (let i = 0; i < 3; i++) o += 4 + data.readUInt32LE(o);
  if (base58Encode(data.subarray(o, o + 32)) !== pend.treasury) return { ok: false, reason: "create_v2 names a different creator than the project treasury" };
  if (tx.meta?.err != null) return { ok: true, landed: false, err: tx.meta.err };
  const iTreasury = keys.indexOf(pend.treasury);
  const seed = iTreasury >= 0 && Array.isArray(tx.meta?.preBalances) ? tx.meta.postBalances[iTreasury] - tx.meta.preBalances[iTreasury] : 0;
  if (GAS_SEED_LAMPORTS > 0 && seed < GAS_SEED_LAMPORTS) return { ok: false, reason: "the AI wallet did not receive its gas seed" };
  return { ok: true, landed: true };
}

async function register(pend, signature, slot, { pool, index }) {
  const existing = get().tokens[tokenKey("solana", pend.mint)];
  if (existing) { pend.token = pend.mint; save(); pool.consume(pend.id); return existing; }
  const launchPackageSnapshot = pend.launchPackage === undefined ? undefined : assertLaunchPackage(pend.launchPackage);
  wallets.aliasTreasury(pendingKey(pend.id), pend.mint);
  const t = await registerSolanaProject({ mint: pend.mint, name: pend.name, symbol: pend.symbol, description: pend.description, creator: pend.creator, treasuryWallet: pend.treasury, projectLogoPng: pend.logoPng || null, launchPackageSnapshot, withPackage: launchPackageSnapshot !== undefined, model: pend.model, offerId: pend.offerId, planRequest: { model: pend.model, offerId: pend.offerId, gpu: pend.plan?.machine || null, dph: pend.plan?.dph ?? null }, index,
    onchain: { pons: false, solana: true, pump: true, token: pend.mint, mint: pend.mint, decimals: pump.TOKEN_DECIMALS, supply: "1000000000000000", program: pump.TOKEN_2022_PROGRAM, bondingCurve: pend.tx.bondingCurve, pool: pend.tx.bondingCurve, excludedHolders: [pend.tx.bondingCurve], explorer: `${SOLSCAN}/token/${pend.mint}`, pumpUrl: `https://pump.fun/coin/${pend.mint}`, launchTx: signature, launchSlot: slot ?? null },
    launchIdentity: { version: 1, kind: "pump", by: "creator", suffix: pend.suffix, launchTx: signature, metadataUri: pend.metadataUri, logo: null },
    eventText: `${pend.symbol} launched ON PUMP.FUN by ${pend.creator.slice(0, 8)}… (mint ${pend.mint.slice(0, 8)}…, creator fee → treasury ${pend.treasury.slice(0, 8)}…)` });
  if (pend.website) t.domain = pend.website.replace(/^https:\/\//, "");
  pend.token = t.address; pend.signature = signature; save();
  pool.consume(pend.id);
  recent.byWallet.set(pend.creator, Date.now()); recent.all.push(Date.now());
  return t;
}

/// Reads one signature and settles the pending from it. Returns
/// { status: 'done'|'pending'|'failed'|'foreign', ... } and never touches the pending on 'foreign'.
async function settle(pend, signature, { rpc, pool, index }) {
  // Raw compiled instructions retain the ATA bytes, unlike jsonParsed. Resolve their
  // indices with the receipt's loaded addresses before matching the stored proof.
  const tx = await rpc.getTransaction(signature, { commitment: "confirmed", encoding: pend.tx.expectedInstructions ? "json" : "jsonParsed", maxSupportedTransactionVersion: 0 });
  if (!tx) return { status: "pending" };
  const proof = proveLaunch(pend, signature, tx);
  if (!proof.ok) return { status: "foreign", reason: proof.reason };
  if (proof.landed) { const t = await register(pend, signature, tx.slot, { pool, index }); return { status: "done", channel: summary(t) }; }
  // Our transaction, but it failed on chain. The mint stays reserved: an earlier copy may have
  // landed (checked by reconcile), and a retry re-uses the same mint with a fresh blockhash.
  pend.lastFailure = { signature, err: proof.err, at: new Date().toISOString() }; save();
  return { status: "failed", retry: true };
}

/// Called by the page after the wallet sent the transaction. Idempotent per signature.
export async function confirm(body, { rpc = solanaRpc(), pool = defaultPool(), index = null } = {}) {
  const pend = pendingById(String(body?.id || ""));
  if (!pend) throw fail(404, "unknown or expired launch — start again");
  const signature = String(body?.signature || pend.signature || "");
  if (!isSolanaSignature(signature)) throw fail(400, "signature is required");
  if (pend.token) return { status: "done", channel: summary(get().tokens[tokenKey("solana", pend.token)]) };
  if (pend.failed) return { status: "failed" };
  if (!pend.signatures.includes(signature)) { pend.signatures.push(signature); pend.signature = signature; save(); }
  const r = await settle(pend, signature, { rpc, pool, index });
  if (r.status === "foreign") throw fail(409, r.reason);
  return r;
}

/// Finishes launches the browser never confirmed and retires abandoned ones. For each open
/// pending: every known signature is re-read; if none is known but the mint already exists on
/// chain, the creating transaction is found through the mint's own history; only a pending
/// whose mint is NOT on chain is purged after the TTL — its mint is consumed (never re-used)
/// and its unused treasury key is deleted when the wallet is empty.
export async function reconcile({ rpc = solanaRpc(), pool = defaultPool(), index = null, now = Date.now } = {}) {
  const pending = pendingOf();
  const out = [];
  for (const pend of Object.values(pending)) {
    if (pend.token) { if (now() - Date.parse(pend.createdAt) > PENDING_TTL_MS) delete pending[pend.id]; continue; }
    try {
      let result = null;
      for (const signature of [...(pend.signatures || []), pend.signature].filter(Boolean)) {
        const r = await settle(pend, signature, { rpc, pool, index });
        if (r.status === "done") { result = r; break; }
        if (r.status !== "foreign") result = result || r;
      }
      if (!result || result.status !== "done") {
        const onChain = await rpc.getAccountInfo(pend.mint);
        if (onChain) {
          pend.mintOnChain = true;
          const sigs = await rpc.call("getSignaturesForAddress", [pend.mint, { limit: 10 }]).catch(() => []);
          for (const row of Array.isArray(sigs) ? sigs : []) {
            if (row?.err != null || !isSolanaSignature(row?.signature)) continue;
            const r = await settle(pend, row.signature, { rpc, pool, index });
            if (r.status === "done") { result = r; break; }
          }
          if (!result || result.status !== "done") { pool.consume(pend.id); result = { status: "orphaned", reason: "the mint exists on chain but no landed transaction proved this launch; treasury key kept" }; }
        } else if (now() - Date.parse(pend.createdAt) > PENDING_TTL_MS) {
          pool.consume(pend.id);                                     // a copy of the handed-out transaction could still be replayed
          const balance = await rpc.getBalance(pend.treasury).catch(() => 1);
          if (balance === 0) wallets.deletePendingTreasury(pendingKey(pend.id));
          delete pending[pend.id];
          result = { status: "purged", treasuryKeyDeleted: balance === 0 };
        } else result = result || { status: "pending" };
      }
      out.push({ id: pend.id, mint: pend.mint, ...result });
    } catch (e) { out.push({ id: pend.id, mint: pend.mint, status: "error", error: String(e.message || e).slice(0, 160) }); }
  }
  // Projects that launched while their machine was sold out get a plan as soon as one is in stock.
  for (const t of Object.values(get().tokens)) {
    if (t.launchIdentity?.kind !== "pump" || t.plan) continue;
    if (!t.launchPlanRequest) {
      const pend = Object.values(pending).find((p) => p.token === t.address && p.model);
      if (!pend) continue;
      t.launchPlanRequest = { model: pend.model, offerId: pend.offerId, gpu: pend.plan?.machine || null, dph: pend.plan?.dph ?? null, requestedAt: pend.createdAt };
    }
    try { const r = await ensurePlan(t); if (r.state === "set") out.push({ id: null, mint: t.address, status: "plan_set", fallback: r.fallback }); }
    catch (e) { out.push({ id: null, mint: t.address, status: "error", error: String(e.message || e).slice(0, 160) }); }
  }
  save();
  return out;
}

/// What the launch page shows before anyone connects a wallet (pool status cached 5 s).
export function info({ pool = defaultPool(), now = Date.now } = {}) {
  if (!infoCache || now() - infoCache.at > 5_000) infoCache = { at: now(), pool: pool.status() };
  const launchPackage = newLaunchPackage();
  return { enabled: launchesEnabled(), chain: "solana", venue: "pump.fun", suffix: MINT_SUFFIX, pool: infoCache.pool,
    gasSeedSol: GAS_SEED_LAMPORTS / LAMPORTS_PER_SOL, rentEstimateSol: RENT_ESTIMATE_LAMPORTS / LAMPORTS_PER_SOL, creatorFeePct: 0.3,
    firstBuy: { supported: true, optional: true, currency: "SOL", maxSol: "100", decimals: 9, atomic: true },
    launchPackage: publicLaunchPackage({ launchPackage }) };
}

/// Every coin launched from here, for anyone who wants to attribute them (bots, trackers).
export function registry() {
  return Object.values(get().tokens).filter((t) => t.launchIdentity?.kind === "pump").map((t) => ({
    mint: t.address, symbol: t.symbol, name: t.name, createdAt: t.createdAt, launchTx: t.launchIdentity.launchTx, suffix: t.launchIdentity.suffix,
    treasury: t.treasury.wallet, creator: t.creator, channel: `/t/${t.address}`, pump: t.onchain?.pumpUrl || null }));
}

export const _test = { resetLimits() { recent.byWallet.clear(); recent.prepares.clear(); recent.byIp.clear(); recent.all.length = 0; infoCache = null; } };
