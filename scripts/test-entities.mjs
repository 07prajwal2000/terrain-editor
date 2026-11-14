// Tests + micro-benchmark for src/world/entities.js (and a headless entityRender/entityDemo pass). node scripts/test-entities.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntityWorld, FAR } from '../src/world/entities.js';
import { createEntityDemo } from '../src/world/entityDemo.js';

// pool capacity / full / reuse
{
  const ew = createEntityWorld({ caps: { car: 3, ped: 2 } });
  const a = [0, 1, 2].map(() => ew.spawn('car', {}));
  assert.deepEqual(a, [0, 1, 2]); assert.equal(ew.spawn('car'), -1); assert.equal(ew.count('car'), 3);
  assert.equal(ew.spawn('ped'), 3); assert.equal(ew.kindName(3), 'ped');
  assert.ok(ew.despawn(1)); assert.ok(!ew.despawn(1)); assert.equal(ew.spawn('car'), 1, 'freed id reused');
}
// events + each + churn + components
{
  const ew = createEntityWorld({ caps: { ped: 100 }, seed: 3 });
  const log = { spawn: 0, despawn: 0, state: 0, honk: 0 };
  ew.on('spawn', () => log.spawn++); ew.on('despawn', () => log.despawn++);
  ew.on('stateChange', (e) => { log.state++; assert.equal(e.data, 0); }); ew.on('honk', (e) => { log.honk++; assert.equal(e.kind, 'ped'); });
  const col = ew.addComponent('collider', 'ped', { hx: 'f32', slot: 'i32' });
  const live = new Set();
  for (let i = 0; i < 20000; i++) {
    if (live.size && (ew.rand() < 0.5 || live.size === 100)) { const id = [...live][(ew.rand() * live.size) | 0]; ew.despawn(id); live.delete(id); }
    else { const id = ew.spawn('ped', { x: ew.rand() * 500, z: ew.rand() * 500 }); assert.ok(id >= 0); assert.equal(col.hx[id], 0); col.hx[id] = 5; live.add(id); }
  }
  assert.equal(ew.count('ped'), live.size);
  const seen = new Set(); ew.each('ped', (id) => { assert.ok(!seen.has(id)); seen.add(id); });
  assert.deepEqual([...seen].sort((a, b) => a - b), [...live].sort((a, b) => a - b));
  assert.equal(log.spawn - log.despawn, live.size);
  const id0 = [...live][0]; ew.setState(id0, 2); ew.setState(id0, 2); assert.equal(log.state, 1);
  ew.emit('honk', id0); assert.equal(log.honk, 1);
  // despawn current inside each
  ew.each('ped', (id) => ew.despawn(id)); assert.equal(ew.count('ped'), 0);
  for (let i = 0; i < 100; i++) assert.ok(ew.spawn('ped') >= 0, 'no leak after churn');
}
// near() vs brute force, after moves
{
  const ew = createEntityWorld({ caps: { car: 500, ped: 500 }, cellSize: 10, seed: 9 });
  for (let i = 0; i < 1000; i++) ew.spawn(i & 1 ? 'car' : 'ped', { x: (ew.rand() - 0.5) * 400, z: (ew.rand() - 0.5) * 400 });
  ew.addSystem({ name: 'move', update(w) { for (const k of ['car', 'ped']) w.each(k, (id) => { w.x[id] += (w.rand() - 0.5) * 30; w.z[id] += (w.rand() - 0.5) * 30; }); } });
  const out = [];
  for (let t = 0; t < 5; t++) {
    ew.update(0.1);
    for (let q = 0; q < 50; q++) {
      const x = (ew.rand() - 0.5) * 400, z = (ew.rand() - 0.5) * 400, r = ew.rand() * 60, kind = q % 3 === 0 ? undefined : q % 3 === 1 ? 'car' : 'ped';
      const got = ew.near(x, z, r, kind, out).slice().sort((a, b) => a - b);
      const want = []; for (let id = 0; id < ew.N; id++) if (ew.alive(id) && (!kind || ew.kindName(id) === kind) && (ew.x[id] - x) ** 2 + (ew.z[id] - z) ** 2 <= r * r) want.push(id);
      assert.deepEqual(got, want);
    }
  }
}
// LOD: FAR flag, cull despawn with reason
{
  const ew = createEntityWorld({ caps: { car: { cap: 4, simRadius: 50, cullRadius: 100, farRate: 4 } } });
  const a = ew.spawn('car', { x: 10 }), b = ew.spawn('car', { x: 70 }), c = ew.spawn('car', { x: 200 });
  const culled = []; ew.on('despawn', (e) => culled.push([e.id, e.data]));
  ew.update(0.016, { x: 0, z: 0 });
  assert.ok(!(ew.flags[a] & FAR)); assert.ok(ew.flags[b] & FAR); assert.deepEqual(culled, [[c, 'cull']]);
  assert.equal(ew.stepDt(b, 1), 4); let k = 0; for (let f = 0; f < 8; f++) { if (ew.shouldUpdate(b)) k++; ew.frame++; } assert.equal(k, 2);
}
// determinism
{
  const run = () => { const d = createEntityDemo({ THREE, scene: new THREE.Scene(), n: 300 }); d.update(0.016, { x: 0, z: 0 }, 0);
    for (let i = 0; i < 100; i++) d.update(0.016, { x: i, z: 0 }, i * 0.016); return Array.from(d.ew.x.slice(0, 300)).join(); };
  assert.equal(run(), run());
}
// benchmark: core update of 5000 entities with a wander system, and the 2000-entity demo incl. instance writes
{
  const ew = createEntityWorld({ caps: { ped: { cap: 5000, simRadius: 300, cullRadius: 1e9 } }, seed: 1 });
  for (let i = 0; i < 5000; i++) ew.spawn('ped', { x: (ew.rand() - 0.5) * 600, z: (ew.rand() - 0.5) * 600, heading: ew.rand() * 6, speed: 1.4 });
  ew.addSystem({ name: 'walk', update(w, dt) { const { ids, n } = w.list('ped'); for (let i = 0; i < n; i++) { const id = ids[i]; if (!w.shouldUpdate(id)) continue; const d = w.stepDt(id, dt); w.x[id] += Math.sin(w.heading[id]) * w.speed[id] * d; w.z[id] += Math.cos(w.heading[id]) * w.speed[id] * d; } } });
  const focus = { x: 0, z: 0 }; for (let i = 0; i < 200; i++) ew.update(1 / 60, focus);
  const F = 1000, t0 = performance.now(); for (let i = 0; i < F; i++) ew.update(1 / 60, focus);
  const ms5k = (performance.now() - t0) / F;
  const d = createEntityDemo({ THREE, scene: new THREE.Scene(), n: 2000 }); for (let i = 0; i < 100; i++) d.update(1 / 60, focus, i / 60);
  const t1 = performance.now(); for (let i = 0; i < F; i++) d.update(1 / 60, focus, i / 60); const ms2k = (performance.now() - t1) / F;
  console.log(`bench: core update 5000 peds ${ms5k.toFixed(3)} ms/frame; demo 2000 (sim + instance writes) ${ms2k.toFixed(3)} ms/frame, drawn ${d.stats().drawn}, draw calls ${d.stats().drawCalls}`);
  assert.ok(ms5k < 2, 'core update budget');
}
console.log('test-entities: all passed');
