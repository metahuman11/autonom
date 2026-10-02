// Pure, persisted accounting primitives. Amounts are integer micro-USD.
// No provider calls, wallets, environment access or automatic expiry of uncertain charges.
import { dexReserveMicros, socialAccountReserveMicros } from './launch-package.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const amount = n => { if (!Number.isSafeInteger(n) || n < 0) throw fail(400, 'invalid usage amount'); return n; };
const epochKey = t => `${t.epoch.index}:${t.epoch.startedSimMs}`;
const pending = r => ['reserved', 'submitted', 'uncertain'].includes(r.state);
const committed = r => ['reserved', 'submitted', 'uncertain', 'settled'].includes(r.state);
const DEX_BRIDGE_PREFIX = 'package-dex-bridge:', SOCIAL_DEBIT_PREFIX = 'package-social:', SOCIAL_USAGE_PREFIX = 'package-social-usage:';
const idOf = r => String(r?.id || '');
const sumBy = (rows, keep) => rows.filter(keep).reduce((n, r) => amount(n + amount(r.limitMicros)), 0);
// The launch-package holds, netted against the package's own money movements so the
// same dollars are never held twice: the DEX reserve is satisfied by its bridge record
// (committed or already gone), the X-account reserve by its debit record, and unsettled
// X usage by the batch that is settling it. `exclude` ignores one record entirely (the
// record whose own availability is being computed).
export function packageHolds(t, { exclude = null } = {}) {
  const bridges = Object.values(t.packageBridgeReservations || {}).filter(r => idOf(r) !== exclude);
  const debits = Object.values(t.packageUsageReservations || {}).filter(r => idOf(r) !== exclude);
  const dex = Math.max(0, dexReserveMicros(t) - sumBy(bridges, r => idOf(r).startsWith(DEX_BRIDGE_PREFIX) && committed(r)));
  const social = Math.max(0, socialAccountReserveMicros(t) - sumBy(debits, r => idOf(r).startsWith(SOCIAL_DEBIT_PREFIX) && committed(r)));
  const usage = Math.max(0, amount(t.socialUsage?.unsettledMicros || 0) - sumBy(debits, r => idOf(r).startsWith(SOCIAL_USAGE_PREFIX) && pending(r)));
  return { dex, social, usage, reserve: dex + social, total: dex + social + usage };
}
export const packageReserveHeld = (t, opts) => packageHolds(t, opts).reserve;
// Owed provider-account charges remain liabilities. A pending settlement record
// replaces the same owed amount instead of holding it twice.
export function aiAccountHeld(t, { exclude = null } = {}) {
  const owed = amount(t.aiAccountUsage?.unsettledMicros || 0);
  const settling = Object.values(t.aiUsageReservations || {}).filter(r => idOf(r) !== exclude && pending(r))
    .reduce((n,r) => amount(n + amount(r.limitMicros)), 0);
  return Math.max(0, owed - settling);
}

// A dex bridge whose origin deposit is already mined has left the treasury: the refreshed
// balance reflects it, so it is no longer a hold (the reserve netting above still applies).
const heldRecord = r => pending(r) && !(idOf(r).startsWith(DEX_BRIDGE_PREFIX) && r.depositMined === true);
export const heldUsage = (t, { exclude = null } = {}) => [...Object.values(t.usageReservations || {}), ...Object.values(t.missionUsageReservations || {}), ...Object.values(t.proposalUsageReservations || {}), ...Object.values(t.vpsUsageReservations || {}), ...Object.values(t.aiUsageReservations || {}), ...Object.values(t.bridgeUsageReservations || {}), ...Object.values(t.communityActionReservations || {}), ...Object.values(t.packageUsageReservations || {}), ...Object.values(t.packageBridgeReservations || {})].filter(r => heldRecord(r) && (exclude == null || idOf(r) !== exclude)).reduce((n, r) => amount(n + amount(r.limitMicros)), packageHolds(t, { exclude }).total + aiAccountHeld(t, { exclude }));
// The launch reserve is enforced against aggregate treasury funds. It is not
// also a $300 debt against the small Base AI pocket; that would block all AI.
export const heldUsageForBasePocket = t => heldUsage(t) - packageReserveHeld(t);
// Only what is actually paid out of an AI pocket: personal AI/voice and proposal AI holds. A Solana
// project's Base pocket must not carry its VPS hours (SOL), its bridge inputs (already left the
// treasury or blocked as unresolved) or launch-package money — those would strand a funded pocket.
export const heldAiUsage = t => [...Object.values(t.usageReservations || {}), ...Object.values(t.missionUsageReservations || {}), ...Object.values(t.proposalUsageReservations || {})].filter(pending).reduce((n, r) => amount(n + amount(r.limitMicros)), 0);

// Defensive spending ceilings, not provider prices or permission to spend. A
// matching, currently approved proposal is still required by the service layer.
export const PROPOSAL_AI_POLICY = Object.freeze({ version: 1, maxCalls: 12, maxCallMicros: 1_000_000, maxTotalMicros: 5_000_000 });
export const PROPOSAL_USAGE_POLICY = PROPOSAL_AI_POLICY;
// Startup migration ONLY, before new work can enter in_progress. Old AI charges
// lack proposal/step identifiers, so no unused lifetime budget can be inferred.
// Repeating an in_progress status message never clears this review requirement.
export function markLegacyProposalUsageForReview(t) {
  let changed = false;
  for (const p of t.proposals || []) {
    if (p.status !== 'approved' || !['TASK','WEBSITE_UPDATE'].includes(p.type) ||
        !['in_progress','paused'].includes(p.agentStatus) || t.proposalUsageAccounts?.[p.id]) continue;
    const reason = 'Prior AI spending cannot be mapped to a proposal budget; operator review required before paid work can resume';
    if (p.aiBudgetReviewRequired !== true || p.agentStatus !== 'paused' || p.agentReason !== reason) changed = true;
    p.aiBudgetReviewRequired = true; p.agentStatus = 'paused'; p.agentReason = reason;
  }
  return changed;
}
const proposalIdOk = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const hashOk = hash => typeof hash === 'string' && /^(?:0x)?[a-f0-9]{64}$/.test(hash);
const proposalRecords = (t, proposalId) => Object.values(t.proposalUsageReservations || {}).filter(r => r.proposalId === proposalId);
function proposalAccount(t, proposalId, approvalHash) {
  if (!proposalIdOk(proposalId) || !hashOk(approvalHash)) throw fail(400, 'invalid proposal AI authority');
  const account = t.proposalUsageAccounts?.[proposalId];
  if (account && (account.version !== 1 || account.proposalId !== proposalId || account.approvalHash !== approvalHash ||
      account.maxCalls !== PROPOSAL_AI_POLICY.maxCalls || account.maxCallMicros !== PROPOSAL_AI_POLICY.maxCallMicros ||
      account.maxTotalMicros !== PROPOSAL_AI_POLICY.maxTotalMicros)) throw fail(409, 'proposal AI approval or budget policy changed; review required');
  const rows = proposalRecords(t, proposalId);
  if (rows.length && !account) throw fail(409, 'proposal AI history lacks its approved budget; review required');
  if (!account && (t.treasury.ledger || []).some(r => r.proposalId === proposalId && String(r.reason || '').startsWith('AI request'))) {
    throw fail(409, 'existing proposal AI spending lacks its lifetime budget; review required');
  }
  for (const r of rows) {
    if (r.version !== 1 || r.approvalHash !== approvalHash || !Number.isInteger(r.step) || r.step < 1 || r.step > PROPOSAL_AI_POLICY.maxCalls ||
        r.id !== `ai:proposal:${proposalId}:${r.step}` || !['reserved','submitted','uncertain','settled','released'].includes(r.state) ||
        !Number.isSafeInteger(r.limitMicros) || r.limitMicros <= 0 || r.limitMicros > PROPOSAL_AI_POLICY.maxCallMicros ||
        (r.state === 'settled' && (!Number.isSafeInteger(r.actualMicros) || r.actualMicros < 0 || r.actualMicros > r.limitMicros))) {
      throw fail(409, 'proposal AI history is not verifiable; review required');
    }
  }
  return { account, rows };
}
export function proposalUsageOf(t, proposalId, approvalHash) {
  const { rows } = proposalAccount(t, proposalId, approvalHash);
  const usedMicros = rows.filter(r => r.state === 'settled').reduce((n,r) => amount(n + r.actualMicros), 0);
  const held = rows.filter(pending);
  const reservedMicros = held.reduce((n,r) => amount(n + r.limitMicros), 0);
  return { ...PROPOSAL_AI_POLICY, attempts: rows.length, usedMicros, reservedMicros,
    uncertainMicros: held.filter(r => r.state === 'uncertain').reduce((n,r) => amount(n + r.limitMicros), 0),
    remainingMicros: Math.max(0, PROPOSAL_AI_POLICY.maxTotalMicros - usedMicros - reservedMicros) };
}
export function assertProposalUsageRequest(t, { proposalId, approvalHash, step }) {
  const { rows } = proposalAccount(t, proposalId, approvalHash);
  if (!Number.isInteger(step) || step < 1 || step > PROPOSAL_AI_POLICY.maxCalls) throw fail(400, 'proposal AI requires a persistent step from 1 to 12');
  const id = `ai:proposal:${proposalId}:${step}`;
  if (t.proposalUsageReservations?.[id] || rows.some(r => r.step >= step)) throw fail(409, 'proposal AI step already submitted or out of order; no automatic paid retry');
  if (rows.length >= PROPOSAL_AI_POLICY.maxCalls) throw fail(409, 'proposal AI call limit reached');
  if (proposalUsageOf(t, proposalId, approvalHash).remainingMicros <= 0) throw fail(402, 'proposal AI lifetime budget exhausted');
  return id;
}
export function reserveProposalUsage(t, { proposalId, approvalHash, step, limitMicros, fingerprint }) {
  const id = assertProposalUsageRequest(t, { proposalId, approvalHash, step });
  amount(limitMicros);
  if (!limitMicros || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw fail(400, 'invalid proposal AI reservation');
  if (limitMicros > PROPOSAL_AI_POLICY.maxCallMicros) throw fail(402, 'proposal AI quoted maximum exceeds the per-call safety cap');
  if (proposalUsageOf(t, proposalId, approvalHash).remainingMicros < limitMicros) throw fail(402, 'proposal AI lifetime budget is insufficient');
  if (amount(t.treasury.micros) - heldUsage(t) < limitMicros) throw fail(402, 'treasury available balance is insufficient');
  if (Object.keys(t.proposalUsageReservations || {}).length >= 20_000) throw fail(429, 'proposal AI history requires archival before further spending');
  const accounts = t.proposalUsageAccounts ||= {};
  accounts[proposalId] ||= { ...PROPOSAL_AI_POLICY, proposalId, approvalHash, createdAt: new Date().toISOString() };
  return (t.proposalUsageReservations ||= {})[id] = { id, version: 1, proposalId, approvalHash, step, fingerprint,
    limitMicros, state: 'reserved', createdAt: new Date().toISOString() };
}
export function submitProposalUsage(t, id) {
  const r = t.proposalUsageReservations?.[id];
  if (r?.state !== 'reserved') throw fail(409, 'proposal AI reservation is not ready');
  r.state = 'submitted'; r.submittedAt = new Date().toISOString(); return r;
}
export function releaseProposalUsage(t, id) {
  const r = t.proposalUsageReservations?.[id];
  if (r?.state !== 'reserved') throw fail(409, 'submitted proposal AI charges require a verified receipt');
  r.state = 'released'; return r;
}
export function refuseProposalUsage(t, id, reason = "") {
  const r = t.proposalUsageReservations?.[id];
  if (!r || !['submitted', 'uncertain'].includes(r.state)) throw fail(409, 'only a submitted proposal AI charge can be refused');
  r.state = 'released'; r.refusedAt = new Date().toISOString(); r.refusedReason = String(reason).slice(0, 200); return r;
}
export function uncertainProposalUsage(t, id) {
  const r = t.proposalUsageReservations?.[id];
  if (r?.state === 'submitted') r.state = 'uncertain';
}
export function settleProposalUsage(t, id, actualMicros) {
  amount(actualMicros);
  const r = t.proposalUsageReservations?.[id];
  if (!r || !['submitted','uncertain'].includes(r.state)) throw fail(409, 'proposal AI charge cannot be settled');
  if (actualMicros > r.limitMicros) { r.state = 'uncertain'; throw fail(502, 'provider charge exceeds proposal AI maximum; review required'); }
  r.state = 'settled'; r.actualMicros = actualMicros; r.settledAt = new Date().toISOString(); return r;
}
// Holder keys: EVM lowercased, base58 Solana wallets verbatim (case-sensitive).
const holderKeyOf = holder => (/^0x/i.test(String(holder)) ? String(holder).toLowerCase() : String(holder));
const HOLDER_RE = /^(?:0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
export function usageOf(t, holder) {
  const h = holderKeyOf(holder);
  const totalMicros = amount(Math.floor(t.epoch.chatPoolMicros * (t.epoch.weights[h] || 0)));
  const usedMicros = amount(t.epoch.used[h] || 0);
  // Outstanding liabilities carry across epoch boundaries; a rollover is not a refund.
  const rows = Object.values(t.usageReservations || {}).filter(r => r.holder === h && pending(r));
  const reservedMicros = rows.reduce((n, r) => n + amount(r.limitMicros), 0);
  return { totalMicros, usedMicros, reservedMicros, uncertainMicros: rows.filter(r => r.state === 'uncertain').reduce((n, r) => n + r.limitMicros, 0), remainingMicros: Math.max(0, totalMicros - usedMicros - reservedMicros) };
}
export function reserveUsage(t, { id, holder, limitMicros, kind, fingerprint }) {
  amount(limitMicros);
  if (!limitMicros || !/^[a-zA-Z0-9:_-]{1,180}$/.test(id || '') || !['ai', 'voice'].includes(kind) || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw fail(400, 'invalid usage reservation');
  const h = holderKeyOf(holder);
  if (!HOLDER_RE.test(h)) throw fail(400, 'invalid usage holder');
  const records = t.usageReservations ||= {};
  const old = records[id];
  if (old) {
    if (old.holder !== h || old.kind !== kind || old.fingerprint !== fingerprint) throw fail(409, 'usage request changed');
    throw fail(409, old.state === 'settled' ? 'usage request already completed' : 'usage request already submitted; no automatic paid retry');
  }
  if (Object.keys(records).length >= 20_000) throw fail(429, 'usage history requires archival before further spending');
  if (usageOf(t, h).remainingMicros < limitMicros) throw fail(402, 'personal usage allowance is insufficient');
  const sharedHeld = heldUsage(t);
  if (amount(t.treasury.micros) - sharedHeld < limitMicros) throw fail(402, 'treasury available balance is insufficient');
  return records[id] = { id, holder: h, kind, fingerprint, limitMicros, epoch: epochKey(t), state: 'reserved', createdAt: new Date().toISOString() };
}
export function submitUsage(t, id) {
  const r = t.usageReservations?.[id];
  if (r?.state !== 'reserved') throw fail(409, 'usage reservation is not ready');
  r.state = 'submitted'; r.submittedAt = new Date().toISOString(); return r;
}
export function releaseUsage(t, id) {
  const r = t.usageReservations?.[id];
  if (r?.state !== 'reserved') throw fail(409, 'submitted charges cannot be released without a verified receipt');
  r.state = 'released'; return r;
}
/// The provider answered 402 to the submitted payment: nothing settled, the hold is released and
/// the reason kept on the record. Never used for timeouts or missing receipts (those stay uncertain).
export function refuseUsage(t, id, reason = "") {
  const r = t.usageReservations?.[id];
  if (!r || !['submitted', 'uncertain'].includes(r.state)) throw fail(409, 'only a submitted charge can be refused');
  r.state = 'released'; r.refusedAt = new Date().toISOString(); r.refusedReason = String(reason).slice(0, 200); return r;
}
export function uncertainUsage(t, id) {
  const r = t.usageReservations?.[id];
  if (r?.state === 'submitted') r.state = 'uncertain';
}
export function settleUsage(t, id, actualMicros) {
  amount(actualMicros); const r = t.usageReservations?.[id];
  if (!r || !['submitted', 'uncertain'].includes(r.state)) throw fail(409, 'usage charge cannot be settled');
  if (actualMicros > r.limitMicros) { r.state = 'uncertain'; throw fail(502, 'provider charge exceeds authorized maximum; review required'); }
  // An old-epoch hold was already deducted from current availability. Settle into
  // current usage if the epoch changed so the charge cannot disappear on rollover.
  t.epoch.used[r.holder] = amount(amount(t.epoch.used[r.holder] || 0) + actualMicros);
  r.state = 'settled'; r.actualMicros = actualMicros; r.settledAt = new Date().toISOString();
  return r;
}

// Mission/onboarding calls have no holder quota, but must still reserve a quoted
// maximum before dispatch. An uncertain call blocks a new paid mission request.
export function reserveMissionUsage(t, { id, limitMicros, fingerprint }) {
  amount(limitMicros);
  if (!limitMicros || !/^ai:mission:[a-f0-9-]{36}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw fail(400, 'invalid mission AI reservation');
  const rows = t.missionUsageReservations ||= {};
  if (Object.values(rows).some(pending)) throw fail(409, 'previous mission AI request needs reconciliation; no new paid request');
  if (Object.hasOwn(rows,id) || Object.keys(rows).length >= 20000) throw fail(409, 'mission AI history requires review');
  if (amount(t.treasury.micros) - heldUsage(t) < limitMicros) throw fail(402, 'treasury available balance is insufficient');
  return rows[id] = { id, limitMicros, fingerprint, state: 'reserved', createdAt: new Date().toISOString() };
}
export function submitMissionUsage(t,id) {
  const r=t.missionUsageReservations?.[id]; if(r?.state!=='reserved')throw fail(409,'mission AI reservation is not ready');
  r.state='submitted';r.submittedAt=new Date().toISOString();return r;
}
export function releaseMissionUsage(t,id,{refused=false}={}) {
  const r=t.missionUsageReservations?.[id];
  if(!r||!(r.state==='reserved'||(refused&&['submitted','uncertain'].includes(r.state))))throw fail(409,'mission AI outcome must be verified before releasing its hold');
  r.state='released';return r;
}
export function uncertainMissionUsage(t,id) {
  const r=t.missionUsageReservations?.[id];if(r?.state==='submitted')r.state='uncertain';return r;
}
export function settleMissionUsage(t,id,actualMicros) {
  amount(actualMicros);const r=t.missionUsageReservations?.[id];
  if(!r||!['submitted','uncertain'].includes(r.state))throw fail(409,'mission AI charge cannot be settled');
  if(actualMicros>r.limitMicros){r.state='uncertain';throw fail(502,'mission AI charge exceeds its maximum');}
  r.state='settled';r.actualMicros=actualMicros;r.settledAt=new Date().toISOString();return r;
}
