// No wallet access, external API calls, payment or independent chat endpoint.
(() => {
  const base = document.currentScript.src;
  let latest = null, presentation = null, mascot = null;
  function update(token) {
    latest = token;
    if (!presentation) return;
    const state = presentation.kurtState(token);
    document.getElementById('kurtState').textContent = state.label;
    document.getElementById('kurtStatus').dataset.online = String(state.online);
    mascot?.setState(state.mode);
    const reply = presentation.latestReply(token);
    const body = document.getElementById('kurtReply');
    body.textContent = reply?.text || 'The next idea starts with your community. Ask Kurt a question in chat.';
    document.getElementById('kurtReplyLabel').textContent = reply ? 'Latest reply from Kurt' : 'Meet your community companion';
  }
  window.GatewayKurt = Object.freeze({ update });
  Promise.all([import(new URL('./state.mjs', base)), import(new URL('./profile.mjs', base))]).then(([state, { KURT }]) => {
    presentation = state;
    document.getElementById('kurtName').textContent = KURT.name;
    document.getElementById('kurtVoice').textContent = `${KURT.voice.name} · character voice`;
    const root = document.getElementById('kurtScene');
    mascot = window.GatewayMascot({
      root, canvas: document.getElementById('kurtCanvas'), loading: document.getElementById('kurtLoading'),
      audio: document.getElementById('kurtAudio'), gesture: document.getElementById('kurtGreet'),
      explore: document.getElementById('kurtExplore'), happy: document.getElementById('kurtHappy'),
      resetView: document.getElementById('kurtReset'), motion: document.getElementById('kurtMotion'),
    });
    update(latest);
  }).catch(() => {
    document.getElementById('kurtLoading').textContent = 'Kurt’s 3D view is unavailable. Community chat still works.';
    document.getElementById('kurtState').textContent = 'You can still follow the conversation';
  });
})();
