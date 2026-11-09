// Road network for the map loader: junction detection, terrain stamping, road/bridge/junction/roundabout meshes and
// the analytic "is this point road?" query. No imports (THREE / RAPIER are injected), like mapLoader.js.
//
// Everything is in world metres, XZ plane. Road samples come from road.getPoints(1) (uniform Catmull-Rom, ~1 m apart).

const LIFT_ROAD = 0.03, LIFT_RING = 0.04, LIFT_PATCH = 0.045, LIFT_DECAL = 0.06; // metres above terrain (+ polygonOffset)
const KERB = 0.5;         // shoulder strip beyond each road edge (gravel on ground, concrete on bridges)
const DECK_T = 0.7;       // bridge slab thickness
const MARK_PERIOD = 9, MARK_DASH = 3; // centre dashes: 3 m paint, 6 m gap

// ------------------------------------------------------------------ polylines
const polyCache = new WeakMap();
export function polyOf(road) {
  let p = polyCache.get(road);
  if (p) return p;
  const pts = road.getPoints(1), n = pts.length;
  p = { n, x: new Float64Array(n), z: new Float64Array(n), y: new Float64Array(n), b: new Uint8Array(n), tx: new Float64Array(n), tz: new Float64Array(n), s: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    p.x[i] = q.x; p.z[i] = q.z; p.y[i] = q.y; p.b[i] = q.bridge ? 1 : 0; p.tx[i] = q.tx; p.tz[i] = q.tz;
    if (i) p.s[i] = p.s[i - 1] + Math.hypot(q.x - p.x[i - 1], q.z - p.z[i - 1]);
  }
  polyCache.set(road, p);
  return p;
}

function nearestOnPoly(p, x, z) {
  let best = { d: Infinity, i: 0, t: 0, x: 0, z: 0 };
  for (let i = 0; i < p.n - 1; i++) {
    const ax = p.x[i], az = p.z[i], bx = p.x[i + 1] - ax, bz = p.z[i + 1] - az, l2 = bx * bx + bz * bz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / l2)) : 0;
    const d = Math.hypot(ax + bx * t - x, az + bz * t - z);
    if (d < best.d) best = { d, i, t, x: ax + bx * t, z: az + bz * t };
  }
  return best;
}

// ------------------------------------------------------------------ junction detection
// Returns junction objects { x, z, y, style, radius, arms:[{roadId, angle, width}], _arms (internal), ... }.
export function detectJunctions(roads, heightAt, overrides = []) {
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
  // T / Y / L: a road END within about one road width of another road's centreline (or its end)
  for (let a = 0; a < roads.length; a++) for (const e of [0, polys[a].n - 1]) {
    const A = polys[a];
    for (let b = 0; b < roads.length; b++) {
      if (a === b) continue;
      const B = polys[b], w = Math.max(roads[a].width, roads[b].width), hit = nearestOnPoly(B, A.x[e], A.z[e]);
      if (hit.d > w) continue;
      if (A.b[Math.min(e, A.n - 2)] || B.b[hit.i] || B.b[hit.i + 1] || Math.abs(A.y[e] - yAt(B, hit.i, hit.t)) > 4) continue;
      const atEnd = (hit.i === 0 && hit.t === 0) || (hit.i === B.n - 2 && hit.t === 1);
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
      const P = polys[ri], near = nearestOnPoly(P, x, z), w = road.width;
      if (near.d > Math.max(w * 1.5, 6)) return; // this road is not part of the cluster
      const i = near.t > 0.5 ? near.i + 1 : near.i, s = P.s[i] + 0; // nearest sample
      const push = (dir, end) => arms.push({ road: ri, roadId: road.id, dir, end, idx: i, width: w, dx: P.tx[i] * dir, dz: P.tz[i] * dir, angle: Math.atan2(P.tz[i] * dir, P.tx[i] * dir) });
      if (s < w) push(1, true); else if (P.s[P.n - 1] - s < w) push(-1, true); else { push(1, false); push(-1, false); }
    });
    if (arms.length < 2) continue;
    const maxW = Math.max(...arms.map((a) => a.width));
    const style = arms.length >= 4 ? 'roundabout' : 'junction';
    junctions.push({ x, z, y: heightAt(x, z), style, radius: 0, arms: arms.map((a) => ({ roadId: a.roadId, angle: a.angle, width: a.width })), _arms: arms, _maxW: maxW });
  }
  // optional override file: [{x,z,style,radius}] matched to the nearest detected junction within 15 m
  for (const o of overrides) {
    let best = null, bd = 15;
    for (const j of junctions) { const d = Math.hypot(j.x - o.x, j.z - o.z); if (d < bd) { bd = d; best = j; } }
    if (!best) continue;
    if (o.style === 'junction' || o.style === 'roundabout' || o.style === 'none') best.style = o.style;
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
      const seg = [P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], hw * hw];
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = cx * 100003 + cz; (grid.get(k) || grid.set(k, []).get(k)).push(seg); }
    }
  }
  return (x, z) => {
    for (const j of junctions) {
      const d = Math.hypot(x - j.x, z - j.z);
      if (j.style === 'roundabout') { if (d < j._Ri) return false; if (d <= j._Ro) return true; }
      else if (d <= j._L && j._poly && pointInPoly(j._poly, x, z)) return true;
    }
    for (const s of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) || []) {
      const bx = s[2] - s[0], bz = s[3] - s[1], l2 = bx * bx + bz * bz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * bx + (z - s[1]) * bz) / l2)) : 0, dx = s[0] + bx * t - x, dz = s[1] + bz * t - z;
      if (dx * dx + dz * dz <= s[4]) return true;
    }
    return false;
  };
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

function makeRoadMaterial(THREE, junctions) {
  const J = junctions.filter((j) => j.style !== 'none').slice(0, 32); // ponytail: 32 marking-mask discs max; extra junctions keep their dashes
  const discs = Array.from({ length: 32 }, (_, i) => new THREE.Vector4(J[i] ? J[i].x : 0, J[i] ? J[i].z : 0, J[i] ? (J[i].style === 'roundabout' ? J[i]._Ro : J[i]._L - 0.5) : -1, 3.5)); // w = extra clearance for the centre dashes only (they stop before the stop line)
  const uniforms = { uNoise: { value: noiseTexture(THREE) }, uJ: { value: discs }, uJCount: { value: J.length } };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'road-v1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aRuv;\nattribute float aHalf;\nattribute float aKind;\nvarying vec2 vRuv;\nvarying float vHalf;\nvarying float vKind;\nvarying vec3 vRWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRuv = aRuv; vHalf = aHalf; vKind = aKind; vRWP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vRuv; varying float vHalf; varying float vKind; varying vec3 vRWP;
uniform sampler2D uNoise; uniform vec4 uJ[32]; uniform int uJCount;
// box-filtered coverage of the interval [a,b] by a pixel footprint of width f centred at x: analytic anti-aliasing,
// exact for sub-pixel lines (they fade into the asphalt instead of shimmering)
float cov(float x, float a, float b, float f) { return clamp(min(x + 0.5 * f, b) - max(x - 0.5 * f, a), 0.0, f) / f; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float u = vRuv.x, v = vRuv.y;
  float fv = max(fwidth(v), 1e-4), fu = max(fwidth(u), 1e-4);
  float grain = texture2D(uNoise, vRWP.xz * 0.43).r, patchN = texture2D(uNoise, vRWP.xz * 0.031).g;
  vec3 asphalt = vec3(0.07) * (0.7 + 0.65 * grain) * (0.85 + 0.3 * patchN);
  vec3 col = asphalt;
  if (vKind > 1.5 && vKind < 2.5) col = vec3(0.62);            // paint decal (stop lines, crosswalk): geometry edges are the AA
  else if (vKind < 1.5 || vKind > 4.5) {                       // ribbon: 0 road, 1 roundabout ring, 5 bridge deck
    float inside = clamp((vHalf - abs(v)) / fv + 0.5, 0.0, 1.0); // hard road edge, one pixel of analytic AA
    vec3 shoulder = (vKind > 4.5 ? vec3(0.42) : vec3(0.30, 0.27, 0.21)) * (0.8 + 0.4 * grain);
    col = mix(shoulder, asphalt, inside);
    float mask = 1.0, cmask = 1.0;
    if (vKind < 0.5) for (int i = 0; i < 32; i++) { if (i >= uJCount) break; float d = length(vRWP.xz - uJ[i].xy); mask *= clamp((d - uJ[i].z) / 0.4 + 0.5, 0.0, 1.0); cmask *= clamp((d - uJ[i].z - uJ[i].w) / 0.4 + 0.5, 0.0, 1.0); }
    float edge = cov(v, vHalf - 0.45, vHalf - 0.30, fv) + cov(v, -vHalf + 0.30, -vHalf + 0.45, fv);
    float xm = mod(u, ${MARK_PERIOD.toFixed(1)});
    float dash = cov(xm, 0.0, ${MARK_DASH.toFixed(1)}, fu) + cov(xm - ${MARK_PERIOD.toFixed(1)}, 0.0, ${MARK_DASH.toFixed(1)}, fu);
    dash = mix(dash, ${(MARK_DASH / MARK_PERIOD).toFixed(4)}, smoothstep(2.0, 6.0, fu)); // far away: average coverage, no aliasing
    float centre = cov(v, -0.075, 0.075, fv) * dash;
    col = mix(col, vec3(0.6), clamp(edge * mask + centre * cmask, 0.0, 1.0) * inside);
  }
  diffuseColor.rgb = col;
}`);
  };
  return mat;
}

// ------------------------------------------------------------------ geometry helpers
class Buf {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.half = []; this.kind = []; this.idx = []; }
  vert(x, y, z, n, u, v, h, k) { const i = this.pos.length / 3; this.pos.push(x, y, z); this.nor.push(n[0], n[1], n[2]); this.uv.push(u, v); this.half.push(h); this.kind.push(k); return i; }
}
function lerpSample(a, b, t) {
  const tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t, l = Math.hypot(tx, tz) || 1;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, u: a.u + (b.u - a.u) * t, tx: tx / l, tz: tz / l, bridge: a.bridge };
}

export function buildRoads({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt }) {
  const mat = makeRoadMaterial(THREE, junctions);
  const B = new Buf(), colliders = [], geos = [];
  const terrN = (x, z) => { const e = 1, gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e), l = Math.hypot(gx, 1, gz); return [-gx / l, 1 / l, -gz / l]; };
  const UP = [0, 1, 0];

  // ribbon: 5 vertices across [-hw-K, -hw, 0, hw, hw+K]; flat y (bridge) or draped on the terrain
  function ribbon(pts, hw, kind, lift, bridge) {
    if (pts.length < 2) return;
    const lats = [-hw - KERB, -hw, 0, hw, hw + KERB], base = B.pos.length / 3;
    for (const p of pts) for (const l of lats) {
      const x = p.x - p.tz * l, z = p.z + p.tx * l;
      B.vert(x, (bridge ? p.y : heightAt(x, z)) + lift, z, bridge ? UP : terrN(x, z), p.u, l, hw, kind);
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
  const bridgeRuns = [];

  // ---- per-road runs: split at bridge changes and at roundabout trims; extend dead ends into junction centres ----
  for (const road of roads) {
    const P = polyOf(road), hw = road.width / 2;
    let S = [];
    for (let i = 0; i < P.n; i++) S.push({ x: P.x[i], z: P.z[i], y: P.y[i], u: P.s[i], tx: P.tx[i], tz: P.tz[i], bridge: !!P.b[i] });
    for (const j of junctions) { // road ends that terminate in a junction patch reach the junction centre (no gap)
      if (j.style === 'roundabout') continue;
      for (const arm of j._arms) if (arm.road === roads.indexOf(road) && arm.end && arm.dir === 1) S.unshift({ x: j.x, z: j.z, y: j.y, u: -Math.hypot(S[0].x - j.x, S[0].z - j.z), tx: S[0].tx, tz: S[0].tz, bridge: false });
      else if (arm.road === roads.indexOf(road) && arm.end && arm.dir === -1) { const l = S[S.length - 1]; S.push({ x: j.x, z: j.z, y: j.y, u: l.u + Math.hypot(l.x - j.x, l.z - j.z), tx: l.tx, tz: l.tz, bridge: false }); }
    }
    const trims = roundabouts.map((j) => [j.x, j.z, Math.sqrt(Math.max(j._Ro * j._Ro - hw * hw, 0)) - 0.3]);
    const inside = (p) => trims.some(([cx, cz, r]) => Math.hypot(p.x - cx, p.z - cz) < r);
    const runs = []; let run = null;
    const cut = (a, b) => { let lo = 0, hi = 1; const ia = inside(a); for (let it = 0; it < 16; it++) { const m = (lo + hi) / 2; (inside(lerpSample(a, b, m)) === ia ? (lo = m) : (hi = m)); } return lerpSample(a, b, (lo + hi) / 2); };
    for (let k = 0; k < S.length; k++) {
      const p = S[k], ins = inside(p), prev = S[k - 1];
      if (ins) { if (run) { run.pts.push(cut(prev, p)); run = null; } continue; }
      if (!run) { run = { pts: [], bridge: p.bridge }; runs.push(run); if (prev && inside(prev)) run.pts.push(cut(prev, p)); }
      else if (p.bridge !== run.bridge) { run.pts.push(p); run = { pts: [p], bridge: p.bridge }; runs.push(run); continue; }
      run.pts.push(p);
    }
    for (const r of runs) {
      if (r.pts.length < 2) continue;
      ribbon(r.pts, hw, r.bridge ? 5 : 0, LIFT_ROAD, r.bridge);
      if (r.bridge) bridgeRuns.push({ pts: r.pts, hw });
    }
  }

  // ---- roundabout rings + islands; junction patches + stop lines ----
  const islands = [];
  for (const j of roundabouts) {
    const Rr = j._Ro - j._ringW / 2, C = 2 * Math.PI * Rr, steps = Math.max(24, Math.ceil(C)), uScale = Math.max(1, Math.round(C / MARK_PERIOD)) * MARK_PERIOD / C;
    const pts = [];
    for (let i = 0; i <= steps; i++) { const a = (i / steps) * 2 * Math.PI; pts.push({ x: j.x + Math.cos(a) * Rr, z: j.z + Math.sin(a) * Rr, y: j.y, u: (i / steps) * C * uScale, tx: -Math.sin(a), tz: Math.cos(a) }); }
    ribbon(pts, j._ringW / 2, 1, LIFT_RING, false);
    islands.push(j);
    for (const arm of j._arms) stopLine(j, arm, j._Ro + 2.0, false);
  }
  for (const j of junctions) {
    if (j.style !== 'junction') continue;
    const arms = j._arms.map((a) => {
      const P = polyOf(roads[a.road]); let i = a.idx, acc = 0;
      while (i + a.dir >= 0 && i + a.dir < P.n && acc < j._L) { acc += Math.hypot(P.x[i + a.dir] - P.x[i], P.z[i + a.dir] - P.z[i]); i += a.dir; }
      const dx = P.tx[i] * a.dir, dz = P.tz[i] * a.dir;
      return { ...a, px: P.x[i], pz: P.z[i], dx, dz, ang: Math.atan2(dz, dx), hw: a.width / 2 };
    }).sort((p, q) => p.ang - q.ang);
    j._anch = arms;
    const poly = [], n = arms.length, cross = (ax, az, bx, bz) => ax * bz - az * bx;
    for (let i = 0; i < n; i++) {
      const A = arms[i], Nx = arms[(i + 1) % n], pA = [-A.dz, A.dx], pN = [-Nx.dz, Nx.dx];
      poly.push(A.px - pA[0] * A.hw, A.pz - pA[1] * A.hw, A.px + pA[0] * A.hw, A.pz + pA[1] * A.hw); // minus edge, plus edge (CCW)
      const E1 = [A.px + pA[0] * A.hw, A.pz + pA[1] * A.hw], E2 = [Nx.px - pN[0] * Nx.hw, Nx.pz - pN[1] * Nx.hw];
      let gap = Nx.ang - A.ang; if (gap <= 0) gap += 2 * Math.PI;
      const det = cross(A.dx, A.dz, Nx.dx, Nx.dz);
      if (n < 2 || gap > 3.05 || Math.abs(det) < 1e-3) continue;
      const D = [E2[0] - E1[0], E2[1] - E1[1]], a = cross(D[0], D[1], Nx.dx, Nx.dz) / det, b = cross(D[0], D[1], A.dx, A.dz) / det;
      if (a >= -0.2 || b >= -0.2) continue;
      const X = [E1[0] + a * A.dx, E1[1] + a * A.dz], fr = Math.min(-a, -b, 0.35 * j._maxW + 2);
      const S1 = [X[0] + fr * A.dx, X[1] + fr * A.dz], S2 = [X[0] + fr * Nx.dx, X[1] + fr * Nx.dz];
      for (let s = 0; s <= 8; s++) { const t = s / 8, m = 1 - t; poly.push(m * m * S1[0] + 2 * m * t * X[0] + t * t * S2[0], m * m * S1[1] + 2 * m * t * X[1] + t * t * S2[1]); }
    }
    j._poly = poly;
    let area = 0; for (let i = 0, k = poly.length - 2; i < poly.length; k = i, i += 2) area += poly[k] * poly[i + 1] - poly[i] * poly[k + 1];
    const c = B.vert(j.x, heightAt(j.x, j.z) + LIFT_PATCH, j.z, UP, j.x, j.z, 1e4, 3), vs = [];
    for (let i = 0; i < poly.length; i += 2) vs.push(B.vert(poly[i], heightAt(poly[i], poly[i + 1]) + LIFT_PATCH, poly[i + 1], UP, poly[i], poly[i + 1], 1e4, 3));
    for (let i = 0; i < vs.length; i++) { const p = vs[i], q = vs[(i + 1) % vs.length]; area > 0 ? B.idx.push(c, q, p) : B.idx.push(c, p, q); }
    for (const a of arms) stopLine(j, a, j._L + 1.2, true);
  }
  // paint decals across an arm at arc distance `d` from the centre: stop line (+ optional crosswalk stripes toward the centre)
  function stopLine(j, arm, d, crosswalk) {
    const P = polyOf(roads[arm.road]); let i = arm.idx, acc = 0;
    while (i + arm.dir >= 0 && i + arm.dir < P.n && acc < d) { acc += Math.hypot(P.x[i + arm.dir] - P.x[i], P.z[i + arm.dir] - P.z[i]); i += arm.dir; }
    if (acc < d - 0.5) return; // arm too short
    const dx = P.tx[i] * arm.dir, dz = P.tz[i] * arm.dir, nx = -dz, nz = dx, hw = arm.width / 2 - 0.6, px = P.x[i], pz = P.z[i];
    const rect = (s0, s1, l0, l1) => quad(px + dx * s0 + nx * l0, pz + dz * s0 + nz * l0, px + dx * s0 + nx * l1, pz + dz * s0 + nz * l1, px + dx * s1 + nx * l0, pz + dz * s1 + nz * l0, px + dx * s1 + nx * l1, pz + dz * s1 + nz * l1, 2, LIFT_DECAL);
    rect(-0.25, 0.25, -hw, hw);
    if (crosswalk) for (let l = -hw + 0.3; l + 0.5 <= hw; l += 1.0) rect(-3.2, -0.7, l, l + 0.5);
  }

  // ---- main road mesh: one draw call for ribbons, rings, patches and paint ----
  const g = new THREE.BufferGeometry();
  const IdxT = B.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
  g.setAttribute('aRuv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('aHalf', new THREE.Float32BufferAttribute(B.half, 1));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(B.kind, 1));
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
      const hs = hw + KERB, n = pts.length, base = sp.length / 3;
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

  return {
    group, roadMesh, material: mat, colliders,
    dispose(world) { for (const c of colliders) world && world.removeCollider(c, false); for (const g2 of geos) g2.dispose(); for (const m of mats) m.dispose(); mat.userData.uniforms.uNoise.value.dispose(); },
  };
}
