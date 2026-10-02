// Manual playback of server-verified cached replies. No generation, wallet,
// provider, billing request, microphone or browser speech synthesis.
globalThis.GatewayVoicePlayer = function ({ token, audio, notice, container, document }) {
  if (!/^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token)) throw new Error('Invalid voice project');
  let allowed = new Set(), current = null, version = 0;
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const labels = {
    not_configured: 'Voice is not connected yet. Text replies remain available.',
    funding_approval_required: 'Voice is waiting for its funding source.',
    acceptance_required: 'Voice setup is being verified.',
    payment_not_connected: 'Voice payment setup is not complete.',
    agent_unavailable: 'Voice is waiting for the agent to reconnect.',
  };
  function stop() {
    version++; current = null;
    audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true;
  }
  function render(t) {
    if (String(t?.address).toLowerCase() !== token.toLowerCase()) { allowed.clear(); stop(); return; }
    const v = t.runtime?.voice, online = t.runtime?.online === true;
    allowed = new Set(online ? (t.messages || []).filter(m => !m.cancelledAt && !m.revokedAt &&
      validId(m.reply?.id) && m.reply.voice?.replyId === m.reply.id &&
      m.reply.voice.state === 'ready' && m.reply.voice.cached === true).map(m => m.reply.id) : []);
    if (current && !allowed.has(current)) stop();
    const ready = online && v?.available === true && v?.status === 'ready';
    if (!current) notice.textContent = ready
      ? 'Dennis voice · tap Listen on a ready reply. Replaying a saved clip does not generate new speech.'
      : labels[v?.status] || 'Voice is not connected yet. Text replies remain available.';
  }
  function button(reply) {
    return allowed.has(reply?.id)
      ? `<button type="button" class="btn sm voice-listen" data-voice-reply="${reply.id}" aria-label="Listen to Kurt’s saved reply">Listen</button>` : '';
  }
  async function play(replyId) {
    if (document.hidden || !allowed.has(replyId)) return false;
    stop(); const epoch = version; current = replyId;
    audio.hidden = false;
    audio.src = `/api/site/token/${token}/voice/${replyId}`;
    notice.textContent = 'Loading Dennis’s saved reply…';
    try {
      await audio.play();
      if (version !== epoch) return false;
      notice.textContent = 'Dennis · saved voice reply';
      return true;
    } catch {
      if (version === epoch) {
        stop(); notice.textContent = 'This saved clip is unavailable. Text is still here; no new speech was requested.';
      }
      return false;
    }
  }
  container.addEventListener('click', event => {
    const button = event.target.closest?.('[data-voice-reply]');
    if (button && container.contains(button)) void play(button.dataset.voiceReply);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  audio.addEventListener('error', () => {
    if (current) { stop(); notice.textContent = 'Saved audio could not be loaded. No new speech was requested.'; }
  });
  return Object.freeze({ render, button, play, stop });
};

if (typeof document !== 'undefined') {
  const audio = document.getElementById('replyAudio');
  const notice = document.getElementById('voiceNotice');
  const container = document.getElementById('msgs');
  const raw = location.pathname.split('/').pop(); const token = /^0x/i.test(raw) ? raw.toLowerCase() : raw;   // an EVM address is case-insensitive; a Solana mint is not
  if (audio && notice && container && /^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token)) {
    globalThis.GatewayVoice = GatewayVoicePlayer({ token, audio, notice, container, document });
    globalThis.addEventListener('pagehide', () => GatewayVoice.stop());
  }
}
