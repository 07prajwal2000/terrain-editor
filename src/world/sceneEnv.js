// Shared scene setup (sky colour, lights, fog, renderer) used by the dev viewer (src/main.js) and the editor's 3D preview
// (src/editor/preview3d.js), so both look identical. THREE is injected like everywhere in src/world.
export const SKY = 0x9ec9e8;

export function createRenderer(THREE, opts = {}) {
  const r = new THREE.WebGLRenderer({ antialias: true, ...opts });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  return r;
}

// background + sun + hemisphere light. Returns { sun, hemi }.
export function setupSky(THREE, scene) {
  scene.background = new THREE.Color(SKY);
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.4); sun.position.set(-0.5, 0.75, -0.45);
  const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x6b5a3a, 1.1);
  scene.add(sun, hemi);
  return { sun, hemi };
}

// fog depends on the world size (call again after loading a different map)
export function applyFog(THREE, scene, worldSize) {
  scene.fog = new THREE.Fog(SKY, worldSize * 0.7, worldSize * 6);
}
