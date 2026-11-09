// Chase camera (mode 0) + hood camera (mode 1, key C). Reads the INTERPOLATED vehicle pose, so it is as smooth as the render pose.
//   const cam = new ChaseCamera(THREE, camera, { heightAt, dims: car.dimensions });  cam.update(dt, pose, vehicle);  cam.toggle();  cam.snap(pose, vehicle);
// Chase: critically damped springs (smoothDamp) on the camera position and on the look-at point; the heading follows the chassis yaw
// (blended with the velocity direction when sliding), distance/height scale with the car size, distance + FOV grow with speed, the look-at point leads
// into the turn (steering + lateral velocity). Never below heightAt + MARGIN.
const MARGIN = 1.2;

function smoothDamp(cur, target, vel, smoothTime, dt) { // Game Programming Gems 4 critically damped spring, returns [value, velocity]
  const omega = 2 / smoothTime, x = omega * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target, temp = (vel + omega * change) * dt;
  return [target + (change + temp) * e, (vel - omega * temp) * e];
}
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export class ChaseCamera {
  constructor(THREE, camera, { heightAt, dims }) {
    this.T = THREE; this.camera = camera; this.heightAt = heightAt; this.mode = 0;
    const L = dims.length, H = dims.height;
    this.dist = Math.max(6.5, L * 1.15 + 3.2); this.height = H * 0.75 + 1.6; this.lookH = H * 0.45 + 0.4; this.hoodH = H * 0.82; this.hoodZ = L * 0.12;
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0]; this.look = [0, 0, 0]; this.lvel = [0, 0, 0]; this.yaw = 0; this.yawVel = 0; this.fov = 62; this.lead = 0;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this.baseFov = 62;
  }
  toggle() { this.mode = (this.mode + 1) % 2; return this.mode; }
  snap(pose, veh) { this._snap = true; this.update(1 / 60, pose, veh); }

  update(dt, pose, veh) {
    dt = Math.min(dt, 0.05);
    const T = this.T, cam = this.camera, s = veh.state;
    this._q.set(pose.qx, pose.qy, pose.qz, pose.qw);
    const fwd = this._v.set(0, 0, 1).applyQuaternion(this._q); // chassis forward
    const carYaw = Math.atan2(fwd.x, fwd.z), speed = s.speed, speedFrac = Math.min(speed / Math.max(veh.vTop, 1), 1.2);
    if (this.mode === 1) { // hood: rigidly on the (interpolated) body
      const off = this._v.set(0, this.hoodH, this.hoodZ).applyQuaternion(this._q);
      cam.position.set(pose.x + off.x, pose.y + off.y, pose.z + off.z); cam.quaternion.copy(this._q);
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
    const dist = this.dist * (1 + 0.22 * speedFrac), h = this.height * (1 + 0.1 * speedFrac);
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
    cam.position.set(this.pos[0], this.pos[1], this.pos[2]);
    cam.lookAt(this.look[0], this.look[1], this.look[2]);
    this._fov(dt, this.baseFov + 14 * Math.min(speedFrac, 1));
  }
  _fov(dt, target) {
    this.fov += (target - this.fov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
  }
}
