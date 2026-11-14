// Procedural suburban US houses as raw triangle primitives (pure: no THREE, runs in Node; a renderer merges the prims per material, e.g. cityChunk.js merge).
//
//   planHouse(spec) -> { prims: [{ mat, pos, nor, uv, idx, cs: 3, col }], W, D, H, tris, variant, collider: [{ cx, cz, hu, hv, y0, y1 }] }   house-local coordinates:
//        pivot = footprint centre at ground level, local +Z = street (cityBlocks lot.footprint convention: place with (footprint.cx, 0, footprint.cz) and yaw = footprint.yaw).
//        Everything stays inside the footprint box x in [-hu, hu], z in [-hv, hv], y >= 0, EXCEPT the 'driveway' and 'walk' slabs, which run on from the garage door / front door
//        straight to the lot's street edge at z = spec.front (still within |x| <= hu). The garden mats (hedge / shrub / fence / flower) also use the front yard hv..front
//        (only when front - hv > 3), keep clear of the drive / walk x-ranges by 0.5 m, and are listed in the result's `garden` boxes [{ mat, x0, x1, z0, z1, y0, y1, col }].
//        garden boxes sit on the real ground: spec.groundAt(x, z) (house-local, ground height relative to the pivot, default 0) -> each box spans min..max corner height; `col` boxes (not posts / flower beds) are for colliders.
//   spec = { hu, hv, seed, groundAt?, driveway?: 'left' | 'right', weight?: 0..1, front?: number, variant?: name }
//        hu / hv = footprint half width (along the street) / half depth; driveway side as seen from the street (viewer faces -Z, so 'left' = -X);
//        weight = affluence 0..1 (biases toward bigger / brick / two-storey variants); front = distance from the pivot to the lot street edge (default hv + 7);
//        variant forces one of VARIANTS (preview / tests).
//   VARIANTS = names, see the table below. MATS = every material key a prim can carry.
//
// GEOMETRY. One prim per material key; every vertex carries an RGB colour (col, cs = 3): the intended albedo (flat-colour renderers use it as is, textured ones may multiply / ignore).
// UVs are metres (1 uv = 1 m) projected on each face plane (u horizontal, v up the face / slope) so tiling textures work. Faces are emitted with a winding check against an
// outward hint, so normals point out and winding is CCW from outside. Detail quads (window frames, glass, doors) sit 2-5 cm proud of the wall in separate planes: no coplanar overlap.
// Footprint shapes come from overlapping box "wings" (rect / L / T); a wing = walls + a roof extruded from a cross-section profile (gable, gambrel, saltbox, shed) or a hip / flat roof.
// Roofs are slabs: top + underside (soffit) + fascia/rake edges, eave overhang 0.4 m, so they read correctly from below too.
import { hash } from './scatterGen.js';
import { Mesh, mass, facade, profile, interp } from './shapeGrammar.js';

export const MATS = ['siding', 'brick', 'plaster', 'roof', 'roofFlat', 'trim', 'shutter', 'door', 'garageDoor', 'glass', 'concrete', 'deck', 'driveway', 'walk', 'hedge', 'shrub', 'fence', 'flower'];
export const VARIANTS = ['ranch', 'colonial', 'capeCod', 'splitLevel', 'craftsman', 'lRanch', 'tFarmhouse', 'dutchColonial', 'saltbox', 'modern', 'ranchDetached', 'foursquare'];
const BIG = new Set(['colonial', 'tFarmhouse', 'dutchColonial', 'saltbox', 'foursquare', 'modern']);
export const TRI_BUDGET = 1500;

const FH = 2.8, E = 0.4, M = 0.5;   // storey height, eave overhang, footprint margin kept for eaves / rakes
const PAL = {
  siding: [[0.95, 0.95, 0.93], [0.78, 0.8, 0.8], [0.86, 0.8, 0.68], [0.7, 0.8, 0.88], [0.93, 0.87, 0.6], [0.66, 0.73, 0.64], [0.55, 0.6, 0.66]],
  plaster: [[0.93, 0.91, 0.86], [0.85, 0.83, 0.8], [0.6, 0.62, 0.63]],
  brick: [[0.62, 0.3, 0.24], [0.7, 0.42, 0.33], [0.55, 0.35, 0.3]],
  roof: [[0.25, 0.25, 0.27], [0.35, 0.28, 0.22], [0.15, 0.15, 0.16], [0.42, 0.24, 0.2], [0.3, 0.36, 0.38]],
  trim: [[0.97, 0.97, 0.95], [0.92, 0.88, 0.78], [0.2, 0.2, 0.2]],
  door: [[0.55, 0.12, 0.1], [0.12, 0.18, 0.35], [0.1, 0.1, 0.1], [0.15, 0.32, 0.2], [0.45, 0.3, 0.18]],
  hedge: [[0.18, 0.4, 0.15], [0.2, 0.35, 0.18], [0.14, 0.32, 0.12]],
  shrub: [[0.25, 0.45, 0.2], [0.3, 0.5, 0.25], [0.2, 0.38, 0.22], [0.35, 0.42, 0.18]],
  fence: [[0.96, 0.96, 0.94], [0.6, 0.45, 0.3], [0.85, 0.82, 0.74]],
  flower: [[0.85, 0.25, 0.3], [0.9, 0.75, 0.2], [0.7, 0.4, 0.8], [0.95, 0.6, 0.7]],
  shutter: [[0.1, 0.12, 0.15], [0.12, 0.25, 0.18], [0.2, 0.25, 0.4], [0.45, 0.15, 0.12]],
};

// style rule sets: data (sym = odd bay count + symmetric front, shutters) + one mass rule each; FH storey height
const DATA = {
  ranch: { sym: false }, colonial: { sym: true, shutters: true }, capeCod: { sym: true, shutters: true }, splitLevel: {}, craftsman: {}, lRanch: {}, tFarmhouse: {},
  dutchColonial: { sym: true, shutters: true }, saltbox: { sym: true, shutters: true }, modern: { big: true }, ranchDetached: {}, foursquare: { sym: true },
};
const STYLES = {
  ranch: { ...DATA.ranch, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const zf = Z1 - 1.3, G = garage('attached', pick(['gable', 'hip'], 20), Math.min(Z1, zf + 0.8)), d = Math.min(9, D - 1.3);
    const m = wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 2.8, roof: pick(['hip', 'gable'], 21) });
    c.walk = door(X0 + (G.x0 - X0) * 0.62, zf); chimney(X0 + 1.2, zf - d / 2, 2, m.top + 0.7);
  } },
  colonial: { ...DATA.colonial, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('attached', 'gable', Z1 - 1.2), x1 = G.x0, w = Math.min(x1 - X0, 13), x0 = x1 - w, zf = Z1 - 1.8, d = Math.min(9, D - 1.8);
    const m = wing({ x0, x1, z0: zf - d, z1: zf, h: 2 * FH + 0.2, floors: 2, k: 0.55 });
    c.walk = porch((x0 + x1) / 2 - 1.4, (x0 + x1) / 2 + 1.4, zf, 1.4, 2.9, (x0 + x1) / 2); chimney(x0 + 0.8, zf - d / 2, 4, m.top + 0.8);
  } },
  capeCod: { ...DATA.capeCod, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage(rng(22) < 0.5 ? 'attached' : 'detached', 'gable', Z1 - 0.6), zf = Z1 - 1.3, d = Math.min(8.5, D - 1.3);
    const m = wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 3, k: 1.0 });
    dormers(m, Math.max(1, Math.min(3, Math.floor((G.x0 - X0) / 3.2)))); c.walk = door((X0 + G.x0) / 2, zf); chimney(G.x0 - 1, zf - d / 2, 3, m.top + 0.7);
  } },
  splitLevel: { ...DATA.splitLevel, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const zf = Z1 - 1.3, xb = X1 - Math.min(7, W * 0.45), d = Math.min(9, D - 1.3);
    const hi = wing({ x0: xb, x1: X1, z0: zf - d + 1, z1: zf + 0.6, h: 5.3, floors: 2, roof: 'gable', k: 0.45, noGroundFront: true });
    garageDoor(hi, (xb + X1) / 2, Math.min(gdw, X1 - xb - 1.2));
    wing({ x0: X0, x1: xb + 0.3, z0: zf - d, z1: zf, h: 3, roof: pick(['gable', 'hip'], 23) });
    c.walk = door(X0 + (xb - X0) * 0.7, zf);
  } },
  craftsman: { ...DATA.craftsman, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('detached', 'gable'), zf = Z1 - pz - 0.4, x1 = Math.min(G.x0, X0 + 11), d = Math.min(10, D - pz - 0.4 - (G.w ? 0 : 0));
    wing({ x0: X0, x1, z0: zf - d, z1: zf, h: 3, roof: 'gable', axis: 'z', k: 0.55, floors: 1 });
    c.walk = porch(X0 + 0.2, x1 - 0.2, zf, pz, 2.7, X0 + (x1 - X0) * 0.35);
  } },
  lRanch: { ...DATA.lRanch, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('attached', 'hip', Z1 - 2.4), zf = Z1 - 3, d = Math.min(8, D - 3), ww = Math.min(4.6, (G.x0 - X0) * 0.45);
    wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 2.8, roof: 'gable' });
    wing({ x0: X0, x1: X0 + ww, z0: zf - d + 1.5, z1: Z1, h: 2.8, roof: 'gable', axis: 'z' });
    c.walk = door(X0 + ww + 1.2, zf);
  } },
  tFarmhouse: { ...DATA.tFarmhouse, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('detached', 'gable'), zf = Z1 - 2.6, x1 = G.x0, d = Math.min(7, D - 2.6), ww = Math.min(4.4, (x1 - X0) * 0.4), wc = (X0 + x1) / 2 + (x1 - X0) * 0.12;
    const m = wing({ x0: X0, x1, z0: zf - d, z1: zf, h: 2 * FH + 0.2, floors: 2, k: 0.7 });
    wing({ x0: wc - ww / 2, x1: wc + ww / 2, z0: zf - 1, z1: Z1, h: 2 * FH + 0.2, floors: 2, roof: 'gable', axis: 'z', k: 0.7 });
    c.walk = porch(X0 + 0.2, wc - ww / 2, zf, Math.min(2.2, Z1 - zf), 2.8, (X0 + wc - ww / 2) / 2); chimney(X0 + 0.9, zf - d / 2, 4, m.top + 0.6);
  } },
  dutchColonial: { ...DATA.dutchColonial, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('attached', 'gable', Z1 - 0.8), zf = Z1 - 1.8, d = Math.min(9, D - 1.8);
    const m = wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 3, roof: 'gambrel', e: 0.25 });
    c.walk = porch((X0 + G.x0) / 2 - 1.3, (X0 + G.x0) / 2 + 1.3, zf, 1.4, 2.9, (X0 + G.x0) / 2); chimney(X0 + 0.8, zf - d / 2, 3, m.top + 0.7);
  } },
  saltbox: { ...DATA.saltbox, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('detached', 'gable'), zf = Z1 - 1.3, d = Math.min(9, D - 1.3);
    const m = wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 2 * FH + 0.2, floors: 2, roof: 'saltbox', k: 0.75 });
    c.walk = door((X0 + G.x0) / 2, zf); chimney((X0 + G.x0) / 2, zf - d * 0.35, 4, m.top + 0.8);
  } },
  modern: { ...DATA.modern, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const zf = Z1 - 1.3, d = Math.min(10, D - 1.3), xa = X0 + (X1 - X0) * 0.55;
    wing({ x0: X0, x1: xa, z0: zf - d, z1: zf, h: 2 * FH + 0.3, floors: 2, roof: 'flat' });
    const b = wing({ x0: xa - 0.3, x1: X1, z0: zf - d + 1, z1: zf + 0.7, h: 3.1, roof: 'flat', noGroundFront: W >= 11 });
    if (W >= 11) garageDoor(b, (xa + X1) / 2, Math.min(gdw, X1 - xa - 1));
    c.walk = door(X0 + (xa - X0) * 0.75, zf, 0.2);
  } },
  ranchDetached: { ...DATA.ranchDetached, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('detached', 'hip'), zf = Z1 - pz - 0.4, d = Math.min(8.5, D - pz - 0.4);
    wing({ x0: X0, x1: G.x0, z0: zf - d, z1: zf, h: 2.8, roof: 'hip' });
    c.walk = porch(X0 + 0.5, G.x0 - 0.5, zf, pz, 2.6, (X0 + G.x0) / 2);
  } },
  foursquare: { ...DATA.foursquare, rule(c) {
    const { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng } = c;
    const G = garage('detached', 'hip'), zf = Z1 - pz - 0.4, s = Math.min(G.x0 - X0, D - pz - 0.4, 10), x0 = X0;
    const m = wing({ x0, x1: x0 + s, z0: zf - s, z1: zf, h: 2 * FH + 0.2, floors: 2, roof: 'hip', k: 0.5 });
    c.walk = porch(x0 + 0.1, x0 + s - 0.1, zf, pz, 2.8, x0 + s * 0.3); chimney(x0 + s - 1, zf - s / 2, 4, m.top + 0.5);
  } },
};

// --- planner ------------------------------------------------------------------------------------------------------------------
export function planHouse(spec) {
  const { hu, hv, seed = 1 } = spec, weight = spec.weight ?? 0.5, rng = (k) => hash(seed >>> 0, k, 0, 913);
  const pick = (list, k) => list[Math.min(list.length - 1, Math.floor(rng(k) * list.length))];
  let variant = spec.variant;
  if (!variant) { variant = pick(VARIANTS, 1); if (rng(2) < Math.abs(weight - 0.5) && BIG.has(variant) !== weight > 0.5) variant = pick(VARIANTS, 3); }
  const style = STYLES[variant];
  const front = spec.front ?? hv + 7, mirror = (spec.driveway ?? (rng(4) < 0.5 ? 'left' : 'right')) === 'left';   // plan with the garage on +X, mirror for 'left' (-X)
  const wallMat = variant === 'modern' ? 'plaster' : rng(5) < 0.15 + weight * 0.3 ? 'brick' : rng(6) < 0.15 ? 'plaster' : 'siding';
  const trim = pick(PAL.trim, 9), col = {
    siding: pick(PAL.siding, 7), plaster: pick(PAL.plaster, 7), brick: pick(PAL.brick, 7), roof: pick(PAL.roof, 8), roofFlat: [0.45, 0.45, 0.45], trim, shutter: pick(PAL.shutter, 10),
    door: pick(PAL.door, 11), garageDoor: rng(12) < 0.7 ? [0.95, 0.95, 0.93] : trim, glass: [0.25, 0.32, 0.38], concrete: [0.72, 0.71, 0.68], deck: [0.55, 0.42, 0.3],
    driveway: rng(13) < 0.5 ? [0.3, 0.3, 0.31] : [0.66, 0.65, 0.62], walk: [0.74, 0.73, 0.7],
    hedge: pick(PAL.hedge, 30), shrub: pick(PAL.shrub, 31), fence: pick(PAL.fence, 32), flower: pick(PAL.flower, 33),
  };
  const g = new Mesh(col), wings = [], doors = [], collider = [];
  const X0 = -hu + M, X1 = hu - M, Z0 = -hv + M, Z1 = hv - M, W = X1 - X0, D = Z1 - Z0;
  const shutters = !!style.shutters || (variant !== 'modern' && rng(14) < 0.3);
  const winW = style.big ? 1.8 : 1.0, winH = style.big ? 1.6 : 1.3;
  const k = 0.45 + rng(15) * 0.25;

  const blocked = (x, y, z, self) => wings.some((w) => w !== self && !w.dormer && x > w.x0 - E && x < w.x1 + E && z > w.z0 - E && z < w.z1 + E && y < w.top);
  const nearDoor = (x, z) => doors.some((d) => Math.abs(d.x - x) < 1.25 && Math.abs(d.z - z) < 0.6);

  function window_(c, n, w = winW, h = winH) {
    g.rect('trim', c, n, w + 0.2, h + 0.2, 0.03); g.rect('glass', c, n, w, h, 0.05);
    if (shutters && w < 1.5) for (const sd of [-1, 1]) g.rect('shutter', [c[0] + n[2] * sd * (w / 2 + 0.33), c[1], c[2] - n[0] * sd * (w / 2 + 0.33)], n, 0.42, h + 0.1, 0.03);
  }

  // wing = box of walls (x0..x1, z0..z1, from yb up to eave height h) + roof; floors = window rows
  function wing(o) {
    const w = mass(g, { k, e: E, wall: wallMat, ...o });
    wings.push(w);
    if (!w.dormer && !w.noCollide) collider.push({ cx: (w.x0 + w.x1) / 2, cz: (w.z0 + w.z1) / 2, hu: (w.x1 - w.x0) / 2, hv: (w.z1 - w.z0) / 2, y0: w.yb, y1: w.top });
    return w;
  }

  function windows() {
    for (const w of wings) {
      if (w.dormer) { const wl = w.walls.find((l) => l.front); window_(wl.pt((wl.u0 + wl.u1) / 2, w.yb + 0.85), wl.n, 0.75, 0.85); continue; }
      if (w.noWin) continue;
      for (const wl of w.walls) facade(wl, {
        yb: w.yb, floorH: FH,
        bays: (row) => (row === 0 && wl.front && w.noGroundFront) ? [] : [{ fix: 0.6 }, { rep: winW + 1.6, odd: style.sym && wl.front, tile: 'win' }, { fix: 0.6 }],
        insert: ({ u, c, row }) => {
          const yc = c[1] + 1.55;
          if (yc + winH / 2 + 0.25 > Math.min(wl.top(u - winW / 2 - 0.1), wl.top(u + winW / 2 + 0.1))) return;
          if (blocked(c[0] + wl.n[0] * 0.4, yc, c[2] + wl.n[2] * 0.4, w) || (row === 0 && nearDoor(c[0], c[2]))) return;
          window_([c[0], yc, c[2]], wl.n);
        },
      });
    }
  }

  // front door on a +Z wall at (x, z); y0 = floor level outside (stoop / porch deck); stoop = small concrete step in front
  function door(x, z, y0 = 0.2, stoop = true) {
    doors.push({ x, z });
    g.rect('trim', [x, y0 + 1.1, z], [0, 0, 1], 1.25, 2.3, 0.02); g.rect('door', [x, y0 + 1.05, z], [0, 0, 1], 0.95, 2.1, 0.04);
    if (stoop) g.box('concrete', x - 0.9, x + 0.9, 0, y0, z, z + 1.1, 'bz');
    return { x, z: stoop ? z + 1.1 : z };
  }
  // porch deck across x0..x1 in front of the wall at z, depth d, columns + shed roof at height ry; returns the walk start
  function porch(x0, x1, z, d, ry, doorX) {
    const y0 = 0.45, zf = z + d;
    g.box('trim', x0, x1, 0, y0, z, zf, 'bz', 'deck');
    g.box('concrete', doorX - 0.8, doorX + 0.8, 0, 0.22, zf, zf + 0.35, 'bz');
    const nc = Math.max(2, Math.round((x1 - x0) / 2.6) + 1);
    for (let i = 0; i < nc; i++) { const cx = x0 + 0.2 + i * (x1 - x0 - 0.4) / (nc - 1); if (Math.abs(cx - doorX) > 0.6) g.box('trim', cx - 0.11, cx + 0.11, y0, ry, zf - 0.33, zf - 0.11, 'tb'); }
    g.extrude([[z, ry + 0.5], [zf + 0.25, ry - 0.05]], x0 - 0.1, x1 + 0.1, (a, s, y) => [a, y, s], [1, 0, 0], [0, 0, 1], { skipFirst: true });
    collider.push({ cx: (x0 + x1) / 2, cz: (z + zf) / 2, hu: (x1 - x0) / 2, hv: d / 2, y0: 0, y1: y0 });
    door(doorX, z, y0, false);
    return { x: doorX, z: zf + 0.35 };
  }
  function chimney(x, z, y0, y1) { g.box('brick', x - 0.45, x + 0.45, y0, y1, z - 0.3, z + 0.3, 'b'); }
  // gabled dormers on the front slope of a main wing w (axis x, gable / gambrel)
  function dormers(w, n) {
    const pr = profile(w.roof, (w.z1 - w.z0) / 2, w.h, w.k, w.e), sc = (w.z0 + w.z1) / 2, Y = (z) => interp(pr, z - sc), zf = w.z1 - 0.5, yb = Y(zf) - 0.05, top = yb + 1.25 + 0.6 * 0.9;
    let zb = zf; while (zb > sc && Y(zb) < top + 0.15) zb -= 0.1;
    if (top > Y(sc) - 0.1) return;
    for (let i = 0; i < n; i++) { const x = w.x0 + (i + 0.5) * (w.x1 - w.x0) / n; wing({ x0: x - 0.6, x1: x + 0.6, z0: zb, z1: zf, yb, h: yb + 1.25, roof: 'gable', axis: 'z', k: 0.9, e: 0.15, dormer: true }); }
  }

  // garage on +X: attached (front at zf) or detached at the back corner; returns { wing, x0 (main house must stay left of this), door }
  const gw = W >= 16 ? 6.4 : 3.8, gdw = gw > 5 ? 5 : 2.6;
  function garage(kind, roof, zf = Z1) {
    if (W < 11) return { x0: X1, w: null };
    let w;
    if (kind === 'attached') { const gd = Math.min(6.6, zf - Z0 - 0.4); w = wing({ x0: X1 - gw, x1: X1, z0: zf - gd, z1: zf, h: 2.8, roof, k: 0.4, noWin: true }); }
    else { const gd = Math.min(6.6, D - 3); w = wing({ x0: X1 - gw, x1: X1, z0: Z0, z1: Z0 + gd, h: 2.8, roof, k: 0.4, noWin: true }); }
    garageDoor(w);
    return { x0: kind === 'attached' ? X1 - gw + 0.3 : X1 - gw - 1.6, w };
  }
  let drive = null;
  function garageDoor(w, x = (w.x0 + w.x1) / 2, dw = gdw) {
    g.rect('trim', [x, 1.16, w.z1], [0, 0, 1], dw + 0.24, 2.32, 0.02); g.rect('garageDoor', [x, 1.1, w.z1], [0, 0, 1], dw, 2.2, 0.04);
    drive = { x0: x - dw / 2 - 0.4, x1: x + dw / 2 + 0.4, z: w.z1 };
  }

  // --- variants (main house spans X0..gx, garage on +X) ---
  let walk = null;
  const pz = Math.min(2.4, D * 0.2);   // porch depth
  const ctx = { X0, X1, Z0, Z1, W, D, pz, gdw, wing, porch, door, chimney, dormers, garage, garageDoor, pick, rng, walk: null };
  style.rule(ctx); walk = ctx.walk;
  windows();

  // ground slabs: driveway from the garage door to the street edge, walk from the front door / steps to the street edge (detours onto the driveway if it would cross it)
  if (drive) g.poly('driveway', [[drive.x0, 0.02, drive.z], [drive.x1, 0.02, drive.z], [drive.x1, 0.02, front], [drive.x0, 0.02, front]], [0, 1, 0]);
  if (walk) {
    const x0 = walk.x - 0.6, x1 = walk.x + 0.6;
    if (drive && x1 > drive.x0 && x0 < drive.x1) g.poly('walk', [[x0, 0.04, walk.z], [x1, 0.04, walk.z], [x1, 0.04, walk.z + 1.2], [x0, 0.04, walk.z + 1.2]], [0, 1, 0]);
    else {
      g.poly('walk', [[x0, 0.04, walk.z], [x1, 0.04, walk.z], [x1, 0.04, front], [x0, 0.04, front]], [0, 1, 0]);
    }
  }

  // garden: by seed ~20% bare, else hedge / picket fence along the street edge (gaps for drive + walk) + optional shrubs and a flower bed in front of the house
  const garden = [];
  if (front - hv > 3 && rng(34) >= 0.2) {
    const gAt = (x, z) => spec.groundAt ? spec.groundAt(mirror ? -x : x, z) : 0;
    const gbox = (mat, x0, x1, h, z0, z1, col = true) => {
      const hs = [gAt(x0, z0), gAt(x1, z0), gAt(x0, z1), gAt(x1, z1)], y0 = Math.min(...hs) - 0.05, y1 = Math.max(...hs) + h;
      g.box(mat, x0, x1, y0, y1, z0, z1, 'b'); garden.push({ mat, x0, x1, z0, z1, y0, y1, col });
    };
    const bl = [drive && [drive.x0, drive.x1], walk && [walk.x - 0.6, walk.x + 0.6]].filter(Boolean).map(([a, b]) => [a - 0.5, b + 0.5]);
    const free = (a, b) => bl.reduce((s, [p, q]) => s.flatMap(([u, v]) => [[u, Math.min(v, p)], [Math.max(u, q), v]]).filter(([u, v]) => v - u > 0.5), [[a, b]]);
    const t = rng(35), zf = front - 0.6;
    if (t < 0.5) for (const [a, b] of free(-hu + 0.3, hu - 0.3)) gbox('hedge', a, b, 0.8 + rng(36) * 0.4, zf - 0.35, zf + 0.35);
    else if (t < 0.75) for (const [a, b] of free(-hu + 0.3, hu - 0.3)) {
      gbox('fence', a, b, 0.9, zf - 0.02, zf + 0.02);
      const n = Math.max(1, Math.round((b - a) / 2)); for (let i = 0; i <= n; i++) { const x = a + i * (b - a) / n; gbox('fence', x - 0.06, x + 0.06, 1.05, zf - 0.06, zf + 0.06, false); }
    }
    if (rng(37) < 0.35) for (const [a, b] of free(-hu + 0.5, hu - 0.5)) gbox('flower', a, b, 0.25, hv + 0.1, hv + 0.6, false);
    for (let i = 0, n = 2 + Math.floor(rng(38) * 4); i < n; i++) {
      const r = 0.35 + rng(40 + i) * 0.3, x = -hu + 0.8 + rng(50 + i) * (2 * hu - 1.6);
      if (bl.some(([p, q]) => x + r > p && x - r < q)) continue;
      gbox('shrub', x - r, x + r, 0.6 + rng(60 + i) * 0.5, hv + 0.7, hv + 0.7 + 2 * r);
    }
  }

  const prims = g.prims();
  if (mirror) for (const p of prims) {
    for (let i = 0; i < p.pos.length; i += 3) { p.pos[i] = -p.pos[i]; p.nor[i] = -p.nor[i]; }
    for (let i = 0; i < p.uv.length; i += 2) p.uv[i] = -p.uv[i];
    for (let i = 0; i < p.idx.length; i += 3) { const t = p.idx[i + 1]; p.idx[i + 1] = p.idx[i + 2]; p.idx[i + 2] = t; }
  }
  if (mirror) for (const c of collider) c.cx = -c.cx;
  if (mirror) for (const b of garden) [b.x0, b.x1] = [-b.x1, -b.x0];
  let H = 0, tris = 0;
  for (const p of prims) { tris += p.idx.length / 3; for (let i = 1; i < p.pos.length; i += 3) H = Math.max(H, p.pos[i]); }
  return { prims, W: 2 * hu, D: 2 * hv, H, tris, variant, collider, garden };
}
