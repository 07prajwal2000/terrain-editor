// Small geometry helpers shared by roadEdges.js / roadSigns.js. THREE is injected (no imports), like the rest of src/world.

// parts: [{ geo, m?: Matrix4, color?: [r,g,b] }] -> one non-indexed BufferGeometry (position, normal, optional per-vertex color).
export function mergeParts(THREE, parts) {
  const pos = [], nor = [], col = [], withColor = parts.some((p) => p.color);
  for (const { geo, m, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
    if (withColor) for (let i = 0; i < p.length / 3; i++) col.push(...(color || [1, 1, 1]));
    g.dispose(); geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  if (withColor) out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

export function boxPart(THREE, w, h, d, x, y, z, color) { return { geo: new THREE.BoxGeometry(w, h, d), m: new THREE.Matrix4().makeTranslation(x, y, z), color }; }
export function cylPart(THREE, r0, r1, h, x, y, z, color, seg = 10) { return { geo: new THREE.CylinderGeometry(r0, r1, h, seg), m: new THREE.Matrix4().makeTranslation(x, y, z), color }; }

// pose of a piece whose local +X runs from A to B (3D): { q: Quaternion, len }
export function poseAlong(THREE, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, h = Math.hypot(dx, dz);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(dz, dx), Math.atan2(dy, h), 'YZX'));
  return { q, len: Math.hypot(dx, dy, dz) };
}

// InstancedMesh from a list of {x,y,z,q,sx,sy,sz}; returns null when empty.
export function instancedMesh(THREE, geo, mat, list, name) {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length), m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3();
  list.forEach((o, i) => { p.set(o.x, o.y, o.z); s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1); m.compose(p, o.q, s); im.setMatrixAt(i, m); });
  im.instanceMatrix.needsUpdate = true; im.name = name; im.matrixAutoUpdate = false;
  im.computeBoundingSphere();
  return im;
}

// true when (x,z) is inside a junction / roundabout footprint grown by `margin`
export function inJunction(junctions, x, z, margin = 2) {
  for (const j of junctions) if (Math.hypot(x - j.x, z - j.z) < j._extent + margin) return true;
  return false;
}
