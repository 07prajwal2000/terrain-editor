// Headless vehicle test: `npm run test:vehicles` (options: --cars sports,bus   --smoke-only   --sample   --verbose)
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
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMapFromData } from '../src/world/mapLoader.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { resolveProfile, archetypeOf } from '../src/vehicles/handling.js';
import { addWedgeCollider, wedgePoints } from '../src/vehicles/wedge.js';

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
function scene(id, { classId = 6, wedge = null, profileEdit = null, at = null } = {}) {
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  const map = loadMapFromData(flatMapData(classId), { THREE, RAPIER, physicsWorld: world, physicsResolution: 8 });
  // the real surfaceAt calls a splat 'road' pixel grass when no road mesh is there, so the test pins the class instead
  const fixed = { classId, weights: Float32Array.from({ length: 8 }, (_, i) => (i === classId ? 1 : 0)) };
  map.surfaceAt = () => fixed;
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
function measureBrake(id) {
  const { v, profile } = scene(id); settle(v);
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
function measureT60(id, classId) { // seconds to 60 km/h on a surface class (30 s cap when it never gets there)
  const { v } = scene(id, { classId }); settle(v);
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

// smoke: every drivable car builds, settles, drives, turns without NaN
const drivable = manifest.cars.filter((c) => c.drivable).map((c) => c.id);
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
console.log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)} s, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
