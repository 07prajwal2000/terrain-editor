// Road network for the map loader: junction detection, terrain stamping, road/bridge/junction/roundabout meshes and
// the analytic "is this point road?" query. THREE / RAPIER are injected (like mapLoader.js); only sibling modules are imported.
// Road node metadata (type, surfaces, oneway, edges, features, signs) is documented in roadMeta.js; edges/features in roadEdges.js,
// automatic warning signs in roadSigns.js, the city type (corridor stamping, kerb + footpath, corner blocks, crosswalks) in roadCity.js,
// signalised junctions in roadSignals.js. The highway type is shader + median barrier (roadEdges.js).
//
// Everything is in world metres, XZ plane. Road samples come from road.getPoints(1) (uniform Catmull-Rom, ~1 m apart).
import { collectFeatures, buildEdges } from './roadEdges.js';
import { buildSigns, detectSigns } from './roadSigns.js';
import { buildCity, crosswalkPlan } from './roadCity.js';
import { planSignals, buildSignalObjects } from './roadSignals.js';
import { SURFACES, SURFACE_PROPS, RUMBLE_ROUGHNESS, ROAD_TYPES, MARKER_JUNCTION_TAGS, HIGHWAY, SELF_JUNCTION } from './roadMeta.js';
export { cityRuns, stampCityCorridors } from './roadCity.js';

const LIFT_ROAD = 0.03, LIFT_RING = 0.04, LIFT_PATCH = 0.045, LIFT_DECAL = 0.06; // metres above terrain (+ polygonOffset)
export const KERB = 0.5;  // shoulder strip beyond each road edge (gravel on ground, concrete on bridges)
const DECK_T = 0.7;       // bridge slab thickness
const MARK_PERIOD = 9, MARK_DASH = 3; // centre dashes: 3 m paint, 6 m gap
const ARROW_PERIOD = 40;              // one-way arrows every 40 m

// ------------------------------------------------------------------ polylines
const polyCache = new WeakMap();
export const resetPoly = (road) => polyCache.delete(road); // after road.setDeck (roadBridges.js): the cached samples are stale
export function polyOf(road) {
  let p = polyCache.get(road);
  if (p) return p;
  const pts = road.getPoints(1), n = pts.length;
  // seg[i] = control point whose segment sample i belongs to (its attributes: road.points[seg]); ci[j] = sample index of control point j
  p = { n, x: new Float64Array(n), z: new Float64Array(n), y: new Float64Array(n), b: new Uint8Array(n), a: new Uint8Array(n), u: new Float64Array(n), tx: new Float64Array(n), tz: new Float64Array(n), s: new Float64Array(n), seg: new Int32Array(n), ci: new Int32Array(Math.max(1, road.points.length)) };
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    p.x[i] = q.x; p.z[i] = q.z; p.y[i] = q.y; p.b[i] = q.bridge ? 1 : 0; p.a[i] = q.auto ? 1 : 0; p.u[i] = q.u; p.tx[i] = q.tx; p.tz[i] = q.tz; p.seg[i] = q.seg;
    if (i) p.s[i] = p.s[i - 1] + Math.hypot(q.x - p.x[i - 1], q.z - p.z[i - 1]);
    if (i === 0 || q.seg !== p.seg[i - 1]) p.ci[q.seg] = i;
  }
  if (n) p.ci[p.ci.length - 1] = n - 1;
  polyCache.set(road, p);
  return p;
}

function segNearest(p, i, x, z) {
  const ax = p.x[i], az = p.z[i], bx = p.x[i + 1] - ax, bz = p.z[i + 1] - az, l2 = bx * bx + bz * bz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / l2)) : 0;
  return { d: Math.hypot(ax + bx * t - x, az + bz * t - z), i, t, x: ax + bx * t, z: az + bz * t };
}
// nearest point on the polyline; with sRef / minSep the segments within minSep metres of arc length of sRef are skipped (self-meetings of one road)
function nearestOnPoly(p, x, z, sRef = 0, minSep = 0) {
  let best = { d: Infinity, i: 0, t: 0, x: 0, z: 0 };
  for (let i = 0; i < p.n - 1; i++) {
    if (minSep && Math.min(Math.abs(p.s[i] - sRef), Math.abs(p.s[i + 1] - sRef)) < minSep) continue;
    const h = segNearest(p, i, x, z); if (h.d < best.d) best = h;
  }
  return best;
}
// separate passes of one road through the circle of radius thr around (x,z): runs of consecutive segments within thr, runs closer than minSep metres of arc
// merged (a tight bend leaving and re-entering is ONE pass); -> nearest point of every pass, in road order
function passesNear(p, x, z, thr, minSep) {
  const out = [];
  for (let i = 0, last = -2; i < p.n - 1; i++) {
    const h = segNearest(p, i, x, z); if (h.d > thr) continue;
    const prev = out[out.length - 1];
    if (prev && (i === last + 1 || p.s[i] - p.s[prev.i + 1] < minSep)) { if (h.d < prev.d) out[out.length - 1] = h; } else out.push(h);
    last = i;
  }
  return out;
}

// ------------------------------------------------------------------ junction detection
// Returns junction objects { x, z, y, style, radius, arms:[{roadId, angle, width, type}], _arms (internal), ... }.
// Style: default 2-3 arms 'junction' / 4+ 'roundabout'; ANY arm of type city (3+ arms) -> 'signals'; ANY arm highway -> plain 'junction' (checked first).
// Then markers (x,z,tags[]: a marker within 15 m with tag roundabout | signals | junction_plain forces the style), then overrides (junctions.json) on top.
export function detectJunctions(roads, heightAt, overrides = [], markers = []) {
  const polys = roads.map(polyOf), events = [];
  const yAt = (p, i, t) => p.y[i] + (p.y[i + 1] - p.y[i]) * t;
  const overpass = (pa, ia, ta, pb, ib, tb) => // either road is a bridge there, or heights differ by > 4 m
    pa.b[ia] || pa.b[ia + 1] || pb.b[ib] || pb.b[ib + 1] || Math.abs(yAt(pa, ia, ta) - yAt(pb, ib, tb)) > 4;

  for (let a = 0; a < roads.length; a++) for (let b = a + 1; b < roads.length; b++) {
    const A = polys[a], B = polys[b], w = Math.max(roads[a].width, roads[b].width);
    // segment crossings: hash B's segments (32 m cells), probe with A's
    const hash = new Map(), C = 32;
    for (let j = 0; j < B.n - 1; j++) {
      const x0 = Math.floor(Math.min(B.x[j], B.x[j + 1]) / C), x1 = Math.floor(Math.max(B.x[j], B.x[j + 1]) / C);
      const z0 = Math.floor(Math.min(B.z[j], B.z[j + 1]) / C), z1 = Math.floor(Math.max(B.z[j], B.z[j + 1]) / C);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = cx * 100003 + cz; (hash.get(k) || hash.set(k, []).get(k)).push(j); }
    }
    for (let i = 0; i < A.n - 1; i++) {
      const seen = new Set();
      const x0 = Math.floor(Math.min(A.x[i], A.x[i + 1]) / C), x1 = Math.floor(Math.max(A.x[i], A.x[i + 1]) / C);
      const z0 = Math.floor(Math.min(A.z[i], A.z[i + 1]) / C), z1 = Math.floor(Math.max(A.z[i], A.z[i + 1]) / C);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (const j of hash.get(cx * 100003 + cz) || []) {
        if (seen.has(j)) continue; seen.add(j);
        const rx = A.x[i + 1] - A.x[i], rz = A.z[i + 1] - A.z[i], sx = B.x[j + 1] - B.x[j], sz = B.z[j + 1] - B.z[j];
        const den = rx * sz - rz * sx; if (Math.abs(den) < 1e-12) continue;
        const qx = B.x[j] - A.x[i], qz = B.z[j] - A.z[i];
        const ta = (qx * sz - qz * sx) / den, tb = (qx * rz - qz * rx) / den;
        if (ta < 0 || ta > 1 || tb < 0 || tb > 1) continue;
        if (overpass(A, i, ta, B, j, tb)) continue;
        events.push({ x: A.x[i] + rx * ta, z: A.z[i] + rz * ta, w, type: 'cross' });
      }
    }
  }
  // self-crossings: segments of ONE road whose arc positions differ by at least the separation, not (nearly) parallel
  const sep = (r) => SELF_JUNCTION.SEP_WIDTHS * r.width + SELF_JUNCTION.SEP_M, cosMax = Math.cos(SELF_JUNCTION.MIN_ANGLE_DEG * Math.PI / 180);
  for (let a = 0; a < roads.length; a++) {
    const A = polys[a], w = roads[a].width, minSep = sep(roads[a]);
    if (A.s[A.n - 1] < minSep) continue;
    const hash = new Map(), C = 32;
    for (let j = 0; j < A.n - 1; j++) {
      const x0 = Math.floor(Math.min(A.x[j], A.x[j + 1]) / C), x1 = Math.floor(Math.max(A.x[j], A.x[j + 1]) / C), z0 = Math.floor(Math.min(A.z[j], A.z[j + 1]) / C), z1 = Math.floor(Math.max(A.z[j], A.z[j + 1]) / C);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = cx * 100003 + cz; (hash.get(k) || hash.set(k, []).get(k)).push(j); }
    }
    for (let i = 0; i < A.n - 1; i++) {
      const seen = new Set(), x0 = Math.floor(Math.min(A.x[i], A.x[i + 1]) / C), x1 = Math.floor(Math.max(A.x[i], A.x[i + 1]) / C), z0 = Math.floor(Math.min(A.z[i], A.z[i + 1]) / C), z1 = Math.floor(Math.max(A.z[i], A.z[i + 1]) / C);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (const j of hash.get(cx * 100003 + cz) || []) {
        if (j <= i || seen.has(j)) continue; seen.add(j);
        if (A.s[j] - A.s[i + 1] < minSep) continue;
        const rx = A.x[i + 1] - A.x[i], rz = A.z[i + 1] - A.z[i], sx = A.x[j + 1] - A.x[j], sz = A.z[j + 1] - A.z[j], den = rx * sz - rz * sx; if (Math.abs(den) < 1e-12) continue;
        if (Math.abs(rx * sx + rz * sz) / (Math.hypot(rx, rz) * Math.hypot(sx, sz)) > cosMax) continue; // hairpin: crossing angle below MIN_ANGLE_DEG
        const qx = A.x[j] - A.x[i], qz = A.z[j] - A.z[i], ta = (qx * sz - qz * sx) / den, tb = (qx * rz - qz * rx) / den;
        if (ta < 0 || ta > 1 || tb < 0 || tb > 1 || overpass(A, i, ta, A, j, tb)) continue;
        events.push({ x: A.x[i] + rx * ta, z: A.z[i] + rz * ta, w, type: 'cross' });
      }
    }
  }
  // T / Y / L: a road END within about one road width of another road's centreline (or its end); b === a = the end meets the road's own body / other end
  for (let a = 0; a < roads.length; a++) for (const e of [0, polys[a].n - 1]) {
    const A = polys[a];
    for (let b = 0; b < roads.length; b++) {
      const B = polys[b], w = Math.max(roads[a].width, roads[b].width), self = a === b, minSep = self ? sep(roads[a]) : 0;
      if (self && A.s[A.n - 1] < minSep) continue;
      const hit = nearestOnPoly(B, A.x[e], A.z[e], A.s[e], minSep);
      if (hit.d > w) continue;
      if (A.b[Math.min(e, A.n - 2)] || B.b[hit.i] || B.b[hit.i + 1] || Math.abs(A.y[e] - yAt(B, hit.i, hit.t)) > 4) continue;
      const atEnd = (hit.i === 0 && hit.t === 0) || (hit.i === B.n - 2 && hit.t === 1);
      if (self && !atEnd && Math.abs(A.tx[e] * B.tx[hit.i] + A.tz[e] * B.tz[hit.i]) > cosMax) continue; // end lying along its own body (hairpin), not a T
      events.push(atEnd ? { x: (hit.x + A.x[e]) / 2, z: (hit.z + A.z[e]) / 2, w, type: 'join' } : { x: hit.x, z: hit.z, w, type: 'T' });
    }
  }
  // merge events within about one road width into clusters
  const par = events.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++)
    if (Math.hypot(events[i].x - events[j].x, events[i].z - events[j].z) < Math.max(events[i].w, events[j].w)) par[find(j)] = find(i);
  const groups = new Map();
  events.forEach((e, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(e); });

  let junctions = [];
  for (const g of groups.values()) {
    const x = g.reduce((s, e) => s + e.x, 0) / g.length, z = g.reduce((s, e) => s + e.z, 0) / g.length;
    const arms = [];
    roads.forEach((road, ri) => {
      const P = polys[ri], w = road.width; // every separate pass of the road through the cluster contributes its own arm(s) (a road may meet itself)
      passesNear(P, x, z, Math.max(w * 1.5, 6), sep(road)).forEach((near, pass) => {
        const i = near.t > 0.5 ? near.i + 1 : near.i, s = P.s[i] + 0; // nearest sample
        const push = (dir, end) => arms.push({ road: ri, roadId: road.id, pass, s, seg: P.seg[i], dir, end, idx: i, width: w, dx: P.tx[i] * dir, dz: P.tz[i] * dir, angle: Math.atan2(P.tz[i] * dir, P.tx[i] * dir) });
        if (s < w) push(1, true); else if (P.s[P.n - 1] - s < w) push(-1, true); else { push(1, false); push(-1, false); }
      });
    });
    if (arms.length < 2) continue;
    const maxW = Math.max(...arms.map((a) => a.width));
    for (const a of arms) { const P = polys[a.road], k = Math.max(0, Math.min(P.n - 1, a.idx + a.dir)); a.type = roads[a.road].points[P.seg[k]].type; } // type of the segment one sample along the arm
    let style = arms.length >= 4 ? 'roundabout' : 'junction';
    if (arms.some((a) => a.type === 'highway')) style = 'junction';
    else if (arms.length >= 3 && arms.some((a) => a.type === 'city')) style = 'signals';
    junctions.push({ x, z, y: heightAt(x, z), style, source: 'default', radius: 0, arms: arms.map((a) => ({ roadId: a.roadId, pass: a.pass, s: a.s, seg: a.seg, dir: a.dir, angle: a.angle, width: a.width, type: a.type })), _arms: arms, _maxW: maxW });
  }
  const nearest = (o) => { let best = null, bd = 15; for (const j of junctions) { const d = Math.hypot(j.x - o.x, j.z - o.z); if (d < bd) { bd = d; best = j; } } return best; };
  // markers: the nearest relevant marker within 15 m of a junction decides (tag order roundabout > signals > junction_plain on one marker)
  const mk = new Map();
  for (const m of markers) {
    const tag = Object.keys(MARKER_JUNCTION_TAGS).find((t) => m.tags && m.tags.includes(t)), j = tag && nearest(m); if (!j) continue;
    const d = Math.hypot(j.x - m.x, j.z - m.z); if (!mk.has(j) || d < mk.get(j).d) mk.set(j, { d, style: MARKER_JUNCTION_TAGS[tag] });
  }
  for (const [j, v] of mk) { j.style = v.style; j.source = 'marker'; }
  // optional override file: [{x,z,style,radius}] matched to the nearest detected junction within 15 m (beats markers)
  for (const o of overrides) {
    const best = nearest(o); if (!best) continue;
    if (['junction', 'roundabout', 'signals', 'none'].includes(o.style)) { best.style = o.style; best.source = 'json'; }
    if (Number.isFinite(o.radius) && o.radius > 0) best._radiusOverride = o.radius;
  }
  junctions = junctions.filter((j) => j.style !== 'none');
  for (const j of junctions) {
    const mw = j._maxW;
    if (j.style === 'roundabout') {
      j._Ro = Math.max(12, j._radiusOverride || 2 * mw); j._ringW = Math.min(mw, j._Ro - 4); j._Ri = j._Ro - j._ringW;
      j.radius = j._Ro; j._extent = j._Ro + KERB + 1;
    } else {
      j._L = Math.max(10, j._radiusOverride || 1.2 * mw + 2); j.radius = j._L; j._extent = j._L + mw * 0.5 + 1;
    }
    j._blend = Math.max(12, 1.5 * mw);
  }
  return junctions;
}

// Flat disc at the junction height + smooth shoulder blend, written straight into the height grid (metres, N x N).
// Optional rect {x0,y0,x1,y1} (pixels, x1/y1 exclusive) restricts the stamp to those pixels (live editing: only the edited
// region of Hm was reset, so only it may be re-stamped; stamping is not idempotent in the blend zone).
export function stampJunctions(Hm, N, cell, junctions, rect) {
  for (const j of junctions) {
    const R = j._extent, B = j._blend, r = R + B;
    let i0 = Math.max(0, Math.floor((j.x - r) / cell - 0.5)), i1 = Math.min(N - 1, Math.ceil((j.x + r) / cell - 0.5));
    let k0 = Math.max(0, Math.floor((j.z - r) / cell - 0.5)), k1 = Math.min(N - 1, Math.ceil((j.z + r) / cell - 0.5));
    if (rect) { i0 = Math.max(i0, rect.x0); i1 = Math.min(i1, rect.x1 - 1); k0 = Math.max(k0, rect.y0); k1 = Math.min(k1, rect.y1 - 1); }
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5) * cell - j.x, (k + 0.5) * cell - j.z);
      if (d >= r) continue;
      const t = d <= R ? 1 : 1 - (d - R) / B, w = t * t * (3 - 2 * t);
      Hm[k * N + i] += (j.y - Hm[k * N + i]) * w;
    }
  }
}

// ------------------------------------------------------------------ analytic road query (replaces blurry splat weights)
// Returns roadAt(x,z) -> true when the point is on asphalt: within half a width of a non-bridge centreline (16 m spatial
// grid), on a roundabout ring, or inside a junction patch; false on a roundabout island.
export function makeRoadQuery(roads, junctions) {
  const C = 16, grid = new Map();
  for (const road of roads) {
    const P = polyOf(road), hw = road.width / 2;
    for (let i = 0; i < P.n - 1; i++) {
      if (P.b[i] || P.b[i + 1]) continue;
      const x0 = Math.floor((Math.min(P.x[i], P.x[i + 1]) - hw) / C), x1 = Math.floor((Math.max(P.x[i], P.x[i + 1]) + hw) / C);
      const z0 = Math.floor((Math.min(P.z[i], P.z[i + 1]) - hw) / C), z1 = Math.floor((Math.max(P.z[i], P.z[i + 1]) + hw) / C);
      const seg = [P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], hw * hw, Math.max(0, SURFACES.indexOf(road.points[P.seg[i]].surface))];
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = cx * 100003 + cz; (grid.get(k) || grid.set(k, []).get(k)).push(seg); }
    }
  }
  // surface name of the asphalt at (x,z) ('smooth' on junction patches / roundabout rings), null when not road
  const surface = (x, z) => {
    for (const j of junctions) {
      const d = Math.hypot(x - j.x, z - j.z);
      if (j.style === 'roundabout') { if (d < j._Ri) return null; if (d <= j._Ro) return 'smooth'; }
      else if (d <= j._L && j._poly && pointInPoly(j._poly, x, z)) return 'smooth';
    }
    for (const s of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) || []) {
      const bx = s[2] - s[0], bz = s[3] - s[1], l2 = bx * bx + bz * bz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * bx + (z - s[1]) * bz) / l2)) : 0, dx = s[0] + bx * t - x, dz = s[1] + bz * t - z;
      if (dx * dx + dz * dz <= s[4]) return SURFACES[s[5]];
    }
    return null;
  };
  const roadAt = (x, z) => surface(x, z) !== null;
  roadAt.surface = surface;
  // footpath / corner-block footprints (flat 2D polygons from roadCity.buildCity), installed after the meshes are built; 8 m spatial hash
  const fpGrid = new Map(), FC = 8;
  roadAt.setFootprints = (list) => {
    fpGrid.clear();
    for (const p of list) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      for (let cx = Math.floor(x0 / FC); cx <= Math.floor(x1 / FC); cx++) for (let cz = Math.floor(z0 / FC); cz <= Math.floor(z1 / FC); cz++) { const k = cx * 100003 + cz; (fpGrid.get(k) || fpGrid.set(k, []).get(k)).push(p); }
    }
  };
  roadAt.footpath = (x, z) => { for (const p of fpGrid.get(Math.floor(x / FC) * 100003 + Math.floor(z / FC)) || []) if (pointInPoly(p, x, z)) return true; return false; };
  // rumble-strip zones (visual strips in roadEdges.js; physically they are a roughness zone, no collider)
  const zones = collectFeatures(roads, junctions).filter((f) => f.kind === 'rumble');
  roadAt.roughness = (x, z, surf) => {
    let r = surf ? SURFACE_PROPS[surf].roughness : 0;
    for (const f of zones) {
      const a = (x - f.x) * f.tx + (z - f.z) * f.tz, l = -(x - f.x) * f.tz + (z - f.z) * f.tx;
      if (Math.abs(a) < 4 && Math.abs(l) < f.hw) r = Math.max(r, RUMBLE_ROUGHNESS);
    }
    return r;
  };
  return roadAt;
}
function pointInPoly(poly, x, z) { // poly: flat [x,z,x,z,...]
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], zi = poly[i + 1], xj = poly[j], zj = poly[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ road material
function noiseTexture(THREE) {
  // Small tileable noise: R = fine grain, G = coarse patching. Mipmapped + max anisotropy so it never shimmers.
  const S = 128, d = new Uint8Array(S * S * 4);
  let seed = 1337; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lat = (g) => Float32Array.from({ length: g * g }, rnd);
  const octave = (L, g, x, y) => { // periodic value noise on a g x g lattice, x,y in [0,1)
    const fx = x * g, fy = y * g, i = Math.floor(fx), j = Math.floor(fy);
    let tx = fx - i, ty = fy - j; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = L[(j % g) * g + (i % g)], b = L[(j % g) * g + ((i + 1) % g)], c = L[(((j + 1) % g)) * g + (i % g)], e = L[((j + 1) % g) * g + ((i + 1) % g)];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
  };
  const L = [lat(8), lat(16), lat(32), lat(64), lat(4)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, o = (y * S + x) * 4;
    const fine = 0.35 * octave(L[1], 16, u, v) + 0.35 * octave(L[2], 32, u, v) + 0.3 * octave(L[3], 64, u, v);
    const coarse = 0.6 * octave(L[4], 4, u, v) + 0.4 * octave(L[0], 8, u, v);
    d[o] = Math.round(fine * 255); d[o + 1] = Math.round(coarse * 255); d[o + 2] = 0; d[o + 3] = 255;
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 16; // three clamps this to the GPU maximum
  t.needsUpdate = true; return t;
}

function makeRoadMaterial(THREE, junctions, signStyle) {
  const J = junctions.filter((j) => j.style !== 'none').slice(0, 32); // ponytail: 32 marking-mask discs max; extra junctions keep their dashes
  const discs = Array.from({ length: 32 }, (_, i) => new THREE.Vector4(J[i] ? J[i].x : 0, J[i] ? J[i].z : 0, J[i] ? (J[i].style === 'roundabout' ? J[i]._Ro : J[i]._L - 0.5) : -1, J[i] && J[i].style === 'signals' ? 4.6 : 3.5)); // w = extra clearance for the centre line only (it stops before the stop line)
  const uniforms = { uNoise: { value: noiseTexture(THREE) }, uJ: { value: discs }, uJCount: { value: J.length }, uUS: { value: signStyle === 'eu' ? 0 : 1 } };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'road-v3';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aRuv;\nattribute float aHalf;\nattribute float aKind;\nattribute vec3 aMeta;\nvarying vec2 vRuv;\nvarying float vHalf;\nvarying float vKind;\nvarying vec3 vMeta;\nvarying vec3 vRWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRuv = aRuv; vHalf = aHalf; vKind = aKind; vMeta = aMeta; vRWP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vRuv; varying float vHalf; varying float vKind; varying vec3 vMeta; varying vec3 vRWP;
uniform sampler2D uNoise; uniform vec4 uJ[32]; uniform int uJCount; uniform float uUS;
// box-filtered coverage of the interval [a,b] by a pixel footprint of width f centred at x: analytic anti-aliasing,
// exact for sub-pixel lines (they fade into the asphalt instead of shimmering)
float cov(float x, float a, float b, float f) { return clamp(min(x + 0.5 * f, b) - max(x - 0.5 * f, a), 0.0, f) / f; }
// ---- surface wear helpers (hash noise in world / road space; every detail fades out with lod() as it gets sub-pixel) ----
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n + 17.1)); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
float lod(float size, float fp) { return 1.0 - smoothstep(0.12, 0.35, fp / size); }   // 1 = detail of this size is resolvable, 0 = average it
vec2 vor(vec2 p) { vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)); vec2 r = g + h22(i + g) - f; float d = dot(r, r); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return vec2(sqrt(d1), sqrt(d2)); }
// thin cracks along Voronoi borders: freq cells/m, width in m; returns 0..1 coverage
float cracks(vec2 w, float freq, float width, float fp) {
  vec2 f12 = vor(w * freq); float e = (f12.y - f12.x) / freq, fe = max(fwidth(e) * 0.8, 1e-4);
  return (1.0 - smoothstep(width - fe, width + fe, e)) * lod(width * 3.0, fp);
}
// potholes in road space q (u along, v across, metres): x = hole, y = broken rim, z = depth shading
vec3 holes(vec2 q, float fp) {
  vec3 res = vec3(0.0); vec2 i = floor(q / 3.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    if (h21(c + 3.7) > 0.45) continue;
    vec2 ctr = (c + 0.2 + 0.6 * h22(c + 9.1)) * 3.0; float r = mix(0.2, 0.6, h21(c + 1.3));
    vec2 d = q - ctr; d.x *= mix(0.65, 1.5, h21(c + 5.5));
    float dist = length(d) + (vn(q * 6.0 + c) - 0.5) * 0.35 * r, aa = max(fp * 0.7, 1e-3);
    float inM = 1.0 - smoothstep(r - aa, r + aa, dist), rim = (1.0 - smoothstep(r * 1.4 - aa, r * 1.4 + aa, dist)) - inM;
    res.x = max(res.x, inM); res.y = max(res.y, rim * 0.9); res.z = max(res.z, inM * (0.4 + 0.6 * (1.0 - dist / r)));
  }
  return res;
}
// darker repair patches with a hard edge: road space, ~7 m x 3 m cells
float patches(vec2 q, float fp, float prob) {
  vec2 c = floor(q / vec2(7.0, 3.0)); if (h21(c + 11.3) > prob) return 0.0;
  vec2 o = h22(c + 2.9), ctr = (c + 0.3 + 0.4 * o) * vec2(7.0, 3.0), hs = mix(vec2(0.8, 0.5), vec2(2.8, 1.2), h22(c + 6.1));
  vec2 d = abs(q - ctr) - hs; float sd = max(d.x, d.y), aa = max(fp * 0.7, 1e-3);
  return (1.0 - smoothstep(-aa, aa, sd)) * lod(0.6, fp);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float u = vRuv.x, v = vRuv.y;
  float fv = max(fwidth(v), 1e-4), fu = max(fwidth(u), 1e-4);
  float ty = (vKind < 1.5 || (vKind > 2.5 && vKind < 3.5)) ? vMeta.z : 0.0; // road type on ribbons / rings / patches: 0 country, 1 city, 2 highway
  float grain = texture2D(uNoise, vRWP.xz * 0.43).r, patchN = texture2D(uNoise, vRWP.xz * 0.031).g;
  vec3 asphalt = vec3(0.07) * (0.7 + 0.65 * grain) * (0.85 + 0.3 * patchN);
  if (ty > 0.5) asphalt = vec3(ty > 1.5 ? 0.04 : 0.05) * (0.97 + (grain - 0.5) * (ty > 1.5 ? 0.16 : 0.3)) * (0.97 + 0.06 * patchN); // city: dark and smooth, highway: very smooth
  vec3 col = asphalt;
  if (vKind > 5.5) {                                           // zebra crossing: stripes across the width (u = lateral m, v = along m), n stripes in vMeta.x
    float n = vMeta.x, x = u + 0.5 * n, box = cov(x, 0.0, n, fu) * cov(v, -1.5, 1.5, fv);
    float s = mix(cov(mod(x, 1.0), 0.25, 0.75, fu) * box, 0.5 * box, smoothstep(0.3, 0.7, fu));
    col = mix(asphalt, vec3(0.8), s);
  }
  else if (vKind > 1.5 && vKind < 2.5) col = vec3(0.62);       // paint decal (stop lines, crosswalk, arrows): geometry edges are the AA
  else if (vKind < 1.5 || (vKind > 4.5 && vKind < 5.5)) {      // ribbon: 0 road, 1 roundabout ring, 5 bridge deck
    float inside = clamp((vHalf - abs(v)) / fv + 0.5, 0.0, 1.0); // hard road edge, one pixel of analytic AA
    float surf = vKind < 0.5 ? vMeta.x : 0.0, paintK = 1.0, oneway = vKind < 0.5 ? vMeta.y : 0.0;
    float fp = max(length(fwidth(vRWP.xz)), 1e-4);
    vec2 w = vRWP.xz, q = vec2(u, v);
    if (surf > 0.5 && surf < 1.5) {                            // worn: bleached, patchy, sparse hairline cracks, faded paint
      float wear = vn(w * 0.45) * 0.6 + vn(w * 1.7) * 0.4;
      asphalt = mix(asphalt, vec3(0.15, 0.148, 0.145) * (0.8 + 0.5 * grain), 0.35 + 0.45 * wear);
      asphalt *= 1.0 - 0.45 * patches(q, fp, 0.35);
      float cm = smoothstep(0.45, 0.62, vn(w * 0.12 + 7.0));
      asphalt = mix(asphalt, vec3(0.03), cracks(w, 1.6, 0.007, fp) * cm * smoothstep(0.42, 0.55, vn(w * 2.3 + 5.0)) * 0.8);
      float sp = mix(0.7, step(0.4, h21(floor(w * 22.0))), lod(1.0 / 22.0, fp));
      paintK = (0.25 + 0.4 * vn(q * vec2(0.4, 0.8))) * sp;
    } else if (surf > 1.5 && surf < 2.5) {                     // potholes: dark patches, dense cracks, holes with a broken rim, ragged paint
      asphalt = mix(asphalt, vec3(0.11, 0.108, 0.105) * (0.8 + 0.5 * grain), 0.5);
      asphalt *= 1.0 - 0.55 * patches(q, fp, 0.55);
      asphalt = mix(asphalt, vec3(0.02), cracks(w, 2.0, 0.009, fp) * smoothstep(0.3, 0.5, vn(w * 0.2 + 3.0)) * smoothstep(0.4, 0.52, vn(w * 2.6 + 9.0)) * 0.85);
      vec3 hl = holes(q, fp);
      asphalt = mix(asphalt, vec3(0.17, 0.155, 0.13), hl.y * 0.7);                              // crumbled rim
      asphalt = mix(asphalt, vec3(0.02, 0.018, 0.016) * (0.7 + 0.8 * hl.z), hl.x);              // hole floor, darkest at the middle
      float sp = mix(0.6, step(0.45, h21(floor(w * 18.0))), lod(1.0 / 18.0, fp));
      paintK = (0.6 + 0.3 * vn(q * 0.7)) * sp * (1.0 - clamp(hl.x + hl.y, 0.0, 1.0));
    } else if (surf > 2.5) {                                   // gravel: loose unpaved look, no markings
      vec3 g1 = vec3(0.36, 0.31, 0.24), g2 = vec3(0.4, 0.39, 0.37);
      asphalt = mix(g1, g2, vn(w * 0.35)) * (0.82 + 0.3 * patchN);
      asphalt *= 0.72 + 0.56 * mix(0.5, smoothstep(0.25, 0.75, vn(w * 22.0) * 0.6 + vn(w * 9.0 + 4.0) * 0.4), lod(1.0 / 22.0, fp));   // pebbles
      asphalt *= 0.88 + 0.24 * mix(0.5, vn(w * 3.0 + 31.0), lod(0.33, fp));                                                        // stones / dirt patches
      asphalt *= 1.0 - 0.2 * exp(-pow((abs(v) - vHalf * 0.32) / 0.4, 2.0));                    // packed wheel tracks
      paintK = 0.0;
    }
    float hwv = vHalf, av = abs(v);
    if (ty > 1.5) asphalt = mix(asphalt, asphalt * 1.5 + vec3(0.012, 0.011, 0.008), clamp((av - (hwv - ${HIGHWAY.SHOULDER_W.toFixed(2)})) / fv + 0.5, 0.0, 1.0)); // subtle hard-shoulder tone
    vec3 shoulder = (vKind > 4.5 ? vec3(0.42) : ty > 1.5 ? vec3(0.2, 0.2, 0.19) : ty > 0.5 ? vec3(0.42, 0.41, 0.39) : vec3(0.30, 0.27, 0.21)) * (0.8 + 0.4 * grain);
    col = mix(shoulder, asphalt, inside);
    float mask = 1.0, cmask = 1.0;
    if (vKind < 0.5) for (int i = 0; i < 32; i++) { if (i >= uJCount) break; float d = length(vRWP.xz - uJ[i].xy); mask *= clamp((d - uJ[i].z) / 0.4 + 0.5, 0.0, 1.0); cmask *= clamp((d - uJ[i].z - uJ[i].w) / 0.4 + 0.5, 0.0, 1.0); }
    float edge = cov(v, vHalf - 0.45, vHalf - 0.30, fv) + cov(v, -vHalf + 0.30, -vHalf + 0.45, fv);
    float xm = mod(u, ${MARK_PERIOD.toFixed(1)});
    float dash = cov(xm, 0.0, ${MARK_DASH.toFixed(1)}, fu) + cov(xm - ${MARK_PERIOD.toFixed(1)}, 0.0, ${MARK_DASH.toFixed(1)}, fu);
    dash = mix(dash, ${(MARK_DASH / MARK_PERIOD).toFixed(4)}, smoothstep(2.0, 6.0, fu)); // far away: average coverage, no aliasing
    float centre = cov(v, -0.075, 0.075, fv) * dash * (1.0 - oneway); // one-way roads have no centre line
    float ow = (vKind > 0.5 && vKind < 1.5) ? 1.0 : oneway; // roundabout rings of city / highway type count as one-way (no centre line); country rings keep their dashes
    if (ty < 0.5) col = mix(col, vec3(0.6), clamp(edge * mask + centre * cmask, 0.0, 1.0) * inside * paintK);
    else if (ty < 1.5) {                                       // city: crisp white edge lines + lane dashes, centre line by sign style (us double yellow, eu white)
      float lanes = ow > 0.5 ? max(1.0, floor(2.0 * hwv / 3.1 + 0.5)) : max(1.0, floor(hwv / 3.1 + 0.5));
      float pl = (ow > 0.5 ? 2.0 * hwv : hwv) / lanes, xl = ow > 0.5 ? v + hwv : av, kk = floor(xl / pl + 0.5);
      float lane = (kk >= 1.0 && kk < lanes) ? cov(xl, kk * pl - 0.06, kk * pl + 0.06, fv) * dash : 0.0;
      float eg = cov(av, hwv - 0.48, hwv - 0.36, fv), tw = 1.0 - ow;
      float white = clamp((eg + lane) * mask + cov(v, -0.06, 0.06, fv) * tw * (1.0 - uUS) * cmask, 0.0, 1.0);
      float yel = clamp((cov(v, -0.2, -0.1, fv) + cov(v, 0.1, 0.2, fv)) * tw * uUS * cmask, 0.0, 1.0);
      col = mix(col, vec3(0.64), white * inside * paintK);
      col = mix(col, vec3(0.8, 0.6, 0.04), yel * inside * paintK);
    } else {                                                   // highway: solid white edge lines + shoulder stripe, dashed lane lines (3.6 m lanes), median-side lines
      float hs = ${HIGHWAY.SHOULDER_W.toFixed(2)}, two = 1.0 - ow, m0 = two > 0.5 ? ${(HIGHWAY.MEDIAN_HALF + HIGHWAY.MEDIAN_SHY).toFixed(2)} : 0.0;
      float usable = two > 0.5 ? hwv - hs - m0 : 2.0 * (hwv - hs), lanes = max(1.0, floor(usable / ${HIGHWAY.LANE_W.toFixed(2)} + 0.5)), pl = usable / lanes;
      float xl = two > 0.5 ? av - m0 : v + hwv - hs, kk = floor(xl / pl + 0.5);
      float lane = (kk >= 1.0 && kk < lanes) ? cov(xl, kk * pl - 0.1, kk * pl + 0.1, fv) * dash : 0.0;
      float solid = cov(av, hwv - hs - 0.1, hwv - hs + 0.1, fv) + cov(av, hwv - 0.6, hwv - 0.2, fv) + (two > 0.5 ? cov(av, m0 - 0.1, m0 + 0.1, fv) : 0.0);
      col = mix(col, vec3(0.7), clamp((solid + lane) * mask, 0.0, 1.0) * inside * paintK);
    }
  }
  diffuseColor.rgb = col;
}`);
  };
  return mat;
}

// ------------------------------------------------------------------ geometry helpers
class Buf {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.half = []; this.kind = []; this.meta = []; this.idx = []; }
  vert(x, y, z, n, u, v, h, k, sf = 0, ow = 0, ty = 0) { const i = this.pos.length / 3; this.pos.push(x, y, z); this.nor.push(n[0], n[1], n[2]); this.uv.push(u, v); this.half.push(h); this.kind.push(k); this.meta.push(sf, ow, ty); return i; } // sf = surface id (SURFACES index; zebras: stripe count), ow = oneway, ty = road type (ROAD_TYPES index)
}
function lerpSample(a, b, t) {
  const tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t, l = Math.hypot(tx, tz) || 1;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, u: a.u + (b.u - a.u) * t, tx: tx / l, tz: tz / l, bridge: a.bridge, sf: a.sf, ow: a.ow, ty: a.ty };
}

// corner returns of a junction patch: for arms A and Nx (angle-sorted neighbours, gap = angle between them) the fillet between A's plus edge and Nx's
// minus edge, or null when there is no corner (collinear arms / too sharp). Shared by the patch outline and the city corner blocks (roadCity.js).
function cornerFillet(A, Nx, gap, maxW) {
  const cross = (ax, az, bx, bz) => ax * bz - az * bx, pA = [-A.dz, A.dx], pN = [-Nx.dz, Nx.dx], det = cross(A.dx, A.dz, Nx.dx, Nx.dz);
  if (gap > 3.05 || Math.abs(det) < 1e-3) return null;
  const E1 = [A.px + pA[0] * A.hw, A.pz + pA[1] * A.hw], E2 = [Nx.px - pN[0] * Nx.hw, Nx.pz - pN[1] * Nx.hw];
  const D = [E2[0] - E1[0], E2[1] - E1[1]], a = cross(D[0], D[1], Nx.dx, Nx.dz) / det, b = cross(D[0], D[1], A.dx, A.dz) / det;
  if (a >= -0.2 || b >= -0.2) return null;
  const X = [E1[0] + a * A.dx, E1[1] + a * A.dz], fr = Math.min(-a, -b, 0.35 * maxW + 2);
  const S1 = [X[0] + fr * A.dx, X[1] + fr * A.dz], S2 = [X[0] + fr * Nx.dx, X[1] + fr * Nx.dz], curve = [];
  for (let s = 0; s <= 8; s++) { const t = s / 8, m = 1 - t; curve.push([m * m * S1[0] + 2 * m * t * X[0] + t * t * S2[0], m * m * S1[1] + 2 * m * t * X[1] + t * t * S2[1]]); }
  return { E1, E2, X, S1, S2, fr, curve };
}
const jType = (j) => (j._arms.some((a) => a.type === 'highway') ? 2 : j._arms.some((a) => a.type === 'city') ? 1 : 0); // road type used for a junction's asphalt look

export function buildRoads({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, driveSide = 'right', signStyle = 'us' }) {
  const mat = makeRoadMaterial(THREE, junctions, signStyle);
  const B = new Buf(), colliders = [], geos = [];
  const terrN = (x, z) => { const e = 1, gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e), l = Math.hypot(gx, 1, gz); return [-gx / l, 1 / l, -gz / l]; };
  const UP = [0, 1, 0];

  // ribbon: 5 vertices across [-hw-K, -hw, 0, hw, hw+K]; flat y (bridge) or draped on the terrain
  function ribbon(pts, hw, kind, lift, bridge, sf = 0, ow = 0, ty = 0) {
    if (pts.length < 2) return;
    const lats = [-hw - KERB, -hw, 0, hw, hw + KERB], base = B.pos.length / 3;
    for (const p of pts) for (const l of lats) {
      const x = p.x - p.tz * l, z = p.z + p.tx * l;
      B.vert(x, (bridge ? p.y : heightAt(x, z)) + lift, z, bridge ? UP : terrN(x, z), p.u, l, hw, kind, sf, ow, ty);
    }
    for (let k = 0; k < pts.length - 1; k++) for (let j = 0; j < 4; j++) {
      const a = base + k * 5 + j, b = a + 1, c = a + 5, d = c + 1;
      B.idx.push(a, b, c, b, d, c);
    }
  }
  const quad = (x0, z0, x1, z1, x2, z2, x3, z3, kind, lift) => { // corners in order a(-,-) b(-,+) c(+,-) d(+,+) as used by ribbon()
    const ids = [[x0, z0], [x1, z1], [x2, z2], [x3, z3]].map(([x, z]) => B.vert(x, heightAt(x, z) + lift, z, UP, x, z, 1e4, kind));
    B.idx.push(ids[0], ids[1], ids[2], ids[1], ids[3], ids[2]);
  };

  const roundabouts = junctions.filter((j) => j.style === 'roundabout');
  const bridgeRuns = [], arrows = [];

  // ---- per-road runs: split at bridge changes and at roundabout trims; extend dead ends into junction centres ----
  for (const road of roads) {
    const P = polyOf(road), hw = road.width / 2;
    let S = [];
    for (let i = 0; i < P.n; i++) { const m = road.points[P.seg[i]]; S.push({ x: P.x[i], z: P.z[i], y: P.y[i], u: P.s[i], tx: P.tx[i], tz: P.tz[i], bridge: !!P.b[i], sf: Math.max(0, SURFACES.indexOf(m.surface)), ow: m.oneway ? 1 : 0, ty: Math.max(0, ROAD_TYPES.indexOf(m.type)) }); }
    for (const j of junctions) { // road ends that terminate in a junction patch reach the junction centre (no gap)
      if (j.style === 'roundabout') continue;
      for (const arm of j._arms) if (arm.road === roads.indexOf(road) && arm.end && arm.dir === 1) S.unshift({ x: j.x, z: j.z, y: j.y, u: -Math.hypot(S[0].x - j.x, S[0].z - j.z), tx: S[0].tx, tz: S[0].tz, bridge: false, sf: S[0].sf, ow: S[0].ow, ty: S[0].ty });
      else if (arm.road === roads.indexOf(road) && arm.end && arm.dir === -1) { const l = S[S.length - 1]; S.push({ x: j.x, z: j.z, y: j.y, u: l.u + Math.hypot(l.x - j.x, l.z - j.z), tx: l.tx, tz: l.tz, bridge: false, sf: l.sf, ow: l.ow, ty: l.ty }); }
    }
    const trims = roundabouts.map((j) => [j.x, j.z, Math.sqrt(Math.max(j._Ro * j._Ro - hw * hw, 0)) - 0.3]);
    const inside = (p) => trims.some(([cx, cz, r]) => Math.hypot(p.x - cx, p.z - cz) < r);
    const runs = []; let run = null;
    const cut = (a, b) => { let lo = 0, hi = 1; const ia = inside(a); for (let it = 0; it < 16; it++) { const m = (lo + hi) / 2; (inside(lerpSample(a, b, m)) === ia ? (lo = m) : (hi = m)); } return lerpSample(a, b, (lo + hi) / 2); };
    for (let k = 0; k < S.length; k++) {
      const p = S[k], ins = inside(p), prev = S[k - 1];
      if (ins) { if (run) { run.pts.push(cut(prev, p)); run = null; } continue; }
      if (!run) { run = { pts: [], bridge: p.bridge, sf: p.sf, ow: p.ow, ty: p.ty }; runs.push(run); if (prev && inside(prev)) run.pts.push(cut(prev, p)); }
      else if (p.bridge !== run.bridge || p.sf !== run.sf || p.ow !== run.ow || p.ty !== run.ty) { run.pts.push(p); run = { pts: [p], bridge: p.bridge, sf: p.sf, ow: p.ow, ty: p.ty }; runs.push(run); continue; }
      run.pts.push(p);
    }
    for (const r of runs) {
      if (r.pts.length < 2) continue;
      ribbon(r.pts, hw, r.bridge ? 5 : 0, LIFT_ROAD, r.bridge, r.sf, r.ow, r.ty);
      if (r.ow && !r.bridge) arrows.push({ pts: r.pts, hw });
      if (r.bridge) bridgeRuns.push({ pts: r.pts, hw });
    }
  }

  // ---- roundabout rings + islands; junction patches + stop lines ----
  const islands = [];
  for (const j of roundabouts) {
    const Rr = j._Ro - j._ringW / 2, C = 2 * Math.PI * Rr, steps = Math.max(24, Math.ceil(C)), uScale = Math.max(1, Math.round(C / MARK_PERIOD)) * MARK_PERIOD / C;
    const pts = [];
    for (let i = 0; i <= steps; i++) { const a = (i / steps) * 2 * Math.PI; pts.push({ x: j.x + Math.cos(a) * Rr, z: j.z + Math.sin(a) * Rr, y: j.y, u: (i / steps) * C * uScale, tx: -Math.sin(a), tz: Math.cos(a) }); }
    ribbon(pts, j._ringW / 2, 1, LIFT_RING, false, 0, 0, jType(j));
    islands.push(j);
    for (const arm of j._arms) stopLine(j, arm, j._Ro + 2.0, false);
  }
  for (const j of junctions) {
    if (j.style !== 'junction' && j.style !== 'signals') continue;
    const arms = j._arms.map((a) => {
      const P = polyOf(roads[a.road]); let i = a.idx, acc = 0;
      while (i + a.dir >= 0 && i + a.dir < P.n && acc < j._L) { acc += Math.hypot(P.x[i + a.dir] - P.x[i], P.z[i + a.dir] - P.z[i]); i += a.dir; }
      const dx = P.tx[i] * a.dir, dz = P.tz[i] * a.dir;
      return { ...a, ai: i, px: P.x[i], pz: P.z[i], dx, dz, ang: Math.atan2(dz, dx), hw: a.width / 2 };
    }).sort((p, q) => p.ang - q.ang);
    j._anch = arms;
    const poly = [], n = arms.length, corners = [];
    for (let i = 0; i < n; i++) {
      const A = arms[i], Nx = arms[(i + 1) % n], pA = [-A.dz, A.dx];
      poly.push(A.px - pA[0] * A.hw, A.pz - pA[1] * A.hw, A.px + pA[0] * A.hw, A.pz + pA[1] * A.hw); // minus edge, plus edge (CCW)
      let gap = Nx.ang - A.ang; if (gap <= 0) gap += 2 * Math.PI;
      const fil = n < 2 ? null : cornerFillet(A, Nx, gap, j._maxW);
      corners.push({ A, Nx, gap, fil });
      if (fil) for (const c of fil.curve) poly.push(c[0], c[1]);
    }
    j._poly = poly; j._corners = corners; const jty = jType(j);
    let area = 0; for (let i = 0, k = poly.length - 2; i < poly.length; k = i, i += 2) area += poly[k] * poly[i + 1] - poly[i] * poly[k + 1];
    const c = B.vert(j.x, heightAt(j.x, j.z) + LIFT_PATCH, j.z, UP, j.x, j.z, 1e4, 3, 0, 0, jty), vs = [];
    for (let i = 0; i < poly.length; i += 2) vs.push(B.vert(poly[i], heightAt(poly[i], poly[i + 1]) + LIFT_PATCH, poly[i + 1], UP, poly[i], poly[i + 1], 1e4, 3, 0, 0, jty));
    for (let i = 0; i < vs.length; i++) { const p = vs[i], q = vs[(i + 1) % vs.length]; area > 0 ? B.idx.push(c, q, p) : B.idx.push(c, p, q); }
    if (j.style === 'junction') for (const a of arms) stopLine(j, a, j._L + 1.2, true);
  }
  // signals junctions: zebra on every arm, stop line (incoming lane) before it, signal posts / railings are built with the edge props below
  const plans = junctions.filter((j) => j.style === 'signals').map((j) => ({ j, plan: planSignals(j, roads, heightAt, driveSide) }));
  for (const { j, plan } of plans) {
    for (const z of plan.zebras) zebra(z.x, z.z, z.tx, z.tz, z.hw, jType(j));
    for (const s of plan.stops) decalRect(s.x, s.z, s.dx, s.dz, -0.25, 0.25, s.l0, s.l1);
  }
  // paint rectangle: along s0..s1, lateral l0..l1 (lateral axis = (-dz, dx)) around (px,pz) heading (dx,dz)
  function decalRect(px, pz, dx, dz, s0, s1, l0, l1) {
    const nx = -dz, nz = dx;
    quad(px + dx * s0 + nx * l0, pz + dz * s0 + nz * l0, px + dx * s0 + nx * l1, pz + dz * s0 + nz * l1, px + dx * s1 + nx * l0, pz + dz * s1 + nz * l0, px + dx * s1 + nx * l1, pz + dz * s1 + nz * l1, 2, LIFT_DECAL);
  }
  // ponytail: the zebra quad repaints plain asphalt under its stripes (worn / pothole texture and the centre line are hidden there); a stencil / alpha decal would keep them
  // zebra crossing across a carriageway (half width hw, centre cx,cz, heading tx,tz): 3 m deep, stripes drawn by the road shader (kind 6, stripe count in meta.x)
  function zebra(cx, cz, tx, tz, hw, ty) {
    const nl = Math.max(1, Math.ceil(2 * hw / 2.5)), stripes = Math.max(1, Math.floor((2 * hw - 0.8) / 1.0)), base = B.pos.length / 3;
    for (const a of [-1.5, 0, 1.5]) for (let c = 0; c <= nl; c++) {
      const l = -hw + 2 * hw * c / nl, x = cx + tx * a - tz * l, z = cz + tz * a + tx * l;
      B.vert(x, heightAt(x, z) + LIFT_DECAL, z, UP, l, a, hw, 6, stripes, 0, ty);
    }
    for (let r = 0; r < 2; r++) for (let c = 0; c < nl; c++) { const a0 = base + r * (nl + 1) + c, c0 = a0 + nl + 1; B.idx.push(a0, a0 + 1, c0, a0 + 1, c0 + 1, c0); }
  }
  // paint decals across an arm at arc distance `d` from the centre: stop line (+ optional crosswalk stripes toward the centre)
  function stopLine(j, arm, d, crosswalk) {
    const P = polyOf(roads[arm.road]); let i = arm.idx, acc = 0;
    while (i + arm.dir >= 0 && i + arm.dir < P.n && acc < d) { acc += Math.hypot(P.x[i + arm.dir] - P.x[i], P.z[i + arm.dir] - P.z[i]); i += arm.dir; }
    if (acc < d - 0.5) return; // arm too short
    const dx = P.tx[i] * arm.dir, dz = P.tz[i] * arm.dir, hw = arm.width / 2 - 0.6, px = P.x[i], pz = P.z[i];
    const rect = (s0, s1, l0, l1) => decalRect(px, pz, dx, dz, s0, s1, l0, l1);
    rect(-0.25, 0.25, -hw, hw);
    if (crosswalk) for (let l = -hw + 0.3; l + 0.5 <= hw; l += 1.0) rect(-3.2, -0.7, l, l + 0.5);
  }
  // crosswalk feature (any road type): zebra across the carriageway at the node + two pedestrian signs (below); skipped on bridges / inside junctions by collectFeatures
  const cw = crosswalkPlan({ roads, features: collectFeatures(roads, junctions), driveSide });
  for (const z of cw.zebras) zebra(z.x, z.z, z.tx, z.tz, z.hw, z.ty);

  // ---- one-way arrows: painted decals every ARROW_PERIOD m along the point order (one per lane when the road is wide) ----
  for (const { pts, hw } of arrows) {
    let next = pts[0].u + 15;
    for (const p of pts) {
      if (p.u < next) continue;
      next = p.u + ARROW_PERIOD;
      if (junctions.some((j) => Math.hypot(p.x - j.x, p.z - j.z) < j._extent + 4)) continue;
      const nx = -p.tz, nz = p.tx;
      for (const lc of hw >= 3.5 ? [-hw / 2, hw / 2] : [0]) {
        const px = p.x + nx * lc, pz = p.z + nz * lc;
        const r = (s0, s1, l0, l1) => quad(px + p.tx * s0 + nx * l0, pz + p.tz * s0 + nz * l0, px + p.tx * s0 + nx * l1, pz + p.tz * s0 + nz * l1, px + p.tx * s1 + nx * l0, pz + p.tz * s1 + nz * l0, px + p.tx * s1 + nx * l1, pz + p.tz * s1 + nz * l1, 2, LIFT_DECAL);
        r(-1.6, 0.55, -0.13, 0.13);
        const at = (s, l) => [px + p.tx * s + nx * l, pz + p.tz * s + nz * l], a = at(0.5, -0.55), b = at(0.5, 0.55), t = at(1.9, 0);
        quad(a[0], a[1], b[0], b[1], t[0], t[1], t[0], t[1], 2, LIFT_DECAL); // head = quad with two coincident tip corners
      }
    }
  }

  // ---- main road mesh: one draw call for ribbons, rings, patches and paint ----
  const g = new THREE.BufferGeometry();
  const IdxT = B.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
  g.setAttribute('aRuv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('aHalf', new THREE.Float32BufferAttribute(B.half, 1));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(B.kind, 1));
  g.setAttribute('aMeta', new THREE.Float32BufferAttribute(B.meta, 2));
  g.setIndex(new THREE.BufferAttribute(new IdxT(B.idx), 1));
  g.computeBoundingSphere(); geos.push(g);
  const roadMesh = new THREE.Mesh(g, mat); roadMesh.name = 'roads'; roadMesh.matrixAutoUpdate = false;

  const group = new THREE.Group(); group.name = 'roadGroup'; group.add(roadMesh);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9c9a92, roughness: 0.9 });
  const mats = [mat, concrete];

  // ---- bridges: slab (walls + underside, flat shaded), rails and pillars; Rapier trimesh for the deck ----
  if (bridgeRuns.length) {
    // ponytail: slab ends are open (they sit buried in the banks); rails/pillars are plain boxes with no colliders.
    const sp = [], si = [], bp = [], bn = [], bi = [];
    const box = (cx, y0, cz, dx, dz, along, lat, h) => { // vertical box, axis-aligned to direction (dx,dz)
      const nx = -dz, nz = dx, c = [];
      for (const sa of [-1, 1]) for (const sl of [-1, 1]) for (const sy of [0, 1]) c.push([cx + dx * along * sa / 2 + nx * lat * sl / 2, y0 + h * sy, cz + dz * along * sa / 2 + nz * lat * sl / 2]);
      // corner index = sa*4 + sl*2 + sy (with sa,sl mapped -1->0, 1->1); faces listed with outward normals
      const f = [[0, 1, 3, 2, [-dx, 0, -dz]], [4, 6, 7, 5, [dx, 0, dz]], [0, 4, 5, 1, [-nx, 0, -nz]], [2, 3, 7, 6, [nx, 0, nz]], [1, 5, 7, 3, [0, 1, 0]], [0, 2, 6, 4, [0, -1, 0]]];
      for (const [a, b, d, e, n] of f) {
        const v0 = bp.length / 3; for (const k of [a, b, d, e]) { bp.push(...c[k]); bn.push(...n); }
        // orient by the stated normal
        const A = c[a], Bv = c[b], D = c[d], ux = Bv[0] - A[0], uy = Bv[1] - A[1], uz = Bv[2] - A[2], wx = D[0] - Bv[0], wy = D[1] - Bv[1], wz = D[2] - Bv[2];
        const cx_ = uy * wz - uz * wy, cy_ = uz * wx - ux * wz, cz_ = ux * wy - uy * wx;
        (cx_ * n[0] + cy_ * n[1] + cz_ * n[2] >= 0) ? bi.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3) : bi.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
      }
    };
    for (const { pts, hw } of bridgeRuns) {
      const hs = hw + KERB, n = pts.length, base = sp.length; // float offset of this run in sp (vertex index = base / 3); was sp.length / 3: every bridge run after the first got garbage indices / a broken trimesh
      for (const p of pts) for (const [l, dy] of [[1, 0], [-1, 0], [1, -DECK_T], [-1, -DECK_T]]) sp.push(p.x - p.tz * hs * l, p.y + dy, p.z + p.tx * hs * l); // TL TR BL BR
      const col = []; // trimesh indices: top, bottom, left wall, right wall (all outward)
      for (let k = 0; k < n - 1; k++) {
        const r = base / 3 + k * 4, q = r + 4, TL = 0, TR = 1, BL = 2, BR = 3;
        col.push(r + TR, r + TL, q + TR, r + TL, q + TL, q + TR);               // top (up)
        col.push(r + BR, q + BR, r + BL, r + BL, q + BR, q + BL);               // bottom (down)
        col.push(r + TL, r + BL, q + TL, q + TL, r + BL, q + BL);               // left wall (+n)
        col.push(r + TR, q + TR, r + BR, q + TR, q + BR, r + BR);               // right wall (-n)
      }
      for (let k = 0; k < col.length; k += 24) si.push(...col.slice(k + 6, k + 24)); // visual slab = all but the top face (the road ribbon is the top)
      // rails along both edges (every 2nd sample) and pillars every ~12 m
      for (let k = 0; k + 2 < n; k += 2) {
        const a = pts[k], b2 = pts[k + 2], dx = b2.x - a.x, dz = b2.z - a.z, L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
        for (const sl of [-1, 1]) { const lat = (hw + 0.25) * sl, mx = (a.x + b2.x) / 2 - uz * lat, mz = (a.z + b2.z) / 2 + ux * lat; box(mx, (a.y + b2.y) / 2 + 0.03, mz, ux, uz, L + 0.04, 0.25, 1.0); }
      }
      let next = 6;
      for (let k = 0; k < n; k++) if (pts[k].u - pts[0].u >= next) {
        next += 12; const p = pts[k];
        for (const sl of [-1, 1]) {
          const lat = (hw - 1.0) * sl, x = p.x - p.tz * lat, z = p.z + p.tx * lat, g0 = heightAt(x, z) - 0.6, top = p.y - DECK_T;
          if (top - g0 > 0.4) box(x, g0, z, p.tx, p.tz, 0.9, 0.9, top - g0);
        }
      }
      if (physicsWorld) {
        const verts = new Float32Array(sp.slice(base, sp.length)), ind = new Uint32Array(col.map((v) => v - base / 3));
        const c = physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(verts, ind).setFriction(1.0)); colliders.push(c);
      }
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setIndex(si);
    const sgn = sg.toNonIndexed(); sgn.computeVertexNormals(); sg.dispose(); geos.push(sgn);
    group.add(new THREE.Mesh(sgn, concrete));
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); rg.setAttribute('normal', new THREE.Float32BufferAttribute(bn, 3)); rg.setIndex(bi); geos.push(rg);
    group.add(new THREE.Mesh(rg, concrete));
  }

  // ---- roundabout islands: raised kerbed grass disc + static cylinder collider ----
  const grass = new THREE.MeshStandardMaterial({ color: 0x4d8a2c, roughness: 1 }), kerbM = new THREE.MeshStandardMaterial({ color: 0xbcbab2, roughness: 0.85 });
  mats.push(grass, kerbM);
  for (const j of islands) {
    const Rin = j._Ri, H = 0.18, y = j.y;
    const gs = [
      [new THREE.CylinderGeometry(Rin, Rin, H, 48, 1, true).translate(0, H / 2, 0), kerbM],
      [new THREE.RingGeometry(Rin - 0.6, Rin, 48).rotateX(-Math.PI / 2).translate(0, H, 0), kerbM],
      [new THREE.CircleGeometry(Rin - 0.6, 48).rotateX(-Math.PI / 2).translate(0, H + 0.002, 0), grass],
    ];
    for (const [geo, m] of gs) { geo.translate(j.x, y, j.z); geos.push(geo); group.add(new THREE.Mesh(geo, m)); }
    if (physicsWorld) colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cylinder(0.7, Rin).setTranslation(j.x, y + H - 0.7, j.z).setFriction(1.0)));
  }

  // ---- edges (fence / guardrail / barrier / lamps), node features (bump / rumble / roadworks), automatic warning signs ----
  const E = buildEdges({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, driveSide, geos, colliders });
  mats.push(...E.mats);
  group.add(E.edges, E.props);
  const signs = detectSigns({ roads, junctions, driveSide }).concat(E.info.workSigns);
  const S = buildSigns({ THREE, RAPIER, physicsWorld, signs: signs.concat(cw.signs), style: signStyle, heightAt, geos });
  colliders.push(...S.colliders);
  group.add(S.group);
  // city: kerb + footpath + corner blocks (one mesh, trimesh colliders); signals junctions: posts, lights, railings (instanced)
  const drops = cw.drops; for (const { plan } of plans) for (const d of plan.drops) drops[d.road].push([d.s0, d.s1]);
  const city = buildCity({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, geos, colliders, mats, drops });
  group.add(city.group);
  const SG = buildSignalObjects({ THREE, RAPIER, physicsWorld, plans: plans.map((p) => p.plan), geos, colliders, mats });
  E.props.add(SG.group);
  for (const { j, plan } of plans) j._signals = plan.posts.map((p) => ({ x: p.x, y: p.y, z: p.z, roadId: p.roadId, group: p.group, fx: p.fx, fz: p.fz }));
  let drawCalls = 0; group.traverse((o) => { if (o.isMesh) drawCalls++; });
  // roadDetail: what was generated (tests, HUDs, the vehicle code): signs[] (see roadSigns.js detectSigns), edge pieces, features, counts
  // city / signals / crosswalk extras are additive: footpaths (pieces: {road, side, ax,az (kerb start), bx,bz (kerb end), hmax, len, collider}), cornerBlocks (polygons),
  // zebras (crosswalk features + signals arms), crosswalkSigns, signals (posts per junction)
  const detail = { signs, edgePieces: E.info.pieces, colliderBoxes: E.info.colliderBoxes, lamps: E.info.lamps, features: E.info.features, drawCalls,
    footpaths: city.pieces, cornerBlocks: city.corners, zebras: cw.zebras.concat(plans.flatMap((p) => p.plan.zebras.map((z) => ({ ...z, junction: junctions.indexOf(p.j) })))), crosswalkSigns: cw.signs,
    signals: plans.map((p) => ({ junction: junctions.indexOf(p.j), posts: p.j._signals })),
    counts: { signs: signs.length, signInstances: S.instances, signDrawCalls: S.drawCalls, edgeInstances: E.stats.instances, edgeDrawCalls: E.stats.drawCalls, pieces: E.stats.pieces, colliders: E.stats.colliders + S.colliders.length, features: E.stats.features,
      footpathPieces: city.pieces.length, footpathColliders: city.stats.colliders, cornerBlocks: city.corners.length, cityDrawCalls: city.stats.drawCalls, zebras: cw.zebras.length + plans.reduce((s, p) => s + p.plan.zebras.length, 0), crosswalkSigns: cw.signs.length,
      signalPosts: SG.counts.posts, signalRails: SG.counts.rails, signalDrawCalls: SG.drawCalls, signalColliders: SG.counts.colliders } };

  return {
    group, roadMesh, material: mat, colliders, edgesGroup: E.edges, propsGroup: E.props, signsGroup: S.group, detail, footprints: city.footprints,
    setTime(t) { SG.uTime.value = t; }, // signal light cycle clock (seconds), see roadSignals.js
    dispose(world) { for (const c of colliders) world && world.removeCollider(c, false); for (const g2 of geos) g2.dispose(); for (const m of mats) m.dispose(); mat.userData.uniforms.uNoise.value.dispose(); },
  };
}
