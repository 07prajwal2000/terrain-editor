// City fill renderer: buildings (procedural from the kit pieces + whole GLB landmarks, public/city/city.glb) and street props, placed by cityGen.js (see its header for the placement rules and
// city.json), with near-player physics colliders (cityColliders.js).
//
//   const city = createCity({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl: '/maps/citytest/', options });
//   city.update(dt, focus?)   every frame after the camera moved (focus = {x,z} = vehicle, for the colliders; default camera). No-op until city.ready resolved.
//   city.genReady             Promise: the generator exists (city.gen, city.blocked) after the optional city.json override was read. Cheap (no GLB): await it BEFORE creating the
//                             nature scatter and pass `extraBlocked: city.blocked` so trees keep off the buildings.
//   city.ready                Promise: the GLB is loaded (skipped when the map has no lots at all: then nothing is downloaded)
//   city.setQuality('low'|'medium'|'high')   city.stats()   city.dispose()   city.gen   city.pool   city.group   city.blocked(x, z, margin)
//   options: { quality = 'medium', cityUrl = '/city/', budgetMs = 3, config = {} (overrides CITY_CONFIG), exclusions = [{x,z,r}], colliders = true, shadows = false (near buildings cast) }
//
// LEVELS OF DETAIL. Buildings are generated in 128 m chunks (lazily, nearest first, under a per-frame budget). Every chunk gets ONE cheap PROXY mesh per material (plain brick wall pieces on the
// street face + both sides, flat roof, set 0.3 m inside the real surfaces; all buildings of the chunk merged, drawn up to cfg.lod.cull). Within cfg.lod.d[0] the DETAILED building is drawn
// on top: a whole GLB landmark = one instanced mesh per (asset, material); a procedural building = its pieces (cityKit.js planBuilding) merged into ONE geometry per material, built lazily
// (one building per frame at most within the budget, nearest first, at most cfg.lod.maxLive alive, disposed when out of range). A plinth box (instanced) fills the gap under a building on sloped
// ground; bollards / planters are instanced within cfg.lod.props. Draw calls are bounded by (live procedural buildings x ~5 materials) + chunks in range x 2 + assets x materials.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createCityGen, CITY_CONFIG } from './cityGen.js';
import { createCityColliderPool } from './cityColliders.js';
import { planBuilding, planProxy, kitPieceNames } from './cityKit.js';

const RESCAN_DIST = 10, SORT_DIST = 2.5, SORT_COS = Math.cos(3 * Math.PI / 180);
const K_PLINTH = 20, K_BOLLARD = 21, K_PLANTER = 22;

async function optionalJson(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const t = await r.text(); if (t.trimStart().startsWith('<')) return null;   // dev servers answer a missing file with index.html
    return JSON.parse(t);
  } catch (e) { console.warn('city: could not read', url, e.message || e); return null; }
}

// merges placed copies of kit primitives (position / normal / uv) into one geometry per material
export class PieceMerger {
  constructor() { this.m = new Map(); }
  // prims = [{ mat, pos, nor, uv, idx }]; world position (x,y,z), rotation yaw about Y, scale (sx,sy,sz) in the piece's local axes
  add(prims, x, y, z, yaw, sx = 1, sy = 1, sz = 1) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const p of prims) {
      let a = this.m.get(p.mat); if (!a) this.m.set(p.mat, a = { pos: [], nor: [], uv: [], col: [], cs: p.cs, idx: [], n: 0 });
      const base = a.n, n = p.pos.length / 3;
      for (let i = 0; i < n; i++) {
        const px = p.pos[3 * i] * sx, py = p.pos[3 * i + 1] * sy, pz = p.pos[3 * i + 2] * sz, nx = p.nor[3 * i], ny = p.nor[3 * i + 1], nz = p.nor[3 * i + 2];
        a.pos.push(x + px * c + pz * s, y + py, z - px * s + pz * c); a.nor.push(nx * c + nz * s, ny, -nx * s + nz * c); a.uv.push(p.uv[2 * i], p.uv[2 * i + 1]);
        for (let q = 0; q < a.cs; q++) a.col.push(p.cs === a.cs ? p.col[p.cs * i + q] : 1);   // COLOR_0 carries the baked ambient occlusion of the kit: without it the walls render black
      }
      for (let i = 0; i < p.idx.length; i++) a.idx.push(base + p.idx[i]);
      a.n += n;
    }
  }
  geometries(THREE) {
    const out = [];
    for (const [material, a] of this.m) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(a.col, a.cs));
      g.setIndex(new THREE.BufferAttribute(a.n > 65535 ? Uint32Array.from(a.idx) : Uint16Array.from(a.idx), 1));
      g.computeBoundingSphere(); out.push({ material, geometry: g, tris: a.idx.length / 3 });
    }
    return out;
  }
}

export function createCity({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl = '', options = {} }) {
  const opt = { quality: 'medium', cityUrl: '/city/', budgetMs: 3, config: {}, exclusions: [], colliders: true, shadows: false, ...options };
  const group = new THREE.Group(); group.name = 'city'; scene.add(group);
  let gen = null, override = null, quality = CITY_CONFIG.quality[opt.quality] ? opt.quality : 'medium';
  let pool = null, glb = null, disposed = false, readyFlag = false, rescan = true, scanX = -1e9, scanZ = -1e9, firstFrames = 0, dirty = true, keys = [];
  const built = new Map(), nodes = new Map(), primCache = new Map(), protoCache = new Map(), buckets = new Map(), ownGeos = [], ownMats = [], triOfName = new Map();
  const tmp = { q: new THREE.Quaternion(), m: new THREE.Matrix4(), p: new THREE.Vector3(), s: new THREE.Vector3(), y: new THREE.Vector3(0, 1, 0), vp: new THREE.Matrix4(), fr: new THREE.Frustum(), dir: new THREE.Vector3() };
  const planes = new Float64Array(24), lastCam = { x: 1e9, y: 0, z: 0, dx: 0, dy: 0, dz: 1 };
  const counters = { built: 0, sorts: 0, procBuilt: 0, procDisposed: 0 };
  let tally = {}, sortMs = 0, sortMsMax = 0, procMs = 0, procMsMax = 0, boxGeo = null, plinthMat = null, fakeMat = null, queue = [];
  let triInfo = {};   // manifest triangle counts per asset name
  const baseBase = baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
  const cityBase = opt.cityUrl.endsWith('/') ? opt.cityUrl : opt.cityUrl + '/';
  const qDist = () => CITY_CONFIG.quality[quality].dist;
  const blocked = (x, z, m) => (gen ? gen.blocked(x, z, m) : false);
  const triOf = (n) => triOfName.get(n) || 300;

  function makeGen() {
    const q = CITY_CONFIG.quality[quality];
    const config = { ...opt.config, density: (opt.config.density ?? CITY_CONFIG.density) * q.density };
    return createCityGen({ map, config, override, extraCircles: opt.exclusions });
  }
  const genReady = (async () => {
    override = await optionalJson(baseBase + 'city.json');
    if (override && override.disabled) { console.info('city: disabled by city.json'); return; }
    gen = makeGen();
  })();

  async function init() {
    await genReady;
    if (!gen || disposed || !gen.hasCity()) { readyFlag = true; return; }
    const man = await fetch(cityBase + 'city.json').then((r) => { if (!r.ok) throw new Error(`city: ${cityBase}city.json HTTP ${r.status}`); return r.json(); });
    for (const e of man.assets) { triInfo[e.name] = e.tris; triOfName.set(e.name, e.tris); }
    for (const [k, a] of gen.assets.entries()) { // the generator's built-in body dimensions must match the kit
      const e = man.assets.find((x) => x.name === a.name);
      if (!e || !e.body) console.warn(`city: ${a.name} has no body data in city.json (run npm run city:lods)`);
      else if (['x0', 'x1', 'z0', 'z1'].some((c) => Math.abs(e.body[c] - a.body[c]) > 0.05)) console.warn(`city: body of ${a.name} differs from CITY_CONFIG.assets[${k}]`);
    }
    glb = await new GLTFLoader().loadAsync(cityBase + 'city.glb');
    if (disposed) return;
    for (const c of glb.scene.children) nodes.set(c.name, c);
    glb.scene.updateMatrixWorld(true);
    for (const n of kitPieceNames()) if (!nodes.has(n)) console.warn('city: kit piece missing from city.glb:', n);
    glb.scene.traverse((o) => { if (o.isMesh && !fakeMat && /FakeInterior/i.test(o.material.name)) fakeMat = o.material; });
    boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0); ownGeos.push(boxGeo);
    plinthMat = new THREE.MeshStandardMaterial({ color: 0x59564f, roughness: 1 }); ownMats.push(plinthMat);
    if (opt.colliders && RAPIER && physicsWorld) pool = createCityColliderPool({ RAPIER, world: physicsWorld, gen });
    keys = gen.chunkKeys(); readyFlag = true; firstFrames = 6;
  }
  const ready = init().catch((e) => { console.error('city: init failed', e); throw e; });

  // ---- kit primitives of a GLB node: [{ mat, pos, nor, uv, idx }] (node transforms baked; all FakeInterior_N share one material so a building needs fewer draw calls) ----
  function primsOf(name) {
    let p = primCache.get(name); if (p) return p;
    p = []; const node = nodes.get(name);
    if (node) node.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, n = pa.count, m = o.matrixWorld;
      const ca = g.attributes.color, cs = ca ? ca.itemSize : 3, col = new Float32Array(n * cs).fill(1), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), v = tmp.p;
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pa, i).applyMatrix4(m); pos[3 * i] = v.x; pos[3 * i + 1] = v.y; pos[3 * i + 2] = v.z;
        if (na) { v.fromBufferAttribute(na, i).transformDirection(m); nor[3 * i] = v.x; nor[3 * i + 1] = v.y; nor[3 * i + 2] = v.z; } else nor[3 * i + 1] = 1;
        if (ua) { uv[2 * i] = ua.getX(i); uv[2 * i + 1] = ua.getY(i); }
        if (ca) { col[cs * i] = ca.getX(i); col[cs * i + 1] = ca.getY(i); col[cs * i + 2] = ca.getZ(i); if (cs > 3) col[cs * i + 3] = ca.getW(i); }
      }
      const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
      p.push({ mat: /FakeInterior/i.test(o.material.name) && fakeMat ? fakeMat : o.material, pos, nor, uv, col, cs, idx });
    });
    primCache.set(name, p); return p;
  }
  // [{ geometry, material }] of a whole building node (primitives of one material merged; transforms baked)
  function protoOf(name) {
    let p = protoCache.get(name); if (p) return p;
    const acc = new PieceMerger(); acc.add(primsOf(name), 0, 0, 0, 0);
    p = acc.geometries(THREE).map(({ geometry, material }) => { ownGeos.push(geometry); return { geometry, material }; });
    protoCache.set(name, p); return p;
  }
  const protosFor = (key) => {
    if (key === K_PLINTH) return [{ geometry: boxGeo, material: plinthMat }];
    if (key === K_BOLLARD) return protoOf('Prop_Bollard');
    if (key === K_PLANTER) return protoOf('Prop_Planter_Single');
    return protoOf(gen.assets[key].name);
  };

  // ---------------------------------------------------------------- generated chunk -> instance matrices + proxy mesh (built once)
  const mat16 = (px, py, pz, yaw, sx, sy, sz) => { tmp.q.setFromAxisAngle(tmp.y, yaw); tmp.p.set(px, py, pz); tmp.s.set(sx, sy, sz); return tmp.m.compose(tmp.p, tmp.q, tmp.s).toArray(new Float32Array(16)); };
  function proxyBox(b) { // building-local proxy extent
    if (b.kind === 'proc') return { x0: -b.spec.W / 2, x1: b.spec.W / 2, zb: -b.spec.D, h: b.h };
    const A = gen.assets[b.asset].body; return { x0: A.x0 * b.sc, x1: A.x1 * b.sc, zb: A.z0 * b.sc, h: A.h * b.sc };
  }
  function buildRender(L) {
    const items = [], props = [], acc = new PieceMerger();
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const b of L.buildings) {
      const yb = Math.atan2(-b.uz, b.ux), c = b.col, r = Math.hypot(b.hu, b.hv, b.h / 2) + 1, cy = b.y + b.h / 2, cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      items.push({ b, proc: b.kind === 'proc', mat: b.kind === 'proc' ? null : mat16(b.x, b.y, b.z, b.yaw, b.sc, b.sc, b.sc),
        plinth: b.plinth ? mat16(c.cx, b.plinth.y0, c.cz, yb, 2 * b.plinth.hu, b.plinth.h, 2 * b.plinth.hv) : null, cx: b.cx, cy, cz: b.cz, r, rxz: Math.min(b.hu, b.hv), ai: b.asset, live: null });
      for (const p of planProxy(proxyBox(b))) acc.add(primsOf(p.n), b.x + p.x * cs + p.z * sn, b.y + p.y, b.z - p.x * sn + p.z * cs, b.yaw + p.r, p.sx, p.sy, p.sz);
      x0 = Math.min(x0, b.cx - r); x1 = Math.max(x1, b.cx + r); z0 = Math.min(z0, b.cz - r); z1 = Math.max(z1, b.cz + r); y0 = Math.min(y0, b.y); y1 = Math.max(y1, cy + r);
    }
    for (const [kind, key] of [['bollard', K_BOLLARD], ['planter', K_PLANTER]]) for (const p of L.props[kind]) {
      props.push({ key, mat: mat16(p.x, p.y, p.z, p.yaw, p.sc, p.sc, p.sc), x: p.x, y: p.y, z: p.z });
      x0 = Math.min(x0, p.x - 3); x1 = Math.max(x1, p.x + 3); z0 = Math.min(z0, p.z - 3); z1 = Math.max(z1, p.z + 3);
    }
    const proxy = new THREE.Group(); proxy.name = 'city_proxy'; let proxyTris = 0;
    for (const { material, geometry, tris } of acc.geometries(THREE)) { const m = new THREE.Mesh(geometry, material); m.matrixAutoUpdate = false; m.receiveShadow = true; proxy.add(m); proxyTris += tris; }
    proxy.visible = false; group.add(proxy);
    return { L, items, props, proxy, proxyTris, aabb: [x0, z0, x1, z1], sph: new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (Math.min(y0, 0) + y1) / 2, (z0 + z1) / 2), 0.5 * Math.hypot(x1 - x0, y1 - Math.min(y0, 0), z1 - z0) + 4) };
  }
  function disposeRender(R) {
    R.proxy.removeFromParent(); R.proxy.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const it of R.items) if (it.live) dropLive(it);
  }

  // ---------------------------------------------------------------- procedural building meshes (detailed, merged per material)
  function makeLive(it) {
    const t0 = performance.now(), b = it.b, plan = planBuilding(b.spec, triOf, gen.cfg.proc.maxTris), acc = new PieceMerger();
    for (const p of plan.pieces) acc.add(primsOf(p.n), p.x, p.y, p.z, p.r);
    const g = new THREE.Group(); g.name = 'city_building'; let tris = 0;
    for (const { material, geometry, tris: t } of acc.geometries(THREE)) { const m = new THREE.Mesh(geometry, material); m.castShadow = opt.shadows; m.receiveShadow = true; m.matrixAutoUpdate = false; g.add(m); tris += t; }
    g.position.set(b.x, b.y, b.z); g.rotation.y = b.yaw; g.updateMatrixWorld(true); g.children.forEach((m) => { m.matrixAutoUpdate = false; });
    group.add(g); it.live = { g, tris }; counters.procBuilt++;
    const dt = performance.now() - t0; procMs += (dt - procMs) * 0.2; if (dt > procMsMax) procMsMax = dt;
  }
  function dropLive(it) { it.live.g.removeFromParent(); it.live.g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); it.live = null; counters.procDisposed++; }

  // ---------------------------------------------------------------- draw buckets (key = asset, or K_*) -> shared instance buffer + one InstancedMesh per material
  function makeBucket(key, need) {
    const cap = Math.ceil(need * 1.25) + 8, attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16); attr.setUsage(THREE.DynamicDrawUsage);
    const meshes = protosFor(key).map(({ geometry, material }) => {
      const m = new THREE.InstancedMesh(geometry, material, cap);
      m.instanceMatrix = attr; m.count = 0; m.visible = false; m.matrixAutoUpdate = false; m.frustumCulled = false;
      m.castShadow = opt.shadows && key < 20; m.receiveShadow = key < 20; m.name = 'city_' + key; group.add(m); return m;
    });
    const b = { attr, cap, count: 0, meshes, key }; buckets.set(key, b); return b;
  }
  function growBucket(b, need) {
    const cap = Math.ceil(need * 1.25) + 8, attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16); attr.setUsage(THREE.DynamicDrawUsage);
    for (const m of b.meshes) { m.dispose(); m.instanceMatrix = attr; }
    b.attr = attr; b.cap = cap;
  }
  const push = (key, m16, need) => {
    let b = buckets.get(key); if (!b) b = makeBucket(key, need);
    if (b.count >= b.cap) growBucket(b, b.count + 16);
    b.attr.array.set(m16, b.count * 16); b.count++;
  };

  function sortInstances() {
    const t0 = performance.now(); counters.sorts++;
    camera.updateMatrixWorld();
    tmp.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); tmp.fr.setFromProjectionMatrix(tmp.vp);
    tmp.fr.planes.forEach((p, k) => { planes[k * 4] = p.normal.x; planes[k * 4 + 1] = p.normal.y; planes[k * 4 + 2] = p.normal.z; planes[k * 4 + 3] = p.constant; });
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, qd = qDist(), cl = gen.cfg.lod;
    camera.getWorldDirection(tmp.dir); lastCam.x = cx; lastCam.y = cy; lastCam.z = cz; lastCam.dx = tmp.dir.x; lastCam.dy = tmp.dir.y; lastCam.dz = tmp.dir.z;
    const outside = (x, y, z, r) => { for (let k = 0; k < 24; k += 4) if (planes[k] * x + planes[k + 1] * y + planes[k + 2] * z + planes[k + 3] < -r) return true; return false; };
    const need = new Map(); let nProps = 0, nPl = 0;
    for (const R of built.values()) { for (const it of R.items) { if (!it.proc) need.set(it.ai, (need.get(it.ai) || 0) + 1); if (it.plinth) nPl++; } nProps += R.props.length; }
    for (const b of buckets.values()) { b.count = 0; const n = b.key === K_PLINTH ? nPl : b.key >= K_BOLLARD ? nProps : (need.get(b.key) || 0); if (n > b.cap) growBucket(b, n); }
    const cull = cl.cull * qd, cull2 = cull * cull, d0 = cl.d[0] * qd, pr = cl.props * qd;
    tally = { whole: 0, proc: 0, procLive: 0, proxyChunks: 0, total: 0, props: 0, tris: 0 };
    const want = [];
    for (const R of built.values()) {
      const a = R.aabb, ddx = cx < a[0] ? a[0] - cx : cx > a[2] ? cx - a[2] : 0, ddz = cz < a[1] ? a[1] - cz : cz > a[3] ? cz - a[3] : 0;
      tally.total += R.items.length;
      const inRange = ddx * ddx + ddz * ddz < cull2;
      R.proxy.visible = inRange && !outside(R.sph.center.x, R.sph.center.y, R.sph.center.z, R.sph.radius);   // (children are frustum culled again by three)
      if (R.proxy.visible) { tally.proxyChunks++; tally.tris += R.proxyTris; }
      if (!inRange) { for (const it of R.items) if (it.live) it.live.g.visible = false; continue; }
      for (const it of R.items) {
        const dx = it.cx - cx, dz = it.cz - cz, dist = Math.max(0, Math.sqrt(dx * dx + dz * dz) - it.rxz), out = outside(it.cx, it.cy, it.cz, it.r);
        if (dist < d0 + 30 && it.proc) want.push({ it, dist, out });
        else if (it.live) it.live.g.visible = false;
        if (out || dist >= cull) continue;
        if (it.plinth) push(K_PLINTH, it.plinth, nPl);
        if (!it.proc && dist < d0) { push(it.ai, it.mat, need.get(it.ai)); tally.whole++; tally.tris += triInfo[gen.assets[it.ai].name] || 0; }
      }
      for (const p of R.props) { const dx = p.x - cx, dz = p.z - cz; if (dx * dx + dz * dz >= pr * pr || outside(p.x, p.y + 0.4, p.z, 2)) continue; push(p.key, p.mat, nProps); tally.props++; }
    }
    // procedural buildings: the nearest cl.maxLive within d0 get their detailed mesh (built lazily through the queue), the rest are hidden / dropped
    want.sort((a, b) => a.dist - b.dist); queue = []; const wantSet = new Set(want.slice(0, cl.maxLive).map((w) => w.it));
    want.forEach((w, i) => {
      const it = w.it, live = i < cl.maxLive && w.dist < d0 + 30;
      if (live && w.dist < d0 + 30) {
        if (it.live) { it.live.g.visible = !w.out && w.dist < d0 + 10; if (it.live.g.visible) { tally.procLive++; tally.tris += it.live.tris; } } else if (w.dist < d0 && (!w.out || w.dist < 40)) queue.push(it);
      } else if (it.live) dropLive(it);
    });
    for (const R of built.values()) for (const it of R.items) if (it.live && !wantSet.has(it)) dropLive(it);
    for (const b of buckets.values()) {
      for (const m of b.meshes) { m.count = b.count; m.visible = b.count > 0; }
      if (b.count) { b.attr.clearUpdateRanges(); b.attr.addUpdateRange(0, b.count * 16); b.attr.needsUpdate = true; }
    }
    dirty = false; const dt = performance.now() - t0; sortMs += (dt - sortMs) * 0.1; if (dt > sortMsMax) sortMsMax = dt;
  }

  // ---------------------------------------------------------------- chunk streaming
  let pending = [];
  function scan(cam) {
    const S = gen.chunkSize, R = gen.cfg.lod.cull * qDist() + S * 0.75, need = new Set(), out = [];
    for (const [cx, cz] of keys) {
      const d = Math.hypot((cx + 0.5) * S - cam.x, (cz + 0.5) * S - cam.z); if (d > R + S * 0.4 + 40) continue;
      const key = cx + ':' + cz; need.add(key);
      if (!built.has(key) && d <= R + S * 0.4) out.push({ key, cx, cz, d });
    }
    for (const key of [...built.keys()]) if (!need.has(key)) { disposeRender(built.get(key)); built.delete(key); dirty = true; }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
  function update(dt, focus) {
    if (!readyFlag || disposed || !gen || !glb) return;
    const cp = camera.position, cam = { x: cp.x, z: cp.z };
    if (rescan || pending.length || Math.hypot(cam.x - scanX, cam.z - scanZ) > RESCAN_DIST) { pending = scan(cam); scanX = cam.x; scanZ = cam.z; rescan = false; }
    const budget = firstFrames > 0 ? opt.budgetMs * 8 : opt.budgetMs; if (firstFrames > 0) firstFrames--;
    const t0 = performance.now();
    while (pending.length && performance.now() - t0 < budget) {
      const t = pending.shift(); if (built.has(t.key)) continue;
      built.set(t.key, buildRender(gen.chunk(t.cx, t.cz))); counters.built++; dirty = true;
    }
    // detailed procedural buildings: at least one per frame while any is missing (nearest first), more while the budget lasts
    let did = 0;
    while (queue.length && (did === 0 || performance.now() - t0 < budget)) { const it = queue.shift(); if (!it.live && built.size) { makeLive(it); did++; dirty = true; } }
    camera.getWorldDirection(tmp.dir);
    if (dirty || Math.hypot(cp.x - lastCam.x, cp.y - lastCam.y, cp.z - lastCam.z) > SORT_DIST || tmp.dir.x * lastCam.dx + tmp.dir.y * lastCam.dy + tmp.dir.z * lastCam.dz < SORT_COS) sortInstances();
    if (pool) { const f = focus || cam; pool.update(f.x, f.z); }
  }

  function clearBuilt() { for (const R of built.values()) disposeRender(R); built.clear(); pending = []; queue = []; rescan = true; dirty = true; }
  function clearBuckets() { for (const b of buckets.values()) for (const m of b.meshes) { group.remove(m); m.dispose(); } buckets.clear(); }
  function setQuality(q) {
    if (!CITY_CONFIG.quality[q]) throw new Error('city: quality must be low | medium | high');
    quality = q; if (!gen) return;
    clearBuilt(); clearBuckets(); gen = makeGen(); keys = gen.chunkKeys(); if (pool) pool.setGen(gen);
  }
  function stats() {
    let meshes = 0, visible = 0, instances = 0, live = 0;
    for (const b of buckets.values()) for (const m of b.meshes) { meshes++; if (m.visible && m.count) { visible++; instances += m.count; } }
    for (const R of built.values()) for (const it of R.items) if (it.live) live++;
    return { ready: readyFlag, quality, chunks: built.size, buildings: { ...tally }, live, draws: { instancedMeshes: meshes, visibleInstanced: visible, instances }, sortMs: +sortMs.toFixed(3), sortMsMax: +sortMsMax.toFixed(2), procMs: +procMs.toFixed(2), procMsMax: +procMsMax.toFixed(2), gen: gen ? gen.stats : null, colliders: pool ? pool.stats() : null, ...counters };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    clearBuilt(); clearBuckets(); if (pool) pool.dispose();
    for (const p of protoCache.values()) for (const { geometry } of p) geometry.dispose();
    ownGeos.forEach((g) => g.dispose()); ownMats.forEach((m) => m.dispose());
    if (glb) glb.scene.traverse((o) => { if (o.isMesh) { const m = o.material; for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); o.geometry.dispose(); } });
    group.removeFromParent();
  }
  return { update, dispose, setQuality, stats, ready, genReady, group, blocked, get gen() { return gen; }, get pool() { return pool; }, get quality() { return quality; } };
}
