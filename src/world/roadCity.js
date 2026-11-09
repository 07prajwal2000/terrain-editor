// City road type: terrain corridor stamping, kerb + footpath geometry (one merged mesh, static trimesh colliders per ~6 m piece),
// corner pavement blocks at junctions and the crosswalk (zebra) plan. THREE / RAPIER are injected like everywhere in src/world.
//
// Footpath (per side of a city, non-bridge stretch): kerb stone band KERB_W + paving FOOT_W, top KERB_H above the road surface, kerb face
// on the road side, outer face on the other. Heights come from heightAt() (the terrain is stamped flat across the corridor first, see
// stampCityCorridors), so the footpath follows the road profile and the render mesh / heightAt / Rapier heightfield all agree.
// The footpath ENDS (a) at a junction patch anchor (full height, a corner block continues it when both neighbouring arms are city),
// (b) at a change of road type, a bridge or the road end (kerb ramps down to road level over CITY.TAPER m), and (c) is dropped to road
// level (flat pavement, no collider) around crosswalks / signal zebras (kerb ramp).
// ponytail: corner blocks only between two city arms of a junction/signals patch and only where the outer footpath lines meet inside the patch (corners sharper than ~60 degrees, depending on width, get end ramps instead and the two footpaths overlap there); roundabouts get footpath end ramps
// (no ring pavement); a footpath is not cut where an UNRELATED road merely passes within a few metres (no junction detected there).
import { polyOf } from './roads.js';
import { CITY, FOOT_SHIFT, ROAD_TYPES } from './roadMeta.js';
import { SIGN_CFG } from './roadSigns.js';

const LIFT = 0.03;      // = roads.js LIFT_ROAD: the road surface sits this far above the terrain
const FLUSH = 0.012;    // a dropped kerb is still this much above the road surface (no z-fight with the ribbon)
const STEP = 2;         // footpath station spacing in polyline samples (~2 m)
const PIECE = 6;        // collider piece length (m)
const SOLID = 0.35;     // collider prisms reach this far below the road surface
const OUT_DOWN = 0.1;   // outer face reaches this far below the terrain

// ------------------------------------------------------------------ terrain corridor stamping
// -> [{ road, hw, n, x[], z[], y[] }]: every maximal city, non-bridge stretch of every road with its smoothed height profile
// (original terrain heights sampled along the centreline, +-8 m box filter, 2 passes). Must be called while Hm == Hbase (polyOf caches y).
export function cityRuns(roads) {
  const runs = [];
  roads.forEach((road, ri) => {
    const P = polyOf(road), city = (i) => !P.b[i] && road.points[P.seg[i]].type === 'city';
    let a = -1;
    for (let i = 0; i <= P.n; i++) {
      if (i < P.n && city(i)) { if (a < 0) a = i; continue; }
      if (a >= 0 && i - 1 > a) {
        const n = i - a, y = Float64Array.from({ length: n }, (_, k) => P.y[a + k]);
        for (let pass = 0; pass < 2; pass++) { // moving average with a shrinking window at the ends
          const src = Float64Array.from(y), R = 8;
          for (let k = 0; k < n; k++) { const lo = Math.max(0, k - R), hi = Math.min(n - 1, k + R); let s = 0; for (let m = lo; m <= hi; m++) s += src[m]; y[k] = s / (hi - lo + 1); }
        }
        runs.push({ road: ri, hw: road.width / 2, n, x: P.x.slice(a, i), z: P.z.slice(a, i), y });
      }
      a = -1;
    }
  });
  return runs;
}

// Flatten the height grid Hm (metres, N x N) across carriageway + footpaths to the run's own profile, smooth blend CITY.BLEND m outside.
// Optional pixel rect {x0,y0,x1,y1} (x1/y1 exclusive) restricts the stamp (live editing, same contract as stampJunctions).
export function stampCityCorridors(Hm, N, cell, runs, rect) {
  for (const r of runs) {
    const flat = r.hw + FOOT_SHIFT + 1.5 * cell, rr = flat + CITY.BLEND; // 1.5 cells: bilinear heightAt at the footpath edge reads cells up to ~1.4 cell away
    let mx0 = Infinity, mx1 = -Infinity, mz0 = Infinity, mz1 = -Infinity;
    for (let i = 0; i < r.n; i++) { mx0 = Math.min(mx0, r.x[i]); mx1 = Math.max(mx1, r.x[i]); mz0 = Math.min(mz0, r.z[i]); mz1 = Math.max(mz1, r.z[i]); }
    const cr = (lo, hi, rect0, rect1) => [Math.max(rect0, Math.floor(lo / cell - 0.5)), Math.min(rect1, Math.ceil(hi / cell - 0.5))];
    const lim = rect ? [rect.x0, rect.x1 - 1, rect.y0, rect.y1 - 1] : [0, N - 1, 0, N - 1];
    const [i0, i1] = cr(mx0 - rr, mx1 + rr, lim[0], lim[1]), [k0, k1] = cr(mz0 - rr, mz1 + rr, lim[2], lim[3]);
    if (i1 < i0 || k1 < k0) continue;
    const best = new Map(); // cell -> [distance to the run, profile height of the nearest point]; sparse so a long diagonal run costs only its corridor
    for (let s = 0; s < r.n - 1; s++) {
      const ax = r.x[s], az = r.z[s], bx = r.x[s + 1] - ax, bz = r.z[s + 1] - az, l2 = bx * bx + bz * bz;
      const [a0, a1] = cr(Math.min(ax, ax + bx) - rr, Math.max(ax, ax + bx) + rr, i0, i1), [c0, c1] = cr(Math.min(az, az + bz) - rr, Math.max(az, az + bz) + rr, k0, k1);
      for (let k = c0; k <= c1; k++) for (let i = a0; i <= a1; i++) {
        const px = (i + 0.5) * cell, pz = (k + 0.5) * cell, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * bx + (pz - az) * bz) / l2)) : 0;
        const d = Math.hypot(ax + bx * t - px, az + bz * t - pz), o = k * N + i, e = best.get(o);
        if (!e) best.set(o, [d, r.y[s] + (r.y[s + 1] - r.y[s]) * t]); else if (d < e[0]) { e[0] = d; e[1] = r.y[s] + (r.y[s + 1] - r.y[s]) * t; }
      }
    }
    for (const [o, [d, y]] of best) {
      if (d >= rr) continue;
      const t = d <= flat ? 1 : 1 - (d - flat) / CITY.BLEND, g = t * t * (3 - 2 * t);
      Hm[o] += (y - Hm[o]) * g;
    }
  }
}

// ------------------------------------------------------------------ crosswalk (zebra) plan, any road type
// features = collectFeatures(...) (roadEdges.js); returns zebras [{x,z,tx,tz,hw,ty,road,s,kind}], pedestrian signs (roadSigns descriptors) and
// drops[roadIndex] = [[s0,s1]...] (arc ranges where a city footpath is dropped to road level).
export function crosswalkPlan({ roads, features, driveSide }) {
  const sd = driveSide === 'left' ? -1 : 1, zebras = [], signs = [], drops = roads.map(() => []);
  for (const f of features) {
    if (f.kind !== 'crosswalk') continue;
    const m = f.meta, city = m.type === 'city';
    zebras.push({ x: f.x, z: f.z, tx: f.tx, tz: f.tz, hw: f.hw, ty: ROAD_TYPES.indexOf(m.type), road: f.road, s: f.s, kind: 'feature' });
    if (city) drops[f.road].push([f.s - CITY.CROSS_HALF, f.s + CITY.CROSS_HALF]);
    for (const sl of [1, -1]) { // one sign per side, facing the traffic that uses that side (one-way: everything faces oncoming = against the point order)
      const d = m.oneway ? 1 : sl * sd, edge = sl > 0 ? m.edgeR : m.edgeL;
      const off = f.hw + (city ? CITY.KERB_W + 0.6 : edge !== 'none' ? SIGN_CFG.EDGE_OFFSET[edge] + SIGN_CFG.EDGE_CLEARANCE : SIGN_CFG.SHOULDER_OFFSET);
      signs.push({ kind: 'crosswalk', type: 'pedestrian', x: f.x - f.tz * sl * off, z: f.z + f.tx * sl * off, fx: d * f.tx, fz: d * f.tz, nx: -d * f.tx, nz: -d * f.tz, roadId: f.roadId, road: f.road, dir: d, side: sl });
    }
  }
  return { zebras, signs, drops };
}

// ------------------------------------------------------------------ paving / kerb shader (one material for every footpath piece)
function makeFootMaterial(THREE) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  mat.customProgramCacheKey = () => 'foot-v1';
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFp;\nvarying vec3 vFp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFp = aFp;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFp;
float cov(float x, float a, float b, float f) { return clamp(min(x + 0.5 * f, b) - max(x - 0.5 * f, a), 0.0, f) / f; }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// periodic joint line of width w (m) every 'per' m at coordinate x, box-filtered; fades to its average coverage when sub-pixel
float joint(float x, float per, float w, float f) {
  float xm = mod(x + 0.5 * w, per), c = cov(xm, 0.0, w, f) + cov(xm - per, 0.0, w, f);
  return mix(c, w / per, smoothstep(0.25 * per, 0.6 * per, f));
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float kind = vFp.z; vec2 p = vFp.xy;
  vec2 fw = max(fwidth(p), vec2(1e-4));
  vec3 col;
  if (kind > 0.5 && kind < 1.5) col = vec3(0.40, 0.39, 0.37) * (0.92 + 0.12 * h21(floor(vec2(p.x, 0.0) / 1.0)));          // kerb face
  else if (kind > 1.5 && kind < 2.5) col = vec3(0.27, 0.26, 0.25);                                                        // outer face
  else {
    float band = kind < 0.5 ? 1.0 - clamp((p.y - ${CITY.KERB_W.toFixed(3)}) / fw.y + 0.5, 0.0, 1.0) : 0.0;                // kerb stone band, crisp edge
    vec2 g = kind < 0.5 ? vec2(p.x, p.y - ${CITY.KERB_W.toFixed(3)}) : p;                                                  // slab grid: road aligned on strips, world aligned on corner blocks
    vec2 cell = floor(g / 0.6);
    vec3 slab = vec3(0.40, 0.39, 0.36) * (0.90 + 0.16 * h21(cell + 3.1));
    float jn = max(joint(g.x, 0.6, 0.016, fw.x), joint(g.y, 0.6, 0.016, fw.y));
    slab = mix(slab, vec3(0.20, 0.195, 0.185), jn);
    vec3 kerb = vec3(0.58, 0.57, 0.54);
    kerb = mix(kerb, vec3(0.22), joint(p.x, 1.0, 0.02, fw.x));                                                             // kerb stone joints every metre
    kerb = mix(kerb, vec3(0.2), cov(p.y, 0.135, ${CITY.KERB_W.toFixed(3)}, fw.y));                                         // clean dark seam between kerb and paving
    col = mix(slab, kerb, band);
  }
  diffuseColor.rgb = col;
}`);
  };
  return mat;
}

// ------------------------------------------------------------------ geometry builder
// ctx: { THREE, RAPIER, physicsWorld, roads, junctions, heightAt, geos, colliders, mats, drops }  (drops = per-road [[s0,s1]] extra dropped-kerb ranges)
// -> { group, pieces[], corners[], footprints[] (flat 2D polygons for surfaceAt), stats }
export function buildCity({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, geos, colliders, mats, drops }) {
  const polys = roads.map(polyOf), out = { group: new THREE.Group(), pieces: [], corners: [], footprints: [], stats: { drawCalls: 0, colliders: 0, triangles: 0 } };
  out.group.name = 'roadCity';
  const V = { pos: [], nor: [], fp: [], idx: [] };
  const ground = (x, z) => heightAt(x, z) + LIFT;

  // quad A-B (one edge), C-D (the opposite edge); A->C and B->D run along; corners are [x,y,z,u,v]; winding follows the normal n
  const vert = (c, n, kind) => { V.pos.push(c[0], c[1], c[2]); V.nor.push(n[0], n[1], n[2]); V.fp.push(c[3], c[4], kind); return V.pos.length / 3 - 1; };
  const tri = (a, b, c, n) => {
    const p = V.pos, ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2], wx = p[3 * c] - p[3 * a], wy = p[3 * c + 1] - p[3 * a + 1], wz = p[3 * c + 2] - p[3 * a + 2];
    const d = (uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2];
    d >= 0 ? V.idx.push(a, b, c) : V.idx.push(a, c, b);
  };
  const quad = (n, kind, A, B, C, D) => { const a = vert(A, n, kind), b = vert(B, n, kind), c = vert(C, n, kind), d = vert(D, n, kind); tri(a, b, c, n); tri(b, d, c, n); };

  // ---- trimesh helpers (Rapier): closed prisms
  const addTrimesh = (verts, ind, friction = 0.9) => {
    if (!physicsWorld) return;
    colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(ind)).setFriction(friction))); out.stats.colliders++;
  };

  // ---- footpath runs per road side
  // 1. which samples are cut by junction footprints (strictly between a patch arm's centre sample and its anchor; roundabouts: inside the extent)
  const anchorOpen = polys.map(() => new Map()); // road -> anchor sample -> { [side]: true } when a corner block continues the footpath there (side = road lateral sign)
  const blocks = []; // corner block jobs, filled below
  const cut = polys.map((P) => new Uint8Array(P.n));
  for (const j of junctions) {
    if (j.style === 'roundabout') {
      roads.forEach((_, ri) => { const P = polys[ri]; for (let i = 0; i < P.n; i++) if (Math.hypot(P.x[i] - j.x, P.z[i] - j.z) < j._extent) cut[ri][i] = 1; });
      continue;
    }
    for (const a of j._anch || []) {
      const P = polys[a.road], c = cut[a.road];
      if (a.end) { if (a.dir > 0) for (let i = 0; i < a.ai; i++) c[i] = 1; else for (let i = a.ai + 1; i < P.n; i++) c[i] = 1; }
      for (let i = Math.min(a.idx, a.ai); i <= Math.max(a.idx, a.ai); i++) if (i !== a.ai) c[i] = 1;
    }
    // corner blocks between neighbouring CITY arms
    (j._corners || []).forEach((cn, ci) => {
      const A = cn.A, N = cn.Nx; if (A.type !== 'city' || N.type !== 'city') return;
      const blk = cornerBlockPlan(cn); if (!blk) return;
      blocks.push({ j, ci, blk });
      // road lateral side (+1 = (-tz,tx)) that the block continues: arm.plus <-> +1 for dir>0, -1 for dir<0; next arm's minus side is the opposite
      (anchorOpen[A.road].get(A.ai) || anchorOpen[A.road].set(A.ai, {}).get(A.ai))[A.dir > 0 ? 1 : -1] = true;
      (anchorOpen[N.road].get(N.ai) || anchorOpen[N.road].set(N.ai, {}).get(N.ai))[N.dir > 0 ? -1 : 1] = true;
    });
  }

  // 2. runs
  const jobs = [];
  roads.forEach((road, ri) => {
    const P = polys[ri], hw = road.width / 2;
    const ok = (i) => !P.b[i] && road.points[P.seg[i]].type === 'city' && !cut[ri][i];
    for (const side of [1, -1]) {
      let a = -1;
      for (let i = 0; i <= P.n; i++) {
        if (i < P.n && ok(i)) { if (a < 0) a = i; continue; }
        if (a >= 0 && i - 1 > a) {
          const b = i - 1, open = anchorOpen[ri];
          jobs.push({ ri, side, hw, a, b,
            fullA: a > 0 && cut[ri][a - 1] && !!(open.get(a) && open.get(a)[side]), fullB: b < P.n - 1 && cut[ri][b + 1] && !!(open.get(b) && open.get(b)[side]) });
        }
        a = -1;
      }
    }
  });

  for (const job of jobs) {
    const { ri, side, hw, a, b } = job, P = polys[ri], L0 = hw, L1 = hw + CITY.KERB_W, L2 = hw + FOOT_SHIFT;
    const pos = (i, l) => [P.x[i] - P.tz[i] * side * l, P.z[i] + P.tx[i] * side * l];
    const ids = []; for (let i = a; i < b; i += STEP) ids.push(i); ids.push(b);
    if (P.s[b] - P.s[a] < 1.5) continue;
    // kerb height factor along s: 0 inside drop ranges and at tapered ends, ramping to 1 over CITY.TAPER
    const ramps = (drops[ri] || []).map((r) => r.slice());
    if (!job.fullA) ramps.push([P.s[a], P.s[a]]); if (!job.fullB) ramps.push([P.s[b], P.s[b]]);
    const hk = (s) => { let f = 1; for (const [s0, s1] of ramps) f = Math.min(f, Math.max(0, Math.max(s0 - s, s - s1)) / CITY.TAPER); return CITY.KERB_H * Math.min(1, f); };
    const st = ids.map((i) => {
      const s = P.s[i], h = hk(s), p0 = pos(i, L0), p1 = pos(i, L1), p2 = pos(i, L2), dl = [-P.tz[i] * side, P.tx[i] * side];
      const top = (p) => ground(p[0], p[1]) + Math.max(h, FLUSH);
      return { i, s, h, p0, p1, p2, base0: ground(p0[0], p0[1]), base2: ground(p2[0], p2[1]), t0: top(p0), t1: top(p1), t2: top(p2), dl, ter2: heightAt(p2[0], p2[1]) };
    });
    // visual
    for (let k = 0; k + 1 < st.length; k++) {
      const A = st[k], B = st[k + 1];
      quad([0, 1, 0], 0, [A.p0[0], A.t0, A.p0[1], A.s, 0], [A.p1[0], A.t1, A.p1[1], A.s, CITY.KERB_W], [B.p0[0], B.t0, B.p0[1], B.s, 0], [B.p1[0], B.t1, B.p1[1], B.s, CITY.KERB_W]);
      quad([0, 1, 0], 0, [A.p1[0], A.t1, A.p1[1], A.s, CITY.KERB_W], [A.p2[0], A.t2, A.p2[1], A.s, FOOT_SHIFT], [B.p1[0], B.t1, B.p1[1], B.s, CITY.KERB_W], [B.p2[0], B.t2, B.p2[1], B.s, FOOT_SHIFT]);
      quad([-A.dl[0], 0, -A.dl[1]], 1, [A.p0[0], A.base0, A.p0[1], A.s, 0], [A.p0[0], A.t0, A.p0[1], A.s, 0], [B.p0[0], B.base0, B.p0[1], B.s, 0], [B.p0[0], B.t0, B.p0[1], B.s, 0]);
      quad([A.dl[0], 0, A.dl[1]], 2, [A.p2[0], A.t2, A.p2[1], A.s, 0], [A.p2[0], A.ter2 - OUT_DOWN, A.p2[1], A.s, 0], [B.p2[0], B.t2, B.p2[1], B.s, 0], [B.p2[0], B.ter2 - OUT_DOWN, B.p2[1], B.s, 0]);
      out.footprints.push([A.p0[0], A.p0[1], A.p2[0], A.p2[1], B.p2[0], B.p2[1], B.p0[0], B.p0[1]]);
    }
    // colliders: closed prism per ~PIECE m, only over stretches where the kerb stands above the road (flush pavement at a crossing: nothing to collide with)
    let k0 = 0;
    while (k0 + 1 < st.length) {
      let k1 = k0 + 1; while (k1 + 1 < st.length && st[k1].s - st[k0].s < PIECE) k1++;
      const seg = st.slice(k0, k1 + 1), hmax = Math.max(...seg.map((q) => q.h)), solid = [];
      for (let k = 0; k + 1 < seg.length; k++) solid.push(Math.max(seg[k].h, seg[k + 1].h) > 0.03);
      for (let k = 0; k < solid.length; k++) {
        if (!solid[k]) continue;
        let e = k; while (e + 1 < solid.length && solid[e + 1]) e++;
        const sub = seg.slice(k, e + 2), n = sub.length, verts = [], ind = [];
        for (const q of sub) verts.push(q.p0[0], q.t0, q.p0[1], q.p2[0], q.t2, q.p2[1], q.p2[0], q.base2 - SOLID, q.p2[1], q.p0[0], q.base0 - SOLID, q.p0[1]); // iT oT oB iB
        for (let m = 0; m + 1 < n; m++) {
          const c = 4 * m, d = c + 4;
          for (let f = 0; f < 4; f++) { const f2 = (f + 1) % 4; ind.push(c + f, c + f2, d + f, c + f2, d + f2, d + f); }
        }
        ind.push(0, 1, 2, 0, 2, 3, 4 * (n - 1), 4 * (n - 1) + 2, 4 * (n - 1) + 1, 4 * (n - 1), 4 * (n - 1) + 3, 4 * (n - 1) + 2);
        addTrimesh(verts, ind); k = e;
      }
      out.pieces.push({ road: ri, side, ax: seg[0].p0[0], az: seg[0].p0[1], bx: seg[seg.length - 1].p0[0], bz: seg[seg.length - 1].p0[1], ox: seg[0].p2[0], oz: seg[0].p2[1], hmax, len: seg[seg.length - 1].s - seg[0].s, collider: solid.some(Boolean) });
      k0 = k1;
    }
  }

  // ---- corner blocks
  for (const { j, ci, blk } of blocks) {
    const { inner, offs, polyOuter, normals } = blk, m = inner.length;
    const Y = (p) => ground(p[0], p[1]) + CITY.KERB_H, arc = [0];
    for (let i = 1; i < m; i++) arc.push(arc[i - 1] + Math.hypot(inner[i][0] - inner[i - 1][0], inner[i][1] - inner[i - 1][1]));
    for (let i = 0; i + 1 < m; i++) { // kerb band (top), kerb face
      const a = inner[i], b = inner[i + 1], oa = offs[i], ob = offs[i + 1];
      quad([0, 1, 0], 0, [a[0], Y(a), a[1], arc[i], 0], [oa[0], Y(oa), oa[1], arc[i], CITY.KERB_W], [b[0], Y(b), b[1], arc[i + 1], 0], [ob[0], Y(ob), ob[1], arc[i + 1], CITY.KERB_W]);
      quad([-normals[i][0], 0, -normals[i][1]], 1, [a[0], ground(a[0], a[1]), a[1], arc[i], 0], [a[0], Y(a), a[1], arc[i], 0], [b[0], ground(b[0], b[1]), b[1], arc[i + 1], 0], [b[0], Y(b), b[1], arc[i + 1], 0]);
    }
    // paving: earcut on [offset kerb line ..., Nout, Xo, Aout]
    const R = offs.concat(blk.outerPts), tris = THREE.ShapeUtils.triangulateShape(R.map((p) => new THREE.Vector2(p[0], p[1])), []);
    const base = V.pos.length / 3;
    for (const p of R) vert([p[0], Y(p), p[1], p[0], p[1]], [0, 1, 0], 3);
    for (const [a, b, c] of tris) tri(base + a, base + b, base + c, [0, 1, 0]);
    // outer walls along the outer boundary (Nout -> Xo -> Aout)
    const o = blk.outerPts; // [Nout, (Xo), Aout]
    for (let i = 0; i + 1 < o.length; i++) {
      const a = o[i], b = o[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      let n = [dz / l, -dx / l]; const cx = (a[0] + b[0]) / 2 - blk.centroid[0], cz = (a[1] + b[1]) / 2 - blk.centroid[1]; if (n[0] * cx + n[1] * cz < 0) n = [-n[0], -n[1]];
      quad([n[0], 0, n[1]], 2, [a[0], Y(a), a[1], 0, 0], [a[0], heightAt(a[0], a[1]) - OUT_DOWN, a[1], 0, 0], [b[0], Y(b), b[1], 0, 0], [b[0], heightAt(b[0], b[1]) - OUT_DOWN, b[1], 0, 0]);
    }
    out.footprints.push(blk.poly.flat());
    out.corners.push({ junction: junctions.indexOf(j), corner: ci, poly: blk.poly.flat(), roads: [blk.roadA, blk.roadB] });
    // collider: closed prism over the whole corner polygon (kerb line + outer boundary), top follows the kerb height, flat walls
    const poly = blk.poly, tr = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []), n = poly.length, verts = [], ind = [];
    for (const p of poly) verts.push(p[0], Y(p), p[1]);
    for (const p of poly) verts.push(p[0], ground(p[0], p[1]) - SOLID, p[1]);
    for (const [a, b, c] of tr) ind.push(a, b, c, n + a, n + c, n + b);
    for (let e = 0; e < n; e++) { const e2 = (e + 1) % n; ind.push(e, e2, n + e, e2, n + e2, n + e); }
    addTrimesh(verts, ind);
  }

  // ---- merged visual mesh: one draw call for every footpath, kerb and corner block
  if (V.pos.length) {
    const g = new THREE.BufferGeometry(), I = V.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    g.setAttribute('position', new THREE.Float32BufferAttribute(V.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(V.nor, 3));
    g.setAttribute('aFp', new THREE.Float32BufferAttribute(V.fp, 3)); g.setIndex(new THREE.BufferAttribute(new I(V.idx), 1));
    g.computeBoundingSphere(); geos.push(g);
    const mat = makeFootMaterial(THREE); mats.push(mat);
    const mesh = new THREE.Mesh(g, mat); mesh.name = 'footpaths'; mesh.matrixAutoUpdate = false; out.group.add(mesh);
    out.stats.drawCalls = 1; out.stats.triangles = V.idx.length / 3;
  }
  return out;
}

// ------------------------------------------------------------------ corner block outline between two neighbouring junction arms
// cn = { A, Nx, gap, fil } as built in roads.js (arm records with px,pz,dx,dz,hw; fil = fillet { X, S1, S2 } or null). The block is the region
// OUTSIDE the carriageway corner: kerb line (anchor edge point of A -> fillet -> anchor edge point of Nx) out to the footpath outer lines.
// -> { inner[] kerb polyline, offs[] it pushed out by KERB_W, outerPts [Nout, (Xo), Aout], poly (collider / footprint outline), centroid, roadA, roadB } or null
function cornerBlockPlan(cn) {
  const { A, Nx, fil } = cn, W = FOOT_SHIFT, K = CITY.KERB_W;
  const pA = [-A.dz, A.dx], pN = [-Nx.dz, Nx.dx];
  const Ain = [A.px + pA[0] * A.hw, A.pz + pA[1] * A.hw], Nin = [Nx.px - pN[0] * Nx.hw, Nx.pz - pN[1] * Nx.hw];
  const Aout = [Ain[0] + pA[0] * W, Ain[1] + pA[1] * W], Nout = [Nin[0] - pN[0] * W, Nin[1] - pN[1] * W];
  let inner, outerPts, nA = pA, nN = [-pN[0], -pN[1]];
  if (fil) {
    if (cn.gap < 0.7) return null; // corner sharper than ~40 degrees: the outer miter would run away (the t,u test below drops the ~40-60 degree ones too)
    const det = A.dx * Nx.dz - A.dz * Nx.dx, D = [Nout[0] - Aout[0], Nout[1] - Aout[1]];
    const t = (D[0] * Nx.dz - D[1] * Nx.dx) / det, u = (D[0] * A.dz - D[1] * A.dx) / det;
    if (!(t < -0.2 && u < -0.2)) return null;
    const Xo = [Aout[0] + t * A.dx, Aout[1] + t * A.dz];
    if (Math.hypot(Xo[0] - fil.X[0], Xo[1] - fil.X[1]) > 4 * W) return null;
    inner = [Ain, ...fil.curve, Nin]; outerPts = [Nout, Xo, Aout];
  } else {
    if (cn.gap > 3.45) return null;
    inner = [Ain, Nin]; outerPts = [Nout, Aout];
  }
  const m = inner.length, normals = [], offs = [];
  const cx = (inner[0][0] + inner[m - 1][0] + outerPts.reduce((s, p) => s + p[0], 0)) / (2 + outerPts.length), cz = (inner[0][1] + inner[m - 1][1] + outerPts.reduce((s, p) => s + p[1], 0)) / (2 + outerPts.length);
  const tgt = outerPts.length === 3 ? outerPts[1] : [cx, cz];
  for (let i = 0; i < m; i++) { // normal pointing from the road into the block
    let n;
    if (i === 0) n = nA; else if (i === m - 1) n = nN;
    else {
      const a = inner[i - 1], b = inner[i + 1], tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1; n = [-tz / l, tx / l];
      if (n[0] * (tgt[0] - inner[i][0]) + n[1] * (tgt[1] - inner[i][1]) < 0) n = [-n[0], -n[1]];
    }
    normals.push(n); offs.push([inner[i][0] + n[0] * K, inner[i][1] + n[1] * K]);
  }
  const segN = []; for (let i = 0; i + 1 < m; i++) segN.push([(normals[i][0] + normals[i + 1][0]) / 2, (normals[i][1] + normals[i + 1][1]) / 2]);
  const poly = inner.concat(outerPts);
  return { inner, offs, outerPts, normals: segN, poly, centroid: [cx, cz], roadA: A.roadId, roadB: Nx.roadId };
}
