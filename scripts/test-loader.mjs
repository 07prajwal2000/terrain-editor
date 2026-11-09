// Node check of the map loader: `npm run test:loader` (sample) or `node scripts/test-loader.mjs --synth 2048` (timing).
// Asserts: PNG decoder is bit-exact, mesh vertices sit on heightAt, Rapier heightfield orientation, water agreement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, loadMapFromData, decodePNG, checkCollider } from '../src/world/mapLoader.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
const mi = process.argv.indexOf('--map');
const sampleDir = path.resolve('public/maps', mi > 0 ? process.argv[mi + 1] : 'sample');
let dir = sampleDir;

// ---- optional synthetic big map (editor format, written with node zlib) ----
const si = process.argv.indexOf('--synth');
if (si > 0) {
  const N = +process.argv[si + 1] || 2048;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-'));
  const png = (w, h, bd, ct, raw) => { // raw big-endian scanlines, filter 0
    const ch = { 0: 1, 6: 4 }[ct], rb = w * ch * bd / 8, f = Buffer.alloc((rb + 1) * h);
    for (let y = 0; y < h; y++) Buffer.from(raw.buffer, raw.byteOffset + y * rb, rb).copy(f, y * (rb + 1) + 1);
    const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = bd; ih[9] = ct;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(f)), chunk('IEND', Buffer.alloc(0))]);
  };
  const h16 = new Uint16Array(N * N), wat = new Uint8Array(N * N * 2), s0 = new Uint8Array(N * N * 4), s1 = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i / N, z = j / N, v = 0.25 + 0.2 * Math.sin(x * 20) * Math.cos(z * 17) + 0.1 * Math.sin(x * 70 + z * 50);
    h16[j * N + i] = Math.max(0, Math.min(65535, Math.round(v * 65535)));
    s0[(j * N + i) * 4] = 255; // all grass
  }
  fs.writeFileSync(path.join(dir, 'heightmap.r16'), Buffer.from(h16.buffer));
  fs.writeFileSync(path.join(dir, 'splat0.png'), png(N, N, 8, 6, s0));
  fs.writeFileSync(path.join(dir, 'splat1.png'), png(N, N, 8, 6, s1));
  fs.writeFileSync(path.join(dir, 'water.png'), png(N, N, 16, 0, wat));
  fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify({ roads: [] }));
  fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify({
    N, worldSizeMeters: 4000, maxHeightMeters: 200, seaLevel: 0.1, seaLevelMeters: 20,
    classes: ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'].map((color, id) => ({ id, name: String(id), color })),
    files: { heightRaw16: 'heightmap.r16', splat0: 'splat0.png', splat1: 'splat1.png', water: 'water.png', roads: 'roads.json' },
  }));
}

// fetch shim: serve the map folder from disk
// extra: files served on top of the folder (markers.json is injected here so public/maps is never modified)
const extra = { 'markers.json': JSON.stringify({ version: 1, markers: [
  { id: 1, name: 'player_start', tags: ['spawn'], color: '#ff3b30', x: 100, z: 120, y: 999, yaw: 90, radius: 0, props: { team: 'a' }, yOffset: 1.5, nx: 0, nz: 0 },
  { id: 2, name: 'ramp_1', tags: ['ramp', 'prop'], color: '#30a0ff', x: 250, z: 200, y: -5, yaw: 0, radius: 15, props: { type: 'ramp_large' }, yOffset: 0, nx: 0, nz: 0 },
  { id: 3, name: '', tags: ['checkpoint', 'spawn'], color: '#ffd400', x: 400, z: 300, y: 0, yaw: 45, radius: 6, props: {}, yOffset: 0.25, nx: 0, nz: 0 },
] }) };
globalThis.fetch = async (url) => {
  const bn = path.basename(url); if (extra[bn]) return new Response(extra[bn]);
  const f = path.join(dir, path.basename(url));
  if (!fs.existsSync(f)) return new Response(null, { status: 404 });
  return new Response(fs.readFileSync(f));
};

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const t0 = performance.now();
const map = await loadMap('/maps/x/', { THREE, RAPIER, physicsWorld: world, physicsResolution: 512 });
console.log(`loadMap total ${(performance.now() - t0).toFixed(0)} ms`, Object.fromEntries(Object.entries(map.info.loadMs).map(([k, v]) => [k, Math.round(v)])));
const { N, worldSize: W, cellSize: c, maxHeight } = map.info;

// 1. decoder exactness vs .r16 (same values by editor contract) -- sample only
if (dir === path.resolve('public/maps/sample')) {
  const hp = await decodePNG(fs.readFileSync(path.join(dir, 'heightmap16.png')));
  const r16 = new Uint16Array(fs.readFileSync(path.join(dir, 'heightmap.r16')).buffer.slice(0));
  let bad = 0; for (let i = 0; i < r16.length; i++) if (hp.data[i] !== r16[i]) bad++;
  assert(hp.bitDepth === 16 && bad === 0, `16-bit PNG decode == .r16 for all ${r16.length} samples (mismatches ${bad})`);
  for (const f of ['splat0.png', 'splat1.png']) if (f === 'splat1.png') {
    const a = await decodePNG(fs.readFileSync(path.join(dir, 'splat0.png'))), b = await decodePNG(fs.readFileSync(path.join(dir, f)));
    let badSum = 0; for (let i = 0; i < N * N; i++) { let s = 0; for (let k = 0; k < 4; k++) s += a.data[i * 4 + k] + b.data[i * 4 + k]; if (s !== 255) badSum++; }
    assert(badSum === 0, `splat0+splat1 weights sum to 255 at every pixel (violations ${badSum})`);
  }
  const wp = await decodePNG(fs.readFileSync(path.join(dir, 'water.png')));
  const vals = new Set(wp.data); console.log('     water.png distinct values:', [...vals].slice(0, 6), `(${vals.size})`);
}

// 2. mesh vertices lie on heightAt; chunk borders share vertices
const terrain = map.parts.terrain; let maxVert = 0, nv = 0;
for (const m of terrain.children) {
  const p = m.geometry.attributes.position.array;
  for (let i = 0; i < p.length; i += 97 * 3) { maxVert = Math.max(maxVert, Math.abs(p[i + 1] - map.heightAt(p[i], p[i + 2]))); nv++; }
}
assert(maxVert < 1e-3, `render-mesh vertices vs heightAt: max |dy| = ${maxVert.toExponential(2)} m over ${nv} vertices`);
// 2b. heightAt is bilinear; the mesh is triangulated, so inside a cell they differ. Report the max over random points.
{
  const g = terrain.children[Math.floor(terrain.children.length / 2)].geometry, ray = new THREE.Raycaster(), mesh = terrain.children[Math.floor(terrain.children.length / 2)];
  const bb = g.boundingBox; let worst = 0, n = 0;
  for (let i = 0; i < 300; i++) {
    const x = bb.min.x + Math.random() * (bb.max.x - bb.min.x), z = bb.min.z + Math.random() * (bb.max.z - bb.min.z);
    ray.set(new THREE.Vector3(x, maxHeight + 10, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(mesh, false)[0]; if (!hit) continue;
    worst = Math.max(worst, Math.abs(hit.point.y - map.heightAt(x, z))); n++;
  }
  console.log(`     bilinear heightAt vs triangle mesh (inside cells): max diff ${worst.toFixed(4)} m over ${n} rays (cell ${c.toFixed(2)} m)`);
}

// 3. physics orientation (Rapier heightfield vs heightAt)
world.step();
const chk = checkCollider(map, RAPIER, world, 400);
console.log(`     raycast vs heightAt: n=${chk.n} misses=${chk.misses} max=${chk.maxErr.toFixed(3)} m mean=${chk.meanErr.toFixed(3)} m`);
// error budget: collider is a triangulated 512^2 resample; compare with the same metric for a deliberately transposed lookup
assert(chk.misses === 0 && chk.n >= 200, 'all raycasts hit the heightfield');
{
  let s = 99; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let tr = 0, mi = 0, k = 0;
  for (let i = 0; i < 300; i++) { // what a transposed / mirrored collider would score
    const x = rnd() * W, z = rnd() * W, h = map.heightAt(x, z);
    tr += Math.abs(map.heightAt(z, x) - h); mi += Math.abs(map.heightAt(W - x, z) - h); k++;
  }
  console.log(`     (for scale: mean |h| error if transposed ${(tr / k).toFixed(2)} m, if x-mirrored ${(mi / k).toFixed(2)} m)`);
  assert(chk.meanErr < Math.min(tr, mi) / k / 5, 'collider mean error is far below transposed/mirrored error');
}

// 4. water consistency (sample only has lakes)
if (map.parts.lakes) {
  const g = map.parts.lakes.geometry, p = g.attributes.position.array; let bad = 0, n = 0, maxd = 0;
  for (let i = 0; i < p.length; i += 3 * 11) {
    const L = map.waterLevelAt(p[i], p[i + 2]); n++;
    if (L === null) continue; // dry shoreline vertices (surface under terrain) legitimately return null
    maxd = Math.max(maxd, Math.abs(L - p[i + 1]));
  }
  assert(maxd < 1e-3 || Number.isNaN(maxd), `waterLevelAt equals lake mesh y at its vertices (max diff ${maxd.toExponential(2)} m, ${n} vertices)`);
}
assert(map.waterLevelAt(W / 2, W / 2) === null || typeof map.waterLevelAt(W / 2, W / 2) === 'number', 'waterLevelAt returns number|null');
// 5. roads: sample vs getPoints agree with the editor's Catmull-Rom at control points
for (const r of map.roads) {
  const a = r.sample(0), b = r.sample(1), pts = r.getPoints(5);
  assert(Math.hypot(a.x - r.points[0].x, a.z - r.points[0].z) < 1e-6 && Math.hypot(b.x - r.points.at(-1).x, b.z - r.points.at(-1).z) < 1e-6, `road ${r.id}: spline passes through end points; ${pts.length} pts @5 m, ${pts.filter((q) => q.bridge).length} bridge pts`);
  const mid = r.sample(2 / (r.points.length - 1));
  assert(Math.hypot(mid.x - r.points[2].x, mid.z - r.points[2].z) < 1e-6, `road ${r.id}: spline passes through control point 2`);
}
// 6. surfaceAt
const sf = map.surfaceAt(W / 2, W / 2);
assert(Math.abs(sf.weights.reduce((a, b) => a + b, 0) - 1) < 1e-4, `surfaceAt weights sum to 1 (class ${sf.classId})`);
const n1 = map.normalAt(W / 2, W / 2); assert(Math.abs(n1.length() - 1) < 1e-5 && n1.y > 0, 'normalAt unit, pointing up');
// 7. junctions / roundabouts / bridges (junctions map)
console.log('     junctions:', map.junctions.map((j) => `${j.style}@(${j.x.toFixed(0)},${j.z.toFixed(0)}) y=${j.y.toFixed(1)} arms=${j.arms.length} r=${j.radius}`).join('  '));
if (mi > 0 && process.argv[mi + 1] === 'junctions') {
  const by = (st) => map.junctions.filter((j) => j.style === st);
  assert(map.junctions.length === 3 && by('roundabout').length === 1 && by('junction').length === 2, 'detected 1 roundabout (4-way crossing) + 2 junctions (T and Y)');
  assert(by('roundabout')[0].arms.length === 4, 'roundabout has 4 arms');
  assert(by('junction').map((j) => j.arms.length).sort().join() === '3,3', 'T and Y junctions have 3 arms each');
  const ov = { x: 420 / 512 * W, z: 150 / 512 * W };
  assert(!map.junctions.some((j) => Math.hypot(j.x - ov.x, j.z - ov.z) < 40), 'overpass (bridge over road 1) produces no junction');
  // override file: force the T into a roundabout / drop the Y -> exercised through a second load
  // road mesh vs the TERRAIN MESH at each junction: gap should be the intended lift (3-6 cm), never negative
  const ray = new THREE.Raycaster(), pos = map.parts.roadMesh.geometry.attributes.position.array, kind = map.parts.roadMesh.geometry.attributes.aKind.array;
  let gmin = 1e9, gmax = -1e9, cnt = 0;
  for (const j of map.junctions) for (let i = 0; i < kind.length; i += 3) {
    if (kind[i] === 5 || Math.hypot(pos[i * 3] - j.x, pos[i * 3 + 2] - j.z) > j.radius + 6) continue;
    ray.set(new THREE.Vector3(pos[i * 3], maxHeight + 50, pos[i * 3 + 2]), new THREE.Vector3(0, -1, 0));
    const h = ray.intersectObject(map.parts.terrain, true)[0]; if (!h) continue;
    const gap = pos[i * 3 + 1] - h.point.y; gmin = Math.min(gmin, gap); gmax = Math.max(gmax, gap); cnt++;
  }
  console.log(`     road mesh above terrain mesh near junctions: min ${(gmin * 100).toFixed(1)} cm, max ${(gmax * 100).toFixed(1)} cm over ${cnt} vertices`);
  assert(gmin > 0.0 && gmax < 0.10, 'road mesh sits 0..10 cm above the rendered terrain at junctions (z-fight margin + polygonOffset)');
  // heightAt at the flat discs = junction y
  for (const j of map.junctions) { let d = 0; for (let a = 0; a < 16; a++) d = Math.max(d, Math.abs(map.heightAt(j.x + Math.cos(a) * (j.radius - 1), j.z + Math.sin(a) * (j.radius - 1)) - j.y)); assert(d < 0.05, `${j.style} disc is flat after stamping (max dev ${(d * 100).toFixed(1)} cm)`); }
  // roundabout: island collider top, ring lane on terrain
  const rb = by('roundabout')[0], top = maxHeight + 50;
  const cast = (x, y, z) => { const h = world.castRay(new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), 500, true); return h ? y - h.timeOfImpact : null; };
  world.step();
  const isl = cast(rb.x, top, rb.z); assert(isl !== null && Math.abs(isl - (rb.y + 0.18)) < 0.02, `island cylinder collider top = junction y + 0.18 (hit ${isl && isl.toFixed(3)}, y ${rb.y.toFixed(3)})`);
  assert(map.surfaceAt(rb.x, rb.z).classId !== 6 && map.surfaceAt(rb.x + rb.radius - 3, rb.z).classId === 6, 'surfaceAt: island is not road, ring lane is road');
  // bridge deck solid; ground below fine
  let decks = 0, bad = 0, below = 0;
  for (const r of map.roads) for (const q of r.getPoints(6)) if (q.bridge) {
    decks++; const dk = cast(q.x, q.y + 3, q.z), gr = cast(q.x, q.y - 0.85, q.z), open = map.heightAt(q.x, q.z) < q.y - 1.2; // under the slab, where the ground is not touching it
    if (dk === null || Math.abs(dk - q.y) > 0.02) bad++;
    if (open && (gr === null || Math.abs(gr - map.heightAt(q.x, q.z)) > 0.5)) below++;
  }
  console.log(`     bridge deck: ${decks} probes, ${bad} not hitting deck top at deck y (+-2 cm); ${below} where ray from under the slab misses terrain`);
  assert(decks > 5 && bad === 0, 'bridge deck collider is solid at all probes');
  assert(below === 0, 'terrain collider below the bridge is intact');
  const sf = map.surfaceAt(rb.x + rb.radius - 3, rb.z); assert(sf.weights[6] === 1, 'surfaceAt weights are pure road on asphalt');
}

// 8. loadMapFromData == loadMap(url); updateRegion == full rebuild; markers --------------------------------------------------
{
  const rd = (f) => fs.readFileSync(path.join(dir, f));
  const [d0, d1, dw] = await Promise.all(['splat0.png', 'splat1.png', 'water.png'].map((f) => decodePNG(rd(f))));
  const rb = rd('heightmap.r16');
  const mkData = () => ({
    info: JSON.parse(rd('map.json')), height: new Uint16Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.length)),
    splat0: d0.data.slice(), splat1: d1.data.slice(), water: dw.data.slice(), roads: JSON.parse(rd('roads.json')), markers: JSON.parse(extra['markers.json']),
  });
  const same = (a, b) => (a.length === b.length) && a.every((v, i) => v === b[i]);
  const meshEq = (A, B) => {
    let bad = 0;
    for (let i = 0; i < A.parts.terrain.children.length; i++) {
      const ga = A.parts.terrain.children[i].geometry.attributes, gb = B.parts.terrain.children[i].geometry.attributes;
      if (!same(ga.position.array, gb.position.array) || !same(ga.normal.array, gb.normal.array)) bad++;
    }
    return bad;
  };
  const lakeEq = (A, B) => (!A.parts.lakes && !B.parts.lakes) || (A.parts.lakes && B.parts.lakes && same(A.parts.lakes.geometry.attributes.position.array, B.parts.lakes.geometry.attributes.position.array) && same(A.parts.lakes.geometry.index.array, B.parts.lakes.geometry.index.array));
  const roadEq = (A, B) => { const a = A.parts.roadMesh.geometry, b = B.parts.roadMesh.geometry; return same(a.attributes.position.array, b.attributes.position.array) && same(a.index.array, b.index.array); };
  const sampleEq = (A, B) => {
    let s = 7, bad = 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 400; i++) {
      const x = rnd() * W, z = rnd() * W;
      if (A.heightAt(x, z) !== B.heightAt(x, z)) bad++;
      const sa = A.surfaceAt(x, z), sb = B.surfaceAt(x, z); if (sa.classId !== sb.classId || !same(sa.weights, sb.weights)) bad++;
      if (A.waterLevelAt(x, z) !== B.waterLevelAt(x, z)) bad++;
    }
    return bad;
  };
  const tex = (m) => [m.parts.material.userData.uniforms.uSplat0.value.image.data, m.parts.material.userData.uniforms.uSplat1.value.image.data];
  const full = (A, B, what) => {
    assert(meshEq(A, B) === 0, `${what}: terrain chunk positions + normals identical`);
    assert(lakeEq(A, B), `${what}: lake mesh identical`);
    assert(roadEq(A, B), `${what}: road mesh identical`);
    assert(sampleEq(A, B) === 0, `${what}: heightAt / surfaceAt / waterLevelAt identical at 400 random points`);
    assert(JSON.stringify(A.junctions) === JSON.stringify(B.junctions) && A.roads.length === B.roads.length, `${what}: junctions + roads identical`);
    assert(same(tex(A)[0], tex(B)[0]) && same(tex(A)[1], tex(B)[1]), `${what}: splat textures identical`);
    assert(JSON.stringify(A.markers) === JSON.stringify(B.markers), `${what}: markers identical`);
  };

  const dataA = mkData();
  const mA = loadMapFromData(dataA, { THREE, physics: false });
  assert(mA.physics === null, 'physics:false builds no collider');
  full(map, mA, 'loadMapFromData vs loadMap(url)');

  // markers via markers.json
  const mk = map.markers;
  assert(mk.length === 3, 'markers.json: 3 markers loaded');
  assert(map.markerByName('ramp_1') && map.markerByName('ramp_1').id === 2 && map.markerByName('nope') === null, 'markerByName');
  assert(map.getMarkers({ tag: 'spawn' }).map((m) => m.id).join() === '1,3' && map.getMarkers({ tag: 'ramp' }).length === 1 && map.getMarkers({ tag: 'x' }).length === 0, 'getMarkers by tag');
  assert(map.getMarkers({ name: 'player_start' }).length === 1 && map.getMarkers({ tag: 'spawn', name: 'player_start' }).length === 1 && map.getMarkers({ tag: 'ramp', name: 'player_start' }).length === 0, 'getMarkers by name and tag combined');
  assert(mk.every((m) => Math.abs(m.y - (map.heightAt(m.x, m.z) + m.yOffset)) < 1e-9), 'marker y == loader heightAt + yOffset (file y ignored)');
  assert(JSON.stringify(mk[0].props) === '{"team":"a"}' && mk[1].radius === 15 && mk[2].name === '', 'marker fields preserved');

  // synthetic edits
  const editData = (d, r, k) => {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
      const i = y * N + x; d.height[i] = Math.min(65535, d.height[i] + 3000 + 40 * ((x + y) % 7));
      d.splat0[i * 4] = 100; d.splat0[i * 4 + 1] = 155; d.splat1[i * 4] = 0;
      if (k && x - r.x0 < 20 && y - r.y0 < 20) d.water[i] = 1 + Math.round(0.5 * 65534);
    }
  };
  const nearRoad = map.roads.length ? map.roads[0].points[Math.min(1, map.roads[0].points.length - 1)] : { x: W / 2, z: W / 2 };
  const px = Math.floor(nearRoad.x / c), pz = Math.floor(nearRoad.z / c);
  const rects = [
    ['edit away from roads (height+splat+water)', { x0: 40, y0: 40, x1: 140, y1: 130 }, true],
    ['edit on a road/junction (heights under roads)', { x0: Math.max(0, px - 45), y0: Math.max(0, pz - 45), x1: Math.min(N, px + 45), y1: Math.min(N, pz + 45) }, false],
  ];
  let t = performance.now(); const cur = mkData(); const mU = loadMapFromData(cur, { THREE, physics: false }); // updated incrementally
  for (const [name, r, wat] of rects) {
    editData(cur, r, wat);
    const mk2 = JSON.parse(extra['markers.json']); mk2.markers[1].x += 1; // also move a marker
    t = performance.now();
    const res = mU.updateRegion(r, { height: cur.height, splat: [cur.splat0, cur.splat1], water: cur.water, roads: cur.roads, markers: mk2 });
    const t1 = performance.now() - t; t = performance.now(); mU.flush(); const t2 = performance.now() - t;
    const ref = loadMapFromData({ ...cur, markers: mk2, splat0: cur.splat0.slice(), splat1: cur.splat1.slice(), height: cur.height.slice(), water: cur.water.slice() }, { THREE, physics: false });
    console.log(`     ${name}: updateRegion ${t1.toFixed(1)} ms + roads flush ${t2.toFixed(1)} ms; changed ${JSON.stringify(res)}`);
    assert(res.height && res.splat, `${name}: reports height+splat changed`);
    full(mU, ref, `updateRegion (${name}) vs full rebuild`);
    ref.dispose();
  }
  // untouched call is a no-op
  const noop = mU.updateRegion({ x0: 0, y0: 0, x1: 50, y1: 50 }, { height: cur.height, splat: [cur.splat0, cur.splat1], water: cur.water, roads: cur.roads });
  assert(!noop.height && !noop.splat && !noop.water && !noop.roads, 'updateRegion with unchanged data is a no-op ' + JSON.stringify(noop));
  mU.dispose(); mA.dispose();
}
map.dispose();
