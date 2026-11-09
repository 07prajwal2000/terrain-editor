// Dev viewer for the map loader. Not the game: free-fly camera, HUD, debug toggles, physics sanity test.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, checkCollider, SURFACE_NAMES } from './world/mapLoader.js';
import { createRenderer, setupSky, applyFog } from './world/sceneEnv.js';
import { createMarkerPins } from './world/markerPins.js';

const $ = (id) => document.getElementById(id);
const mapUrl = new URLSearchParams(location.search).get('map') || '/maps/sample/';

const renderer = createRenderer(THREE);
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 60000);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

setupSky(THREE, scene);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

let map;
try {
  map = await loadMap(mapUrl, { THREE, RAPIER, physicsWorld: world });
} catch (e) {
  $('hud').textContent = 'loadMap failed:\n' + e.message; console.error(e); throw e;
}
const W = map.info.worldSize;
scene.add(map.group);
applyFog(THREE, scene, W);
console.log('map loaded', map.info);

// ---- map markers (markers.json) as pins ----
const pins = createMarkerPins(THREE, { heightAt: map.heightAt, size: Math.max(2, W * 0.012) });
pins.setMarkers(map.markers); pins.group.visible = false; scene.add(pins.group);

// ---- roads as debug polylines (the road/bridge MESHES are a later task) ----
const roadLines = new THREE.Group(); roadLines.visible = false; scene.add(roadLines); // off by default; the road MESH is in map.group
for (const r of map.roads) {
  const pts = r.getPoints(2), pos = [], col = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], c = a.bridge ? [1, 0.45, 0.1] : [1, 0.9, 0.2];
    pos.push(a.x, a.y + 0.5, a.z, b.x, b.y + 0.5, b.z); col.push(...c, ...c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  roadLines.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, fog: false })));
}

// ---- collider debug mesh (built lazily from the exact heights handed to Rapier) ----
let colMesh = null;
function buildColliderMesh() {
  const { heights, resolution: R } = map.physics, step = W / (R - 1);
  const pos = new Float32Array(R * R * 3), ind = new Uint32Array((R - 1) * (R - 1) * 6);
  for (let iz = 0; iz < R; iz++) for (let ix = 0; ix < R; ix++) {
    const o = (iz * R + ix) * 3; pos[o] = ix * step; pos[o + 1] = heights[ix * R + iz] + 0.3; pos[o + 2] = iz * step;
  }
  let p = 0;
  for (let iz = 0; iz < R - 1; iz++) for (let ix = 0; ix < R - 1; ix++) {
    const a = iz * R + ix, b = a + R;
    ind[p++] = a; ind[p++] = b; ind[p++] = a + 1; ind[p++] = a + 1; ind[p++] = b; ind[p++] = b + 1;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(ind, 1));
  colMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff2fd0, wireframe: true, fog: false }));
  scene.add(colMesh);
}

// ---- toggles ----
$('cbWire').onchange = (e) => { map.parts.material.wireframe = e.target.checked; };
$('cbCol').onchange = (e) => { if (e.target.checked && !colMesh) buildColliderMesh(); if (colMesh) colMesh.visible = e.target.checked; };
$('cbWater').onchange = (e) => { map.parts.ocean.visible = e.target.checked; if (map.parts.lakes) map.parts.lakes.visible = e.target.checked; };
$('cbRoads').onchange = (e) => { roadLines.visible = e.target.checked; };
$('cbMarkers').onchange = (e) => { pins.group.visible = e.target.checked; };
$('cbMesh').onchange = (e) => { map.parts.roadGroup.visible = e.target.checked; };

// ---- fly camera ----
let yaw = 0, pitch = 0, speed = W / 15;
function lookFrom(x, y, z, tx, ty, tz) {
  camera.position.set(x, y, z);
  const dx = tx - x, dy = ty - y, dz = tz - z;
  yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
}
camera.far = W * 12; camera.updateProjectionMatrix();
const home = () => lookFrom(W * 0.5, map.info.maxHeight * 1.6 + 60, W * 1.2, W * 0.5, 20, W * 0.45);
home();
$('bHome').onclick = home;
$('bTop').onclick = () => { lookFrom(W * 0.5, W * 0.95, W * 0.5 + 0.01, W * 0.5, 0, W * 0.5); };
// ---- view presets used for screenshots ----
let jIdx = -1;
function jView(far) {
  if (!map.junctions.length) return;
  const j = map.junctions[far ? Math.max(jIdx, 0) : (jIdx = (jIdx + 1) % map.junctions.length)], d = far ? 160 : 38;
  lookFrom(j.x + d * 0.35, j.y + d * 0.75, j.z + d * 0.75, j.x, j.y, j.z);
}
$('bJ').onclick = () => jView(false); $('bJF').onclick = () => jView(true);
function roadView(kind, ri = 0, t = 0.35) {
  const r = map.roads[ri], p = r.sample(t), q = r.sample(Math.min(1, t + 0.01));
  const gy = map.heightAt(p.x, p.z);
  if (kind === 'top') lookFrom(p.x, gy + 9, p.z + 0.001, p.x, gy, p.z);
  else if (kind === 'driver') lookFrom(p.x - p.tx * 6, gy + 1.5, p.z - p.tz * 6, p.x + p.tx * 40, gy + 1.0, p.z + p.tz * 40);
  else lookFrom(p.x - 90, gy + 140, p.z + 160, p.x, gy, p.z);
}
$('bRT').onclick = () => roadView('top'); $('bRD').onclick = () => roadView('driver'); $('bRF').onclick = () => roadView('far');
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let dragging = false;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (dragging) { yaw -= e.movementX * 0.003; pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.003)); }
});
renderer.domElement.addEventListener('wheel', (e) => { speed *= Math.exp(-e.deltaY * 0.001); speed = Math.max(2, Math.min(W, speed)); }, { passive: true });
const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
function fly(dt) {
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.getWorldDirection(fwd); right.crossVectors(fwd, camera.up).normalize();
  const s = speed * (keys.has('ShiftLeft') ? 4 : 1) * dt;
  tmp.set(0, 0, 0);
  if (keys.has('KeyW')) tmp.add(fwd); if (keys.has('KeyS')) tmp.sub(fwd);
  if (keys.has('KeyD')) tmp.add(right); if (keys.has('KeyA')) tmp.sub(right);
  if (keys.has('KeyE')) tmp.y += 1; if (keys.has('KeyQ')) tmp.y -= 1;
  camera.position.addScaledVector(tmp, s);
}

// ---- cursor -> terrain hit by marching heightAt (cheap; the dev viewer needs no BVH) ----
const ndc = new THREE.Vector2(), ray = new THREE.Raycaster();
function cursorHit() {
  ndc.set(mouse.x / innerWidth * 2 - 1, -(mouse.y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction; let t = 0, prev = 0; const stepM = 2;
  for (; t < W * 4; t += stepM * (1 + t / 400)) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (x < 0 || z < 0 || x > W || z > W) { if (t > 0 && d.y >= 0) return null; continue; }
    if (y < map.heightAt(x, z)) {
      let a = prev, b = t; for (let i = 0; i < 20; i++) { const m = (a + b) / 2; (o.y + d.y * m < map.heightAt(o.x + d.x * m, o.z + d.z * m)) ? (b = m) : (a = m); }
      return { x: o.x + d.x * b, y: o.y + d.y * b, z: o.z + d.z * b };
    }
    prev = t;
  }
  return null;
}

// ---- physics sanity test ----
const balls = [];
function clearBalls() { for (const b of balls) { world.removeRigidBody(b.body); scene.remove(b.mesh); b.mesh.geometry.dispose(); } balls.length = 0; }
const ballMat = new THREE.MeshStandardMaterial({ color: 0xff3b30 });
$('bPhys').onclick = () => {
  clearBalls();
  const R = 0.6, margin = 20; let rnd = 4242; const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 20; i++) {
    const x = margin + rand() * (W - 2 * margin), z = margin + rand() * (W - 2 * margin), y = map.heightAt(x, z) + 15 + rand() * 20;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    world.createCollider(RAPIER.ColliderDesc.ball(R).setFriction(0.8).setRestitution(0.1), body);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 12, 8), ballMat); scene.add(mesh);
    balls.push({ body, mesh, R });
  }
  for (let i = 0; i < 60 * 12; i++) world.step(); // fast-forward 12 s so the result is immediate
  let onSurface = 0, fell = 0, floating = 0, rolling = 0, offMap = 0;
  for (const b of balls) {
    const p = b.body.translation(), h = map.heightAt(p.x, p.z), dy = p.y - (h + b.R / map.normalAt(p.x, p.z).y); // centre rests R/cos(slope) above the surface
    if (p.x < 0 || p.z < 0 || p.x > W || p.z > W) offMap++; // rolled off the map edge (no walls); not a collider failure
    else if (dy < -1.0) fell++; else if (Math.abs(dy) < 0.35) { onSurface++; const v = b.body.linvel(); if (Math.hypot(v.x, v.y, v.z) > 0.5) rolling++; } else floating++;
  }
  $('out').textContent = `Physics test: ${onSurface}/20 on surface (${rolling} still rolling), ${fell} fell through, ${offMap} rolled off the map edge, ${floating} other.`;
  console.log($('out').textContent);
};
$('bRay').onclick = () => {
  const r = checkCollider(map, RAPIER, world, 300);
  $('out').textContent = `Raycast vs heightAt: n=${r.n} misses=${r.misses} max=${r.maxErr.toFixed(3)} m mean=${r.meanErr.toFixed(3)} m`;
  console.log($('out').textContent);
};

// ---- loop + HUD ----
let last = performance.now(), frames = 0, fpsT = last, fps = 0, hudT = 0;
function hud() {
  const c = camera.position, h = map.heightAt(c.x, c.z), sf = map.surfaceAt(c.x, c.z), wl = map.waterLevelAt(c.x, c.z), cur = cursorHit();
  const top = [...sf.weights].map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter((a) => a[0] > 0.01).map(([w, i]) => `${SURFACE_NAMES[i]} ${(w * 100) | 0}%`).join(', ');
  let cs = 'cursor: (off map)';
  if (cur) { const s2 = map.surfaceAt(cur.x, cur.z), wl2 = map.waterLevelAt(cur.x, cur.z); cs = `cursor: x ${cur.x.toFixed(0)} z ${cur.z.toFixed(0)} h ${cur.y.toFixed(1)} m ${SURFACE_NAMES[s2.classId]}${wl2 !== null ? ' water ' + wl2.toFixed(1) : ''}`; }
  $('hud').textContent =
    `fps ${fps.toFixed(0)}   N ${map.info.N}  ${map.info.worldSize} m  chunks ${map.info.chunks}  load ${map.info.loadMs.total.toFixed(0)} ms\n` +
    `cam x ${c.x.toFixed(0)} y ${c.y.toFixed(1)} z ${c.z.toFixed(0)}  speed ${speed.toFixed(0)}\n` +
    `ground ${h.toFixed(1)} m  AGL ${(c.y - h).toFixed(1)} m\n` +
    `surface: ${SURFACE_NAMES[sf.classId]} (${top})  friction ${map.SURFACE_FRICTION[sf.classId]}\n` +
    `water: ${wl === null ? 'none' : 'level ' + wl.toFixed(1) + ' m'}  camera underwater: ${map.isUnderwater(c.x, c.z, c.y)}\n` + cs;
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fly(dt);
  if (balls.length) { world.timestep = 1 / 60; world.step(); for (const b of balls) { const p = b.body.translation(); b.mesh.position.set(p.x, p.y, p.z); } }
  renderer.render(scene, camera);
  frames++; if (now - fpsT > 500) { fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
  if (now - hudT > 150) { hudT = now; hud(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__viewer = { pins, roadView, jView, balls, THREE, camera, map, world, scene, renderer, lookFrom, setLook: (x, y, z, tx, ty, tz) => lookFrom(x, y, z, tx, ty, tz) };
