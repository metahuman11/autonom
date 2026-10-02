// Pure speech policy. No credentials, wallet, environment or provider access.
import { createHash } from 'node:crypto';
import { requirePublicText } from './public-safety.mjs';
import { speechRequest } from '../tools/voice-preview/voices.mjs';

export const VOICE_POLICY = Object.freeze({
  version: 1, provider: 'NanoGPT', name: 'Dennis', model: 'inworld/realtime-tts-2',
  maxTextChars: 900, maxSourceChars: 2000, maxAudioBytes: 6_000_000,
  maxCallMicros: 100_000, maxDailyMicros: 5_000_000, timeoutMs: 45_000, maxConcurrent: 4,
  maxCacheBytes: 24_000_000, maxCacheEntries: 32, cacheTtlMs: 3_600_000,
});
export const voiceFail = (status, message) => Object.assign(new Error(message), { status });
export const voiceHash = value => createHash('sha256').update(value).digest('hex');
// EVM addresses are case-insensitive and travel lowercased; a base58 Solana mint or wallet keeps its case.
const EVM = /^0x[0-9a-fA-F]{40}$/, BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const voiceIdentity = (v) => (EVM.test(v) ? v.toLowerCase() : BASE58.test(v) ? v : null);
export function voiceProjectKey(t) {
  const id = voiceIdentity(String(t?.address || ''));
  if (!t || typeof t.chain !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(t.chain) || !id)
    throw voiceFail(400, 'Voice requires a supported project identity');
  return `${t.chain}:${id}`;
}
export function voiceRequest(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > VOICE_POLICY.maxSourceChars)
    throw voiceFail(400, 'A bounded saved reply is required for speech');
  requirePublicText(text);
  // No model-authored provider direction or SSML. Dennis is fixed, not selected
  // by token metadata, the prompt, request body or a viewer's browser settings.
  const plain = text.replace(/<[^>]*>/g, '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) throw voiceFail(400, 'The saved reply contains no speakable text');
  const spoken = Array.from(plain).slice(0, VOICE_POLICY.maxTextChars).join('');
  // Official NanoGPT docs say Inworld ignores streaming; do not promise it.
  return Object.freeze({ ...speechRequest('wolf-dennis', spoken), stream: false });
}
export function voiceScope(t, body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.replyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.replyId))
    throw voiceFail(400, 'Only a saved replyId may be supplied');
  const projectKey = voiceProjectKey(t);
  const matches = (t.replies || []).filter(r => r.id === body.replyId);
  const reply = matches.length === 1 ? matches[0] : null;
  const messages = (t.messages || []).filter(m => m.id === reply?.messageId);
  const message = messages.length === 1 ? messages[0] : null;
  const age = now - Date.parse(reply?.completedAt || reply?.at);
  if (!reply || !message || message.cancelledAt || message.revokedAt ||
      !['reply', 'result'].includes(reply.stage) || !Number.isFinite(age) || age < -60_000 || age > 7 * 86_400_000 ||
      !voiceIdentity(String(message.holder || '')))
    throw voiceFail(403, 'A current completed holder reply is required');
  const request = voiceRequest(reply.text), holder = voiceIdentity(String(message.holder));
  const fingerprint = voiceHash(JSON.stringify([projectKey, reply.id, message.id, holder, reply.text, request]));
  return { projectKey, replyId: reply.id, messageId: message.id, holder,
    id: `voice:${reply.id}`, fingerprint, request, requestHash: voiceHash(JSON.stringify(request)) };
}
export function validateVoiceQuote(quote, scope, now = Date.now()) {
  if (!quote || quote.projectKey !== scope.projectKey || quote.requestHash !== scope.requestHash ||
      !Number.isSafeInteger(quote.limitMicros) || quote.limitMicros <= 0 || quote.limitMicros > VOICE_POLICY.maxCallMicros ||
      typeof quote.quoteId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(quote.quoteId) ||
      !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now || Date.parse(quote.expiresAt) > now + 120_000)
    throw voiceFail(502, 'A current project-bound speech payment maximum is required');
  return quote;
}
export function voiceDailyMicros(t, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return Object.values(t.usageReservations || {}).filter(r => r.kind === 'voice' &&
    (['reserved', 'submitted', 'uncertain'].includes(r.state) || (r.state === 'settled' && r.createdAt?.startsWith(day))))
    .reduce((sum, r) => {
      const n = r.state === 'settled' ? r.actualMicros : r.limitMicros;
      if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(sum + n)) throw voiceFail(409, 'Voice accounting requires review');
      return sum + n;
    }, 0);
}
