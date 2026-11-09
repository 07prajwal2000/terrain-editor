// Unified keyboard + Gamepad input.  const input = createInput(); each frame: const s = input.update();
//   s = { throttle 0..1, brake 0..1, steer -1..1 (+1 = RIGHT), handbrake 0..1, pitch, roll, yaw -1..1 (+ = right), resetPressed, cameraPressed, tuningPressed }
// Keyboard: W/Up throttle, S/Down brake+reverse, A/D or Left/Right steer, Space handbrake, R reset, C camera, ` or F1 tuning panel.
//   In the AIR the same keys are air control: W/S pitch (W = nose down), A/D roll, Q/E yaw (see Vehicle.js).
// Gamepad (standard mapping): RT throttle, LT brake/reverse, left stick X steer, A handbrake, Y reset, X camera, left stick = roll/pitch in the air, LB/RB yaw.
// *Pressed flags are true for exactly one update(). input.override = {throttle?, ...} (or null) replaces the keys: used by tests / the debug hook.
const DEAD = 0.14;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

export function createInput(target = window) {
  const down = new Set(); let edge = { reset: false, camera: false, tuning: false };
  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '');
  const onDown = (e) => {
    if (typing(e)) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1'].includes(e.code)) e.preventDefault();
    if (!down.has(e.code)) {
      if (e.code === 'KeyR') edge.reset = true;
      if (e.code === 'KeyC') edge.camera = true;
      if (e.code === 'Backquote' || e.code === 'F1') edge.tuning = true;
    }
    down.add(e.code);
  };
  const onUp = (e) => down.delete(e.code);
  const onBlur = () => down.clear();
  target.addEventListener('keydown', onDown); target.addEventListener('keyup', onUp); addEventListener('blur', onBlur);
  const k = (...codes) => (codes.some((c) => down.has(c)) ? 1 : 0);
  const prevPad = { reset: false, camera: false };
  const input = {
    override: null,
    state: { throttle: 0, brake: 0, steer: 0, handbrake: 0, pitch: 0, roll: 0, yaw: 0, resetPressed: false, cameraPressed: false, tuningPressed: false },
    padName: null,
    update() {
      const s = input.state;
      s.throttle = k('KeyW', 'ArrowUp'); s.brake = k('KeyS', 'ArrowDown');
      s.steer = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'); s.handbrake = k('Space');
      s.yaw = k('KeyE') - k('KeyQ'); s.pitch = 0; s.roll = 0;
      s.resetPressed = edge.reset; s.cameraPressed = edge.camera; s.tuningPressed = edge.tuning; edge = { reset: false, camera: false, tuning: false };
      const pad = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((g) => g && g.connected);
      input.padName = pad ? pad.id : null;
      if (pad) {
        const b = (i) => pad.buttons[i]?.value || 0, x = dz(pad.axes[0] || 0), y = dz(pad.axes[1] || 0);
        s.throttle = Math.max(s.throttle, b(7)); s.brake = Math.max(s.brake, b(6));
        if (x) s.steer = x;
        s.handbrake = Math.max(s.handbrake, b(0) > 0.5 ? 1 : 0);
        s.roll = x; s.pitch = -y; s.yaw += b(5) - b(4);
        const r = b(3) > 0.5, c = b(2) > 0.5;
        if (r && !prevPad.reset) s.resetPressed = true; if (c && !prevPad.camera) s.cameraPressed = true;
        prevPad.reset = r; prevPad.camera = c;
      }
      if (input.override) Object.assign(s, input.override);
      return s;
    },
    dispose() { target.removeEventListener('keydown', onDown); target.removeEventListener('keyup', onUp); removeEventListener('blur', onBlur); },
  };
  return input;
}
