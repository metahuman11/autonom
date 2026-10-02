// Read-only recovery of the ORIGINAL inference request. Never reruns inference,
// infers zero from a 404, or treats a primary charge as proof of collected funds.
// https://docs.nano-gpt.com/api-reference/endpoint/request-billing (2026-09-19)
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY = 86_400_000;
export function nanoRequestId(headers) {
  const id = headers?.get?.('x-request-id');
  return typeof id === 'string' && ID.test(id) ? id : null;
}
export async function lookupNanoRequestCharge({ key, requestId, submittedAt, now = Date.now, fetchImpl = fetch } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  let checkedAt = clock();
  const started = Date.parse(submittedAt);
  if (typeof key !== 'string' || key.length < 8 || /[\r\n]/.test(key) || typeof requestId !== 'string' || !ID.test(requestId) ||
      !Number.isFinite(started) || !Number.isFinite(checkedAt) || started > checkedAt)
    throw new Error('Invalid private request billing binding');
  const deadline = started + DAY;
  if (checkedAt >= deadline) return { state: 'review_required', reason: 'lookup_window_expired' };
  const pending = (delay, reason) => checkedAt + delay >= deadline
    ? { state: 'review_required', reason: 'lookup_window_expired' }
    : { state: 'pending', reason, retryAt: new Date(checkedAt + delay).toISOString() };
  let response;
  try {
    response = await fetchImpl('https://nano-gpt.com/api/v1/usage/requests/' + encodeURIComponent(requestId), {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { checkedAt = clock(); return pending(30_000, 'lookup_unavailable'); }
  checkedAt = clock();
  if (response.redirected) { await response.body?.cancel(); return { state: 'review_required', reason: 'unexpected_response' }; }
  if (response.status !== 200) {
    await response.body?.cancel(); // Never publish the provider's error body.
    if (![404, 429, 503].includes(response.status)) return { state: 'review_required', reason: 'lookup_rejected' };
    const retry = response.headers.get('retry-after');
    // Retry-After starts at receipt, not at dispatch of a slow GET. An enormous
    // numeric value must not overflow and silently become a shorter retry.
    if (retry && /^\d+$/.test(retry) && Number(retry) * 1000 >= deadline - checkedAt)
      return { state: 'review_required', reason: 'lookup_window_expired' };
    const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - checkedAt;
    return pending(Number.isFinite(delay) ? Math.max(30_000, delay) : 30_000, 'charge_not_available');
  }
  try {
    const chunks = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 16_384) throw new Error('limit');
      chunks.push(Buffer.from(part));
    }
    const row = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    checkedAt = clock();
    const created = Date.parse(row.created_at), asOf = Date.parse(row.as_of), expires = Date.parse(row.expires_at);
    if (row.object !== 'request_billing' || row.request_id !== requestId || row.cost_scope !== 'primary_charge' ||
        !['USD', 'XNO'].includes(row.currency) || typeof row.cost !== 'string' || !/^\d{1,80}(?:\.\d{1,40})?$/.test(row.cost) ||
        !Number.isFinite(created) || !Number.isFinite(asOf) || created > asOf || asOf > checkedAt + 60_000 ||
        created < started - 60_000 || expires !== created + DAY || checkedAt >= expires)
      throw new Error('invalid receipt');
    // Preserve decimal precision; rounding a charge into USD micros needs an
    // explicit accounting policy, and XNO requires a separately verified FX rate.
    return { state: 'recorded', requestId, cost: row.cost, currency: row.currency,
      scope: 'primary_charge', collected: false, createdAt: row.created_at, expiresAt: row.expires_at };
  } catch { return { state: 'review_required', reason: 'invalid_charge_record' }; }
}
