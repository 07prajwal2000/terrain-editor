// Debug demo for the entity layer (play.html?entityDemo=1, optional &entityN=2000): N tinted boxes ('prop' kind, 4 variants = 4 draw calls) wander round the
// player, stick to the terrain, get culled beyond cullRadius and respawned near the player via the 'despawn' event. Proves entities.js + entityRender.js.
//   const demo = createEntityDemo({ THREE, scene, heightAt, n });  demo.update(dt, focus, timeSec)  demo.stats()  demo.dispose()
// Stats (update ms EMA, live, drawn, draw calls) are also printed to the console every 5 s.
import { createEntityWorld } from './entities.js';
import { createEntityRenderer } from './entityRender.js';

export function wanderSystem(ew, heightAt) {
  return {
    name: 'wander', kinds: ['prop'],
    update(ew_, dt) {
      const { ids, n } = ew.list('prop');
      for (let i = 0; i < n; i++) {
        const id = ids[i]; if (!ew.shouldUpdate(id)) continue;
        const d = ew.stepDt(id, dt);
        if (ew.rand() < 0.01) ew.heading[id] += (ew.rand() - 0.5) * 2;
        const h = ew.heading[id], v = ew.speed[id] * d;
        ew.x[id] += Math.sin(h) * v; ew.z[id] += Math.cos(h) * v;
        if (heightAt) ew.y[id] = heightAt(ew.x[id], ew.z[id]);
        ew.anim[id] += d * ew.speed[id];
      }
    },
  };
}

export function createEntityDemo({ THREE, scene, heightAt, n = 2000, radius = 120 }) {
  const ew = createEntityWorld({ caps: { prop: { cap: n, simRadius: 150, cullRadius: 220, farRate: 4 } }, seed: 7 });
  const er = createEntityRenderer({ THREE, scene, ew });
  const geo = new THREE.BoxGeometry(1, 1.6, 1).translate(0, 0.8, 0);
  const mats = [0, 1, 2, 3].map(() => new THREE.MeshLambertMaterial({ color: 0xffffff }));
  mats.forEach((m, v) => er.register('prop', v, geo, m, { max: n, drawRadius: 180 }));
  ew.addSystem(wanderSystem(ew, heightAt));
  const palette = [0xe04040, 0x40c060, 0x4080e0, 0xe0c040, 0xc060e0, 0x40d0d0];
  let fx = 0, fz = 0;
  const place = () => {
    const a = ew.rand() * Math.PI * 2, r = 10 + ew.rand() * radius, x = fx + Math.cos(a) * r, z = fz + Math.sin(a) * r;
    ew.spawn('prop', { x, z, y: heightAt ? heightAt(x, z) : 0, heading: ew.rand() * 6.283, speed: 1 + ew.rand() * 2, variant: (ew.rand() * 4) | 0, tint: palette[(ew.rand() * 6) | 0], scale: 0.7 + ew.rand() * 0.6 });
  };
  let pending = 0;
  ew.on('despawn', (e) => { if (e.data === 'cull') pending++; });   // recycle: never spawn inside the listener, the pool slot is freed after it
  let ms = 0, last = 0, started = false;
  return {
    ew, er,
    update(dt, focus, time) {
      fx = focus.x; fz = focus.z;
      if (!started) { started = true; for (let i = 0; i < n; i++) place(); }
      const t0 = performance.now();
      ew.update(dt, focus);
      for (; pending > 0; pending--) place();
      er.update(focus, time);
      ms += (performance.now() - t0 - ms) * 0.05;
      if (time - last > 5) { last = time; console.log('[entityDemo]', JSON.stringify(this.stats())); }
    },
    stats: () => ({ updateMs: +ms.toFixed(3), live: ew.count('prop'), ...er.stats() }),
    dispose() { er.dispose(); geo.dispose(); mats.forEach((m) => m.dispose()); },
  };
}
