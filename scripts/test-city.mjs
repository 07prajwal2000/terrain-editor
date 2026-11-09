// Node checks for the city / highway / signals / crosswalk road work: `npm run test:city`.
//  1. junction style rules on synthetic maps (city arm -> signals, highway arm -> plain, markers, junctions.json precedence)
//  2. public/maps/citytest (made by scripts/make-city-test-map.mjs): junction styles, signal / crosswalk counts, kerb + footpath geometry via Rapier
//     raycasts, corner blocks, footpath ends, median barrier, surfaceAt footpath, terrain corridor stamping (raycast vs heightAt), signal cycle,
//     draw calls, loadMapFromData / updateRegion == loadMap(url)
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, loadMapFromData, decodePNG, checkCollider } from '../src/world/mapLoader.js';
import { highwayLanes, CITY, FOOT_SHIFT } from '../src/world/roadMeta.js';
import { cityRuns, stampCityCorridors } from '../src/world/roads.js';
import { signalState } from '../src/world/roadSignals.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
await RAPIER.init();
const world = () => new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const info = (...a) => console.log('    ', ...a);

// ---------------------------------------------------------------- 1. junction style rules (synthetic flat map)
console.log('--- junction style rules');
const W = 4000, N = 512, MAXH = 200;
const CLASSES = ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'].map((color, id) => ({ id, name: String(id), color }));
function mkData(roads, extra = {}, hfn = null) {
  const h = new Uint16Array(N * N).fill(Math.round(20 / MAXH * 65535)), s0 = new Uint8Array(N * N * 4);
  const cw = W / N; if (hfn) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = Math.round(hfn((i + 0.5) * cw, (j + 0.5) * cw) / MAXH * 65535);
  for (let i = 0; i < N * N; i++) s0[i * 4] = 255;
  return { info: { N, worldSizeMeters: W, maxHeightMeters: MAXH, seaLevel: 0, seaLevelMeters: -5, classes: CLASSES }, height: h, splat0: s0, splat1: new Uint8Array(N * N * 4), water: new Uint16Array(N * N), roads: { roads }, ...extra };
}
const line = (id, width, x0, z0, x1, z1, meta = {}, n = 9) => ({ id, widthMeters: width, points: Array.from({ length: n }, (_, i) => ({ x: x0 + (x1 - x0) * i / (n - 1), z: z0 + (z1 - z0) * i / (n - 1), y: 20, bridge: false, ...meta })) });
const styleOf = (roads, extra) => { const m = loadMapFromData(mkData(roads, extra), { THREE, physics: false }); const js = m.junctions.map((j) => ({ style: j.style, source: j.source, arms: j.arms.length })); m.dispose(); return js; };
const city = { type: 'city' }, hwy = { type: 'highway' };
const X = (a, b) => [line(1, 10, 1600, 2000, 2400, 2000, a), line(2, 10, 2000, 1600, 2000, 2400, b)]; // 4-way crossing at (2000,2000)
const T = (a, b) => [line(1, 10, 1600, 2000, 2400, 2000, a), line(2, 10, 2000, 2000, 2000, 2400, b)]; // T junction (side road starts on road 1)
const only = (r) => (r.length === 1 ? r[0] : null);
const eq = (r, style, source, arms) => { const o = only(r); return !!o && o.style === style && o.source === source && (arms === undefined || o.arms === arms); };
assert(eq(styleOf(X({}, {})), 'roundabout', 'default', 4), 'country crossing -> roundabout (unchanged default)');
assert(eq(styleOf(T({}, {})), 'junction', 'default', 3), 'country T -> plain junction (unchanged default)');
assert(eq(styleOf(X(city, {})), 'signals', 'default', 4), 'crossing with ONE city road -> signals, never a roundabout');
assert(eq(styleOf(X(city, city)), 'signals', 'default', 4), 'city x city crossing -> signals');
assert(eq(styleOf(T({}, city)), 'signals', 'default', 3), 'T junction whose side road is city -> signals');
assert(eq(styleOf(T(city, {})), 'signals', 'default', 3), 'T junction on a city main road -> signals');
assert(eq(styleOf(X(hwy, {})), 'junction', 'default', 4), 'highway x country crossing -> plain junction (no roundabout)');
assert(eq(styleOf(X(hwy, city)), 'junction', 'default', 4), 'highway arm beats city arm: plain junction, no signals');
assert(eq(styleOf(T(hwy, city)), 'junction', 'default', 3), 'highway T city -> plain junction');
{ const two = [line(1, 10, 1600, 2000, 2000, 2000, city, 5), line(2, 10, 2000, 2000, 2400, 2000, city, 5)]; assert(eq(styleOf(two), 'junction', 'default', 2), '2-arm city join stays a plain junction patch'); }
const mk = (x, z, tags) => ({ x, z, tags });
const markers = (...m) => ({ markers: m });
assert(eq(styleOf(X(city, city), { markers: markers(mk(2005, 2004, ['roundabout'])) }), 'roundabout', 'marker', 4), 'marker "roundabout" near a city crossing forces a roundabout');
assert(eq(styleOf(X({}, {}), { markers: markers(mk(1995, 2003, ['signals'])) }), 'signals', 'marker', 4), 'marker "signals" forces signals on a country crossing');
assert(eq(styleOf(X(city, city), { markers: markers(mk(2000, 2010, ['junction_plain'])) }), 'junction', 'marker', 4), 'marker "junction_plain" forces a plain junction patch');
assert(eq(styleOf(X(city, city), { markers: markers(mk(2000, 2030, ['roundabout'])) }), 'signals', 'default', 4), 'marker > 15 m away is ignored');
assert(eq(styleOf(X(city, city), { markers: markers(mk(2000, 2012, ['roundabout']), mk(2002, 2002, ['junction_plain'])) }), 'junction', 'marker', 4), 'two markers: the nearest one wins');
assert(eq(styleOf(X(city, city), { markers: markers(mk(2000, 2000, ['spawn', 'roundabout'])) }), 'roundabout', 'marker', 4), 'unrelated tags are ignored, relevant tag on the same marker works');
assert(eq(styleOf(X(city, city), { markers: markers(mk(2000, 2000, ['roundabout'])), junctions: [{ x: 2001, z: 2001, style: 'signals' }] }), 'signals', 'json', 4), 'junctions.json beats a roundabout marker (signals)');
assert(eq(styleOf(X({}, {}), { markers: markers(mk(2000, 2000, ['signals'])), junctions: [{ x: 2001, z: 2001, style: 'junction' }] }), 'junction', 'json', 4), 'junctions.json beats a signals marker (junction)');
assert(styleOf(X(city, city), { junctions: [{ x: 2001, z: 2001, style: 'none' }] }).length === 0, 'junctions.json "none" removes the city junction');
assert(eq(styleOf(X({}, {}), { junctions: [{ x: 2000, z: 2000, style: 'signals' }] }), 'signals', 'json', 4), 'junctions.json accepts the new style "signals"');
{ let threw = false; try { styleOf(X({}, {}), { junctions: [{ x: 2000, z: 2000, style: 'nonsense' }] }); } catch { threw = true; } assert(threw, 'junctions.json rejects unknown styles'); }
{ // markers changed through updateRegion trigger a junction rebuild; same markers are a no-op
  const m = loadMapFromData(mkData(X(city, city)), { THREE, physics: false });
  const r1 = m.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { markers: markers({ x: 2000, z: 2000, tags: ['roundabout'] }) }); m.flush();
  assert(r1.markers && r1.roads && m.junctions[0].style === 'roundabout' && m.junctions[0].source === 'marker', 'updateRegion: a roundabout marker added later rebuilds the junction as roundabout');
  const r2 = m.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { markers: markers({ x: 2000, z: 2000, tags: ['roundabout'] }) });
  const r3 = m.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { markers: markers({ x: 2000, z: 2000, tags: ['roundabout'] }, { x: 100, z: 100, tags: ['spawn'] }) });
  assert(!r2.markers && !r3.roads, 'updateRegion: unchanged / unrelated markers do not rebuild roads');
  m.dispose();
}
{ // crosswalk never inside a junction or on a bridge; one-way highway has no median barrier
  const a = line(1, 10, 1600, 2000, 2400, 2000, city, 9), b = line(2, 10, 2000, 1600, 2000, 2400, city, 9);
  a.points[4].features = ['crosswalk']; a.points[1].features = ['crosswalk']; a.points[1].bridge = true; a.points[0].features = ['crosswalk']; // (4) = crossing centre; (1) = on a bridge; (0) = ok
  const m = loadMapFromData(mkData([a, b]), { THREE, physics: false });
  assert(m.roadDetail.zebras.filter((z) => z.kind === 'feature').length === 1 && m.roadDetail.counts.crosswalkSigns === 2, 'crosswalk skipped inside a junction disc and on a bridge (1 of 3 kept)');
  m.dispose();
  const h2 = loadMapFromData(mkData([line(1, 20, 1000, 1000, 1800, 1000, { ...hwy, oneway: true }, 17)]), { THREE, physics: false });
  const h3 = loadMapFromData(mkData([line(1, 20, 1000, 1000, 1800, 1000, hwy, 17)]), { THREE, physics: false });
  assert(h2.roadDetail.counts.pieces.median === 0 && h3.roadDetail.counts.pieces.median > 0, `median barrier only on two-way highways (one-way ${h2.roadDetail.counts.pieces.median}, two-way ${h3.roadDetail.counts.pieces.median} pieces)`);
  h2.dispose(); h3.dispose();
}
{ const l = highwayLanes(10, false), o = highwayLanes(10, true); assert(l.lanes === 2 && Math.abs(l.laneW - 3.4) < 1e-9 && o.lanes === 4, `highway lanes from width: 20 m two-way = ${l.lanes} per direction of ${l.laneW.toFixed(2)} m, one-way ${o.lanes} lanes`); }

// ---------------------------------------------------------------- 1b. a road meeting itself
console.log('--- self-meeting roads');
{
  const mkRoad = (pts, meta = {}, width = 10) => ({ id: 1, widthMeters: width, points: pts.map(([x, z], i) => ({ x, z, y: 20, bridge: false, ...(typeof meta === 'function' ? meta(i, x, z) : meta) })) });
  const fig8 = (meta = {}, a = 300, b = 150, cx = 2000, cz = 2000) => mkRoad(Array.from({ length: 111 }, (_, i) => { const t = -0.6 + i * (Math.PI + 1.2) / 110; return [cx + a * Math.sin(t), cz + b * Math.sin(t) * Math.cos(t)]; }), meta);
  const run = (roads, extra) => { const m = loadMapFromData(mkData(roads, extra), { THREE, physics: false }); return { j: m.junctions, m }; };
  const ids = (j) => j.arms.map((a) => a.roadId + ':' + a.s.toFixed(1) + ':' + a.angle.toFixed(3));
  const dist = (j) => new Set(ids(j)).size === j.arms.length;
  let r = run([fig8()]);
  assert(r.j.length === 1 && r.j[0].style === 'roundabout' && r.j[0].arms.length === 4 && Math.hypot(r.j[0].x - 2000, r.j[0].z - 2000) < 5, 'figure-eight (country): one 4-arm junction at the crossing -> roundabout');
  assert(dist(r.j[0]) && new Set(r.j[0].arms.map((a) => a.pass)).size === 2 && r.j[0].arms.every((a) => Number.isFinite(a.s) && Number.isInteger(a.seg)), `arm identities are distinct (roadId:s:angle ${ids(r.j[0]).join(' ')}), 2 passes, s and seg present`);
  { // roundabout trimming: both spans of the one road are cut at the ring
    const kind = r.m.parts.roadMesh.geometry.attributes.aKind.array, pos = r.m.parts.roadMesh.geometry.attributes.position.array, Ro = r.j[0].radius; let inside = 0;
    for (let i = 0; i < kind.length; i++) if (kind[i] === 0 && Math.hypot(pos[3 * i] - 2000, pos[3 * i + 2] - 2000) < Ro - 6) inside++;
    assert(inside === 0, 'roundabout on a figure-eight: no road ribbon vertices inside the ring (both passes trimmed at the ring)');
  }
  r.m.dispose();
  r = run([fig8({ type: 'city' }, 300, 300)]); // 90 degree crossing
  assert(r.j.length === 1 && r.j[0].style === 'signals' && r.j[0].arms.length === 4, 'figure-eight (city): signals junction, 4 arms');
  {
    const D = r.m.roadDetail, j = r.j[0], g = j.signals;
    assert(g.length === 4 && D.zebras.filter((z) => z.kind === 'signals').length === 4 && D.cornerBlocks.length === 4, 'city figure-eight: 4 signal posts, 4 zebras, 4 corner blocks');
    assert(new Set(g.map((p) => p.group)).size === 2 && g.every((a) => g.every((b) => (a.group === b.group) === (Math.abs(a.fx * b.fx + a.fz * b.fz) > 0.9))), 'signal phases: the two arms of one pass share a phase (opposite arms), the crossing pass has the other');
    let bad = 0; for (const p of D.footpaths) if (Math.hypot(p.ax - j.x, p.az - j.z) < j.radius - 0.5 || Math.hypot(p.bx - j.x, p.bz - j.z) < j.radius - 0.5) bad++;
    assert(bad === 0 && dist(j), 'city figure-eight: footpath cut at the patch on all four arms, arm ids distinct');
  }
  r.m.dispose();
  { const x = run([fig8({ type: 'city' })]); assert(x.j.length === 1 && x.m.roadDetail.cornerBlocks.length === 2 && x.j[0].signals.length === 4, 'city figure-eight crossing at 53 degrees: signals + 4 posts, corner blocks only for the two obtuse corners (documented limit for sharp corners)'); x.m.dispose(); }
  // lollipop: the end lands on the road's own body -> 3-arm T
  const lolli = [[1000, 1000], [1200, 1000], [1400, 1000], [1600, 1000], [1750, 900], [1700, 750], [1500, 680], [1320, 760], [1295, 900], [1300, 1000]];
  r = run([mkRoad(lolli)]);
  assert(r.j.length === 1 && r.j[0].style === 'junction' && r.j[0].arms.length === 3 && r.j[0].arms.filter((a) => a.pass === 0).length === 2 && dist(r.j[0]), `lollipop: one 3-arm T junction (${r.j.map((j) => j.style + '/' + j.arms.length)})`);
  r.m.dispose();
  r = run([mkRoad(lolli, { type: 'city' })]); assert(r.j.length === 1 && r.j[0].style === 'signals' && r.j[0].signals.length === 3, 'lollipop (city): signals, 3 posts'); r.m.dispose();
  // closed loop: last node = first node
  const circle = Array.from({ length: 41 }, (_, i) => { const a = i / 40 * 2 * Math.PI; return [2000 + 300 * Math.cos(a), 2000 + 300 * Math.sin(a)]; });
  r = run([mkRoad(circle)]);
  assert(r.j.length === 1 && r.j[0].arms.length === 2 && r.j[0].arms.every((a) => a.s < 1 || a.s > 1800) && dist(r.j[0]) && Math.hypot(r.j[0].x - 2300, r.j[0].z - 2000) < 10, `closed loop: one junction where the last node meets the first, 2 end arms (s = ${r.j[0] && r.j[0].arms.map((a) => a.s.toFixed(0))})`);
  r.m.dispose();
  // no junction: hairpin legs 30 m apart, tight C-curve, spiral, hairpin crossing below 25 degrees
  const none = (name, pts, w = 10) => { const x = run([mkRoad(pts, {}, w)]); assert(x.j.length === 0, `${name}: no junction (${x.j.length})`); x.m.dispose(); };
  none('hairpin (parallel legs 30 m apart)', [[1000, 2000], [1400, 2000], [1700, 2000], [1760, 2015], [1700, 2030], [1400, 2030], [1000, 2030]]);
  none('tight 270-degree curve (R 25 m)', Array.from({ length: 28 }, (_, i) => { const a = i / 27 * 1.5 * Math.PI; return [2000 + 25 * Math.cos(a), 2000 + 25 * Math.sin(a)]; }));
  none('spiral, turns 63 m apart', Array.from({ length: 150 }, (_, i) => { const t = i / 149 * 4 * Math.PI, rr = 200 - 10 * t; return [2000 + rr * Math.cos(t), 2000 + rr * Math.sin(t)]; }));
  const hp = (deg) => { const k = Math.tan(deg * Math.PI / 180); return [[1000, 2000], [1400, 2000], [1800, 2000], [1850, 2030], [1800, 2060], [1500, 2060 - 300 * k], [1000, 2060 - 800 * k]]; };
  none('hairpin crossing its own leg at 15 degrees', hp(15));
  { const x = run([mkRoad(hp(40))]); assert(x.j.length === 1 && x.j[0].arms.length === 4, `same shape crossing at 40 degrees DOES make a 4-arm junction (${x.j.map((j) => j.arms.length)})`); x.m.dispose(); }
  // overpass: one part of the figure-eight is a bridge -> no junction
  { const x = run([fig8((i) => ({ bridge: i > 90 && i < 98 }))]); assert(x.j.length === 0, 'self-crossing overpass (one part a bridge): no junction'); x.m.dispose(); }
  // markers still apply to self-junctions
  { const x = run([fig8({ type: 'city' })], { markers: markers(mk(2004, 2003, ['roundabout'])) }); assert(x.j.length === 1 && x.j[0].style === 'roundabout' && x.j[0].source === 'marker', 'marker forces a roundabout on a city figure-eight'); x.m.dispose(); }
  // edge pieces: gap at the self-junction, edges elsewhere
  { const x = run([fig8({ edgeR: 'guardrail' })]), P = x.m.roadDetail.edgePieces; assert(P.length > 20 && !P.some((p) => Math.hypot(p.ax - 2000, p.az - 2000) < x.j[0].radius), `edge pieces gap at the self-junction (${P.length} pieces elsewhere)`); x.m.dispose(); }
  // physics: collider vs heightAt on the new case (bumpy terrain, city figure-eight with corridor stamping)
  {
    const hfn = (x, z) => 20 + 3 * Math.sin(x / 60) + 2 * Math.sin(z / 45), w3 = world(), m = loadMapFromData(mkData([fig8({ type: 'city' })], {}, hfn), { THREE, RAPIER, physicsWorld: w3, physicsResolution: 2048 }); w3.step();
    let mx = 0, n = 0;
    for (const p of m.roads[0].getPoints(6)) for (const l of [-3, 3]) { const x = p.x - p.tz * l, z = p.z + p.tx * l; if (Math.hypot(x - 2000, z - 2000) < 30) continue; const h = w3.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true); if (h) { mx = Math.max(mx, Math.abs(100 - h.timeOfImpact - m.heightAt(x, z))); n++; } }
    const cc = checkCollider(m, RAPIER, w3, 300); info(`figure-eight collider vs heightAt: carriageway rays ${n} max ${(mx * 1000).toFixed(1)} mm; whole map max ${cc.maxErr.toFixed(3)} m`);
    assert(n > 100 && mx < 0.05, 'collider agrees with heightAt along the stamped self-crossing city road'); m.dispose();
  }
  // updateRegion roads edit == full rebuild
  {
    const a = run([mkRoad(lolli)]), full = run([fig8({ type: 'city' })]); a.m.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { roads: { roads: [fig8({ type: 'city' })] } }); a.m.flush();
    const sum = (m) => JSON.stringify({ j: m.junctions, f: m.roadDetail.footpaths, c: m.roadDetail.cornerBlocks, z: m.roadDetail.zebras.map((q) => [q.x, q.z]) }) + Array.from(m.parts.roadMesh.geometry.attributes.position.array.slice(0, 4000)).join();
    assert(sum(a.m) === sum(full.m), 'updateRegion (lollipop -> city figure-eight) == full rebuild'); a.m.dispose(); full.m.dispose();
  }
}

// ---------------------------------------------------------------- 2. the citytest map
console.log('--- citytest map');
const dir = path.resolve('public/maps/citytest');
if (!fs.existsSync(dir)) { assert(false, 'public/maps/citytest missing: run node scripts/make-city-test-map.mjs'); process.exit(1); }
globalThis.fetch = async (url) => { const f = path.join(dir, path.basename(url)); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 }); };
const w = world(), map = await loadMap('/maps/citytest/', { THREE, RAPIER, physicsWorld: w });
w.step();
const D = map.roadDetail, C = D.counts, J = map.junctions;
console.log('     counts', JSON.stringify(C));
const jAt = (x, z) => J.find((j) => Math.hypot(j.x - x, j.z - z) < 12);
const jIdx = (x, z) => J.indexOf(jAt(x, z));
const cast = (ox, oy, oz, dx, dy, dz, max = 60) => { const h = w.castRay(new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }), max, true); return h ? h.timeOfImpact : null; };
const down = (x, z, top = 60) => { const t = cast(x, top, z, 0, -1, 0, 100); return t === null ? null : top - t; };
const GROUND = (x, z) => map.heightAt(x, z), LIFT = 0.03, MAXH_CT = map.info.maxHeight;
const footMesh = (m) => { let f = null; m.parts.roadGroup.traverse((o) => { if (o.name === 'footpaths') f = o; }); return f; };

// junction styles on the real map
for (const [x, z, st, src, arms] of [[150, 150, 'signals', 'default', 4], [150, 293, 'signals', 'default', 4], [300, 293, 'signals', 'default', 3], [300, 220, 'signals', 'default', 3], [300, 150, 'roundabout', 'marker', 4], [150, 220, 'junction', 'marker', 3], [700, 470, 'junction', 'default', 3]]) {
  const j = jAt(x, z); assert(!!j && j.style === st && j.source === src && j.arms.length === arms, `junction (${x},${z}): ${j && j.style}/${j && j.source}/${j && j.arms.length} arms (expected ${st}/${src}/${arms})`);
}
assert(J.length === 8 && J.filter((j) => j.style === 'roundabout' && j.x < 500).every((j) => j.source === 'marker'), 'every roundabout in the city comes from the marker (8 junctions in total incl. the self-crossing road)');
{ const s = jAt(800, 160); assert(!!s && s.style === 'roundabout' && s.arms.length === 4 && new Set(s.arms.map((a) => a.pass)).size === 2, 'country figure-eight road (id 8): 4-arm roundabout at its self-crossing (800,160)'); }

// signals: posts, zebras, phase groups, lights
const sig = J.filter((j) => j.style === 'signals');
assert(sig.map((j) => j.signals.length).sort().join() === '3,3,4,4' && C.signalPosts === 14, `signal posts per signals junction 3,3,4,4 (total ${C.signalPosts}, one per incoming arm)`);
for (const j of sig) {
  const ji = J.indexOf(j), zs = D.zebras.filter((z) => z.kind === 'signals' && z.junction === ji);
  assert(zs.length === j.arms.length, `signals (${j.x.toFixed(0)},${j.z.toFixed(0)}): a zebra crossing on every arm (${zs.length}/${j.arms.length})`);
  const facing = j.signals.every((p) => (p.x - j.x) * p.fx + (p.z - j.z) * p.fz > 0 && Math.hypot(p.x - j.x, p.z - j.z) > j.radius && Math.abs(Math.hypot(p.fx, p.fz) - 1) < 1e-6);
  assert(facing, `signals (${j.x.toFixed(0)},${j.z.toFixed(0)}): every head faces out along its arm (toward the approaching traffic), posts stand outside the patch`);
  const grp = j.signals.every((a) => j.signals.every((b) => (a.group === b.group) === (a.roadId === b.roadId)));
  assert(grp, `signals (${j.x.toFixed(0)},${j.z.toFixed(0)}): arms of one road share a phase, the other road has the other phase`);
}
{ // post + railing colliders are solid
  const p = sig[0].signals[0], t = cast(p.x - 1.5, p.y + 1, p.z, 1, 0, 0, 3), t2 = cast(p.x, p.y + 1, p.z - 1.5, 0, 0, 1, 3), t3 = cast(p.x + 1.5, p.y + 1, p.z, -1, 0, 0, 3), t4 = cast(p.x, p.y + 1, p.z + 1.5, 0, 0, -1, 3);
  assert([t, t2, t3, t4].some((v) => v !== null && Math.abs(v - 1.5) < 0.25), 'signal post has a collider (horizontal ray hits the pole)');
  assert(C.signalRails === 28 && C.signalColliders === 14 + 28, `pedestrian railings: ${C.signalRails} runs (2 per city arm) + ${C.signalPosts} posts all with colliders (${C.signalColliders})`);
}
{ // signal cycle: time uniform, never two conflicting greens, opposite arms share a phase
  let lens = null; map.parts.roadProps.traverse((o) => { if (o.name === 'signal_lenses') lens = o; });
  assert(!!lens && lens.count === 14, 'lens meshes instanced: 1 draw call for all 14 heads x 3 lights');
  let conflicts = 0, seen = new Set();
  for (let t = 0; t < 48; t += 0.25) { const a = signalState(0, t), b = signalState(1, t); seen.add(a + '/' + b); if (a === 'green' && b === 'green') conflicts++; if ((a === 'green' || a === 'amber') && (b === 'green' || b === 'amber')) conflicts++; }
  assert(conflicts === 0 && seen.has('green/red') && seen.has('red/green') && seen.has('amber/red') && seen.has('red/red'), `signal cycle: groups never both go (${[...seen].join(' ')}), 1 s all-red between phases`);
  map.update(5); const s0 = [map.signalState(0), map.signalState(1), lens.material.uniforms.uTime.value];
  map.update(5); const s1 = [map.signalState(0), map.signalState(1), lens.material.uniforms.uTime.value];
  map.update(1.5); const s2 = [map.signalState(0), map.signalState(1)];
  assert(s0.join() === 'green,red,5' && s1.join() === 'amber,red,10' && s2.join() === 'red,red', `map.update(dt) drives the light cycle and the shader time uniform (${s0.join('|')} ${s1.join('|')} ${s2.join('|')})`);
}

// zebra / crosswalk features
{
  const feats = D.zebras.filter((z) => z.kind === 'feature');
  assert(feats.length === 3 && C.crosswalkSigns === 6, `3 crosswalk features (2 city, 1 country) -> 3 zebras + 6 pedestrian signs`);
  const kind = map.parts.roadMesh.geometry.attributes.aKind.array, pos = map.parts.roadMesh.geometry.attributes.position.array;
  for (const f of feats) {
    let zmin = 1e9, zmax = -1e9, n = 0;
    for (let i = 0; i < kind.length; i++) if (kind[i] === 6 && Math.hypot(pos[3 * i] - f.x, pos[3 * i + 2] - f.z) < 8 && Math.abs(pos[3 * i] - f.x) < 8) { n++; const a = (pos[3 * i] - f.x) * f.tx + (pos[3 * i + 2] - f.z) * f.tz; zmin = Math.min(zmin, a); zmax = Math.max(zmax, a); }
    assert(n >= 6 && Math.abs(zmax - zmin - 3) < 0.05, `zebra at (${f.x.toFixed(0)},${f.z.toFixed(0)}): ${n} shader-stripe vertices, ${(zmax - zmin).toFixed(2)} m deep along the road (spec ~3)`);
  }
  const sg = D.crosswalkSigns;
  assert(feats.every((f) => { const p = sg.filter((s) => Math.hypot(s.x - f.x, s.z - f.z) < 8); return p.length === 2 && p[0].side !== p[1].side && p[0].dir !== p[1].dir; }), 'each crossing has one sign per side, facing the traffic of that side');
  const s0 = sg[0], t = cast(s0.x - 2, GROUND(s0.x, s0.z) + 1, s0.z, 1, 0, 0, 4), t2 = cast(s0.x + 2, GROUND(s0.x, s0.z) + 1, s0.z, -1, 0, 0, 4), t3 = cast(s0.x, GROUND(s0.x, s0.z) + 1, s0.z - 2, 0, 0, 1, 4), t4 = cast(s0.x, GROUND(s0.x, s0.z) + 1, s0.z + 2, 0, 0, -1, 4);
  assert([t, t2, t3, t4].some((v) => v !== null && Math.abs(v - 2) < 0.2), 'crosswalk sign post has a collider');
  let ped = 0; map.parts.roadSigns.traverse((o) => { if (o.name === 'sign_pedestrian') ped = o.count; });
  assert(ped === 6, 'pedestrian sign faces are instanced (6)');
  // city crossing: kerb dropped (flush pavement, no collider); mid-block kerb still full height
  const c = feats.find((f) => Math.abs(f.x - 230) < 1 && Math.abs(f.z - 293) < 1), mid = down(230, 293 + 6.5);
  assert(Math.abs(mid - GROUND(230, 293 + 6.5)) < 0.02, `city crosswalk: no kerb collider at the crossing (ray hits the ground: ${(mid - GROUND(230, 293 + 6.5)).toFixed(3)} m above it)`);
  assert(!!c && map.surfaceAt(230, 293 + 6.5).roadSurface === 'footpath' && down(230 + 1.2, 293 + 6.5) - GROUND(230, 293 + 6.5) < 0.02 && down(230 + 4.5, 293 + 6.5) - GROUND(230, 293 + 6.5) > 0.1, 'city crosswalk: flush pavement (still footpath) in the 3.8 m gap, kerb ramps back up to full height within ~4.5 m');
}

// kerb + footpath geometry (H1 = road 0, heading +x, + side = +z)
{
  const x = 215, zc = 150, g0 = GROUND(x, zc);
  const road = down(x, zc), kerbTop = down(x, zc + 5 + 0.1), foot = down(x, zc + 6.5), foot2 = down(x, zc + 7.4), beyond = down(x, zc + 5 + FOOT_SHIFT + 1.5), left = down(x, zc - 6.5);
  assert(Math.abs(road - g0) < 0.01, `road collider = heightfield at heightAt (${road.toFixed(3)} vs ${g0.toFixed(3)})`);
  assert(Math.abs(kerbTop - (g0 + LIFT + CITY.KERB_H)) < 0.01, `kerb top ${(kerbTop - g0 - LIFT).toFixed(3)} m above the road surface (spec ~0.15)`);
  assert(Math.abs(foot - kerbTop) < 0.01 && Math.abs(foot2 - kerbTop) < 0.01 && Math.abs(left - kerbTop) < 0.01, 'footpath top flat at kerb height on both sides, 2.5 m paving');
  assert(Math.abs(beyond - GROUND(x, zc + 5 + FOOT_SHIFT + 1.5)) < 0.01, 'footpath ends 2.65 m from the road edge (ground beyond)');
  const side = cast(x, g0 + 0.1, zc, 0, 0, 1, 10), outer = cast(x, g0 + 0.1, zc + 9, 0, 0, -1, 10);
  assert(side !== null && Math.abs(side - 5) < 0.1, `kerb face is solid: horizontal ray at 10 cm height hits it ${side && side.toFixed(2)} m from the centre (road edge at 5.00)`);
  assert(outer !== null && Math.abs(outer - (9 - 5 - FOOT_SHIFT)) < 0.1, `footpath outer face is solid (hit ${outer && outer.toFixed(2)} m, expected ${(4 - FOOT_SHIFT).toFixed(2)})`);
  const lamps = D.lamps.filter((l) => l.road === 0);
  assert(lamps.length > 0 && lamps.every((l) => Math.abs(Math.abs(l.z - zc) - (5 + FOOT_SHIFT + 0.9)) < 0.05), `lamps (edgeL) on a city road stand outside the footpath: ${lamps.length} lamps, offset ${(5 + FOOT_SHIFT + 0.9).toFixed(2)} m from the centreline`);
  const cm = map.surfaceAt(x, zc + 6.5), cr = map.surfaceAt(x, zc), co = map.surfaceAt(x, zc + 12);
  assert(cm.classId === 7 && cm.roadSurface === 'footpath' && cm.roughness === 0 && cm.gripMul === 1 && cm.weights[7] === 1, 'surfaceAt on a footpath: classId 7, roadSurface footpath, roughness 0, gripMul 1');
  assert(cr.classId === 6 && cr.roadSurface === 'smooth' && co.roadSurface === null && co.classId !== 7, 'surfaceAt: road unchanged (class 6 smooth), beside the footpath = ground');
}

// footpath ends: type change (H2 city -> country at x=360)
{
  const pcs = D.footpaths.filter((p) => p.road === 1 && p.side > 0), maxX = Math.max(...pcs.map((p) => Math.max(p.ax, p.bx)));
  const h = (x) => down(x, 293 + 6.5) - GROUND(x, 293 + 6.5) - LIFT;
  assert(maxX > 355 && maxX < 361, `footpath of H2 ends at the type change (last piece reaches x=${maxX.toFixed(1)}, country from 360)`);
  assert(Math.abs(h(345) - 0.15) < 0.01 && h(358.4) < 0.1 && h(358.4) > 0.01, `end cap ramps down: kerb ${(h(345) * 100).toFixed(0)} cm at x=345, ${(h(358.4) * 100).toFixed(1)} cm at x=358.4`);
  assert(Math.abs(down(380, 293 + 6.5) - GROUND(380, 293 + 6.5)) < 0.02 && map.surfaceAt(380, 293 + 6.5).roadSurface === null, 'no footpath on the country stretch');
  assert(D.footpaths.every((p) => p.road !== 5 && p.road !== 6), 'no footpath on highway / country roads (roads 6, 7)');
}

// junction footprints: no footpath inside, corner blocks instead
{
  let bad = 0, minD = 1e9;
  for (const p of D.footpaths) for (const j of J) for (const [x, z] of [[p.ax, p.az], [p.bx, p.bz], [p.ox, p.oz]]) { const d = Math.hypot(x - j.x, z - j.z); minD = Math.min(minD, d - j.radius); if (d < j.radius - 0.5) bad++; }
  assert(bad === 0, `no footpath piece inside a junction patch / roundabout footprint (closest footpath point ${minD.toFixed(2)} m outside the radius)`);
  const per = (ji) => D.cornerBlocks.filter((c) => c.junction === ji).length;
  assert(per(jIdx(150, 150)) === 4 && per(jIdx(150, 293)) === 4 && per(jIdx(300, 293)) === 3 && per(jIdx(300, 220)) === 3 && per(jIdx(150, 220)) === 3 && per(jIdx(300, 150)) === 0 && per(jIdx(700, 470)) === 0, `corner blocks: ${C.cornerBlocks} (4/4/3/3 at the signals, 3 at the plain city T, none at the roundabout / highway junction)`);
  const cb = D.cornerBlocks.find((c) => c.junction === jIdx(150, 150)), pts = cb.poly, n = pts.length / 2;
  let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += pts[2 * i]; cz += pts[2 * i + 1]; } cx /= n; cz /= n;
  const inPoly = (x, z) => { let ins = false; for (let i = 0, k = n - 1; i < n; k = i++) { const xi = pts[2 * i], zi = pts[2 * i + 1], xk = pts[2 * k], zk = pts[2 * k + 1]; if ((zi > z) !== (zk > z) && x < (xk - xi) * (z - zi) / (zk - zi) + xi) ins = !ins; } return ins; };
  // sample inside the block (nearest-to-centroid vertex pulled toward the centroid)
  const ia = 1 + (n - 4) / 2 | 0, ib = n - 2; // curve apex and the outer miter corner (poly = Ain, curve.., Nin, Nout, Xo, Aout)
  const sx = (pts[2 * ia] + pts[2 * ib]) / 2, sz = (pts[2 * ia + 1] + pts[2 * ib + 1]) / 2; void cx; void cz;
  const top = down(sx, sz), s = map.surfaceAt(sx, sz);
  assert(inPoly(sx, sz) && Math.abs(top - (GROUND(sx, sz) + LIFT + CITY.KERB_H)) < 0.015 && s.roadSurface === 'footpath', `corner block is solid at kerb height (top ${(top - GROUND(sx, sz) - LIFT).toFixed(3)} m, surfaceAt footpath)`);
  // triangulated top area == outline area (no holes / overlaps): kind 0 band quads + kind 3 earcut polygon whose centroid lies inside the outline
  const fg = footMesh(map).geometry, fp = fg.attributes.position.array, fk = fg.attributes.aFp.array, ix = fg.index.array;
  let area = 0; for (let t = 0; t < ix.length; t += 3) { const a = ix[t], b = ix[t + 1], c = ix[t + 2]; if (fk[3 * a + 2] !== 0 && fk[3 * a + 2] !== 3) continue; if (fp[3 * a + 1] < 0 || Math.abs(fp[3 * a + 1] - fp[3 * b + 1]) > 1e-6 || Math.abs(fp[3 * a + 1] - fp[3 * c + 1]) > 0.2) continue;
    const mx = (fp[3 * a] + fp[3 * b] + fp[3 * c]) / 3, mz = (fp[3 * a + 2] + fp[3 * b + 2] + fp[3 * c + 2]) / 3; if (!inPoly(mx, mz)) continue;
    area += Math.abs((fp[3 * b] - fp[3 * a]) * (fp[3 * c + 2] - fp[3 * a + 2]) - (fp[3 * c] - fp[3 * a]) * (fp[3 * b + 2] - fp[3 * a + 2])) / 2; }
  let pa = 0; for (let i = 0, k = n - 1; i < n; k = i++) pa += pts[2 * k] * pts[2 * i + 1] - pts[2 * i] * pts[2 * k + 1]; pa = Math.abs(pa) / 2;
  info(`corner block outline area ${pa.toFixed(2)} m2, visible top triangles ${area.toFixed(2)} m2`);
  assert(Math.abs(area - pa) / pa < 0.02, 'corner block top mesh covers its outline exactly (earcut + kerb band, no gaps / overlaps)');
  const finite = [map.parts.roadMesh.geometry.attributes.position.array, fp, fg.attributes.normal.array].every((a) => a.every(Number.isFinite));
  assert(finite, 'road + footpath meshes contain no NaN');
}

// highway
{
  const med = D.edgePieces.filter((p) => p.type === 'median'), jh = jAt(700, 470);
  assert(med.length > 20 && med.every((p) => Math.abs(p.az - 470) < 0.05 && Math.abs(p.bz - 470) < 0.05), `median barrier: ${med.length} pieces on the highway centreline`);
  assert(med.every((p) => Math.hypot(p.ax - jh.x, p.az - jh.z) > jh.radius), 'median barrier has a gap at the country-road junction');
  const t = cast(590, GROUND(590, 470) + 0.4, 470 - 3, 0, 0, 1, 6);
  assert(t !== null && Math.abs(t - 2.7) < 0.12, `median barrier collider: horizontal ray hits at ${t && t.toFixed(2)} m (expected 2.70)`);
  assert(D.colliderBoxes.some((b) => b.type === 'median'), 'median colliders are generated (cuboid chords)');
  const meta = map.parts.roadMesh.geometry.attributes.aMeta.array; let ty = [0, 0, 0]; for (let i = 2; i < meta.length; i += 3) ty[meta[i]]++;
  assert(ty[0] > 0 && ty[1] > 0 && ty[2] > 0, `road mesh carries the road type per vertex (country ${ty[0]}, city ${ty[1]}, highway ${ty[2]} vertices)`);
}

// terrain corridor stamping
{
  const dataOf = async () => { const rd = (f) => fs.readFileSync(path.join(dir, f)), rb = rd('heightmap.r16'); const [d0, d1, dw] = await Promise.all(['splat0.png', 'splat1.png', 'water.png'].map((f) => decodePNG(rd(f)))); return () => ({ info: JSON.parse(rd('map.json')), height: new Uint16Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.length)), splat0: d0.data.slice(), splat1: d1.data.slice(), water: dw.data.slice(), roads: JSON.parse(rd('roads.json')), markers: JSON.parse(rd('markers.json')) }); };
  const mk0 = await dataOf(), flat = loadMapFromData({ ...mk0(), roads: { roads: [] } }, { THREE, physics: false });
  // corridor samples: carriageway + footpath of the city stretches, away from junctions
  let n = 0, sum = 0, mx = 0, spread = 0, ray = 0, rsum = 0, rn = 0, worst = null;
  const cityRoads = [[1, 'x', 150, 60, 430], [2, 'x', 293, 60, 360], [3, 'z', 150, 60, 430], [4, 'z', 300, 60, 293]];
  for (const [, axis, fixed, a0, a1] of cityRoads) for (let s = a0; s <= a1; s += 1.3) for (const lat of [-6, -3, 0, 3, 6]) {
    const x = axis === 'x' ? s : fixed + lat, z = axis === 'x' ? fixed + lat : s;
    if (J.some((j) => Math.hypot(j.x - x, j.z - z) < j.radius + 14)) continue;
    const d = Math.abs(map.heightAt(x, z) - flat.heightAt(x, z)); n++; sum += d; mx = Math.max(mx, d);
    const base = map.heightAt(axis === 'x' ? s : fixed, axis === 'x' ? fixed : s); spread = Math.max(spread, Math.abs(map.heightAt(x, z) - base));
    if (Math.abs(lat) <= 3) { const h = down(x, z); if (h !== null) { const e = Math.abs(h - map.heightAt(x, z)); ray = Math.max(ray, e); rsum += e; rn++; if (e === ray) worst = [x, z]; } }
  }
  info(`stamped corridor samples ${n}: terrain moved by max ${mx.toFixed(2)} m, mean ${(sum / n).toFixed(2)} m vs the unstamped grid`);
  assert(mx > 0.0 && spread < 0.05, `corridor is flat across carriageway + footpaths (max cross-section deviation ${(spread * 100).toFixed(1)} cm, spec: footpaths never clip or float)`);
  assert(rn > 100 && ray < 0.05, `Rapier raycast vs heightAt inside the stamped corridor: max ${(ray * 1000).toFixed(1)} mm, mean ${(rsum / rn * 1000).toFixed(1)} mm over ${rn} rays (physics heightfield uses the stamped grid)`);
  const cc = checkCollider(map, RAPIER, w, 400);
  info(`checkCollider (whole map, random): n=${cc.n} misses=${cc.misses} max=${cc.maxErr.toFixed(3)} m mean=${cc.meanErr.toFixed(4)} m`);
  // footpath vs terrain: every station sits 3 cm + kerb above the terrain at both edges, terrain at the outer edge equals the road level
  let dev = 0; for (const p of D.footpaths) dev = Math.max(dev, Math.abs(map.heightAt(p.ax, p.az) - map.heightAt(p.ox, p.oz)));
  assert(dev < 0.05, `footpath kerb line vs outer edge terrain height differ by at most ${(dev * 100).toFixed(1)} cm over ${D.footpaths.length} pieces`);
  // render mesh agrees: terrain vertex heights inside the corridor are heightAt
  let vmax = 0; map.parts.terrain.traverse((o) => { if (!o.isMesh) return; const p = o.geometry.attributes.position.array; for (let i = 0; i < p.length; i += 3) if (p[i] > 140 && p[i] < 160 && p[i + 2] > 100 && p[i + 2] < 200) vmax = Math.max(vmax, Math.abs(p[i + 1] - map.heightAt(p[i], p[i + 2]))); });
  assert(vmax < 1e-3, `terrain render mesh vertices in the corridor equal heightAt (max ${vmax.toExponential(1)} m)`);
  flat.dispose();

  // loadMapFromData == loadMap(url) and updateRegion == full rebuild
  const B = loadMapFromData(mk0(), { THREE, physics: false });
  const sum2 = (m) => JSON.stringify({ s: m.roadDetail.signs, cw: m.roadDetail.crosswalkSigns, z: m.roadDetail.zebras.map((q) => [q.x, q.z, q.kind]), f: m.roadDetail.footpaths, c: m.roadDetail.cornerBlocks, e: m.roadDetail.edgePieces, sg: m.roadDetail.signals, j: m.junctions });
  const geo = (m) => { const f = footMesh(m); return Array.from(m.parts.roadMesh.geometry.attributes.position.array.slice(0, 6000)).join() + '|' + Array.from(f.geometry.attributes.position.array).join(); };
  const hs = (m) => { let s = ''; for (let z = 40; z < 460; z += 7.3) for (let x = 40; x < 460; x += 7.3) s += m.heightAt(x, z).toFixed(4) + ','; return s; };
  assert(sum2(map) === sum2(B) && geo(map) === geo(B) && hs(map) === hs(B), 'loadMapFromData == loadMap(url): junctions, signals, zebras, footpaths, corner blocks, road + footpath meshes, stamped heights');
  const E = mk0(), rect = { x0: 70, y0: 60, x1: 100, y1: 90 }; // pixels: x 137..195 m, z 117..176 m (inside the H1 / V1 corridor + junction)
  for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) E.height[y * N + x] = Math.min(65535, E.height[y * N + x] + 2000);
  const U = loadMapFromData(mk0(), { THREE, physics: false }), res = U.updateRegion(rect, { height: E.height });
  const R = loadMapFromData(E, { THREE, physics: false });
  assert(res.height && res.roads, 'updateRegion height edit under a city corridor schedules the road rebuild');
  { // rect-restricted corridor stamp (what updateRegion applies immediately) == full restamp of the same cells
    const hk = MAXH_CT / 65535, base = Float32Array.from(mk0().height, (v) => v * hk), runs = cityRuns(map.roads), cell = 1000 / N;
    const A = base.slice(), Bm = base.slice(); stampCityCorridors(A, N, cell, runs); stampCityCorridors(Bm, N, cell, runs);
    for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) Bm[y * N + x] = base[y * N + x];
    stampCityCorridors(Bm, N, cell, runs, rect);
    let d = 0; for (let i = 0; i < A.length; i++) d = Math.max(d, Math.abs(A[i] - Bm[i]));
    assert(d < 1e-5, `restricted stampCityCorridors(rect) == full restamp (max diff ${d.toExponential(1)} m over ${runs.length} city runs)`);
  }
  U.flush();
  assert(hs(U) === hs(R) && geo(U) === geo(R) && sum2(U) === sum2(R), 'updateRegion + flush == full rebuild (heights, footpath mesh, junctions, detail)');
  const cur = mk0(); cur.roads.roads[1].points[4].type = 'city'; cur.roads.roads[1].points[5].type = 'city'; // extend the city stretch of H2 by two segments
  const U2 = loadMapFromData(mk0(), { THREE, physics: false }); U2.updateRegion({ x0: 0, y0: 0, x1: 0, y1: 0 }, { roads: cur.roads }); U2.flush();
  const R2 = loadMapFromData(cur, { THREE, physics: false });
  assert(sum2(U2) === sum2(R2) && geo(U2) === geo(R2) && hs(U2) === hs(R2), 'updateRegion with edited road types (city stretch extended) == full rebuild');
  for (const m of [B, U, R, U2, R2]) m.dispose();
}

// draw calls
{
  let meshes = 0, inst = 0, tris = 0; map.parts.roadGroup.traverse((o) => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) inst++; } });
  const fg = footMesh(map).geometry;
  info(`draw calls: road group ${C.cityDrawCalls ? meshes : meshes} meshes (${inst} instanced); city ${C.cityDrawCalls}, signals ${C.signalDrawCalls}, signs ${C.signDrawCalls}, edges ${C.edgeDrawCalls}; footpath triangles ${fg.index.count / 3}`);
  void tris;
  assert(meshes <= 26 && C.cityDrawCalls === 1 && C.signalDrawCalls === 3, `road group stays at ${meshes} draw calls (footpaths+kerbs+corners 1, signals 3)`);
}
map.dispose();

// ---------------------------------------------------------------- 2b. corridor stamping on strongly sloped, bumpy terrain
console.log('--- stamping on hilly terrain (1000 m, 10% cross slope, +-13 m hills)');
{
  const W2 = 1000, hill = (x, z) => 80 + 8 * Math.sin(x / 35) + 5 * Math.sin(z / 27) + 0.1 * (z - 500), cell = W2 / N;
  const h = new Uint16Array(N * N), s0 = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { h[j * N + i] = Math.round(hill((i + 0.5) * cell, (j + 0.5) * cell) / MAXH * 65535); s0[(j * N + i) * 4] = 255; }
  const pts = Array.from({ length: 17 }, (_, i) => { const x = 100 + i * 50; return { x, z: 500 + 60 * Math.sin(x / 120), y: hill(x, 500), bridge: false, ...(i < 12 ? city : {}) }; }); // city for 11 segments, then country
  const data = { info: { N, worldSizeMeters: W2, maxHeightMeters: MAXH, seaLevel: 0, seaLevelMeters: -50, classes: CLASSES }, height: h, splat0: s0, splat1: new Uint8Array(N * N * 4), water: new Uint16Array(N * N), roads: { roads: [{ id: 1, widthMeters: 10, points: pts }] } };
  const w2 = world(), m = loadMapFromData(data, { THREE, RAPIER, physicsWorld: w2, physicsResolution: 512 }); w2.step();
  const flat = loadMapFromData({ ...data, roads: { roads: [] } }, { THREE, physics: false });
  const P = m.roads[0].getPoints(1); let spread = 0, ray = 0, rsum = 0, rn = 0, moved = 0, kink = 0, cross = 0;
  const ys = [];
  for (let i = 20; i < P.length - 1 && P[i].seg < 10; i++) { // stations of the city stretch, 20 m from its start
    const p = P[i], nx = -p.tz, nz = p.tx, yc = m.heightAt(p.x, p.z); ys.push(yc);
    for (const l of [-7.65, -5, -2.5, 0, 2.5, 5, 7.65]) { const x = p.x + nx * l, z = p.z + nz * l; spread = Math.max(spread, Math.abs(m.heightAt(x, z) - yc)); moved = Math.max(moved, Math.abs(m.heightAt(x, z) - flat.heightAt(x, z))); cross = Math.max(cross, Math.abs(flat.heightAt(x, z) - flat.heightAt(p.x, p.z))); }
    for (const l of [-3, 0, 3]) { const x = p.x + nx * l, z = p.z + nz * l, hit = w2.castRay(new RAPIER.Ray({ x, y: 250, z }, { x: 0, y: -1, z: 0 }), 400, true); if (hit) { const e = Math.abs(250 - hit.timeOfImpact - m.heightAt(x, z)); ray = Math.max(ray, e); rsum += e; rn++; } }
  }
  for (let i = 1; i + 1 < ys.length; i++) kink = Math.max(kink, Math.abs(ys[i - 1] - 2 * ys[i] + ys[i + 1]));
  info(`unstamped cross-section deviation up to ${cross.toFixed(2)} m, terrain moved by up to ${moved.toFixed(2)} m, stamped deviation ${(spread * 100).toFixed(2)} cm, profile 2nd difference (1 m) max ${(kink * 100).toFixed(1)} cm`);
  assert(cross > 0.5 && spread < 0.03, `city corridor flat across carriageway + footpaths (${(spread * 100).toFixed(2)} cm, unstamped terrain deviates ${cross.toFixed(2)} m)`);
  assert(kink < 0.05, `stamped road profile is smooth along the road (max 2nd difference ${(kink * 100).toFixed(1)} cm per m^2)`);
  info(`Rapier raycast vs heightAt on the carriageway of the stamped corridor: max ${(ray * 1000).toFixed(1)} mm, mean ${(rsum / rn * 1000).toFixed(1)} mm over ${rn} rays`);
  assert(ray < 0.06, 'Rapier heightfield agrees with the stamped heightAt in the corridor (< 6 cm)');
  // render mesh vs heightAt at footpath outer edges (the footpath is built from heightAt: no float / clip against the drawn terrain)
  const rc = new THREE.Raycaster(); let md = 0, mn = 0;
  for (const p of m.roadDetail.footpaths.filter((q, i) => i % 4 === 0)) for (const [x, z] of [[p.ox, p.oz], [p.ax, p.az]]) {
    rc.set(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0)); const hit = rc.intersectObject(m.parts.terrain, true)[0];
    if (hit) { md = Math.max(md, Math.abs(hit.point.y - m.heightAt(x, z))); mn++; }
  }
  info(`terrain render mesh vs heightAt at ${mn} footpath edge points: max ${(md * 1000).toFixed(2)} mm`);
  assert(mn > 20 && md < 0.02, 'drawn terrain agrees with heightAt along the footpaths (no floating / clipping)');
  const co = checkCollider(m, RAPIER, w2, 300); info(`checkCollider whole hilly map: max ${co.maxErr.toFixed(3)} m mean ${co.meanErr.toFixed(4)} m`);
  // end of the city stretch blends back into the original terrain
  const e = P.find((p) => p.seg >= 11), eb = Math.abs(m.heightAt(e.x + 12 * e.tx, e.z + 12 * e.tz) - flat.heightAt(e.x + 12 * e.tx, e.z + 12 * e.tz));
  info(`12 m past the city stretch the terrain differs from the original by ${(eb * 100).toFixed(1)} cm`);
  m.dispose(); flat.dispose();
}

// ---------------------------------------------------------------- 3. old maps unchanged
console.log('--- old maps');
for (const name of ['sample', 'junctions', 'roadmeta']) {
  const d2 = path.resolve('public/maps', name);
  globalThis.fetch = async (url) => { const f = path.join(d2, path.basename(url)); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 }); };
  const m = await loadMap('/maps/' + name + '/', { THREE, RAPIER, physicsWorld: world() });
  const st = m.junctions.map((j) => j.style + ':' + j.source).join(' ');
  info(name, 'junctions', st || '-', 'footpath pieces', m.roadDetail.counts.footpathPieces);
  if (name === 'junctions') assert(m.junctions.map((j) => j.style).sort().join() === 'junction,junction,roundabout', 'junctions map: still 1 roundabout + 2 plain junctions (country roads unchanged)');
  assert(m.junctions.every((j) => j.source === 'default' && j.signals.length === 0 && j.style !== 'signals'), `${name}: no signals, all styles from the defaults`);
  m.dispose();
}
console.log(process.exitCode ? '\nFAILED' : '\nall city tests passed');
