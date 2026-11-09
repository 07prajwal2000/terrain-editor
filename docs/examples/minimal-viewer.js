// minimal-viewer.js - smallest Three.js + Rapier page that loads a map export.
//
// This page is served by Vite (npm run dev), so bare imports ("three",
// "@dimforge/rapier3d-compat") are resolved by the dev server. Open:
//   http://127.0.0.1:5173/docs/examples/minimal-viewer.html
//   http://127.0.0.1:5173/docs/examples/minimal-viewer.html?map=/maps/citytest/
//
// It does not need a bundler config change: any HTML file under the project root
// is served and its module imports are transformed by Vite. Opening the file
// through file:// will not work (ES modules + bare imports).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap } from '/src/world/mapLoader.js';

const info = document.getElementById('info');
const mapUrl = new URLSearchParams(location.search).get('map') || '/maps/sample/';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec9e8);
scene.add(new THREE.HemisphereLight(0xb8d8ff, 0x6b5a3a, 1.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(-0.5, 0.75, -0.45);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 60000);
let map;

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

try {
  map = await loadMap(mapUrl, { THREE, RAPIER, physicsWorld: world, physicsResolution: 256 });
} catch (err) {
  info.textContent = `Failed to load ${mapUrl}\n${err.message || err}`;
  throw err;
}
scene.add(map.group);
scene.fog = new THREE.Fog(0x9ec9e8, map.info.worldSize * 0.7, map.info.worldSize * 6);

const W = map.info.worldSize;
camera.position.set(W / 2, map.heightAt(W / 2, W / 2) + 120, W / 2);
camera.far = W * 8;
camera.updateProjectionMatrix();

let yaw = 0;
let pitch = -0.35;
let dragging = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  dragging = false;
  renderer.domElement.releasePointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.003;
  pitch = Math.max(-1.5, Math.min(1.2, pitch - e.movementY * 0.003));
});

const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let speed = 60;
addEventListener('wheel', (e) => {
  speed = Math.max(5, Math.min(600, speed * (e.deltaY > 0 ? 0.85 : 1.18)));
  e.preventDefault();
}, { passive: false });

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const clock = new THREE.Clock();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  const step = speed * fast * dt;
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  if (keys.has('KeyW')) camera.position.addScaledVector(forward, step);
  if (keys.has('KeyS')) camera.position.addScaledVector(forward, -step);
  if (keys.has('KeyA')) camera.position.addScaledVector(right, -step);
  if (keys.has('KeyD')) camera.position.addScaledVector(right, step);
  if (keys.has('KeyE')) camera.position.y += step;
  if (keys.has('KeyQ')) camera.position.y -= step;

  map.update(dt); // signal-light clock
  renderer.render(scene, camera);
}

info.textContent =
  `${mapUrl}\n` +
  `${map.info.N} x ${map.info.N} px, ${map.info.worldSize} m, max height ${map.info.maxHeight} m\n` +
  `${map.roads.length} roads, ${map.junctions.length} junctions, ${map.markers.length} markers\n` +
  `loaded in ${map.info.loadMs.total.toFixed(0)} ms (${map.info.chunks} chunks)`;
frame();
