// Live tuning panel (lil-gui, bundled with three). Toggle with ` or F1. Edits the live profile object and calls vehicle.applyProfile().
// "Copy profile JSON" copies { "<carId>": { ...only the values you changed } } = a CAR_OVERRIDES entry for src/vehicles/handling.js.
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { TUNABLE, profileDiff, resolveProfile } from './handling.js';
import { saveSettings } from './cameraLook.js';

const GROUPS = {
  'Engine + brakes': ['launchAccel', 'kneeKmh', 'topSpeed', 'brakeG', 'handbrakeG'],
  'Mass + balance': ['mass', 'comFrac', 'comZ'],
  Steering: ['steerMaxDeg', 'steerSpeedKmh', 'steerMinFrac', 'steerGrip', 'steerRate', 'steerReturn', 'rearSteer'],
  Suspension: ['suspRest', 'suspTravel', 'suspStiffness', 'suspCompression', 'suspRelaxation', 'suspMaxForceX'],
  Tyres: ['gripFront', 'gripRear', 'sideStiff', 'handbrakeSlip', 'offRoad', 'roughResponse'],
  'Body + stability + air': ['antiRoll', 'leanRoll', 'leanPitch', 'tipDeg', 'tipPitchDeg', 'downforce', 'airControl', 'assist', 'angDamp', 'maxAngVel'],
};

// camera: the shared mouse-look / shake settings object from cameraLook.js (saved to localStorage on every change)
export function createTuningPanel({ vehicle, car, onMessage, camera }) {
  const p = vehicle.p, gui = new GUI({ title: `Tuning: ${car.name} (${p.archetype})`, width: 300 });
  gui.domElement.style.cssText += ';position:fixed;top:56px;right:12px;z-index:20;max-height:80vh;overflow:auto';
  const apply = () => vehicle.applyProfile();
  const ctrls = [];
  const sel = { style: p.style || 'sim' };
  gui.add(sel, 'style', { 'Arcade (GTA V-ish)': 'arcade', Realistic: 'sim' }).name('Handling preset').onChange((s) => {
    for (const k of Object.keys(p)) delete p[k]; // arcade sets `style`, sim doesn't: clear so no stale key survives
    Object.assign(p, resolveProfile(car, s)); apply(); ctrls.forEach((c) => c.updateDisplay());
    onMessage?.(`Handling: ${s === 'arcade' ? 'Arcade' : 'Realistic'}`);
  });
  for (const [name, keys] of Object.entries(GROUPS)) {
    const f = gui.addFolder(name); if (name !== 'Engine + brakes') f.close();
    for (const k of keys) { if (!(k in p) || !TUNABLE[k]) continue; const [mn, mx, st] = TUNABLE[k]; ctrls.push(f.add(p, k, mn, mx, st).onChange(apply)); }
  }
  const f = gui.addFolder('Drive');
  ctrls.push(f.add(p, 'drive', ['FWD', 'RWD', 'AWD']).onChange(apply)); ctrls.push(f.add(p, 'frontBias', 0, 1, 0.01).name('AWD front share').onChange(apply)); f.close();
  if (camera) {
    const cf = gui.addFolder('Camera (saved in browser)'), save = () => saveSettings(camera);
    cf.add(camera, 'sens', 0.0005, 0.008, 0.0001).name('Mouse sensitivity (rad/px)').onChange(save); cf.add(camera, 'invertY').name('Invert mouse Y').onChange(save);
    cf.add(camera, 'idleDelay', 0.3, 6, 0.1).name('Recentre delay (s)').onChange(save); cf.add(camera, 'shake', 0, 0.2, 0.005).name('Road shake (m)').onChange(save); cf.add(camera, 'zoom', 0.6, 2.5, 0.05).name('Zoom distance (x)').onChange(save); cf.close();
  }
  const copy = () => {
    const json = JSON.stringify({ [car.id]: profileDiff(car, p) }, null, 2);
    console.log(json);
    (navigator.clipboard?.writeText(json) || Promise.reject()).then(() => onMessage?.('Profile JSON copied'), () => { window.prompt('Copy the overrides:', json); });
  };
  gui.add({ copy }, 'copy').name('Copy profile JSON');
  gui.add({ reset() { Object.assign(p, resolveProfile(car, p.style)); apply(); ctrls.forEach((c) => c.updateDisplay()); } }, 'reset').name('Reset to defaults');
  gui.hide();
  return { gui, toggle() { gui.show(gui._hidden); } };
}
