// Fixed-host transport only. No global/preview API key fallback, no environment
// imports, no invented x402 speech rail, no speculative per-character billing.
// Official docs checked 2026-09-18:
// https://docs.nano-gpt.com/api-reference/endpoint/speech
// https://docs.nano-gpt.com/api-reference/miscellaneous/x402
// audio/speech is NOT in the documented stable accountless endpoint matrix.
import { resolveSpeech } from '../tools/voice-preview/speech.mjs';
import { VOICE_POLICY, voiceFail, voiceHash, validateVoiceQuote } from './voice-policy.mjs';
import { nanoRequestId } from './nano-request-billing.mjs';

export const VOICE_ENDPOINT = 'https://nano-gpt.com/api/v1/audio/speech';
/** The trusted billing adapter must hold a HARD maximum in an isolated funded
 * project account before returning a quote, and verify actual provider spending
 * afterward. A price estimate or HTTP 200 is not that adapter. None is supplied
 * by this module; production must remain disabled until payment acceptance.
 * prepare/receipt never receive the API key; it exists only in this closure.
 */
export function createNanoSpeechProvider({ projectKey, key, billing, fetchImpl = fetch, now = Date.now, download } = {}) {
  if (typeof projectKey !== 'string' || typeof key !== 'string' || key.length < 8 || /[\r\n]/.test(key) ||
      billing?.hardMaximumVerified !== true || typeof billing.prepare !== 'function' || typeof billing.receipt !== 'function')
    throw voiceFail(503, 'Dedicated bounded speech billing is not connected');
  const quotes = new WeakMap();
  const hashRequest = request => {
    if (!request || request.model !== VOICE_POLICY.model || request.voice !== VOICE_POLICY.name ||
        request.stream !== false || request.response_format !== 'mp3' || typeof request.input !== 'string' ||
        request.input.length > 2000 || Object.keys(request).sort().join(',') !== 'input,model,response_format,stream,voice')
      throw voiceFail(400, 'Only the fixed Dennis speech request is permitted');
    return voiceHash(JSON.stringify(request));
  };
  return Object.freeze({
    async quote(request) {
      const requestHash = hashRequest(request);
      let q;
      try { q = await billing.prepare({ projectKey, requestHash, request: { ...request }, maximumMicros: VOICE_POLICY.maxCallMicros }); }
      catch { throw voiceFail(503, 'Speech payment maximum is unavailable'); }
      validateVoiceQuote(q, { projectKey, requestHash }, now());
      const quote = Object.freeze({ projectKey, requestHash, limitMicros: q.limitMicros, quoteId: q.quoteId, expiresAt: q.expiresAt });
      quotes.set(quote, { requestHash, consumed: false }); return quote;
    },
    async synthesize(request, quote) {
      const original = quotes.get(quote), requestHash = hashRequest(request);
      if (!original || original.consumed || original.requestHash !== requestHash) throw voiceFail(409, 'Speech quote changed or was already submitted');
      validateVoiceQuote(quote, { projectKey, requestHash }, now());
      original.consumed = true; // Never resubmit a charge, including after timeouts.
      const signal = AbortSignal.timeout(VOICE_POLICY.timeoutMs);
      try {
        // Persist the original attempt before dispatch. The recovery journal is
        // separate from public replies and never contains this credential.
        if (typeof billing.beforeSubmission === 'function') await billing.beforeSubmission({
          projectKey, requestHash, quoteId: quote.quoteId, maximumMicros: quote.limitMicros,
        });
        const response = await fetchImpl(VOICE_ENDPOINT, { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg,application/json' },
          body: JSON.stringify(request) });
        // Persist the server correlation ID BEFORE reading audio. This permits
        // later read-only charge recovery if delivery fails; it is NOT provider
        // idempotency, a billing maximum, or proof speech lookup is supported.
        if (typeof billing.captureRequest === 'function') {
          try {
            await billing.captureRequest({ projectKey, requestHash, quoteId: quote.quoteId,
              requestId: nanoRequestId(response.headers), receivedAt: new Date(now()).toISOString() });
          } catch (error) { await response.body?.cancel(); throw error; }
        }
        if (response.status !== 200 || response.redirected) { await response.body?.cancel(); throw new Error('provider response'); }
        // Reuse the reviewed preview parser: bounded bytes, magic type detection,
        // public pinned DNS for audio URLs, no redirects or credentials to storage.
        // No job polling/fallback generation for another model is authorized.
        const audio = await resolveSpeech(response, { signal, maxPolls: 0, ...(download ? { download } : {}) });
        const receipt = await billing.receipt({ projectKey, requestHash, quoteId: quote.quoteId,
          maximumMicros: quote.limitMicros, headers: response.headers, signal });
        return { audio, receipt };
      } catch {
        // Provider bodies/errors may contain credentials or private account URLs.
        throw voiceFail(502, 'Speech delivery or payment is uncertain; no automatic paid retry');
      }
    },
  });
}
