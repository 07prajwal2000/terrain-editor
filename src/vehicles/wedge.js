// Static test wedge (ramp): a triangular prism rising along +Z. Used by ?testRamp in the game and by scripts/test-vehicles.mjs.
//   o = { x, z0, y0 = 0, width = 12, angleDeg = 20, length = 24 (along the slope) }; low edge at z0, vertical back wall at the top edge.
export function wedgePoints(o) {
  const { x = 0, z0, y0 = 0, width = 12, angleDeg = 20, length = 24 } = o, a = angleDeg * Math.PI / 180;
  const run = length * Math.cos(a), H = length * Math.sin(a), hw = width / 2;
  // A,B low edge; C,D top edge; E,F foot of the back wall
  return { pts: [[x - hw, y0, z0], [x + hw, y0, z0], [x - hw, y0 + H, z0 + run], [x + hw, y0 + H, z0 + run], [x - hw, y0, z0 + run], [x + hw, y0, z0 + run]], run, H };
}
export function addWedgeCollider(RAPIER, world, o) {
  const { pts } = wedgePoints(o), f = new Float32Array(pts.flat());
  return world.createCollider(RAPIER.ColliderDesc.convexHull(f).setFriction(1.0).setRestitution(0));
}
export function wedgeMesh(THREE, o, color = 0xd9822b) {
  const { pts } = wedgePoints(o), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  g.setIndex([0, 1, 3, 0, 3, 2, 4, 3, 5, 4, 2, 3, 0, 2, 4, 1, 5, 3, 0, 4, 5, 0, 5, 1]); // slope, back wall, sides, bottom
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
  m.castShadow = m.receiveShadow = true; return m;
}
