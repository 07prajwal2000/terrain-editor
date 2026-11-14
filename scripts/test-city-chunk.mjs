// Headless check of the city chunk planner (src/world/cityChunk.js) on real maps: `node scripts/test-city-chunk.mjs [map...]` (default: city citytest).
// Asserts determinism (order-independent), one geometry per material per chunk, impostors <= 30 tris / building, colliders, buildings === lots; prints perf stats.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadMap } from '../src/world/mapLoader.js';
import { createCityBlocks } from '../src/world/cityBlocks.js';
import { createChunkPlanner } from '../src/world/cityChunk.js';
import { planRow } from '../src/world/rowKit.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); if (!fs.existsSync(f)) return new Response(null, { status: 404 }); return new Response(fs.readFileSync(f)); };
const sig = (P) => [...P.near.entries()].map(([k, g]) => k + g.pos.length + ':' + g.pos.reduce((a, b) => a + b, 0).toFixed(2)).join('|');

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['city', 'citytest']) {
  console.log(`\n== ${name}`);
  mapDir = path.resolve('public/maps', name);
  const map = await loadMap('/maps/x/', { THREE, physics: false });
  const cb = createCityBlocks({ map }), keys = cb.chunkKeys(), A = createChunkPlanner({ cb, heightAt: map.heightAt }), B = createChunkPlanner({ cb, heightAt: map.heightAt });
  const zones = { residential: 0, rowhouse: 0, downtown: 0 }, rows = [];
  let towerCol = 0, stepMax = 0, lots = 0, ok = true, impOk = true, colOk = true, msMax = 0, msSum = 0;
  const plans = keys.map(([cx, cz]) => { const t0 = performance.now(), P = A.plan(cx, cz), ms = performance.now() - t0; msSum += ms; msMax = Math.max(msMax, ms); return [cx, cz, P, ms]; });
  for (const [cx, cz, P, ms] of plans.slice().reverse()) {
    const n = cb.chunk(cx, cz).lots.length; lots += n;
    for (const k in zones) zones[k] += P.buildings[k];
    if (sig(P) !== sig(B.plan(cx, cz))) ok = false;   // B plans in reverse order (row neighbour heights cached differently)
    if (P.tris.far > 30 * n) impOk = false;
    if (n && !(P.colliders.length >= n && P.colliders.every((c) => c.hx > 0 && c.hy > 0 && c.hz > 0 && Number.isFinite(c.y)))) colOk = false;
    for (const l of cb.chunk(cx, cz).lots) if (l.zone === 'downtown') {   // car-height point at the footprint centre must be inside a box
      const f = l.footprint, py = map.heightAt(f.cx, f.cz) + 1;
      if (!P.colliders.some((c) => { const dx = f.cx - c.x, dz = f.cz - c.z, co = Math.cos(c.yaw), si = Math.sin(c.yaw), u = dx * co - dz * si, w = dx * si + dz * co;
        return Math.abs(u) <= c.hx && Math.abs(w) <= c.hz && Math.abs(py - c.y) <= c.hy; })) towerCol++;
    }
    let sliceMax = 0; { const it = A.planIter(cx, cz); for (let r, t = performance.now(); !(r = it.next()).done; t = performance.now()) sliceMax = Math.max(sliceMax, performance.now() - t); }
    stepMax = Math.max(stepMax, sliceMax);
    rows.push({ chunk: `${cx},${cz}`, lots: n, nearMats: P.near.size, nearTris: P.tris.near, farMats: P.far.size, farTris: P.tris.far, colliders: P.colliders.length, props: P.props.length, ms: +ms.toFixed(1) });
  }
  console.table(rows);
  assert(ok, `deterministic and chunk-order independent (${keys.length} chunks)`);
  assert(Object.values(zones).reduce((a, b) => a + b, 0) === lots && lots > 0, `every lot planned once (${lots}: ${JSON.stringify(zones)})`);
  assert(impOk, 'far impostors <= 30 tris per building');
  assert(colOk, 'collider boxes valid, >= 1 per building');
  assert(towerCol === 0, `every downtown lot has a collider at ground level over its centre (${towerCol} missing)`);
  console.log(`     planIter: longest single slice ${stepMax.toFixed(1)} ms`);
  const nearDraws = rows.reduce((a, r) => a + r.nearMats, 0), farDraws = rows.reduce((a, r) => a + r.farMats, 0), nearTris = rows.reduce((a, r) => a + r.nearTris, 0), farTris = rows.reduce((a, r) => a + r.farTris, 0);
  console.log(`     totals: near ${nearTris} tris / ${nearDraws} draws, far ${farTris} tris / ${farDraws} draws; plan+merge ${(msSum / keys.length).toFixed(1)} ms/chunk avg, ${msMax.toFixed(1)} max`);
  // all rowhouse zoning: every side is either hidden by a really adjacent attached lot at least as tall, or has an outward wall reaching the body top
  {
    const cbR = createCityBlocks({ map, config: { zone: [-1, 9] } }), R = createChunkPlanner({ cb: cbR, heightAt: map.heightAt }), lotsR = cbR.chunkKeys().flatMap(([cx, cz]) => cbR.chunk(cx, cz).lots);
    const byId = new Map(); for (const bl of cbR.blocks) for (const l of bl.lots) byId.set(l, bl);
    const adj = (l, sg) => byId.get(l).lots.filter((o) => { if (o === l || !o.attached) return false; const f = l.footprint, g = o.footprint, c = Math.cos(f.yaw), sn = Math.sin(f.yaw), dx = g.cx - f.cx, dz = g.cz - f.cz;
      const u = dx * c - dz * sn, v = dx * sn + dz * c; return u * sg > 0 && Math.abs(Math.abs(u) - f.hu - g.hu) <= 0.3 && Math.abs(v) <= 2; });
    let n = 0, open = 0, bad = 0, ends = 0;
    for (const l of lotsR) {
      if (l.zone !== 'rowhouse') continue;
      n++; const spec = R.rowSpecOf(l), b = planRow(spec), top = b.tiers[0].y1, mans = top - b.wallTop;
      for (const [d, sg, nb] of [[0, -1, spec.leftH], [1, 1, spec.rightH]]) {
        if (!(nb >= 0)) { bad++; console.error('  rowhouse lot ' + l.id + ': neighbour height not explicit'); continue; }
        const a = adj(l, sg); if ((nb > 0) !== (a.length > 0)) { bad++; console.error(`  lot ${l.id} side ${d}: neighbour mismatch (h=${nb}, adjacent lots ${a.length})`); continue; }
        const wallTris = [], faces = [];   // (z, y) triangles of this side's outward wall quads, in the side plane (the outermost one: chimney faces sit inside)
        for (const p of b.prims) if (['brick', 'brownstone', 'plaster'].includes(p.mat)) for (let t = 0; t < p.idx.length; t += 3) { const i = [0, 1, 2].map((k) => p.idx[t + k] * 3); if (p.nor[i[0]] * sg > 0.99 && i.every((q) => Math.abs(p.pos[q] - p.pos[i[0]]) < 1e-4)) faces.push([p.pos[i[0]] * sg, i.map((q) => [p.pos[q + 2], p.pos[q + 1]])]); }
        const px = Math.max(...faces.map((q) => q[0])); for (const [x, tri] of faces) if (Math.abs(x - px) < 1e-3) wallTris.push(tri);
        const inTri = (z, y) => wallTris.some(([A, B, C]) => { const s1 = (B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (z - A[0]), s2 = (C[0] - B[0]) * (y - B[1]) - (C[1] - B[1]) * (z - B[0]), s3 = (A[0] - C[0]) * (y - C[1]) - (A[1] - C[1]) * (z - C[0]); return (s1 >= -1e-6 && s2 >= -1e-6 && s3 >= -1e-6) || (s1 <= 1e-6 && s2 <= 1e-6 && s3 <= 1e-6); });
        const fin = !(nb > 0) || (spec.corner && spec.cornerSide !== (sg < 0 ? 'right' : 'left')), nzs = fin ? null : (sg < 0 ? spec.leftZ : spec.rightZ), bodyTop = top - mans - 0.2;   // 'body top' = below the roof slab
        if (nb > 0 && !fin && !nzs) { bad++; console.error(`  lot ${l.id} side ${d}: neighbour z-extent missing`); continue; }
        let hole = null;   // every point of the side plane up to the body top is the neighbour's wall (z in its extent, y below its roof) or one of our wall tris
        for (let z = b.Z0 + 0.1; z < b.zf - 0.1 && !hole; z += 0.25) for (let y = 0.1; y < bodyTop && !hole; y += 0.4) if (!(nzs && z >= nzs[0] && z <= nzs[1] && y <= nb) && !inTri(z, y)) hole = [z, y];
        if (nb === 0) ends++;
        if (hole) { open++; console.error(`  lot ${l.id} side ${d}: open at z=${hole[0].toFixed(2)} y=${hole[1].toFixed(2)} (neighbour h=${nb}, z ${nzs && nzs.map((q) => q.toFixed(2))}, own z ${b.Z0.toFixed(2)}..${b.zf.toFixed(2)})`); }
      }
    }
    assert(n > 0 && !bad && !open, `forced rowhouse zoning: ${n} lots, ${ends} exposed ends all walled, neighbours explicit + adjacent (${open} open, ${bad} bad)`);
  }
}
