// Node checks for the automatic bridges over water (src/world/roadBridges.js): `npm run test:bridges`.
// Synthetic maps with KNOWN geometry (a lake basin, an ocean dip, a narrow river, two channels, junctions near the water, editor-marked bridges) built
// with the real loader. Roads run along +Z at x = 1000; heights/water are written as the editor would (water.png raster).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMapFromData } from '../src/world/mapLoader.js';
import { AUTO_BRIDGE } from '../src/world/roadBridges.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { resolveProfile } from '../src/vehicles/handling.js';

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; process.exitCode = 1; } else console.log('ok   ' + m); };
await RAPIER.init();

const W = 2000, N = 512, MAXH = 200, cell = W / N, X0 = 1000;
const CLASSES = ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'].map((color, id) => ({ id, name: String(id), color }));
const FLAT = 20, LAKE = 18, C = AUTO_BRIDGE;
// water: level (m) where the terrain is below it, as water.png encodes it
const mkData = (hfn, roads, { level = null, sea = -5, extra = {} } = {}) => {
  const h = new Uint16Array(N * N), s0 = new Uint8Array(N * N * 4), w = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * cell, z = (j + 0.5) * cell, v = Math.round(hfn(x, z) / MAXH * 65535);
    h[j * N + i] = v; s0[(j * N + i) * 4] = 255;
    if (level !== null && v * MAXH / 65535 < level) w[j * N + i] = 1 + Math.round(level / MAXH * 65534);
  }
  return { info: { N, worldSizeMeters: W, maxHeightMeters: MAXH, seaLevel: 0, seaLevelMeters: sea, classes: CLASSES, ...extra }, height: h, splat0: s0, splat1: new Uint8Array(N * N * 4), water: w, roads: { roads } };
};
const lakeH = (R = 60) => (x, z) => { const r2 = ((x - X0) ** 2 + (z - 1000) ** 2) / (R * R); return FLAT - 8 * Math.max(0, 1 - r2); }; // basin 12 m deep in the middle, water at 18
const zRoad = (id, meta = {}, z0 = 300, z1 = 1700, y = FLAT, x = X0, w = 8) => { const pts = []; for (let z = z0; z <= z1; z += 10) pts.push({ x, y: typeof y === 'function' ? y(z) : y, z, bridge: false, ...(typeof meta === 'function' ? meta(z) : meta) }); return { id, widthMeters: w, points: pts }; };
const xRoad = (id, z, x0, x1) => { const pts = []; for (let x = x0; x <= x1; x += 10) pts.push({ x, y: FLAT, z, bridge: false }); return { id, widthMeters: 8, points: pts }; };
const build = (data, o = {}) => { const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); const map = loadMapFromData(data, { THREE, RAPIER, physicsWorld: world, physicsResolution: 512, ...o }); world.step(); return { map, world }; };
const cast = (world, x, y, z) => { const h = world.castRay(new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), 500, true); return h ? y - h.timeOfImpact : null; };
const spanPts = (map, ri = 0) => map.roads[ri].getPoints(1);
const autoRange = (pts) => { const a = pts.findIndex((q) => q.auto), b = pts.length - 1 - [...pts].reverse().findIndex((q) => q.auto); return a < 0 ? null : [a, b]; };
const gradeOf = (pts, a, b) => { let g = 0; for (let i = a + 1; i <= b; i++) g = Math.max(g, Math.abs(pts[i].y - pts[i - 1].y) / Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)); return g; };
// every NON-bridge road ribbon vertex (kind 0) must be above the water surface (lake / ocean)
const wetRibbonVerts = (map) => {
  const g = map.parts.roadMesh.geometry, pos = g.attributes.position.array, kind = g.attributes.aKind.array; let bad = 0, n = 0;
  for (let i = 0; i < kind.length; i++) if (kind[i] === 0) { n++; const L = map.waterLevelAt(pos[i * 3], pos[i * 3 + 2]); if (L !== null && pos[i * 3 + 1] < L) bad++; }
  return { bad, n };
};

// ---------------------------------------------------------------- 1. lake: road crossing a basin at ground level
console.log('--- lake');
{
  const roads = [zRoad(1, (z) => ({ edgeL: 'guardrail', edgeR: 'lamps', features: z % 20 === 0 ? ['bump'] : [] }))];
  const { map, world } = build(mkData(lakeH(), roads, { level: LAKE }));
  const ab = map.roadDetail.autoBridges, pts = spanPts(map), r = autoRange(pts);
  assert(ab.length === 1 && ab[0].reason === 'lake' && ab[0].roadId === 1, `one auto bridge over the lake (${JSON.stringify(ab.map((b) => [b.s0 | 0, b.s1 | 0, b.reason]))})`);
  assert(map.roads[0].autoBridges.length === 1 && map.roadDetail.counts.autoBridges === 1 && map.roads[0].points.some((p) => p.auto), 'exposed as road.autoBridges, roadDetail.autoBridges (+counts) and point.auto');
  assert(r && pts.slice(r[0], r[1] + 1).every((q) => q.bridge && q.auto), 'samples of the span carry bridge:true + auto:true');
  const [a, b] = r, span = pts.slice(a, b + 1);
  const wet = span.filter((q) => map.heightAt(q.x, q.z) < LAKE);
  assert(wet.length > 80 && wet.every((q) => q.y >= LAKE + C.CLEARANCE - 1e-6), `deck >= water + ${C.CLEARANCE} m over the ${wet.length} wet samples (min ${Math.min(...wet.map((q) => q.y)).toFixed(3)})`);
  const g = gradeOf(pts, a, b);
  assert(g <= C.MAX_GRADE + 1e-3, `max deck grade ${(g * 100).toFixed(2)}% <= ${C.MAX_GRADE * 100}% (ramps ${(ab[0].s0 | 0)}..${ab[0].s1 | 0} m, span ${(ab[0].s1 - ab[0].s0).toFixed(0)} m)`);
  assert(Math.abs(span[0].y - map.heightAt(span[0].x, span[0].z)) < 1e-6 && Math.abs(span.at(-1).y - map.heightAt(span.at(-1).x, span.at(-1).z)) < 1e-6 && !pts[a - 1].bridge && !pts[b + 1].bridge, 'deck ends exactly at the dry road height, neighbours are plain road');
  let k2 = 0; for (let i = a + 1; i < b; i++) k2 = Math.max(k2, Math.abs(pts[i + 1].y - 2 * pts[i].y + pts[i - 1].y)); // second difference per ~1 m sample = grade change per metre
  assert(k2 < 0.02, `smooth deck: max grade change ${(k2 * 100).toFixed(2)}% per sample (no kinks)`);
  let bad = 0, hits = 0; for (let i = a; i <= b; i += 7) { const y = cast(world, pts[i].x, pts[i].y + 3, pts[i].z); hits++; if (y === null || Math.abs(y - pts[i].y) > 0.02) bad++; }
  assert(bad === 0 && hits > 10, `Rapier deck trimesh found at the deck height at ${hits} probes (${bad} off)`);
  const mid = pts[(a + b) >> 1];
  assert(Math.abs(cast(world, mid.x, mid.y - 0.85, mid.z) - map.heightAt(mid.x, mid.z)) < 0.5 && map.surfaceAt(mid.x, mid.z).roadSurface === null, 'terrain collider below the deck intact; surfaceAt on the lake bed below the deck is not road');
  const v = wetRibbonVerts(map); assert(v.n > 100 && v.bad === 0, `no non-bridge road ribbon vertex below the water (${v.bad} of ${v.n})`);
  const inSpan = (x, z) => z > pts[a].z - 1 && z < pts[b].z + 1 && Math.abs(x - X0) < 20, D = map.roadDetail;
  assert(D.edgePieces.length > 10 && !D.edgePieces.some((p) => inSpan(p.ax, p.az) || inSpan(p.bx, p.bz)) && !D.lamps.some((l) => inSpan(l.x, l.z)), `no guardrail / lamps on the bridge (${D.edgePieces.length} pieces, ${D.lamps.length} lamps elsewhere)`);
  assert(D.features.length > 3 && !D.features.some((f) => inSpan(f.x, f.z)) && !D.signs.some((s) => inSpan(s.x, s.z)), `no features / signs on the bridge (${D.features.length} features elsewhere)`);
  // the water mesh does not cover the deck: lake surface at most at LAKE, deck above it everywhere
  const wp = map.parts.lakes.geometry.attributes.position.array; let wmax = -1e9; for (let i = 1; i < wp.length; i += 3) wmax = Math.max(wmax, wp[i]);
  assert(wmax <= LAKE + 0.01 && Math.min(...span.filter((q) => map.heightAt(q.x, q.z) < LAKE).map((q) => q.y - 0.7)) > wmax, `slab underside above the water mesh (water ${wmax.toFixed(2)})`);
  // autoBridge:false = the old behaviour
  const off = build(mkData(lakeH(), roads, { level: LAKE }), { autoBridge: false }).map, offPts = spanPts(off);
  const vo = wetRibbonVerts(off);
  assert(off.roadDetail.autoBridges.length === 0 && !offPts.some((q) => q.bridge || q.auto) && vo.bad > 50 && offPts.every((q) => Math.abs(q.y - off.heightAt(q.x, q.z)) < 1e-9), `autoBridge:false: no bridge, the road drapes under the water as before (${vo.bad} wet ribbon vertices)`);
  // city type: no footpaths / corridor on the bridge
  const rc = [zRoad(1, { type: 'city' })], c = build(mkData(lakeH(), rc, { level: LAKE })).map, cp = spanPts(c), cr = autoRange(cp);
  const inC = (x, z) => z > cp[cr[0]].z - 1 && z < cp[cr[1]].z + 1 && Math.abs(x - X0) < 10;
  assert(cr && !c.roadDetail.footpaths.some((f) => inC(f.ax, f.az) || inC(f.bx, f.bz)) && c.roadDetail.footpaths.length > 5 && Math.abs(c.heightAt(X0, 1000) - 12) < 0.05 && c.surfaceAt(X0, 1000).classId !== 6 && c.surfaceAt(X0, 1000).classId !== 7, 'city road: no footpath, no terrain corridor, no road surface on the bridge');
  c.dispose(); off.dispose(); map.dispose();
}

// ---------------------------------------------------------------- 2. ocean coast: road dipping below sea level
console.log('--- ocean');
{
  const SEA = 10, hfn = (x, z) => FLAT - 17 * Math.exp(-(((z - 1000) / 250) ** 2)); // gentle coast: 5.8% max slope (steeper dry banks keep their own grade, see roadBridges.js)
  const { map, world } = build(mkData(hfn, [zRoad(1)], { sea: SEA })), ab = map.roadDetail.autoBridges, pts = spanPts(map), r = autoRange(pts);
  assert(ab.length === 1 && ab[0].reason === 'ocean', `one auto bridge, reason ocean (${ab.length})`);
  const span = pts.slice(r[0], r[1] + 1), wet = span.filter((q) => map.heightAt(q.x, q.z) < SEA);
  assert(wet.length > 100 && wet.every((q) => q.y >= SEA + C.CLEARANCE - 1e-6) && gradeOf(pts, r[0], r[1]) <= C.MAX_GRADE + 1e-3, `deck >= sea + ${C.CLEARANCE} (${wet.length} samples), grade ${(gradeOf(pts, r[0], r[1]) * 100).toFixed(1)}%`);
  const m = span[span.length >> 1]; assert(Math.abs(cast(world, m.x, m.y + 3, m.z) - m.y) < 0.02, 'deck collider over the sea');
  const v = wetRibbonVerts(map); assert(v.bad === 0, `no non-bridge ribbon vertex below the sea (${v.n} checked)`);
  map.dispose();
}

// ---------------------------------------------------------------- 3. narrow river
console.log('--- river');
{
  const hfn = (x, z) => FLAT - 6 * Math.exp(-(((z - 1000) / 7) ** 2)), RL = 17;
  const { map, world } = build(mkData(hfn, [zRoad(1)], { level: RL })), ab = map.roadDetail.autoBridges, pts = spanPts(map), r = autoRange(pts);
  assert(ab.length === 1, `river: one auto bridge (${ab.length})`);
  const span = pts.slice(r[0], r[1] + 1), wet = span.filter((q) => map.heightAt(q.x, q.z) < RL);
  assert(wet.length >= 6 && wet.every((q) => q.y >= RL + C.CLEARANCE - 1e-6) && gradeOf(pts, r[0], r[1]) <= C.MAX_GRADE + 1e-3, `river deck >= ${RL + C.CLEARANCE} over ${wet.length} wet samples, grade ${(gradeOf(pts, r[0], r[1]) * 100).toFixed(1)}%`);
  const m = span[span.length >> 1]; assert(Math.abs(cast(world, m.x, m.y + 3, m.z) - m.y) < 0.02, 'river deck collider');
  assert(wetRibbonVerts(map).bad === 0, 'no wet non-bridge ribbon vertex at the river');
  map.dispose();
  // a one-pixel wet spot (~2.5 m of road, only 0.5 m under the surface) is ignored; the same spot clearly deeper (> 0.5 m under) is bridged
  const px = (255 + 0.5) * cell;
  for (const [low, want] of [[17.5, 0], [15, 1]]) {
    const s = build(mkData((x, z) => (Math.abs(x - px) < 1 && Math.abs(z - px) < 1 ? low : FLAT), [zRoad(1, {}, 300, 1700, FLAT, px)], { level: LAKE })).map;
    assert(s.roadDetail.autoBridges.length === want, `tiny wet spot, lowest point ${low} m under water ${LAKE}: ${want ? 'bridged' : 'ignored'} (${s.roadDetail.autoBridges.length})`); s.dispose();
  }
}

// ---------------------------------------------------------------- 4. two wet spans: merged under 20 m, separate when far apart
console.log('--- merge');
for (const [gap, want] of [[15, 1], [100, 2]]) {
  const ch = (x, z) => ((z > 850 && z < 910) || (z > 910 + gap && z < 970 + gap) ? 14 : FLAT);
  const { map } = build(mkData(ch, [zRoad(1)], { level: LAKE })), ab = map.roadDetail.autoBridges, pts = spanPts(map);
  assert(ab.length === want, `channels ${gap} m apart -> ${want} bridge(s) (${ab.length})`);
  if (want === 1) { const gp = pts.filter((q) => q.z > 912 && q.z < 908 + gap); assert(gp.length > 5 && gp.every((q) => q.y >= LAKE + C.CLEARANCE - 0.05), `merged: deck stays above water + clearance across the ${gap} m dry gap (min ${Math.min(...gp.map((q) => q.y)).toFixed(2)})`); }
  assert(wetRibbonVerts(map).bad === 0, `channels ${gap}: no wet non-bridge ribbon vertex`);
  map.dispose();
}

// ---------------------------------------------------------------- 5. junction footprints
console.log('--- junctions');
{
  const cross = build(mkData(lakeH(), [zRoad(1), xRoad(2, 1000, 700, 1300)], { level: LAKE })).map;
  assert(cross.junctions.length === 1 && cross.roadDetail.autoBridges.length === 0 && cross.roadDetail.autoBridgeSkipped.length >= 1 && cross.roadDetail.autoBridgeSkipped.every((s) => s.reason === 'junction'),
    `crossing in the middle of the lake: not bridged, skipped (${cross.roadDetail.autoBridgeSkipped.length} spans) and reported`);
  assert(!spanPts(cross).some((q) => q.bridge), 'skipped span stays plain road (no deck, no crash)');
  cross.dispose();
  const near = build(mkData(lakeH(), [zRoad(1), { id: 2, widthMeters: 8, points: [{ x: X0, y: FLAT, z: 925, bridge: false }, { x: X0 + 100, y: FLAT, z: 925, bridge: false }, { x: X0 + 200, y: FLAT, z: 925, bridge: false }] }], { level: LAKE })).map;
  assert(near.junctions.length === 1 && near.roadDetail.autoBridges.length === 0 && near.roadDetail.autoBridgeSkipped.length === 1, `T junction at the shore: the ramps would reach its footprint -> skipped (${near.roadDetail.autoBridgeSkipped.length})`);
  near.dispose();
  const far = build(mkData(lakeH(), [zRoad(1), { id: 2, widthMeters: 8, points: [{ x: X0, y: FLAT, z: 400, bridge: false }, { x: X0 + 100, y: FLAT, z: 400, bridge: false }, { x: X0 + 200, y: FLAT, z: 400, bridge: false }] }], { level: LAKE })).map;
  assert(far.junctions.length === 1 && far.roadDetail.autoBridges.length === 1 && far.roadDetail.autoBridgeSkipped.length === 0, 'a junction far from the lake does not prevent the bridge');
  far.dispose();
}

// ---------------------------------------------------------------- 6. editor-marked bridges over water
console.log('--- marked bridge');
{
  const low = (z) => (z <= 940 || z >= 1060 ? FLAT : 18.6), mk = (y) => zRoad(1, {}, 300, 1700, y), setB = (rd) => { rd.points.forEach((p) => { p.bridge = p.z >= 940 && p.z < 1060; }); return rd; };
  const { map, world } = build(mkData(lakeH(), [setB(mk(low))], { level: LAKE })), pts = spanPts(map), ab = map.roadDetail.autoBridges;
  const wet = pts.filter((q) => map.heightAt(q.x, q.z) < LAKE), marked = pts.filter((q) => q.z >= 940 && q.z < 1060);
  assert(ab.length === 1 && ab[0].raised && map.roads[0].points.filter((p) => p.bridge).length === 12, `marked bridge too low: raised (${ab.length} span, raised ${ab[0] && ab[0].raised}), flags kept`);
  assert(wet.length > 50 && wet.every((q) => q.bridge && q.y >= LAKE + C.CLEARANCE - 1e-6) && marked.every((q) => q.bridge && !q.auto), `deck >= water + clearance over the lake (min ${Math.min(...wet.map((q) => q.y)).toFixed(2)}); marked samples keep auto:false`);
  const r = autoRange(pts); assert(gradeOf(pts, r[0], r[1]) < 0.4 && Math.abs(pts[r[0]].y - map.heightAt(pts[r[0]].x, pts[r[0]].z)) < 1e-6, 'extension ramps end at the dry road');
  const m = wet[wet.length >> 1]; assert(Math.abs(cast(world, m.x, m.y + 3, m.z) - m.y) < 0.02, 'raised deck collider at the new height');
  map.dispose();
  const hi = build(mkData(lakeH(), [setB(mk((z) => (z <= 940 || z >= 1060 ? FLAT : 26)))], { level: LAKE })).map, hp = spanPts(hi);
  assert(hi.roadDetail.autoBridges.length === 0 && hp.filter((q) => q.z > 990 && q.z < 1010).every((q) => q.y > 24 && !q.auto), 'a marked bridge that is high enough is left alone');
  hi.dispose();
}

// ---------------------------------------------------------------- 7. updateRegion / setSeaLevel == full rebuild
console.log('--- live edit');
{
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const eq = (A, B) => same(A.parts.roadMesh.geometry.attributes.position.array, B.parts.roadMesh.geometry.attributes.position.array) && same(A.parts.roadMesh.geometry.index.array, B.parts.roadMesh.geometry.index.array)
    && JSON.stringify(A.roadDetail.autoBridges) === JSON.stringify(B.roadDetail.autoBridges) && JSON.stringify(A.roadDetail.autoBridgeSkipped) === JSON.stringify(B.roadDetail.autoBridgeSkipped)
    && JSON.stringify(spanPts(A)) === JSON.stringify(spanPts(B)) && A.roadDetail.counts.signs === B.roadDetail.counts.signs;
  const roads = [zRoad(1, { edgeR: 'fence' })], dry = mkData(lakeH(), roads), wetD = mkData(lakeH(), roads, { level: LAKE });
  const mU = loadMapFromData({ ...dry, height: dry.height.slice(), water: dry.water.slice(), splat0: dry.splat0.slice() }, { THREE, physics: false });
  assert(mU.roadDetail.autoBridges.length === 0, 'dry basin: no auto bridge');
  const res = mU.updateRegion({ x0: 0, y0: 0, x1: N, y1: N }, { water: wetD.water });
  assert(res.water && res.roads, `flooding the basin schedules the road rebuild ${JSON.stringify(res)}`);
  mU.flush();
  const ref = loadMapFromData({ ...wetD }, { THREE, physics: false });
  assert(mU.roadDetail.autoBridges.length === 1 && eq(mU, ref), 'updateRegion(flood) + flush == full rebuild (road mesh, samples, auto bridges)');
  const res2 = mU.updateRegion({ x0: 0, y0: 0, x1: N, y1: N }, { water: dry.water }); mU.flush();
  const ref2 = loadMapFromData({ ...dry }, { THREE, physics: false });
  assert(res2.roads && mU.roadDetail.autoBridges.length === 0 && eq(mU, ref2), 'draining it again == full rebuild without the bridge');
  // a height edit that digs the road under the water level
  const lakeOnly = mkData((x, z) => FLAT, roads, { level: LAKE }); lakeOnly.water.fill(0); for (let j = 230; j < 282; j++) for (let i = 230; i < 282; i++) lakeOnly.water[j * N + i] = 1 + Math.round(LAKE / MAXH * 65534);
  const mH = loadMapFromData({ ...lakeOnly, height: lakeOnly.height.slice(), water: lakeOnly.water.slice() }, { THREE, physics: false });
  assert(mH.roadDetail.autoBridges.length === 0, 'water on a flat plain above the water level: no bridge');
  const dug = lakeOnly.height.slice(); for (let j = 230; j < 282; j++) for (let i = 230; i < 282; i++) dug[j * N + i] = Math.round(12 / MAXH * 65535);
  const rh = mH.updateRegion({ x0: 230, y0: 230, x1: 282, y1: 282 }, { height: dug }); mH.flush();
  const refH = loadMapFromData({ ...lakeOnly, height: dug.slice(), water: lakeOnly.water.slice() }, { THREE, physics: false });
  assert(rh.height && mH.roadDetail.autoBridges.length === 1 && eq(mH, refH), 'height edit digging the road below the water == full rebuild');
  // sea level
  const hfn = (x, z) => FLAT - 17 * Math.exp(-(((z - 1000) / 100) ** 2)), od = mkData(hfn, [zRoad(1)], { sea: 0 });
  const mS = loadMapFromData({ ...od }, { THREE, physics: false }); assert(mS.roadDetail.autoBridges.length === 0, 'sea 0 m: the road dip (min 3 m) stays dry');
  mS.setSeaLevel(10); mS.flush();
  const refS = loadMapFromData(mkData(hfn, [zRoad(1)], { sea: 10 }), { THREE, physics: false });
  assert(mS.roadDetail.autoBridges.length === 1 && eq(mS, refS), 'setSeaLevel(10) + flush == loading with seaLevelMeters 10');
  for (const m of [mU, ref, ref2, mH, refH, mS, refS]) m.dispose();
}

// ---------------------------------------------------------------- 8. drive across an auto bridge
console.log('--- drive');
{
  const { map, world } = build(mkData(lakeH(), [zRoad(1)], { level: LAKE }));
  const pts = spanPts(map), r = autoRange(pts), zA = pts[r[0]].z, zB = pts[r[1]].z;
  const glb = (id) => { const b = fs.readFileSync(path.resolve(`public/cars/${id}.glb`)), len = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + len).toString()), node = j.nodes.find((n) => n.name === 'body'), t = node.translation || [0, 0, 0], min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9]; for (const p of j.meshes[node.mesh].primitives) { const a = j.accessors[p.attributes.POSITION]; for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k] + t[k]); max[k] = Math.max(max[k], a.max[k] + t[k]); } } return { min, max }; };
  const manifest = JSON.parse(fs.readFileSync(path.resolve('public/cars/cars.json'), 'utf8')), car = manifest.cars.find((c) => c.id === 'sedan'), DT = 1 / 120;
  const z0 = zA - 60, v = new Vehicle({ RAPIER, world, map, car, profile: resolveProfile(car), bounds: glb('sedan'), spawn: { x: X0, y: FLAT + 0.5, z: z0, yaw: 0 }, dt: DT });
  v.world.step(); v.resetAt(X0, FLAT + 0.5, z0, 0);
  let minUp = 1, minAbove = 1e9, resets = 0, t = 0, kmhMax = 0, z = z0; const target = 40 / 3.6;
  for (; t < 120 && z < zB + 60; t += DT) {
    v.fixedStep({ throttle: Math.max(0, Math.min(1, (target - v.state.vf) * 2.5)), brake: 0, steer: 0, handbrake: 0 });
    const p = v.body.translation(); z = p.z; if (v.broken) { resets++; break; }
    minUp = Math.min(minUp, v.ax.u[1]); kmhMax = Math.max(kmhMax, v.state.kmh);
    if (z > zA && z < zB) { const deck = pts.reduce((m, q) => (Math.abs(q.z - z) < Math.abs(m.z - z) ? q : m)); minAbove = Math.min(minAbove, v.lowestHullY() - deck.y); }
  }
  assert(z >= zB + 60 && resets === 0 && Math.abs(v.body.translation().x - X0) < 6, `sedan drove across the lake bridge (${t.toFixed(0)} s, ${(zB - zA).toFixed(0)} m span, max ${kmhMax.toFixed(0)} km/h)`);
  assert(minUp >= 0.9 && minAbove > -0.1 && minAbove < 2, `stayed on the deck: min up.y ${minUp.toFixed(3)} >= 0.9, lowest hull point ${minAbove.toFixed(2)} m above the deck line at its lowest`);
  map.dispose();
}
console.log(fails ? `\n${fails} FAILED` : '\nall bridge checks passed');
