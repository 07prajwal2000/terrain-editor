// Signalised junctions (junction style 'signals'): layout plan (pure geometry, runs in Node) + objects (instanced, a handful of draw calls).
// Per arm of the junction patch: a zebra crossing just outside the patch (ZEBRA_OFF..ZEBRA_OFF+ZEBRA_D from the patch anchor), a stop line before it
// (incoming lane only), a signal post on the driver's side beyond the stop line (pole + head with 3 lights facing the approaching traffic) and, on city
// arms, two short pedestrian railings along the kerb (thin cuboid colliders). The corner pavements themselves come from roadCity.js.
//
// Signal lights cycle VISUALLY (no real lights, no AI): arms of the same road share a phase group (0 / 1, alternating over the roads of the
// junction), group 1 is shifted by half a cycle. The lens shader reads ONE time uniform; call map.update(dt) once per frame.
//   cycle (s): green 9, amber 2, red 13 (period 24); group 1 = group 0 shifted by 12 s -> 1 s of all-red between the phases.
// ponytail: fixed-time two-phase cycle, no turn arrows, no pedestrian heads; a junction of 3+ roads still alternates road by road.
import { polyOf } from './roads.js';
import { CITY } from './roadMeta.js';
import { mergeParts, boxPart, cylPart, poseAlong, instancedMesh } from './roadGeo.js';

export const SIGNAL_CYCLE = Object.freeze({ green: 9, amber: 2, period: 24, shift: 12 });
export function signalState(group, t) { // 'green' | 'amber' | 'red' for phase group 0 / 1 at time t (s)
  const p = (((t + group * SIGNAL_CYCLE.shift) % SIGNAL_CYCLE.period) + SIGNAL_CYCLE.period) % SIGNAL_CYCLE.period;
  return p < SIGNAL_CYCLE.green ? 'green' : p < SIGNAL_CYCLE.green + SIGNAL_CYCLE.amber ? 'amber' : 'red';
}

// distances are measured outward from the patch anchor of an arm (where the corner blocks end and the footpath starts at full height): the zebra starts
// ZEBRA_OFF out so the kerb ramp (CITY.TAPER) that drops the kerb around it fits inside the footpath; railings start after the far ramp
const ZEBRA_OFF = CITY.TAPER + CITY.CROSS_HALF - 1.5 + 0.4, ZEBRA_D = 3, STOP_D = ZEBRA_OFF + ZEBRA_D + 1.1, POST_D = STOP_D + 1.0, POST_LAT = 0.9, POLE_H = 2.9, HEAD_Y = 3.4;
const RAIL_D0 = ZEBRA_OFF + 1.5 + CITY.CROSS_HALF + CITY.TAPER + 0.2, RAIL_D1 = RAIL_D0 + 3, RAIL_LAT = 0.4, RAIL_L = 1.5, RAIL_H = 1.0;
export const ZEBRA_DEPTH = ZEBRA_D;
const LIFT = 0.03;

// point at arc distance d from sample ai walking along the arm (dir = +-1): { x, z, dx, dz (outward tangent), s (polyline arc length) } or null when the arm is shorter
function alongArm(P, ai, dir, d) {
  let i = ai, acc = 0;
  while (i + dir >= 0 && i + dir < P.n) {
    const l = Math.hypot(P.x[i + dir] - P.x[i], P.z[i + dir] - P.z[i]);
    if (acc + l >= d) { const t = (d - acc) / (l || 1); return { x: P.x[i] + (P.x[i + dir] - P.x[i]) * t, z: P.z[i] + (P.z[i + dir] - P.z[i]) * t, dx: P.tx[i] * dir, dz: P.tz[i] * dir, s: P.s[ai] + dir * d }; }
    acc += l; i += dir;
  }
  return null;
}

// -> { arms[], posts[], rails[], zebras[], stops[], drops: [{ road, s0, s1 }] } for one signals junction (needs j._anch from the patch builder)
export function planSignals(j, roads, heightAt, driveSide) {
  const side = driveSide === 'left' ? -1 : 1, plan = { arms: [], posts: [], rails: [], zebras: [], stops: [], drops: [] }, order = [];
  (j._anch || []).forEach((a, k) => {
    const P = polyOf(roads[a.road]), meta = roads[a.road].points[P.seg[a.ai]], city = a.type === 'city';
    const key = a.road + ':' + a.pass; // a road passing the junction twice (it meets itself) gets one phase per pass
    if (!order.includes(key)) order.push(key);
    const group = order.indexOf(key) % 2, incoming = !meta.oneway || a.dir < 0; // one-way arm that leads AWAY from the junction needs no stop line / signal
    const pAx = (f) => -f.dz, pAz = (f) => f.dx; // lateral axis (+) of an arm frame
    const arm = { arm: k, road: a.road, roadId: a.roadId, group, incoming, city };
    const base = (x, z) => heightAt(x, z) + (city ? LIFT + CITY.KERB_H : 0);
    const zc = alongArm(P, a.ai, a.dir, ZEBRA_OFF + ZEBRA_D / 2);
    if (zc) {
      plan.zebras.push({ x: zc.x, z: zc.z, tx: zc.dx, tz: zc.dz, hw: a.hw, road: a.road, s: zc.s, kind: 'signals', junction: j, arm: k });
      if (city) plan.drops.push({ road: a.road, s0: zc.s - CITY.CROSS_HALF, s1: zc.s + CITY.CROSS_HALF });
    }
    const sl = alongArm(P, a.ai, a.dir, STOP_D);
    if (sl && incoming) { // incoming lane lateral range in the arm frame: traffic arrives on the driver's side = -side * (+lateral)
      const l0 = side > 0 ? -(a.hw - 0.4) : 0.25, l1 = side > 0 ? -0.25 : a.hw - 0.4;
      plan.stops.push({ x: sl.x, z: sl.z, dx: sl.dx, dz: sl.dz, l0, l1, arm: k });
    }
    const pp = alongArm(P, a.ai, a.dir, POST_D);
    if (pp && incoming) {
      const l = -side * (a.hw + POST_LAT), x = pp.x + pAx(pp) * l, z = pp.z + pAz(pp) * l;
      const post = { x, z, y: base(x, z), fx: pp.dx, fz: pp.dz, group, arm: k, roadId: a.roadId, road: a.road }; // head faces along the outward arm direction = toward approaching drivers
      plan.posts.push(post); arm.post = post;
    }
    if (city) for (const sg of [1, -1]) {
      const p0 = alongArm(P, a.ai, a.dir, RAIL_D0), p1 = alongArm(P, a.ai, a.dir, RAIL_D1); if (!p0 || !p1) continue;
      const l = sg * (a.hw + RAIL_LAT), A = [p0.x + pAx(p0) * l, p0.z + pAz(p0) * l], B = [p1.x + pAx(p1) * l, p1.z + pAz(p1) * l];
      plan.rails.push({ ax: A[0], az: A[1], ay: base(A[0], A[1]), bx: B[0], bz: B[1], by: base(B[0], B[1]), arm: k, side: sg });
    }
    plan.arms.push(arm);
  });
  return plan;
}

// ------------------------------------------------------------------ objects
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((c) => Math.pow(c, 2.2));

// plans: [{ plan, junction }]. -> { group, drawCalls, instances, colliders, uTime (shared uniform object), counts }
export function buildSignalObjects({ THREE, RAPIER, physicsWorld, plans, geos, colliders, mats }) {
  const group = new THREE.Group(); group.name = 'roadSignals';
  const uTime = { value: 0 }, res = { group, drawCalls: 0, instances: 0, uTime, counts: { posts: 0, rails: 0, colliders: 0 } };
  const posts = plans.flatMap((p) => p.posts), rails = plans.flatMap((p) => p.rails);
  const add = (m) => { if (m) { group.add(m); res.drawCalls++; res.instances += m.count; } };
  const std = (o) => { const m = new THREE.MeshStandardMaterial(o); mats.push(m); return m; };
  const yawQ = (fx, fz) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fx, fz)); // local +Z -> (fx, fz)
  if (posts.length) {
    const grey = rgb(0x70747b), dark = rgb(0x1b1d21);
    const pg = mergeParts(THREE, [cylPart(THREE, 0.05, 0.07, POLE_H, 0, POLE_H / 2, 0, grey, 8), boxPart(THREE, 0.34, 1.0, 0.3, 0, HEAD_Y, 0, dark), boxPart(THREE, 0.5, 1.2, 0.04, 0, HEAD_Y, -0.17, dark), boxPart(THREE, 0.36, 0.05, 0.42, 0, HEAD_Y + 0.55, 0.06, dark)]); geos.push(pg);
    const list = posts.map((p) => ({ x: p.x, y: p.y, z: p.z, q: yawQ(p.fx, p.fz) }));
    add(instancedMesh(THREE, pg, std({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), list, 'signal_posts'));
    // lenses: 3 discs (red top, amber, green) per head; colour from the shared time uniform + the head's phase group (instance attribute)
    const lenses = [0.3, 0, -0.3].map((dy) => ({ geo: new THREE.CircleGeometry(0.1, 12), m: new THREE.Matrix4().makeTranslation(0, HEAD_Y + dy, 0.152) }));
    const lg = mergeParts(THREE, lenses), per = lg.attributes.position.count / 3, lens = new Float32Array(lg.attributes.position.count);
    for (let i = 0; i < lens.length; i++) lens[i] = Math.floor(i / per);
    lg.setAttribute('aLens', new THREE.BufferAttribute(lens, 1)); geos.push(lg);
    const lm = new THREE.ShaderMaterial({
      uniforms: { uTime }, side: THREE.DoubleSide,
      vertexShader: `attribute float aLens; attribute float aGroup; uniform float uTime; varying vec3 vCol;
void main() {
  float p = mod(uTime + aGroup * ${SIGNAL_CYCLE.shift.toFixed(1)}, ${SIGNAL_CYCLE.period.toFixed(1)});
  float st = p < ${SIGNAL_CYCLE.green.toFixed(1)} ? 2.0 : (p < ${(SIGNAL_CYCLE.green + SIGNAL_CYCLE.amber).toFixed(1)} ? 1.0 : 0.0);
  vec3 base = aLens < 0.5 ? vec3(1.0, 0.08, 0.05) : (aLens < 1.5 ? vec3(1.0, 0.62, 0.02) : vec3(0.05, 0.95, 0.3));
  vCol = base * (abs(aLens - st) < 0.5 ? 1.6 : 0.1);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
    });
    mats.push(lm);
    const lensMesh = instancedMesh(THREE, lg, lm, list, 'signal_lenses');
    lg.setAttribute('aGroup', new THREE.InstancedBufferAttribute(new Float32Array(posts.map((p) => p.group)), 1));
    add(lensMesh);
    res.counts.posts = posts.length;
    if (physicsWorld) for (const p of posts) { colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cylinder((POLE_H + 0.1) / 2, 0.08).setTranslation(p.x, p.y + (POLE_H + 0.1) / 2 - 0.05, p.z).setFriction(0.3))); res.counts.colliders++; }
  }
  if (rails.length) {
    const body = rgb(0x2b2f36), top = rgb(0xdfe2e6), L = RAIL_L;
    const rg = mergeParts(THREE, [boxPart(THREE, 0.06, RAIL_H, 0.06, 0, RAIL_H / 2, 0, body), boxPart(THREE, L, 0.06, 0.05, L / 2, RAIL_H - 0.05, 0, top), boxPart(THREE, L, 0.05, 0.04, L / 2, RAIL_H * 0.55, 0, body), boxPart(THREE, L, 0.04, 0.04, L / 2, RAIL_H * 0.25, 0, body)]); geos.push(rg);
    const list = [];
    for (const r of rails) {
      const n = Math.max(1, Math.round(Math.hypot(r.bx - r.ax, r.bz - r.az) / RAIL_L));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, a = [r.ax + (r.bx - r.ax) * t0, r.ay + (r.by - r.ay) * t0, r.az + (r.bz - r.az) * t0], b = [r.ax + (r.bx - r.ax) * t1, r.ay + (r.by - r.ay) * t1, r.az + (r.bz - r.az) * t1];
        const { q, len } = poseAlong(THREE, a[0], a[1], a[2], b[0], b[1], b[2]); list.push({ x: a[0], y: a[1], z: a[2], q, sx: len / L });
      }
      if (physicsWorld) {
        const { q, len } = poseAlong(THREE, r.ax, r.ay, r.az, r.bx, r.by, r.bz);
        colliders.push(physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, RAIL_H / 2, 0.04).setTranslation((r.ax + r.bx) / 2, (r.ay + r.by) / 2 + RAIL_H / 2, (r.az + r.bz) / 2).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.3))); res.counts.colliders++;
      }
    }
    add(instancedMesh(THREE, rg, std({ vertexColors: true, roughness: 0.55, metalness: 0.3 }), list, 'pedestrian_railings'));
    res.counts.rails = rails.length;
  }
  return res;
}
