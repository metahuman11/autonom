// Public launching: anyone with a wallet opens a token from the site. The creator
// signs the launch (EIP-191 over canonical JSON, like every holder action); the site
// creates the token with its own treasury wallet, prices the plan (model + machine) and
// leaves it LOCKED until the treasury reaches the threshold. No operator involved.
import { ethers } from "ethers";
import { createHash } from "node:crypto";
import { get, save, event } from "./store.mjs";
import { recoverSigner } from "./canonical.mjs";
import { createToken, addHolderAddress, budgetOf, usd, tokenOf } from "./economy.mjs";
import { setPlan, quotePlan, lockStatus } from "./plan.mjs";
import { viewersOf } from "./viewers.mjs";
import { createTreasuryWallet, aliasTreasury } from "./wallets.mjs";
import * as pons from "./pons.mjs";
import { env } from "./env.mjs";
import { indexToken } from "./market.mjs";
import { newLaunchPackage, assertLaunchPackage, publicLaunchPackage } from "./launch-package.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const FRESH_MS = 10 * 60_000;
const PER_WALLET_MS = 10 * 60_000;      // one launch per wallet per 10 minutes
const GLOBAL_PER_HOUR = 30;             // and at most this many launches an hour in total
const CREATOR_SHARE_PCT = 1;            // the creator's demo stake, so they can chat and vote
const recent = { byWallet: new Map(), all: [] };
const nonces = new Set();

function verifyLaunch(body) {
  const p = body?.payload;
  if (!p || typeof p !== "object" || typeof body.signature !== "string") throw fail(400, "expected {payload, signature}");
  if (p.schemaVersion !== 1 || p.type !== "launch") throw fail(400, "payload.type must be launch with schemaVersion 1");
  for (const f of ["creator", "name", "symbol", "model", "offerId", "timestamp", "nonce"]) if (!(f in p)) throw fail(400, `payload.${f} is required`);
  const ts = Date.parse(p.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_MS) throw fail(400, "timestamp is missing or stale");
  if (!/^0x[0-9a-f]{32}$/.test(String(p.nonce))) throw fail(400, "nonce must be 16 random bytes as hex");
  if (nonces.has(p.nonce)) throw fail(409, "nonce already used");
  let who;
  try { who = recoverSigner(p, body.signature); } catch { throw fail(401, "bad signature"); }
  if (who.toLowerCase() !== String(p.creator).toLowerCase()) throw fail(401, "signature is not from the creator wallet");
  return p;
}

function checkFields(p) {
  const name = String(p.name || "").trim(), symbol = String(p.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (name.length < 2 || name.length > 40) throw fail(400, "name must be 2–40 characters");
  if (symbol.length < 2 || symbol.length > 10) throw fail(400, "symbol must be 2–10 letters or digits");
  const taken = Object.values(get().tokens).some((t) => t.symbol === symbol);
  if (taken) throw fail(409, `$${symbol} is already launched here — pick another symbol`);
  const description = String(p.description || "").trim().slice(0, 400);
  return { name, symbol, description };
}

function rateLimit(wallet) {
  const now = Date.now(), w = wallet.toLowerCase();
  recent.all = recent.all.filter((t) => now - t < 3_600_000);
  if (recent.all.length >= GLOBAL_PER_HOUR) throw fail(429, "too many launches right now — try again in a while");
  const last = recent.byWallet.get(w) || 0;
  if (now - last < PER_WALLET_MS) throw fail(429, `this wallet launched ${Math.round((now - last) / 60_000)} min ago — wait ${Math.ceil((PER_WALLET_MS - (now - last)) / 60_000)} min`);
}

/// Prices a launch without creating anything (the form shows this live).
export async function quote({ model, offerId }) {
  const runtime = await quotePlan({ model, offerId: Number(offerId) });
  const launchPackage = newLaunchPackage();
  return { ...runtime, activationUsd: launchPackage.activationMicros / 1e6, runtimeActivationUsd: runtime.activationUsd,
    launchPackage: publicLaunchPackage({ launchPackage }) };
}

/// Creates the token from a signed launch payload. Returns the public summary.
export async function launch(body) {
  const p = verifyLaunch(body);
  const { name, symbol, description } = checkFields(p);
  rateLimit(p.creator);
  const t = createToken({ name, symbol, treasuryMode: "wallet", chain: "robinhood", treasuryUsd: 0 });
  t.creator = ethers.getAddress(p.creator).toLowerCase();
  t.createdAt = new Date().toISOString();
  if (description) t.website.content = `${description}\n\n${name} (${symbol}) is operated by an AI agent on Autonom.`;
  try {
    await setPlan(t, { model: String(p.model), offerId: Number(p.offerId), minCuda: 12.8 });
  } catch (e) {
    delete get().tokens[t.address.toLowerCase()];   // no half-launched token
    throw e;
  }
  addHolderAddress(t.address, t.creator, CREATOR_SHARE_PCT);
  nonces.add(p.nonce); if (nonces.size > 5000) nonces.clear();
  recent.byWallet.set(t.creator, Date.now()); recent.all.push(Date.now());
  event("launch", `${symbol} launched by ${t.creator.slice(0, 10)}… (${t.plan.modelName}, ${t.plan.offer.gpu}) — unlocks at $${t.plan.activationUsd}`, { token: t.address });
  save();
  return summary(t);
}

// ── real launches on Pons ─────────────────────────────────────────────────────
const PENDING_TTL_MS = 60 * 60_000;
const PREPARE_RETRY_MS = 5 * 60_000;
const MAX_PENDING = 30, MAX_UNCONFIRMED_ALLOCATIONS = 100, MAX_CREATOR_ALLOCATIONS = 2;
const preparing = new Map();
const TAX_MIN_BPS = 100, TAX_MAX_BPS = 500, TAX_DEFAULT_BPS = 200;
const pendingOf = () => { const s = get(); s.pendingLaunches ||= {}; for (const [id, p] of Object.entries(s.pendingLaunches)) if (Date.now() - Date.parse(p.createdAt) > PENDING_TTL_MS && !p.txHash) delete s.pendingLaunches[id]; return s.pendingLaunches; };

function prepareGuard() {
  const s = get();
  if (!s.launchPrepareGuard) {
    // Metadata only. Never read/delete wallet keys to reconcile reservations.
    const allocations = Object.fromEntries(Object.entries(s.pendingLaunches || {}).filter(([, p]) => !p.token).map(([id, p]) => [id, { creator: p.creator, at: Date.parse(p.createdAt) || Date.now() }]));
    s.launchPrepareGuard = { attempts: [], allocations };
  }
  const guard = s.launchPrepareGuard;
  if (!Array.isArray(guard.attempts) || !guard.allocations || typeof guard.allocations !== "object" || Array.isArray(guard.allocations)) throw fail(503, "launch preparation guard requires maintenance");
  guard.attempts = guard.attempts.filter((a) => Number.isFinite(a.at) && Date.now() - a.at < PENDING_TTL_MS);
  return guard;
}

function reservePrepare(creator, requestHash) {
  const guard = prepareGuard(), now = Date.now();
  const pending = Object.values(pendingOf()).filter((p) => !p.token);
  if (guard.attempts.length >= GLOBAL_PER_HOUR || pending.length + preparing.size >= MAX_PENDING) throw fail(429, "launch preparation is busy — try again later");
  if (guard.attempts.some((a) => a.creator === creator && now - a.at < PER_WALLET_MS)) throw fail(429, "wait 10 minutes before preparing a different launch");
  const allocations = Object.values(guard.allocations);
  if (allocations.length >= MAX_UNCONFIRMED_ALLOCATIONS || allocations.filter((a) => a.creator === creator).length >= MAX_CREATOR_ALLOCATIONS) throw fail(429, "unconfirmed launch preparation limit reached — finish an existing launch or request reconciliation");
  // Reserve synchronously and persist before RPC/model-catalog work, not merely
  // after confirmation. Failures consume the attempt, bounding retry abuse.
  guard.attempts.push({ creator, requestHash, at: now });
  save();
  return guard;
}

function releaseAllocation(id) {
  if (get().launchPrepareGuard?.allocations) delete get().launchPrepareGuard.allocations[id];
}

// Owner switch (2026-09-21): token launches are moving to Solana; Pons launches are
// paused with LAUNCH_PONS_ENABLED=0 (systemd drop-in), existing projects unaffected.
export const launchesPaused = () => env("LAUNCH_PONS_ENABLED", "1") !== "1";
export const PAUSED_MESSAGE = "Token launches are moving to Solana. Pons launches are paused for now; existing projects keep running.";
export async function info() {
  const i = await pons.launchInfo();
  const paused = launchesPaused();
  return { chainId: pons.CHAIN_ID, router: pons.ROUTER, factory: pons.FACTORY, explorer: pons.EXPLORER, ponsApp: pons.PONS_APP, launchFeeEth: i.launchFeeEth, enabled: i.enabled && !paused, paused, pausedReason: paused ? PAUSED_MESSAGE : null, taxMinBps: TAX_MIN_BPS, taxMaxBps: TAX_MAX_BPS, taxDefaultBps: TAX_DEFAULT_BPS };
}

/// Step 1: the treasury wallet is created now, the launch call is encoded with it as
/// the creator-tax recipient, and the creator's wallet gets {to, data, value} to send.
export async function prepare(body) {
  if (launchesPaused()) throw fail(503, PAUSED_MESSAGE);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "launch fields required");
  const allowed = ["creator", "name", "symbol", "description", "website", "twitter", "logo", "model", "offerId", "creatorTaxBps", "firstBuyEth", "launchPackageVersion"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, "unexpected launch field");
  if (body.launchPackageVersion !== newLaunchPackage().version) throw fail(400, "Launch package changed. Refresh and review the current package before launching");
  for (const key of ["creator", "name", "symbol", "description", "website", "twitter", "logo", "model"]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "string") throw fail(400, `launch ${key} must be text`);
  }
  for (const key of ["offerId", "creatorTaxBps", "firstBuyEth"]) {
    if (Object.hasOwn(body, key) && !["string", "number"].includes(typeof body[key])) throw fail(400, `launch ${key} must be numeric`);
  }
  const creator = ethers.getAddress(String(body.creator || "")).toLowerCase();
  const { name, symbol, description } = checkFields({ name: body.name, symbol: body.symbol, description: body.description });
  const website = String(body.website || "").trim().slice(0, 200), twitter = String(body.twitter || "").trim().slice(0, 200), logo = String(body.logo || "").trim().slice(0, 300);
  if (website && !/^https:\/\//.test(website)) throw fail(400, "website must start with https://");
  if (logo && !/^(https:\/\/|ipfs:\/\/)/.test(logo)) throw fail(400, "logo must be an https:// or ipfs:// URL");
  const creatorTaxBps = body.creatorTaxBps == null ? TAX_DEFAULT_BPS : Number(body.creatorTaxBps);
  if (!Number.isInteger(creatorTaxBps) || creatorTaxBps < TAX_MIN_BPS || creatorTaxBps > TAX_MAX_BPS) throw fail(400, `creator tax must be ${TAX_MIN_BPS / 100}–${TAX_MAX_BPS / 100}%`);
  const firstBuyEth = Number(body.firstBuyEth ?? 0);
  if (!Number.isFinite(firstBuyEth) || firstBuyEth < 0 || firstBuyEth > 10) throw fail(400, "first buy must be 0–10 ETH");
  const model = String(body.model || ""), offerId = Number(body.offerId);
  if (!model || model.length > 160 || !Number.isSafeInteger(offerId) || offerId <= 0) throw fail(400, "valid model and machine are required");
  let quoteInWei;
  try { quoteInWei = ethers.parseEther(String(firstBuyEth)).toString(); } catch { throw fail(400, "first buy must use a supported ETH decimal amount"); }
  const launchPackage = assertLaunchPackage(newLaunchPackage());
  const requestHash = createHash("sha256").update(JSON.stringify({ creator, name, symbol, description, website, twitter, logo, creatorTaxBps, firstBuyEth, model, offerId, launchPackageVersion: launchPackage.version })).digest("hex");
  // Capture existing allocation metadata before pruning expired pending drafts.
  prepareGuard();
  const retry = Object.values(pendingOf()).find((p) => p.requestHash === requestHash && p.prepareResponse && !p.token && Date.now() - Date.parse(p.createdAt) < PREPARE_RETRY_MS);
  if (retry) return { ...retry.prepareResponse, duplicate: true };
  if (preparing.has(requestHash)) return { ...await preparing.get(requestHash), duplicate: true };
  rateLimit(creator);
  const guard = reservePrepare(creator, requestHash);
  const operation = (async () => {
    const plan = await quotePlan({ model, offerId });
    const i = await pons.launchInfo();
    if (!i.enabled) throw fail(503, "Pons launches are disabled right now");
    const id = ethers.hexlify(ethers.randomBytes(8)).slice(2);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const params = { name, symbol, logo, description, website, twitter, creatorTaxBps, expectedEconomics: i.expectedEconomics, salt, creator, quoteInWei, launchFeeWei: i.launchFeeWei };
    // Validate all provider/amount/ABI inputs before allocating any key.
    pons.encodeLaunch({ ...params, treasury: ethers.ZeroAddress });
    // Recheck after asynchronous work; simultaneous distinct creators must not
    // cross the allocation cap. Persist a conservative slot before key creation.
    if (Object.keys(guard.allocations).length >= MAX_UNCONFIRMED_ALLOCATIONS) throw fail(429, "unconfirmed launch allocation limit reached");
    guard.allocations[id] = { creator, at: Date.now() };
    save();
    const treasury = createTreasuryWallet(`pending:${id}`);
    const tx = pons.encodeLaunch({ ...params, treasury });
    const response = { id, treasury, tx, launchFeeEth: i.launchFeeEth, totalEth: ethers.formatEther(BigInt(tx.value)), launchPackage: publicLaunchPackage({ launchPackage }),
      plan: { activationUsd: launchPackage.activationMicros / 1e6, runtimeActivationUsd: plan.activationUsd, dailyUsd: plan.dailyUsd, modelName: plan.modelName, machine: plan.machine } };
    pendingOf()[id] = { id, creator, name, symbol, description, website, twitter, logo, creatorTaxBps, firstBuyEth, model, offerId, treasury, salt, tx, requestHash, launchPackage, prepareResponse: response, createdAt: new Date().toISOString(), txHash: null, token: null };
    save();
    return response;
  })();
  preparing.set(requestHash, operation);
  try { return await operation; } finally { preparing.delete(requestHash); }
}

/// Step 2: the creator reports the tx hash; once mined and verified, the channel exists.
export async function confirm(body) {
  const pend = pendingOf()[String(body.id || "")];
  if (!pend) throw fail(404, "unknown or expired launch — start again");
  const txHash = String(body.txHash || pend.txHash || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw fail(400, "txHash is required");
  if (pend.token) return { status: "done", channel: summary(tokenOf(pend.token)) };
  // Old pending launches retain their original terms. New ones carry the exact
  // package reviewed at preparation; never infer it from today's defaults.
  const launchPackage = pend.launchPackage === undefined ? null : assertLaunchPackage(pend.launchPackage);
  pend.txHash = txHash; save();
  const r = await pons.readLaunch(txHash, { expectedCreator: pend.creator, expectedTreasury: pend.treasury });
  if (r.status !== "mined") return { status: r.status };
  const existing = get().tokens[r.token];
  if (existing) { pend.token = r.token; releaseAllocation(pend.id); save(); return { status: "done", channel: summary(existing) }; }
  const t = createToken({ name: pend.name, symbol: pend.symbol, treasuryMode: "wallet", chain: "robinhood", treasuryUsd: 0, treasuryWallet: pend.treasury,
    onchain: { token: r.token, curve: r.curve, pairToken: r.pairToken, launchTx: txHash, launchBlock: r.block, creatorTaxBps: r.creatorTaxBps, deployer: r.deployer, graduationThresholdWei: r.graduationThreshold, firstBuy: r.firstBuy, explorer: `${pons.EXPLORER}/token/${r.token}`, pons: `${pons.PONS_APP}` } });
  if (launchPackage) t.launchPackage = structuredClone(launchPackage);
  aliasTreasury(`pending:${pend.id}`, t.address);
  t.creator = pend.creator; t.createdAt = new Date().toISOString();
  // Preserve only the launch identity confirmed by this creator's on-chain
  // launch. A later finalized profile vote may replace/remove its artwork.
  t.launchIdentity = {version:1,logo:pend.logo||null,launchTx:txHash};
  if (pend.website) t.domain = pend.website.replace(/^https:\/\//, "");
  if (pend.description) t.website.content = `${pend.description}\n\n${pend.name} (${pend.symbol}) is operated by an AI agent on Autonom.`;
  await setPlan(t, { model: pend.model, offerId: pend.offerId, minCuda: 12.8 }).catch((e) => { t.lock = { state: "locked", note: `plan: ${e.message.slice(0, 120)}` }; });
  pend.token = t.address.toLowerCase();
  releaseAllocation(pend.id);
  recent.byWallet.set(pend.creator, Date.now()); recent.all.push(Date.now());
  event("launch", `${t.symbol} launched ON PONS by ${pend.creator.slice(0, 10)}… (tx ${txHash.slice(0, 10)}…, ${r.creatorTaxBps / 100}% creator tax → treasury)`, { token: t.address });
  save();
  try { await indexToken(t); save(); } catch (e) { event("market", `${t.symbol}: first index failed — ${e.message.slice(0, 100)}`, { token: t.address, level: "warn" }); }
  return { status: "done", channel: summary(t) };
}

export function summary(t) {
  const b = budgetOf(t), L = lockStatus(t), viewers = viewersOf(t.address);
  return {
    address: t.address, name: t.name, symbol: t.symbol, chain: t.chain, creator: t.creator || null, createdAt: t.createdAt || t.createdSimAt,
    treasury: { wallet: t.treasury.wallet || null, usd: usd(b.remainingMicros) },
    lock: { state: L.state, activationUsd: L.activationUsd, progress: L.progress, treasuryUsd: L.treasuryUsd, missingUsd: L.missingUsd },
    plan: t.plan ? { model: t.plan.modelName, machine: t.plan.offer.gpu, dph: t.plan.offer.dph, dailyUsd: t.plan.dailyUsd } : null,
    launchPackage: publicLaunchPackage(t),
    live: t.vps.mode === 'real' && t.vps.state === 'running' && L.state !== 'paused' && viewers.telemetryFresh === true && viewers.ready === true,
    phase: t.vps.phase, agent: t.agent.state, viewers: viewers.viewers, viewerStatus: viewers.status,
    holders: Object.entries(t.balances).filter(([a, v]) => v > 0 && (!t.curveAddress || (a !== t.curveAddress && a !== t.curveAddress.toLowerCase()))).length,
    description: (t.website?.content || "").split("\n")[0].slice(0, 160),
    onchain: t.onchain ? { token: t.onchain.token, curve: t.onchain.curve, explorer: t.onchain.explorer, creatorTaxBps: t.onchain.creatorTaxBps } : null,
    market: t.market?.price ? { priceEth: t.market.price.priceEth, mcapEth: t.market.price.priceEth * (t.market.price.totalSupply || 0), graduated: t.market.price.graduated, trades: t.market.trades.length } : null,
  };
}

/// Every channel, live ones first, then by treasury.
export function channels() {
  return Object.values(get().tokens).map(summary).sort((a, b) => (b.live - a.live) || (b.treasury.usd - a.treasury.usd));
}
