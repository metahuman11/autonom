// Never replace this exact allowlist with directory serving. Private demo APIs,
// operator tools, source backups and account configuration are NOT public assets.
const files = ['profile.mjs', 'state.mjs', 'channel.js', 'mascot.js',
  'wolf-scene.mjs', 'wolf-model.mjs', 'wolf-motion.mjs',
  'assets/wolf.glb', 'assets/desktop-atlas.png', 'assets/ATTRIBUTION.md',
  'vendor/three/three.module.js', 'vendor/three/three.core.js',
  'vendor/three/GLTFLoader.js', 'vendor/three/BufferGeometryUtils.js', 'vendor/three/LICENSE'];
export const COMPANION_ASSETS = Object.freeze(Object.fromEntries(files.map(file => [`/kurt/${file}`, `kurt/${file}`])));
