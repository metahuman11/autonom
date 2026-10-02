# Gateway wolf asset provenance

`wolf.glb`: Wolf by Quaternius, Ultimate Animated Animals pack.

- Author page: https://quaternius.com/packs/ultimateanimatedanimals.html
- Individual source: https://poly.pizza/m/P1gU3Qkr9r
- Original download: https://static.poly.pizza/f1d12388-e39b-4157-b32a-646a1d089fc4.glb
- License: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/
- Retrieved 2026-09-15. The downloaded binary is retained unchanged.
- Gateway runtime restyling: blue-gray/cream materials, softer normals, enlarged
  head/ears, attached expression eyes/jaw and additive animation.

Three.js 0.180.0: https://github.com/mrdoob/three.js/tree/r180
MIT license retained in `../vendor/three/LICENSE`. Vendored npm files, with only
the loader/utility imports changed to relative, same-origin modules.

No textures, remote dependencies, actor voice clones or real-person likenesses
are included in this character asset.

`desktop-atlas.png` is rendered from that same restyled wolf with
`tools/render-native-kurt.mjs`. 112 transparent 512px frames at 10 fps: idle
48 frames, thinking 32, happy 32; eight columns. Native GTK/Cairo plays these
pre-rendered animations on the VPS without WebGL, a browser or a live 3D renderer.
SHA-256: `4fc470e9e9284ee12bdbd51d9012235d1f86249c7bf7412b78d062c7e11e0ff1`.
