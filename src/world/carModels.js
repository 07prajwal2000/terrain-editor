// Traffic car models (plan part 6b). CAR_TYPES is pure data (id + real dimensions from public/cars/cars.json, used by the traffic sim, colliders and tests, no THREE).
// buildGlbGeometry(THREE, gltfScene) merges one of the game's own car GLBs (/cars/<id>.glb: nodes body + wheel_*; all meshes baked at rest pose, wheels included, no
// spinning) into ONE vertex-coloured geometry: colour = material colour, attribute aPaint = 1 on the body paint material ('body <colour>', not black / white) whose colour is
// replaced by white so the per-instance tint (ew.tint) only recolours the paint; glass, tyres, rims and lamps stay untinted (trafficMaterial() applies aPaint in the shader).
// buildCarGeometries(THREE) is the FALLBACK: simple boxes (<= 150 tris), scaled to the CAR_TYPES dimensions (used only if the GLBs fail to load).
// Local frame: origin on the ground at the car centre, forward = +Z (matches entities.js heading: forward = (sin h, 0, cos h)), width on X.
// Body paint is vertex white so the per-instance tint (ew.tint) colours it; glass / tyres / lamps are baked dark / bright and are only slightly shifted by the tint.
// Variants: 0 taxi (yellow, roof sign), 1 sedan, 2 hatchback, 3 van, 4 bus, 5 delivery truck.
export const CAR_TYPES = Object.freeze([
  { name: 'taxi', id: 'taxi', len: 5.233, wid: 2.814, hgt: 2.319, tint: [0xffc20e] },
  { name: 'sedan', id: 'sedan', len: 5.233, wid: 2.814, hgt: 2.011, tint: [0xc0392b, 0x2c5aa0, 0x2f3a45, 0xd8d8d8, 0x1f6f4a, 0x7a7f87, 0x111111, 0x8a5a2b] },
  { name: 'hatchback', id: 'hatchback', len: 5.106, wid: 2.814, hgt: 2.011, tint: [0xe8b020, 0xd14b8f, 0x3a9ad9, 0xe6e6e6, 0xd2562a, 0x5aa65a, 0x444b57] },
  { name: 'van', id: 'van', len: 5.906, wid: 2.814, hgt: 2.711, tint: [0xf2f2f2, 0xc9ccd1, 0x2c5aa0, 0xb02a2a] },
  { name: 'bus', id: 'bus', len: 13.699, wid: 3.814, hgt: 4.274, tint: [0xc23b22, 0x2c6fb5, 0xe0a82a] },
  { name: 'truck', id: 'truck', len: 5.383, wid: 3.414, hgt: 3.211, tint: [0xf0f0f0, 0xb8452a, 0x2d6a4f, 0x2c5aa0, 0xd9a521] },
]);

const SIMPLE = [[4.5, 1.8, 1.5], [4.5, 1.8, 1.45], [3.9, 1.7, 1.45], [5, 2, 2], [11, 2.5, 3.1], [7, 2.4, 3.2]]; // dims the simple boxes below were drawn for

// Material for every variant: vertex colours x (instance tint only where aPaint = 1). Instance colour must exist on the mesh (entityRender sets it).
export function trafficMaterial(THREE) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aPaint;\n' + sh.vertexShader.replace('#include <color_vertex>', 'vColor.xyz = color.rgb * mix(vec3(1.0), instanceColor.rgb, aPaint);\n#ifdef USE_COLOR_ALPHA\nvColor.w = 1.0;\n#endif');
  };
  m.customProgramCacheKey = () => 'traffic-paint-v1';
  return m;
}

// gltf scene (Object3D) -> merged geometry (non-indexed). userData.tris = triangle count. Skips nothing: the game's cars are 1.4k-1.8k tris each.
export function buildGlbGeometry(THREE, scene) {
  scene.updateMatrixWorld(true);
  const pos = [], nor = [], col = [], paint = [], v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material, g = o.geometry, ix = g.index, P = g.attributes.position, N = g.attributes.normal;
    const isPaint = /^body (?!black|white)/i.test(mat.name || ''), c = isPaint ? [1, 1, 1] : [mat.color.r, mat.color.g, mat.color.b];
    nm.getNormalMatrix(o.matrixWorld);
    const cnt = ix ? ix.count : P.count;
    for (let i = 0; i < cnt; i++) {
      const k = ix ? ix.getX(i) : i;
      v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); pos.push(v.x, v.y, v.z);
      if (N) n.fromBufferAttribute(N, k).applyMatrix3(nm).normalize(); else n.set(0, 1, 0);
      nor.push(n.x, n.y, n.z); col.push(c[0], c[1], c[2]); paint.push(isPaint ? 1 : 0);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('aPaint', new THREE.Float32BufferAttribute(paint, 1));
  g.computeBoundingSphere(); g.userData.tris = pos.length / 9;
  return g;
}

export function buildCarGeometries(THREE) {
  const ST = SIMPLE.map(([len, wid, hgt]) => ({ len, wid, hgt }));
  const W = [1, 1, 1], GLASS = [0.1, 0.14, 0.2], TYRE = [0.05, 0.05, 0.06], HEAD = [1, 0.95, 0.75], TAIL = [0.8, 0.05, 0.05], DARK = [0.18, 0.18, 0.2], SIGN = [1, 0.95, 0.8];
  const geos = [];
  const make = (fn) => {
    const pos = [], nor = [], col = [], pnt = [];
    const box = (cx, cy, cz, sx, sy, sz, c) => { // axis aligned box, 12 triangles, flat normals
      const col0 = c;
      const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
      const faces = [ // [normal, 4 corners counter-clockwise seen from outside]
        [[1, 0, 0], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [[-1, 0, 0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]],
        [[0, 1, 0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [[0, -1, 0], [x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
        [[0, 0, 1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [[0, 0, -1], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]];
      for (const [n, a, b, c, d] of faces) for (const v of [a, b, c, a, c, d]) { pos.push(...v); nor.push(...n); col.push(...c0(c)); pnt.push(col0 === W ? 1 : 0); }
    };
    const c0 = (c) => c;
    const wheels = (L, Wd, r, zs) => { for (const z of zs) for (const sx of [-1, 1]) box(sx * (Wd / 2 - 0.12), r, z, 0.24, r * 2, r * 2, TYRE); };
    const lamps = (L, Wd, y, h) => { box(0, y, L / 2 - 0.02, Wd - 0.3, h, 0.05, HEAD); box(0, y, -L / 2 + 0.02, Wd - 0.3, h, 0.05, TAIL); };
    fn({ box, wheels, lamps });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('aPaint', new THREE.Float32BufferAttribute(pnt, 1));
    g.userData.simple = true; g.userData.tris = pos.length / 9; geos.push(g);
    return g;
  };
  const car = (t, cabinLen, cabinZ, sign) => make(({ box, wheels, lamps }) => {
    const { len: L, wid: Wd, hgt: H } = t;
    wheels(L, Wd, 0.32, [L * 0.3, -L * 0.3]);
    box(0, 0.65, 0, Wd, 0.6, L - 0.1, W);                                  // body
    box(0, 0.95 + (H - 0.95 - 0.06) / 2, cabinZ, Wd - 0.16, H - 0.95 - 0.06, cabinLen, GLASS); // glass cabin
    box(0, H - 0.03, cabinZ, Wd - 0.12, 0.06, cabinLen + 0.1, W);          // roof
    lamps(L, Wd, 0.72, 0.16);
    if (sign) box(0, H + 0.1, cabinZ, 0.7, 0.2, 0.28, SIGN);               // taxi roof sign
  });
  const taxi = car(ST[0], 2.2, -0.15, true), sedan = car(ST[1], 2.2, -0.15, false), hatch = car(ST[2], 2.4, -0.35, false);
  const van = make(({ box, wheels, lamps }) => {
    const { len: L, wid: Wd, hgt: H } = ST[3];
    wheels(L, Wd, 0.36, [L * 0.3, -L * 0.3]);
    box(0, 0.4 + (H - 0.4) / 2, -0.3, Wd, H - 0.4, L - 0.6, W);            // box body
    box(0, 0.4 + 0.45, L / 2 - 0.45, Wd, 0.9, 0.9, W);                     // bonnet block
    box(0, 1.3, L / 2 - 0.9, Wd - 0.2, 0.55, 0.12, GLASS);                 // windscreen
    box(0, 0.5, 0, Wd - 0.1, 0.12, L - 0.2, DARK);                         // sill
    lamps(L, Wd, 0.75, 0.16);
  });
  const bus = make(({ box, wheels, lamps }) => {
    const { len: L, wid: Wd, hgt: H } = ST[4];
    wheels(L, Wd, 0.5, [L * 0.32, -L * 0.3]);
    box(0, 0.5 + (H - 0.5) / 2, 0, Wd, H - 0.5, L - 0.1, W);               // body
    box(0, 2.05, 0, Wd + 0.04, 0.8, L - 0.8, GLASS);                       // window band (proud of the sides)
    box(0, 1.65, L / 2 - 0.02, Wd - 0.3, 0.75, 0.06, GLASS);               // windscreen
    box(0, 0.62, 0, Wd - 0.1, 0.16, L - 0.2, DARK);                        // skirt
    lamps(L, Wd, 0.85, 0.2);
  });
  const truck = make(({ box, wheels, lamps }) => {
    const { len: L, wid: Wd, hgt: H } = ST[5];
    wheels(L, Wd, 0.5, [L * 0.3, -L * 0.3]);
    box(0, 0.7, 0, Wd - 0.2, 0.3, L - 0.2, DARK);                          // chassis
    box(0, 1.45 + 0.35, L / 2 - 0.9, Wd, 1.8, 1.8, W);                     // cab
    box(0, 2.05, L / 2 - 0.05, Wd - 0.3, 0.7, 0.06, GLASS);                // windscreen
    box(0, 0.85 + (H - 0.85) / 2, -0.95, Wd, H - 0.85, L - 2.2, W);        // cargo box
    lamps(L, Wd, 0.85, 0.2);
  });
  const all = [taxi, sedan, hatch, van, bus, truck];
  all.forEach((g, i) => { g.scale(CAR_TYPES[i].wid / SIMPLE[i][1], CAR_TYPES[i].hgt / SIMPLE[i][2], CAR_TYPES[i].len / SIMPLE[i][0]); g.computeBoundingSphere(); });
  return { geos: all, dispose: () => geos.forEach((g) => g.dispose()) };
}
