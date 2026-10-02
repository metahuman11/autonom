// Private, same-project recovery of a previously submitted speech request.
// This is a real read-only billing transport, NOT a payment maximum or settlement
// adapter. A recorded primary charge must never become a verified/collected receipt.
// https://docs.nano-gpt.com/api-reference/endpoint/request-billing (2026-09-20)
import { lookupNanoRequestCharge } from './nano-request-billing.mjs';
import { VOICE_POLICY, voiceFail, voiceHash } from './voice-policy.mjs';

const PROJECT = /^[a-z0-9_-]{1,32}:0x[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const QUOTE = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const thenable = value => value && typeof value.then === 'function';

/** journal belongs to the private durable store, never the public token DTO.
 * persist must synchronously commit durably. The provider's beforeSubmission and
 * captureRequest hooks can use these methods; reconcile only performs GETs.
 * No credential loading, speech generation, funding, wallet debit or timer here.
 */
export function createVoiceChargeRecovery({ projectKey, key, journal, persist, now = Date.now, fetchImpl = fetch } = {}) {
  if (!PROJECT.test(projectKey || '') || typeof key !== 'string' || key.length < 8 || /[\r\n]/.test(key) ||
      !journal || typeof journal !== 'object' || Array.isArray(journal) || typeof persist !== 'function')
    throw voiceFail(503, 'Private speech billing recovery is not configured');
  const keyDigest = voiceHash(key), lookups = new Map();
  function bound() {
    if (journal.version !== 1 || journal.projectKey !== projectKey || journal.keyDigest !== keyDigest ||
        !journal.attempts || typeof journal.attempts !== 'object' || Array.isArray(journal.attempts))
      throw voiceFail(409, 'Speech billing recovery binding changed; use the original project and key');
  }
  function durable(mutate) {
    const before = structuredClone(journal);
    try {
      mutate();
      if (thenable(persist())) throw new Error('asynchronous persistence');
    } catch {
      for (const k of Object.keys(journal)) delete journal[k];
      Object.assign(journal, before);
      throw voiceFail(503, 'Speech billing recovery could not be saved');
    }
  }
  if (Object.keys(journal).length === 0) {
    durable(() => Object.assign(journal, { version: 1, projectKey, keyDigest, attempts: {} }));
  }
  bound();
  function attempt(quoteId, requestHash) {
    bound();
    const row = QUOTE.test(quoteId || '') && Object.hasOwn(journal.attempts, quoteId) ? journal.attempts[quoteId] : null;
    if (!row || row.quoteId !== quoteId || row.projectKey !== projectKey || !HASH.test(row.requestHash || '') ||
        (requestHash !== undefined && row.requestHash !== requestHash) || !Number.isFinite(Date.parse(row.submittedAt)) ||
        !Number.isSafeInteger(row.maximumMicros) || row.maximumMicros <= 0 || row.maximumMicros > VOICE_POLICY.maxCallMicros)
      throw voiceFail(409, 'Speech billing attempt does not match this project and request');
    return row;
  }
  const view = row => ({ quoteId: row.quoteId, state: row.state, requestId: row.requestId || null,
    reason: row.reason || null, retryAt: row.retryAt || null, charge: row.charge ? { ...row.charge } : null,
    collected: false });

  function beforeSubmission(meta) {
    bound();
    if (meta?.projectKey !== projectKey || !HASH.test(meta.requestHash || '') || !QUOTE.test(meta.quoteId || '') ||
        !Number.isSafeInteger(meta.maximumMicros) || meta.maximumMicros <= 0 || meta.maximumMicros > VOICE_POLICY.maxCallMicros)
      throw voiceFail(400, 'A bounded project speech submission is required');
    if (Object.hasOwn(journal.attempts, meta.quoteId)) throw voiceFail(409, 'Speech submission already checkpointed; no paid retry');
    // Own-property definition also safely handles reserved JavaScript property names.
    durable(() => Object.defineProperty(journal.attempts, meta.quoteId, { enumerable: true, configurable: true, writable: true,
      value: { projectKey, requestHash: meta.requestHash, quoteId: meta.quoteId, maximumMicros: meta.maximumMicros,
        submittedAt: new Date(now()).toISOString(), state: 'awaiting_response_identity', requestId: null } }));
  }
  function captureRequest(meta) {
    if (meta?.projectKey !== projectKey || !HASH.test(meta.requestHash || '')) throw voiceFail(409, 'Speech response belongs to another project or request');
    const row = attempt(meta.quoteId, meta.requestHash), at = Date.parse(meta.receivedAt);
    if (!Number.isFinite(at) || at < Date.parse(row.submittedAt) || at > now() + 60_000)
      throw voiceFail(409, 'Speech response time does not match the original attempt');
    if (!REQUEST.test(meta.requestId || '')) {
      durable(() => Object.assign(row, { state: 'review_required', reason: 'missing_response_identity' }));
      throw voiceFail(502, 'Speech response has no recoverable request identity');
    }
    if (row.requestId) {
      if (row.requestId !== meta.requestId) throw voiceFail(409, 'Speech response identity changed');
      return view(row); // Same checkpoint is safe after a transport callback retry.
    }
    if (Object.values(journal.attempts).some(other => other !== row && other.requestId === meta.requestId))
      throw voiceFail(409, 'Speech request identity was reused; billing needs review');
    durable(() => Object.assign(row, { requestId: meta.requestId, receivedAt: meta.receivedAt,
      state: 'awaiting_charge', reason: null, retryAt: new Date(Math.max(now(), at) + 2_000).toISOString() }));
    return view(row);
  }
  async function lookup(quoteId) {
    const row = attempt(quoteId), clock = now();
    if (['recorded_primary_charge', 'review_required'].includes(row.state)) return view(row);
    if (!REQUEST.test(row.requestId || '')) return { ...view(row), reason: 'response_identity_unavailable' };
    if (Number.isFinite(Date.parse(row.retryAt)) && Date.parse(row.retryAt) > clock) return view(row);
    const requestId = row.requestId;
    const result = await lookupNanoRequestCharge({ key, requestId, submittedAt: row.submittedAt, now, fetchImpl });
    // The caller may have reloaded/rebound private state during the GET.
    const current = attempt(quoteId, row.requestHash);
    if (current !== row || current.requestId !== requestId) throw voiceFail(409, 'Speech billing state changed during lookup');
    durable(() => {
      row.checkedAt = new Date(now()).toISOString();
      row.reason = result.reason || null;
      row.retryAt = result.retryAt || null;
      if (result.state === 'recorded') {
        row.state = 'recorded_primary_charge';
        row.charge = { cost: result.cost, currency: result.currency, scope: result.scope,
          createdAt: result.createdAt, expiresAt: result.expiresAt };
      } else row.state = result.state === 'pending' ? 'awaiting_charge' : 'review_required';
    });
    return view(row);
  }
  function reconcile(quoteId) {
    attempt(quoteId);
    if (lookups.has(quoteId)) return lookups.get(quoteId);
    const pending = lookup(quoteId).finally(() => lookups.delete(quoteId));
    lookups.set(quoteId, pending);
    return pending;
  }
  return Object.freeze({ beforeSubmission, captureRequest, reconcile,
    status: quoteId => view(attempt(quoteId)) });
}
