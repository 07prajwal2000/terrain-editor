// Free-look camera maths (GTA style), pure functions so scripts/test-vehicles.mjs can test them headless.
//   look = newLook()  ->  { yaw, pitch, idle, behind }: the PLAYER's offset relative to the chase direction (yaw rad, + = towards the car's left, same sign as
//   Vehicle yaw; pitch rad, + = camera higher / looking down), so the offset is kept while the car turns (the chase camera adds it on top of the car heading).
//   stepLook(look, dt, { dx, dy, sx, sy, behind }, speed, cfg)   per frame: dx/dy = mouse pixels since last frame (pointer lock), sx/sy = right stick -1..1,
//   behind = hold-to-look-back. Mouse right turns the view right (yaw -), mouse up looks up (camera goes lower; invertY flips).
//   Auto-recentre: after cfg.idleDelay seconds without mouse / stick / B and while the car moves faster than RECENTRE_MIN, yaw and pitch decay to 0,
//   exponential rate 0 -> RECENTRE_RATE 1/s between RECENTRE_MIN and RECENTRE_FULL m/s. Standing still: stays where the player left it.
//   lookYaw(look) = yaw including the look-behind blend; orbitOffset / aboveGround are used by chaseCamera.js.
export const PITCH_MIN = -15 * Math.PI / 180, PITCH_MAX = 45 * Math.PI / 180; // offsets from the default chase elevation (~10 deg) => roughly -5..+55 deg
export const RECENTRE_MIN = 2, RECENTRE_FULL = 25, RECENTRE_RATE = 3;         // m/s, m/s, 1/s
const STICK_YAW = 2.8, STICK_PITCH = 1.6, BEHIND_RATE = 6;                    // rad/s at full deflection, 1/s
export const LOOK_DEFAULTS = { sens: 0.0022, invertY: false, idleDelay: 1.7, shake: 0.05 }; // sens rad per mouse pixel, delay s, road shake amplitude m

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const wrapAngle = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; }; // [-pi, pi)
export const clampPitch = (p) => clamp(p, PITCH_MIN, PITCH_MAX);
export const newLook = () => ({ yaw: 0, pitch: 0, idle: 0, behind: 0 });
export const recentreRate = (speed) => (speed <= RECENTRE_MIN ? 0 : RECENTRE_RATE * clamp((speed - RECENTRE_MIN) / (RECENTRE_FULL - RECENTRE_MIN), 0, 1));

export function stepLook(L, dt, inp, speed, cfg = LOOK_DEFAULTS) {
  const dx = inp.dx || 0, dy = inp.dy || 0, sx = inp.sx || 0, sy = inp.sy || 0;
  const active = dx !== 0 || dy !== 0 || sx !== 0 || sy !== 0 || !!inp.behind;
  L.yaw = wrapAngle(L.yaw - dx * cfg.sens - sx * STICK_YAW * dt);
  L.pitch = clampPitch(L.pitch + (dy * cfg.sens + sy * STICK_PITCH * dt) * (cfg.invertY ? -1 : 1));
  L.idle = active ? 0 : L.idle + dt;
  L.behind = clamp(L.behind + (inp.behind ? 1 : -1) * BEHIND_RATE * dt, 0, 1);
  if (L.idle > cfg.idleDelay) {
    const k = Math.exp(-recentreRate(speed) * dt);
    L.yaw *= k; L.pitch *= k;
  }
  return L;
}

// effective yaw offset: the player's yaw blended along the short arc to 180 deg while B is held
export function lookYaw(L) { const t = L.behind * L.behind * (3 - 2 * L.behind); return wrapAngle(L.yaw + t * wrapAngle(Math.PI - L.yaw)); }

// camera offset (x,y,z) from the orbit pivot rotated by yaw about +Y (+ = azimuth atan2(x,z) grows) and raised by pitch (elevation angle += pitch); radius kept
export function orbitOffset(ox, oy, oz, yaw, pitch, out = [0, 0, 0]) {
  const d = Math.hypot(ox, oz), R = Math.hypot(d, oy), a = Math.atan2(ox, oz) + yaw, e = Math.atan2(oy, d) + pitch;
  const d2 = R * Math.cos(e);
  out[0] = d2 * Math.sin(a); out[1] = R * Math.sin(e); out[2] = d2 * Math.cos(a);
  return out;
}

// camera height never below the ground + margin
export const aboveGround = (y, ground, margin) => Math.max(y, ground + margin);

// settings persisted in localStorage (try/catch: private mode, blocked storage, node)
const KEY = 'monster-mash.camera';
export function loadSettings() {
  const s = { ...LOOK_DEFAULTS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* defaults */ }
  return s;
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }
