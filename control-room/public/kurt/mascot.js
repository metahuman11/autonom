// Public WebGL companion. Analyse an existing audio element, never a microphone.
const gatewayWolfModule = new URL('./wolf-scene.mjs', document.currentScript.src).href;
window.GatewayMascot = function ({ root, canvas, loading, audio, gesture, explore, happy, resetView, motion }) {
  let mode = 'idle', scene, context, analyser, samples, linked = false, disabled = false, closed = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function readAmplitude() {
    if (mode !== 'speaking' || audio.paused || audio.ended || audio.seeking || !analyser || context.state !== 'running') return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += ((value - 128) / 128) ** 2;
    return Math.sqrt(sum / samples.length);
  }
  function applyMotion() {
    const enabled = !disabled && !reduced.matches;
    motion.setAttribute('aria-pressed', String(enabled));
    motion.disabled = reduced.matches || !scene;
    gesture.disabled = explore.disabled = happy.disabled = !enabled || !scene;
    resetView.disabled = !scene;
    motion.textContent = reduced.matches ? 'Reduced motion' : disabled ? 'Enable motion' : 'Pause motion';
    scene?.setMotion(enabled);
  }
  async function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      context ||= new Ctx();
      await context.resume();
      if (!linked && context.state === 'running') {
        const source = context.createMediaElementSource(audio);
        // Direct output is connected first so analysis cannot mute playback.
        source.connect(context.destination); linked = true;
        analyser = context.createAnalyser(); analyser.fftSize = 256;
        samples = new Uint8Array(analyser.fftSize); source.connect(analyser);
      }
    } catch { /* Native playback remains available if analysis cannot start. */ }
  }
  gesture.addEventListener('click', () => scene?.greet());
  explore.addEventListener('click', () => scene?.explore());
  happy.addEventListener('click', () => scene?.celebrate());
  resetView.addEventListener('click', () => scene?.resetView());
  motion.addEventListener('click', () => { disabled = !disabled; applyMotion(); });
  reduced.addEventListener('change', applyMotion);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // Preserve the scene when restoring Back/Forward.
    closed = true; scene?.dispose(); context?.close().catch(() => {});
    reduced.removeEventListener('change', applyMotion);
  });
  applyMotion();
  import(gatewayWolfModule).then(async ({ createWolfScene }) => {
    if (closed) return;
    scene = await createWolfScene({ canvas, root, loading, readAmplitude });
    if (closed) { scene.dispose(); return; }
    root.dataset.renderer = 'webgl'; scene.setState(mode); applyMotion();
  }).catch(() => {
    root.dataset.renderer = 'unavailable'; loading.hidden = false;
    loading.textContent = 'The 3D wolf could not load. Try refreshing with graphics acceleration enabled. Community chat still works.';
    gesture.disabled = explore.disabled = happy.disabled = resetView.disabled = motion.disabled = true;
  });
  return { unlockAudio, setState(next) { mode = next; root.dataset.state = next; scene?.setState(next); } };
};
