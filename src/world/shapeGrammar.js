// Generic CGA-style split grammar for low-poly procedural buildings (pure: no THREE, runs in Node). Styles live in their own files (houseKit.js); this is the reusable engine.
//
//   new Mesh(colours) -> builder with one primitive per material key: poly(mat, pts, outwardHint), box(...), rect(...), extrude(profile, ...); prims() -> [{ mat, pos, nor, uv, idx, cs: 3, col }]
//        typed arrays (Float32Array / Uint16|32Array), uv in metres projected on each face plane, winding checked against the outward hint, per-vertex colour = colours[mat].
//   split(total, parts) -> [{ u0, u1, part, i }]     the split rule. parts: { fix: m } fixed size, { rel: w } share of the rest, { rep: m, odd? } repeat a cell of ~m metres
//        as often as fits (odd forces an odd count, for symmetric facades with a centre bay). Deterministic, no backtracking: fixed first, then repeats, then relatives.
//   mass(g, m) -> m with .walls / .top                extrude rule: a box mass (x0..x1, z0..z1, walls from yb to eave h) + its roof rule:
//        'gable' | 'gambrel' | 'saltbox' (cross-section profile extruded along the ridge axis 'x' | 'z'), 'hip', 'flat', 'none'. Roofs are slabs (top 'roof', soffit + edges 'trim').
//        each wall = { pt(u, y) -> [x, y, z], u0, u1, n (outward), top(u) -> wall top height at u, rows (floor rows incl. gable attic), front (faces +Z) }.
//   facade(wall, { yb, floorH, rows, bays(row) -> parts, insert(cell) })   facade rule: wall -> floors -> bays (split) -> tile; insert gets { wall, row, u, y, c (centre point), w, i, n }.
//   profile(roof, hs, h, k, e) / interp(profile, s)   the roof cross-sections (relative to the mass centre line, +s = front for axis 'x').
//   g.band(mat, a, b, y0, y1, cellW, cellH)            one-quad facade band with uv in window cells (bays x storeys) for windows-in-texture towers (towerKit / rowKit LOD).
export class Mesh {
  constructor(col) { this.p = new Map(); this.col = col; }
  poly(mat, pts, hint) {
    const q = [];
    for (const v of pts) { const l = q[q.length - 1]; if (!l || Math.abs(l[0] - v[0]) + Math.abs(l[1] - v[1]) + Math.abs(l[2] - v[2]) > 1e-6) q.push(v); }
    while (q.length > 2 && Math.abs(q[0][0] - q[q.length - 1][0]) + Math.abs(q[0][1] - q[q.length - 1][1]) + Math.abs(q[0][2] - q[q.length - 1][2]) < 1e-6) q.pop();
    if (q.length < 3) return;
    let nx = 0, ny = 0, nz = 0;   // Newell normal
    for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    const l = Math.hypot(nx, ny, nz); if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { q.reverse(); nx = -nx; ny = -ny; nz = -nz; }
    let tx = 1, tz = 0;
    if (Math.abs(ny) < 0.99) { const h = Math.hypot(nz, nx); tx = nz / h; tz = -nx / h; }
    const bx = ny * tz, by = nz * tx - nx * tz, bz = -ny * tx;   // b = n x t
    let a = this.p.get(mat); if (!a) this.p.set(mat, a = { mat, pos: [], nor: [], uv: [], idx: [], cs: 3, col: [] });
    const base = a.pos.length / 3, c = this.col[mat];
    for (const v of q) { a.pos.push(v[0], v[1], v[2]); a.nor.push(nx, ny, nz); a.uv.push(v[0] * tx + v[2] * tz, v[0] * bx + v[1] * by + v[2] * bz); a.col.push(c[0], c[1], c[2]); }
    for (let i = 1; i < q.length - 1; i++) a.idx.push(base, base + i, base + i + 1);
  }
  // axis-aligned box; omit = string of faces to skip ('t' top, 'b' bottom, 'x' -x, 'X' +x, 'z' -z, 'Z' +z)
  box(mat, x0, x1, y0, y1, z0, z1, omit = 'b', top = mat) {
    const f = (k, pts, h) => { if (!omit.includes(k)) this.poly(k === 't' ? top : mat, pts, h); };
    f('t', [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
    f('b', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    f('x', [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]);
    f('X', [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
    f('z', [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
    f('Z', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  }
  // vertical rectangle centred at c on a wall with outward horizontal normal n, pushed d metres out
  rect(mat, c, n, w, h, d) {
    const tx = n[2], tz = -n[0], ox = c[0] + n[0] * d, oz = c[2] + n[2] * d, hw = w / 2, hh = h / 2;
    this.poly(mat, [[ox - tx * hw, c[1] - hh, oz - tz * hw], [ox + tx * hw, c[1] - hh, oz + tz * hw], [ox + tx * hw, c[1] + hh, oz + tz * hw], [ox - tx * hw, c[1] + hh, oz - tz * hw]], n);
  }
  // rect() with explicit uv: [u0, v0, u1, v1] spans the rect left->right (seen from outside) / bottom->top, e.g. whole texture cells for ground-floor glass
  rectUV(mat, c, n, w, h, d, [u0, v0, u1, v1]) {
    const a = this.p.get(mat), start = a ? a.pos.length : 0;
    this.rect(mat, c, n, w, h, d);
    const p = this.p.get(mat), tx = n[2], tz = -n[0];
    for (let i = start; i < p.pos.length; i += 3) {
      const s = ((p.pos[i] - c[0]) * tx + (p.pos[i + 2] - c[2]) * tz) / w + 0.5, t = (p.pos[i + 1] - c[1]) / h + 0.5;
      p.uv[(i / 3) * 2] = u0 + (u1 - u0) * Math.round(s); p.uv[(i / 3) * 2 + 1] = v0 + (v1 - v0) * Math.round(t);
    }
  }
  // roof slab extruded along a in [a0, a1] from a cross-section [[s, y]] (ascending s); map(a, s, y) -> [x, y, z]
  extrude(pts, a0, a1, map, aDir, sDir, { t = 0.12, skipFirst = false } = {}) {
    const up = [0, 1, 0], dn = [0, -1, 0], neg = (v) => [-v[0], -v[1], -v[2]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [s, y] = pts[i], [s2, y2] = pts[i + 1];
      this.poly('roof', [map(a0, s, y), map(a1, s, y), map(a1, s2, y2), map(a0, s2, y2)], up);
      this.poly('trim', [map(a0, s, y - t), map(a1, s, y - t), map(a1, s2, y2 - t), map(a0, s2, y2 - t)], dn);
      for (const [a, h] of [[a0, neg(aDir)], [a1, aDir]]) this.poly('trim', [map(a, s, y), map(a, s2, y2), map(a, s2, y2 - t), map(a, s, y - t)], h);
    }
    const ends = skipFirst ? [[pts[pts.length - 1], sDir]] : [[pts[0], neg(sDir)], [pts[pts.length - 1], sDir]];
    for (const [[s, y], h] of ends) this.poly('trim', [map(a0, s, y), map(a1, s, y), map(a1, s, y - t), map(a0, s, y - t)], h);
  }
  // windows-in-texture facade band: ONE vertical quad from a=[x,z] to b=[x,z] (a->b runs left to right as seen from outside; n = (az-bz, 0, bx-ax)/len), heights y0..y1,
  // uv in CELLS instead of metres: u = 0..round(len / cellW) (whole window bays), v = 0..(y1 - y0) / cellH (floors), so a window texture tiles one bay x one storey per uv unit.
  band(mat, a, b, y0, y1, cellW, cellH) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); if (l < 1e-6 || y1 - y0 < 1e-6) return;
    const nx = -dz / l, nz = dx / l, U = Math.max(1, Math.round(l / cellW)), V = (y1 - y0) / cellH;
    let p = this.p.get(mat); if (!p) this.p.set(mat, p = { mat, pos: [], nor: [], uv: [], idx: [], cs: 3, col: [] });
    const base = p.pos.length / 3, c = this.col[mat], [ou, ov] = this.uvOff || [0, 0];   // uvOff (optional, whole cells): per-building texture phase
    for (const [x, y, z, u, v] of [[a[0], y0, a[1], 0, 0], [b[0], y0, b[1], U, 0], [b[0], y1, b[1], U, V], [a[0], y1, a[1], 0, V]]) { p.pos.push(x, y, z); p.nor.push(nx, 0, nz); p.uv.push(u + ou, v + ov); p.col.push(c[0], c[1], c[2]); }
    p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  prims() {
    return [...this.p.values()].map((a) => ({ mat: a.mat, cs: 3, pos: Float32Array.from(a.pos), nor: Float32Array.from(a.nor), uv: Float32Array.from(a.uv), col: Float32Array.from(a.col), idx: a.pos.length / 3 > 65535 ? Uint32Array.from(a.idx) : Uint16Array.from(a.idx) }));
  }
}

export const interp = (pts, s) => {
  for (let i = 0; i + 1 < pts.length; i++) { const [s0, y0] = pts[i], [s1, y1] = pts[i + 1]; if (s <= s1 || i + 2 === pts.length) return y0 + (y1 - y0) * (s - s0) / (s1 - s0); }
  return pts[0][1];
};

// cross-section of a roof relative to the wing centre line (s across the ridge, +s = front for axis 'x'), eave height h at the walls
export function profile(roof, hs, h, k, e) {
  if (roof === 'gable') return [[-hs - e, h - e * k], [0, h + hs * k], [hs + e, h - e * k]];
  if (roof === 'gambrel') { const k1 = 1.7, k2 = 0.45, b = 0.4, y1 = h + b * hs * k1, y2 = y1 + (1 - b) * hs * k2; return [[-hs - e, h - e * k1], [-(1 - b) * hs, y1], [0, y2], [(1 - b) * hs, y1], [hs + e, h - e * k1]]; }
  if (roof === 'saltbox') { const sr = 0.3 * hs, peak = h + (hs - sr) * k, yr = peak - (hs + sr) * k; return [[-hs - e, yr - e * k], [sr, peak], [hs + e, h - e * k]]; }
  return null;
}


export function split(total, parts) {
  let fixed = 0, rel = 0;
  for (const p of parts) { if (p.fix) fixed += p.fix; else if (p.rel) rel += p.rel; }
  const free = Math.max(0, total - fixed), counts = parts.map((p) => {
    if (!p.rep) return 0;
    let n = Math.floor(free / p.rep); if (p.odd && n > 0 && n % 2 === 0) n--; return n;
  });
  const repW = counts.reduce((s, n, i) => s + n * (parts[i].rep || 0), 0), scale = rel ? 1 : (repW > 0 ? free / repW : 0), relW = rel ? (free - repW) / rel : 0;
  const out = []; let u = 0;
  parts.forEach((p, k) => {
    if (p.fix) { out.push({ u0: u, u1: u + p.fix, part: p, i: 0 }); u += p.fix; }
    else if (p.rel) { out.push({ u0: u, u1: u + p.rel * relW, part: p, i: 0 }); u += p.rel * relW; }
    else for (let i = 0; i < counts[k]; i++) { const w = p.rep * scale; out.push({ u0: u, u1: u + w, part: p, i, n: counts[k] }); u += w; }
  });
  return out;
}

// m = { x0, x1, z0, z1, yb = 0, h, roof, axis = 'x', k (pitch), e (eave), wall (material), floors }
export function mass(g, m) {
  m = { yb: 0, floors: 1, roof: 'gable', axis: 'x', k: 0.5, e: 0.4, wall: 'siding', ...m };
  if (m.roof === 'hip') m.axis = (m.x1 - m.x0) >= (m.z1 - m.z0) ? 'x' : 'z';
  const ax = m.axis === 'x', a0 = ax ? m.x0 : m.z0, a1 = ax ? m.x1 : m.z1, s0 = ax ? m.z0 : m.x0, s1 = ax ? m.z1 : m.x1, hs = (s1 - s0) / 2, sc = (s0 + s1) / 2;
  const map = ax ? (a, s, y) => [a, y, s] : (a, s, y) => [s, y, a], aDir = ax ? [1, 0, 0] : [0, 0, 1], sDir = ax ? [0, 0, 1] : [1, 0, 0];
  const pr = profile(m.roof, hs, m.h, m.k, m.e), wallPr = pr || [[-hs, m.h], [hs, m.h]], Y = (s) => interp(wallPr, s - sc);
  m.top = pr ? Math.max(...pr.map((p) => p[1])) : m.roof === 'hip' ? m.h + Math.min(hs, (a1 - a0) / 2) * m.k : m.roof === 'flat' ? m.h + 0.35 : m.h;
  const walls = [];
  for (const [s, sg] of [[s0, -1], [s1, 1]]) {
    const n = sDir.map((v) => v * sg);
    g.poly(m.wall, [map(a0, s, m.yb), map(a1, s, m.yb), map(a1, s, Y(s)), map(a0, s, Y(s))], n);
    walls.push({ pt: (u, y) => map(u, s, y), u0: a0, u1: a1, n, top: () => Y(s), rows: m.floors, front: ax && sg > 0 });
  }
  const inner = wallPr.filter((p) => p[0] > -hs + 1e-6 && p[0] < hs - 1e-6).map((p) => [p[0] + sc, p[1]]).reverse();
  for (const [a, sg] of [[a0, -1], [a1, 1]]) {
    const n = aDir.map((v) => v * sg);
    g.poly(m.wall, [[s0, m.yb], [s1, m.yb], [s1, Y(s1)], ...inner, [s0, Y(s0)]].map(([s, y]) => map(a, s, y)), n);
    walls.push({ pt: (u, y) => map(a, u, y), u0: s0, u1: s1, n, top: Y, rows: m.floors + (pr ? 1 : 0), front: !ax && sg > 0 });
  }
  if (pr) g.extrude(pr.map(([s, y]) => [s + sc, y]), a0 - 0.2, a1 + 0.2, map, aDir, sDir);
  else if (m.roof === 'hip') {
    const A = (a1 - a0) / 2 + m.e, B = hs + m.e, ac = (a0 + a1) / 2, ye = m.h - m.e * m.k, rl = Math.max(0, A - B), yr = ye + B * m.k, t = 0.12;
    for (const [dy, tag] of [[0, 'roof'], [-t, 'trim']]) {
      const P = (a, s, y) => map(ac + a, sc + s, y + dy), c00 = P(-A, -B, ye), c10 = P(A, -B, ye), c11 = P(A, B, ye), c01 = P(-A, B, ye), r0 = P(-rl, 0, yr), r1 = P(rl, 0, yr), h = dy ? [0, -1, 0] : [0, 1, 0];
      g.poly(tag, [c00, c10, r1, r0], h); g.poly(tag, [c01, c11, r1, r0], h); g.poly(tag, [c00, c01, r0], h); g.poly(tag, [c10, c11, r1], h);
    }
    const ex = ax ? A : B, ez = ax ? B : A, cx = (m.x0 + m.x1) / 2, cz = (m.z0 + m.z1) / 2;
    g.box('trim', cx - ex, cx + ex, ye - t, ye, cz - ez, cz + ez, 'tb');
  } else if (m.roof === 'flat') g.box('trim', m.x0 - 0.15, m.x1 + 0.15, m.h, m.h + 0.35, m.z0 - 0.15, m.z1 + 0.15, '', 'roofFlat');
  m.walls = walls;
  return m;
}

export function facade(wall, { yb = 0, floorH = 2.8, rows = wall.rows, bays, insert }) {
  for (let row = 0; row < rows; row++) {
    const y = yb + row * floorH;
    for (const c of split(wall.u1 - wall.u0, bays(row, wall))) {
      if (!c.part.tile) continue;
      const u = wall.u0 + (c.u0 + c.u1) / 2;
      insert({ wall, row, u, y, c: wall.pt(u, y), w: c.u1 - c.u0, i: c.i, n: c.n, tile: c.part.tile });
    }
  }
}
