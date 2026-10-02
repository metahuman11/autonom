// Provider responses are untrusted diagnostics, never lifecycle commands. Keep
// this allowlist small: raw responses may contain boot commands and credentials.
const STATES = new Set(['running', 'loading', 'created', 'stopped', 'exited', 'offline', 'destroyed', 'frozen', 'rebooting', 'unknown', 'stopping', 'starting', 'pending', 'unloaded', 'error']);
const SOURCES = new Set(['show-instance', 'poll', 'cleanup', 'reconcile', 'delete-confirmation']);
const MAX_UNIX_SECONDS = 4_102_444_800; // 2100-01-01; reject milliseconds, never guess units.
export const MIN_RENTAL_SECONDS = 2 * 3600 + 20 * 60;

function providerNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function providerUnixSeconds(value) {
  const n = providerNumber(value);
  return n !== null && n > 0 && n <= MAX_UNIX_SECONDS ? n : null;
}
export const providerState = value => typeof value === 'string' && STATES.has(value.toLowerCase()) ? value.toLowerCase() : 'unknown';
export function providerBoolean(value) {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : null;
}
export function sanitizeProviderStatus(value) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 4096)
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)/gi, '[redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:https?|rtmps?|ssh):\/\/[^\s<>]+/gi, '[redacted-url]')
    .replace(/["']?\b(?:authorization|api[_ -]?key|token|secret|password|passwd|private[_ -]?key|boot[_ -]?code|session|stream[_ -]?key)\b["']?\s*(?:[:=]|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 320) : null;
}

// Input is the normalized showInstance result. Only this snapshot belongs in an
// incident: callers must not spread the raw provider response or publish it.
export function sanitizeProviderEvidence(remote = {}, { observedAtMs = Date.now(), source = 'show-instance' } = {}) {
  const ms = typeof observedAtMs === 'number' && Number.isFinite(observedAtMs) && observedAtMs >= 0 && observedAtMs <= MAX_UNIX_SECONDS * 1000 ? observedAtMs : Date.now();
  return {
    state: providerState(remote.state), actualState: providerState(remote.actualState),
    intended: providerState(remote.intended), nextState: providerState(remote.nextState),
    statusMsg: sanitizeProviderStatus(remote.statusMsg), startDate: providerUnixSeconds(remote.startDate),
    endDate: providerUnixSeconds(remote.endDate), isBid: providerBoolean(remote.isBid),
    checkedAt: new Date(ms).toISOString(), source: SOURCES.has(source) ? source : 'unknown',
  };
}

// Vast documents offer duration in seconds and end_date as a Unix timestamp.
// https://docs.vast.ai/api-reference/search/search-offers
// https://docs.vast.ai/host/hosting-overview
// time_remaining has no documented units, so it is never used as a guarantee.
// Missing lifetime data is unknown, not an invented unlimited rental commitment.
export function offerRentalLifetime(raw = {}, { observedAtMs = Date.now() } = {}) {
  const endDate = providerUnixSeconds(raw.end_date);
  const duration = providerNumber(raw.duration);
  const durationSeconds = duration !== null && duration >= 0 && duration <= MAX_UNIX_SECONDS ? duration : null;
  const malformed = (raw.end_date != null && endDate === null) || (raw.duration != null && durationSeconds === null);
  const until = [endDate === null ? null : endDate * 1000, durationSeconds === null ? null : observedAtMs + durationSeconds * 1000].filter(x => x !== null);
  return { endDate, durationSeconds, rentalLifetime: {
    status: malformed ? 'invalid' : until.length ? 'known' : 'unknown',
    observedAtMs, guaranteedUntilMs: malformed || !until.length ? null : Math.min(...until),
  } };
}

export function assertExpectedRentalLifetime(offer, { minRentalSeconds = MIN_RENTAL_SECONDS, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(minRentalSeconds) || minRentalSeconds < MIN_RENTAL_SECONDS)
    throw Object.assign(new Error('invalid VPS minimum rental duration'), { status: 400 });
  const lifetime = offer?.rentalLifetime;
  if (lifetime?.status !== 'known' || !Number.isFinite(lifetime.guaranteedUntilMs) || !Number.isFinite(lifetime.observedAtMs) || lifetime.observedAtMs > nowMs)
    throw Object.assign(new Error('selected VPS offer has no verified rental lifetime; refresh and choose another offer'), { status: 409, code: 'VPS_RENTAL_LIFETIME_UNVERIFIED' });
  if (lifetime.guaranteedUntilMs - nowMs < minRentalSeconds * 1000)
    throw Object.assign(new Error('selected VPS offer expires before startup and two funded runtime hours; choose a longer rental'), { status: 409, code: 'VPS_RENTAL_LIFETIME_TOO_SHORT' });
  return offer;
}
