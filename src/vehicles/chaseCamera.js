// Chase camera (mode 0) + hood camera (mode 1, key C). Reads the INTERPOLATED vehicle pose, so it is as smooth as the render pose.
//   const cam = new ChaseCamera(THREE, camera, { heightAt, dims: car.dimensions });  cam.update(dt, pose, vehicle);  cam.toggle();  cam.snap(pose, vehicle);
// Chase: critically damped springs (smoothDamp) on the camera position and on the look-at point; the heading follows the chassis yaw
// (blended with the velocity direction when sliding), distance/height scale with the car size, distance + FOV grow with speed, the look-at point leads
// into the turn (steering + lateral velocity). Never below heightAt + MARGIN.
// FREE LOOK (cameraLook.js): update(dt, pose, veh, lk) with lk = { yaw, pitch } (effective offsets from lookYaw()). The springs above run on the plain chase geometry;
//   then the camera offset from the car is orbited by the (separately smoothed) look yaw/pitch, so the offset is relative to the car heading and the orbit is an exact arc
//   (no corner cutting through the car). The look-at point is rotated by the same yaw. Hood view: yaw is free (B = look back), pitch is limited to -15..+29 deg.
// ROAD SHAKE: veh.state.shake (0..~1.2, roughness x speed) x settings.shake metres of high-frequency camera jitter on top (chase view only; no shake when stopped).
import { orbitOffset, aboveGround, wrapAngle } from './cameraLook.js';
export const MARGIN = 1.2;
const ZERO = { yaw: 0, pitch: 0 };

function smoothDamp(cur, target, vel, smoothTime, dt) { // Game Programming Gems 4 critically damped spring, returns [value, velocity]
  const omega = 2 / smoothTime, x = omega * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target, temp = (vel + omega * change) * dt;
  return [target + (change + temp) * e, (vel - omega * temp) * e];
}
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export class ChaseCamera {
  constructor(THREE, camera, { heightAt, dims, settings = { shake: 0.05 }, RAPIER = null, world = null }) {
    this.R = RAPIER; this.world = world; this.clip = 1; // clip: fraction of the pivot->camera distance kept after the wall raycast (smoothed outwards)
    this.T = THREE; this.camera = camera; this.heightAt = heightAt; this.mode = 0; this.settings = settings;
    this.ly = 0; this.lyVel = 0; this.lp = 0; this.lpVel = 0; this._lookInit = false; this._t = 0; this._o = [0, 0, 0];
    this._e = new THREE.Euler(); this._q2 = new THREE.Quaternion();
    const L = dims.length, H = dims.height;
    this.dist = Math.max(6.5, L * 1.15 + 3.2); this.height = H * 0.75 + 1.6; this.lookH = H * 0.45 + 0.4; this.hoodH = H * 0.82; this.hoodZ = L * 0.12;
    this.minD = Math.hypot(L, dims.width) / 2 + 1.2; // car's half-diagonal + clearance: the camera never gets closer (horizontally) than this
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0]; this.look = [0, 0, 0]; this.lvel = [0, 0, 0]; this.yaw = 0; this.yawVel = 0; this.fov = 62; this.lead = 0;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this.baseFov = 62;
  }
  toggle() { this.mode = (this.mode + 1) % 2; return this.mode; }
  snap(pose, veh, lk = ZERO) { this._snap = true; this._lookInit = false; this.update(1 / 60, pose, veh, lk); }

  update(dt, pose, veh, lk = ZERO) {
    dt = Math.min(dt, 0.05); this._t += dt;
    if (!this._lookInit) { this.ly = lk.yaw; this.lp = lk.pitch; this.lyVel = this.lpVel = 0; this._lookInit = true; }
    else { // look offsets get their own fast springs (mouse feels direct, B eases in/out); the yaw one runs on the shortest arc
      const [v, vv] = smoothDamp(angDiff(this.ly, lk.yaw), 0, this.lyVel, 0.07, dt); this.ly = wrapAngle(lk.yaw + v); this.lyVel = vv;
      [this.lp, this.lpVel] = smoothDamp(this.lp, lk.pitch, this.lpVel, 0.07, dt);
    }
    const T = this.T, cam = this.camera, s = veh.state;
    this._q.set(pose.qx, pose.qy, pose.qz, pose.qw);
    const fwd = this._v.set(0, 0, 1).applyQuaternion(this._q); // chassis forward
    const carYaw = Math.atan2(fwd.x, fwd.z), speed = s.speed, speedFrac = Math.min(speed / Math.max(veh.vTop, 1), 1.2);
    if (this.mode === 1) { // hood: rigidly on the (interpolated) body
      // tall boxy vehicles (bus, van, fire truck...) have no hood and no modelled interior: sit just in front of the windscreen instead of inside the cabin
      // ponytail: height threshold, not per-model camera points; add a `hoodCam` entry to cars.json if a model needs a custom spot
      const b = veh.bounds, z = b.max[1] - b.min[1] > 2.6 ? b.max[2] + 0.15 : this.hoodZ;
      const off = this._v.set(0, this.hoodH, z).applyQuaternion(this._q);
      cam.position.set(pose.x + off.x, pose.y + off.y, pose.z + off.z);
      // a three.js camera looks down its local -Z and the car faces +Z, hence the extra 180 deg; then the look offset (yaw free, pitch limited)
      this._e.set(-Math.max(-0.26, Math.min(0.5, this.lp)), Math.PI + this.ly, 0, 'YXZ'); this._q2.setFromEuler(this._e);
      cam.quaternion.copy(this._q).multiply(this._q2);
      this._fov(dt, this.baseFov + 10 * speedFrac); this._snap = true; // re-snap the chase spring when switching back
      return;
    }
    const first = this._snap !== false; this._snap = false;
    // heading target: chassis yaw, pulled towards the velocity direction when moving forward fast (drifts show their side)
    let target = carYaw;
    if (s.vf > 6 && s.slip > 1.5) { const lv = veh.body.linvel(); target = carYaw + angDiff(Math.atan2(lv.x, lv.z), carYaw) * 0.45; }
    if (first) { this.yaw = target; this.yawVel = 0; }
    { // angle spring on the shortest path
      const [v, vv] = smoothDamp(angDiff(this.yaw, target), 0, this.yawVel, 0.28, dt); this.yaw = target + v; this.yawVel = vv;
    }
    const zoom = this.settings.zoom ?? 1, dist = this.dist * zoom * (1 + 0.22 * speedFrac), h = this.height * Math.sqrt(zoom) * (1 + 0.1 * speedFrac);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // look-at: ahead of the car, leaning into the turn
    const lat = veh.steer * -1; // + = left
    const targetLead = Math.max(-1, Math.min(1, lat * 1.2)) * 0.12 * dist;
    this.lead += (targetLead - this.lead) * (1 - Math.exp(-3 * dt));
    const look = [pose.x + sy * (2 + speedFrac * 5) + cy * this.lead, pose.y + this.lookH, pose.z + cy * (2 + speedFrac * 5) - sy * this.lead];
    const want = [pose.x - sy * dist, pose.y + h, pose.z - cy * dist];
    if (first) { this.pos = want.slice(); this.look = look.slice(); this.vel = [0, 0, 0]; this.lvel = [0, 0, 0]; }
    for (let i = 0; i < 3; i++) {
      const stiff = i === 1 ? 0.22 : 0.12; // vertical a bit slower than horizontal: bumps do not shake the view
      [this.pos[i], this.vel[i]] = smoothDamp(this.pos[i], want[i], this.vel[i], stiff, dt);
      [this.look[i], this.lvel[i]] = smoothDamp(this.look[i], look[i], this.lvel[i], 0.1, dt);
    }
    // keep the camera out of the ground (and a minimum distance from the car so it never sits inside it)
    const gy = this.heightAt(this.pos[0], this.pos[2]) + MARGIN;
    if (this.pos[1] < gy) { this.pos[1] = gy; if (this.vel[1] < 0) this.vel[1] = 0; }
    { // the spring lags behind hard braking / reversing and would swing into the body: push it out to minD, killing the inward velocity
      const dx = this.pos[0] - pose.x, dz = this.pos[2] - pose.z, d = Math.hypot(dx, dz), minD = this.minD;
      if (d < minD) {
        const nx = d > 1e-3 ? dx / d : -sy, nz = d > 1e-3 ? dz / d : -cy;
        this.pos[0] = pose.x + nx * minD; this.pos[2] = pose.z + nz * minD;
        const vin = this.vel[0] * nx + this.vel[2] * nz; if (vin < 0) { this.vel[0] -= vin * nx; this.vel[2] -= vin * nz; }
      }
    }
    // free look: orbit the spring camera around the car (pivot = look height above the pose), rotate the look-at point by the same yaw
    const px = pose.x, py = pose.y + this.lookH, pz = pose.z, o = orbitOffset(this.pos[0] - px, this.pos[1] - py, this.pos[2] - pz, this.ly, this.lp, this._o);
    const cy_ = Math.cos(this.ly), sy_ = Math.sin(this.ly), lx = this.look[0] - px, lz = this.look[2] - pz;
    const cx = px + o[0], cz = pz + o[2];
    cam.position.set(cx, aboveGround(py + o[1], this.heightAt(cx, cz), MARGIN), cz);
    if (this.world) { // walls: ray from the pivot to the camera (own chassis excluded); pull in instantly on a hit, ease back out
      const ox = cam.position.x - px, oy = cam.position.y - py, oz = cam.position.z - pz, len = Math.hypot(ox, oy, oz);
      const hit = len > 0.1 && this.world.castRay(new this.R.Ray({ x: px, y: py, z: pz }, { x: ox / len, y: oy / len, z: oz / len }), len + 0.4, true, undefined, undefined, undefined, veh.body);
      const want = hit ? Math.max(0.05, (hit.timeOfImpact ?? hit.toi) - 0.4) / len : 1;
      this.clip = want < this.clip ? want : Math.min(want, this.clip + dt * 1.5);
      if (this.clip < 1) cam.position.set(px + ox * this.clip, py + oy * this.clip, pz + oz * this.clip);
    }
    cam.lookAt(px + lx * cy_ + lz * sy_, this.look[1], pz - lx * sy_ + lz * cy_);
    const sh = (veh.state.shake || 0) * this.settings.shake;
    if (sh > 1e-4) { // road shake: a few incommensurate sines (deterministic, no allocation)
      const t = this._t;
      cam.translateY(sh * (0.6 * Math.sin(t * 47) + 0.4 * Math.sin(t * 83 + 1.7))); cam.translateX(sh * 0.5 * Math.sin(t * 61 + 0.5)); cam.rotateZ(sh * 0.1 * Math.sin(t * 37 + 2));
    }
    this._fov(dt, this.baseFov + 14 * Math.min(speedFrac, 1));
  }
  _fov(dt, target) {
    this.fov += (target - this.fov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
  }
}
