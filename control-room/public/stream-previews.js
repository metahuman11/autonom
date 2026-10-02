// Public, muted HLS previews only. Never starts a broadcast, a WebRTC session or a viewer beacon.
const MAX_PREVIEWS = 2;
const STARTUP_TIMEOUT = 12000;
const entries = new Map();
const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let observer = null;
let suspended = false;
let reconciling = false;
let reconcileAgain = false;

function label(entry, key, fallback) { return entry.el.dataset[key] || fallback; }
function show(entry, state) {
  entry.state = state;
  entry.el.dataset.previewState = state;
  entry.el.classList.toggle('preview-playing', state === 'playing');
  const status = entry.el.querySelector('.preview-state');
  if (status) status.textContent = state === 'unavailable' ? label(entry, 'previewUnavailable', 'Preview unavailable · Open room')
    : state === 'paused' ? label(entry, 'previewPaused', 'Preview paused')
    : state === 'idle' ? label(entry, 'previewPlay', 'Play muted preview') : label(entry, 'previewLoading', 'Connecting to stream…');
  const caption = entry.el.querySelector('.card-preview-caption');
  if (caption) caption.textContent = label(entry, 'previewMuted', 'Muted preview');
  const button = entry.el.querySelector('[data-preview-toggle]');
  if (button) {
    const active = state === 'loading' || state === 'playing';
    const title = active ? label(entry, 'previewPause', 'Pause preview') : label(entry, 'previewPlay', 'Play muted preview');
    button.setAttribute('aria-label', title); button.title = title;
    button.setAttribute('aria-pressed', String(active));
  }
}
function dispose(entry) {
  // Invalidate callbacks before destroy/pause, including delayed play() rejections.
  entry.generation++;
  clearTimeout(entry.deadline); entry.deadline = null;
  const video = entry.video; entry.video = null;
  entry.hls?.destroy(); entry.hls = null;
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
  entry.el.classList.remove('preview-playing');
}
function start(entry) {
  const video = document.createElement('video');
  const generation = ++entry.generation;
  entry.video = video;
  video.className = 'card-preview-video';
  video.muted = true; video.defaultMuted = true; video.autoplay = true; video.playsInline = true;
  video.preload = 'none'; video.controls = false; video.disablePictureInPicture = true; video.disableRemotePlayback = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('aria-hidden', 'true'); video.tabIndex = -1;
  const current = () => entry.el.isConnected !== false && entries.get(entry.el) === entry && entry.video === video && generation === entry.generation;
  const fail = () => { if (!current()) return; entry.failed = true; dispose(entry); show(entry, 'unavailable'); reconcile(); };
  const play = () => {
    if (!current()) return;
    try {
      video.play()?.catch(error => {
        if (!current()) return;
        if (error?.name === 'NotAllowedError') { entry.userPaused = true; dispose(entry); show(entry, 'paused'); reconcile(); }
        else fail();
      });
    } catch { fail(); }
  };
  video.addEventListener('playing', () => { if (current()) { clearTimeout(entry.deadline); entry.deadline = null; show(entry, 'playing'); } });
  video.addEventListener('error', fail, { once: true });
  video.addEventListener('waiting', () => { if (current() && !entry.deadline) { show(entry, 'loading'); entry.deadline = setTimeout(fail, STARTUP_TIMEOUT); } });
  entry.el.prepend(video);
  show(entry, 'loading');
  entry.deadline = setTimeout(fail, STARTUP_TIMEOUT);
  const src = '/hls/live/' + entry.address + '/index.m3u8';
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src; play();
  } else if (window.Hls?.isSupported()) {
    try {
      const hls = entry.hls = new window.Hls({ maxBufferLength: 3, maxMaxBufferLength: 6, backBufferLength: 0, maxBufferSize: 2000000, capLevelToPlayerSize: true, startLevel: 0, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 1 });
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => { if (current()) hls.loadSource(src); });
      hls.on(window.Hls.Events.MANIFEST_PARSED, play);
      hls.on(window.Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
      hls.attachMedia(video);
    } catch { fail(); }
  } else fail();
}
function reconcile() {
  if (reconciling) { reconcileAgain = true; return; }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      const selected = new Set();
      for (const entry of entries.values()) {
        const wantsPlay = !entry.userPaused && (!motion?.matches || entry.manual);
        const eligible = entry.el.isConnected !== false && !suspended && !document.hidden && entry.visible && !entry.failed && wantsPlay;
        if (eligible && selected.size < MAX_PREVIEWS) selected.add(entry);
        else {
          if (entry.video) dispose(entry);
          show(entry, entry.failed ? 'unavailable' : !wantsPlay ? 'paused' : 'idle');
        }
      }
      // Release every displaced player before allocating its replacement.
      for (const entry of selected) {
        if (!entry.video) start(entry);
        else show(entry, entry.state);
      }
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}
function observe() {
  if (observer || !('IntersectionObserver' in window)) return;
  const created = new IntersectionObserver(items => {
    if (observer !== created) return;
    for (const item of items) { const entry = entries.get(item.target); if (entry) entry.visible = item.isIntersecting && item.intersectionRatio >= .35; }
    reconcile();
  }, { threshold: [0, .35] });
  observer = created;
}
export function stopStreamPreviews() {
  observer?.disconnect(); observer = null;
  for (const entry of entries.values()) { dispose(entry); entry.button?.removeEventListener('click', entry.toggle); show(entry, 'idle'); }
  entries.clear();
}
export function syncStreamPreviews(root) {
  const targets = new Set(root.querySelectorAll('[data-stream]'));
  for (const [el, entry] of entries) if (!targets.has(el) || el.dataset.stream !== entry.address) {
    observer?.unobserve(el); dispose(entry); entry.button?.removeEventListener('click', entry.toggle); entries.delete(el);
  }
  observe();
  for (const el of targets) {
    const address = el.dataset.stream;
    if (!/^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(address)) continue;
    if (entries.has(el)) continue;
    const entry = { el, address, visible: !observer, video: null, hls: null, failed: false, generation: 0, deadline: null, manual: false, userPaused: false, state: 'idle' };
    entry.button = el.querySelector('[data-preview-toggle]');
    entry.toggle = event => {
      event.preventDefault(); event.stopPropagation();
      const running = !!entry.video;
      entry.userPaused = running; entry.manual = !running; entry.failed = false;
      if (running) dispose(entry);
      // A deliberate play click gets priority over an automatically playing card.
      if (!running) { const ordered = [entry, ...[...entries.values()].filter(item => item !== entry)]; entries.clear(); for (const item of ordered) entries.set(item.el, item); }
      reconcile();
    };
    entry.button?.addEventListener('click', entry.toggle);
    entries.set(el, entry); observer?.observe(el);
  }
  reconcile();
}
document.addEventListener('visibilitychange', reconcile);
window.addEventListener('pagehide', () => { suspended = true; reconcile(); });
window.addEventListener('pageshow', () => { suspended = false; reconcile(); });
motion?.addEventListener?.('change', () => {
  if (motion.matches) for (const entry of entries.values()) entry.manual = false;
  reconcile();
});
