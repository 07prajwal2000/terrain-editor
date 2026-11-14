// Writes the few city.glb base-colour textures cityFill.js borrows to public/city/tex/ (webp, as embedded) + tex.json { material: file },
// so the game fetches ~0.4 MB instead of the 10 MB GLB.   node scripts/extract-city-textures.mjs
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const WANT = /^(MI_RedBrick|MI_Trim|MI_Concrete|MI_Roof_Slate|MI_Glass|MI_FakeInterior.*|MI_Trim_MetalConcrete)$/;
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read('public/city/city.glb');
fs.mkdirSync('public/city/tex', { recursive: true });
const out = {};
for (const m of doc.getRoot().listMaterials()) {
  const t = m.getBaseColorTexture(); if (!WANT.test(m.getName()) || !t) continue;
  const file = m.getName() + '.' + (t.getMimeType().split('/')[1] || 'webp');
  fs.writeFileSync('public/city/tex/' + file, t.getImage());
  out[m.getName()] = { file, size: t.getSize() };
}
fs.writeFileSync('public/city/tex/tex.json', JSON.stringify(out, null, 1));
console.log(out);
