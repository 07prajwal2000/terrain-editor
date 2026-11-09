// Headless check of the city fill: `npm run test:cityfill` (real maps in public/maps + synthetic maps; no browser, no WebGL).
// Covers: determinism / chunk order independence / seed, building footprints vs every exclusion (other buildings, road ribbons of any type, junctions, bridges + approaches, water + shore,
// markers incl. lot_empty / lot_tall, override circles, slope), facing + setback, paint-weight rules (superset, zero, proportional, taller with weight), generation cost, props on the
// footpath, the Rapier collider pool (cap, no leaks, sits on the instances, footpath / road free, a ball cannot get into a facade), the nature scatter exclusion hook, city.json override.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, loadMapFromData } from '../src/world/mapLoader.js';
import { polyOf, KERB } from '../src/world/roads.js';
import { FOOT_SHIFT, HIGHWAY } from '../src/world/roadMeta.js';
import { createCityGen, CITY_CONFIG, pointBoxDist, boxesOverlap } from '../src/world/cityGen.js';
import { planBuilding, planProxy, pieceWidth, FAMILY, GROUND, FAMILIES, kitPieceNames } from '../src/world/cityKit.js';
import { createCityColliderPool } from '../src/world/cityColliders.js';
import { createScatterGen, hash } from '../src/world/scatterGen.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
const info = (m) => console.log('     ' + m);
await RAPIER.init();
const kit = JSON.parse(fs.readFileSync('public/city/city.json', 'utf8')), nature = JSON.parse(fs.readFileSync('public/nature/nature.json', 'utf8'));
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); if (!fs.existsSync(f)) return new Response(null, { status: 404 }); return new Response(fs.readFileSync(f)); };
async function loadDir(name, opts = {}) { mapDir = path.resolve('public/maps', name); return loadMap('/maps/x/', { THREE, physics: false, ...opts }); }
const CFG = CITY_CONFIG;

// ---- synthetic map (editor data format) ----
const CLASS_COLORS = ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'];
function synth({ N = 256, W = 1024, sea = 20, height = () => 60, city = () => 0, forest = () => 0, roads = [], markers = [], physics = false, world = null }) {
  const h = new Uint16Array(N * N), s0 = new Uint8Array(N * N * 4), s1 = new Uint8Array(N * N * 4), c = W / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * c, z = (j + 0.5) * c, k = j * N + i, w7 = city(x, z), wf = Math.min(1 - w7, forest(x, z));
    h[k] = Math.round(Math.max(0, Math.min(200, height(x, z))) / 200 * 65535);
    s0[k * 4] = Math.round((1 - w7 - wf) * 255); s0[k * 4 + 1] = Math.round(wf * 255); s1[k * 4 + 3] = Math.round(w7 * 255);
  }
  return loadMapFromData({
    info: { N, worldSizeMeters: W, maxHeightMeters: 200, seaLevel: sea / 200, seaLevelMeters: sea, classes: CLASS_COLORS.map((color, id) => ({ id, name: String(id), color })) },
    height: h, splat0: s0, splat1: s1, water: new Uint16Array(N * N), roads: { roads }, markers: { version: 1, markers },
  }, { THREE, physics, RAPIER, physicsWorld: world });
}
const cityRoad = (id, z0, x0, x1, y = 60, w = 10, step = 40, type = 'city') => ({ id, widthMeters: w, points: Array.from({ length: Math.round((x1 - x0) / step) + 1 }, (_, i) => ({ x: x0 + i * step, z: z0, y, bridge: false, type })) });
const mkMarker = (id, tags, x, z, radius = 0) => ({ id, name: tags[0] || 'm' + id, tags, color: '#fff', x, z, y: 0, yaw: 0, radius, props: {}, yOffset: 0, nx: 0, nz: 0 });
const allChunks = (gen) => gen.chunkKeys().map(([cx, cz]) => gen.chunk(cx, cz));
const allB = (gen) => allChunks(gen).flatMap((c) => c.buildings);
const idsOf = (gen) => new Map(allB(gen).map((b) => [b.id, b]));
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// ---- independent checks ----
const boxPts = (b, step) => { // points over a footprint box
  const nu = Math.max(1, Math.ceil(2 * b.hu / step)), nv = Math.max(1, Math.ceil(2 * b.hv / step)), pts = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const u = -b.hu + 2 * b.hu * i / nu, v = -b.hv + 2 * b.hv * j / nv; pts.push([b.cx + b.ux * u - b.uz * v, b.cz + b.uz * u + b.ux * v]); }
  return pts;
};
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(ax + dx * t - px, az + dz * t - pz); };
function roadSegs(map) { // [ax,az,bx,bz, clearance, isBridge]
  const out = [];
  for (const r of map.roads) { const P = polyOf(r); for (let i = 0; i < P.n - 1; i++) {
    const t = r.points[P.seg[i]].type, br = !!(P.b[i] || P.b[i + 1]);
    out.push([P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], r.width / 2 + KERB + (t === 'city' ? FOOT_SHIFT : t === 'highway' ? HIGHWAY.SHOULDER_W : 0) + CFG.roadMargin, br, r.width / 2 + KERB + CFG.roadMargin + CFG.bridgeMargin]);
  } }
  return out;
}
const SH = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);

// =================================================================================================
// 1. every map: determinism, exclusion rules, facing, setback
// =================================================================================================
const REAL = ['sample', 'sample2', 'junctions', 'roadmeta', 'citytest', 'city'];
const maps = {}, gens = {};
for (const name of REAL) {
  const map = maps[name] = await loadDir(name);
  const t0 = performance.now(), gen = gens[name] = createCityGen({ map }), tInit = performance.now() - t0;
  const keys = gen.chunkKeys(), B = allB(gen);
  info(`${name} (${map.info.worldSize} m): ${gen.candidates.length} candidate lots (init ${tInit.toFixed(1)} ms), ${keys.length} chunks, ${B.length} buildings, ${gen.stats.chunks ? (gen.stats.ms / gen.stats.chunks).toFixed(2) : 0} ms / chunk (max ${gen.stats.maxMs.toFixed(1)})`);
  if (!gen.hasCity()) {
    assert(B.length === 0 && !map.roads.some((r) => r.points.some((p) => p.type === 'city')), `${name}: no city road and no painted road -> no lots, no buildings`);
    continue;
  }
  // determinism: fresh generator, shuffled chunk order -> identical JSON
  const gen2 = createCityGen({ map }), order = keys.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(hash(7, i, 0, 0) * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let diff = 0; for (const [cx, cz] of order) if (JSON.stringify(gen.chunk(cx, cz)) !== JSON.stringify(gen2.chunk(cx, cz))) diff++;
  assert(diff === 0, `${name}: same seed, fresh generator, shuffled chunk order -> identical buildings + props (${keys.length} chunks, ${diff} differ)`);
  const gen3 = createCityGen({ map, override: { seed: 99 } });
  assert(B.length > 5 && allB(gen3).some((b, i) => !B[i] || Math.abs(b.x - B[i].x) > 1e-6) || B.length <= 5, `${name}: another seed gives other buildings`);
  assert(B.length > 0 && B.every((b) => b.row === 0), `${name}: has buildings, street row only (${B.length}: ${B.filter((b) => b.kind === 'proc').length} procedural, ${B.filter((b) => b.kind === 'whole').length} whole; ${B.filter((b) => b.mode === 1).length} on city roads, ${B.filter((b) => b.mode === 2).length} on painted roads)`);

  // independent exclusion checks on every footprint (padded box)
  const segs = roadSegs(map), bad = { overlap: 0, road: 0, bridge: 0, junction: 0, marker: 0, water: 0, shore: 0, slope: 0, edge: 0, n: B.length };
  const W = map.info.worldSize;
  B.forEach((b, i) => {
    for (let j = i + 1; j < B.length; j++) { const o = B[j]; if (Math.abs(b.cx - o.cx) > 60 || Math.abs(b.cz - o.cz) > 60) continue; if (boxesOverlap(b, o)) bad.overlap++; else if (boxPts(b, 1.5).some(([x, z]) => pointBoxDist(o, x, z) === 0)) bad.overlap++; }
    const pts = boxPts(b, 1.5); let h0 = 1e9, h1 = -1e9;
    for (const [x, z] of pts) {
      for (const s of segs) { const d = segDist(x, z, s[0], s[1], s[2], s[3]); if (d < s[4] - 1e-6) { bad.road++; break; } if (s[5] && d < s[6] - 1e-6) { bad.bridge++; break; } }
      if (map.waterLevelAt(x, z) !== null) bad.water++;
      else if (SH.some(([dx, dz]) => map.waterLevelAt(x + dx * CFG.shore, z + dz * CFG.shore) !== null)) bad.shore++;
      const h = map.heightAt(x, z); h0 = Math.min(h0, h); h1 = Math.max(h1, h);
      if (x < CFG.edgeMargin || z < CFG.edgeMargin || x > W - CFG.edgeMargin || z > W - CFG.edgeMargin) bad.edge++;
    }
    if (h1 - h0 > CFG.maxHeightRange + 0.4) bad.slope++;
    for (const j of map.junctions) if (j.style !== 'none' && pointBoxDist(b, j.x, j.z) < j.radius + CFG.junctionMargin - 1e-6) bad.junction++;
    for (const m of map.markers) if (pointBoxDist(b, m.x, m.z) < Math.max(0, m.radius) + CFG.markerClear - 1e-6) bad.marker++;
  });
  assert(Object.entries(bad).every(([k, v]) => k === 'n' || v === 0), `${name}: ${bad.n} footprints: overlap ${bad.overlap}, road ribbon ${bad.road}, bridge+approach ${bad.bridge}, junction ${bad.junction}, marker ${bad.marker}, water ${bad.water}, shore ${bad.shore}, slope ${bad.slope}, map edge ${bad.edge} (all must be 0)`);

  // facing + setback (own road polyline)
  let maxAng = 0, minSet = 1e9, towards = 0;
  for (const b of B) {
    const road = map.roads[b.road], P = polyOf(road), hw = road.width / 2; let best = { d: 1e9 };
    for (let i = 0; i < P.n - 1; i++) { const d = segDist(b.x, b.z, P.x[i], P.z[i], P.x[i + 1], P.z[i + 1]); if (d < best.d) best = { d, i }; }
    const tx = P.tx[best.i], tz = P.tz[best.i], fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    maxAng = Math.max(maxAng, Math.abs(Math.asin(Math.max(-1, Math.min(1, fx * tx + fz * tz)))) * 180 / Math.PI);   // facade normal vs the road perpendicular
    const px = P.x[best.i] - b.x, pz = P.z[best.i] - b.z; if (fx * px + fz * pz > 0) towards++;
    if (b.row === 0) minSet = Math.min(minSet, best.d - hw - (b.mode === 2 ? KERB : FOOT_SHIFT));
  }
  assert(maxAng < 4 && towards === B.length, `${name}: every facade faces its road: max deviation from the road perpendicular ${maxAng.toFixed(2)} deg, ${towards}/${B.length} point toward the road`);
  assert(minSet >= CFG.setback[0] - 1e-6, `${name}: setback behind the footpath (city roads, footpath ${FOOT_SHIFT} m) / the road edge + kerb strip (painted roads) >= ${CFG.setback[0]} m (min ${minSet.toFixed(2)} m)`);
  // scale, yaw sanity
  assert(B.every((b) => b.kind === 'proc' ? b.sc === 1 : b.sc >= CFG.scale[0] - 1e-9 && b.sc <= CFG.scale[1] + 1e-9) && B.every((b) => b.kind === 'whole' || (b.spec.floors >= 3 && b.spec.floors <= 8 && b.spec.W % 2 === 0 && b.spec.D % 2 === 0)), `${name}: whole buildings uniform scale ${CFG.scale.join('..')}; procedural 3..8 floors, even width / depth`);
  if (name === 'city' || name === 'citytest') { // street-row gaps: distance along the street to the next building of the same road side (same row), when they are consecutive lots
    const by = new Map(); for (const b of B) { const k = b.road * 2 + (b.side > 0 ? 1 : 0); (by.get(k) || by.set(k, []).get(k)).push(b); }
    let n = 0, big = 0, mx = 0; for (const l of by.values()) { l.sort((a, c) => a.id - c.id); for (let i = 0; i + 1 < l.length; i++) { if (l[i + 1].id - l[i].id !== 1) continue; const gp = Math.hypot(l[i + 1].cx - l[i].cx, l[i + 1].cz - l[i].cz) - l[i].hu - l[i + 1].hu; n++; mx = Math.max(mx, gp); if (gp > 3.4) big++; } }
    assert(n > 10 && big <= n * 0.04, `${name}: gap between neighbouring street-row buildings <= 3.4 m (padding included) for ${(100 - 100 * big / n).toFixed(1)} % of ${n} neighbour pairs (rest: outer side of bends), largest ${mx.toFixed(2)} m`);
  }
  // collider boxes keep off the footpath / road surface
  let onRoad = 0, nb = 0;
  for (const b of B) { const c = b.col; for (const [x, z] of boxPts({ ...c, ux: b.ux, uz: b.uz }, 1)) { nb++; const s = map.surfaceAt(x, z); if (s.classId === 6 || s.roadSurface === 'footpath') onRoad++; } }
  assert(onRoad === 0, `${name}: collider boxes never cover road or footpath surface (${nb} sample points, ${onRoad} on road / footpath)`);
  // props
  const props = allChunks(gen).flatMap((c) => c.props.bollard.map((p) => ['b', p]).concat(c.props.planter.map((p) => ['p', p])));
  let badP = 0; const zebras = (map.roadDetail.zebras || []);
  for (const [k, p] of props) {
    const s = map.surfaceAt(p.x, p.z);
    if (k === 'b' && (s.roadSurface !== 'footpath' || zebras.some((z) => Math.hypot(z.x - p.x, z.z - p.z) < CFG.props.bollard.zebra - 1e-6) || Math.abs(p.y - (map.heightAt(p.x, p.z) + 0.03 + 0.15)) > 1e-6)) badP++;
    if (k === 'p' && (s.classId === 6 || s.classId === 7 || B.some((b) => pointBoxDist(b, p.x, p.z) === 0))) badP++;
  }
  assert(badP === 0, `${name}: ${props.length} props (${props.filter((p) => p[0] === 'b').length} bollards on the paving, ${props.filter((p) => p[0] === 'p').length} planters off road / footpath / buildings): ${badP} misplaced`);
  // grounding: building (y .. y + h) covers the whole footprint ground range: no gap under it
  let gap = 0;
  for (const b of B) { let lo = 1e9, hi = -1e9; for (const [x, z] of boxPts(b, 2)) { const h = map.heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const bottom = b.plinth ? b.plinth.y0 : b.y; if (bottom > lo + 0.05 || b.y > hi + 0.01 || b.col.y0 > lo + 0.05) gap++; }
  assert(gap === 0, `${name}: no building floats: plinth / base reaches the lowest ground under each footprint (${gap} violations); ${B.filter((b) => b.plinth).length} of ${B.length} need a plinth`);
}
// citytest: cost + the shipped kit manifest matches CITY_CONFIG body dims + counts
{
  const gen = createCityGen({ map: maps.citytest });
  const t0 = performance.now(); const cs = gen.chunkKeys().map(([cx, cz]) => { const t = performance.now(); gen.chunk(cx, cz); return performance.now() - t; }); const tot = performance.now() - t0;
  info(`citytest generation: ${cs.length} chunks, total ${tot.toFixed(1)} ms, mean ${mean(cs).toFixed(2)} ms, max ${Math.max(...cs).toFixed(2)} ms per 128 m chunk`);
  assert(Math.max(...cs) < 60, `citytest: slowest chunk ${Math.max(...cs).toFixed(1)} ms (< 60 ms)`);
  for (const a of CFG.assets) { const e = kit.assets.find((x) => x.name === a.name); assert(e && e.body && ['x0', 'x1', 'z0', 'z1'].every((k) => Math.abs(e.body[k] - a.body[k]) <= 0.05) && Math.abs(e.height - a.body.h) <= 0.05, `${a.name}: CITY_CONFIG body = city.json body`); }
  for (const n of ['Prop_Bollard', 'Prop_Planter_Single']) assert(kit.assets.some((a) => a.name === n), `${n} in city.json`);
}

// =================================================================================================
// 2. synthetic map: bridge + approaches, water, steep slope, markers, painted rows, nature hook
// =================================================================================================
const trench = (x) => { const d = Math.abs(x - 520); return d < 70 ? 10 + d / 70 * 50 : 60; };
const pond = (x, z) => { const d = Math.hypot(x - 330, z - 440); return d < 30 ? 5 + 55 * (d / 30) ** 3 : 60; };   // a small lake north of the road
const synthHeight = (x, z) => Math.min(trench(x), pond(x, z)) + (z < 430 ? (430 - z) * 0.35 : 0);
const markers = [mkMarker(1, ['lot_empty'], 250, 520), mkMarker(2, ['lot_tall'], 700, 470), mkMarker(3, ['spawn'], 840, 490)];
const mapS = synth({ height: synthHeight, city: (x, z) => (z > 300 && z < 700 ? 0.9 : 0), roads: [cityRoad(1, 500, 80, 940)], markers });
const P1 = polyOf(mapS.roads[0]);
assert(P1.b.some((v) => v) && mapS.roadDetail.autoBridges.length >= 1, `synthetic: the road crosses a trench and is auto-bridged (${mapS.roadDetail.autoBridges.length} span)`);
const genS = createCityGen({ map: mapS, config: { rows: 3 } }), BS = allB(genS);
assert(allB(createCityGen({ map: mapS })).every((b) => b.row === 0) && allB(createCityGen({ map: mapS })).length > 20, 'default config: street row only, no second row (rows = 1)');
{
  info(`synthetic: ${genS.candidates.length} lots, ${BS.length} buildings, rejections ${JSON.stringify(genS.stats.rej)}`);
  const segs = roadSegs(mapS); let bBridge = 1e9, bWater = 0, bSlope = 0, bMarker = 1e9, bEmpty = 1e9;
  for (const b of BS) {
    for (const [x, z] of boxPts(b, 1.5)) {
      for (const s of segs) if (s[5]) bBridge = Math.min(bBridge, segDist(x, z, s[0], s[1], s[2], s[3]) - s[6]);
      if (mapS.waterLevelAt(x, z) !== null || SH.some(([dx, dz]) => mapS.waterLevelAt(x + dx * CFG.shore, z + dz * CFG.shore) !== null)) bWater++;
    }
    let lo = 1e9, hi = -1e9; for (const [x, z] of boxPts(b, 1.5)) { const h = mapS.heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); } if (hi - lo > CFG.maxHeightRange + 0.4) bSlope++;
    bMarker = Math.min(bMarker, pointBoxDist(b, 840, 490) - CFG.markerClear); bEmpty = Math.min(bEmpty, pointBoxDist(b, 250, 520) - CFG.tagRadius);
  }
  assert(BS.length > 20 && bBridge >= -1e-6, `synthetic: ${BS.length} buildings, none on a bridge deck / approach (clearance margin ${bBridge.toFixed(2)} m >= 0)`);
  assert(bWater === 0 && bSlope === 0, `synthetic: no footprint in water / shore ring (${bWater}), none on slopes steeper than the rule (${bSlope})`);
  assert(genS.stats.rej.slope > 0 && genS.stats.rej.water > 0 && genS.stats.rej.road > 0 && genS.stats.rej.overlap >= 0, `synthetic: the water / slope / road rules actually rejected lots (water ${genS.stats.rej.water}, slope ${genS.stats.rej.slope}, road ${genS.stats.rej.road})`);
  assert(bMarker >= -1e-6, `synthetic: marker clearance honoured (margin ${bMarker.toFixed(2)} m)`);
  assert(bEmpty >= -1e-6, `synthetic: lot_empty marker keeps a ${CFG.tagRadius} m zone empty (margin ${bEmpty.toFixed(2)} m)`);
  const nearTall = BS.filter((b) => pointBoxDist(b, 700, 470) < CFG.tagRadius), nearOther = BS.filter((b) => pointBoxDist(b, 700, 470) >= CFG.tagRadius && b.cls === 2);
  assert(nearTall.length > 0 && nearTall.every((b) => b.tall && (b.kind === 'whole' || b.spec.floors === 8)), `synthetic: lot_tall zone -> procedural buildings get 8 floors (${nearTall.length} lots, ${nearTall.filter((b) => b.kind === 'proc').length} procedural)`);
  assert(BS.some((b) => b.row === 0) && BS.some((b) => b.row === 1), `synthetic: config rows: 3 + painted city (0.9) adds rows behind the street row (rows 0 / 1 / 2: ${[0, 1, 2].map((r) => BS.filter((b) => b.row === r).length).join(' / ')})`);
  const gb = createCityGen({ map: mapS, config: { rows: 3 } }); // stable under chunk order + overlap rule agrees with cache clear
  gb.clearCache(); assert(JSON.stringify(allB(gb)) === JSON.stringify(BS), 'synthetic: regenerating after clearCache gives the same buildings');
  // blocked()
  const b0 = BS[0];
  assert(genS.blocked(b0.cx, b0.cz, 0) && !genS.blocked(2, 2, 3), 'blocked(): true inside a footprint, false far from every building');
}

// ---- curved + crossing city roads: lots fan out on the inner side of a bend -> the overlap rule must remove them
{
  const arc = { id: 1, widthMeters: 10, points: Array.from({ length: 19 }, (_, i) => { const a = -Math.PI * 0.9 + i * Math.PI * 1.7 / 18; return { x: 420 + Math.cos(a) * 110, z: 520 + Math.sin(a) * 110, y: 60, bridge: false, type: 'city' }; }) };
  const tight = { id: 2, widthMeters: 8, points: Array.from({ length: 9 }, (_, i) => { const a = i * Math.PI / 8; return { x: 800 + Math.cos(a) * 45, z: 250 + Math.sin(a) * 45, y: 60, bridge: false, type: 'city' }; }) };
  const mapC = synth({ city: () => 0.9, roads: [arc, tight, cityRoad(3, 520, 560, 940), { id: 4, widthMeters: 10, points: [0, 1, 2, 3, 4].map((i) => ({ x: 700, z: 160 + i * 100, y: 60, bridge: false, type: 'city' })) }] });
  const gen = createCityGen({ map: mapC, config: { rows: 3 } }), B = allB(gen), segs = roadSegs(mapC); let ov = 0, rd = 0, ang = 0;
  B.forEach((b, i) => { for (let j = i + 1; j < B.length; j++) if (boxesOverlap(b, B[j])) ov++; for (const [x, z] of boxPts(b, 1.5)) for (const s of segs) if (segDist(x, z, s[0], s[1], s[2], s[3]) < s[4] - 1e-6) { rd++; break; }
    if (b.row !== 0) return; const P = polyOf(mapC.roads[b.road]); let best = { d: 1e9 }; for (let k = 0; k < P.n - 1; k++) { const d = segDist(b.x, b.z, P.x[k], P.z[k], P.x[k + 1], P.z[k + 1]); if (d < best.d) best = { d, k }; }
    ang = Math.max(ang, Math.abs(Math.asin(Math.sin(b.yaw) * P.tx[best.k] + Math.cos(b.yaw) * P.tz[best.k])) * 180 / Math.PI); });
  info(`curves: ${gen.candidates.length} lots, ${B.length} buildings, rejections ${JSON.stringify(gen.stats.rej)}; max facade deviation ${ang.toFixed(1)} deg`);
  assert(B.length > 40 && gen.stats.rej.overlap > 10 && gen.stats.rej.junction > 0 && ov === 0 && rd === 0, `curved + crossing city roads: ${gen.stats.rej.overlap} lots removed as overlapping, ${gen.stats.rej.junction} near the junction; remaining ${B.length} buildings: overlaps ${ov}, road ribbon hits ${rd}`);
  assert(ang < 12, `bends: street-row facades within ${ang.toFixed(1)} deg of the local road perpendicular (nearest-sample estimate, < 12 incl. an R 45 m bend)`);
  const g2 = createCityGen({ map: mapC, config: { rows: 3 } }), ord = g2.chunkKeys().reverse(); ord.forEach(([cx, cz]) => g2.chunk(cx, cz));
  assert(JSON.stringify(allB(g2)) === JSON.stringify(B), 'curves: reverse chunk order -> identical buildings (overlap resolution is order independent)');
}

// ---- override file: disabled / density / exclusion / defaultWeight / forceTall
{
  const plain = synth({ roads: [cityRoad(1, 500, 80, 940)] }), base = createCityGen({ map: plain }), nBase = allB(base).length;
  assert(nBase > 15, `plain city road without any paint: ${nBase} buildings (defaultWeight ${CFG.defaultWeight}, rows = 0 only: ${allB(base).every((b) => b.row === 0)})`);
  assert(allB(createCityGen({ map: plain, override: { disabled: true } })).length === 0, 'city.json disabled:true -> no buildings');
  assert(allB(createCityGen({ map: plain, override: { defaultWeight: 0 } })).length === 0, 'city.json defaultWeight 0 + no paint -> none');
  assert(allB(createCityGen({ map: plain, override: { density: 0 } })).length === 0, 'city.json density 0 -> none');
  const ids0 = new Set(allB(base).map((b) => b.id)), half = allB(createCityGen({ map: plain, override: { density: 0.5 } }));
  assert(half.length < nBase * 0.75 && half.length > nBase * 0.3 && half.every((b) => ids0.has(b.id)), `city.json density 0.5 -> ${half.length} of ${nBase} (subset, same lots)`);
  const ex = allB(createCityGen({ map: plain, override: { exclusions: [{ x: 500, z: 500, r: 120 }] } }));
  assert(ex.length < nBase && ex.every((b) => pointBoxDist(b, 500, 500) >= 120 - 1e-6), `city.json exclusion circle r 120 keeps buildings out (${nBase} -> ${ex.length})`);
  const tall = allB(createCityGen({ map: plain, override: { forceTall: [{ x: 500, z: 500, r: 150 }] } })).filter((b) => pointBoxDist(b, 500, 500) < 150);
  assert(tall.length > 0 && tall.every((b) => b.tall && (b.kind === 'whole' || b.spec.floors === 8)), 'city.json forceTall zone: procedural buildings get 8 floors');
  const sd = allB(createCityGen({ map: plain, override: { seed: 5 } }));
  assert(sd.length > 0 && sd.some((b, i) => !allB(base)[i] || Math.abs(b.x - allB(base)[i].x) > 1e-6), 'city.json seed changes the town');
  assert(allB(createCityGen({ map: synth({ city: () => 1 }) })).length === 0 && !createCityGen({ map: synth({ city: () => 1 }) }).hasCity(), 'painted city class 1.0 everywhere but NO city road -> no lots at all');
  const cty = (over) => createCityGen({ map: synth({ roads: [cityRoad(1, 500, 80, 940, 60, 8, 40, 'country')], city: (x, z) => (x > 400 && x < 700 && Math.abs(z - 500) < 150 ? 0.8 : 0) }), override: over });
  const pb = allB(cty()), mp = (b) => b.mode === 2;
  assert(pb.length > 10 && pb.every(mp) && pb.every((b) => b.cx > 380 && b.cx < 720), `painted COUNTRY road: ${pb.length} buildings only where the city paint is (x 400..700), none on the unpainted stretches`);
  assert(allB(cty({ paintedRoads: false })).length === 0 && allB(cty({ paintMinWeight: 0.9 })).length === 0 && allB(cty({ paintMinWeight: 0.3 })).length >= pb.length, 'city.json paintedRoads:false / paintMinWeight 0.9 (above the paint) -> none; lower threshold keeps them');
  assert(allB(createCityGen({ map: synth({ roads: [cityRoad(1, 500, 80, 940, 60, 8, 40, 'country')] }) })).length === 0 && !createCityGen({ map: synth({ roads: [cityRoad(1, 500, 80, 940, 60, 8, 40, 'country')] }) }).hasCity(), 'country road with no paint -> no lots at all');
  assert(allB(createCityGen({ map: synth({ roads: [cityRoad(1, 500, 80, 940, 60, 24, 40, 'highway')], city: () => 1 }) })).length === 0, 'painted city next to a HIGHWAY -> none');
}

// ---- paint weight: superset, proportional, taller
{
  const flat = (w) => synth({ city: (x, z) => (z > 300 && z < 700 ? w : 0), roads: [cityRoad(1, 500, 80, 940)] });
  const g = (w) => createCityGen({ map: flat(w), config: { defaultWeight: 0 }, override: { defaultWeight: 0 } });
  const ws = [0, 0.2, 0.4, 0.6, 0.8, 1], sets = ws.map((w) => idsOf(g(w)));
  let mono = true; for (let i = 1; i < ws.length; i++) for (const [id, b] of sets[i - 1]) { const o = sets[i].get(id); if (!o || o.asset > ws[i] && false) mono = false; if (o && o.h < b.h - 1e-9) mono = false; }
  assert(sets[0].size === 0 && mono, `paint monotone: weight ${ws.join(' / ')} -> ${sets.map((s) => s.size).join(' / ')} buildings; every lot kept when painting stronger, never a lower one`);
  const hs = sets.map((s) => mean([...s.values()].map((b) => b.h)));
  assert(hs[1] > 0 && hs[1] < hs[3] && hs[3] < hs[5], `taller with weight: mean building height at weight ${ws.slice(1).join(' / ')}: ${hs.slice(1).map((h) => h.toFixed(1)).join(' / ')} m (procedural floors follow the paint)`);
  // proportional: three parallel roads in three paint bands (row 0 only counts)
  const bandMap = synth({ city: (x, z) => (z < 340 ? 0.25 : z < 680 ? 0.5 : 1), roads: [cityRoad(1, 170, 80, 940), cityRoad(2, 510, 80, 940), cityRoad(3, 850, 80, 940)] });
  const gen = createCityGen({ map: bandMap, override: { defaultWeight: 0 } }), cand = [0, 0, 0], fill = [0, 0, 0];
  for (const c of gen.candidates) if (c.row === 0) { /* statically valid lots only */ }
  const filled = allB(gen).filter((b) => b.row === 0), avail = gen.candidates.filter((c) => c.row === 0);
  for (const c of avail) cand[c.road]++; for (const b of filled) fill[b.road]++;
  const frac = fill.map((f, i) => f / Math.max(1, cand[i] - 0)), h3 = [1, 2, 3].map((r) => mean(filled.filter((b) => b.road === r - 1).map((b) => b.h)));
  info(`bands: row-0 lots ${cand.join(' / ')}, filled ${fill.join(' / ')} (fraction ${frac.map((f) => f.toFixed(2)).join(' / ')} of the candidates; weights .25 / .5 / 1)`);
  assert(fill[0] > 0 && fill[1] > fill[0] * 1.4 && fill[2] > fill[1] * 1.4 && Math.abs(frac[0] - 0.25 * 0.92) < 0.16 && Math.abs(frac[1] - 0.5 * 0.92) < 0.16 && frac[2] > 0.8, 'paint weight 0.25 / 0.5 / 1.0 -> counts roughly proportional (filled fraction ~ weight)');
  assert(h3[0] < h3[2] - 2 && h3[1] < h3[2], `taller with weight: mean height ${h3.map((h) => h.toFixed(1)).join(' / ')} m (paint .25 / .5 / 1)`);
}

// ---- nature scatter exclusion hook
{
  const mapF = synth({ forest: () => 1, roads: [cityRoad(1, 500, 80, 940)] }), gen = createCityGen({ map: mapF }), B = allB(gen);
  const mk = (extra) => createScatterGen({ map: mapF, manifest: nature, ...extra });
  const trees = (sg) => { const out = []; const S = sg.chunkSize.far, n = Math.ceil(sg.worldSize / S); for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) { const p = sg.layer('tree', cx, cz).parts.tree; for (let i = 0; i < p.n; i++) out.push([p.data[i * 7], p.data[i * 7 + 2]]); } return out; };
  const without = trees(mk({})), withHook = trees(mk({ extraBlocked: gen.blocked }));
  const inside = (list) => list.filter(([x, z]) => B.some((b) => pointBoxDist(b, x, z) < 3.5 - 1e-6)).length;
  assert(B.length > 15 && without.length > 200 && inside(without) > 5, `scatter without the hook: ${inside(without)} of ${without.length} trees stand in / next to ${B.length} building footprints (the test is meaningful)`);
  assert(withHook.length > 100 && inside(withHook) === 0 && withHook.length < without.length, `scatter with extraBlocked = city.blocked: 0 trees within the tree road margin of a footprint (${without.length} -> ${withHook.length} trees)`);
  const bg = createScatterGen({ map: mapF, manifest: nature }), kept = new Set(without.map((t) => t.join(',')));
  assert(withHook.every((t) => kept.has(t.join(','))), 'the hook only REMOVES trees (every remaining tree is where it was)');
}

// =================================================================================================
// 3. Rapier collider pool on citytest: cap, leaks, on the instances, a ball cannot enter a facade
// =================================================================================================
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = 1 / 60;
  mapDir = path.resolve('public/maps/citytest');
  const map = await loadMap('/maps/x/', { THREE, RAPIER, physicsWorld: world, physicsResolution: 512 });
  const gen = createCityGen({ map }), B = allB(gen), before = world.colliders.len();
  const small = { colliders: { max: 6, maxBollards: 5 } }, gp = createCityGen({ map, config: small });
  const pool = createCityColliderPool({ RAPIER, world, gen });
  const made = world.colliders.len() - before;
  assert(made === CFG.colliders.max + CFG.colliders.maxBollards, `pool pre-creates ${made} colliders (${CFG.colliders.max} + ${CFG.colliders.maxBollards}), all disabled`);
  let maxActive = 0, ok = true; const t0 = performance.now();
  for (let i = 0; i < 400; i++) { const x = 60 + (i * 7.3) % 400, z = 150 + Math.sin(i * 0.1) * 120; pool.update(x, z); const s = pool.stats(); maxActive = Math.max(maxActive, s.active); if (s.buildings > s.capBuildings || s.bollards > s.capBollards) ok = false; }
  const dt = (performance.now() - t0) / 400;
  assert(ok && world.colliders.len() === before + made, `pool never exceeds its caps (max active ${maxActive}), no collider is created or leaked over 400 moves (${world.colliders.len() - before} in the world); ${dt.toFixed(2)} ms / update call`);
  // every building within radius of the focus has an active collider exactly on its collision box
  pool.forceUpdate(230, 150);
  const act = pool.active().filter((a) => a.kind === 'building'), inRange = B.filter((b) => Math.hypot(b.col.cx - 230, b.col.cz - 150) - Math.hypot(b.col.hu, b.col.hv) <= CFG.colliders.radius);
  const sits = inRange.length <= CFG.colliders.max ? inRange.every((b) => act.some((a) => Math.abs(a.x - b.col.cx) < 1e-4 && Math.abs(a.z - b.col.cz) < 1e-4 && Math.abs(a.hx - b.col.hu) < 1e-4 && Math.abs(a.hz - b.col.hv) < 1e-4 && Math.abs(a.y - (b.col.y0 + b.col.y1) / 2) < 1e-4)) : true;
  assert(inRange.length > 0 && sits && act.every((a) => B.some((b) => b.id === a.id)), `colliders sit exactly on the building boxes (${act.length} active, ${inRange.length} buildings in range ${CFG.colliders.radius} m)`);
  const bol = pool.active().filter((a) => a.kind === 'bollard');
  assert(bol.length > 0 && bol.every((a) => Math.hypot(a.x - 230, a.z - 150) <= CFG.colliders.bollardRange + 6), `${bol.length} bollard colliders near the focus only (range ${CFG.colliders.bollardRange} m)`);
  pool.forceUpdate(900, 900); assert(pool.stats().active === 0, 'far from any building: 0 active colliders');
  // a heavy ball shot at a facade stops outside it
  world.step(); let worst = 1e9, n = 0;
  for (const b of B.filter((q, i) => i % Math.max(1, Math.floor(B.length / 4)) === 0).slice(0, 4)) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), sx = b.cx + fx * (b.hv + 14), sz = b.cz + fz * (b.hv + 14), sy = map.heightAt(sx, sz) + 3.5;
    pool.forceUpdate(sx, sz);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(sx, sy, sz).setLinvel(-fx * 22, 0, -fz * 22).setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.ball(0.6).setFriction(0.4), body);
    for (let i = 0; i < 150; i++) world.step();
    const p = body.translation(); worst = Math.min(worst, pointBoxDist({ cx: b.col.cx, cz: b.col.cz, ux: b.ux, uz: b.uz, hu: b.col.hu, hv: b.col.hv }, p.x, p.z)); n++;
    world.removeRigidBody(body);
  }
  assert(n > 0 && worst > 0.3, `a 22 m/s ball shot at ${n} facades stays outside the building box (closest ${worst.toFixed(2)} m from its edge)`);
  pool.dispose(); assert(world.colliders.len() === before, 'pool.dispose() removes every collider');
}

// =================================================================================================
// 4. procedural building kit (cityKit.js): every facade slot covered once, widths add up, pieces exist in the GLB, triangle budget
// =================================================================================================
{
  const triOf = (n) => (kit.assets.find((a) => a.name === n) || { tris: 300 }).tris, names = new Set(kit.assets.map((a) => a.name));
  assert(kitPieceNames().every((n) => names.has(n)), `all ${kitPieceNames().length} kit pieces used by cityKit.js exist in city.json`);
  let nb = 0, bad = { cover: 0, dup: 0, width: 0, tris: 0, h: 0 }, maxT = 0, sig = new Set(), styles = new Set();
  for (let i = 0; i < 400; i++) {
    const spec = { W: 2 * (5 + (i % 8)), D: 2 * (5 + (i % 6)), floors: 3 + (i % 6), up: FAMILIES[i % 3], gr: FAMILIES[Math.floor(i / 3) % 3], cor: ['brick', 'metal', 'trim', 'none'][Math.floor(i / 9) % 4], cols: i % 3 !== 0, seed: i * 7919 };
    const pl = planBuilding(spec, triOf, 15000); nb++; maxT = Math.max(maxT, pl.tris);
    if (pl.tris > 15000) bad.tris++;
    if (Math.abs(pl.H - (spec.floors * 3 + (spec.cor === 'none' ? 0 : 1))) > 1e-9) bad.h++;
    const seen = new Set(); for (const p of pl.pieces) { const k = [p.n, p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), p.r.toFixed(3)].join('|'); if (seen.has(k)) bad.dup++; seen.add(k); }
    // wall rows: for each face and floor the pieces tile the face exactly once (front / back along x from -W/2, left / right along z from -D)
    for (const [face, span] of [['front', spec.W], ['back', spec.W], ['left', spec.D], ['right', spec.D]]) for (let f = 0; f < spec.floors; f++) {
      const fb = face === 'front' || face === 'back', row = pl.pieces.filter((p) => p.role === 'wall' && p.face === face && Math.abs(p.y - f * 3) < 1e-9).map((p) => [fb ? p.x : p.z, p.w]).sort((x, y) => x[0] - y[0]);
      let at = fb ? -span / 2 : -span, ok = row.length > 0; const tot = row.reduce((q, r) => q + r[1], 0);
      if (Math.abs(tot - span) > 0.01) bad.width++;
      for (const [c, w] of row) { if (Math.abs(c - w / 2 - at) > 0.01) ok = false; at += w; }
      if (Math.abs(at - (fb ? span / 2 : 0)) > 0.01) ok = false;
      if (!ok) bad.cover++;
    }
    sig.add(pl.pieces.map((p) => p.n).join(',')); styles.add(spec.up + spec.gr + spec.cor);
  }
  assert(bad.cover === 0 && bad.width === 0 && bad.dup === 0, `${nb} generated buildings: every wall unit of every floor on every face covered exactly once, widths sum to the footprint (1 cm), no duplicate piece (violations: cover ${bad.cover}, width ${bad.width}, duplicates ${bad.dup})`);
  assert(bad.tris === 0 && bad.h === 0 && maxT <= 15000, `triangle budget: largest of ${nb} buildings ${maxT} tris (<= 15000); heights = floors x 3 (+1 cornice)`);
  assert(sig.size > 300 && styles.size >= 30, `variety: ${sig.size} distinct piece layouts, ${styles.size} style combinations in ${nb} buildings`);
  // cost of the worst case 24 x 20 m, 8 floors, windows of the heaviest family
  const worst = planBuilding({ W: 24, D: 20, floors: 8, up: 'brick', gr: 'brick', cor: 'trim', cols: true, seed: 1 }, triOf, 15000);
  info(`worst case 24 x 20 m, 8 floors: ${worst.pieces.length} pieces, ${worst.tris} tris`);
  const px = planProxy({ x0: -8, x1: 8, zb: -14, h: 19 });
  assert(px.every((p) => p.n === 'Brick_Plain_3' || p.n === 'Roof_2x2') && px.length > 20 && px.reduce((s, p) => s + triOf(p.n) * 1, 0) < 2500, `far proxy of a 16 x 14 x 19 m building: ${px.length} pieces, ${px.reduce((s, p) => s + triOf(p.n), 0)} tris`);
}

console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall city fill checks passed');
