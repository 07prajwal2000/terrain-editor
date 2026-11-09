// Automatic bridges over water for the map loader (option autoBridge, see the header of mapLoader.js).
// Pure planning, no THREE / RAPIER: planAutoBridges() looks at the ~1 m road samples (roads.js polyOf), finds the stretches that would be drawn
// under the water surface and gives each road a deck table (road.setDeck) so that its samples become bridge samples with a planned deck y.
// Everything downstream (slab / rails / pillars / trimesh in roads.js, no edges / signs / features / footpaths / road surface) keys on the sample's bridge flag, so
// nothing else has to know about auto bridges.
//
// Algorithm per road (all along the ~1 m samples, arc length s):
//   1. wet sample: centreline or either edge (half width + KERB) has terrain below water + TOL (water = lake surface or sea level). Samples of an
//      editor-marked bridge count when there is water under the deck and the deck is below water + CLEARANCE (they get raised, they are never un-bridged).
//   2. runs of wet samples; runs shorter than MIN_WET_M that are not DEEP under the surface are dropped; runs less than MERGE_M apart merge.
//   3. target T = water + CLEARANCE (+ PAD for the smoothing loss) on wet samples, interpolated across merged gaps; envelope E = max over all T of
//      T - RAMP_GRADE * |ds| (the approach ramps); deck = max(road y, E). A span = a maximal range where E > road y.
//      Dry samples within REACH_M of a merged wet group are extra sources at their own height, so a steep bank (terrain falling faster than the ramp) is spanned from
//      its crest by a straight ramp instead of the deck following the bank down.
//   4. smoothing: box blur of the deck (BLUR_M) gives the ramp feet and the plateau corners a vertical curve (C1 where it meets the dry road); the span is where the
//      blurred deck is above the road (> 1 mm), its end samples are pinned to the road height; finally deck >= road y and >= water + CLEARANCE on wet samples.
//   5. a span whose ramps reach a junction footprint (stamped extent + blend) is skipped (the road stays on the terrain), reported in `skipped`.
// ponytail: grade is limited on the ramps over flat ground; a steep bank (terrain steeper than 8%) under a ramp keeps the terrain's own grade where the deck touches it,
// and a deck within DECK_H (0.8 m) of dry ground (the first ~11 m of every ramp) is treated by the vehicle code as ground (surfaceAt reports no road there).
import { polyOf, resetPoly, KERB } from './roads.js';

export const AUTO_BRIDGE = Object.freeze({
  CLEARANCE: 1.5,     // deck height above the water surface (m)
  TOL: 0.3,           // road y < water + TOL counts as wet (m)
  MIN_WET_M: 4,       // wet runs shorter than this are ignored ...
  DEEP: 0.5,          // ... unless the terrain is more than this below the water (m)
  MERGE_M: 20,        // wet runs closer than this (m of dry road) become one bridge
  MAX_GRADE: 0.08,    // cap on the approach ramp grade
  RAMP_GRADE: 0.07,   // the ramps are designed at this grade (the smoothing blur only lowers grades)
  BLUR_M: 4,          // deck smoothing half window (m): the vertical curves at the ramp feet / crests
  REACH_M: 40,        // a bank that falls away faster than RAMP_GRADE within this distance of the water is bridged from its crest (the deck does not follow the bank down)
  PAD: 0.2,           // extra target height so that the blur never takes the deck under water + CLEARANCE (m)
});

// -> { spans: [{ roadId, s0, s1, deckY0, deckY1, maxY, reason, raised, x0, z0, x1, z1, path }], skipped: [{ roadId, s0, s1, reason: 'junction' }] }
// waterAt(x, z) -> { level, kind: 'lake'|'ocean' } (the water SURFACE there, also where the terrain is above it)
export function planAutoBridges({ roads, junctions, heightAt, waterAt, opts = {} }) {
  const C = { ...AUTO_BRIDGE, ...opts }, spans = [], skipped = [];
  for (const road of roads) {
    road.autoBridges = [];
    const P = polyOf(road), n = P.n;
    if (n < 3) continue;
    const e = road.width / 2 + KERB, y0 = P.y, s = P.s;
    // ---- 1. wet samples ----
    const wet = new Uint8Array(n), deep = new Uint8Array(n), need = new Float64Array(n).fill(-Infinity), kind = new Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      for (const l of [0, e, -e]) {
        if (P.b[i] && l) continue; // a marked bridge: only the deck line
        const x = P.x[i] - P.tz[i] * l, z = P.z[i] + P.tx[i] * l, W = waterAt(x, z), h = heightAt(x, z);
        if (P.b[i] ? !(h < W.level && y0[i] < W.level + C.CLEARANCE) : !(h < W.level + C.TOL)) continue;
        wet[i] = 1; any = true; if (h < W.level - C.DEEP) deep[i] = 1;
        if (W.level + C.CLEARANCE > need[i]) { need[i] = W.level + C.CLEARANCE; kind[i] = W.kind; }
      }
    }
    if (!any) continue;
    // ---- 2. runs, filter, merge ----
    let runs = [];
    for (let i = 0; i < n; i++) if (wet[i]) {
      const r = runs[runs.length - 1];
      if (r && r.b === i - 1) { r.b = i; r.deep ||= !!deep[i]; r.mk ||= !!P.b[i]; } else runs.push({ a: i, b: i, deep: !!deep[i], mk: !!P.b[i] });
    }
    runs = runs.filter((r) => r.mk || r.deep || s[r.b] - s[r.a] >= C.MIN_WET_M);
    const kept = new Uint8Array(n); for (const r of runs) kept.fill(1, r.a, r.b + 1);
    const groups = [];
    for (const r of runs) { const g = groups[groups.length - 1]; if (g && s[r.a] - s[g.b] < C.MERGE_M) g.b = r.b; else groups.push({ a: r.a, b: r.b }); }
    // ---- 3. targets and the ramp envelope ----
    const T = new Float64Array(n).fill(-Infinity), inGroup = new Uint8Array(n); // inGroup: a merged group is ONE bridge even where its dry gap is above the deck line
    for (const g of groups) {
      inGroup.fill(1, g.a, g.b + 1);
      let last = -1;
      for (let i = g.a; i <= g.b; i++) {
        if (!kept[i]) continue; // dropped tiny runs inside a merged group count as gap
        T[i] = y0[i] >= need[i] ? y0[i] : need[i] + C.PAD;
        if (last >= 0 && i - last > 1) for (let k = last + 1; k < i; k++) T[k] = Math.max(y0[k], T[last] + (T[i] - T[last]) * (s[k] - s[last]) / (s[i] - s[last]));
        last = i;
      }
    }
    for (const g of groups) { // crest sources (see 3.)
      for (let i = g.a - 1; i >= 0 && s[g.a] - s[i] <= C.REACH_M; i--) if (!kept[i]) T[i] = Math.max(T[i], y0[i]);
      for (let i = g.b + 1; i < n && s[i] - s[g.b] <= C.REACH_M; i++) if (!kept[i]) T[i] = Math.max(T[i], y0[i]);
    }
    const E = Float64Array.from(T);
    for (let i = 1; i < n; i++) E[i] = Math.max(E[i], E[i - 1] - C.RAMP_GRADE * (s[i] - s[i - 1]));
    for (let i = n - 2; i >= 0; i--) E[i] = Math.max(E[i], E[i + 1] - C.RAMP_GRADE * (s[i + 1] - s[i]));
    const D0 = Float64Array.from(y0, (y, i) => Math.max(y, E[i]));
    // ---- 4. spans, smoothing ----
    const D = Float64Array.from(y0), mod = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      const on = (i) => E[i] > y0[i] + 1e-6 || inGroup[i];
      if (!on(a)) continue;
      let b = a; while (b + 1 < n && on(b + 1)) b++;
      const sa = s[a], sb = s[b];
      // the blur reaches BLUR_M beyond the span; junction footprint check covers that
      let lo = a, hi = b; while (lo > 0 && sa - s[lo - 1] <= C.BLUR_M) lo--; while (hi < n - 1 && s[hi + 1] - sb <= C.BLUR_M) hi++;
      const hit = junctions.some((j) => { const r = j._extent + j._blend; for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) if (Math.hypot(P.x[i] - j.x, P.z[i] - j.z) < r) return true; return false; });
      if (hit) { skipped.push({ roadId: road.id, s0: sa, s1: sb, reason: 'junction' }); a = b; continue; }
      let first = -1, last = -1;
      for (let i = lo; i <= hi; i++) {
        let sum = 0, cnt = 0;
        for (let k = i; k >= 0 && s[i] - s[k] <= C.BLUR_M; k--) { sum += D0[k]; cnt++; }
        for (let k = i + 1; k < n && s[k] - s[i] <= C.BLUR_M; k++) { sum += D0[k]; cnt++; }
        D[i] = Math.max(sum / cnt, y0[i], wet[i] && kept[i] ? need[i] : -Infinity);
        if (D[i] - y0[i] > 1e-3) { if (first < 0) first = i; last = i; }
      }
      if (first < 0) continue;
      if (first > 0) D[first] = y0[first]; // pinned: the deck meets the dry road exactly (the blurred deck is within 1 mm of it here)
      if (last < n - 1) D[last] = y0[last];
      let maxY = -Infinity, reason = 'lake', best = -Infinity, raised = false;
      for (let i = first; i <= last; i++) { mod[i] = 1; maxY = Math.max(maxY, D[i]); if (P.b[i]) raised = true; if (need[i] > best) { best = need[i]; reason = kind[i]; } }
      const sp = { roadId: road.id, s0: s[first], s1: s[last], deckY0: D[first], deckY1: D[last], maxY, reason, raised, x0: P.x[first], z0: P.z[first], x1: P.x[last], z1: P.z[last], path: [] };
      for (let i = first; i <= last; i += 4) sp.path.push(P.x[i], P.z[i]); sp.path.push(P.x[last], P.z[last]); // flat [x,z,...] every ~4 m (the editor draws it)
      spans.push(sp); road.autoBridges.push(sp);
      a = Math.max(b, last);
    }
    if (!mod.some((m) => m)) continue;
    road.setDeck({ u: P.u.slice(), y: D, mod, auto: Uint8Array.from(P.b, (b, i) => (mod[i] && !b ? 1 : 0)) });
    resetPoly(road);
    const Q = polyOf(road); // control points inside a span carry auto: true (the samples already carry bridge + auto)
    road.points.forEach((p, j) => { if (Q.a[Q.ci[j]]) p.auto = true; });
  }
  return { spans, skipped };
}
