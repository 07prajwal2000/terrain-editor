// Lane graph for traffic (plan part 6b). PURE (no THREE): built from map.roads (polyOf splines) + map.junctions (+ zebra list), runs in Node.
//
//   const g = buildLaneGraph({ roads, junctions, zebras, heightAt, driveSide, paintAt });
//
// Every road is cut at its junction arms (arm.s +- junction.radius = the patch / ring edge), each piece between two cuts becomes one LANE per direction
// (oneway roads: only along the point order; highways: none), offset from the centreline by max(1.5, halfWidth / 2) on the driver's side (right-hand default:
// lateral + = (-tz, tx) = right of travel). Inside a junction, every incoming lane gets a CONNECTOR to every other arm's outgoing lane (no U-turns): a bezier, or
// an arc round the ring on roundabouts (counter-clockwise seen from above for right-hand traffic). Lanes and connectors share one array `paths`
// (lane ids first), both have x/y/z/s (Float64Array, s = cumulative arc length), len, cars[] (filled by traffic.js every step).
//
// paths[i] lane:      { id, isConn:false, road, fwd, type, v (limit m/s), n,x,y,z,s,len, s0,s1 (road arc range), from/to {ji,ak}|null, outConns[] (path ids),
//                       gates[] sorted by d: { d, kind:'junction'|'zebra', group (signal phase group or -1), id (zebra index) }, entryZebras[] (zebras just after its start), paint }
// paths[i] connector: { id, isConn:true, ci (index into occ), ji, from, to (lane path ids), n,x,y,z,s,len, v, turn (rad), weight, conflicts[] (ci of connectors that
//                       cross / merge with it: two cars may not be inside conflicting connectors at once) }
// occ: Int16Array(nConns) occupancy / reservation counters, owned by traffic.js.   spawn: flat points { path, s, x, z, w, paint } + queryPts(x, z, r, out) (grid, 64 m cells).
// Limitations: dead-end lanes just end (cars despawn there); lanes inside a junction patch are only the connectors; no multi-lane roads; roundabout ring cars use
// connector locks like any junction (one conflicting stream at a time), so a busy roundabout is slow; a bridge deck uses the road's own y.
import { polyOf } from './roads.js';

export const LANE_CFG = { STEP: 3, MIN_PIECE: 6, MIN_OFF: 1.5, SPEED: { city: 11, country: 17 }, STOP_OFF: { signals: 6.4, junction: 2.0, roundabout: 3.0 }, ZEBRA_STOP: 2.8, SPAWN_SPACING: 35, CONFLICT_DIST: 4.0, LIFT: 0.03 };

function sampleAt(P, s) {
  let lo = 0, hi = P.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.s[m] <= s) lo = m; else hi = m; }
  const l = P.s[hi] - P.s[lo] || 1, t = Math.min(1, Math.max(0, (s - P.s[lo]) / l));
  return { x: P.x[lo] + (P.x[hi] - P.x[lo]) * t, z: P.z[lo] + (P.z[hi] - P.z[lo]) * t, y: P.y[lo] + (P.y[hi] - P.y[lo]) * t, tx: P.tx[lo], tz: P.tz[lo], b: P.b[lo] && P.b[hi] ? 1 : 0, seg: P.seg[lo] };
}
const arcs = (x, z) => { const s = new Float64Array(x.length); for (let i = 1; i < x.length; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]); return s; };

export function buildLaneGraph({ roads, junctions, zebras = [], heightAt, driveSide = 'right', paintAt = () => 0 }) {
  const side = driveSide === 'left' ? -1 : 1, C = LANE_CFG;
  const idxOf = new Map(roads.map((r, i) => [r.id, i])), key = (ji, ak) => ji * 64 + ak;
  const cuts = roads.map(() => []);
  junctions.forEach((j, ji) => j.arms.forEach((a, ak) => { const ri = idxOf.get(a.roadId); if (ri !== undefined) cuts[ri].push({ s: a.s + a.dir * j.radius, ji, ak, dir: a.dir }); }));
  const paths = [], armOut = new Map(), armIn = new Map(), lanesOfRoad = roads.map(() => []);

  // ---- lanes
  roads.forEach((road, ri) => {
    const P = polyOf(road); if (P.n < 2) return;
    const L = P.s[P.n - 1], pieces = []; let start = { s: 0, arm: null };
    for (const c of cuts[ri].sort((a, b) => a.s - b.s)) {
      if (c.dir > 0) start = { s: Math.max(0, c.s), arm: c };
      else { if (start && Math.min(c.s, L) - start.s >= C.MIN_PIECE) pieces.push({ s0: start.s, s1: Math.min(L, c.s), a0: start.arm, a1: c }); start = null; }
    }
    if (start && L - start.s >= C.MIN_PIECE) pieces.push({ s0: start.s, s1: L, a0: start.arm, a1: null });
    const hw = road.width / 2, off = Math.max(C.MIN_OFF, hw * 0.5);
    for (const pc of pieces) {
      const mid = sampleAt(P, (pc.s0 + pc.s1) / 2), meta = road.points[mid.seg];
      if (!meta || meta.type === 'highway') continue;
      const ss = []; for (let s = pc.s0; s < pc.s1 - 1e-6; s += C.STEP) ss.push(s); ss.push(pc.s1);
      for (const fwd of meta.oneway ? [true] : [true, false]) {
        const q = ss.map((s) => sampleAt(P, s)); if (!fwd) q.reverse();
        const d = fwd ? 1 : -1, n = q.length, x = new Float64Array(n), z = new Float64Array(n), y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          x[i] = q[i].x + side * d * off * -q[i].tz; z[i] = q[i].z + side * d * off * q[i].tx;
          y[i] = q[i].b ? q[i].y : heightAt(x[i], z[i]) + C.LIFT;
        }
        const s = arcs(x, z), id = paths.length, from = fwd ? pc.a0 : pc.a1, to = fwd ? pc.a1 : pc.a0;
        const lane = { id, isConn: false, road: ri, fwd, type: meta.type, v: C.SPEED[meta.type] || 14, n, x, y, z, s, len: s[n - 1], s0: pc.s0, s1: pc.s1,
          from: from ? { ji: from.ji, ak: from.ak } : null, to: to ? { ji: to.ji, ak: to.ak } : null, outConns: [], gates: [], entryZebras: [], cars: [], paint: paintAt(x[n >> 1], z[n >> 1]) };
        paths.push(lane); lanesOfRoad[ri].push(id);
        if (lane.from) armOut.set(key(lane.from.ji, lane.from.ak), id);
        if (lane.to) armIn.set(key(lane.to.ji, lane.to.ak), id);
      }
    }
  });
  const nLanes = paths.length;

  // ---- connectors
  const conns = [], jInfo = junctions.map(() => ({ conns: [] }));
  const tanEnd = (l) => { const k = l.n - 1, dx = l.x[k] - l.x[k - 1], dz = l.z[k] - l.z[k - 1], h = Math.hypot(dx, dz) || 1; return [dx / h, dz / h]; };
  const tanStart = (l) => { const dx = l.x[1] - l.x[0], dz = l.z[1] - l.z[0], h = Math.hypot(dx, dz) || 1; return [dx / h, dz / h]; };
  junctions.forEach((j, ji) => {
    const ins = [], outs = [];
    j.arms.forEach((a, ak) => { const li = armIn.get(key(ji, ak)), lo = armOut.get(key(ji, ak)); if (li !== undefined) ins.push({ ak, id: li }); if (lo !== undefined) outs.push({ ak, id: lo }); });
    const ring = j.style === 'roundabout', mw = Math.max(0, ...j.arms.map((a) => a.width)), Rr = j.radius - Math.min(mw, j.radius - 4) / 2;
    for (const A of ins) for (const B of outs) {
      if (A.ak === B.ak) continue;
      const la = paths[A.id], lb = paths[B.id], ta = tanEnd(la), tb = tanStart(lb);
      const px = [la.x[la.n - 1]], pz = [la.z[la.n - 1]], ex = lb.x[0], ez = lb.z[0];
      const cosT = ta[0] * tb[0] + ta[1] * tb[1]; if (cosT < -0.92) continue;     // reversal: no U-turns
      const turn = Math.atan2(ta[0] * tb[1] - ta[1] * tb[0], cosT);
      if (ring) {
        const a0 = Math.atan2(pz[0] - j.z, px[0] - j.x), a1 = Math.atan2(ez - j.z, ex - j.x), dir = -side;
        let da = ((a1 - a0) * dir) % (2 * Math.PI); if (da < 0) da += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(da / 0.2));
        for (let k = 0; k <= steps; k++) { const a = a0 + dir * da * k / steps; px.push(j.x + Math.cos(a) * Rr); pz.push(j.z + Math.sin(a) * Rr); }
      } else {
        const D = Math.hypot(ex - px[0], ez - pz[0]), k = Math.max(1, D * 0.38), n = Math.max(4, Math.ceil(D / 2));
        const p1 = [px[0] + ta[0] * k, pz[0] + ta[1] * k], p2 = [ex - tb[0] * k, ez - tb[1] * k], p0x = px[0], p0z = pz[0];
        for (let i = 1; i < n; i++) {
          const t = i / n, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
          px.push(b0 * p0x + b1 * p1[0] + b2 * p2[0] + b3 * ex); pz.push(b0 * pz[0] + b1 * p1[1] + b2 * p2[1] + b3 * ez);
        }
      }
      px.push(ex); pz.push(ez);
      const n = px.length, x = Float64Array.from(px), z = Float64Array.from(pz), y = new Float64Array(n), s = arcs(x, z);
      const y0 = la.y[la.n - 1], y1 = lb.y[0]; for (let i = 0; i < n; i++) y[i] = y0 + (y1 - y0) * (s[n - 1] ? s[i] / s[n - 1] : 0);
      const id = paths.length, c = { id, isConn: true, ci: conns.length, ji, from: la.id, to: lb.id, n, x, y, z, s, len: s[n - 1], v: Math.abs(turn) < 0.4 ? la.v : ring ? 7 : 5.5, turn, weight: Math.abs(turn) < 0.45 ? 4 : 1.5, conflicts: [], cars: [] };
      paths.push(c); conns.push(c); jInfo[ji].conns.push(c); la.outConns.push(id);
    }
    // conflicts: connectors of this junction whose paths come closer than CONFLICT_DIST (resampled every ~1.5 m); includes same-origin / same-target pairs
    const res = jInfo[ji].conns.map((c) => { const pts = []; for (let d = 0; d <= c.len; d += 1.5) { let k = 0; while (k < c.n - 2 && c.s[k + 1] < d) k++; const t = (d - c.s[k]) / ((c.s[k + 1] - c.s[k]) || 1); pts.push(c.x[k] + (c.x[k + 1] - c.x[k]) * t, c.z[k] + (c.z[k + 1] - c.z[k]) * t); } return pts; });
    const cd = ring ? C.CONFLICT_DIST * 1.6 : C.CONFLICT_DIST, D2 = cd * cd, cs = jInfo[ji].conns;   // long vehicles swing wide on the tight ring
    for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
      let hit = false;
      for (let i = 0; i < res[a].length && !hit; i += 2) for (let k = 0; k < res[b].length; k += 2) { const dx = res[a][i] - res[b][k], dz = res[a][i + 1] - res[b][k + 1]; if (dx * dx + dz * dz < D2) { hit = true; break; } }
      if (hit) { cs[a].conflicts.push(cs[b].ci); cs[b].conflicts.push(cs[a].ci); }
    }
  });

  // ---- gates: the stop line before a junction (signal group from the junction's posts), zebras (stop before the crossing; those right after a lane start gate the junction entry instead)
  for (let i = 0; i < nLanes; i++) {
    const l = paths[i]; if (!l.to) continue;
    const j = junctions[l.to.ji], arm = j.arms[l.to.ak], st = j.style;
    let group = -1;
    if (st === 'signals') { const p = (j.signals || []).find((q) => q.roadId === arm.roadId); if (p) group = p.group; }
    l.gates.push({ d: Math.max(1, l.len - (C.STOP_OFF[st] ?? 2)), kind: 'junction', group, id: -1 });
  }
  zebras.forEach((z, zi) => {
    for (const li of lanesOfRoad[z.road] || []) {
      const l = paths[li]; if (z.s < l.s0 + 0.5 || z.s > l.s1 - 0.5) continue;
      const rel = l.fwd ? z.s - l.s0 : l.s1 - z.s, d = rel - C.ZEBRA_STOP;
      if (d >= 1) l.gates.push({ d, kind: 'zebra', group: -1, id: zi }); else if (rel < 8) l.entryZebras.push(zi);
    }
  });
  for (let i = 0; i < nLanes; i++) paths[i].gates.sort((a, b) => a.d - b.d);

  // ---- spawn points + grid
  const spawn = { path: [], s: [], x: [], z: [], w: [], paint: [] }, grid = new Map(), CELL = 64;
  for (let i = 0; i < nLanes; i++) {
    const l = paths[i]; if (l.len < 20) continue;
    for (let s = 14; s <= l.len - 8; s += C.SPAWN_SPACING) {
      let k = 0; while (k < l.n - 2 && l.s[k + 1] < s) k++;
      const t = (s - l.s[k]) / ((l.s[k + 1] - l.s[k]) || 1), x = l.x[k] + (l.x[k + 1] - l.x[k]) * t, z = l.z[k] + (l.z[k + 1] - l.z[k]) * t, paint = Math.min(1, Math.max(0, paintAt(x, z)));
      // w = target cars per spawn point (= SPAWN_SPACING m of one lane) at density 1: city 1 car / 120 m (residential) .. 35 m (downtown paint), country 1 / 250 m
      const mpc = l.type === 'city' ? 1 / (1 / 120 + (1 / 35 - 1 / 120) * paint) : 250, w = C.SPAWN_SPACING / mpc, id = spawn.x.length;
      spawn.path.push(l.id); spawn.s.push(s); spawn.x.push(x); spawn.z.push(z); spawn.w.push(w); spawn.paint.push(paint);
      const ck = Math.floor(x / CELL) * 65536 + Math.floor(z / CELL); (grid.get(ck) || grid.set(ck, []).get(ck)).push(id);
    }
  }
  function queryPts(x, z, r, out = []) {
    out.length = 0; const r2 = r * r;
    for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      const a = grid.get(cx * 65536 + cz); if (!a) continue;
      for (const id of a) { const dx = spawn.x[id] - x, dz = spawn.z[id] - z; if (dx * dx + dz * dz <= r2) out.push(id); }
    }
    return out;
  }
  return { paths, nLanes, nConns: conns.length, conns, occ: new Int16Array(conns.length), junctions: jInfo, spawn, queryPts, lanesOfRoad, side,
    stats: { lanes: nLanes, connectors: conns.length, gates: paths.reduce((a, p) => a + (p.gates ? p.gates.length : 0), 0), spawnPoints: spawn.x.length, laneMetres: Math.round(paths.slice(0, nLanes).reduce((a, p) => a + p.len, 0)) } };
}
