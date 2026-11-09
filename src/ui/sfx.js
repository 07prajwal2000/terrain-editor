// Tiny UI sound helper (Kenney sounds in /ui/Sounds). Audio starts only after the first user gesture, files are fetched
// lazily on first use (only the three below), mute is remembered in localStorage.
// Usage: bindSfx(); then mark elements data-sfx="click" | "select" (hover sound plays on any [data-sfx]).
const FILES = { hover: '/ui/Sounds/tap-a.ogg', click: '/ui/Sounds/click-a.ogg', select: '/ui/Sounds/switch-a.ogg' };
const VOL = { hover: 0.25, click: 0.5, select: 0.5 };
const KEY = 'monsterMash.muted';
const audio = {};
let unlocked = false;
let muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable: default on */ }

export const isMuted = () => muted;
export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* ignore */ }
}

export function play(name) {
  if (muted || !unlocked || !FILES[name]) return;
  const a = (audio[name] ??= Object.assign(new Audio(FILES[name]), { volume: VOL[name] }));
  a.currentTime = 0;
  a.play().catch(() => {}); // autoplay refusal etc: silently ignore
}

export function bindSfx(root = document) {
  const unlock = () => { unlocked = true; };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
  root.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-sfx]');
    if (el && !el.disabled && el !== e.relatedTarget?.closest?.('[data-sfx]')) play('hover');
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-sfx]');
    if (el && !el.disabled && el.dataset.sfx !== 'none') play(el.dataset.sfx);
  });
}
