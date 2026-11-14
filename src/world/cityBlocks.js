// City blocks + lots from the road network (replacement for cityGen.js's one-row-along-each-road lots).
// PURE: no THREE, no DOM, no Rapier, so it runs in Node (scripts/test-city-blocks.mjs). Everything is built once from static geometry (roads, junctions, paint, terrain,
// markers) and every random choice is hash(seed, blockId, lotIndex, k): same map + seed + config = same blocks / lots, whatever order chunks are asked for.
//
//   const cb = createCityBlocks({ map, config?, override?, extraCircles? });
//   cb.blocks  -> [{ id, kind: 'block' | 'frontage', poly: [[x,z]...], zone, weight, lots: [lot], plaza?: { kind: 'plaza' | 'courtyard', poly, props: [{ type, x, z, yaw }] } }]
//   lot = { id, block, poly: [[x,z] x4], front: { x, z, yaw } (middle of the street edge; yaw turns local +Z toward the road, Three.js convention: +Z -> (sin yaw, cos yaw)),
//           w (along the street), d (depth), zone: 'residential' | 'rowhouse' | 'downtown', weight (city paint at the lot centre, drives height), corner, streets: [yaw...] (1, or 2 on a corner),
//           attached (rowhouse: neighbours share side walls), seed (uint32), driveway?: 'left' | 'right' (residential, seen from the street),
//           footprint: { cx, cz, hu, hv, yaw } (building box: hu half width along local X = street, hv half depth along local Z) }
//   cb.chunk(cx, cz) -> { cx, cz, lots: [lot], plazas: [plaza] }   (CFG.chunk m cells; a lot / plaza belongs to the cell of its centre)
//   cb.chunkKeys()   -> [[cx, cz]...] cells that hold anything
//   cb.blocked(x, z, margin) -> true within `margin` m of a building footprint or within lotMargin of any lot / plaza / courtyard
//   cb.blockedFor(x, z, margin, cat) -> same, but small veg (LOT_SMALL_VEG) may enter lots/plazas where grass+forest paint >= lotVegPaint (the scatter's `extraBlocked` hook)
//   cb.stats         -> counts (faces, failed insets, rejected lots by reason, ...)
//
// HOW. 1) Planar graph: every road is split at the junctions on it (map.junctions[].arms[].s = arc position), giving edges between junction nodes; road ends off a junction are
// dangling nodes. Dangling chains are pruned (repeatedly) and become FRONTAGE. 2) Faces: half-edge walk (at each node take the next edge clockwise); positive-area faces are blocks,
// negative ones are the outer boundary of a component (their road side also becomes frontage). 3) Block polygon = face inset by each edge's clearance (half width + KERB + footpath on
// city / shoulder on highway + roadMargin), miter offset with flipped edges removed; a face whose inset is not simple is dropped (stats.failedInset). 4) Zone from the mean city paint
// (weights[7]) over the block: < zone[0] residential, <= zone[1] rowhouse, else downtown. 5) Lots: downtown = detached perimeter strip + plaza in the leftover interior; rowhouse =
// attached perimeter strip + courtyard; residential = two rows along the long axis of the min-area box (perimeter strip when the block is not box-like). Frontage = a strip of
// CFG.frontageDepth on each open road side, lots along the road only. Every lot is then checked statically (map bounds, water + shore, slope, any road ribbon incl. bridge margin,
// highway, junction discs, markers / lot_empty, exclusion circles) and against every lot accepted before it (blocks first, in id order).
// Which roads make lots: city-type edges always; country edges where the block / strip paint >= paintMin; highways and bridges never (they still bound blocks).
// override (city.json): { seed, disabled, exclusions: [{x,z,r}] }. marker tag lot_empty: no lot within its radius (default tagRadius).
import { polyOf, KERB } from './roads.js';
import { FOOT_SHIFT, HIGHWAY } from './roadMeta.js';
import { hash } from './scatterGen.js';

export const BLOCK_CONFIG = {
  seed: 4242,
  chunk: 128,
  zone: [0.3, 0.5],                     // paint thresholds residential | rowhouse | downtown
  paintMin: 0.5,                        // country edges carry lots only where the paint is at least this
  cityShare: 0.25,                      // a face is a block if this share of its perimeter is city road, or its paint >= paintMin
  roadMargin: 1.5,                      // beyond the ribbon (half width + kerb + footpath / shoulder)
  checkMargin: 0.8,                     // static lot check: lot points keep ribbon + this (the inset ring is simplified by simplifyTol)
  simplifyTol: 0.5,
  bridgeMargin: 14, junctionMargin: 2, markerClear: 6, tagRadius: 25, shore: 4, edgeMargin: 8,
  maxHeightRange: 4,                    // terrain height range over a lot
  minBlockArea: 300, frontageDepth: 40, walkStep: 1, sharpTurn: 35 * Math.PI / 180,
  downtown: { w: [16, 30], d: [25, 40], gap: [6, 15], setback: [0.5, 2], side: 0.5, back: 1 },
  rowhouse: { w: [6, 10], d: [15, 20], gap: [0, 0], setback: [1, 3], houseD: [9, 12] },
  residential: { w: [18, 25], d: [26, 40], gap: [0, 2], front: [6, 8], side: 3, drive: 5, houseD: [9, 14], boxFill: 0.8 },
  lotMargin: 1,                         // blockedFor(): lots / plazas / courtyards are closed to scatter out to this many m past their edge
  lotVegPaint: 0.5,                     // ...except small veg (LOT_SMALL_VEG) where painted grass + forest weight >= this (footprints stay closed)
  plaza: { minArea: 300, maxArea: 40000, spacing: 9, jitter: 2.5, edge: 2, lotClear: 2, mix: [['tree', 0.35], ['bench', 0.35], ['planter', 0.3]], courtyardTrees: 0.4 },
};

export const LOT_SMALL_VEG = new Set(['groundcover', 'flower', 'bush']); // scatter categories a lot may hold when painted
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const deepMerge = (a, b) => {
  if (!b || typeof b !== 'object') return a;
  const o = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b)) o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : b[k];
  return o;
};

// ---------------------------------------------------------------- 2D polygon helpers (ring = [[x,z]...], not closed)
export const ringArea = (r) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
export function pointInRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; }
  return inside;
}
const segX = (a, b, c, d) => { // proper crossing of segments ab, cd
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};
function isSimple(r) { // ponytail: O(n^2), blocks have tens of vertices
  const n = r.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { if (i === 0 && j === n - 1) continue; if (segX(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return false; }
  return true;
}
export function convexOverlap(A, B, eps = 0.05) { // SAT for convex polygons; touching (penetration <= eps) is not an overlap
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], ax = -(q[1] - p[1]), az = q[0] - p[0], l = Math.hypot(ax, az) || 1;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of A) { const s = (v[0] * ax + v[1] * az) / l; a0 = Math.min(a0, s); a1 = Math.max(a1, s); }
    for (const v of B) { const s = (v[0] * ax + v[1] * az) / l; b0 = Math.min(b0, s); b1 = Math.max(b1, s); }
    if (a1 - eps <= b0 || b1 - eps <= a0) return false;
  }
  return true;
}
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(ax + dx * t - px, az + dz * t - pz); };
function simplify(pts, tol) { // Douglas-Peucker on an open polyline, keeps both ends
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) { const d = segDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (d > bd) { bd = d; best = i; } }
    if (best > 0) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// inset a positive-area ring (interior on the left) by a per-edge distance d[i] (edge i = r[i] -> r[i+1]); null when the result is degenerate / not simple
export function insetRing(r, d) {
  let L = r.map((p, i) => { const q = r[(i + 1) % r.length], tx = q[0] - p[0], tz = q[1] - p[1], l = Math.hypot(tx, tz) || 1; return { px: p[0], pz: p[1], tx: tx / l, tz: tz / l, d: d[i] }; })
    .filter((e, i) => Math.hypot(r[(i + 1) % r.length][0] - r[i][0], r[(i + 1) % r.length][1] - r[i][1]) > 1e-6);
  const meet = (a, b) => { // offset line a meets offset line b
    const ax = a.px - a.tz * a.d, az = a.pz + a.tx * a.d, bx = b.px - b.tz * b.d, bz = b.pz + b.tx * b.d, den = a.tx * b.tz - a.tz * b.tx;
    if (Math.abs(den) < 1e-3) return [bx, bz];
    const t = ((bx - ax) * b.tz - (bz - az) * b.tx) / den; return [ax + a.tx * t, az + a.tz * t];
  };
  for (let it = 0; it < 200 && L.length >= 3; it++) {
    const V = L.map((e, i) => meet(L[(i - 1 + L.length) % L.length], e));
    const bad = L.findIndex((e, i) => { const p = V[i], q = V[(i + 1) % L.length]; return (q[0] - p[0]) * e.tx + (q[1] - p[1]) * e.tz <= 0; });
    if (bad < 0) return ringArea(V) > 0 && isSimple(V) ? V : null;
    L.splice(bad, 1);
  }
  return null;
}
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function minBox(r) { // min-area oriented box -> { ux, uz (long axis), u0, u1, v0, v1 } with v = (-uz, ux)
  const h = convexHull(r); let best = null;
  for (let i = 0; i < h.length; i++) {
    const q = h[(i + 1) % h.length], l = Math.hypot(q[0] - h[i][0], q[1] - h[i][1]); if (l < 1e-6) continue;
    const ux = (q[0] - h[i][0]) / l, uz = (q[1] - h[i][1]) / l; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of h) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const a = (u1 - u0) * (v1 - v0);
    if (!best || a < best.a) best = (u1 - u0 >= v1 - v0) ? { a, ux, uz, u0, u1, v0, v1 } : { a, ux: -uz, uz: ux, u0: v0, u1: v1, v0: -u1, v1: -u0 };
  }
  return best;
}
const centroid = (r) => { let x = 0, z = 0; for (const p of r) { x += p[0]; z += p[1]; } return [x / r.length, z / r.length]; };
const yawOf = (dx, dz) => Math.atan2(dx, dz);                       // yaw turning local +Z to (dx, dz)

// ================================================================================================
export function createCityBlocks({ map, config, override = null, extraCircles = [] }) {
  const cfg = config ? deepMerge(BLOCK_CONFIG, config) : BLOCK_CONFIG;
  const ov = override || {};
  const seed = (Number.isFinite(ov.seed) ? ov.seed : cfg.seed) | 0;
  const W = map.info.worldSize, CS = cfg.chunk;
  const circles = [...(ov.exclusions || []), ...extraCircles].filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z) && c.r > 0);
  const stats = { nodes: 0, edges: 0, pruned: 0, faces: 0, outer: 0, failedInset: 0, small: 0, notCity: 0, blocks: 0, frontage: 0, lots: 0, rej: { bounds: 0, water: 0, slope: 0, road: 0, junction: 0, marker: 0, circle: 0, overlap: 0, shape: 0 } };
  const roads = ov.disabled ? [] : (map.roads || []), junctions = map.junctions || [];
  const polys = roads.map(polyOf), roadIdx = new Map(roads.map((r, i) => [r.id, i]));

  // ---- road ribbon segments in a grid (static lot check) ----
  const G = 32, gk = (a, b) => a * 73856 + b, segGrid = new Map();
  const ribbon = (road, P, i) => { const t = road.points[P.seg[i]] && road.points[P.seg[i]].type; return road.width / 2 + KERB + (t === 'city' ? FOOT_SHIFT : t === 'highway' ? HIGHWAY.SHOULDER_W : 0); };
  roads.forEach((road, ri) => {
    const P = polys[ri];
    for (let i = 0; i < P.n - 1; i++) {
      const c = ribbon(road, P, i) + cfg.checkMargin + ((P.b[i] || P.b[i + 1]) ? cfg.bridgeMargin : 0), s = [P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], c];
      for (let a = Math.floor((Math.min(s[0], s[2]) - c) / G); a <= Math.floor((Math.max(s[0], s[2]) + c) / G); a++)
        for (let b = Math.floor((Math.min(s[1], s[3]) - c) / G); b <= Math.floor((Math.max(s[1], s[3]) + c) / G); b++) { const k = gk(a, b); (segGrid.get(k) || segGrid.set(k, []).get(k)).push(s); }
    }
  });
  const markers = (map.markers || []).map((m) => ({ x: m.x, z: m.z, r: Math.max(0, m.radius || 0) + (m.tags && m.tags.includes('lot_empty') ? (m.radius > 0 ? 0 : cfg.tagRadius) : cfg.markerClear) }));
  const dry = (x, z) => {
    if (map.waterLevelAt(x, z) !== null) return false;
    for (let k = 0; k < 8; k++) if (map.waterLevelAt(x + Math.cos(k * TAU / 8) * cfg.shore, z + Math.sin(k * TAU / 8) * cfg.shore) !== null) return false;
    return true;
  };
  const lotPoints = (q) => { // corners, edge points every <= 5 m, centre
    const out = [];
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5)); for (let k = 0; k < n; k++) out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]); }
    out.push(centroid(q)); return out;
  };
  function staticReject(q) { // -> reason or null
    const pts = lotPoints(q);
    for (const [x, z] of pts) if (x < cfg.edgeMargin || z < cfg.edgeMargin || x > W - cfg.edgeMargin || z > W - cfg.edgeMargin) return 'bounds';
    let h0 = Infinity, h1 = -Infinity;
    for (const [x, z] of pts) { const h = map.heightAt(x, z); h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
    if (h1 - h0 > cfg.maxHeightRange) return 'slope';
    for (const [x, z] of pts) for (const s of segGrid.get(gk(Math.floor(x / G), Math.floor(z / G))) || []) if (segDist(x, z, s[0], s[1], s[2], s[3]) < s[4]) return 'road';
    for (const j of junctions) for (const [x, z] of pts) if (Math.hypot(x - j.x, z - j.z) < j.radius + cfg.junctionMargin) return 'junction';
    for (const m of markers) for (const [x, z] of pts) if (Math.hypot(x - m.x, z - m.z) < m.r) return 'marker';
    for (const c of circles) for (const [x, z] of pts) if (Math.hypot(x - c.x, z - c.z) < c.r) return 'circle';
    for (const [x, z] of pts) if (!dry(x, z)) return 'water';
    return null;
  }

  // ================================================================ 1) planar graph
  const nodes = []; // { x, z, out: [halfedge ids] }
  const jNode = new Map(); const nodeOfJ = (j) => { if (!jNode.has(j)) { jNode.set(j, nodes.length); nodes.push({ x: junctions[j].x, z: junctions[j].z, out: [] }); } return jNode.get(j); };
  const edges = []; // { a, b, pts: [[x,z]], clear, type: 'city'|'country'|'highway', bridge, road }
  roads.forEach((road, ri) => {
    const P = polys[ri]; if (P.n < 2) return;
    const splits = [];
    junctions.forEach((j, ji) => { for (const a of j.arms || []) if (roadIdx.get(a.roadId) === ri && !splits.some((s) => s.j === ji && Math.abs(s.s - a.s) < road.width * 2)) splits.push({ s: a.s, j: ji }); });
    splits.sort((a, b) => a.s - b.s || a.j - b.j);
    const len = P.s[P.n - 1], stops = [];
    if (!splits.length || splits[0].s > road.width + 1) stops.push({ s: 0, node: -1 });
    for (const s of splits) stops.push({ s: s.s, node: nodeOfJ(s.j) });
    if (!splits.length || len - splits[splits.length - 1].s > road.width + 1) stops.push({ s: len, node: -1 });
    for (const st of stops) if (st.node < 0) { const i = st.s === 0 ? 0 : P.n - 1; st.node = nodes.length; nodes.push({ x: P.x[i], z: P.z[i], out: [] }); }
    for (let k = 0; k + 1 < stops.length; k++) {
      const A = stops[k], B = stops[k + 1]; if (B.s - A.s < 1) continue;
      const pts = [[nodes[A.node].x, nodes[A.node].z]]; let clear = 0, bridge = false, nc = 0, nh = 0, nn = 0;
      for (let i = 0; i < P.n; i++) {
        if (P.s[i] <= A.s || P.s[i] >= B.s) continue;
        pts.push([P.x[i], P.z[i]]); const ii = Math.min(i, P.n - 2), t = road.points[P.seg[ii]].type;
        clear = Math.max(clear, ribbon(road, P, ii)); bridge = bridge || !!P.b[i]; nn++; if (t === 'city') nc++; else if (t === 'highway') nh++;
      }
      pts.push([nodes[B.node].x, nodes[B.node].z]);
      if (!nn) { clear = road.width / 2 + KERB; }
      edges.push({ a: A.node, b: B.node, pts: simplify(pts, cfg.simplifyTol), clear: clear + cfg.roadMargin, type: nh ? 'highway' : nc * 2 >= nn && nn ? 'city' : 'country', bridge, road: ri });
    }
  });
  stats.nodes = nodes.length; stats.edges = edges.length;
  // half-edges: 2e = a->b, 2e+1 = b->a
  const hePts = (h) => { const e = edges[h >> 1]; return h & 1 ? e.pts.slice().reverse() : e.pts; };
  const heAng = (h) => { const p = hePts(h), o = p[0]; let q = p[p.length - 1]; let acc = 0; for (let i = 1; i < p.length; i++) { acc += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); if (acc >= 5) { q = p[i]; break; } } return Math.atan2(q[1] - o[1], q[0] - o[0]); };
  // prune dangling chains (degree 1) -> frontage on both sides
  const alive = edges.map(() => true), deg = nodes.map(() => 0);
  edges.forEach((e) => { deg[e.a]++; deg[e.b]++; });
  for (let changed = true; changed;) {
    changed = false;
    edges.forEach((e, i) => { if (alive[i] && (deg[e.a] === 1 || deg[e.b] === 1)) { alive[i] = false; deg[e.a]--; deg[e.b]--; changed = true; stats.pruned++; } });
  }
  edges.forEach((e, i) => { if (!alive[i]) return; nodes[e.a].out.push(2 * i); nodes[e.b].out.push(2 * i + 1); });
  for (const n of nodes) n.out.sort((a, b) => heAng(a) - heAng(b) || a - b);
  const heEnd = (h) => { const e = edges[h >> 1]; return h & 1 ? e.a : e.b; };
  const nextHe = (h) => { const n = nodes[heEnd(h)], tw = h ^ 1, k = n.out.indexOf(tw); return n.out[(k - 1 + n.out.length) % n.out.length]; };

  // ================================================================ 2) faces
  const used = new Set(), faces = [], openSides = []; // openSides: half-edges whose LEFT side is open land (frontage)
  edges.forEach((_, i) => { if (!alive[i]) openSides.push(2 * i, 2 * i + 1); });
  edges.forEach((_, i) => {
    if (!alive[i]) return;
    for (const h0 of [2 * i, 2 * i + 1]) {
      if (used.has(h0)) continue;
      const cyc = []; let h = h0;
      for (let g = 0; g < 10000 && !used.has(h); g++) { used.add(h); cyc.push(h); h = nextHe(h); }
      const ring = [], clr = [];
      for (const he of cyc) { const p = hePts(he); for (let k = 0; k < p.length - 1; k++) { ring.push(p[k]); clr.push(he); } }
      const a = ringArea(ring);
      if (a > 0) faces.push({ cyc, ring, he: clr, area: a }); else { stats.outer++; openSides.push(...cyc); }
    }
  });
  stats.faces = faces.length;

  // ================================================================ lots
  const blocks = [], accepted = [], lotGrid = new Map(), LG = 32;
  const lotAabb = (q) => [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];
  const gridEach = (bb, fn) => { for (let a = Math.floor(bb[0] / LG); a <= Math.floor(bb[2] / LG); a++) for (let b = Math.floor(bb[1] / LG); b <= Math.floor(bb[3] / LG); b++) fn(gk(a, b)); };
  const overlapsAccepted = (q) => { let hit = false; gridEach(lotAabb(q), (k) => { if (!hit) for (const o of lotGrid.get(k) || []) if (convexOverlap(q, o.poly)) { hit = true; break; } }); return hit; };
  const paint = (x, z) => map.surfaceAt(x, z).weights[7] || 0;
  const zoneOf = (w) => (w < cfg.zone[0] ? 'residential' : w <= cfg.zone[1] ? 'rowhouse' : 'downtown');
  const meanPaint = (ring) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const p of ring) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    const st = Math.max(6, Math.sqrt((x1 - x0) * (z1 - z0) / 400)); let s = 0, n = 0;
    for (let x = x0 + st / 2; x < x1; x += st) for (let z = z0 + st / 2; z < z1; z += st) if (pointInRing(ring, x, z)) { s += paint(x, z); n++; }
    if (!n) { const c = centroid(ring); return paint(c[0], c[1]); }
    return s / n;
  };
  const insideRing = (ring, q) => { // lot shrunk by 0.3 m fully inside the ring, no ring vertex inside it
    const c = centroid(q), s = q.map((p) => { const dx = c[0] - p[0], dz = c[1] - p[1], l = Math.hypot(dx, dz) || 1; return [p[0] + dx / l * 0.3, p[1] + dz / l * 0.3]; });
    for (let i = 0; i < 4; i++) { if (!pointInRing(ring, s[i][0], s[i][1])) return false; const m = [(s[i][0] + s[(i + 1) % 4][0]) / 2, (s[i][1] + s[(i + 1) % 4][1]) / 2]; if (!pointInRing(ring, m[0], m[1])) return false; }
    for (const p of ring) if (pointInRing(s, p[0], p[1])) return false;
    for (let i = 0; i < ring.length; i++) for (let k = 0; k < 4; k++) if (segX(ring[i], ring[(i + 1) % ring.length], s[k], s[(k + 1) % 4])) return false;
    return true;
  };
  // lot from front mid F, street axis (ux,uz), inward normal (nx,nz)
  function makeLot(blk, idx, F, ux, uz, nx, nz, w, d, zone, extra = {}) {
    const hw = w / 2, a = [F[0] - ux * hw, F[1] - uz * hw], b = [F[0] + ux * hw, F[1] + uz * hw];
    const poly = [a, b, [b[0] + nx * d, b[1] + nz * d], [a[0] + nx * d, a[1] + nz * d]];
    if (ringArea(poly) < 0) poly.reverse();
    const cx = F[0] + nx * d / 2, cz = F[1] + nz * d / 2, yaw = yawOf(-nx, -nz), sd = Math.floor(hash(seed, blk.id, idx, 99) * 4294967296);
    const r = (k) => hash(seed, blk.id, idx, k), Z = cfg[zone];
    let fu = 0, fhu, fv0, fv1, driveway;
    if (zone === 'downtown') { fhu = hw - Z.side; fv0 = lerp(Z.setback[0], Z.setback[1], r(5)); fv1 = d - Z.back; }
    else if (zone === 'rowhouse') { fhu = hw; fv0 = lerp(Z.setback[0], Z.setback[1], hash(seed, blk.id, 0, 6)); fv1 = Math.min(d - 3, fv0 + lerp(Z.houseD[0], Z.houseD[1], hash(seed, blk.id, 0, 7))); }
    else {
      driveway = r(8) < 0.5 ? 'left' : 'right'; fhu = hw - (Z.side + Z.drive) / 2; fu = (Z.drive - Z.side) / 2 * (driveway === 'left' ? 1 : -1); // house shifted away from the driveway
      fhu = Math.min(fhu, hw - Z.side); fv0 = lerp(Z.front[0], Z.front[1], r(5)); fv1 = Math.min(d - 4, fv0 + lerp(Z.houseD[0], Z.houseD[1], r(7)));
    }
    if (!(fhu >= 2.5 && fv1 - fv0 >= 4)) return null;
    // driveway side as seen by a viewer on the street looking into the lot (+n)
    const side = (ux * nz - uz * nx) > 0 ? -1 : 1, fv = (fv0 + fv1) / 2;
    const fcx = F[0] + ux * fu * side + nx * fv, fcz = F[1] + uz * fu * side + nz * fv;
    return { id: 0, block: blk.id, poly, front: { x: F[0], z: F[1], yaw }, w, d, zone, weight: paint(cx, cz), corner: false, streets: [yaw], attached: zone === 'rowhouse', seed: sd,
      ...(driveway ? { driveway } : {}), footprint: { cx: fcx, cz: fcz, hu: fhu, hv: (fv1 - fv0) / 2, yaw }, ...extra };
  }
  function tryAccept(blk, lot, ring) {
    if (!lot) { stats.rej.shape++; return false; }
    if (ring && !insideRing(ring, lot.poly)) { stats.rej.shape++; return false; }
    const why = staticReject(lot.poly); if (why) { stats.rej[why]++; return false; }
    if (overlapsAccepted(lot.poly)) { stats.rej.overlap++; return false; }
    lot.id = blk.id * 1000 + blk.lots.length; blk.lots.push(lot); accepted.push(lot); gridEach(lotAabb(lot.poly), (k) => (lotGrid.get(k) || lotGrid.set(k, []).get(k)).push(lot));
    return true;
  }
  // walk a ring (or its first `limit` m) placing lots front-on; okAt(segIndex) says whether that ring edge is a street that carries lots
  function perimeterWalk(blk, ring, zone, okAt, { limit = Infinity, depth = null, fit = null } = {}) {
    const n = ring.length, S = [0]; for (let i = 0; i < n; i++) S.push(S[i] + Math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]));
    const L = S[n], Z = cfg[zone];
    const at = (s) => { s = ((s % L) + L) % L; let i = 0; while (i < n - 1 && S[i + 1] <= s) i++; const t = (s - S[i]) / ((S[i + 1] - S[i]) || 1), p = ring[i], q = ring[(i + 1) % n]; return [[lerp(p[0], q[0], t), lerp(p[1], q[1], t)], i]; };
    // sharp convex corners (arc position, outward normal of the other street)
    const corners = [];
    for (let i = 0; i < n; i++) {
      const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n], a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
      let t = a2 - a1; while (t > Math.PI) t -= TAU; while (t < -Math.PI) t += TAU;
      if (t > cfg.sharpTurn) corners.push({ s: S[i], in: [-(c[1] - p[1]), c[0] - p[0]], out: [-(q[1] - c[1]), q[0] - c[0]], t });
    }
    let s0 = 0;
    if (limit === Infinity && corners.length) s0 = corners.reduce((b, c) => (c.t > b.t + 1e-9 ? c : b)).s;
    const end = limit === Infinity ? s0 + L : limit;
    let idx = blk.lots.length * 7 + 1;
    for (let s = s0; ;) {
      const k = idx++, w = lerp(Z.w[0], Z.w[1], hash(seed, blk.id, k, 1)), d = depth != null ? depth : lerp(Z.d[0], Z.d[1], hash(seed, blk.id, k, 2));
      if (s + w > end) break;
      const [A, ia] = at(s), [B, ib] = at(s + w), cl = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (cl < w * 0.92 || !okAt(ia) || !okAt(ib)) { s += cfg.walkStep; continue; }
      const ux = (B[0] - A[0]) / cl, uz = (B[1] - A[1]) / cl, F = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const lot = makeLot(blk, k, F, ux, uz, -uz, ux, w, fit ? Math.min(d, fit) : d, zone);
      if (!tryAccept(blk, lot, ring)) { s += cfg.walkStep; continue; }
      for (const c of corners) { // corner lot: a sharp corner within one lot depth of either end
        let ds = c.s - s; ds = ((ds % L) + L) % L; if (ds > L / 2) ds -= L;
        if (ds > -lot.d * 0.6 && ds < w + lot.d * 0.6) { const o = ds < w / 2 ? c.in : c.out; if (!lot.corner) { lot.corner = true; lot.streets.push(yawOf(-o[0], -o[1])); } }
      }
      s += w + lerp(Z.gap[0], Z.gap[1], hash(seed, blk.id, k, 3));
    }
  }
  function residentialRows(blk, ring, okAt) {
    const bx = minBox(ring), Z = cfg.residential, short = bx.v1 - bx.v0;
    if (ringArea(ring) / bx.a < Z.boxFill || short > 2 * Z.d[1] + 30 || short < 2 * Z.d[0] * 0.7) return perimeterWalk(blk, ring, 'residential', okAt, { fit: short / 2 });
    const d = Math.min(short / 2, Z.d[1]), vx = -bx.uz, vz = bx.ux;
    for (const row of [0, 1]) {
      const v = row ? bx.v1 : bx.v0, nsg = row ? -1 : 1, lots = [];
      let u = bx.u0 + 1, k = row * 500 + 1;
      for (;;) {
        const w = lerp(Z.w[0], Z.w[1], hash(seed, blk.id, k, 1)); if (u + w > bx.u1 - 1) break;
        const um = u + w / 2, F = [bx.ux * um + vx * v, bx.uz * um + vz * v];
        const lot = makeLot(blk, k++, F, bx.ux, bx.uz, vx * nsg, vz * nsg, w, d, 'residential');
        if (tryAccept(blk, lot, ring)) { lots.push(lot); u += w + lerp(Z.gap[0], Z.gap[1], hash(seed, blk.id, k, 3)); } else u += cfg.walkStep * 2;
      }
      for (const [lot, sg] of [[lots[0], -1], [lots[lots.length - 1], 1]]) if (lot) { lot.corner = true; lot.streets.push(yawOf(bx.ux * sg, bx.uz * sg)); }
      if (lots.length === 1) lots[0].streets.pop();
    }
  }
  function interior(blk, ring, depth, kind) {
    const inner = insetRing(ring, ring.map(() => depth)); if (!inner) return;
    const a = ringArea(inner), P = cfg.plaza; if (a < P.minArea || a > P.maxArea) return;
    const bx = minBox(inner), vx = -bx.uz, vz = bx.ux, props = [], baseYaw = yawOf(bx.ux, bx.uz);
    let k = 0;
    for (let u = bx.u0 + P.spacing / 2; u < bx.u1; u += P.spacing) for (let v = bx.v0 + P.spacing / 2; v < bx.v1; v += P.spacing) {
      k++; const jx = (hash(seed, blk.id, k, 21) - 0.5) * 2 * P.jitter, jz = (hash(seed, blk.id, k, 22) - 0.5) * 2 * P.jitter;
      const x = bx.ux * u + vx * v + jx, z = bx.uz * u + vz * v + jz;
      if (!pointInRing(inner, x, z)) continue;
      let edge = Infinity; for (let i = 0; i < inner.length; i++) { const q = inner[(i + 1) % inner.length]; edge = Math.min(edge, segDist(x, z, inner[i][0], inner[i][1], q[0], q[1])); }
      if (edge < P.edge) continue;
      if (blk.lots.some((l) => pointInRing(l.poly, x, z) || l.poly.some((p, i) => segDist(x, z, p[0], p[1], l.poly[(i + 1) % 4][0], l.poly[(i + 1) % 4][1]) < P.lotClear))) continue;
      const r = hash(seed, blk.id, k, 23); let type;
      if (kind === 'courtyard') { if (r >= P.courtyardTrees) continue; type = 'tree'; }
      else { let acc = 0; type = P.mix[P.mix.length - 1][0]; for (const [t, p] of P.mix) { acc += p; if (r < acc) { type = t; break; } } }
      props.push({ type, x, z, yaw: baseYaw + Math.floor(hash(seed, blk.id, k, 24) * 4) * Math.PI / 2 });
    }
    blk.plaza = { kind, poly: inner, props };
  }

  // ---- blocks ----
  faces.forEach((f) => {
    const perim = f.he.map((h, i) => { const q = f.ring[(i + 1) % f.ring.length]; return Math.hypot(q[0] - f.ring[i][0], q[1] - f.ring[i][1]); }), L = perim.reduce((a, b) => a + b, 0);
    const cityLen = f.he.reduce((s, h, i) => s + (edges[h >> 1].type === 'city' ? perim[i] : 0), 0);
    const ring = insetRing(f.ring, f.he.map((h) => edges[h >> 1].clear));
    if (!ring) { stats.failedInset++; return; }
    if (ringArea(ring) < cfg.minBlockArea) { stats.small++; return; }
    const weight = meanPaint(ring);
    if (cityLen < cfg.cityShare * L && weight < cfg.paintMin) { stats.notCity++; return; }
    const zone = zoneOf(weight), blk = { id: blocks.length + 1, kind: 'block', poly: ring, zone, weight, lots: [] };
    // ring edge -> street: nearest face edge to the ring edge's midpoint
    const streetOk = (i) => {
      const p = ring[i], q = ring[(i + 1) % ring.length], mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2; let best = Infinity, he = -1;
      for (let k = 0; k < f.ring.length; k++) { const a = f.ring[k], b = f.ring[(k + 1) % f.ring.length], d = segDist(mx, mz, a[0], a[1], b[0], b[1]); if (d < best) { best = d; he = f.he[k]; } }
      const e = edges[he >> 1]; return !e.bridge && (e.type === 'city' || (e.type === 'country' && weight >= cfg.paintMin));
    };
    const okCache = ring.map((_, i) => streetOk(i)), okAt = (i) => okCache[i];
    blocks.push(blk);
    if (zone === 'residential') residentialRows(blk, ring, okAt);
    else {
      const depth = zone === 'rowhouse' ? lerp(cfg.rowhouse.d[0], cfg.rowhouse.d[1], hash(seed, blk.id, 0, 2)) : null;
      perimeterWalk(blk, ring, zone, okAt, { depth });
      interior(blk, ring, depth || cfg.downtown.d[1], zone === 'downtown' ? 'plaza' : 'courtyard');
    }
  });
  stats.blocks = blocks.length;

  // ---- frontage strips on open road sides ----
  const sidesDone = new Set();
  for (const h of openSides) {
    if (sidesDone.has(h)) continue; sidesDone.add(h);
    const e = edges[h >> 1]; if (e.bridge || e.type === 'highway') continue;
    const p = hePts(h); if (p.length < 2) continue;
    const off = (pts, d) => pts.map((q, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1; return [q[0] - tz / l * d, q[1] + tx / l * d]; });
    const front = off(p, e.clear), back = off(p, e.clear + cfg.frontageDepth), ring = front.concat(back.reverse());
    if (ringArea(ring) <= 0) continue;
    const weight = meanPaint(ring); if (e.type === 'country' && weight < cfg.paintMin) continue;
    let flen = 0; for (let i = 1; i < front.length; i++) flen += Math.hypot(front[i][0] - front[i - 1][0], front[i][1] - front[i - 1][1]);
    const zone = zoneOf(weight), blk = { id: blocks.length + 1, kind: 'frontage', poly: ring, zone, weight, lots: [] };
    blocks.push(blk); stats.frontage++;
    const depth = zone === 'rowhouse' ? lerp(cfg.rowhouse.d[0], cfg.rowhouse.d[1], hash(seed, blk.id, 0, 2)) : null;
    perimeterWalk(blk, ring, zone, (i) => i < front.length - 1, { limit: flen, depth, fit: cfg.frontageDepth });
  }
  for (const b of blocks) b.lots.forEach((l) => { l.weight = Math.round(l.weight * 1000) / 1000; });
  stats.lots = accepted.length;

  // ---- chunks + blocked() ----
  const byChunk = new Map(), ck = (cx, cz) => cx * 100003 + cz;
  const slot = (x, z) => { const cx = Math.floor(x / CS), cz = Math.floor(z / CS), k = ck(cx, cz); return byChunk.get(k) || byChunk.set(k, { cx, cz, lots: [], plazas: [] }).get(k); };
  const fpGrid = new Map(), FG = 32, plazas = [];
  for (const b of blocks) {
    for (const l of b.lots) {
      slot(l.footprint.cx, l.footprint.cz).lots.push(l);
      const f = l.footprint, ex = f.hu + f.hv; gridEach([f.cx - ex, f.cz - ex, f.cx + ex, f.cz + ex], (k) => (fpGrid.get(k) || fpGrid.set(k, []).get(k)).push(f));
    }
    if (b.plaza) { const c = centroid(b.plaza.poly); slot(c[0], c[1]).plazas.push(b.plaza); plazas.push(b.plaza); }
  }
  // areas = lot polys + plaza / courtyard polys, bucketed by aabb (+ lotMargin) in the same FG grid as the footprints
  const areaGrid = new Map(), LM = cfg.lotMargin;
  const addArea = (poly) => {
    const bb = lotAabb(poly), a = { poly, bb: [bb[0] - LM, bb[1] - LM, bb[2] + LM, bb[3] + LM] };
    for (let i = Math.floor(a.bb[0] / FG); i <= Math.floor(a.bb[2] / FG); i++) for (let j = Math.floor(a.bb[1] / FG); j <= Math.floor(a.bb[3] / FG); j++) { const k = gk(i, j); (areaGrid.get(k) || areaGrid.set(k, []).get(k)).push(a); }
  };
  for (const b of blocks) { for (const l of b.lots) addArea(l.poly); if (b.plaza) addArea(b.plaza.poly); }
  const inArea = (x, z) => {
    for (const a of areaGrid.get(gk(Math.floor(x / FG), Math.floor(z / FG))) || []) {
      if (x < a.bb[0] || x > a.bb[2] || z < a.bb[1] || z > a.bb[3]) continue;
      if (pointInRing(a.poly, x, z)) return true;
      const r = a.poly; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; if (segDist(x, z, p[0], p[1], q[0], q[1]) < LM) return true; }
    }
    return false;
  };
  const nearFootprint = (x, z, margin) => {
    for (const f of fpGrid.get(gk(Math.floor(x / FG), Math.floor(z / FG))) || []) {
      const dx = x - f.cx, dz = z - f.cz, c = Math.cos(f.yaw), s = Math.sin(f.yaw), lu = dx * c - dz * s, lv = dx * s + dz * c; // local X = (cos, -sin), local Z = (sin, cos)
      if (Math.hypot(Math.max(Math.abs(lu) - f.hu, 0), Math.max(Math.abs(lv) - f.hv, 0)) <= margin) return true;
    }
    return false;
  };
  // cat = scatter category (or null = treat as large): footprints always block; lots / plazas / courtyards block all but painted small veg
  const blockedFor = (x, z, margin = 0, cat = null) => {
    if (nearFootprint(x, z, margin)) return true;
    if (!inArea(x, z)) return false;
    if (!cat || !LOT_SMALL_VEG.has(cat)) return true;
    const w = map.surfaceAt(x, z).weights; return w[0] + w[1] < cfg.lotVegPaint;
  };
  const blocked = (x, z, margin = 0) => blockedFor(x, z, margin, null);
  return {
    config: cfg, seed, stats, blocks,
    chunk: (cx, cz) => byChunk.get(ck(cx, cz)) || { cx, cz, lots: [], plazas: [] },
    chunkKeys: () => [...byChunk.values()].map((c) => [c.cx, c.cz]),
    blocked, blockedFor,
  };
}
