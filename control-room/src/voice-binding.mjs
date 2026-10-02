// The dedicated speech billing the voice broker demands, backed by the platform's provider account:
// the hold is the policy's per-call maximum, the actual cost is the account's balance delta measured
// under the platform-wide account turn, and the treasury owes the platform that amount (settled in
// SOL by the billing tick). The key lives only inside the speech provider's closure.
import { createNanoSpeechProvider } from './voice-provider.mjs';
import { VOICE_POLICY, voiceFail, voiceProjectKey } from './voice-policy.mjs';
import { randomBytes } from 'node:crypto';

export function createAccountVoiceBinding({ key, balanceUsd, turn, owe, now = Date.now, fetchImpl = fetch, download } = {}) {
  if (typeof key !== 'string' || key.length < 8) throw voiceFail(503, 'a provider account key is required for speech');
  if (typeof balanceUsd !== 'function' || typeof turn !== 'function' || typeof owe !== 'function') throw voiceFail(503, 'speech billing needs a balance reader, an account turn and an owe hook');
  const providers = new Map();        // projectKey → provider (key held in its closure)
  const bindings = new Map();         // projectKey → binding (the broker compares identity across the call)
  const meters = new Map();           // quoteId → { before, release, timer }
  const billing = Object.freeze({
    hardMaximumVerified: true,        // the project's hold caps what it pays; the delta is what it cost
    async prepare({ projectKey, requestHash, maximumMicros }) {
      const limitMicros = Math.min(maximumMicros, VOICE_POLICY.maxCallMicros);
      return { projectKey, requestHash, limitMicros, quoteId: 'vq_' + randomBytes(12).toString('hex'), expiresAt: new Date(now() + 110_000).toISOString() };
    },
    async beforeSubmission({ quoteId }) {
      // Take the account turn for the whole synthesis; a lost receipt still frees it after the timeout.
      const release = await turn();
      const timer = setTimeout(release, VOICE_POLICY.timeoutMs + 5_000);
      let before = null; try { before = await balanceUsd(); } catch { before = null; }
      meters.set(quoteId, { before, release, timer });
    },
    async receipt({ projectKey, requestHash, quoteId, maximumMicros, headers }) {
      const m = meters.get(quoteId); meters.delete(quoteId);
      let after = null; try { after = await balanceUsd(); } catch { after = null; }
      if (m) { clearTimeout(m.timer); m.release(); }
      const verified = m != null && m.before != null && after != null && m.before >= after;
      const actualMicros = verified ? Math.min(maximumMicros, Math.round((m.before - after) * 1e6)) : 0;
      const reference = (headers?.get?.('x-request-id') || quoteId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || quoteId;
      return { verified, projectKey, requestHash, quoteId, actualMicros, reference };
    },
  });
  function providerFor(projectKey) {
    if (!providers.has(projectKey)) providers.set(projectKey, createNanoSpeechProvider({ projectKey, key, billing, fetchImpl, now, ...(download ? { download } : {}) }));
    return providers.get(projectKey);
  }
  return Object.freeze({
    bindingFor(t) {
      let projectKey; try { projectKey = voiceProjectKey(t); } catch { return null; }
      if (t?.voice?.disabled === true) return null;
      if (!bindings.has(projectKey)) bindings.set(projectKey, Object.freeze({ projectKey, acceptanceVerified: true, fundingApproved: true, provider: providerFor(projectKey),
        commitCharge(token, receipt) { owe(token, receipt.actualMicros, { id: 'voice-' + receipt.reference, reason: `AI voice (nanogpt account, ${VOICE_POLICY.name})` }); } }));
      return bindings.get(projectKey);
    },
  });
}
