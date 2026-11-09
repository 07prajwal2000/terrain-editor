// Node checks for road node metadata: `npm run test:roads`.
// Synthetic maps with KNOWN geometry (arcs of known radius, ramps of known grade) -> automatic sign generation (count, type, distance
// before the curve, driver's side, shoulder offset, gaps at junctions / bridges / city / signs:off), Rapier colliders for edges / bump /
// roadworks, surfaceAt extras, oneway, back-compat with the old maps, and loadMapFromData / updateRegion == loadMap(url) on roadmeta.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, loadMapFromData, decodePNG } from '../src/world/mapLoader.js';
import { SIGN_CFG } from '../src/world/roadSigns.js';

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; process.exitCode = 1; } else console.log('ok   ' + m); };
await RAPIER.init();

// ---------------------------------------------------------------- synthetic map helpers
const W = 4000, N = 512, MAXH = 200;
const CLASSES = ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'].map((color, id) => ({ id, name: String(id), color }));
const ramp = (x, z) => { // road 2 band (z 1900..2100): flat 20, +10% up x 500..800, flat, -10% down x 1100..1400
  if (z < 1850 || z > 2150) return 20;
  return x < 500 ? 20 : x < 800 ? 20 + 0.1 * (x - 500) : x < 1100 ? 50 : x < 1400 ? 50 - 0.1 * (x - 1100) : 20;
};
function mkData(roads, extraInfo = {}, hfn = ramp) {
  const cell = W / N, h = new Uint16Array(N * N), s0 = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { h[j * N + i] = Math.round(hfn((i + 0.5) * cell, (j + 0.5) * cell) / MAXH * 65535); s0[(j * N + i) * 4] = 255; }
  return { info: { N, worldSizeMeters: W, maxHeightMeters: MAXH, seaLevel: 0, seaLevelMeters: -5, classes: CLASSES, ...extraInfo }, height: h, splat0: s0, splat1: new Uint8Array(N * N * 4), water: new Uint16Array(N * N), roads: { roads } };
}
// path generator: segments [{ straight: m } | { arc: { R, deg, dir: -1 left | +1 right } }], control point every `step` m
function genPath(x, z, heading, segs, step = 10) {
  const pts = [{ x, z }], marks = []; let len = 0;
  for (const sg of segs) {
    const L = sg.straight ?? (sg.arc.R * sg.arc.deg * Math.PI / 180), n = Math.max(1, Math.round(L / step)), ds = L / n;
    marks.push({ start: len, end: len + L, ...sg });
    for (let i = 0; i < n; i++) {
      if (sg.arc) heading += sg.arc.dir * ds / sg.arc.R / 2;
      x += Math.cos(heading) * ds; z += Math.sin(heading) * ds;
      if (sg.arc) heading += sg.arc.dir * ds / sg.arc.R / 2;
      pts.push({ x, z });
    }
    len += L;
  }
  return { pts, marks, length: len };
}
const road = (id, width, pts, meta = {}) => ({ id, widthMeters: width, points: pts.map((p, i) => ({ x: p.x, y: 20, z: p.z, bridge: false, ...(typeof meta === 'function' ? meta(i, p, pts) : meta) })) });
const S = (n) => ({ straight: n }), A = (R, deg, dir) => ({ arc: { R, deg, dir } });
const world = () => new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const cross = (s) => ({ side: (s.x - s.cx) * 0 }); void cross;
const along = (rd, sg) => { // signed lateral offset of a sign from the road centreline (+ = right of travel) and arc position of the nearest centreline point
  const pts = rd.getPoints(1); let best = null;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i].x - sg.x, pts[i].z - sg.z); if (!best || d < best.d) best = { d, i }; }
  const q = pts[best.i], fx = sg.fx, fz = sg.fz, lat = (sg.x - q.x) * -fz + (sg.z - q.z) * fx;
  let s = 0; for (let i = 1; i <= best.i; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return { lat, s, total: pts.reduce((a, p, i) => a + (i ? Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0) };
};

// ---------------------------------------------------------------- 1. automatic signs on known geometry
console.log('--- signs');
const p1 = genPath(100, 1000, 0, [S(400), A(100, 50, -1), S(400), A(20, 90, 1), S(400), A(100, 45, -1), S(60), A(100, 45, 1), S(300)]);
const p2 = genPath(100, 2000, 0, [S(1500)]);
const scene = (z, meta = {}) => genPath(100, z, 0, [S(300), A(80, 60, -1), S(200)]);
const sc = { A: scene(2400), B: scene(2600), C: scene(2800), D: scene(3000), E: scene(3200), F: scene(3400) };
const crossRoad = { pts: [{ x: 345, z: 3100 }, { x: 345, z: 3200 }, { x: 345, z: 3300 }] }; // N-S road crossing scene E exactly at the sign spot (road starts at x=100, sign at s=245 -> x=345)
const roads1 = [
  road(1, 8, p1.pts), road(2, 8, p2.pts), road(3, 8, sc.A.pts),
  road(4, 8, sc.B.pts, { type: 'city' }),
  road(5, 8, sc.C.pts),
  road(6, 8, sc.D.pts),
  road(7, 8, sc.E.pts), road(8, 8, crossRoad.pts),
  road(9, 8, sc.F.pts, { oneway: true }),
];
// scene C: signs off on the segments around the sign spot (x ~ 345); scene D: a bridge covering it
roads1[4].points.forEach((p) => { if (p.x > 300 && p.x < 390) p.signs = 'off'; });
roads1[5].points.forEach((p) => { p.bridge = p.x > 290 && p.x < 400; });
{
  const map = loadMapFromData(mkData(roads1), { THREE, physics: false });
  const signs = map.roadDetail.signs, byRoad = (id) => signs.filter((s) => s.roadId === id);
  const rd = (id) => map.roads.find((r) => r.id === id);
  console.log('     signs:', signs.map((s) => `${s.roadId}${s.dir > 0 ? '+' : '-'}${s.type}${s.grade ? s.grade : ''}@${s.s.toFixed(0)}`).join(' '));
  const f = byRoad(1).filter((s) => s.dir > 0);
  assert(f.map((s) => s.type).join() === 'curveL,sharpR,winding', 'road 1 forward: gentle left, sharp right, S-bend (one sign) -> ' + f.map((s) => s.type).join());
  assert(byRoad(1).filter((s) => s.dir < 0).map((s) => s.type).join() === 'winding,sharpL,curveR', 'road 1 reverse: S-bend, sharp left, gentle right -> ' + byRoad(1).filter((s) => s.dir < 0).map((s) => s.type).join());
  // distance before the curve start along the road (true geometric start from the generator)
  const starts = [p1.marks[1].start, p1.marks[3].start, p1.marks[5].start];
  f.forEach((s, i) => {
    const d = starts[i] - s.s;
    assert(d >= 47 && d <= 63, `road 1 sign ${s.type}: ${d.toFixed(1)} m before the true curve start (spec 50..60, spline blending +-5 m)`);
    assert(Math.abs(s.trigger - s.s - SIGN_CFG.SIGN_BEFORE_M) < 1.5, `road 1 sign ${s.type}: ${(s.trigger - s.s).toFixed(1)} m before the detected start (55 m)`);
    const a = along(rd(1), s);
    assert(Math.abs(a.lat - (4 + SIGN_CFG.SHOULDER_OFFSET)) < 0.05, `road 1 sign ${s.type}: right side, ${a.lat.toFixed(2)} m from the centreline (half width 4 + 0.7)`);
    assert(Math.abs(s.nx * s.fx + s.nz * s.fz + 1) < 1e-9, `road 1 sign ${s.type}: faces oncoming traffic (normal = -travel)`);
  });
  const hills = byRoad(2);
  assert(hills.map((s) => (s.dir > 0 ? '+' : '-') + s.type + s.grade).sort().join() === '+hillDown10,+hillUp10,-hillDown10,-hillUp10', 'road 2: steep climb + descent, both directions, grade 10% -> ' + hills.map((s) => s.type + s.grade).join());
  const up = hills.find((s) => s.dir > 0 && s.type === 'hillUp');
  assert(up && up.trigger - up.s > 50 && up.trigger - up.s < 60 && Math.abs(up.trigger - 400) < 10, `hill sign 55 m before the section (section start s=${up && up.trigger.toFixed(0)}, ramp starts at s=400 = x 500)`);
  const a = signs.filter((s) => s.roadId === 3).sort((p, q) => p.dir - q.dir);
  assert(a.length === 2 && a[1].type === 'curveL' && a[0].type === 'curveR', 'scene A (control): left curve forward, right curve in reverse');
  assert(byRoad(4).length === 0, 'scene B (city stretch): no signs');
  assert(byRoad(5).filter((s) => s.dir > 0).length === 0, 'scene C (signs: off on the segment): no forward sign (' + byRoad(5).length + ' total, reverse sign is on an auto segment)');
  assert(byRoad(6).filter((s) => s.dir > 0).length === 0, 'scene D (bridge under the sign spot): no forward sign');
  assert(byRoad(7).filter((s) => s.dir > 0).length === 0 && map.junctions.length >= 1, `scene E (junction at the sign spot): no forward sign inside the junction disc (${map.junctions.length} junction(s))`);
  for (const sg of signs) for (const j of map.junctions) { const d = Math.hypot(sg.x - j.x, sg.z - j.z); if (d < j.radius) assert(false, 'sign inside junction disc ' + d); }
  const f9 = byRoad(9); assert(f9.length === 1 && f9[0].dir > 0, 'scene F (oneway): only the forward sign, none for the opposite direction');
  // sign meshes exist and are instanced
  const names = []; map.parts.roadSigns.traverse((o) => { if (o.isInstancedMesh) names.push(o.name + 'x' + o.count); });
  console.log('     sign meshes:', names.join(' '), '| signs draw calls', map.roadDetail.counts.signDrawCalls);
  assert(map.roadDetail.counts.signDrawCalls <= 16 && map.roadDetail.counts.signInstances >= signs.length, 'signs are instanced into a handful of draw calls');
  map.dispose();
}
{ // left-hand traffic: driver's side = left edge; EU style is a render option only
  const map = loadMapFromData(mkData([road(3, 8, sc.A.pts)], { driveSide: 'left', signStyle: 'eu' }), { THREE, physics: false });
  const s = map.roadDetail.signs.find((q) => q.dir > 0), a = along(map.roads[0], s);
  assert(map.info.driveSide === 'left' && map.info.signStyle === 'eu', 'map.info carries driveSide / signStyle');
  assert(Math.abs(a.lat + 4.7) < 0.05, `driveSide left: sign on the left edge (lat ${a.lat.toFixed(2)})`);
  map.dispose();
}

// ---------------------------------------------------------------- 2. colliders: edges, bump, roadworks, surfaceAt, oneway
console.log('--- edges / features / surfaces');
{
  const E0 = 400, pe = genPath(200, 600, 0, [S(1000)], 20); // z = 600
  const x = (i) => pe.pts[i].x;
  // points every 20 m: 0..50 (x 200..1200). edges by x range
  const meta = (i, p) => {
    const m = {};
    if (p.x < 500) { m.edgeR = 'guardrail'; m.edgeL = 'fence'; }
    else if (p.x < 700) { m.edgeR = 'barrier'; m.edgeL = 'lamps'; m.surface = 'potholes'; }
    else if (p.x < 900) { m.surface = 'gravel'; m.oneway = true; }
    else { m.surface = 'worn'; }
    if (i === 10) m.features = ['bump'];
    if (i === 12) m.features = ['rumble'];
    if (i === 30) m.features = ['roadworks', 'crosswalk'];
    return m;
  };
  void E0; void x;
  const r1 = road(1, 8, pe.pts, meta);
  // a side road meeting the right edge at x = 360 (T junction) and a bridge piece
  const side = road(2, 6, [{ x: 360, z: 700 }, { x: 360, z: 640 }, { x: 360, z: 606 }]);
  // bridge on a separate road far away (edges requested on a bridge must not appear)
  const bp = genPath(200, 1000, 0, [S(400)], 20);
  const rb = road(3, 8, bp.pts, (i, p) => ({ edgeR: 'guardrail', edgeL: 'barrier', bridge: p.x > 310 && p.x < 400 }));
  const w = world();
  const map = loadMapFromData(mkData([r1, side, rb], {}, () => 20), { THREE, RAPIER, physicsWorld: w, physicsResolution: 512 });
  w.step();
  const D = map.roadDetail, hw = 4;
  console.log('     counts', JSON.stringify(D.counts), 'draw calls (roads group)', D.drawCalls);
  const cast = (ox, oy, oz, dx, dy, dz, max = 30) => { const h = w.castRay(new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }), max, true); return h ? h.timeOfImpact : null; };
  const j = map.junctions[0];
  assert(!!j && j.style === 'junction', 'side road creates a T junction at the right edge');
  // guardrail (right edge, +z for heading east): ray from the centre line at x = 300 toward +z
  let t = cast(300, 20.5, 600, 0, 0, 1); assert(t !== null && Math.abs(t - (hw + 0.6 - 0.1)) < 0.15, `guardrail collider: horizontal ray from the centre hits at ${t && t.toFixed(2)} m (expected ${(hw + 0.5).toFixed(2)})`);
  t = cast(300, 20.5, 600, 0, 0, -1); assert(t !== null && Math.abs(t - (hw + 0.6 - 0.06)) < 0.15, `fence collider (left edge): hit at ${t && t.toFixed(2)} m`);
  t = cast(600, 20.4, 600, 0, 0, 1); assert(t !== null && Math.abs(t - (hw + 0.55 - 0.3)) < 0.15, `barrier collider: hit at ${t && t.toFixed(2)} m (expected ${(hw + 0.25).toFixed(2)})`);
  const lamp = D.lamps.find((l) => Math.abs(l.z - (600 - hw - 0.9)) < 0.01 && l.x > 520 && l.x < 680);
  assert(!!lamp, `lamp posts on the left edge every ~35 m (${D.lamps.length} lamps)`);
  if (lamp) { t = cast(lamp.x, 21, 600, 0, 0, -1); assert(t !== null && Math.abs(t - (hw + 0.9 - 0.12)) < 0.2, `lamp post collider: hit at ${t && t.toFixed(2)} m`); }
  assert(!D.lamps.some((l, i) => i && D.lamps[i - 1].road === l.road && Math.abs(l.x - D.lamps[i - 1].x) < 30 && Math.abs(l.z - D.lamps[i - 1].z) < 1), 'lamp spacing >= 30 m');
  // gaps: none of the edge pieces / collider chords near the junction or on the bridge
  const near = (px, pz, c) => Math.hypot(px - c.x, pz - c.z) < c._extent;
  const jr = { x: j.x, z: j.z, _extent: 15 };
  assert(!D.edgePieces.some((p) => p.road === 0 && p.side > 0 && near(p.ax, p.az, jr)), 'no right-edge pieces inside the T junction footprint (gap at the side-road join)');
  assert(D.edgePieces.some((p) => p.road === 0 && p.side > 0 && p.ax < j.x - 25) && D.edgePieces.some((p) => p.road === 0 && p.side > 0 && p.ax > j.x + 25), 'right edge continues on both sides of the gap');
  assert(!D.edgePieces.some((p) => p.road === 2 && p.ax > 322 && p.ax < 398), 'no edge pieces on the bridge (x 320..400)');
  assert(D.edgePieces.some((p) => p.road === 2 && p.ax < 295) && D.edgePieces.some((p) => p.road === 2 && p.ax > 405), 'edges resume after the bridge');
  // bump: top ~0.1 m above the road surface (terrain + 3 cm lift), flat ground beside it
  const bx = x(10) === undefined ? 0 : pe.pts[10].x, top = 40 - cast(bx, 40, 600, 0, -1, 0, 80), gnd = map.heightAt(bx, 600);
  assert(Math.abs(top - (gnd + 0.03 + 0.1)) < 0.015, `bump: collider top ${(top - gnd - 0.03).toFixed(3)} m above the road surface (spec ~0.1)`);
  const off = 40 - cast(bx + 2.5, 40, 600, 0, -1, 0, 80); assert(Math.abs(off - gnd) < 0.02, 'no bump 2.5 m away (ground only)');
  const crest = 40 - cast(bx + 0.35, 40, 603.5, 0, -1, 0, 80); assert(crest > gnd + 0.03 + 0.05, 'bump spans the road width (hit near the edge too)');
  // rumble: roughness zone, no collider
  const rx = pe.pts[12].x, sRum = map.surfaceAt(rx, 600), sPlain = map.surfaceAt(rx + 20, 600);
  assert(sRum.roughness >= 0.4 && sPlain.roughness < 0.4 + 1e-9 && sRum.classId === 6, `rumble strips: roughness ${sRum.roughness} inside, ${sPlain.roughness} outside`);
  // roadworks: board collider across the closed (right) lane half, cones, sign
  const wx = pe.pts[30].x; t = cast(wx - 5, 20.5, 600 + 2.5, 1, 0, 0, 10); assert(t !== null && Math.abs(t - (5 - 0.08)) < 0.2, `roadworks board collider in the right lane: hit at ${t && t.toFixed(2)} m`);
  t = cast(wx - 5, 20.5, 600 - 2.5, 1, 0, 0, 10); assert(t === null, 'roadworks: the opposite lane half is open');
  let cones = 0; map.parts.roadProps.traverse((o) => { if (o.isInstancedMesh && o.name === 'cones') cones = o.count; });
  assert(cones === 7, `roadworks: ${cones} traffic cones (instanced, visual only)`);
  assert(D.signs.some((s) => s.type === 'roadworks' && s.x < wx), 'roadworks warning sign upstream of the board');
  assert(D.features.filter((f) => f.kind === 'crosswalk').length === 1, 'crosswalk feature listed in roadDetail.features (zebra + signs are tested in test-city.mjs)');
  // surfaceAt extras
  const sg = map.surfaceAt(800, 600), sp = map.surfaceAt(600, 600), sw = map.surfaceAt(1000, 600), ss = map.surfaceAt(300, 600), so = map.surfaceAt(300, 700);
  assert(sg.classId === 6 && sg.roadSurface === 'gravel' && sg.gripMul === 0.7 && sg.roughness === 0.5, 'surfaceAt gravel: class 6, roadSurface gravel, gripMul 0.7, roughness 0.5');
  assert(sp.roadSurface === 'potholes' && sp.gripMul === 0.9 && sw.roadSurface === 'worn' && sw.gripMul === 0.95 && ss.roadSurface === 'smooth' && ss.gripMul === 1 && ss.roughness === 0, 'surfaceAt potholes 0.9 / worn 0.95 / smooth 1');
  assert(so.classId !== 6 && so.roadSurface === null && so.roughness === 0 && so.gripMul === 1, 'surfaceAt off the road: roadSurface null, roughness 0, gripMul 1');
  // oneway: arrows exist on the oneway stretch only; points parsed with defaults
  const kind = map.parts.roadMesh.geometry.attributes.aKind.array; let decalVerts = 0; for (const k of kind) if (k === 2) decalVerts++;
  console.log('     paint decal vertices (one-way arrows + stop lines):', decalVerts);
  assert(decalVerts > 0, 'oneway stretch has painted arrows (decal geometry present)');
  const pt0 = map.roads[0].points[0], pt30 = map.roads[0].points[30];
  assert(pt0.type === 'country' && pt0.oneway === false && pt0.edgeL === 'fence' && pt0.edgeR === 'guardrail' && pt30.features.join() === 'crosswalk,roadworks', 'loader keeps node metadata on map.roads[i].points[j] (type/oneway/edges/features)');
  map.dispose();
  const m2 = loadMapFromData(mkData([r1, side, rb], {}, () => 20), { THREE, physics: false });
  assert(m2.roadDetail.counts.colliders === 0 || m2.roadDetail.counts.colliders === 0, 'physics:false builds no road colliders');
  m2.dispose();
}

// ---------------------------------------------------------------- 3. type city / highway are parsed and preserved (their looks are tested in test-city.mjs)
{
  const pts = genPath(200, 3700, 0, [S(200)], 20).pts;
  const r = road(1, 8, pts, (i) => ({ type: i < 3 ? 'city' : 'highway' }));
  const m = loadMapFromData(mkData([r], {}, () => 20), { THREE, physics: false });
  assert(m.roads[0].points[0].type === 'city' && m.roads[0].points[5].type === 'highway', 'type city / highway preserved on map.roads[0].points[j].type');
  const bad = loadMapFromData(mkData([road(1, 8, pts, { type: 'spaceship', edgeL: 'laser', surface: 'lava', features: ['bump', 'nope'] })], {}, () => 20), { THREE, physics: false });
  const q = bad.roads[0].points[0]; assert(q.type === 'country' && q.edgeL === 'none' && q.surface === 'smooth' && q.features.join() === 'bump', 'unknown enum values fall back to defaults');
  m.dispose(); bad.dispose();
}

// ---------------------------------------------------------------- 4. back-compat: old maps parse with defaults and keep working
console.log('--- back-compat');
for (const name of ['sample', 'junctions']) {
  const dir = path.resolve('public/maps', name);
  globalThis.fetch = async (url) => { const f = path.join(dir, path.basename(url)); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 }); };
  const rj = JSON.parse(fs.readFileSync(path.join(dir, 'roads.json'), 'utf8'));
  assert(!rj.roads.some((r) => r.points.some((p) => 'type' in p || 'edgeL' in p || 'surface' in p || 'features' in p)), `${name}: old roads.json has no metadata fields`);
  const w = world(), m = await loadMap('/maps/' + name + '/', { THREE, RAPIER, physicsWorld: w });
  assert(m.roads.every((r) => r.points.every((p) => p.type === 'country' && !p.oneway && p.edgeL === 'none' && p.edgeR === 'none' && p.surface === 'smooth' && p.signs === 'auto' && p.features.length === 0)), `${name}: all points load with default metadata`);
  assert(m.info.driveSide === 'right' && m.info.signStyle === 'us', `${name}: map defaults driveSide right / signStyle us`);
  console.log(`     ${name}: roadDetail counts ${JSON.stringify(m.roadDetail.counts)}`);
  assert(m.roadDetail.counts.edgeInstances === 0 && m.roadDetail.counts.colliders >= 0, `${name}: no edge objects without metadata`);
  const sf = m.surfaceAt(m.roads[0].points[1].x, m.roads[0].points[1].z); assert(sf.classId === 6 && sf.roadSurface === 'smooth' && sf.gripMul === 1, `${name}: road surface smooth by default`);
  m.dispose();
}

// ---------------------------------------------------------------- 5. roadmeta test map: loadMapFromData + updateRegion == loadMap(url)
console.log('--- roadmeta map');
{
  const dir = path.resolve('public/maps/roadmeta');
  if (!fs.existsSync(dir)) { assert(false, 'public/maps/roadmeta missing'); }
  else {
    globalThis.fetch = async (url) => { const f = path.join(dir, path.basename(url)); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 }); };
    const rd = (f) => fs.readFileSync(path.join(dir, f));
    const w = world(), A = await loadMap('/maps/roadmeta/', { THREE, RAPIER, physicsWorld: w });
    const [d0, d1, dw] = await Promise.all(['splat0.png', 'splat1.png', 'water.png'].map((f) => decodePNG(rd(f)))), rb = rd('heightmap.r16');
    const mk = () => ({ info: JSON.parse(rd('map.json')), height: new Uint16Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.length)), splat0: d0.data.slice(), splat1: d1.data.slice(), water: dw.data.slice(), roads: JSON.parse(rd('roads.json')) });
    const B = loadMapFromData(mk(), { THREE, physics: false });
    const sum = (m) => JSON.stringify({ s: m.roadDetail.signs, c: m.roadDetail.counts.signs, p: m.roadDetail.edgePieces, f: m.roadDetail.features, l: m.roadDetail.lamps });
    const pos = (m) => Array.from(m.parts.roadMesh.geometry.attributes.position.array.slice(0, 5000)).join();
    assert(sum(A) === sum(B) && pos(A) === pos(B) && JSON.stringify(A.roads.map((r) => r.points)) === JSON.stringify(B.roads.map((r) => r.points)), 'loadMapFromData == loadMap(url): signs, edge pieces, features, road mesh, node metadata');
    const c = A.roadDetail.counts, kinds = {}; for (const s of A.roadDetail.signs) kinds[s.type] = (kinds[s.type] || 0) + 1;
    console.log('     roadmeta signs', JSON.stringify(kinds), 'counts', JSON.stringify(c), 'drawCalls', A.roadDetail.drawCalls);
    assert(['curveL', 'curveR', 'sharpL', 'sharpR', 'winding', 'hillUp', 'hillDown', 'roadworks'].every((t) => kinds[t]), 'roadmeta has every sign type: ' + Object.keys(kinds).join());
    assert(['fence', 'guardrail', 'barrier', 'lamps'].every((k) => c.pieces[k] > 0) && c.features.bump && c.features.rumble && c.features.roadworks && c.features.crosswalk, 'roadmeta has every edge type and feature');
    // updateRegion with a road metadata edit == full rebuild of the edited data
    const cur = mk(); cur.roads.roads[0].points[1].surface = 'gravel'; cur.roads.roads[0].points[2].edgeR = 'barrier';
    const U = loadMapFromData(mk(), { THREE, physics: false });
    const res = U.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { roads: cur.roads }); U.flush();
    const R = loadMapFromData(cur, { THREE, physics: false });
    assert(res.roads && sum(U) === sum(R) && pos(U) === pos(R), 'updateRegion with edited road metadata == full rebuild');
    const noop = U.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { roads: cur.roads }); assert(!noop.roads, 'unchanged road metadata is a no-op');
    for (const m of [A, B, U, R]) m.dispose();
  }
}
console.log(fails ? `\n${fails} FAILED` : '\nall road tests passed');
