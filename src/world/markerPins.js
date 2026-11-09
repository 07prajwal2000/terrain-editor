// 3D marker pins shared by the editor's preview and the game viewer. A marker = { name, color, x, z, y, yaw, radius, yOffset, ... }
// (see map.markers in mapLoader.js). Pin = coloured pole + sphere head + yaw arrow (+ draped radius ring if radius > 0) + name label.
// Convention: yaw degrees, 0 = +X, +90 = +Z; forward = (cos yaw, sin yaw) in (x, z).
// createMarkerPins(THREE, { heightAt, size }) -> { group, setMarkers(list), refresh(), dispose() }
//   heightAt(x,z) = ground height (metres); pin y = heightAt + marker.yOffset. size = pole height in metres.
//   refresh() re-reads heights (call after terrain changes). The group is a child of whatever vertically-scaled parent you like.
// ponytail: rebuilds every pin on setMarkers/refresh (fine for dozens of markers); labels are one canvas texture each.
export function createMarkerPins(THREE, { heightAt, size = 12 } = {}) {
  const group = new THREE.Group(); group.name = 'markerPins';
  let list = [], owned = [];
  const mats = new Map();
  const matFor = (hex) => { let m = mats.get(hex); if (!m) { m = new THREE.MeshBasicMaterial({ color: hex, fog: false }); mats.set(hex, m); } return m; };

  function label(text, hex) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = 'bold 28px system-ui,sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 20; c.width = w; c.height = 44;
    g.font = 'bold 28px system-ui,sans-serif'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(0, 0, w, 44); g.fillStyle = hex; g.fillRect(0, 0, 5, 44);
    g.fillStyle = '#fff'; g.fillText(text, 12, 23);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, fog: false }));
    sp.scale.set(0.035 * w / 44, 0.035, 1); sp.center.set(0.5, 0); sp.renderOrder = 10;
    owned.push(tex, sp.material);
    return sp;
  }

  function build() {
    for (const c of [...group.children]) { group.remove(c); }
    for (const o of owned) o.dispose(); owned = [];
    for (const m of list) {
      const hex = m.color || '#ff3b30', y = heightAt(m.x, m.z) + (m.yOffset || 0), mat = matFor(hex);
      const pin = new THREE.Group(); pin.position.set(m.x, y, m.z); pin.name = 'pin_' + (m.name || m.id);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.03, size * 0.03, size, 6).translate(0, size / 2, 0), mat);
      const head = new THREE.Mesh(new THREE.SphereGeometry(size * 0.16, 14, 10).translate(0, size + size * 0.12, 0), mat);
      const arrow = new THREE.Group();
      const L = size * 0.9;
      arrow.add(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.025, size * 0.025, L, 6).rotateZ(Math.PI / 2).translate(L / 2, size * 0.05, 0), mat));
      arrow.add(new THREE.Mesh(new THREE.ConeGeometry(size * 0.09, size * 0.25, 10).rotateZ(-Math.PI / 2).translate(L + size * 0.1, size * 0.05, 0), mat));
      arrow.rotation.y = -(m.yaw || 0) * Math.PI / 180; // three's +Y rotation by -yaw maps +X to (cos yaw, 0, sin yaw)
      pin.add(pole, head, arrow);
      owned.push(pole.geometry, head.geometry, ...arrow.children.map((c) => c.geometry));
      if (m.radius > 0) {
        const pts = [];
        for (let i = 0; i < 64; i++) { const a = i / 64 * 2 * Math.PI, x = m.x + Math.cos(a) * m.radius, z = m.z + Math.sin(a) * m.radius; pts.push(x - m.x, heightAt(x, z) + 0.4 - y, z - m.z); }
        const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: hex, fog: false }));
        owned.push(g, ring.material); pin.add(ring);
      }
      if (m.name) { const sp = label(m.name, hex); sp.position.set(0, size * 1.45, 0); pin.add(sp); }
      group.add(pin);
    }
  }
  return {
    group,
    setMarkers(l) { list = l; build(); },
    refresh() { build(); },
    dispose() { for (const c of [...group.children]) group.remove(c); for (const o of owned) o.dispose(); for (const m of mats.values()) m.dispose(); owned = []; mats.clear(); },
  };
}
