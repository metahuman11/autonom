// Money on a Solana treasury. Every debit the platform takes from a project on Solana
// is ONE SOL transfer from the project treasury to the platform wallet, recorded in the
// same durable maps billing.mjs uses on EVM (vpsUsageReservations, packageUsageReservations,
// packageBridgeReservations) with `chain:'solana'`:
//   reserved → submitted (signature persisted BEFORE the send) → settled | released | uncertain
// A signed Solana transaction can land at most once and never after its blockhash expires,
// so "released" is only ever written for a record that provably did not land (expired or
// failed on chain), and a lost answer is re-verified from the signature, never re-sent.
// The AI pocket on Solana is the treasury's own USDC account, refilled by a Jupiter swap
// that is decoded, simulated and bounded before the treasury signs it.
import { createHash } from "node:crypto";
import * as rail from "./solana.mjs";
import { solanaTreasurySigner } from "./wallets.mjs";
import { heldUsage } from "./usage-budget.mjs";
import { packagePaymentAvailableMicros, isStagedPackagePayment } from "./runtime-budget.mjs";
import { env } from "./env.mjs";

export const isSolanaTreasury = (t) => t?.treasury?.chain === "solana";
const iso = (now) => new Date(now()).toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
let rpcCache = null;
/// The process-wide RPC client (Helius when HELIUS_API_KEY / SOLANA_RPC_URL is set).
export function solanaRpc() { return (rpcCache ||= rail.createRpc({})); }
export function setSolanaRpcForTests(rpc) { rpcCache = rpc; }
const nativeMicros = (tr) => (tr.solUsd > 0 ? rail.microsFor(Math.max(0, (tr.solLamports || 0) - rail.TREASURY_SOL_RESERVE_LAMPORTS), tr.solUsd) : 0);
/// Recomputes the cached USD view from lamports / USDC / price (the spendable SOL excludes the rent+fee reserve).
export function recomputeSolanaMicros(tr) {
  tr.ethMicros = 0; tr.usdgMicros = 0; tr.robinhoodEth = 0;
  tr.solMicros = nativeMicros(tr);
  tr.micros = tr.solMicros + (tr.usdcMicros || 0) + (tr.basePocket?.usdcMicros || 0);
  return tr;
}
/// Which rail a Solana project pays NanoGPT on: 'base' (its Base USDC pocket, refilled through
/// Relay — the default since NanoGPT's Solana facilitator refused every payment on 2026-09-22)
/// or 'solana' (its own USDC account, x402 on Solana). SOLANA_AI_RAIL=solana switches back.
export const solanaAiRail = () => (env("SOLANA_AI_RAIL", "base") === "solana" ? "solana" : "base");
/// The USDC the project can pay AI with on its current rail.
export const aiPocketMicros = (t) => (isSolanaTreasury(t) && solanaAiRail() === "base" ? (t.treasury.basePocket?.usdcMicros || 0) : (t.treasury.usdcMicros || 0));

/// Reads SOL, the treasury's USDC account and the SOL/USD price. `marketingObservedAt` is
/// stamped only when all three reads succeeded (the funding gate needs a complete view).
const solanaTreasuryReads = new WeakMap();
export async function refreshSolanaTreasury(t, { rpc = solanaRpc(), price = rail.solUsd, now = Date.now, offline = false } = {}) {
  const tr = t.treasury, wallet = tr.wallet;
  const generation = (solanaTreasuryReads.get(tr) || 0) + 1;
  solanaTreasuryReads.set(tr, generation);
  const startedAt = iso(now);
  tr.marketingObservedAt = null; tr.marketingObservationStartedAt = null; tr.marketingBasePocketObservation = null; tr.marketingNativeObservation = null;
  if (offline) { recomputeSolanaMicros(tr); tr.marketingObservedAt = iso(now); tr.marketingObservationStartedAt = startedAt; tr.marketingNativeObservation = { wallet, startedAt, observedAt: tr.marketingObservedAt }; return tr; }
  const [lamports, usdc, usd] = await Promise.all([
    rpc.getBalance(tr.wallet).catch(() => null),
    rail.ataOf(tr.wallet).then((ata) => rpc.getTokenAccountBalance(ata)).catch(() => undefined),   // null = no account yet (0), undefined = read failed
    price().catch(() => null),
  ]);
  if (t.treasury !== tr || tr.wallet !== wallet || solanaTreasuryReads.get(tr) !== generation) return t.treasury;
  if (lamports != null) tr.solLamports = lamports;
  if (usdc !== undefined) tr.usdcMicros = usdc ?? 0;
  if (usd != null) tr.solUsd = usd;
  recomputeSolanaMicros(tr);
  tr.refreshedAt = iso(now);
  const complete = lamports != null && usdc !== undefined && usd != null && tr.solUsd > 0;
  tr.marketingObservedAt = complete ? tr.refreshedAt : null;
  tr.marketingObservationStartedAt = complete ? startedAt : null;
  tr.marketingNativeObservation = complete ? { wallet, startedAt, observedAt: tr.refreshedAt } : null;
  return tr;
}

const settleRecord = (t, rec, { signature, lamports, feeLamports, micros, reason, ledger, ledgerKey, now, extra = {} }) => {
  const tr = t.treasury;
  Object.assign(rec, { state: "settled", tx: signature, settledAt: iso(now), ...extra });
  tr.solLamports = Math.max(0, (tr.solLamports || 0) - lamports - (feeLamports || 0));
  recomputeSolanaMicros(tr);
  ledger(t, -micros, `${reason} (${(lamports / rail.LAMPORTS_PER_SOL).toFixed(6)} SOL, Solana)`, { tx: signature, chain: "solana", billingId: rec.id, ...(ledgerKey || {}) });
};
const releaseRecord = (rec, why) => Object.assign(rec, { state: "released", failure: String(why).slice(0, 160) });

/// Re-verifies a submitted/uncertain Solana record from its signature. Returns
/// 'settled' | 'released' | 'pending' after persisting the verdict.
export async function verifySolanaRecord(t, rec, { rpc = solanaRpc(), persist, ledger, reason, ledgerKey = null, now = Date.now } = {}) {
  if (!rail.isSolanaSignature(rec.signature || "")) return "pending";
  const v = await rail.checkSignature(rpc, rec.signature, { lastValidBlockHeight: rec.lastValidBlockHeight || 0 });
  if (v.state === "confirmed") {
    persist(t, () => settleRecord(t, rec, { signature: rec.signature, lamports: rec.lamports, feeLamports: rec.maxFeeLamports || 0, micros: rec.limitMicros, reason: `${reason}; settled from receipt`, ledger, ledgerKey, now }));
    return "settled";
  }
  if (v.state === "failed" || v.state === "expired") {
    persist(t, () => releaseRecord(rec, v.state === "failed" ? "transaction failed on chain; nothing moved" : "blockhash expired before landing; nothing moved"));
    return "released";
  }
  return "pending";
}

/// One durable SOL debit treasury → `recipient` (the platform wallet). `records()` returns the
/// map the record lives in, `persist(t, mutate)` is that map's durable writer, `ledger` the
/// treasury ledger writer of billing.mjs. Idempotent by id, like chargePackageOnce.
export async function solanaDebitOnce(t, { id, micros, reason, recipient = rail.SOLANA_OPS_ADDRESS, records, persist, ledger, ledgerKey = null, reservedMicros = 0, binding = null, event = null, beforeDispatch = null },
  { rpc = solanaRpc(), signer = null, now = Date.now, confirm = rail.confirmBounded, transfer = rail.transferOnce, send = rail.send } = {}) {
  const map = records, tr = t.treasury;
  const existing = map()[id];
  if (existing) {
    if (typeof existing !== "object" || Array.isArray(existing) || existing.version !== 1 || existing.id !== id ||
        existing.chain !== "solana" || existing.limitMicros !== micros || existing.recipient !== recipient ||
        !["reserved", "submitted", "uncertain", "settled", "released"].includes(existing.state) ||
        JSON.stringify(existing.binding ?? null) !== JSON.stringify(binding ?? null) ||
        existing.state === "reserved" && (existing.signature != null || existing.tx != null))
      return { paid: false, pending: true, reason: "Solana payment record requires reconciliation" };
    if (existing.state === "settled" && rail.isSolanaSignature(existing.tx || "")) return { paid: true, chain: "solana", tx: existing.tx, billingId: id, settledAt: existing.settledAt, duplicate: true };
    if (existing.state === "reserved") {
      // The send follows the 'submitted' persist: a record still 'reserved' was never dispatched.
      persist(t, () => releaseRecord(map()[id], "interrupted before dispatch"));
    } else if (["submitted", "uncertain"].includes(existing.state)) {
      const verdict = await verifySolanaRecord(t, existing, { rpc, persist, ledger, reason, ledgerKey, now });
      if (verdict === "settled") return { paid: true, chain: "solana", tx: existing.tx, billingId: id, settledAt: existing.settledAt, duplicate: true };
      if (verdict === "pending") return { paid: false, pending: true, reason: "Solana payment is awaiting its receipt; no automatic repeat" };
    } else if (existing.state !== "released") return { paid: false, pending: true, reason: "Solana payment record is in an unknown state" };
  }
  if (!(tr.solUsd > 0)) return { paid: false, reason: "SOL valuation is unavailable" };
  const lamports = rail.lamportsFor(micros, tr.solUsd);
  const available = () => packagePaymentAvailableMicros(t, { id, reservedMicros, now: now() });
  if (!Number.isSafeInteger(tr.micros) || available() < micros) return { paid: false, reason: "treasury cannot cover this payment outside its other liabilities" };
  const s = signer || solanaTreasurySigner(t.address);
  if (s.address !== tr.wallet) return { paid: false, reason: "treasury signer does not match the treasury wallet" };
  let prepared;
  try { prepared = await transfer(rpc, { signer: s, to: recipient, lamports, memo: id.slice(0, 64) }); }
  catch (e) { return { paid: false, reason: "Solana transfer could not be prepared: " + String(e.message).slice(0, 120) }; }
  if ((tr.solLamports || 0) < lamports + prepared.maxFeeLamports + rail.TREASURY_SOL_RESERVE_LAMPORTS) return { paid: false, reason: "treasury SOL is below the payment plus fee and reserve" };
  if (available() < micros + (isStagedPackagePayment(t, id) ? rail.microsFor(prepared.maxFeeLamports, tr.solUsd) : 0)) return { paid: false, reason: "treasury balance changed before dispatch" };
  persist(t, () => { map()[id] = { id, version: 1, binding, chain: "solana", limitMicros: micros, lamports, recipient, state: "reserved", createdAt: iso(now) }; });
  // Recheck runtime authority after asynchronous preparation, with the reserve
  // already durable. If it changed, retain the hold for review and send nothing.
  // The hook is synchronous; receipt-only reconciliation above does not use it.
  if (beforeDispatch) {
    const check = beforeDispatch();
    if (check && typeof check.then === 'function') throw new Error('beforeDispatch must validate synchronously');
  }
  // The signature is durable BEFORE the send: the same signed bytes may be re-sent, never re-signed.
  persist(t, () => { Object.assign(map()[id], { state: "submitted", signature: prepared.signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, maxFeeLamports: prepared.maxFeeLamports, submittedAt: iso(now) }); });
  let verdict;
  try { await send(rpc, prepared.wire, { signature: prepared.signature }); verdict = await confirm(rpc, prepared.signature, { lastValidBlockHeight: prepared.lastValidBlockHeight, now }); }
  catch (e) { verdict = { state: "unknown", error: String(e.message || e) }; }
  if (verdict.state === "confirmed") {
    persist(t, () => settleRecord(t, map()[id], { signature: prepared.signature, lamports, feeLamports: prepared.maxFeeLamports, micros, reason, ledger, ledgerKey, now, extra: { slot: verdict.slot ?? null } }));
    return { paid: true, chain: "solana", tx: prepared.signature, billingId: id, settledAt: map()[id].settledAt };
  }
  if (verdict.state === "failed" || verdict.state === "expired") {
    persist(t, () => releaseRecord(map()[id], verdict.state === "failed" ? `transaction failed on chain: ${JSON.stringify(verdict.err).slice(0, 100)}` : "blockhash expired before landing; nothing moved"));
    return { paid: false, reason: verdict.state === "failed" ? "Solana payment failed on chain; nothing moved" : "Solana payment expired before landing; nothing moved" };
  }
  persist(t, () => { Object.assign(map()[id], { state: "uncertain", failure: String(verdict.error || "no confirmation within the window").slice(0, 160) }); });
  event?.("package", `${t.symbol}: ${reason} — Solana payment outcome unknown (${prepared.signature.slice(0, 12)}…); it is re-verified from its signature, never repeated`, { token: t.address, level: "error" });
  return { paid: false, pending: true, reason: "Solana payment outcome unknown; re-verified from its signature, never repeated" };
}

/// The DEX allocation on Solana: a SOL transfer of `micros` to the platform DEX wallet with
/// the packageBridgeReservations record semantics billing.bridgePackageAllocation exposes
/// (view fields, dispatch flag, terminal 'uncertain'). No Relay, never 'refunded'.
export async function solanaAllocationOnce(t, { id, micros, recipient, reason, reservedMicros = 0, ledgerKey = null, dispatch = true, records, persist, ledger, event = null, inFlight },
  { rpc = solanaRpc(), signer = null, now = Date.now, confirm = rail.confirmBounded, transfer = rail.transferOnce, send = rail.send } = {}) {
  const map = records, tr = t.treasury;
  const view = (r) => ({ state: r.state, id: r.id, chain: "solana", requestId: null, txs: r.signature ? [r.signature] : [], depositMined: r.state === "settled", settledAt: r.settledAt || null,
    outAmount: r.lamports != null ? String(r.lamports) : null, outUsd: null, inUsd: null, actualMicros: r.actualMicros ?? null, outTxHashes: r.state === "settled" && r.signature ? [r.signature] : [], lamports: r.lamports ?? null,
    limitMicros: r.limitMicros, reason: r.failure || null, createdAt: r.createdAt || null, submittedAt: r.submittedAt || null });
  const existing = map()[id];
  if (existing) {
    if (existing.chain !== "solana" || existing.limitMicros !== micros || existing.recipient !== recipient) return { state: "invalid", id, reason: "package allocation record requires reconciliation" };
    if (inFlight?.has(id)) return view(existing);
    if (existing.state === "reserved") { persist(t, () => releaseRecord(map()[id], "interrupted before dispatch")); if (!dispatch) return view(map()[id]); }
    else if (["submitted", "uncertain"].includes(existing.state)) {
      await verifySolanaRecord(t, existing, { rpc, persist, ledger, reason, ledgerKey, now });
      if (map()[id].state === "settled") { event?.("package", `${t.symbol}: ${reason} — $${(micros / 1e6).toFixed(2)} delivered to the platform DEX wallet (settled from receipt)`, { token: t.address }); Object.assign(map()[id], { actualMicros: micros }); persist(t, () => {}); }
      return view(map()[id]);
    } else if (existing.state !== "released") return view(existing);
    else if (!dispatch) return view(existing);
  } else if (!dispatch) return { state: "none", id, reason: null };
  if (inFlight?.has(id)) return { state: "unavailable", id, reason: "allocation transfer already in progress" };
  inFlight?.add(id);
  try {
    if (!(tr.solUsd > 0)) return { state: "unavailable", id, reason: "SOL valuation is unavailable" };
    const lamports = rail.lamportsFor(micros, tr.solUsd);
    const available = () => packagePaymentAvailableMicros(t, { id, reservedMicros, now: now() });
    if (!Number.isSafeInteger(tr.micros) || available() < micros) return { state: "unavailable", id, reason: "treasury cannot cover this allocation outside its other liabilities" };
    const s = signer || solanaTreasurySigner(t.address);
    if (s.address !== tr.wallet) return { state: "unavailable", id, reason: "treasury signer does not match the treasury wallet" };
    let prepared;
    try { prepared = await transfer(rpc, { signer: s, to: recipient, lamports, memo: id.slice(0, 64) }); }
    catch (e) { persist(t, () => { map()[id] = { id, version: 1, chain: "solana", limitMicros: micros, lamports, recipient, state: "released", createdAt: iso(now), failure: String(e.message).slice(0, 160) }; }); return { state: "released", id, reason: "allocation transfer could not be prepared: " + String(e.message).slice(0, 120) }; }
    if ((tr.solLamports || 0) < lamports + prepared.maxFeeLamports + rail.TREASURY_SOL_RESERVE_LAMPORTS) return { state: "unavailable", id, reason: "treasury SOL is below the allocation plus fee and reserve" };
    if (available() < micros + (isStagedPackagePayment(t, id) ? rail.microsFor(prepared.maxFeeLamports, tr.solUsd) : 0)) return { state: "unavailable", id, reason: "treasury balance changed before allocation dispatch" };
    persist(t, () => { map()[id] = { id, version: 1, chain: "solana", limitMicros: micros, actualMicros: micros, lamports, recipient, state: "reserved", createdAt: iso(now) }; });
    persist(t, () => { Object.assign(map()[id], { state: "submitted", signature: prepared.signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, maxFeeLamports: prepared.maxFeeLamports, submittedAt: iso(now) }); });
    event?.("package", `${t.symbol}: ${reason} — sending ${(lamports / rail.LAMPORTS_PER_SOL).toFixed(4)} SOL to the platform DEX wallet (${prepared.signature.slice(0, 12)}…)`, { token: t.address });
    let verdict;
    try { await send(rpc, prepared.wire, { signature: prepared.signature }); verdict = await confirm(rpc, prepared.signature, { lastValidBlockHeight: prepared.lastValidBlockHeight, now }); }
    catch (e) { verdict = { state: "unknown", error: String(e.message || e) }; }
    if (verdict.state === "confirmed") {
      persist(t, () => settleRecord(t, map()[id], { signature: prepared.signature, lamports, feeLamports: prepared.maxFeeLamports, micros, reason, ledger, ledgerKey, now, extra: { slot: verdict.slot ?? null } }));
      event?.("package", `${t.symbol}: ${reason} — $${(micros / 1e6).toFixed(2)} delivered to the platform DEX wallet`, { token: t.address });
    } else if (verdict.state === "failed" || verdict.state === "expired") {
      persist(t, () => releaseRecord(map()[id], verdict.state === "failed" ? "transaction failed on chain; nothing moved" : "blockhash expired before landing; nothing moved"));
    } else {
      persist(t, () => { Object.assign(map()[id], { state: "uncertain", failure: String(verdict.error || "no confirmation within the window").slice(0, 160) }); });
      event?.("package", `${t.symbol}: ${reason} — allocation transfer outcome unknown (${prepared.signature.slice(0, 12)}…); operator reconciliation required, nothing is re-sent`, { token: t.address, level: "error" });
    }
    return view(map()[id]);
  } finally { inFlight?.delete(id); }
}

// ---------------------------------------------------------------- AI pocket: Jupiter SOL → USDC
export const JUPITER_API = () => env("JUPITER_API_BASE", "https://api.jup.ag/swap/v1").replace(/\/$/, "");
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const SWAP_MAX_PRIORITY_LAMPORTS = 1_000_000;   // 0.001 SOL
export const SWAP_FEE_ALLOWANCE_LAMPORTS = 10_000_000; // 0.01 SOL: fee + rent of a fresh wSOL/USDC account
export const SWAP_MAX_PRICE_IMPACT = 0.01;
async function jupiterFetch(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, { ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || !json || typeof json !== "object") throw fail(502, `Jupiter ${res.status}: ${(json?.error || text).toString().slice(0, 120)}`);
  return json;
}
export async function jupiterQuote({ lamports, slippageBps = 50, fetch: fetchImpl = globalThis.fetch } = {}) {
  const q = await jupiterFetch(fetchImpl, `${JUPITER_API()}/quote?inputMint=${rail.WSOL_MINT}&outputMint=${rail.USDC_MINT}&amount=${lamports}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
  const out = Number(q.outAmount), min = Number(q.otherAmountThreshold), impact = Number(q.priceImpactPct || 0);
  if (String(q.inputMint) !== rail.WSOL_MINT || String(q.outputMint) !== rail.USDC_MINT || String(q.inAmount) !== String(lamports)) throw fail(502, "Jupiter quote does not match the request");
  if (!Number.isSafeInteger(out) || out <= 0 || !Number.isSafeInteger(min) || min <= 0 || min > out) throw fail(502, "Jupiter quote carries no usable amounts");
  if (!(impact >= 0) || impact > SWAP_MAX_PRICE_IMPACT) throw fail(502, `Jupiter price impact ${impact} too high`);
  return { quote: q, outMicros: out, minOutMicros: min, priceImpact: impact };
}
export async function jupiterSwapTransaction({ quote, wallet, fetch: fetchImpl = globalThis.fetch } = {}) {
  const r = await jupiterFetch(fetchImpl, `${JUPITER_API()}/swap`, { method: "POST", body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: SWAP_MAX_PRIORITY_LAMPORTS, priorityLevel: "medium" } } }) });
  const wire = String(r.swapTransaction || ""), lastValidBlockHeight = Number(r.lastValidBlockHeight);
  if (!wire || !Number.isSafeInteger(lastValidBlockHeight)) throw fail(502, "Jupiter swap response is incomplete");
  return { wire, lastValidBlockHeight };
}
const parsedLamports = (acc) => (acc && Number.isSafeInteger(acc.lamports) ? acc.lamports : null);
const parsedTokenMicros = (acc) => { const a = acc?.data?.parsed?.info?.tokenAmount?.amount; return typeof a === "string" && /^\d+$/.test(a) ? Number(a) : acc === null ? 0 : null; };

/// Refills the treasury's USDC pocket (the x402 payment account on Solana) by swapping SOL
/// through Jupiter. The unsigned swap is decoded (fee payer = treasury, one signer), simulated
/// (our SOL leaves by at most the input + fee allowance, our USDC rises by at least the quoted
/// minimum), then signed, persisted with its signature and sent. Records in
/// bridgeUsageReservations (kind 'jupiter-swap') so unresolvedPocket() blocks a second refill.
export async function refillSolanaPocket(t, needMicros, { floorMicros, targetMicros, persist, ledger, event = null, unresolved },
  { rpc = solanaRpc(), signer = null, now = Date.now, fetch: fetchImpl = globalThis.fetch, confirm = rail.confirmBounded, send = rail.send, refresh = refreshSolanaTreasury } = {}) {
  const tr = t.treasury;
  await refresh(t, { rpc, now });
  const usdc = tr.usdcMicros || 0, floor = Math.max(floorMicros, needMicros);
  if (usdc >= floor) return usdc;
  if (unresolved(t)) throw fail(409, "a refill is already in flight or unresolved; operator reconciliation required before another request");
  if (!(tr.solUsd > 0)) throw fail(402, "SOL valuation is unavailable");
  const wantMicros = Math.max(targetMicros, needMicros) - usdc;
  if (!Number.isSafeInteger(wantMicros) || wantMicros <= 0) throw fail(400, "invalid AI pocket target");
  const lamportsIn = rail.lamportsFor(Math.ceil(wantMicros * 1.01), tr.solUsd);
  const vpsReserveMicros = t.vps?.state === "running" ? 2 * (t.vps.hourlyMicros || 0) : 0;
  const needLamports = lamportsIn + SWAP_FEE_ALLOWANCE_LAMPORTS + rail.TREASURY_SOL_RESERVE_LAMPORTS + rail.lamportsFor(vpsReserveMicros, tr.solUsd);
  if ((tr.solLamports || 0) < needLamports) throw fail(402, `treasury holds ${((tr.solLamports || 0) / 1e9).toFixed(4)} SOL; refilling the AI pocket needs ${(needLamports / 1e9).toFixed(4)} (including VPS reserves)`);
  if (!Number.isSafeInteger(tr.micros) || tr.micros - heldUsage(t) < rail.microsFor(lamportsIn, tr.solUsd)) throw fail(402, "AI pocket refill cannot use money reserved for other payments");
  const { quote, minOutMicros, outMicros } = await jupiterQuote({ lamports: lamportsIn, fetch: fetchImpl });
  if (minOutMicros < Math.floor(wantMicros * 0.97)) throw fail(502, `Jupiter would deliver $${(minOutMicros / 1e6).toFixed(2)} for a $${(wantMicros / 1e6).toFixed(2)} refill`);
  const s = signer || solanaTreasurySigner(t.address);
  if (s.address !== tr.wallet) throw fail(403, "treasury signer does not match the treasury wallet");
  const { wire, lastValidBlockHeight } = await jupiterSwapTransaction({ quote, wallet: tr.wallet, fetch: fetchImpl });
  const decoded = rail.decodeOutbound(wire);
  if (decoded.feePayer !== tr.wallet || decoded.numSigners !== 1 || decoded.signed) throw fail(502, "Jupiter transaction is not a single-signer transaction paid by the treasury");
  if (!decoded.staticAccounts.includes(JUPITER_PROGRAM)) throw fail(502, "Jupiter transaction does not call the Jupiter program");
  const ata = await rail.ataOf(tr.wallet);
  const sim = await rpc.simulateTransaction(wire, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "jsonParsed", addresses: [tr.wallet, ata] } });
  if (!sim || sim.err != null) throw fail(502, `Jupiter swap simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 120)}`);
  const [postWallet, postAta] = sim.accounts || [];
  const postLamports = parsedLamports(postWallet), postUsdc = parsedTokenMicros(postAta);
  if (postLamports == null || postUsdc == null) throw fail(502, "Jupiter swap simulation returned no balances");
  if (postLamports < (tr.solLamports || 0) - lamportsIn - SWAP_FEE_ALLOWANCE_LAMPORTS) throw fail(502, "Jupiter swap would take more SOL than quoted");
  if (postUsdc < usdc + minOutMicros) throw fail(502, "Jupiter swap would deliver less USDC than its own minimum");
  const id = "ai-pocket-sol-" + createHash("sha256").update(`${t.address}:${iso(now)}:${wire.slice(0, 64)}`).digest("hex").slice(0, 32);
  const binding = { wallet: tr.wallet, instanceId: String(t.vps?.instanceId || "legacy"), running: t.vps?.state === "running" };
  const limitMicros = rail.microsFor(lamportsIn + SWAP_FEE_ALLOWANCE_LAMPORTS, tr.solUsd);
  persist(t, () => {
    (t.bridgeUsageReservations ||= {})[id] = { id, version: 1, kind: "jupiter-swap", chain: "solana", binding, limitMicros, lamportsIn, minOutMicros, outMicros, state: "reserved", createdAt: iso(now), txs: [] };
    t.treasury.bridge = { requestId: id, check: null, startedAt: iso(now), status: "pending", dispatchState: "prepared", inFormatted: (lamportsIn / 1e9).toFixed(6), outFormatted: (outMicros / 1e6).toFixed(2), txs: [], kind: "jupiter-swap" };
  });
  const signed = await rail.signWire(wire, s);
  persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "submitted", signature: signed.signature, lastValidBlockHeight, txs: [signed.signature] }); t.treasury.bridge.dispatchState = "submitted"; t.treasury.bridge.txs = [signed.signature]; });
  event?.("bridge", `${t.symbol}: swapping ${(lamportsIn / 1e9).toFixed(4)} SOL → ${(outMicros / 1e6).toFixed(2)} USDC on Jupiter (${signed.signature.slice(0, 12)}…)`, { token: t.address });
  let verdict;
  try { await send(rpc, signed.wire, { signature: signed.signature }); verdict = await confirm(rpc, signed.signature, { lastValidBlockHeight, now, timeoutMs: 120_000 }); }
  catch (e) { verdict = { state: "unknown", error: String(e.message || e) }; }
  if (verdict.state === "confirmed") {
    await refresh(t, { rpc, now });
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "settled", settledAt: iso(now) }); t.treasury.bridge.status = "success"; ledger(t, 0, `AI pocket refill: ${(lamportsIn / 1e9).toFixed(4)} SOL → USDC on Jupiter (${signed.signature.slice(0, 10)}…)`, { tx: signed.signature, chain: "solana", billingId: id }); });
    return t.treasury.usdcMicros || 0;
  }
  if (verdict.state === "failed" || verdict.state === "expired") {
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "released", failure: verdict.state === "failed" ? "swap failed on chain; nothing moved" : "blockhash expired before landing; nothing moved" }); t.treasury.bridge.status = "failed"; });
    throw fail(502, verdict.state === "failed" ? "Jupiter swap failed on chain; nothing moved" : "Jupiter swap expired before landing; nothing moved");
  }
  persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "uncertain", failure: String(verdict.error || "no confirmation within the window").slice(0, 160) }); t.treasury.bridge.status = "uncertain"; ledger(t, 0, `AI pocket refill uncertain: ${signed.signature.slice(0, 10)}…; reconciliation required`); });
  throw fail(502, "Jupiter swap outcome unknown; operator reconciliation required");
}

// ── The Base pocket: Solana treasury → Base USDC through Relay ─────────────────────────────
export const BRIDGE_FEE_ALLOWANCE_LAMPORTS = 3_000_000;   // fee + rent for accounts the deposit may create (~0.003 SOL)
const MIN_POCKET_BRIDGE_MICROS = 500_000;                   // below $0.50 a bridge is mostly fees

/// Reads the Base pocket's USDC (Base RPC) into t.treasury.basePocket. A failed read keeps the
/// cached value; the pocket is a part of the treasury view (micros).
const basePocketReads = new WeakMap();
export async function refreshBasePocket(t, { usdcOnBase = null, ethOnBase = null, now = Date.now } = {}) {
  const p = t.treasury.basePocket;
  if (!p?.address) return null;
  // recordRealSpend bumps p.revision; a read that started before the debit is discarded. Captured
  // before any await so a debit during the read is never lost.
  const revision = p.revision || 0, address = p.address, startedAt = iso(now);
  const generation = (basePocketReads.get(p) || 0) + 1;
  basePocketReads.set(p, generation);
  p.readOk = false; p.observationStartedAt = null; p.observedAt = null; p.observedRevision = null; p.observedAddress = null;
  // Tests inject readers; offline a missing reader is never replaced by the network.
  const offline = process.env.GATEWAY_OFFLINE === "1";
  const chain = !offline && (!usdcOnBase || !ethOnBase) ? await import("./chain.mjs") : null;
  const read = usdcOnBase || chain?.usdcMicros || null, readEth = ethOnBase || (chain ? (async (a) => Math.round(Number(await chain.baseEth(a)) * 1e18)) : null);
  if (!read) return p.usdcMicros || 0;
  p.ethReadOk = false;
  const ethRevision = p.ethRevision || 0;   // bumped when a transfer's gas is subtracted; a stale read is discarded
  if (readEth) { try { const wei = await readEth(p.address); if (Number.isSafeInteger(wei) && wei >= 0 && (p.ethRevision || 0) === ethRevision && basePocketReads.get(p) === generation && t.treasury.basePocket === p && p.address === address) { p.ethWei = wei; p.ethReadOk = true; } } catch {} }
  let value = null;
  try { const v = await read(p.address); if (Number.isSafeInteger(v) && v >= 0) value = v; } catch {}
  if (t.treasury.basePocket !== p || p.address !== address || basePocketReads.get(p) !== generation) return t.treasury.basePocket?.usdcMicros || 0;
  if (value != null && (p.revision || 0) === revision) {
    p.usdcMicros = value; p.refreshedAt = iso(now); p.readOk = true;
    p.observationStartedAt = startedAt; p.observedAt = p.refreshedAt; p.observedRevision = revision; p.observedAddress = address;
    settleSeenDeliveries(t, now);
  }
  recomputeSolanaMicros(t.treasury);
  return p.usdcMicros || 0;
}
/// A Relay bridge whose deposit landed and whose receipt on Base was not visible at the time
/// (RPC lag) is settled once a later read shows the pocket holding at least 98 % of the quoted
/// output on top of what it held before. Only that one failure mode is reconciled here.
export function settleSeenDeliveries(t, now = Date.now, { persist = (tok, mutate) => mutate(), ledger = null } = {}) {
  const p = t.treasury.basePocket; if (!p?.address || p.readOk !== true) return [];
  const settled = [];
  for (const r of Object.values(t.bridgeUsageReservations || {})) {
    if (!["relay-solana-base", "relay-solana-base-gas"].includes(r.kind) || r.state !== "uncertain" || !/receipt not observed/.test(String(r.failure || ""))) continue;
    const before = Number.isSafeInteger(r.pocketBefore) ? r.pocketBefore : 0;
    if (r.kind === "relay-solana-base-gas") { if (p.ethReadOk !== true || !((p.ethWei || 0) > before)) continue; }
    else if ((p.usdcMicros || 0) < before + Math.floor((r.outMicros || 0) * 0.98)) continue;
    persist(t, () => {
      Object.assign(r, { state: "settled", settledAt: iso(now), failure: undefined, reconciled: "delivery seen on a later read" });
      if (t.treasury.bridge?.requestId === r.requestId) { t.treasury.bridge.status = "success"; t.treasury.bridge.settledAt = iso(now); }
      ledger?.(t, 0, `AI pocket refill delivered: ${r.kind === "relay-solana-base-gas" ? "ETH (gas)" : (r.outMicros ? (r.outMicros / 1e6).toFixed(2) : "?") + " USDC"} on Base (Relay ${String(r.requestId).slice(0, 10)}…)`, { chain: "solana", billingId: r.id, relay: r.requestId });
    });
    settled.push(r.id);
  }
  return settled;
}

/// Refills the Base pocket from the treasury's own money: its Solana USDC when that covers the
/// need (or at least $0.50), otherwise SOL — through ONE Relay deposit the treasury signs after
/// the transaction is decoded, simulated and bounded (like the Jupiter swap). Durable states in
/// bridgeUsageReservations (kind 'relay-solana-base'): reserved → submitted (signature persisted
/// before the send) → settled | released (provably never landed) | uncertain (reconcile).
export const BASE_GAS_FLOOR_WEI = 20_000_000_000_000;      // 0.00002 ETH ≈ 50 USDC transfers at Base's usual gas price
export const BASE_GAS_TOPUP_MICROS = 300_000;               // $0.30 of SOL → ETH when the pocket runs dry
/// ETH for the Base pocket's own transfers (the direct NanoGPT rail): the same guarded Relay
/// deposit, SOL in, native ETH out, settled when the pocket's ETH is seen to rise.
export async function refillBaseGas(t, { persist, ledger, event = null, unresolved, pocketAddress, topupMicros = BASE_GAS_TOPUP_MICROS, floorWei = BASE_GAS_FLOOR_WEI }, deps = {}) {
  return refillBasePocket(t, 0, { floorMicros: 0, targetMicros: 0, persist, ledger, event, unresolved, pocketAddress, destination: "eth", topupMicros, floorWei }, deps);
}
export async function refillBasePocket(t, needMicros, { floorMicros, targetMicros, persist, ledger, event = null, unresolved, pocketAddress, destination = "usdc", topupMicros = 0, floorWei = 0 }, deps = {}) {
  const { rpc = solanaRpc(), signer = null, now = Date.now, relay: relayImpl = null, confirm = rail.confirmBounded, send = rail.send, refresh = refreshSolanaTreasury, usdcOnBase = null, ethOnBase = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deliveryReads = 8 } = deps;
  const gas = destination === "eth";
  const tr = t.treasury;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(pocketAddress || ""))) throw fail(500, "a Base pocket address is required");
  tr.basePocket ||= { address: pocketAddress, usdcMicros: 0 };
  if (tr.basePocket.address !== pocketAddress) throw fail(500, "the Base pocket on file does not match");
  await refresh(t, { rpc, now });
  await refreshBasePocket(t, { usdcOnBase, ethOnBase, now });
  const have = gas ? (tr.basePocket.ethWei || 0) : (tr.basePocket.usdcMicros || 0), floor = gas ? floorWei : Math.max(floorMicros, needMicros);
  if (have >= floor) return have;
  if (tr.basePocket.readOk !== true) throw fail(502, "the Base pocket balance could not be read; no deposit without a baseline");
  if (gas && (tr.basePocket.ethReadOk !== true || !Number.isSafeInteger(tr.basePocket.ethWei))) throw fail(502, "the Base pocket's ETH could not be read; no deposit without a baseline");
  if (unresolved(t)) throw fail(409, "a refill is already in flight or unresolved; operator reconciliation required before another request");
  const wantMicros = gas ? topupMicros : Math.max(targetMicros, needMicros) - have;
  if (!Number.isSafeInteger(wantMicros) || wantMicros <= 0) throw fail(400, "invalid AI pocket target");
  const rl = relayImpl || await import("./relay.mjs");
  const usdcHave = tr.usdcMicros || 0;
  let origin, amount, inputMicros, lamportsIn = 0, usdcIn = 0;
  if (!gas && usdcHave >= Math.max(Math.ceil(needMicros * 1.02), MIN_POCKET_BRIDGE_MICROS)) {
    origin = "USDC"; usdcIn = Math.min(usdcHave, Math.ceil(wantMicros * 1.02)); amount = String(usdcIn); inputMicros = usdcIn;
    if ((tr.solLamports || 0) < BRIDGE_FEE_ALLOWANCE_LAMPORTS + rail.TREASURY_SOL_RESERVE_LAMPORTS) throw fail(402, "treasury SOL cannot pay the bridge fee");
  } else {
    if (!(tr.solUsd > 0)) throw fail(402, "SOL valuation is unavailable");
    origin = "SOL"; lamportsIn = rail.lamportsFor(Math.ceil(wantMicros * 1.03), tr.solUsd); amount = String(lamportsIn); inputMicros = rail.microsFor(lamportsIn, tr.solUsd);
    const vpsReserveMicros = t.vps?.state === "running" ? 2 * (t.vps.hourlyMicros || 0) : 0;
    const needLamports = lamportsIn + BRIDGE_FEE_ALLOWANCE_LAMPORTS + rail.TREASURY_SOL_RESERVE_LAMPORTS + rail.lamportsFor(vpsReserveMicros, tr.solUsd);
    if ((tr.solLamports || 0) < needLamports) throw fail(402, `treasury holds ${((tr.solLamports || 0) / 1e9).toFixed(4)} SOL; refilling the AI pocket needs ${(needLamports / 1e9).toFixed(4)} (including VPS reserves)`);
  }
  if (!Number.isSafeInteger(tr.micros) || tr.micros - heldUsage(t) < inputMicros) throw fail(402, "AI pocket refill cannot use money reserved for other payments");
  const q = await rl.quoteSolanaToBase({ user: tr.wallet, recipient: pocketAddress, originCurrency: origin, amount, ...(gas ? { destinationCurrency: "0x0000000000000000000000000000000000000000" } : {}) });
  // USDC out is compared in micros; ETH out is compared in USD (Relay's own valuation of the output).
  const outWorthMicros = gas ? Math.round(q.outUsd * 1e6) : q.outMicros;
  if (outWorthMicros < Math.floor(Math.min(wantMicros, inputMicros) * 0.8)) throw fail(502, `Relay would deliver $${(outWorthMicros / 1e6).toFixed(2)} for a $${(inputMicros / 1e6).toFixed(2)} bridge`);
  const s = signer || solanaTreasurySigner(t.address);
  if (s.address !== tr.wallet) throw fail(403, "treasury signer does not match the treasury wallet");
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const tables = await rail.fetchLookupTables(rpc, q.lookupTables);
  const { wire } = rail.buildForeign({ feePayer: tr.wallet, instructions: q.instructions, blockhash, lastValidBlockHeight, lookupTables: tables });
  const decoded = rail.decodeOutbound(wire);
  if (decoded.feePayer !== tr.wallet || decoded.numSigners !== 1 || decoded.signed) throw fail(502, "Relay transaction is not a single-signer transaction paid by the treasury");
  const ata = await rail.ataOf(tr.wallet);
  // Fresh pre-balances for the bound: money that arrived since the refresh must not widen it.
  const [preLamports, preUsdcRaw] = await Promise.all([rpc.getBalance(tr.wallet), rpc.getTokenAccountBalance(ata)]);
  const preUsdc = preUsdcRaw ?? 0;
  if (!Number.isSafeInteger(preLamports) || !Number.isSafeInteger(preUsdc)) throw fail(502, "treasury balances could not be read before the deposit");
  if (origin === "USDC" && preUsdc < usdcIn) throw fail(402, "treasury USDC changed before the deposit");
  const sim = await rpc.simulateTransaction(wire, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "jsonParsed", addresses: [tr.wallet, ata] } });
  if (!sim || sim.err != null) throw fail(502, `Relay deposit simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 120)}`);
  const [postWallet, postAta] = sim.accounts || [];
  const postLamports = parsedLamports(postWallet), postUsdc = postAta == null ? (preUsdc === 0 ? 0 : null) : parsedTokenMicros(postAta);
  if (postLamports == null || postUsdc == null) throw fail(502, "Relay deposit simulation returned no balances");
  if (postLamports < preLamports - lamportsIn - BRIDGE_FEE_ALLOWANCE_LAMPORTS) throw fail(502, "Relay deposit would take more SOL than quoted");
  if (postUsdc < preUsdc - usdcIn) throw fail(502, "Relay deposit would take more USDC than quoted");
  const id = "ai-pocket-base-" + createHash("sha256").update(`${t.address}:${q.requestId}`).digest("hex").slice(0, 32);
  if (t.bridgeUsageReservations?.[id] || Object.values(t.bridgeUsageReservations || {}).some((r) => r.requestId === q.requestId)) throw fail(409, "this Relay intent was already used; no repeat deposit");
  const binding = { wallet: tr.wallet, instanceId: String(t.vps?.instanceId || "legacy"), running: t.vps?.state === "running" };
  const limitMicros = inputMicros + rail.microsFor(BRIDGE_FEE_ALLOWANCE_LAMPORTS, tr.solUsd || 0);
  persist(t, () => {
    (t.bridgeUsageReservations ||= {})[id] = { id, version: 1, kind: gas ? "relay-solana-base-gas" : "relay-solana-base", chain: "solana", binding, limitMicros, origin, lamportsIn, usdcIn, outMicros: q.outMicros, outUsd: q.outUsd, pocket: pocketAddress, pocketBefore: have, requestId: q.requestId, check: q.check, state: "reserved", createdAt: iso(now), txs: [] };
    tr.bridge = { requestId: q.requestId, check: q.check, startedAt: iso(now), status: "pending", dispatchState: "prepared", inFormatted: q.inFormatted, outFormatted: q.outFormatted, txs: [], kind: gas ? "relay-solana-base-gas" : "relay-solana-base" };
  });
  const signed = await rail.signWire(wire, s);
  persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "submitted", signature: signed.signature, lastValidBlockHeight, txs: [signed.signature] }); tr.bridge.dispatchState = "submitted"; tr.bridge.txs = [signed.signature]; });
  event?.("bridge", `${t.symbol}: bridging ${q.inFormatted} ${origin} → ${q.outFormatted} ${gas ? "ETH (gas)" : "USDC"} on Base via Relay (${signed.signature.slice(0, 12)}…)`, { token: t.address });
  let verdict;
  try { await send(rpc, signed.wire, { signature: signed.signature }); verdict = await confirm(rpc, signed.signature, { lastValidBlockHeight, now, timeoutMs: 120_000 }); }
  catch (e) { verdict = { state: "unknown", error: String(e.message || e) }; }
  if (verdict.state === "failed" || verdict.state === "expired") {
    // Provably never landed: the record and the bridge view are 'released', so the next refill may start.
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "released", failure: verdict.state === "failed" ? "deposit failed on chain; nothing moved" : "blockhash expired before landing; nothing moved" }); tr.bridge.status = "released"; });
    throw fail(502, verdict.state === "failed" ? "Relay deposit failed on chain; nothing moved" : "Relay deposit expired before landing; nothing moved");
  }
  if (verdict.state !== "confirmed") {
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "uncertain", failure: String(verdict.error || "no confirmation within the window").slice(0, 160) }); tr.bridge.status = "uncertain"; ledger(t, 0, `AI pocket bridge uncertain: ${signed.signature.slice(0, 10)}…; reconciliation required`); });
    throw fail(502, "Relay deposit outcome unknown; operator reconciliation required");
  }
  await refresh(t, { rpc, now });
  // The deposit landed on Solana; Relay now delivers USDC on Base. Wait for its receipt.
  const st = await rl.waitSettled(q.check, { timeoutMs: 4 * 60_000 });
  if (st.status !== "success") {
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "uncertain", failure: `Relay ${st.status}` }); tr.bridge.status = ["failure", "refund", "timeout"].includes(st.status) ? st.status : "uncertain"; ledger(t, 0, `AI pocket bridge ${tr.bridge.status}: ${q.requestId.slice(0, 10)}…; reconciliation required`); });
    throw fail(502, `Relay bridge ${st.status}; operator reconciliation required`);
  }
  const pocketBefore = have;
  // Relay's "success" runs a few seconds ahead of what a public Base RPC shows: re-read for a while
  // before calling the delivery unverified (2026-09-23: both first bridges sat 'uncertain' for one tick).
  let delivered = false;
  for (let i = 0; i < Math.max(1, deliveryReads); i++) {
    await refreshBasePocket(t, { usdcOnBase, ethOnBase, now });
    delivered = gas
      ? tr.basePocket.ethReadOk === true && Number.isSafeInteger(tr.basePocket.ethWei) && tr.basePocket.ethWei > pocketBefore
      : tr.basePocket.readOk === true && (tr.basePocket.usdcMicros || 0) >= pocketBefore + Math.floor(q.outMicros * 0.98);
    if (delivered) break;
    await sleep(5_000);
  }
  if (!delivered) {
    // Relay says success but the pocket does not show it (RPC down, or a short delivery): keep the
    // liability until an operator or a later read confirms; never spend this record again.
    persist(t, () => { Object.assign(t.bridgeUsageReservations[id], { state: "uncertain", failure: "Relay reported success; Base USDC receipt not observed yet", relayTxs: st.txHashes || [] }); tr.bridge.status = "uncertain"; ledger(t, 0, `AI pocket bridge delivery unverified: ${q.requestId.slice(0, 10)}…; reconciliation required`); });
    throw fail(502, "Relay reported success but the Base pocket receipt is not visible yet; reconciliation required");
  }
  persist(t, () => {
    Object.assign(t.bridgeUsageReservations[id], { state: "settled", settledAt: iso(now), relayTxs: st.txHashes || [] });
    tr.bridge.status = "success"; tr.bridge.settledAt = iso(now);
    ledger(t, 0, `AI pocket refill: ${q.inFormatted} ${origin} → ${q.outFormatted} ${gas ? "ETH (gas)" : "USDC"} on Base via Relay (${signed.signature.slice(0, 10)}…)`, { tx: signed.signature, chain: "solana", billingId: id, relay: q.requestId });
  });
  return gas ? (tr.basePocket.ethWei || 0) : (tr.basePocket.usdcMicros || 0);
}
