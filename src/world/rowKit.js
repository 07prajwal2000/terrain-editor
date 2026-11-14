// Procedural Georgian -> Art Deco rowhouses / apartment blocks (terraces) as raw triangle primitives (pure: no THREE, runs in Node; same output contract as houseKit.planHouse).
//
//   planRow(spec) -> { prims: [{ mat, pos, nor, uv, idx, cs: 3, col }], W, D, H, tris, variant, collider: [{ cx, cz, hu, hv, y0, y1 }], tiers, tex, col, top, wallTop, meta }   house-local coordinates:
//        pivot = footprint centre at ground, local +Z = street (cityBlocks lot.footprint: place at (cx, 0, cz), yaw = footprint.yaw). Everything inside x in [-hu, hu], z in [-hv, hv], y >= 0.
//   spec = { hu, hv, seed, weight?: 0..1, attached?: bool, corner?: bool, cornerSide?: 'left' | 'right' | 'both', leftH?, rightH?, leftZ?: [z0, z1], rightZ?: [z0, z1], variant?: name, avoid?: [rowKey] }
//        attached: side walls are party walls and are NOT emitted, except the part above a lower neighbour (leftH = -X neighbour height, rightH = +X). An unknown / 0 neighbour
//        height means NO neighbour: that side is a finished end wall (same as a detached end, cornice / parapet / mansard closed with end caps). leftZ / rightZ = z-extent [back, front wall]
//        of that neighbour in THIS lot's frame (front walls differ per style: stoops / setbacks): the strip of side wall the neighbour does not cover is emitted too. corner: the side(s) given by cornerSide (default 'both' -- lots only know they are corners) get a finished facade with windows. weight -> more floors.
//        avoid: list of rowKey() strings ("variant|palette") this building must not pick (neighbours' keys): the pick is re-rolled (up to 8x). Feed the keys of the adjacent lots.
//        top = roof height of the main body (what neighbours see as leftH / rightH; gables, turrets, water tanks, cresting stick out above it), wallTop = height the side walls must reach (top, minus the mansard slab).
//        meta = { variant, palette, win, roof, gf, sur, balc } the per-seed choices (palette = name + colour index, e.g. 'painted3').
//   rowKey(spec) -> 'variant|palette' without planning. planImpostor(spec) / impostorFromTiers(tiers, colours) -> { prims, tris, H, tiers } far-LOD box (<= 10 tris per tier) with a 'windowBand' facade, also used by towerKit.
//   ROW_VARIANTS, CITY_MATS = every material key a city-kit prim can carry, ROW_TRI_BUDGET.
//
// STYLES (data, see STY; 17): georgian, georgianWide (5 bays, centre door), regency (stucco, balcony), victorianBay (canted bay column, stoop), italianate (bay / oriel, bracket or mansard), brownstone,
// brownstoneMansard, londonStucco (stucco terrace: columned porch, area railings, rusticated base), mewsHouse (2-3 floors, garage door), edwardianMansion (5-7 floors, stone bands, turret / oriel, gabled dormers),
// nycTenement (5-6 floors, fire escapes, deep cornice, ground-floor shops), prewarApartment (7-10 floors, stone base / brick middle / stone top, roof water tank), castIronLoft (SoHo: iron columns, big
// multi-pane windows), dutchGable (stepped / bell gable front), secondEmpire (tall mansard, ornate dormers, iron cresting), queenAnneCorner (half-hex turret with conical roof), artDecoWalkup (piers, spandrels, stepped parapet).
// PER-SEED CHOICES inside a style: palette (wall material + tint: red / London stock / Chicago common / painted / brownstone / white + pastel stucco), window type (sash / casement / arched / multi-pane),
// surround (none / lintel / pediment / hood / keystone), canted bay or oriel, balconies (juliet / full / fire escape), roofline (parapet / bracket cornice / mansard + 1-3 dormers / step or bell gable / deco), ground floor
// (residential / area railings / shop / pub / garage), shutters, plant boxes, AC units, porch. Neighbouring lots differ by seed; spec.avoid lets the caller forbid the neighbours' (style, palette).
// GEOMETRY as houseKit: uv in metres, winding checked against outward hints, detail quads 1.5-5 cm proud of the wall. The flat roof / parapet inner faces exist so it reads from above.
import { hash } from './scatterGen.js';
import { Mesh, split } from './shapeGrammar.js';
import { textureKeyFor } from './windowAtlas.js';

// MATS shared with houseKit: brick, plaster, roof, roofFlat, trim, glass, door, concrete. New: stone (lintels, sills, cornices, stoops), brownstone (wall), metal (railings, fire escapes, HVAC),
// windowBand (wall-with-windows texture, tinted per building), curtainGlass (glazed curtain wall texture), metalPanel (spandrels / crown cladding), shopGlass (ground-floor shopfronts), awning,
// wood (water tank, flat colour, also towerKit) and foliage (plant boxes, flat colour). Suggested city.glb mapping: brick -> MI_RedBrick (cityFill greys it: the vertex tint carries the hue), brownstone -> same
// (dark tint), plaster -> procedural stucco noise (cityFill), stone / trim -> MI_Concrete, concrete -> MI_Concrete, roof -> MI_Roof_Slate, glass / curtainGlass -> MI_Glass, shopGlass -> MI_FakeInterior*,
// metalPanel / metal -> MI_Trim_MetalConcrete, windowBand -> a tiled window atlas, roofFlat -> MI_Concrete, wood / foliage -> flat colour.
export const CITY_MATS = ['brick', 'brownstone', 'plaster', 'stone', 'roof', 'roofFlat', 'trim', 'glass', 'door', 'concrete', 'metal', 'windowBand', 'curtainGlass', 'metalPanel', 'shopGlass', 'awning', 'wood', 'foliage'];
export const ROW_VARIANTS = ['georgian', 'georgianWide', 'regency', 'victorianBay', 'italianate', 'brownstone', 'brownstoneMansard', 'londonStucco', 'mewsHouse', 'edwardianMansion', 'nycTenement',
  'prewarApartment', 'castIronLoft', 'dutchGable', 'secondEmpire', 'queenAnneCorner', 'artDecoWalkup'];
export const ROW_TRI_BUDGET = 1500;
const FH = 3.1;

// palettes: name -> wall material key + tints (the brick texture is neutral grey in cityFill, so these ARE the colours)
const PALS = {
  red: { mat: 'brick', c: [[0.62, 0.3, 0.24], [0.7, 0.42, 0.33], [0.55, 0.32, 0.27], [0.5, 0.26, 0.22]] },
  stock: { mat: 'brick', c: [[0.66, 0.6, 0.42], [0.6, 0.55, 0.43], [0.7, 0.63, 0.48]] },   // London stock yellow-grey
  chicago: { mat: 'brick', c: [[0.74, 0.52, 0.34], [0.68, 0.46, 0.3], [0.78, 0.6, 0.42]] },   // Chicago common brick, buff / orange
  painted: { mat: 'brick', c: [[0.92, 0.92, 0.9], [0.9, 0.84, 0.7], [0.6, 0.7, 0.56], [0.16, 0.22, 0.38], [0.1, 0.1, 0.11]] },   // white cream sage navy black
  brown: { mat: 'brownstone', c: [[0.42, 0.28, 0.22], [0.5, 0.34, 0.26], [0.36, 0.25, 0.21]] },   // NYC brownstone
  stucco: { mat: 'plaster', c: [[0.94, 0.93, 0.9], [0.93, 0.9, 0.82]] },   // white / ivory
  pastel: { mat: 'plaster', c: [[0.92, 0.7, 0.72], [0.7, 0.82, 0.9], [0.95, 0.88, 0.6], [0.7, 0.86, 0.74], [0.86, 0.76, 0.9], [0.95, 0.8, 0.65]] },   // Notting Hill pink blue yellow mint lilac peach
};
const PAL = {
  door: [[0.08, 0.08, 0.09], [0.12, 0.18, 0.35], [0.55, 0.12, 0.1], [0.15, 0.32, 0.2], [0.35, 0.2, 0.12]],
  trim: [[0.95, 0.94, 0.9], [0.12, 0.12, 0.13], [0.85, 0.82, 0.74], [0.12, 0.26, 0.2]],   // white black cream dark green
  pub: [[0.1, 0.1, 0.11], [0.1, 0.22, 0.14], [0.35, 0.09, 0.09], [0.1, 0.14, 0.3]],   // dark painted shopfronts
  awning: [[0.6, 0.15, 0.12], [0.15, 0.3, 0.2], [0.12, 0.2, 0.4], [0.8, 0.7, 0.5], [0.15, 0.15, 0.17]],
};
export const BASE_COL = {
  stone: [0.82, 0.79, 0.72], roof: [0.28, 0.3, 0.33], roofFlat: [0.42, 0.42, 0.41], glass: [0.22, 0.28, 0.34], concrete: [0.7, 0.69, 0.66], metal: [0.25, 0.26, 0.27],
  windowBand: [0.6, 0.6, 0.6], curtainGlass: [0.35, 0.48, 0.58], metalPanel: [0.55, 0.57, 0.6], shopGlass: [0.2, 0.25, 0.3], awning: PAL.awning[0], retailGlass: [1, 1, 1], officeGlass: [1, 1, 1],
  wood: [0.42, 0.3, 0.2], foliage: [0.24, 0.44, 0.2],
  brick: PALS.red.c[0], brownstone: PALS.brown.c[0], plaster: PALS.stucco.c[0], door: PAL.door[0], trim: PAL.trim[0],
};

// per-style data. Lists are picked uniformly per seed (repeat an entry to weight it). Defaults: DEF. stoop = raised parlour floor (m) with steps; flat-fronted styles have no stoop and may get shopfronts.
// bays: n or [min, max] (by width); sym = centre door on odd bay counts; sill / maxW / wf = window sill height, max width, share of the bay; frame = window frame material.
const DEF = { floors: [3, 4], bays: 3, roof: ['parapet'], win: ['sash'], sur: ['lintel'], gf: ['res'], balc: ['none'], bayK: ['none'], stoop: 0, pal: ['red'], sh: 0.2, pl: 0.2, ac: 0.15, porch: 0, sill: 0.9, maxW: 1.1, wf: 0.62, frame: 'trim', bayW: 2.1 };
const STY = Object.fromEntries(Object.entries({
  georgian: { pal: ['red', 'red', 'stock', 'chicago', 'painted'], roof: ['parapet'], win: ['sash', 'sash', 'arched'], sur: ['lintel', 'keystone', 'none'], gf: ['res', 'res', 'shop'], balc: ['none', 'juliet'], sh: 0.3, pl: 0.25, porch: 0.25 },
  georgianWide: { pal: ['red', 'stock', 'chicago', 'painted'], floors: [3, 5], bays: 5, sym: 1, win: ['sash', 'sash', 'arched'], sur: ['lintel', 'pediment', 'keystone'], gf: ['res', 'res', 'shop'], balc: ['none', 'juliet', 'full'], porch: 0.4 },
  regency: { pal: ['stucco', 'pastel', 'stucco'], win: ['sash', 'arched'], sur: ['none', 'lintel', 'hood'], gf: ['res', 'shop'], balc: ['full', 'full', 'juliet'], sh: 0.35 },
  victorianBay: { pal: ['red', 'stock', 'chicago', 'painted'], bays: 2, stoop: 1.3, roof: ['bracket'], win: ['sash', 'arched', 'casement'], sur: ['hood', 'keystone', 'lintel'], gf: ['res', 'area'], balc: ['none', 'juliet'], bayK: ['bay'] },
  italianate: { pal: ['red', 'brown', 'stock', 'chicago'], floors: [3, 5], bays: 2, stoop: 1.2, roof: ['mansard', 'bracket'], win: ['sash', 'arched'], sur: ['hood', 'keystone', 'pediment'], gf: ['res', 'area'], bayK: ['bay', 'oriel', 'bay'] },
  brownstone: { pal: ['brown'], floors: [4, 6], stoop: 1.7, roof: ['bracket'], win: ['sash', 'arched'], sur: ['hood', 'hood', 'pediment', 'keystone'], gf: ['res', 'area'], balc: ['none', 'juliet'], sh: 0.1 },
  brownstoneMansard: { pal: ['brown'], floors: [3, 5], stoop: 1.6, roof: ['mansard'], win: ['sash', 'arched'], sur: ['hood', 'keystone'], gf: ['res', 'area'] },
  londonStucco: { pal: ['stucco', 'pastel', 'stucco', 'painted'], floors: [4, 5], bays: [2, 3], sym: 1, stoop: 1.0, roof: ['parapet'], win: ['sash', 'sash', 'casement'], sur: ['pediment', 'lintel', 'none', 'hood'], gf: ['area'], balc: ['full', 'juliet', 'full'], porch: 1, rust: 1, sh: 0.3 },
  mewsHouse: { pal: ['painted', 'pastel', 'red', 'stock'], floors: [2, 3], bays: [1, 2], roof: ['parapet', 'bracket'], win: ['sash', 'casement', 'arched'], sur: ['lintel', 'none'], gf: ['garage'], balc: ['none', 'juliet'], sh: 0.4, pl: 0.5, noShop: 1 },
  edwardianMansion: { pal: ['red', 'red', 'chicago'], floors: [5, 7], bays: [3, 5], stoop: 1.4, roof: ['mansard', 'bracket', 'parapet'], win: ['sash', 'arched', 'casement'], sur: ['keystone', 'hood', 'pediment'], gf: ['res', 'area'], balc: ['none', 'juliet', 'full'], bayK: ['oriel', 'bay', 'none'], bands: 1, turret: 0.5, dorm: 'gabled' },
  nycTenement: { pal: ['red', 'chicago', 'brown', 'stock'], floors: [5, 6], bays: [3, 4], roof: ['bracket'], win: ['sash', 'casement'], sur: ['lintel', 'hood', 'pediment', 'none'], gf: ['shop', 'shop', 'res'], balc: ['fire'], ac: 0.6, cornH: 0.9, cornD: 0.55, sh: 0 },
  prewarApartment: { pal: ['red', 'chicago', 'stock', 'painted'], floors: [7, 10], bays: [3, 6], sym: 1, bayW: 1.9, roof: ['parapet', 'bracket'], win: ['casement', 'sash', 'arched'], sur: ['lintel', 'keystone', 'none'], gf: ['res', 'shop'], balc: ['juliet', 'none', 'full'], tri: 1, tank: 0.7, ac: 0.5, sh: 0 },
  castIronLoft: { pal: ['painted', 'painted', 'stucco', 'pastel'], floors: [4, 6], bays: [3, 5], sym: 1, bayW: 2.6, roof: ['bracket', 'parapet'], win: ['multi', 'arched'], sur: ['none'], gf: ['shop', 'shop', 'res'], cast: 1, sill: 0.5, maxW: 2.1, wf: 0.8, ac: 0.1, sh: 0 },
  dutchGable: { pal: ['red', 'red', 'chicago', 'stock'], bays: [2, 3], roof: ['stepGable', 'curveGable'], win: ['sash', 'casement', 'arched'], sur: ['lintel', 'keystone', 'hood'], gf: ['res', 'shop'], balc: ['none', 'juliet'] },
  secondEmpire: { pal: ['red', 'stock', 'chicago', 'painted', 'stucco'], floors: [3, 5], bays: [2, 3], stoop: 1.5, roof: ['mansard'], win: ['sash', 'arched'], sur: ['hood', 'pediment', 'keystone'], gf: ['res', 'area'], bayK: ['bay', 'oriel', 'none'], dorm: 'ornate', crest: 1 },
  queenAnneCorner: { pal: ['red', 'chicago', 'stock', 'painted', 'pastel'], bays: [2, 3], stoop: 1.3, roof: ['bracket', 'parapet'], win: ['sash', 'casement', 'arched'], sur: ['lintel', 'hood', 'keystone', 'none'], gf: ['res', 'area'], balc: ['none', 'juliet', 'full'], turret: 1, sh: 0.3 },
  artDecoWalkup: { pal: ['chicago', 'stock', 'red', 'painted'], floors: [4, 6], bays: [3, 4], sym: 1, roof: ['deco'], win: ['casement'], sur: ['none', 'lintel'], gf: ['res', 'shop'], balc: ['none', 'juliet'], piers: 1, frame: 'metal', sh: 0, ac: 0.3 },
}).map(([k, v]) => [k, { ...DEF, ...v }]));

const stats = (prims) => { let H = 0, tris = 0; for (const p of prims) { tris += p.idx.length / 3; for (let i = 1; i < p.pos.length; i += 3) H = Math.max(H, p.pos[i]); } return { H, tris }; };

// far LOD: one box per tier [{ x0, x1, z0, z1, y0, y1, mat }] -> 4 band quads (uv in window cells) + roof quad
export function impostorFromTiers(tiers, col, cellW = 3, cellH = FH) {
  const g = new Mesh(col);
  for (const t of tiers) {
    const m = t.mat || 'windowBand';
    g.band(m, [t.x0, t.z1], [t.x1, t.z1], t.y0, t.y1, cellW, cellH); g.band(m, [t.x1, t.z1], [t.x1, t.z0], t.y0, t.y1, cellW, cellH);
    g.band(m, [t.x1, t.z0], [t.x0, t.z0], t.y0, t.y1, cellW, cellH); g.band(m, [t.x0, t.z0], [t.x0, t.z1], t.y0, t.y1, cellW, cellH);
    g.poly('roofFlat', [[t.x0, t.y1, t.z0], [t.x1, t.y1, t.z0], [t.x1, t.y1, t.z1], [t.x0, t.y1, t.z1]], [0, 1, 0]);
  }
  const prims = g.prims();
  return { prims, tiers, ...stats(prims) };
}
export const planImpostor = (spec) => { const r = planRow(spec); return impostorFromTiers(r.tiers, r.col); };

// the (style, palette) pick; attempt a > 0 re-rolls it (spec.avoid)
function choose(spec, a) {
  const r = (k) => hash((spec.seed ?? 1) >>> 0, k + 100 * a, 0, 4711), pick = (list, k) => list[Math.min(list.length - 1, Math.floor(r(k) * list.length))];
  let variant = spec.variant || pick(ROW_VARIANTS, 1);
  if (variant === 'georgianWide' && spec.hu < 3.8) variant = 'georgian';   // 5 bays need ~7.6 m of frontage
  const s = STY[variant], pal = pick(s.pal, 2), ci = Math.min(PALS[pal].c.length - 1, Math.floor(r(12) * PALS[pal].c.length));
  return { variant, s, pal, ci, key: `${variant}|${pal}${ci}` };
}
export const rowKey = (spec) => choose(spec, 0).key;

export function planRow(spec) {
  const { hu, hv, seed = 1, attached = false, corner = false } = spec, weight = spec.weight ?? 0.5, rng = (k) => hash(seed >>> 0, k, 0, 4711);
  const pick = (list, k) => list[Math.min(list.length - 1, Math.floor(rng(k) * list.length))];
  let ch; for (let a = 0; a < 8; a++) { ch = choose(spec, a); if (!(spec.avoid || []).includes(ch.key)) break; }
  const { variant, s, pal, ci } = ch, wall = PALS[pal].mat, cs = spec.cornerSide || 'both';
  const col = { ...BASE_COL, [wall]: PALS[pal].c[ci], door: pick(PAL.door, 3), trim: pick(PAL.trim, 4), awning: pick(PAL.awning, 24) };
  col.windowBand = col[wall];
  const g = new Mesh(col), collider = [], used = new Set();
  const finL = !attached || !(spec.leftH > 0) || (corner && cs !== 'right'), finR = !attached || !(spec.rightH > 0) || (corner && cs !== 'left');
  const X0 = attached && !finL ? -hu : -hu + 0.3, X1 = attached && !finR ? hu : hu - 0.3, W = X1 - X0, Z0 = -hv + 0.2;
  const n = s.floors[0] + Math.min(s.floors[1] - s.floors[0], Math.floor((rng(5) * 0.6 + weight * 0.6) * (s.floors[1] - s.floors[0] + 1)));
  const D0 = 2 * hv - 0.2, P = s.stoop ? Math.min(s.stoop, (D0 - 6.5) * 0.45) : 0.35;   // parlour floor level (shrunk stoop on shallow lots)
  const ns = s.stoop ? Math.max(2, Math.round(P / 0.18)) : 0, tread = 0.28, land = 0.9;
  const zf = hv - (s.stoop ? land + ns * tread + 0.05 : 0.6), H = P + n * FH;

  // ---- per-seed choices
  const turretOn = s.turret && rng(26) < s.turret && W > 4.2 && s.stoop > 0, turretSide = turretOn ? (corner && cs !== 'both' ? (cs === 'left' ? -1 : 1) : rng(27) < 0.5 ? -1 : 1) : 0;
  const tr = turretOn ? Math.min(1.25, W * 0.2) : 0;
  const F0 = turretSide < 0 ? X0 + 2 * tr + 0.15 : X0, F1 = turretSide > 0 ? X1 - 2 * tr - 0.15 : X1, FW = F1 - F0;   // facade range (beside the turret)
  let roof = pick(s.roof, 20); if (turretOn && roof === 'mansard') roof = 'bracket';
  const mans = roof === 'mansard' ? 2.6 : 0, parapet = roof === 'parapet' || roof === 'deco' ? 0.9 : 0, gable = roof.endsWith('Gable'), Ht = H + parapet, top = H + Math.max(parapet, mans);
  const nbT = Array.isArray(s.bays) ? Math.max(s.bays[0], Math.min(s.bays[1], Math.round(FW / s.bayW))) : s.bays;
  const dorms = mans ? 1 + Math.floor(rng(28) * 3) : 0, dormStep = dorms === 3 ? 1 : dorms === 2 ? 2 : 3;   // dormer count class: 1 = every 3rd bay, 2 = every 2nd, 3 = every bay
  let win = pick(s.win, 15), sr = pick(s.sur, 16), balc = pick(s.balc, 18), bayK = pick(s.bayK, 19);
  let gf = pick(s.gf, 17);
  if (!s.stoop && !s.noShop) { if (corner && rng(60) < 0.75) gf = rng(61) < 0.5 ? 'pub' : 'shop'; else if (gf === 'res' && rng(62) < 0.12) gf = rng(63) < 0.5 ? 'pub' : 'shop'; }
  if (s.stoop && gf !== 'res' && gf !== 'area') gf = 'res';
  if (gf === 'pub') col.door = pick(PAL.pub, 64);
  const shopF = gf === 'shop' || gf === 'pub', shopMat = gf === 'pub' ? 'officeGlass' : rng(9) < 0.6 ? 'retailGlass' : 'officeGlass';
  const heavy = n * nbT > 26, bA = bayK === 'oriel' ? 1 : 0, bB = bayK === 'oriel' ? bA + 1 : n - 2;
  if (bayK !== 'none' && (nbT < 2 || bB > n - 2 || bB < bA || turretOn)) bayK = 'none';
  if (bayK !== 'none' && balc === 'full') balc = 'juliet';
  const feat = { sh: !heavy && rng(21) < s.sh, plant: rng(22) < s.pl, ac: rng(23) < s.ac, porch: rng(25) < s.porch && !shopF && gf !== 'garage' };
  const fm = s.frame;

  // ---- shell: front / back walls (+ parapet), side walls where exposed, roof
  g.poly(wall, [[X0, 0, zf], [X1, 0, zf], [X1, Ht, zf], [X0, Ht, zf]], [0, 0, 1]);
  g.poly(wall, [[X0, 0, Z0], [X1, 0, Z0], [X1, Ht, Z0], [X0, Ht, Z0]], [0, 0, -1]);
  const T = 0.1, sideProfile = mans ? [[Z0, H], [Z0 + 0.9, H + mans], [zf - 0.9, H + mans], [zf, H]] : [[Z0, Ht], [zf, Ht]];
  const sides = [[X0, -1, finL, spec.leftH, spec.leftZ], [X1, 1, finR, spec.rightH, spec.rightZ]].map(([x, sg, fin, nb, nz]) => ({ x, sg, fin, nz: fin ? null : nz, raw: fin ? 0 : nb - 0.05 }));
  const endCaps = (k) => k;   // cornice / coping / string course end faces are always emitted (a neighbour's facade may be set back from them)
  const wallTop = (z) => { for (let i = 0; i + 1 < sideProfile.length; i++) { const [z0, y0] = sideProfile[i], [z1, y1] = sideProfile[i + 1]; if (z <= z1 + 1e-9) return y0 + (y1 - y0) * (z - z0) / (z1 - z0 || 1); } return sideProfile[sideProfile.length - 1][1]; };
  // side wall of the body for z in [a, b] between y0 and min(profile, cap); mansard walls stop at the slab underside (its trim end cap covers the rest)
  const wallPart = (x, sg, a, b, y0, cap) => {
    const dy = mans ? T : 0, zs = new Set([a, b]);
    for (const [z] of sideProfile) if (z > a && z < b) zs.add(z);
    for (let i = 0; i + 1 < sideProfile.length; i++) { const [z0, h0] = sideProfile[i], [z1, h1] = sideProfile[i + 1]; if ((h0 - dy - cap) * (h1 - dy - cap) < 0) { const z = z0 + (z1 - z0) * (cap + dy - h0) / (h1 - h0); if (z > a && z < b) zs.add(z); } }
    const zl = [...zs].sort((p, q) => p - q), tp = zl.map((z) => [x, Math.min(wallTop(z) - dy, cap), z]);
    g.poly(wall, [[x, y0, a], [x, y0, b], ...tp.reverse()], [sg, 0, 0]);
  };
  for (const { x, sg, fin, raw, nz } of sides) {
    const y0 = Math.min(raw, mans ? H - T : Ht);
    if (raw < top - 0.1) wallPart(x, sg, Z0, zf, y0, Infinity);   // fin: whole wall; else the part above the neighbour
    if (nz && !fin) {   // neighbour's facade is set further back / forward than ours: the stretch of side wall it does not cover
      const cap = Math.max(raw, 0);
      if (nz[1] < zf - 0.05) wallPart(x, sg, Math.max(nz[1], Z0), zf, 0, cap);
      if (nz[0] > Z0 + 0.05) wallPart(x, sg, Z0, Math.min(nz[0], zf), 0, cap);
    }
    if (raw < top - 0.1) {
      if (parapet) g.poly(wall, [[x, H, Z0], [x, H, zf], [x, Ht, zf], [x, Ht, Z0]], [-sg, 0, 0]);   // inner face of the side parapet
      if (corner && fin && attached) for (let r = 0; r < n; r++) for (const c of split(zf - Z0, [{ fix: 0.8 }, { rep: 2.6, tile: 1 }, { fix: 0.8 }])) if (c.part.tile) window_([x, P + r * FH + 1.6, Z0 + (c.u0 + c.u1) / 2], [sg, 0, 0], 1.0, 1.6, { sur: 'lintel', type: 'sash' });
    }
  }
  const cornH = s.cornH || 0.55, cornD = s.cornD || 0.5;
  if (parapet) {   // inner parapet faces + coping
    g.poly(wall, [[X0, H, zf], [X1, H, zf], [X1, Ht, zf], [X0, Ht, zf]], [0, 0, -1]); g.poly(wall, [[X0, H, Z0], [X1, H, Z0], [X1, Ht, Z0], [X0, Ht, Z0]], [0, 0, 1]);
    g.box('stone', X0, X1, Ht, Ht + 0.12, zf - 0.3, zf + 0.05, endCaps('b')); g.box('stone', X0, X1, H - 0.45, H - 0.15, zf, zf + 0.25, endCaps(''));   // coping + cornice band
  } else {   // bracketed cornice: deep trim box + repeated brackets
    g.box('trim', X0, X1, H - cornH, H, zf, zf + cornD, endCaps(''));
    for (const c of split(W, [{ rep: 0.9 }])) { const x = X0 + (c.u0 + c.u1) / 2; g.box('trim', x - 0.08, x + 0.08, H - cornH - 0.3, H - cornH, zf, zf + cornD - 0.1, 'zt'); }
  }
  if (mans) g.extrude(sideProfile, X0, X1, (a, z, y) => [a, y, z], [1, 0, 0], [0, 0, 1], { t: T });
  else g.poly('roofFlat', [[X0, H, Z0], [X1, H, Z0], [X1, H, zf], [X0, H, zf]], [0, 1, 0]);
  collider.push({ cx: (X0 + X1) / 2, cz: (Z0 + zf) / 2, hu: W / 2, hv: (zf - Z0) / 2, y0: 0, y1: top });

  // ---- openings
  function P3(c, nrm, u, v, d) { return [c[0] + nrm[2] * u + nrm[0] * d, c[1] + v, c[2] - nrm[0] * u + nrm[2] * d]; }   // point on a wall plane: u along the facade (left -> right seen from outside), v up
  function arch(mat, c, nrm, w, h, d) {   // flat-topped rectangle with a semicircular head
    const r = w / 2, vs = h / 2 - r, pts = [[-r, -h / 2], [r, -h / 2]];
    for (let k = 0; k <= 4; k++) { const a = k * Math.PI / 4; pts.push([r * Math.cos(a), vs + r * Math.sin(a)]); }
    g.poly(mat, pts.map(([u, v]) => P3(c, nrm, u, v, d)), nrm);
  }
  // window = frame + glass (+ glazing bars) + surround (header / pediment / hood / keystone) + sill, optional shutters (o.sh = width), plant box, AC unit
  function window_(c, nrm, w, h, o = {}) {
    const ty = o.type || win, su = o.sur || sr, arched = ty === 'arched' && h > w * 1.2, tx = nrm[2], tz = -nrm[0];
    if (arched) { arch(fm, c, nrm, w + 0.16, h + 0.16, 0.02); arch('glass', c, nrm, w, h, 0.04); if (su === 'keystone') g.rect('stone', [c[0], c[1] + h / 2 + 0.1, c[2]], nrm, 0.22, 0.3, 0.05); }
    else {
      g.rect(fm, c, nrm, w + 0.16, h + 0.16, 0.02); g.rect('glass', c, nrm, w, h, 0.04);
      if (ty === 'sash') g.rect(fm, c, nrm, w, 0.05, 0.05);   // meeting rail
      else if (ty === 'casement') g.rect(fm, c, nrm, 0.05, h, 0.05);
      else if (ty === 'multi') { for (const u of [-w / 6, w / 6]) g.rect(fm, [c[0] + tx * u, c[1], c[2] + tz * u], nrm, 0.05, h, 0.05); g.rect(fm, [c[0], c[1] + h * 0.25, c[2]], nrm, w, 0.05, 0.05); }
      if (su !== 'none') {
        const hood = su === 'hood';
        g.rect('stone', [c[0], c[1] + h / 2 + (hood ? 0.25 : 0.16), c[2]], nrm, w + (hood ? 0.45 : 0.3), hood ? 0.35 : 0.22, 0.05);
        if (su === 'pediment') g.poly('stone', [P3(c, nrm, -(w / 2 + 0.15), h / 2 + 0.27, 0.05), P3(c, nrm, w / 2 + 0.15, h / 2 + 0.27, 0.05), P3(c, nrm, 0, h / 2 + 0.6, 0.05)], nrm);
        else if (su === 'keystone') g.rect('trim', [c[0], c[1] + h / 2 + 0.16, c[2]], nrm, 0.2, 0.34, 0.07);
      }
    }
    g.rect('stone', [c[0], c[1] - h / 2 - 0.1, c[2]], nrm, w + 0.2, 0.1, 0.05);
    if (o.sh) for (const sx of [-1, 1]) g.rect('door', [c[0] + tx * sx * (w / 2 + 0.08 + o.sh / 2), c[1], c[2] + tz * sx * (w / 2 + 0.08 + o.sh / 2)], nrm, o.sh, h, 0.03);   // shutters (door paint)
    if (o.plant) { g.rect('wood', [c[0], c[1] - h / 2 - 0.1, c[2]], nrm, w, 0.2, 0.2); g.rect('foliage', [c[0], c[1] - h / 2 + 0.08, c[2]], nrm, w * 0.9, 0.22, 0.2); g.poly('foliage', [P3(c, nrm, -w / 2, -h / 2 + 0.0, 0.0), P3(c, nrm, w / 2, -h / 2 + 0.0, 0.0), P3(c, nrm, w / 2, -h / 2 + 0.0, 0.2), P3(c, nrm, -w / 2, -h / 2 + 0.0, 0.2)], [0, 1, 0]); }
    if (o.ac) g.box('metal', c[0] + tx * w * 0.15 - 0.28, c[0] + tx * w * 0.15 + 0.28, c[1] - h / 2 - 0.4, c[1] - h / 2 - 0.02, zf, zf + 0.28, 'bz');
  }
  const rail = (x0, x1, y, z, h, step = 0.26) => {   // railing facing +Z: pickets + top bar (inset 2 cm: pickets are 3 cm wide)
    x0 += 0.02; x1 = Math.max(x0 + 0.01, x1 - 0.02);
    const k = Math.max(1, Math.round((x1 - x0) / step));
    for (let i = 0; i <= k; i++) g.rect('metal', [x0 + (x1 - x0) * i / k, y + h / 2, z], [0, 0, 1], 0.03, h, 0);
    g.rect('metal', [(x0 + x1) / 2, y + h, z], [0, 0, 1], x1 - x0, 0.05, 0.01);
  };
  const hOf = (r) => s.cast ? 2.3 : r === 0 ? 2.0 : r === 1 && !s.stoop ? 2.1 : r === n - 1 ? 1.3 : 1.7;

  // front facade: margins + nb equal bays; door bay at ground, bay-window / oriel column, balconies
  const mg = s.cast ? 0 : 0.45, cells = split(FW, [{ rel: mg }, ...Array.from({ length: nbT }, () => ({ rel: 1, tile: 1 })), { rel: mg }]).filter((c) => c.part.tile);
  const nb = cells.length, cw = FW / (nb + (s.cast ? 0 : 0.9)), ww = Math.min(s.maxW, cw * s.wf), shW = cw / 2 - ww / 2 - 0.12 > 0.15 ? Math.min(0.4, cw / 2 - ww / 2 - 0.12) : 0;
  const cx = (i) => F0 + (cells[i].u0 + cells[i].u1) / 2;
  let doorBay = s.sym && nb % 2 === 1 ? (nb - 1) >> 1 : nb === 5 ? 2 : nb === 1 ? 0 : nb === 2 ? (rng(6) < 0.5 ? 0 : 1) : rng(6) < 0.5 ? 0 : nb - 1;
  if (turretOn) doorBay = turretSide < 0 ? nb - 1 : 0;
  else if (corner && cs !== 'both' && shopF && nb > 1) doorBay = cs === 'left' ? 0 : nb - 1;   // corner shop / pub: entrance at the corner
  const bayCol = bayK !== 'none' ? (doorBay === 0 ? nb - 1 : doorBay === nb - 1 ? 0 : -1) : -1, bayC = bayCol >= 0 ? bayCol : -1;
  if (bayC < 0) bayK = 'none';
  let nAc = 0, nPl = 0;
  cells.forEach((c, i) => {
    const x = cx(i);
    for (let r = 0; r < n; r++) {
      const y = P + r * FH;
      if (i === bayC && r >= bA && r <= bB) { if (r === bA) bayWindow(F0 + c.u0 + 0.05, F0 + c.u1 - 0.05, bA, bB); continue; }
      if (r === 0 && i === doorBay && !shopF) { if (gf === 'garage') garage(x, y); else door(x, y); continue; }
      if (r === 0 && shopF) continue;
      const h = hOf(r), ac = feat.ac && r >= 1 && nAc < (heavy ? 2 : 4) && rng(100 + r * 7 + i) < 0.35, plant = feat.plant && r <= 1 && nPl < 3 && rng(130 + r * 7 + i) < 0.5;
      if (ac) nAc++; if (plant) nPl++;
      window_([x, y + s.sill + h / 2, zf], [0, 0, 1], ww, h, { sh: feat.sh ? shW : 0, ac, plant, k: i });
      if (balc === 'juliet' && r >= 1 && (heavy ? r === 1 : r % 2 === 1) && !plant) rail(x - ww / 2 - 0.08, x + ww / 2 + 0.08, y + s.sill + 0.06, zf + 0.16, 0.7, 0.3);
    }
    if (s.stoop && P > 1.0 && i !== doorBay && !(i === bayC && bA === 0)) g.rect('glass', [x, P / 2, zf], [0, 0, 1], ww, Math.min(0.8, P - 0.4), 0.04);   // basement
  });
  if (shopF) shopfront();
  if (balc === 'full') { const y = P + FH; g.box('metal', X0 + 0.2, X1 - 0.2, y - 0.1, y, zf, zf + 0.5, 'z'); rail(X0 + 0.2, X1 - 0.2, y, zf + 0.48, 0.9, 0.3); }
  if (balc === 'fire') fireEscape();
  if (wall === 'plaster' && !s.cast) g.box('stone', X0, X1, P + FH - 0.25, P + FH - 0.05, zf, zf + 0.12, endCaps(''));   // stucco string course
  if (s.bands) for (let r = 2; r < n; r++) g.rect('stone', [(X0 + X1) / 2, P + r * FH - 0.05, zf], [0, 0, 1], W, 0.18, 0.015);   // stone bands
  if (s.rust) for (let k = 1; k * 0.5 < P + 0.01; k++) g.rect('concrete', [(X0 + X1) / 2, k * 0.5, zf], [0, 0, 1], W, 0.04, 0.012);   // rusticated base: joint lines
  if (s.tri) {   // tripartite: stone base (2 floors) and stone top (2 floors) over a brick middle
    g.rect('stone', [(X0 + X1) / 2, (P + 2 * FH) / 2, zf], [0, 0, 1], W, P + 2 * FH, 0.012);
    g.rect('stone', [(X0 + X1) / 2, P + (n - 2) * FH + FH, zf], [0, 0, 1], W, 2 * FH, 0.012);
    g.rect('stone', [(X0 + X1) / 2, P + 2 * FH, zf], [0, 0, 1], W, 0.3, 0.06); g.rect('stone', [(X0 + X1) / 2, P + (n - 2) * FH, zf], [0, 0, 1], W, 0.3, 0.06);
  }
  if (s.cast) {   // cast-iron frame: columns on every bay line, spandrel band per floor
    for (let k = 0; k <= nb; k++) { const xk = k < nb ? F0 + cells[k].u0 : F0 + cells[nb - 1].u1; g.box('trim', Math.max(X0, xk - 0.14), Math.min(X1, xk + 0.14), 0, H, zf, zf + 0.14, 'bz'); }
    for (let r = 1; r <= n; r++) g.rect('trim', [(X0 + X1) / 2, P + r * FH - 0.2, zf], [0, 0, 1], W, 0.36, 0.1);
  }
  if (s.piers) {   // deco piers with spandrel panels
    for (let k = 0; k <= nb; k++) { const xk = k === 0 ? F0 + cells[0].u0 : k === nb ? F0 + cells[nb - 1].u1 : F0 + cells[k].u0; g.box('stone', Math.max(X0, xk - 0.17), Math.min(X1, xk + 0.17), P, Ht + 0.45, zf - 0.2, zf + 0.12, 'bz'); }
    for (let r = 1; r < n; r++) for (let i = 0; i < nb; i++) if (i !== bayC) g.rect('stone', [cx(i), P + r * FH + 0.4, zf], [0, 0, 1], cw * 0.7, 0.45, 0.02);
  }
  // back: plain sash windows
  for (let r = 0; r < n; r++) for (const c of split(W, [{ fix: 0.5 }, { rep: 2.4, tile: 1 }, { fix: 0.5 }])) if (c.part.tile) g.rect('glass', [X0 + (c.u0 + c.u1) / 2, P + r * FH + 1.6, Z0], [0, 0, -1], 1.0, 1.5, 0.03);

  function door(x, y) {
    if (s.stoop) x = Math.max(X0 + 1.0, Math.min(X1 - 1.0, x));   // keep the steps' cheek walls (0.97 m) inside the lot on narrow facades
    g.rect('stone', [x, y + 1.45, zf], [0, 0, 1], 1.55, 2.9, 0.02); g.rect('door', [x, y + 1.1, zf], [0, 0, 1], 1.0, 2.2, 0.04);
    g.rect('glass', [x, y + 2.47, zf], [0, 0, 1], 0.9, 0.4, 0.04);   // fanlight / transom
    if (feat.porch) {   // columned portico
      const dz = s.stoop ? 0.55 : 0.4;
      for (const sx of [-1, 1]) g.box('stone', x + sx * 0.85 - 0.1, x + sx * 0.85 + 0.1, y, y + 2.7, zf + dz - 0.1, zf + dz + 0.1, 'bt');
      g.box('stone', x - 1.05, x + 1.05, y + 2.7, y + 2.95, zf, zf + dz + 0.15, 'b');
    }
    if (!s.stoop) { g.box('stone', x - 0.8, x + 0.8, 0, y, zf, zf + 0.5, 'bz'); collider.push({ cx: x, cz: zf + 0.25, hu: 0.8, hv: 0.25, y0: 0, y1: y }); return; }
    const hw = 0.85, z1 = zf + land + ns * tread;
    g.box('stone', x - hw, x + hw, 0, P, zf, zf + land, 'bz');
    for (let k = 1; k <= ns; k++) g.box('stone', x - hw, x + hw, 0, P - k * (P / (ns + 1)), zf + land + (k - 1) * tread, zf + land + k * tread, 'bz');
    for (const sx of [-1, 1]) {   // cheek walls / railings: sloped slab beside the steps
      const xa = x + sx * hw, xb = xa + sx * 0.12, a = [zf + land, P + 0.9], b = [z1, 0.9];
      for (const [xx, hx] of [[xb, sx], [xa, -sx]]) g.poly('metal', [[xx, 0, zf], [xx, 0, z1], [xx, b[1], b[0]], [xx, a[1], a[0]], [xx, a[1], zf]], [hx, 0, 0]);
      g.poly('metal', [[xa, a[1], zf], [xb, a[1], zf], [xb, a[1], a[0]], [xa, a[1], a[0]]], [0, 1, 0]);
      g.poly('metal', [[xa, a[1], a[0]], [xb, a[1], a[0]], [xb, b[1], b[0]], [xa, b[1], b[0]]], [0, 1, 1]);
      g.poly('metal', [[xa, 0, z1], [xb, 0, z1], [xb, b[1], z1], [xa, b[1], z1]], [0, 0, 1]);
    }
    if (gf === 'area') { const zr = hv - 0.03; rail(X0, Math.max(X0 + 0.01, x - hw - 0.2), 0, zr, 0.9); rail(Math.min(X1 - 0.01, x + hw + 0.2), X1, 0, zr, 0.9); }   // front-yard railings either side of the steps
    collider.push({ cx: x, cz: (zf + z1) / 2, hu: hw + 0.12, hv: (z1 - zf) / 2, y0: 0, y1: P });
  }
  function garage(x, y) {   // mews: big painted carriage / garage door with plank lines + a small window above
    const w = Math.min(2.6, cw * 0.9);
    g.rect('stone', [x, y + 1.3, zf], [0, 0, 1], w + 0.3, 2.6, 0.02); g.rect('door', [x, y + 1.2, zf], [0, 0, 1], w, 2.4, 0.04);
    for (const u of [-w / 4, 0, w / 4]) g.rect('trim', [x + u, y + 1.2, zf], [0, 0, 1], 0.04, 2.4, 0.055);
    g.rect('trim', [x, y + 1.9, zf], [0, 0, 1], w, 0.05, 0.055);
  }
  // shopfront / pub front across the whole ground floor: dark painted pilasters + stall riser + sign band, glass panels (whole-cell uv), entrance at doorBay, awning
  function shopfront() {
    const xs = [X0, ...cells.slice(1).map((c, i) => (F0 + cells[i].u1 + F0 + c.u0) / 2), X1], pub = gf === 'pub', zc = zf + 0.03;
    g.rect('door', [(X0 + X1) / 2, 0.45, zf], [0, 0, 1], W, 0.9, 0.04);   // stall riser
    g.rect('door', [(X0 + X1) / 2, 2.95, zf], [0, 0, 1], W, pub ? 0.7 : 0.5, 0.09); g.rect('trim', [(X0 + X1) / 2, 2.95, zf], [0, 0, 1], W * 0.5, 0.26, 0.1);   // sign band + lettering
    for (const x of xs) g.rect('door', [Math.min(X1 - 0.13, Math.max(X0 + 0.13, x)), 1.5, zf], [0, 0, 1], 0.26, 3.0, 0.06);
    for (let i = 0; i < nb; i++) {
      const xa = xs[i] + 0.13, xb = xs[i + 1] - 0.13, xc = (xa + xb) / 2, w = xb - xa;
      if (i === doorBay) { g.rect('door', [xc, 1.15, zf], [0, 0, 1], Math.min(1.1, w), 2.3, 0.07); g.rect('glass', [xc, 1.65, zf], [0, 0, 1], Math.min(0.7, w - 0.3), 1.2, 0.08); continue; }
      const o = Math.floor(rng(20 + i) * 4), r0 = Math.floor(rng(40 + i) * 4);
      g.rectUV(shopMat, [xc, 1.75, zf], [0, 0, 1], w, 1.5, 0.04, [o, r0, o + Math.max(1, Math.round(w / 1.5)), r0 + 1]); used.add(shopMat);
      if (pub && w > 1.6) for (const u of [-w / 6, w / 6]) g.rect('door', [xc + u, 1.75, zf], [0, 0, 1], 0.05, 1.5, 0.06);
    }
    if (rng(24) < (pub ? 0.4 : 0.7)) {   // awning
      const xa = X0 + 0.2, xb = X1 - 0.2;
      g.poly('awning', [[xa, 2.62, zc + 0.03], [xb, 2.62, zc + 0.03], [xb, 2.2, zf + 0.52], [xa, 2.2, zf + 0.52]], [0, 0.7, 0.7]);
      g.poly('awning', [[xa, 2.2, zf + 0.52], [xb, 2.2, zf + 0.52], [xb, 2.05, zf + 0.52], [xa, 2.05, zf + 0.52]], [0, 0, 1]);
      for (const [x, h] of [[xa, -1], [xb, 1]]) g.poly('awning', [[x, 2.62, zc + 0.03], [x, 2.2, zf + 0.52], [x, 2.2, zc + 0.03]], [h, 0, 0]);
    }
  }
  // NYC fire escape: platforms + railings + ladders across two middle bays (depth 0.55, inside the 0.6 m frontage strip)
  function fireEscape() {
    const k = nb >= 3 ? 1 : 0, xa = (nb >= 3 ? cx(k) : cx(0)) - 0.6, xb = (nb >= 3 ? cx(k + 1) : cx(0)) + 0.6;
    for (let r = 1; r < n; r++) {
      const y = P + r * FH + 0.3;
      g.box('metal', xa, xb, y - 0.07, y, zf, zf + 0.55, 'z');
      g.rect('metal', [(xa + xb) / 2, y + 0.9, zf + 0.55], [0, 0, 1], xb - xa, 0.05, 0); g.rect('metal', [(xa + xb) / 2, y + 0.45, zf + 0.55], [0, 0, 1], xb - xa, 0.05, 0);
      for (const x of [xa + 0.35, xa + 0.65]) g.rect('metal', [x, y - FH / 2, zf + 0.55], [0, 0, 1], 0.04, FH - 0.2, 0);   // ladder rails down to the platform below
    }
  }
  // canted bay-window column on the front wall, x0..x1, floors rA..rB (rA = 0: from the ground, else an oriel on a corbel)
  function bayWindow(x0, x1, rA, rB) {
    const d = 0.7, c = Math.min(0.5, (x1 - x0) * 0.25), yb = rA === 0 ? 0 : P + rA * FH + 0.6, yt = P + rB * FH + 3.4, z = zf + d;
    const faces = [[[x0, zf], [x0 + c, z]], [[x0 + c, z], [x1 - c, z]], [[x1 - c, z], [x1, zf]]];
    for (const [[ax, az], [bx, bz]] of faces) {
      const nx = bz - az, nz = -(bx - ax), l = Math.hypot(nx, nz), nrm = [-nx / l, 0, -nz / l];   // outward = away from the wall
      g.poly(wall, [[ax, yb, az], [bx, yb, bz], [bx, yt, bz], [ax, yt, az]], nrm);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, fw = Math.hypot(bx - ax, bz - az);
      for (let r = rA; r <= rB; r++) { const h = Math.min(2.0, hOf(r)); window_([mx, P + r * FH + s.sill + h / 2, mz], nrm, fw * 0.6, h, { sur: 'lintel' }); }
    }
    g.poly('trim', [[x0, yt, zf], [x1, yt, zf], [x1 - c, yt, z], [x0 + c, yt, z]], [0, 1, 0]);
    if (rA > 0) g.poly('trim', [[x0, yb, zf], [x1, yb, zf], [x1 - c, yb, z], [x0 + c, yb, z]], [0, -1, 0]);   // corbel underside
    collider.push({ cx: (x0 + x1) / 2, cz: zf + d / 2, hu: (x1 - x0) / 2, hv: d / 2, y0: yb, y1: yt });
  }
  // half-hexagon corner turret (3 canted faces on the front wall) with a conical roof, windows every floor
  if (turretOn) {
    const r = tr, tcx = turretSide < 0 ? X0 + r : X1 - r, yt = Ht + 0.3, vs = [0, 1, 2, 3].map((k) => [tcx - r * Math.cos(k * Math.PI / 3), zf + r * Math.sin(k * Math.PI / 3)]), apex = [tcx, yt + 2.5, zf];
    for (let k = 0; k < 3; k++) {
      const [ax, az] = vs[k], [bx, bz] = vs[k + 1], a = Math.PI - (k + 0.5) * Math.PI / 3, nrm = [Math.cos(a), 0, Math.sin(a)];
      g.poly(wall, [[ax, 0, az], [bx, 0, bz], [bx, yt, bz], [ax, yt, az]], nrm);
      for (let rr = 0; rr < n; rr++) { const h = Math.min(1.7, hOf(rr)); window_([(ax + bx) / 2, P + rr * FH + s.sill + h / 2, (az + bz) / 2], nrm, r * 0.55, h, { sur: 'lintel' }); }
      g.poly('roof', [[ax, yt, az], [bx, yt, bz], apex], [nrm[0] * 0.5, 0.7, nrm[2] * 0.5]);
    }
    g.poly('roof', [[vs[0][0], yt, zf], [vs[3][0], yt, zf], apex], [0, 0, -1]);
    g.poly('trim', vs.map(([x, z]) => [x, yt, z]), [0, -1, 0]);
    collider.push({ cx: tcx, cz: zf + r / 2, hu: r, hv: r / 2, y0: 0, y1: yt });
  }
  // mansard dormers (flat / gabled / ornate: gabled + frame + arched window) on every dormStep-th bay; iron cresting along the mansard ridge
  if (mans) {
    cells.forEach((c, i) => {
      if (i % dormStep) return;
      const x = cx(i), y0 = H + 0.5, y1 = H + 1.9, z1 = zf - 0.3, zb = zf - 1.0, kind = s.dorm || 'flat', ornate = kind === 'ornate';
      if (kind === 'flat') g.box('trim', x - 0.55, x + 0.55, y0, y1, zb, z1, 'bz');
      else {
        g.box('trim', x - 0.55, x + 0.55, y0, y1, zb, z1, 'bzt');
        g.poly('trim', [[x - 0.55, y1, z1], [x + 0.55, y1, z1], [x, y1 + 0.45, z1]], [0, 0, 1]);
        g.poly('roof', [[x - 0.62, y1, zb], [x - 0.62, y1, z1 + 0.06], [x, y1 + 0.5, z1 + 0.06], [x, y1 + 0.5, zb]], [-0.6, 1, 0]); g.poly('roof', [[x + 0.62, y1, zb], [x + 0.62, y1, z1 + 0.06], [x, y1 + 0.5, z1 + 0.06], [x, y1 + 0.5, zb]], [0.6, 1, 0]);
      }
      if (ornate) { arch('stone', [x, (y0 + y1) / 2, z1], [0, 0, 1], 0.9, 1.3, 0.02); arch('glass', [x, (y0 + y1) / 2, z1], [0, 0, 1], 0.7, 1.1, 0.04); g.poly('stone', [[x - 0.6, y1 + 0.02, z1 + 0.03], [x + 0.6, y1 + 0.02, z1 + 0.03], [x, y1 + 0.5, z1 + 0.03]], [0, 0, 1]); }
      else g.rect('glass', [x, (y0 + y1) / 2, z1], [0, 0, 1], 0.7, 1.0, 0.03);
    });
    if (s.crest) { for (const c of split(W, [{ rep: 0.4 }])) g.rect('metal', [X0 + (c.u0 + c.u1) / 2, H + mans + 0.2, zf - 0.9], [0, 0, 1], 0.04, 0.4, 0); g.rect('metal', [(X0 + X1) / 2, H + mans + 0.42, zf - 0.9], [0, 0, 1], W, 0.05, 0); }
  }
  // dutch gable: stepped or bell-shaped shield wall above the front, 0.4 m thick (the roof behind stays flat)
  if (gable) {
    const z0 = zf - 0.4;
    if (roof === 'stepGable') {
      const k = 4, dx = W * 0.1, sh = 0.55;
      for (let i = 0; i < k; i++) g.box(wall, X0 + dx * i, X1 - dx * i, H + i * sh, H + (i + 1) * sh, z0, zf, 'b');
      g.box('stone', (X0 + X1) / 2 - 0.2, (X0 + X1) / 2 + 0.2, H + k * sh, H + k * sh + 0.5, z0, zf, 'b');
    } else {
      const N = 10, hc = (t) => 0.45 + 2.6 * Math.pow(1 - t * t, 1.5), xm = (X0 + X1) / 2;
      for (let i = 0; i < N; i++) {
        const ta = -1 + 2 * i / N, tb = -1 + 2 * (i + 1) / N, xa = xm + ta * W / 2, xb = xm + tb * W / 2, ha = H + hc(ta), hb = H + hc(tb);
        g.poly(wall, [[xa, H, zf], [xb, H, zf], [xb, hb, zf], [xa, ha, zf]], [0, 0, 1]); g.poly(wall, [[xa, H, z0], [xb, H, z0], [xb, hb, z0], [xa, ha, z0]], [0, 0, -1]);
        g.poly('stone', [[xa, ha, z0], [xb, hb, z0], [xb, hb, zf], [xa, ha, zf]], [0, 1, 0]);
      }
      for (const [x, sg] of [[X0, -1], [X1, 1]]) g.poly(wall, [[x, H, z0], [x, H, zf], [x, H + hc(sg), zf], [x, H + hc(sg), z0]], [sg, 0, 0]);
    }
  }
  if (roof === 'deco') {   // stepped parapet: stone piers on the bay lines + a taller centre block
    const xm = (X0 + X1) / 2;
    for (const [a, b, h] of [[xm - W * 0.22, xm + W * 0.22, 0.8], [xm - W * 0.1, xm + W * 0.1, 1.5]]) g.box('stone', a, b, Ht, Ht + h, zf - 0.3, zf + 0.05, 'b');
  }
  if (s.tank && n >= 6 && rng(29) < s.tank) {   // rooftop wooden water tank on steel legs
    const tx = (X0 + X1) / 2 + (rng(30) < 0.5 ? -1 : 1) * W * 0.2, tz = Z0 + 2.2, tr2 = 0.95, y0 = Ht + 0.0, y1 = y0 + 1.0, y2 = y1 + 1.7, N = 8;
    for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) g.box('metal', tx + lx - 0.05, tx + lx + 0.05, y0, y1, tz + lz - 0.05, tz + lz + 0.05, 'bt');
    const ring = Array.from({ length: N }, (_, k) => [tx + tr2 * Math.cos(2 * Math.PI * k / N), tz + tr2 * Math.sin(2 * Math.PI * k / N)]);
    ring.forEach(([ax, az], k) => { const [bx, bz] = ring[(k + 1) % N], a = 2 * Math.PI * (k + 0.5) / N; g.poly('wood', [[ax, y1, az], [bx, y1, bz], [bx, y2, bz], [ax, y2, az]], [Math.cos(a), 0, Math.sin(a)]); g.poly('roof', [[ax, y2, az], [bx, y2, bz], [tx, y2 + 0.8, tz]], [0, 1, 0]); });
    g.poly('wood', ring.map(([x, z]) => [x, y1, z]), [0, -1, 0]);
  }
  // chimney stacks on the party walls (shared look along a terrace)
  if (!mans && n <= 6 && !gable) for (const x of [X0 + 0.45, X1 - 0.45]) if (rng(x > 0 ? 7 : 8) < 0.7) g.box(wall, x - 0.35, x + 0.35, H, Ht + 1.1, -0.6, 0.4);

  const prims = g.prims(), st = stats(prims);
  const tex = {}; for (const m of used) tex[m] = textureKeyFor(m, seed);
  const meta = { variant, palette: pal + ci, win: win + (bayK !== 'none' ? '+' + bayK : '') + (turretOn ? '+turret' : ''), roof: roof + (mans ? dorms : ''), gf, sur: sr, balc };
  return { prims, Z0, zf, top, wallTop: mans ? H : Ht, W: 2 * hu, D: 2 * hv, H: st.H, tris: st.tris, variant, collider, col, tex, meta, tiers: [{ x0: X0, x1: X1, z0: Z0, z1: zf, y0: 0, y1: top }] };
}
