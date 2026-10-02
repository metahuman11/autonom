// Saved-reply speech coordinator. One trusted writer, synchronous atomic store
// persistence. No anonymous text-to-speech, network call on playback, secret
// provisioning or default spending. No production binding is installed here.
import { audioType } from '../tools/voice-preview/speech.mjs';
import { reserveUsage, submitUsage, releaseUsage, uncertainUsage, settleUsage } from './usage-budget.mjs';
import { VOICE_POLICY, voiceFail, voiceHash, voiceProjectKey, voiceScope, validateVoiceQuote, voiceDailyMicros } from './voice-policy.mjs';

const inFlight = new Set(); // shared by broker instances in the single writer
const isThenable = value => value && typeof value.then === 'function';
export function createVoiceBroker({ persist, bindingFor = () => null, authorityFor = async () => false, now = Date.now, enabled = false } = {}) {
  if (typeof persist !== 'function') throw new Error('Synchronous durable persistence is required');
  const cache = new Map(); let cacheBytes = 0;
  const binding = t => {
    if (!enabled) return null;
    const b = bindingFor(t);
    return b?.projectKey === voiceProjectKey(t) && b.acceptanceVerified === true && b.fundingApproved === true &&
      typeof b.provider?.quote === 'function' && typeof b.provider?.synthesize === 'function' && typeof b.commitCharge === 'function' ? b : null;
  };
  const status = t => {
    const configured = enabled && bindingFor(t)?.projectKey === voiceProjectKey(t);
    const accepted = configured && bindingFor(t)?.acceptanceVerified === true;
    const funded = configured && bindingFor(t)?.fundingApproved === true;
    const connected = !!binding(t);
    return { provider: VOICE_POLICY.provider, name: VOICE_POLICY.name, model: VOICE_POLICY.model,
      configured: !!configured, accepted: !!accepted, fundingApproved: !!funded, enabled: connected,
      status: !configured ? 'not_configured' : !funded ? 'funding_approval_required' : !accepted ? 'acceptance_required' : connected ? 'ready' : 'payment_not_connected', streaming: false,
      generation: 'once_per_saved_reply', playbackConsentRequired: true };
  };
  function durable(t, mutate) {
    // The trusted charge adapter may maintain additional token-local accounting
    // fields. Restore the complete token on a failed commit, preserving its root
    // identity. Adapter must not mutate any other token/store or cause I/O.
    const before = structuredClone(t);
    let saving = false;
    try {
      const out = mutate();
      if (isThenable(out)) throw new Error('async mutation is not supported');
      saving = true;
      if (isThenable(persist())) throw new Error('async persistence is not supported');
      return out;
    } catch (error) {
      for (const k of Object.keys(t)) delete t[k];
      Object.assign(t, before);
      // Policy/budget rejection before persistence is not a disk failure. A
      // post-submission error is redacted by generate regardless of this branch.
      if (!saving && Number.isInteger(error?.status)) throw error;
      throw voiceFail(503, 'Voice accounting could not be saved; stop and reconcile before another attempt');
    }
  }
  function drop(key) { const row = cache.get(key); if (row) { cacheBytes -= row.bytes.length; cache.delete(key); } }
  const cacheKey = (t, replyId) => `${voiceProjectKey(t)}:${replyId}`;
  function cached(t, scope, metadataOnly = false) {
    const key = cacheKey(t, scope.replyId), row = cache.get(key), record = t.voiceRecords?.[scope.replyId];
    if (!row) return null;
    if (row.expiresAt <= now() || row.fingerprint !== scope.fingerprint || record?.state !== 'ready' || record.audioHash !== voiceHash(row.bytes)) { drop(key); return null; }
    return metadataOnly ? { replyId: scope.replyId, state: 'ready', cached: true } : { bytes: Buffer.from(row.bytes), type: row.type };
  }
  function keep(t, scope, audio) {
    const key = cacheKey(t, scope.replyId); drop(key);
    for (const [id, row] of cache) if (row.expiresAt <= now()) drop(id);
    while (cache.size >= VOICE_POLICY.maxCacheEntries || cacheBytes + audio.bytes.length > VOICE_POLICY.maxCacheBytes) drop(cache.keys().next().value);
    cache.set(key, { ...audio, bytes: Buffer.from(audio.bytes), fingerprint: scope.fingerprint, expiresAt: now() + VOICE_POLICY.cacheTtlMs });
    cacheBytes += audio.bytes.length;
  }
  const view = (r, cachePresent = false) => ({ replyId: r.replyId, state: r.state, cached: cachePresent,
    name: VOICE_POLICY.name, ...(r.actualMicros == null ? {} : { costMicros: r.actualMicros }) });
  async function generate(t, body, { contextValid = () => true } = {}) {
    const scope = voiceScope(t, body, now()), key = scope.projectKey;
    const b = binding(t);
    if (!b) throw voiceFail(503, 'Dennis voice billing is not connected; no speech was purchased');
    if (inFlight.has(key)) throw voiceFail(409, 'A voice request is already in progress');
    if (inFlight.size >= VOICE_POLICY.maxConcurrent) throw voiceFail(429, 'Speech capacity is busy; no request was submitted');
    inFlight.add(key);
    let reservation = false, submitted = false;
    try {
      const verify = async () => {
        if (await authorityFor(t, scope) !== true) throw voiceFail(403, 'Current holder and voice spending authority is required');
        if (contextValid() !== true) throw voiceFail(401, 'Agent session is no longer valid for speech');
        if (binding(t) !== b || voiceScope(t, body, now()).fingerprint !== scope.fingerprint)
          throw voiceFail(403, 'Voice authority or saved reply changed');
      };
      await verify();
      const existing = t.voiceRecords?.[scope.replyId];
      if (existing) {
        if (existing.fingerprint !== scope.fingerprint) throw voiceFail(409, 'This saved reply changed after voice submission; no replacement charge');
        return view(existing, !!cached(t, scope));
      }
      const quote = await b.provider.quote(scope.request);
      await verify(); validateVoiceQuote(quote, scope, now());
      if (voiceDailyMicros(t, now()) + quote.limitMicros > VOICE_POLICY.maxDailyMicros) throw voiceFail(402, 'Project daily voice ceiling reached');
      durable(t, () => {
        reserveUsage(t, { id: scope.id, holder: scope.holder, limitMicros: quote.limitMicros, kind: 'voice', fingerprint: scope.fingerprint });
        t.usageReservations[scope.id].createdAt = new Date(now()).toISOString();
        (t.voiceRecords ||= {})[scope.replyId] = { replyId: scope.replyId, messageId: scope.messageId, fingerprint: scope.fingerprint,
          requestHash: scope.requestHash, state: 'reserved', quoteId: quote.quoteId, limitMicros: quote.limitMicros, createdAt: new Date(now()).toISOString() };
      });
      reservation = true;
      await verify(); validateVoiceQuote(quote, scope, now());
      durable(t, () => { submitUsage(t, scope.id); t.voiceRecords[scope.replyId].state = 'submitted'; });
      submitted = true;
      const { audio, receipt } = await b.provider.synthesize(scope.request, quote);
      if (!Buffer.isBuffer(audio?.bytes) || !audio.bytes.length || audio.bytes.length > VOICE_POLICY.maxAudioBytes || audioType(audio.bytes) !== audio.type)
        throw voiceFail(502, 'Invalid speech audio');
      if (receipt?.verified !== true || receipt.projectKey !== scope.projectKey || receipt.requestHash !== scope.requestHash ||
          receipt.quoteId !== quote.quoteId || !Number.isSafeInteger(receipt.actualMicros) || receipt.actualMicros < 0 || receipt.actualMicros > quote.limitMicros ||
          typeof receipt.reference !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.reference))
        throw voiceFail(502, 'Speech charge has not been verified');
      // Charge settlement must finish even if the holder revoked while the paid
      // provider was working. Revocation prevents playback, not a fake refund.
      durable(t, () => {
        const result = b.commitCharge(t, { ...receipt, holder: scope.holder, replyId: scope.replyId });
        if (isThenable(result)) throw new Error('Charge accounting must be synchronous');
        settleUsage(t, scope.id, receipt.actualMicros);
        Object.assign(t.voiceRecords[scope.replyId], { state: 'ready', actualMicros: receipt.actualMicros,
          paymentReference: receipt.reference, audioHash: voiceHash(audio.bytes), contentType: audio.type, byteLength: audio.bytes.length });
      });
      keep(t, scope, audio);
      return view(t.voiceRecords[scope.replyId], true);
    } catch (e) {
      if (reservation && !['settled', 'released'].includes(t.usageReservations?.[scope.id]?.state)) {
        durable(t, () => {
          if (submitted) uncertainUsage(t, scope.id); else releaseUsage(t, scope.id);
          t.voiceRecords[scope.replyId].state = submitted ? 'review_required' : 'cancelled';
        });
      }
      // Never expose provider exception bodies, keys, hostnames or account URLs.
      if (submitted) throw voiceFail(502, 'Speech delivery or payment needs review; no automatic paid retry');
      throw e;
    } finally { inFlight.delete(key); }
  }
  // A playback GET may call this only. It cannot generate or spend money.
  function audio(t, replyId) { return cached(t, voiceScope(t, { replyId }, now())); }
  function playback(t, replyId) {
    try { return cached(t, voiceScope(t, { replyId }, now()), true); }
    catch { return null; } // Stale/revoked/malformed replies must not break a page.
  }
  return Object.freeze({ status, generate, audio, playback });
}
