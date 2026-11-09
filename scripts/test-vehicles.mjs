// Headless vehicle test: `npm run test:vehicles` (options: --cars sports,bus   --smoke-only   --quick   --road-only)
// Drives scripted inputs on a synthetic FLAT map (built with the real loader, loadMapFromData) and prints one comparison table, then asserts that
// the archetypes are clearly distinct and that nothing explodes. All distances/times are in simulated seconds at the game's fixed step (1/120 s).
//   0-100 / top speed : full throttle from rest, 70 s
//   brake 100->0      : velocity set to 100 km/h (or 0.9*top if lower), full brake on a straight line
//   turn circle       : full steering lock at a steady 10 km/h, diameter of the best-fit circle of the path of the chassis origin
//   corner vmax       : closed-loop (steering controller) on a 30 m RADIUS circle, speed raised by 5 km/h until it cannot hold the line (error > 3 m,
//                       speed lost, spin or roll); reported speed and lateral g = v^2/(R g)
//   roll @60          : body roll angle (deg) and lateral g while cruising at 60 km/h with full steering input (lock is speed-limited)
//   susp use          : max compression of any wheel (m, relative to static) in a 3 m drop; "10 m drop" checks no pass-through / no launch
//   climb 30          : slope distance covered up a 30 degree wedge from standstill in 10 s (full throttle)
//   sand 0-60 / dirt  : time to 60 km/h on sand / dirt (or distance in 10 s when it never gets there)
//   slope park        : creep (m) in 8 s on a 15 degree slope with the handbrake, and with NO input (auto hold)
//   ROAD SURFACES (--road-only runs just these + the camera tests): a real road (roads.json data through loadMapFromData, surface smooth / potholes / gravel)
//   on a flat map: 100->0 braking and 0-60 on gravel vs smooth, vertical-acceleration RMS + max height gain at 80 km/h on potholes, parked jitter/creep on
//   potholes and gravel, bridge-deck rule (contact > 0.8 m above heightAt = smooth). CAMERA (cameraLook.js + chaseCamera.js): pitch clamp, 360 deg yaw wrap,
//   idle recentre timing + speed dependence, never below heightAt + margin, yaw offset preserved while the car turns.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMapFromData } from '../src/world/mapLoader.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { resolveProfile, archetypeOf } from '../src/vehicles/handling.js';
import { addWedgeCollider, wedgePoints } from '../src/vehicles/wedge.js';
import { newLook, stepLook, lookYaw, clampPitch, wrapAngle, orbitOffset, PITCH_MIN, PITCH_MAX, LOOK_DEFAULTS } from '../src/vehicles/cameraLook.js';
import { ChaseCamera, MARGIN } from '../src/vehicles/chaseCamera.js';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const X0 = 10000, Z0 = 10000, DT = 1 / 120, KMH = 3.6, G = 9.81;
const manifest = JSON.parse(fs.readFileSync(path.resolve('public/cars/cars.json'), 'utf8'));
const cars = Object.fromEntries(manifest.cars.map((c) => [c.id, c]));

// ---- GLB body bounds (the game measures the same thing with Box3 on the loaded scene) ----
function glbBodyBounds(id) {
  const b = fs.readFileSync(path.resolve(`public/cars/${id}.glb`)), len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString());
  const node = j.nodes.find((n) => n.name === 'body'), t = node.translation || [0, 0, 0];
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of j.meshes[node.mesh].primitives) { const a = j.accessors[p.attributes.POSITION]; for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k] + t[k]); max[k] = Math.max(max[k], a.max[k] + t[k]); } }
  return { min, max };
}

await RAPIER.init();

// ---- scene: flat map of one surface class (+ optional wedge) ----
function flatMapData(classId, N = 16, W = 20000) {
  const s0 = new Uint8Array(N * N * 4), s1 = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) (classId < 4 ? s0 : s1)[i * 4 + (classId & 3)] = 255;
  return {
    info: { N, worldSizeMeters: W, maxHeightMeters: 10, seaLevel: 0, seaLevelMeters: -5, classes: ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'].map((color, id) => ({ id, name: String(id), color })) },
    height: new Uint16Array(N * N), splat0: s0, splat1: s1, water: new Uint16Array(N * N), roads: { roads: [] },
  };
}
// a 30 m wide straight road along +Z through (X0, Z0) with one road surface ('smooth' | 'worn' | 'potholes' | 'gravel'), as roads.json data
function roadData(surface) {
  const pts = []; for (let z = Z0 - 300; z <= Z0 + 3000; z += 100) pts.push({ nx: X0 / 20000, nz: z / 20000, x: X0, y: 0, z, bridge: false, surface });
  return { roads: [{ id: 1, widthMeters: 30, points: pts }] };
}
// road: use the REAL surfaceAt of a map with that road (gripMul / roughness / roadSurface come from the loader); deckBelow: pretend the ground is that far below
// the contact (heightAt = -deckBelow), i.e. the car drives on a bridge deck above that road
function scene(id, { classId = 6, wedge = null, profileEdit = null, at = null, road = null, deckBelow = 0 } = {}) {
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  const data = flatMapData(road ? 0 : classId); if (road) data.roads = roadData(road);
  const map = loadMapFromData(data, { THREE, RAPIER, physicsWorld: world, physicsResolution: 8 });
  if (deckBelow) map.heightAt = () => -deckBelow;
  if (!road) { // the real surfaceAt calls a splat 'road' pixel grass when no road mesh is there, so the test pins the class instead
    const fixed = { classId, weights: Float32Array.from({ length: 8 }, (_, i) => (i === classId ? 1 : 0)) };
    map.surfaceAt = () => fixed;
  }
  if (wedge) addWedgeCollider(RAPIER, world, wedge);
  const car = cars[id], profile = resolveProfile(car);
  if (profileEdit) profileEdit(profile);
  const o = at || { x: X0, y: 0.15, z: Z0, yaw: 0 };
  const v = new Vehicle({ RAPIER, world, map, car, profile, bounds: glbBodyBounds(id), spawn: o, dt: DT });
  v.step = (inp) => v.fixedStep(inp);
  v.world.step(); // init collider set
  v.resetAt(o.x, o.y, o.z, o.yaw);
  return { world, map, v, car, profile };
}
const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const upY = (v) => v.ax.u[1];
function run(v, seconds, fn, every = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { const inp = fn ? fn(i * DT, v) : NONE; v.fixedStep(inp); if (every) every(i * DT, v); if (v.broken) return false; }
  return true;
}
const settle = (v, s = 1.5) => run(v, s, null);
const planar = (v) => { const l = v.body.linvel(); return Math.hypot(l.x, l.z); };
function setSpeedFwd(v, kmh) { const f = v.ax.f; v.body.setLinvel({ x: f[0] * kmh / KMH, y: 0, z: f[2] * kmh / KMH }, true); }
function cruise(target) { return (t, v) => ({ throttle: Math.max(0, Math.min(1, (target / KMH - v.state.vf) * 2.5)), brake: Math.max(0, Math.min(1, (v.state.vf - target / KMH) * 0.5)), steer: 0, handbrake: 0 }); }

// ---- measurements ----
function measureAccel(id) {
  const { v } = scene(id); settle(v);
  let t100 = NaN, top = 0, x0 = v.body.translation().z, maxYaw = 0;
  run(v, 70, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }), (t) => {
    top = Math.max(top, v.state.kmh); if (Number.isNaN(t100) && v.state.kmh >= 100) t100 = t;
    maxYaw = Math.max(maxYaw, Math.abs(v.body.angvel().y));
  });
  return { t100, top, ok: !v.broken, drift: Math.abs(v.body.translation().x - X0) };
}
function measureBrake(id, road = null, noJolt = false) { // noJolt: roughResponse 0 = isolate the grip effect from the pothole jolts
  const { v, profile } = scene(id, { road, profileEdit: noJolt ? (p) => { p.roughResponse = 0; } : null }); settle(v);
  const from = Math.min(100, profile.topSpeed * 0.9); setSpeedFwd(v, from);
  const z0 = v.body.translation().z; let dist = NaN;
  run(v, 12, () => ({ throttle: 0, brake: 1, steer: 0, handbrake: 0 }), () => { if (Number.isNaN(dist) && v.state.kmh < 2) dist = Math.abs(v.body.translation().z - z0); });
  return { from, dist };
}
function fitCircle(pts) { // Kasa least squares -> { r, cx, cz }
  let sx = 0, sz = 0, n = pts.length; for (const p of pts) { sx += p[0]; sz += p[1]; } const mx = sx / n, mz = sz / n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) { const u = p[0] - mx, w = p[1] - mz; suu += u * u; suv += u * w; svv += w * w; suuu += u * u * u; svvv += w * w * w; suvv += u * w * w; svuu += w * u * u; }
  const det = suu * svv - suv * suv, a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
  return { r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n), cx: uc + mx, cz: vc + mz };
}
function measureTurn(id) {
  const { v } = scene(id); settle(v);
  const pts = []; const ctl = cruise(10);
  run(v, 30, (t, vv) => ({ ...ctl(t, vv), steer: 1 }), (t, vv) => { if (t > 12 && Math.round(t / DT) % 12 === 0) { const p = vv.body.translation(); pts.push([p.x, p.z]); } });
  const c = fitCircle(pts);
  return { dia: 2 * c.r, ok: !v.broken && upY(v) > 0.8 };
}
function measureRoll(id) {
  const { v } = scene(id); settle(v);
  const ctl = cruise(60); let roll = 0, lat = 0, n = 0, maxRoll = 0;
  run(v, 12, (t, vv) => ({ ...ctl(t, vv), steer: t > 4 ? 1 : 0 }), (t, vv) => {
    const r = Math.asin(Math.max(-1, Math.min(1, vv.ax.l[1]))) * 180 / Math.PI; // how far the car's left axis tilts out of the horizontal
    maxRoll = Math.max(maxRoll, Math.abs(r));
    if (t > 8) { roll += Math.abs(r); lat += Math.abs(vv.state.vf * vv.body.angvel().y) / G; n++; }
  });
  return { roll: roll / n, lat: lat / n, ok: !v.broken && upY(v) > 0.5 };
}
function holdsCircle(id, kmh, R = 30, classId = 6) {
  const { v } = scene(id, { classId, at: { x: X0, y: 0.15, z: Z0, yaw: 0 } }); settle(v, 0.5);
  const cx = X0 - R, cz = Z0; // circle centre to the car's right (-X when facing +Z)
  setSpeedFwd(v, kmh);
  let maxErr = 0, minUp = 1, vmin = 1e9, vmax = 0;
  const spd = cruise(kmh);
  const ok = run(v, 10, (t, vv) => {
    const p = vv.body.translation(), f = vv.ax.f, fl = Math.hypot(f[0], f[2]) || 1, fx = f[0] / fl, fz = f[2] / fl;
    const rx = p.x - cx, rz = p.z - cz, d = Math.hypot(rx, rz), e = d - R, rhx = rx / d, rhz = rz / d, tx = -rhz, tz = rhx;
    const rightX = -fz, rightZ = fx, hErr = Math.asin(Math.max(-1, Math.min(1, tx * rightX + tz * rightZ)));
    const vv0 = Math.max(vv.state.vf, 1);
    const delta = Math.atan(vv.wheelbase / R) + hErr + Math.atan(0.7 * e / (vv0 + 2));
    const steer = Math.max(-1, Math.min(1, delta / vv.steerLock(vv0)));
    return { ...spd(t, vv), steer, handbrake: 0 };
  }, (t, vv) => { if (t > 3) { const p = vv.body.translation(); maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x - cx, p.z - cz) - R)); minUp = Math.min(minUp, upY(vv)); vmin = Math.min(vmin, vv.state.kmh); } });
  return ok && maxErr < 3 && minUp > 0.35 && vmin > kmh * 0.8;
}
function measureCorner(id, vStart, classId = 6) {
  let best = 0;
  for (let k = vStart; k <= 170; k += 5) { if (holdsCircle(id, k, 30, classId)) best = k; else if (k > best + 10) break; }
  return { kmh: best, lat: (best / KMH) ** 2 / 30 / G };
}
function measureDrop(id, h) {
  const { v, profile } = scene(id, { at: { x: X0, y: h, z: Z0, yaw: 0 } });
  let minY = 1e9, maxUpV = 0, impact = false, minLen = [9, 9, 9, 9], bounceTop = 0, landed = false;
  const ok = run(v, 7, null, (t, vv) => {
    const p = vv.body.translation(), lv = vv.body.linvel(); minY = Math.min(minY, vv.lowestHullY());
    if (vv.nContact > 0) landed = true;
    if (landed) { maxUpV = Math.max(maxUpV, lv.y); bounceTop = Math.max(bounceTop, lv.y > 0 ? p.y : 0); }
    for (let i = 0; i < 4; i++) if (vv.contact[i]) minLen[i] = Math.min(minLen[i], vv.len[i]);
  });
  const use = Math.max(...minLen.map((l, i) => v.staticLen[i] - l));
  return { ok: ok && upY(v) > 0.9, minY, use, bounceV: maxUpV, settled: planar(v) < 0.3 && Math.abs(v.body.linvel().y) < 0.2, restY: v.body.translation().y };
}
function placeOnSlope(v, a, sAlong) { // car on the wedge (low edge at Z0), nose uphill, `sAlong` metres up the slope
  v.resetAt(X0, sAlong * Math.sin(a) + 0.25, Z0 + sAlong * Math.cos(a), 0);
  v.body.setRotation({ x: -Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, true);
}
function measureClimb(id, angle = 30) { // from rest ON the slope, full throttle, 8 s: slope distance gained
  const a = angle * Math.PI / 180, wedge = { x: X0, z0: Z0, width: 14, angleDeg: angle, length: 400 };
  const { v } = scene(id, { wedge }); placeOnSlope(v, a, 6);
  let minUp = 1; const p0 = v.body.translation();
  const ok = run(v, 8, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }), () => { minUp = Math.min(minUp, v.ax.u[1] / Math.cos(0)); });
  const p1 = v.body.translation(), dist = Math.hypot(p1.y - p0.y, p1.z - p0.z);
  return { dist: p1.z > p0.z ? dist : 0, endKmh: v.state.kmh, ok: ok && !v.broken, flipped: upY(v) < 0.2 };
}
function measureT60(id, classId, road = null) { // seconds to 60 km/h on a surface class (30 s cap when it never gets there)
  const { v } = scene(id, { classId, road }); settle(v);
  let t60 = 30;
  run(v, 30, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }), (t) => { if (t60 === 30 && v.state.kmh >= 60) t60 = t; });
  return t60;
}
function measureSlope(id, angle = 15) {
  const wedge = { x: X0, z0: Z0, width: 14, angleDeg: angle, length: 60 }, a = angle * Math.PI / 180;
  const out = {};
  for (const mode of ['hb', 'none']) {
    const { v } = scene(id, { wedge }); placeOnSlope(v, a, 10);
    const inp = mode === 'hb' ? { throttle: 0, brake: 0, steer: 0, handbrake: 1 } : NONE;
    run(v, 3, () => inp); const p0 = v.body.translation();
    let jit = 0; run(v, 8, () => inp, () => { jit = Math.max(jit, Math.abs(v.body.linvel().y)); });
    const p1 = v.body.translation(); out[mode] = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z); out[mode + 'Jit'] = jit; out.up = upY(v); out.y = p1.y;
  }
  return out;
}
function measureFlatStability(id) { // full throttle + full lock from rest, then a flick at 100 km/h
  const { v } = scene(id); settle(v);
  let minUp = 1, finite = true;
  run(v, 10, () => ({ throttle: 1, brake: 0, steer: 1, handbrake: 0 }), () => { minUp = Math.min(minUp, upY(v)); });
  finite = !v.broken;
  const s2 = scene(id); settle(s2.v); setSpeedFwd(s2.v, Math.min(100, s2.profile.topSpeed * 0.8));
  let minUp2 = 1; const sp = Math.min(100, s2.profile.topSpeed * 0.8);
  run(s2.v, 6, (t, vv) => ({ ...cruise(sp)(t, vv), steer: t < 2 ? 1 : t < 4 ? -1 : 0 }), () => { minUp2 = Math.min(minUp2, upY(s2.v)); });
  return { minUp, minUpFlick: minUp2, ok: finite && !s2.v.broken };
}
function flickUp(id, assist, sp) { // min up.y during a hard steering reversal at `sp` km/h
  const { v } = scene(id, { profileEdit: (p) => { p.assist = assist; } }); settle(v); setSpeedFwd(v, sp);
  let m = 1; run(v, 6, (t, vv) => ({ ...cruise(sp)(t, vv), steer: t < 2 ? 1 : t < 4 ? -1 : 0 }), () => { m = Math.min(m, upY(v)); });
  return m;
}
function measureRest(id) { // parked on flat ground: jitter + sag
  const { v } = scene(id); settle(v, 2); let vmax = 0, ymin = 9, ymax = -9;
  run(v, 4, null, () => { vmax = Math.max(vmax, v.state.speed); const y = v.body.translation().y; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); });
  return { jitter: ymax - ymin, vmax, restY: v.body.translation().y };
}

// ---- run ----
const REQUIRED = ['sports', 'muscle', 'sedan', 'suv', 'pickup', 'van', 'bus', 'monster-truck', 'limousine', 'firetruck'];
const wanted = typeof opt('cars') === 'string' ? opt('cars').split(',') : REQUIRED;
const R = {}; const fails = []; let t0 = performance.now();
const check = (c, m) => { if (!c) { fails.push(m); console.log('FAIL: ' + m); } else console.log('ok    ' + m); };
const fx = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

// ---- road surfaces ----
function measureBumps(id, surface, { deckBelow = 0 } = {}) { // 200 m at 80 km/h: RMS of the chassis vertical acceleration, max height gain, shake
  const { v } = scene(id, { road: surface, deckBelow }); settle(v);
  const y0 = v.body.translation().y, ctl = cruise(80); setSpeedFwd(v, 80);
  let vy = v.body.linvel().y, s2 = 0, n = 0, ymax = y0, shake = 0, minUp = 1, nan = false;
  const ok = run(v, 9, ctl, (t) => {
    const l = v.body.linvel(); if (t > 0.5) { const a = (l.y - vy) / DT; s2 += a * a; n++; }
    vy = l.y; ymax = Math.max(ymax, v.body.translation().y); shake = Math.max(shake, v.state.shake); minUp = Math.min(minUp, upY(v));
  });
  return { rms: Math.sqrt(s2 / n), gain: ymax - y0, shake, ok: ok && !v.broken, minUp, rs: v.state.roadSurface, grip: v.wGrip.slice(), dist: 0 };
}
function measureParked(id, surface) { // settle, then 6 s with no input: creep / jitter / shake
  const { v } = scene(id, { road: surface }); settle(v, 2.5);
  const p0 = v.body.translation(); let vmax = 0, ymin = 9, ymax = -9, shake = 0;
  run(v, 6, null, () => { vmax = Math.max(vmax, v.state.speed); const y = v.body.translation().y; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); shake = Math.max(shake, v.state.shake); });
  const p1 = v.body.translation();
  return { jitter: ymax - ymin, vmax, creep: Math.hypot(p1.x - p0.x, p1.z - p0.z), shake };
}
function roadTests() {
  console.log('\n--- road surfaces (real roads data through loadMapFromData; surfaceAt gripMul smooth 1 / potholes 0.9 / gravel 0.7)');
  const ids = ['sports', 'sedan', 'bus', 'monster-truck'], Rd = {};
  for (const id of ids) {
    const t1 = performance.now(), r = Rd[id] = {};
    r.bS = measureBrake(id, 'smooth').dist; r.bG = measureBrake(id, 'gravel').dist; r.bG0 = measureBrake(id, 'gravel', true).dist; r.tS = measureT60(id, 6, 'smooth'); r.tG = measureT60(id, 6, 'gravel');
    r.pS = measureBumps(id, 'smooth'); r.pP = measureBumps(id, 'potholes'); r.pG = measureBumps(id, 'gravel');
    r.parkP = measureParked(id, 'potholes'); r.parkG = measureParked(id, 'gravel');
    console.log(`  ${id}: brake100 smooth ${fx(r.bS)} m, gravel ${fx(r.bG)} m (x${fx(r.bG / r.bS, 2)}; grip only, no jolts ${fx(r.bG0)} m x${fx(r.bG0 / r.bS, 2)}); 0-60 smooth ${fx(r.tS)} s, gravel ${fx(r.tG)} s (x${fx(r.tG / r.tS, 2)}); ` +
      `vert accel RMS@80 smooth ${fx(r.pS.rms, 2)} potholes ${fx(r.pP.rms, 2)} gravel ${fx(r.pG.rms, 2)} m/s2 (x${fx(r.pP.rms / r.pS.rms, 1)} / x${fx(r.pG.rms / r.pS.rms, 1)}); ` +
      `max height gain ${fx(r.pP.gain * 100)} cm (shake ${fx(r.pP.shake, 2)}); parked potholes ${fx(r.parkP.creep * 100, 2)} cm creep ${fx(r.parkP.jitter * 1000, 2)} mm jitter, gravel ${fx(r.parkG.creep * 100, 2)} cm ${fx(r.parkG.jitter * 1000, 2)} mm (${fx((performance.now() - t1) / 1000)} s)`);
    check(r.pS.rs === 'smooth' && r.pP.rs === 'potholes' && r.pG.rs === 'gravel', `${id}: state.roadSurface reads smooth / potholes / gravel (${r.pS.rs} / ${r.pP.rs} / ${r.pG.rs})`);
    check(r.bG0 > r.bS * 1.05 && r.bG > r.bS * 0.9, `${id}: 100->0 on gravel (grip effect, jolts off) ${fx(r.bG0)} m is longer than on smooth asphalt ${fx(r.bS)} m (x${fx(r.bG0 / r.bS, 2)} > 1.05); with jolts ${fx(r.bG)} m`);
    check(r.tG > r.tS * 1.02, `${id}: 0-60 on gravel ${fx(r.tG)} s is slower than on smooth asphalt ${fx(r.tS)} s (x${fx(r.tG / r.tS, 2)} > 1.02)`);
    check(r.pP.rms > r.pS.rms * 2 && r.pP.rms > 0.15, `${id}: potholes vertical-accel RMS ${fx(r.pP.rms, 2)} m/s2 > 2 x smooth ${fx(r.pS.rms, 2)} (x${fx(r.pP.rms / r.pS.rms, 1)})`);
    check(r.pP.ok && r.pG.ok && r.pP.minUp > 0.9, `${id}: no NaN / flip on a 200 m pothole + gravel run (min up.y ${fx(r.pP.minUp, 3)})`);
    check(r.pP.gain < 0.12 && r.pG.gain < 0.12, `${id}: no launch: max chassis height gain ${fx(r.pP.gain * 100)} cm (potholes) / ${fx(r.pG.gain * 100)} cm (gravel) < 12 cm`);
    check(r.pP.shake > 0.05 && r.parkP.shake < 1e-3 && r.parkG.shake < 1e-3, `${id}: camera shake ${fx(r.pP.shake, 2)} at 80 km/h on potholes, ${fx(r.parkP.shake, 4)} / ${fx(r.parkG.shake, 4)} parked`);
    for (const [n, k] of [['potholes', 'parkP'], ['gravel', 'parkG']]) check(r[k].jitter < 0.01 && r[k].vmax < 0.1 && r[k].creep < 0.05, `${id}: parked on ${n}: jitter ${fx(r[k].jitter * 1000, 2)} mm, max speed ${fx(r[k].vmax, 3)} m/s, creep ${fx(r[k].creep * 100, 2)} cm`);
  }
  const ratio = (id) => Rd[id].pP.rms / Rd[id].pS.rms;
  check(ratio('bus') < ratio('sports') && ratio('monster-truck') < ratio('sports') && Rd.bus.pP.rms < Rd.sports.pP.rms && Rd['monster-truck'].pP.rms < Rd.sports.pP.rms,
    `bus / monster absorb potholes better than sports: RMS ratio x${fx(ratio('bus'), 1)} / x${fx(ratio('monster-truck'), 1)} vs x${fx(ratio('sports'), 1)} (absolute ${fx(Rd.bus.pP.rms, 2)} / ${fx(Rd['monster-truck'].pP.rms, 2)} vs ${fx(Rd.sports.pP.rms, 2)} m/s2)`);
  // grip formula: wheel grip = classMult * (1 - (1 - gripMul) / max(offRoad, 1))
  { const g = (id, s) => { const { v } = scene(id, { road: s }); settle(v); return v.wGrip.reduce((a, b) => a + b) / 4; };
    const sedG = g('sedan', 'gravel'), monG = g('monster-truck', 'gravel'), spG = g('sports', 'gravel');
    check(Math.abs(sedG - 0.7) < 0.01 && Math.abs(spG - 0.7) < 0.01 && Math.abs(monG - (1 - 0.3 / 2.6)) < 0.01, `gravel wheel grip: sedan ${fx(sedG, 3)}, sports ${fx(spG, 3)} (= gripMul 0.7), monster ${fx(monG, 3)} (offRoad 2.6 softens it to ${fx(1 - 0.3 / 2.6, 3)})`); }
  // bridge deck: contact 3 m above heightAt over a gravel road -> smooth values, no road metadata of the ground below
  { const gv = measureBumps('sedan', 'gravel'), dk = measureBumps('sedan', 'gravel', { deckBelow: 3 }), sm = measureBumps('sedan', 'smooth');
    check(dk.rs === 'smooth' && dk.grip.every((x) => Math.abs(x - 1) < 1e-6) && dk.shake < 1e-3 && dk.rms < gv.rms * 0.6, `deck above a gravel road: roadSurface ${dk.rs}, wheel grip ${dk.grip.map((x) => fx(x, 2)).join('/')}, vertical RMS ${fx(dk.rms, 2)} (smooth ${fx(sm.rms, 2)}, gravel ${fx(gv.rms, 2)})`); }
}

// ---- free-look camera ----
function cameraTests() {
  console.log('\n--- free-look camera (pure maths + real ChaseCamera)');
  const cfg = { ...LOOK_DEFAULTS, sens: 0.002, invertY: false, idleDelay: 1.7 }, dt = 1 / 60;
  { const L = newLook(); stepLook(L, dt, { dy: 1e5 }, 0, cfg); const hi = L.pitch; stepLook(L, dt, { dy: -1e6 }, 0, cfg);
    check(hi === PITCH_MAX && L.pitch === PITCH_MIN && clampPitch(9) === PITCH_MAX && clampPitch(-9) === PITCH_MIN, `pitch clamp: ${fx(hi * 57.3)} .. ${fx(L.pitch * 57.3)} deg = [${fx(PITCH_MIN * 57.3)}, ${fx(PITCH_MAX * 57.3)}]`);
    const I = newLook(); stepLook(I, dt, { dy: 100 }, 0, { ...cfg, invertY: true }); const N0 = newLook(); stepLook(N0, dt, { dy: 100 }, 0, cfg);
    check(I.pitch < 0 && N0.pitch > 0, 'invert Y flips the pitch direction'); }
  { const L = newLook(); const full = 2 * Math.PI / cfg.sens; for (let i = 0; i < 100; i++) stepLook(L, dt, { dx: -full * 1.25 / 100 }, 0, cfg);
    const e = Math.abs(Math.atan2(Math.sin(L.yaw - Math.PI / 2), Math.cos(L.yaw - Math.PI / 2)));
    check(e < 1e-6 && Math.abs(L.yaw) <= Math.PI, `yaw is free through 360 deg and wraps: 1.25 turns right -> ${fx(L.yaw * 57.3)} deg (expected 90)`);
    check(Math.abs(Math.cos(wrapAngle(7 * Math.PI)) + 1) < 1e-9 && Math.abs(wrapAngle(-3.5 * Math.PI) - Math.PI / 2) < 1e-9, 'wrapAngle maps any angle into [-pi, pi)'); }
  { const run1 = (speed, secs, init = { yaw: 1.2, pitch: 0.3 }) => { const L = { ...newLook(), ...init }; for (let i = 0; i < Math.round(secs / dt); i++) stepLook(L, dt, {}, speed, cfg); return L; };
    const early = run1(20, 1.6), late = run1(20, 4.7), slow = run1(5, 4.7), fast = run1(25, 4.7), still = run1(0, 30), lowv = run1(1.5, 30);
    check(Math.abs(early.yaw - 1.2) < 1e-9, `no recentre before the idle delay (1.6 s < ${cfg.idleDelay} s): yaw ${fx(early.yaw, 3)}`);
    check(late.yaw < 1.2 * 0.8 && late.yaw > 0, `recentres after the delay at 72 km/h: 1.2 -> ${fx(late.yaw, 3)} rad after 4.7 s`);
    check(fast.yaw < slow.yaw && slow.yaw < 1.2 - 1e-6, `recentre rate grows with speed: after 3 s of recentring 5 m/s ${fx(slow.yaw, 3)}, 25 m/s ${fx(fast.yaw, 3)} (from 1.2)`);
    check(Math.abs(still.yaw - 1.2) < 1e-9 && Math.abs(still.pitch - 0.3) < 1e-9 && Math.abs(lowv.yaw - 1.2) < 1e-9, 'stationary / crawling: the camera stays where the player left it');
    const L = { ...newLook(), yaw: 1.2 }; for (let i = 0; i < 4 * 60; i++) stepLook(L, dt, {}, 20, cfg);
    const before = L.yaw; stepLook(L, dt, { dx: 1 }, 20, cfg); const idleAfter = L.idle; for (let i = 0; i < 90; i++) stepLook(L, dt, {}, 20, cfg);
    check(idleAfter === 0 && Math.abs(L.yaw - (before - cfg.sens)) < 1e-9, 'any mouse movement cancels the recentre immediately and it waits the full delay again');
    const S = { ...newLook(), yaw: 1 }; for (let i = 0; i < 5 * 60; i++) stepLook(S, dt, { sx: 0.5 }, 20, cfg);
    check(S.idle === 0, 'a deflected stick keeps the recentre off');
    const B = newLook(); for (let i = 0; i < 60; i++) stepLook(B, dt, { behind: true }, 20, cfg); const by = lookYaw(B);
    for (let i = 0; i < 60; i++) stepLook(B, dt, { behind: false }, 20, cfg);
    check(Math.abs(Math.abs(by) - Math.PI) < 1e-9 && Math.abs(lookYaw(B)) < 1e-9, `B snaps the yaw to 180 deg (${fx(by * 57.3)}) and eases back on release (${fx(lookYaw(B) * 57.3, 3)})`); }
  { const o = orbitOffset(1, 2, 3, 0, 0), q = orbitOffset(0, 0, -7, Math.PI, 0);
    check(Math.hypot(o[0] - 1, o[1] - 2, o[2] - 3) < 1e-9 && Math.hypot(q[0], q[2] - 7) < 1e-9, 'orbitOffset: zero look = identity, 180 deg yaw moves the camera to the other side of the car'); }
  // real ChaseCamera: never below heightAt + MARGIN, yaw offset kept while the car turns
  const cam = new THREE.PerspectiveCamera(62, 1.6, 0.4, 6000);
  const veh = { state: { speed: 20, vf: 20, slip: 0, shake: 0 }, steer: 0, vTop: 60, body: { linvel: () => ({ x: 0, y: 0, z: 20 }) } };
  const pose = (x, y, z, yaw) => ({ x, y, z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2) });
  { const hf = (x, z) => 0.8 * z + 4 * Math.sin(x * 0.2), ch = new ChaseCamera(THREE, cam, { heightAt: hf, dims: { length: 4.5, height: 1.4, width: 1.9 } });
    let worst = 1e9, n = 0;
    for (const yaw of [-3, -1.5, 0, 1.5, 3]) for (const pitch of [PITCH_MIN, 0, PITCH_MAX]) {
      ch.snap(pose(100, hf(100, 100) + 0.5, 100, 0), veh, { yaw, pitch });
      for (let i = 0; i < 90; i++) { ch.update(1 / 60, pose(100, hf(100, 100 + i * 0.01) + 0.5, 100 + i * 0.01, 0), veh, { yaw, pitch }); worst = Math.min(worst, cam.position.y - hf(cam.position.x, cam.position.z)); n++; }
    }
    check(worst >= MARGIN - 1e-6, `camera never below heightAt + ${MARGIN} m over a steep slope for yaw -3..3 x pitch ${fx(PITCH_MIN * 57.3, 0)}..${fx(PITCH_MAX * 57.3, 0)} deg (${n} frames, min margin ${fx(worst, 3)} m)`); }
  { const ch = new ChaseCamera(THREE, cam, { heightAt: () => 0, dims: { length: 4.5, height: 1.4, width: 1.9 } }), lk = { yaw: 0.8, pitch: 0.1 };
    const rel = (carYaw, p) => { const H = Math.atan2(p.x - cam.position.x, p.z - cam.position.z); return wrapAngle(H - carYaw); };
    let p = pose(100, 0, 100, 0); ch.snap(p, veh, lk); for (let i = 0; i < 200; i++) ch.update(1 / 60, p, veh, lk);
    const r0 = rel(0, p), x0 = cam.position.x;
    p = pose(100, 0, 100, 0.6); for (let i = 0; i < 300; i++) ch.update(1 / 60, p, veh, lk);
    const r1 = rel(0.6, p);
    check(Math.abs(r0 - 0.8) < 0.03 && Math.abs(r1 - 0.8) < 0.03 && Math.abs(cam.position.x - x0) > 1, `yaw offset kept relative to the car while it turns: look 0.8 rad -> view offset ${fx(r0, 3)} before / ${fx(r1, 3)} after a 0.6 rad turn (camera moved ${fx(cam.position.x - x0, 1)} m)`); }
}

// smoke: every drivable car builds, settles, drives, turns without NaN
const drivable = manifest.cars.filter((c) => c.drivable).map((c) => c.id);
cameraTests();
if (opt('road-only')) { roadTests(); console.log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)} s, ${fails.length} failed`); if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; } process.exit(fails.length ? 1 : 0); }
if (!opt('quick')) for (const id of drivable) {
  const { v } = scene(id); const okS = settle(v, 1.5);
  const rest = v.body.translation().y; const ok = run(v, 6, (t) => ({ throttle: 1, brake: 0, steer: t > 3 ? 1 : 0, handbrake: 0 }));
  check(okS && ok && !v.broken && upY(v) > 0.5 && Math.abs(rest) < 0.12, `smoke ${id} (${archetypeOf(id)}): builds, rests at y=${rest.toFixed(3)}, drives + turns, upright, no NaN`);
}
console.log(`smoke done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (opt('smoke-only')) process.exit(fails.length ? 1 : 0);

for (const id of wanted) {
  const t1 = performance.now();
  const r = R[id] = { id, arch: archetypeOf(id), mass: resolveProfile(cars[id]).mass };
  Object.assign(r, measureAccel(id)); Object.assign(r, { brake: measureBrake(id) }); r.turn = measureTurn(id); r.roll = measureRoll(id);
  r.corner = measureCorner(id, 20); r.cornerDirt = measureCorner(id, 20, 2); r.cornerSand = measureCorner(id, 10, 3); r.d3 = measureDrop(id, 3); r.d10 = measureDrop(id, 10); r.climb = measureClimb(id, 30);
  r.t60 = measureT60(id, 6); r.t60dirt = measureT60(id, 2); r.t60sand = measureT60(id, 3);
  r.flick0 = flickUp(id, 0, Math.min(100, resolveProfile(cars[id]).topSpeed * 0.8)); r.slope = measureSlope(id); r.stab = measureFlatStability(id); r.rest = measureRest(id);
  console.log(`measured ${id} in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
}

// ---- table ----
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const rows = wanted.map((id) => { const r = R[id]; return [id, r.arch, Math.round(r.mass), f(r.t100), f(r.top, 0), f(r.brake.dist), f(r.turn.dia), f(r.corner.kmh, 0) + '/' + f(r.corner.lat, 2), f(r.cornerDirt.kmh, 0) + '/' + f(r.cornerSand.kmh, 0), f(r.roll.roll) + '/' + f(r.roll.lat, 2), f(r.d3.use, 2), f(r.d10.bounceV, 1), f(r.climb.dist, 1), f(r.t60dirt / r.t60, 2), f(r.t60sand / r.t60, 2), f(r.t60sand), f(r.slope.hb * 100, 1) + '/' + f(r.slope.none * 100, 1), f(Math.min(r.stab.minUp, r.stab.minUpFlick), 2), f(r.flick0, 2)]; });
const head = ['car', 'arch', 'kg', '0-100s', 'top', 'brk100m', 'turnDia', 'cornerKmh/g', 'dirt/sand', 'roll60/g', 'suspUse3m', 'bounceV10', 'climb30m', 'dirt60 x', 'sand60 x', 'sand0-60s', 'creep cm hb/none', 'minUp', 'flick@a0'];
const wd = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
console.log('\n' + head.map((h, i) => h.padEnd(wd[i])).join('  '));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(wd[i])).join('  '));

// ---- assertions ----
console.log('');
const band = (id, key, lo, hi, what, get = (r) => r[key]) => { const v = get(R[id]); check(v >= lo && v <= hi, `${id} ${what} ${f(v)} in [${lo}, ${hi}]`); };
if (!opt('cars')) {
  band('sports', 't100', 3.5, 5.5, '0-100 s'); band('muscle', 't100', 4.5, 6.5, '0-100 s'); band('sedan', 't100', 7, 10.5, '0-100 s');
  band('suv', 't100', 8.5, 12.5, '0-100 s'); band('pickup', 't100', 8.5, 12.5, '0-100 s'); band('van', 't100', 11, 16, '0-100 s');
  band('bus', 't100', 15, 23, '0-100 s'); band('monster-truck', 't100', 5.5, 9.5, '0-100 s');
  band('sports', 'top', 195, 240, 'top km/h'); band('muscle', 'top', 175, 205, 'top km/h'); band('sedan', 'top', 145, 175, 'top km/h');
  band('suv', 'top', 125, 155, 'top km/h'); band('van', 'top', 115, 145, 'top km/h'); band('bus', 'top', 95, 112, 'top km/h'); band('monster-truck', 'top', 105, 135, 'top km/h');
  band('sports', 'x', 9, 13, 'turn dia m', (r) => r.turn.dia); band('sedan', 'x', 10, 14, 'turn dia m', (r) => r.turn.dia); band('bus', 'x', 20, 40, 'turn dia m', (r) => r.turn.dia);
  band('limousine', 'x', 18, 40, 'turn dia m', (r) => r.turn.dia); band('monster-truck', 'x', 13, 17.5, 'turn dia m', (r) => r.turn.dia);
  check(R.bus.t100 / R.sports.t100 >= 3, `bus/sports 0-100 ratio ${f(R.bus.t100 / R.sports.t100, 2)} >= 3`);
  check(R['monster-truck'].d3.use / R.sports.d3.use >= 2.5, `monster/sports suspension use ratio ${f(R['monster-truck'].d3.use / R.sports.d3.use, 2)} >= 2.5`);
  check(R.bus.turn.dia / R.sports.turn.dia >= 1.7, `bus/sports turning circle ratio ${f(R.bus.turn.dia / R.sports.turn.dia, 2)} >= 1.7`);
  const slow = (id, k) => R[id][k] / R[id].t60;
  check(R['monster-truck'].t60sand <= R.sports.t60sand && slow('monster-truck', 't60sand') < slow('sports', 't60sand') * 0.85 && R.sports.cornerSand.kmh < R['monster-truck'].cornerSand.kmh, `monster sand advantage: 0-60 on sand ${f(R['monster-truck'].t60sand)} s (x${f(slow('monster-truck', 't60sand'), 2)} vs road) vs sports ${f(R.sports.t60sand)} s (x${f(slow('sports', 't60sand'), 2)}); 30 m circle on sand ${R['monster-truck'].cornerSand.kmh} vs ${R.sports.cornerSand.kmh} km/h`);
  check(slow('sports', 't60dirt') > slow('suv', 't60dirt') && slow('sports', 't60dirt') > slow('monster-truck', 't60dirt'), `dirt hurts sports (x${f(slow('sports', 't60dirt'), 2)} 0-60) more than SUV (x${f(slow('suv', 't60dirt'), 2)}) and monster (x${f(slow('monster-truck', 't60dirt'), 2)})`);
  check(['sports', 'muscle', 'sedan', 'suv', 'van', 'bus', 'limousine', 'firetruck'].every((o) => R['monster-truck'].climb.dist > R[o].climb.dist * 1.1), `monster climbs 30 deg (${f(R['monster-truck'].climb.dist)} m in 10 s from rest) further than sports/muscle/sedan/SUV/van/bus (${['sports', 'muscle', 'sedan', 'suv', 'van', 'bus'].map((o) => f(R[o].climb.dist)).join('/')} m)`);
  check(R['monster-truck'].flick0 < 0.3 && R.sports.flick0 > 0.5, `top-heavy: with assist 0 the monster truck rolls over in a 96 km/h flick (min up.y ${f(R['monster-truck'].flick0, 2)}), sports does not (${f(R.sports.flick0, 2)}); sedan ${f(R.sedan.flick0, 2)}, bus ${f(R.bus.flick0, 2)}`);
  check(R.bus.roll.roll > R.sports.roll.roll, `bus rolls more than sports at 60 km/h (${f(R.bus.roll.roll)} vs ${f(R.sports.roll.roll)} deg)`);
  check(R.sports.corner.lat > R.bus.corner.lat && R.sports.corner.lat > R.van.corner.lat, `sports corners harder (${f(R.sports.corner.lat, 2)} g) than van (${f(R.van.corner.lat, 2)}) and bus (${f(R.bus.corner.lat, 2)})`);
  check(R.bus.brake.dist > R.sports.brake.dist, `bus brakes longer than sports (${f(R.bus.brake.dist)} vs ${f(R.sports.brake.dist)} m)`);
  check(R.firetruck.mass > R.bus.mass * 0.9 || R.firetruck.mass > 10000, `firetruck very heavy (${R.firetruck.mass} kg)`);
}
for (const id of wanted) {
  const r = R[id];
  check(r.ok && r.stab.ok && r.d3.ok && r.d10.ok, `${id}: no NaN / explosion, upright after drops, full-lock throttle and flick`);
  check(r.d10.minY > -0.12 && r.d10.settled, `${id}: 10 m drop: chassis box never below the ground (lowest point ${f(r.d10.minY, 2)} m) and settles (${r.d10.settled})`);
  check(r.d10.bounceV < 6, `${id}: 10 m drop rebound speed ${f(r.d10.bounceV)} m/s < 6 (no launch)`);
  check(r.stab.minUp > 0.7, `${id}: no flipping on flat ground at full throttle + full lock from rest (min up.y ${f(r.stab.minUp, 2)})`);
  console.log(`   ${id}: slope up.y ${f(r.slope.up, 3)} (15 deg = 0.966), y ${f(r.slope.y, 2)}, jitter hb ${f(r.slope.hbJit, 4)} none ${f(r.slope.noneJit, 4)}`);
  check(r.slope.hb < 0.15 && r.slope.none < 0.35, `${id}: parked on 15 deg: creep ${f(r.slope.hb * 100)} cm with handbrake, ${f(r.slope.none * 100)} cm without`);
  check(r.rest.jitter < 0.01 && r.rest.vmax < 0.1, `${id}: parked jitter ${f(r.rest.jitter * 1000)} mm, max speed ${f(r.rest.vmax, 3)} m/s`);
}
roadTests();
console.log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)} s, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
