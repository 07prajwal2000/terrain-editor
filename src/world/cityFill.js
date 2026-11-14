// City renderer: procedural buildings on the lots of cityBlocks.js (houses / rowhouses / towers, planned per 128 m chunk by cityChunk.js), plaza props, near-player colliders.
//
//   const city = createCity({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl: '/maps/citytest/', options });
//   city.update(dt, focus?)   every frame after the camera moved (focus = {x,z} = vehicle, for the colliders; default camera). No-op until city.ready resolved.
//   city.genReady             Promise: the blocks exist (city.gen = cityBlocks + hasCity(), city.blocked) after the optional <map>/city.json override ({ seed, disabled, exclusions }) was
//                             read. Await it BEFORE creating the nature scatter and pass `extraBlocked: city.blocked` so trees keep off lots / plazas.
//   city.ready                Promise: renderer ready. Textures: <cityUrl>tex/*.webp (~0.45 MB, scripts/extract-city-textures.mjs) + window textures from windowWorker.js; a chunk is
//                             shown only once its materials have their textures and are compiled (renderer.compileAsync, renderer grabbed via scene.onBeforeRender).
//   city.setQuality('low'|'medium'|'high')   city.stats()   city.dispose()   city.gen   city.pool   city.group   city.blocked(x, z, margin)
//   options: { quality = 'medium', cityUrl = '/city/', budgetMs = 3, exclusions = [{x,z,r}], colliders = true, shadows = false (near buildings cast), textures = true }
//
// LOD. Per chunk two merged meshes sets (one geometry per material key): NEAR = full kit buildings (+ plinths) within QUALITY.near, FAR = impostor boxes (<= 30 tris / building)
// out to QUALITY.far (towers stay on the skyline; small chunks are just as cheap). Chunks are built lazily, nearest first, under budgetMs per frame (
// one chunk in flight, planned lot by lot via planner.planIter -> materials -> meshes -> compileAsync, one stage slice per frame), and disposed beyond the range + hysteresis. Three.js frustum-culls each mesh. Draw calls ~ (near chunks x ~15 mats) + (far chunks x ~5 mats) + 3 prop meshes.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCityBlocks } from './cityBlocks.js';
import { createChunkPlanner, splitKey } from './cityChunk.js';
import { createCityColliderPool } from './cityColliders.js';
import { STYLE_BY_MAT, patchTintMask } from './windowAtlas.js';

export const QUALITY = { low: { near: 220, far: 1200, props: 120 }, medium: { near: 320, far: 1700, props: 170 }, high: { near: 420, far: 2300, props: 230 } };
const HYST = 40, RESCAN_DIST = 10, CHUNK = 128;
const COLLIDERS = { radius: 120, max: 160, maxBollards: 0, bollardRadius: 0.16, bollardHeight: 0.89, bollardRange: 0 };
// material key -> city.glb texture (extracted to <cityUrl>tex/ by scripts/extract-city-textures.mjs). MI_Trim is a trim sheet (dark wood bands), so trim / stone use concrete.
// TEX_M = metres per texture tile, from the content: brick ~24 courses of 75 mm per tile, slate 6 courses of ~0.25 m; the rest are plain noise (2.5 m).
const GLB_TEX = { brick: 'MI_RedBrick', brownstone: 'MI_RedBrick', trim: 'MI_Concrete', stone: 'MI_Concrete', concrete: 'MI_Concrete', roofFlat: 'MI_Concrete', roof: 'MI_Roof_Slate',
  metal: 'MI_Trim_MetalConcrete' };
// NEUTRAL: glb textures turned to grey luminance at load (mortar lines stay) so the kit's vertex tint alone sets the hue (red / stock yellow / painted ... brick); plaster = procedural stucco noise (stuccoTex).
// 'wood' (water tank) and 'foliage' (plant boxes) have no texture: flat vertex colour.
const NEUTRAL = new Set(['MI_RedBrick']);
const TEX_M = { brick: 1.8, brownstone: 1.8, roof: 1.5, plaster: 1.5 }, TEX_M_DEF = 2.5;
const isGlass = (k) => /glass|curtain/i.test(k);   // window-texture keys: glass keys fully tinted, others (masonry bands) tintMask so glass keeps its baked colour

async function optionalJson(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const t = await r.text(); if (t.trimStart().startsWith('<')) return null;   // dev servers answer a missing file with index.html
    return JSON.parse(t);
  } catch (e) { console.warn('city: could not read', url, e.message || e); return null; }
}

export function createCity({ THREE, map, scene, camera, RAPIER, physicsWorld, baseUrl = '', options = {} }) {
  const opt = { quality: 'medium', cityUrl: '/city/', budgetMs: 3, exclusions: [], colliders: true, shadows: false, textures: true, ...options };
  const group = new THREE.Group(); group.name = 'city'; scene.add(group);
  let gen = null, planner = null, pool = null, quality = QUALITY[opt.quality] ? opt.quality : 'medium', disposed = false, readyFlag = false;
  let keys = [], pending = [], scanX = -1e9, scanZ = -1e9, rescan = true, propsDirty = true, job = null, renderer = null;
  const chunks = new Map(), mats = new Map(), ownTex = [], counters = { nearBuilt: 0, farBuilt: 0, disposed: 0 };
  let buildMs = 0, buildMsMax = 0, frameMsMax = 0;
  const baseBase = baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
  const cityBase = opt.cityUrl.endsWith('/') ? opt.cityUrl : opt.cityUrl + '/';
  const blocked = (x, z, m, cat) => (gen ? gen.blockedFor(x, z, m, cat) : false);

  const genReady = (async () => {
    const override = await optionalJson(baseBase + 'city.json');
    if (override && override.disabled) { console.info('city: disabled by city.json'); return; }
    gen = createCityBlocks({ map, override, extraCircles: opt.exclusions });
    gen.hasCity = () => gen.blocks.some((b) => b.lots.length);
    planner = createChunkPlanner({ cb: gen, heightAt: map.heightAt });
  })();
  const ready = (async () => {
    await genReady;
    if (!gen || disposed || !gen.hasCity()) { readyFlag = true; return; }
    keys = gen.chunkKeys();
    if (opt.colliders && RAPIER && physicsWorld) { // cityColliders.js expects a generator: chunk(cx, cz).buildings[i].col (+ axis) -> one entry per collider box
      const adapter = { cfg: { colliders: COLLIDERS }, chunkSize: CHUNK,
        chunk: (cx, cz) => ({ buildings: planner.colliders(cx, cz).map((b, i) => ({ id: i, ux: Math.cos(b.yaw), uz: -Math.sin(b.yaw), col: { cx: b.x, cz: b.z, hu: b.hx, hv: b.hz, y0: b.y - b.hy, y1: b.y + b.hy } })), props: { bollard: [] } }) };
      pool = createCityColliderPool({ RAPIER, world: physicsWorld, gen: adapter });
    }
    readyFlag = true;
  })().catch((e) => { console.error('city: init failed', e); throw e; });

  const stageMax = { planStep: 0, material: 0, mesh: 0, compileCall: 0 };
  let matMs = 0; const prof = []; if (typeof window !== 'undefined') window.__cityProf = prof;   // per chunk build: { near, plan, mesh, mat } ms
  // ---------------------------------------------------------------- materials (one per merge key 'mat' | 'mat|style:variant', shared by every chunk)
  // A material is only handed out once its textures exist (window textures come from a Web Worker, glb textures are small webp files), so a map never
  // appears later and forces a shader recompile; chunks wait for their materials (and for renderer.compileAsync) before they are shown.
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = function (r, ...a) { renderer = r; return prevBefore.call(this, r, ...a); };   // grab the renderer for compileAsync (no API change)
  let stucco = null;
  const texs = new Map();   // cache key -> { tex, emissive } | { tex, mul } | null (pending) | false (unavailable)
  let worker = null, wid = 0; const waiting = new Map();
  function windowTex(tk, mask) {
    const ck = tk + (mask ? '#m' : ''); if (texs.has(ck)) return texs.get(ck);
    texs.set(ck, null);
    if (!worker) {
      worker = new Worker(new URL('./windowWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: t }) => { const k = waiting.get(t.id); waiting.delete(t.id); if (!disposed) texs.set(k, { tex: dataTex(t.data, t), emissive: dataTex(t.emissive, t) }); };
      worker.onerror = (e) => console.error('city: window texture worker failed', e.message || e);
    }
    waiting.set(++wid, ck); worker.postMessage({ id: wid, key: tk, opts: { seed: 7, tintMask: mask } });
    return null;
  }
  const dataTex = (data, t) => {
    const x = new THREE.DataTexture(data, t.width, t.height); x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set(1 / t.cells, 1 / t.cells);
    x.magFilter = THREE.LinearFilter; x.minFilter = THREE.LinearMipmapLinearFilter; x.generateMipmaps = true; x.anisotropy = 4; x.colorSpace = THREE.SRGBColorSpace; x.needsUpdate = true; ownTex.push(x); return x;
  };
  let glbIndex = opt.textures ? undefined : null;   // undefined = not asked yet, null = none / loading, Map(name -> { file })
  function glbTex(name) {
    if (glbIndex === undefined) { glbIndex = null; optionalJson(cityBase + 'tex/tex.json').then((j) => { glbIndex = new Map(Object.entries(j || {})); if (!j) console.warn('city: no tex/tex.json, flat colours'); }); }
    if (glbIndex === null) return opt.textures ? null : false;
    const e = glbIndex.get(name); if (!e) return false;
    if (texs.has(name)) return texs.get(name);
    texs.set(name, null);
    new THREE.TextureLoader().loadAsync(cityBase + 'tex/' + e.file).then((t) => {
      if (NEUTRAL.has(name)) t = greyTex(t);
      t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; ownTex.push(t);
      const mul = [1, 1, 1];
      try { // normalise by the mean colour so the vertex colour (the kit albedo) keeps the hue
        const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(t.image, 0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data; for (let q = 0; q < 3; q++) mul[q] = Math.min(4, 1 / Math.max(0.05, Math.pow(d[q] / 255, 2.2)));
      } catch { /* keep white */ }
      if (!disposed) texs.set(name, { tex: t, mul });
    }, (err) => { console.warn('city: texture', name, 'unavailable', err.message || err); texs.set(name, false); });
    return null;
  }
  function greyTex(t) {   // luminance copy at <= 1024 px (a tile covers 1.8 m); falls back to the colour texture if the canvas read fails
    try {
      const w = Math.min(1024, t.image.width), h = Math.min(1024, t.image.height), c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(t.image, 0, 0, w, h); const im = ctx.getImageData(0, 0, w, h), d = im.data;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      ctx.putImageData(im, 0, 0); t.dispose(); return new THREE.CanvasTexture(c);
    } catch { return t; }
  }
  // stucco / plaster: fine procedural noise (128 px per tile, mean ~0.95 so the tint stays the albedo)
  function stuccoTex() {
    const N = 128, d = new Uint8Array(N * N * 4); let r = 987654; const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < N * N; i++) { const v = Math.round(255 * (0.9 + 0.1 * rnd() * rnd() * 2)); d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = Math.min(255, v); d[4 * i + 3] = 255; }
    const t = dataTex(d, { width: N, height: N, cells: 1 }); t.repeat.set(1 / TEX_M.plaster, 1 / TEX_M.plaster); return t;
  }
  // paving: procedural slab texture (N x N slabs per tile, dark joints, per-slab tone), uv in metres. paving = 1.2 m concrete slabs, plaza = 2 m granite, band = 0.6 m setts
  const PAVING = { paving: { n: 4, m: 1.2, j: 0.035, v: 0.1 }, pavingPlaza: { n: 2, m: 2, j: 0.02, v: 0.16, speck: 0.12 }, pavingBand: { n: 8, m: 0.6, j: 0.06, v: 0.12 } };
  function pavingTex(k) {
    const P = PAVING[k], N = 128, d = new Uint8Array(N * N * 4), cell = N / P.n, jp = P.j / P.m;   // m = slab size (m), j = joint width (m)
    let r = 12345; const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
    const tone = Array.from({ length: P.n * P.n }, () => 1 - P.v / 2 + rnd() * P.v);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), lx = x - cx * cell, ly = y - cy * cell, joint = lx < jp * cell || ly < jp * cell;
      const v = joint ? 0.55 : tone[cy * P.n + cx] * (1 - (P.speck || 0.04) * rnd()), o = 4 * (y * N + x);
      d[o] = d[o + 1] = d[o + 2] = Math.round(255 * Math.min(1, v * 0.92)); d[o + 3] = 255;
    }
    const t = dataTex(d, { width: N, height: N, cells: 1 }); t.repeat.set(1 / (P.n * P.m), 1 / (P.n * P.m)); return t;
  }
  function material(key) { // -> material, or null while its textures are still coming
    let m = mats.get(key); if (m) return m;
    const tm = performance.now();
    let [k, tk] = splitKey(key); if (!tk && STYLE_BY_MAT[k]) tk = STYLE_BY_MAT[k] + ':0';
    const mask = !isGlass(k), wt = tk ? windowTex(tk, mask) : undefined, gt = GLB_TEX[k] ? glbTex(GLB_TEX[k]) : false;
    if (wt === null || gt === null) return null;
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: isGlass(k) ? 0.25 : 0.9, metalness: k === 'metal' ? 0.4 : 0 });
    if (k === 'shopGlass' && !wt) { m.roughness = 0.12; m.metalness = 0.5; m.color.setRGB(0.35, 0.38, 0.42); }   // plain dark reflective until shop glass gets window textures
    if (PAVING[k]) { m.map = pavingTex(k); m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4; m.renderOrder = 1; }
    if (k === 'plaster' && !wt) m.map = stucco || (stucco = stuccoTex());
    if (k === 'crownLit') { m.emissive.set(0xffe2a0); m.emissiveIntensity = 0.6; }
    if (wt) { m.map = wt.tex; m.emissiveMap = wt.emissive; m.emissive.set(0xffffff); m.emissiveIntensity = 0.15; if (mask) patchTintMask(m); }
    else if (gt) { const t = gt.tex.clone(), r = 1 / (TEX_M[k] || TEX_M_DEF); t.repeat.set(r, r); t.needsUpdate = true; ownTex.push(t); m.map = t; m.color.setRGB(...gt.mul); }
    mats.set(key, m); matMs += performance.now() - tm; stageMax.material = Math.max(stageMax.material, performance.now() - tm); return m;
  }

  // ---------------------------------------------------------------- plaza props: 3 instanced procedural meshes
  const props = (() => {
    const part = (g, rgb, x, y, z) => { g = g.toNonIndexed(); g.translate(x, y, z); const n = g.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) c.set(rgb, 3 * i); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
    const B = (w, h, d) => new THREE.BoxGeometry(w, h, d), wood = [0.45, 0.3, 0.18], iron = [0.15, 0.15, 0.16], conc = [0.62, 0.61, 0.58], leaf = [0.22, 0.42, 0.18];
    const geos = {
      tree: mergeGeometries([part(new THREE.CylinderGeometry(0.12, 0.18, 2.4, 6), [0.35, 0.25, 0.16], 0, 1.2, 0), part(new THREE.IcosahedronGeometry(1.7, 0), leaf, 0, 3.6, 0)]),
      bench: mergeGeometries([part(B(1.7, 0.06, 0.45), wood, 0, 0.45, 0), part(B(1.7, 0.4, 0.05), wood, 0, 0.75, -0.2), part(B(0.06, 0.45, 0.45), iron, -0.75, 0.22, 0), part(B(0.06, 0.45, 0.45), iron, 0.75, 0.22, 0)]),
      planter: mergeGeometries([part(B(1.2, 0.55, 1.2), conc, 0, 0.27, 0), part(new THREE.IcosahedronGeometry(0.55, 0), leaf, 0, 0.8, 0)]),
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), meshes = {};
    for (const [k, g] of Object.entries(geos)) { const m = new THREE.InstancedMesh(g, mat, 256); m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.castShadow = opt.shadows; m.name = 'city_' + k; group.add(m); meshes[k] = m; }
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
    return {
      meshes,
      set(list) { // list = [{ type, x, y, z, yaw }]
        const by = { tree: [], bench: [], planter: [] }; for (const p of list) by[p.type]?.push(p);
        for (const [k, arr] of Object.entries(by)) {
          let m = meshes[k];
          if (arr.length > m.instanceMatrix.count) { const n = new THREE.InstancedMesh(m.geometry, mat, arr.length * 2); Object.assign(n, { frustumCulled: false, receiveShadow: true, castShadow: opt.shadows, name: m.name }); group.remove(m); m.dispose(); group.add(n); meshes[k] = m = n; }
          arr.forEach((p, i) => { Q.setFromAxisAngle(Y, p.yaw); P.set(p.x, p.y, p.z); m.setMatrixAt(i, M.compose(P, Q, S)); });
          m.count = arr.length; m.instanceMatrix.needsUpdate = true;
        }
      },
      dispose() { for (const m of Object.values(meshes)) { m.geometry.dispose(); m.dispose(); } mat.dispose(); },
    };
  })();

  // ---------------------------------------------------------------- chunk meshes
  function meshGroup(M, near) {
    const g = new THREE.Group(); g.name = near ? 'city_near' : 'city_far'; g.matrixAutoUpdate = false;
    for (const [k, a] of M) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(a.pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2)); geo.setAttribute('color', new THREE.BufferAttribute(a.col, 3));
      geo.setIndex(new THREE.BufferAttribute(a.pos.length / 3 > 65535 ? a.idx : Uint16Array.from(a.idx), 1)); geo.computeBoundingSphere();
      const mat = material(k);
      const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.receiveShadow = near; m.castShadow = near && opt.shadows;
      if (mat.renderOrder) m.renderOrder = mat.renderOrder;
      g.add(m);
    }
    return g;
  }
  const dropGroup = (g) => { if (!g) return null; g.removeFromParent(); g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); counters.disposed++; return null; };
  // one chunk build in flight, sliced over frames: plan (one lot per step) -> wait for materials -> meshes -> compileAsync -> shown
  function step(deadline) { // -> true = stop for this frame (out of time or waiting), false = job finished
    const t = job, c = t.c, t0 = performance.now();
    if (!t.P) {
      if (!t.it) t.it = planner.planIter(c.cx, c.cz, { near: t.near });
      for (;;) { const ts = performance.now(), r = t.it.next(); stageMax.planStep = Math.max(stageMax.planStep, performance.now() - ts); if (r.done) { t.P = r.value; break; } if (performance.now() > deadline) { t.plan += performance.now() - t0; return true; } }
      t.plan += performance.now() - t0;
    }
    if (!t.g) {
      for (const k of [...t.P.far.keys(), ...(t.near ? t.P.near.keys() : [])]) if (!material(k) || performance.now() > deadline) return true;   // new materials spread over frames
      const t1 = performance.now();
      t.g = { far: c.far ? null : meshGroup(t.P.far, false), near: t.near ? meshGroup(t.P.near, true) : null };
      t.mesh = performance.now() - t1;
      stageMax.mesh = Math.max(stageMax.mesh, t.mesh); t.objs = [t.g.far, t.g.near].filter(Boolean); t.pend = 0;
      return true;   // compile in later frames
    }
    if (t.objs.length) { // one compileAsync per frame (its synchronous part links new programs: ~15 ms once per program variant, ~0 after)
      const t2 = performance.now(), o = t.objs.shift();
      if (renderer && renderer.compileAsync) { t.pend++; renderer.compileAsync(o, camera, scene).finally(() => { t.pend--; }); }
      stageMax.compileCall = Math.max(stageMax.compileCall, performance.now() - t2);
      return true;
    }
    if (t.pend) return true;
    const P = t.P;
    if (t.g.far) { c.far = t.g.far; group.add(c.far); }
    c.farTris = P.tris.far; c.props = P.props; c.buildings = P.buildings;
    if (t.near) { c.near = t.g.near; group.add(c.near); c.nearTris = P.tris.near; counters.nearBuilt++; } else counters.farBuilt++;
    if (c.far) c.far.visible = !c.near;
    const dt = t.plan + t.mesh; prof.push({ near: t.near, plan: t.plan, mesh: t.mesh, mat: matMs }); matMs = 0;
    buildMs += (dt - buildMs) * 0.2; buildMsMax = Math.max(buildMsMax, dt); propsDirty = true; job = null;
    return false;
  }

  function scan(cam) {
    const Q = QUALITY[quality], out = [];
    for (const [cx, cz] of keys) {
      const k = cx + ':' + cz; let c = chunks.get(k);
      if (!c) chunks.set(k, c = { cx, cz, near: null, far: null, nearTris: 0, farTris: 0, props: [], buildings: null });
      c.d = Math.max(0, Math.hypot((cx + 0.5) * CHUNK - cam.x, (cz + 0.5) * CHUNK - cam.z) - CHUNK * 0.71);
      if (c.near && c.d > Q.near + HYST) { c.near = dropGroup(c.near); propsDirty = true; }
      if (c.far && c.d > Q.far + HYST) { c.far = dropGroup(c.far); c.props = []; }
      if (!c.near && c.d < Q.near) out.push({ c, near: true, d: c.d });
      else if (!c.far && c.d < Q.far) out.push({ c, near: false, d: c.d + 1 });
      if (c.near) c.near.visible = true;
      if (c.far) c.far.visible = !c.near;
    }
    return out.sort((a, b) => a.d - b.d);
  }
  function updateProps() {
    const pr = QUALITY[quality].props, list = [];
    for (const c of chunks.values()) if (c.d < pr) for (const p of c.props) if (Math.hypot(p.x - scanX, p.z - scanZ) < pr) list.push(p);
    props.set(list); propsDirty = false;
  }
  function update(dt, focus) {
    if (!readyFlag || disposed || !planner || !keys.length) return;
    const cp = camera.position, cam = { x: cp.x, z: cp.z };
    if (rescan || Math.hypot(cam.x - scanX, cam.z - scanZ) > RESCAN_DIST) { scanX = cam.x; scanZ = cam.z; pending = scan(cam); rescan = false; propsDirty = true; }
    const t0 = performance.now(), deadline = t0 + opt.budgetMs;
    while (performance.now() < deadline) {
      if (!job) {
        while (pending.length && (pending[0].near ? pending[0].c.near : pending[0].c.far)) pending.shift();
        if (!pending.length) break;
        job = { ...pending.shift(), plan: 0, mesh: 0 };
      }
      if (step(deadline)) break;
    }
    frameMsMax = Math.max(frameMsMax, performance.now() - t0);
    if (propsDirty) updateProps();
    if (pool) { const f = focus || cam; pool.update(f.x, f.z); }
  }

  function clearBuilt() { job = null; for (const c of chunks.values()) { c.near = dropGroup(c.near); c.far = dropGroup(c.far); } chunks.clear(); pending = []; rescan = true; }
  function setQuality(q) { if (!QUALITY[q]) throw new Error('city: quality must be low | medium | high'); if (q !== quality) { quality = q; rescan = true; } }
  function stats() {
    let near = 0, far = 0, draws = 0, tris = 0; const buildings = { residential: 0, rowhouse: 0, downtown: 0 };
    for (const c of chunks.values()) {
      if (c.near) { near++; draws += c.near.children.length; tris += c.nearTris; } else if (c.far) { draws += c.far.children.length; tris += c.farTris; }
      if (c.far) { far++; for (const k in buildings) buildings[k] += c.buildings[k]; }
    }
    for (const m of Object.values(props.meshes)) if (m.count) draws++;
    return { ready: readyFlag, quality, chunks: { total: keys.length, near, far }, buildings, drawCalls: draws, tris, buildMs: +buildMs.toFixed(2), buildMsMax: +buildMsMax.toFixed(2), cityFrameMsMax: +frameMsMax.toFixed(2), stageMax: Object.fromEntries(Object.entries(stageMax).map(([k, v]) => [k, +v.toFixed(2)])), materials: mats.size, pending: pending.length, textured: !!(glbIndex && glbIndex.size), colliders: pool ? pool.stats() : null, blocks: gen ? gen.stats : null, ...counters };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    clearBuilt(); props.dispose(); if (pool) pool.dispose();
    for (const m of mats.values()) m.dispose(); ownTex.forEach((t) => t.dispose()); if (worker) worker.terminate(); scene.onBeforeRender = prevBefore;
    group.removeFromParent();
  }
  return { update, dispose, setQuality, stats, ready, genReady, group, blocked, get gen() { return gen; }, get pool() { return pool; }, get quality() { return quality; } };
}
