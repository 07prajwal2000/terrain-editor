// Per-chunk building planner for the city (pure: no THREE, runs in Node; renderer: cityFill.js, test: scripts/test-city-chunk.mjs).
//
//   const P = createChunkPlanner({ cb, heightAt });     cb = cityBlocks.createCityBlocks(...), heightAt(x, z) = map.heightAt
//   P.plan(cx, cz, { near }) -> { far: Map(mat -> geo), near: Map(mat -> geo) | null, colliders: [{ x, y, z, hx, hy, hz, yaw }], props: [{ type, x, y, z, yaw }],
//                                 buildings: { residential, rowhouse, downtown }, tris: { near, far }, bounds: { x, z, r, top } }
//        geo = { pos, nor, uv, col (Float32Array, world space), idx (Uint32Array) }: every building of the chunk merged into ONE geometry per material key.
//   P.planIter(cx, cz, opts) generator: yields after each lot / merge step, returns the same plan (time-slicing).   splitKey('mat|style:v') -> [mat, texKey|null]
//        geo keys are 'mat' or 'mat|style:variant' (building's planTower tex for that material; impostors share the full building's tex).
//   P.colliders(cx, cz) -> the chunk's collider boxes (cached; cheap after the first call)
//
// Zone -> kit: residential = houseKit.planHouse (front = distance to the lot street edge), rowhouse = rowKit.planRow (leftH / rightH = heights of the attached
// neighbour lots of the same block, cornerSide from lot.streets[1]), downtown = towerKit.planTower. Far LOD = impostor boxes (rowKit.impostorFromTiers; houses use
// their collider boxes as tiers). Ground: building base = lowest footprint sample - EMBED, sunk into the slope by up to MAX_BURY on the high side; steeper lots sit at hi - MAX_BURY on a
// stone plinth down to the lowest corner - PLINTH_SINK. Downtown / rowhouse blocks get paved ground (near only): materials 'paving' (block,
// pushed out to the footpath edge), 'pavingPlaza' + 'pavingBand' (downtown plaza: granite slabs in a border band); rowhouse courtyards and residential stay terrain. All plans are deterministic (lot.seed), so a chunk can be re-planned at will.
import { planHouse } from './houseKit.js';
import { planRow, impostorFromTiers } from './rowKit.js';
import { planTower, TOWER_CONFIG } from './towerKit.js';
import { Mesh } from './shapeGrammar.js';
import { BLOCK_CONFIG } from './cityBlocks.js';
import earcut from 'three/src/extras/lib/earcut.js';   // pure JS, no THREE runtime

const CHUNK = BLOCK_CONFIG.chunk, MAX_BURY = 1.5, EMBED = 0.1, PLINTH_SINK = 0.3, PLINTH_TOP = 0.3, PLINTH_COL = { stone: [0.5, 0.48, 0.45] };
const PAVE = { lift: 0.04, maxEdge: 8, band: 1.2, col: { paving: [0.66, 0.64, 0.6], pavingPlaza: [0.72, 0.7, 0.66], pavingBand: [0.42, 0.41, 0.4] } };
const HOUSE_IMP_COL = { siding: [0.85, 0.83, 0.78], roofFlat: [0.3, 0.3, 0.32] };

// merge key: 'mat' or 'mat|style:variant' when the building picked a window texture for that material (towerKit tex)
export const splitKey = (k) => { const i = k.indexOf('|'); return i < 0 ? [k, null] : [k.slice(0, i), k.slice(i + 1)]; };
function merge(items) { // items [{ prims, x, y, z, yaw, tex? }] -> Map(key -> geo)
  const acc = new Map();
  for (const it of items) for (const p of it.prims) {
    const key = it.tex && it.tex[p.mat] ? p.mat + '|' + it.tex[p.mat] : p.mat;
    let a = acc.get(key); if (!a) acc.set(key, a = { list: [], nv: 0, ni: 0 });
    a.list.push([p, it]); a.nv += p.pos.length / 3; a.ni += p.idx.length;
  }
  const out = new Map();
  for (const [mat, a] of acc) {
    const pos = new Float32Array(a.nv * 3), nor = new Float32Array(a.nv * 3), uv = new Float32Array(a.nv * 2), col = new Float32Array(a.nv * 3).fill(1), idx = new Uint32Array(a.ni);
    let v = 0, k = 0;
    for (const [p, it] of a.list) {
      const c = Math.cos(it.yaw), s = Math.sin(it.yaw), n = p.pos.length / 3, cs = p.cs || 3;
      for (let i = 0; i < n; i++, v++) {
        const px = p.pos[3 * i], pz = p.pos[3 * i + 2], nx = p.nor[3 * i], nz = p.nor[3 * i + 2];
        pos[3 * v] = it.x + px * c + pz * s; pos[3 * v + 1] = it.y + p.pos[3 * i + 1]; pos[3 * v + 2] = it.z - px * s + pz * c;
        nor[3 * v] = nx * c + nz * s; nor[3 * v + 1] = p.nor[3 * i + 1]; nor[3 * v + 2] = -nx * s + nz * c;
        uv[2 * v] = p.uv[2 * i]; uv[2 * v + 1] = p.uv[2 * i + 1];
        if (p.col) for (let q = 0; q < 3; q++) col[3 * v + q] = p.col[cs * i + q];
      }
      const v0 = v - n; for (let j = 0; j < p.idx.length; j++) idx[k++] = p.idx[j] + v0;
    }
    out.set(mat, { pos, nor, uv, col, idx });
  }
  return out;
}

// ---- paved ground (downtown / rowhouse blocks): polygon (+ holes) -> earcut -> triangles split to <= maxEdge, draped on heightAt + lift; uv in metres
const area2 = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; } return a; };
function offsetPoly(P, d) { // d > 0 = outward (miter, clamped); fine for the mostly convex block / plaza rings
  const sg = area2(P) > 0 ? -1 : 1, n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n];
    const e1 = [b[0] - a[0], b[1] - a[1]], e2 = [c[0] - b[0], c[1] - b[1]], l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    const n1 = [sg * e1[1] / l1, -sg * e1[0] / l1], n2 = [sg * e2[1] / l2, -sg * e2[0] / l2], m = [n1[0] + n2[0], n1[1] + n2[1]], ml = Math.hypot(...m) || 1;
    const k = d / Math.max(0.35, (m[0] * n1[0] + m[1] * n1[1]) / ml);
    out.push([b[0] + m[0] / ml * k, b[1] + m[1] / ml * k]);
  }
  return out;
}
function pavePrim(mat, outer, holes, heightAt) {
  const flat = [], hi = [];
  for (const [x, z] of outer) flat.push(x, z);
  for (const h of holes) { hi.push(flat.length / 2); for (const [x, z] of h) flat.push(x, z); }
  const tri = earcut(flat, hi.length ? hi : null), pos = [], idx = [], seen = new Map();
  const put = (x, z) => { const k = x.toFixed(2) + ',' + z.toFixed(2); let i = seen.get(k); if (i === undefined) { seen.set(k, i = pos.length / 3); pos.push(x, heightAt(x, z) + PAVE.lift, z); } return i; };
  const sub = (a, b, c, d) => { // a, b, c = [x, z]
    const l = [Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(a[0] - b[0], a[1] - b[1])], i = l.indexOf(Math.max(...l));
    if (l[i] <= PAVE.maxEdge || d > 8) { idx.push(put(...a), put(...c), put(...b)); return; }   // ponytail: T-junctions not stitched (hairline gaps possible), fine at +lift
    const [p, q, r] = i === 0 ? [a, b, c] : i === 1 ? [b, c, a] : [c, a, b], m = [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2];
    sub(p, q, m, d + 1); sub(p, m, r, d + 1);
  };
  for (let i = 0; i < tri.length; i += 3) { const P = (j) => [flat[2 * tri[j]], flat[2 * tri[j] + 1]]; sub(P(i), P(i + 1), P(i + 2), 0); }
  const n = pos.length / 3, nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { nor[3 * i + 1] = 1; uv[2 * i] = pos[3 * i]; uv[2 * i + 1] = pos[3 * i + 2]; }
  const col = new Float32Array(n * 3); for (let i = 0; i < n; i++) col.set(PAVE.col[mat], 3 * i);
  return { mat, pos: new Float32Array(pos), nor, uv, col, idx: new Uint32Array(idx) };
}
// one block -> paving prims: block ring pushed out to the footpath edge; downtown plaza = granite slabs inside a dark border band; rowhouse courtyards stay terrain
function pavingOf(b, heightAt) {
  if (b.zone !== 'downtown') return []; // rowhouse gardens/porches sit on the terrain, whose city class already reads as paving
  const outer = offsetPoly(b.poly, BLOCK_CONFIG.roadMargin - 0.05), pl = b.plaza && b.plaza.poly && b.plaza.poly.length > 2 ? b.plaza.poly : null;
  const out = [pavePrim('paving', outer, pl ? [pl] : [], heightAt)];
  if (pl && b.zone === 'downtown') { const inner = offsetPoly(pl, -PAVE.band); out.push(pavePrim('pavingBand', pl, [inner], heightAt), pavePrim('pavingPlaza', inner, [], heightAt)); }
  return out;
}

const trisOf = (m) => { let t = 0; for (const g of m.values()) t += g.idx.length / 3; return t; };

export function createChunkPlanner({ cb, heightAt }) {
  const blockOf = new Map(cb.blocks.map((b) => [b.id, b])), blocksIn = new Map(), hCache = new Map(), colCache = new Map();
  for (const b of cb.blocks) { // a block's paving belongs to the chunk of its ring centroid
    let x = 0, z = 0; for (const [px, pz] of b.poly) { x += px; z += pz; }
    const k = Math.floor(x / b.poly.length / CHUNK) + ':' + Math.floor(z / b.poly.length / CHUNK); if (!blocksIn.has(k)) blocksIn.set(k, []); blocksIn.get(k).push(b);
  }
  const toLocal = (f, x, z) => { const dx = x - f.cx, dz = z - f.cz, c = Math.cos(f.yaw), s = Math.sin(f.yaw); return [dx * c - dz * s, dx * s + dz * c]; };
  const rowSpec = (l) => ({ hu: l.footprint.hu, hv: l.footprint.hv, seed: l.seed, weight: l.weight, attached: !!l.attached, corner: !!l.corner });
  const rowInfo = (l) => { let h = hCache.get(l.id); if (h === undefined) { const r = planRow(rowSpec(l)); hCache.set(l.id, h = { top: r.top, z0: r.Z0, zf: r.zf }); } return h; };   // roof height + front / back wall z (independent of neighbours)
  // attached lots of the same block sharing a side wall -> { H: [-X, +X] roof heights (0 = no neighbour: rowKit emits a finished end wall), Z: [-X, +X] [back, front] wall z of that neighbour in this lot's frame }.
  // Local -X = left (toLocal matches ground()). Front walls differ per style, so rowKit also gets the stretch of side wall the neighbour does not cover.
  function neighbours(l) {
    const f = l.footprint, out = { H: [0, 0], Z: [undefined, undefined] }, gap = [Infinity, Infinity], b = blockOf.get(l.block);
    if (!b || !l.attached) return out;
    for (const o of b.lots) {
      if (o === l || !o.attached) continue;
      const [u, v] = toLocal(f, o.footprint.cx, o.footprint.cz), dyaw = Math.abs(Math.atan2(Math.sin(o.footprint.yaw - f.yaw), Math.cos(o.footprint.yaw - f.yaw)));
      const e = Math.abs(Math.abs(u) - (f.hu + o.footprint.hu)), k = u < 0 ? 0 : 1;   // e = distance between the two side edges
      if (dyaw > 0.17 || Math.abs(v) > 2 || e > 0.3 || e >= gap[k]) continue;
      const i = rowInfo(o); gap[k] = e; out.H[k] = i.top; out.Z[k] = [v + i.z0, v + i.zf];
    }
    return out;
  }
  const rowSpecOf = (l) => { const spec = rowSpec(l), n = neighbours(l); [spec.leftH, spec.rightH] = n.H; [spec.leftZ, spec.rightZ] = n.Z;
    if (l.corner && l.streets && l.streets.length > 1) spec.cornerSide = Math.sin(l.streets[1] - l.footprint.yaw) > 0 ? 'right' : 'left';   // side street toward local +X = right
    return spec;
  };
  function planLot(l, gy = 0, gAt) {
    const f = l.footprint;
    if (l.zone === 'residential') {
      const [, fz] = toLocal(f, l.front.x, l.front.z);
      const b = planHouse({ hu: f.hu, hv: f.hv, seed: l.seed, weight: l.weight, driveway: l.driveway, front: Math.max(f.hv, fz), groundAt: gAt && ((u, v) => gAt(u, v) - gy) });
      return { b, imp: impostorFromTiers(b.collider.map((c) => ({ x0: c.cx - c.hu, x1: c.cx + c.hu, z0: c.cz - c.hv, z1: c.cz + c.hv, y0: c.y0, y1: c.y1, mat: 'siding' })), HOUSE_IMP_COL) };
    }
    if (l.zone === 'rowhouse') {
      const spec = rowSpecOf(l);
      const b = planRow(spec);
      return { b, imp: impostorFromTiers(b.tiers, b.col) };
    }
    const b = planTower({ hu: f.hu, hv: f.hv, seed: l.seed, weight: l.weight }), tiers = b.tiers.slice(0, 3).map((x) => ({ ...x }));   // = towerKit.planImpostor without re-planning
    if (b.tiers.length > 3) tiers[2].y1 = b.tiers[b.tiers.length - 1].y1;
    tiers[0].y0 = 0;
    return { b, imp: impostorFromTiers(tiers, b.col, TOWER_CONFIG.bayW, TOWER_CONFIG.floorH) };
  }
  function ground(f) { // base y + plinth depth below it (0 = none)
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw), at = (u, v) => heightAt(f.cx + u * c + v * s, f.cz - u * s + v * c);
    const hs = [at(-f.hu, f.hv), at(f.hu, f.hv), at(-f.hu, -f.hv), at(f.hu, -f.hv), at(0, f.hv), at(0, -f.hv), at(-f.hu, 0), at(f.hu, 0)];
    const lo = Math.min(...hs), hi = Math.max(...hs), y = Math.max(lo, hi - MAX_BURY) - EMBED;   // sit on the low side, sink into the slope up to MAX_BURY
    return { y, plinth: y - lo > 0.02 ? y - lo + PLINTH_SINK : 0 };
  }

  const plan = (cx, cz, o) => { const it = planIter(cx, cz, o); let r; while (!(r = it.next()).done); return r.value; };
  // generator: yields after every lot (renderer slices one chunk over several frames), returns the plan
  function* planIter(cx, cz, { near = true } = {}) {
    const C = cb.chunk(cx, cz), nearItems = [], farItems = [], colliders = [], buildings = { residential: 0, rowhouse: 0, downtown: 0 };
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
    for (const l of C.lots) {
      const f = l.footprint, { y, plinth } = ground(f), cs = Math.cos(f.yaw), sn = Math.sin(f.yaw);
      const { b, imp } = planLot(l, y, (u, v) => heightAt(f.cx + u * cs + v * sn, f.cz - u * sn + v * cs));
      buildings[l.zone]++;
      const at = { x: f.cx, y, z: f.cz, yaw: f.yaw };
      if (near) {
        nearItems.push({ prims: b.prims, tex: b.tex, ...at });
        if (plinth) { const g = new Mesh(PLINTH_COL); g.box('stone', -f.hu, f.hu, -plinth, PLINTH_TOP, -f.hv, f.hv); nearItems.push({ prims: g.prims(), ...at }); }
      }
      farItems.push({ prims: imp.prims, tex: b.tex, ...at });
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      // lowest boxes reach the ground (planTower's tier boxes start at groundH = 6 m: the lobby storey has no box, cars drove under the towers)
      const y0min = Math.min(...b.collider.map((k) => k.y0)) + 0.01;
      for (const k of b.collider) {
        const yb = y + (k.y0 <= y0min ? -plinth : k.y0);
        if (yb > y + 4) continue;   // ponytail: rooftop / upper-tier boxes skipped (cars stay on the ground; keeps the 80-box pool for walls). Keep them if anything lands on roofs.
        colliders.push({ x: f.cx + k.cx * c + k.cz * s, z: f.cz - k.cx * s + k.cz * c, y: (yb + y + k.y1) / 2, hx: k.hu, hy: (y + k.y1 - yb) / 2, hz: k.hv, yaw: f.yaw });
      }
      for (const k of b.garden || []) if (k.col) colliders.push({ x: f.cx + (k.x0 + k.x1) / 2 * c + (k.z0 + k.z1) / 2 * s, z: f.cz - (k.x0 + k.x1) / 2 * s + (k.z0 + k.z1) / 2 * c, y: y + (k.y0 + k.y1) / 2, hx: (k.x1 - k.x0) / 2, hy: (k.y1 - k.y0) / 2, hz: (k.z1 - k.z0) / 2, yaw: f.yaw });
      const r = Math.hypot(f.hu, f.hv);
      x0 = Math.min(x0, f.cx - r); x1 = Math.max(x1, f.cx + r); z0 = Math.min(z0, f.cz - r); z1 = Math.max(z1, f.cz + r); top = Math.max(top, y + b.H);
      yield;
    }
    if (near) for (const b of blocksIn.get(cx + ':' + cz) || []) { const pv = pavingOf(b, heightAt); if (pv.length) nearItems.push({ prims: pv, x: 0, y: 0, z: 0, yaw: 0 }); yield; }
    const props = [];
    for (const p of C.plazas) for (const q of p.props) props.push({ type: q.type, x: q.x, y: heightAt(q.x, q.z), z: q.z, yaw: q.yaw });
    colCache.set(cx + ':' + cz, colliders);
    const farM = merge(farItems); yield;
    const nearM = near ? merge(nearItems) : null;
    return { far: farM, near: nearM, colliders, props, buildings, tris: { near: nearM ? trisOf(nearM) : 0, far: trisOf(farM) },
      bounds: C.lots.length ? { x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2, top } : null };
  }
  return {
    plan, planIter, rowSpecOf,   // rowSpecOf: test hook, the spec planLot feeds planRow
    colliders(cx, cz) { const k = cx + ':' + cz; if (!colCache.has(k)) plan(cx, cz, { near: false }); return colCache.get(k); },
  };
}
