// A failed payment is not evidence that the project has run out of funds.
// This pure decision keeps transport, signing and receipt failures recoverable.
import { heldUsage } from './usage-budget.mjs';
import { hasFreshMarketingObservation } from './launch-package.mjs';

const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const sampleGapMs = 30_000;
const freshnessMs = 30_000;

const iso = value => { const n = stamp(value); return Number.isFinite(n) && n > 0 && n <= 4_102_444_800_000 ? new Date(n).toISOString() : null; };
const usageBinding = v => JSON.stringify([String(v.instanceId), v.startedAt || null]);
function usageReviewEvidence(t) {
  const v = t.vps || {}, review = v.usageReview, recovery = v.recovery, incident = v.lastIncident;
  // Records from before the last provider-confirmed resolution are closed history.
  const resolvedAt = stamp(v.usageReviewResolvedAt);
  const afterResolution = at => !(Number.isFinite(resolvedAt) && resolvedAt > 0) || stamp(at) > resolvedAt;
  // Old reviews are kept as history when a different allocation starts. A
  // malformed review without an identity cannot silently become spending proof.
  if (review && (review.instanceId == null || String(review.instanceId) === String(v.instanceId) && (!Object.hasOwn(review, 'startedAt') || review.startedAt === (v.startedAt || null))))
    return { since: iso(review.uncertainFrom), recordedAt: iso(review.recordedAt), persisted: review };
  if (recovery && String(recovery.instanceId) === String(v.instanceId) &&
      (recovery.active === true || recovery.firstObservedAt || recovery.recoveredAt) &&
      afterResolution(recovery.firstObservedAt || recovery.lastObservedAt))
    return { since: iso(recovery.firstObservedAt), recordedAt: null, persisted: null };
  // Cleanup can finish between provider polls and the next billing tick. The
  // retained incident must still hold that interval after recovery is cleared.
  // Legacy incidents lack startedAt; accept them conservatively when their
  // observation is not demonstrably from an earlier lifetime of the instance.
  if (incident && ['provider_observation', 'provider_destroyed'].includes(incident.kind) &&
      String(incident.instanceId) === String(v.instanceId)) {
    const since = iso(incident.firstObservedAt || incident.at), started = iso(v.startedAt);
    const sameLifetime = Object.hasOwn(incident, 'startedAt') ? incident.startedAt === (v.startedAt || null)
      : !since || !started || stamp(since) >= stamp(started);
    if (sameLifetime && afterResolution(since || incident.at)) return { since, recordedAt: null, persisted: null };
  }
  return null;
}
/// Closes an open usage review once the provider itself confirms the SAME allocation is running
/// and the runtime on it is alive (fresh heartbeat and a live stream). The provider's record is
/// the authority on whether the paid container ran; an API timeout in between never was. The
/// hours between the last billed hour and now are recorded as waived, not charged in a burst:
/// the platform already carried them on its provider account. Billing resumes from now.
export function resolveVpsUsageReview(t, persist, { now = Date.now(), observation, health, allocation } = {}) {
  const v = t.vps || {};
  if (!publicVpsUsageReviewOf(t)) return null;
  if (!allocation || String(allocation.instanceId) !== String(v.instanceId) || allocation.startedAt !== (v.startedAt || null)) return null;
  if (observation?.kind !== 'running' || health?.agentOnline !== true || health?.streamReady !== true) return null;
  const at = new Date(now).toISOString();
  const review = v.usageReview && (v.usageReview.instanceId == null || String(v.usageReview.instanceId) === String(v.instanceId)) ? v.usageReview : null;
  const since = review?.uncertainFrom || v.recovery?.firstObservedAt || v.lastIncident?.firstObservedAt || v.lastIncident?.at || null;
  const lastBilled = stamp(v.lastBilledAt) || stamp(v.startedAt);
  const waivedHours = Number.isFinite(lastBilled) && lastBilled > 0 ? Math.max(0, Math.floor((now - lastBilled) / 3_600_000)) : 0;
  const had = Object.hasOwn(v, 'usageReview');
  const snapshot = { review: structuredClone(v.usageReview ?? null), recovery: structuredClone(v.recovery ?? null), incident: structuredClone(v.lastIncident ?? null),
    lastBilledAt: v.lastBilledAt ?? null, resolvedAt: v.usageReviewResolvedAt ?? null, guard: structuredClone(v.billingGuard ?? null), history: structuredClone(v.usageReviewHistory ?? null) };
  try {
    v.usageReviewHistory = [...(Array.isArray(v.usageReviewHistory) ? v.usageReviewHistory : []), {
      version: 1, instanceId: v.instanceId, startedAt: v.startedAt || null, uncertainFrom: iso(since), resolvedAt: at, resolution: 'provider_confirmed_running',
      evidence: { providerCheckedAt: v.providerCheck?.checkedAt || at, heartbeatAt: t.agent?.lastHeartbeatAt || null, streamMeasuredAt: iso(health.streamMeasuredAt) },
      lastBilledAtBefore: v.lastBilledAt ?? null, waivedHours, billingResumedFrom: at }].slice(-20);
    delete v.usageReview;
    v.usageReviewResolvedAt = at;
    if (v.recovery && String(v.recovery.instanceId) === String(v.instanceId)) v.recovery = null;
    if (v.lastIncident && String(v.lastIncident.instanceId) === String(v.instanceId)) { v.lastIncident.resolvedAt ||= at; v.lastIncident.usageResolvedAt = at; }
    if (v.billingGuard?.reason === 'provider_usage_unverified') delete v.billingGuard;
    v.lastBilledAt = at;
    persist();
  } catch (error) {
    if (had) v.usageReview = snapshot.review; else delete v.usageReview;
    v.recovery = snapshot.recovery; v.lastIncident = snapshot.incident; v.lastBilledAt = snapshot.lastBilledAt;
    if (snapshot.resolvedAt == null) delete v.usageReviewResolvedAt; else v.usageReviewResolvedAt = snapshot.resolvedAt;
    if (snapshot.guard == null) delete v.billingGuard; else v.billingGuard = snapshot.guard;
    if (snapshot.history == null) delete v.usageReviewHistory; else v.usageReviewHistory = snapshot.history;
    throw error;
  }
  return { resolvedAt: at, since: iso(since), waivedHours };
}
// One ambiguous service interval requires review even after connectivity returns.
// No automatic cursor jump can turn that interval into paid or forgiven usage.
export function publicVpsUsageReviewOf(t) {
  const evidence = usageReviewEvidence(t);
  return evidence ? { required: true, reason: 'provider_usage_unverified', since: evidence.since, recordedAt: evidence.recordedAt } : null;
}
export function holdVpsUsageForReview(t, persist, { now = Date.now() } = {}) {
  const v = t.vps || {}, evidence = usageReviewEvidence(t);
  if (!evidence) return false;
  if (evidence.persisted?.version === 1 && evidence.persisted.binding === usageBinding(v) && evidence.persisted.required === true) return true;
  const had = Object.hasOwn(v, 'usageReview'), before = had ? structuredClone(v.usageReview) : undefined;
  try {
    v.usageReview = { version: 1, instanceId: v.instanceId, startedAt: v.startedAt || null, binding: usageBinding(v),
      required: true, reason: 'provider_usage_unverified', uncertainFrom: evidence.since || new Date(now).toISOString(),
      recordedAt: new Date(now).toISOString() };
    persist();
  } catch (error) {
    if (had) v.usageReview = before; else delete v.usageReview;
    throw error;
  }
  return true;
}
export function assertVpsUsageDispatchAllowed(t, persist, options) {
  if (holdVpsUsageForReview(t, persist, options))
    throw Object.assign(new Error('VPS usage interval requires review; no new hourly payment was dispatched'), { status: 409, code: 'vps_usage_review_required' });
}

export function vpsBillingDecision(t, result, { now = Date.now(), attemptedAt, instanceId, startedAt, hourlyMicros } = {}) {
  const v = t.vps || {}, tr = t.treasury || {};
  const bind = JSON.stringify([instanceId, startedAt, hourlyMicros]);
  const prior = v.billingGuard;
  const record = (reason, extras = {}) => {
    const guard = { version: 1, instanceId, binding: bind, reason, checkedAt: new Date(now).toISOString(), observations: 0, ...extras };
    v.billingGuard = guard;
    return { action: 'retry', reason, ...extras };
  };
  if (String(v.instanceId) !== String(instanceId) || v.startedAt !== startedAt || v.hourlyMicros !== hourlyMicros || v.state !== 'running')
    return { action: 'retry', reason: 'instance_changed' };
  if (publicVpsUsageReviewOf(t)) return record('provider_usage_unverified');
  if (result?.paid === true) return record('paid');
  if (result?.pending === true) return record('payment_pending');
  if (result?.paid !== false || !Number.isSafeInteger(hourlyMicros) || hourlyMicros <= 0)
    return record('payment_unavailable');
  const begin = stamp(tr.marketingObservationStartedAt), observed = stamp(tr.marketingObservedAt);
  if (!hasFreshMarketingObservation(t, now) || !Number.isFinite(attemptedAt) || !Number.isFinite(begin) || !Number.isFinite(observed) ||
      begin < attemptedAt || begin > observed || observed > now || now - begin > freshnessMs ||
      !Number.isSafeInteger(tr.micros) || tr.micros < 0)
    return record('balance_unavailable');
  let available;
  try { available = tr.micros - heldUsage(t); } catch { return record('liabilities_unavailable'); }
  if (!Number.isSafeInteger(available)) return record('liabilities_unavailable');
  if (available >= hourlyMicros) return record('payment_blocked');
  const continuing = prior?.version === 1 && prior.binding === bind &&
    ['insufficient_funds_checking', 'insufficient_funds_confirmed'].includes(prior.reason) &&
    Number.isSafeInteger(prior.observations) && prior.observations >= 1 && prior.observations <= 2 &&
    Number.isFinite(stamp(prior.firstObservedAt)) && Number.isFinite(stamp(prior.lastObservedAt)) &&
    stamp(prior.firstObservedAt) <= stamp(prior.lastObservedAt) &&
    (prior.observations === 1 || stamp(prior.lastObservedAt) - stamp(prior.firstObservedAt) >= sampleGapMs) &&
    stamp(prior.lastObservedAt) <= begin && now - stamp(prior.lastObservedAt) <= 180_000;
  const spaced = continuing && begin - stamp(prior.lastObservedAt) >= sampleGapMs;
  const observations = continuing ? Math.min(2, (prior.observations || 1) + (spaced ? 1 : 0)) : 1;
  const firstObservedAt = continuing ? prior.firstObservedAt : new Date(begin).toISOString();
  const lastObservedAt = continuing && !spaced ? prior.lastObservedAt : new Date(begin).toISOString();
  const reason = observations >= 2 ? 'insufficient_funds_confirmed' : 'insufficient_funds_checking';
  const out = record(reason, { observations, firstObservedAt, lastObservedAt, availableMicros: available, requiredMicros: hourlyMicros });
  if (observations >= 2) out.action = 'stop';
  return out;
}
