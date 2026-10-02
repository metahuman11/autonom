// Platform spending limits. These are ceilings, never provider prices or grants.
import { isStagedLaunch, runtimeVpsReserveMicros, markPackageFunded, operationalAiLiquidityMicros, runtimeStageReady, hasPriorRuntimeActivation, recordRuntimeActivation, activationRequirementMicros, hasLaunchPackage, isPackageFunded, hasFreshMarketingObservation } from './launch-package.mjs';
import { heldUsage, packageHolds } from './usage-budget.mjs';
import { publicVpsUsageReviewOf } from './vps-billing-recovery.mjs';
export const VPS_MAX_DPH = 1;
export const RUNTIME_AI_MAX_CALL_MICROS = 1_000_000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reservationMaps = ['usageReservations', 'missionUsageReservations', 'proposalUsageReservations', 'vpsUsageReservations',
  'aiUsageReservations', 'bridgeUsageReservations', 'communityActionReservations', 'packageUsageReservations', 'packageBridgeReservations'];
const pendingStates = new Set(['reserved', 'submitted', 'uncertain']);
const settledStates = new Set(['settled', 'released']);
// Startup must not interpret an unreadable liability journal as zero dollars.
// These are the states written by the accounting modules; package bridges alone
// additionally support a verified refunded terminal state. Older terminal rows
// may omit amounts, but an outstanding reservation must retain its exact limit.
export function assertRuntimeStartupLiabilities(t) {
  const reject = () => { throw Object.assign(fail(409, 'Project payment commitments require review before another rental'), { code: 'runtime_liabilities_unverified' }); };
  for (const key of reservationMaps) {
    const rows = t[key];
    if (rows == null) continue;
    if (!record(rows)) reject();
    for (const row of Object.values(rows)) {
      if (!record(row) || !(pendingStates.has(row.state) || settledStates.has(row.state) || key === 'packageBridgeReservations' && row.state === 'refunded')) reject();
      if ((pendingStates.has(row.state) || Object.hasOwn(row, 'limitMicros')) && (!Number.isSafeInteger(row.limitMicros) || row.limitMicros < 0)) reject();
    }
  }
  for (const key of ['aiAccountUsage', 'socialUsage']) {
    const usage = t[key];
    if (usage == null) continue;
    if (!record(usage) || Object.hasOwn(usage, 'unsettledMicros') && (!Number.isSafeInteger(usage.unsettledMicros) || usage.unsettledMicros < 0)) reject();
  }
  try {
    const held = heldUsage(t);
    if (!Number.isSafeInteger(held) || held < 0) reject();
    return held;
  } catch { reject(); }
}
export function assertVpsQuote(offer) {
  if (!Number.isFinite(offer?.dph) || offer.dph <= 0 || offer.dph > VPS_MAX_DPH)
    throw fail(409, 'VPS hourly quote must be at most $1.00, including allocated storage');
  return offer;
}
export function cappedVpsCriteria(criteria = {}) {
  const requested = criteria.maxDph == null ? VPS_MAX_DPH : Number(criteria.maxDph);
  if (!Number.isFinite(requested) || requested <= 0) throw fail(400, 'invalid VPS hourly price ceiling');
  return { ...criteria, maxDph: Math.min(VPS_MAX_DPH, requested) };
}
export function unheldVpsReserveMicros(t, now = Date.now()) {
  if (!isStagedLaunch(t)) return 0;
  const alreadyHeld = Object.values(t.vpsUsageReservations || {}).filter(r => ['reserved','submitted','uncertain'].includes(r?.state))
    .reduce((n,r) => n + (Number.isSafeInteger(r.limitMicros) && r.limitMicros >= 0 ? r.limitMicros : Number.MAX_SAFE_INTEGER), 0);
  return Math.max(0, runtimeVpsReserveMicros(t, { now }) - alreadyHeld);
}
// One read-only view of the money an AI request may use. A holder's period
// entitlement is separate: it cannot make reserved or unverified money spendable.
// In particular, a service-usage review is not an invitation to deposit more.
export function runtimeAiAvailabilityOf(t, { ownHoldMicros = 0, now = Date.now() } = {}) {
  let staged = false, heldMicros = null, vpsReserveMicros = null, unheldReserve = null, review = null;
  const balanceMicros = Number.isSafeInteger(t.treasury?.micros) && t.treasury.micros >= 0 ? t.treasury.micros : null;
  let liabilitiesVerified = true;
  try {
    staged = isStagedLaunch(t);
    review = staged ? publicVpsUsageReviewOf(t) : null;
    heldMicros = assertRuntimeStartupLiabilities(t);
    vpsReserveMicros = staged ? runtimeVpsReserveMicros(t, { now }) : 0;
    unheldReserve = staged ? unheldVpsReserveMicros(t, now) : 0;
    if (![vpsReserveMicros, unheldReserve, ownHoldMicros].every(n => Number.isSafeInteger(n) && n >= 0) || ownHoldMicros > heldMicros)
      liabilitiesVerified = false;
  } catch { liabilitiesVerified = false; }
  let reason = null, message = null, status = 'ready', availableMicros = 0;
  if (!liabilitiesVerified) {
    status = 'review_required'; reason = 'runtime_liabilities_unverified';
    message = 'AI responses are paused while the platform checks existing payment commitments. Adding funds will not resolve this check.';
  } else if (balanceMicros == null) {
    status = 'review_required'; reason = 'runtime_balance_unverified';
    message = 'The project balance could not be verified. AI responses are paused until its balance is checked.';
  } else {
    const remaining = balanceMicros - (heldMicros - ownHoldMicros) - unheldReserve;
    if (!Number.isSafeInteger(remaining)) {
      status = 'review_required'; reason = 'runtime_liabilities_unverified';
      message = 'AI responses are paused while the platform checks existing payment commitments. Adding funds will not resolve this check.';
    } else {
      availableMicros = Math.max(0, remaining);
      if (availableMicros === 0) {
        if (review?.required) {
          status = 'review_required'; reason = 'vps_usage_review_required';
          message = 'AI responses are paused because the remaining project funds are reserved for server usage awaiting a billing review. Your holder allowance is unchanged. The platform needs to check this usage.';
        } else {
          status = 'budget_paused'; reason = 'runtime_funding_required';
          message = 'AI responses are paused because project funds are reserved for server costs and existing payments. Your holder allowance is unchanged.';
        }
      }
    }
  }
  return { version: 1, status, reason, message, availableMicros, balanceMicros, heldMicros,
    vpsReserveMicros, unheldVpsReserveMicros: unheldReserve, reviewRequired: review?.required === true, reviewSince: review?.since || null };
}
export function assertRuntimeAiAffordable(t, limitMicros, { ownHoldMicros = 0, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(limitMicros) || limitMicros <= 0) throw fail(502, 'invalid AI quoted spending maximum');
  if (!isStagedLaunch(t)) return;
  if (limitMicros > RUNTIME_AI_MAX_CALL_MICROS) throw fail(402, 'AI request exceeds the $1 per-call safety ceiling');
  const availability = runtimeAiAvailabilityOf(t, { ownHoldMicros, now });
  if (availability.status === 'review_required')
    throw Object.assign(fail(409, availability.message), { code: availability.reason });
  if (availability.availableMicros < limitMicros)
    throw Object.assign(fail(402, 'AI is paused: confirmed funds must cover this request and the reserved VPS hours'), { code: 'runtime_funding_required' });
}

// A stopped project's next rental has its own budget. A prior activation
// preserves the one-time $5 milestone, but every rental still needs currently
// unheld money for two freshly quoted VPS hours and $1 of operating AI liquidity.
// Display callers may pass the saved plan; only dispatch supplies a live quote.
export function runtimeStartupFundingOf(t, { offer = t.lock?.startup?.lastQuote?.planSetAt === (t.plan?.setAt ?? null) ? t.lock.startup.lastQuote : t.plan?.offer, now = Date.now() } = {}) {
  const staged = isStagedLaunch(t), resumed = staged && hasPriorRuntimeActivation(t, { now });
  let heldMicros = 0, liabilitiesVerified = true;
  const liabilityReviewRequired = Boolean(publicVpsUsageReviewOf(t));
  if (staged) {
    try { heldMicros = assertRuntimeStartupLiabilities(t); }
    catch { heldMicros = null; liabilitiesVerified = false; }
  }
  const balanceMicros = Number.isSafeInteger(t.treasury?.micros) && t.treasury.micros >= 0 ? t.treasury.micros : 0;
  const quoteValid = Number.isFinite(offer?.dph) && offer.dph > 0 && offer.dph <= VPS_MAX_DPH;
  const hourlyMicros = quoteValid ? Math.ceil(offer.dph * 1_000_000) : null;
  const vpsMicros = resumed ? (hourlyMicros ?? 1_000_000) * 2 : 0;
  const aiMicros = resumed ? operationalAiLiquidityMicros(t) : 0;
  const requirementMicros = resumed ? vpsMicros + aiMicros : activationRequirementMicros(t);
  const availableMicros = liabilitiesVerified && !liabilityReviewRequired ? Math.max(0, balanceMicros - heldMicros) : 0;
  const valid = Number.isSafeInteger(requirementMicros) && requirementMicros > 0;
  return { resumed, requirementMicros, heldMicros, liabilitiesVerified, liabilityReviewRequired, balanceMicros, availableMicros, vpsMicros, aiMicros, hourlyMicros,
    quoteValid, freshBalance: !hasLaunchPackage(t) || hasFreshMarketingObservation(t, now),
    launchFunded: hasLaunchPackage(t) && isPackageFunded(t),
    affordable: liabilitiesVerified && !liabilityReviewRequired && valid && balanceMicros - heldMicros >= requirementMicros,
    missingMicros: liabilitiesVerified && !liabilityReviewRequired && valid ? Math.max(0, requirementMicros - (balanceMicros - heldMicros)) : null };
}
export function assertRuntimeStartupAffordable(t, { offer, now = Date.now(), requireFreshBalance = true } = {}) {
  if (t.lock?.state === 'paused') throw fail(409, 'Automatic startup is paused');
  if (t.vps?.reconciliationRequired || t.vps?.pendingCreate || ['stopping','reconciliation_required'].includes(t.vps?.phase))
    throw fail(409, 'An unresolved server rental or shutdown requires review before starting');
  if (isStagedLaunch(t)) assertVpsQuote(offer);
  const funding = runtimeStartupFundingOf(t, { offer, now });
  if (funding.liabilityReviewRequired) throw Object.assign(fail(409, 'Previous server usage requires an operator billing review before another rental'), { code: 'vps_usage_review_required' });
  if (!funding.liabilitiesVerified) assertRuntimeStartupLiabilities(t);
  if (requireFreshBalance && !funding.freshBalance)
    throw fail(503, 'A fresh verified marketing balance is required before rental; no server was ordered');
  if (hasLaunchPackage(t) && !funding.launchFunded)
    throw fail(402, 'A fresh verified marketing balance must reach the launch package funding target before rental');
  if (!funding.affordable) {
    const error = fail(402, funding.resumed ? 'Unreserved project funds must cover two quoted VPS hours and $1 of AI liquidity before restarting' : 'Project balance is below its startup target; waiting for funding');
    if (funding.quoteValid && offer) error.startupQuote = { dph: offer.dph, quotedAt: new Date(now).toISOString(), planSetAt: t.plan?.setAt ?? null };
    throw error;
  }
  return funding;
}

// Policy adoption and its funding certificate must be durable before rental.
export function persistRuntimeActivation(t, persist) {
  const keys = ['launchPackageUpgrade', 'launchPackageRun', 'treasury'];
  const before = keys.map(key => [key, Object.hasOwn(t, key), Object.hasOwn(t, key) ? structuredClone(t[key]) : null]);
  try {
    if (isStagedLaunch(t)) assertRuntimeStartupLiabilities(t);
    const funded = markPackageFunded(t, { availableMicros: t.treasury.micros - heldUsage(t) });
    const recorded = recordRuntimeActivation(t);
    const changed = funded || recorded;
    if (changed) persist();
    return changed;
  } catch (error) {
    for (const [key, exists, value] of before) { if (exists) t[key] = value; else delete t[key]; }
    throw error;
  }
}

// Setup allocations consume only the reserve actually held at dispatch time.
// A stale $20/$310 credit cannot create money after the wallet balance falls.
// Existing committed payments reconcile before callers reach this check.
export const isStagedPackagePayment = (t, id) => isStagedLaunch(t) && /^(package-social:|package-dex-bridge:)/.test(String(id));
export function packagePaymentAvailableMicros(t, { id, reservedMicros = 0, now = Date.now() }) {
  const kind = String(id).startsWith('package-social:') ? 'social' : String(id).startsWith('package-dex-bridge:') ? 'dex' : null;
  const held = heldUsage(t, { exclude: id });
  if (!kind || !isStagedLaunch(t)) return t.treasury.micros - (held - reservedMicros);
  if (!runtimeStageReady(t, { now })) return 0;
  const credit = Math.min(reservedMicros, packageHolds(t, { exclude: id })[kind]);
  return t.treasury.micros - (held - credit) - unheldVpsReserveMicros(t, now) - operationalAiLiquidityMicros(t);
}
