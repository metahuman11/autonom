// Provider observations are evidence, never authority to stop or replace an
// allocation. Recovery only watches the exact instance already being paid for.
import { sanitizeProviderEvidence } from './provider-evidence.mjs';

export const RECOVERY_GRACE_MS = 120_000;
export const RECOVERY_READ_INTERVAL_MS = 30_000;
const reasons = new Set(['provider_conflict', 'provider_stopped', 'provider_offline', 'provider_exited', 'provider_frozen', 'provider_transition', 'provider_unknown', 'provider_unavailable', 'provider_absence_unconfirmed']);
const activeStates = new Set(['running', 'loading', 'created', 'rebooting', 'starting', 'pending']);
const interruptedStates = new Set(['stopped', 'offline', 'exited', 'frozen']);
const count = n => Math.min(9999, Math.max(0, Number.isSafeInteger(n) ? n : 0));
const time = value => { const n = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(n) && n > 0 && n <= 4_102_444_800_000 ? n : null; };

// An unavailable control-plane read is not a report that the paid container
// stopped. Keep this narrower than any generic Error: malformed identities,
// missing configuration and unconfirmed absence still require investigation.
const transientReadError = error => {
  const status = error?.providerStatus;
  if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  return error?.name === 'TypeError' && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(error?.cause?.code || '');
};

function continuouslyObservedRuntime(t, { now, heartbeatFresh, streamReady, allocation, streamMeasuredAt }) {
  const v = t.vps || {}, c = v.runtimeCapabilities;
  // The caller captures this lifetime before awaiting the provider GET. A fresh
  // heartbeat and live screen must both belong to its current registration.
  if (!allocation || !v.instanceId || allocation.instanceId !== v.instanceId ||
      allocation.startedAt !== v.startedAt || allocation.registeredAt !== v.registeredAt ||
      v.mode !== 'real' || v.state !== 'running' || !['ready', 'live'].includes(v.phase) ||
      v.reconciliationRequired || v.pendingCreate || t.lock?.state === 'paused' ||
      !['starting', 'idle', 'working'].includes(t.agent?.state) || heartbeatFresh !== true || streamReady !== true) return false;
  const start = time(v.startedAt), registration = time(v.registeredAt), heartbeat = time(t.agent?.lastHeartbeatAt);
  const acknowledgment = time(c?.acknowledgedAt), stream = time(streamMeasuredAt);
  const fresh = (at, maxAge) => at != null && at >= registration && at <= now && now - at <= maxAge;
  return start != null && registration != null && registration >= start && registration <= now &&
    c?.version === 1 && c.registration === v.registeredAt &&
    fresh(heartbeat, RECOVERY_GRACE_MS) && fresh(acknowledgment, RECOVERY_GRACE_MS) &&
    fresh(stream, 20_000);
}

export function incidentOrigin(t, observation, now = Date.now()) {
  const v = t.vps, old = v.recovery?.active && v.lastIncident?.instanceId === v.instanceId ? v.lastIncident : null;
  const firstReason = old?.firstReason || old?.reason || observation.reason;
  const firstObservedAt = new Date(time(old?.firstObservedAt) || now).toISOString();
  return { firstObservedAt, firstReason: reasons.has(firstReason) ? firstReason : observation.kind === 'destroyed' ? 'provider_destroyed' : 'provider_unknown',
    firstProviderState: old ? sanitizeProviderEvidence(old.firstProviderState || old.providerState || {},
      { observedAtMs: time(firstObservedAt), source: 'poll' }) : observation.evidence };
}

export function providerObservation(remote, error, now = Date.now()) {
  const evidence = sanitizeProviderEvidence(remote || {}, { observedAtMs: now });
  const absent = error?.providerStatus === 404 || error?.providerInstanceAbsent === true;
  if (error || !remote) return { kind: 'uncertain', reason: absent ? 'provider_absence_unconfirmed' : 'provider_unavailable', evidence,
    ...(error && !absent && transientReadError(error) ? { transportUnavailable: true } : {}) };
  const { state, actualState, intended, nextState } = evidence;
  // Destruction is authoritative only when the exact-instance response does not
  // simultaneously report a running container or an intended active allocation.
  if (state === 'destroyed' && ![actualState, intended, nextState].some(s => activeStates.has(s))) return { kind: 'destroyed', evidence };
  if ((interruptedStates.has(state) || state === 'destroyed') && [actualState, intended, nextState].some(s => activeStates.has(s)))
    return { kind: 'uncertain', reason: 'provider_conflict', evidence };
  for (const s of [state, actualState, intended, nextState]) {
    if (interruptedStates.has(s)) return { kind: 'uncertain', reason: `provider_${s}`, evidence };
  }
  // During a cold allocation the provider can know its startup transition before
  // a container exists to report actual_status. This is bounded startup evidence,
  // not an outage; callers only exempt a never-live boot from recovery review.
  if (activeStates.has(state) && state !== 'running' && (activeStates.has(actualState) || actualState === 'unknown') &&
      ![intended, nextState].includes('destroyed')) return { kind: 'starting', reason: 'provider_transition', evidence };
  if (!activeStates.has(state) || actualState === 'unknown' || [actualState, intended, nextState].includes('destroyed')) return { kind: 'uncertain', reason: 'provider_unknown', evidence };
  if (state === 'running' && (actualState === 'running' || actualState == null) && !['loading', 'created', 'rebooting'].includes(nextState))
    return { kind: 'running', evidence };
  return { kind: 'starting', reason: 'provider_transition', evidence };
}

export function observeRecovery(t, observation, { now = Date.now(), heartbeatFresh = false, streamReady = null, allocation = null, streamMeasuredAt = null } = {}) {
  const v = t.vps, prior = v.recovery?.instanceId === v.instanceId ? v.recovery : null;
  const at = new Date(now).toISOString();
  // Keep the separate providerCheck diagnostic, but do not manufacture an
  // uncertain service interval from an API outage while service is observed.
  // Existing recovery/incident/usage-review records are deliberately untouched.
  if (observation.kind === 'uncertain' && observation.reason === 'provider_unavailable' && observation.transportUnavailable === true &&
      continuouslyObservedRuntime(t, { now, heartbeatFresh, streamReady, allocation, streamMeasuredAt })) return;
  if (observation.kind === 'running') {
    if (!prior?.active) return;
    const spaced = !time(prior.lastRunningAt) || now - time(prior.lastRunningAt) >= RECOVERY_READ_INTERVAL_MS;
    const runningObservations = count(prior.runningObservations) + (spaced ? 1 : 0);
    const runtimeReturned = heartbeatFresh && time(t.agent?.lastHeartbeatAt) >= time(prior.firstObservedAt);
    const recovered = runtimeReturned || runningObservations >= 2;
    v.recovery = { ...prior, active: !recovered, status: recovered ? 'recovered' : 'checking', lastObservedAt: at,
      runningObservations: count(runningObservations), lastRunningAt: spaced ? at : prior.lastRunningAt,
      recoveredAt: recovered ? at : null };
    if (recovered) {
      if (v.lastIncident?.instanceId === v.instanceId) v.lastIncident.resolvedAt = at;
      // One post-recovery startup grace per allocation; later noisy reads cannot
      // perpetually renew a never-booted machine's first-stream deadline.
      v.bootRecoveryGraceUntil ||= now + RECOVERY_GRACE_MS;
    }
    return;
  }
  if (observation.kind === 'starting' && !prior?.active && v.phase === 'booting' && !v.firstStreamAt) return;
  const continuing = prior?.active === true;
  const firstObservedAt = continuing ? prior.firstObservedAt : at;
  const spaced = !continuing || !time(prior.lastCountedAt) || now - time(prior.lastCountedAt) >= RECOVERY_READ_INTERVAL_MS;
  const consecutiveObservations = count(continuing ? prior.consecutiveObservations : 0) + (spaced ? 1 : 0);
  const attention = now - time(firstObservedAt) >= RECOVERY_GRACE_MS && consecutiveObservations >= 3;
  const reason = reasons.has(observation.reason) ? observation.reason : 'provider_unknown';
  const { firstReason, firstProviderState } = incidentOrigin(t, observation, now);
  v.recovery = { instanceId: v.instanceId, active: true, status: attention ? 'attention_required' : 'checking', reason,
    firstObservedAt, lastObservedAt: at, lastCountedAt: spaced ? at : prior.lastCountedAt,
    consecutiveObservations: count(consecutiveObservations), runningObservations: 0, lastRunningAt: null, recoveredAt: null };
  v.lastIncident = { kind: 'provider_observation', instanceId: v.instanceId, startedAt: v.startedAt || null, reason, firstObservedAt, lastObservedAt: at,
    firstReason, firstProviderState, observations: count(consecutiveObservations), providerState: observation.evidence,
    runtime: { heartbeatFresh: heartbeatFresh === true, streamReady: typeof streamReady === 'boolean' ? streamReady : null }, resolvedAt: null };
}

// Public projection deliberately excludes provider messages, addresses, status
// codes, IDs and arbitrary fields, including those from legacy persisted state.
export function publicRecoveryOf(t) {
  const r = t.vps?.recovery;
  if (!r || r.instanceId !== t.vps.instanceId || !['checking', 'attention_required', 'recovered'].includes(r.status)) return null;
  const iso = value => { const n = time(value); return n == null ? null : new Date(n).toISOString(); };
  return { active: r.active === true, status: r.status, reason: reasons.has(r.reason) ? r.reason : 'provider_unknown',
    firstObservedAt: iso(r.firstObservedAt), lastObservedAt: iso(r.lastObservedAt), recoveredAt: iso(r.recoveredAt),
    observations: count(r.consecutiveObservations) };
}
