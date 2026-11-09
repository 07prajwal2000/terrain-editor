// HUD: speed, gear + rev bar, surface, car name + archetype, key legend, links. DOM only, updated at most every frame from vehicle.state.
import '../ui/ui.css';
import './hud.css';
import { SURFACE_NAMES } from '../world/mapLoader.js';

export function createHud({ car, arch }) {
  const root = document.createElement('div'); root.className = 'hud';
  root.innerHTML = `
    <div class="hud-top">
      <div class="ui-box ui-box--blue" style="padding:4px 14px"><span class="hud-car"></span><span class="ui-box ui-badge ui-box--yellow hud-badge"></span></div>
      <div class="hud-surface">Surface: <b id="h-surf">-</b></div>
      <div class="hud-dbg" id="h-dbg"></div>
    </div>
    <div class="hud-links">
      <a class="ui-box ui-btn" href="/garage.html" data-hud="garage">Garage</a>
    </div>
    <div class="hud-msg" id="h-msg"></div>
    <div class="hud-air" id="h-air">AIR: W/S pitch &middot; A/D roll &middot; Q/E yaw</div>
    <div class="hud-speed">
      <div class="hud-kmh"><span id="h-kmh">0</span><small>km/h</small></div>
      <div class="hud-gear"><span id="h-gear">N</span><div class="hud-rpm"><i id="h-rpm"></i></div></div>
    </div>
    <div class="hud-keys"><kbd>W</kbd><kbd>S</kbd> gas / brake+reverse &nbsp; <kbd>A</kbd><kbd>D</kbd> steer &nbsp; <kbd>Space</kbd> handbrake<br>
      <kbd>R</kbd> reset upright &nbsp; <kbd>C</kbd> camera &nbsp; <kbd>&#96;</kbd> tuning panel<br>
      In the air: <kbd>W</kbd><kbd>S</kbd> pitch, <kbd>A</kbd><kbd>D</kbd> roll, <kbd>Q</kbd><kbd>E</kbd> yaw &nbsp; Pad: RT/LT, stick, A handbrake, Y reset, X camera</div>`;
  document.body.append(root);
  const $ = (id) => root.querySelector('#' + id);
  root.querySelector('.hud-car').textContent = car.name; // textContent: names come from file names
  root.querySelector('.hud-badge').textContent = arch;
  const el = { kmh: $('h-kmh'), gear: $('h-gear'), rpm: $('h-rpm'), surf: $('h-surf'), msg: $('h-msg'), air: $('h-air'), dbg: $('h-dbg') };
  let msgT = 0; const last = {};
  return {
    root,
    update(vs, dbgText) {
      const k = Math.round(vs.kmh); if (k !== last.k) { el.kmh.textContent = k; last.k = k; }
      const g = vs.gear < 0 ? 'R' : k < 1 && !vs.throttle ? 'N' : String(vs.gear); if (g !== last.g) { el.gear.textContent = g; last.g = g; }
      el.rpm.style.width = (vs.rpm * 100).toFixed(0) + '%';
      const sn = vs.inWater ? 'water' : SURFACE_NAMES[vs.surface] || '-'; if (sn !== last.s) { el.surf.textContent = sn; last.s = sn; }
      el.air.classList.toggle('on', !!vs.airborne);
      if (dbgText !== last.d) { el.dbg.textContent = dbgText || ''; last.d = dbgText; }
      if (msgT && performance.now() > msgT) { el.msg.classList.remove('on'); msgT = 0; }
    },
    message(t, ms = 1400) { el.msg.textContent = t; el.msg.classList.add('on'); msgT = performance.now() + ms; },
  };
}
