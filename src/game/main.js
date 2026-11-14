// Game page: drive one car around a map. URL params:
//   ?map=/maps/sample/   map folder (default sample)         ?car=<id>   car id (default: garage choice, else first drivable)
//   ?testRamp            dev: a static ramp 30 m ahead of the spawn (spawn then faces +Z)
//   ?scatter=0           disable the nature scatter (trees, bushes, rocks, grass: world/scatter.js)     ?scatterQuality=low|medium|high (default medium)
//   ?scatterShadows=1    let near trees cast shadows (expensive)
//   ?city=0              disable the city (procedural buildings on cityBlocks lots + plaza props: world/cityFill.js)     ?cityQuality=low|medium|high (default medium)
//   ?cityShadows=1       let near buildings cast shadows (expensive)
// Mouse look: click the canvas (pointer lock), mouse orbits the camera, B looks back, right stick on a pad; settings in the tuning panel (Camera folder).
//   ?spawn=x,z[,yawDeg]  dev: override the spawn (yaw like markers: 0 = +X east, 90 = +Z south)
//   screenshots (dev, docs/gallery): ?cam=x,y,z&look=x,y,z[&fov=deg] fixed camera, ?hideUI=1 no HUD, ?sun=elevDeg,azimDeg (low elevation = warm light); window.__game.shot(w,h,mime,q) -> data URL
// Debug hook: window.__game = { vehicle, map, world, input, camera, stats, THREE, reset(), setInput(obj|null) }.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadMap } from '../world/mapLoader.js';
import { createRenderer, setupSky, applyFog } from '../world/sceneEnv.js';
import { loadCarCatalog, getSelectedCarId } from '../vehicles/carCatalog.js';
import { resolveProfile, archetypeOf, ARCHETYPES } from '../vehicles/handling.js';
import { Vehicle } from '../vehicles/Vehicle.js';
import { createInput } from '../vehicles/input.js';
import { ChaseCamera } from '../vehicles/chaseCamera.js';
import { newLook, stepLook, lookYaw, loadSettings } from '../vehicles/cameraLook.js';
import { createHud } from '../vehicles/hud.js';
import { createTuningPanel } from '../vehicles/tuningPanel.js';
import { addWedgeCollider, wedgeMesh } from '../vehicles/wedge.js';
import { createScatter } from '../world/scatter.js';
import { createCity } from '../world/cityFill.js';

const params = new URLSearchParams(location.search);
const mapUrl = params.get('map') || '/maps/sample/';
const DT = 1 / 120, MAX_STEPS = 10;
const status = document.getElementById('status');
const fail = (e) => { status.style.display = 'grid'; status.textContent = 'Could not start: ' + (e.message || e); console.error(e); };

async function main() {
  // ---- car choice ----
  const catalog = await loadCarCatalog();
  const drivable = catalog.cars.filter((c) => c.drivable);
  let want = params.get('car') || getSelectedCarId();
  let car = catalog.cars.find((c) => c.id === want);
  if (!car || !car.drivable) {
    if (want) console.warn(`car "${want}" ${car ? 'is not drivable' : 'does not exist'}; falling back to "${drivable[0].id}"`);
    car = drivable[0];
  }

  // ---- renderer / scene / physics world / map ----
  const renderer = createRenderer(THREE);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 60000);
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  const { sun } = setupSky(THREE, scene);
  const nums = (k) => (params.get(k) || '').split(',').map(Number), shotCam = params.has('cam') && params.has('look') ? { pos: nums('cam'), look: nums('look') } : null;
  if (params.has('fov')) { camera.fov = +params.get('fov'); camera.updateProjectionMatrix(); }
  if (params.has('sun')) { const [el, az = 0] = nums('sun').map((d) => d * Math.PI / 180); sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)); if (el < 0.35) sun.color.set(0xffc58a); }

  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  status.textContent = 'Loading map...';
  const map = await loadMap(mapUrl, { THREE, RAPIER, physicsWorld: world, physicsResolution: 1024 });
  const W = map.info.worldSize;
  scene.add(map.group); applyFog(THREE, scene, W);
  map.group.traverse((o) => { if (o.isMesh && o.name !== 'ocean' && o.name !== 'lakes') o.receiveShadow = true; });

  // ---- spawn: marker (player_start / spawn) -> map centre snapped to terrain, facing the flattest direction ----
  const spawn = findSpawn(map);
  if (params.has('testRamp')) spawn.yaw = 0;

  // ---- car: GLB first (the chassis collider uses its real body bounds), then the vehicle ----
  status.textContent = `Loading ${car.name}...`;
  const gltf = await new GLTFLoader().loadAsync(car.glb);
  gltf.scene.updateMatrixWorld(true);
  const body = gltf.scene.getObjectByName('body') || gltf.scene;
  const bb = new THREE.Box3().setFromObject(body);
  const profile = resolveProfile(car, 'arcade'); // default; switch to 'Realistic' in the ` tuning panel
  const vehicle = new Vehicle({
    RAPIER, world, map, car, profile, dt: DT,
    bounds: { min: bb.min.toArray(), max: bb.max.toArray() },
    spawn: { x: spawn.x, y: map.heightAt(spawn.x, spawn.z) + 0.35, z: spawn.z, yaw: spawn.yaw },
  });
  scene.add(vehicle.attachVisual(THREE, gltf.scene));

  if (params.has('testRamp')) {
    const o = { x: spawn.x, z0: spawn.z + 30, width: 14, angleDeg: 18, length: 24 };
    let y0 = -1e9; for (let dx = -7; dx <= 7; dx += 3.5) for (let dz = 0; dz <= 24; dz += 4) y0 = Math.max(y0, map.heightAt(o.x + dx, o.z0 + dz));
    o.y0 = y0 - 0.05;
    addWedgeCollider(RAPIER, world, o); scene.add(wedgeMesh(THREE, o));
  }

  // ---- city fill (procedural buildings on city lots, plaza props; solid buildings near the car). Created BEFORE the scatter so trees keep off the buildings. ?city=0 turns it off ----
  const spawnExcl = [{ x: spawn.x, z: spawn.z, r: 12 }];
  const city = params.get('city') === '0' ? null : createCity({ THREE, map, scene, camera, RAPIER, physicsWorld: world, baseUrl: mapUrl,
    options: { quality: params.get('cityQuality') || 'medium', shadows: params.get('cityShadows') === '1', exclusions: spawnExcl } });
  if (city) { city.ready.catch(() => {}); await city.genReady; }   // generator only (tiny fetch); the 10 MB GLB loads in the background

  // ---- nature scatter (trees / bushes / rocks / grass; solid trunks + rocks near the car). Loads in the background; ?scatter=0 turns it off ----
  const scatter = params.get('scatter') === '0' ? null : createScatter({ THREE, map, scene, camera, RAPIER, physicsWorld: world, baseUrl: mapUrl,
    options: { quality: params.get('scatterQuality') || 'medium', shadows: params.get('scatterShadows') === '1', exclusions: spawnExcl, extraBlocked: city && city.gen && city.gen.hasCity() ? city.blocked : null } });
  if (scatter) scatter.ready.catch(() => {});
  // ---- entity layer debug demo (?entityDemo=1&entityN=2000) ----
  const entityDemo = params.get('entityDemo') === '1' ? (await import('../world/entityDemo.js')).createEntityDemo({ THREE, scene, heightAt: map.heightAt, n: +(params.get('entityN') || 2000) }) : null;
  if (entityDemo) addEventListener('pagehide', () => entityDemo.dispose());

  const input = createInput();
  input.mouseLook(renderer.domElement); // click the canvas = pointer lock = free look (cameraLook.js)
  const settings = loadSettings(), look = newLook(), lookView = { yaw: 0, pitch: 0 };
  const chase = new ChaseCamera(THREE, camera, { heightAt: map.heightAt, dims: car.dimensions, settings, RAPIER, world });
  const hud = createHud({ car, arch: ARCHETYPES[archetypeOf(car.id)].label });
  if (params.get('hideUI') === '1') hud.root.style.display = 'none';
  const tuning = createTuningPanel({ vehicle, car, onMessage: (m) => hud.message(m), camera: settings });

  // shadow rig follows the car
  const S = Math.max(28, car.dimensions.length * 2.4);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 500 }); sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.5;
  scene.add(sun.target);
  const sunDir = sun.position.clone().normalize();

  // ---- reset policy ----
  const safe = { x: spawn.x, y: vehicle.body.translation().y, z: spawn.z, yaw: spawn.yaw, t: 0 };
  const margin = 12;
  const outOfWorld = (p) => !(p.y > -30) || p.x < -margin || p.z < -margin || p.x > W + margin || p.z > W + margin;
  let resets = 0;
  const resetToSafe = (why) => { Object.assign(look, newLook()); vehicle.resetAt(safe.x, safe.y + 1.0, safe.z, safe.yaw); chase.snap(vehicle.poseAt(1), vehicle); hud.message(why); resets++; console.warn('auto reset:', why); };
  const resetUpright = () => { Object.assign(look, newLook()); vehicle.resetUpright(1.0); chase.snap(vehicle.poseAt(1), vehicle); hud.message('Reset'); };

  status.style.display = 'none';
  chase.snap(vehicle.poseAt(1), vehicle);

  // ---- main loop: fixed physics step with accumulator, interpolated render ----
  let acc = 0, last = performance.now(), physMs = 0, steps = 0, fpsEma = 60, frameCount = 0, dbgText = '';
  const pose = {}; const stats = { physMs: 0, stepsPerFrame: 0, fps: 0, frames: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    const s = input.update();
    if (s.tuningPressed) { tuning.toggle(); input.unlock?.(); } // the panel needs the mouse cursor
    if (s.cameraPressed) { chase.toggle(); }
    if (s.resetPressed) resetUpright();
    acc += dt; let n = 0;
    const t0 = performance.now();
    while (acc >= DT && n < MAX_STEPS) { vehicle.fixedStep(s); acc -= DT; n++; }
    if (n === MAX_STEPS) acc = 0; // way behind (tab was hidden): drop the backlog instead of spiralling
    physMs += (performance.now() - t0 - physMs) * 0.05; steps = n;
    // safety nets
    const p = vehicle.body.translation();
    if (vehicle.broken) resetToSafe('Physics glitch: reset');
    else if (outOfWorld(p)) resetToSafe('Out of bounds: reset');
    else if (vehicle.submerged > 3) resetToSafe('Drowned: reset');
    else if (vehicle.nContact >= 3 && !vehicle.inWater && now - safe.t > 250) { safe.x = p.x; safe.y = p.y; safe.z = p.z; safe.yaw = vehicle.heading(); safe.t = now; }

    map.update?.(dt); // advances the traffic-signal light cycle
    vehicle.updateVisual(acc / DT);
    vehicle.poseAt(acc / DT, pose);
    stepLook(look, dt, { dx: s.lookX, dy: s.lookY, sx: s.lookSX, sy: s.lookSY, behind: s.lookBehind }, vehicle.state.speed, settings);
    lookView.yaw = lookYaw(look); lookView.pitch = look.pitch;
    chase.update(dt, pose, vehicle, lookView);
    if (shotCam) { camera.position.set(...shotCam.pos); camera.lookAt(...shotCam.look); }
    // shadow rig
    sun.target.position.set(pose.x, pose.y, pose.z); sun.position.set(pose.x + sunDir.x * 150, pose.y + sunDir.y * 150, pose.z + sunDir.z * 150);
    sun.target.updateMatrixWorld();
    city?.update(dt, p);    // buildings: cull / LOD sort for this view, keeps the building + bollard colliders round the car
    entityDemo?.update(dt, p, now / 1000);
    scatter?.update(dt, p); // after the camera moved: culls / LOD-sorts the instances for this view, keeps the trunk colliders round the car
    renderer.render(scene, camera);

    fpsEma += (1 / Math.max(dt, 1e-4) - fpsEma) * 0.05; frameCount++;
    Object.assign(stats, { physMs, stepsPerFrame: steps, fps: fpsEma, frames: frameCount, resets });
    if (frameCount % 10 === 0) dbgText = `${fpsEma.toFixed(0)} fps  physics ${physMs.toFixed(2)} ms (${steps} steps)  ${input.padName ? 'pad' : 'keys'}`;
    hud.update(vehicle.state, dbgText); hud.lookHint(!input.locked);
  }
  requestAnimationFrame((t) => { last = t; frame(t); });

  // render at w x h (restores the size) and return the frame as a data URL; used by the gallery capture (scripts/shots.json)
  const shot = (w = 1600, h = 900, mime = 'image/webp', q = 0.9) => {
    const pr = renderer.getPixelRatio(); renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (shotCam) { camera.position.set(...shotCam.pos); camera.lookAt(...shotCam.look); }
    renderer.render(scene, camera); const url = renderer.domElement.toDataURL(mime, q);
    renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); return url;
  };
  window.__game = { shot, THREE, RAPIER, vehicle, map, world, input, camera, chase, scene, renderer, stats, car, profile,
    scatter, city, entityDemo, reset: resetUpright, setInput: (o) => { input.override = o; }, tuning, spawn };
}

// marker -> else centre-nearest drivable spot. returns { x, z, yaw } with yaw in Vehicle convention (forward = (sin yaw, cos yaw) in x,z)
function findSpawn(map) {
  const W = map.info.worldSize, sea = map.info.seaLevel;
  const fromDeg = (d) => Math.PI / 2 - d * Math.PI / 180; // marker yaw (0 = +X) -> vehicle yaw
  const sp = params.get('spawn');
  if (sp) { const [x, z, d = 90] = sp.split(',').map(Number); return { x, z, yaw: fromDeg(d) }; }
  const m = map.getMarkers({ tag: 'player_start' })[0] || map.getMarkers({ tag: 'spawn' })[0] || map.markerByName('player_start');
  if (m) return { x: m.x, z: m.z, yaw: fromDeg(m.yaw) };
  const ok = (x, z) => {
    if (x < 20 || z < 20 || x > W - 20 || z > W - 20) return false;
    const h = map.heightAt(x, z);
    if (h < sea + 1.5 || map.isUnderwater(x, z, h + 1)) return false;
    return map.normalAt(x, z).y > 0.96; // < ~16 deg
  };
  let best = { x: W / 2, z: W / 2 };
  search: for (let r = 0; r < W / 2; r += 6) for (let a = 0; a < Math.max(1, Math.round(r / 6) * 4); a++) {
    const t = a / Math.max(1, Math.round(r / 6) * 4) * Math.PI * 2, x = W / 2 + Math.cos(t) * r, z = W / 2 + Math.sin(t) * r;
    if (ok(x, z)) { best = { x, z }; break search; }
  }
  // face the flattest of 16 directions (smallest height change over 40 m)
  let yaw = 0, bd = 1e9;
  for (let i = 0; i < 16; i++) {
    const th = i / 16 * Math.PI * 2, x2 = best.x + Math.sin(th) * 40, z2 = best.z + Math.cos(th) * 40;
    const d = Math.abs(map.heightAt(x2, z2) - map.heightAt(best.x, best.z)) + (map.isUnderwater(x2, z2, map.heightAt(x2, z2) + 1) ? 100 : 0);
    if (d < bd) { bd = d; yaw = th; }
  }
  return { ...best, yaw };
}

main().catch(fail);
