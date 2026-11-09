// Road edge objects (fence / guardrail / jersey barrier / lamp posts) and node features (bump, rumble strips, roadworks).
// All instanced or merged (a handful of draw calls); static Rapier colliders for fences, rails, barriers, lamp posts, the bump
// and the roadworks board. THREE / RAPIER are injected like everywhere in src/world.
//
// City segments: edge items stand FOOT_SHIFT (kerb + footpath width, roadMeta.js) further out, i.e. outside the footpath.
// Highway: a two-way (not one-way) highway stretch also gets a central concrete median barrier (jersey pieces on the centreline, same colliders as 'barrier').
// Edges stand just outside the asphalt edge (halfWidth + EDGE_OFFSET[type]); they are left out on bridges (which have their own
// rails), inside junction / roundabout footprints and wherever another road's carriageway comes near that edge (side-road joins).
// Colliders: fence / guardrail / barrier = one thin cuboid per ~6 m chord between stations (tolerates curves and slopes: the box
// follows the terrain pitch), lamp = thin cylinder.
// ponytail: visual pieces and 6 m collider chords are separate walks; on a curve under ~25 m radius the chord cuts the arc by
// a few cm. Cone / sign-post-free roadworks pieces have no colliders (cones are visual only; the board and the sign post do).
import { polyOf } from './roads.js';
import { SIGN_CFG } from './roadSigns.js';
import { FOOT_SHIFT, SELF_JUNCTION } from './roadMeta.js';
import { mergeParts, boxPart, cylPart, poseAlong, instancedMesh, inJunction } from './roadGeo.js';

export const LIFT_FEATURE = 0.03;           // = roads.js LIFT_ROAD: the hump base sits flush with the road surface
export const BUMP = { height: 0.10, length: 1.5 };
export const RUMBLE = { strips: 8, stripLen: 0.35, pitch: 0.9, height: 0.035 };
const COL_STEP = 6;
const EDGE = { // L = nominal piece length (m), collider h = height, t = thickness
  fence: { L: 2.5, h: 1.05, t: 0.12 }, guardrail: { L: 2.0, h: 0.78, t: 0.2 }, barrier: { L: 3.0, h: 0.8, t: 0.6 },
};
EDGE.median = EDGE.barrier;
const LAMP_STEP = 35, LAMP_H = 7.5, LAMP_ARM = 2.2;
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((c) => Math.pow(c, 2.2)); // vertex colours are linear

// ------------------------------------------------------------------ node features (shared with roads.js surfaceAt)
// -> [{ kind, road (index), roadId, pt, x, z, tx, tz, hw, s, meta (segment attrs at the point), oneway }]; skips bridges and junction footprints.
export function collectFeatures(roads, junctions) {
  const out = [];
  roads.forEach((road, ri) => {
    const P = polyOf(road), n = road.points.length;
    road.points.forEach((pt, j) => {
      if (!pt.features.length || P.n < 2) return;
      const i = P.ci[j];
      if (P.b[i] || inJunction(junctions, P.x[i], P.z[i], 1)) return;
      for (const kind of pt.features) out.push({ kind, road: ri, roadId: road.id, pt: j, x: P.x[i], z: P.z[i], tx: P.tx[i], tz: P.tz[i], hw: road.width / 2, s: P.s[i], meta: road.points[Math.min(j, n - 2)] });
    });
  });
  return out;
}

// ------------------------------------------------------------------ builder
export function buildEdges({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, driveSide, geos, colliders }) {
  const edges = new THREE.Group(); edges.name = 'roadEdges';
  const props = new THREE.Group(); props.name = 'roadProps';
  const stats = { drawCalls: 0, instances: 0, pieces: { fence: 0, guardrail: 0, barrier: 0, median: 0, lamps: 0 }, colliders: 0, features: { bump: 0, rumble: 0, roadworks: 0, crosswalk: 0 } };
  const info = { pieces: [], lamps: [], features: [], workSigns: [], colliderBoxes: [] }; // for tests / debugging
  const polys = roads.map(polyOf);

  // spatial hash of all non-bridge road samples (for "another road passes near this edge")
  const CELL = 16, hash = new Map();
  roads.forEach((road, ri) => {
    const P = polys[ri];
    for (let k = 0; k < P.n; k += 2) if (!P.b[k]) { const key = Math.floor(P.x[k] / CELL) * 100003 + Math.floor(P.z[k] / CELL); (hash.get(key) || hash.set(key, []).get(key)).push([ri, P.x[k], P.z[k], P.y[k], road.width / 2, P.s[k]]); }
  });
  // another road passes near this edge point; the road itself counts too when the other part is far away along its own arc (self-meetings)
  const nearOther = (ri, x, z, y, s) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), minSep = SELF_JUNCTION.SEP_WIDTHS * roads[ri].width + SELF_JUNCTION.SEP_M;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [rj, px, pz, py, hj, ps] of hash.get((cx + a) * 100003 + cz + b) || []) {
      if ((rj === ri && Math.abs(ps - s) < minSep) || Math.abs(py - y) > 4) continue;
      const d = Math.hypot(px - x, pz - z); if (d < hj + 3) return true;
    }
    return false;
  };
  const edgePos = (P, k, lat) => [P.x[k] - P.tz[k] * lat, P.z[k] + P.tx[k] * lat];

  // stations along one road side (side 0 = the centreline, for the highway median): [{ k, x, z, y, type, s, ok }] every `step` metres of arc length
  function stations(ri, side, step, wantType) {
    const road = roads[ri], P = polys[ri], hw = road.width / 2, out = [];
    let next = 0;
    for (let k = 0; k < P.n; k++) {
      if (P.s[k] < next - 1e-9) continue;
      next = P.s[k] + step;
      const m = road.points[P.seg[k]], type = side === 0 ? (m.type === 'highway' && !m.oneway ? 'median' : 'none') : side > 0 ? m.edgeR : m.edgeL;
      let ok = type !== 'none' && (wantType ? type === wantType : true) && !P.b[k];
      let x = 0, z = 0, y = 0;
      if (ok) {
        [x, z] = edgePos(P, k, side === 0 ? 0 : side * (hw + SIGN_CFG.EDGE_OFFSET[type] + (m.type === 'city' ? FOOT_SHIFT : 0)));
        y = heightAt(x, z);
        if (inJunction(junctions, x, z, 3) || nearOther(ri, x, z, y, P.s[k])) ok = false;
      }
      out.push({ k, x, z, y, type, s: P.s[k], ok });
    }
    return out;
  }

  // ---- fence / guardrail / barrier pieces + collider chords
  const pieceLists = { fence: [], guardrail: [], barrier: [], median: [] }, lampList = [];
  const q0 = new THREE.Quaternion();
  const addCollider = (type, a, b) => {
    const E = EDGE[type], { q, len } = poseAlong(THREE, a.x, a.y, a.z, b.x, b.y, b.z);
    info.colliderBoxes.push({ type, ax: a.x, az: a.z, bx: b.x, bz: b.z });
    if (!physicsWorld) return;
    const half = (E.h + 0.1) / 2, cy = (a.y + b.y) / 2 + (E.h - 0.1) / 2;
    colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(len / 2 + 0.03, half, E.t / 2).setTranslation((a.x + b.x) / 2, cy, (a.z + b.z) / 2).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.3)));
    stats.colliders++;
  };
  roads.forEach((road, ri) => {
    for (const side of [-1, 0, 1]) {
      for (const type of side === 0 ? ['median'] : ['fence', 'guardrail', 'barrier']) {
        const E = EDGE[type], st = stations(ri, side, E.L, type);
        for (let i = 0; i + 1 < st.length; i++) {
          const a = st[i], b = st[i + 1];
          if (!a.ok || !b.ok || b.s - a.s > E.L * 1.8) continue;
          const { q, len } = poseAlong(THREE, a.x, a.y, a.z, b.x, b.y, b.z);
          pieceLists[type].push({ x: a.x, y: a.y, z: a.z, q, sx: len / E.L });
          info.pieces.push({ type, side, road: ri, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z });
        }
        const cs = stations(ri, side, COL_STEP, type);
        for (let i = 0; i + 1 < cs.length; i++) { const a = cs[i], b = cs[i + 1]; if (a.ok && b.ok && b.s - a.s <= COL_STEP * 1.8) addCollider(type, a, b); }
      }
      if (side !== 0) for (const a of stations(ri, side, LAMP_STEP, 'lamps')) {
        if (!a.ok) continue;
        const P = polys[ri], cx = P.x[a.k], cz = P.z[a.k], yaw = Math.atan2(cz - a.z, cx - a.x); // local +X points at the road
        lampList.push({ x: a.x, y: a.y, z: a.z, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -yaw, 0)) });
        info.lamps.push({ x: a.x, z: a.z, y: a.y, road: ri });
        if (physicsWorld) { colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cylinder(LAMP_H / 2, 0.12).setTranslation(a.x, a.y + LAMP_H / 2 - 0.1, a.z).setFriction(0.3))); stats.colliders++; }
      }
    }
  });
  stats.pieces = { fence: pieceLists.fence.length, guardrail: pieceLists.guardrail.length, barrier: pieceLists.barrier.length, median: pieceLists.median.length, lamps: lampList.length };
  pieceLists.barrier.push(...pieceLists.median); // the median uses the jersey barrier piece (one instanced draw call)
  const add = (grp, m) => { if (m) { grp.add(m); stats.drawCalls++; stats.instances += m.count; } };
  const std = (o) => new THREE.MeshStandardMaterial(o), mats = [];
  const mk = (o) => { const m = std(o); mats.push(m); return m; };
  { // piece geometries: local +X = along the road, x in [0,L], post at x = 0
    const g = (parts) => { const m = mergeParts(THREE, parts); geos.push(m); return m; };
    const wood = rgb(0x7a5a38);
    add(edges, instancedMesh(THREE, g([boxPart(THREE, 0.1, 1.25, 0.1, 0, 0.475, 0, wood), boxPart(THREE, EDGE.fence.L, 0.1, 0.05, EDGE.fence.L / 2, 0.45, 0, wood), boxPart(THREE, EDGE.fence.L, 0.1, 0.05, EDGE.fence.L / 2, 0.85, 0, wood)]),
      mk({ vertexColors: true, roughness: 0.9 }), pieceLists.fence, 'fence'));
    const steel = rgb(0xb4bac2), L = EDGE.guardrail.L;
    add(edges, instancedMesh(THREE, g([boxPart(THREE, 0.1, 0.85, 0.1, 0, 0.275, -0.1, steel), boxPart(THREE, L, 0.16, 0.05, L / 2, 0.6, 0, steel), boxPart(THREE, L, 0.16, 0.05, L / 2, 0.45, 0, steel), boxPart(THREE, L, 0.1, 0.08, L / 2, 0.525, 0.02, steel)]),
      mk({ vertexColors: true, roughness: 0.4, metalness: 0.6 }), pieceLists.guardrail, 'guardrail'));
    const sh = new THREE.Shape(); // jersey profile (lateral x, up y)
    sh.moveTo(-0.3, -0.1); sh.lineTo(0.3, -0.1); sh.lineTo(0.3, 0.1); sh.lineTo(0.2, 0.35); sh.lineTo(0.11, 0.8); sh.lineTo(-0.11, 0.8); sh.lineTo(-0.2, 0.35); sh.lineTo(-0.3, 0.1); sh.closePath();
    const bg = new THREE.ExtrudeGeometry(sh, { depth: EDGE.barrier.L - 0.04, bevelEnabled: false }); bg.rotateY(Math.PI / 2); bg.translate(0.02, 0, 0); geos.push(bg);
    add(edges, instancedMesh(THREE, bg, mk({ color: 0x9d9b95, roughness: 0.92 }), pieceLists.barrier, 'barrier'));
    // lamp: pole + arm + housing (grey), lens (unlit warm), halo (billboard glow, additive, no real light)
    const grey = rgb(0x6d7178);
    const pole = g([cylPart(THREE, 0.05, 0.08, LAMP_H + 0.1, 0, LAMP_H / 2 - 0.05, 0, grey, 8), boxPart(THREE, LAMP_ARM, 0.07, 0.07, LAMP_ARM / 2, LAMP_H, 0, grey), boxPart(THREE, 0.9, 0.12, 0.32, LAMP_ARM, LAMP_H - 0.02, 0, grey)]);
    add(edges, instancedMesh(THREE, pole, mk({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), lampList, 'lamp_poles'));
    const lens = new THREE.BoxGeometry(0.7, 0.04, 0.24).translate(LAMP_ARM, LAMP_H - 0.1, 0); geos.push(lens);
    add(edges, instancedMesh(THREE, lens, mk({ color: 0xfff0c0 }), lampList, 'lamp_lens'));
    const halo = new THREE.PlaneGeometry(3.2, 3.2).translate(LAMP_ARM, LAMP_H - 0.25, 0); geos.push(halo);
    const hm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * instanceMatrix * vec4(position.x * 0.0 + ' + LAMP_ARM.toFixed(2) + ', ' + (LAMP_H - 0.25).toFixed(2) + ', 0.0, 1.0); mv.xy += (uv - 0.5) * 3.2; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(1.0 - d, 0.0), 3.0) * 0.45; gl_FragColor = vec4(1.0, 0.82, 0.45, a); }' });
    mats.push(hm);
    add(edges, instancedMesh(THREE, halo, hm, lampList, 'lamp_halo'));
  }

  // ---- node features: bump, rumble, roadworks (+ crosswalk: parse only)
  const feats = collectFeatures(roads, junctions);
  const FP = { pos: [], idx: [], col: [] }; // visual props (vertex coloured); bump trimesh colliders are built per feature
  const cones = [];
  const lat2 = (f, a, l) => [f.x + f.tx * a - f.tz * l, f.z + f.tz * a + f.tx * l]; // along a, lateral l (+ = right of the point order)
  const yellow = rgb(0xf2c200), black = rgb(0x151515), white = rgb(0xe8e8e8), red = rgb(0xc8281e), grey = rgb(0xb9b9b9);
  // hump: cos^2 profile across `len` m along the road, full width, lateral cells of ~0.5 m coloured by `colorOf(cell)`
  function hump(f, a0, len, peak, cell, colorOf, collide) {
    const hw = f.hw, nl = Math.max(2, Math.round(2 * hw / cell)), ns = Math.max(4, Math.round(len / 0.2)), loc = { pos: [], idx: [] };
    for (let c = 0; c < nl; c++) {
      const l0 = -hw + 2 * hw * c / nl, l1 = -hw + 2 * hw * (c + 1) / nl, col = colorOf(c), base = FP.pos.length / 3, lb = loc.pos.length / 3;
      for (let i = 0; i <= ns; i++) for (const l of [l0, l1]) {
        const a = a0 + len * i / ns, [x, z] = lat2(f, a, l), h = peak * Math.cos(Math.PI * (i / ns - 0.5)) ** 2, y = heightAt(x, z) + LIFT_FEATURE + h;
        FP.pos.push(x, y, z); FP.col.push(...col); loc.pos.push(x, y, z);
      }
      for (let i = 0; i < ns; i++) { const a = i * 2, v = [a, a + 1, a + 2, a + 3]; FP.idx.push(base + v[0], base + v[1], base + v[2], base + v[1], base + v[3], base + v[2]); loc.idx.push(lb + v[0], lb + v[1], lb + v[2], lb + v[1], lb + v[3], lb + v[2]); }
    }
    if (collide && physicsWorld) { colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(loc.pos), new Uint32Array(loc.idx)).setFriction(0.9))); stats.colliders++; }
  }
  const boxFP = (cx, cy, cz, tx, tz, along, lat, h, col) => { // vertical box (centre cx,cy,cz), long side `along` along (tx,tz)
    const parts = [{ geo: new THREE.BoxGeometry(along, h, lat), m: new THREE.Matrix4().makeRotationY(-Math.atan2(tz, tx)).setPosition(cx, cy, cz), color: col }];
    const g = mergeParts(THREE, parts), p = g.attributes.position.array, n = g.attributes.normal.array, base = FP.pos.length / 3;
    for (let i = 0; i < p.length / 3; i++) { FP.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); FP.col.push(...col); FP.idx.push(base + i); }
    g.dispose();
  };
  const sd = driveSide === 'left' ? -1 : 1;
  for (const f of feats) {
    stats.features[f.kind]++; info.features.push({ kind: f.kind, x: f.x, z: f.z, tx: f.tx, tz: f.tz, hw: f.hw, road: f.road, pt: f.pt });
    if (f.kind === 'bump') hump(f, -BUMP.length / 2, BUMP.length, BUMP.height, 0.5, (c) => (c % 2 ? black : yellow), true);
    else if (f.kind === 'rumble') {
      const span = (RUMBLE.strips - 1) * RUMBLE.pitch;
      for (let i = 0; i < RUMBLE.strips; i++) hump(f, -span / 2 + i * RUMBLE.pitch - RUMBLE.stripLen / 2, RUMBLE.stripLen, RUMBLE.height, 2 * f.hw, () => grey, false);
    } else if (f.kind === 'roadworks') {
      const hw = f.hw, l0 = 0.35, l1 = hw - 0.35, lc = sd * (l0 + l1) / 2, Lb = l1 - l0;
      const ground = (x, z) => heightAt(x, z);
      // barrier board: red/white striped horizontal plank on two legs, across the closed (driver's side) lane half
      const [bx, bz] = lat2(f, 0, lc), gy = ground(bx, bz), nStripe = Math.max(2, Math.round(Lb / 0.5));
      for (let i = 0; i < nStripe; i++) { const [sx, sz] = lat2(f, 0, sd * (l0 + Lb * (i + 0.5) / nStripe)); boxFP(sx, gy + 0.9, sz, f.tz, -f.tx, Lb / nStripe, 0.1, 0.28, i % 2 ? white : red); }
      for (const l of [l0 + 0.1, l1 - 0.1]) { const [sx, sz] = lat2(f, 0, sd * l); boxFP(sx, gy + 0.45, sz, f.tx, f.tz, 0.08, 0.08, 0.9, grey); }
      if (physicsWorld) {
        const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(f.tz, f.tx), 0)); // local z = lateral axis = the board's long side
        colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(0.08, 0.5, Lb / 2).setTranslation(bx, gy + 0.5, bz).setRotation({ x: lq.x, y: lq.y, z: lq.z, w: lq.w }).setFriction(0.3))); stats.colliders++;
      }
      // taper of cones from the lane edge toward the centre line, upstream of the board (travel direction = point order)
      const nC = 5;
      for (let i = 0; i < nC; i++) {
        const t = i / (nC - 1), a = -14 + t * 12, l = sd * (hw - 0.6 + t * (0.5 - (hw - 0.6))), [cx, cz] = lat2(f, a, l);
        cones.push({ x: cx, y: ground(cx, cz) + LIFT_FEATURE, z: cz, q: q0 });
      }
      for (const a of [1.5, 3.5]) { const [cx, cz] = lat2(f, a, sd * (l0 + 0.4)); cones.push({ x: cx, y: ground(cx, cz) + LIFT_FEATURE, z: cz, q: q0 }); }
      // "road works" sign 25 m upstream on the driver's side shoulder (consumed by roadSigns.buildSigns)
      const P = polys[f.road], target = f.s - 25;
      let k = 0; while (k < P.n - 1 && P.s[k] < target) k++;
      if (target > 0 && !P.b[k] && !inJunction(junctions, P.x[k], P.z[k], 2)) {
        const off = hw + SIGN_CFG.SHOULDER_OFFSET, [sx, sz] = [P.x[k] - P.tz[k] * sd * off, P.z[k] + P.tx[k] * sd * off];
        info.workSigns.push({ kind: 'work', type: 'roadworks', x: sx, z: sz, fx: P.tx[k], fz: P.tz[k], nx: -P.tx[k], nz: -P.tz[k], roadId: f.roadId, road: f.road, dir: 1, s: P.s[k], trigger: f.s, offset: off, side: sd });
      }
    }
  }
  if (FP.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(FP.pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(FP.col, 3));
    g.setIndex(FP.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(FP.idx, 1) : new THREE.Uint16BufferAttribute(FP.idx, 1));
    g.computeVertexNormals(); g.computeBoundingSphere(); geos.push(g);
    const m = new THREE.Mesh(g, mk({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide })); m.name = 'roadFeatures'; m.matrixAutoUpdate = false; props.add(m); stats.drawCalls++;
  }
  if (cones.length) {
    const orange = rgb(0xff6a14), band = rgb(0xf4f4f4), base = rgb(0x222222);
    const cg = mergeParts(THREE, [boxPart(THREE, 0.38, 0.04, 0.38, 0, 0.02, 0, base), cylPart(THREE, 0.04, 0.14, 0.6, 0, 0.34, 0, orange, 10), cylPart(THREE, 0.075, 0.095, 0.1, 0, 0.42, 0, band, 10)]); geos.push(cg);
    add(props, instancedMesh(THREE, cg, mk({ vertexColors: true, roughness: 0.7 }), cones, 'cones'));
  }
  return { edges, props, stats, info, mats };
}
