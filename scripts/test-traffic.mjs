// Headless tests for traffic (src/world/traffic.js, trafficLanes.js, carModels.js): node scripts/test-traffic.mjs
// Lane graph on public/maps/city + citytest, 10 min headless sims on both (red lights, gaps, overlaps, zebra yielding, locks), churn / leaks, determinism by seed, perf.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadMap } from '../src/world/mapLoader.js';
import { signalState } from '../src/world/roadSignals.js';
import { createEntityWorld } from '../src/world/entities.js';
import { createTraffic, trafficCaps } from '../src/world/traffic.js';
import { CAR_TYPES, buildCarGeometries } from '../src/world/carModels.js';

let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 }); };
const load = async (name) => { mapDir = path.resolve('public/maps', name); return loadMap('/maps/x/', { THREE, physics: false }); };

// car models: triangle budget
{
  const { geos, dispose } = buildCarGeometries(THREE);
  assert(geos.length === CAR_TYPES.length && geos.every((g) => g.userData.tris <= 150), `fallback car models: ${geos.map((g) => g.userData.tris).join('/')} tris (<= 150)`);
  dispose();
}

function obbOverlap(ew, T, a, b) {
  const poly = (id) => { const h = ew.heading[id], s = Math.sin(h), c = Math.cos(h), hl = T.len[id] * 0.45, hw = T.wid[id] * 0.45, x = ew.x[id], z = ew.z[id]; return { ax: [[s, c], [c, -s]], pts: [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([f, w]) => [x + s * hl * f + c * hw * w, z + c * hl * f - s * hw * w]) }; };
  const A = poly(a), B = poly(b);
  for (const [ux, uz] of [...A.ax, ...B.ax]) {
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const [x, z] of A.pts) { const d = x * ux + z * uz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const [x, z] of B.pts) { const d = x * ux + z * uz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

function makeSim(map, { seed = 1, quality = 'high', focus, density = 3, paintAt } = {}) {
  const ew = createEntityWorld({ caps: { car: trafficCaps(quality), ped: 4 }, cellSize: 16, seed });
  const clock = { t: 0 };
  const traffic = createTraffic({ ew, map, quality, density, paintAt, signal: (g) => signalState(g, clock.t) });
  const f = { x: focus.x, z: focus.z };
  return { ew, traffic, clock, focus: f, step(dt) { clock.t += dt; ew.update(dt, f); } };
}
const focusOf = (map) => { const s = map.junctions.filter((j) => j.style === 'signals').sort((a, b) => b.arms.length - a.arms.length)[0] || map.junctions[0]; return { x: s.x + 40, z: s.z + 40 }; };

for (const name of ['citytest', 'city']) {
  console.log(`\n== ${name}`);
  const map = await load(name), focus = focusOf(map);
  const t0 = performance.now();
  let sim = makeSim(map, { focus });
  const G = sim.traffic.graph;
  console.log('     graph', JSON.stringify(G.stats), `${(performance.now() - t0).toFixed(0)} ms, crossings ${sim.traffic.crossings.length}, junctions ${map.junctions.length}`);
  assert(G.nLanes > 10 && G.nConns > 10 && G.spawn.x.length > 20, `${name}: lane graph builds (${G.nLanes} lanes, ${G.nConns} connectors, ${G.stats.spawnPoints} spawn points)`);
  assert(G.paths.every((p) => p.len > 0 && Number.isFinite(p.len) && Array.from(p.x).every(Number.isFinite)), `${name}: all paths finite`);
  assert(G.conns.every((c) => G.paths[c.from].len > 0 && G.paths[c.to].len > 0 && G.paths[c.from].outConns.includes(c.id)), `${name}: connectors link lanes`);
  // driving side: incoming lanes sit on the right of the road centreline (right-hand default)
  {
    const l = G.paths.find((p) => !p.isConn && p.n > 3), P = map.roads[l.road], k = l.n >> 1;
    let best = 1e9, side = 0; // nearest road sample, lateral sign relative to the travel direction
    for (let i = 0; i < P.getPoints(1).length; i++) { /* placeholder to keep polyOf cache warm */ break; }
    const pts = P.getPoints(1); let bi = 0;
    for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i].x - l.x[k], pts[i].z - l.z[k]); if (d < best) { best = d; bi = i; } }
    const tdx = l.x[k + 1] - l.x[k], tdz = l.z[k + 1] - l.z[k];
    side = ((l.x[k] - pts[bi].x) * -tdz + (l.z[k] - pts[bi].z) * tdx) > 0 ? 1 : -1;   // + = right of travel
    assert(side === (map.info.driveSide === 'left' ? -1 : 1), `${name}: lanes on the ${map.info.driveSide || 'right'}-hand side`);
  }

  // ---- 10 minute headless run: red lights, gaps, overlaps, locks
  const dt = 0.05, N = 12000, prev = { path: new Int32Array(sim.ew.N), front: new Float32Array(sim.ew.N), gen: new Uint16Array(sim.ew.N) };
  const T = sim.traffic.comps, ew = sim.ew, paths = G.paths, tmp = [];
  let redRuns = 0, crossings = 0, overlaps = 0, maxCars = 0, sumCars = 0, zebraCross = new Float64Array(sim.traffic.crossings.length), stoppedMax = 0, honks = 0;
  ew.on('honk', () => honks++);
  const wallT0 = performance.now(); let simMs = 0;
  let busyId = -1, busyFrom = -1, busyViolations = 0, busyChecked = 0;
  for (let i = 0; i < N; i++) {
    if (busyId >= 0 && sim.clock.t < busyFrom + 40) sim.traffic.markCrossingBusy(busyId, 0.4);
    const t1 = performance.now(); sim.step(dt); simMs += performance.now() - t1;
    const n = ew.count('car'); maxCars = Math.max(maxCars, n); sumCars += n;
    const { ids } = ew.list('car');
    for (let k = 0; k < n; k++) {
      const id = ids[k], p = paths[T.path[id]], front = T.pos[id] + T.len[id] / 2;
      if (prev.gen[id] === ew.gen[id]) {
        const pp = paths[prev.path[id]];
        if (!pp.isConn) for (const g of pp.gates) {
          if (prev.front[id] <= g.d && (T.path[id] !== pp.id || front > g.d)) {
            if (g.kind === 'junction' && g.group >= 0) { crossings++; if (signalState(g.group, sim.clock.t) === 'red') redRuns++; }
            if (g.kind === 'zebra') { zebraCross[g.id]++; if (busyId === g.id && sim.clock.t > busyFrom + 3 && sim.clock.t < busyFrom + 40) busyViolations++; }
          }
        }
      }
      prev.path[id] = T.path[id]; prev.front[id] = front; prev.gen[id] = ew.gen[id];
      if (i % 4 === 0) {
        ew.near(ew.x[id], ew.z[id], 14, 'car', tmp);
        for (const j of tmp) if (j > id && obbOverlap(ew, T, id, j)) overlaps++;
      }
    }
    if (i === 3000) { // choose the busiest zebra seen so far and hold it busy for 40 s
      let b = 0; for (let z = 1; z < zebraCross.length; z++) if (zebraCross[z] > zebraCross[b]) b = z;
      if (zebraCross.length && zebraCross[b] > 0) { busyId = b; busyFrom = sim.clock.t; busyChecked = zebraCross[b]; }
    }
  }
  const st = sim.traffic.stats();
  console.log(`     sim ${N * dt} s: cars avg ${(sumCars / N).toFixed(1)} max ${maxCars}, spawned ${st.spawned}, culled ${st.culled}, ended ${st.ended}, stuck ${st.stuck}, honks ${honks}, signal crossings ${crossings}, minGap ${st.minGap.toFixed(2)}, ${(simMs / N).toFixed(3)} ms/step (wall ${((performance.now() - wallT0) / 1000).toFixed(1)} s)`);
  assert(maxCars > 5, `${name}: traffic spawned (max ${maxCars} cars)`);
  assert(crossings === 0 || redRuns === 0, `${name}: no car crossed a red stop line (${crossings} signal-line crossings, ${redRuns} on red)`);
  assert(st.minGap >= 0.49, `${name}: gap to the leader never below MIN_GAP (min ${st.minGap.toFixed(2)} m)`);
  assert(overlaps === 0, `${name}: no overlapping car boxes (${overlaps})`);
  if (busyId >= 0) assert(busyViolations === 0, `${name}: nobody crossed the held-busy zebra ${busyId} after 3 s (${busyChecked} baseline crossings before, ${busyViolations} during)`);
  else console.log('     (no zebra on any lane carried traffic in 150 s: yielding not exercised)');
  // lock accounting: occupancy never negative; after clearing all cars every connector is free
  assert(Array.from(G.occ).every((v) => v >= 0), `${name}: connector occupancy never negative`);
  ew.each('car', (id) => ew.despawn(id, 'test'));
  assert(Array.from(G.occ).every((v) => v === 0), `${name}: no leaked connector locks after clearing the cars`);

  // ---- default density (no override) with a synthetic downtown (paint 1 within 200 m of the focus, fading to 0 at 320 m): busy but flowing, no gridlock
  {
    const R = 150, paintAt = (x, z) => Math.max(0, Math.min(1, (320 - Math.hypot(x - focus.x, z - focus.z)) / 120)), s = makeSim(map, { focus, seed: 2, quality: 'medium', density: undefined, paintAt }), Gm = s.traffic.graph, Tm = s.traffic.comps;
    const near = (x, z) => (x - focus.x) ** 2 + (z - focus.z) ** 2 < R * R; let laneM = 0;
    for (const l of Gm.paths) if (!l.isConn) for (let d = 2.5; d < l.len; d += 5) { let k = 0; while (k < l.n - 2 && l.s[k + 1] < d) k++; if (near(l.x[k], l.z[k])) laneM += 5; }
    let sumNear = 0, sumV = 0, maxWait = 0, frames = 0, min = 1e9;
    for (let i = 0; i < 12000; i++) {
      s.step(0.05); const { ids, n } = s.ew.list('car');
      if (i < 1200) continue;   // skip the first minute (initial fill)
      frames++; let sv = 0;
      for (let k = 0; k < n; k++) { const id = ids[k]; if (near(s.ew.x[id], s.ew.z[id])) sumNear++; sv += s.ew.speed[id]; maxWait = Math.max(maxWait, Tm.wait[id]); }
      sumV += n ? sv / n : 0;
    }
    const per100 = sumNear / frames / laneM * 100, meanV = sumV / frames, st = s.traffic.stats();
    console.log(`     default density (lane ${laneM} m, avg ${(sumNear / frames).toFixed(1)} cars near): ${per100.toFixed(2)} cars / 100 m of lane within ${R} m of downtown, mean speed ${meanV.toFixed(2)} m/s, longest wait ${maxWait.toFixed(0)} s, live ${st.live}/${st.cap}`);
    assert(per100 >= 1, `${name}: default density is busy (${per100.toFixed(2)} cars / 100 m >= 1)`);
    assert(meanV > 1.5 && maxWait < 120, `${name}: no gridlock (mean ${meanV.toFixed(2)} m/s, longest wait ${maxWait.toFixed(0)} s < 120)`);
    assert(st.minGap >= 0.49, `${name}: min gap at default density ${st.minGap.toFixed(2)} m >= 0.5`);
  }

  // ---- churn: teleport the focus around, pools recycle without growth
  sim = makeSim(map, { focus, seed: 5 });
  const cap = sim.ew.cap('car'), ids0 = new Set(); let leak = false;
  const pts = G.spawn;
  for (let i = 0; i < 4000; i++) {
    if (i % 100 === 0) { const k = (sim.ew.rand() * pts.x.length) | 0; sim.focus.x = pts.x[k]; sim.focus.z = pts.z[k]; }
    sim.step(0.05); if (sim.ew.count('car') > cap) leak = true;
  }
  const s2 = sim.traffic.stats();
  assert(!leak && sim.ew.count('car') <= cap && s2.culled > 0 && s2.spawned > cap, `${name}: churn ok (spawned ${s2.spawned}, culled ${s2.culled}, live ${sim.ew.count('car')}/${cap})`);
  sim.ew.each('car', (id) => sim.ew.despawn(id, 'test'));
  assert(sim.ew.count('car') === 0 && sim.ew.stats().car.live === 0 && Array.from(sim.traffic.graph.occ).every((v) => v === 0), `${name}: pool + locks empty after churn`);
  let refill = 0; for (let i = 0; i < 20; i++) { sim.step(0.05); refill = sim.ew.count('car'); }
  assert(refill > 0, `${name}: refills after emptying (${refill})`);

  // ---- determinism
  const run = (seed) => { const s = makeSim(map, { focus, seed }); let h = 0; for (let i = 0; i < 1200; i++) { s.step(0.05); } s.ew.each('car', (id) => { h = (h * 31 + Math.round(s.ew.x[id] * 100) + Math.round(s.ew.z[id] * 100) * 7 + s.ew.variant[id]) | 0; }); return h + ':' + s.ew.count('car'); };
  const a = run(11), b = run(11), c = run(12);
  assert(a === b && a !== c, `${name}: deterministic by seed (${a} == ${b} != ${c})`);

  // ---- perf: 100 cars
  {
    const s = makeSim(map, { focus, seed: 3, density: 12 });
    for (let i = 0; i < 600; i++) s.step(1 / 60);
    const n = s.ew.count('car'); let ms = 0; const M = 600;
    for (let i = 0; i < M; i++) { const t1 = performance.now(); s.step(1 / 60); ms += performance.now() - t1; }
    console.log(`     perf: ${n} cars, ${(ms / M).toFixed(3)} ms per ew.update (traffic system + LOD + grid)`);
    assert(ms / M < 1, `${name}: < 1 ms/frame with ${n} cars`);
  }
  map.dispose?.();
}

console.log(fails ? `\n${fails} FAILED` : '\nall traffic tests passed');
