// Shared entity layer for city life (plan part 6a). Pure JS, no THREE, no physics. Traffic (6b), pedestrians (6c) and street props / carts (6d) all live here,
// so a future sound / fx system subscribes once (events + components) and covers every entity uniformly.
//
//   const ew = createEntityWorld({ caps: { car: { cap: 64, simRadius: 300, cullRadius: 360, farRate: 4 }, ped: 400, cart: 16, prop: 512 }, cellSize: 16, seed: 1 });
//
// Storage: one struct-of-arrays over ALL kinds; each kind owns a fixed id range [base, base+cap), so an id indexes every array directly:
//   ew.x, ew.y, ew.z, ew.heading (rad, about +Y; forward = (sin h, 0, cos h), same as THREE rotation.y), ew.speed (m/s), ew.scale (1), ew.anim (free per-entity phase,
//   the renderer feeds it to the shader as aPhase), ew.tint (Uint32 0xRRGGBB, 0 = keep material colour), ew.state (Uint8), ew.variant (Uint8, picks the mesh),
//   ew.flags (Uint16; bit 0 ALIVE and bit 1 FAR are owned here, bits 2..15 free for the kind), ew.kindOf (Uint8 kind index), ew.dist2 (to focus, refreshed by update).
//   Write positions straight into the arrays; the grid catches up at the end of every update (or call ew.relink(id) after a teleport if you query before that).
//
// API
//   spawn(kind, init?) -> id | -1 when that kind's pool is full. init: { x, y, z, heading, speed, scale, state, variant, tint, anim, flags }. Emits 'spawn'.
//   despawn(id, reason?) -> bool. Emits 'despawn' (data = reason, e.g. 'cull'), clears components, id goes back on the free list (LIFO, so ids get reused).
//   alive(id)  count(kind)  cap(kind)  kindName(id)
//   each(kind, fn(id, ew))  no allocation; iterates exactly the live entities, backwards, so despawning the CURRENT id inside fn is safe (others: use list()).
//   list(kind) -> { ids: Int32Array, n }  the dense live list for raw for-loops (do not mutate; despawn reorders it).
//   near(x, z, r, kind?, out=[]) -> out (ids within r on the XZ plane; out.length reset to 0 first). Uniform grid, hashed, updated incrementally.
//   setState(id, s)  emits 'stateChange' (data = previous state) only when it changes.
//   on(type, fn(ev)) -> off()   emit(type, id, data)   ev = { type, id, kind, data } is ONE reused object: copy fields if you keep them. Types: spawn, despawn,
//     stateChange, plus anything custom ('honk', 'bell', 'shout', ...).
//   addComponent(name, kind, schema) -> store: per-kind optional data, e.g. addComponent('collider', 'car', { hx: 'f32', hy: 'f32', hz: 'f32', slot: 'i32' }).
//     store.hx[id] ... (arrays are id-indexed, zeroed on spawn/despawn); store.has[id] (Uint8) is yours to set. comp(name, kind) fetches it later.
//   addSystem({ name, kinds?, update(ew, dt, focus) })  run in insertion order by ew.update.
//   update(dt, focus={x,z})  1) LOD pass: dist2, FAR flag, despawn('cull') beyond cullRadius  2) systems  3) grid relink of moved entities  4) frame++.
//   shouldUpdate(id) -> true for near entities, every farRate-th frame for FAR ones (staggered by id). stepDt(id, dt) -> dt * farRate when FAR, so a skipping system
//     still moves at the right average speed:  if (!ew.shouldUpdate(id)) return; const d = ew.stepDt(id, dt);
//   rand() deterministic mulberry32 from cfg.seed (use it instead of Math.random so runs replay).  stats()
//
// How 6b/6c/6d plug in
//   - Own a kind each: 'car' (traffic.js), 'ped' (pedestrians.js), 'cart' + 'prop' (streetProps.js). Pass caps from the quality preset into ONE shared world (main.js).
//   - A spawner listens for on('despawn') with data 'cull' (or just watches count) and respawns ahead of the player, so pools recycle instead of grow.
//   - Behaviour = a system over its kind; keep per-entity scratch in a component (e.g. 'lane': { seg: 'i32', t: 'f32' }) not in JS objects.
//   - Rendering: entityRender.js, register one geometry/material per (kind, variant); peds pass anim.onShader for the walk cycle driven by ew.anim.
//   - Colliders (cars near the player, solid props): DO NOT give every entity a body. Mirror cityColliders.js: pre-create a small pool of DISABLED Rapier cuboids,
//     and each frame (or when the focus moved > a few m) take ew.near(px, pz, R, 'car', tmp), enable/reposition one cuboid per hit using a 'collider' component
//     (hx/hy/hz, slot = pool index or -1), release slots whose entity left range or despawned (listen to 'despawn'). Cars are kinematic: setTranslation/setRotation
//     from ew.x/z/heading; pedestrians never get one (the player passes through them).
//   - Sound/fx later: on('honk', ...) / on('spawn', ...) + each(kind) + near(focus) to choose the closest voices. Nothing in 6b/c/d needs to know about them.
//
// Limitations: caps are fixed at creation (pick per quality). near() is XZ-only. Grid hash has 4096 buckets (collisions are filtered, only cost time).
// Event listeners must not throw. Ids are reused, so hold (id, ew.gen[id]) if you keep references across frames (gen bumps on every spawn).

export const ALIVE = 1, FAR = 2;
const BUCKETS = 4096;
const TYPES = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array };

export function createEntityWorld({ caps = {}, cellSize = 16, seed = 1 } = {}) {
  const kinds = [], kindIdx = {};
  let N = 0;
  for (const [name, c] of Object.entries(caps)) {
    const o = typeof c === 'number' ? { cap: c } : { ...c };
    const k = { name, idx: kinds.length, base: N, cap: o.cap | 0, simRadius: o.simRadius ?? Infinity, cullRadius: o.cullRadius ?? Infinity, farRate: Math.max(1, o.farRate ?? 4) };
    k.free = new Int32Array(k.cap); k.nFree = k.cap;
    for (let i = 0; i < k.cap; i++) k.free[i] = k.base + k.cap - 1 - i;   // pop() yields base first
    k.live = new Int32Array(k.cap); k.n = 0;
    kinds.push(k); kindIdx[name] = k; N += k.cap;
  }
  const K = (kind) => { const k = kindIdx[kind]; if (!k) throw new Error(`entities: unknown kind "${kind}"`); return k; };

  const ew = {
    N, frame: 0,
    x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), heading: new Float32Array(N), speed: new Float32Array(N),
    scale: new Float32Array(N), anim: new Float32Array(N), dist2: new Float32Array(N), tint: new Uint32Array(N),
    state: new Uint8Array(N), variant: new Uint8Array(N), flags: new Uint16Array(N), kindOf: new Uint8Array(N), gen: new Uint16Array(N),
  };
  const livePos = new Int32Array(N);   // index into kind.live
  // grid: bucket heads + doubly linked lists, cell coords per entity so hash collisions are filtered
  const head = new Int32Array(BUCKETS).fill(-1), next = new Int32Array(N).fill(-1), prev = new Int32Array(N).fill(-1);
  const cxOf = new Int32Array(N), czOf = new Int32Array(N), bucketOf = new Int32Array(N).fill(-1);
  const inv = 1 / cellSize;
  const hash = (cx, cz) => (((cx * 73856093) ^ (cz * 19349663)) >>> 0) & (BUCKETS - 1);

  function unlink(id) {
    const b = bucketOf[id]; if (b < 0) return;
    if (prev[id] >= 0) next[prev[id]] = next[id]; else head[b] = next[id];
    if (next[id] >= 0) prev[next[id]] = prev[id];
    next[id] = prev[id] = -1; bucketOf[id] = -1;
  }
  function relink(id) {
    const cx = Math.floor(ew.x[id] * inv), cz = Math.floor(ew.z[id] * inv);
    if (bucketOf[id] >= 0 && cx === cxOf[id] && cz === czOf[id]) return;
    unlink(id);
    const b = hash(cx, cz); cxOf[id] = cx; czOf[id] = cz; bucketOf[id] = b;
    next[id] = head[b]; prev[id] = -1; if (head[b] >= 0) prev[head[b]] = id; head[b] = id;
  }

  // events (one reused event object, listener arrays never reallocated during emit)
  const listeners = {}, ev = { type: '', id: -1, kind: '', data: undefined };
  function emit(type, id, data) {
    const ls = listeners[type]; if (!ls || ls.length === 0) return;
    for (let i = 0; i < ls.length; i++) {
      ev.type = type; ev.id = id; ev.kind = id >= 0 ? kinds[ew.kindOf[id]].name : ''; ev.data = data;
      ls[i](ev);
    }
  }
  function on(type, fn) {
    (listeners[type] ||= []).push(fn);
    return () => { const ls = listeners[type], i = ls.indexOf(fn); if (i >= 0) listeners[type] = ls.slice(0, i).concat(ls.slice(i + 1)); };
  }

  // components
  const comps = {};
  function addComponent(name, kind, schema) {
    K(kind); const key = name + '/' + kind;
    if (comps[key]) return comps[key];
    const store = { name, kind, has: new Uint8Array(N), fields: [] };
    for (const [f, t] of Object.entries(schema)) { if (!TYPES[t]) throw new Error(`entities: bad type ${t}`); store[f] = new TYPES[t](N); store.fields.push(f); }
    store.fields.push('has');
    (K(kind).comps ||= []).push(store);
    return (comps[key] = store);
  }
  const clearComps = (k, id) => { if (k.comps) for (const s of k.comps) for (const f of s.fields) s[f][id] = 0; };

  function spawn(kind, init) {
    const k = K(kind); if (k.nFree === 0) return -1;
    const id = k.free[--k.nFree];
    ew.x[id] = init?.x ?? 0; ew.y[id] = init?.y ?? 0; ew.z[id] = init?.z ?? 0; ew.heading[id] = init?.heading ?? 0; ew.speed[id] = init?.speed ?? 0;
    ew.scale[id] = init?.scale ?? 1; ew.anim[id] = init?.anim ?? 0; ew.tint[id] = init?.tint ?? 0; ew.state[id] = init?.state ?? 0; ew.variant[id] = init?.variant ?? 0;
    ew.flags[id] = ((init?.flags ?? 0) & ~(ALIVE | FAR)) | ALIVE; ew.kindOf[id] = k.idx; ew.gen[id]++; ew.dist2[id] = 0;
    clearComps(k, id);
    livePos[id] = k.n; k.live[k.n++] = id;
    relink(id);
    emit('spawn', id, undefined);
    return id;
  }
  function despawn(id, reason) {
    if (id < 0 || id >= N || !(ew.flags[id] & ALIVE)) return false;
    const k = kinds[ew.kindOf[id]];
    emit('despawn', id, reason);
    ew.flags[id] = 0; unlink(id); clearComps(k, id);
    const p = livePos[id], last = k.live[--k.n]; k.live[p] = last; livePos[last] = p;
    k.free[k.nFree++] = id;
    return true;
  }

  function near(x, z, r, kind, out = []) {
    out.length = 0;
    const kf = kind ? K(kind).idx : -1, r2 = r * r;
    const x0 = Math.floor((x - r) * inv), x1 = Math.floor((x + r) * inv), z0 = Math.floor((z - r) * inv), z1 = Math.floor((z + r) * inv);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      for (let id = head[hash(cx, cz)]; id >= 0; id = next[id]) {
        if (cxOf[id] !== cx || czOf[id] !== cz || (kf >= 0 && ew.kindOf[id] !== kf)) continue;
        const dx = ew.x[id] - x, dz = ew.z[id] - z;
        if (dx * dx + dz * dz <= r2) out.push(id);
      }
    }
    return out;
  }

  const systems = [];
  let rs = (seed >>> 0) || 1;
  Object.assign(ew, {
    kinds, spawn, despawn, near, on, emit, addComponent, relink,
    comp: (name, kind) => comps[name + '/' + kind],
    alive: (id) => id >= 0 && id < N && (ew.flags[id] & ALIVE) !== 0,
    count: (kind) => K(kind).n, cap: (kind) => K(kind).cap, kindName: (id) => kinds[ew.kindOf[id]].name,
    list: (kind) => { const k = K(kind); return { ids: k.live, n: k.n }; },
    each(kind, fn) { const k = K(kind); for (let i = k.n - 1; i >= 0; i--) { if (i >= k.n) continue; fn(k.live[i], ew); } },
    setState(id, s) { const p = ew.state[id]; if (p === s) return; ew.state[id] = s; emit('stateChange', id, p); },
    addSystem(sys) { systems.push(sys); return sys; },
    shouldUpdate(id) { if (!(ew.flags[id] & FAR)) return true; return (ew.frame + id) % kinds[ew.kindOf[id]].farRate === 0; },
    stepDt(id, dt) { return ew.flags[id] & FAR ? dt * kinds[ew.kindOf[id]].farRate : dt; },
    rand() { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
    update(dt, focus) {
      const fx = focus ? focus.x : 0, fz = focus ? focus.z : 0;
      for (const k of kinds) {
        const s2 = k.simRadius * k.simRadius, c2 = k.cullRadius * k.cullRadius;
        for (let i = k.n - 1; i >= 0; i--) {
          const id = k.live[i], dx = ew.x[id] - fx, dz = ew.z[id] - fz, d2 = dx * dx + dz * dz;
          ew.dist2[id] = d2;
          if (focus && d2 > c2) { despawn(id, 'cull'); continue; }
          ew.flags[id] = d2 > s2 ? ew.flags[id] | FAR : ew.flags[id] & ~FAR;
        }
      }
      for (let i = 0; i < systems.length; i++) systems[i].update(ew, dt, focus);
      for (const k of kinds) for (let i = 0; i < k.n; i++) relink(k.live[i]);
      ew.frame++;
    },
    stats: () => Object.fromEntries(kinds.map((k) => [k.name, { live: k.n, cap: k.cap }])),
  });
  return ew;
}
