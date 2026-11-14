// Dev page (/city-kit-preview.html): rowKit: a terrace of 10, a broken terrace, a 20-lot terrace (no equal neighbours), a corner-lot row, all 17 variants, + towers across weight 0.5 -> 1 (towerKit), with their far-LOD impostors behind. Band materials use procedural window textures (windowAtlas).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { planRow, planImpostor as rowImp, ROW_VARIANTS } from '../world/rowKit.js';
import { planTower, planImpostor as towerImp } from '../world/towerKit.js';
import { STYLE_BY_MAT, STYLE_POOL, parseTextureKey, textureFromKey, patchTintMask } from '../world/windowAtlas.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 4000);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x556644, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(40, 80, 60); scene.add(sun);
// band materials get a procedural window texture (windowAtlas, uv in window cells -> repeat 1 / cells), multiplied by the vertex tint
const tex = (data, t) => {
  const x = new THREE.DataTexture(data, t.width, t.height); x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set(1 / t.cells, 1 / t.cells);
  x.magFilter = THREE.LinearFilter; x.minFilter = THREE.LinearMipmapLinearFilter; x.generateMipmaps = true; x.anisotropy = 8; x.colorSpace = THREE.SRGBColorSpace; x.needsUpdate = true; return x;
};
// k = material key or material key + '|' + texture key ('style:variant' from planTower().tex); masonry textures bake glass colour (tintMask + patchTintMask)
const MASONRY = new Set([...STYLE_POOL.windowBand, ...STYLE_POOL.windowGrid, ...STYLE_POOL.windowDeco]);
function makeMat(k) {
  const [mk, tk] = k.split('|'), style = tk ? parseTextureKey(tk).style : STYLE_BY_MAT[mk];
  if (mk === 'crownLit') return new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffe2a0, emissiveIntensity: 0.6 });
  if (!style) return new THREE.MeshLambertMaterial({ vertexColors: true });
  const masonry = MASONRY.has(style), t = textureFromKey(tk || style + ':0', { seed: 7, tintMask: masonry });
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex(t.data, t), emissiveMap: tex(t.emissive, t), emissive: 0xffffff, emissiveIntensity: 0.15 });
  return masonry ? patchTintMask(m) : m;
}
const mats = new Map(), mat = (k) => mats.get(k) || mats.set(k, makeMat(k)).get(k);
const lines = [], specsT = [];
function add(b, x, z, texKeys = b.tex) {
  const grp = new THREE.Group(); grp.position.set(x, 0, z);
  for (const p of b.prims) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(p.nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(p.col, 3)); g.setIndex(new THREE.BufferAttribute(p.idx, 1));
    grp.add(new THREE.Mesh(g, mat(texKeys?.[p.mat] ? p.mat + '|' + texKeys[p.mat] : p.mat)));
  }
  scene.add(grp);
}
// terrace: neighbours pass their heights so the visible part of a taller party wall is emitted
const specs = Array.from({ length: 10 }, (_, i) => ({ hu: 3 + (i % 3) * 0.6, hv: 5.5, seed: 500 + i * 37, weight: 0.4 + (i % 4) * 0.15, attached: true, corner: i === 0 || i === 9, cornerSide: i === 0 ? 'left' : 'right' }));
const hs = specs.map((s) => planRow(s).H);
let x = 0;
specs.forEach((s, i) => {
  const b = planRow({ ...s, leftH: hs[i - 1], rightH: hs[i + 1] });
  x += s.hu; add(b, x, 0); add(rowImp(s), x, -30); x += s.hu;
  lines.push(`row ${i}: ${b.variant} ${b.tris} tris`);
});
// broken terrace (z = -70): lots 2, 5 and 6 rejected like cityBlocks does (slope / overlap), so the survivors have holes and ends: heights only from really adjacent lots, 0 = finished end wall
{
  const gone = new Set([2, 5, 6]), bs = Array.from({ length: 10 }, (_, i) => ({ hu: 3 + (i % 3) * 0.6, hv: 5.5, seed: 900 + i * 41, weight: 0.4 + (i % 4) * 0.15, attached: true })), bh = bs.map((q) => planRow(q).H);
  let bx = 0;
  bs.forEach((q, i) => {
    bx += q.hu; if (!gone.has(i)) add(planRow({ ...q, leftH: gone.has(i - 1) || i === 0 ? 0 : bh[i - 1], rightH: gone.has(i + 1) || i === 9 ? 0 : bh[i + 1] }), bx, -70); bx += q.hu;
  });
}
// 20-lot terrace (z = -250; views: #terrace #corner #variants, key i toggles the list): every lot avoids its left neighbour's (style, palette) via spec.avoid -- no two adjacent buildings look alike
{
  let px = 0, prev = null;
  for (let i = 0; i < 20; i++) {
    const q = { hu: 2.8 + (i * 7 % 5) * 0.55, hv: 5.5, seed: 4000 + i * 53, weight: 0.3 + (i * 3 % 7) * 0.1, attached: true, avoid: prev ? [prev] : [] };
    const b = planRow({ ...q, leftH: i ? 1 : 0, rightH: 0 }); prev = b.meta.variant + '|' + b.meta.palette;   // heights are placeholders; the row is re-planned below once all are known
    q.key = prev; q.H = b.top; specsT.push(q);
  }
  specsT.forEach((q, i) => {
    const b = planRow({ ...q, leftH: i ? specsT[i - 1].H : 0, rightH: i < 19 ? specsT[i + 1].H : 0, corner: i === 0 || i === 19, cornerSide: i === 0 ? 'left' : 'right' });
    px += q.hu; add(b, px, -250); px += q.hu; lines.push(`terrace ${i}: ${b.meta.variant} ${b.meta.palette} ${b.meta.win} ${b.meta.roof} ${b.meta.gf} ${b.tris} tris`);
  });
}
// corner-lot row (z = -290): detached corner lots with the side street on alternating sides (shop / pub ground floors, turrets, side-wall windows)
for (let i = 0; i < 8; i++) {
  const q = { hu: 3.6 + (i % 3) * 0.5, hv: 5.5, seed: 7000 + i * 71, weight: 0.5 + (i % 4) * 0.1, attached: true, corner: true, cornerSide: i % 2 ? 'right' : 'left', leftH: 0, rightH: 0 }, b = planRow(q);
  add(b, i * 12, -290); lines.push(`corner ${i}: ${b.meta.variant} ${b.meta.palette} ${b.meta.win} ${b.meta.gf} ${b.tris} tris`);
}
// every variant once (z = -330), forced, same width
ROW_VARIANTS.forEach((v, i) => { const b = planRow({ hu: 4, hv: 5.5, seed: 321 + i, weight: 0.7, variant: v, attached: false }); add(b, i * 10, -330); lines.push(`variant ${v}: ${b.meta.palette} ${b.meta.roof} ${b.tris} tris`); });
// towers across weights
let tx = 0, tt = 0;
for (let i = 0; i < 16; i++) {   // two rows of 8: towers at z 60 / 100, impostors at z 150 / 190
  const row = i >> 3, spec = { hu: 12, hv: 16, seed: 900 + i * 13, weight: 0.5 + (i % 8) / 14 + row * 0.03 }, b = planTower(spec);
  tx = (i % 8) * 30; add(b, tx, 60 + row * 40); add(towerImp(spec), tx, 150 + row * 40, b.tex); tt += b.tris;
  lines.push(`tower w=${spec.weight.toFixed(2)}: ${b.variant}/${b.shape}/${b.crown}/${b.base} ${b.floors} fl ${b.tris} tris ${Object.values(b.tex).join(' ')}`);
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 800), new THREE.MeshLambertMaterial({ color: 0x777a70 }));
ground.rotation.x = -Math.PI / 2; ground.position.set(100, -0.02, -110); scene.add(ground);
document.getElementById('info').textContent = `front: terrace + towers, behind: impostors\n${lines.join('\n')}`;
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(100, 10, -60); camera.position.set(80, 70, -280); controls.update();
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
const VIEWS = { terrace: [[60, 8, -250], [60, 16, -205]], corner: [[42, 8, -290], [42, 14, -250]], variants: [[85, 8, -330], [85, 18, -290]] };
const view = VIEWS[location.hash.slice(1)]; if (view) { controls.target.set(...view[0]); camera.position.set(...view[1]); controls.update(); }
addEventListener('keydown', (e) => { if (e.key === 'i') { const el = document.getElementById('info'); el.style.display = el.style.display === 'none' ? '' : 'none'; } });
