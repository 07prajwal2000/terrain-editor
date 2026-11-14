// Dev page (/house-preview.html): every houseKit variant x a few seeds on a grid, flat vertex-coloured materials per key.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { planHouse, VARIANTS } from '../world/houseKit.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 2000);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x556644, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(40, 80, 60); scene.add(sun);
const mats = new Map(), mat = (k) => mats.get(k) || mats.set(k, new THREE.MeshLambertMaterial({ vertexColors: true, })).get(k);
const SEEDS = 4, CW = 26, CD = 36;
let tris = 0;
VARIANTS.forEach((variant, vi) => {
  for (let s = 0; s < SEEDS; s++) {
    const spec = { hu: 7 + (s % 3) * 1.2, hv: 5 + (s % 2) * 1.5, seed: 1000 + s * 31 + vi, driveway: s & 1 ? 'left' : 'right', variant };
    spec.front = spec.hv + 7;
    const h = planHouse(spec), grp = new THREE.Group();
    grp.position.set(vi * CW, 0, s * CD); tris += h.tris;
    for (const p of h.prims) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(p.nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(p.col, 3)); g.setIndex(new THREE.BufferAttribute(p.idx, 1));
      grp.add(new THREE.Mesh(g, mat(p.mat)));
    }
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(2 * spec.hu + 8, spec.front + spec.hv + 4), new THREE.MeshLambertMaterial({ color: 0x5e8c46 }));
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(0, -0.01, (spec.front - spec.hv) / 2); grp.add(lawn);
    scene.add(grp);
  }
});
document.getElementById('info').textContent = `${VARIANTS.length} variants x ${SEEDS} seeds (columns: ${VARIANTS.join(', ')}), ${tris} tris`;
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(VARIANTS.length * CW / 2, 0, SEEDS * CD / 2); camera.position.set(VARIANTS.length * CW / 2, 90, SEEDS * CD + 80); controls.update();
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
