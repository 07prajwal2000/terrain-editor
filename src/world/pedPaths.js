// Pedestrian walk network (plan part 6c). PURE (no THREE, runs in Node: scripts/test-pedestrians.mjs).
//
//   const net = buildPedNetwork({ roads, roadDetail, junctions, blocks, paintAt, heightAt? });
//     roads / roadDetail / junctions = map.roads / map.roadDetail / map.junctions, blocks = cityBlocks.blocks, paintAt(x, z) = city paint 0..1 (map.surfaceAt(x,z).weights[7]).
//   net = { n, nx, nz, nh (Float32Array: x, z, height above the terrain surface at the node), nType (Uint8: NODE.*), nYaw (seat facing),
//           adjStart (Int32Array n+1), adjEdge (Int32Array), m (edges), ea, eb (Int32Array node ids), elen (Float32Array), ekind (EDGE.*), ecross (zebra index or -1),
//           egroup (signal phase group 0/1 of the crossed road, -1 = unsignalled), ew (city paint 0..1), crossings: [{ id, group, kind, x, z }], stats }
//
// Graph: undirected straight edges between nodes.
//   EDGE.WALK   footpath: one edge per footpath piece of roadDetail.footpaths, on the line hw + KERB_W + 1.2 m from the road centre (mid-footpath), pieces joined by node merging.
//   EDGE.CROSS  zebra: from a kerb node (hw + 0.5 from the centre) on one side to the kerb node on the other; made for EVERY zebra (roadDetail.zebras, signal arms and crosswalk
//               features) whose both footpath lines exist. A short WALK edge joins each kerb node to the footpath line (splitting the footpath edge there).
//               ecross = index into roadDetail.zebras = the crossing id used by crossingBusy (pedestrians.js). egroup: phase group of the crossed road at its junction
//               (signalState(group) 'red' = cars stopped = walk), taken from the junction's signal posts; -1 for feature zebras / arms without a post.
//   corners     the free footpath ends at a junction corner block (roadDetail.cornerBlocks) are joined by a WALK edge bent round the junction centre.
//   plazas      per downtown plaza: a ring 1.2 m inside the plaza polygon (EDGE.PLAZA), spurs (EDGE.SPUR) to benches (NODE.SEAT) and planters (NODE.IDLE), and, when a straight
//               link to a footpath node crosses no lot, a PLAZA edge to the footpath. Plazas without such a link are islands of their own.
// ponytail: no block-edge paths (the footpath already borders the block and downtown paving reaches it), no mid-plaza obstacle avoidance (spurs may pass through a tree),
// corners are two chords meeting where the walking lines cross (very sharp corners may clip the kerb), plain 'junction' / roundabout footpath ends stay dead ends (peds turn round there).
import { insetRing } from './cityBlocks.js';

export const EDGE = Object.freeze({ WALK: 0, CROSS: 1, SPUR: 2, PLAZA: 3 });
export const NODE = Object.freeze({ PLAIN: 0, SEAT: 1, IDLE: 2, KERB: 3 });
export const WALK_LINE = 1.35;      // m from the kerb line to the walking line (KERB_W 0.15 + 1.2)
export const KERB_STAND = 0.5;      // m from the road centre line edge (hw) where pedestrians wait
export const H_FOOT = 0.18, H_FLUSH = 0.045, H_PLAZA = 0.04;   // node height above the terrain: footpath top (LIFT 0.03 + kerb 0.15), flush crossing, plaza paving

const hypot = Math.hypot;

export function buildPedNetwork({ roads = [], roadDetail = null, junctions = [], blocks = [], paintAt = () => 0.5 }) {
  const NX = [], NZ = [], NH = [], NT = [], NY = [];
  const E = [];                                  // { a, b, kind, cross, group, w }
  const grid = new Map(), gk = (cx, cz) => cx * 73856 + cz;   // node hash, 1 m cells
  const addNode = (x, z, h, t = 0, yaw = 0) => {
    const id = NX.length; NX.push(x); NZ.push(z); NH.push(h); NT.push(t); NY.push(yaw);
    const k = gk(Math.floor(x), Math.floor(z)); (grid.get(k) || grid.set(k, []).get(k)).push(id); return id;
  };
  const nodeNear = (x, z, tol) => {
    let best = -1, bd = tol;
    for (let cz = Math.floor(z - tol); cz <= Math.floor(z + tol); cz++) for (let cx = Math.floor(x - tol); cx <= Math.floor(x + tol); cx++)
      for (const i of grid.get(gk(cx, cz)) || []) { const d = hypot(NX[i] - x, NZ[i] - z); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const nodeAt = (x, z, h, tol = 0.7) => { const i = nodeNear(x, z, tol); return i >= 0 ? i : addNode(x, z, h); };
  const addEdge = (a, b, kind, extra = {}) => { if (a === b) return -1; E.push({ a, b, kind, cross: -1, group: -1, w: 1, ...extra }); return E.length - 1; };
  const len = (e) => hypot(NX[e.b] - NX[e.a], NZ[e.b] - NZ[e.a]);

  // ---- 1. footpath lines
  let nPieces = 0;
  for (const p of roadDetail?.footpaths || []) {
    const L = hypot(p.bx - p.ax, p.bz - p.az); if (L < 0.3) continue;
    let ux = p.ox - p.ax, uz = p.oz - p.az; const ul = hypot(ux, uz) || 1; ux /= ul; uz /= ul;   // away from the road
    let px = -(p.bz - p.az) / L, pz = (p.bx - p.ax) / L; if (px * ux + pz * uz < 0) { px = -px; pz = -pz; }
    const A = nodeAt(p.ax + ux * WALK_LINE, p.az + uz * WALK_LINE, H_FOOT), B = nodeAt(p.bx + px * WALK_LINE, p.bz + pz * WALK_LINE, H_FOOT);
    const w = paintAt(p.bx + px * (WALK_LINE + 4), p.bz + pz * (WALK_LINE + 4));
    addEdge(A, B, EDGE.WALK, { w: Number.isFinite(w) ? w : 0.5 }); nPieces++;
  }

  // closest point on a WALK edge: -> { e, t (0..1), d, x, z } | null
  function nearestWalk(x, z, tol) {
    let best = null;
    for (let i = 0; i < E.length; i++) {
      const e = E[i]; if (e.kind !== EDGE.WALK) continue;
      const ax = NX[e.a], az = NZ[e.a], dx = NX[e.b] - ax, dz = NZ[e.b] - az, l2 = dx * dx + dz * dz; if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), d = hypot(ax + dx * t - x, az + dz * t - z);
      if (d <= tol && (!best || d < best.d)) best = { e: i, t, d, x: ax + dx * t, z: az + dz * t };
    }
    return best;
  }
  // footpath node at (x, z): reuse an end / existing node, or split the nearest walk edge there. -1 when there is no footpath within tol.
  function walkNodeAt(x, z, tol, h) {
    const n = nodeNear(x, z, 0.5); if (n >= 0 && E.some((e) => e.kind === EDGE.WALK && (e.a === n || e.b === n))) return n;
    const s = nearestWalk(x, z, tol); if (!s) return -1;
    const e = E[s.e], l = len(e);
    if (s.t * l < 0.5) return e.a; if ((1 - s.t) * l < 0.5) return e.b;
    const w = addNode(s.x, s.z, h), b = e.b; e.b = w; addEdge(w, b, EDGE.WALK, { w: e.w }); return w;
  }

  // ---- 2. zebras
  const crossings = [];
  const groupOf = new Map();                      // junction index -> { roadId -> group } from the signal posts
  for (const s of roadDetail?.signals || []) { const m = new Map(); for (const p of s.posts || []) m.set(p.roadId, p.group); groupOf.set(s.junction, m); }
  (roadDetail?.zebras || []).forEach((z, zi) => {
    const off = z.hw + WALK_LINE, kerb = z.hw + KERB_STAND, sd = [];
    for (const sg of [1, -1]) {
      const wx = z.x - z.tz * sg * off, wz = z.z + z.tx * sg * off;
      const W = walkNodeAt(wx, wz, 1.6, H_FLUSH); if (W < 0) return;
      sd.push({ W, kx: z.x - z.tz * sg * kerb, kz: z.z + z.tx * sg * kerb });
    }
    if (sd[0].W === sd[1].W) return;
    let group = -1;
    if (z.kind === 'signals' && z.junction !== undefined) {
      const m = groupOf.get(z.junction), rid = roads[z.road]?.id;
      if (m) { if (m.has(rid)) group = m.get(rid); else if (m.size) group = 1 - [...m.values()][0]; }
    }
    const K = sd.map((s) => addNode(s.kx, s.kz, H_FLUSH, NODE.KERB));
    sd.forEach((s, i) => addEdge(s.W, K[i], EDGE.WALK, { w: 0.5 }));
    addEdge(K[0], K[1], EDGE.CROSS, { cross: zi, group });
    crossings.push({ id: zi, group, kind: z.kind, x: z.x, z: z.z });
  });

  // ---- 3. junction corner blocks: join the two free footpath ends next to the block
  const degree = () => { const d = new Int32Array(NX.length); for (const e of E) { d[e.a]++; d[e.b]++; } return d; };
  const segD = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return hypot(ax + dx * t - px, az + dz * t - pz); };
  let nCorners = 0;
  for (const c of roadDetail?.cornerBlocks || []) {
    const P = c.poly, deg = degree(), cand = [];
    for (let i = 0; i < NX.length; i++) {
      if (deg[i] !== 1 || NT[i] !== NODE.PLAIN) continue;
      let d = Infinity; for (let k = 0; k < P.length; k += 2) { const k2 = (k + 2) % P.length; d = Math.min(d, segD(NX[i], NZ[i], P[k], P[k + 1], P[k2], P[k2 + 1])); }
      if (d < 2.5) cand.push(i);
    }
    if (cand.length < 2) continue;
    let bi = 0, bj = 1, bd = -1;
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) { const d = hypot(NX[cand[i]] - NX[cand[j]], NZ[cand[i]] - NZ[cand[j]]); if (d > bd) { bd = d; bi = i; bj = j; } }
    const a = cand[bi], b = cand[bj], jn = junctions[c.junction];
    // bend = where the two walking lines meet (they run on past the ends); else the chord midpoint pushed out round the junction centre
    const dirOf = (n) => { const e = E.find((q) => q.a === n || q.b === n), o = e.a === n ? e.b : e.a, l = hypot(NX[n] - NX[o], NZ[n] - NZ[o]) || 1; return [(NX[n] - NX[o]) / l, (NZ[n] - NZ[o]) / l]; };
    const da = dirOf(a), db = dirOf(b), den = da[0] * db[1] - da[1] * db[0];
    let M = -1;
    if (Math.abs(den) > 0.2) {
      const ex = NX[b] - NX[a], ez = NZ[b] - NZ[a], ta = (ex * db[1] - ez * db[0]) / den, tb = (ex * da[1] - ez * da[0]) / den;
      if (ta > -1 && ta < 14 && tb > -1 && tb < 14) M = addNode(NX[a] + da[0] * ta, NZ[a] + da[1] * ta, H_FOOT);
    }
    if (M < 0) {
      const cx = jn ? jn.x : (NX[a] + NX[b]) / 2, cz = jn ? jn.z : (NZ[a] + NZ[b]) / 2;
      const mx = (NX[a] + NX[b]) / 2 - cx, mz = (NZ[a] + NZ[b]) / 2 - cz, ml = hypot(mx, mz) || 1, r = (hypot(NX[a] - cx, NZ[a] - cz) + hypot(NX[b] - cx, NZ[b] - cz)) / 2;
      M = addNode(cx + mx / ml * r, cz + mz / ml * r, H_FOOT);
    }
    const w = paintAt(NX[M], NZ[M]);
    addEdge(a, M, EDGE.WALK, { w }); addEdge(M, b, EDGE.WALK, { w }); nCorners++;
  }

  // ---- 4. plazas
  const lots = blocks.flatMap((b) => b.lots.map((l) => l.poly));
  const segX = (a, b, c, d) => {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const clear = (a, b) => { // straight line a -> b crosses no lot polygon
    const x0 = Math.min(a[0], b[0]) - 1, x1 = Math.max(a[0], b[0]) + 1, z0 = Math.min(a[1], b[1]) - 1, z1 = Math.max(a[1], b[1]) + 1;
    for (const q of lots) {
      let qx0 = Infinity, qx1 = -Infinity, qz0 = Infinity, qz1 = -Infinity; for (const p of q) { qx0 = Math.min(qx0, p[0]); qx1 = Math.max(qx1, p[0]); qz0 = Math.min(qz0, p[1]); qz1 = Math.max(qz1, p[1]); }
      if (qx1 < x0 || qx0 > x1 || qz1 < z0 || qz0 > z1) continue;
      for (let i = 0; i < q.length; i++) if (segX(a, b, q[i], q[(i + 1) % q.length])) return false;
    }
    return true;
  };
  let nPlazas = 0, nLinked = 0, nSeats = 0;
  const footNodes = []; for (let i = 0; i < NX.length; i++) if (NT[i] === NODE.PLAIN) footNodes.push(i);
  for (const blk of blocks) {
    const pl = blk.plaza; if (!pl || pl.kind !== 'plaza') continue;
    const d = pl.poly.map(() => 1.2), ring = insetRing_(pl.poly, d) || pl.poly;
    const pts = [];   // ring subdivided to <= 8 m
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length], n = Math.max(1, Math.ceil(hypot(q[0] - p[0], q[1] - p[1]) / 8)); for (let k = 0; k < n; k++) pts.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]); }
    if (pts.length < 3) continue;
    const ids = pts.map((p) => addNode(p[0], p[1], H_PLAZA));
    for (let i = 0; i < ids.length; i++) addEdge(ids[i], ids[(i + 1) % ids.length], EDGE.PLAZA, { w: 1 });
    nPlazas++;
    for (const pr of pl.props) {
      if (pr.type !== 'bench' && pr.type !== 'planter') continue;
      let bi = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const dd = hypot(pts[i][0] - pr.x, pts[i][1] - pr.z); if (dd < bd) { bd = dd; bi = i; } }
      const seat = pr.type === 'bench', N = addNode(pr.x, pr.z, H_PLAZA, seat ? NODE.SEAT : NODE.IDLE, pr.yaw);
      addEdge(ids[bi], N, EDGE.SPUR, { w: 1 }); if (seat) nSeats++;
    }
    // link to the footpath: nearest few footpath nodes whose straight line crosses no lot
    let linked = false;
    const near = ids.flatMap((id) => footNodes.map((f) => [hypot(NX[id] - NX[f], NZ[id] - NZ[f]), id, f])).filter((q) => q[0] < 70).sort((p, q) => p[0] - q[0]);
    for (const [, id, f] of near.slice(0, 40)) { if (clear([NX[id], NZ[id]], [NX[f], NZ[f]])) { addEdge(id, f, EDGE.PLAZA, { w: 1 }); linked = true; break; } }
    if (linked) nLinked++;
  }

  // ---- compile
  const n = NX.length, m = E.length;
  const net = {
    n, m, nx: Float32Array.from(NX), nz: Float32Array.from(NZ), nh: Float32Array.from(NH), nType: Uint8Array.from(NT), nYaw: Float32Array.from(NY),
    ea: new Int32Array(m), eb: new Int32Array(m), elen: new Float32Array(m), ekind: new Uint8Array(m), ecross: new Int32Array(m), egroup: new Int8Array(m), ew: new Float32Array(m),
    adjStart: new Int32Array(n + 1), adjEdge: null, crossings,
  };
  const cnt = new Int32Array(n + 1);
  E.forEach((e, i) => {
    net.ea[i] = e.a; net.eb[i] = e.b; net.elen[i] = len(e); net.ekind[i] = e.kind; net.ecross[i] = e.cross; net.egroup[i] = e.group; net.ew[i] = Math.max(0, Math.min(1, e.w));
    cnt[e.a]++; cnt[e.b]++;
  });
  for (let i = 0; i < n; i++) net.adjStart[i + 1] = net.adjStart[i] + cnt[i];
  net.adjEdge = new Int32Array(net.adjStart[n]);
  const fill = net.adjStart.slice(0, n); for (let i = 0; i < m; i++) { net.adjEdge[fill[net.ea[i]]++] = i; net.adjEdge[fill[net.eb[i]]++] = i; }
  let walkLen = 0; for (let i = 0; i < m; i++) if (net.ekind[i] !== EDGE.CROSS) walkLen += net.elen[i];
  net.stats = { nodes: n, edges: m, pieces: nPieces, crossings: crossings.length, corners: nCorners, plazas: nPlazas, plazasLinked: nLinked, seats: nSeats, walkLen: Math.round(walkLen) };
  return net;
}

const insetRing_ = (r, d) => { try { return insetRing(r, d); } catch { return null; } };

// ---- queries shared by the runtime and the tests
// connected components over all edges: -> { comp: Int32Array(n), count }
export function components(net) {
  const comp = new Int32Array(net.n).fill(-1); let count = 0; const st = [];
  for (let s = 0; s < net.n; s++) {
    if (comp[s] >= 0) continue; comp[s] = count; st.push(s);
    while (st.length) { const u = st.pop(); for (let k = net.adjStart[u]; k < net.adjStart[u + 1]; k++) { const e = net.adjEdge[k], v = net.ea[e] === u ? net.eb[e] : net.ea[e]; if (comp[v] < 0) { comp[v] = count; st.push(v); } } }
    count++;
  }
  return { comp, count };
}
// density multiplier from city paint: downtown (>= 0.5) heavy, rowhouse (0.3..0.5) light, residential sparse
export const density = (w) => (w >= 0.5 ? 1 : w >= 0.3 ? 0.4 : 0.1);
