// Packs public/models/<Set>/*.gltf into ONE optimised GLB + manifest.
//   npm run nature   ->  public/nature/nature.glb, nature.json   (scatter: instancing-safe)
//   npm run city     ->  public/city/city.glb, city.json         (modular kit: authored pivots kept)
// Per asset: node transforms baked, base moved to y=0, leaf/flower cards BLEND -> MASK (no sorting, instancing-safe),
// textures deduped + resized + webp. Pivot stays at the trunk (x/z untouched) so trees plant where you place them.
import fs from 'fs'; import path from 'path';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { flatten, mergeDocuments, transformMesh, dedup, prune, textureCompress, getBounds } from '@gltf-transform/functions';
import sharp from 'sharp';

const SET = process.argv[2] || 'nature';
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
