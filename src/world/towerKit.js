// Procedural downtown buildings (mid-rise -> skyscraper) as raw triangle primitives (pure: no THREE, runs in Node; same output contract as houseKit.planHouse / rowKit.planRow).
//
//   planTower(spec) -> { prims, W, D, H, tris, variant, floors, collider: [{ cx, cz, hu, hv, y0, y1 }], tiers, col }   pivot = footprint centre at ground, +Z = street,
//        everything inside x in [-hu, hu], z in [-hv, hv], y >= 0. Detached: all four sides finished.
//   spec = { hu, hv, seed, weight?: 0..1, variant?: name }   weight (city paint) -> floor count via TOWER_CONFIG.floorCurve (+- jitter), variant must suit the floor count.
//   planImpostor(spec) -> { prims, tris (<= 30), H, tiers }   far LOD: the same silhouette tiers (max 3) as band boxes, same material keys.
//   TOWER_VARIANTS, TOWER_CONFIG, towerBudget(floors), TOWER_MATS (extra material keys), TOWER_SHAPES / TOWER_CROWNS (values of .shape / .crown).
//   planTower also returns shape, crown and tex = { matKey: windowAtlas texture key "style:variant" } for every band material it emits (renderer: one material per key).
//
// FACADES are windows-in-texture: each tier side is ONE quad (Mesh.band) whose uv runs in window cells (u = bays of TOWER_CONFIG.bayW, v = storeys of floorH), material
// 'windowBand' (punched windows in a wall, tinted per building: brick / stone / concrete) or 'curtainGlass'. Only the street front of low classic buildings
// (floors <= geomWindowsMaxFloors) gets real window quads. Ground floor = shopfront band (shopGlass quads + fascia) with an entrance canopy on the street side.
// STYLES (STY: floor range + rule): classic / classicStone (cornice, parapet, water tower), concreteGrid (vertical fins), glassBox, podiumTower (stone podium + glass shaft),
// artDeco (3-4 setback tiers + stepped crown + spire), chamfered (octagonal glass tower with a setback). Rooftops: HVAC boxes, parapets, antenna on the tallest (>= antennaFloors).
// DETAIL: double-height darker base (lobby canopy on non-brick), string course over it, floor-line ledges / spandrel frames (ledges(): capped by ledgeTris), fins / piers,
// classic corner piers, lighter 2-storey crown band on tall tiers, roofKit (penthouse, cooling tower, mech screen, BMU rails, HVAC), topper variety, crownLit (>= litCrownFloors).
// Band textures: windowAtlas.js STYLE_BY_MAT (windowBand punched, windowGrid concrete grid, windowDeco piers, curtainGlass, metalPanel).
import { hash } from './scatterGen.js';
import { Mesh, split, interp } from './shapeGrammar.js';
import { BASE_COL, impostorFromTiers } from './rowKit.js';
import { textureKeyFor } from './windowAtlas.js';

export const TOWER_CONFIG = {
  floorCurve: [[0, 3], [0.5, 6.5], [0.65, 10], [0.8, 22], [0.9, 36], [1, 55]],   // weight -> mean floor count (piecewise linear)
  jitter: 0.2,                 // +- share of the mean
  groundH: 6, floorH: 3.6, bayW: 3,   // groundH: double-height lobby / shopfront
  geomWindowsMaxFloors: 8,     // real window quads on the street front up to this many floors
  litCrownFloors: 30,          // towers this tall get a 'crownLit' crown (emissive at night)
  ledgeTris: 1200,             // max tris spent on floor-line ledges / spandrel frames per tier run
  antennaFloors: 40,
  budget: { mid: 1500, sky: 3000, skyFloors: 12 },
};
export const towerBudget = (floors) => (floors > TOWER_CONFIG.budget.skyFloors ? TOWER_CONFIG.budget.sky : TOWER_CONFIG.budget.mid);
const STY = {
  classic: { range: [3, 14] }, classicStone: { range: [3, 12] }, concreteGrid: { range: [4, 30] }, glassBox: { range: [6, 45] },
  chamfered: { range: [10, 70] }, podiumTower: { range: [15, 70] }, artDeco: { range: [12, 70] },
  slab: { range: [8, 40] }, twinTower: { range: [20, 70] }, taperTower: { range: [12, 70] },
};
export const TOWER_SHAPES = ['rect', 'rounded', 'L', 'slab', 'twin', 'taper', 'octagon', 'setback'];
export const TOWER_CROWNS = ['flat', 'pyramid', 'stepped', 'helipad', 'logo', 'spire', 'cornice'];
export const TOWER_VARIANTS = Object.keys(STY);
// material keys towerKit adds on top of rowKit.CITY_MATS: windowGrid / windowDeco = windowBand with another window texture (windowAtlas STYLE_BY_MAT), crownLit = emissive crown
export const TOWER_MATS = ['windowGrid', 'windowDeco', 'crownLit', 'wood', 'lobbyGlass', 'retailGlass', 'officeGlass'];   // *Glass: ground-floor glass (windowAtlas lobby / retail / office / dark)
export const TOWER_BASES = ['lobby', 'retail', 'stone', 'bank'];   // wood: water tower (pre-existing, was missing from CITY_MATS)
const PAL = {   // brick red / brown / yellow / dark; stone cream / grey / red sandstone / limestone; glass blue / teal / green / bronze / grey / black / silver
  brick: [[0.62, 0.3, 0.24], [0.55, 0.32, 0.27], [0.72, 0.5, 0.36], [0.78, 0.66, 0.42], [0.42, 0.24, 0.2], [0.66, 0.4, 0.3]],
  stone: [[0.82, 0.79, 0.72], [0.74, 0.72, 0.68], [0.88, 0.84, 0.74], [0.7, 0.45, 0.38], [0.62, 0.62, 0.62], [0.86, 0.76, 0.6]],
  concrete: [[0.7, 0.69, 0.66], [0.6, 0.6, 0.58], [0.78, 0.76, 0.72], [0.66, 0.62, 0.55], [0.5, 0.52, 0.54]],
  curtainGlass: [[0.35, 0.48, 0.58], [0.3, 0.45, 0.42], [0.45, 0.38, 0.3], [0.25, 0.3, 0.38], [0.55, 0.62, 0.68], [0.3, 0.42, 0.32], [0.16, 0.18, 0.22], [0.4, 0.42, 0.45], [0.2, 0.36, 0.5]],
  metalPanel: [[0.62, 0.64, 0.66], [0.3, 0.3, 0.32], [0.55, 0.45, 0.32], [0.78, 0.78, 0.76]],
  awning: [[0.6, 0.15, 0.12], [0.15, 0.3, 0.2], [0.15, 0.2, 0.4]],
};
const rectRing = (x0, x1, z0, z1, c = 0) => (c <= 0 ? [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]
  : [[x0 + c, z1], [x1 - c, z1], [x1, z1 - c], [x1, z0 + c], [x1 - c, z0], [x0 + c, z0], [x0, z0 + c], [x0, z1 - c]]);   // a->b left to right from outside

export function planTower(spec) {
  const { hu, hv, seed = 1 } = spec, weight = spec.weight ?? 0.75, C = TOWER_CONFIG, rng = (k) => hash(seed >>> 0, k, 0, 7177);
  const pick = (list, k) => list[Math.min(list.length - 1, Math.floor(rng(k) * list.length))];
  const fl = Math.max(3, Math.round(interp(C.floorCurve, Math.min(1, Math.max(0, weight))) * (1 + (rng(1) - 0.5) * 2 * C.jitter)));
  const variant = spec.variant || pick(TOWER_VARIANTS.filter((v) => fl >= STY[v].range[0] && fl <= STY[v].range[1]), 2);
  const GF = C.groundH, FH = C.floorH, cw = C.bayW, H = GF + fl * FH, yF = (f) => GF + f * FH;
  const col = { ...BASE_COL, brick: pick(PAL.brick, 3), stone: pick(PAL.stone, 3), concrete: pick(PAL.concrete, 3), curtainGlass: pick(PAL.curtainGlass, 4), awning: pick(PAL.awning, 5), metalPanel: pick(PAL.metalPanel, 6), wood: [0.42, 0.3, 0.2] };
  const wallMat = { classic: 'brick', concreteGrid: 'concrete' }[variant] || 'stone';
  col.windowBand = col[wallMat]; col.windowGrid = col.concrete; col.windowDeco = col.stone; col.crownLit = [0.98, 0.92, 0.72]; col.lobbyGlass = col.retailGlass = col.officeGlass = [1, 1, 1];
  const g = new Mesh(col), collider = [], tiers = [];
  g.uvOff = [Math.floor(rng(7) * 4), Math.floor(rng(8) * 4)];   // per-building texture phase (whole cells of the 4x4 window texture)
  const baseK = 0.62 + rng(9) * 0.3, crownK = rng(10) < 0.5 ? 1.08 + rng(11) * 0.22 : 0.72 + rng(11) * 0.18;   // per-seed tri-partite tints
  let shape = 'rect', crownType = 'flat';
  const baseType = pick(variant === 'classic' ? ['retail', 'retail', 'stone'] : variant === 'concreteGrid' ? ['retail', 'lobby', 'stone']
    : ['classicStone', 'podiumTower', 'artDeco', 'twinTower'].includes(variant) ? ['stone', 'bank', 'retail', 'lobby'] : ['lobby', 'lobby', 'retail', 'bank'], 12);
  const X0 = -hu + 0.5, X1 = hu - 0.5, Z0 = -hv + 0.5, Z1 = hv - 0.5, W = X1 - X0, D = Z1 - Z0;
  const edges = (ring, f) => ring.forEach((a, i) => f(a, ring[(i + 1) % ring.length], i));
  const nrm = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [-dz / l, 0, dx / l]; };
  const roof = (ring, y, mat = 'roofFlat') => g.poly(mat, ring.map(([x, z]) => [x, y, z]), [0, 1, 0]);
  const tint = (mat, k, fn) => { const c0 = col[mat]; col[mat] = c0.map((v) => Math.min(1, v * k)); fn(); col[mat] = c0; };   // tri-partite base / shaft / crown tints
  // horizontal ledge (string course / spandrel frame) around a convex ring: outer face + top + soffit, d proud, 6 tris per edge
  function ledge(ring, y, h = 0.3, d = 0.25, mat = 'stone') {
    const n = ring.length, N = ring.map((a, i) => nrm(a, ring[(i + 1) % n])), o = ring.map((v, i) => {
      const n1 = N[(i + n - 1) % n], n2 = N[i], k = d / (1 + n1[0] * n2[0] + n1[2] * n2[2]);
      return [v[0] + (n1[0] + n2[0]) * k, v[1] + (n1[2] + n2[2]) * k];
    });
    edges(ring, (a, b, i) => {
      const a2 = o[i], b2 = o[(i + 1) % n];
      g.poly(mat, [[a2[0], y, a2[1]], [b2[0], y, b2[1]], [b2[0], y + h, b2[1]], [a2[0], y + h, a2[1]]], N[i]);
      g.poly(mat, [[a[0], y + h, a[1]], [b[0], y + h, b[1]], [b2[0], y + h, b2[1]], [a2[0], y + h, a2[1]]], [0, 1, 0]);
      g.poly(mat, [[a[0], y, a[1]], [b[0], y, b[1]], [b2[0], y, b2[1]], [a2[0], y, a2[1]]], [0, -1, 0]);
    });
  }
  // ledges at floor lines f0 < f < f1 (every >= opt.every floors), spaced so the run stays within ledgeTris
  const ledges = (ring, f0, f1, opt = {}) => {
    const k = Math.max(opt.every || 1, Math.ceil(((f1 - f0) * ring.length * 6) / (opt.budget || C.ledgeTris)));
    for (let f = f0 + k; f < f1; f += k) ledge(ring, yF(f) - 0.15, opt.h, opt.d, opt.mat);
  };

  // tier = facade band ring from y0 to y1 (+ roof); geomFront = solid street wall with window quads instead of a band
  function tier(x0, x1, z0, z1, y0, y1, mat, { c = 0, top = true, geomFront = false, crown = top } = {}) {
    const ring = rectRing(x0, x1, z0, z1, c);
    edges(ring, (a, b, i) => {
      if (!(geomFront && i === 0)) {   // top 2 storeys = lighter crown band on tall tiers
        if (!crown || y1 - y0 < 8 * FH) return g.band(mat, a, b, y0, y1, cw, FH);
        const yc = y1 - 2 * FH; g.band(mat, a, b, y0, yc, cw, FH); return tint(mat, crownK, () => g.band(mat, a, b, yc, y1, cw, FH));
      }
      g.poly(wallMat, [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [0, 0, 1]);
      for (let f = 0; (f + 1) * FH <= y1 - y0 + 1e-6; f++) for (const s of split(b[0] - a[0], [{ fix: 1 }, { rep: cw, tile: 1 }, { fix: 1 }])) if (s.part.tile) {
        const c3 = [a[0] + (s.u0 + s.u1) / 2, y0 + f * FH + 1.85, z1];
        g.rect('glass', c3, [0, 0, 1], 1.4, 1.9, 0.04); g.rect('stone', [c3[0], c3[1] + 1.12, z1], [0, 0, 1], 1.8, 0.3, 0.06);
      }
    });
    if (top) roof(ring, y1);
    tiers.push({ x0, x1, z0, z1, y0, y1, mat }); collider.push({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hu: (x1 - x0) / 2, hv: (z1 - z0) / 2, y0, y1 });
    return ring;
  }
  function base(ring, mat = wallMat) { tint(mat, baseK, () => base0(ring, mat)); }   // darker base
  // ground floor: wall + per-bay mix on the street face (entrance bay(s) in the middle), mostly solid side / back faces with a few windows and a loading door.
  // baseType (per seed): lobby (double-height glass + fins + revolving door + canopy), retail (storefront per bay: own sign colour / awning / shutter / solid pier),
  // stone (tall punched windows, bronze doors), bank (columns + big entrance). Glass uses lobbyGlass / retailGlass / officeGlass with whole-cell uv per ~1.5 m panel.
  function base0(ring, mat) {
    let bayK = 0;
    edges(ring, (a, b, ei) => {
      const n = nrm(a, b), len = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], P = (u, y) => [a[0] + t[0] * u, y, a[1] + t[1] * u];
      g.poly(mat, [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], GF, b[1]], [a[0], GF, a[1]]], n);
      if (len < 3) return;
      const front = ei === 0, z = a[1];
      const glass = (m, u, w, y0, h, k) => g.rectUV(m, P(u, y0 + h / 2), n, w, h, 0.05, ((o, r) => [o, r, o + Math.max(1, Math.round(w / 1.5)), r + 1])(Math.floor(rng(k) * 4), Math.floor(rng(k + 1) * 4)));
      const sign = (u, w, k) => tint('awning', 0.5 + rng(k) * 1.2, () => g.rect('awning', P(u, GF - 1.35), n, w, 0.7, 0.06));
      const canopy = (x, w, y, m = 'metalPanel') => g.box(m, x - w / 2, x + w / 2, y, y + 0.25, z, Math.min(z + 0.5, hv), 'z', m === 'awning' ? 'awning' : 'roofFlat');
      if (front) {
        const bays = split(len, [{ fix: 0.6 }, { rep: 4.5, tile: 1 }, { fix: 0.6 }]).filter((s) => s.part.tile), nb = bays.length, e = Math.floor(nb / 2);
        const mix = { lobby: ['lobby', 'lobby', 'retail', 'solid'], retail: ['retail', 'retail', 'retail', 'shutter', 'solid'], stone: ['stone', 'stone', 'retail', 'solid'], bank: ['bank'] }[baseType];
        bays.forEach((s, j) => {
          const u = (s.u0 + s.u1) / 2, w = s.u1 - s.u0, k = 300 + 11 * bayK++, x = P(u, 0)[0];
          const entry = j === e || (baseType === 'lobby' && nb >= 5 && Math.abs(j - e) === 1);
          const ty = entry ? baseType : pick(mix, k);
          if (ty === 'lobby') {
            glass('lobbyGlass', u, w - 0.3, 0.2, GF - 0.8, k + 1);
            for (const f of [-0.25, 0.25]) g.rect('metalPanel', P(u + f * w, GF / 2 - 0.2), n, 0.12, GF - 0.6, 0.3);   // mullion fins
            if (entry) { g.rect('door', P(u, 1.45), n, 2.6, 2.7, 0.1); if (j === e) canopy(x, Math.min(8, w + 2), 3.6); }   // revolving / glass door bay
          } else if (ty === 'retail') {
            glass('retailGlass', u, w - 0.9, 0.35, GF - 2.4, k + 1); sign(u, w - 0.9, k + 3);
            if (front && rng(k + 4) < 0.5) tint('awning', 0.6 + rng(k + 5) * 0.9, () => canopy(x, w - 0.9, GF - 2.2, 'awning'));
            if (entry) g.rect('door', P(u, 1.3), n, 1.4, 2.4, 0.08);
          } else if (ty === 'shutter') { g.rect('metal', P(u, 1.85), n, w - 0.9, 3.2, 0.05); sign(u, w - 0.9, k + 3); }
          else if (ty === 'stone') {
            if (entry) { g.rect('stone', P(u, 2.2), n, 3.4, 4.4, 0.03); g.rect('door', P(u, 1.8), n, 2.4, 3.6, 0.06); canopy(x, 4, 4.3); }   // bronze doors
            else for (const f of [-0.22, 0.22]) { g.rect('stone', P(u + f * w, GF / 2 + 0.2), n, 1.5, GF - 1.8, 0.03); glass('officeGlass', u + f * w, 1.2, 1.2, GF - 2.2, k + 1 + f * 10); }
          } else if (ty === 'bank') {
            for (const f of [-0.5, 0.5]) { const xc = x + f * w * Math.sign(t[0] || 1); g.box('stone', xc - 0.4, xc + 0.4, 0, GF - 0.4, z, Math.min(z + 0.45, hv), 'bz'); }
            if (entry) g.rect('door', P(u, 2), n, 2.8, 4, 0.06); else glass('officeGlass', u, w - 1.4, 0.8, GF - 1.6, k + 1);
          }
        });
        const m = len / 2; g.rect('stone', P(m, GF - 0.45), n, len - 0.2, 0.6, 0.06);   // fascia / sign course
      } else {   // side / back: solid with a few windows, a loading door on the first side
        split(len, [{ fix: 1 }, { rep: 6, tile: 1 }, { fix: 1 }]).filter((s) => s.part.tile).forEach((s, j) => {
          const u = (s.u0 + s.u1) / 2, k = 300 + 11 * bayK++;
          if (ei === 1 && j === 0 && len > 9) g.rect('metal', P(u, 2.1), n, 3.6, 4.2, 0.05);   // loading door
          else if (rng(k) < 0.55) glass('officeGlass', u, 1.6, 1.8, 2.2, k + 1);
        });
      }
    });
  }
  const cornice = (x0, x1, z0, z1, y, d = 0.35, h = 0.7) => g.box('stone', x0 - d, x1 + d, y - h, y, z0 - d, z1 + d, '', 'roofFlat');
  function parapet(x0, x1, z0, z1, y, mat = wallMat, h = 1.1, t = 0.3) {
    g.box(mat, x0, x1, y, y + h, z1 - t, z1); g.box(mat, x0, x1, y, y + h, z0, z0 + t);
    g.box(mat, x0, x0 + t, y, y + h, z0 + t, z1 - t, 'bzZ'); g.box(mat, x1 - t, x1, y, y + h, z0 + t, z1 - t, 'bzZ');
  }
  function hvac(x0, x1, z0, z1, y, k = 20) {
    const nb = 1 + Math.floor(rng(k) * 3);
    for (let i = 0; i < nb; i++) {
      const w = 1.5 + rng(k + 1 + i) * 2, d = 1.5 + rng(k + 5 + i) * 1.5, h = 1.4 + rng(k + 9 + i) * 1.2;
      if (x1 - x0 < w + 3 || z1 - z0 < d + 3) return;
      const x = x0 + 1.5 + w / 2 + rng(k + 13 + i) * (x1 - x0 - 3 - w), z = z0 + 1.5 + d / 2 + rng(k + 17 + i) * (z1 - z0 - 3 - d);
      g.box('metal', x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2);
    }
  }
  function waterTower(x, z, y) {
    const r = 1.5, yl = y + 3, yt = yl + 3.4, ring = Array.from({ length: 8 }, (_, i) => [x + r * Math.cos((i * Math.PI) / 4), z - r * Math.sin((i * Math.PI) / 4)]);
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.box('metal', x + dx * 0.9 - 0.1, x + dx * 0.9 + 0.1, y, yl, z + dz * 0.9 - 0.1, z + dz * 0.9 + 0.1, 'bt');
    edges(ring, (a, b) => { g.poly('wood', [[a[0], yl, a[1]], [b[0], yl, b[1]], [b[0], yt, b[1]], [a[0], yt, a[1]]], nrm(a, b)); g.poly('roof', [[a[0], yt, a[1]], [b[0], yt, b[1]], [x, yt + 1.3, z]], [0, 1, 0]); });
    g.poly('wood', ring.map(([px, pz]) => [px, yl, pz]), [0, -1, 0]);
    collider.push({ cx: x, cz: z, hu: r, hv: r, y0: y, y1: yt + 1.3 });
  }
  function spire(x, z, y, h, r, mat = 'metalPanel') {
    const p = [[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]];
    edges(p, (a, b) => g.poly(mat, [[a[0], y, a[1]], [b[0], y, b[1]], [x, y + h, z]], [(a[0] + b[0]) / 2 - x, 0.3, (a[1] + b[1]) / 2 - z]));
  }
  const antenna = (x, z, y) => { g.box('metal', x - 0.6, x + 0.6, y, y + 3, z - 0.6, z + 0.6); g.box('metal', x - 0.12, x + 0.12, y + 3, y + Math.min(30, H * 0.15), z - 0.12, z + 0.12, 'b'); };
  function fins(x0, x1, z0, z1, y0, y1, mat = 'concrete', every = 1, d = 0.35) {   // vertical fins / piers every `every` bays on the 4 sides of a rect tier
    const at = (L) => split(L, [{ rep: cw }]).slice(1).filter((s) => s.i % every === 0);
    for (const s of at(x1 - x0)) { const x = x0 + s.u0; g.box(mat, x - 0.15, x + 0.15, y0, y1, z1, z1 + d, 'bz'); g.box(mat, x - 0.15, x + 0.15, y0, y1, z0 - d, z0, 'bZ'); }
    for (const s of at(z1 - z0)) { const z = z0 + s.u0; g.box(mat, x1, x1 + d, y0, y1, z - 0.15, z + 0.15, 'bx'); g.box(mat, x0 - d, x0, y0, y1, z - 0.15, z + 0.15, 'bX'); }
  }
  // rooftop plant: stair / lift penthouse, maybe a cooling tower and a mechanical screen, window-washing rails on tall towers, then HVAC boxes
  function roofKit(x0, x1, z0, z1, y, k = 40) {
    const w = Math.min(8, (x1 - x0) * 0.35), d = Math.min(6, (z1 - z0) * 0.3), ph = FH * 1.3, px = x0 + (x1 - x0) * (0.3 + rng(k) * 0.4), pz = z0 + (z1 - z0) * (0.3 + rng(k + 1) * 0.3);
    if (w > 2 && d > 2) { g.box('concrete', px - w / 2, px + w / 2, y, y + ph, pz - d / 2, pz + d / 2, 'b', 'roofFlat'); collider.push({ cx: px, cz: pz, hu: w / 2, hv: d / 2, y0: y, y1: y + ph }); }
    if (rng(k + 2) < 0.5 && x1 - x0 > 10 && z1 - z0 > 10) {   // cooling tower: 8-sided drum in the back corner
      const r = 1.6, cx = x1 - 2.5, cz = z0 + 2.5, ring = Array.from({ length: 8 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 4), cz - r * Math.sin((i * Math.PI) / 4)]);
      edges(ring, (a, b) => g.poly('metal', [[a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + 2.6, b[1]], [a[0], y + 2.6, a[1]]], nrm(a, b)));
      roof(ring, y + 2.6, 'metalPanel');
    }
    if (rng(k + 3) < 0.5 && x1 - x0 > 9 && z1 - z0 > 9) {   // mechanical screen, both faces
      edges(rectRing(x0 + 3, x1 - 3, z0 + 3, z1 - 3), (a, b) => { g.band('metalPanel', a, b, y, y + 2.4, cw, FH); g.band('metalPanel', b, a, y, y + 2.4, cw, FH); });
    }
    if (fl > 20) { g.box('metal', x0 + 0.8, x1 - 0.8, y + 1.1, y + 1.3, z1 - 0.7, z1 - 0.5); g.box('metal', x0 + 0.8, x1 - 0.8, y + 1.1, y + 1.3, z0 + 0.5, z0 + 0.7); }   // BMU rails
    hvac(x0, x1, z0, z1, y, k + 10);
  }
  function topper(x, z, y, k = 60) {   // antenna / twin masts / spire on the tallest
    const r = rng(k);
    if (r < 0.4) antenna(x, z, y);
    else if (r < 0.7) { antenna(x - 3, z, y); g.box('metal', x + 2.88, x + 3.12, y, y + Math.min(18, H * 0.08), z - 0.12, z + 0.12, 'b'); }
    else { g.box('metalPanel', x - 1.5, x + 1.5, y, y + 4, z - 1.5, z + 1.5, 'b'); spire(x, z, y + 4, Math.min(30, H * 0.15), 1.2); }
  }

  const cxm = (X0 + X1) / 2, czm = (Z0 + Z1) / 2;
  const lit = fl >= C.litCrownFloors, R = (x0, x1, z0, z1) => rectRing(x0, x1, z0, z1), glassTopMat = lit ? 'crownLit' : 'metalPanel';
  // crown on a flat glass roof: pyramid / stepped / helipad / logo box / plain (parapet + roof plant)
  function crown(x0, x1, z0, z1, y, k = 70) {
    const t = pick(['flat', 'flat', 'pyramid', 'stepped', 'helipad', 'logo'], k), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hm = Math.min(x1 - x0, z1 - z0) / 2;
    crownType = t;
    parapet(x0, x1, z0, z1, y, t === 'flat' ? glassTopMat : 'metalPanel', 1.2 + rng(k + 1) * 0.8, 0.25);
    if (t === 'pyramid') spire(cx, cz, y, hm * (0.6 + rng(k + 2) * 0.8), hm * 0.9, glassTopMat);
    else if (t === 'stepped') { let s = 0, yy = y; for (let i = 0; i < 3; i++) { s += hm * 0.22; g.box(i === 2 ? glassTopMat : 'metalPanel', x0 + s, x1 - s, yy, yy + FH, z0 + s, z1 - s, 'b', 'roofFlat'); yy += FH; } }
    else if (t === 'helipad' && hm > 5) { const r2 = Math.min(5, hm - 1); g.box('metal', cx - 1.5, cx + 1.5, y, y + 1.5, cz - 1.5, cz + 1.5); roof(rectRing(cx - r2, cx + r2, cz - r2, cz + r2, r2 * 0.4), y + 1.5, 'stone'); }
    else if (t === 'logo') { roofKit(x0, x1, z0, z1, y, k + 5); g.box('crownLit', cx - Math.min(4, hm * 0.6), cx + Math.min(4, hm * 0.6), y + 1.5, y + 4, z1 - 0.8, z1 - 0.4, 'b'); }
    else roofKit(x0, x1, z0, z1, y, k + 5);
  }
  // street arcade / colonnade on stone bases: a column every bay in front of the street wall, 0.45 m proud
  function arcade() {
    for (const q of split(W, [{ rep: cw }]).slice(1)) { const x = X0 + q.u0; g.box('stone', x - 0.25, x + 0.25, 0, GF - 0.3, Z1 + 0.05, Z1 + 0.45, 'bz'); }
  }
  // glass tower tier run with floor-line spandrel frames, optional fins
  function glassTier(x0, x1, z0, z1, f0, f1, opt = {}) {
    const ring = tier(x0, x1, z0, z1, yF(f0), yF(f1), opt.mat || 'curtainGlass', { c: opt.c || 0, crown: opt.crown ?? true });
    ledges(ring, f0, f1, { h: 0.25, d: 0.15, mat: 'metalPanel', budget: opt.budget, every: opt.every });
    if (opt.fins && !opt.c) fins(x0, x1, z0, z1, yF(f0), yF(f1), 'metalPanel', opt.fins, 0.2);
    return ring;
  }
  if (['classicStone', 'podiumTower', 'artDeco'].includes(variant) && rng(80) < 0.4) arcade();
  if (variant === 'classic' || variant === 'classicStone') {
    base(R(X0, X1, Z0, Z1));
    tier(X0, X1, Z0, Z1, GF, H, 'windowBand', { top: false, geomFront: fl <= C.geomWindowsMaxFloors });
    ledge(R(X0, X1, Z0, Z1), GF - 0.15, 0.35, 0.25);   // string course over the shopfronts
    if (fl > C.geomWindowsMaxFloors) ledges(R(X0, X1, Z0, Z1), 0, fl, { every: 4, h: 0.25, d: 0.15 });
    for (const [x0, x1] of [[X0 - 0.3, X0 + 0.6], [X1 - 0.6, X1 + 0.3]]) for (const [z0, z1] of [[Z0 - 0.3, Z0 + 0.6], [Z1 - 0.6, Z1 + 0.3]]) g.box('stone', x0, x1, GF, H - 0.7, z0, z1, 'bt');   // corner piers
    cornice(X0 + 0.3, X1 - 0.3, Z0 + 0.3, Z1 - 0.3, H); parapet(X0, X1, Z0, Z1, H, wallMat, 0.9);
    if (fl >= 5 && rng(30) < 0.75) waterTower(X0 + 3 + rng(31) * (W - 6), Z0 + 3 + rng(32) * Math.max(0, D * 0.5 - 6), H); else hvac(X0, X1, Z0, Z1, H);
  } else if (variant === 'concreteGrid') {
    const [x0, x1, z0, z1] = [X0 + 0.35, X1 - 0.35, Z0 + 0.35, Z1 - 0.35];
    base(R(X0, X1, Z0, Z1), 'concrete');
    tier(x0, x1, z0, z1, GF, H, 'windowGrid');
    fins(x0, x1, z0, z1, GF, H + 0.6); ledges(R(x0, x1, z0, z1), 0, fl, { every: 3, h: 0.35, d: 0.45, mat: 'concrete' });
    parapet(x0, x1, z0, z1, H, 'concrete', 0.6); roofKit(x0, x1, z0, z1, H);
  } else if (variant === 'glassBox') {
    shape = pick(['rect', 'rounded', 'L'], 81);
    const c = shape === 'rounded' ? Math.min(W, D) * (0.08 + rng(82) * 0.1) : 0;
    base(rectRing(X0, X1, Z0, Z1, c), 'metalPanel'); ledge(rectRing(X0, X1, Z0, Z1, c), GF - 0.2, 0.4, 0.3, 'metalPanel');
    if (shape === 'L') {   // tall back wing + lower side wing towards the street
      const zm = Z0 + D * (0.45 + rng(83) * 0.15), left = rng(84) < 0.5, xm = left ? X0 + W * 0.5 : X1 - W * 0.5, f2 = Math.max(2, Math.round(fl * (0.4 + rng(85) * 0.3)));
      glassTier(X0, X1, Z0, zm, 0, fl, { budget: 800, fins: fl <= 30 ? 2 : 0 }); crown(X0, X1, Z0, zm, H);
      const [a0, a1] = left ? [X0, xm] : [xm, X1];
      roof(R(X0, X1, Z0, Z1), GF); glassTier(a0, a1, zm, Z1, 0, f2, { budget: 400 }); parapet(a0, a1, zm, Z1, yF(f2), 'metalPanel', 1.2, 0.25);
    } else {
      glassTier(X0, X1, Z0, Z1, 0, fl, { c, fins: fl <= 30 ? 2 : 0 });
      if (c) { edges(rectRing(X0, X1, Z0, Z1, c), (a, b) => g.band(glassTopMat, a, b, H, H + 1.6, cw, FH)); roofKit(X0 + c, X1 - c, Z0 + c, Z1 - c, H); } else crown(X0, X1, Z0, Z1, H);
    }
    if (fl >= C.antennaFloors) topper(cxm, czm - (shape === 'L' ? D * 0.25 : 0), H + 0.01);
  } else if (variant === 'podiumTower') {
    const pf = Math.min(6, Math.max(2, Math.round(fl * 0.15))), yp = yF(pf), ix = W * 0.2, iz = D * 0.2, zb = Math.min(iz, 2);   // tower sits towards the back
    const [x0, x1, z0, z1] = [X0 + ix, X1 - ix, Z0 + iz - zb, Z1 - iz - zb];
    base(R(X0, X1, Z0, Z1));
    tier(X0, X1, Z0, Z1, GF, yp, 'windowBand', { top: false }); cornice(X0 + 0.3, X1 - 0.3, Z0 + 0.3, Z1 - 0.3, yp, 0.3, 0.5);
    ledge(R(X0, X1, Z0, Z1), GF - 0.15, 0.35, 0.25);
    tier(x0, x1, z0, z1, yp, H, 'curtainGlass'); ledges(R(x0, x1, z0, z1), pf, fl, { h: 0.25, d: 0.15, mat: 'metalPanel' });
    fins(x0, x1, z0, z1, yp, H, 'metalPanel', 2, 0.25);
    crown(x0, x1, z0, z1, H); if (fl >= C.antennaFloors && crownType !== 'pyramid') topper(cxm, czm - zb, H);
  } else if (variant === 'artDeco') {
    const cuts = (fl > 40 ? [0.5, 0.72, 0.88, 1] : [0.6, 0.85, 1]).map((f) => Math.max(1, Math.round(fl * f))), step = Math.min(W, D) * 0.08;
    base(R(X0, X1, Z0, Z1));
    ledge(R(X0, X1, Z0, Z1), GF - 0.15, 0.4, 0.3);
    let y = GF, f0 = 0;
    cuts.forEach((f, i) => {
      const s = i * step, y1 = yF(Math.max(f, f0 + 1)); f0 = Math.max(f, f0 + 1);
      tier(X0 + s, X1 - s, Z0 + s, Z1 - s, y, y1, 'windowDeco', { top: false, crown: i === cuts.length - 1 });
      fins(X0 + s, X1 - s, Z0 + s, Z1 - s, y, y1 - 0.4, 'stone', fl > 40 ? 3 : 2, 0.3);   // piers
      cornice(X0 + s + 0.2, X1 - s - 0.2, Z0 + s + 0.2, Z1 - s - 0.2, y1, 0.2, 0.4); y = y1;
    });
    let s = (cuts.length - 1) * step;   // stepped crown (top step lit on the tallest) + spire
    for (let k = 0; k < 3; k++) { s += Math.min(W, D) * 0.05; const hk = FH * 1.2; g.box(lit && k === 2 ? 'crownLit' : 'stone', X0 + s, X1 - s, y, y + hk, Z0 + s, Z1 - s, 'b', 'roofFlat'); y += hk; }
    collider.push({ cx: cxm, cz: czm, hu: W / 2 - s, hv: D / 2 - s, y0: H, y1: y });
    spire(cxm, czm, y, Math.min(25, 4 + fl * 0.3), Math.min(1.5, (Math.min(W, D) / 2 - s) * 0.6));
  } else if (variant === 'slab') {   // thin wide slab set back from the street, low glass pavilion in front
    shape = 'slab';
    const glass = rng(86) < 0.5, d2 = Math.min(D * 0.45, 14), z1 = Z0 + d2, mat = glass ? 'curtainGlass' : 'windowGrid';
    base(R(X0, X1, Z0, z1), glass ? 'metalPanel' : 'concrete');
    if (glass) glassTier(X0, X1, Z0, z1, 0, fl, { budget: 900 }); else { tier(X0, X1, Z0, z1, GF, H, mat); ledges(R(X0, X1, Z0, z1), 0, fl, { every: 2, h: 0.3, d: 0.35, mat: 'concrete', budget: 900 }); }
    fins(X0, X1, Z0, z1, GF, H + 0.5, glass ? 'metalPanel' : 'concrete', glass ? 3 : 1, 0.3);
    parapet(X0, X1, Z0, z1, H, 'concrete', 0.8); roofKit(X0, X1, Z0, z1, H); crownType = 'flat';
    tier(X0 + 1, X1 - 1, z1, Z1, 0, GF, 'curtainGlass', { crown: false }); g.box('metalPanel', X0 + 0.5, X1 - 0.5, GF, GF + 0.5, z1, Z1, 'b', 'roofFlat');   // pavilion
  } else if (variant === 'twinTower') {   // two glass towers of different height on a shared stone podium
    shape = 'twin';
    const pf = 2 + Math.floor(rng(87) * 3), yp = yF(pf), gap = Math.max(3, W * 0.12), wt = (W - gap) / 2 - 1, zb = Math.min(D * 0.15, 3), fB = Math.max(pf + 2, Math.round(fl * (0.7 + rng(88) * 0.25)));
    base(R(X0, X1, Z0, Z1)); tier(X0, X1, Z0, Z1, GF, yp, 'windowBand', { top: false }); cornice(X0 + 0.3, X1 - 0.3, Z0 + 0.3, Z1 - 0.3, yp, 0.3, 0.5);
    const c = rng(89) < 0.4 ? Math.min(wt, D) * 0.15 : 0, za = Z0 + 1, zc = Z1 - 1 - zb;
    glassTier(X0 + 1, X0 + 1 + wt, za, zc, pf, fl, { c, budget: 700 }); crown(X0 + 1, X0 + 1 + wt, za, zc, H, 90);
    glassTier(X1 - 1 - wt, X1 - 1, za, zc, pf, fB, { c, budget: 500 }); parapet(X1 - 1 - wt, X1 - 1, za, zc, yF(fB), glassTopMat, 1.5, 0.25); hvac(X1 - 1 - wt, X1 - 1, za, zc, yF(fB), 95);
  } else if (variant === 'taperTower') {   // 3-5 glass setback tiers of random depth, crown on top
    shape = 'taper';
    const n = 3 + Math.floor(rng(91) * 3), c = rng(92) < 0.35 ? Math.min(W, D) * 0.12 : 0;
    base(rectRing(X0, X1, Z0, Z1, c), 'metalPanel');
    let s = 0, f0 = 0;
    for (let i = 0; i < n; i++) {
      const f1 = i === n - 1 ? fl : Math.max(f0 + 2, Math.round(fl * (i + 1) / n * (0.85 + rng(93 + i) * 0.25)));
      if (f1 >= fl && i < n - 1) continue;
      glassTier(X0 + s, X1 - s, Z0 + s, Z1 - s, f0, f1, { c: c * (1 - i * 0.15), budget: C.ledgeTris / n, crown: i === n - 1 });
      if (i < n - 1) ledge(rectRing(X0 + s, X1 - s, Z0 + s, Z1 - s, c * (1 - i * 0.15)), yF(f1) - 0.1, 0.5, 0.3, 'metalPanel');
      f0 = f1; s += Math.min(W, D) * (0.04 + rng(99 + i) * 0.05);
    }
    const last = tiers[tiers.length - 1];
    if (c) roofKit(last.x0 + c, last.x1 - c, last.z0 + c, last.z1 - c, H); else crown(last.x0, last.x1, last.z0, last.z1, H);
    if (fl >= C.antennaFloors && crownType !== 'pyramid') topper((last.x0 + last.x1) / 2, (last.z0 + last.z1) / 2, H);
  } else {   // chamfered
    const c = Math.min(W, D) * 0.22, fs = Math.round(fl * 0.7), ys = yF(fs), i2 = Math.min(W, D) * 0.12;
    const r0 = rectRing(X0, X1, Z0, Z1, c);
    base(r0, 'metalPanel'); tier(X0, X1, Z0, Z1, GF, ys, 'curtainGlass', { c }); ledge(r0, GF - 0.2, 0.4, 0.3, 'metalPanel');
    ledges(r0, 0, fs, { h: 0.25, d: 0.15, mat: 'metalPanel' }); ledge(r0, ys - 0.1, 0.5, 0.35, 'metalPanel');   // setback ledge
    const r2 = tier(X0 + i2, X1 - i2, Z0 + i2, Z1 - i2, ys, H, 'curtainGlass', { c: c * 0.8 });
    ledges(r2, fs, fl, { h: 0.25, d: 0.15, mat: 'metalPanel' });
    edges(r2, (a, b) => g.band(lit ? 'crownLit' : 'metalPanel', a, b, H, H + 2, cw, FH));   // crown screen
    if (fl >= C.antennaFloors) topper(cxm, czm, H); else roofKit(X0 + i2 + c, X1 - i2 - c, Z0 + i2 + c, Z1 - i2 - c, H);
  }

  const prims = g.prims();
  let Hm = 0, tris = 0;
  for (const p of prims) { tris += p.idx.length / 3; for (let i = 1; i < p.pos.length; i += 3) Hm = Math.max(Hm, p.pos[i]); }
  if (variant === 'chamfered') shape = 'octagon'; if (variant === 'artDeco') { shape = 'setback'; crownType = 'spire'; } if (variant.startsWith('classic')) crownType = 'cornice';
  const tex = {}; for (const m of new Set(prims.map((q) => q.mat))) if (['windowBand', 'windowGrid', 'windowDeco', 'curtainGlass', 'metalPanel', 'lobbyGlass', 'retailGlass', 'officeGlass'].includes(m)) tex[m] = textureKeyFor(m, seed * 31 + 5);
  const yMin = Math.min(...collider.map((c) => c.y0)); for (const c of collider) if (c.y0 === yMin) c.y0 = 0;   // lobby storey has no tier of its own: drop the lowest boxes to the ground
  return { prims, W: 2 * hu, D: 2 * hv, H: Hm, tris, variant, floors: fl, collider, tiers, col, shape, crown: crownType, base: baseType, tex };
}

// far LOD: <= 3 silhouette tiers (extra setbacks fold into the third), 10 tris each
export function planImpostor(spec) {
  const t = planTower(spec), tiers = t.tiers.slice(0, 3).map((x) => ({ ...x }));
  if (t.tiers.length > 3) tiers[2].y1 = t.tiers[t.tiers.length - 1].y1;
  tiers[0].y0 = 0;
  return impostorFromTiers(tiers, t.col, TOWER_CONFIG.bayW, TOWER_CONFIG.floorH);
}
