// Pedestrians (plan part 6c): city life on footpaths, zebras and plazas. NOT GTA: no physics, no colliders, they never react to the player's car (the car drives through them).
// Kind 'ped' of the shared entity world (entities.js); walk network in pedPaths.js; bodies + shader walk cycle in pedModels.js.
//
//   const net = buildPedNetwork({ roads: map.roads, roadDetail: map.roadDetail, junctions: map.junctions, blocks: cityBlocks.blocks, paintAt: (x, z) => map.surfaceAt(x, z).weights[7] });
//   const peds = createPedestrians({ ew, net, heightAt: map.heightAt, signalState: (g) => map.signalState(g), quality: 'medium', THREE, er });   // THREE + er (entityRenderer) only in the browser
//   (no per-frame call: it is a system of ew, so ew.update(dt, focus) runs it)   peds.stats()   peds.spawnVendor(x, z, opts)   peds.dispose()
//   the ew must have a 'ped' kind:  createEntityWorld({ caps: { ped: { cap: PED_QUALITY[q], simRadius: 250, cullRadius: 210, farRate: 2 }, ... } })
//
// crossingBusy (exported Uint8Array(4096), CONTRACT with traffic.js): index = zebra id = index into map.roadDetail.zebras (pedPaths crossings[].id). It is cleared at the start
//   of every ew.update and SET to 1 for every zebra that has a pedestrian ON it (between its two kerb nodes) this frame. Traffic reads crossingBusy[id] and must not drive
//   onto that zebra while it is 1 (it may keep driving otherwise; peds never read cars on signalled zebras). Pedestrians start crossing a signalled zebra only while
//   signalState(group) of the crossed road is 'red' (they may still be on it when the light turns: traffic yields via crossingBusy). Unsignalled zebras (mid-block crosswalk
//   features): a ped steps out only when no 'car' entity (if the world has that kind) moving > 0.5 m/s is within 18 m.
//
// Behaviour: random walk on the graph (prefers straight on, sometimes crosses), pauses (phone / looking round), sits ~15-45 s on benches (SEAT nodes), stands at planters (IDLE nodes).
//   walk speed 1.1..1.6 m/s (x1.15 on zebras); lane offset by id (right of travel 0.1..0.9 m) separates opposite streams without neighbour queries; position / heading are smoothed so
//   corners and edge changes never pop.
// Density: spawn target = 0.05 * sum(edge length * density(city paint)) over the footpaths within SPAWN_R of the player (downtown 1, rowhouse 0.4, residential 0.1), capped by the
//   quality cap; spawn at 30..SPAWN_R m on a random weighted edge, despawn beyond DESPAWN_R (own check, so a world with another cullRadius works).
// States (ew.state, setState emits 'stateChange'): PED_STATE.WALK 0, WAIT 1 (at a kerb), SIT 2, IDLE 3 (pose in component 'ped'.pose: 0 look round, 1 phone).
// Component 'ped' (for future audio / fx): edge, from (node), t (m along the edge from `from`), next (edge waiting to be taken), timer (s), spd (walk speed), lane, prev (edge), ph (gait phase), pose.
// Vendor hook (6d): spawnVendor(x, z, { heading, variant, tint }) -> id, an idle ped (flag bit 2 = FLAG_VENDOR) that never moves nor despawns by range (ew.cullRadius still applies).
// ponytail: no pedestrian-pedestrian or pedestrian-car avoidance beyond lanes; a ped that is on a zebra when the light turns keeps walking.
import { EDGE, NODE, density } from './pedPaths.js';
import { buildPedVariants, ANIM } from './pedModels.js';

export const crossingBusy = new Uint8Array(4096);
export const PED_STATE = Object.freeze({ WALK: 0, WAIT: 1, SIT: 2, IDLE: 3 });
export const PED_QUALITY = Object.freeze({ low: 60, medium: 150, high: 300 });
export const FLAG_VENDOR = 4;
export const SPAWN_R = 120, SPAWN_MIN = 30, DESPAWN_R = 200;
const CELL = 64, TAU = Math.PI * 2, PER_M = 0.05;
const TINTS = [0xd94a4a, 0x4a7fd9, 0x4ab06a, 0xe0b84a, 0xb04ad9, 0xe0e0e0, 0x3a3a3a, 0xe08a3a, 0x4ac8c8, 0x8a5a3a];
const DARK = [0x2a2a30, 0x1c2540, 0x3a3a3a, 0x4a3a30];

export function createPedestrians({ ew, net, heightAt = () => 0, signalState = () => 'red', quality = 'medium', cap, THREE = null, er = null, drawRadius = 150, perM = PER_M }) {
  const maxPeds = Math.min(cap ?? PED_QUALITY[quality] ?? 150, ew.cap('ped'));
  const C = ew.addComponent('ped', 'ped', { edge: 'i32', from: 'i32', t: 'f32', next: 'i32', timer: 'f32', spd: 'f32', lane: 'f32', prev: 'i32', ph: 'f32', pose: 'u8' });
  const hasCars = ew.kinds.some((k) => k.name === 'car'), carTmp = [];
  const { nx, nz, nh, nType, nYaw, adjStart, adjEdge, ea, eb, elen, ekind, ecross, egroup } = net;

  // visuals
  let variants = null;
  if (THREE && er) {
    variants = buildPedVariants(THREE);
    variants.forEach((v, i) => er.register('ped', i, v.geometry, v.material, { max: maxPeds, drawRadius, anim: { onShader: v.onShader } }));
  }

  // spawnable edges bucketed by midpoint
  const cells = new Map(), ck = (cx, cz) => cx * 73856 + cz;
  for (let e = 0; e < net.m; e++) {
    if (ekind[e] === EDGE.CROSS || ekind[e] === EDGE.SPUR || nType[ea[e]] === NODE.KERB || nType[eb[e]] === NODE.KERB) continue;
    const k = ck(Math.floor((nx[ea[e]] + nx[eb[e]]) / 2 / CELL), Math.floor((nz[ea[e]] + nz[eb[e]]) / 2 / CELL));
    (cells.get(k) || cells.set(k, []).get(k)).push(e);
  }
  let cand = new Int32Array(256), cum = new Float64Array(256), nCand = 0, target = 0, retargetAt = -1, time = 0, ms = 0, spawned = 0, despawned = 0;

  function retarget(fx, fz) {
    nCand = 0; let sum = 0;
    const x0 = Math.floor((fx - SPAWN_R) / CELL), x1 = Math.floor((fx + SPAWN_R) / CELL), z0 = Math.floor((fz - SPAWN_R) / CELL), z1 = Math.floor((fz + SPAWN_R) / CELL);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) for (const e of cells.get(ck(cx, cz)) || []) {
      const mx = (nx[ea[e]] + nx[eb[e]]) / 2 - fx, mz = (nz[ea[e]] + nz[eb[e]]) / 2 - fz; if (mx * mx + mz * mz > SPAWN_R * SPAWN_R) continue;
      if (nCand === cand.length) { const c2 = new Int32Array(nCand * 2); c2.set(cand); cand = c2; const w2 = new Float64Array(nCand * 2); w2.set(cum); cum = w2; }
      sum += elen[e] * density(net.ew[e]); cand[nCand] = e; cum[nCand++] = sum;
    }
    target = Math.min(maxPeds, Math.round(sum * perM));
  }

  const pick = (items) => items[(ew.rand() * items.length) | 0];
  // set pose word + stored speed
  function anim(id, q) { ew.anim[id] = C.ph[id] + 8 * q; }

  function place(id, x, z) { ew.x[id] = x; ew.z[id] = z; ew.y[id] = heightAt(x, z); }

  function spawnOne(fx, fz) {
    if (!nCand) return -1;
    for (let tries = 0; tries < 8; tries++) {
      const r = ew.rand() * cum[nCand - 1]; let lo = 0, hi = nCand - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const e = cand[lo], t = ew.rand(), x = nx[ea[e]] + (nx[eb[e]] - nx[ea[e]]) * t, z = nz[ea[e]] + (nz[eb[e]] - nz[ea[e]]) * t, d = Math.hypot(x - fx, z - fz);
      if (d < SPAWN_MIN || d > SPAWN_R) continue;
      const fwd = ew.rand() < 0.5, v = ew.rand() < 0.12 ? 3 : (ew.rand() * 3) | 0, spd = 1.1 + ew.rand() * 0.5;
      const id = ew.spawn('ped', { x, z, y: heightAt(x, z), scale: 0.93 + ew.rand() * 0.14, variant: v, tint: v === 0 ? pick(DARK) : pick(TINTS), anim: 0 });
      if (id < 0) return -1;
      C.has[id] = 1; C.edge[id] = e; C.from[id] = fwd ? ea[e] : eb[e]; C.t[id] = fwd ? t * elen[e] : (1 - t) * elen[e]; C.next[id] = -1; C.prev[id] = -1;
      C.spd[id] = spd; C.lane[id] = 0.1 + ew.rand() * 0.8; C.ph[id] = ew.rand() * TAU; C.timer[id] = 0; C.pose[id] = 0;
      ew.speed[id] = spd;
      const dx = nx[C.from[id] === ea[e] ? eb[e] : ea[e]] - nx[C.from[id]], dz = nz[C.from[id] === ea[e] ? eb[e] : ea[e]] - nz[C.from[id]];
      ew.heading[id] = Math.atan2(dx, dz); anim(id, 8);
      spawned++;
      return id;
    }
    return -1;
  }

  // next edge at `node`: weighted random, never straight back unless dead end
  function choose(id, node, prevEdge) {
    const h = ew.heading[id], hx = Math.sin(h), hz = Math.cos(h);
    let sum = 0, n = 0, only = -1;
    for (let k = adjStart[node]; k < adjStart[node + 1]; k++) { const e = adjEdge[k]; if (e === prevEdge) continue; n++; only = e; sum += weight(e, node, hx, hz); }
    if (!n) return prevEdge;
    if (n === 1) return only;
    let r = ew.rand() * sum;
    for (let k = adjStart[node]; k < adjStart[node + 1]; k++) { const e = adjEdge[k]; if (e === prevEdge) continue; r -= weight(e, node, hx, hz); if (r <= 0) return e; }
    return only;
  }
  function weight(e, node, hx, hz) {
    const o = ea[e] === node ? eb[e] : ea[e];
    if (nType[o] === NODE.KERB) return 0.35;                 // step off to a zebra
    if (ekind[e] === EDGE.SPUR) return 0.6;
    const l = elen[e] || 1, dot = ((nx[o] - nx[node]) * hx + (nz[o] - nz[node]) * hz) / l;
    return dot > 0.6 ? 3 : dot > -0.3 ? 1.2 : 0.4;
  }

  function mayCross(e, x, z) {
    const g = egroup[e];
    if (g >= 0) return signalState(g) === 'red';
    if (!hasCars) return true;
    ew.near(x, z, 18, 'car', carTmp);
    for (let i = 0; i < carTmp.length; i++) if (ew.speed[carTmp[i]] > 0.5) return false;
    return true;
  }

  // start walking edge e from node n
  function depart(id, n, e) { C.edge[id] = e; C.from[id] = n; C.t[id] = 0; C.next[id] = -1; ew.setState(id, PED_STATE.WALK); }

  function arrive(id, n) {
    const prev = C.edge[id]; C.prev[id] = prev;
    const ty = nType[n], r = ew.rand();
    if (ty === NODE.SEAT && r < 0.7) { C.from[id] = n; C.t[id] = 0; C.timer[id] = 15 + ew.rand() * 30; ew.setState(id, PED_STATE.SIT); ew.heading[id] = nYaw[n]; ew.speed[id] = 0; return; }
    if (ty === NODE.IDLE && r < 0.5) { C.from[id] = n; C.timer[id] = 4 + ew.rand() * 6; C.pose[id] = 0; ew.setState(id, PED_STATE.IDLE); ew.speed[id] = 0; return; }
    if (ty === NODE.PLAIN && r < 0.04) { C.from[id] = n; C.timer[id] = 3 + ew.rand() * 6; C.pose[id] = ew.rand() < 0.5 ? 1 : 0; ew.setState(id, PED_STATE.IDLE); ew.speed[id] = 0; return; }
    leave(id, n, prev);
  }
  function leave(id, n, prev) {
    const e = choose(id, n, prev);
    if (ekind[e] === EDGE.CROSS && !mayCross(e, nx[n], nz[n])) { C.from[id] = n; C.edge[id] = prev; C.next[id] = e; C.timer[id] = 0.3; ew.speed[id] = 0; ew.setState(id, PED_STATE.WAIT); return; }
    depart(id, n, e);
  }

  let dtc = 0, fxc = 0, fzc = 0, k8 = 0;
  function step(id) {
    if (ew.flags[id] & FLAG_VENDOR) { anim(id, 0); return; }
    if (ew.dist2[id] > DESPAWN_R * DESPAWN_R) { ew.despawn(id, 'range'); despawned++; return; }
    const dt = dtc, st = ew.state[id], n = C.from[id];
    let e = C.edge[id], moving = false;
    if (st === PED_STATE.WAIT) {
      const ne = C.next[id]; C.timer[id] -= dt;
      const ox = ea[ne] === n ? eb[ne] : ea[ne]; ew.heading[id] = turn(ew.heading[id], Math.atan2(nx[ox] - nx[n], nz[ox] - nz[n]), dt);
      if (C.timer[id] <= 0) { if (mayCross(ne, nx[n], nz[n])) depart(id, n, ne); else C.timer[id] = 0.25; }
    } else if (st === PED_STATE.SIT || st === PED_STATE.IDLE) {
      C.timer[id] -= dt;
      if (st === PED_STATE.IDLE && C.pose[id] === 0) ew.heading[id] += Math.sin(time * 0.9 + id) * dt * 0.6;   // looking round
      if (C.timer[id] <= 0) { leave(id, n, C.prev[id]); }
    } else {
      moving = true;
      const cross = ekind[e] === EDGE.CROSS, v = C.spd[id] * (cross ? 1.15 : 1), L = elen[e];
      C.t[id] += v * dt; ew.speed[id] = v;
      if (C.t[id] >= L) { const far = ea[e] === n ? eb[e] : ea[e]; arrive(id, far); if (ew.state[id] === PED_STATE.WALK) { moving = true; } else moving = false; e = C.edge[id]; }
    }
    // pose
    const s = ew.state[id];
    let tx, tz, h;   // target position on the walking line + lane offset
    const f = C.from[id], ee = C.edge[id];
    if (s === PED_STATE.WALK) {
      if (ekind[ee] === EDGE.CROSS) crossingBusy[ecross[ee]] = 1;
      const a = f, b = ea[ee] === f ? eb[ee] : ea[ee], L = elen[ee] || 1, t = Math.min(C.t[id], L), u = t / L;
      const dx = (nx[b] - nx[a]) / L, dz = (nz[b] - nz[a]) / L, lane = C.lane[id] * (ekind[ee] === EDGE.CROSS ? 0.4 : 1);
      tx = nx[a] + (nx[b] - nx[a]) * u + dz * lane; tz = nz[a] + (nz[b] - nz[a]) * u - dx * lane;
      h = nh[a] + (nh[b] - nh[a]) * u;
      if (ekind[ee] === EDGE.CROSS) h = nh[a];
      ew.heading[id] = turn(ew.heading[id], Math.atan2(dx, dz), dt);
    } else { tx = nx[f]; tz = nz[f]; h = nh[f]; }
    const k = 1 - Math.exp(-dt * 8);
    if (moving || s === PED_STATE.WALK) { ew.x[id] += (tx - ew.x[id]) * k; ew.z[id] += (tz - ew.z[id]) * k; }
    else { ew.x[id] += (tx - ew.x[id]) * Math.min(1, k * 0.5); ew.z[id] += (tz - ew.z[id]) * Math.min(1, k * 0.5); }
    ew.y[id] = heightAt(ew.x[id], ew.z[id]) + h;
    let q = 0;
    if (s === PED_STATE.WALK) { C.ph[id] = (C.ph[id] + ew.speed[id] * dt * 4.2) % TAU; q = 1 + Math.round(Math.min(1, ew.speed[id] / 1.8) * 14); }
    else if (s === PED_STATE.SIT) q = ANIM.SIT; else if (s === PED_STATE.IDLE && C.pose[id] === 1) q = ANIM.PHONE;
    if (s !== PED_STATE.WALK) ew.speed[id] = 0;
    anim(id, Math.min(q, 17));
  }
  const turn = (a, b, dt) => { let d = b - a; d -= Math.round(d / TAU) * TAU; return a + d * (1 - Math.exp(-dt * 8)); };

  const system = {
    name: 'pedestrians', kinds: ['ped'],
    update(_ew, dt, focus) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      dtc = Math.min(dt, 0.1); time += dtc; fxc = focus ? focus.x : 0; fzc = focus ? focus.z : 0;
      crossingBusy.fill(0);
      if (time >= retargetAt) { retarget(fxc, fzc); retargetAt = time + 0.5; }
      ew.each('ped', step);
      let live = ew.count('ped'), budget = live < target * 0.5 ? 12 : 2;
      while (live < target && budget-- > 0) { if (spawnOne(fxc, fzc) < 0) break; live++; }
      if (t0) ms += (performance.now() - t0 - ms) * 0.05;
    },
  };
  ew.addSystem(system);

  return {
    system, net, comp: C,
    spawnVendor(x, z, { heading = 0, variant = 1, tint = 0xd0a050 } = {}) {
      const id = ew.spawn('ped', { x, z, y: heightAt(x, z), heading, variant, tint, state: PED_STATE.IDLE, flags: FLAG_VENDOR });
      if (id >= 0) { C.has[id] = 1; C.edge[id] = -1; C.next[id] = -1; C.prev[id] = -1; }
      return id;
    },
    stats() {
      let wait = 0, sit = 0, idle = 0; ew.each('ped', (id) => { const s = ew.state[id]; if (s === 1) wait++; else if (s === 2) sit++; else if (s === 3) idle++; });
      return { live: ew.count('ped'), target, cap: maxPeds, waiting: wait, sitting: sit, idle, spawned, despawned, candidates: nCand, ms: +ms.toFixed(3), tris: variants ? variants.map((v) => v.tris) : null };
    },
    dispose() { if (variants) for (const v of variants) { v.geometry.dispose(); v.material.dispose(); } },
  };
}
