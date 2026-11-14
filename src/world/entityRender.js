// Instanced rendering for the entity layer (entities.js). One THREE.InstancedMesh per (kind, variant); every frame the matrices / colours / phases are written
// straight from the SoA arrays (no Object3D, no allocation) for live entities within drawRadius of the focus, count set to what was written, and the bounding
// sphere refitted to those instances so frustum culling stays correct.
//
//   const er = createEntityRenderer({ THREE, scene, ew });
//   er.register('ped', 0, geometry, material, { max: 400, drawRadius: 150, castShadow: false, yOffset: 0, anim: { onShader(shader) {...} } })
//   er.update(focus, timeSec)      once per frame after ew.update     er.stats() -> { meshes, drawn, drawCalls }     er.dispose()
//
// Per instance: matrix = translate(x, y + yOffset, z) * rotY(heading) * scale(scale); instanceColor = tint (0 -> white, i.e. the material colour);
// attribute aPhase = ew.anim[id] (only when opts.anim). Variants >= registered count fall back to variant 0.
// Vertex animation hook (peds' walk cycle): opts.anim.onShader(shader) runs inside onBeforeCompile AFTER `uniform float uTime; attribute float aPhase;` were
// declared, so it can e.g. shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed.z += sin(uTime*8.+aPhase)*0.1*position.y;')
// Give each animated (kind, variant) its own material (onBeforeCompile is per material).
// Limitation: geometry/material are owned by the caller (dispose() only removes the meshes). Per-instance pitch/roll not supported (yaw only).

export function createEntityRenderer({ THREE, scene, ew }) {
  const byKind = {};   // kind name -> [entry per variant]
  const entries = [], uTime = { value: 0 };

  function register(kind, variant, geometry, material, opts = {}) {
    const max = opts.max ?? ew.cap(kind);
    const mesh = new THREE.InstancedMesh(geometry, material, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0; mesh.castShadow = !!opts.castShadow; mesh.receiveShadow = opts.receiveShadow ?? true;
    mesh.name = `entity:${kind}:${variant}`;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    mesh.boundingSphere = new THREE.Sphere();
    let phase = null;
    if (opts.anim) {
      phase = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aPhase', phase);   // ponytail: phase lives on the geometry, so do not share one geometry between two animated variants
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uTime;
        shader.vertexShader = 'uniform float uTime;\nattribute float aPhase;\n' + shader.vertexShader;
        opts.anim.onShader?.(shader);
      };
      material.needsUpdate = true;
    }
    scene.add(mesh);
    const e = { kind, variant, mesh, max, phase, drawRadius: opts.drawRadius ?? Infinity, yOffset: opts.yOffset ?? 0, geoR: geometry.boundingSphere.radius };
    ((byKind[kind] ||= [])[variant] = e); entries.push(e);
    return mesh;
  }

  let drawn = 0;
  function update(focus, time = 0) {
    uTime.value = time; drawn = 0;
    for (const e of entries) { e.n = 0; e.minX = e.minY = e.minZ = Infinity; e.maxX = e.maxY = e.maxZ = -Infinity; e.maxS = 0; }
    for (const kind in byKind) {
      const vs = byKind[kind], { ids, n } = ew.list(kind);
      for (let i = 0; i < n; i++) {
        const id = ids[i], e = vs[ew.variant[id]] || vs[0];
        if (!e || e.n >= e.max || ew.dist2[id] > e.drawRadius * e.drawRadius) continue;   // dist2 is from the last ew.update(focus)
        const k = e.n++, m = e.mesh.instanceMatrix.array, o = k * 16;
        const h = ew.heading[id], s = ew.scale[id], c = Math.cos(h) * s, sn = Math.sin(h) * s;
        const x = ew.x[id], y = ew.y[id] + e.yOffset, z = ew.z[id];
        m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = s; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
        m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
        const t = ew.tint[id], col = e.mesh.instanceColor.array, oc = k * 3;
        if (t === 0) { col[oc] = col[oc + 1] = col[oc + 2] = 1; }
        else { col[oc] = ((t >> 16) & 255) / 255; col[oc + 1] = ((t >> 8) & 255) / 255; col[oc + 2] = (t & 255) / 255; }
        if (e.phase) e.phase.array[k] = ew.anim[id];
        if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x; if (y < e.minY) e.minY = y; if (y > e.maxY) e.maxY = y;
        if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z; if (s > e.maxS) e.maxS = s;
      }
    }
    for (const e of entries) {
      const mesh = e.mesh; mesh.count = e.n; drawn += e.n; mesh.visible = e.n > 0;
      if (!e.n) continue;
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, e.n * 16); mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, e.n * 3); mesh.instanceColor.needsUpdate = true;
      if (e.phase) { e.phase.clearUpdateRanges(); e.phase.addUpdateRange(0, e.n); e.phase.needsUpdate = true; }
      const bs = mesh.boundingSphere, hx = (e.maxX - e.minX) / 2, hy = (e.maxY - e.minY) / 2, hz = (e.maxZ - e.minZ) / 2;
      bs.center.set(e.minX + hx, e.minY + hy, e.minZ + hz);
      bs.radius = Math.sqrt(hx * hx + hy * hy + hz * hz) + e.geoR * e.maxS + Math.abs(e.yOffset);
    }
  }

  return {
    register, update,
    stats: () => ({ meshes: entries.length, drawn, drawCalls: entries.reduce((a, e) => a + (e.n > 0 ? 1 : 0), 0) }),
    dispose() { for (const e of entries) { scene.remove(e.mesh); e.mesh.dispose(); } entries.length = 0; for (const k in byKind) delete byKind[k]; },
  };
}
