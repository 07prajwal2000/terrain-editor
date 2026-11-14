// Builds the README / gallery showcase maps WITHOUT the editor:  node scripts/make-showcase-maps.mjs [city|nature] [--tmap] [--preview=<dir>]
//   public/maps/showcase-city/    1200 m, a downtown (towers + plaza block) fading through rowhouses to suburbs, a curved crescent avenue, signalled junctions, zebras,
//                                 a river with bridges, a forested hill on the east bank.
//   public/maps/showcase-nature/  2000 m, snowy mountains, a lake with a sand beach, forest, a river with 2 bridges, a winding country road + a highway.
// Writes every file the loader needs (map.json, heightmap.r16/.png, splat0/1.png, water.png, biome_color.png, roads.json, markers.json, city.json, map.tmap) - formats: docs/file-formats.md.
// Deterministic (seeded noise). Rebuild + validate: node scripts/make-showcase-maps.mjs && node scripts/test-city-blocks.mjs showcase-city
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const only = process.argv.find((a) => a === 'city' || a === 'nature');
const previewDir = (process.argv.find((a) => a.startsWith('--preview=')) || '').slice(10);

// ------------------------------------------------------------------ small utils
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }; // a > b gives the reversed ramp
const hash2 = (i, j, s) => { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vnoise = (x, z, s) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash2(i, j, s), hash2(i + 1, j, s), u), lerp(hash2(i, j + 1, s), hash2(i + 1, j + 1, s), u), v) * 2 - 1; };
const fbm = (x, z, s, oct = 5) => { let a = 1, f = 1, t = 0, n = 0; for (let o = 0; o < oct; o++) { n += a * vnoise(x * f, z * f, s + o * 17); t += a; a *= 0.5; f *= 2; } return n / t; };
const ridge = (x, z, s, oct = 5) => { let a = 1, f = 1, t = 0, n = 0; for (let o = 0; o < oct; o++) { n += a * (1 - Math.abs(vnoise(x * f, z * f, s + o * 31))); t += a; a *= 0.5; f *= 2; } return n / t; };

// ------------------------------------------------------------------ PNG writer (8/16-bit gray, RGB, RGBA; filter 0)
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, ch, depth, data) { // data: raw bytes, row-major, 16-bit samples big-endian
  const bpp = ch * depth / 8, row = w * bpp, raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * row, row).copy(raw, y * (row + 1) + 1);
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = { 1: 0, 3: 2, 4: 6 }[ch]; // gray / RGB / RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ map model
const CLASSES = [['grass', '#5da130'], ['forest', '#1f5c2a'], ['dirt', '#8a6a43'], ['sand', '#e0cf8f'], ['rock', '#7d7d7d'], ['snow', '#f2f6ff'], ['road', '#333333'], ['city', '#b0a0c0']];
const GRASS = 0, FOREST = 1, DIRT = 2, SAND = 3, ROCK = 4, SNOW = 5, CITY = 7;

class Grid {
  constructor(N, W, maxH, seaM) {
    Object.assign(this, { N, W, maxH, seaM, cell: W / N });
    this.H = new Float32Array(N * N);               // metres
    this.water = new Float32Array(N * N);           // surface metres, 0 = none
    this.w = Array.from({ length: 8 }, () => new Float32Array(N * N));
  }
  each(fn) { const { N, cell } = this; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) fn(i, j, (i + 0.5) * cell, (j + 0.5) * cell, j * N + i); }
  heightAt(x, z) { // the loader's bilinear rule
    const { N, cell, H } = this, cl = (v) => clamp(v, 0, N - 1), fx = cl(x / cell - 0.5), fz = cl(z / cell - 0.5), i = Math.min(Math.floor(fx), N - 2), j = Math.min(Math.floor(fz), N - 2), tx = fx - i, tz = fz - j;
    const h = (a, b) => H[b * N + a], a = lerp(h(i, j), h(i + 1, j), tx), b = lerp(h(i, j + 1), h(i + 1, j + 1), tx);
    return lerp(a, b, tz);
  }
  slope(i, j) { const { N, cell, H } = this, g = (a, b) => H[clamp(b, 0, N - 1) * N + clamp(a, 0, N - 1)]; return Math.hypot(g(i + 1, j) - g(i - 1, j), g(i, j + 1) - g(i, j - 1)) / (2 * cell); }
}

// uniform Catmull-Rom through [x,z] points, sampled about every `step` m -> [{x,z,s}]
const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
function sampleSpline(P, step) {
  const out = []; let s = 0, prev = null;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(i - 1, 0)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(i + 2, P.length - 1)], m = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k <= m; k++) { if (k === m && i < P.length - 2) break; const f = k / m, x = cr(p0[0], p1[0], p2[0], p3[0], f), z = cr(p0[1], p1[1], p2[1], p3[1], f); if (prev) s += Math.hypot(x - prev.x, z - prev.z); prev = { x, z, s }; out.push(prev); }
  }
  return out;
}

// carve a river along `pts`: terrain blends to the bed within `bank` m of the centre; water surface = levelAt(s). bedAt(s, baseCentre) -> bed metres. Monotone-safe is the caller's job.
function carveRiver(g, pts, { halfW, bank, bedFn, levelFn, step = 3 }) {
  const S = sampleSpline(pts, step), R = bank + halfW + 6, { N, cell } = g;
  const best = new Float32Array(N * N).fill(1e9), bs = new Float32Array(N * N);
  for (const p of S) {
    const i0 = Math.max(0, Math.floor((p.x - R) / cell)), i1 = Math.min(N - 1, Math.ceil((p.x + R) / cell)), j0 = Math.max(0, Math.floor((p.z - R) / cell)), j1 = Math.min(N - 1, Math.ceil((p.z + R) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const d = Math.hypot((i + 0.5) * cell - p.x, (j + 0.5) * cell - p.z), k = j * N + i; if (d < best[k]) { best[k] = d; bs[k] = p.s; } }
  }
  const bed = S.map((p) => bedFn(p.s, g.heightAt(p.x, p.z))); // evaluated on the UNcarved terrain
  const at = (s) => bed[clamp(Math.round(s / step), 0, bed.length - 1)];
  for (let k = 0; k < N * N; k++) {
    const d = best[k]; if (d > R) continue;
    const b = at(bs[k]), lv = levelFn(bs[k], b), h0 = g.H[k];
    if (d <= halfW) { g.H[k] = Math.min(h0, lerp(b, lv - 0.15, sstep(0, halfW, d))); g.water[k] = Math.max(g.water[k], lv); } // bed -> shoreline just under the surface
    else g.H[k] = lerp(Math.max(lv + 0.3, Math.min(h0, lv + 0.3 + (halfW + bank - d) * 0)) , h0, sstep(halfW, halfW + bank, d)); // levee: at least surface + 0.3 m at the shore, blends to the land
  }
  return S;
}

// ------------------------------------------------------------------ roads
function makeRoads(g, W) {
  const road = (id, width, pts, meta = {}) => ({ id, widthMeters: width, points: pts.map(([x, z, extra = {}]) => ({ nx: x / W, nz: z / W, x: +x.toFixed(2), y: +g.heightAt(x, z).toFixed(2), z: +z.toFixed(2), bridge: false, ...meta, ...extra })) });
  return road;
}

// ------------------------------------------------------------------ writer
function writeMap(g, name, { roads, markers, cityJson, driveSide, signStyle }) {
  const { N, W, maxH, seaM } = g, dst = path.resolve('public/maps', name);
  fs.mkdirSync(dst, { recursive: true });
  const raw = new Uint16Array(N * N); for (let k = 0; k < N * N; k++) raw[k] = Math.round(clamp(g.H[k] / maxH, 0, 1) * 65535);
  fs.writeFileSync(path.join(dst, 'heightmap.r16'), Buffer.from(raw.buffer));
  const be = Buffer.alloc(N * N * 2); for (let k = 0; k < N * N; k++) be.writeUInt16BE(raw[k], k * 2);
  fs.writeFileSync(path.join(dst, 'heightmap16.png'), png(N, N, 1, 16, be));
  // splat: normalise to exactly 255 per pixel (largest remainder)
  const s0 = new Uint8Array(N * N * 4), s1 = new Uint8Array(N * N * 4), q = new Float64Array(8), fl = new Int32Array(8), rgb = new Uint8Array(N * N * 3);
  for (let k = 0; k < N * N; k++) {
    let sum = 0; for (let c = 0; c < 8; c++) { q[c] = Math.max(g.w[c][k], 0); sum += q[c]; }
    if (sum <= 0) { q.fill(0); q[GRASS] = 1; sum = 1; }
    let tot = 0; for (let c = 0; c < 8; c++) { q[c] = q[c] / sum * 255; fl[c] = Math.floor(q[c]); tot += fl[c]; }
    for (let r = 255 - tot; r > 0; r--) { let b = 0, bv = -1; for (let c = 0; c < 8; c++) if (q[c] - fl[c] > bv) { bv = q[c] - fl[c]; b = c; } fl[b]++; q[b] = fl[b]; }
    for (let c = 0; c < 4; c++) { s0[k * 4 + c] = fl[c]; s1[k * 4 + c] = fl[c + 4]; }
    let dom = 0; for (let c = 1; c < 8; c++) if (fl[c] > fl[dom]) dom = c;
    const col = parseInt(CLASSES[dom][1].slice(1), 16); rgb[k * 3] = col >> 16; rgb[k * 3 + 1] = (col >> 8) & 255; rgb[k * 3 + 2] = col & 255;
  }
  fs.writeFileSync(path.join(dst, 'splat0.png'), png(N, N, 4, 8, s0));
  fs.writeFileSync(path.join(dst, 'splat1.png'), png(N, N, 4, 8, s1));
  fs.writeFileSync(path.join(dst, 'biome_color.png'), png(N, N, 3, 8, rgb));
  // water: v = round(level/maxH*65534)+1 where the surface is above the (quantised) terrain
  const wbe = Buffer.alloc(N * N * 2), wnorm = new Float32Array(N * N).fill(-1); let wet = 0;
  for (let k = 0; k < N * N; k++) { const lv = g.water[k]; if (lv > raw[k] / 65535 * maxH + 0.02) { const v = Math.round(clamp(lv / maxH, 0, 1) * 65534) + 1; wbe.writeUInt16BE(v, k * 2); wnorm[k] = (v - 1) / 65534; wet++; } }
  fs.writeFileSync(path.join(dst, 'water.png'), png(N, N, 1, 16, wbe));
  const mj = { formatVersion: 1, N, worldSizeMeters: W, maxHeightMeters: maxH, cellSizeMeters: W / N, seaLevel: seaM / maxH, seaLevelMeters: seaM,
    classes: CLASSES.map(([n, c], id) => ({ id, name: n, color: c })),
    files: { height16: 'heightmap16.png', heightRaw16: 'heightmap.r16', splat0: 'splat0.png', splat1: 'splat1.png', biomeColor: 'biome_color.png', water: 'water.png', roads: 'roads.json', markers: 'markers.json' },
    encodings: { height: 'raw16 LE / 65535 * maxHeightMeters', splat0: 'RGBA8 classes 0-3, channels sum to 255 with splat1', water: '16-bit gray, 0 none, (v-1)/65534 * maxHeightMeters' },
    driveSide, signStyle };
  fs.writeFileSync(path.join(dst, 'map.json'), JSON.stringify(mj, null, 1));
  fs.writeFileSync(path.join(dst, 'roads.json'), JSON.stringify({ formatVersion: 1, note: `Showcase map generated by scripts/make-showcase-maps.mjs (nx,nz normalized, x,z metres, y terrain height). See the script for the layout.`, roads }, null, 1));
  const mk = markers.map((m, i) => ({ id: i + 1, name: m.name, tags: m.tags, color: m.color || '#ff3b30', x: m.x, z: m.z, y: +g.heightAt(m.x, m.z).toFixed(2), nx: m.x / W, nz: m.z / W, yaw: m.yaw || 0, radius: m.radius || 0, props: {}, yOffset: 0 }));
  fs.writeFileSync(path.join(dst, 'markers.json'), JSON.stringify({ version: 1, note: 'Generated by scripts/make-showcase-maps.mjs.', markers: mk }, null, 1));
  if (cityJson) fs.writeFileSync(path.join(dst, 'city.json'), JSON.stringify(cityJson, null, 1));
  if (!process.argv.includes('--tmap')) { console.log(`wrote ${dst}: ${roads.length} roads, ${mk.length} markers, ${wet} water px (no map.tmap: pass --tmap for the editor project file, 16 MB)`); return; }
  // .tmap project file (editor): f32 height + f32 water (-1 none) + 8 u8 weights
  const layers = [], parts = []; let off = 0;
  const add = (n, type, buf) => { layers.push({ name: n, type, offset: off, byteLength: buf.length }); parts.push(buf); off += buf.length; };
  const hf = new Float32Array(N * N); for (let k = 0; k < N * N; k++) hf[k] = g.H[k] / maxH;
  add('height', 'f32', Buffer.from(hf.buffer)); add('water', 'f32', Buffer.from(wnorm.buffer));
  for (let c = 0; c < 8; c++) { const u = new Uint8Array(N * N), src = c < 4 ? s0 : s1; for (let k = 0; k < N * N; k++) u[k] = src[k * 4 + (c & 3)]; add('weight' + c, 'u8', Buffer.from(u)); }
  const settings = { worldSizeMeters: W, maxHeightMeters: maxH, seaLevel: seaM / maxH }; if (driveSide !== 'right') settings.driveSide = driveSide; if (signStyle !== 'us') settings.signStyle = signStyle;
  // the editor stores roads / markers with NORMALISED x,z (and width, no y / nx / nz)
  const eroads = roads.map((r) => ({ id: r.id, width: r.widthMeters, points: r.points.map(({ nx, nz, x, y, z, ...rest }) => ({ x: nx, z: nz, ...rest })) }));
  const emk = mk.map(({ x, z, y, nx, nz, ...rest }) => ({ ...rest, x: nx, z: nz }));
  const hdr = Buffer.from(JSON.stringify({ format: 'tmap', version: 1, N, settings, roads: eroads, nextRoadId: roads.length + 1, markers: emk, nextMarkerId: mk.length + 1, layers }));
  const hl = (hdr.length + 3) & ~3, head = Buffer.alloc(8 + hl, 0x20); head.write('TMAP', 0, 'latin1'); head.writeUInt32LE(hl, 4); hdr.copy(head, 8);
  fs.writeFileSync(path.join(dst, 'map.tmap'), Buffer.concat([head, ...parts]));
  console.log(`wrote ${dst}: ${roads.length} roads, ${mk.length} markers, ${wet} water px`);
}

// optional top-down preview for eyeballing the layout (hillshade + class colours + water + roads)
function preview(g, roads, file) {
  const { N, W } = g, img = new Uint8Array(N * N * 3);
  g.each((i, j, x, z, k) => {
    let dom = 0; for (let c = 1; c < 8; c++) if (g.w[c][k] > g.w[dom][k]) dom = c;
    const col = parseInt(CLASSES[dom][1].slice(1), 16), sh = clamp(0.75 + (g.H[k - (i > 0 ? 1 : 0)] - g.H[k + (i < N - 1 ? 1 : 0)] + g.H[k - (j > 0 ? N : 0)] - g.H[k + (j < N - 1 ? N : 0)]) * 0.25, 0.4, 1.3);
    let r = (col >> 16) * sh, gg = ((col >> 8) & 255) * sh, b = (col & 255) * sh;
    if (g.water[k] > g.H[k] + 0.02 || g.H[k] < g.seaM) { r = 40; gg = 90; b = 190; }
    img.set([clamp(r, 0, 255), clamp(gg, 0, 255), clamp(b, 0, 255)], k * 3);
  });
  for (const rd of roads) for (const p of sampleSpline(rd.points.map((q) => [q.x, q.z]), 2)) { const i = Math.floor(p.x / g.cell), j = Math.floor(p.z / g.cell); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < N && jj < N) img.set([255, 60, 60], (jj * N + ii) * 3); } }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png(N, N, 3, 8, img));
}

// grade report: max slope (over 20 m) along each road on the raw terrain, ignoring wet stretches (those become bridges) - the loader also stamps corridors
function gradeReport(g, roads) {
  for (const rd of roads) {
    const S = sampleSpline(rd.points.map((q) => [q.x, q.z]), 5), dry = S.map((p) => !(g.water[Math.floor(p.z / g.cell) * g.N + Math.floor(p.x / g.cell)] > 0)), hs = S.map((p) => g.heightAt(p.x, p.z)); let mx = 0, at = S[0];
    for (let i = 4; i < S.length; i++) if (dry[i] && dry[i - 4]) { const gr = Math.abs(hs[i] - hs[i - 4]) / 20; if (gr > mx) { mx = gr; at = S[i]; } }
    if (process.env.PROFILE) console.log(S.filter((_, i) => i % 20 === 0).map((q, i) => `${(q.s | 0)}:(${q.x | 0},${q.z | 0})h${hs[S.indexOf(q)] | 0}`).join(' '));
    console.log(`  road ${rd.id}: ${S.at(-1).s.toFixed(0)} m, height ${Math.min(...hs).toFixed(0)}..${Math.max(...hs).toFixed(0)} m, max dry grade ${(mx * 100).toFixed(0)}% @ (${at.x.toFixed(0)},${at.z.toFixed(0)})`);
  }
}

// ================================================================== showcase-city
function buildCity() {
  const W = 1200, N = 1024, g = new Grid(N, W, 200, 20), SEED = 11;
  const core = [470, 480];
  const riverPts = Array.from({ length: 13 }, (_, i) => { const z = i * 100 - 0; return [800 + 34 * Math.sin(z / 170 + 0.8) + 14 * Math.sin(z / 61), clamp(z, 0, W)]; });
  riverPts.unshift([riverPts[0][0] - 10, -20]); riverPts.push([riverPts.at(-1)[0], W + 20]);
  // terrain: flat city plain (36 m, +-0.7 m), a forested hill east of the river
  g.each((i, j, x, z, k) => {
    let h = 36 + 0.7 * fbm(x / 260, z / 260, SEED, 3) + 0.25 * fbm(x / 40, z / 40, SEED + 3, 2);
    h += (46 * sstep(900, 1200, x) * (0.75 + 0.5 * fbm(x / 150, z / 150, SEED + 7, 4)) + 14 * sstep(920, 1100, x) * Math.max(0, fbm(x / 70, z / 70, SEED + 5, 3))) * (0.6 + 0.4 * sstep(150, 700, z) + 0.2 * sstep(1150, 900, z));
    h += 20 * sstep(80, 0, z) + 12 * sstep(W - 80, W, z) + 24 * sstep(60, 0, x) + 10 * sstep(W - 40, W, x); // low rim so the edges are not a cliff
    g.H[k] = h;
  });
  carveRiver(g, riverPts, { halfW: 21, bank: 16, bedFn: () => 25, levelFn: () => 30 });
  // paint: city weight radial from the core (downtown > 0.5, rowhouse 0.3..0.5, residential < 0.3), forest + rock on the hill, sand on the river banks
  g.each((i, j, x, z, k) => {
    const d = Math.hypot(x - core[0], z - core[1]) * (1 + 0.12 * fbm(x / 120, z / 120, SEED + 9, 2)), h = g.H[k], base = 36, up = h - base, sl = g.slope(i, j);
    const wet = g.water[k] > h + 0.02;
    let cityW = 0.9 * (1 - clamp((d - 30) / 470, 0, 1)); // linear: downtown < ~195 m from the core, rowhouse to ~295 m, suburb beyond cityW *= (1 - sstep(2, 8, up)) * (wet ? 0 : 1);
    const forest = sstep(5, 14, up) * (0.6 + 0.4 * sstep(-0.1, 0.25, fbm(x / 90, z / 90, SEED + 13, 3)));
    const rock = Math.max(sstep(0.5, 0.85, sl), sstep(48, 60, up) * 0.8);
    const sand = wet || h < 31.6 ? 1 : sstep(33.2, 31.6, h) * 0.8;
    let rem = 1, put = (c, a) => { const v = Math.min(rem, a); g.w[c][k] = v; rem -= v; };
    put(ROCK, rock); put(SAND, sand); put(CITY, cityW); put(FOREST, forest); put(GRASS, rem);
  });
  const road = makeRoads(g, W);
  const city = { type: 'city' }, lamps = { type: 'city', edgeL: 'lamps', edgeR: 'lamps' };
  const VX = [130, 270, 410, 550], HZ = [200, 340, 480, 620, 760, 900], RIVERFRONT = 640, AVE = 480;
  const roads = []; let id = 1;
  // horizontals: control points at every crossing + a mid-block point; zebras on the mid-block points of every other block
  for (const z of HZ) {
    const xs = [...VX, RIVERFRONT], row = [];
    for (let i = 0; i < xs.length; i++) { if (i) row.push([(xs[i - 1] + xs[i]) / 2, z, (i % 2 === 0 || z === AVE) ? { features: ['crosswalk'] } : {}]); row.push([xs[i], z]); }
    if (z === AVE) { // the avenue crosses the river: over the water as a city road, then a country road up the hill
      row.push([700, z], [760, z], [820, z], [870, z, { type: 'country' }], [930, z], [1000, z - 30], [1070, z - 70], [1130, z - 130], [1170, z - 200]);
    }
    roads.push(road(id++, z === AVE ? 14 : 10, row, z === AVE ? lamps : city));
  }
  for (const x of [...VX, RIVERFRONT]) {
    if (x === 410) { // the plaza block: no V410 between H340 and H480 -> one big downtown block
      roads.push(road(id++, 10, [[x, HZ[0]], [x, 270], [x, HZ[1]]], city));
      roads.push(road(id++, 10, [[x, AVE], [x, 550], [x, 620], [x, 690], [x, 760], [x, 830], [x, 900], [x, 975], [x, 1055]], city));
      continue;
    }
    const zs = [HZ[0], ...HZ.slice(1)], col = [];
    for (let i = 0; i < zs.length; i++) { if (i) col.push([x, (zs[i - 1] + zs[i]) / 2, i % 2 === 1 ? { features: ['crosswalk'] } : {}]); col.push([x, zs[i]]); }
    if (x === 130 || x === 270 || x === 550) { const end = { 130: [130, 900], 270: [270, 1030], 550: [550, 1030] }[x]; if (end[1] > 900) col.push([x, 965], end); }
    roads.push(road(id++, x === RIVERFRONT ? 12 : 10, col, x === RIVERFRONT ? lamps : city));
  }
  // curved crescent avenue under the grid (suburb side), 14 m, lamps
  roads.push(road(id++, 14, [[130, 900], [190, 980], [270, 1030], [340, 1048], [410, 1055], [480, 1048], [550, 1030], [600, 980], [640, 900]], lamps));
  const markers = [{ name: 'player_start', tags: ['spawn', 'player_start'], x: 300, z: AVE, yaw: 0 }];
  return { g, W, roads, markers, cityJson: { seed: 4242, exclusions: [] } };
}

// ================================================================== showcase-nature
function buildNature() {
  const W = 2000, N = 1024, g = new Grid(N, W, 200, 20), SEED = 29;
  const lake = { x: 1150, z: 1180, R: 300, level: 62 }, peak = [330, 300];
  g.each((i, j, x, z, k) => {
    const calm = sstep(1450, 1700, z), base = 70 + (1 - calm * 0.8) * (24 * fbm(x / 520, z / 520, SEED, 4)) + 2.5 * fbm(x / 90, z / 90, SEED + 3, 3);
    const dm = Math.hypot((x - peak[0]) * 0.9, (z - peak[1]) * 1.15), mask = Math.pow(sstep(800, 100, dm), 1.15);
    const rid = ridge(x / 230, z / 230, SEED + 11, 6), body = fbm(x / 260, z / 260, SEED + 21, 4);
    let h = base + mask * (22 + 118 * Math.pow(rid, 3.2) + 22 * body) + 14 * sstep(1000, 0, dm) * Math.max(0, body);
    const dl = Math.hypot(x - lake.x, z - lake.z); h -= 16 * Math.exp(-Math.pow(dl / lake.R, 2)); // basin
    h += (1 - calm) * 95 * Math.pow(sstep(520, 120, Math.hypot(x - 1620, z - 520)), 1.2) * (0.25 + 1.5 * Math.pow(ridge(x / 200, z / 200, SEED + 12, 5), 3)) + 26 * sstep(1500, 2000, x) * (0.6 + 0.4 * fbm(x / 200, z / 200, SEED + 8, 3)) + 10 * sstep(80, 0, Math.min(x, z, W - x, W - z)); // eastern hills, low rim
    g.H[k] = clamp(h, 40, 195);
  });
  for (let k = 0; k < N * N; k++) { const z = (Math.floor(k / N) + 0.5) * g.cell; if (z > 1500) g.H[k] = lerp(g.H[k], 66 + 3 * fbm((k % N) / 60, z / 60, SEED + 4, 2), sstep(1500, 1700, z) * 0.85); } // calmer south plain for the highway
  g.each((i, j, x, z, k) => { const dl = Math.hypot(x - lake.x, z - lake.z); if (dl < lake.R * 1.3) g.water[k] = g.H[k] < lake.level ? lake.level : 0; });
  const riverPts = [[770, 470], [800, 560], [830, 640], [910, 735], [1010, 820], [1090, 880], [1135, 905]];
  carveRiver(g, riverPts, { halfW: 9, bank: 12, bedFn: (() => { let m = 1e9; return (s, base) => (m = Math.min(m, base - 2.6, 118 - s * 0.045)); })(), levelFn: (s, bed) => bed + 2.3 });
  g.each((i, j, x, z, k) => { // water at the river mouth must not sit above the lake
    if (g.water[k] > 0 && Math.hypot(x - lake.x, z - lake.z) < lake.R * 1.0) g.water[k] = lake.level;
  });
  // paint
  g.each((i, j, x, z, k) => {
    const h = g.H[k], sl = g.slope(i, j), wet = g.water[k] > h + 0.02, dl = Math.hypot(x - lake.x, z - lake.z);
    const nz = fbm(x / 70, z / 70, SEED + 5, 3);
    const snow = sstep(121 + 8 * nz, 134 + 8 * nz, h) * (1 - sstep(0.85, 1.15, sl) * 0.75);
    const rock = Math.max(sstep(0.42, 0.78, sl), sstep(92 + 10 * nz, 110 + 10 * nz, h) * 0.85, sstep(0.0, 0.18, fbm(x / 35, z / 35, SEED + 17, 2)) * sstep(75, 95, h) * 0.5);
    const sand = (wet && dl < lake.R * 1.3 ? 1 : 0) || sstep(lake.level + 2.8, lake.level + 0.3, h) * (dl < lake.R * 1.4 ? 1 : 0) || (wet ? 0.8 : 0);
    const forest = sstep(0.0, 0.16, fbm(x / 240, z / 240, SEED + 31, 4)) * sstep(112, 88, h) * sstep(lake.level + 3.5, lake.level + 8, h) * sstep(0.62, 0.38, sl);
    const dirt = sstep(0.24, 0.36, fbm(x / 60, z / 60, SEED + 41, 3)) * 0.55 * sstep(0.5, 0.25, sl);
    let rem = 1; const put = (c, a) => { const v = Math.min(rem, a); g.w[c][k] = v; rem -= v; };
    put(SNOW, snow); put(ROCK, rock); put(SAND, sand); put(FOREST, forest); put(DIRT, dirt); put(GRASS, rem);
  });
  const road = makeRoads(g, W), roads = [];
  const hw = { type: 'highway', edgeL: 'guardrail', edgeR: 'guardrail', signs: 'off' };
  roads.push(road(1, 20, [[30, 1730], [320, 1700], [640, 1650], [900, 1625], [1180, 1635], [1500, 1690], [1780, 1700], [1970, 1670]], hw));
  // country road: off the highway, up the west side of the lake, over the river (auto bridge), across the foothills, switchbacks up the pass
  const cr1 = [[900, 1625], [860, 1520], [810, 1420], [790, 1300], [805, 1180], [815, 1060], [850, 940], [900, 840], [945, 735], [965, 660], [945, 585], [905, 520], [885, 450], [900, 380], [950, 330]];
  roads.push(road(2, 8, cr1, { edgeR: 'none', surface: 'smooth' }));
  // a gravel forest track east of the lake joining the highway
  roads.push(road(3, 6, [[1500, 1690], [1530, 1560], [1500, 1440], [1530, 1300], [1600, 1190], [1700, 1130]], { surface: 'gravel' }));
  const markers = [{ name: 'player_start', tags: ['spawn', 'player_start'], x: 860, z: 1520, yaw: -75 }];
  return { g, W, roads, markers, cityJson: null };
}

for (const [key, build, opts] of [['city', buildCity, { driveSide: 'right', signStyle: 'eu' }], ['nature', buildNature, { driveSide: 'right', signStyle: 'eu' }]]) {
  if (only && only !== key) continue;
  const { g, W, roads, markers, cityJson } = build();
  console.log(`showcase-${key}: grades`); gradeReport(g, roads);
  writeMap(g, `showcase-${key}`, { roads, markers, cityJson, ...opts });
  if (previewDir) { preview(g, roads, path.join(previewDir, `showcase-${key}.png`)); console.log('preview', previewDir); }
}
