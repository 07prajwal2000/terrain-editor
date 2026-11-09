// Car catalog + selected-car storage. Manifest is produced by `npm run cars` (public/cars/cars.json).
const KEY = 'monsterMash.selectedCar';
let catalog;

export function loadCarCatalog() {
  catalog ??= fetch('/cars/cars.json')
    .then((r) => { if (!r.ok) throw new Error(`cars.json: HTTP ${r.status}`); return r.json(); })
    .catch((e) => { catalog = undefined; throw e; }); // allow a retry after a failure
  return catalog;
}

export function getSelectedCarId() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function setSelectedCarId(id) {
  try { localStorage.setItem(KEY, id); return true; } catch { return false; }
}
