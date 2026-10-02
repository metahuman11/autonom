import * as THREE from './vendor/three/three.module.js';

// Restyle the licensed, skinned Quaternius model. Its real skeleton and clips
// remain intact; expression meshes are attached to the head, not screen sprites.
export function prepareWolf(gltf) {
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const head = model.getObjectByName('Head');
  const neck = model.getObjectByName('Neck3');
  if (!head || !neck) throw new Error('Wolf rig is unavailable.');
  const fur = { Main: '#8c9fac', Main_Light: '#f3f2eb', Nose: '#263541' };
  model.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = true; node.receiveShadow = true; node.frustumCulled = false;
    if (node.material.name === 'Eyes_Black') { node.visible = false; return; }
    node.material = node.material.clone();
    node.material.color.set(fur[node.material.name] || '#93aabc');
    node.material.metalness = 0; node.material.roughness = .88;
    // Average split vertex normals at coincident positions for soft, toy-like fur.
    const geometry = node.geometry.clone(); node.geometry = geometry;
    const position = geometry.attributes.position, normal = geometry.attributes.normal;
    if (normal) {
      const groups = new Map();
      for (let i = 0; i < position.count; i++) {
        const key = [position.getX(i), position.getY(i), position.getZ(i)].map(n => n.toFixed(6)).join(',');
        let group = groups.get(key);
        if (!group) { group = { ids: [], normal: new THREE.Vector3() }; groups.set(key, group); }
        group.ids.push(i); group.normal.add(new THREE.Vector3().fromBufferAttribute(normal, i));
      }
      for (const group of groups.values()) {
        group.normal.normalize();
        for (const i of group.ids) normal.setXYZ(i, group.normal.x, group.normal.y, group.normal.z);
      }
      normal.needsUpdate = true;
    }
  });
  const face = new THREE.Group(); face.name = 'WolfExpressions';
  model.add(face); head.attach(face);
  // attach() keeps the author's original world-space rest pose and bone scale.
  function ball(parent, color, position, scale, roughness = .65) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color, roughness }));
    mesh.position.set(...position); mesh.scale.set(...scale); mesh.castShadow = true;
    parent.add(mesh); return mesh;
  }
  // Face is in the original world coordinate frame; future movement is skeletal.
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group(); eye.position.set(side * .254 - .027, 2.247, 2.087);
    eye.rotation.y = side * .42;
    face.add(eye);
    ball(eye, '#f8f7ef', [0, 0, 0], [.14, .156, .065]);
    ball(eye, '#354b5d', [0, -.004, .048], [.11, .122, .043], .3);
    ball(eye, '#111f2d', [0, -.004, .077], [.079, .092, .024], .25);
    ball(eye, '#ffffff', [-.029, .043, .099], [.027, .03, .009], .3);
    ball(eye, '#e4eff5', [.03, -.047, .096], [.012, .014, .006], .3);
    eyes.push(eye);
  }
  const jaw = new THREE.Group(); jaw.name = 'VoiceJaw'; jaw.position.set(-.043, 2.026, 2.11); face.add(jaw);
  ball(jaw, '#293e4c', [0, .006, .155], [.176, .033, .25]);
  ball(jaw, '#eeeee5', [0, -.025, .14], [.185, .064, .25]);
  ball(jaw, '#cb9198', [0, .025, .28], [.08, .015, .08]);
  // Larger head/ears and paws create a young, approachable silhouette.
  neck.scale.multiplyScalar(1.36); head.scale.multiplyScalar(1.12);
  for (const side of ['L', 'R']) {
    model.getObjectByName('Ear1' + side)?.scale.multiplyScalar(1.06);
  }
  model.scale.set(1.16, 1, .86);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const wrapper = new THREE.Group(); wrapper.name = 'GatewayWolf'; wrapper.add(model);
  wrapper.scale.setScalar(2.7 / size.y);
  model.position.y -= bounds.min.y;
  model.position.z -= bounds.getCenter(new THREE.Vector3()).z;
  model.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(model);
  const clips = new Map(gltf.animations.filter(clip => !clip.name.includes('|')).map(clip => [clip.name, clip]));
  const bones = ['Head', 'Neck3', 'Ear1L', 'Ear1R', 'Tail1', 'Tail2', 'Tail3'].map(name => model.getObjectByName(name)).filter(Boolean);
  const saved = new Map(bones.map(bone => [bone, bone.quaternion.clone()]));
  let active;
  function play(name, once = false) {
    const clip = clips.get(name) || clips.get('Idle');
    if (!clip) throw new Error('Wolf animation is unavailable.');
    const next = mixer.clipAction(clip);
    if (active === next && !once) return;
    next.reset().setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once; next.enabled = true; next.setEffectiveWeight(1).setEffectiveTimeScale(name === 'Walk' ? .8 : 1).play();
    if (active && active !== next) next.crossFadeFrom(active, .28, false);
    active = next;
  }
  function animate(dt, pose) {
    // Remove last frame's additive offsets before evaluating the next rig pose.
    for (const bone of bones) bone.quaternion.copy(saved.get(bone));
    mixer.update(dt);
    for (const bone of bones) saved.get(bone).copy(bone.quaternion);
    head.rotateY(pose.headTilt); head.rotateX(pose.headNod);
    model.getObjectByName('Ear1L')?.rotateZ(pose.earLeft);
    model.getObjectByName('Ear1R')?.rotateZ(pose.earRight);
    for (let i = 1; i <= 3; i++) model.getObjectByName('Tail' + i)?.rotateZ(pose.tail / i);
    jaw.rotation.x = pose.mouth;
    for (const eye of eyes) eye.scale.y = pose.blink;
    model.updateMatrixWorld(true);
  }
  play('Idle');
  return { object: wrapper, model, mixer, play, animate, jaw, eyes, clips };
}
