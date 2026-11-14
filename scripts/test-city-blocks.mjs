// Headless check of the city blocks / lots (src/world/cityBlocks.js): `node scripts/test-city-blocks.mjs [map...]` (default: citytest city s3).
// Asserts determinism (two runs equal), no lot on a road ribbon, no lot overlapping another (attached rowhouses may share edges), footprints inside their lots;
// writes an SVG per map (roads, blocks by zone, lots, plazas) to $OUT_DIR (default <os tmp>/city-blocks).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { loadMap } from '../src/world/mapLoader.js';
import { polyOf, KERB } from '../src/world/roads.js';
import { FOOT_SHIFT, HIGHWAY } from '../src/world/roadMeta.js';
import { createCityBlocks, convexOverlap, pointInRing } from '../src/world/cityBlocks.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); if (!fs.existsSync(f)) return new Response(null, { status: 404 }); return new Response(fs.readFileSync(f)); };
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), 'city-blocks');
fs.mkdirSync(OUT, { recursive: true });
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(ax + dx * t - px, az + dz * t - pz); };
const COL = { residential: '#7cb36b', rowhouse: '#d9a441', downtown: '#5b7bd6' };

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['citytest', 'city', 's3']) {
  console.log(`\n== ${name}`);
  mapDir = path.resolve('public/maps', name);
  const map = await loadMap('/maps/x/', { THREE, physics: false });
  const t0 = performance.now(), A = createCityBlocks({ map }), ms = performance.now() - t0, B = createCityBlocks({ map });
  const lots = A.blocks.flatMap((b) => b.lots);
  assert(JSON.stringify(A.blocks) === JSON.stringify(B.blocks), `deterministic (${A.blocks.length} blocks, ${lots.length} lots, ${ms.toFixed(0)} ms)`);

  // road ribbons: half width + kerb + footpath / shoulder, sampled over each lot
  const segs = [];
  for (const r of map.roads) { const P = polyOf(r); for (let i = 0; i < P.n - 1; i++) { const t = r.points[P.seg[i]].type; segs.push([P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], r.width / 2 + KERB + (t === 'city' ? FOOT_SHIFT : t === 'highway' ? HIGHWAY.SHOULDER_W : 0)]); } }
  let onRoad = 0, overlaps = 0, fpOut = 0;
  for (const l of lots) {
    const pts = [];
    for (let i = 0; i < 4; i++) { const a = l.poly[i], b = l.poly[(i + 1) % 4]; for (let k = 0; k < 8; k++) pts.push([a[0] + (b[0] - a[0]) * k / 8, a[1] + (b[1] - a[1]) * k / 8]); }
    if (pts.some(([x, z]) => segs.some((s) => segDist(x, z, s[0], s[1], s[2], s[3]) < s[4]))) onRoad++;
    const f = l.footprint, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = f.cx + c * f.hu * u * 0.99 + s * f.hv * v * 0.99, z = f.cz - s * f.hu * u * 0.99 + c * f.hv * v * 0.99; if (!pointInRing(l.poly, x, z)) { fpOut++; break; } }
  }
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) if (convexOverlap(lots[i].poly, lots[j].poly, 0.05)) overlaps++;
  assert(onRoad === 0, `no lot on a road ribbon (${onRoad})`);
  assert(overlaps === 0, `no overlapping lots (${overlaps})`);
  assert(fpOut === 0, `footprints inside their lots (${fpOut})`);
  const chunked = A.chunkKeys().reduce((s, [cx, cz]) => s + A.chunk(cx, cz).lots.length, 0);
  assert(chunked === lots.length, `chunks hold every lot once (${chunked})`);
  if (lots.length) { const f = lots[0].footprint; assert(A.blocked(f.cx, f.cz, 0) && !A.blocked(-100, -100, 5), 'blocked() hits a footprint, misses empty land'); }
  // lot interior (off the footprint) blocked by default; painted small veg allowed, trees never
  const res = lots.find((l) => A.blocks.find((b) => b.lots.includes(l)).zone === 'residential') || lots[0];
  if (res) {
    const f = res.footprint, c = res.poly.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    let pt = null; // a lot point clear of the footprint by 1 m
    for (let t = 0; t <= 1 && !pt; t += 0.05) for (const p of res.poly) { const x = p[0] + (c[0] - p[0]) * t, z = p[1] + (c[1] - p[1]) * t; const dx = x - f.cx, dz = z - f.cz, co = Math.cos(f.yaw), si = Math.sin(f.yaw); if (Math.hypot(Math.max(Math.abs(dx * co - dz * si) - f.hu, 0), Math.max(Math.abs(dx * si + dz * co) - f.hv, 0)) > 1.5 && pointInRing(res.poly, x, z)) { pt = [x, z]; break; } }
    if (pt) {
      const paint = (g) => ({ ...map, surfaceAt: (x, z) => { const s = map.surfaceAt(x, z), w = s.weights.slice(); w[0] = g; w[1] = 0; return { ...s, weights: w }; } });
      const P0 = createCityBlocks({ map: paint(0) }), P1 = createCityBlocks({ map: paint(1) });
      assert(A.blocked(pt[0], pt[1], 0) && P1.blocked(pt[0], pt[1], 0), 'lot interior blocked by default (blocked())');
      assert(P0.blockedFor(pt[0], pt[1], 0, 'flower'), 'unpainted lot blocks small veg');
      assert(!P1.blockedFor(pt[0], pt[1], 0, 'flower') && !P1.blockedFor(pt[0], pt[1], 0, 'bush'), 'painted lot allows small veg');
      assert(P1.blockedFor(pt[0], pt[1], 0, 'tree') && P1.blockedFor(pt[0], pt[1], 0, 'rock'), 'painted lot still blocks trees / rocks');
      assert(P1.blockedFor(f.cx, f.cz, 0, 'flower'), 'footprint blocks small veg even when painted');
      let n = 0; const W = map.info.worldSize, t1 = performance.now(); for (let i = 0; i < 200000; i++) if (A.blockedFor((i * 7919.31) % W, (i * 104729.7) % W, 2, 'tree')) n++;
      console.log(`     blockedFor: 200k calls in ${(performance.now() - t1).toFixed(0)} ms (${n} blocked)`);
    } else console.log('     (no lot point clear of its footprint)');
  }

  const per = {};
  for (const b of A.blocks) { const k = `${b.kind}/${b.zone}`; per[k] = per[k] || { blocks: 0, lots: 0, corner: 0, plaza: 0 }; per[k].blocks++; per[k].lots += b.lots.length; per[k].corner += b.lots.filter((l) => l.corner).length; if (b.plaza) per[k].plaza++; }
  console.table(per);
  console.log('     stats', JSON.stringify(A.stats));

  // SVG
  const W = map.info.worldSize, P = (r) => r.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="1600" height="1600" style="background:#eee">`];
  for (const r of map.roads) { const Q = polyOf(r); const pts = []; for (let i = 0; i < Q.n; i++) pts.push([Q.x[i], Q.z[i]]); out.push(`<polyline points="${P(pts)}" fill="none" stroke="#444" stroke-opacity="0.6" stroke-width="${r.width}"/>`); }
  for (const b of A.blocks) {
    out.push(`<polygon points="${P(b.poly)}" fill="${COL[b.zone]}" fill-opacity="${b.kind === 'block' ? 0.25 : 0.1}" stroke="${COL[b.zone]}" stroke-width="0.6"/>`);
    if (b.plaza) { out.push(`<polygon points="${P(b.plaza.poly)}" fill="${b.plaza.kind === 'plaza' ? '#c9c2b0' : '#a7d48f'}" stroke="#776" stroke-width="0.4"/>`); for (const p of b.plaza.props) out.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.z.toFixed(1)}" r="1.2" fill="${p.type === 'tree' ? '#2d7a2d' : p.type === 'bench' ? '#8a5a2b' : '#b05050'}"/>`); }
    for (const l of b.lots) {
      out.push(`<polygon points="${P(l.poly)}" fill="${COL[l.zone]}" fill-opacity="0.35" stroke="${l.corner ? '#d00' : '#222'}" stroke-width="${l.corner ? 0.8 : 0.3}"/>`);
      const f = l.footprint, deg = -f.yaw * 180 / Math.PI;
      out.push(`<rect x="${(-f.hu).toFixed(2)}" y="${(-f.hv).toFixed(2)}" width="${(2 * f.hu).toFixed(2)}" height="${(2 * f.hv).toFixed(2)}" transform="translate(${f.cx.toFixed(1)},${f.cz.toFixed(1)}) rotate(${deg.toFixed(1)})" fill="#333" fill-opacity="0.55"/>`);
      out.push(`<line x1="${l.front.x.toFixed(1)}" y1="${l.front.z.toFixed(1)}" x2="${(l.front.x + Math.sin(l.front.yaw) * 3).toFixed(1)}" y2="${(l.front.z + Math.cos(l.front.yaw) * 3).toFixed(1)}" stroke="#d00" stroke-width="0.5"/>`);
    }
  }
  out.push('</svg>');
  const file = path.join(OUT, `city-blocks-${name}.svg`);
  fs.writeFileSync(file, out.join('\n'));
  console.log('     svg ' + file);
}
