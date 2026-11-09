// Nature scatter renderer: trees, bushes, rocks, grass, flowers, pebbles instanced from public/nature/nature.glb, placed by scatterGen.js (see its header for the
// placement rules, density curves and scatter.json), with near-player physics colliders (scatterColliders.js).
//
//   const scatter = createScatter({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl: '/maps/sample/', options });
//   scatter.update(dt, focus?)    every frame (after the camera moved); focus = {x,z} (vehicle) for the colliders, default camera position. No-op until scatter.ready resolved.
//   scatter.setQuality('low'|'medium'|'high')   rebuilds with other density / distance scales      scatter.stats()   counts, draw meshes, drawn tris, gen ms, colliders
//   scatter.dispose()    scatter.ready (Promise), scatter.gen (generator), scatter.pool (collider pool or null), scatter.group (THREE.Group)
//   options: { quality = 'medium', natureUrl = '/nature/', shadows = false, budgetMs = 3, config = {} (overrides SCATTER_CONFIG), exclusions = [{x,z,r}], colliders = true,
//             extraBlocked = (x, z, margin) => boolean (e.g. city.blocked: keeps trees / rocks off the city buildings) }
//
// RENDERING. Instances live in generated CHUNKS (128 m for trees / dead trees / bushes / rocks, 48 m for grass / flowers / pebbles; generated lazily nearest-first under a
// per-frame time budget, dropped when the camera leaves their range; their instance matrices are built once). Drawing is a CPU "cull + LOD sort" over the loaded chunks:
// every instance is tested against its category's draw distance and the camera frustum (a bounding sphere from the manifest), gets its LOD from the distance, and its matrix is
// copied into the instance buffer of its (species, LOD). That gives ONE InstancedMesh per (species, LOD, material primitive) for the whole scene, so the draw calls are
// bounded by the species list (not by the number of chunks), and nothing outside the view or beyond the distance is drawn. The sort re-runs when the camera moved > 2.5 m or
// turned > 3 degrees (or a chunk appeared / vanished); chunk-level sphere / distance tests skip most chunks before any instance is touched. The bark + leaf meshes of a species
// share one instance buffer. LOD meshes (<name>_LOD1 ~25 % tris, _LOD2 ~6 %) come from scripts/nature/build.mjs; species without them use the base mesh.
// SHADOWS: scatter does not cast or receive shadows by default (the sun's shadow rig is a small box round the car); options.shadows = true makes LOD0 trees / dead trees cast.
// WIND: leaf / grass / flower materials get a small vertex sway (onBeforeCompile, one shared time uniform, amplitude grows with height; no extra draw calls).
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createScatterGen, SCATTER_CONFIG, LAYERS } from './scatterGen.js';
import { createColliderPool } from './scatterColliders.js';

const LAYER_CATS = { tree: ['tree'], deadtree: ['deadtree'], bush: ['bush'], rock: ['rock', 'rockpebble'], grass: ['groundcover'], forestfloor: ['groundcover'], flower: ['flower'], pebble: ['pebble'] };
const RESCAN_DIST = 10, SORT_DIST = 2.5, SORT_COS = Math.cos(3 * Math.PI / 180);

async function optionalJson(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const t = await r.text(); if (t.trimStart().startsWith('<')) return null;   // dev servers answer a missing file with index.html
    return JSON.parse(t);
  } catch (e) { console.warn('scatter: could not read', url, e.message || e); return null; }
}

export function createScatter({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl = '', options = {} }) {
  const opt = { quality: 'medium', natureUrl: '/nature/', shadows: false, budgetMs: 3, config: {}, exclusions: [], colliders: true, extraBlocked: null, ...options };
  const group = new THREE.Group(); group.name = 'scatter'; scene.add(group);
  const windU = { value: 0 };
  let gen = null, manifest = null, override = null, quality = SCATTER_CONFIG.quality[opt.quality] ? opt.quality : 'medium';
  let pool = null, glb = null, disposed = false, readyFlag = false, rescan = true, scanX = -1e9, scanZ = -1e9, firstFrames = 0, dirty = true;
  const built = new Map();            // 'layer:cx:cz' -> render { L, parts[] }
  const nodes = new Map(), protoCache = new Map();
  const buckets = new Map();          // sp * 4 + lod -> { attr, cap, count, meshes[], sp, lod }
  const tmp = { q: new THREE.Quaternion(), q2: new THREE.Quaternion(), m: new THREE.Matrix4(), p: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(), y: new THREE.Vector3(0, 1, 0), vp: new THREE.Matrix4(), fr: new THREE.Frustum(), dir: new THREE.Vector3() };
  const planes = new Float64Array(24), lastCam = { x: 1e9, y: 0, z: 0, dx: 0, dy: 0, dz: 1 };
  const counters = { built: 0, disposed: 0, sorts: 0 };
  let tally = {}, sortMs = 0, sortMsMax = 0, spInfo = [];

  const baseBase = baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
  const natBase = opt.natureUrl.endsWith('/') ? opt.natureUrl : opt.natureUrl + '/';
  const qDist = () => SCATTER_CONFIG.quality[quality].dist;

  // ---------------------------------------------------------------- loading
  function patchWind(mat) {
    mat.customProgramCacheKey = () => 'scatter-wind-v1';
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWindT = windU;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWindT;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
{ float ph = uWindT * 1.7 + instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.27;
  float k = 0.012 * transformed.y + 0.0025 * transformed.y * transformed.y;
  transformed.x += sin(ph) * k; transformed.z += cos(ph * 0.83) * 0.7 * k; }
#endif`);
    };
  }
  function makeGen() {
    const q = SCATTER_CONFIG.quality[quality];
    const config = { ...opt.config, density: { ...(opt.config.density || {}) } };
    for (const c of Object.keys(q.density)) config.density[c] = (config.density[c] ?? SCATTER_CONFIG.density[c] ?? 1) * q.density[c];
    const g = createScatterGen({ map, manifest, config, override, extraExclusions: opt.exclusions, extraBlocked: opt.extraBlocked });
    spInfo = g.species.map((s) => ({ r: Math.max(s.radius, s.height * 0.55), h: s.height, nL: s.lods.length, tris: [s.tris, ...s.lodTris] }));   // culling sphere: centre at half height, radius per unit scale
    return g;
  }

  async function init() {
    const [ov, man] = await Promise.all([optionalJson(baseBase + 'scatter.json'), fetch(natBase + 'nature.json').then((r) => { if (!r.ok) throw new Error(`scatter: ${natBase}nature.json HTTP ${r.status}`); return r.json(); })]);
    override = ov; manifest = man;
    if (ov && ov.disabled) { console.info('scatter: disabled by scatter.json'); readyFlag = true; return; }
    glb = await new GLTFLoader().loadAsync(natBase + 'nature.glb');
    if (disposed) return;
    for (const c of glb.scene.children) nodes.set(c.name, c);
    glb.scene.updateMatrixWorld(true);
    const seen = new Set();
    glb.scene.traverse((o) => { if (o.isMesh && o.material && !seen.has(o.material)) { seen.add(o.material); if (/leaves|grass|flowers/i.test(o.material.name)) patchWind(o.material); } });
    gen = makeGen();
    if (opt.colliders && RAPIER && physicsWorld) pool = createColliderPool({ RAPIER, world: physicsWorld, gen });
    readyFlag = true; firstFrames = 6;
  }
  const ready = init().catch((e) => { console.error('scatter: init failed', e); throw e; });

  // [{ geometry, material }] of GLB node `name` (mesh transforms, e.g. the base lift, baked into a geometry copy)
  function protoOf(name) {
    let p = protoCache.get(name); if (p) return p;
    p = []; const node = nodes.get(name);
    if (node) node.traverse((o) => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); p.push({ geometry: g, material: o.material }); } });
    protoCache.set(name, p); return p;
  }

  // ---------------------------------------------------------------- generated layer chunk -> instance matrices (built once)
  function buildRender(L) {
    const parts = [];
    for (const cat of Object.keys(L.parts)) {
      const part = L.parts[cat]; if (!part.n) continue;
      const mats = new Float32Array(part.n * 16), d = part.data;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9; const spCnt = new Map();
      for (let i = 0; i < part.n; i++) {
        const o = i * 7;
        tmp.up.set(d[o + 5], 1, d[o + 6]).normalize();
        tmp.q.setFromUnitVectors(tmp.y, tmp.up); tmp.q2.setFromAxisAngle(tmp.y, d[o + 3]); tmp.q.multiply(tmp.q2);
        tmp.p.set(d[o], d[o + 1], d[o + 2]); tmp.s.setScalar(d[o + 4]);
        tmp.m.compose(tmp.p, tmp.q, tmp.s).toArray(mats, i * 16);
        if (d[o] < x0) x0 = d[o]; if (d[o] > x1) x1 = d[o]; if (d[o + 2] < z0) z0 = d[o + 2]; if (d[o + 2] > z1) z1 = d[o + 2]; if (d[o + 1] < y0) y0 = d[o + 1]; if (d[o + 1] > y1) y1 = d[o + 1];
        spCnt.set(part.species[i], (spCnt.get(part.species[i]) || 0) + 1);
      }
      const PADXZ = 16, PADY = 26;   // widest / tallest tree (twisted, scaled)
      const sph = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1 + PADY) / 2, (z0 + z1) / 2), 0.5 * Math.hypot(x1 - x0 + 2 * PADXZ, y1 - y0 + PADY, z1 - z0 + 2 * PADXZ));
      parts.push({ cat, part, mats, spCnt, sph, aabb: [x0, z0, x1, z1] });
    }
    return { L, parts };
  }

  // ---------------------------------------------------------------- draw buckets: (species, lod) -> shared instance buffer + one InstancedMesh per material primitive
  function makeBucket(sp, lod, need) {
    const cap = Math.ceil(need * 1.25) + 16, S = gen.species[sp], name = lod === 0 ? S.name : S.lods[lod - 1], protos = protoOf(name);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16); attr.setUsage(THREE.DynamicDrawUsage);
    const meshes = protos.map(({ geometry, material }) => {
      const m = new THREE.InstancedMesh(geometry, material, cap);
      m.instanceMatrix = attr; m.count = 0; m.visible = false; m.matrixAutoUpdate = false; m.frustumCulled = false;   // culled per instance by sortInstances()
      m.castShadow = opt.shadows && lod === 0 && (S.cat === 'tree' || S.cat === 'deadtree'); m.receiveShadow = false; m.name = name; group.add(m); return m;
    });
    const b = { attr, cap, count: 0, meshes, sp, lod }; buckets.set(sp * 4 + lod, b); return b;
  }
  function growBucket(b, need) {
    const cap = Math.ceil(need * 1.25) + 16, attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16); attr.setUsage(THREE.DynamicDrawUsage);
    for (const m of b.meshes) { m.dispose(); m.instanceMatrix = attr; }   // dispose() frees the old GPU buffer
    b.attr = attr; b.cap = cap;
  }

  // frustum + distance cull + LOD sort of every loaded instance into the buckets
  function sortInstances() {
    const t0 = performance.now(); counters.sorts++;
    camera.updateMatrixWorld();
    tmp.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); tmp.fr.setFromProjectionMatrix(tmp.vp);
    tmp.fr.planes.forEach((p, k) => { planes[k * 4] = p.normal.x; planes[k * 4 + 1] = p.normal.y; planes[k * 4 + 2] = p.normal.z; planes[k * 4 + 3] = p.constant; });
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, qd = qDist(), cfgLod = gen.cfg.lod;
    camera.getWorldDirection(tmp.dir); lastCam.x = cx; lastCam.y = cy; lastCam.z = cz; lastCam.dx = tmp.dir.x; lastCam.dy = tmp.dir.y; lastCam.dz = tmp.dir.z;
    const outside = (x, y, z, r) => {
      if (planes[0] * x + planes[1] * y + planes[2] * z + planes[3] < -r || planes[4] * x + planes[5] * y + planes[6] * z + planes[7] < -r) return true;
      if (planes[8] * x + planes[9] * y + planes[10] * z + planes[11] < -r || planes[12] * x + planes[13] * y + planes[14] * z + planes[15] < -r) return true;
      return planes[16] * x + planes[17] * y + planes[18] * z + planes[19] < -r || planes[20] * x + planes[21] * y + planes[22] * z + planes[23] < -r;
    };
    // capacity bookkeeping: a species can have at most (its loaded instances) in any one LOD
    const need = new Map();
    for (const R of built.values()) for (const P of R.parts) for (const [sp, n] of P.spCnt) need.set(sp, (need.get(sp) || 0) + n);
    for (const b of buckets.values()) { b.count = 0; const n = need.get(b.sp) || 0; if (n > b.cap) growBucket(b, n); }
    tally = {};
    for (const R of built.values()) for (const P of R.parts) {
      const cat = P.cat, L = cfgLod[cat], cull = L.cull * qd, a = P.aabb;
      const ddx = cx < a[0] ? a[0] - cx : cx > a[2] ? cx - a[2] : 0, ddz = cz < a[1] ? a[1] - cz : cz > a[3] ? cz - a[3] : 0;
      if (ddx * ddx + ddz * ddz >= cull * cull || outside(P.sph.center.x, P.sph.center.y, P.sph.center.z, P.sph.radius + 4)) continue;
      const cull2 = cull * cull, d1 = L.d[0] !== undefined ? L.d[0] * qd : 1e9, d2 = L.d[1] !== undefined ? L.d[1] * qd : 1e9, dat = P.part.data, spv = P.part.species, mats = P.mats, n = P.part.n;
      const tl = tally[cat] || (tally[cat] = { lod0: 0, lod1: 0, lod2: 0, tris: 0, total: 0 }); tl.total += n;
      for (let i = 0; i < n; i++) {
        const o = i * 7, x = dat[o], z = dat[o + 2], dx = x - cx, dz = z - cz, dd = dx * dx + dz * dz;
        if (dd >= cull2) continue;
        const dist = Math.sqrt(dd);
        const sp = spv[i], si = spInfo[sp], sc = dat[o + 4];
        if (outside(x, dat[o + 1] + si.h * sc * 0.5, z, si.r * sc + 2 + dist * 0.01)) continue;
        let l = dist < d1 ? 0 : dist < d2 ? 1 : 2; if (l > si.nL) l = si.nL;
        let b = buckets.get(sp * 4 + l); if (!b) b = makeBucket(sp, l, need.get(sp));
        const arr = b.attr.array, ob = b.count * 16, s = i * 16;
        for (let k = 0; k < 16; k++) arr[ob + k] = mats[s + k];
        b.count++;
        tl['lod' + l]++; tl.tris += si.tris[l];
      }
    }
    for (const b of buckets.values()) {
      for (const m of b.meshes) { m.count = b.count; m.visible = b.count > 0; }
      if (b.count) { b.attr.clearUpdateRanges(); b.attr.addUpdateRange(0, b.count * 16); b.attr.needsUpdate = true; }
    }
    dirty = false; const dt = performance.now() - t0; sortMs += (dt - sortMs) * 0.1; if (dt > sortMsMax) sortMsMax = dt;
  }

  function disposeRender() { counters.disposed++; }

  // ---------------------------------------------------------------- chunk streaming
  function layerRange(name) { let r = 0; for (const c of LAYER_CATS[name]) r = Math.max(r, gen.cfg.lod[c].cull); return r * qDist(); }
  function scan(cam) {
    const need = new Set(), W = gen.worldSize, pending = [];
    for (const name of Object.keys(LAYERS)) {
      const S = gen.chunkSize[LAYERS[name]], R = layerRange(name) + S * 0.75, n = Math.ceil(W / S);
      const x0 = Math.max(0, Math.floor((cam.x - R - 40) / S)), x1 = Math.min(n - 1, Math.floor((cam.x + R + 40) / S)), z0 = Math.max(0, Math.floor((cam.z - R - 40) / S)), z1 = Math.min(n - 1, Math.floor((cam.z + R + 40) / S));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const d = Math.hypot((cx + 0.5) * S - cam.x, (cz + 0.5) * S - cam.z); if (d > R + S * 0.4 + 40) continue;   // +40 m hysteresis before a built chunk is dropped
        const key = name + ':' + cx + ':' + cz; need.add(key);
        if (!built.has(key) && d <= R + S * 0.4) pending.push({ key, name, cx, cz, d });
      }
    }
    for (const key of [...built.keys()]) if (!need.has(key)) { disposeRender(); built.delete(key); dirty = true; }
    pending.sort((a, b) => a.d - b.d);
    return pending;
  }
  let pending = [];
  function update(dt, focus) {
    if (!readyFlag || disposed || !gen) return;
    windU.value += dt;
    const cp = camera.position, cam = { x: cp.x, z: cp.z };
    if (rescan || pending.length || Math.hypot(cam.x - scanX, cam.z - scanZ) > RESCAN_DIST) { pending = scan(cam); scanX = cam.x; scanZ = cam.z; rescan = false; }
    const budget = firstFrames > 0 ? opt.budgetMs * 8 : opt.budgetMs; if (firstFrames > 0) firstFrames--;
    const t0 = performance.now();
    while (pending.length && performance.now() - t0 < budget) {
      const t = pending.shift(); if (built.has(t.key)) continue;
      built.set(t.key, buildRender(gen.layer(t.name, t.cx, t.cz))); counters.built++; dirty = true;
    }
    camera.getWorldDirection(tmp.dir);
    if (dirty || Math.hypot(cp.x - lastCam.x, cp.y - lastCam.y, cp.z - lastCam.z) > SORT_DIST || tmp.dir.x * lastCam.dx + tmp.dir.y * lastCam.dy + tmp.dir.z * lastCam.dz < SORT_COS) sortInstances();
    if (pool) { const f = focus || cam; pool.update(f.x, f.z); }
  }

  function clearBuilt() { built.clear(); pending = []; rescan = true; dirty = true; }
  function clearBuckets() { for (const b of buckets.values()) for (const m of b.meshes) { group.remove(m); m.dispose(); } buckets.clear(); }
  function setQuality(q) {
    if (!SCATTER_CONFIG.quality[q]) throw new Error('scatter: quality must be low | medium | high');
    quality = q; if (!gen) return;
    clearBuilt(); clearBuckets(); gen = makeGen(); if (pool) pool.setGen(gen);
  }

  function stats() {
    let meshes = 0, visible = 0, instances = 0;
    for (const b of buckets.values()) for (const m of b.meshes) { meshes++; if (m.visible && m.count) { visible++; instances += m.count; } }
    let tris = 0; for (const t of Object.values(tally)) tris += t.tris;
    return { ready: readyFlag, quality, layers: built.size, cats: tally, draws: { meshes, visible, instances, tris }, sortMs: +sortMs.toFixed(3), sortMsMax: +sortMsMax.toFixed(2), gen: gen ? gen.stats : null, colliders: pool ? pool.stats() : null, ...counters };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    clearBuilt(); clearBuckets(); if (pool) pool.dispose();
    for (const p of protoCache.values()) for (const { geometry } of p) geometry.dispose();
    if (glb) glb.scene.traverse((o) => { if (o.isMesh) { const m = o.material; for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); o.geometry.dispose(); } });
    group.removeFromParent();
  }
  return { update, dispose, setQuality, stats, ready, group, get gen() { return gen; }, get pool() { return pool; }, get quality() { return quality; } };
}
