// Packs public/models/<Set>/*.gltf into ONE optimised GLB + manifest.
//   npm run nature       ->  public/nature/nature.glb, nature.json   (scatter: instancing-safe) + LODs (below)
//   npm run nature:lods  ->  only (re)generates LOD nodes + trunkRadius in the existing nature.glb / nature.json (sources not needed)
//   npm run city         ->  public/city/city.glb, city.json         (modular kit: authored pivots kept)
// Per asset: node transforms baked, base moved to y=0, leaf/flower cards BLEND -> MASK (no sorting, instancing-safe),
// textures deduped + resized + webp. Pivot stays at the trunk (x/z untouched) so trees plant where you place them.
import fs from 'fs'; import path from 'path';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { flatten, mergeDocuments, transformMesh, dedup, prune, textureCompress, getBounds, simplify, weld, normals, cloneDocument, join } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SET = process.argv[2] || 'nature';
const LODS_ONLY = process.argv.includes('--lods-only');       // keep the existing nature.glb, only regenerate LOD nodes + trunkRadius
const CFG = {
  nature: { src: 'public/models/Nature', out: 'public/nature', ground: true, mask: true, color: 1024, other: 512,
    cats: [[/^(Birch|Maple|Pine|Palm|Common|Twisted)Tree|^(Birch|Maple|Pine|Palm)/, 'tree'], [/^DeadTree/, 'deadtree'], [/^Bush/, 'bush'],
      [/^Flower/, 'flower'], [/^(Grass|Clover|Fern|Plant|Mushroom|Petal)/, 'groundcover'], [/^Rock_/, 'rock'], [/^(Pebble|RockPath)/, 'pebble']] },
  city: { src: 'public/models/City', out: 'public/city', ground: false, mask: false, color: 2048, other: 1024,
    cats: [[/^Building_/, 'building'], [/^Street_/, 'street'], [/^Sidewalk_/, 'sidewalk'], [/^Decal_/, 'decal'], [/^Prop_/, 'prop'],
      [/^Roof_/, 'roof'], [/^Cornice_/, 'cornice'], [/^(Door|DoorFrame)_/, 'door'], [/^(Floor|Entrance|Stairs)_/, 'ground'],
      [/Window/, 'window'], [/Column/, 'column'], [/^(Brick|Metal|Trim)_/, 'wall']] },
}[SET];
const SRC = CFG.src, OUT = CFG.out, CATS = CFG.cats;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const catOf = n => (CATS.find(([re]) => re.test(n)) || [0, 'other'])[1];

// ---- nature LODs (read by src/world/scatter.js) ----
// For every tree / dead tree / bush with > LOD_MIN_TRIS triangles add top-level nodes <name>_LOD1 (vertex ratio 0.25) and <name>_LOD2 (0.06),
// simplified with meshoptimizer, into nature.glb. The manifest gets lods:[names], lodTris:[n, n] and (trees, dead trees) trunkRadius = girth of
// the bark mesh between 0.25 and 0.9 m above the base (90th percentile distance from the centroid; used for the physics colliders).
// Works on the written files, so `npm run nature:lods` re-runs it without the source glTF (idempotent: old _LOD nodes are dropped first).
const LODS = [{ ratio: 0.25, error: 0.12 }, { ratio: 0.06, error: 0.3 }], LOD_MIN_TRIS = 900, LOD_CATS = new Set(['tree', 'deadtree', 'bush']);
const primTris = (p) => (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
function trunkRadius(node) {
  const dy = node.getTranslation()[1];
  for (const [lo, hi] of [[0.25, 0.9], [0, 1.6]]) {
    const pts = [];
    for (const p of node.getMesh().listPrimitives()) {
      if (!/bark/i.test(p.getMaterial()?.getName() || '')) continue;
      const a = p.getAttribute('POSITION');
      for (let i = 0; i < a.getCount(); i++) { const v = a.getElement(i, []); const y = v[1] + dy; if (y >= lo && y <= hi) pts.push([v[0], v[2]]); }
    }
    if (pts.length < 6) continue;
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cz = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const ds = pts.map((q) => Math.hypot(q[0] - cx, q[1] - cz)).sort((x, y) => x - y);
    return +ds[Math.floor(ds.length * 0.9)].toFixed(2);
  }
  return 0;
}
async function addLods() {
  const glb = path.join(OUT, 'nature.glb'), jsonPath = path.join(OUT, 'nature.json');
  const doc = await io.read(glb), man = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const sc = doc.getRoot().listScenes()[0];
  for (const n of sc.listChildren()) if (/_LOD\d$/.test(n.getName())) n.dispose();
  await doc.transform(prune());
  await MeshoptSimplifier.ready;
  const byName = new Map(sc.listChildren().map((n) => [n.getName(), n]));
  for (const e of man.assets) {
    delete e.lods; delete e.lodTris; delete e.trunkRadius;
    const node = byName.get(e.name); if (!node || !node.getMesh()) continue;
    if (e.category === 'tree' || e.category === 'deadtree') e.trunkRadius = trunkRadius(node);
    if (!LOD_CATS.has(e.category) || e.tris <= LOD_MIN_TRIS) continue;
    e.lods = []; e.lodTris = [];
    for (const [k, o] of LODS.entries()) {
      const c = cloneDocument(doc), csc = c.getRoot().listScenes()[0];
      for (const n of csc.listChildren()) if (n.getName() !== e.name) { csc.removeChild(n); n.dispose(); }
      // the source meshes are flat shaded (every vertex split by its normal), which locks meshopt: drop NORMAL, weld, simplify, smooth normals back
      for (const m of c.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('NORMAL', null);
      await c.transform(prune(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: o.ratio, error: o.error }), normals({ overwrite: true }));
      let t = 0; for (const m of c.getRoot().listMeshes()) for (const p of m.listPrimitives()) t += primTris(p);
      const nm = e.name + '_LOD' + (k + 1); e.lods.push(nm); e.lodTris.push(Math.round(t));
      mergeDocuments(doc, c);
      for (const s of doc.getRoot().listScenes()) if (s !== sc) { for (const n of s.listChildren()) { n.setName(nm); sc.addChild(n); } s.dispose(); }
    }
  }
  await doc.transform(dedup(), prune());
  const [b0, ...rest] = doc.getRoot().listBuffers();
  for (const a of doc.getRoot().listAccessors()) a.setBuffer(b0);
  rest.forEach((b) => b.dispose());
  await io.write(glb, doc);
  fs.writeFileSync(jsonPath, JSON.stringify(man, null, 1));
  console.log(`LODs: ${man.assets.filter((e) => e.lods).length} assets -> ${glb} (${(fs.statSync(glb).size / 1024).toFixed(0)} KB)`);
}

// ---- city.glb manifest body data (legacy: the procedural city in src/world/cityFill.js now only borrows city.glb textures) ----
// (The simplified-LOD experiment was dropped: the kit does not simplify cleanly.) Removes any old <name>_LOD nodes from city.glb and writes
// the manifest field body:{x0,x1,z0,z1,h} = bounds of the brick body (facade = local +Z at z=0, pivot at the front, y=0 = ground floor; the trim /
// cornice overhang and the entrance steps are NOT in it). Works on the written files (npm run city:lods), idempotent.
async function addCityLods() {
  const glb = path.join(OUT, 'city.glb'), jsonPath = path.join(OUT, 'city.json');
  const doc = await io.read(glb), man = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const sc = doc.getRoot().listScenes()[0];
  for (const n of sc.listChildren()) if (/_LOD\d$/.test(n.getName())) n.dispose();
  await doc.transform(prune());
  await MeshoptSimplifier.ready;
  const byName = new Map(sc.listChildren().map((n) => [n.getName(), n]));
  for (const e of man.assets) {
    delete e.lods; delete e.lodTris; delete e.body;
    if (e.category !== 'building') continue;
    const node = byName.get(e.name); if (!node || !node.getMesh()) continue;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of node.getMesh().listPrimitives()) {
      if (p.getMaterial()?.getName() !== 'MI_RedBrick') continue;
      const a = p.getAttribute('POSITION'); const v = [0, 0, 0];
      for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); } }
    }
    e.body = { x0: +mn[0].toFixed(2), x1: +mx[0].toFixed(2), z0: +mn[2].toFixed(2), z1: +mx[2].toFixed(2), h: +e.height.toFixed(2) };
  }
  await doc.transform(dedup(), prune());
  const [b0, ...rest] = doc.getRoot().listBuffers();
  for (const a of doc.getRoot().listAccessors()) a.setBuffer(b0);
  rest.forEach((b) => b.dispose());
  await io.write(glb, doc);
  fs.writeFileSync(jsonPath, JSON.stringify(man, null, 1));
  console.log('city bodies: ' + man.assets.filter((e) => e.body).map((e) => e.name).join(', ') + ' (' + (fs.statSync(glb).size / 1024).toFixed(0) + ' KB)');
}

if (!LODS_ONLY) {
  const main = new Document(); main.createBuffer(); const scene = main.createScene('nature');
  const manifest = [];
  const files = fs.readdirSync(SRC).filter(f => /\.(gltf|glb)$/i.test(f)).sort();
  for (const f of files) {
    const d = await io.read(path.join(SRC, f));
    await d.transform(flatten());
    const sc = d.getRoot().listScenes()[0];
    for (const n of sc.listChildren()) {                       // bake any node rotation/scale into the mesh (e.g. Bush_*)
      const m = n.getMesh(); if (!m) continue;
      transformMesh(m, n.getWorldMatrix()); n.setTranslation([0, 0, 0]); n.setRotation([0, 0, 0, 1]); n.setScale([1, 1, 1]);
    }
    const b = getBounds(sc);
    const dy = CFG.ground ? -b.min[1] : 0;                                    // sit on the ground
    for (const n of sc.listChildren()) n.setTranslation([0, dy, 0]);
    const bb = { min: [b.min[0], 0, b.min[2]], max: [b.max[0], b.max[1] + dy, b.max[2]] };
    let tris = 0, alpha = false;
    for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      tris += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
      const mat = p.getMaterial();
      if (mat && CFG.mask && mat.getAlphaMode() === 'BLEND') { mat.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true); alpha = true; }
    }
    const name = path.parse(f).name;
    const radius = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), Math.abs(bb.min[2]), Math.abs(bb.max[2]));
    manifest.push({ name, category: catOf(name), tris, height: +bb.max[1].toFixed(2), radius: +radius.toFixed(2),
      size: [0, 1, 2].map(i => +(bb.max[i] - bb.min[i]).toFixed(2)), alphaCards: alpha });
    mergeDocuments(main, d);                                 // pull this asset into the shared doc
    for (const s of main.getRoot().listScenes()) if (s !== scene) {
      for (const n of s.listChildren()) { n.setName(name); scene.addChild(n); }
      s.dispose();
    }
  }
  await main.transform(dedup(), prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [CFG.color, CFG.color], quality: 82, slots: /^(?!(normal|metallicRoughness|occlusion)Texture)/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [CFG.other, CFG.other], quality: 78, slots: /^(normal|metallicRoughness|occlusion)Texture/ }));
  const [b0, ...rest] = main.getRoot().listBuffers();          // GLB allows one buffer: fold the per-file ones into the first
  for (const a of main.getRoot().listAccessors()) a.setBuffer(b0);
  rest.forEach(b => b.dispose());
  fs.mkdirSync(OUT, { recursive: true });
  await io.write(path.join(OUT, SET + '.glb'), main);
  fs.writeFileSync(path.join(OUT, SET + '.json'), JSON.stringify({ assets: manifest }, null, 1));
  const kb = fs.statSync(path.join(OUT, SET + '.glb')).size / 1024;
  console.log(`${manifest.length} assets -> ${OUT}/${SET}.glb (${kb.toFixed(0)} KB)`);
  const by = {}; for (const m of manifest) (by[m.category] ||= []).push(m);
  for (const [c, l] of Object.entries(by)) console.log(c.padEnd(9), l.length, 'tris', Math.min(...l.map(x => x.tris)) + '..' + Math.max(...l.map(x => x.tris)));
}
if (SET === 'nature') await addLods();
if (SET === 'city') await addCityLods();
