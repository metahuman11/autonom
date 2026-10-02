// Adopting an existing Solana mint as a Autonom project (operator only, Basic
// auth on /api/control). Until the own router launch exists (owner signal), a
// project on Solana is created like a Pons launch — same plan / lock / launch
// package v3 — but with chain 'solana', the mint as its address and a Solana
// treasury that deposits fund. Read-only RPC only: no transaction is ever sent.
import { get, save, event } from "./store.mjs";
import { createToken } from "./economy.mjs";
import { setPlan } from "./plan.mjs";
import { summary } from "./launch.mjs";
import { newLaunchPackage, assertLaunchPackage } from "./launch-package.mjs";
import { env } from "./env.mjs";
import * as wallets from "./wallets.mjs";
import { SOLANA_ADDRESS_RE, tokenKey, isSolanaChain } from "./solana-auth.mjs";
import { logoBytes } from "./project-profile.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOLSCAN = "https://solscan.io";
const RPC_TIMEOUT_MS = 10_000;

/// The public/Helius RPC endpoint. The URL (it may carry an api key) is never
/// returned, logged or included in an error message.
export function rpcUrl() {
  const explicit = env("SOLANA_RPC_URL");
  if (explicit) return explicit;
  const helius = env("HELIUS_API_KEY");
  return helius ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : "https://api.mainnet-beta.solana.com";
}

/// Minimal JSON-RPC client (read-only methods only are ever called from here).
export function solanaRpc(url = rpcUrl()) {
  return async (method, params = []) => {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    } catch { throw fail(503, "Solana RPC is unreachable"); }
    if (!res.ok) throw fail(503, `Solana RPC responded ${res.status}`);
    const j = await res.json().catch(() => null);
    if (!j || typeof j !== "object") throw fail(503, "Solana RPC returned an invalid response");
    if (j.error) throw fail(503, `Solana RPC error: ${String(j.error.message || j.error.code || "unknown").slice(0, 120)}`);
    return j.result;
  };
}

/// Reads the mint account: must exist, belong to the classic SPL Token program
/// (Token-2022 is rejected at adoption), be an initialized mint with decimals/supply.
export async function validateMint(mint, rpc = solanaRpc()) {
  if (typeof mint !== "string" || !SOLANA_ADDRESS_RE.test(mint)) throw fail(400, "mint must be a base58 Solana address");
  const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const value = info?.value;
  if (!value) throw fail(400, "mint account not found on Solana");
  // Classic SPL and Token-2022 are both adopted; the program is recorded because it decides
  // how an associated token account is derived. A transfer-fee extension is the token's own
  // business: the project reads balances, it does not move the token.
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(value.owner)) throw fail(400, "not an SPL Token mint");
  const parsed = value.data?.parsed;
  if (!parsed || parsed.type !== "mint" || !parsed.info) throw fail(400, "account is not a token mint");
  const { decimals, supply, isInitialized, mintAuthority = null, freezeAuthority = null } = parsed.info;
  if (isInitialized === false) throw fail(400, "mint is not initialized");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw fail(400, "mint decimals are invalid");
  if (typeof supply !== "string" || !/^\d+$/.test(supply)) throw fail(400, "mint supply is invalid");
  return { mint, decimals, supply, mintAuthority, freezeAuthority, program: value.owner };
}

function checkFields(body) {
  const name = String(body.name || "").trim(), symbol = String(body.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (name.length < 2 || name.length > 40) throw fail(400, "name must be 2–40 characters");
  if (symbol.length < 2 || symbol.length > 10) throw fail(400, "symbol must be 2–10 letters or digits");
  if (Object.values(get().tokens).some((t) => t.symbol === symbol)) throw fail(409, `$${symbol} is already launched here — pick another symbol`);
  const description = String(body.description || "").trim().slice(0, 400);
  return { name, symbol, description };
}

/// POST /api/control/tokens/solana { mint, name, symbol, description?, creator, model?, offerId?, launchPackage? }
/// `launchPackage: "none"` (operator only — this route is loopback + admin) files the project
/// without the $420 launch package: no DEX Screener order, no X account; the startup target is
/// the plan's own activation amount. For end-to-end tests of the server, the AI and the stream.
/// `deps` exist for tests only (fake RPC, fake custody); production uses the defaults.
export async function adoptSolanaToken(body, { rpc = null, createTreasury = null, index = null } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "mint, name, symbol and creator are required");
  const allowed = ["mint", "name", "symbol", "description", "creator", "model", "offerId", "launchPackage"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, "unexpected field");
  for (const key of ["mint", "name", "symbol", "description", "creator", "model"]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "string") throw fail(400, `${key} must be text`);
  }
  const mint = String(body.mint || "");
  if (!SOLANA_ADDRESS_RE.test(mint)) throw fail(400, "mint must be a base58 Solana address");
  const creator = String(body.creator || "");
  if (!SOLANA_ADDRESS_RE.test(creator)) throw fail(400, "creator must be a base58 Solana wallet");
  const { name, symbol, description } = checkFields(body);
  if (get().tokens[tokenKey("solana", mint)]) throw fail(409, "this mint is already a channel");
  const model = body.model == null ? null : String(body.model), offerId = body.offerId == null ? null : Number(body.offerId);
  if ((model && !offerId) || (!model && offerId)) throw fail(400, "model and offerId go together");
  if (Object.hasOwn(body, "launchPackage") && body.launchPackage !== "none") throw fail(400, 'launchPackage may only be "none"');
  const withPackage = body.launchPackage !== "none";
  const custody = createTreasury || wallets.createSolanaTreasury;
  if (typeof custody !== "function") throw fail(503, "Solana treasury custody is not available in this build");

  const onchain = await validateMint(mint, rpc || solanaRpc());
  if (get().tokens[tokenKey("solana", mint)]) throw fail(409, "this mint is already a channel");   // recheck after the network read
  const wallet = custody(mint);
  const t = await registerSolanaProject({ mint, name, symbol, description, creator, treasuryWallet: wallet, model, offerId, index, withPackage,
    onchain: { pons: false, solana: true, token: mint, mint, decimals: onchain.decimals, supply: onchain.supply, program: onchain.program, explorer: `${SOLSCAN}/token/${mint}`, launchTx: null, launchSlot: null },
    launchIdentity: { version: 1, kind: "adopted", by: "admin", logo: null, launchTx: null },
    eventText: `${symbol} adopted on Solana by the operator (mint ${mint.slice(0, 8)}…, creator ${creator.slice(0, 8)}…)` });
  return { status: "done", channel: summary(t) };
}

/// Files a Solana mint as a Autonom project: the store record, its Solana treasury,
/// launch package v3, identity, plan (or a lock note) and the first market read. Shared by
/// operator adoption and pump.fun launches; the treasury key must already exist in custody.
export async function registerSolanaProject({ mint, name, symbol, description = "", creator, treasuryWallet, onchain, launchIdentity, projectLogoPng = null, launchPackageSnapshot, model = null, offerId = null, planRequest = null, index = null, eventText, withPackage = true }) {
  if (!SOLANA_ADDRESS_RE.test(String(treasuryWallet || ""))) throw fail(503, "Solana treasury custody returned an invalid address");
  if (projectLogoPng !== null) logoBytes(projectLogoPng);
  const filed = wallets.treasuryAddress(mint);
  if (filed && filed !== treasuryWallet) throw fail(503, "the treasury on file for this mint does not match");
  const launchPackage = withPackage ? assertLaunchPackage(launchPackageSnapshot === undefined ? newLaunchPackage() : launchPackageSnapshot) : null;
  const t = createToken({ name, symbol, chain: "solana", treasuryMode: "wallet", treasuryUsd: 0, treasuryWallet, onchain });
  if (!isSolanaChain(t.chain) || t.address !== mint) {
    // The economy refused (or altered) the base58 identity: undo, never keep a half-adopted channel.
    delete get().tokens[tokenKey(t.chain, t.address)];
    throw fail(503, "the token store cannot hold a Solana mint yet");
  }
  t.treasury = { mode: "wallet", chain: "solana", wallet: treasuryWallet, micros: 0, solLamports: 0, usdcMicros: 0, solUsd: null, ledger: [] };
  t.launchPackage = launchPackage ? structuredClone(launchPackage) : null;
  t.creator = creator; t.createdAt = new Date().toISOString();
  t.launchIdentity = structuredClone(launchIdentity);
  if (projectLogoPng) t.projectProfile = { version: 0, logoPng: projectLogoPng, updatedAt: t.createdAt };
  if (description) t.website.content = `${description}\n\n${name} (${symbol}) is operated by an AI agent on Autonom.`;
  const request = planRequest || (model ? { model, offerId, gpu: null, dph: null } : null);
  if (request) { t.launchPlanRequest = { ...request, requestedAt: new Date().toISOString() }; await ensurePlan(t); }
  else t.lock = { state: "locked", note: "plan: choose a model and machine from the control room" };
  event("launch", eventText || `${symbol} registered on Solana`, { token: t.address });
  save();
  // First market read (holders/trades) through the chain-dispatching indexer; like a Pons
  // launch, a failed first index is an event, not a failed registration.
  try { const first = index || (await import("./market.mjs")).indexToken; await first(t); save(); }
  catch (e) { event("market", `${t.symbol}: first index failed — ${String(e.message || e).slice(0, 100)}`, { token: t.address, level: "warn" }); }
  return t;
}

/// Sets the plan the launcher asked for. If that exact machine sold out in the meantime (stock
/// changes every minute), the cheapest machine of the same GPU class at no more than the quoted
/// price is taken instead; if none is in stock, the request is kept and retried by reconcile().
export async function ensurePlan(t, { quote = null, stock = null } = {}) {
  if (t.plan) return { state: "set", plan: t.plan };
  const req = t.launchPlanRequest;
  if (!req?.model) return { state: "no_request" };
  const { inventory, offerById } = await import("./inventory.mjs");
  try {
    const exact = req.offerId != null ? offerById(Number(req.offerId)) : null;
    if (exact) { req.gpu ||= exact.gpu; req.dph ||= exact.dph; await setPlan(t, { model: req.model, offerId: Number(req.offerId), minCuda: 12.8 }); return { state: "set", plan: t.plan, fallback: false }; }
    const inv = stock || await inventory();
    const like = (inv.offers || []).filter((o) => (!req.gpu || o.gpu === req.gpu) && (req.dph == null || o.dph <= req.dph * 1.1)).sort((a, b) => a.dph - b.dph);
    if (!like.length) { t.lock = { state: "locked", note: `plan: ${req.gpu || "the chosen machine"} is out of stock — retrying automatically` }; return { state: "waiting", reason: "out_of_stock" }; }
    await setPlan(t, { model: req.model, offer: like[0], minCuda: 12.8 });
    event("launch", `${t.symbol}: the chosen machine sold out; ${like[0].gpu} at $${like[0].dph}/h took its place`, { token: t.address });
    return { state: "set", plan: t.plan, fallback: true };
  } catch (e) {
    t.lock = { state: "locked", note: `plan: ${String(e.message).slice(0, 120)}` };
    return { state: "failed", reason: String(e.message).slice(0, 120) };
  }
}

/// The stored project for a mint, or null.
export const solanaProjectOf = (mint) => get().tokens[tokenKey("solana", String(mint || ""))] || null;
