// Headless check of the nature scatter: `npm run test:scatter` (all maps in public/maps + synthetic painted maps; no browser, no WebGL).
// Covers: determinism / chunk order independence, exclusion rules (water + shore, road + city class, road ribbons, junctions, markers, slope, snow), paint-weight
// density (zero = none, monotonic superset, ~linear), species rules, spacing, generation cost, instance + LOD counts, the Rapier collider pool, a car-vs-trunk crash.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap, loadMapFromData } from '../src/world/mapLoader.js';
import { polyOf } from '../src/world/roads.js';
import { createScatterGen, lodCounts, SCATTER_CONFIG, hash } from '../src/world/scatterGen.js';
import { createColliderPool } from '../src/world/scatterColliders.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
const info = (m) => console.log('     ' + m);
const manifest = JSON.parse(fs.readFileSync('public/nature/nature.json', 'utf8'));
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); if (!fs.existsSync(f)) return new Response(null, { status: 404 }); return new Response(fs.readFileSync(f)); };
async function loadDir(name, opts = {}) { mapDir = path.resolve('public/maps', name); return loadMap('/maps/x/', { THREE, physics: false, ...opts }); }

// ---- synthetic painted map (editor data format): heightFn(x,z)->m, weightsFn(x,z)->[8 weights summing to 1] ----
const CLASS_COLORS = ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'];
function synth({ N = 256, W = 1024, sea = 20, height = () => 60, weights = () => [1, 0, 0, 0, 0, 0, 0, 0] }) {
  const h = new Uint16Array(N * N), s0 = new Uint8Array(N * N * 4), s1 = new Uint8Array(N * N * 4), c = W / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * c, z = (j + 0.5) * c, k = j * N + i;
    h[k] = Math.round(Math.max(0, Math.min(200, height(x, z))) / 200 * 65535);
    const w = weights(x, z), b = w.map((v) => Math.round(v * 255)); let sum = b.reduce((a, v) => a + v, 0); b[0] += 255 - sum; // grass takes the rounding
    for (let q = 0; q < 4; q++) { s0[k * 4 + q] = b[q]; s1[k * 4 + q] = b[4 + q]; }
  }
  return loadMapFromData({
    info: { N, worldSizeMeters: W, maxHeightMeters: 200, seaLevel: sea / 200, seaLevelMeters: sea, classes: CLASS_COLORS.map((color, id) => ({ id, name: String(id), color })) },
    height: h, splat0: s0, splat1: s1, water: new Uint16Array(N * N), roads: { roads: [] },
  }, { THREE, physics: false });
}
const newGen = (map, extra = {}) => createScatterGen({ map, manifest, ...extra });
const allChunks = (gen, group, names = gen.layerNames(group)) => {
  const S = gen.chunkSize[group], n = Math.ceil(gen.worldSize / S), out = [];
  for (const name of names) for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) out.push(gen.layer(name, cx, cz));
  return out;
};
function* instances(layers, cats) {
  for (const L of layers) for (const [cat, p] of Object.entries(L.parts)) { if (cats && !cats.includes(cat)) continue; for (let i = 0; i < p.n; i++) { const o = i * 7, d = p.data; yield { cat, sp: p.species[i], x: d[o], y: d[o + 1], z: d[o + 2], yaw: d[o + 3], scale: d[o + 4], ux: d[o + 5], uz: d[o + 6], L, i }; } }
}
const ms = (f) => { const t = performance.now(); const r = f(); return [performance.now() - t, r]; };

// =================================================================================================
// 1. real maps: determinism + exclusion rules
// =================================================================================================
const REAL = ['sample', 'sample2', 'junctions', 'roadmeta', 'citytest'];
const realMaps = {};
for (const name of REAL) {
  const map = realMaps[name] = await loadDir(name);
  const gen = newGen(map), cfg = gen.cfg, W = gen.worldSize;
  const far = allChunks(gen, 'far'), nearN = Math.min(Math.ceil(W / 48), 8);
  const near = []; for (const n of gen.layerNames('near')) for (let cz = 0; cz < nearN; cz++) for (let cx = 0; cx < nearN; cx++) near.push(gen.layer(n, cx, cz));
  const tot = {}; for (const it of instances([...far, ...near])) tot[it.cat] = (tot[it.cat] || 0) + 1;
  info(`${name} (${W} m): instances ${JSON.stringify(tot)}`);

  // determinism: a fresh generator, chunks generated in a shuffled order, must give byte-identical data
  const gen2 = newGen(map);
  const jobs = []; for (const L of [...far, ...near]) jobs.push([L.name, L.cx, L.cz]);
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(hash(7, i, 0, 0) * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  let diff = 0;
  for (const [n, cx, cz] of jobs) {
    const a = gen.layer(n, cx, cz), b = gen2.layer(n, cx, cz);
    for (const cat of Object.keys(a.parts)) { const p = a.parts[cat], q = b.parts[cat]; if (p.n !== q.n || Buffer.compare(Buffer.from(p.data.buffer), Buffer.from(q.data.buffer)) || Buffer.compare(Buffer.from(p.species.buffer), Buffer.from(q.species.buffer))) diff++; }
  }
  assert(diff === 0, `${name}: same seed, shuffled chunk order, fresh generator -> identical instances (${jobs.length} chunk layers, ${diff} differ)`);
  const gen3 = newGen(map, { override: { seed: 99 } }), a1 = [...instances(allChunks(gen3, 'far', ['tree']))].length, a0 = tot.tree || 0;
  if (a0 > 20) assert([...instances(allChunks(gen3, 'far', ['tree']))].some((v, i) => { const o = [...instances(far.filter((l) => l.name === 'tree'))][i]; return !o || o.x !== v.x; }), `${name}: another seed gives another forest`);

  // exclusion rules against independent re-implementations on the map data
  const segs = []; for (const r of map.roads) { const P = polyOf(r); for (let i = 0; i < P.n - 1; i++) segs.push([P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], r.width / 2]); }
  const roadDist = (x, z) => { let b = 1e9; for (const s of segs) { const bx = s[2] - s[0], bz = s[3] - s[1], l2 = bx * bx + bz * bz, t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * bx + (z - s[1]) * bz) / l2)) : 0; const d = Math.hypot(s[0] + bx * t - x, s[1] + bz * t - z) - s[4]; if (d < b) b = d; } return b; };
  const slopeDeg = (x, z) => Math.atan(Math.hypot((map.heightAt(x + 1, z) - map.heightAt(x - 1, z)) / 2, (map.heightAt(x, z + 1) - map.heightAt(x, z - 1)) / 2)) * 180 / Math.PI;
  const bad = { water: 0, shore: 0, cls: 0, road: 0, junction: 0, marker: 0, slope: 0, snow: 0, n: 0 };
  const all = [...instances([...far, ...near])], stride = Math.max(1, Math.ceil(all.length / 25000));   // big maps: every n-th instance (the brute-force road scan is slow)
  for (let ii = 0; ii < all.length; ii += stride) {
    const it = all[ii];
    const cat = it.cat === 'rockpebble' ? 'rockpebble' : it.cat, c = cfg.cats[cat]; bad.n++;
    if (map.waterLevelAt(it.x, it.z) !== null) bad.water++;
    if (c.shore > 0) { let w = false; for (let k = 0; k < 16 && !w; k++) for (const f of [0.55, 0.95]) { const a = (k + 0.3) * Math.PI / 8; if (map.waterLevelAt(it.x + Math.cos(a) * c.shore * f, it.z + Math.sin(a) * c.shore * f) !== null) w = true; } if (w) bad.shore++; }
    const s = map.surfaceAt(it.x, it.z);
    if (s.classId === 6 || s.classId === 7 || s.weights[7] > c.maxCity + 1e-4) bad.cls++;
    if (s.weights[5] > c.maxSnow + 1e-4) bad.snow++;
    if (roadDist(it.x, it.z) < c.road - 1e-3) bad.road++;
    for (const j of map.junctions) if (j.style !== 'none' && Math.hypot(it.x - j.x, it.z - j.z) < j.radius + c.junction - 1e-3) bad.junction++;
    if (c.marker > 0) for (const m of map.markers) if (Math.hypot(it.x - m.x, it.z - m.z) < Math.max(0, m.radius) + c.marker - 1e-3) bad.marker++;
    if (cat !== 'rock' && slopeDeg(it.x, it.z) > c.maxSlope + 0.01) bad.slope++;
    if (cat === 'rock' && slopeDeg(it.x, it.z) > c.maxSlope + 0.01) bad.slope++;
  }
  assert(Object.entries(bad).every(([k, v]) => k === 'n' || v === 0), `${name}: ${bad.n} instances: water ${bad.water}, shore margin ${bad.shore}, road/city class ${bad.cls}, road ribbon ${bad.road}, junction ${bad.junction}, marker ${bad.marker}, slope ${bad.slope}, snow ${bad.snow} violations (all 0)`);
  // trees spacing
  const T = [...instances(far.filter((l) => l.name === 'tree' || l.name === 'deadtree'))];
  const G = new Map(), key = (a, b) => a * 100003 + b; let minD = 1e9, minDD = 1e9;
  for (const t of T) { const k = key(Math.floor(t.x / 8), Math.floor(t.z / 8)); (G.get(k) || G.set(k, []).get(k)).push(t); }
  for (const t of T) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const u of G.get(key(Math.floor(t.x / 8) + a, Math.floor(t.z / 8) + b)) || []) {
    if (u === t) continue; const d = Math.hypot(u.x - t.x, u.z - t.z); minD = Math.min(minD, d); if (t.cat === 'deadtree' && u.cat === 'deadtree') minDD = Math.min(minDD, d);
  }
  if (T.length > 1) assert(minD >= cfg.cats.tree.minD - 1e-4 && minDD >= cfg.cats.deadtree.minD - 1e-4, `${name}: min centre distance between ${T.length} trees/dead trees = ${minD.toFixed(2)} m (>= ${cfg.cats.tree.minD}), dead-dead ${minDD > 1e8 ? '-' : minDD.toFixed(2)} (>= ${cfg.cats.deadtree.minD})`);
  // rocks only on rock class or steep ground
  let badRock = 0, rocks = 0; for (const it of instances(far, ['rock'])) { rocks++; const s = map.surfaceAt(it.x, it.z); if (s.weights[4] < 1e-3 && slopeDeg(it.x, it.z) < cfg.rock.slopeFrom - 0.1) badRock++; }
  assert(badRock === 0, `${name}: ${rocks} rocks, all on rock class or on slopes >= ${cfg.rock.slopeFrom} deg (${badRock} violate)`);
}

// =================================================================================================
// 2. override file: disabled / density multiplier / exclusion circle
// =================================================================================================
{
  const map = realMaps.sample2, base = newGen(map), baseTrees = [...instances(allChunks(base, 'far', ['tree']))];
  assert(baseTrees.length > 1000, `sample2 has forest: ${baseTrees.length} trees`);
  assert([...instances(allChunks(newGen(map, { override: { disabled: true } }), 'far'))].length === 0, 'scatter.json disabled:true -> no instances');
  assert([...instances(allChunks(newGen(map, { override: { density: { tree: 0 } } }), 'far', ['tree']))].length === 0, 'scatter.json density.tree = 0 -> no trees');
  const half = [...instances(allChunks(newGen(map, { override: { density: { tree: 0.5 } } }), 'far', ['tree']))];
  assert(Math.abs(half.length / baseTrees.length - 0.5) < 0.08, `density.tree 0.5 -> ${(half.length / baseTrees.length * 100).toFixed(0)} % of the trees`);
  const keyOf = (t) => t.x.toFixed(3) + ',' + t.z.toFixed(3), bs = new Set(baseTrees.map(keyOf));
  assert(half.every((t) => bs.has(keyOf(t))), 'halving the multiplier only removes trees (the rest stay exactly where they were)');
  const c = baseTrees[Math.floor(baseTrees.length / 2)], ex = [...instances(allChunks(newGen(map, { override: { exclusions: [{ x: c.x, z: c.z, r: 40 }] } }), 'far', ['tree', 'bush']))];
  assert(ex.every((t) => Math.hypot(t.x - c.x, t.z - c.z) >= 40), 'scatter.json exclusion circle (r 40) keeps trees and bushes out');
}

// =================================================================================================
// 3. paint weight -> density (synthetic bands: forest weight 0 / .25 / .5 / 1, the rest grass)
// =================================================================================================
{
  const W = 1024, bandOf = (x) => Math.min(3, Math.floor(x / 256)), FW = [0, 0.25, 0.5, 1];
  const mk = (fw) => synth({ W, weights: (x) => { const f = fw[bandOf(x)]; return [1 - f, f, 0, 0, 0, 0, 0, 0]; } });
  const mapA = mk(FW), genA = newGen(mapA), margin = 24;
  const inBand = (b) => (it) => it.x > b * 256 + margin && it.x < (b + 1) * 256 - margin;
  const trees = [...instances(allChunks(genA, 'far', ['tree']))];
  const cnt = FW.map((_, b) => trees.filter(inBand(b)).length);
  info(`tree counts per band (forest weight ${FW.join(' / ')}): ${cnt.join(' / ')}`);
  assert(cnt[0] === 0, 'zero forest weight -> zero trees');
  assert(cnt[3] > 1500, `full forest weight -> dense forest (${cnt[3]} trees in ${(208 * 1024 / 1e4).toFixed(0)} ha-ish)`);
  assert(Math.abs(cnt[1] / cnt[3] - 0.25) < 0.05 && Math.abs(cnt[2] / cnt[3] - 0.5) < 0.06, `tree count ~ linear in weight: 25 % -> ${(cnt[1] / cnt[3] * 100).toFixed(1)} %, 50 % -> ${(cnt[2] / cnt[3] * 100).toFixed(1)} % of full`);
  // monotonic superset: same map with the 0.25 band raised to 0.6 keeps every old tree
  const mapB = mk([0, 0.6, 0.5, 1]), treesB = [...instances(allChunks(newGen(mapB), 'far', ['tree']))];
  const kb = new Set(treesB.map((t) => t.x.toFixed(3) + ',' + t.z.toFixed(3) + ',' + t.sp));
  const missing = trees.filter((t) => t.x < 512 && !kb.has(t.x.toFixed(3) + ',' + t.z.toFixed(3) + ',' + t.sp)).length;
  assert(missing === 0 && treesB.filter(inBand(1)).length > cnt[1] * 1.8, `more paint only ADDS trees: 0 of ${trees.filter((t) => t.x < 512).length} old trees moved/removed, band 25 % -> 60 % gives ${cnt[1]} -> ${treesB.filter(inBand(1)).length}`);
  // grass cover follows the grass weight (1 - forest), flowers only on grass, nothing of either on forest-only ground
    const gl = []; { const n = Math.ceil(W / 48); for (const nm of ['grass', 'flower', 'forestfloor']) for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) gl.push(genA.layer(nm, cx, cz)); }
  const gr = [...instances(gl.filter((l) => l.name === 'grass'))], fl = [...instances(gl.filter((l) => l.name === 'flower'))], ff = [...instances(gl.filter((l) => l.name === 'forestfloor'))];
  const gc = FW.map((_, b) => gr.filter(inBand(b)).length), fc = FW.map((_, b) => fl.filter(inBand(b)).length), ffc = FW.map((_, b) => ff.filter(inBand(b)).length);
  info(`grass per band ${gc.join(' / ')}, flowers ${fc.join(' / ')}, forest floor ${ffc.join(' / ')}`);
  assert(gc[3] === 0 && fc[3] === 0, 'forest-only ground (grass weight 0): no grass, no flowers');
  assert(ffc[0] === 0 && ffc[3] > 500, 'ferns / plants only where forest weight > 0');
  assert(Math.abs(gc[2] / gc[0] - 0.5) < 0.07 && Math.abs(gc[1] / gc[0] - 0.75) < 0.07, `grass density follows the grass weight: 75 % -> ${(gc[1] / gc[0] * 100).toFixed(0)} %, 50 % -> ${(gc[2] / gc[0] * 100).toFixed(0)} %`);
  assert(gc[2] > 100 && ffc[2] > 100 && cnt[2] > 100, 'a 50/50 forest/grass pixel grows BOTH trees and grass');
  // slopes, snow, water
  const mapS = synth({ W, height: (x) => 40 + (x < 300 ? 0 : x < 400 ? (x - 300) * 1.5 : 150) + (x > 400 ? (x - 400) * 0.04 : 0), weights: (x, z) => z > 700 ? [0, 0.6, 0, 0, 0, 0.4, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0] });
  const gS = newGen(mapS), tS = [...instances(allChunks(gS, 'far', ['tree']))], rS = [...instances(allChunks(gS, 'far', ['rock']), ['rock'])];
  const sl = (x, z) => Math.atan(Math.hypot((mapS.heightAt(x + 1, z) - mapS.heightAt(x - 1, z)) / 2, (mapS.heightAt(x, z + 1) - mapS.heightAt(x, z - 1)) / 2)) * 180 / Math.PI;
  const steepTrees = tS.filter((t) => sl(t.x, t.z) > gS.cfg.cats.tree.maxSlope).length, snowTrees = tS.filter((t) => mapS.surfaceAt(t.x, t.z).weights[5] > 0.2).length;
  assert(tS.length > 300 && steepTrees === 0, `steep ramp (up to ${sl(350, 100).toFixed(0)} deg): ${tS.length} trees, ${steepTrees} on slopes > ${gS.cfg.cats.tree.maxSlope} deg`);
  assert(snowTrees === 0 && !tS.some((t) => t.z > 700 && t.z < 800 - 0), `snow weight 0.4 (> 0.2 limit): no trees in the snowy band (${snowTrees})`);
  const steepRocks = rS.filter((r) => sl(r.x, r.z) > 26).length;
  assert(rS.length > 0 && rS.every((r) => mapS.surfaceAt(r.x, r.z).weights[4] < 1e-3 ? sl(r.x, r.z) >= 25.9 : true) && steepRocks > 0, `no rock paint anywhere: ${rS.length} rocks, all on slopes >= 26 deg (${steepRocks} steep)`);
  // species by elevation: ramp map, forest everywhere
  const mapE = synth({ W, height: (x) => 25 + x * 0.12, weights: () => [0, 1, 0, 0, 0, 0, 0, 0] }), gE = newGen(mapE);
  const tE = [...instances(allChunks(gE, 'far', ['tree']))], nm = (t) => gE.species[t.sp].name, el = (t) => gE.elev01(mapE.heightAt(t.x, t.z));
  const lowPines = tE.filter((t) => /^Pine/.test(nm(t)) && el(t) < gE.cfg.trees.pineMinCold - 0.1).length, lowT = tE.filter((t) => el(t) < 0.15).length, highT = tE.filter((t) => el(t) > 0.8), highPine = highT.filter((t) => /^Pine/.test(nm(t))).length;
  info(`species ramp: ${lowT} trees in the lowest 15 % of elevation, ${highT.length} in the top 20 % (${highPine} pines)`);
  assert(lowT > 100 && lowPines === 0, 'no pines on the lowest ground');
  assert(highT.length > 100 && highPine / highT.length > 0.3, `pines dominate the cold top: ${(highPine / highT.length * 100).toFixed(0)} % of the trees above 80 % elevation`);
  assert(tE.some((t) => /^(Birch|Maple|Common)/.test(nm(t)) && el(t) < 0.3), 'birch / maple / common trees grow on low ground');
  // water: a lake in a forest, trees keep the shore margin
  const mapL = synth({ W, height: (x, z) => { const d = Math.hypot(x - 512, z - 512); return d < 90 ? 8 : d < 120 ? 8 + (d - 90) / 30 * 40 : 48; }, weights: () => [0, 1, 0, 0, 0, 0, 0, 0] });
  const gL = newGen(mapL), tL = [...instances(allChunks(gL, 'far', ['tree', 'bush']))];
  const wet = (x, z) => mapL.waterLevelAt(x, z) !== null;
  let nearWater = 0, minShore = 1e9; for (const t of tL) { let d = 0; for (; d < 8; d += 0.25) { let hit = false; for (let k = 0; k < 24; k++) if (wet(t.x + Math.cos(k * Math.PI / 12) * d, t.z + Math.sin(k * Math.PI / 12) * d)) hit = true; if (hit) break; } minShore = Math.min(minShore, d); if (d < 2.4) nearWater++; }
  assert(tL.length > 500 && nearWater === 0, `lake: ${tL.length} trees/bushes, none within 2.4 m of water (closest ${minShore.toFixed(1)} m)`);
}

// =================================================================================================
// 4. generation cost, counts, LOD
// =================================================================================================
{
  const map = realMaps.sample2, gen = newGen(map), far = allChunks(gen, 'far'), near = [];
  const nn = Math.ceil(map.info.worldSize / 48);
  info('instances per category on sample2 (whole map): ' + JSON.stringify(Object.fromEntries(Object.entries([...instances(far)].reduce((a, i) => (a[i.cat] = (a[i.cat] || 0) + 1, a), {})))));
  // densest far chunk
  let best = null; for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) { const n = gen.layer('tree', cx, cz).parts.tree.n + gen.layer('bush', cx, cz).parts.bush.n; if (!best || n > best.n) best = { cx, cz, n }; }
  const times = {}; for (const name of gen.layerNames('far')) { gen.clearCache(); let tm = 1e9; for (let r = 0; r < 5; r++) { gen.clearCache(); tm = Math.min(tm, ms(() => gen.layer(name, best.cx, best.cz))[0]); } times[name] = tm; }
  const total = Object.values(times).reduce((a, b) => a + b, 0);
  info(`densest 128 m chunk (${best.cx},${best.cz}): ${Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')} -> ${total.toFixed(2)} ms for all far layers`);
  assert(total < 12 && Math.max(...Object.values(times)) < 6, `far chunk generation is cheap (${total.toFixed(1)} ms total for the densest chunk, worst layer ${Math.max(...Object.values(times)).toFixed(1)} ms)`);
  const nt = {}; for (const name of gen.layerNames('near')) { let tm = 0, mx = 0, k = 0; for (let cz = 0; cz < 10; cz++) for (let cx = 0; cx < 10; cx++) { gen.clearCache(); const [t] = ms(() => gen.layer(name, 10 + cx, 10 + cz)); tm += t; mx = Math.max(mx, t); k++; } nt[name] = `${(tm / k).toFixed(2)} avg / ${mx.toFixed(2)} max`; }
  info('48 m near chunk generation ms: ' + JSON.stringify(nt));
  // per-category LOD counts + triangles around the 3 densest camera spots and each quality
  const camScore = []; for (let x = 100; x < 2000; x += 100) for (let z = 100; z < 2000; z += 100) { const c = lodCounts(gen, far, x, z); camScore.push({ x, z, tris: Object.values(c).reduce((a, o) => a + o.tris, 0) }); }
  camScore.sort((a, b) => b.tris - a.tris);
  const cams = [camScore[0], camScore[Math.floor(camScore.length / 4)], camScore[Math.floor(camScore.length / 2)]];
  for (const cam of cams) {
    const nearL = []; for (const nm of gen.layerNames('near')) for (let cz = Math.max(0, Math.floor((cam.z - 80) / 48)); cz <= Math.floor((cam.z + 80) / 48); cz++) for (let cx = Math.max(0, Math.floor((cam.x - 80) / 48)); cx <= Math.floor((cam.x + 80) / 48); cx++) nearL.push(gen.layer(nm, cx, cz));
    const c = lodCounts(gen, [...far, ...nearL], cam.x, cam.z);
    const line = Object.entries(c).map(([k, o]) => `${k} ${o.lod0}/${o.lod1}/${o.lod2} (cull ${o.culled}, ${(o.tris / 1000).toFixed(0)}k tris)`).join('; ');
    info(`camera (${cam.x},${cam.z}) [lod0/lod1/lod2], high quality: ${line}; total ${(Object.values(c).reduce((a, o) => a + o.tris, 0) / 1e6).toFixed(2)} M tris`);
  }
  for (const q of ['low', 'medium', 'high']) {
    const qc = SCATTER_CONFIG.quality[q], g = newGen(map, { config: { density: qc.density } }), fl = allChunks(g, 'far');
    const c = lodCounts(g, fl, cams[0].x, cams[0].z, qc.dist), tris = Object.values(c).reduce((a, o) => a + o.tris, 0);
    info(`quality ${q} at the densest camera (far categories only): ${(tris / 1e6).toFixed(2)} M tris, trees ${c.tree ? c.tree.lod0 + '/' + c.tree.lod1 + '/' + c.tree.lod2 : '-'}, bushes ${c.bush.lod0 + c.bush.lod1 + c.bush.lod2}`);
  }
  const lc = lodCounts(gen, far, cams[0].x, cams[0].z);
  assert(lc.tree.lod0 > 0 && lc.tree.lod1 > lc.tree.lod0 && lc.tree.lod2 > lc.tree.lod1 && lc.tree.culled > 0, 'trees spread over LOD0 / LOD1 / LOD2 / culled (near-to-far counts grow)');
  const lodOk = manifest.assets.filter((a) => (a.category === 'tree' || a.category === 'deadtree') && a.tris > 900).every((a) => a.lods && a.lods.length === 2 && a.lodTris[0] < a.tris * 0.7 && a.lodTris[1] < a.tris * 0.15);
  assert(lodOk, 'every tree / dead tree in nature.json has LOD1 (<70 % tris) and LOD2 (<15 % tris)');
  assert(gen.species.filter((s) => s.cat === 'tree' || s.cat === 'deadtree').every((s) => s.trunkRadius > 0), 'every used tree has a trunkRadius in the manifest');
}

// =================================================================================================
// 5. collider pool (Rapier) on sample2
// =================================================================================================
await RAPIER.init();
{
  mapDir = path.resolve('public/maps/sample2');
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const map = await loadMap('/maps/x/', { THREE, RAPIER, physicsWorld: world, physicsResolution: 256 });
  const gen = newGen(map), cfgC = gen.cfg.colliders;
  const base = world.colliders.len(), pool = createColliderPool({ RAPIER, world, gen });
  assert(world.colliders.len() === base + cfgC.maxTrees + cfgC.maxRocks, `pool pre-creates ${cfgC.maxTrees} + ${cfgC.maxRocks} colliders once (${world.colliders.len() - base})`);
  world.step();
  // fly a wavy line over the forest in 3 m steps (1.2 km)
  const route = []; for (let k = 0; k < 400; k++) route.push([700 + k * 3, 1100 + Math.sin(k / 30) * 120]);
  let maxActive = 0, mism = 0, leaks = 0, tMax = 0, tSum = 0, calls = 0, minTrees = 1e9, maxTrees = 0; const t00 = performance.now();
  for (const [x, z] of route) {
    const [t, ran] = ms(() => pool.update(x, z)); if (ran) { tMax = Math.max(tMax, t); tSum += t; calls++; }
    const st = pool.stats(); maxActive = Math.max(maxActive, st.active); maxTrees = Math.max(maxTrees, st.trees); if (st.trees) minTrees = Math.min(minTrees, st.trees);
    if (world.colliders.len() !== base + cfgC.maxTrees + cfgC.maxRocks) leaks++;
  }
  // positions vs instance lists at the end of the route
  const [fx, fz] = route.at(-1); pool.forceUpdate(fx, fz);
  const act = pool.active(); let found = 0;
  for (const a of act) {
    const S = gen.chunkSize.far;
    // the instance may belong to a neighbouring chunk (candidate pokes out by < g/2): search the 3x3
    let ok = false;
    for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) { const L2 = gen.layer(a.layer, Math.floor(a.x / S) + dx, Math.floor(a.z / S) + dz), q = L2.parts[a.layer]; for (let i = 0; i < q.n; i++) if (Math.abs(q.data[i * 7] - a.x) < 1e-4 && Math.abs(q.data[i * 7 + 2] - a.z) < 1e-4) { ok = true; break; } }
    if (ok) found++; else mism++;
  }
  assert(leaks === 0 && maxActive <= cfgC.maxTrees + cfgC.maxRocks, `moving 1.2 km: collider count never leaks or exceeds the cap (max active ${maxActive}, trees ${minTrees}..${maxTrees} of ${cfgC.maxTrees})`);
  assert(mism === 0 && act.length > 20, `all ${act.length} active colliders sit on an instance position (${found} matched, ${mism} not)`);
  info(`pool refresh: ${calls} refreshes over ${route.length} frames, ${(tSum / calls).toFixed(2)} ms avg, ${tMax.toFixed(2)} ms max (incl. chunk generation), whole route ${(performance.now() - t00).toFixed(0)} ms`);
  // collision geometry: a horizontal ray at a trunk hits it, after moving away it is gone
  const trunk = act.find((a) => a.kind === 'tree'); world.step();
  const hit = world.castRay(new RAPIER.Ray({ x: trunk.x - 6, y: trunk.y, z: trunk.z }, { x: 1, y: 0, z: 0 }), 20, true);
  assert(hit && Math.abs(hit.timeOfImpact - (6 - trunk.radius)) < 0.05, `ray at a trunk (radius ${trunk.radius.toFixed(2)} m, ${(trunk.halfHeight * 2).toFixed(1)} m tall) hits its surface (toi ${hit && hit.timeOfImpact.toFixed(2)})`);
  const radii = act.filter((a) => a.kind === 'tree').map((a) => a.radius); info(`trunk radii in range: ${Math.min(...radii).toFixed(2)}..${Math.max(...radii).toFixed(2)} m (mean ${(radii.reduce((a, b) => a + b, 0) / radii.length).toFixed(2)}), ${act.filter((a) => a.kind === 'rock').length} rocks`);
  { const rk = [...instances(allChunks(gen, 'far', ['rock']), ['rock'])][0]; pool.forceUpdate(rk.x + 12, rk.z); world.step();
    const a = pool.active().find((q) => q.kind === 'rock' && Math.abs(q.x - rk.x) < 1e-3), h = a && world.castRay(new RAPIER.Ray({ x: a.x - 20, y: a.y, z: a.z }, { x: 1, y: 0, z: 0 }), 40, true);
    assert(a && h && Math.abs(h.timeOfImpact - (20 - a.radius)) < 0.1, `rock (scale ${rk.scale.toFixed(2)}) gets a ball collider of radius ${a && a.radius.toFixed(2)} m, ray hits it`); }
  pool.forceUpdate(100, 100); world.step();
  const hit2 = world.castRay(new RAPIER.Ray({ x: trunk.x - 6, y: trunk.y, z: trunk.z }, { x: 1, y: 0, z: 0 }), 20, true);
  assert(!hit2 || Math.abs(hit2.timeOfImpact - (6 - trunk.radius)) > 0.05, 'after the focus moved away the same ray no longer hits that trunk');
  const stillThere = pool.active().some((a) => a.x === trunk.x && a.z === trunk.z); assert(!stillThere, 'a trunk that left the radius is deactivated');
  pool.dispose(); assert(world.colliders.len() === base, 'dispose removes every pool collider');
}

// =================================================================================================
// 6. car vs trunk: a 1500 kg box at 40 km/h into a trunk cylinder (radius 0.4 m), 120 Hz
// =================================================================================================
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = 1 / 120;
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(1));
  world.createCollider(RAPIER.ColliderDesc.cylinder(2.5, 0.4).setTranslation(14, 2.5, 0.0).setFriction(0.7).setRestitution(0.1));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, 0.1).setLinvel(40 / 3.6, 0, 0).setCcdEnabled(true));
  world.createCollider(RAPIER.ColliderDesc.cuboid(2.2, 0.5, 0.95).setMass(1500).setFriction(0.03).setRestitution(0.05), body);
  let maxV = 0, nan = false, maxY = 0, maxAng = 0, tHit = -1;
  for (let k = 0; k < 120 * 4; k++) {
    world.step(); const v = body.linvel(), t = body.translation(), a = body.angvel();
    if (![v.x, v.y, v.z, t.x, t.y, t.z].every(Number.isFinite)) nan = true;
    maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); maxY = Math.max(maxY, t.y); maxAng = Math.max(maxAng, Math.hypot(a.x, a.y, a.z));
    if (tHit < 0 && Math.hypot(v.x, v.y, v.z) < 11) tHit = k / 120;
  }
  const v = body.linvel(), t = body.translation();
  info(`car-vs-trunk: peak speed ${maxV.toFixed(1)} m/s (start 11.1), final ${Math.hypot(v.x, v.y, v.z).toFixed(2)} m/s, max height ${maxY.toFixed(2)} m, peak spin ${maxAng.toFixed(1)} rad/s, final x ${t.x.toFixed(2)} (trunk at 14, hit at 40 km/h, wheels rolling = low friction)`);
  assert(!nan && maxV < 12 && maxY < 1.6 && maxAng < 12 && t.x < 14, 'a 40 km/h hit stops or bounces the car sanely (finite, no launch, no tunnelling through)');
}
console.log(process.exitCode ? 'SCATTER TESTS FAILED' : 'scatter tests passed');
