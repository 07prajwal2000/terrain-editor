// Live tuning panel (lil-gui, bundled with three). Toggle with ` or F1. Edits the live profile object and calls vehicle.applyProfile().
// "Copy profile JSON" copies { "<carId>": { ...only the values you changed } } = a CAR_OVERRIDES entry for src/vehicles/handling.js.
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { TUNABLE, profileDiff, resolveProfile } from './handling.js';

const GROUPS = {
  'Engine + brakes': ['launchAccel', 'kneeKmh', 'topSpeed', 'brakeG', 'handbrakeG'],
  'Mass + balance': ['mass', 'comFrac', 'comZ'],
  Steering: ['steerMaxDeg', 'steerSpeedKmh', 'steerMinFrac', 'steerGrip', 'steerRate', 'steerReturn', 'rearSteer'],
  Suspension: ['suspRest', 'suspTravel', 'suspStiffness', 'suspCompression', 'suspRelaxation', 'suspMaxForceX'],
  Tyres: ['gripFront', 'gripRear', 'sideStiff', 'handbrakeSlip', 'offRoad'],
  'Body + stability + air': ['antiRoll', 'leanRoll', 'leanPitch', 'tipDeg', 'tipPitchDeg', 'downforce', 'airControl', 'assist', 'angDamp', 'maxAngVel'],
};

export function createTuningPanel({ vehicle, car, onMessage }) {
  const p = vehicle.p, gui = new GUI({ title: `Tuning: ${car.name} (${p.archetype})`, width: 300 });
  gui.domElement.style.cssText += ';position:fixed;top:56px;right:12px;z-index:20;max-height:80vh;overflow:auto';
  const apply = () => vehicle.applyProfile();
  const ctrls = [];
  for (const [name, keys] of Object.entries(GROUPS)) {
    const f = gui.addFolder(name); if (name !== 'Engine + brakes') f.close();
    for (const k of keys) { if (!(k in p) || !TUNABLE[k]) continue; const [mn, mx, st] = TUNABLE[k]; ctrls.push(f.add(p, k, mn, mx, st).onChange(apply)); }
  }
  const f = gui.addFolder('Drive');
  ctrls.push(f.add(p, 'drive', ['FWD', 'RWD', 'AWD']).onChange(apply)); ctrls.push(f.add(p, 'frontBias', 0, 1, 0.01).name('AWD front share').onChange(apply)); f.close();
  const copy = () => {
    const json = JSON.stringify({ [car.id]: profileDiff(car, p) }, null, 2);
    console.log(json);
    (navigator.clipboard?.writeText(json) || Promise.reject()).then(() => onMessage?.('Profile JSON copied'), () => { window.prompt('Copy the overrides:', json); });
  };
  gui.add({ copy }, 'copy').name('Copy profile JSON');
  gui.add({ reset() { Object.assign(p, resolveProfile(car)); apply(); ctrls.forEach((c) => c.updateDisplay()); } }, 'reset').name('Reset to defaults');
  gui.hide();
  return { gui, toggle() { gui.show(gui._hidden); } };
}
