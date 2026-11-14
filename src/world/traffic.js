// City traffic (plan part 6b): AI cars on a lane graph, built on the shared entity layer (entities.js kind 'car', entityRender.js). No physics: cars follow lane
// polylines (trafficLanes.js), only cars near the player get pooled box colliders so the player cannot drive through them (never the other way round).
//
//   (opts: crossingBusy = optional Uint8Array indexed by zebra id, 1 = pedestrian on it: pedestrians.js exports one and clears + refills it every ew.update)
//   const traffic = createTraffic({ ew, map, quality: 'low'|'medium'|'high', signal?, paintAt?, density? = 0.75 (multiplier on the per-lane targets, trafficLanes.js spawn.w), visible?: (x, z) => bool, true while a point is on screen (spawns closer than 110 m need it; without it spawns stay >= 110 m) });    // ew = createEntityWorld({ caps: { car: trafficCaps(q), ... } })
//   traffic.update is registered as an entity system (ew.update(dt, focus) runs it); lanes are built once from map.roads / map.junctions / map.roadDetail.zebras.
//   registerTrafficRender({ THREE, er, ew, GLTFLoader }) -> { ready (Promise), tris, dispose }   6 variants from /cars/{taxi,sedan,hatchback,van,bus,truck}.glb = 6 instanced draw calls, paint tinted per instance
//   traffic.active (default true): set false until `ready` resolves so no car is simulated / spawned before its model exists
//   createTrafficColliders({ RAPIER, world, ew, max = 16, radius = 30 }) -> { update(x, z), stats(), dispose() }   call every frame with the player position
//
// Behaviour: drive on map.info.driveSide (right default) on 1 lane per direction (city + country, no highways), random turns at junctions (straight preferred), IDM
// car following per lane (leader looked up through the next connector / lane), stop line before signals (green go, amber go only if it cannot stop, red stop), junctions
// (also unsignalled + roundabouts) admit a car only when its connector does not cross / merge with an occupied one and the exit lane has room, and cars stop before a
// zebra while it is busy. The gap to the leader is hard-clamped to MIN_GAP (0.5 m) so cars never overlap. Spawn / despawn: cars beyond ew cullRadius are culled by
// entities.js, new ones appear on lanes 110..~315 m from the player (biased ahead of a moving player and by city paint: more downtown, few on country roads),
// target count = cap-limited and proportional to the road weight in range, so a lone country road gets a handful of cars.
//
// CROSSINGS for pedestrians (6c): ids are indices into map.roadDetail.zebras (== traffic.crossings). While anyone is on / about to step onto crossing `id`, call EVERY FRAME
//   traffic.markCrossingBusy(id, 0.4)     // keeps it busy until now + 0.4 s traffic time (self-clears, no unmark needed). traffic.crossingBusy(id) -> bool.
// Shared array form: traffic.crossingBusyUntil (Float64Array, traffic clock seconds, traffic.clock()) may be written directly. Cars that have not yet reached the stop
// line before a busy crossing brake and wait; a car already past the line keeps going. Signal crossings at junctions: cars also stop for red anyway (map.signalState).
//
// Per-entity data (components, id indexed, see ew.comp(name, 'car')): 'traffic' { path (lane/connector id), pos (m along path, car centre), route (next connector path id or -1),
// lock (connector reserved + 1), v0, len, wid, wait (s stopped), honkT, commit, why (0 free, 1 leader, 2 red/amber, 3 junction / crossing), acc, gap, stopD }.
// Events: 'honk' (stopped > 7 s for a reason other than a red light; at most every 10 s), 'stateChange' (state 0 moving / 1 stopped), 'spawn', 'despawn' (reasons 'cull', 'end', 'stuck').
// Limitations: dead ends / lane ends without a connector despawn the car; heading is yaw only; roundabouts work one conflicting stream at a time; lanes are built once
// (call traffic.rebuild() after the map's roads changed); the lane graph ignores bridges' lane offsets and overtaking / lane changes.
import { buildLaneGraph } from './trafficLanes.js';
import { CAR_TYPES, buildCarGeometries, buildGlbGeometry, trafficMaterial } from './carModels.js';

export const TRAFFIC_QUALITY = Object.freeze({ low: 60, medium: 120, high: 200 });
export const trafficCaps = (quality = 'medium') => ({ cap: TRAFFIC_QUALITY[quality] ?? 120, simRadius: Infinity, cullRadius: 340, farRate: 1 });
const K = { T: 1.3, s0: 2, a: 1.7, b: 2.2, MIN_GAP: 0.5, COMF: 4.5, MAXDEC: 9, GATE_GAP: 0.8, SPAWN_MIN: 110 };
const SQ = 2 * Math.sqrt(K.a * K.b), TAU = Math.PI * 2;

export function createTraffic({ ew, map, quality = 'medium', signal, paintAt, spawnMin = K.SPAWN_MIN, density = 0.75, crossingBusy = null, visible = null }) {
  const car = ew.kinds.find((k) => k.name === 'car'); if (!car) throw new Error('traffic: entity world has no "car" kind');
  const sig = signal || ((g) => map.signalState(g));
  const paint = paintAt || ((x, z) => (map.surfaceAt ? map.surfaceAt(x, z).weights[7] || 0 : 0));
  const T = ew.addComponent('traffic', 'car', { path: 'i32', pos: 'f32', route: 'i32', lock: 'i32', exit: 'i32', v0: 'f32', len: 'f32', wid: 'f32', seg: 'i32', wait: 'f32', honkT: 'f32', commit: 'u8', why: 'u8', acc: 'f32', gap: 'f32', stopD: 'f32' });
  const capN = Math.min(car.cap, TRAFFIC_QUALITY[quality] ?? car.cap);
  let graph = null, paths = [], occ = null, pend = null, pendGen = null, zebras = [], busyUntil = new Float64Array(0);
  let now = 0, spawnAcc = 1e9, fx = 0, fz = 0, fvx = 0, fvz = 0, havefocus = false, lastFx = 0, lastFz = 0, filled = false;
  const used = [], stats_ = { spawned: 0, forced: 0, culled: 0, ended: 0, stuck: 0, minGap: Infinity, honks: 0 };

  function rebuild() {
    for (const i of used) paths[i].cars.length = 0;
    used.length = 0;
    ew.each('car', (id) => ew.despawn(id, 'rebuild'));
    zebras = (map.roadDetail && map.roadDetail.zebras) || [];
    if (busyUntil.length !== zebras.length) busyUntil = new Float64Array(zebras.length);
    graph = buildLaneGraph({ roads: map.roads || [], junctions: map.junctions || [], zebras, heightAt: map.heightAt, driveSide: (map.info && map.info.driveSide) || 'right', paintAt: paint });
    paths = graph.paths; occ = graph.occ; pend = new Int32Array(graph.junctions.length).fill(-1); pendGen = new Uint16Array(graph.junctions.length);
    api.graph = graph; api.crossings = zebras; api.crossingBusyUntil = busyUntil; filled = false;
  }

  const idm = (v, v0, gap, vl, s0) => { const s = Math.max(gap, 0.05), ss = s0 + Math.max(0, v * K.T + v * (v - vl) / SQ), r = v / v0; return K.a * (1 - r * r * r * r - (ss / s) * (ss / s)); };
  const releaseLock = (id) => { if (T.lock[id]) { occ[T.lock[id] - 1]--; T.lock[id] = 0; } };
  const releaseExit = (id) => { if (T.exit[id]) { occ[T.exit[id] - 1]--; T.exit[id] = 0; } };
  ew.on('despawn', (e) => { if (e.kind === 'car' && occ) { releaseLock(e.id); releaseExit(e.id); } });
  const busy = (id) => busyUntil[id] > now || (crossingBusy !== null && crossingBusy[id] === 1);   // own timer (markCrossingBusy) OR the pedestrians' shared Uint8Array
  const conflictsWith = (a, b) => a === b || a.conflicts.includes(b.ci);

  function rebuildLists() {
    for (const i of used) paths[i].cars.length = 0;
    used.length = 0;
    const { ids, n } = ew.list('car');
    for (let i = 0; i < n; i++) {
      const id = ids[i], p = paths[T.path[id]], c = p.cars;
      if (c.length === 0) used.push(p.id);
      let k = c.length; c.push(id);
      while (k > 0 && T.pos[c[k - 1]] > T.pos[id]) { c[k] = c[k - 1]; k--; }
      c[k] = id;
    }
  }

  function pickRoute(lane, id) {
    const o = lane.outConns; if (o.length === 0) return -1;
    let sum = 0; for (const c of o) sum += paths[c].weight;
    let r = ew.rand() * sum; for (const c of o) { r -= paths[c].weight; if (r <= 0) return c; }
    return o[o.length - 1];
  }

  // 0 open, 2 closed by signal, 3 closed by a conflicting connector / full exit / busy crossing
  function junctionClosed(id, p, G, dg, v, gap) {
    if (G.group >= 0) {
      const st = sig(G.group);
      let open = st === 'green' || T.commit[id] === 1;
      if (!open && st === 'amber' && v > 1.5 && v * v / (2 * K.COMF) >= dg - 0.5) { T.commit[id] = 1; open = true; }   // cannot stop comfortably: go
      if (!open) { releaseLock(id); return 2; }
    }
    if (T.lock[id]) return 0;
    const c = T.route[id]; if (c < 0) return 0;
    if (dg > 10 + v * v / 5 || gap < dg) return 0;          // not close yet, or a car is still between us and the line
    const cn = paths[c], jn = cn.ji, pid = pend[jn];
    let blocked = false;
    if (pid >= 0 && pid !== id) {
      if (ew.alive(pid) && ew.gen[pid] === pendGen[jn] && T.route[pid] >= 0) { if (conflictsWith(paths[T.route[pid]], cn)) blocked = true; } else pend[jn] = -1;
    }
    if (!blocked) for (const ci of cn.conflicts) if (occ[ci] > 0) { blocked = true; break; }
    if (!blocked) { const to = paths[cn.to]; if (to.cars.length) { const j = to.cars[0]; if (T.pos[j] - T.len[j] / 2 < T.len[id] + 5) blocked = true; } if (!blocked) for (const zi of to.entryZebras) if (busy(zi)) { blocked = true; break; } }
    if (blocked) { if (v < 0.5 && T.wait[id] > 2.5 && (pend[jn] < 0 || pend[jn] === id)) { pend[jn] = id; pendGen[jn] = ew.gen[id]; } return 3; }
    occ[cn.ci]++; T.lock[id] = cn.ci + 1; if (pend[jn] === id) pend[jn] = -1;
    return 0;
  }

  function phase1() {
    let minGap = Infinity;
    for (const pid of used) {
      const p = paths[pid], cars = p.cars;
      for (let k = cars.length - 1; k >= 0; k--) {
        const id = cars[k], v = ew.speed[id], len = T.len[id], front = T.pos[id] + len / 2, v0 = Math.max(1, Math.min(T.v0[id], p.v));
        const r = v / v0; let acc = K.a * (1 - r * r * r * r), why = 0, stopD = 1e9, gap = Infinity, vl = 0;
        if (k + 1 < cars.length) { const j = cars[k + 1]; gap = T.pos[j] - T.len[j] / 2 - front; vl = ew.speed[j]; }
        else {
          let off = p.len - front, q = p.isConn ? paths[p.to] : T.route[id] >= 0 ? paths[T.route[id]] : null;
          for (let h = 0; h < 2 && q; h++) {
            if (q.cars.length) { const j = q.cars[0]; gap = off + T.pos[j] - T.len[j] / 2; vl = ew.speed[j]; break; }
            off += q.len; q = q.isConn ? paths[q.to] : null;
          }
        }
        if (gap < Infinity) { const a2 = idm(v, v0, gap, vl, K.s0); if (a2 < acc) { acc = a2; why = 1; } if (gap < minGap) minGap = gap; }
        if (!p.isConn) {
          const gs = p.gates;
          for (let g = 0; g < gs.length; g++) {
            const G = gs[g], dg = G.d - front; if (dg < -0.4) continue;
            let closed = 0;
            if (G.kind === 'zebra') closed = busy(G.id) && v * v / (2 * K.MAXDEC) < dg ? 3 : 0; else closed = junctionClosed(id, p, G, dg, v, gap);
            if (closed) { const a2 = idm(v, v0, Math.max(dg, 0.05), 0, K.GATE_GAP); if (a2 < acc) { acc = a2; why = closed; } stopD = dg; break; }
          }
        }
        T.acc[id] = Math.max(acc, -K.MAXDEC); T.why[id] = why; T.stopD[id] = stopD; T.gap[id] = gap;
      }
    }
    if (minGap < stats_.minGap) stats_.minGap = minGap;
  }

  function phase2(dt, fxx, fzz) {
    const { ids } = ew.list('car');
    for (let i = ew.count('car') - 1; i >= 0; i--) {
      const id = ids[i]; let p = paths[T.path[id]];
      const vOld = ew.speed[id]; let v = Math.min(40, Math.max(0, vOld + T.acc[id] * dt)), move = (vOld + v) * 0.5 * dt;
      const lim = Math.min(T.gap[id] - K.MIN_GAP, T.stopD[id] - 0.05);   // hard guarantees: never closer than MIN_GAP to the leader, never over a closed line
      if (move > lim) { move = Math.max(0, lim); v = Math.min(v, move / dt); }
      let pos = T.pos[id] + move, dead = false;
      while (pos >= p.len) {
        if (!p.isConn) {
          const c = T.route[id];
          if (c < 0) { ew.despawn(id, 'end'); stats_.ended++; dead = true; break; }
          if (!T.lock[id]) { stats_.forced++; occ[paths[c].ci]++; T.lock[id] = paths[c].ci + 1; }   // forced entry (committed on amber / skipped window): still holds the connector
          T.commit[id] = 0; pos -= p.len; p = paths[c];
        } else { pos -= p.len; p = paths[p.to]; T.route[id] = pickRoute(p, id); T.exit[id] = T.lock[id]; T.lock[id] = 0; }   // the connector stays occupied until the body has cleared it
        T.path[id] = p.id; T.seg[id] = 0;
      }
      if (dead) continue;
      if (T.exit[id] && !p.isConn && pos > T.len[id] * 0.5 + 1) releaseExit(id);
      T.pos[id] = pos;
      let k = T.seg[id]; if (k > p.n - 2) k = 0;
      while (k < p.n - 2 && pos > p.s[k + 1]) k++;
      while (k > 0 && pos < p.s[k]) k--;
      T.seg[id] = k;
      const dl = p.s[k + 1] - p.s[k] || 1, t = Math.min(1, Math.max(0, (pos - p.s[k]) / dl));
      ew.x[id] = p.x[k] + (p.x[k + 1] - p.x[k]) * t; ew.z[id] = p.z[k] + (p.z[k + 1] - p.z[k]) * t; ew.y[id] = p.y[k] + (p.y[k + 1] - p.y[k]) * t;
      let dh = Math.atan2(p.x[k + 1] - p.x[k], p.z[k + 1] - p.z[k]) - ew.heading[id]; dh -= Math.round(dh / TAU) * TAU;
      ew.heading[id] += dh * Math.min(1, dt * 8);
      ew.speed[id] = v;
      if (v < 0.2) T.wait[id] += dt; else T.wait[id] = 0;
      if (v > 0.8) ew.setState(id, 0); else if (T.wait[id] > 0.6) ew.setState(id, 1);
      if (T.wait[id] > 7 && T.why[id] !== 2 && now - T.honkT[id] > 10) { T.honkT[id] = now; stats_.honks++; ew.emit('honk', id); }
      if (T.wait[id] > 45) { const dx = ew.x[id] - fxx, dz = ew.z[id] - fzz; if (dx * dx + dz * dz > 6400) { ew.despawn(id, 'stuck'); stats_.stuck++; } }
    }
  }

  // ---- spawning
  const tmpPts = [], cand = [], cum = [];
  function pickVariant(lane, pt) {
    const city = lane.type === 'city', w = [city ? 0.04 + 0.9 * pt : 0.01, 1, 0.7, 0.25, city ? 0.06 + 0.12 * pt : 0.02, city ? 0.1 : 0.18];
    let r = ew.rand() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < 6; i++) { r -= w[i]; if (r <= 0) return i; }
    return 1;
  }
  function spawnAt(sp) {
    const lane = paths[graph.spawn.path[sp]]; if (lane.cars.length * 18 > lane.len) return false;   // lane already queued full: spawn where traffic flows
    const variant = pickVariant(lane, graph.spawn.paint[sp]), ty = CAR_TYPES[variant];
    const s = Math.min(lane.len - 4, Math.max(12, graph.spawn.s[sp] + (ew.rand() - 0.5) * 10));
    for (const j of lane.cars) if (T.path[j] === lane.id && ew.alive(j) && Math.abs(T.pos[j] - s) < 12 + (T.len[j] + ty.len) / 2) return false;
    for (const G of lane.gates) { if (G.d > s + ty.len / 2) { if (G.d - s < 25) return false; } else if (G.kind === 'junction') return false; }   // not right in front of a stop line, never past it
    let k = 0; while (k < lane.n - 2 && lane.s[k + 1] < s) k++;
    const t = (s - lane.s[k]) / ((lane.s[k + 1] - lane.s[k]) || 1), v0 = lane.v * (0.85 + ew.rand() * 0.25);
    const id = ew.spawn('car', { x: lane.x[k] + (lane.x[k + 1] - lane.x[k]) * t, y: lane.y[k] + (lane.y[k + 1] - lane.y[k]) * t, z: lane.z[k] + (lane.z[k + 1] - lane.z[k]) * t,
      heading: Math.atan2(lane.x[k + 1] - lane.x[k], lane.z[k + 1] - lane.z[k]), speed: Math.min(v0, 8) * 0.8, variant, tint: ty.tint[(ew.rand() * ty.tint.length) | 0] });
    if (id < 0) return false;
    T.has[id] = 1; T.path[id] = lane.id; T.pos[id] = s; T.seg[id] = k; T.v0[id] = v0; T.len[id] = ty.len; T.wid[id] = ty.wid; T.route[id] = pickRoute(lane, id); T.gap[id] = Infinity; T.stopD[id] = 1e9;
    if (lane.cars.length === 0) used.push(lane.id);
    lane.cars.push(id); stats_.spawned++;
    return true;
  }
  function manageSpawn(initial) {
    const R = car.cullRadius * 0.92, pts = graph.queryPts(fx, fz, R, tmpPts), S = graph.spawn;
    let W = 0; for (const i of pts) W += S.w[i];
    let need = Math.min(capN, Math.round(W * density)) - ew.count('car'); if (need <= 0) return;
    need = Math.min(need, initial ? capN : 8);
    // cap binds: only spawn inside the radius that holds capN worth of target, so the cars crowd round the player instead of thinning out over the whole range
    let Rs = R; if (W * density > capN) { let w = 0; const order = pts.map((i) => [Math.hypot(S.x[i] - fx, S.z[i] - fz), S.w[i]]).sort((a, b) => a[0] - b[0]); for (const [d, wi] of order) { w += wi * density; if (w >= capN) { Rs = Math.max(d, 150); break; } } }
    const minR = initial ? 35 : visible ? 60 : spawnMin, sp = Math.hypot(fvx, fvz); let acc = 0; cand.length = 0; cum.length = 0;
    for (const i of pts) {
      const dx = S.x[i] - fx, dz = S.z[i] - fz, d = Math.hypot(dx, dz); if (d < minR || d > Rs) continue;
      if (!initial && visible && d < spawnMin && visible(S.x[i], S.z[i])) continue;   // never pop in on screen
      acc += S.w[i] * (sp > 3 ? 1 + 1.5 * Math.max(0, (dx * fvx + dz * fvz) / (d * sp)) : 1); cand.push(i); cum.push(acc);
    }
    if (!cand.length) return;
    for (let tries = need * 4; tries > 0 && need > 0; tries--) {
      const r = ew.rand() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
      if (spawnAt(cand[lo])) need--;
    }
  }

  const system = {
    name: 'traffic', kinds: ['car'],
    update(ew_, dt, focus) {
      if (!api.active || !graph || !paths.length || dt <= 0) return;
      if (focus) { fx = focus.x; fz = focus.z; if (havefocus) { fvx += ((fx - lastFx) / dt - fvx) * 0.1; fvz += ((fz - lastFz) / dt - fvz) * 0.1; } lastFx = fx; lastFz = fz; havefocus = true; }
      const steps = Math.min(4, Math.ceil(dt / 0.05)), h = dt / steps;
      for (let s = 0; s < steps; s++) { rebuildLists(); phase1(); now += h; phase2(h, fx, fz); }
      spawnAcc += dt;
      if (!filled || spawnAcc > 0.3) { rebuildLists(); manageSpawn(!filled); filled = true; spawnAcc = 0; }
    },
  };
  ew.on('despawn', (e) => { if (e.kind === 'car' && e.data === 'cull') stats_.culled++; });
  const api = {
    active: true, system, graph: null, crossings: zebras, crossingBusyUntil: busyUntil, comps: T, rebuild, cap: capN, kinds: CAR_TYPES,
    clock: () => now,
    markCrossingBusy(id, seconds = 0.4) { if (id >= 0 && id < busyUntil.length) busyUntil[id] = Math.max(busyUntil[id], now + seconds); },
    crossingBusy: (id) => id >= 0 && busy(id),
    stats: () => ({ live: ew.count('car'), cap: capN, ...stats_, lanes: graph.stats }),
  };
  rebuild();
  ew.addSystem(system);
  return api;
}

// ---------------------------------------------------------------------------------------------------- rendering (THREE + GLTFLoader injected)
// Loads the game's own car GLBs (/cars/<CAR_TYPES[i].id>.glb) one by one, merging each into one geometry in its own task (no long frame), and registers a variant with the
// renderer as soon as it is built. 6 variants = 6 draw calls. Variants whose GLB fails fall back to the simple boxes. Resolves { geos, stats, dispose } once all six exist,
// so main.js can set traffic.active = true then (cars only appear once the models are ready).
export function registerTrafficRender({ THREE, er, ew, GLTFLoader, base = '/cars/', drawRadius = 260 }) {
  const mat = trafficMaterial(THREE), geos = [], tris = [];
  const reg = (v, g) => { geos[v] = g; tris[v] = g.userData.tris ?? 0; er.register('car', v, g, mat, { max: ew.cap('car'), drawRadius, castShadow: false }); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ready = (async () => {
    const loader = GLTFLoader ? new GLTFLoader() : null; let simple = null;
    for (let v = 0; v < CAR_TYPES.length; v++) {
      try {
        if (!loader) throw new Error('no GLTFLoader');
        const gltf = await loader.loadAsync(base + CAR_TYPES[v].id + '.glb'); await tick();
        reg(v, buildGlbGeometry(THREE, gltf.scene));
      } catch (e) {
        console.warn('[traffic] car model', CAR_TYPES[v].id, 'failed, using simple boxes:', e.message || e);
        simple ||= buildCarGeometries(THREE); const g = simple.geos[v]; g.userData.tris = g.attributes.position.count / 3; reg(v, g);
      }
      await tick();
    }
    return { tris: tris.slice(), simple: geos.map((g) => !!g.userData.simple) };
  })();
  return { ready, geos, tris, dispose() { geos.forEach((g) => g.dispose()); mat.dispose(); } };
}

// ---------------------------------------------------------------------------------------------------- colliders near the player
// A pool of body-less cuboids (like cityColliders.js), re-placed every frame onto the nearest cars within `radius`; cars outside release their slot. comp 'collider' { hx, hy, hz, slot (index + 1) }.
export function createTrafficColliders({ RAPIER, world, ew, max = 16, radius = 30, hysteresis = 8 }) {
  const col = ew.addComponent('collider', 'car', { hx: 'f32', hy: 'f32', hz: 'f32', slot: 'i32' });
  const slots = Array.from({ length: max }, () => ({ collider: world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setFriction(0.3).setTranslation(0, -1e4, 0).setEnabled(false)), id: -1, gen: 0 }));
  const free = slots.slice().reverse(), tmp = []; let px = 0, pz = 0;
  const release = (s) => { if (s.id >= 0) { if (ew.alive(s.id) && ew.gen[s.id] === s.gen) col.slot[s.id] = 0; } s.collider.setEnabled(false); s.id = -1; free.push(s); };
  ew.on('despawn', (e) => { if (e.kind === 'car' && col.slot[e.id]) release(slots[col.slot[e.id] - 1]); });
  return {
    update(x, z) {
      px = x; pz = z;
      const rr = (radius + hysteresis) ** 2;
      for (const s of slots) if (s.id >= 0 && (!ew.alive(s.id) || ew.gen[s.id] !== s.gen || (ew.x[s.id] - x) ** 2 + (ew.z[s.id] - z) ** 2 > rr)) release(s);
      ew.near(x, z, radius, 'car', tmp);
      if (tmp.length > free.length) tmp.sort((a, b) => ((ew.x[a] - x) ** 2 + (ew.z[a] - z) ** 2) - ((ew.x[b] - x) ** 2 + (ew.z[b] - z) ** 2));
      for (const id of tmp) {
        if (col.slot[id]) continue;
        const s = free.pop(); if (!s) break;
        const ty = CAR_TYPES[ew.variant[id]] || CAR_TYPES[1];
        col.hx[id] = ty.wid / 2; col.hy[id] = ty.hgt / 2 - 0.1; col.hz[id] = ty.len / 2;
        s.collider.setHalfExtents({ x: col.hx[id], y: col.hy[id], z: col.hz[id] }); s.collider.setEnabled(true);
        s.id = id; s.gen = ew.gen[id]; col.slot[id] = slots.indexOf(s) + 1;
      }
      for (const s of slots) {
        if (s.id < 0) continue;
        const id = s.id, h = ew.heading[id] / 2;
        s.collider.setTranslation({ x: ew.x[id], y: ew.y[id] + col.hy[id] + 0.25, z: ew.z[id] });
        s.collider.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
      }
    },
    stats: () => ({ active: max - free.length, max }),
    dispose() { for (const s of slots) world.removeCollider(s.collider, false); slots.length = 0; free.length = 0; },
  };
}
