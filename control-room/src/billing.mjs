// Real money, real clock. A token in "wallet" mode has a treasury wallet on Robinhood
// Chain that holders fund with ETH. From it, and only from it:
//   * VPS hours: ETH → operations wallet, one transfer per hour;
//   * the AI pocket: Base USDC, refilled through Relay (Robinhood ETH → Base USDC)
//     whenever it drops below the floor, so x402 payments never find it empty;
//   * AI requests: Base USDC through NanoGPT's x402 rail (x402.mjs).
// When the treasury cannot cover the next hour the VPS is torn down. One bridge at a
// time per token; a bridge that does not settle is recorded, never repeated blindly.
import { ethers } from "ethers";
import { createHash } from "node:crypto";
import { get, save, saveDurable, event } from "./store.mjs";
import { CHAINS, baseRpc, usdcMicros, baseEth, submitAuthorizedTransfer, USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES, USDC_BASE, sendUsdcFromOps } from "./chain.mjs";
import { opsAddress, opsSigner, signTypedDataAsTreasury, createBasePocket } from "./wallets.mjs";
import { env } from "./env.mjs";
import { isStagedLaunch, runtimeVpsReserveMicros } from "./launch-package.mjs";
import { unheldVpsReserveMicros, packagePaymentAvailableMicros, isStagedPackagePayment } from "./runtime-budget.mjs";
import { teardown } from "./deploy.mjs";
import { vpsBillingDecision, holdVpsUsageForReview, assertVpsUsageDispatchAllowed } from './vps-billing-recovery.mjs';
import * as relay from "./relay.mjs";
import { refreshUsagePeriod, recordRealSpend } from "./economy.mjs";
import { heldUsage, heldUsageForBasePocket, settleUsage, settleProposalUsage, refuseUsage, refuseProposalUsage, settleMissionUsage, releaseMissionUsage } from "./usage-budget.mjs";
import { withBillingTreasury } from './treasury-lock.mjs';
import { refreshSolanaTreasury, solanaDebitOnce, solanaAllocationOnce, refillSolanaPocket, refillBasePocket, refillBaseGas, refreshBasePocket, solanaAiRail, aiPocketMicros, BASE_GAS_FLOOR_WEI } from './solana-billing.mjs';
export { solanaAiRail, aiPocketMicros };
/// How a Base pocket pays NanoGPT: 'direct' (USDC sent to NanoGPT's per-request address, no
/// facilitator — the rail that works while Coinbase refuses NanoGPT's x402 settlements) or 'x402'.
export const nanoBaseRail = () => (env("NANOGPT_BASE_RAIL", "direct") === "x402" ? "x402" : "direct");
/// Direct-rail payments whose outcome this process did not see to the end. The Base receipt decides:
/// landed → the spend is booked exactly once (ledger only: the balance reads already show it) and the
/// open hold settled; reverted → released; an 'intent' older than 15 min never had a signed
/// transaction → released; a signed transaction with no receipt is released only once its nonce has
/// been consumed by another transaction (it can never land then) — otherwise it stays uncertain.
/// Journal state is re-read after every await: the live request may book meanwhile. Never re-sends.
export async function reconcileDirectPayments(t, { receipt = null, nonceNow = null, now = Date.now } = {}) {
  const journal = t.aiDirectPayments || {}; const out = [];
  const chain = (!receipt || !nonceNow) ? await import("./chain.mjs") : null;
  const readReceipt = receipt || chain.baseReceipt, readNonce = nonceNow || chain.baseNonce;
  const settleHold = (e, tx) => {
    if (e.scopeKind === "mission" && ["submitted", "uncertain"].includes(t.missionUsageReservations?.[e.scope]?.state)) { settleMissionUsage(t, e.scope, e.amountMicros); t.missionUsageReservations[e.scope].settlementTx = tx; }
    if (e.scopeKind === "personal" && t.usageReservations?.[e.scope] && ["submitted", "uncertain"].includes(t.usageReservations[e.scope].state)) { settleUsage(t, e.scope, e.amountMicros); t.usageReservations[e.scope].settlementTx = tx; }
    if (e.scopeKind === "proposal" && t.proposalUsageReservations?.[e.scope] && ["submitted", "uncertain"].includes(t.proposalUsageReservations[e.scope].state)) { settleProposalUsage(t, e.scope, e.amountMicros); t.proposalUsageReservations[e.scope].settlementTx = tx; }
  };
  const releaseHold = (e, why) => {
    if (e.scopeKind === "mission" && ["submitted", "uncertain"].includes(t.missionUsageReservations?.[e.scope]?.state)) releaseMissionUsage(t, e.scope, { refused: true });
    if (e.scopeKind === "personal" && t.usageReservations?.[e.scope] && ["submitted", "uncertain"].includes(t.usageReservations[e.scope].state)) refuseUsage(t, e.scope, why);
    if (e.scopeKind === "proposal" && t.proposalUsageReservations?.[e.scope] && ["submitted", "uncertain"].includes(t.proposalUsageReservations[e.scope].state)) refuseProposalUsage(t, e.scope, why);
  };
  for (const e of Object.values(journal)) {
    if (e.state === "intent" && !e.txHash) {
      if (now() - Date.parse(e.at) > 15 * 60_000) { releaseHold(e, "no transaction was ever signed"); Object.assign(e, { state: "released", reconciledAt: new Date(now()).toISOString(), note: "no signed transaction; nothing moved" }); out.push({ id: e.paymentId, verdict: "never-signed" }); }
      continue;
    }
    if (!["signed", "uncertain", "sent"].includes(e.state) || e.booked || !e.txHash) continue;
    let rc = null; try { rc = await readReceipt(e.txHash); } catch { continue; }
    if (!["signed", "uncertain", "sent"].includes(e.state) || e.booked) continue;   // the live request finished during the await
    if (rc && rc.status === 1) {
      const model = e.model || t.agent?.ai?.model || "";
      settleHold(e, e.txHash);
      recordRealSpend(t, e.amountMicros, `AI request (nanogpt direct, ${model}) — reconciled from the receipt`, { tx: e.txHash, chain: "base", pocket: "base", paymentId: e.paymentId, model, ledgerOnly: true });
      Object.assign(e, { state: e.state === "sent" ? "sent" : "uncertain", booked: true, reconciledAt: new Date(now()).toISOString(), note: "landed; answer not delivered to anyone" });
      out.push({ id: e.paymentId, verdict: "landed" });
    } else if (rc && rc.status === 0) {
      releaseHold(e, "USDC transfer reverted on Base");
      Object.assign(e, { state: "released", reconciledAt: new Date(now()).toISOString(), note: "reverted on chain; nothing moved" });
      out.push({ id: e.paymentId, verdict: "reverted" });
    } else if (!rc && Number.isInteger(e.nonce)) {
      let next = null; try { next = await readNonce(t.treasury.basePocket?.address || ""); } catch { continue; }
      if (!["signed", "uncertain", "sent"].includes(e.state) || e.booked) continue;
      if (Number.isInteger(next) && next > e.nonce) {
        // The nonce went to another transaction: this one can never land.
        releaseHold(e, "USDC transfer superseded; it can no longer land");
        Object.assign(e, { state: "released", reconciledAt: new Date(now()).toISOString(), note: "nonce consumed by another transaction; nothing moved" });
        out.push({ id: e.paymentId, verdict: "superseded" });
      }
    }
  }
  if (out.length) { event("ai", `${t.symbol}: reconciled ${out.length} direct payment(s): ${out.map((o) => o.verdict).join(", ")}`, { token: t.address, level: "warn" }); save(); }
  return out;
}
/// ETH for the pocket's own transfers on the direct rail; refilled from the treasury's SOL through Relay.
export async function ensureBaseGas(t) {
  if (t.treasury.chain !== "solana" || solanaAiRail() !== "base") return t.treasury.basePocket?.ethWei || 0;
  if (process.env.GATEWAY_OFFLINE === "1") throw bridgeFail(409, "offline: no Base gas refill");
  if (t.treasury.basePocket?.address && t.treasury.basePocket.ethReadOk !== true) await refreshBasePocket(t).catch(() => {});
  if (t.treasury.basePocket?.ethReadOk === true && (t.treasury.basePocket.ethWei || 0) >= BASE_GAS_FLOOR_WEI) return t.treasury.basePocket.ethWei;
  if (pocketInFlight.has(t.address)) throw bridgeFail(409, "a refill is already in flight; no second request");
  pocketInFlight.add(t.address);
  try { return await withBillingTreasury(t, () => refillBaseGas(t, { persist: persistBridgeUsage, ledger, event, unresolved: unresolvedPocket, pocketAddress: createBasePocket(t.address) })); }
  finally { pocketInFlight.delete(t.address); }
}
import { SOLANA_OPS_ADDRESS, isSolanaAddress } from './solana.mjs';

const HOUR_MS = 3_600_000;
const ROBINHOOD = CHAINS.find((c) => c.key === "robinhood");
export const USDG = ethers.getAddress(ROBINHOOD.stable.addr);
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
let rhProvider = null;
export const rhRpc = () => (rhProvider ||= new ethers.JsonRpcProvider(ROBINHOOD.rpc, ROBINHOOD.id, { staticNetwork: true, batchMaxCount: 1 }));
const GAS_RESERVE_ETH = 0.00005;          // kept on Robinhood for the treasury's own transactions

export const pocketFloorMicros = () => Math.round(Number(get().settings.aiPocketFloorUsd ?? 1) * 1e6);
export const pocketTargetMicros = () => Math.round(Number(get().settings.aiPocketTargetUsd ?? 3) * 1e6);
const treasuryReads = new WeakMap();

/// Reads the treasury's balances (ETH on Robinhood, USDC on Base, USDG if any) and
/// caches them on the token, valued in micro-dollars.
export async function refreshTreasury(t) {
  if (t.treasury.mode !== "wallet") return t.treasury;
  const generation = (treasuryReads.get(t) || 0) + 1;
  treasuryReads.set(t, generation);
  if (t.treasury.chain === "solana") {
    const tr = await refreshSolanaTreasury(t, { offline: process.env.GATEWAY_OFFLINE === "1" });
    if (treasuryReads.get(t) !== generation || t.treasury !== tr) return t.treasury;
    const nativeStartedAt = tr.marketingObservationStartedAt, nativeObservedAt = tr.marketingObservedAt, nativeProof = tr.marketingNativeObservation;
    const pocket = tr.basePocket;
    if (pocket?.address) {
      // micros always includes this USDC pocket, regardless of the selected AI
      // rail. A native-only read cannot certify that aggregate balance.
      tr.marketingObservedAt = null; tr.marketingObservationStartedAt = null;
      await refreshBasePocket(t).catch(() => {});
      if (treasuryReads.get(t) !== generation || t.treasury !== tr) return t.treasury;
      const start = Date.parse(nativeStartedAt || ''), end = Date.parse(nativeObservedAt || '');
      const pocketStart = Date.parse(pocket.observationStartedAt || ''), pocketEnd = Date.parse(pocket.observedAt || '');
      if (tr.marketingNativeObservation === nativeProof && nativeProof && tr.basePocket === pocket && pocket.readOk === true && pocket.observedAddress === pocket.address &&
          pocket.observedRevision === (pocket.revision || 0) && Number.isSafeInteger(pocket.usdcMicros) && pocket.usdcMicros >= 0 &&
          Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= pocketStart && pocketStart <= pocketEnd) {
        tr.marketingObservationStartedAt = nativeStartedAt; tr.marketingObservedAt = pocket.observedAt;
        tr.marketingBasePocketObservation = { address: pocket.address, revision: pocket.observedRevision, usdcMicros: pocket.usdcMicros,
          startedAt: pocket.observationStartedAt, observedAt: pocket.observedAt };
      }
    }
    return tr;
  }
  const observationStartedAt = new Date().toISOString();
  if (process.env.GATEWAY_OFFLINE === "1") {   // tests: keep whatever the test put in the cache
    t.treasury.ethMicros = Math.round((t.treasury.robinhoodEth || 0) * (t.treasury.ethUsd || 0) * 1e6);
    t.treasury.micros = t.treasury.ethMicros + (t.treasury.usdcMicros || 0) + (t.treasury.usdgMicros || 0);
    t.treasury.marketingObservedAt = new Date().toISOString();
    t.treasury.marketingObservationStartedAt = observationStartedAt;
    return t.treasury;
  }
  const addr = t.treasury.wallet;
  const [rhEth, usdc, usdg, ethUsd] = await Promise.all([
    rhRpc().getBalance(addr).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    usdcMicros(addr).catch(() => null),
    rhRpc().call({ to: USDG, data: new ethers.Interface(ERC20).encodeFunctionData("balanceOf", [addr]) }).then((r) => Number(BigInt(r))).catch(() => null),
    relay.nativeUsd(ROBINHOOD.id).catch(() => null),
  ]);
  if (treasuryReads.get(t) !== generation || t.treasury.wallet !== addr) return t.treasury;
  if (rhEth != null) t.treasury.robinhoodEth = rhEth;
  if (usdc != null) t.treasury.usdcMicros = usdc;
  if (usdg != null) t.treasury.usdgMicros = usdg;
  if (ethUsd != null) t.treasury.ethUsd = ethUsd;
  t.treasury.ethMicros = Math.round((t.treasury.robinhoodEth || 0) * (t.treasury.ethUsd || 0) * 1e6);
  t.treasury.micros = t.treasury.ethMicros + (t.treasury.usdcMicros || 0) + (t.treasury.usdgMicros || 0);
  t.treasury.refreshedAt = new Date().toISOString();
  // Existing UI can retain cached components, but new launch-package funding
  // cannot use an incomplete refresh as evidence for a payment or rental.
  t.treasury.marketingObservedAt = [rhEth, usdc, usdg, ethUsd].every(v => Number.isFinite(v) && v >= 0) && ethUsd > 0
    ? t.treasury.refreshedAt : null;
  t.treasury.marketingObservationStartedAt = t.treasury.marketingObservedAt ? observationStartedAt : null;
  return t.treasury;
}

function ledger(t, deltaMicros, reason, extra = {}) {
  t.treasury.ledger.unshift({ simAt: new Date().toISOString(), deltaMicros, balanceMicros: t.treasury.micros, reason, ...extra });
  if (t.treasury.ledger.length > 400) t.treasury.ledger.length = 400;
}

const weiFor = (micros, ethUsd) => ethers.parseEther(((micros / 1e6) / ethUsd).toFixed(18));

// Shared with the AI reservation ledger. An unresolved hourly payment is a
// liability, not permission to retry on the same or another chain.
const vpsBillingInFlight = new Set();
const billingHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function hourlyBinding(t, ops, micros) {
  return { token: t.treasury.chain==='solana'?t.address:t.address.toLowerCase(), treasury: t.treasury.chain==='solana'?t.treasury.wallet:t.treasury.wallet.toLowerCase(), recipient: /^0x/i.test(ops)?ops.toLowerCase():ops,
    instanceId: String(t.vps.instanceId || 'legacy'), startedAt: t.vps.startedAt || null,
    lastBilledAt: t.vps.lastBilledAt || null, micros };
}
function persistAiUsage(t, mutate) {
  const keys = ['aiUsageReservations','aiAccountUsage','treasury'];
  const before = keys.map(key => [key,Object.hasOwn(t,key),Object.hasOwn(t,key)?JSON.parse(JSON.stringify(t[key])):null]);
  try { const result=mutate();saveDurable();return result; }
  catch(e) { for(const [key,exists,value]of before){if(exists)t[key]=value;else delete t[key];}e.aiPersistenceFailure=true;throw e; }
}
/// Account billing: the owner's provider account paid for an answer; the project's treasury pays the
/// platform back on-chain (one SOL transfer per settlement, the VPS-hour rail). A failed or pending
/// debit is carried in aiAccountUsage.unsettledMicros and retried by the billing tick. Solana only.
async function chargeAiAccount(t, micros, { id, reason = 'AI usage (provider account)', settlingOwed = false }) {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error('invalid AI usage amount');
  if (t.treasury?.chain !== 'solana') return { paid: false, reason: 'account billing settles on Solana treasuries only' };
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(String(id || ''))) throw new Error('invalid AI usage id');
  const binding = { token: t.address, treasury: t.treasury.wallet, micros };
  try { return await withBillingTreasury(t, () => solanaDebitOnce(t, { id, micros, reason, recipient: SOLANA_OPS_ADDRESS, records: () => (t.aiUsageReservations ||= {}), persist: persistAiUsage, ledger, binding, reservedMicros: settlingOwed ? Math.min(micros, t.aiAccountUsage?.unsettledMicros || 0) : 0, event })); }
  catch (e) { if (e.status === 409) return { paid: false, pending: true, reason: 'Treasury transaction requires reconciliation before billing' }; throw e; }
}
/// One idempotent provider charge becomes a durable obligation before its AI hold
/// is released. Callers that also settle a request hold save both in ONE transaction.
function oweAiAccountUsage(t, micros, { id, reason = 'AI usage (provider account)' }) {
  if (!Number.isSafeInteger(micros) || micros < 0 || !/^[a-zA-Z0-9:_-]{8,180}$/.test(String(id || ''))) throw new Error('invalid AI usage obligation');
  const usage = (t.aiAccountUsage ||= { unsettledMicros: 0, settledMicros: 0, requests: 0, lastAt: null });
  const entries = usage.obligations ||= {};
  if (entries[id]) {
    if (entries[id].micros !== micros) throw new Error('AI usage obligation changed');
    return usage.unsettledMicros;
  }
  if (Object.keys(entries).length >= 20_000) throw new Error('AI usage history requires archival');
  entries[id] = { micros, createdAt: new Date().toISOString() };
  usage.requests += 1; usage.lastAt = new Date().toISOString(); usage.unsettledMicros += micros;
  ledger(t, 0, `${reason}: $${(micros / 1e6).toFixed(4)} owed to the platform`, { billingId: id, owed: true });
  return usage.unsettledMicros;
}
async function bookAiAccountUsage(t, micros, { id, reason }) {
  persistAiUsage(t, () => oweAiAccountUsage(t, micros, { id, reason }));
  return await settleOwedAiUsage(t) || { paid: false, reason: 'AI usage retained for the next settlement batch' };
}
/// A durable batch has ONE identity for its entire lifecycle, across minutes and
/// restarts. An ambiguous older transfer is reconciled before a new one is created.
const aiSettlementInFlight = new WeakSet();
async function settleOwedAiUsage(t, options = {}) {
  if (aiSettlementInFlight.has(t)) return { paid: false, pending: true, reason: 'AI settlement is already in progress' };
  aiSettlementInFlight.add(t);
  try { return await settleOwedAiUsageOnce(t, options); }
  finally { aiSettlementInFlight.delete(t); }
}
async function settleOwedAiUsageOnce(t, { charge = chargeAiAccount } = {}) {
  const usage = t.aiAccountUsage, owed = usage?.unsettledMicros || 0;
  if (owed < 10_000) return null;
  let batch = usage.pendingBatch;
  if (!batch) {
    // Older code saved a settled transfer before decrementing the aggregate debt.
    // Without a durable batch/sequence we cannot distinguish that crash from new
    // debt after a successful payment, so never pay it again automatically.
    if (!Number.isSafeInteger(usage.settlementSequence) && Object.values(t.aiUsageReservations || {}).some(r => r?.state === 'settled'))
      return { paid: false, pending: true, reason: 'Legacy settled AI debit and remaining debt require reconciliation; no new payment' };
    const old = Object.values(t.aiUsageReservations || {}).filter(r => ['reserved','submitted','uncertain'].includes(r?.state));
    if (old.length > 1) return { paid: false, pending: true, reason: 'Multiple prior AI debits require reconciliation; no new payment' };
    if (old.length && (!Number.isSafeInteger(old[0].limitMicros) || old[0].limitMicros <= 0 || old[0].limitMicros > owed || typeof old[0].id !== 'string'))
      return { paid: false, pending: true, reason: 'Prior AI debit does not match owed usage; no new payment' };
    persistAiUsage(t, () => {
      const sequence = Number.isSafeInteger(usage.settlementSequence) ? usage.settlementSequence + 1 : 1;
      usage.settlementSequence = sequence;
      batch = usage.pendingBatch = old.length ? { id: old[0].id, micros: old[0].limitMicros, adoptedLegacy: true }
        : { id: 'ai-acct-batch-' + billingHash({ token: t.address, sequence }), micros: owed };
    });
  }
  if (typeof batch.id !== 'string' || !Number.isSafeInteger(batch.micros) || batch.micros <= 0 || batch.micros > owed)
    return { paid: false, pending: true, reason: 'AI settlement batch requires reconciliation' };
  let r;
  try { r = await charge(t, batch.micros, { id: batch.id, reason: 'AI usage (provider account, owed)', settlingOwed: true }); }
  catch { return { paid: false, pending: true, reason: 'AI settlement outcome unknown; same batch retained' }; }
  if (r?.paid) persistAiUsage(t, () => {
    if (usage.pendingBatch?.id !== batch.id || usage.pendingBatch?.micros !== batch.micros) throw new Error('AI settlement batch changed');
    usage.unsettledMicros -= batch.micros; usage.settledMicros += batch.micros;
    usage.lastSettledBatch = { id: batch.id, micros: batch.micros, tx: r.tx || null };
    delete usage.pendingBatch;
  });
  return r;
}
function persistVpsUsage(t, mutate) {
  const keys = ['vpsUsageReservations','treasury'];
  const before = keys.map(key => [key,Object.hasOwn(t,key),Object.hasOwn(t,key)?JSON.parse(JSON.stringify(t[key])):null]);
  try { const result=mutate();save();return result; }
  catch(e) { for(const [key,exists,value]of before){if(exists)t[key]=value;else delete t[key];}e.vpsPersistenceFailure=true;throw e; }
}
function assertHourlyAvailable(t, binding, id = null, chain = null) {
  if(t.vps.state!=='running'||t.treasury.mode!=='wallet'||billingHash(hourlyBinding(t,binding.recipient,t.vps.hourlyMicros))!==billingHash(binding))throw new Error('VPS billing authority changed');
  assertVpsUsageDispatchAllowed(t, saveDurable);
  const own=id&&['reserved','submitted','uncertain'].includes(t.vpsUsageReservations?.[id]?.state)?binding.micros:0;
  const others=heldUsage(t)-own;
  if(!Number.isSafeInteger(t.treasury.micros)||t.treasury.micros-others<binding.micros)throw new Error('treasury balance is reserved for outstanding payments');
  if(chain==='base'&&(!Number.isSafeInteger(t.treasury.usdcMicros)||t.treasury.usdcMicros-(heldUsageForBasePocket(t)-own)<binding.micros))throw new Error('Base USDC is reserved for outstanding payments');
}

/// One VPS hour, treasury → operations: ETH on Robinhood first, Base USDC (by
/// authorization, ops pays gas) as the fallback.
export async function chargeVpsHour(t) {
  if (holdVpsUsageForReview(t, saveDurable)) return { paid: false, pending: true, reason: 'VPS usage interval requires review; existing payment records remain held' };
  const micros = t.vps.hourlyMicros;
  const ops = t.treasury?.chain==='solana' ? SOLANA_OPS_ADDRESS : opsAddress();
  if (!micros || !ops) return { paid: false, reason: "nothing to charge" };
  if(!Number.isSafeInteger(micros)||micros<0)throw new Error('invalid hourly VPS amount');
  if(vpsBillingInFlight.has(t.address))return {paid:false,pending:true,reason:'VPS hour payment is already in progress'};
  vpsBillingInFlight.add(t.address);
  try { return await withBillingTreasury(t,()=>chargeVpsHourOnce(t,ops,micros)); }
  catch(e) { if(e.status===409)return {paid:false,pending:true,reason:'Treasury transaction requires reconciliation before billing'};throw e; }
  finally {vpsBillingInFlight.delete(t.address);}
}

async function chargeVpsHourOnce(t,ops,micros) {
  const binding=hourlyBinding(t,ops,micros),id='vps-hour-'+billingHash({token:binding.token,instanceId:binding.instanceId,startedAt:binding.startedAt,lastBilledAt:binding.lastBilledAt});
  const existing=t.vpsUsageReservations?.[id];
  // Validate the whole journal before any receipt/release path can return early.
  // An unfamiliar positive hold is never an empty or safely retryable journal.
  const history=t.vpsUsageReservations;
  if(history != null && (typeof history!=='object'||Array.isArray(history)||Object.entries(history).some(([key,r])=>!r||typeof r!=='object'||Array.isArray(r)||r.version!==1||r.id!==key||!['reserved','submitted','uncertain','settled','released'].includes(r.state))))return {paid:false,pending:true,reason:'VPS billing history requires operator review'};
  if(existing&&existing.chain==='solana'&&t.treasury.chain==='solana'){
    if(existing.limitMicros!==micros||!existing.binding||billingHash(existing.binding)!==billingHash(binding))return {paid:false,pending:true,reason:'VPS billing history requires operator review'};
    return solanaDebitOnce(t,{id,micros,reason:'VPS hour',recipient:ops,records:()=>(t.vpsUsageReservations||={}),persist:persistVpsUsage,ledger,binding,event,beforeDispatch:()=>assertHourlyAvailable(t,binding,id)});
  }
  if(existing){
    if(existing.version!==1||existing.id!==id||existing.limitMicros!==micros||!['base','robinhood'].includes(existing.chain)||!existing.binding||billingHash(existing.binding)!==billingHash(binding))return {paid:false,pending:true,reason:'VPS billing history requires operator review'};
    if(existing.state==='settled'&&/^0x[a-fA-F0-9]{64}$/.test(existing.tx||''))return {paid:true,chain:existing.chain,tx:existing.tx,billingId:id,duplicate:true};
    return {paid:false,pending:true,reason:'VPS hour requires reconciliation; no automatic repeat payment'};
  }
  if(Object.keys(t.vpsUsageReservations||{}).length>=10_000)return {paid:false,pending:true,reason:'VPS billing history requires archival'};
  await refreshTreasury(t);
  try {assertHourlyAvailable(t,binding);}catch(e){return {paid:false,reason:e.message};}
  if(t.treasury.chain==='solana')return solanaDebitOnce(t,{id,micros,reason:'VPS hour',recipient:ops,records:()=>(t.vpsUsageReservations||={}),persist:persistVpsUsage,ledger,binding,event,beforeDispatch:()=>assertHourlyAvailable(t,binding,id)});
  const ethUsd = t.treasury.ethUsd || 0;
  let chain,wei;
  if (ethUsd > 0) {
    wei = weiFor(micros, ethUsd);
    const have = ethers.parseEther(String(t.treasury.robinhoodEth || 0));
    if (have >= wei + ethers.parseEther(String(GAS_RESERVE_ETH))) chain='robinhood';
  }
  if(!chain){try {assertHourlyAvailable(t,binding,null,'base');chain='base';}catch{return {paid:false,reason:'treasury cannot cover the next hour without using reserved AI funds'};}}
  persistVpsUsage(t,()=>{(t.vpsUsageReservations||={})[id]={id,version:1,binding,chain,limitMicros:micros,state:'reserved',createdAt:new Date().toISOString()};});
  let submitted=false;
  try {
    let hash;
    if(chain==='robinhood'){
      assertHourlyAvailable(t,binding,id,chain);
      persistVpsUsage(t,()=>{t.vpsUsageReservations[id].state='submitted';});submitted=true;
      const tx=await opsSigner.treasury(t.address,rhRpc()).sendTransaction({to:ops,value:wei});
      persistVpsUsage(t,()=>{t.vpsUsageReservations[id].tx=tx.hash;});
      const rc=await tx.wait();
      if(rc?.status!==1)throw new Error('VPS native payment lacks a successful receipt');
      hash=rc.hash;
    }else{
      const auth = { from: t.treasury.wallet, to: ops, value: String(micros), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
      const sig = await signTypedDataAsTreasury(t.address, USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES, { ...auth, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore) });
      await refreshTreasury(t);
      assertHourlyAvailable(t,binding,id,'base');
      persistVpsUsage(t,()=>{Object.assign(t.vpsUsageReservations[id],{state:'submitted',authorization:auth});});submitted=true;
      hash=await submitAuthorizedTransfer(opsSigner(baseRpc()),auth,sig);
    }
    if(typeof hash!=='string'||!/^0x[a-fA-F0-9]{64}$/.test(hash))throw new Error('VPS payment receipt has no verifiable transaction hash');
    persistVpsUsage(t,()=>{
      Object.assign(t.vpsUsageReservations[id],{state:'settled',tx:hash,settledAt:new Date().toISOString()});
      if(chain==='base')t.treasury.usdcMicros=Math.max(0,(t.treasury.usdcMicros||0)-micros);
      else {t.treasury.robinhoodEth=Math.max(0,(t.treasury.robinhoodEth||0)-Number(ethers.formatEther(wei)));t.treasury.ethMicros=Math.max(0,(t.treasury.ethMicros||0)-micros);}
      t.treasury.micros=(t.treasury.ethMicros||0)+(t.treasury.usdgMicros||0)+(t.treasury.usdcMicros||0);
      ledger(t,-micros,chain==='base'?'VPS hour (USDC, Base)':`VPS hour (${ethers.formatEther(wei).slice(0,10)} ETH, Robinhood)`,{tx:hash,chain,billingId:id});
    });
    return {paid:true,chain,tx:hash,billingId:id};
  }catch(e){
    persistVpsUsage(t,()=>{const r=t.vpsUsageReservations[id];if(r.state!=='settled')r.state=submitted?'uncertain':'released';});
    if(e.vpsPersistenceFailure)throw e;
    return {paid:false,pending:submitted,reason:submitted?'VPS hour payment is uncertain; operator reconciliation required, no automatic fallback':'VPS billing stopped before dispatch: '+e.message};
  }
}

/// Refills the Base USDC pocket from Robinhood ETH when it is below the floor (or
/// below `needMicros`). Returns what the pocket holds afterwards.
const pocketInFlight = new Set();
const bridgeFail=(status,message)=>Object.assign(new Error(message),{status});
function persistBridgeUsage(t,mutate){
  const keys=['bridgeUsageReservations','treasury'];
  const before=keys.map(key=>[key,Object.hasOwn(t,key),Object.hasOwn(t,key)?JSON.parse(JSON.stringify(t[key])):null]);
  try{const result=mutate();save();return result;}
  catch(e){for(const [key,exists,value]of before){if(exists)t[key]=value;else delete t[key];}e.bridgePersistenceFailure=true;throw e;}
}
function unresolvedPocket(t){
  // 'released' is written only when the deposit provably never landed (expired / failed on chain, nothing
  // moved); every other non-success status ('failed' after a lost persistence, 'uncertain', 'pending',
  // 'failure', 'refund', 'timeout') keeps blocking until an operator reconciles.
  if(t.treasury.bridge&&!['success','released'].includes(t.treasury.bridge.status))return true;
  return Object.values(t.bridgeUsageReservations||{}).some(r=>r.version!==1||!['settled','released'].includes(r.state));
}
function assertPocketAvailable(t,binding,inputWei,limitMicros,id=null){
  if(t.treasury.mode!=='wallet'||t.treasury.wallet.toLowerCase()!==binding.wallet||String(t.vps.instanceId||'legacy')!==binding.instanceId||(binding.running&&t.vps.state!=='running'))throw bridgeFail(403,'AI pocket refill authority changed');
  const own=id&&['reserved','submitted','uncertain'].includes(t.bridgeUsageReservations?.[id]?.state)?limitMicros:0;
  if(!(t.treasury.ethUsd>0)||!Number.isFinite(t.treasury.ethUsd))throw bridgeFail(402,'native asset valuation is unavailable');
  const nativeVpsHolds=Object.values(t.vpsUsageReservations||{}).filter(r=>r.chain==='robinhood'&&['reserved','submitted','uncertain'].includes(r.state)).reduce((n,r)=>n+r.limitMicros,0);
  if(!Number.isSafeInteger(nativeVpsHolds)||nativeVpsHolds<0)throw bridgeFail(409,'native VPS payment history requires review');
  const reserveMicros=nativeVpsHolds+(isStagedLaunch(t)?unheldVpsReserveMicros(t):(t.vps.state==='running'?2*t.vps.hourlyMicros:0));
  const required=inputWei+ethers.parseEther(String(GAS_RESERVE_ETH))+weiFor(reserveMicros,t.treasury.ethUsd);
  const have=ethers.parseEther(String(t.treasury.robinhoodEth||0));
  if(have<required)throw bridgeFail(402,`treasury holds ${ethers.formatEther(have).slice(0,8)} ETH on Robinhood; refilling the AI pocket needs ${ethers.formatEther(required).slice(0,8)} (including VPS reserves)`);
  if(!Number.isSafeInteger(t.treasury.micros)||t.treasury.micros-(heldUsage(t)-own)<limitMicros)throw bridgeFail(402,'AI pocket refill cannot use money reserved for other payments');
}
export function aiPocketTargets(t, needMicros = 0) {
  const floorMicros=pocketFloorMicros(),targetMicros=pocketTargetMicros();
  if(!isStagedLaunch(t))return {floorMicros,targetMicros};
  // Small startup budgets must not inherit a $3 refill target. Preserve VPS
  // hours and use at most $1 per refill (or the lower actual available balance).
  const have=aiPocketMicros(t),available=Math.max(0,t.treasury.micros-heldUsage(t)-unheldVpsReserveMicros(t));
  const target=Math.min(targetMicros,1_000_000,have+Math.max(0,Math.floor(available/1.1)-100_000));
  if(target<needMicros)throw bridgeFail(402,'confirmed funds cannot refill this AI request while preserving VPS hours');
  return {floorMicros:Math.min(floorMicros,500_000,target),targetMicros:target};
}
export async function ensureAiPocket(t, needMicros = 0) {
  if(!Number.isSafeInteger(needMicros)||needMicros<0)throw bridgeFail(400,'invalid AI pocket requirement');
  if(t.treasury.chain==='solana'&&solanaAiRail()==='base'&&process.env.GATEWAY_OFFLINE==='1')throw bridgeFail(409,'offline: no Base pocket refill');   // before the in-flight marker; chain first: the durability test runs this slice in a vm without `process`
  if(pocketInFlight.has(t.address))throw bridgeFail(409,'a refill is already in flight; no second request');
  const pocketOpts={...aiPocketTargets(t,needMicros),persist:persistBridgeUsage,ledger,event,unresolved:unresolvedPocket};
  pocketInFlight.add(t.address);
  try{return await withBillingTreasury(t,()=>t.treasury.chain==='solana'
    ?(solanaAiRail()==='base'?refillBasePocket(t,needMicros,{...pocketOpts,pocketAddress:createBasePocket(t.address)}):refillSolanaPocket(t,needMicros,pocketOpts))
    :refillAiPocket(t,needMicros));}finally{pocketInFlight.delete(t.address);}
}
async function refillAiPocket(t,needMicros){
  const binding={wallet:String(t.treasury.wallet).toLowerCase(),instanceId:String(t.vps.instanceId||'legacy'),running:t.vps.state==='running'};
  await refreshTreasury(t);
  const usdc = t.treasury.usdcMicros || 0;
  const targets = aiPocketTargets(t,needMicros);
  const floor = Math.max(targets.floorMicros, needMicros);
  if (usdc >= floor) return usdc;
  if(unresolvedPocket(t))throw bridgeFail(409,'a refill is already in flight or unresolved; operator reconciliation required before another request');
  if(!(t.treasury.ethUsd>0)||!(t.treasury.robinhoodEth>GAS_RESERVE_ETH))throw bridgeFail(402,'native balance or valuation is insufficient to refill the AI pocket');
  const wantMicros = Math.max(targets.targetMicros, needMicros) - usdc;
  if(!Number.isSafeInteger(wantMicros)||wantMicros<=0)throw bridgeFail(400,'invalid AI pocket target');
  const q = await relay.quote({ user: t.treasury.wallet, recipient: t.treasury.wallet, originChainId: ROBINHOOD.id, destinationChainId: 8453, destinationCurrency: USDC_BASE, amount: String(wantMicros), tradeType: "EXACT_OUTPUT" });
  if(!/^0x[a-fA-F0-9]{64}$/.test(q.requestId||'')||q.check!==`/intents/status/v3?requestId=${q.requestId}`&&q.check!==`/intents/status/v2?requestId=${q.requestId}`)throw bridgeFail(502,'invalid Relay refill identity');
  const id='ai-pocket-'+q.requestId.toLowerCase();
  if(t.bridgeUsageReservations?.[id])throw bridgeFail(409,'this Relay refill intent was already used; no repeat deposit');
  if(Object.keys(t.bridgeUsageReservations||{}).length>=10_000)throw bridgeFail(429,'refill history requires archival');
  const inputWei=BigInt(q.inAmount),expected=(q.txs||[]).map(tx=>({to:tx.to.toLowerCase(),data:tx.data||'0x',value:BigInt(tx.value),gas:tx.gas==null?null:BigInt(tx.gas)}));
  if(inputWei<=0n||!expected.length||expected.some(tx=>tx.value<0n)||expected.reduce((n,tx)=>n+tx.value,0n)>inputWei)throw bridgeFail(502,'Relay refill transactions exceed the quoted input');
  await refreshTreasury(t);
  if((t.treasury.usdcMicros||0)>=floor)return t.treasury.usdcMicros;
  if(unresolvedPocket(t))throw bridgeFail(409,'another refill intent appeared; operator reconciliation required');
  const limitMicros=Math.max(Math.ceil(q.inUsd*1e6),Math.ceil(Number(ethers.formatEther(inputWei))*t.treasury.ethUsd*1e6))+Math.ceil(GAS_RESERVE_ETH*t.treasury.ethUsd*1e6);
  if(!Number.isSafeInteger(limitMicros)||limitMicros<=0)throw bridgeFail(502,'invalid Relay refill cost');
  assertPocketAvailable(t,binding,inputWei,limitMicros);
  persistBridgeUsage(t,()=>{
    (t.bridgeUsageReservations||={})[id]={id,version:1,requestId:q.requestId,binding,limitMicros,state:'reserved',createdAt:new Date().toISOString(),txs:[]};
    t.treasury.bridge={requestId:q.requestId,check:q.check,startedAt:new Date().toISOString(),status:'pending',dispatchState:'prepared',inFormatted:q.inFormatted,outFormatted:q.outFormatted,txs:[]};
  });
  const assertIntent=()=>{
    const r=t.bridgeUsageReservations?.[id],intent=t.treasury.bridge;
    if(!r||r.version!==1||r.requestId!==q.requestId||r.limitMicros!==limitMicros||billingHash(r.binding)!==billingHash(binding)||intent?.requestId!==q.requestId||intent.check!==q.check)throw bridgeFail(409,'refill intent changed; operator reconciliation required');
  };
  let attempted=false,index=0;
  try{
    const signer=opsSigner.treasury(t.address,rhRpc());
    const guardedSigner={sendTransaction:async tx=>{
      const expectedTx=expected[index];
      if(!expectedTx||String(tx.to).toLowerCase()!==expectedTx.to||(tx.data||'0x')!==expectedTx.data||BigInt(tx.value)!==expectedTx.value||(tx.gasLimit==null?null:BigInt(tx.gasLimit))!==expectedTx.gas)throw bridgeFail(403,'refill dispatch differs from its quoted transaction');
      assertIntent();
      assertPocketAvailable(t,binding,inputWei,limitMicros,id);
      persistBridgeUsage(t,()=>{t.bridgeUsageReservations[id].state='submitted';t.treasury.bridge.dispatchState='submitted';});
      attempted=true;
      const sent=await signer.sendTransaction(tx);
      if(!/^0x[a-fA-F0-9]{64}$/.test(sent.hash||''))throw bridgeFail(502,'refill transaction hash unavailable');
      persistBridgeUsage(t,()=>{t.bridgeUsageReservations[id].txs.push(sent.hash);t.treasury.bridge.txs.push(sent.hash);});
      index++;
      return {hash:sent.hash,wait:(...args)=>sent.wait(...args)};
    }};
    const hashes=await relay.execute(guardedSigner,q);
    assertIntent();
    if(index!==expected.length||hashes.length!==expected.length||hashes.some((hash,i)=>hash!==t.bridgeUsageReservations[id].txs[i]))throw bridgeFail(502,'refill transaction execution is incomplete');
    event('bridge',`${t.symbol}: bridging ${q.inFormatted} ETH → ${q.outFormatted} USDC (Relay ${q.requestId.slice(0,10)}…)`,{token:t.address});
    const st=await relay.waitSettled(q.check,{timeoutMs:4*60_000});
    assertIntent();
    if(st.status!=='success'){
      persistBridgeUsage(t,()=>{t.bridgeUsageReservations[id].state='uncertain';t.treasury.bridge.status=['failure','refund','timeout'].includes(st.status)?st.status:'uncertain';ledger(t,0,`bridge ${t.treasury.bridge.status}: ${q.requestId.slice(0,10)}; reconciliation required`);});
      throw bridgeFail(502,`Relay bridge ${st.status}; operator reconciliation required`);
    }
    await refreshTreasury(t);
    assertIntent();
    persistBridgeUsage(t,()=>{
      t.bridgeUsageReservations[id].state='settled';t.bridgeUsageReservations[id].settledAt=new Date().toISOString();
      t.treasury.bridge.status='success';t.treasury.bridge.settledAt=new Date().toISOString();
      ledger(t,0,`AI pocket refilled: ${q.inFormatted} ETH → ${q.outFormatted} USDC`,{tx:hashes[0],chain:'robinhood',relay:q.requestId});
    });
    return t.treasury.usdcMicros||0;
  }catch(e){
    persistBridgeUsage(t,()=>{
      const r=t.bridgeUsageReservations[id];if(r.state!=='settled')r.state=attempted?'uncertain':'released';
      if(t.treasury.bridge?.requestId===q.requestId&&!['failure','refund','timeout','success'].includes(t.treasury.bridge.status))t.treasury.bridge.status=attempted?'uncertain':'failed';
    });
    throw e;
  }
}

/// Real-clock upkeep: refresh, bill every running real VPS, keep AI pockets filled.
export async function billRunning() {
  // Age does not resolve an ambiguous money movement. Keep every open package
  // hold out of destructive balance inference until its receipt is reconciled.
  const packageMoneyInFlight = (t) => [...Object.values(t.packageBridgeReservations || {}), ...Object.values(t.packageUsageReservations || {})]
    .some((r) => ['reserved', 'submitted', 'uncertain'].includes(r?.state));
  const s = get();
  for (const t of Object.values(s.tokens)) {
    if (t.treasury.mode !== "wallet") continue;
    try { await billProject(t, packageMoneyInFlight); }
    catch (e) { event("billing", `${t.symbol}: billing pass failed — ${String(e.message || e).slice(0, 120)}`, { token: t.address, level: "error" }); save(); }
  }
}

async function billProject(t, packageMoneyInFlight) {
  {
    await refreshTreasury(t).catch(() => {});
    refreshUsagePeriod(t);
    if (t.treasury.chain === "solana" && (t.aiAccountUsage?.unsettledMicros || 0) >= 10_000) {
      await settleOwedAiUsage(t).catch((e) => event("billing", `${t.symbol}: owed AI usage settlement failed — ${String(e.message || e).slice(0, 100)}`, { token: t.address, level: "warn" }));
    }
    if (t.treasury.chain === "solana" && Object.values(t.aiDirectPayments || {}).some((e) => (e.state === "intent" && !e.txHash) || ["signed", "uncertain"].includes(e.state) || (e.state === "sent" && !e.booked))) {
      await reconcileDirectPayments(t).catch((e) => event("ai", `${t.symbol}: direct payment reconciliation failed — ${String(e.message || e).slice(0, 100)}`, { token: t.address, level: "warn" }));
    }
    if (t.vps.mode === "real" && t.vps.state === "running") {
      if (holdVpsUsageForReview(t, saveDurable)) {
        save(); return; // No new charge, catch-up cursor, refill or billing teardown.
      }
      const last = t.vps.lastBilledAt ? Date.parse(t.vps.lastBilledAt) : Date.parse(t.vps.startedAt || new Date().toISOString());
      if (Date.now() - last >= HOUR_MS) {
        const attempt = { attemptedAt: Date.now(), instanceId: t.vps.instanceId, startedAt: t.vps.startedAt, hourlyMicros: t.vps.hourlyMicros };
        const r = await chargeVpsHour(t);
        if (String(t.vps.instanceId) === String(attempt.instanceId) && t.vps.startedAt === attempt.startedAt)
          holdVpsUsageForReview(t, saveDurable);
        if (r.paid) {
          const decision = vpsBillingDecision(t, r, attempt);
          if (decision.reason === 'instance_changed' || decision.reason === 'provider_usage_unverified') {
            event('billing', `${t.symbol}: a previous VPS hour settled; the current server billing period was preserved`, { token: t.address });
            save(); return;
          }
          t.vps.lastBilledAt = new Date(last + HOUR_MS).toISOString();
          t.vps.hoursBilled = (t.vps.hoursBilled || 0) + 1;
          event("billing", `${t.symbol}: VPS hour #${t.vps.hoursBilled} paid on ${r.chain} (${r.tx.slice(0, 10)}…)`, { token: t.address });
        }
        else if(r.pending) { vpsBillingDecision(t,r,attempt); event('billing',`${t.symbol}: ${r.reason}`,{token:t.address,level:'warn'}); save(); return; }
        else if(packageMoneyInFlight(t)) { vpsBillingDecision(t,{paid:false,pending:true},attempt); event('billing',`${t.symbol}: ${r.reason} — a launch-package transfer is in flight; the hour is retried, not torn down`,{token:t.address,level:'warn'}); save(); return; }
        else {
          const decision = vpsBillingDecision(t, r, attempt);
          saveDurable(); // A failed durable check must never dispatch DELETE.
          if (decision.action === 'stop') {
            event("billing", `${t.symbol}: available funds are below the VPS hour on two verified balance reads — stopping the VPS`, { token: t.address, level: "error" });
            await teardown(t, "treasury empty");
          } else {
            event("billing", `${t.symbol}: VPS payment needs a check (${decision.reason}); server preserved`, { token: t.address, level: "warn" });
          }
          save();
          return;
        }
      }
      if (aiPocketMicros(t) < pocketFloorMicros() && t.agent.ai?.provider === "nanogpt-x402") {
        await ensureAiPocket(t).catch((e) => event("bridge", `${t.symbol}: refill skipped — ${e.message.slice(0, 100)}`, { token: t.address, level: "warn" }));
      }
    }
    save();
  }
}

/// Operations → a token treasury, Base USDC (manual, confirmed in the panel).
export async function fundTreasuryFromOps(t, micros) {
  const hash = await sendUsdcFromOps(opsSigner(baseRpc()), t.treasury.wallet, micros);
  ledger(t, +micros, "funded from operations (USDC, Base)", { tx: hash, chain: "base" });
  event("billing", `${t.symbol}: treasury funded $${(micros / 1e6).toFixed(2)} from operations`, { token: t.address });
  return hash;
}

/// Operations wallet → anywhere via Relay (moving money the operator sent to the
/// wrong chain). Confirmed in the panel; the recipient must be a token treasury.
export async function opsBridge({ originChainId, amountWei, destinationChainId, destinationCurrency, recipient }) {
  const origin = CHAINS.find((c) => c.id === Number(originChainId));
  if (!origin) throw Object.assign(new Error("unknown origin chain"), { status: 400 });
  const provider = new ethers.JsonRpcProvider(origin.rpc, origin.id, { staticNetwork: true, batchMaxCount: 1 });
  const ops = opsAddress();
  const q = await relay.quote({ user: ops, recipient, originChainId: origin.id, destinationChainId: Number(destinationChainId), destinationCurrency, amount: String(amountWei), tradeType: "EXACT_INPUT" });
  const hashes = await relay.execute(opsSigner(provider), q);
  const st = await relay.waitSettled(q.check, { timeoutMs: 5 * 60_000 });
  event("bridge", `ops bridge ${q.inFormatted} → ${q.outFormatted} ${q.symbolOut} (${st.status})`, { level: st.status === "success" ? "info" : "error" });
  return { quote: { in: q.inFormatted, out: q.outFormatted, symbolOut: q.symbolOut, inUsd: q.inUsd, outUsd: q.outUsd }, txs: hashes, status: st.status, requestId: q.requestId };
}

export async function opsBalances() {
  const a = opsAddress();
  if (!a) return null;
  const [usdc, eth, rhEth] = await Promise.all([usdcMicros(a).catch(() => null), baseEth(a).catch(() => null), rhRpc().getBalance(a).then((b) => Number(ethers.formatEther(b))).catch(() => null)]);
  return { address: a, baseUsdc: usdc == null ? null : usdc / 1e6, baseEth: eth, robinhoodEth: rhEth };
}

/// One launch-package debit, treasury → operations, with its own durable
/// reservation (`t.packageUsageReservations[id]`). `reservedMicros` is the package
/// allocation this debit consumes (the $300 DEX / $10 X reserve), so the amount is
/// checked against the treasury outside every OTHER pending liability. ETH on
/// Robinhood first, Base USDC by authorization as the fallback. Idempotent by id:
/// a settled record is returned as a duplicate, an in-flight or uncertain record
/// is never repeated, a released (never dispatched) record may be retried.
export async function chargeTreasuryOnce(t, { id, micros, reason, reservedMicros = 0, ledgerKey = null }) {
  const ops = t.treasury?.chain === 'solana' ? SOLANA_OPS_ADDRESS : opsAddress();
  if (!ops) return { paid: false, reason: 'operations wallet unavailable' };
  if (!/^package-[a-zA-Z0-9:_.-]{1,160}$/.test(String(id))) throw new Error('invalid package debit id');
  if (!Number.isSafeInteger(micros) || micros <= 0 || !Number.isSafeInteger(reservedMicros) || reservedMicros < 0) throw new Error('invalid package debit amount');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 120) throw new Error('invalid package debit reason');
  if (t.treasury.mode !== 'wallet' || !t.treasury.wallet) return { paid: false, reason: 'no treasury wallet' };
  if (ledgerKey !== null && (typeof ledgerKey !== 'object' || Array.isArray(ledgerKey) || Object.keys(ledgerKey).some(k => !['launchPackageJobId', 'socialAccountJobId'].includes(k) || typeof ledgerKey[k] !== 'string'))) throw new Error('invalid package ledger key');
  try { return await withBillingTreasury(t, () => chargePackageOnce(t, ops, { id, micros, reason, reservedMicros, ledgerKey })); }
  catch (e) { if (e.status === 409) return { paid: false, pending: true, reason: 'Treasury transaction requires reconciliation before this debit' }; throw e; }
}
function persistPackageUsage(t, mutate) {
  const keys = ['packageUsageReservations', 'treasury'];
  const before = keys.map(key => [key, Object.hasOwn(t, key), Object.hasOwn(t, key) ? JSON.parse(JSON.stringify(t[key])) : null]);
  try { const result = mutate(); save(); return result; }
  catch (e) { for (const [key, exists, value] of before) { if (exists) t[key] = value; else delete t[key]; } e.packagePersistenceFailure = true; throw e; }
}
async function chargePackageOnce(t, ops, { id, micros, reason, reservedMicros, ledgerKey }) {
  const map = () => (t.packageUsageReservations ||= {});
  if (t.treasury.chain === 'solana') {
    await refreshTreasury(t);
    return solanaDebitOnce(t, { id, micros, reason, recipient: ops, records: map, persist: persistPackageUsage, ledger, ledgerKey, reservedMicros, binding: { token: t.address, treasury: t.treasury.wallet, recipient: ops, micros, reason }, event });
  }
  const binding = { token: t.address.toLowerCase(), treasury: t.treasury.wallet.toLowerCase(), recipient: ops.toLowerCase(), micros, reason };
  const existing = t.packageUsageReservations?.[id];
  const settledView = (r) => ({ paid: true, chain: r.chain, tx: r.tx, billingId: id, settledAt: r.settledAt, duplicate: true });
  if (existing) {
    if (existing.version !== 1 || existing.id !== id || existing.limitMicros !== micros || billingHash(existing.binding) !== billingHash(binding)) return { paid: false, pending: true, reason: 'Package debit record requires reconciliation' };
    if (existing.state === 'settled' && /^0x[a-fA-F0-9]{64}$/.test(existing.tx || '')) return settledView(existing);
    if (existing.state === 'reserved') {
      // The send follows the 'submitted' persist, so a record still 'reserved' after a
      // crash was provably never dispatched: release it and let this attempt start.
      persistPackageUsage(t, () => { Object.assign(map()[id], { state: 'released', failure: 'interrupted before dispatch' }); });
    } else if (['submitted', 'uncertain'].includes(existing.state) && /^0x[a-fA-F0-9]{64}$/.test(existing.tx || '')) {
      // A stored hash is checkable evidence: settle or release from the receipt, never repeat blindly.
      const verdict = await verifyPackageDebit(t, existing, { reason, ledgerKey });
      if (verdict === 'settled') return settledView(map()[id]);
      if (verdict !== 'failed') return { paid: false, pending: true, reason: 'Package debit is awaiting its receipt; no automatic repeat' };
    } else if (existing.state !== 'released') return { paid: false, pending: true, reason: 'Package debit is in progress or uncertain; no automatic repeat' };
  }
  if (Object.values(t.packageUsageReservations || {}).some(r => r.version !== 1 || !['reserved', 'submitted', 'uncertain', 'settled', 'released'].includes(r.state))) return { paid: false, pending: true, reason: 'Package debit history requires operator review' };
  await refreshTreasury(t);
  // Availability outside every OTHER liability: this record and the reserve it consumes are excluded.
  const available = () => packagePaymentAvailableMicros(t, { id, reservedMicros });
  if (!Number.isSafeInteger(t.treasury.micros) || available() < micros) return { paid: false, reason: 'treasury cannot cover this package debit outside its other liabilities' };
  const ethUsd = t.treasury.ethUsd || 0;
  let chain, wei;
  if (ethUsd > 0) {
    wei = weiFor(micros, ethUsd);
    const have = ethers.parseEther(String(t.treasury.robinhoodEth || 0));
    if (have >= wei + ethers.parseEther(String(GAS_RESERVE_ETH))) chain = 'robinhood';
  }
  if (!chain) {
    if (Number.isSafeInteger(t.treasury.usdcMicros) && t.treasury.usdcMicros - heldUsageForBasePocket(t) >= micros) chain = 'base';
    else return { paid: false, reason: 'treasury cannot cover this package debit on Robinhood or Base' };
  }
  persistPackageUsage(t, () => { map()[id] = { id, version: 1, binding, chain, limitMicros: micros, state: 'reserved', createdAt: new Date().toISOString() }; });
  let submitted = false;
  try {
    let hash;
    if (chain === 'robinhood') {
      if (available() < micros + (isStagedPackagePayment(t, id) ? Math.ceil(GAS_RESERVE_ETH * ethUsd * 1e6) : 0)) throw new Error('treasury balance changed before dispatch');
      persistPackageUsage(t, () => { map()[id].state = 'submitted'; }); submitted = true;
      const tx = await opsSigner.treasury(t.address, rhRpc()).sendTransaction({ to: ops, value: wei });
      persistPackageUsage(t, () => { map()[id].tx = tx.hash; });
      const rc = await tx.wait(1, PACKAGE_RECEIPT_WAIT_MS); // a stalled receipt becomes 'uncertain' with its hash, re-verified on the next call
      if (rc?.status !== 1) throw new Error('package debit lacks a successful receipt');
      hash = rc.hash;
    } else {
      const auth = { from: t.treasury.wallet, to: ops, value: String(micros), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
      const sig = await signTypedDataAsTreasury(t.address, USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES, { ...auth, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore) });
      await refreshTreasury(t);
      if (available() < micros || t.treasury.usdcMicros - (heldUsageForBasePocket(t) - micros) < micros) throw new Error('treasury balance changed before dispatch');
      persistPackageUsage(t, () => { Object.assign(map()[id], { state: 'submitted', authorization: auth }); }); submitted = true;
      hash = await submitAuthorizedTransfer(opsSigner(baseRpc()), auth, sig);
    }
    if (typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('package debit receipt has no verifiable transaction hash');
    const settledAt = new Date().toISOString();
    persistPackageUsage(t, () => {
      Object.assign(map()[id], { state: 'settled', tx: hash, settledAt });
      if (chain === 'base') t.treasury.usdcMicros = Math.max(0, (t.treasury.usdcMicros || 0) - micros);
      else { t.treasury.robinhoodEth = Math.max(0, (t.treasury.robinhoodEth || 0) - Number(ethers.formatEther(wei))); t.treasury.ethMicros = Math.max(0, (t.treasury.ethMicros || 0) - micros); }
      t.treasury.micros = (t.treasury.ethMicros || 0) + (t.treasury.usdgMicros || 0) + (t.treasury.usdcMicros || 0);
      // The queue's job key rides on this single financial entry so its own
      // deduplication finds it and never books the reimbursement twice.
      ledger(t, -micros, chain === 'base' ? `${reason} (USDC, Base)` : `${reason} (${ethers.formatEther(wei).slice(0, 10)} ETH, Robinhood)`, { tx: hash, chain, billingId: id, ...(ledgerKey || {}) });
    });
    event('package', `${t.symbol}: ${reason} — $${(micros / 1e6).toFixed(2)} treasury → operations`, { token: t.address });
    return { paid: true, chain, tx: hash, billingId: id, settledAt };
  } catch (e) {
    persistPackageUsage(t, () => { const r = map()[id]; if (r.state !== 'settled') { r.state = submitted ? 'uncertain' : 'released'; r.failure = String(e.message).slice(0, 160); } });
    if (e.packagePersistenceFailure) throw e;
    if (submitted) event('package', `${t.symbol}: ${reason} — debit outcome unknown (${String(map()[id].tx || 'no hash').slice(0, 12)}…); it is re-verified from its receipt, never repeated`, { token: t.address, level: 'error' });
    return { paid: false, pending: submitted, reason: submitted ? 'package debit is uncertain; operator reconciliation required, no automatic repeat' : 'package debit stopped before dispatch: ' + e.message };
  }
}
const PACKAGE_RECEIPT_WAIT_MS = 120_000;
/// Re-verifies a submitted/uncertain package debit from its transaction hash. Settles the
/// record (ledger row, cache adjustment) when the receipt succeeded, releases it when the
/// transfer reverted (nothing moved), leaves it pending while the receipt is not in yet.
async function verifyPackageDebit(t, r, { reason, ledgerKey }) {
  const map = () => (t.packageUsageReservations ||= {});
  let rc;
  try { rc = await (r.chain === 'base' ? baseRpc() : rhRpc()).getTransactionReceipt(r.tx); } catch { return 'pending'; }
  if (!rc) return 'pending';
  if (rc.status !== 1) {
    persistPackageUsage(t, () => { Object.assign(map()[r.id], { state: 'released', failure: 'transaction reverted; nothing moved' }); });
    return 'failed';
  }
  const micros = r.limitMicros, settledAt = new Date().toISOString();
  await refreshTreasury(t).catch(() => {});
  persistPackageUsage(t, () => {
    Object.assign(map()[r.id], { state: 'settled', settledAt, verifiedFromReceipt: true });
    ledger(t, -micros, `${reason} (${r.chain === 'base' ? 'USDC, Base' : 'ETH, Robinhood'}; settled from receipt)`, { tx: r.tx, chain: r.chain, billingId: r.id, ...(ledgerKey || {}) });
  });
  event('package', `${t.symbol}: ${reason} — $${(micros / 1e6).toFixed(2)} treasury → operations (settled from receipt)`, { token: t.address });
  return 'settled';
}

/// Launch-package allocation bridged OUT of the project treasury: Robinhood ETH worth
/// `micros` (EXACT_INPUT; re-quoted once when Relay's own valuation of the input drifts)
/// → USDC on Solana to the platform's DEX wallet. Durable record in
/// `t.packageBridgeReservations[id]`:
///   reserved → submitted (deposit sent; depositMined once its receipt is in)
///            → settled | refunded | uncertain | released
/// A 'reserved' record left by a crash was provably never dispatched (the 'submitted'
/// persist precedes the send) and is released; 'released' may start again on the same id;
/// 'refunded' and 'uncertain' are terminal for the id (a new attempt needs a new id, or an
/// operator release). Dispatch happens only with `dispatch: true`, under the treasury
/// lock and an in-flight guard per id; `dispatch: false` only observes and settles.
const bridgeInFlight = new Set();
const BRIDGE_PRICE_TOLERANCE = 0.01;          // Relay's USD valuation of the input must be within ±1% of the allocation
const BRIDGE_STALE_SUBMIT_MS = 45 * 60_000;   // a deposit Relay still has not seen after this long is escalated to the operator
const BRIDGE_STATES = ['reserved', 'submitted', 'uncertain', 'settled', 'refunded', 'released'];
export function bridgeView(r) {
  return { state: r.state, id: r.id, requestId: r.requestId || null, txs: r.txs || [], depositMined: r.depositMined === true, settledAt: r.settledAt || null,
    outAmount: r.outAmount || null, outUsd: r.outUsd || null, inUsd: r.inUsd || null, actualMicros: r.actualMicros ?? null, outTxHashes: r.outTxHashes || [],
    limitMicros: r.limitMicros, reason: r.failure || null, createdAt: r.createdAt || null, submittedAt: r.submittedAt || null };
}
export async function bridgePackageAllocation(t, { id, micros, recipient, reason, reservedMicros = 0, ledgerKey = null, minOutMicros = null, dispatch = true, destinationChainId = relay.SOLANA_CHAIN_ID, destinationCurrency = relay.SOLANA_USDC },
  { relayApi = relay, signerFor = (address) => opsSigner.treasury(address, rhRpc()), now = Date.now, refresh = refreshTreasury, lock = withBillingTreasury } = {}) {
  if (!/^package-[a-zA-Z0-9:_.-]{1,160}$/.test(String(id))) throw new Error('invalid package bridge id');
  if (!Number.isSafeInteger(micros) || micros <= 0 || !Number.isSafeInteger(reservedMicros) || reservedMicros < 0) throw new Error('invalid package bridge amount');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 120) throw new Error('invalid package bridge reason');
  if (ledgerKey !== null && (typeof ledgerKey !== 'object' || Array.isArray(ledgerKey) || Object.keys(ledgerKey).some(k => !['launchPackageJobId', 'socialAccountJobId'].includes(k) || typeof ledgerKey[k] !== 'string'))) throw new Error('invalid package ledger key');
  const minOut = minOutMicros == null ? Math.ceil(micros * 0.97) : minOutMicros;
  if (!Number.isSafeInteger(minOut) || minOut <= 0 || minOut > micros) throw new Error('invalid package bridge minimum output');
  if (t.treasury.mode !== 'wallet' || !t.treasury.wallet) return { state: 'unavailable', id, reason: 'no treasury wallet' };
  const target = relayApi.recipientFor(destinationChainId, recipient);
  const map = () => (t.packageBridgeReservations ||= {});
  const persist = (mutate) => {
    const keys = ['packageBridgeReservations', 'treasury'];
    const before = keys.map(key => [key, Object.hasOwn(t, key), Object.hasOwn(t, key) ? JSON.parse(JSON.stringify(t[key])) : null]);
    try { const result = mutate(); save(); return result; }
    catch (e) { for (const [key, exists, value] of before) { if (exists) t[key] = value; else delete t[key]; } e.packagePersistenceFailure = true; throw e; }
  };
  const iso = () => new Date(now()).toISOString();
  if (t.treasury.chain === 'solana') {
    // Same chain: the allocation is a SOL transfer to the platform DEX wallet (no Relay).
    if (!isSolanaAddress(recipient)) throw new Error('a base58 Solana recipient is required');
    await refresh(t);
    const run = () => solanaAllocationOnce(t, { id, micros, recipient, reason, reservedMicros, ledgerKey, dispatch, records: map, persist: (_t, mutate) => persist(mutate), ledger, event, inFlight: bridgeInFlight }, { now });
    if (!dispatch) return run();
    try { return await lock(t, run); }
    catch (e) { if (e.status === 409) return { state: 'unavailable', id, reason: 'treasury is processing another transaction' }; throw e; }
  }
  const binding = { token: t.address.toLowerCase(), treasury: t.treasury.wallet.toLowerCase(), recipient: target, destinationChainId, destinationCurrency, micros, reason };
  const view = bridgeView;
  const check = async (r) => {
    if (!['submitted', 'uncertain'].includes(r.state)) return view(r);
    let st;
    try { st = await relayApi.status(r.check); } catch { return view(r); }
    if (st.status === 'success') {
      await refresh(t);
      persist(() => {
        Object.assign(map()[id], { state: 'settled', settledAt: iso(), relayStatus: 'success', outTxHashes: st.txHashes || [] });
        ledger(t, -r.actualMicros, `${reason}: ${r.inFormatted} ETH → ${r.outFormatted} USDC on Solana (Relay ${String(r.requestId).slice(0, 10)}…)`, { tx: r.txs[0], chain: 'robinhood', relay: r.requestId, billingId: id, ...(ledgerKey || {}) });
      });
      event('package', `${t.symbol}: ${reason} — $${(r.actualMicros / 1e6).toFixed(2)} bridged to the platform DEX wallet`, { token: t.address });
    } else if (['failure', 'refund'].includes(st.status)) {
      // The origin deposit came back (or never left). The record stays for the operator;
      // the hold is released and the cache re-read so the returned ETH counts again.
      await refresh(t).catch(() => {});
      persist(() => { Object.assign(map()[id], { state: 'refunded', relayStatus: st.status, refundedAt: iso(), failure: `Relay ${st.status}` }); ledger(t, 0, `${reason}: bridge ${st.status} (Relay ${String(r.requestId).slice(0, 10)}…)`, { relay: r.requestId, billingId: id }); });
      event('package', `${t.symbol}: ${reason} — bridge ${st.status}; the deposit returned to the treasury (Relay ${String(r.requestId).slice(0, 10)}…)`, { token: t.address, level: 'warn' });
    } else if (r.state === 'submitted' && !r.staleAt && now() - Date.parse(r.submittedAt || r.createdAt || 0) > BRIDGE_STALE_SUBMIT_MS) {
      // Neither settled nor refunded long after dispatch: the operator decides; nothing is re-sent.
      persist(() => { Object.assign(map()[id], { state: 'uncertain', staleAt: iso(), relayStatus: st.status, failure: `Relay still ${st.status} ${Math.round(BRIDGE_STALE_SUBMIT_MS / 60_000)} min after dispatch` }); });
      event('package', `${t.symbol}: ${reason} — bridge unresolved (Relay ${st.status}); operator reconciliation required`, { token: t.address, level: 'error' });
    }
    return view(map()[id]);
  };
  const existing = t.packageBridgeReservations?.[id];
  if (existing) {
    if (existing.version !== 1 || existing.id !== id || existing.limitMicros !== micros || billingHash(existing.binding) !== billingHash(binding)) return { state: 'invalid', id, reason: 'package bridge record requires reconciliation' };
    if (bridgeInFlight.has(id)) return view(existing);       // this id is being dispatched right now
    if (existing.state === 'reserved') {
      // The send follows the 'submitted' persist: a record still 'reserved' after a crash was never dispatched.
      persist(() => { Object.assign(map()[id], { state: 'released', failure: 'interrupted before dispatch' }); });
      if (!dispatch) return view(map()[id]);
    } else if (existing.state !== 'released') return check(existing);
    else if (!dispatch) return view(existing);
  } else if (!dispatch) return { state: 'none', id, reason: null };
  if (Object.values(t.packageBridgeReservations || {}).some(r => r.version !== 1 || !BRIDGE_STATES.includes(r.state))) return { state: 'invalid', id, reason: 'package bridge history requires operator review' };
  if (bridgeInFlight.has(id)) return { state: 'unavailable', id, reason: 'bridge call already in progress' };
  bridgeInFlight.add(id);
  try { return await lock(t, () => start()); }
  catch (e) { if (e.status === 409) return { state: 'unavailable', id, reason: 'treasury is processing another transaction' }; throw e; }
  finally { bridgeInFlight.delete(id); }

  async function start() {
    await refresh(t);
    if (!(t.treasury.ethUsd > 0) || !Number.isFinite(t.treasury.ethUsd)) return { state: 'unavailable', id, reason: 'native asset valuation is unavailable' };
    const gasReserveMicros = Math.ceil(GAS_RESERVE_ETH * t.treasury.ethUsd * 1e6);
    // Availability outside every OTHER liability: this record and the reserve it consumes are excluded.
    const available = () => packagePaymentAvailableMicros(t, { id, reservedMicros });
    if (!Number.isSafeInteger(t.treasury.micros) || available() < micros + gasReserveMicros) return { state: 'unavailable', id, reason: 'treasury cannot cover this allocation outside its other liabilities' };
    let inputWei = weiFor(micros, t.treasury.ethUsd);
    const have = ethers.parseEther(String(t.treasury.robinhoodEth || 0));
    if (have < inputWei + ethers.parseEther(String(GAS_RESERVE_ETH))) return { state: 'unavailable', id, reason: 'treasury ETH on Robinhood is below the allocation plus gas reserve' };
    const refuse = (failure) => { persist(() => { map()[id] = { id, version: 1, binding, limitMicros: micros, state: 'released', createdAt: iso(), txs: [], failure: String(failure).slice(0, 160) }; }); return { state: 'released', id, reason: String(failure) }; };
    const quoteFor = (wei) => relayApi.quote({ user: t.treasury.wallet, recipient: target, originChainId: ROBINHOOD.id, destinationChainId, destinationCurrency, amount: wei.toString(), tradeType: 'EXACT_INPUT' });
    let q;
    try { q = await quoteFor(inputWei); } catch (e) { return refuse('Relay quote failed: ' + e.message); }
    let inUsdMicros = Math.round(Number(q.inUsd) * 1e6);
    if (!(inUsdMicros > 0)) return refuse('Relay quote carries no input valuation');
    if (Math.abs(inUsdMicros - micros) > micros * BRIDGE_PRICE_TOLERANCE) {
      // The cached price drifted from Relay's: size the input from Relay's own valuation and quote once more.
      inputWei = inputWei * BigInt(micros) / BigInt(inUsdMicros);
      if (have < inputWei + ethers.parseEther(String(GAS_RESERVE_ETH))) return { state: 'unavailable', id, reason: 'treasury ETH on Robinhood is below the re-priced allocation plus gas reserve' };
      try { q = await quoteFor(inputWei); } catch (e) { return refuse('Relay re-quote failed: ' + e.message); }
      inUsdMicros = Math.round(Number(q.inUsd) * 1e6);
      if (!(inUsdMicros > 0) || Math.abs(inUsdMicros - micros) > micros * BRIDGE_PRICE_TOLERANCE) return refuse(`Relay values the input at $${(inUsdMicros / 1e6).toFixed(2)} for a $${(micros / 1e6).toFixed(2)} allocation`);
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(q.requestId || '') || !q.check?.includes(q.requestId)) return refuse('invalid Relay bridge identity');
    const expected = (q.txs || []).map(tx => ({ to: String(tx.to).toLowerCase(), data: tx.data || '0x', value: BigInt(tx.value), gas: tx.gas == null ? null : BigInt(tx.gas) }));
    try { relay.assertNativeDepositSteps(q.txs || []); } catch (e) { return refuse(e.message); }
    if (!expected.length || expected.some(tx => tx.value < 0n) || expected.reduce((n, tx) => n + tx.value, 0n) > inputWei) return refuse('Relay bridge transactions exceed the quoted input');
    const outUsdMicros = Math.round(Number(q.outUsd) * 1e6);
    if (!(outUsdMicros > 0) || outUsdMicros < minOut) return refuse(`Relay bridge output too low: $${(outUsdMicros / 1e6).toFixed(2)} for $${(micros / 1e6).toFixed(2)} (minimum $${(minOut / 1e6).toFixed(2)})`);
    const actualMicros = Math.min(micros, inUsdMicros);   // the exact treasury debit that is booked
    if (available() < micros + gasReserveMicros) return { state: 'unavailable', id, reason: 'treasury balance changed while quoting' };
    persist(() => { map()[id] = { id, version: 1, binding, requestId: q.requestId, check: q.check, limitMicros: micros, actualMicros, minOutMicros: minOut, inputWei: inputWei.toString(), inFormatted: q.inFormatted, outFormatted: q.outFormatted, outAmount: q.outAmount, outUsd: q.outUsd, inUsd: q.inUsd, state: 'reserved', createdAt: iso(), txs: [] }; });
    let attempted = false, index = 0;
    try {
      const signer = signerFor(t.address);
      const guarded = { sendTransaction: async (tx) => {
        const e = expected[index];
        if (!e || String(tx.to).toLowerCase() !== e.to || (tx.data || '0x') !== e.data || BigInt(tx.value) !== e.value || (tx.gasLimit == null ? null : BigInt(tx.gasLimit)) !== e.gas) throw new Error('bridge dispatch differs from the verified quote');
        const r = map()[id];
        if (!r || r.requestId !== q.requestId || billingHash(r.binding) !== billingHash(binding)) throw new Error('bridge intent changed before dispatch');
        if (available() < micros + gasReserveMicros) throw new Error('treasury balance changed before dispatch');
        persist(() => { Object.assign(map()[id], { state: 'submitted', submittedAt: iso() }); }); attempted = true;
        const sent = await signer.sendTransaction(tx);
        if (!/^0x[a-fA-F0-9]{64}$/.test(sent.hash || '')) throw new Error('bridge transaction hash unavailable');
        persist(() => { map()[id].txs.push(sent.hash); });
        index++;
        const value = BigInt(tx.value);
        return { hash: sent.hash, wait: async (confirms = 1, timeout = PACKAGE_RECEIPT_WAIT_MS) => {
          const rc = await sent.wait(confirms, timeout);
          if (rc?.status === 1) persist(() => {
            // The deposit left the treasury: the record is no longer a hold and the cached balance says so at once.
            Object.assign(map()[id], { depositMined: true, depositMinedAt: iso() });
            t.treasury.robinhoodEth = Math.max(0, (t.treasury.robinhoodEth || 0) - Number(ethers.formatEther(value)));
            t.treasury.ethMicros = Math.max(0, Math.round(t.treasury.robinhoodEth * (t.treasury.ethUsd || 0) * 1e6));
            t.treasury.micros = t.treasury.ethMicros + (t.treasury.usdcMicros || 0) + (t.treasury.usdgMicros || 0);
          });
          return rc;
        } };
      } };
      const hashes = await relayApi.execute(guarded, q);
      if (index !== expected.length || hashes.length !== expected.length) throw new Error('bridge transaction execution is incomplete');
      event('package', `${t.symbol}: ${reason} — bridging ${q.inFormatted} ETH → ${q.outFormatted} USDC (Relay ${q.requestId.slice(0, 10)}…)`, { token: t.address });
      return check(map()[id]);
    } catch (e) {
      persist(() => { const r = map()[id]; if (r.state !== 'settled') { r.state = attempted ? 'uncertain' : 'released'; r.failure = String(e.message).slice(0, 160); } });
      if (e.packagePersistenceFailure) throw e;
      if (attempted) event('package', `${t.symbol}: ${reason} — bridge dispatch outcome unknown (${String(e.message).slice(0, 80)}); operator reconciliation required, nothing is re-sent`, { token: t.address, level: 'error' });
      return { state: attempted ? 'uncertain' : 'released', id, reason: attempted ? 'bridge dispatch outcome unknown; operator reconciliation required' : 'bridge stopped before dispatch: ' + e.message };
    }
  }
}
// Exported for tests (kept out of the vm slice the durability test takes from this file).
export { unresolvedPocket };
export { chargeAiAccount, bookAiAccountUsage, settleOwedAiUsage, oweAiAccountUsage };
