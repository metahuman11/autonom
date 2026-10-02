import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { prepareWolf } from './wolf-model.mjs';
import { wolfPose, happyMotion, HOME_VIEW, bindWolfOrbit } from './wolf-motion.mjs';

export function wolfSceneVisible(root, page = document) {
  return !page.hidden && !root.closest('[hidden]') && !root.closest('details:not([open])');
}

export function watchWolfDrawers(root, changed) {
  const drawers = [];
  for (let node = root.parentElement; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') {
      node.addEventListener('toggle', changed);
      drawers.push(node);
    }
  }
  return () => { for (const drawer of drawers) drawer.removeEventListener('toggle', changed); };
}

export async function createWolfScene({ canvas, root, loading, readAmplitude }) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  const maxPixelRatio = root.dataset.quality === 'desktop' ? 2 : 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, .1, 50);
  const view = { ...HOME_VIEW }; let targetView = { ...HOME_VIEW };
  const cameraTarget = new THREE.Vector3(0, 1.4, .05);
  function updateCamera(mix = 1) {
    const shortest = Math.atan2(Math.sin(targetView.yaw - view.yaw), Math.cos(targetView.yaw - view.yaw));
    view.yaw += shortest * mix; view.pitch += (targetView.pitch - view.pitch) * mix;
    const flat = Math.cos(view.pitch) * view.radius;
    camera.position.set(Math.sin(view.yaw) * flat, cameraTarget.y + Math.sin(view.pitch) * view.radius, Math.cos(view.yaw) * flat);
    camera.lookAt(cameraTarget);
  }
  updateCamera();
  scene.add(new THREE.HemisphereLight('#f3f8ff', '#bac5cd', 2.3));
  const key = new THREE.DirectionalLight('#fff6e9', 3.1); key.position.set(-3, 7, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.normalBias = .025;
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: .1, far: 20 });
  key.shadow.camera.updateProjectionMatrix(); scene.add(key);
  const rim = new THREE.DirectionalLight('#bedcff', 2); rim.position.set(4, 3, -5); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ color: '#53697c', opacity: .14 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = -.03; scene.add(floor);
  let wolf;
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('./assets/wolf.glb', import.meta.url).href);
    wolf = prepareWolf(gltf); scene.add(wolf.object);
  } catch (e) { renderer.dispose(); throw e; }
  let mode = 'idle', enabled = true, disposed = false, contextLost = false, raf = 0;
  let last = 0, time = 0, gestureEnds = 0, walkEnds = 0, pointerX = 0, pointerY = 0, lookX = 0, lookY = 0;
  let amplitude = 0;
  let happyAt = -Infinity;
  const baseScale = wolf.object.scale.clone(), origin = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  function idleClip() { return mode === 'thinking' || mode === 'voicing' ? 'Idle_2' : 'Idle'; }
  function celebrate() {
    if (!enabled || (time - happyAt < .4)) return;
    walkEnds = gestureEnds = 0; happyAt = time;
    wolf.play('Idle'); root.dataset.mood = 'happy'; draw();
  }
  function render(now) {
    raf = 0;
    if (disposed || contextLost || !wolfSceneVisible(root)) return;
    const dt = last ? Math.min((now - last) / 1000, .045) : 0; last = now;
    if (enabled) {
      time += dt;
      if (gestureEnds && time >= gestureEnds) { gestureEnds = 0; wolf.play(idleClip()); }
      if (walkEnds && time >= walkEnds) { walkEnds = 0; wolf.play(idleClip()); }
      const mix = 1 - Math.exp(-dt * 9);
      lookX += (pointerX - lookX) * mix; lookY += (pointerY - lookY) * mix;
      amplitude += (readAmplitude() - amplitude) * (1 - Math.exp(-dt * 24));
      const joy = happyMotion(time - happyAt);
      if (time - happyAt >= 3.2 && root.dataset.mood === 'happy') root.dataset.mood = mode;
      const pose = wolfPose(time + 1, { mode, amplitude, x: lookX, y: lookY, greeting: !!gestureEnds, happy: joy.joy });
      wolf.animate(dt, pose);
      wolf.object.scale.copy(baseScale).multiply(new THREE.Vector3(1 / Math.sqrt(joy.squash), joy.squash, 1 / Math.sqrt(joy.squash)));
      wolf.object.rotation.z = joy.roll;
      if (walkEnds) {
        const phase = (time - (walkEnds - 5.2)) / 5.2 * Math.PI * 2;
        wolf.object.position.set(Math.sin(phase) * .55, 0, (Math.cos(phase) - 1) * .35);
        wolf.object.rotation.y = phase + Math.PI / 2;
      } else {
        wolf.object.position.lerp(origin, mix); wolf.object.position.y = joy.lift;
        const turn = wolf.object.rotation.y;
        wolf.object.rotation.y += Math.atan2(Math.sin(-turn), Math.cos(-turn)) * mix;
      }
    }
    updateCamera(enabled && dt ? 1 - Math.exp(-dt * 13) : 1);
    renderer.render(scene, camera);
    if (enabled) raf = requestAnimationFrame(render);
  }
  function draw() { if (!raf && !disposed && !contextLost && wolfSceneVisible(root)) { last = 0; raf = requestAnimationFrame(render); } }
  function resize() {
    const { width, height } = root.getBoundingClientRect();
    if (!width || !height) return;
    // Native 2x on the 4K desktop, with a four-megapixel fill-rate ceiling.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio, Math.sqrt(4_000_000 / (width * height))));
    renderer.setSize(width, height, false); camera.aspect = width / height;
    camera.fov = width / height < 1.08 ? 40 : 34; camera.updateProjectionMatrix(); draw();
  }
  const observer = new ResizeObserver(resize); observer.observe(root);
  const orbit = bindWolfOrbit(canvas, {
    onChange(next) { targetView = next; draw(); },
    onHover(x, y) { pointerX = x; pointerY = y; },
    onPet(event) {
      const box = canvas.getBoundingClientRect();
      wolf.object.updateMatrixWorld(true);
      wolf.model.traverse(node => { if (node.isSkinnedMesh) node.computeBoundingSphere(); });
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1), camera);
      if (raycaster.intersectObject(wolf.object, true).some(hit => hit.object.visible)) celebrate();
    },
  });
  const visibility = () => { cancelAnimationFrame(raf); raf = 0; last = 0; if (!document.hidden) draw(); };
  document.addEventListener('visibilitychange', visibility);
  const appVisibility = () => { visibility(); if (wolfSceneVisible(root)) resize(); };
  root.addEventListener('gateway-scene-visibility', appVisibility);
  const unwatchDrawers = watchWolfDrawers(root, appVisibility);
  const lost = e => { e.preventDefault(); contextLost = true; cancelAnimationFrame(raf); raf = 0; loading.textContent = '3D paused · restoring the scene…'; loading.hidden = false; };
  const restored = () => { contextLost = false; loading.hidden = true; resize(); };
  canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
  loading.hidden = true; resize();
  return {
    setState(next) { mode = next; if (!gestureEnds && !walkEnds) wolf.play(idleClip()); draw(); },
    setMotion(on) {
      enabled = on; cancelAnimationFrame(raf); raf = 0;
      if (!on) { gestureEnds = walkEnds = 0; happyAt = -Infinity; root.dataset.mood = mode; wolf.play('Idle'); wolf.animate(0, wolfPose(1)); wolf.jaw.rotation.x = 0; wolf.object.position.copy(origin); wolf.object.rotation.set(0, 0, 0); wolf.object.scale.copy(baseScale); }
      draw();
    },
    greet() { if (!enabled) return; happyAt = -Infinity; walkEnds = 0; gestureEnds = time + 1.5; wolf.play('Jump_ToIdle', true); draw(); },
    explore() { if (!enabled) return; happyAt = -Infinity; gestureEnds = 0; walkEnds = time + 5.2; wolf.play('Walk'); draw(); },
    celebrate,
    resetView() { orbit.reset(); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect(); wolf.mixer.stopAllAction(); wolf.mixer.uncacheRoot(wolf.model);
      document.removeEventListener('visibilitychange', visibility);
      root.removeEventListener('gateway-scene-visibility', appVisibility);
      unwatchDrawers();
      orbit.dispose();
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
      const geometries = new Set(), materials = new Set();
      scene.traverse(n => { if (n.geometry) geometries.add(n.geometry); if (n.material) materials.add(n.material); if (n.isSkinnedMesh) n.skeleton.dispose(); });
      for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
      key.shadow.map?.dispose(); renderer.dispose();
    },
  };
}
