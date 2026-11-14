// Headless checks of the pedestrians (src/world/pedPaths.js + pedestrians.js): `node scripts/test-pedestrians.mjs [map...]` (default: citytest city).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadMap } from '../src/world/mapLoader.js';
import { createCityBlocks } from '../src/world/cityBlocks.js';
import { createEntityWorld } from '../src/world/entities.js';
import { buildPedNetwork, components, EDGE, NODE } from '../src/world/pedPaths.js';
import { createPedestrians, crossingBusy, PED_STATE } from '../src/world/pedestrians.js';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } else console.log('ok   ' + m); };
let mapDir = '';
globalThis.fetch = async (url) => { const f = path.join(mapDir, path.basename(url)); if (!fs.existsSync(f)) return new Response(null, { status: 404 }); return new Response(fs.readFileSync(f)); };
const segD = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(ax + dx * t - px, az + dz * t - pz); };

const world = (cap, seed) => createEntityWorld({ seed, caps: { car: 8, ped: { cap, simRadius: 250, cullRadius: 210, farRate: 2 } } });
const nearEdge = (net, x, z) => { let d = Infinity; for (let e = 0; e < net.m; e++) d = Math.min(d, segD(x, z, net.nx[net.ea[e]], net.nz[net.ea[e]], net.nx[net.eb[e]], net.nz[net.eb[e]])); return d; };

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['citytest', 'city']) {
  console.log(`\n== ${name}`);
  mapDir = path.resolve('public/maps', name);
  const map = await loadMap('/maps/x/', { THREE, physics: false });
  const cb = createCityBlocks({ map });
  const mk = () => buildPedNetwork({ roads: map.roads, roadDetail: map.roadDetail, junctions: map.junctions, blocks: cb.blocks, paintAt: (x, z) => map.surfaceAt(x, z).weights[7] });
  const t0 = performance.now(), net = mk(), buildMs = performance.now() - t0, net2 = mk();
  console.log(JSON.stringify(net.stats), `build ${buildMs.toFixed(0)} ms`);
  assert(JSON.stringify([...net.nx, ...net.ea, ...net.elen]) === JSON.stringify([...net2.nx, ...net2.ea, ...net2.elen]), 'network deterministic');
  assert(net.stats.edges > 0 && net.stats.walkLen > 100, 'network has footpaths');
  assert(net.crossings.length > 0, `zebra crossings built (${net.crossings.length} of ${map.roadDetail.zebras.length} zebras)`);
  const { comp, count } = components(net); const sizes = new Map(); for (const c of comp) sizes.set(c, (sizes.get(c) || 0) + 1);
  console.log('components', count, 'largest', Math.max(...sizes.values()), 'of', net.n);
  assert(Math.max(...sizes.values()) > net.n * 0.4, 'one big connected walk network');
  // walk edges lie on a footpath piece (<= 2.9 m from its kerb line), a corner block (<= 3.2 m from its outline) or a kerb link
  let offPath = 0, samples = 0;
  const fps = map.roadDetail.footpaths, corners = map.roadDetail.cornerBlocks;
  for (let e = 0; e < net.m; e++) if (net.ekind[e] === EDGE.WALK) {
    const a = net.ea[e], b = net.eb[e], n = Math.max(1, Math.ceil(net.elen[e] / 3));
    for (let k = 0; k <= n; k++) {
      const x = net.nx[a] + (net.nx[b] - net.nx[a]) * k / n, z = net.nz[a] + (net.nz[b] - net.nz[a]) * k / n; samples++;
      const onPiece = fps.some((p) => segD(x, z, p.ax, p.az, p.bx, p.bz) < 2.9);
      const onCorner = corners.some((c) => { let d = Infinity; for (let i = 0; i < c.poly.length; i += 2) { const j = (i + 2) % c.poly.length; d = Math.min(d, segD(x, z, c.poly[i], c.poly[i + 1], c.poly[j], c.poly[j + 1])); } let ins = false; for (let i = 0, j = c.poly.length - 2; i < c.poly.length; j = i, i += 2) if ((c.poly[i + 1] > z) !== (c.poly[j + 1] > z) && x < (c.poly[j] - c.poly[i]) * (z - c.poly[i + 1]) / (c.poly[j + 1] - c.poly[i + 1]) + c.poly[i]) ins = !ins; return ins || d < 3.2; });
      if (!onPiece && !onCorner && net.nType[a] !== NODE.KERB && net.nType[b] !== NODE.KERB) { offPath++; if (process.env.DBG) console.log('off', x.toFixed(1), z.toFixed(1), 'edge', e, net.elen[e].toFixed(1)); }
    }
  }
  assert(offPath / samples < 0.02, `walk edges lie on footpaths / corner blocks (${offPath} of ${samples} samples off)`);
  let badCross = 0;
  for (let e = 0; e < net.m; e++) if (net.ekind[e] === EDGE.CROSS) {
    const z = map.roadDetail.zebras[net.ecross[e]], mx = (net.nx[net.ea[e]] + net.nx[net.eb[e]]) / 2, mz = (net.nz[net.ea[e]] + net.nz[net.eb[e]]) / 2;
    if (Math.hypot(mx - z.x, mz - z.z) > 0.5 || Math.abs(net.elen[e] - 2 * (z.hw + 0.5)) > 0.5) badCross++;
  }
  assert(badCross === 0, 'zebra edges span the carriageway at the zebra');

  const fc0 = net.crossings.find((c) => c.group >= 0) || net.crossings[0] || { x: net.nx[0], z: net.nz[0] }, focus = { x: fc0.x, z: fc0.z };
  const run = (seed, { seconds = 120, cap = 150, signal = () => 'red', perM = 0.05, onFrame = null, foc = focus } = {}) => {
    const ew = world(cap, seed), peds = createPedestrians({ ew, net, heightAt: map.heightAt, signalState: signal, cap, perM });
    const log = [];
    ew.on('stateChange', (e) => { if (e.kind === 'ped') log.push(ew.state[e.id]); });
    for (let f = 0; f < seconds * 30; f++) { ew.update(1 / 30, foc); if (onFrame) onFrame(ew, peds, f); }
    return { ew, peds, log };
  };

  // stay on the network, crossingBusy consistent, pool cap
  let worst = 0, busyMismatch = 0, maxLive = 0;
  const r1 = run(7, { onFrame(ew, peds, f) {
    maxLive = Math.max(maxLive, ew.count('ped'));
    if (f % 15) return;
    const want = new Set(), C = peds.comp;
    ew.each('ped', (id) => { worst = Math.max(worst, nearEdge(net, ew.x[id], ew.z[id])); if (ew.state[id] === PED_STATE.WALK && net.ekind[C.edge[id]] === EDGE.CROSS) want.add(net.ecross[C.edge[id]]); });
    for (let i = 0; i < crossingBusy.length; i++) if ((crossingBusy[i] === 1) !== want.has(i)) busyMismatch++;
  } });
  const st = r1.peds.stats(); console.log(JSON.stringify(st), 'worst offset', worst.toFixed(2));
  assert(st.live > 0 && st.spawned > 0, `peds spawned (${st.live} live, target ${st.target})`);
  assert(worst < 1.6, `peds stay within 1.6 m of the walk network (worst ${worst.toFixed(2)} m)`);
  assert(busyMismatch === 0, 'crossingBusy == zebras with a ped on them');
  assert(maxLive <= 150, `pool cap respected (${maxLive})`);
  assert(r1.log.includes(PED_STATE.WALK), 'stateChange events emitted');

  // light: nobody steps onto a signalled zebra on green, they do on red
  let onSignalled = 0, waited = 0, crossedRed = 0;
  run(3, { seconds: 90, perM: 1, signal: () => 'green', onFrame(ew, peds) { ew.each('ped', (id) => { const e = peds.comp.edge[id]; if (ew.state[id] === PED_STATE.WALK && net.ekind[e] === EDGE.CROSS && net.egroup[e] >= 0) onSignalled++; if (ew.state[id] === PED_STATE.WAIT) waited++; }); } });
  run(3, { seconds: 90, perM: 1, signal: () => 'red', onFrame(ew, peds) { ew.each('ped', (id) => { const e = peds.comp.edge[id]; if (ew.state[id] === PED_STATE.WALK && net.ekind[e] === EDGE.CROSS) crossedRed++; }); } });
  assert(onSignalled === 0, 'nobody steps onto a signalled zebra on green');
  if (net.crossings.some((c) => c.group >= 0)) assert(waited > 0, `peds wait at kerbs on green (${waited} ped-frames)`);
  assert(crossedRed > 0, `peds cross on red (${crossedRed} ped-frames)`);

  // determinism
  const sig = (r) => { let h = 0; r.ew.each('ped', (id) => { h = (h * 31 + Math.round(r.ew.x[id] * 100) + Math.round(r.ew.z[id] * 100) * 7) | 0; }); return h + ':' + r.ew.count('ped'); };
  const a = run(11, { seconds: 40 }), b = run(11, { seconds: 40 }), c = run(12, { seconds: 40 });
  assert(sig(a) === sig(b), 'same seed -> same pedestrians');
  assert(sig(a) !== sig(c), 'different seed -> different pedestrians');

  // churn: move the focus around for 10 min, cap never exceeded, ids recycle, all despawn when far away; vendor hook
  {
    const ew = world(150, 5), peds = createPedestrians({ ew, net, heightAt: map.heightAt, cap: 150 });
    const pts = []; for (let e = 0; e < net.m; e += Math.max(1, (net.m / 40) | 0)) pts.push([net.nx[net.ea[e]], net.nz[net.ea[e]]]);
    let over = 0; const seen = new Set(), fc = { x: 0, z: 0 };
    for (let f = 0; f < 30 * 600; f++) {
      const p = pts[Math.floor(f / 150) % pts.length]; fc.x = p[0]; fc.z = p[1];
      ew.update(1 / 30, fc); if (ew.count('ped') > 150) over++; if (f % 30 === 0) ew.each('ped', (id) => seen.add(id));
    }
    const s = peds.stats(); console.log('churn', JSON.stringify(s));
    assert(over === 0 && s.spawned > 20, `churn: ${s.spawned} spawned, ${s.despawned} range-despawned, ${s.live} live, cap never exceeded`);
    assert(ew.list('ped').n === ew.count('ped') && seen.size <= 150, `ids recycled (${seen.size} distinct ids of 150)`);
    for (let f = 0; f < 3; f++) ew.update(1 / 30, { x: -1e5, z: -1e5 });
    assert(ew.count('ped') === 0, 'everything despawns far from the player');
    const id = peds.spawnVendor(10, 10, {}); assert(id >= 0 && ew.alive(id), 'vendor hook spawns an idle ped');
    ew.update(1 / 30, { x: 10, z: 10 }); assert(ew.state[id] === PED_STATE.IDLE && ew.x[id] === 10, 'vendor stays put');
  }

  // benches
  if (net.stats.seats) {
    const seat = [...net.nType].findIndex((t) => t === NODE.SEAT);
    let sat = 0; run(2, { seconds: 400, perM: 1, foc: { x: net.nx[seat], z: net.nz[seat] }, onFrame(ew) { ew.each('ped', (id) => { if (ew.state[id] === PED_STATE.SIT) sat++; }); } });
    assert(sat > 0, `peds sit on benches (${sat} ped-frames)`);
  } else console.log('(no plaza benches on this map)');

  // perf: 300 peds
  {
    const ew = world(300, 9); createPedestrians({ ew, net, heightAt: map.heightAt, cap: 300, perM: 5 });
    for (let f = 0; f < 120; f++) ew.update(1 / 30, focus);
    const n = ew.count('ped'), t1 = performance.now(), F = 600;
    for (let f = 0; f < F; f++) ew.update(1 / 30, focus);
    const per = (performance.now() - t1) / F;
    assert(per < 1, `${n} peds: ${per.toFixed(3)} ms per ew.update (< 1 ms)`);
  }
}
