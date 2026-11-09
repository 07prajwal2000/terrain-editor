// Deterministic lot / building placement for the city fill (renderer: cityFill.js, colliders: cityColliders.js).
// PURE: no THREE, no DOM, no Rapier, so it runs in Node (scripts/test-city-fill.mjs). Same map + seed + config = same buildings, whatever order the
// chunks are asked for (every decision is a hash of the integer lot key, or a memoised function of static geometry, never of request order).
//
//   const gen = createCityGen({ map, config?, override?, extraCircles? });
//   gen.chunk(cx, cz) -> { cx, cz, buildings: [...], props: { bollard: [...], planter: [...] } }     (128 m chunks, a lot belongs to the chunk of its centre; cached)
//   gen.blocked(x, z, margin) -> true when (x,z) is within `margin` m of a building footprint (the nature scatter's `extraBlocked` hook)
//   building = { id, road, side, row, asset (0..2), x, y, z (pivot: front of the facade, ground floor), yaw, sc, cx, cz, hu, hv, ux, uz (footprint box: centre, half extents along
//                the street (u) / away from it (v), padded), col: { cx, cz, hu, hv, y0, y1 } (collider box = brick body), plinth: { h, y0 } | null, w (paint weight used), tall }
//   prop = { x, y, z, yaw, sc }
//
// HOW LOTS ARE LAID OUT. Every maximal CITY, non-bridge stretch of every road is walked on both sides ("rows" 0..rows-1 at growing distance from the road). Along a row the lots are a
// fixed sequence (a function of seed + road + side + row only, NOT of paint or exclusions): a size class (0 small / 1 medium / 2 large building) from a hash, the slot is that class's
// reserved footprint + a random side gap. Row 0 stands setback m behind the footpath (kerb 0.15 + paving 2.5, see roadMeta.js CITY), facade toward the road. A lot's STATIC test
// (inside the map, no junction, no road ribbon of ANY road + margin [bridge decks and approaches get a bigger margin], no marker clearance / lot_empty zone / exclusion circle, no water + shore
// ring, terrain height range <= maxHeightRange) uses the reserved footprint, so it never depends on paint. Overlaps (curved roads fan their lots, crossing roads) are removed greedily by a hash
// priority (row 0 beats rows behind it) over the statically valid lots, again independent of paint and of request order. Only then the PAINT gates the lot:
//     w = city class weight (bilinear, map.surfaceAt) at the lot centre;  row 0: w = max(w, defaultWeight)  (a plain city road with no paint still gets buildings, density
//     defaultWeight^gamma);  rows >= 1 need painted city (w >= rowMinWeight)  ->  filled iff  hash < w^gamma * density.
// so painting stronger only ADDS buildings (the old ones stay). ROADS: lots exist along CITY-type road stretches (default weight, footpath) AND along country roads wherever the paint
// weight is >= paint.minWeight (config / city.json paintMinWeight; paint.country / city.json paintedRoads:false turns it off); highways never. No road = no lots. ROWS: only the street row
// by default (rows = 1); rows > 1 (config) add rows behind it on painted city only.
// Most lots (1 - wholeShare) get a PROCEDURAL building (cityKit.js: width / depth fitted to the lot in 2 m modules, 3..8 floors, random style); wholeShare of them a whole GLB building (landmark,
// asset = lot class, so it fills its lot). Procedural floors = 3 + (floorW * weight + (1 - floorW) * hash) * 6, so heavier paint = taller (a lot_tall marker forces 8). Facade
// = local +Z of the GLB (pivot at the front centre of the facade, y = 0 ground floor), so yaw points +Z at the road; no mirroring, scale 0.9..1.1 uniform.
//
// city.json (optional per map, public/maps/<name>/city.json): { "seed": 1, "disabled": false, "density": 1.2, "defaultWeight": 0.6, "paintedRoads": true, "paintMinWeight": 0.5, "exclusions": [{x,z,r}], "forceTall": [{x,z,r}] }
// marker tags: lot_empty (no lot within marker radius, default tagRadius), lot_tall (tier 2 within marker radius).
import { polyOf, KERB } from './roads.js';
import { CITY, FOOT_SHIFT, HIGHWAY } from './roadMeta.js';
import { hash } from './scatterGen.js';

// ================================================================================================
// CONFIG: every tunable lives here. Metres unless noted.
// ================================================================================================
export const CITY_CONFIG = {
  seed: 4242,
  chunk: 128,                           // generation / culling cell size
  weightGamma: 1.0,                     // filled iff hash < weight^gamma
  defaultWeight: 0.6,                   // paint weight assumed along a city road (row 0 only) when the painted city weight is lower
  density: 1,                           // global multiplier on the fill probability (city.json "density", quality scale)
  wholeShare: 0.12,                     // share of lots that get a whole GLB building (landmark); the rest are procedural (cityKit.js)
  classMix: [0.3, 0.4, 0.3],            // size class of a whole-building lot (small / medium / large)
  proc: { w: [10, 24], d: [10, 20], floors: [3, 8], floorW: 0.4, maxTris: 15000 },   // procedural lots: facade width / depth (rounded to 2 m), floors, how much of the floor count follows the paint weight
  paint: { country: true, minWeight: 0.5, setback: [4, 6] },   // lots along non-highway, non-city roads where the city paint weight is >= minWeight (setback from the road edge + kerb strip)
  // whole buildings of public/city/city.glb. body = bounds of the brick body (checked against city.json "body" by the test); facade = +Z at z = 0, pivot at the front.
  assets: [
    { name: 'Building_Small_1', body: { x0: -7.17, x1: 5.17, z0: -12.17, z1: 0.17, h: 17.01 } },
    { name: 'Building_Medium_2_001', body: { x0: -7.12, x1: 7.09, z0: -11.96, z1: 0.21, h: 25 } },
    { name: 'Building_Large_2', body: { x0: -9, x1: 11, z0: -16, z1: 0, h: 28 } },
  ],
  scale: [1.04, 1.1],                   // uniform scale of whole buildings (narrow range: the lot is sized for 1.1, so no big gaps)
  pad: 0.3,                             // footprint padding round the brick body (trim / cornice overhang)
  colPad: 0.15,                         // collider box padding round the brick body
  setback: [3.0, 5.0],                  // gap between the outer footpath edge and the facade plane (row 0). >= 3 keeps the entrance steps clear of the footpath
  sideGap: [0.5, 2.5],                  // gap between neighbouring reserved footprints along the street
  rows: 1, rowAlley: 3, rowMinWeight: 0.5,   // rows: 1 = street row only. More rows go behind it (only on painted city, `rowAlley` m between them)
  startPad: [3, 8],                     // first lot of a stretch starts this far (random) from the stretch start; stretches shorter than minRun get no lots
  minRun: 20,
  roadMargin: 1.5,                      // clearance to a road ribbon (half width + kerb + footpath / shoulder) + this
  bridgeMargin: 14,                     // extra clearance round bridge decks and their approaches
  junctionMargin: 10,                   // beyond the junction patch / roundabout radius (corner pavements, signal posts)
  markerClear: 8, tagRadius: 25,        // clearance beyond a marker's radius; default radius of lot_empty / lot_tall zones (marker radius 0)
  shore: 6,                             // dry land kept round water
  maxHeightRange: 3.5,                  // terrain height range over the reserved footprint
  edgeMargin: 8,                        // distance to the map border
  embed: 0.1, plinthPad: 0.08, plinthTop: 0.3, plinthSink: 0.3,   // building sits (highest front ground - embed); plinth box from lowest ground - sink up to +plinthTop
  props: {
    bollard: { chance: 0.55, n: [2, 3], spacing: 2.4, lateral: KERB + 0, zebra: 6, lamp: 1.5, junction: 3 },   // bollards on the paving next to the kerb in front of a building
    planter: { chance: 0.3, lateral: 1.3 },                                                                    // planter in the setback strip beside the entrance
  },
  quality: { low: { density: 0.6, dist: 0.65 }, medium: { density: 1, dist: 0.85 }, high: { density: 1, dist: 1 } },
  // draw distances (m, camera xz): detailed building < d[0] (whole GLB instanced / procedural pieces merged per building, at most maxLive of the latter), cheap brick proxy beyond, culled beyond cull
  lod: { d: [120], cull: 650, props: 170, maxLive: 30 },
  // physics (cityColliders.js)
  colliders: { radius: 140, max: 40, maxBollards: 48, bollardRadius: 0.16, bollardHeight: 0.89, bollardRange: 45 },
};
export const CLASS_NAMES = ['small', 'medium', 'large'];

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const deepMerge = (a, b) => {
  if (!b || typeof b !== 'object') return a;
  const o = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b)) o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : b[k];
  return o;
};

// ================================================================================================
// 2D oriented-box helpers. box = { cx, cz, ux, uz, hu, hv }: u = (ux,uz) unit axis, v = (-uz, ux), half extents hu / hv.
// ================================================================================================
export const boxAABB = (b) => { const ex = Math.abs(b.ux) * b.hu + Math.abs(b.uz) * b.hv, ez = Math.abs(b.uz) * b.hu + Math.abs(b.ux) * b.hv; return [b.cx - ex, b.cz - ez, b.cx + ex, b.cz + ez]; };
export function pointBoxDist(b, x, z) { // 0 inside
  const dx = x - b.cx, dz = z - b.cz, pu = Math.abs(dx * b.ux + dz * b.uz) - b.hu, pv = Math.abs(-dx * b.uz + dz * b.ux) - b.hv;
  return Math.hypot(Math.max(pu, 0), Math.max(pv, 0));
}
export function boxesOverlap(a, b, margin = 0) { // SAT
  for (const A of [a, b]) for (const [ax, az] of [[A.ux, A.uz], [-A.uz, A.ux]]) {
    const pr = (B) => { const c = (B.cx) * ax + (B.cz) * az, r = B.hu * Math.abs(B.ux * ax + B.uz * az) + B.hv * Math.abs(-B.uz * ax + B.ux * az); return [c - r, c + r]; };
    const p = pr(a), q = pr(b);
    if (p[1] + margin <= q[0] || q[1] + margin <= p[0]) return false;
  }
  return true;
}
// distance between segment (ax,az)-(bx,bz) and the box (0 when they touch)
export function segBoxDist(b, ax, az, bx, bz) {
  const toL = (x, z) => [(x - b.cx) * b.ux + (z - b.cz) * b.uz, -(x - b.cx) * b.uz + (z - b.cz) * b.ux];
  const [pu, pv] = toL(ax, az), [qu, qv] = toL(bx, bz), du = qu - pu, dv = qv - pv;
  let t0 = 0, t1 = 1; // Liang-Barsky clip against [-hu,hu] x [-hv,hv]
  for (const [p, q] of [[-du, pu + b.hu], [du, b.hu - pu], [-dv, pv + b.hv], [dv, b.hv - pv]]) {
    if (p === 0) { if (q < 0) { t0 = 2; break; } } else { const r = q / p; if (p < 0) { if (r > t1) { t0 = 2; break; } if (r > t0) t0 = r; } else { if (r < t0) { t0 = 2; break; } if (r < t1) t1 = r; } }
  }
  if (t0 <= t1) return 0;
  const pb = (u, v) => Math.hypot(Math.max(Math.abs(u) - b.hu, 0), Math.max(Math.abs(v) - b.hv, 0));
  let best = Math.min(pb(pu, pv), pb(qu, qv));
  const l2 = du * du + dv * dv;
  for (const [cu, cv] of [[-b.hu, -b.hv], [b.hu, -b.hv], [b.hu, b.hv], [-b.hu, b.hv]]) {
    const t = l2 ? Math.max(0, Math.min(1, ((cu - pu) * du + (cv - pv) * dv) / l2)) : 0;
    best = Math.min(best, Math.hypot(pu + du * t - cu, pv + dv * t - cv));
  }
  return best;
}

// clearance of a road ribbon (half width + shoulder / kerb / footpath) as used for the road exclusion; shared with the test
export function roadClearance(road, segIndex, P, cfg = CITY_CONFIG) {
  const t = road.points[P.seg[segIndex]] && road.points[P.seg[segIndex]].type, hw = road.width / 2;
  return hw + KERB + (t === 'city' ? FOOT_SHIFT : t === 'highway' ? HIGHWAY.SHOULDER_W : 0) + cfg.roadMargin + ((P.b[segIndex] || P.b[segIndex + 1]) ? cfg.bridgeMargin : 0);
}

// ================================================================================================
export function createCityGen({ map, config, override = null, extraCircles = [] }) {
  const cfg = config ? deepMerge(CITY_CONFIG, config) : CITY_CONFIG;
  const ov = override || {};
  const seed = (Number.isFinite(ov.seed) ? ov.seed : cfg.seed) | 0;
  const disabled = !!ov.disabled;
  const density = cfg.density * (Number.isFinite(ov.density) ? ov.density : 1);
  const defaultWeight = Number.isFinite(ov.defaultWeight) ? ov.defaultWeight : cfg.defaultWeight;
  const paintOn = cfg.paint.country && ov.paintedRoads !== false, paintMin = Number.isFinite(ov.paintMinWeight) ? ov.paintMinWeight : cfg.paint.minWeight;
  const gamma = cfg.weightGamma, W = map.info.worldSize, CS = cfg.chunk, heightAt = map.heightAt;
  const SAFE = (ps) => ps.filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z) && c.r > 0);
  const circles = SAFE([...(ov.exclusions || []), ...extraCircles]);
  const forceTall = SAFE(ov.forceTall || []);
  const stats = { chunks: 0, ms: 0, maxMs: 0, cands: 0, valid: 0, accepted: 0, rej: { bounds: 0, junction: 0, road: 0, marker: 0, circle: 0, water: 0, slope: 0, overlap: 0 } };

  // ---- size classes: reserved footprint per class (max over the assets that can stand in it, at the largest scale) ----
  const scMax = cfg.scale[1], pad = cfg.pad;
  const assets = cfg.assets.map((a) => ({ ...a, hw: (a.body.x1 - a.body.x0) / 2, cxb: (a.body.x0 + a.body.x1) / 2, zc: (a.body.z0 + a.body.z1) / 2, hz: (a.body.z1 - a.body.z0) / 2 }));
  const classes = assets.map((_, k) => {
    let hw = 0, front = 0, back = 0;
    for (let j = 0; j <= k; j++) { hw = Math.max(hw, assets[j].hw); front = Math.max(front, assets[j].body.z1); back = Math.max(back, -assets[j].body.z0); }
    const f = front * scMax + pad, b = back * scMax + pad;
    return { hu: hw * scMax + pad, front: f, back: b, depth: f + b };
  });
  const rowPitch = classes[classes.length - 1].depth + cfg.rowAlley;
  const PROC_FRONT = 0.25;              // procedural body front: columns stand 0.2 m proud of the facade plane

  // ---- road / junction / marker data ----
  const roads = map.roads || [];
  const polys = roads.map(polyOf);
  const C = 32, key2 = (a, b) => a * 73856 + b;
  const segGrid = new Map();
  roads.forEach((road, ri) => {
    const P = polys[ri];
    for (let i = 0; i < P.n - 1; i++) {
      const clear = roadClearance(road, i, P, cfg), seg = [P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], clear];
      const x0 = Math.floor((Math.min(seg[0], seg[2]) - clear) / C), x1 = Math.floor((Math.max(seg[0], seg[2]) + clear) / C);
      const z0 = Math.floor((Math.min(seg[1], seg[3]) - clear) / C), z1 = Math.floor((Math.max(seg[1], seg[3]) + clear) / C);
      for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) { const k = key2(a, b); (segGrid.get(k) || segGrid.set(k, []).get(k)).push(seg); }
    }
  });
  const junctions = (map.junctions || []).filter((j) => j.style !== 'none');
  const markers = (map.markers || []).map((m) => ({ x: m.x, z: m.z, r: Math.max(0, m.radius || 0), tags: m.tags || [] }));
  const emptyZones = markers.filter((m) => m.tags.includes('lot_empty')).map((m) => ({ x: m.x, z: m.z, r: m.r > 0 ? m.r : cfg.tagRadius }));
  const tallZones = markers.filter((m) => m.tags.includes('lot_tall')).map((m) => ({ x: m.x, z: m.z, r: m.r > 0 ? m.r : cfg.tagRadius })).concat(forceTall);
  const detail = map.roadDetail || {};
  const zebras = (detail.zebras || []).map((z) => [z.x, z.z]), lamps = (detail.lamps || []).map((l) => [l.x, l.z]);

  // ---- terrain helpers ----
  const SHORE = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos(k * TAU / 8), Math.sin(k * TAU / 8)]);
  const dry = (x, z, shore) => {
    if (map.waterLevelAt(x, z) !== null) return false;
    for (const [dx, dz] of SHORE) if (map.waterLevelAt(x + dx * shore, z + dz * shore) !== null || map.waterLevelAt(x + dx * shore * 0.5, z + dz * shore * 0.5) !== null) return false;
    return true;
  };
  // sample points over a box: grid with <= `step` m spacing incl. the border -> [[x, z, edgeFront]]
  const boxPoints = (b, step) => {
    const nu = Math.max(1, Math.ceil(2 * b.hu / step)), nv = Math.max(1, Math.ceil(2 * b.hv / step)), vx = -b.uz, vz = b.ux, pts = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = -b.hu + 2 * b.hu * i / nu, v = -b.hv + 2 * b.hv * j / nv;
      pts.push([b.cx + b.ux * u + vx * v, b.cz + b.uz * u + vz * v, j]);
    }
    return pts;
  };

  // ---- road sampling ----
  function sampleAt(P, s) { // -> [x, z, tx, tz] at arc length s
    let lo = 0, hi = P.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.s[m] <= s) lo = m; else hi = m; }
    const l = P.s[hi] - P.s[lo], t = l > 0 ? Math.min(1, Math.max(0, (s - P.s[lo]) / l)) : 0;
    let tx = P.tx[lo] + (P.tx[hi] - P.tx[lo]) * t, tz = P.tz[lo] + (P.tz[hi] - P.tz[lo]) * t; const tl = Math.hypot(tx, tz) || 1;
    return [P.x[lo] + (P.x[hi] - P.x[lo]) * t, P.z[lo] + (P.z[hi] - P.z[lo]) * t, tx / tl, tz / tl];
  }

  // ================================================================================================
  // candidate lots (geometry only, cheap): every city stretch, both sides, rows 0..rows-1
  // ================================================================================================
  const cands = [], byChunk = new Map(), cgrid = new Map();
  const cgAdd = (c) => { const a = c.aabb; for (let i = Math.floor(a[0] / C); i <= Math.floor(a[2] / C); i++) for (let j = Math.floor(a[1] / C); j <= Math.floor(a[3] / C); j++) { const k = key2(i, j); (cgrid.get(k) || cgrid.set(k, []).get(k)).push(c); } };
  const sRange = cfg.sideGap, sbRange = cfg.setback;
  function buildCandidates() {
    roads.forEach((road, ri) => {
      const P = polys[ri]; if (P.n < 3) return;
      // mode of a segment: 1 = city road, 2 = other non-highway road (lots only where painted), 0 = none (bridge, highway)
      const modeOf = (i) => { if (P.b[i]) return 0; const t = road.points[P.seg[i]] && road.points[P.seg[i]].type; return t === 'city' ? 1 : (t === 'country' && paintOn) ? 2 : 0; }, hw = road.width / 2;
      let runIdx = 0;
      for (let i = 0, a = -1, m = 0; i <= P.n; i++) {
        const mi = i < P.n - 1 ? modeOf(i) : 0;
        if (a >= 0 && mi === m) continue;
        if (a >= 0) {
          const s0 = P.s[a], s1 = P.s[Math.min(i, P.n - 1)], run = runIdx++;
          if (s1 - s0 >= cfg.minRun) walkRun(ri, P, hw, run, s0, s1, m);
        }
        a = mi ? i : -1; m = mi;
      }
    });
    for (const c of cands) {
      const cx = Math.floor(c.box.cx / CS), cz = Math.floor(c.box.cz / CS), k = cx * 100003 + cz;
      (byChunk.get(k) || byChunk.set(k, { cx, cz, list: [] }).get(k)).list.push(c);
    }
    stats.cands = cands.length;
  }
  function walkRun(ri, P, hw, run, sStart, sEnd, mode) {
    for (let si = 0; si < 2; si++) {
      const side = si ? -1 : 1;
      for (let row = 0; row < cfg.rows; row++) {
        const rkey = ((ri * 64 + (run & 63)) * 2 + si) * 8 + row;
        let s = sStart + lerp(cfg.startPad[0], cfg.startPad[1], hash(seed, rkey, 0, 11));
        for (let k = 0; ; k++) {
          const whole = hash(seed, rkey, k, 1) < cfg.wholeShare, u6 = hash(seed, rkey, k, 6);
          const cls = !whole ? -1 : u6 < cfg.classMix[0] ? 0 : u6 < cfg.classMix[0] + cfg.classMix[1] ? 1 : 2;
          let K, PW = 0, PD = 0;
          if (whole) K = classes[cls];
          else { // procedural lot: even-metre width / depth, reserved = body + pad
            PW = 2 * Math.round(lerp(cfg.proc.w[0], cfg.proc.w[1], hash(seed, rkey, k, 12)) / 2); PD = 2 * Math.round(lerp(cfg.proc.d[0], cfg.proc.d[1], hash(seed, rkey, k, 13)) / 2);
            const f = PROC_FRONT + pad, b = PD + pad; K = { hu: PW / 2 + pad, front: f, back: b, depth: f + b };
          }
          const w = 2 * K.hu, gap = lerp(sRange[0], sRange[1], hash(seed, rkey, k, 2));
          if (s + w > sEnd - cfg.startPad[0]) break;
          const sm = s + w / 2; s += w + gap;
          const [x, z, tx, tz] = sampleAt(P, sm), nx = side * -tz, nz = side * tx;      // n = outward lateral (away from the road)
          const sbr = mode === 2 ? cfg.paint.setback : sbRange, setb = lerp(sbr[0], sbr[1], hash(seed, rkey, k, 3)) + (row ? hash(seed, rkey, k, 4) * 2 : 0);
          const L0 = hw + (mode === 2 ? KERB : FOOT_SHIFT) + setb + row * rowPitch;                            // lateral position of the facade plane
          const Lc = L0 - K.front + K.depth / 2;                                         // lateral centre of the reserved box
          const box = { cx: x + nx * Lc, cz: z + nz * Lc, ux: tx, uz: tz, hu: K.hu, hv: K.depth / 2 };
          // box axes: u = tangent, v = (-uz, ux) = side * n; the half extent along v is symmetric, so the sign of v does not matter here
          if (mode === 2 && map.surfaceAt(box.cx, box.cz).weights[7] < (row ? cfg.rowMinWeight : paintMin)) continue;   // painted roads: cheap paint prefilter, only real candidates exist
          const c = { id: rkey * 4096 + k, rkey, k, mode, kind: whole ? 'whole' : 'proc', PW, PD, hu: K.hu, road: ri, side, row, cls, sm, x, z, tx, tz, nx, nz, L0, hw, setb, box, aabb: boxAABB(box), prio: (row === 0 ? 1 : 0) + hash(seed, rkey, k, 7), ok: undefined, acc: undefined };
          cands.push(c); cgAdd(c);
        }
      }
    }
  }
  if (!disabled) buildCandidates();

  // ================================================================================================
  // static validity (independent of paint) and greedy overlap removal (independent of request order)
  // ================================================================================================
  function staticOk(c) {
    if (c.ok !== undefined) return c.ok;
    const b = c.box, a = c.aabb, em = cfg.edgeMargin;
    let why = '';
    if (a[0] < em || a[1] < em || a[2] > W - em || a[3] > W - em) why = 'bounds';
    if (!why) for (const j of junctions) if (pointBoxDist(b, j.x, j.z) < j.radius + cfg.junctionMargin) { why = 'junction'; break; }
    if (!why) {
      const seen = new Set();
      scan: for (let i = Math.floor(a[0] / C); i <= Math.floor(a[2] / C); i++) for (let j = Math.floor(a[1] / C); j <= Math.floor(a[3] / C); j++) {
        const l = segGrid.get(key2(i, j)); if (!l) continue;
        for (const s of l) { if (seen.has(s)) continue; seen.add(s); if (segBoxDist(b, s[0], s[1], s[2], s[3]) < s[4]) { why = 'road'; break scan; } }
      }
    }
    if (!why) for (const m of markers) if (pointBoxDist(b, m.x, m.z) < m.r + cfg.markerClear) { why = 'marker'; break; }
    if (!why) for (const m of emptyZones) if (pointBoxDist(b, m.x, m.z) < m.r) { why = 'marker'; break; }
    if (!why) for (const e of circles) if (pointBoxDist(b, e.x, e.z) < e.r) { why = 'circle'; break; }
    if (!why) { // water + shore ring on a 5 m grid, terrain height range
      let lo = Infinity, hi = -Infinity;
      for (const [x, z] of boxPoints(b, 5)) { const h = heightAt(x, z); if (h < lo) lo = h; if (h > hi) hi = h; if (!dry(x, z, cfg.shore)) { why = 'water'; break; } }
      if (!why && hi - lo > cfg.maxHeightRange) why = 'slope';
    }
    if (why) stats.rej[why]++; else stats.valid++;
    return (c.ok = !why);
  }
  function neighbours(c) {
    const out = new Set(), a = c.aabb;
    for (let i = Math.floor(a[0] / C); i <= Math.floor(a[2] / C); i++) for (let j = Math.floor(a[1] / C); j <= Math.floor(a[3] / C); j++) {
      const l = cgrid.get(key2(i, j)); if (l) for (const n of l) if (n !== c) out.add(n);
    }
    return out;
  }
  function accepted(c) { // statically valid and not overlapping an accepted lot of higher priority (memoised; recursion strictly goes up in priority, so it terminates)
    if (c.acc !== undefined) return c.acc;
    let r = staticOk(c);
    if (r) for (const n of neighbours(c)) {
      if (n.prio < c.prio || (n.prio === c.prio && n.id < c.id)) continue;
      if (c.aabb[0] > n.aabb[2] || c.aabb[2] < n.aabb[0] || c.aabb[1] > n.aabb[3] || c.aabb[3] < n.aabb[1]) continue;
      if (boxesOverlap(c.box, n.box, 0.1) && accepted(n)) { r = false; stats.rej.overlap++; break; }
    }
    if (r) stats.accepted++;
    return (c.acc = r);
  }

  // ================================================================================================
  // paint gate + building record
  // ================================================================================================
  const FAM = ['brick', 'metal', 'trim'], COR = ['brick', 'metal', 'trim', 'none'];
  function build(c) {
    const b = c.box, s = map.surfaceAt(b.cx, b.cz), wPaint = s.weights[7];
    if (c.row > 0 && wPaint < cfg.rowMinWeight) return null;
    const w = c.mode === 1 && c.row === 0 ? Math.max(wPaint, defaultWeight) : wPaint;
    if (!(hash(seed, c.rkey, c.k, 9) < Math.pow(w, gamma) * density)) return null;
    let tall = false;
    for (const z of tallZones) if (pointBoxDist(b, z.x, z.z) < z.r) { tall = true; break; }
    let ai = c.cls, A, sc = 1, spec = null;
    if (c.kind === 'whole') { A = assets[ai]; sc = lerp(cfg.scale[0], cfg.scale[1], hash(seed, c.rkey, c.k, 5)); }
    else {
      const P = cfg.proc, u2 = hash(seed, c.rkey, c.k, 30), fl = tall ? P.floors[1] : Math.min(P.floors[1], P.floors[0] + Math.floor((P.floorW * Math.min(1, w) + (1 - P.floorW) * u2) * (P.floors[1] - P.floors[0] + 1)));
      const up = FAM[Math.floor(hash(seed, c.rkey, c.k, 31) * 3)], gr = hash(seed, c.rkey, c.k, 32) < 0.6 ? up : FAM[Math.floor(hash(seed, c.rkey, c.k, 33) * 3)];
      const cor = COR[Math.floor(hash(seed, c.rkey, c.k, 34) * 4)];
      spec = { W: c.PW, D: c.PD, floors: fl, up, gr, cor, cols: hash(seed, c.rkey, c.k, 35) < 0.55, seed: Math.floor(hash(seed, c.rkey, c.k, 36) * 1e9) };
      ai = -1; A = { hw: c.PW / 2, cxb: 0, body: { x0: -c.PW / 2, x1: c.PW / 2, z0: -c.PD, z1: 0.2, h: fl * 3 + (cor === 'none' ? 0 : 1) } };
    }
    // pivot: facade plane centre; local X world axis = -side * tangent, local +Z (facade normal) = -n
    const L0 = c.L0, ex = -c.side * c.tx, ez = -c.side * c.tz;
    const px = c.x + c.nx * L0 - ex * A.cxb * sc, pz = c.z + c.nz * L0 - ez * A.cxb * sc;
    const yaw = Math.atan2(-c.nx, -c.nz);
    // footprint box (u = tangent, v = (-uz, ux)); the body spans lateral [L0 - z1*sc, L0 - z0*sc]
    const lat0 = L0 - A.body.z1 * sc, lat1 = L0 - A.body.z0 * sc, latC = (lat0 + lat1) / 2;
    const mk = (pd) => ({ cx: c.x + c.nx * latC, cz: c.z + c.nz * latC, ux: c.tx, uz: c.tz, hu: A.hw * sc + pd, hv: (lat1 - lat0) / 2 + pd });
    const fp = mk(cfg.pad), col = mk(cfg.colPad);
    // ground: base = highest ground along the front edge - embed, plinth down to the lowest ground under the footprint
    let lo = Infinity, hi = -Infinity, frontMax = -Infinity;
    const jFront = c.side > 0 ? 0 : Math.max(1, Math.ceil(2 * fp.hv / 3));   // box v = side * n (n = away from the road): the front row of sample points is v = -side * hv
    for (const [x, z, j] of boxPoints(fp, 3)) {
      const h = heightAt(x, z); if (h < lo) lo = h; if (h > hi) hi = h;
      if (j === jFront && h > frontMax) frontMax = h;
    }
    const y = frontMax - cfg.embed, y0 = Math.min(y, lo - cfg.plinthSink);
    const plinth = y - lo > 0.02 ? { h: y - y0 + cfg.plinthTop, y0, hu: A.hw * sc + cfg.plinthPad, hv: (lat1 - lat0) / 2 + cfg.plinthPad } : null;
    return { id: c.id, kind: c.kind, spec, mode: c.mode, road: c.road, side: c.side, row: c.row, cls: c.cls, asset: ai, x: px, y, z: pz, yaw, sc, w, tall,
      cx: fp.cx, cz: fp.cz, ux: fp.ux, uz: fp.uz, hu: fp.hu, hv: fp.hv, col: { cx: col.cx, cz: col.cz, hu: col.hu, hv: col.hv, y0: Math.min(y0, y), y1: y + A.body.h * sc }, plinth, h: A.body.h * sc };
  }

  // ---- street props of a filled row-0 building ----
  const near2 = (list, x, z, r) => { for (const [px, pz] of list) if ((px - x) * (px - x) + (pz - z) * (pz - z) < r * r) return true; return false; };
  function propsOf(c, bd, out) {
    if (c.row !== 0 || c.mode !== 1) return;   // props only along city roads (footpath)
    const P = cfg.props, road = roads[c.road], rp = polys[c.road], hw = c.hw;
    if (hash(seed, c.rkey, c.k, 20) < P.bollard.chance) {
      const n = P.bollard.n[0] + Math.floor(hash(seed, c.rkey, c.k, 21) * (P.bollard.n[1] - P.bollard.n[0] + 1)), lat = hw + CITY.KERB_W + 0.35;
      for (let q = 0; q < n; q++) {
        const [x, z, tx, tz] = sampleAt(rp, c.sm + (q - (n - 1) / 2) * P.bollard.spacing), bx = x + c.nx * lat, bz = z + c.nz * lat;
        if (near2(zebras, bx, bz, P.bollard.zebra) || near2(lamps, bx, bz, P.bollard.lamp)) continue;
        if (junctions.some((j) => Math.hypot(bx - j.x, bz - j.z) < j.radius + P.bollard.junction)) continue;
        const s = map.surfaceAt(bx, bz); if (s.roadSurface !== 'footpath') continue;   // must really stand on the paving
        out.bollard.push({ x: bx, y: heightAt(bx, bz) + 0.03 + CITY.KERB_H, z: bz, yaw: 0, sc: 1 });
      }
    }
    if (hash(seed, c.rkey, c.k, 22) < P.planter.chance) {
      const off = (c.hu - 2.4) * (hash(seed, c.rkey, c.k, 23) < 0.5 ? -1 : 1), lat = hw + FOOT_SHIFT + P.planter.lateral;
      const [x, z, tx, tz] = sampleAt(rp, c.sm + off), cx = x + c.nx * lat, cz = z + c.nz * lat;
      let ok = true, ymax = -Infinity;
      for (const [du, dv] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const qx = cx + tx * du + -tz * dv, qz = cz + tz * du + tx * dv, s = map.surfaceAt(qx, qz);
        if (s.classId === 6 || s.classId === 7 || map.waterLevelAt(qx, qz) !== null) { ok = false; break; }
        ymax = Math.max(ymax, heightAt(qx, qz));
      }
      // keep it clear of the building body and of the entrance steps (small building: steps 2 m in front of the facade)
      if (ok && pointBoxDist({ cx: bd.cx, cz: bd.cz, ux: bd.ux, uz: bd.uz, hu: bd.hu + 1.2, hv: bd.hv + 1.2 }, cx, cz) === 0) ok = false;
      if (ok) out.planter.push({ x: cx, y: ymax - 0.05, z: cz, yaw: Math.atan2(tx, tz) + Math.PI / 2, sc: 1 });
    }
  }

  // ================================================================================================
  // public
  // ================================================================================================
  const cache = new Map(); let cacheCap = 600;
  function chunk(cx, cz) {
    const key = cx * 100003 + cz, hit = cache.get(key);
    if (hit) return hit;
    const t0 = performance.now(), res = { cx, cz, buildings: [], props: { bollard: [], planter: [] } };
    const ent = byChunk.get(key), list = ent && ent.list;
    if (list) for (const c of list) {
      if (!accepted(c)) continue;
      const bd = build(c); if (!bd) continue;
      res.buildings.push(bd); propsOf(c, bd, res.props);
    }
    res.buildings.sort((a, b) => a.id - b.id);
    cache.set(key, res); if (cache.size > cacheCap) cache.delete(cache.keys().next().value);
    const dt = performance.now() - t0; stats.chunks++; stats.ms += dt; if (dt > stats.maxMs) stats.maxMs = dt;
    return res;
  }
  function blocked(x, z, margin = 0) {
    if (!cands.length) return false;
    const R = margin + 26;
    for (let cz = Math.floor((z - R) / CS); cz <= Math.floor((z + R) / CS); cz++) for (let cx = Math.floor((x - R) / CS); cx <= Math.floor((x + R) / CS); cx++) {
      if (!byChunk.has(cx * 100003 + cz)) continue;
      for (const b of chunk(cx, cz).buildings) if (pointBoxDist(b, x, z) <= margin) return true;
    }
    return false;
  }
  return {
    cfg, seed, disabled, assets, classes, stats, chunkSize: CS, worldSize: W, candidates: cands, chunk, blocked,
    hasCity: () => cands.length > 0,
    // chunk coordinates that contain at least one candidate lot (the renderer / tests only visit these)
    chunkKeys: () => [...byChunk.values()].map((e) => [e.cx, e.cz]),
    clearCache: () => cache.clear(), setCacheCap: (n) => { cacheCap = n; },
  };
}

// LOD selection shared by renderer and tests: distance -> 0 (full), 1 (simplified), 2 (box), -1 culled
export function cityLod(cfg, dist, qDist = 1) {
  if (dist >= cfg.lod.cull * qDist) return -1;
  let k = 0; while (k < cfg.lod.d.length && dist >= cfg.lod.d[k] * qDist) k++;
  return k;
}
