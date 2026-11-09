// A drivable car: Rapier chassis (compound of cuboids) + DynamicRayCastVehicleController + (optional) Three.js visual.
//
//   const v = new Vehicle({ RAPIER, world, map, car, profile, bounds, spawn: {x, y, z, yaw} })   // physics only: runs in Node (scripts/test-vehicles.mjs)
//   v.fixedStep(input)            // ONE physics step of v.dt seconds: controls -> forces -> wheel rays -> world.step() -> bookkeeping
//   v.attachVisual(THREE, scene)  // browser: GLB scene (nodes body, wheel_fl/fr/rl/rr + extra wheels) becomes v.visual
//   v.updateVisual(alpha)         // interpolates the last two physics poses (alpha = accumulator / dt) -> no jitter at any refresh rate
//
// Conventions (same as cars.json): Y up, metres, car faces +Z, LEFT = +X. Input steer: +1 = RIGHT. Wheel order: 0 fl, 1 fr, 2 rl, 3 rr.
// Rapier facts this file relies on (verified numerically while writing it, see the probes in scripts/test-vehicles.mjs):
//  - axle (-1,0,0) makes positive engine force drive towards +Z, and a positive wheel steering angle turn LEFT (about +Y).
//  - engine force is Newtons per wheel; brake is a max IMPULSE per step (so brake force = brake / dt) and is ignored while that wheel has engine force.
//  - spring/damper forces are multiplied by the chassis mass inside Rapier (stiffness is per kg), tyre force limit = frictionSlip * suspension force.
//  - the suspension ray is only rest+radius long, so the wheel can compress by `travel` below rest but never extend past rest.
//  - the controller excludes its own chassis from the wheel rays automatically.
// Fixed step: dt = 1/120 s. The raycast model has stiff springs and a hard friction clamp that get noisy at 60 Hz for the 0.2 s-period sports
// suspension; 120 Hz costs ~2 steps per displayed frame for one car (measured in the report), and render interpolation hides the rate.
import { SURFACE_FRICTION } from '../world/mapLoader.js';
import { ASSIST } from './handling.js';

const G = 9.81, KMH = 1 / 3.6;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// bridge deck / ramp: plain smooth road (surfaceAt only knows the ground BELOW a deck, so its road metadata must not be used up there)
const DECK = { classId: 6, weights: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0]), roadSurface: 'smooth', roughness: 0, gripMul: 1 };
const DECK_H = 0.8;                 // contact more than this above heightAt = deck. ponytail: a deck lower than 0.8 m over a gravel road still inherits it (no height in surfaceAt)
// Road roughness (see preStep): per wheel contact, vertical impulse = kick * wheel load * dt,
//   kick = clamp(ROUGH_KICK * roughness * roughResponse * min(|vf| / 80 km/h, 1.5) * noise(x, z), +-0.6)   (fraction of the wheel's weight; zero-mean noise => no net energy bias; never > 0.6 g so no launch)
const ROUGH_KICK = 2.0, ROUGH_CELL = 1.5; // noise lattice spacing in metres (~ one bump per 1.5 m)
// deterministic value noise in [-1, 1] from the world position: front and rear wheels hit the same potholes; at standstill the speed gate makes the kick 0
const hash = (i, j) => { let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1; };
function bumpNoise(x, z) {
  x /= ROUGH_CELL; z /= ROUGH_CELL;
  const i = Math.floor(x), j = Math.floor(z), u = smooth(x - i), v = smooth(z - j);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'];

// rotate (x,y,z) by quaternion q -> out
function rot(q, x, y, z, out) {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  out[0] = x + q.w * tx + (q.y * tz - q.z * ty);
  out[1] = y + q.w * ty + (q.z * tx - q.x * tz);
  out[2] = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class Vehicle {
  constructor({ RAPIER, world, map, car, profile, bounds, spawn = { x: 0, y: 1, z: 0, yaw: 0 }, dt = 1 / 120 }) {
    this.R = RAPIER; this.world = world; this.map = map; this.car = car; this.p = profile; this.dt = dt;
    const d = car.dimensions;
    this.bounds = bounds || { min: [-d.width / 2, 0.3, -d.length / 2], max: [d.width / 2, d.height, d.length / 2] };
    this.wheelPos = WHEEL_KEYS.map((k) => car.wheels[k].slice());
    this.radius = car.wheelRadius;
    this.wheelbase = car.wheelbase; this.track = car.trackWidth;
    world.timestep = dt;

    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z).setRotation({ x: 0, y: Math.sin(spawn.yaw / 2), z: 0, w: Math.cos(spawn.yaw / 2) })
      .setCcdEnabled(true).setCanSleep(false));
    this.colliders = [];
    this.ctl = world.createVehicleController(this.body);
    for (let i = 0; i < 4; i++) {
      const w = this.wheelPos[i];
      this.ctl.addWheel({ x: w[0], y: w[1] + 0.3, z: w[2] }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.3, this.radius);
    }
    // per-step scratch + state
    this.ax = { f: [0, 0, 1], u: [0, 1, 0], l: [1, 0, 0] };
    this.aLong = 0; this.aLat = 0; this.prevLv = { x: 0, y: 0, z: 0 }; this.muEff = 1;
    this.steer = 0;                  // centre steering angle, rad, + = RIGHT
    this.wSteer = [0, 0, 0, 0];      // applied (Rapier sign: + = left) per wheel
    this.wGrip = [1, 1, 1, 1]; this.wRoad = [1, 1, 1, 1]; this.wSoft = [0, 0, 0, 0];
    this.contact = [false, false, false, false];
    this.len = [0, 0, 0, 0]; this.prevLen = [0, 0, 0, 0];
    this.spin = [0, 0, 0, 0]; this.prevSpin = [0, 0, 0, 0]; this.spinRate = [0, 0, 0, 0];
    this.nContact = 0; this.airborne = false; this.airTime = 0;
    this.surfaceClass = 6; this.roadSurface = null; this.roadGrip = 1; this.shake = 0; this.inWater = false; this.submerged = 0; this.broken = false;
    this.state = { speed: 0, kmh: 0, vf: 0, gear: 1, rpm: 0, throttle: 0, brake: 0, airborne: false, surface: 6, roadSurface: null, roughness: 0, shake: 0, inWater: false, slip: 0, latG: 0 };
    this.stats = { minLen: [9, 9, 9, 9] };
    this._tmp = { x: 0, y: 0, z: 0 };
    this.applyProfile();
    this.prevPose = null; this.curPose = null;
    this.resetAt(spawn.x, spawn.y, spawn.z, spawn.yaw);
  }

  // (Re)apply every profile value: mass props, damping, colliders, wheel parameters. Safe to call live (tuning panel).
  applyProfile() {
    const p = this.p, R = this.R, b = this.bounds, m = p.mass;
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], l = b.max[2] - b.min[2];
    // --- suspension geometry: static length gives the manifest hub height at rest
    const loadFront = clamp((p.comZ - this.wheelPos[2][2]) / (this.wheelPos[0][2] - this.wheelPos[2][2]), 0.25, 0.75);
    this.share = [loadFront / 2, loadFront / 2, (1 - loadFront) / 2, (1 - loadFront) / 2];
    this.staticLen = this.share.map((s) => p.suspRest - Math.min(s * G / p.suspStiffness, p.suspTravel * 0.85));
    this.minLen = p.suspRest - p.suspTravel;
    // --- mass properties (colliders have density 0, so mass/COM/inertia are exactly the profile's)
    const K = 0.6, comY = this.comY = p.comFrac * (this.car.dimensions.height);
    const mi = p.inertia;
    this.inertia = [K * m / 12 * (h * h + l * l) * mi.pitch, K * m / 12 * (w * w + l * l) * mi.yaw, K * m / 12 * (w * w + h * h) * mi.roll];
    this.body.setAdditionalMassProperties(m, { x: 0, y: comY, z: p.comZ }, { x: this.inertia[0], y: this.inertia[1], z: this.inertia[2] }, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinearDamping(p.linDamp); this.body.setAngularDamping(p.angDamp);
    // --- chassis collider: chamfered convex hull lower body + narrower cabin box
    // Bottom kept above the fully compressed wheels; front & rear underside chamfered >= 30 deg
    for (const c of this.colliders) this.world.removeCollider(c, false);
    this.colliders = [];
    const used = Math.max(...this.staticLen) - this.minLen;
    const bottom = Math.min(Math.max(b.min[1], used + 0.12), b.max[1] - 0.5), top = b.max[1], mid = bottom + (top - bottom) * 0.5;
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const hx = w * 0.5 * 0.97, hz = l * 0.5 * 0.97;
    const zF = cz + hz, zR = cz - hz;
    const zFw = this.wheelPos[0][2], zRw = this.wheelPos[2][2];
    const fwdOverhang = Math.max(0.2, zF - zFw), revOverhang = Math.max(0.2, zRw - zR);

    // 30 degree approach / departure angle from wheel ground contact
    const tan30 = Math.tan(30 * Math.PI / 180);
    const reqY_F = fwdOverhang * tan30;
    const reqY_R = revOverhang * tan30;
    const yNoseF = Math.min(mid - 0.05, Math.max(bottom + 0.20, reqY_F));
    const yNoseR = Math.min(mid - 0.05, Math.max(bottom + 0.20, reqY_R));
    const zNoseF = zF - fwdOverhang * 0.08;
    const zNoseR = zR + revOverhang * 0.08;
    const zChamferF = zFw + 0.1 * fwdOverhang;
    const zChamferR = zRw - 0.1 * revOverhang;

    const pts = [];
    const bottomPts = [];
    for (const sx of [-1, 1]) {
      const x = cx + sx * hx;
      pts.push([x, mid, zF], [x, mid, zR]);
      pts.push([x, yNoseF, zNoseF], [x, yNoseR, zNoseR]);
      pts.push([x, bottom, zChamferF], [x, bottom, zChamferR]);
      bottomPts.push([x, bottom, zChamferF], [x, bottom, zChamferR]);
      bottomPts.push([x, yNoseF, zNoseF], [x, yNoseR, zNoseR]);
    }

    const hullDesc = R.ColliderDesc.convexHull(new Float32Array(pts.flat()))
      .setDensity(0).setFriction(0.05).setRestitution(0)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min);
    this.colliders.push(this.world.createCollider(hullDesc, this.body));

    const cabinDesc = R.ColliderDesc.cuboid(w * 0.5 * 0.8, (top - mid) / 2, l * 0.28)
      .setTranslation(cx, (top + mid) / 2, cz - l * 0.05)
      .setDensity(0).setFriction(0.05).setRestitution(0)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min);
    this.colliders.push(this.world.createCollider(cabinDesc, this.body));

    this.hull = { hx, bottom, hz, cx, cz, bottomPts };
    // --- derived engine / drag numbers
    this.vTop = p.topSpeed * KMH; this.vKnee = p.kneeKmh * KMH; this.F0 = m * p.launchAccel;
    const v94 = 0.94 * this.vTop;
    this.dragK = 0.35 * this.engineCurve(v94) / (v94 * v94);
    this.crr = 0.012; this.softDrag = 0.4;
    this.maxF = p.suspMaxForceX * m * G / 4;
    // --- wheels
    const c = this.ctl;
    for (let i = 0; i < 4; i++) {
      const wp = this.wheelPos[i];
      c.setWheelChassisConnectionPointCs(i, { x: wp[0], y: wp[1] + this.staticLen[i], z: wp[2] });
      c.setWheelSuspensionRestLength(i, p.suspRest); c.setWheelMaxSuspensionTravel(i, p.suspTravel);
      c.setWheelRadius(i, this.radius);
      c.setWheelSuspensionStiffness(i, p.suspStiffness);
      const sq = Math.sqrt(p.suspStiffness);
      c.setWheelSuspensionCompression(i, p.suspCompression * sq); c.setWheelSuspensionRelaxation(i, p.suspRelaxation * sq);
      c.setWheelMaxSuspensionForce(i, this.maxF);
      c.setWheelSideFrictionStiffness(i, p.sideStiff);
      c.setWheelFrictionSlip(i, i < 2 ? p.gripFront : p.gripRear);
    }
    for (let i = 0; i < 4; i++) { this.len[i] = this.prevLen[i] = this.staticLen[i]; }
    this.shares = p.drive === 'FWD' ? [0.5, 0.5, 0, 0] : p.drive === 'RWD' ? [0, 0, 0.5, 0.5] : [p.frontBias / 2, p.frontBias / 2, (1 - p.frontBias) / 2, (1 - p.frontBias) / 2];
  }

  // centre steering lock (rad) available at forward speed v (m/s): full at standstill, fades to steerMinFrac at steerSpeedKmh
  // ... and never more than what the tyres can hold: atan(wheelbase * steerGrip * mu * g / v^2) (so soft surfaces also shrink the lock = understeer)
  steerLock(v) {
    const p = this.p, lock = p.steerMaxDeg * Math.PI / 180 * (1 - (1 - p.steerMinFrac) * smooth(Math.abs(v) / (p.steerSpeedKmh * KMH)));
    return Math.min(lock, Math.atan(this.wheelbase * p.steerGrip * this.muEff * G / Math.max(v * v, 1)));
  }

  // total tractive force (N) available at forward speed v (m/s), throttle 1: constant up to the knee, constant power beyond, soft limiter at top speed
  engineCurve(v) {
    v = Math.abs(v);
    const f = v < this.vKnee ? this.F0 : this.F0 * this.vKnee / v;
    return f * clamp((this.vTop - v) / (0.06 * this.vTop), 0, 1);
  }

  // surface grip multiplier + softness for a wheel from the map's per-class weights, times the road-surface factor:
  //   grip = classMult * road,   road = 1 - (1 - sf.gripMul) / max(offRoad, 1)
  // classMult is 1 on every road, so the two never stack there. offRoad only SOFTENS the road-surface loss (SUV / monster shrug off gravel);
  // sports (offRoad < 1) get exactly gripMul, their "hates dirt" penalty already lives in the class factor.
  surfaceMult(sf) {
    const off = this.p.offRoad; let mult = 0, soft = 0;
    for (let c = 0; c < 8; c++) {
      const w = sf.weights[c]; if (w <= 0) continue;
      const loss = 1 - SURFACE_FRICTION[c];
      mult += w * clamp(1 - loss / off, 0.2, 1.15); soft += w * loss * loss; // soft ~ loss^2: sand/snow drag hard, grass hardly
    }
    const road = 1 - (1 - (sf.gripMul ?? 1)) / Math.max(off, 1);
    return { mult: mult * road, soft: soft / off, road };
  }

  fixedStep(input) {
    this.preStep(input, this.dt);
    this.world.step();
    this.postStep(this.dt);
  }

  preStep(inp, dt) {
    // missing/NaN fields count as 0 (a NaN input would poison the whole sim)
    const input = { throttle: +inp.throttle || 0, brake: +inp.brake || 0, steer: +inp.steer || 0, handbrake: +inp.handbrake || 0, pitch: +inp.pitch || 0, roll: +inp.roll || 0, yaw: +inp.yaw || 0 };
    const p = this.p, b = this.body, c = this.ctl, m = p.mass, map = this.map;
    const q = b.rotation(), lv = b.linvel(), av = b.angvel(), pos = b.translation();
    const A = this.ax; rot(q, 0, 0, 1, A.f); rot(q, 0, 1, 0, A.u); rot(q, 1, 0, 0, A.l);
    const vf = lv.x * A.f[0] + lv.y * A.f[1] + lv.z * A.f[2];
    const vl = lv.x * A.l[0] + lv.y * A.l[1] + lv.z * A.l[2];
    const speed = Math.hypot(lv.x, lv.y, lv.z), vAbs = Math.abs(vf);
    const nC = this.nContact, groundFrac = nC / 4;
    const wUp = av.x * A.u[0] + av.y * A.u[1] + av.z * A.u[2];
    { // specific force (what an accelerometer would read: acceleration minus gravity) along the car's axes, low-passed; drives the body lean below
      const pl = this.prevLv, k = 1 - Math.exp(-dt / 0.06);
      const ax_ = (lv.x - pl.x) / dt, ay_ = (lv.y - pl.y) / dt + G, az_ = (lv.z - pl.z) / dt;
      const al = clamp(ax_ * A.l[0] + ay_ * A.l[1] + az_ * A.l[2], -25, 25), af = clamp(ax_ * A.f[0] + ay_ * A.f[1] + az_ * A.f[2], -25, 25);
      this.aLat += (al - this.aLat) * k; this.aLong += (af - this.aLong) * k;
      pl.x = lv.x; pl.y = lv.y; pl.z = lv.z;
    }
    const hb = input.handbrake > 0.5;

    // ---- water: heavy drag, weak engine, timer for the auto reset
    const wl = map.waterLevelAt ? map.waterLevelAt(pos.x, pos.z) : null;
    this.inWater = wl !== null && pos.y + 0.25 < wl;
    this.submerged = this.inWater ? this.submerged + dt : 0;
    if (this.inWater) { const k = 1 - Math.exp(-2.8 * dt); b.applyImpulse({ x: -lv.x * m * k, y: -lv.y * m * k * 0.5, z: -lv.z * m * k }, true); }

    // ---- per-wheel surface lookup (uses last step's contact points)
    const tmp = this._tmp; let sfClass = this.surfaceClass, rsName = this.roadSurface, softSum = 0, softN = 0, roadSum = 0, roughSum = 0;
    const speedK = Math.min(vAbs / (80 * KMH), 1.5);
    for (let i = 0; i < 4; i++) {
      if (this.contact[i]) {
        c.wheelContactPoint(i, tmp);
        let sf = map.surfaceAt(tmp.x, tmp.z);
        // contact well above the terrain = bridge deck / ramp: surfaceAt only knows the ground below, so use smooth road. gripMul / roughness /
        // roadSurface are only trusted for contacts within DECK_H of heightAt (the real ground), never for a deck above a gravel road.
        if (tmp.y - map.heightAt(tmp.x, tmp.z) > DECK_H) sf = DECK;
        const s = this.surfaceMult(sf), rough = sf.roughness ?? 0;
        this.wGrip[i] = s.mult; this.wRoad[i] = s.road; this.wSoft[i] = s.soft; sfClass = sf.classId; rsName = sf.roadSurface ?? null; // last wheel in contact wins (rear = the driven axle)
        softSum += s.soft; roadSum += s.road; roughSum += rough; softN++;
        if (rough > 0 && speedK > 0.01) { // pothole / rumble jolt: vertical impulse at the contact patch, proportional to the wheel's load, 0 at standstill
          const load = Math.min(c.wheelSuspensionForce(i), 2 * this.share[i] * m * G);
          const kick = clamp(ROUGH_KICK * rough * (p.roughResponse ?? 1) * speedK * bumpNoise(tmp.x, tmp.z), -0.6, 0.6);
          const J = kick * load * dt;
          b.applyImpulseAtPoint({ x: A.u[0] * J, y: A.u[1] * J, z: A.u[2] * J }, { x: tmp.x, y: tmp.y, z: tmp.z }, true);
        }
      }
    }
    this.surfaceClass = sfClass; this.roadSurface = rsName;
    this.roadGrip = softN ? roadSum / softN : 1;
    { // camera shake amount (~0..1.2): mean roughness x speed factor, low-passed; the chase camera turns it into actual motion
      const target = softN ? roughSum / softN * speedK / 1.5 * 1.2 : 0;
      this.shake += (target - this.shake) * (1 - Math.exp(-dt / 0.15));
      this.state.shake = this.shake; this.state.roughness = softN ? roughSum / softN : 0; this.state.roadSurface = rsName;
    }
    this.muEff = (p.gripFront * (this.wGrip[0] + this.wGrip[1]) + p.gripRear * (this.wGrip[2] + this.wGrip[3])) / 4;

    // ---- steering: speed-sensitive lock, rate limited, Ackermann per wheel, optional rear steer
    const lockMax = p.steerMaxDeg * Math.PI / 180, lock = this.steerLock(vAbs);
    const target = clamp(input.steer, -1, 1) * lock;
    const rate = (Math.abs(target) < Math.abs(this.steer) || target * this.steer < 0 ? p.steerReturn : p.steerRate) * lockMax * dt;
    this.steer += clamp(target - this.steer, -rate, rate);
    if (Math.abs(this.steer) > lock) this.steer = Math.sign(this.steer) * lock; // lock shrinks as speed grows
    const sgn = Math.sign(this.steer), ad = Math.abs(this.steer);
    let outer = ad, inner = ad;
    if (ad > 1e-4) { const Rr = this.wheelbase / Math.tan(ad); outer = Math.atan(this.wheelbase / (Rr + this.track / 2)); inner = Math.atan(this.wheelbase / (Rr - this.track / 2)); }
    // right turn (sgn>0): right wheels (odd idx) are inner. Rapier: + = left, so negate.
    const f = [-sgn * (sgn > 0 ? outer : inner), -sgn * (sgn > 0 ? inner : outer)];
    this.wSteer[0] = f[0]; this.wSteer[1] = f[1];
    this.wSteer[2] = -f[0] * p.rearSteer; this.wSteer[3] = -f[1] * p.rearSteer;
    for (let i = 0; i < 4; i++) c.setWheelSteering(i, this.wSteer[i]);

    // ---- throttle / brake / reverse logic (arcade: S brakes while rolling forward, reverses once stopped)
    const thr = clamp(input.throttle, 0, 1), brk = clamp(input.brake, 0, 1);
    let engine = 0, brake = 0;
    if (brk > 0.01 && vf > 1.2) brake = brk;
    else if (thr > 0.01 && vf < -1.2) brake = thr;
    else if (thr > 0.01) engine = this.engineCurve(vf) * thr;
    else if (brk > 0.01) engine = -0.6 * this.F0 * brk * clamp(1 - vAbs / (p.reverseKmh * KMH), 0, 1);
    else if (vAbs < 1.2) brake = 0.45 * (1 - vAbs / 1.2) + 0.1; // auto-hold: parked cars do not creep down slopes
    const soft = softN ? softSum / softN : 0;
    if (this.inWater) engine *= 0.35;
    // torque split: nominal drive shares, shifted towards the wheels that carry load (previous step's spring force) = poor man's limited-slip /
    // traction control, so an unloaded axle (steep climb) or a wheel in the air does not waste the engine force
    const tc = 0.4 + 0.6 * p.assist, sh = this.shares; let meanLoad = 0, nd = 0;
    for (let i = 0; i < 4; i++) if (sh[i] > 0) { meanLoad += this.contact[i] ? c.wheelSuspensionForce(i) : 0; nd++; }
    meanLoad /= nd || 1;
    const eff = [0, 0, 0, 0]; let es = 0;
    for (let i = 0; i < 4; i++) if (sh[i] > 0) { const nl = meanLoad > 1 ? (this.contact[i] ? c.wheelSuspensionForce(i) : 0) / meanLoad : 1; eff[i] = sh[i] * (1 - tc + tc * nl); es += eff[i]; }
    const driven = eff.map((e) => (es > 0 ? engine * e / es : 0));
    if (hb) { driven[2] = driven[3] = 0; }
    const svc = brake * p.brakeG * m * G * dt;  // total impulse per step
    const hbk = hb ? p.handbrakeG * m * G * dt : 0;
    const wb = [svc * 0.3, svc * 0.3, svc * 0.2 + hbk * 0.5, svc * 0.2 + hbk * 0.5];
    // Rapier's friction cap alone barely bites on a good road (brake / engine demand stays below mu*load), so on loose road surfaces (gravel 0.7, potholes 0.9)
    // the engine force and brake impulse are scaled by the wheel's road factor as well: gravel = ~30 % less drive and braking, ~40 % longer stops.
    for (let i = 0; i < 4; i++) {
      c.setWheelEngineForce(i, driven[i] * this.wRoad[i]);
      c.setWheelBrake(i, wb[i] * this.wRoad[i]);
      c.setWheelFrictionSlip(i, (i < 2 ? p.gripFront : p.gripRear) * this.wGrip[i] * (hb && i >= 2 ? p.handbrakeSlip : 1));
    }
    this.state.throttle = thr; this.state.brake = brk;

    // ---- drag, rolling resistance (worse on soft ground), downforce
    if (speed > 0.01) {
      const crr = this.crr + soft * this.softDrag;
      const fr = (this.dragK * speed * speed + groundFrac * crr * m * G) * dt;
      const k = Math.min(fr, m * speed * 0.6) / speed;
      b.applyImpulse({ x: -lv.x * k, y: -lv.y * k * 0.2, z: -lv.z * k }, true);
    }
    if (p.downforce > 0 && vAbs > 1) {
      const df = p.downforce * m * G * (vAbs / 27.8) ** 2 * dt;
      b.applyImpulse({ x: -A.u[0] * df, y: -A.u[1] * df, z: -A.u[2] * df }, true);
    }

    // ---- anti-roll (stabiliser bar) per axle: push up where compressed more, down on the other side
    const ar = p.antiRoll * (1 + ASSIST.rollBoost * p.assist);
    if (ar > 0) for (let ax = 0; ax < 2; ax++) {
      const L = ax * 2, Rr = ax * 2 + 1;
      if (!this.contact[L] && !this.contact[Rr]) continue;
      const compL = this.contact[L] ? p.suspRest - this.len[L] : 0, compR = this.contact[Rr] ? p.suspRest - this.len[Rr] : 0;
      const F = 0.5 * ar * m * (compL - compR) * dt;
      for (const [i, s] of [[L, 1], [Rr, -1]]) if (this.contact[i]) {
        const hp = c.wheelHardPoint(i, tmp);
        b.applyImpulseAtPoint({ x: A.u[0] * F * s, y: A.u[1] * F * s, z: A.u[2] * F * s }, { x: hp.x, y: hp.y, z: hp.z }, true);
      }
    }

    // ---- arcade assists on the ground: yaw damping (spin-out catcher) + lateral slide grip
    // ---- body lean: Rapier applies tyre forces at a lowered height, so cars would not roll/pitch; add the missing inertial moment about the COM
    //      (lateral specific force -> roll to the OUTSIDE, longitudinal -> squat/dive). leanRoll/leanPitch scale it (1 = physical).
    if (nC > 0 && (p.leanRoll > 0 || p.leanPitch > 0)) {
      const hc = this.comY * 0.9;
      const tr = p.leanRoll * m * this.aLat * hc * dt, tp = -p.leanPitch * m * this.aLong * hc * dt;
      b.applyTorqueImpulse({ x: A.f[0] * tr + A.l[0] * tp, y: A.f[1] * tr + A.l[1] * tp, z: A.f[2] * tr + A.l[2] * tp }, true);
    }
    // ---- anti-rollover / anti-backflip assist: past tipDeg of roll (resp. tipPitchDeg of pitch) relative to the ground (mean wheel contact normal)
    //      a restoring torque ramps in, scaled by assist. Normal driving never gets there; it only catches flips.
    if (nC > 0 && p.assist > 0) {
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < 4; i++) if (this.contact[i]) { c.wheelContactNormal(i, tmp); nx += tmp.x; ny += tmp.y; nz += tmp.z; }
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const rollRel = Math.asin(clamp(A.l[0] * nx + A.l[1] * ny + A.l[2] * nz, -1, 1)), pitchRel = Math.asin(clamp(A.f[0] * nx + A.f[1] * ny + A.f[2] * nz, -1, 1));
      const exR = Math.abs(rollRel) - p.tipDeg * Math.PI / 180, exP = Math.abs(pitchRel) - p.tipPitchDeg * Math.PI / 180;
      if (exR > 0 || exP > 0) {
        const wRoll = av.x * A.f[0] + av.y * A.f[1] + av.z * A.f[2], wPitch = av.x * A.l[0] + av.y * A.l[1] + av.z * A.l[2];
        const kk = p.assist * dt;
        const tr = exR > 0 ? -Math.sign(rollRel) * this.inertia[2] * kk * (ASSIST.tipGain * exR) - this.inertia[2] * kk * ASSIST.tipDamp * wRoll : 0;
        const tp = exP > 0 ? Math.sign(pitchRel) * this.inertia[0] * kk * (ASSIST.tipGain * exP) - this.inertia[0] * kk * ASSIST.tipDamp * wPitch : 0;
        b.applyTorqueImpulse({ x: A.f[0] * tr + A.l[0] * tp, y: A.f[1] * tr + A.l[1] * tp, z: A.f[2] * tr + A.l[2] * tp }, true);
      }
    }
    if (nC >= 2 && p.assist > 0) {
      const wExp = vf * Math.tan(-this.steer) / this.wheelbase;
      const kYaw = ASSIST.yawDamp * p.assist * (hb ? 0.2 : 1);
      const ti = -this.inertia[1] * (wUp - wExp) * kYaw * dt * groundFrac;
      b.applyTorqueImpulse({ x: A.u[0] * ti, y: A.u[1] * ti, z: A.u[2] * ti }, true);
      if (!hb) {
        const rg = this.roadGrip; // slide assist scales with the road-surface grip, so gravel really slides
        const a = clamp(-vl * ASSIST.slideGrip * p.assist * rg, -ASSIST.slideMaxAccel * p.assist * rg, ASSIST.slideMaxAccel * p.assist * rg) * groundFrac;
        const J = m * a * dt;
        b.applyImpulse({ x: A.l[0] * J, y: A.l[1] * J, z: A.l[2] * J }, true);
      }
    }

    // ---- air: keys = pitch (throttle/brake: W nose down), roll (steer), yaw (Q/E); else self-right gently
    if (nC === 0) {
      const pi = clamp(input.throttle - input.brake + input.pitch, -1, 1), ro = clamp(input.steer + input.roll, -1, 1), ya = clamp(input.yaw, -1, 1);
      const have = Math.abs(pi) + Math.abs(ro) + Math.abs(ya) > 0.05;
      let tl = [0, 0, 0];
      if (have) {
        const wl3 = [0, 0, 0]; // angular velocity in body axes, to stop adding torque past a cap
        wl3[0] = av.x * A.l[0] + av.y * A.l[1] + av.z * A.l[2]; wl3[1] = wUp; wl3[2] = av.x * A.f[0] + av.y * A.f[1] + av.z * A.f[2];
        const cap = 4.2;
        const tx = (pi > 0 ? wl3[0] < cap : wl3[0] > -cap) ? pi : 0, tz = (ro > 0 ? wl3[2] < cap : wl3[2] > -cap) ? ro : 0, ty = (ya > 0 ? wl3[1] > -cap : wl3[1] < cap) ? -ya : 0;
        // body axes: x=left(+pitch down), y=up(+left yaw), z=forward(+roll right)
        tl = [tx * p.airControl * this.inertia[0], ty * p.airControl * this.inertia[1], tz * p.airControl * this.inertia[2]];
      }
      if (!have && p.assist > 0) { // self-right gently: angular accel about up x worldUp, plus damping of the tumble
        const k = ASSIST.selfRight * p.assist, damp = 1.2 * p.assist, Im = (this.inertia[0] + this.inertia[1] + this.inertia[2]) / 3;
        const ex = -A.u[2] * k - av.x * damp, ey = -av.y * damp * 0.5, ez = A.u[0] * k - av.z * damp;
        b.applyTorqueImpulse({ x: ex * Im * dt, y: ey * Im * dt, z: ez * Im * dt }, true);
      }
      if (have) {
        const wx = A.l[0] * tl[0] + A.u[0] * tl[1] + A.f[0] * tl[2], wy = A.l[1] * tl[0] + A.u[1] * tl[1] + A.f[1] * tl[2], wz = A.l[2] * tl[0] + A.u[2] * tl[1] + A.f[2] * tl[2];
        b.applyTorqueImpulse({ x: wx * dt, y: wy * dt, z: wz * dt }, true);
      }
    }

    // ---- wheel rays + suspension + tyre forces (modifies the chassis velocity), then the caller steps the world
    c.updateVehicle(dt, undefined, undefined, undefined);

    // ---- clamps (after updateVehicle so its impulses are included)
    const v2 = b.linvel(), vmax = this.vTop * 1.6 + 40, sp2 = Math.hypot(v2.x, v2.y, v2.z);
    if (sp2 > vmax) b.setLinvel({ x: v2.x * vmax / sp2, y: v2.y * vmax / sp2, z: v2.z * vmax / sp2 }, true);
    const a2 = b.angvel(), aw = Math.hypot(a2.x, a2.y, a2.z);
    if (aw > p.maxAngVel) b.setAngvel({ x: a2.x * p.maxAngVel / aw, y: a2.y * p.maxAngVel / aw, z: a2.z * p.maxAngVel / aw }, true);
  }

  postStep(dt) {
    const b = this.body, c = this.ctl, t = b.translation(), r = b.rotation(), lv = b.linvel();
    if (!(Number.isFinite(t.x + t.y + t.z + r.x + r.y + r.z + r.w + lv.x + lv.y + lv.z)) || Math.abs(t.y) > 1e5) this.broken = true;
    this.prevPose = this.curPose;
    this.curPose = { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
    let n = 0;
    const A = this.ax, vf = lv.x * A.f[0] + lv.y * A.f[1] + lv.z * A.f[2];
    for (let i = 0; i < 4; i++) {
      this.contact[i] = c.wheelIsInContact(i);
      if (this.contact[i]) n++;
      this.prevLen[i] = this.len[i]; this.len[i] = c.wheelSuspensionLength(i);
      if (this.len[i] < this.stats.minLen[i]) this.stats.minLen[i] = this.len[i];
      this.prevSpin[i] = this.spin[i]; 
      this.spinRate[i] = this.contact[i] ? vf / this.radius : this.spinRate[i] * 0.995;
      this.spin[i] += this.spinRate[i] * dt;
    }
    this.nContact = n; this.airborne = n === 0; this.airTime = this.airborne ? this.airTime + dt : 0;
    const s = this.state, speed = Math.hypot(lv.x, lv.y, lv.z);
    s.speed = speed; s.vf = vf; s.kmh = Math.abs(vf) * 3.6; s.airborne = this.airborne; s.surface = this.surfaceClass; s.inWater = this.inWater;
    // fake gearbox for the HUD: gear boundaries are spaced so each gear covers a similar chunk of the rev range
    const N = this.p.gears, u = clamp(Math.abs(vf) / this.vTop, 0, 1.2), edge = (g) => Math.pow((g + 1) / N, 0.85);
    let g = 0; while (g < N - 1 && u > edge(g)) g++;
    const lo = g === 0 ? 0 : edge(g - 1), hi = edge(g);
    s.gear = vf < -0.5 ? -1 : g + 1; s.rpm = clamp(0.2 + 0.8 * (u - lo) / (hi - lo), 0, 1);
    s.slip = Math.abs(lv.x * A.l[0] + lv.y * A.l[1] + lv.z * A.l[2]);
  }

  // ---- teleports
  resetAt(x, y, z, yaw) {
    const b = this.body;
    b.setTranslation({ x, y, z }, true); b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.aLong = 0; this.aLat = 0; this.prevLv = { x: 0, y: -G * this.dt, z: 0 }; this.steer = 0; this.submerged = 0; this.broken = false; this.airTime = 0; this.shake = 0; this.roadSurface = null; this.roadGrip = 1;
    for (let i = 0; i < 4; i++) { this.len[i] = this.prevLen[i] = this.staticLen[i]; this.contact[i] = false; this.wGrip[i] = 1; this.wRoad[i] = 1; this.wSoft[i] = 0; this.wSteer[i] = 0; this.spinRate[i] = 0; }
    this.nContact = 0;
    this.curPose = { x, y, z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2) }; this.prevPose = this.curPose;
    this.yaw = yaw;
  }
  // lowest world-space y of the lower chassis hull (tests: must stay above the ground)
  lowestHullY() {
    const q = this.body.rotation(), t = this.body.translation(), o = [0, 0, 0]; let m = 1e9;
    const pts = this.hull?.bottomPts;
    if (pts) {
      for (let i = 0; i < pts.length; i++) {
        rot(q, pts[i][0], pts[i][1], pts[i][2], o);
        m = Math.min(m, t.y + o[1]);
      }
    } else {
      const { hx, bottom, hz, cx, cz } = this.hull;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { rot(q, cx + sx * hx, bottom, cz + sz * hz, o); m = Math.min(m, t.y + o[1]); }
    }
    return m;
  }
  heading() { // yaw of the chassis forward vector projected on the ground (rad, same convention as resetAt)
    const f = rot(this.body.rotation(), 0, 0, 1, [0, 0, 0]);
    if (Math.hypot(f[0], f[2]) > 0.2) this.yaw = Math.atan2(f[0], f[2]);
    return this.yaw;
  }
  resetUpright(lift = 1.0) { const t = this.body.translation(); this.resetAt(t.x, t.y + lift, t.z, this.heading()); }

  // ---- interpolated pose for rendering/camera: {x,y,z,qx,qy,qz,qw}
  poseAt(alpha, out = {}) {
    const a = this.prevPose, c = this.curPose;
    out.x = a.x + (c.x - a.x) * alpha; out.y = a.y + (c.y - a.y) * alpha; out.z = a.z + (c.z - a.z) * alpha;
    // nlerp: the angle between two 1/120 s poses is tiny
    let dotq = a.qx * c.qx + a.qy * c.qy + a.qz * c.qz + a.qw * c.qw; const s = dotq < 0 ? -1 : 1;
    let x = a.qx + (s * c.qx - a.qx) * alpha, y = a.qy + (s * c.qy - a.qy) * alpha, z = a.qz + (s * c.qz - a.qz) * alpha, w = a.qw + (s * c.qw - a.qw) * alpha;
    const l = Math.hypot(x, y, z, w) || 1; out.qx = x / l; out.qy = y / l; out.qz = z / l; out.qw = w / l;
    return out;
  }

  // ---- visual -------------------------------------------------------------------------------------------------
  // scene: the loaded GLB scene (Object3D). Wheels are placed at the manifest hub positions; extra wheels (tandem axle) copy the rear wheel
  // on the same side: spin + suspension offset (ponytail: visual only, no physics wheels; the chassis only rests on 4).
  attachVisual(THREE, scene) {
    this.THREE = THREE;
    const root = new THREE.Group(); root.name = 'vehicle'; root.add(scene);
    this.visual = root; this.wheelNodes = []; this.extraWheels = [];
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    WHEEL_KEYS.forEach((k, i) => {
      const n = scene.getObjectByName('wheel_' + k);
      if (n) { n.position.set(...this.wheelPos[i]); n.rotation.order = 'YXZ'; this.wheelNodes[i] = { node: n, base: n.position.clone() }; }
    });
    scene.traverse((o) => {
      const mm = /^wheel_(fl|fr|rl|rr)\d+$/.exec(o.name);
      if (mm) { o.rotation.order = 'YXZ'; this.extraWheels.push({ node: o, base: o.position.clone(), src: WHEEL_KEYS.indexOf(mm[1]) }); }
    });
    this._q = new THREE.Quaternion();
    return root;
  }
  updateVisual(alpha) {
    if (!this.visual) return null;
    const P = this._pose || (this._pose = {}); this.poseAt(alpha, P);
    this.visual.position.set(P.x, P.y, P.z); this.visual.quaternion.set(P.qx, P.qy, P.qz, P.qw);
    const L = (a, bb) => a + (bb - a) * alpha;
    const place = (w, i) => {
      if (!w) return;
      w.node.position.y = w.base.y + (this.staticLen[i] - L(this.prevLen[i], this.len[i]));
      w.node.rotation.set(L(this.prevSpin[i], this.spin[i]), this.wSteer[i], 0, 'YXZ');
    };
    for (let i = 0; i < 4; i++) place(this.wheelNodes[i], i);
    for (const e of this.extraWheels) { // copies suspension offset + spin of its source wheel; steering 0 (rear axle)
      e.node.position.y = e.base.y + (this.staticLen[e.src] - L(this.prevLen[e.src], this.len[e.src]));
      e.node.rotation.set(L(this.prevSpin[e.src], this.spin[e.src]), 0, 0, 'YXZ');
    }
    return P;
  }

  dispose() {
    this.world.removeRigidBody(this.body);
    if (this.world.removeVehicleController) this.world.removeVehicleController(this.ctl);
  }
}
