// node scripts/test-house-kit.mjs : every houseKit variant over many seeds / footprints.
import assert from 'node:assert/strict';
import { planHouse, VARIANTS, TRI_BUDGET } from '../src/world/houseKit.js';
import { hash } from '../src/world/scatterGen.js';

const N = 60, stats = {};
let total = 0, ms = 0, gardens = 0;
for (const variant of VARIANTS) {
  const st = stats[variant] = { min: 1e9, max: 0 };
  for (let s = 0; s < N; s++) {
    const spec = { groundAt: (x, z) => 0.15 * x - 0.1 * z, hu: 6 + hash(s, 1, 0, 0) * 4, hv: 4.5 + hash(s, 2, 0, 0) * 2.5, seed: s * 7919 + 13, driveway: s & 1 ? 'left' : 'right', weight: hash(s, 3, 0, 0), variant };
    spec.front = spec.hv + 6;
    const t0 = performance.now(), h = planHouse(spec); ms += performance.now() - t0; total++;
    const h2 = planHouse(spec);
    assert.equal(h.tris, h2.tris); assert.deepEqual(h.prims[0].pos, h2.prims[0].pos, 'deterministic');
    assert.ok(h.tris < TRI_BUDGET, `${variant} ${s}: ${h.tris} tris`);
    st.min = Math.min(st.min, h.tris); st.max = Math.max(st.max, h.tris);
    for (const p of h.prims) {
      const slab = ['driveway', 'walk', 'hedge', 'shrub', 'fence', 'flower'].includes(p.mat), e = 1e-4;
      for (let i = 0; i < p.pos.length; i += 3) {
        const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
        assert.ok(Number.isFinite(x + y + z), 'finite');
        assert.ok(Math.abs(x) <= spec.hu + e && z >= -spec.hv - e && z <= (slab ? spec.front : spec.hv) + e && y >= (slab && p.mat !== 'driveway' && p.mat !== 'walk' ? -3 : -e), `${variant} ${s} ${p.mat} out of footprint (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)})`);
        assert.ok(Math.abs(Math.hypot(p.nor[i], p.nor[i + 1], p.nor[i + 2]) - 1) < 1e-4, 'unit normal');
      }
      for (let t = 0; t < p.idx.length; t += 3) {   // winding agrees with the normal (outward faces)
        const [a, b, c] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]].map((k) => 3 * k), P = p.pos;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
        assert.ok(gx * p.nor[a] + gy * p.nor[a + 1] + gz * p.nor[a + 2] > 0, `${variant} ${s} ${p.mat} winding`);
      }
    }
    const slabs = h.prims.filter((p) => p.mat === 'driveway' || p.mat === 'walk').map((p) => { const xs = [], zs = []; for (let i = 0; i < p.pos.length; i += 3) { xs.push(p.pos[i]); zs.push(p.pos[i + 2]); } return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]; });
    for (const b of h.garden) {
      assert.ok(b.z0 > spec.hv, 'garden box in front yard');
      for (const [x0, x1, z0, z1] of slabs) assert.ok(b.x1 <= x0 || b.x0 >= x1 || b.z1 <= z0 || b.z0 >= z1, `${variant} ${s} ${b.mat} blocks drive/walk`);
    }
    gardens += h.garden.length > 0;
    assert.ok(h.collider.length > 0 && h.collider.every((c) => Math.abs(c.cx) + c.hu <= spec.hu + 1e-4));
  }
}
// unforced variant pick covers everything
const seen = new Set(); for (let s = 0; s < 2000; s++) seen.add(planHouse({ hu: 8, hv: 6, seed: s }).variant);
assert.equal(seen.size, VARIANTS.length);
for (const [v, st] of Object.entries(stats)) console.log(v.padEnd(14), `tris ${st.min}-${st.max}`);
console.log(`${gardens}/${total} houses with a garden`);
console.log(`ok: ${total} houses, ${(ms / total).toFixed(3)} ms/house plan`);
