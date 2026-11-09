// Procedural modular buildings assembled from the pieces of public/city/city.glb (pure: no THREE, runs in Node; the renderer is cityFill.js).
//
//   planBuilding(spec, triOf?, maxTris?) -> { pieces: [{ n, x, y, z, r, role, face, w }], W, D, floors, H, tris }   building-local coordinates:
//        pivot = centre of the facade plane at ground level, facade normal = local +Z (like the whole buildings), the body spans x in [-W/2, W/2], z in [-D, 0], y in [0, H].
//        piece = GLB node name placed with its authored pivot at (x, y, z) and rotated r radians about Y (three: x' = x cos r + z sin r, z' = -x sin r + z cos r).
//   planProxy({ x0, x1, zb, h }) -> [{ n, x, y, z, r, sx, sy, sz }]   the cheap far LOD: plain brick wall pieces on the front and both sides + a flat roof, set 0.3 m INSIDE the real surfaces
//   spec = { W, D, floors, up, gr, cor, cols, seed }   W, D even metres; floors 3..8 (incl. the ground floor); up / gr = family of the upper / ground floors ('brick' | 'metal' | 'trim');
//        cor = cornice family or 'none'; cols = corner columns on the street corners.
//
// MEASURED PIECE FACTS (public/city/city.glb, authored pivots, checked with @gltf-transform getBounds): wall / window / door / cornice pieces are 2 m (x -1..1) or 4 m (x -2..2) wide, wall
// pieces 3 m tall with the street face at z = 0 and the body 0.2 m behind it; cornices stand on top (1 m tall; Trim ones overhang 0.53 m); Roof_2x2 is a horizontal quad at y = -0.2;
// Brick_CornerColumn_* are 1.14 m piers whose outer corner is at (+0.17, +0.17) (mirror = rotate -90 degrees); Metal / Trim columns are square, centred on the pivot.
// LAYOUT. One 2 m unit grid along each face. Front: the two end units are plain wall (the corner piers cover them), interior units are windows (2 m units, or 4 m pieces covering two units
// where the style has them), ground floor = shopfront windows + one door. Left / right / back faces are plain brick wall (3 m per floor). Pieces never overlap
// (every unit of every floor row is covered exactly once); corner columns / cornice / roof sit proud or on top (columns are shifted 2 cm outwards so they do not z-fight the side wall).
import { hash } from './scatterGen.js';

export const FLOOR_H = 3;
export const FAMILY = {
  brick: { wall: ['Brick_Plain_3', 'Brick_Plain_3_noWear'], win2: ['Brick_Window_Trim', 'Brick_Window_Trim_Single', 'Brick_Window_Square_Single'], win4: ['Brick_Inset_Window', 'Brick_Inset_Window_Curved_Small', 'Brick_RedWhite_DoubleWindow'],
    cornice: 'Cornice_Brick_Center', col: { kind: 'corner', bottom: 'Brick_CornerColumn_Bottom', mid: 'Brick_CornerColumn_Center', top: 'Brick_CornerColumn_Top', off: 0.17 } },
  metal: { wall: ['Metal_Plain_3'], win2: ['Metal_FullWindow', 'Metal_Window_Half'], win4: ['Metal_Window'],
    cornice: 'Cornice_Metal_Center', col: { kind: 'square', bottom: 'Metal_Column_Bottom', mid: 'Metal_Column_Center', top: 'Metal_Column_Top', off: 0.25 } },
  trim: { wall: ['Trim_Plain_3'], win2: ['Trim_Window'], win4: [],
    cornice: 'Cornice_Trim_Center', col: { kind: 'square', bottom: 'Trim_Column_Bottom', mid: 'Trim_Column_Center', top: 'Trim_Column_Top', off: 0.34 } },
};
export const GROUND = {
  brick: { win: ['Trim_FirstFloor_Window_001'], wall: 'Trim_FirstFloor_Wall', door: ['DoorFrame_Trim', 'DoorFrame_Wooden'] },
  metal: { win: ['Metal_FirstFloor_Window'], wall: 'Metal_FirstFloor_Wall', door: ['DoorFrame_Metal_Single'] },
  trim: { win: ['Trim_FirstFloor_Window_001'], wall: 'Trim_FirstFloor_Wall', door: ['DoorFrame_Wooden', 'DoorFrame_Trim'] },
};
export const FAMILIES = Object.keys(FAMILY);
const WIDE = new Set(Object.values(FAMILY).flatMap((f) => f.win4));
export const pieceWidth = (n) => (WIDE.has(n) ? 4 : 2);
export const kitPieceNames = () => {
  const s = new Set(['Brick_Plain_3', 'Roof_2x2']);
  for (const f of Object.values(FAMILY)) { f.wall.forEach((n) => s.add(n)); f.win2.forEach((n) => s.add(n)); f.win4.forEach((n) => s.add(n)); s.add(f.cornice); s.add(f.col.bottom); s.add(f.col.mid); s.add(f.col.top); }
  for (const g of Object.values(GROUND)) { g.win.forEach((n) => s.add(n)); s.add(g.wall); g.door.forEach((n) => s.add(n)); }
  return [...s];
};

const SIDE = FAMILY.brick.wall;   // side + back walls are plain brick whatever the street style (cheap: 6 tris per 2 x 3 m)
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

export function planBuilding(spec, triOf = () => 300, maxTris = 15000) {
  const { W, D, floors: F, seed } = spec, fam = FAMILY[spec.up], gfam = GROUND[spec.gr], rng = (k) => hash(seed, k, 0, 77);
  const n = W / 2, nD = D / 2, pieces = [], ux = (u) => -W / 2 + 1 + 2 * u;
  const add = (p) => pieces.push({ x: 0, y: 0, z: 0, r: 0, w: 2, ...p });
  // upper cells: [{ u, w }] in units; the two end units are plain
  const cells = [{ u: 0, w: 1 }];
  for (let i = 1; i <= n - 2;) { if (fam.win4.length && i + 1 <= n - 2 && rng(100 + i) < 0.45) { cells.push({ u: i, w: 2 }); i += 2; } else { cells.push({ u: i, w: 1 }); i++; } }
  cells.push({ u: n - 1, w: 1 });
  const doorU = 1 + Math.floor(rng(5) * (n - 2)), door2 = n >= 10 ? (n - 1 - doorU) : -1;   // wide buildings get a second door, mirrored
  for (let f = 0; f < F; f++) {
    const y = f * FLOOR_H;
    if (f === 0) {
      for (let u = 0; u < n; u++) {
        const nm = (u === 0 || u === n - 1) ? gfam.wall : (u === doorU || u === door2) ? pick(gfam.door, rng(6 + u)) : pick(gfam.win, rng(20 + u));
        add({ n: nm, x: ux(u), y, z: 0, role: 'wall', face: 'front', w: 2 });
      }
    } else {
      cells.forEach((c, ci) => {
        const cx = -W / 2 + 2 * (c.u + c.w / 2), end = ci === 0 || ci === cells.length - 1, blank = !end && rng(1000 + f * 64 + ci) < 0.08;
        const nm = end || blank ? pick(fam.wall, rng(300 + f)) : c.w === 2 ? pick(fam.win4, rng(200 + ci)) : pick(fam.win2, rng(250 + ci));
        add({ n: nm, x: cx, y, z: 0, role: 'wall', face: 'front', w: end || blank ? 2 * c.w : pieceWidth(nm) });
        if ((end || blank) && c.w === 2) { pieces.pop(); add({ n: nm, x: cx - 1, y, z: 0, role: 'wall', face: 'front', w: 2 }); add({ n: nm, x: cx + 1, y, z: 0, role: 'wall', face: 'front', w: 2 }); }
      });
    }
    // plain brick side + back walls
    for (let j = 0; j < nD; j++) {
      add({ n: pick(SIDE, rng(400 + f * 32 + j)), x: -W / 2, y, z: -1 - 2 * j, r: -Math.PI / 2, role: 'wall', face: 'left' });
      add({ n: pick(SIDE, rng(500 + f * 32 + j)), x: W / 2, y, z: -1 - 2 * j, r: Math.PI / 2, role: 'wall', face: 'right' });
    }
    for (let u = 0; u < n; u++) add({ n: pick(SIDE, rng(600 + f * 32 + u)), x: ux(u), y, z: -D, r: Math.PI, role: 'wall', face: 'back' });
  }
  if (spec.cols) { // corner columns on the two street corners, bottom / mid / top piece per floor, 2 cm outward (no coplanar faces with the side walls)
    const c = fam.col;
    for (let f = 0; f < F; f++) {
      const nm = F > 1 && f === F - 1 ? c.top : f === 0 ? c.bottom : c.mid;
      if (c.kind === 'corner') { const o = W / 2 - c.off + 0.02; add({ n: nm, x: o, y: f * FLOOR_H, z: 0.02, r: 0, role: 'col', face: 'front' }); add({ n: nm, x: -o, y: f * FLOOR_H, z: 0.02, r: -Math.PI / 2, role: 'col', face: 'front' }); }
      else { const o = W / 2 - c.off + 0.02; add({ n: nm, x: o, y: f * FLOOR_H, z: 0.02, role: 'col', face: 'front' }); add({ n: nm, x: -o, y: f * FLOOR_H, z: 0.02, role: 'col', face: 'front' }); }
    }
  }
  if (spec.cor !== 'none') for (let u = 0; u < n; u++) add({ n: FAMILY[spec.cor].cornice, x: ux(u), y: F * FLOOR_H, z: 0, role: 'cornice', face: 'front' });
  for (let j = 0; j < nD; j++) for (let u = 0; u < n; u++) add({ n: 'Roof_2x2', x: ux(u), y: F * FLOOR_H + 0.2, z: -1 - 2 * j, role: 'roof', face: 'roof' });
  // triangle budget: swap the most expensive windows for the cheapest of the family until the building fits
  const total = () => pieces.reduce((s, p) => s + triOf(p.n), 0);
  let tris = total();
  if (tris > maxTris) {
    const cheap2 = [...fam.win2].sort((x, y) => triOf(x) - triOf(y))[0], front = () => pieces.filter((q) => q.role === 'wall' && q.face === 'front' && q.y > 0 && triOf(q.n) > 250 && !fam.wall.includes(q.n)).sort((x, y) => triOf(y.n) - triOf(x.n));
    for (const p of front()) { // 4 m pieces -> two cheap 2 m windows, 2 m windows -> the cheapest of the family
      if (tris <= maxTris) break;
      if (p.w === 4) { pieces.splice(pieces.indexOf(p), 1, { ...p, n: cheap2, x: p.x - 1, w: 2 }, { ...p, n: cheap2, x: p.x + 1, w: 2 }); } else if (triOf(cheap2) < triOf(p.n)) p.n = cheap2;
      tris = total();
    }
    for (const p of front().concat(pieces.filter((q) => q.role === 'wall' && q.face === 'front' && q.y > 0 && triOf(q.n) > 100 && !fam.wall.includes(q.n)))) { // still too heavy: plain wall
      if (tris <= maxTris) break;
      p.n = FAMILY.brick.wall[0]; tris = total();
    }
  }
  return { pieces, W, D, floors: F, H: F * FLOOR_H + (spec.cor !== 'none' ? 1 : 0), tris: total() };
}

// far proxy: front + left + right walls of plain brick pieces 0.3 m inside the real surfaces, flat roof 0.3 m below the real roof. x0..x1 = facade extent, zb = back (negative), h = height.
// The wall pieces are stretched PROXY_STRETCH times (4 x 6 m cells instead of 2 x 3 m: bricks look twice as big, which nobody sees beyond ~120 m) to keep the triangle count low.
export const PROXY_STRETCH = 2;
export function planProxy({ x0, x1, zb, h }) {
  const IN = 0.3, S = PROXY_STRETCH, cw = 2 * S, ch = FLOOR_H * S, out = [], nx = Math.max(1, Math.round((x1 - x0) / cw)), sx = (x1 - x0) / (2 * nx), Fp = Math.max(1, Math.round(h / ch)), sy = h / (FLOOR_H * Fp), Dp = -zb, nz = Math.max(1, Math.round(Dp / cw)), sz = Dp / (2 * nz);
  for (let f = 0; f < Fp; f++) {
    for (let u = 0; u < nx; u++) out.push({ n: 'Brick_Plain_3', x: x0 + sx * (2 * u + 1), y: f * FLOOR_H * sy, z: -IN, r: 0, sx, sy, sz: 1 });
    for (let j = 0; j < nz; j++) {
      out.push({ n: 'Brick_Plain_3', x: x1 - IN, y: f * FLOOR_H * sy, z: -sz * (2 * j + 1), r: Math.PI / 2, sx: sz, sy, sz: 1 });
      out.push({ n: 'Brick_Plain_3', x: x0 + IN, y: f * FLOOR_H * sy, z: -sz * (2 * j + 1), r: -Math.PI / 2, sx: sz, sy, sz: 1 });
    }
  }
  for (let j = 0; j < nz; j++) for (let u = 0; u < nx; u++) out.push({ n: 'Roof_2x2', x: x0 + sx * (2 * u + 1), y: h - IN + 0.2, z: -sz * (2 * j + 1), r: 0, sx, sy: 1, sz });
  return out;
}
