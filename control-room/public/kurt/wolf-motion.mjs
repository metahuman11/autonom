const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));
export function rms(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  for (const value of bytes) sum += ((value - 128) / 128) ** 2;
  return Math.sqrt(sum / bytes.length);
}
export function wolfPose(time, { mode = 'idle', amplitude = 0, x = 0, y = 0, greeting = false, happy = 0 } = {}) {
  const t = Number.isFinite(time) ? time : 0;
  const speaking = mode === 'speaking';
  const thinking = mode === 'thinking' || mode === 'voicing';
  const mouth = speaking ? clamp((amplitude - .006) * 5.5, 0, .65) : 0;
  const blinkPhase = t % 4.7;
  const joy = clamp(happy, 0, 1);
  return {
    mouth,
    blink: (blinkPhase < .16 ? Math.max(.06, Math.abs(blinkPhase - .08) / .08) : 1) * (1 - joy * .24),
    headTilt: clamp(x, -1, 1) * .1 + (thinking ? .14 + Math.sin(t * 1.3) * .045 : Math.sin(t * .85) * .025) + joy * Math.sin(t * 5) * .055,
    headNod: clamp(y, -1, 1) * .055 + mouth * .11 - joy * .075,
    earLeft: Math.sin(t * 2.4) * .055 + (thinking ? .13 : 0) + joy * .15,
    earRight: Math.sin(t * 2.1 + 1.3) * .06 - (thinking ? .09 : 0) - joy * .15,
    tail: Math.sin(t * (joy ? 12 : greeting ? 11 : speaking ? 7 : 3.6)) * (joy ? .13 + joy * .25 : greeting ? .27 : .13),
  };
}

// A short, bounded celebration: anticipation, three diminishing hops, settle.
export function happyMotion(elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 3.2) return { joy: 0, lift: 0, squash: 1, roll: 0 };
  const fade = Math.min(1, elapsed / .18, (3.2 - elapsed) / .6);
  const hopTime = elapsed - .22;
  const hop = hopTime >= 0 && hopTime < 2.1 ? Math.floor(hopTime / .7) : -1;
  const phase = hop >= 0 ? (hopTime % .7) / .7 : 0;
  const lift = hop >= 0 ? Math.sin(phase * Math.PI) ** 2 * (.24 - hop * .055) : 0;
  const squash = elapsed < .22 ? 1 - Math.sin(elapsed / .22 * Math.PI) * .055 : 1 + lift * .1;
  return { joy: Math.max(0, fade), lift, squash, roll: Math.sin(elapsed * 5) * .024 * fade };
}

export const HOME_VIEW = Object.freeze({ yaw: .54, pitch: .2, radius: 8.9 });
export function orbitDrag(view, dx, dy, width, height, touch = false) {
  const yaw = view.yaw - clamp(dx, -10000, 10000) / Math.max(160, width || 0) * Math.PI * 2;
  const pitch = clamp(view.pitch + (touch ? 0 : clamp(dy, -10000, 10000) / Math.max(160, height || 0) * 1.4), .06, .75);
  return { yaw, pitch, radius: HOME_VIEW.radius };
}

// Single-pointer input. Vertical touch gestures remain available for page scroll.
// Petting/rotating is local-only: this controller never sends a paid request.
export function bindWolfOrbit(canvas, { onChange, onPet, onHover = () => {} }) {
  let view = { ...HOME_VIEW }, pointer = null;
  const notify = () => onChange({ ...view });
  function down(e) {
    if (pointer || e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, distance: 0 };
    canvas.setPointerCapture?.(e.pointerId); canvas.focus?.({ preventScroll: true });
    canvas.classList.add('dragging');
  }
  function move(e) {
    const box = canvas.getBoundingClientRect();
    if (!pointer) { onHover((e.clientX - box.left) / box.width * 2 - 1, (e.clientY - box.top) / box.height * 2 - 1); return; }
    if (pointer.id !== e.pointerId) return;
    pointer.distance = Math.max(pointer.distance, Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY));
    if (pointer.distance > 5) {
      view = orbitDrag(view, e.clientX - pointer.x, e.clientY - pointer.y, box.width, box.height, e.pointerType === 'touch');
      onHover(0, 0); notify();
    }
    pointer.x = e.clientX; pointer.y = e.clientY;
  }
  function finish(e, pet = false) {
    if (!pointer || pointer.id !== e.pointerId) return;
    const wasTap = pet && pointer.distance <= 5;
    pointer = null; canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (wasTap) onPet(e);
  }
  const up = e => finish(e, true), cancel = e => finish(e), leave = () => { if (!pointer) onHover(0, 0); };
  function key(e) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') view = { ...HOME_VIEW };
    else view = { ...view, yaw: view.yaw + (e.key === 'ArrowLeft' ? -.2 : e.key === 'ArrowRight' ? .2 : 0), pitch: clamp(view.pitch + (e.key === 'ArrowUp' ? .08 : e.key === 'ArrowDown' ? -.08 : 0), .06, .75) };
    notify();
  }
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, lostpointercapture: cancel, pointerleave: leave, keydown: key };
  for (const [name, handler] of Object.entries(events)) canvas.addEventListener(name, handler);
  return {
    get view() { return { ...view }; },
    reset() { view = { ...HOME_VIEW }; notify(); },
    dispose() {
      if (pointer) cancel({ pointerId: pointer.id });
      for (const [name, handler] of Object.entries(events)) canvas.removeEventListener(name, handler);
    },
  };
}
