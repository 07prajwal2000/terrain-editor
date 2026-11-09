// Physics colliders for the scatter: trees (trunk cylinder) and rocks (ball) near the player, from the generator's instance lists (single source of truth:
// colliders are DERIVED from gen.layer('tree' | 'deadtree' | 'rock', cx, cz), never stored separately). No colliders for bushes, grass, flowers, pebbles.
//
//   const pool = createColliderPool({ RAPIER, world, gen });   // pre-creates maxTrees + maxRocks static colliders, all DISABLED (no broad-phase cost, no allocation later)
//   pool.update(x, z);       // call every frame with the vehicle position; cheap no-op until the focus moved >= moveThreshold m, then re-picks the nearest instances
//   pool.stats() -> { trees, rocks, active, capTrees, capRocks, updates, enabledOps }     pool.active() -> [{ kind, x, y, z, radius, halfHeight, layer, index }]
//   pool.setGen(gen)  switch generator (quality change); pool.dispose() removes the colliders.
// Trunk: cylinder radius = clamp(manifest trunkRadius * scale * trunkScale, trunkMin, trunkMax), height min(trunkHeight, tree height) so a car can drive between
// trunks (spacing >= 4 m) and tall foliage does not matter. Rock: ball of ~0.38 * mean(size x, z) * scale whose top sits at ~90 % of the rock height.
// Activation radius cfg.colliders.radius (add) with +6 m hysteresis (remove); if more instances than the cap are in range the nearest win.
export function createColliderPool({ RAPIER, world, gen: gen0, moveThreshold = 3 }) {
  let gen = gen0, cfg = gen.cfg.colliders;
  const mk = (kind, halfHeight, radius) => {
    const desc = kind === 'tree' ? RAPIER.ColliderDesc.cylinder(halfHeight, radius) : RAPIER.ColliderDesc.ball(radius);
    desc.setFriction(0.7).setRestitution(0.1).setTranslation(0, -1e4, 0).setEnabled(false);
    return { collider: world.createCollider(desc), kind, key: -1, x: 0, y: 0, z: 0, radius, halfHeight, layer: '', index: -1, free: true };
  };
  const trees = Array.from({ length: cfg.maxTrees }, () => mk('tree', 1, 0.3));
  const rocks = Array.from({ length: cfg.maxRocks }, () => mk('rock', 0, 1));
  const freeT = trees.slice(), freeR = rocks.slice();          // free lists (stack)
  const live = new Map();                                       // key -> slot
  const stats_ = { updates: 0, enabledOps: 0 };
  let fx = -1e9, fz = -1e9, cand = [];                          // cand is reused (cleared, not re-allocated)
  const LAYER_ID = { tree: 0, deadtree: 1, rock: 2 };

  const keyOf = (layer, cx, cz, i) => (((LAYER_ID[layer] * 2048 + (cx + 512)) * 2048 + (cz + 512)) * 65536) + i;  // < 2^53 for chunk coords < 1024 and i < 65536

  function shape(layer, sp, scale, y) {
    if (layer === 'rock') {
      const r = Math.max(0.3, 0.38 * 0.5 * (sp.size[0] + sp.size[2]) * scale), h = sp.height * scale;
      return { radius: r, halfHeight: 0, cy: y + Math.max(0.2 * r, 0.9 * h - r) };
    }
    const r = Math.min(cfg.trunkMax, Math.max(cfg.trunkMin, (sp.trunkRadius || 0.2) * scale * cfg.trunkScale)), hh = Math.min(cfg.trunkHeight, sp.height * scale) / 2;
    return { radius: r, halfHeight: hh, cy: y + hh };
  }
  function activate(slot, key, layer, cx, cz, i, p) {
    const o = i * 7, sp = gen.species[p.species[i]], s = shape(layer, sp, p.data[o + 4], p.data[o + 1]);
    const c = slot.collider;
    if (slot.kind === 'tree') { c.setRadius(s.radius); c.setHalfHeight(s.halfHeight); } else c.setRadius(s.radius);
    c.setTranslation({ x: p.data[o], y: s.cy, z: p.data[o + 2] });
    c.setEnabled(true); stats_.enabledOps++;
    Object.assign(slot, { key, free: false, x: p.data[o], y: s.cy, z: p.data[o + 2], radius: s.radius, halfHeight: s.halfHeight, layer, index: i });
    live.set(key, slot);
  }
  function release(slot) {
    slot.collider.setEnabled(false); stats_.enabledOps++;
    live.delete(slot.key); slot.free = true; slot.key = -1;
    (slot.kind === 'tree' ? freeT : freeR).push(slot);
  }

  function refresh(x, z) {
    stats_.updates++;
    const R = cfg.radius, S = gen.chunkSize.far, R2 = R * R, keep2 = (R + 6) * (R + 6);
    cand.length = 0;
    const cx0 = Math.max(0, Math.floor((x - R - 20) / S)), cx1 = Math.floor((x + R + 20) / S), cz0 = Math.max(0, Math.floor((z - R - 20) / S)), cz1 = Math.floor((z + R + 20) / S);
    for (const layer of ['tree', 'deadtree', 'rock']) for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const L = gen.layer(layer, cx, cz), p = L.parts[layer];
      for (let i = 0; i < p.n; i++) {
        const dx = p.data[i * 7] - x, dz = p.data[i * 7 + 2] - z, d2 = dx * dx + dz * dz;
        if (d2 <= keep2) cand.push({ key: keyOf(layer, cx, cz, i), d2, layer, cx, cz, i, p });   // (small temp objects only when the focus moved >= moveThreshold)
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const want = new Set(); let nt = 0, nr = 0;
    for (const c of cand) {
      const isRock = c.layer === 'rock';
      if (isRock ? nr >= cfg.maxRocks : nt >= cfg.maxTrees) continue;
      if (c.d2 > R2 && !live.has(c.key)) continue;           // outside the add radius: only keep ones that are already active (hysteresis)
      want.add(c.key); if (isRock) nr++; else nt++;
    }
    for (const slot of [...live.values()]) if (!want.has(slot.key)) release(slot);
    for (const c of cand) if (want.has(c.key) && !live.has(c.key)) {
      const slot = (c.layer === 'rock' ? freeR : freeT).pop(); if (!slot) continue;
      activate(slot, c.key, c.layer, c.cx, c.cz, c.i, c.p);
    }
  }

  return {
    update(x, z) { if (Math.hypot(x - fx, z - fz) < moveThreshold) return false; fx = x; fz = z; refresh(x, z); return true; },
    forceUpdate(x, z) { fx = x; fz = z; refresh(x, z); },
    active: () => [...live.values()].map((s) => ({ kind: s.kind, x: s.x, y: s.y, z: s.z, radius: s.radius, halfHeight: s.halfHeight, layer: s.layer, index: s.index })),
    stats: () => ({ trees: trees.length - freeT.length, rocks: rocks.length - freeR.length, active: live.size, capTrees: cfg.maxTrees, capRocks: cfg.maxRocks, ...stats_ }),
    setGen(g) { gen = g; cfg = g.cfg.colliders; for (const s of [...live.values()]) release(s); fx = fz = -1e9; },
    dispose() { for (const s of [...trees, ...rocks]) world.removeCollider(s.collider, false); live.clear(); freeT.length = freeR.length = 0; },
  };
}
