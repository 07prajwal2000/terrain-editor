// Physics colliders for the city fill: one static oriented cuboid per building (its real brick-body footprint, NOT the lot, so footpath and road stay free) and a small
// cylinder per street bollard, only near the player. Derived from gen.chunk(cx, cz) (single source of truth), pooled like scatterColliders.js.
//
//   const pool = createCityColliderPool({ RAPIER, world, gen });   // pre-creates cfg.colliders.max cuboids + maxBollards cylinders, all DISABLED, no allocation later
//   pool.update(x, z)        every frame with the vehicle position; a cheap no-op until the focus moved >= moveThreshold m, then re-picks the nearest
//   pool.stats() -> { buildings, bollards, active, capBuildings, capBollards, updates, enabledOps }     pool.active() -> [{ kind, x, y, z, hx, hy, hz, yaw, id }]
//   pool.setGen(gen)  pool.dispose()
// Activation radius cfg.colliders.radius (distance of the box centre to the focus minus its half diagonal, so a long facade next to the car counts) with +8 m hysteresis;
// bollards within bollardRange. If more are in range the nearest win (cap).
export function createCityColliderPool({ RAPIER, world, gen: gen0, moveThreshold = 3 }) {
  let gen = gen0, cfg = gen.cfg.colliders;
  const mk = (kind) => {
    const desc = kind === 'building' ? RAPIER.ColliderDesc.cuboid(1, 1, 1) : RAPIER.ColliderDesc.cylinder(0.45, cfg.bollardRadius);
    desc.setFriction(kind === 'building' ? 0.3 : 0.5).setRestitution(0.05).setTranslation(0, -1e4, 0).setEnabled(false);
    return { collider: world.createCollider(desc), kind, key: -1, free: true, x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0, id: -1 };
  };
  const bs = Array.from({ length: cfg.max }, () => mk('building')), ps = Array.from({ length: cfg.maxBollards }, () => mk('bollard'));
  const freeB = bs.slice(), freeP = ps.slice(), live = new Map();
  const stats_ = { updates: 0, enabledOps: 0 };
  let fx = -1e9, fz = -1e9; const cand = [];
  const keyOf = (kind, cx, cz, i) => ((((kind === 'building' ? 0 : 1) * 2048 + (cx + 512)) * 2048 + (cz + 512)) * 65536) + i;

  function activate(slot, key, c) {
    const co = slot.collider;
    if (c.kind === 'building') {
      co.setHalfExtents({ x: c.hx, y: c.hy, z: c.hz });
      co.setRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
    } else { co.setHalfHeight(c.hy); co.setRadius(c.hx); }
    co.setTranslation({ x: c.x, y: c.y, z: c.z }); co.setEnabled(true); stats_.enabledOps++;
    Object.assign(slot, { key, free: false, x: c.x, y: c.y, z: c.z, hx: c.hx, hy: c.hy, hz: c.hz, yaw: c.yaw, id: c.id });
    live.set(key, slot);
  }
  function release(slot) {
    slot.collider.setEnabled(false); stats_.enabledOps++;
    live.delete(slot.key); slot.free = true; slot.key = -1; (slot.kind === 'building' ? freeB : freeP).push(slot);
  }
  function refresh(x, z) {
    stats_.updates++;
    const R = cfg.radius, S = gen.chunkSize, reach = R + 8 + 30;
    cand.length = 0;
    for (let cz = Math.floor((z - reach) / S); cz <= Math.floor((z + reach) / S); cz++) for (let cx = Math.floor((x - reach) / S); cx <= Math.floor((x + reach) / S); cx++) {
      if (cx < 0 || cz < 0) continue;
      const L = gen.chunk(cx, cz);
      L.buildings.forEach((b, i) => {
        const c = b.col, d = Math.max(0, Math.hypot(c.cx - x, c.cz - z) - Math.hypot(c.hu, c.hv));
        if (d <= R + 8) cand.push({ key: keyOf('building', cx, cz, i), d, kind: 'building', id: b.id, x: c.cx, y: (c.y0 + c.y1) / 2, z: c.cz, hx: c.hu, hy: (c.y1 - c.y0) / 2, hz: c.hv, yaw: Math.atan2(-b.uz, b.ux) });
      });
      L.props.bollard.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= cfg.bollardRange + 6) cand.push({ key: keyOf('bollard', cx, cz, i), d, kind: 'bollard', id: i, x: p.x, y: p.y + cfg.bollardHeight / 2, z: p.z, hx: cfg.bollardRadius, hy: cfg.bollardHeight / 2, hz: 0, yaw: 0 });
      });
    }
    cand.sort((a, b) => a.d - b.d);
    const want = new Set(); let nb = 0, np = 0;
    for (const c of cand) {
      const isB = c.kind === 'building';
      if (isB ? nb >= cfg.max : np >= cfg.maxBollards) continue;
      if (c.d > (isB ? R : cfg.bollardRange) && !live.has(c.key)) continue;
      want.add(c.key); if (isB) nb++; else np++;
    }
    for (const s of [...live.values()]) if (!want.has(s.key)) release(s);
    for (const c of cand) if (want.has(c.key) && !live.has(c.key)) { const slot = (c.kind === 'building' ? freeB : freeP).pop(); if (slot) activate(slot, c.key, c); }
  }
  return {
    update(x, z) { if (Math.hypot(x - fx, z - fz) < moveThreshold) return false; fx = x; fz = z; refresh(x, z); return true; },
    forceUpdate(x, z) { fx = x; fz = z; refresh(x, z); },
    active: () => [...live.values()].map((s) => ({ kind: s.kind, x: s.x, y: s.y, z: s.z, hx: s.hx, hy: s.hy, hz: s.hz, yaw: s.yaw, id: s.id })),
    stats: () => ({ buildings: bs.length - freeB.length, bollards: ps.length - freeP.length, active: live.size, capBuildings: cfg.max, capBollards: cfg.maxBollards, ...stats_ }),
    setGen(g) { gen = g; cfg = g.cfg.colliders; for (const s of [...live.values()]) release(s); fx = fz = -1e9; },
    dispose() { for (const s of [...bs, ...ps]) world.removeCollider(s.collider, false); live.clear(); freeB.length = freeP.length = 0; },
  };
}
