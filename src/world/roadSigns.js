// Automatic warning signs: detection (pure geometry, runs in Node) + procedural rendering (instanced, canvas textures).
// No model files. THREE / RAPIER are injected like everywhere in src/world.
//
// Detection works per road and per travel direction on the road's ~1 m polyline (roads.js polyOf):
//   curves  : a curve is a stretch whose heading rate exceeds CURVE_RATE_DEG_PER_M; it counts when the heading changes by at least
//             CURVE_MIN_DEG within CURVE_WINDOW_M. "Sharp" = >= SHARP_DEG within the window or radius < SHARP_RADIUS_M.
//             Opposite curves following within SBEND_GAP_M are one 'winding' sign.
//   hills   : the average grade over HILL_MIN_LEN_M is >= HILL_MIN_GRADE (from the road y profile) -> hillUp / hillDown + grade %.
//   placing : SIGN_BEFORE_M before the start of the section, along the road in the direction of travel, on the driver's side
//             (driveSide), at halfWidth + SHOULDER_OFFSET from the centreline (further out behind an edge fence / rail / lamp row),
//             facing oncoming traffic. Skipped / slid back up to SLIDE_BACK_M when inside a junction disc, on a bridge, on a
//             non-country stretch or where signs are 'off'. MIN_SPACING_M between signs of one road+direction.
import { polyOf } from './roads.js';
import { inJunction, instancedMesh } from './roadGeo.js';

export const SIGN_CFG = Object.freeze({
  CURVE_RATE_DEG_PER_M: 0.3, CURVE_MERGE_GAP_M: 20, CURVE_MIN_DEG: 25, CURVE_WINDOW_M: 90, SHARP_DEG: 70, SHARP_RADIUS_M: 30, SBEND_GAP_M: 120,
  HILL_MIN_GRADE: 0.09, HILL_MIN_LEN_M: 60,
  SIGN_BEFORE_M: 55, SLIDE_BACK_M: 15, MIN_SPACING_M: 40, SHOULDER_OFFSET: 0.7, RATE_HALF_WINDOW_M: 5,
  EDGE_OFFSET: { fence: 0.6, guardrail: 0.6, barrier: 0.55, lamps: 0.9 }, // lateral offset of each edge type from the asphalt edge (shared with roadEdges.js)
  EDGE_CLEARANCE: 0.9, // sign sits this much further out when an edge object is on its side
});
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ detection
function dirView(P, dir) {
  const n = P.n, L = P.s[n - 1], ix = (k) => (dir > 0 ? k : n - 1 - k);
  const s = new Float64Array(n), phi = new Float64Array(n), y = new Float64Array(n);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const i = ix(k); s[k] = dir > 0 ? P.s[i] : L - P.s[i]; y[k] = P.y[i];
    let a = Math.atan2(dir * P.tz[i], dir * P.tx[i]);
    if (k) { while (a - prev > Math.PI) a -= 2 * Math.PI; while (a - prev < -Math.PI) a += 2 * Math.PI; }
    phi[k] = a; prev = a;
  }
  return { n, ix, s, phi, y, L };
}
const lowerBound = (s, from, target) => { let k = from; while (k < s.length - 1 && s[k] < target) k++; return k; };

// -> [{ kind:'curve'|'hill', trigger (m along travel), type, grade?, sharp? }] sorted by trigger. phi increases clockwise seen from above
// (x east, z south), i.e. a RIGHT turn for the traveller.
function findSections(v) {
  const C = SIGN_CFG, { n, s, phi, y } = v, out = [];
  // --- heading rate over +-RATE_HALF_WINDOW_M
  const rate = new Float64Array(n);
  for (let k = 0, a = 0, b = 0; k < n; k++) {
    while (a < k && s[k] - s[a] > C.RATE_HALF_WINDOW_M) a++;
    while (b < n - 1 && s[b] - s[k] < C.RATE_HALF_WINDOW_M) b++;
    rate[k] = b > a ? (phi[b] - phi[a]) / (s[b] - s[a]) : 0; // rad per m
  }
  const thr = C.CURVE_RATE_DEG_PER_M * DEG, curves = [];
  let cur = null, gapStart = -1;
  const close = () => { if (cur) curves.push(cur); cur = null; };
  for (let k = 0; k < n; k++) {
    const r = rate[k], sg = Math.abs(r) > thr ? Math.sign(r) : 0;
    if (sg) {
      if (cur && cur.sg === sg) { cur.k1 = k; gapStart = -1; }
      else { close(); cur = { sg, k0: k, k1: k }; gapStart = -1; }
    } else if (cur) { if (gapStart < 0) gapStart = k; if (s[k] - s[cur.k1] > C.CURVE_MERGE_GAP_M) close(); }
  }
  close();
  const acc = [];
  for (const c of curves) {
    const a = Math.max(0, lowerBound(s, 0, s[c.k0] - C.RATE_HALF_WINDOW_M)), b = Math.min(n - 1, lowerBound(s, c.k1, s[c.k1] + C.RATE_HALF_WINDOW_M));
    let best = 0, rmax = 0;
    for (let k = a, j = a; k <= b; k++) {
      if (j < k) j = k; while (j < b && s[j] - s[k] < C.CURVE_WINDOW_M) j++;
      best = Math.max(best, Math.abs(phi[j] - phi[k]));
    }
    for (let k = c.k0; k <= c.k1; k++) rmax = Math.max(rmax, Math.abs(rate[k]));
    if (best < C.CURVE_MIN_DEG * DEG) continue;
    acc.push({ sg: c.sg, s0: s[c.k0], s1: s[c.k1], sharp: best >= C.SHARP_DEG * DEG || (rmax > 0 && 1 / rmax < C.SHARP_RADIUS_M) });
  }
  for (let i = 0; i < acc.length; i++) { // S-bend / winding: opposite curves within SBEND_GAP_M -> one sign at the first
    let j = i;
    while (j + 1 < acc.length && acc[j + 1].sg !== acc[j].sg && acc[j + 1].s0 - acc[j].s1 <= C.SBEND_GAP_M) j++;
    if (j > i) { out.push({ kind: 'curve', type: 'winding', trigger: acc[i].s0 }); i = j; continue; }
    const c = acc[i]; out.push({ kind: 'curve', type: (c.sharp ? 'sharp' : 'curve') + (c.sg < 0 ? 'L' : 'R'), trigger: c.s0, sharp: c.sharp });
  }
  // --- hills: average grade over HILL_MIN_LEN_M
  const g = new Float64Array(n);
  for (let k = 0, j = 0; k < n; k++) {
    if (j < k) j = k; while (j < n - 1 && s[j] - s[k] < C.HILL_MIN_LEN_M) j++;
    g[k] = s[j] - s[k] >= C.HILL_MIN_LEN_M - 1e-6 ? (y[j] - y[k]) / (s[j] - s[k]) : 0;
  }
  for (let k = 0; k < n; k++) {
    const sg = Math.abs(g[k]) >= C.HILL_MIN_GRADE ? Math.sign(g[k]) : 0; if (!sg) continue;
    let e = k; while (e + 1 < n && Math.sign(g[e + 1]) === sg && Math.abs(g[e + 1]) >= C.HILL_MIN_GRADE) e++;
    const endK = lowerBound(s, e, s[e] + C.HILL_MIN_LEN_M), grade = Math.abs(y[endK] - y[k]) / Math.max(1, s[endK] - s[k]);
    out.push({ kind: 'hill', type: sg > 0 ? 'hillUp' : 'hillDown', trigger: s[k], grade: Math.round(grade * 100) });
    k = e;
  }
  return out.sort((a, b) => a.trigger - b.trigger);
}

// roads/junctions as passed to buildRoads; returns sign descriptors
// { type, grade?, x, z, fx, fz (travel dir), nx, nz (face normal = -travel), roadId, road (index), dir, s (m along travel), trigger, offset, side (+1 right of travel / -1 left), kind }
export function detectSigns({ roads, junctions, driveSide = 'right' }) {
  const C = SIGN_CFG, res = [];
  roads.forEach((road, ri) => {
    const P = polyOf(road), hw = road.width / 2;
    if (P.n < 3) return;
    for (const dir of [1, -1]) {
      const v = dirView(P, dir), meta = (k) => road.points[P.seg[v.ix(k)]];
      const okAt = (k) => { // sign / trigger allowed here?
        const i = v.ix(k), m = meta(k);
        return !P.b[i] && m.type === 'country' && m.signs !== 'off' && !(dir < 0 && m.oneway) && !inJunction(junctions, P.x[i], P.z[i], 2);
      };
      const okTrigger = (k) => { const m = meta(k); return m.type === 'country' && m.signs !== 'off' && !(dir < 0 && m.oneway) && !P.b[v.ix(k)]; };
      const lastS = { s: -1e9 }, mine = [];
      for (const sec of findSections(v)) {
        const kt = lowerBound(v.s, 0, sec.trigger);
        if (!okTrigger(kt)) continue;
        let k = -1;
        for (let back = 0; back <= C.SLIDE_BACK_M; back++) {
          const target = sec.trigger - C.SIGN_BEFORE_M - back; if (target < 0) break;
          const kk = lowerBound(v.s, 0, target); if (okAt(kk)) { k = kk; break; }
        }
        if (k < 0) continue;
        const sPos = v.s[k];
        if (sPos - lastS.s < C.MIN_SPACING_M) continue; // merge duplicates / too close: keep the earlier sign
        lastS.s = sPos;
        const i = v.ix(k), fx = dir * P.tx[i], fz = dir * P.tz[i], side = driveSide === 'left' ? -1 : 1, m = meta(k);
        const lat = dir * side, edge = lat > 0 ? m.edgeR : m.edgeL; // lateral sign in the point-order frame
        const offset = hw + (edge !== 'none' ? C.EDGE_OFFSET[edge] + C.EDGE_CLEARANCE : C.SHOULDER_OFFSET);
        const rx = -fz * side, rz = fx * side; // unit vector to the driver's side
        mine.push({ kind: sec.kind, type: sec.type, grade: sec.grade, x: P.x[i] + rx * offset, z: P.z[i] + rz * offset, fx, fz, nx: -fx, nz: -fz,
          roadId: road.id, road: ri, dir, s: sPos, trigger: sec.trigger, offset, side });
      }
      res.push(...mine);
    }
  });
  return res;
}

// ------------------------------------------------------------------ rendering
const FACE = 1.6, DIAMOND = 0.75, TRI = [[-0.62, -0.36], [0.62, -0.36], [0, 0.71]]; // metres: texture square side, diamond half-diagonal (~42 in sign), triangle corners (1.24 m side)
const CENTER_H = 2.6, PLATE_H = 1.55, PLATE = [0.8, 0.4], POST_R = 0.04, POST_DOWN = 0.3;
const SIGN_COLORS = { us: { fill: '#f6cb12', work: '#ff8a1c', ink: '#111' }, eu: { fill: '#ffffff', work: '#ffffff', ink: '#111', red: '#d3151d' } };

function roundedPoly(path, verts, r) { // path: THREE.Shape or a canvas adapter (moveTo/lineTo/quadraticCurveTo)
  const n = verts.length;
  const pt = (a, b, d) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return [a[0] + dx / l * d, a[1] + dy / l * d]; };
  for (let i = 0; i < n; i++) {
    const p = verts[(i + n - 1) % n], c = verts[i], q = verts[(i + 1) % n], a = pt(c, p, r), b = pt(c, q, r);
    i ? path.lineTo(a[0], a[1]) : path.moveTo(a[0], a[1]);
    path.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  }
}
const outline = (style) => (style === 'eu' ? TRI : [[-DIAMOND, 0], [0, DIAMOND], [DIAMOND, 0], [0, -DIAMOND]]);
const cornerR = (style) => (style === 'eu' ? 0.07 : 0.07);

function symbol(ctx, type) { // black pictograms in a +-50 box (y down); ctx is already translated/scaled
  const head = (x, y, dx, dy, s = 26) => { const l = Math.hypot(dx, dy); dx /= l; dy /= l; ctx.beginPath(); ctx.moveTo(x + dx * s * 0.55, y + dy * s * 0.55); ctx.lineTo(x - dy * s * 0.5 - dx * s * 0.45, y + dx * s * 0.5 - dy * s * 0.45); ctx.lineTo(x + dy * s * 0.5 - dx * s * 0.45, y - dx * s * 0.5 - dy * s * 0.45); ctx.closePath(); ctx.fill(); };
  ctx.fillStyle = ctx.strokeStyle = '#111'; ctx.lineWidth = 11; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  if (type === 'curveL' || type === 'curveR') {
    if (type === 'curveR') ctx.scale(-1, 1);
    ctx.beginPath(); ctx.moveTo(12, 44); ctx.bezierCurveTo(12, 14, 8, -6, -16, -16); ctx.stroke(); head(-16, -16, -24, -10);
  } else if (type === 'sharpL' || type === 'sharpR') {
    if (type === 'sharpR') ctx.scale(-1, 1);
    ctx.beginPath(); ctx.moveTo(16, 44); ctx.lineTo(16, -4); ctx.lineTo(-10, -4); ctx.stroke(); head(-12, -4, -1, 0, 30);
  } else if (type === 'winding') {
    ctx.beginPath(); ctx.moveTo(4, 46); ctx.bezierCurveTo(4, 26, -16, 26, -16, 8); ctx.bezierCurveTo(-16, -10, 10, -6, 10, -24); ctx.stroke(); head(10, -24, 0, -1, 28);
  } else if (type === 'hillUp' || type === 'hillDown') {
    const up = type === 'hillUp', sl = Math.atan2(40, 88);
    ctx.beginPath(); if (up) { ctx.moveTo(-44, 28); ctx.lineTo(44, 28); ctx.lineTo(44, -12); } else { ctx.moveTo(-44, -12); ctx.lineTo(-44, 28); ctx.lineTo(44, 28); } ctx.closePath(); ctx.fill();
    ctx.save(); ctx.translate(0, 8); ctx.rotate(up ? -sl : sl);
    ctx.fillRect(-28, -22, 34, 19); // box
    ctx.beginPath(); ctx.moveTo(8, -3); ctx.lineTo(8, -16); ctx.lineTo(16, -16); ctx.lineTo(25, -8); ctx.lineTo(25, -3); ctx.closePath(); ctx.fill(); // cab
    ctx.beginPath(); ctx.arc(-16, -2, 5.5, 0, 6.3); ctx.arc(16, -2, 5.5, 0, 6.3); ctx.fill();
    ctx.restore();
  } else if (type === 'pedestrian') { // walking figure above a zebra: crossing sign (crosswalk feature), same pictogram in both styles
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(-2, -32, 8, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-2, -20); ctx.lineTo(-2, 4); ctx.moveTo(-2, -14); ctx.lineTo(-16, -4); ctx.moveTo(-2, -14); ctx.lineTo(14, -6); ctx.moveTo(-2, 4); ctx.lineTo(-14, 24); ctx.moveTo(-2, 4); ctx.lineTo(12, 22); ctx.stroke();
    ctx.lineCap = 'butt'; for (let i = 0; i < 4; i++) ctx.fillRect(-40 + i * 21, 31, 13, 10);
  } else if (type === 'roadworks') {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(-10, -30, 7, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-10, -20); ctx.lineTo(-4, 0); ctx.moveTo(-4, 0); ctx.lineTo(-16, 22); ctx.moveTo(-4, 0); ctx.lineTo(8, 20); ctx.moveTo(-8, -14); ctx.lineTo(12, -4); ctx.moveTo(12, -4); ctx.lineTo(22, 14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(14, 12); ctx.lineTo(30, 20); ctx.lineTo(22, 24); ctx.closePath(); ctx.fill(); // shovel blade
    ctx.beginPath(); ctx.moveTo(14, 28); ctx.lineTo(32, 6); ctx.lineTo(46, 28); ctx.closePath(); ctx.fill(); // dirt pile
    ctx.beginPath(); ctx.moveTo(-40, 28); ctx.lineTo(46, 28); ctx.stroke();
  }
}

const texCache = new Map(); // module level: textures + materials survive the debounced road rebuilds (a few hundred KB each)
function canvasOf(S, h = S) { const c = typeof document !== 'undefined' ? document.createElement('canvas') : null; if (c) { c.width = S; c.height = h; } return c; }
function finishTex(THREE, canvas) {
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
}
function faceMaterial(THREE, style, type) {
  const key = 'f' + style + type; if (texCache.has(key)) return texCache.get(key);
  const S = 512, cv = canvasOf(S), K = SIGN_COLORS[style]; let map = null;
  if (cv) {
    const c = cv.getContext('2d'), X = (x) => (x / FACE + 0.5) * S, Y = (y) => (0.5 - y / FACE) * S;
    const adapt = { moveTo: (x, y) => c.moveTo(X(x), Y(y)), lineTo: (x, y) => c.lineTo(X(x), Y(y)), quadraticCurveTo: (a, b, x, y) => c.quadraticCurveTo(X(a), Y(b), X(x), Y(y)) };
    const V = outline(style), r = cornerR(style), inset = (k) => V.map(([x, y]) => [x * k, y * k]);
    c.beginPath(); roundedPoly(adapt, V, r); c.closePath();
    c.fillStyle = type === 'roadworks' ? K.work : K.fill; c.fill(); c.save(); c.clip();
    if (style === 'eu') { c.strokeStyle = K.red; c.lineWidth = 0.17 * S; c.stroke(); } // clipped: inner half = border band
    else { c.beginPath(); roundedPoly(adapt, inset(0.9), r * 0.8); c.closePath(); c.strokeStyle = K.ink; c.lineWidth = 0.028 * S; c.stroke(); }
    c.restore();
    c.save(); c.translate(S / 2, S / 2 + (style === 'eu' ? 0.075 * S : 0)); const sc = (style === 'eu' ? 0.0052 : 0.0048) * S; c.scale(sc, sc); symbol(c, type); c.restore();
    map = finishTex(THREE, cv);
  }
  const mat = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : (type === 'roadworks' ? 0xff8a1c : style === 'eu' ? 0xffffff : 0xf6cb12), emissive: 0xffffff, emissiveMap: map, emissiveIntensity: map ? 0.42 : 0, roughness: 0.55 });
  texCache.set(key, mat); return mat;
}
function plateMaterial(THREE, style, grade) {
  const key = 'p' + style + grade; if (texCache.has(key)) return texCache.get(key);
  const W = 512, H = 256, cv = canvasOf(W, H); let map = null;
  if (cv) {
    const c = cv.getContext('2d'), eu = style === 'eu';
    c.fillStyle = eu ? '#fff' : '#f6cb12'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#111'; c.lineWidth = 14; c.strokeRect(12, 12, W - 24, H - 24);
    c.fillStyle = '#111'; c.font = '700 168px Arial, Helvetica, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(grade + '%', W / 2, H / 2 + 10);
    map = finishTex(THREE, cv);
  }
  const mat = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : 0xf6cb12, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: map ? 0.42 : 0, roughness: 0.55 });
  texCache.set(key, mat); return mat;
}
const shared = (THREE, key, f) => { if (!texCache.has(key)) texCache.set(key, f()); return texCache.get(key); };

// Builds the sign meshes + post colliders. Returns { group, drawCalls, instances, colliders }.
export function buildSigns({ THREE, RAPIER, physicsWorld, signs, style, heightAt, geos }) {
  const group = new THREE.Group(); group.name = 'roadSigns';
  const colliders = [], out = { group, colliders, instances: 0, drawCalls: 0 };
  if (!signs.length) return out;
  const V = outline(style), r = cornerR(style);
  const faceShape = () => { const s = new THREE.Shape(); roundedPoly(s, V, r); s.closePath(); return s; };
  const faceGeo = () => { const g = new THREE.ShapeGeometry(faceShape(), 6), p = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / FACE + 0.5, p.getY(i) / FACE + 0.5); g.translate(0, 0, 0.045); return g; };
  const backGeo = () => new THREE.ShapeGeometry(faceShape(), 6).rotateY(Math.PI).translate(0, 0, 0.036);
  const metal = shared(THREE, 'metal', () => new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.5, metalness: 0.5 }));
  const yawQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
  const byType = new Map(), plates = new Map(), posts = [], backs = [], plateBacks = [];
  for (const sg of signs) {
    const gy = heightAt(sg.x, sg.z), q = yawQ(Math.atan2(sg.nx, sg.nz));
    (byType.get(sg.type) || byType.set(sg.type, []).get(sg.type)).push({ x: sg.x, y: gy + CENTER_H, z: sg.z, q });
    backs.push({ x: sg.x, y: gy + CENTER_H, z: sg.z, q });
    const len = CENTER_H + POST_DOWN - 0.15; // post top ends a little below the sign centre, inside the diamond
    posts.push({ x: sg.x, y: gy - POST_DOWN, z: sg.z, q: yawQ(0), sy: len });
    if (sg.kind === 'hill') {
      const o = { x: sg.x, y: gy + PLATE_H, z: sg.z, q };
      (plates.get(sg.grade) || plates.set(sg.grade, []).get(sg.grade)).push(o); plateBacks.push(o);
    }
    if (physicsWorld) colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cylinder(len / 2, POST_R).setTranslation(sg.x, gy - POST_DOWN + len / 2, sg.z).setFriction(0.6)));
  }
  const add = (m) => { if (m) { group.add(m); out.drawCalls++; out.instances += m.count; } };
  const fg = faceGeo(); geos.push(fg);
  for (const [type, list] of byType) add(instancedMesh(THREE, fg, faceMaterial(THREE, style, type), list, 'sign_' + type));
  const bg = backGeo(); geos.push(bg); add(instancedMesh(THREE, bg, metal, backs, 'sign_backs'));
  const pg = new THREE.PlaneGeometry(PLATE[0], PLATE[1]).translate(0, 0, 0.045), pbg = new THREE.PlaneGeometry(PLATE[0], PLATE[1]).rotateY(Math.PI).translate(0, 0, 0.036); geos.push(pg, pbg);
  for (const [grade, list] of plates) add(instancedMesh(THREE, pg, plateMaterial(THREE, style, grade), list, 'plate_' + grade));
  add(instancedMesh(THREE, pbg, metal, plateBacks, 'plate_backs'));
  const postG = new THREE.CylinderGeometry(POST_R, POST_R, 1, 8).translate(0, 0.5, 0); geos.push(postG);
  add(instancedMesh(THREE, postG, metal, posts, 'sign_posts'));
  return out;
}
