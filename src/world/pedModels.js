// Low-poly pedestrian bodies (plan part 6c): 4 variants, each ONE merged geometry (<= 108 tris) with vertex colours per body part, own material with the walk cycle in the vertex shader.
//   const v = buildPedVariants(THREE) -> [{ geometry, material, tris }] indexed by ew.variant: 0 suit, 1 casual, 2 coat + hat, 3 kid.
// Per-vertex attributes: color (part colour), aPart (0 body, 1 head, 2 leg, 3 arm; +0.5 = right side), aMask (1 = takes the per-instance tint, 0 = fixed colour: skin, hair, shoes).
// Animation word = ew.anim = phase (0..2pi) + 8 * q, decoded in the shader:  q 0 idle, 1..15 walk (amplitude q/15 = speed), 16 sitting, 17 phone (right arm up).
// The CPU advances the phase with the distance walked (speed-scaled stride), so the shader needs no time uniform.
import { mergeParts, boxPart } from './roadGeo.js';

export const ANIM = Object.freeze({ SIT: 16, PHONE: 17 });
const SKIN = [[0.85, 0.65, 0.5], [0.62, 0.43, 0.3], [0.42, 0.28, 0.2], [0.93, 0.75, 0.62]];

// shapes in metres, feet at y = 0, facing +Z. leg pivot = hip, arm pivot = shoulder
function body(THREE, o) {
  const { H, hip, sh, legW = 0.17, torsoW = 0.42, torsoD = 0.22, headS = 0.22, skin, hair, torsoC, legC, shoeC = [0.12, 0.1, 0.1], armC, extra = [] } = o;
  const parts = [], tag = [];
  const add = (p, part, mask) => { parts.push(p); tag.push([part, mask]); };
  const legH = hip, torsoH = sh - hip + 0.1, armL = sh - hip + 0.1;
  for (const sg of [-1, 1]) {
    add(boxPart(THREE, legW, legH - 0.07, legW, sg * torsoW * 0.27, 0.07 + (legH - 0.07) / 2, 0, legC), 2 + (sg > 0 ? 0.5 : 0), legC.mask ?? 0);
    add(boxPart(THREE, legW, 0.07, legW + 0.08, sg * torsoW * 0.27, 0.035, 0.04, shoeC), 2 + (sg > 0 ? 0.5 : 0), 0);
  }
  add(boxPart(THREE, torsoW, torsoH, torsoD, 0, hip + torsoH / 2 - 0.05, 0, torsoC), 0, 1);
  for (const sg of [-1, 1]) add(boxPart(THREE, 0.1, armL, 0.12, sg * (torsoW / 2 + 0.06), sh - armL / 2 + 0.05, 0, armC), 3 + (sg > 0 ? 0.5 : 0), armC.mask ?? 1);
  add(boxPart(THREE, headS, headS * 1.15, headS, 0, sh + 0.04 + headS * 0.58, 0, skin), 1, 0);
  add(boxPart(THREE, headS + 0.03, headS * 0.45, headS + 0.03, 0, sh + 0.04 + headS * 1.0, -0.01, hair), 1, 0);
  for (const x of extra) add(x.part, x.group ?? 0, x.mask ?? 0);
  const g = mergeParts(THREE, parts.map((p) => ({ geo: p.geo, m: p.m, color: p.color }))), N = g.attributes.position.count / parts.length;
  const aPart = new Float32Array(g.attributes.position.count), aMask = new Float32Array(g.attributes.position.count);
  tag.forEach(([p, m], i) => { aPart.fill(p, i * N, (i + 1) * N); aMask.fill(m, i * N, (i + 1) * N); });
  g.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1)); g.setAttribute('aMask', new THREE.BufferAttribute(aMask, 1));
  g.computeBoundingSphere();
  return g;
}
const col = (r, g, b, mask) => Object.assign([r, g, b], { mask });

export const VARIANTS = [
  { name: 'suit', H: 1.78, hip: 0.9, sh: 1.5, skin: SKIN[0], hair: [0.12, 0.1, 0.09], torsoC: [0.2, 0.2, 0.24], legC: col(0.17, 0.17, 0.2, 0), armC: col(0.2, 0.2, 0.24, 1) },
  { name: 'casual', H: 1.72, hip: 0.88, sh: 1.46, skin: SKIN[1], hair: [0.25, 0.16, 0.1], torsoC: [0.85, 0.85, 0.85], legC: col(0.2, 0.3, 0.5, 0), armC: col(0.85, 0.85, 0.85, 1) },
  { name: 'coat', H: 1.75, hip: 0.9, sh: 1.5, skin: SKIN[2], hair: [0.15, 0.15, 0.15], torsoC: [0.8, 0.8, 0.8], legC: col(0.15, 0.15, 0.17, 0), armC: col(0.8, 0.8, 0.8, 1), coat: true },
  { name: 'kid', H: 1.15, hip: 0.55, sh: 0.97, legW: 0.12, torsoW: 0.3, torsoD: 0.17, headS: 0.22, skin: SKIN[3], hair: [0.45, 0.3, 0.12], torsoC: [0.9, 0.9, 0.9], legC: col(0.25, 0.28, 0.4, 0), armC: col(0.9, 0.9, 0.9, 1) },
];

export function buildPedVariants(THREE) {
  return VARIANTS.map((v, i) => {
    const extra = [];
    if (v.coat) { // long coat skirt (swings with nothing: static, hides the thighs), hat + brim
      extra.push({ part: boxPart(THREE, 0.46, 0.5, 0.26, 0, 0.72, 0, [0.8, 0.8, 0.8]), group: 0, mask: 1 });
      extra.push({ part: boxPart(THREE, 0.27, 0.12, 0.27, 0, v.sh + 0.04 + 0.22 * 1.18, 0, [0.14, 0.12, 0.12]), group: 1 });
      extra.push({ part: boxPart(THREE, 0.38, 0.03, 0.38, 0, v.sh + 0.04 + 0.22 * 1.02, 0, [0.14, 0.12, 0.12]), group: 1 });
    }
    const geometry = body(THREE, { ...v, extra });
    const f = (n) => n.toFixed(3);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xffffff });
    material.customProgramCacheKey = () => 'ped-v' + i;   // onBeforeCompile text is identical for all variants, the shader is not
    material.userData.onShader = (shader) => {
      shader.vertexShader = 'attribute float aPart; attribute float aMask;\n' + shader.vertexShader
        .replace('#include <color_vertex>', `#include <color_vertex>
  vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, aMask);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float q = floor(aPhase / 8.0), ph = aPhase - q * 8.0;
  float amp = q > 15.5 ? 0.0 : q / 15.0, sw = sin(ph) * amp;
  float typ = floor(aPart), side = (aPart - typ) > 0.25 ? 1.0 : -1.0;
  float ang = 0.0, py = 0.0;
  if (typ > 1.5 && typ < 2.5) { py = ${f(v.hip)}; ang = sw * 0.75 * side; if (q > 15.5 && q < 16.5) ang = 1.5; }
  else if (typ > 2.5) { py = ${f(v.sh)}; ang = -sw * 0.65 * side; if (q > 16.5 && side > 0.0) ang = 1.25; if (q > 15.5 && q < 16.5) ang = 0.35; }
  float dy = transformed.y - py;
  transformed.z -= dy * sin(ang);
  transformed.y = py + dy * cos(ang) + abs(sw) * 0.03;
  transformed.y -= (q > 15.5 && q < 16.5) ? 0.42 * ${f(v.H / 1.75)} : 0.0;
}`);
    };
    const tris = geometry.attributes.position.count / 3;
    return { geometry, material, tris, onShader: material.userData.onShader };
  });
}
