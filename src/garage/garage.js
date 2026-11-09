// Car selection page. Previews are CSS background offsets into ONE spritesheet (cars.json "sheet" + each car's "sprite").
import '../ui/ui.css';
import './garage.css';
import { bindSfx, isMuted, setMuted, play } from '../ui/sfx.js';
import { loadCarCatalog, getSelectedCarId, setSelectedCarId } from '../vehicles/carCatalog.js';

const $ = (s) => document.querySelector(s);
const grid = $('#grid'), msg = $('#msg'), picked = $('#picked'), drive = $('#drive'), driveOff = $('#drive-off');
let cars = [], selected = getSelectedCarId(), filter = 'all';

function spriteStyle(sheet, s) {
  const pct = (i, n) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  return `aspect-ratio:${sheet.cellW}/${sheet.cellH};background-image:url(${sheet.url});` +
    `background-size:${sheet.cols * 100}% ${sheet.rows * 100}%;background-position:${pct(s.col, sheet.cols)}% ${pct(s.row, sheet.rows)}%`;
}

function render(sheet) {
  grid.textContent = '';
  for (const c of cars.filter((c) => filter === 'all' || c.drivable)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'ui-box ui-btn gr-card';
    b.dataset.id = c.id; b.dataset.sfx = 'select';
    b.setAttribute('aria-pressed', c.id === selected);
    const kt = c.triangles >= 1000 ? (c.triangles / 1000).toFixed(1) + 'k' : c.triangles;
    b.innerHTML = `<span class="ui-box ui-badge gr-badge ${c.drivable ? '' : 'ui-box--yellow'}">${c.drivable ? 'Drivable' : 'Static'}</span><div class="gr-sprite" role="img" style="${spriteStyle(sheet, c.sprite)}"></div>
      <span class="gr-name"></span>
      <span class="gr-stats">${c.dimensions.length.toFixed(1)} m &middot; ${kt} tris</span>`;
    b.querySelector('.gr-sprite').setAttribute('aria-label', c.name);
    b.querySelector('.gr-name').textContent = c.name; // textContent: names come from file names
    li.append(b); grid.append(li);
  }
}

function updateBar() {
  const c = cars.find((c) => c.id === selected);
  picked.textContent = c ? c.name : '';
  drive.hidden = !(c && c.drivable);
  if (c && c.drivable) drive.href = '/play.html?car=' + encodeURIComponent(c.id);
  driveOff.hidden = !drive.hidden;
  driveOff.textContent = c ? 'Static only' : 'Pick a car';
}

function updateMute() {
  const m = isMuted(), b = $('#mute');
  b.setAttribute('aria-pressed', m);
  b.querySelector('img').src = m ? '/ui/Vector/Blue/icon_cross.svg' : '/ui/Vector/Green/icon_checkmark.svg';
  b.querySelector('span').textContent = m ? 'Sound off' : 'Sound on';
}

bindSfx();
updateMute();
$('#mute').addEventListener('click', () => { setMuted(!isMuted()); updateMute(); play('click'); });

loadCarCatalog().then((m) => {
  cars = m.cars;
  if (!cars.some((c) => c.id === selected)) selected = null;
  msg.hidden = true;
  render(m.sheet); updateBar();

  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.gr-card'); if (!b) return;
    selected = b.dataset.id; setSelectedCarId(selected);
    grid.querySelectorAll('.gr-card').forEach((x) => x.setAttribute('aria-pressed', x === b));
    updateBar();
  });
  document.querySelectorAll('[data-filter]').forEach((f) => f.addEventListener('click', () => {
    filter = f.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', x === f));
    render(m.sheet);
  }));
}).catch((e) => { msg.textContent = 'Could not load the car list (' + e.message + '). Run `npm run cars`.'; });
