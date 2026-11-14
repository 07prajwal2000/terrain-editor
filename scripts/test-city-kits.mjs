// node scripts/test-city-kits.mjs : rowKit + towerKit variants over many seeds / footprints / weights (+ impostors).
import assert from 'node:assert/strict';
import { planRow, planImpostor as rowImp, ROW_VARIANTS, ROW_TRI_BUDGET, rowKey } from '../src/world/rowKit.js';
import { planTower, planImpostor as towerImp, TOWER_VARIANTS, TOWER_MATS, TOWER_SHAPES, TOWER_CROWNS, TOWER_BASES, towerBudget } from '../src/world/towerKit.js';
import { windowTexture, WINDOW_STYLES, STYLE_BY_MAT, STYLE_POOL, STYLE_VARIANTS, textureKeyFor, parseTextureKey, textureFromKey } from '../src/world/windowAtlas.js';
import { CITY_MATS } from '../src/world/rowKit.js';
import { hash } from '../src/world/scatterGen.js';

function check(b, spec, tag) {
  const e = 1e-4;
  for (const p of b.prims) {
    for (let i = 0; i < p.pos.length; i += 3) {
      const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
      assert.ok(Number.isFinite(x + y + z), `${tag} finite`);
      assert.ok(Math.abs(x) <= spec.hu + e && Math.abs(z) <= spec.hv + e && y >= -e, `${tag} ${p.mat} out of footprint (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)})`);
      assert.ok(Math.abs(Math.hypot(p.nor[i], p.nor[i + 1], p.nor[i + 2]) - 1) < 1e-4, `${tag} unit normal`);
    }
    for (let t = 0; t < p.idx.length; t += 3) {
      const [a, b2, c] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]].map((k) => 3 * k), P = p.pos;
      const ux = P[b2] - P[a], uy = P[b2 + 1] - P[a + 1], uz = P[b2 + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      assert.ok((uy * vz - uz * vy) * p.nor[a] + (uz * vx - ux * vz) * p.nor[a + 1] + (ux * vy - uy * vx) * p.nor[a + 2] > 0, `${tag} ${p.mat} winding`);
    }
  }
  assert.ok(b.collider.length > 0 && b.collider.every((c) => Math.abs(c.cx) + c.hu <= spec.hu + 1e-4 && Math.abs(c.cz) + c.hv <= spec.hv + 1e-4), `${tag} collider`);
}
const same = (a, b) => { assert.equal(a.tris, b.tris); a.prims.forEach((p, i) => assert.deepEqual(p.pos, b.prims[i].pos)); };
const N = 60, out = [];

for (const variant of ROW_VARIANTS) {
  const st = { min: 1e9, max: 0, ms: 0, n: 0 };
  for (let s = 0; s < N; s++) {
    const spec = { hu: 2.8 + hash(s, 1, 0, 0) * 2.2, hv: 4.5 + hash(s, 2, 0, 0) * 1.5, seed: s * 7919 + 13, weight: hash(s, 3, 0, 0), attached: s % 4 !== 0, corner: s % 5 === 0, variant };
    if (s % 3 === 0) { spec.leftH = 4 + hash(s, 4, 0, 0) * 12; spec.rightH = 4 + hash(s, 5, 0, 0) * 12; }
    const t0 = performance.now(), b = planRow(spec); st.ms += performance.now() - t0; st.n++;
    same(b, planRow(spec)); check(b, spec, `${variant} ${s}`);
    assert.ok(b.tris < ROW_TRI_BUDGET, `${variant} ${s}: ${b.tris} tris`);
    const imp = rowImp(spec); assert.ok(imp.tris <= 30); check({ ...imp, collider: b.collider }, spec, `${variant} imp`);
    st.min = Math.min(st.min, b.tris); st.max = Math.max(st.max, b.tris);
  }
  out.push([variant, st]);
}
// closed shell: with no neighbours (leftH = rightH = 0, or unknown) every rowhouse has an outward wall on all 4 sides covering ground -> body top (also exported for the chunk test)
export function wallReach(b, variant) {   // per direction [-x, +x, -z, +z]: { lo, hi } y-range of the outward wall triangles (-1 / 1 = none)
  const dirs = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]], r = dirs.map(() => ({ lo: 1e9, hi: -1e9 }));
  for (const p of b.prims) if (['brick', 'brownstone', 'plaster'].includes(p.mat)) for (let t = 0; t < p.idx.length; t += 3) {
    const a = p.idx[t] * 3, d = dirs.findIndex((v) => p.nor[a] * v[0] + p.nor[a + 2] * v[2] > 0.99);
    if (d < 0) continue;
    for (let k = 0; k < 3; k++) { const y = p.pos[p.idx[t + k] * 3 + 1]; r[d].lo = Math.min(r[d].lo, y); r[d].hi = Math.max(r[d].hi, y); }
  }
  return r;
}
for (const variant of ROW_VARIANTS) for (let s = 0; s < 30; s++) for (const sp of [{ leftH: 0, rightH: 0 }, {}, { leftH: undefined, rightH: 0 }]) for (const attached of [true, false]) {
  const spec = { hu: 3 + hash(s, 1, 0, 0) * 2.5, hv: 4.8 + hash(s, 2, 0, 0), seed: s * 31 + 5, weight: hash(s, 3, 0, 0), attached, corner: s % 4 === 0, variant, ...sp }, b = planRow(spec);
  const need = b.wallTop - 0.15;
  wallReach(b, variant).forEach((r, d) => assert.ok(r.lo <= 0.01 && r.hi >= need, `${variant} ${s} attached=${attached} ${JSON.stringify(sp)}: side ${d} not a closed wall (${r.lo.toFixed(2)}..${r.hi.toFixed(2)}, need ..${need.toFixed(2)})`));
}
{   // a taller neighbour hides the side; a lower one leaves only the part above it
  const spec = { hu: 4, hv: 5.5, seed: 3, attached: true, variant: 'georgian' }, top = planRow(spec).tiers[0].y1;
  const tall = wallReach(planRow({ ...spec, leftH: top + 5 }), 'georgian'), low = wallReach(planRow({ ...spec, leftH: top - 4 }), 'georgian');
  assert.ok(tall[0].lo > 5, 'taller neighbour: no side wall (only the chimney faces that way)'); assert.ok(low[0].lo > 2 && low[0].hi >= top - 0.2, `lower neighbour: wall only above it (${low[0].lo.toFixed(1)}..${low[0].hi.toFixed(1)})`);
}
for (const variant of TOWER_VARIANTS) {
  const st = { min: 1e9, max: 0, ms: 0, n: 0, msMax: 0 };
  let tried = 0;
  for (let s = 0; st.n < N && tried < 4000; s++, tried++) {
    const spec = { hu: 8 + hash(s, 1, 0, 0) * 7, hv: 12 + hash(s, 2, 0, 0) * 8, seed: s * 104729 + 7, weight: 0.5 + hash(s, 3, 0, 0) * 0.5 };
    const probe = planTower(spec);   // force only variants that suit the floor count
    const r = { classic: [3, 14], classicStone: [3, 12], concreteGrid: [4, 30], glassBox: [6, 45], chamfered: [10, 70], podiumTower: [15, 70], artDeco: [12, 70], slab: [8, 40], twinTower: [20, 70], taperTower: [12, 70] }[variant];
    if (probe.floors < r[0] || probe.floors > r[1]) continue;
    spec.variant = variant;
    const t0 = performance.now(), b = planTower(spec), dt = performance.now() - t0; st.ms += dt; st.n++; st.msMax = Math.max(st.msMax, dt);
    same(b, planTower(spec)); check(b, spec, `${variant} ${s}`);
    assert.ok(b.collider.some((c) => c.y0 <= 0.01 && c.y1 >= 1 && Math.abs(c.cx) <= c.hu && Math.abs(c.cz) <= c.hv), `${variant} ${s} ground collider`);
    for (const p of b.prims) assert.ok(CITY_MATS.includes(p.mat) || TOWER_MATS.includes(p.mat), `unknown mat ${p.mat}`);
    assert.ok(b.tris < towerBudget(b.floors), `${variant} ${s}: ${b.tris} tris at ${b.floors} floors`);
    const imp = towerImp(spec); assert.ok(imp.tris <= 30, `imp ${imp.tris}`); check({ ...imp, collider: b.collider }, spec, `${variant} imp`);
    st.min = Math.min(st.min, b.tris); st.max = Math.max(st.max, b.tris); st.fmin = Math.min(st.fmin ?? 99, b.floors); st.fmax = Math.max(st.fmax ?? 0, b.floors);
  }
  assert.ok(st.n >= 20, `${variant}: only ${st.n} samples`);
  out.push([variant, st]);
}
// height grows with weight (mean over seeds), unforced picks cover every variant
let prev = 0;
for (let w = 0.5; w <= 1.001; w += 0.05) {
  let sum = 0; for (let s = 0; s < 200; s++) sum += planTower({ hu: 12, hv: 16, seed: s, weight: w }).H;
  assert.ok(sum / 200 > prev, `height not monotonic at weight ${w.toFixed(2)}`); prev = sum / 200;
  if (Math.abs(w - 0.5) < 1e-6 || Math.abs(w - 1) < 1e-6) console.log(`weight ${w.toFixed(2)}: mean H ${(sum / 200).toFixed(1)} m`);
}
const seenT = new Set(), seenR = new Set();
for (let s = 0; s < 3000; s++) { seenT.add(planTower({ hu: 12, hv: 16, seed: s, weight: 0.5 + (s % 50) / 100 }).variant); seenR.add(planRow({ hu: 4, hv: 5.5, seed: s }).variant); }
assert.equal(seenT.size, TOWER_VARIANTS.length); assert.equal(seenR.size, ROW_VARIANTS.length);
// timing over unforced plans (fresh: avoids the probe warm-up skew)
for (const [wt, lim] of [[0.55, 1], [1, 3]]) {
  let t = 0; for (let s = 0; s < 300; s++) { const t0 = performance.now(); planTower({ hu: 12, hv: 16, seed: s, weight: wt }); t += performance.now() - t0; }
  console.log(`towers weight ${wt}: ${(t / 300).toFixed(3)} ms/plan (target < ${lim})`); assert.ok(t / 300 < lim);
}
for (const [v, st] of out) console.log(v.padEnd(18), `tris ${st.min}-${st.max}`, st.fmin ? `floors ${st.fmin}-${st.fmax}` : '', `${(st.ms / st.n).toFixed(3)} ms avg`);
// window textures: deterministic, right size, opaque, seed-dependent, every band material has a style
for (const st of WINDOW_STYLES) {
  const a = windowTexture(st, { seed: 3 }), b = windowTexture(st, { seed: 3 });
  assert.equal(a.data.length, a.width * a.height * 4); assert.equal(a.emissive.length, a.data.length);
  assert.deepEqual(a.data, b.data); assert.deepEqual(a.emissive, b.emissive);
  for (let i = 3; i < a.data.length; i += 4) assert.equal(a.data[i], 255);
  if (st !== 'panel' && st !== 'dark') assert.notDeepEqual(a.data, windowTexture(st, { seed: 4 }).data, st);
}
assert.ok(windowTexture('punched', { seed: 3 }).emissive.some((v, i) => i % 4 === 0 && v > 0), 'some lit windows');
for (const m of ['windowBand', 'curtainGlass', 'windowGrid', 'windowDeco', 'metalPanel']) assert.ok(WINDOW_STYLES.includes(STYLE_BY_MAT[m]), m);
{ const t0 = performance.now(); for (const st of WINDOW_STYLES) windowTexture(st); console.log(`window textures: ${(performance.now() - t0).toFixed(1)} ms for ${WINDOW_STYLES.length}`); }
// texture keys: valid, deterministic; tintMask zeroes glass alpha only on masonry styles; variants differ
for (const [m, pool] of Object.entries(STYLE_POOL)) for (let s = 0; s < 50; s++) { const k = textureKeyFor(m, s), { style, variant } = parseTextureKey(k); assert.ok(pool.includes(style) && variant >= 0 && variant < STYLE_VARIANTS, k); assert.equal(k, textureKeyFor(m, s)); }
{ const t = textureFromKey('arched:1', { tintMask: true }); assert.ok(t.data.some((v, i) => i % 4 === 3 && v === 0)); assert.ok(windowTexture('curtain', { tintMask: true }).data.every((v, i) => i % 4 !== 3 || v === 255));
  assert.notDeepEqual(textureFromKey('punched:0').data, textureFromKey('punched:2').data); }
// variety: distinct (variant, shape, crown, wall texture, glass texture) over 200 unforced towers at weight >= 0.6
{ const combos = new Set(), tk = new Set(); let n = 0;
  for (let s = 0; s < 200; s++) { const b = planTower({ hu: 12, hv: 16, seed: s * 7 + 1, weight: 0.6 + (s % 40) / 100 }); n++;
    for (const k of Object.values(b.tex)) tk.add(k); assert.ok(TOWER_SHAPES.includes(b.shape) && TOWER_CROWNS.includes(b.crown), `${b.shape} ${b.crown}`);
    combos.add([b.variant, b.shape, b.crown, b.tex.windowBand || b.tex.windowGrid || b.tex.windowDeco || '-', b.tex.curtainGlass || '-'].join('|')); }
  console.log(`variety: ${combos.size} distinct (variant|shape|crown|wallTex|glassTex) combos in ${n} towers, ${tk.size} texture keys used`); assert.ok(combos.size > 100); }
// ground floor: every base type occurs, no shopGlass on towers, ground glass has whole-cell uv and a tex key, front bays not all alike
{ const bases = new Set(), fronts = new Set();
  for (let s = 0; s < 300; s++) {
    const b = planTower({ hu: 12, hv: 16, seed: s * 3 + 2, weight: 0.55 + (s % 45) / 100 }); bases.add(b.base);
    assert.ok(!b.prims.some((p) => p.mat === 'shopGlass'), 'tower uses shopGlass');
    for (const p of b.prims) if (['lobbyGlass', 'retailGlass', 'officeGlass'].includes(p.mat)) {
      assert.ok(b.tex[p.mat], `tex for ${p.mat}`); assert.ok(p.uv.every((v) => Number.isInteger(v)), `${p.mat} uv whole cells`);
    }
    fronts.add(b.prims.filter((p) => p.mat.endsWith('Glass') && p.mat !== 'curtainGlass').map((p) => `${p.mat}${p.idx.length}`).join());
  }
  assert.deepEqual([...bases].sort(), [...TOWER_BASES].sort()); assert.ok(fronts.size > 30, `ground-floor layouts ${fronts.size}`);
  console.log(`ground floors: ${fronts.size} distinct glass layouts in 300 towers, bases ${[...bases].join(' ')}`); }
// rowhouses: no shopGlass; ground glass has a tex key and whole-cell uv; flat-fronted styles actually get shopfronts
{ let shops = 0;
  for (let s = 0; s < 300; s++) {
    const b = planRow({ hu: 4, hv: 5.5, seed: s * 13 + 1 });
    assert.ok(!b.prims.some((p) => p.mat === 'shopGlass'), 'row uses shopGlass');
    for (const p of b.prims) if (['retailGlass', 'officeGlass'].includes(p.mat)) { shops++; assert.ok(b.tex[p.mat], `row tex for ${p.mat}`); assert.ok(p.uv.every((v) => Number.isInteger(v)), `row ${p.mat} uv whole cells`); }
  }
  assert.ok(shops > 0, 'no rowhouse shopfronts'); }
// rowhouse variety: distinct (variant, palette, window type, roofline, ground floor) over 300 seeds; every ground floor / roofline / window type / palette family occurs
{ const combos = new Set(), seen = { gf: new Set(), roof: new Set(), win: new Set(), pal: new Set(), sur: new Set(), balc: new Set() }; let t = 0;
  for (let s = 0; s < 300; s++) {
    const t0 = performance.now(), b = planRow({ hu: 3 + (s % 5) * 0.6, hv: 5.5, seed: s * 13 + 1, weight: (s % 7) / 7, corner: s % 9 === 0, cornerSide: s % 18 === 0 ? 'left' : 'right', attached: true }); t += performance.now() - t0;
    const m = b.meta; combos.add([m.variant, m.palette, m.win, m.roof, m.gf].join('|'));
    seen.gf.add(m.gf); seen.roof.add(m.roof.replace(/\d$/, '')); seen.win.add(m.win.split('+')[0]); seen.pal.add(m.palette.replace(/\d+$/, '')); seen.sur.add(m.sur); seen.balc.add(m.balc);
    assert.ok(b.tris < ROW_TRI_BUDGET && b.wallTop > 0 && b.top >= b.wallTop - 1e-9, `${m.variant} ${b.tris}`);
  }
  const need = { gf: ['res', 'area', 'shop', 'pub', 'garage'], roof: ['parapet', 'bracket', 'mansard', 'stepGable', 'curveGable', 'deco'], win: ['sash', 'casement', 'arched', 'multi'], pal: ['red', 'stock', 'chicago', 'painted', 'brown', 'stucco', 'pastel'], sur: ['none', 'lintel', 'pediment', 'hood', 'keystone'], balc: ['none', 'juliet', 'full', 'fire'] };
  for (const [k, list] of Object.entries(need)) for (const v of list) assert.ok(seen[k].has(v), `${k} '${v}' never picked: ${[...seen[k]]}`);
  console.log(`variety: ${combos.size} distinct (variant|palette|window|roofline|ground floor) combos in 300 seeds (old kit: 30); plan ${(t / 300).toFixed(3)} ms avg`); assert.ok(combos.size > 150 && t / 300 < 1);
  // avoid: a re-rolled pick never equals a forbidden (style, palette); unforced picks are unchanged without avoid
  for (let s = 0; s < 300; s++) { const sp = { hu: 4, hv: 5.5, seed: s * 17 + 3 }, k = rowKey(sp), b = planRow({ ...sp, avoid: [k] }); assert.notEqual(b.meta.variant + '|' + b.meta.palette, k); assert.equal(planRow(sp).meta.variant + '|' + planRow(sp).meta.palette, k); }
}
console.log('ok');
