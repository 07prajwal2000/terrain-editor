// Deterministic vegetation / rock placement for the nature scatter (renderer: scatter.js, colliders: scatterColliders.js).
// PURE: no THREE, no DOM, no Rapier, so it runs in Node (scripts/test-scatter.mjs). Same map + seed + config = same instances, whatever
// order chunks are generated in (every decision is a hash of the integer grid cell, never of generation order or of a neighbour's result).
//
//   const gen = createScatterGen({ map, manifest, config?, override? });     // map = loadMap()/loadMapFromData() result, manifest = public/nature/nature.json
//   gen.layer('tree', cx, cz)  -> { name, cx, cz, parts: { tree: { n, species: Uint16Array, data: Float32Array(n*7) } } }   (cached)
//   instance i of a part: data[i*7..] = x, y(ground - sink), z, yaw, scale, ux, uz   (ux,uz = horizontal part of the local up vector: tilt)
//   gen.species[k] = { name, cat, tris, height, radius, trunkRadius?, lods? }       gen.chunkSize.far / .near, gen.groups
//
// WHAT GROWS WHERE. The editor stores the paint as 8 class weights per pixel (0..255 = 0..100 %). Every layer reads the BILINEAR weights from
// map.surfaceAt (so brush edges fade) and turns the weight of its class into a probability  d = weight^gamma * (noise) * densityMul.  A candidate point
// (one per jittered grid cell, hash-placed) is kept iff its own stable hash u < d.  So: 0 weight = nothing; 25 % weight = ~25 % of the full-paint
// count; raising the weight only ADDS instances (the old ones stay exactly where they are); a mixed pixel (50 % forest + 50 % grass) grows both.
// A grid cell belongs to the chunk containing its centre. Min spacing comes from the grid itself: cell size g, jitter range g-minD, so two candidates are never closer than minD (axis-wise, hence also euclid).
//
//   layer       group  cat(s)               density source (all multiplied by the category multiplier and the quality scale)
//   tree        far    tree                 forest weight * glade/clump noise; species from elevation / cold / noise (pine high+snow, birch/maple/common low-mid, twisted rare)
//   deadtree    far    deadtree             dirt, sand, rock weights (sparse) + a few forest patches; never within the tree spacing of a live tree
//   bush        far    bush                 forest EDGES (4*f*(1-f)), a little undergrowth, grass patches
//   rock        far    rock, rockpebble     rock weight * patchiness + steep slopes; random scale 0.6..3, yaw, tilt; pebble ring round each rock
//   grass       near   groundcover          grass weight * cover noise   (grass, clover)
//   forestfloor near   groundcover          forest weight                (ferns, plants, a few mushrooms)
//   flower      near   flower               grass weight * meadow patches (patch picks the dominant flower)
//   pebble      near   pebble               dirt + sand + rock weights
// EXCLUSIONS (all categories, margins per category in config.cats): water + shore ring (lakes AND ocean via map.waterLevelAt), road class 6 / city class 7,
// slope limit, snow limit, distance to road ribbons (half width + kerb + city footpath / highway shoulder + margin; spatial hash over polyOf samples),
// junction footprints (radius + margin), bridge decks (they are road segments), markers (radius + margin), scatter.json exclusion circles.
//
// scatter.json (optional, public/maps/<name>/scatter.json; a missing file / dev-server HTML answer is fine; read by scatter.js, passed as `override`):
//   { "seed": 1337,                               hash seed (change it to get another forest on the same map)
//     "disabled": false,                          true = no scatter at all on this map
//     "density": { "tree": 1.5, "bush": 0.5 },    multipliers per category (tree deadtree bush rock rockpebble groundcover flower pebble), default 1
//     "exclusions": [ { "x": 100, "z": 200, "r": 30, "cats": ["tree","bush"] } ] }   circles in metres; cats optional (default all)
import { polyOf, KERB } from './roads.js';
import { FOOT_SHIFT, HIGHWAY } from './roadMeta.js';

// ================================================================================================
// CONFIG: every tunable lives here. Metres / degrees unless noted.
// ================================================================================================
export const SCATTER_CONFIG = {
  seed: 1337,
  chunk: { far: 128, near: 48 },        // generation / culling cell sizes. near = grass, flowers, pebbles (small draw range, so small chunks cull well)
  slopeEps: 1.0,                        // slope / tilt are measured with +-1 m central differences
  weightGamma: 1.0,                     // density = weight^gamma. 1 = linear in paint strength (a mild 1.2-1.4 thins out weak strokes a bit more)
  density: { tree: 1, deadtree: 1, bush: 1, rock: 1, rockpebble: 1, groundcover: 1, flower: 1, pebble: 1 },   // multipliers (scatter.json "density" + quality scale these)
  quality: {                            // setQuality(): density multipliers and distance multiplier
    low:    { density: { tree: 0.6, deadtree: 0.6, bush: 0.5, rock: 0.7, rockpebble: 0.5, groundcover: 0.4, flower: 0.4, pebble: 0.4 }, dist: 0.65 },
    medium: { density: { tree: 0.85, deadtree: 1, bush: 0.8, rock: 1, rockpebble: 0.8, groundcover: 0.7, flower: 0.7, pebble: 0.7 }, dist: 0.85 },
    high:   { density: { tree: 1, deadtree: 1, bush: 1, rock: 1, rockpebble: 1, groundcover: 1, flower: 1, pebble: 1 }, dist: 1 },
  },
  // per category rules. cell/minD: grid cell and guaranteed min centre distance of two candidates of the layer (0 = free jitter).
  // maxSlope deg, maxSnow/maxCity = limit of the snow(5)/city(7) class WEIGHT, shore = metres of dry land kept round water, road = margin beyond the road
  // clearance (half width + kerb [+ footpath / shoulder]), junction = margin beyond the junction radius, marker = margin beyond the marker radius.
  cats: {
    tree:        { cell: 6,   minD: 4,   maxSlope: 38, maxSnow: 0.2,  maxCity: 0.25, shore: 4,   road: 3.5, junction: 6, marker: 8, scale: [0.8, 1.3], sink: [0.05, 0.15], tilt: 4 },
    deadtree:    { cell: 7,   minD: 5,   maxSlope: 40, maxSnow: 0.5,  maxCity: 0.25, shore: 3,   road: 3.5, junction: 6, marker: 8, scale: [0.8, 1.3], sink: [0.05, 0.15], tilt: 6 },
    bush:        { cell: 3,   minD: 1.8, maxSlope: 40, maxSnow: 0.25, maxCity: 0.25, shore: 2.5, road: 1.6, junction: 3, marker: 4, scale: [0.8, 1.3], sink: [0.03, 0.08], tilt: 3 },
    rock:        { cell: 6,   minD: 4,   maxSlope: 75, maxSnow: 0.7,  maxCity: 0.25, shore: 1.5, road: 2.5, junction: 4, marker: 5, scale: [0.6, 3.0], sink: [0.15, 0.25], tilt: 15 },   // sink = fraction of the rock height
    rockpebble:  { maxSlope: 80, maxSnow: 0.8, maxCity: 0.5, shore: 0.5, road: 0.4, junction: 0, marker: 0, scale: [0.8, 1.5], sink: [0.01, 0.03] },
    groundcover: { cell: 1.5, minD: 0, maxSlope: 40, maxSnow: 0.4,  maxCity: 0.5,  shore: 0.6, road: 0.5, junction: 1, marker: 0, scale: [0.22, 0.4], sink: [0, 0.03] },
    flower:      { cell: 1.6, minD: 0, maxSlope: 30, maxSnow: 0.1,  maxCity: 0.5,  shore: 0.8, road: 0.6, junction: 1, marker: 0, scale: [0.3, 0.5], sink: [0, 0.02] },
    pebble:      { cell: 2.0, minD: 0, maxSlope: 50, maxSnow: 0.5,  maxCity: 0.5,  shore: 0.4, road: 0.3, junction: 1, marker: 0, scale: [0.8, 1.4], sink: [0, 0.02] },
  },
  // species used (names from nature.json). Fewer variants = fewer draw calls (every (species, material, chunk) is one draw).
  species: {
    birch:  ['BirchTree_1', 'BirchTree_2', 'BirchTree_4'],
    maple:  ['MapleTree_1', 'MapleTree_2', 'MapleTree_5'],
    pine:   ['Pine_1', 'Pine_2', 'Pine_3', 'Pine_5'],
    common: ['CommonTree_1', 'CommonTree_3', 'CommonTree_4'],
    twisted: ['TwistedTree_2', 'TwistedTree_4'],
    dead:   ['DeadTree_1', 'DeadTree_6', 'DeadTree_8'],
    bush:   [['Bush', 2], ['Bush_Common', 1.2], ['Bush_Large', 1.5], ['Bush_Small', 1.5], ['Bush_Flowers', 1], ['Bush_Common_Flowers', 0.3], ['Bush_Large_Flowers', 0.6]],   // [name, weight]
    rock:   ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'],
    rockpebble: ['Pebble_Round_1', 'Pebble_Round_2', 'Pebble_Square_1', 'Pebble_Square_2', 'Pebble_Square_3'],
    grass:  [['Grass_Common_Short', 3], ['Grass_Common_Tall', 2], ['Grass_Wispy_Short', 2], ['Grass_Large', 2], ['Clover_1', 1.5], ['Clover_2', 0.8]],
    forestfloor: [['Fern_1', 3], ['Plant_1', 1.5], ['Plant_1_Big', 0.4], ['Mushroom_Common', 0.3], ['Plant_7', 1]],
    flower: ['Flower_1', 'Flower_2', 'Flower_1_Clump', 'Flower_2_Clump', 'Flower_4_Clump'],
    pebble: ['Pebble_Round_1', 'Pebble_Round_3', 'Pebble_Square_2', 'Pebble_Square_4', 'RockPath_Round_Small_1', 'RockPath_Square_Small_1'],
  },
  // tree species mix. cold c = clamp(elevation01 + 1.2*snowWeight + 0.3*(noise-0.5)); weights below are RELATIVE (they are only compared with each other)
  trees: {
    pineMinCold: 0.2,                   // no pines at all below this cold value (lowest, warmest ground)
    twistedChance: 0.04,                // twisted trees only where the "weird" noise is high; relative weight there
    forestDeadPatch: 0.78,              // noise above this = a patch of dead trees inside forests
  },
  noise: { glade: 90, gladeLo: 0.28, gladeHi: 0.46, clump: 16, species: 140, rockPatch: 45, meadow: 14, cover: 7 },   // noise wavelengths (m) / smoothstep range of the glade mask
  rock: { slopeFrom: 26, slopeTo: 50, slopeDensity: 0.3, weightDensity: 0.5, pebblesMin: 2, pebblesMax: 6 },
  // draw distances (m, from the camera, xz) per category: d = [LOD0->LOD1, LOD1->LOD2] boundaries, cull = beyond this nothing is drawn.
  // Trees: LOD0 (full mesh) very near, LOD1 (~25 % tris) mid, LOD2 (~6 % tris) far. A species without LOD meshes uses its base mesh at every distance.
  lod: {
    tree: { d: [40, 120], cull: 420 }, deadtree: { d: [40, 120], cull: 420 },
    bush: { d: [45, 80], cull: 120 }, rock: { d: [], cull: 240 }, rockpebble: { d: [], cull: 110 },
    groundcover: { d: [], cull: 55 }, flower: { d: [], cull: 50 }, pebble: { d: [], cull: 65 },
  },
  // physics colliders (scatterColliders.js)
  colliders: { radius: 55, maxTrees: 300, maxRocks: 60, trunkScale: 0.85, trunkMin: 0.15, trunkMax: 0.6, trunkHeight: 5 },
};

export const CATS = ['tree', 'deadtree', 'bush', 'rock', 'rockpebble', 'groundcover', 'flower', 'pebble'];
export const LAYERS = { tree: 'far', deadtree: 'far', bush: 'far', rock: 'far', grass: 'near', forestfloor: 'near', flower: 'near', pebble: 'near' };

// ================================================================================================
// hashing / noise (integer cell coordinates -> [0,1); no state)
// ================================================================================================
export function hash(seed, a, b, c) {
  let h = (seed ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ a, 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35); h ^= h >>> 16;
  h = Math.imul(h ^ c, 0x27d4eb2f); h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function vnoise(seed, salt, x, z) {           // smooth value noise, x,z in noise units (lattice spacing 1)
  const i = Math.floor(x), j = Math.floor(z); let fx = x - i, fz = z - j;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash(seed, i, j, salt), b = hash(seed, i + 1, j, salt), c = hash(seed, i, j + 1, salt), d = hash(seed, i + 1, j + 1, salt);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
const TAU = Math.PI * 2;
const deepMerge = (a, b) => { // plain-object merge, b wins (arrays replaced)
  if (!b || typeof b !== 'object') return a;
  const o = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b)) o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : b[k];
  return o;
};

// ================================================================================================
// road clearance index: segments of every road (bridges included) in a 32 m hash; query(x,z) = min over segments of (distance - clearance)
// ================================================================================================
function buildRoadIndex(map, reach) {
  const C = 32, grid = new Map(), key = (cx, cz) => cx * 73856 + cz;
  for (const road of map.roads || []) {
    const P = polyOf(road), hw = road.width / 2;
    for (let i = 0; i < P.n - 1; i++) {
      const t = road.points[P.seg[i]] && road.points[P.seg[i]].type;
      const clear = hw + KERB + (t === 'city' ? FOOT_SHIFT + 0.5 : t === 'highway' ? HIGHWAY.SHOULDER_W + 0.5 : 0);
      const seg = [P.x[i], P.z[i], P.x[i + 1], P.z[i + 1], clear], e = clear + reach;
      const x0 = Math.floor((Math.min(seg[0], seg[2]) - e) / C), x1 = Math.floor((Math.max(seg[0], seg[2]) + e) / C);
      const z0 = Math.floor((Math.min(seg[1], seg[3]) - e) / C), z1 = Math.floor((Math.max(seg[1], seg[3]) + e) / C);
      for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) { const k = key(a, b); (grid.get(k) || grid.set(k, []).get(k)).push(seg); }
    }
  }
  return (x, z) => {
    let best = Infinity;
    const l = grid.get(key(Math.floor(x / C), Math.floor(z / C)));
    if (!l) return best;
    for (const s of l) {
      const bx = s[2] - s[0], bz = s[3] - s[1], l2 = bx * bx + bz * bz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * bx + (z - s[1]) * bz) / l2)) : 0;
      const d = Math.hypot(s[0] + bx * t - x, s[1] + bz * t - z) - s[4];
      if (d < best) best = d;
    }
    return best;
  };
}

// ================================================================================================
// extraBlocked(x, z, margin, cat) -> boolean (optional): extra exclusions, e.g. cityBlocks.js blockedFor() (lots, plazas, footprints); margin = the category's road margin, cat = scatter category.
export function createScatterGen({ map, manifest, config, override = null, extraExclusions = [], extraBlocked = null }) {
  const cfg = config ? deepMerge(SCATTER_CONFIG, config) : SCATTER_CONFIG;
  const ov = override || {};
  const seed = (Number.isFinite(ov.seed) ? ov.seed : cfg.seed) | 0;
  const mul = {}; for (const c of CATS) mul[c] = (cfg.density[c] ?? 1) * (Number.isFinite(ov.density && ov.density[c]) ? ov.density[c] : 1);
  const disabled = !!ov.disabled;
  const W = map.info.worldSize, sea = () => map.info.seaLevel;
  const gamma = cfg.weightGamma, EPS = cfg.slopeEps;
  const CS = cfg.chunk;

  // ---- species table ----
  const species = [], byName = new Map();
  const man = new Map(manifest.assets.map((a) => [a.name, a]));
  const sp = (name) => {
    if (byName.has(name)) return byName.get(name);
    const a = man.get(name); if (!a) throw new Error(`scatter: species "${name}" is not in nature.json`);
    species.push({ name, cat: a.category, tris: a.tris, height: a.height, radius: a.radius, size: a.size, trunkRadius: a.trunkRadius || 0, lods: a.lods || [], lodTris: a.lodTris || [] });
    byName.set(name, species.length - 1); return species.length - 1;
  };
  const S = cfg.species, list = (arr) => arr.map((e) => (Array.isArray(e) ? e : [e, 1]));
  const idx = {}, cum = {};
  for (const k of Object.keys(S)) {
    const l = list(S[k]); idx[k] = l.map(([n]) => sp(n));
    let t = 0; cum[k] = l.map(([, w]) => (t += w)); cum[k].total = t;
  }
  const pickW = (k, u) => { const c = cum[k], x = u * c.total; for (let i = 0; i < c.length; i++) if (x < c[i]) return idx[k][i]; return idx[k][idx[k].length - 1]; };
  const pickU = (k, u) => idx[k][Math.min(idx[k].length - 1, Math.floor(u * idx[k].length))];

  // ---- map statistics (elevation range of land, for the elevation-dependent species) ----
  let hLo = Infinity, hHi = -Infinity; { const hs = [];
    for (let j = 0; j < 48; j++) for (let i = 0; i < 48; i++) { const h = map.heightAt((i + 0.5) * W / 48, (j + 0.5) * W / 48); if (h > sea() + 0.5) hs.push(h); }
    hs.sort((a, b) => a - b); if (hs.length) { hLo = hs[0]; hHi = hs[Math.floor(hs.length * 0.97)]; } else { hLo = 0; hHi = 1; } }
  const elev01 = (h) => (hHi - hLo > 1 ? Math.min(1, Math.max(0, (h - hLo) / (hHi - hLo))) : 0.5);

  // ---- exclusion data ----
  const maxReach = Math.max(...Object.values(cfg.cats).map((c) => c.road || 0)) + 1;
  const roadClear = buildRoadIndex(map, maxReach);
  const junctions = (map.junctions || []).filter((j) => j.style !== 'none');
  const markers = (map.markers || []).map((m) => ({ x: m.x, z: m.z, r: Math.max(0, m.radius || 0) }));
  const circles = [...(ov.exclusions || []), ...extraExclusions].filter((c) => Number.isFinite(c.x) && Number.isFinite(c.z) && c.r > 0);

  // ---- terrain helpers ----
  const heightAt = map.heightAt;
  const SHORE_DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos(k * TAU / 8), Math.sin(k * TAU / 8)]);   // 8 directions x 2 rings (half and full shore distance)
  const slopeAt = (x, z) => { // -> [gx, gz, slopeDeg]
    const gx = (heightAt(x + EPS, z) - heightAt(x - EPS, z)) / (2 * EPS), gz = (heightAt(x, z + EPS) - heightAt(x, z - EPS)) / (2 * EPS);
    return [gx, gz, Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI];
  };
  const dryWithMargin = (x, z, shore) => {
    if (map.waterLevelAt(x, z) !== null) return false;
    if (shore > 0) for (const [dx, dz] of SHORE_DIRS) if (map.waterLevelAt(x + dx * shore, z + dz * shore) !== null || map.waterLevelAt(x + dx * shore * 0.5, z + dz * shore * 0.5) !== null) return false;
    return true;
  };
  // rules independent of the paint weight of the layer's own class: returns null when the point is not allowed, else the slope triple
  function envOk(c, cat, x, z, s) {
    if (s.classId === 6 || s.classId === 7) return null;
    if (s.weights[7] > c.maxCity || s.weights[5] > c.maxSnow) return null;
    const sl = slopeAt(x, z); if (sl[2] > c.maxSlope) return null;
    if (roadClear(x, z) < c.road) return null;
    for (const j of junctions) { const r = j.radius + c.junction; if ((x - j.x) * (x - j.x) + (z - j.z) * (z - j.z) < r * r) return null; }
    if (c.marker > 0) for (const m of markers) { const r = m.r + c.marker; if ((x - m.x) * (x - m.x) + (z - m.z) * (z - m.z) < r * r) return null; }
    for (const e of circles) { if (e.cats && !e.cats.includes(cat)) continue; if ((x - e.x) * (x - e.x) + (z - e.z) * (z - e.z) < e.r * e.r) return null; }
    if (extraBlocked && extraBlocked(x, z, c.road, cat)) return null;
    if (!dryWithMargin(x, z, c.shore)) return null;
    return sl;
  }

  // ---- layer machinery ----
  const clampMag = (a, b, m) => { const l = Math.hypot(a, b); return l > m ? [a * m / l, b * m / l] : [a, b]; };
  const tan = (deg) => Math.tan(deg * Math.PI / 180);
  function newOut() { return { sp: [], d: [] }; }
  function emit(out, spIdx, x, y, z, yaw, sc, ux, uz) { out.sp.push(spIdx); out.d.push(x, y, z, yaw, sc, ux, uz); }
  const finish = (out) => ({ n: out.sp.length, species: Uint16Array.from(out.sp), data: Float32Array.from(out.d) });
  function cellPos(c, gi, gj, salt) { // jittered position inside grid cell (gi,gj); jitter range g-minD keeps candidates >= minD apart
    const g = c.cell, jr = (g - c.minD) / g;
    return [(gi + 0.5 + (hash(seed, gi, gj, salt + 1) - 0.5) * jr) * g, (gj + 0.5 + (hash(seed, gi, gj, salt + 2) - 0.5) * jr) * g];
  }
  const common = (c, out, spIdx, x, z, sl, gi, gj, salt, tiltFollow) => { // scale / yaw / sink / tilt -> emit
    const sc = c.scale[0] + (c.scale[1] - c.scale[0]) * hash(seed, gi, gj, salt + 3);
    const yaw = hash(seed, gi, gj, salt + 4) * TAU;
    const sk = c.sink[0] + (c.sink[1] - c.sink[0]) * hash(seed, gi, gj, salt + 5);
    let ux = 0, uz = 0;
    if (c.tilt) { const m = tan(c.tilt); [ux, uz] = clampMag(-sl[0] * tiltFollow, -sl[1] * tiltFollow, m); }
    emit(out, spIdx, x, heightAt(x, z) - sk, z, yaw, sc, ux, uz);
  };

  // ---- the layers: cellFn(gi, gj, out) is called for every grid cell of a chunk ----
  const N = cfg.noise;
  const treeClump = (x, z) => sstep(N.gladeLo, N.gladeHi, 0.65 * vnoise(seed, 11, x / N.glade, z / N.glade) + 0.35 * vnoise(seed, 12, x / (N.glade / 3), z / (N.glade / 3)))
    * (0.65 + 0.35 * vnoise(seed, 13, x / N.clump, z / N.clump));
  const SALT = { tree: 100, deadtree: 200, bush: 300, rock: 400, pebR: 500, grass: 600, forestfloor: 700, flower: 800, pebble: 900 };

  function treeAt(gi, gj) { // a live tree at cell (gi,gj) or null -> [x, z, species, sl]; pure, also used by the dead tree layer
    const c = cfg.cats.tree, salt = SALT.tree, m = mul.tree; if (m <= 0) return null;
    const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
    const clump = treeClump(x, z) * m; if (u >= clump) return null;
    const s = map.surfaceAt(x, z), wf = s.weights[1]; if (wf <= 0 || u >= Math.pow(wf, gamma) * clump) return null;
    const sl = envOk(c, 'tree', x, z, s); if (!sl) return null;
    // species: cold + noise decide the family
    const h = heightAt(x, z), n1 = vnoise(seed, 21, x / N.species, z / N.species), n2 = vnoise(seed, 22, x / (N.species * 0.6), z / (N.species * 0.6)), cold = Math.min(1, Math.max(0, elev01(h) + 1.2 * s.weights[5] + 0.3 * (n1 - 0.5)));
    const T = cfg.trees;
    const fam = [
      ['pine', cold < T.pineMinCold ? 0 : 0.15 + 3 * sstep(0.3, 0.75, cold)],
      ['birch', 1.2 * (1 - sstep(0.45, 0.8, cold)) * (0.4 + n2)],
      ['maple', 1.0 * (1 - sstep(0.55, 0.9, cold)) * (1.4 - n2)],
      ['common', 1.0 * (1 - sstep(0.5, 0.85, cold))],
      ['twisted', n2 > 0.78 ? T.twistedChance * 6 : 0],
    ];
    let tot = 0; for (const f of fam) tot += f[1];
    let pick = hash(seed, gi, gj, salt + 6) * (tot || 1), name = 'common';
    for (const f of fam) { if (pick < f[1]) { name = f[0]; break; } pick -= f[1]; }
    return [x, z, pickU(name, hash(seed, gi, gj, salt + 7)), sl, c];
  }
  const layerFns = {
    tree(gi, gj, out) {
      const t = treeAt(gi, gj); if (!t) return;
      common(t[4], out, t[2], t[0], t[1], t[3], gi, gj, SALT.tree, 0.3);
    },
    deadtree(gi, gj, out) {
      const c = cfg.cats.deadtree, salt = SALT.deadtree, m = mul.deadtree; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const patch = sstep(cfg.trees.forestDeadPatch, cfg.trees.forestDeadPatch + 0.08, vnoise(seed, 31, x / 60, z / 60));
      const s = map.surfaceAt(x, z), w = s.weights;
      const d = (0.08 * (Math.pow(w[2], gamma) + 0.8 * Math.pow(w[3], gamma) + 0.6 * Math.pow(w[4], gamma)) + 0.05 * Math.pow(w[1], gamma) * patch) * m;
      if (u >= d) return;
      const sl = envOk(c, 'deadtree', x, z, s); if (!sl) return;
      // keep the live trees' spacing: no dead tree within tree.minD of an actual live tree
      const tc = cfg.cats.tree, gx0 = Math.floor(x / tc.cell), gz0 = Math.floor(z / tc.cell), r = Math.ceil(tc.minD / tc.cell) + 1;
      for (let a = gx0 - r; a <= gx0 + r; a++) for (let b = gz0 - r; b <= gz0 + r; b++) {
        const t = treeAt(a, b); if (t && Math.hypot(t[0] - x, t[1] - z) < tc.minD) return;
      }
      common(c, out, pickU('dead', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0.3);
    },
    bush(gi, gj, out) {
      const c = cfg.cats.bush, salt = SALT.bush, m = mul.bush; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const s = map.surfaceAt(x, z), fo = Math.pow(s.weights[1], gamma), gr = Math.pow(s.weights[0], gamma);
      const patch = sstep(0.55, 0.75, vnoise(seed, 41, x / 25, z / 25));
      const d = (0.9 * 4 * fo * (1 - fo) + 0.12 * fo + 0.3 * gr * patch) * m;   // forest EDGE (fo ~ 0.5) + undergrowth + grass patches
      if (u >= d) return;
      const sl = envOk(c, 'bush', x, z, s); if (!sl) return;
      common(c, out, pickW('bush', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0.3);
    },
    rock(gi, gj, out, out2) {
      const c = cfg.cats.rock, salt = SALT.rock, m = mul.rock; if (m <= 0) return;
      const R = cfg.rock, u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const s = map.surfaceAt(x, z), sl = slopeAt(x, z);
      const patch = 0.35 + 0.65 * vnoise(seed, 51, x / N.rockPatch, z / N.rockPatch);
      const d = (R.weightDensity * Math.pow(s.weights[4], gamma) * patch + R.slopeDensity * sstep(R.slopeFrom, R.slopeTo, sl[2]) * (s.weights[5] < 0.5 ? 1 : 0)) * m;
      if (u >= d) return;
      if (!envOk(c, 'rock', x, z, s)) return;
      const spI = pickU('rock', hash(seed, gi, gj, salt + 7)), a = species[spI];
      const sc = c.scale[0] + (c.scale[1] - c.scale[0]) * Math.pow(hash(seed, gi, gj, salt + 3), 2.5);
      const yaw = hash(seed, gi, gj, salt + 4) * TAU, sk = (c.sink[0] + (c.sink[1] - c.sink[0]) * hash(seed, gi, gj, salt + 5)) * a.height * sc;
      let [ux, uz] = clampMag((hash(seed, gi, gj, salt + 8) - 0.5) * 2 * tan(c.tilt) - sl[0] * 0.5, (hash(seed, gi, gj, salt + 9) - 0.5) * 2 * tan(c.tilt) - sl[1] * 0.5, tan(c.tilt + 10));
      emit(out, spI, x, heightAt(x, z) - sk, z, yaw, sc, ux, uz);
      // pebble ring round the rock
      const pc = cfg.cats.rockpebble, np = R.pebblesMin + Math.floor(hash(seed, gi, gj, salt + 10) * (R.pebblesMax - R.pebblesMin + 1));
      for (let k = 0; k < np; k++) {
        const ang = hash(seed, gi, gj, salt + 20 + k * 3) * TAU, rad = a.radius * sc * 0.6 + 0.4 + hash(seed, gi, gj, salt + 21 + k * 3) * 2.2;
        const px = x + Math.cos(ang) * rad, pz = z + Math.sin(ang) * rad;
        if (px < 0 || pz < 0 || px > W || pz > W) continue;
        const ps = map.surfaceAt(px, pz); if (ps.classId === 6 || ps.classId === 7 || !dryWithMargin(px, pz, pc.shore) || roadClear(px, pz) < pc.road || (extraBlocked && extraBlocked(px, pz, pc.road, 'rockpebble'))) continue;
        const psl = slopeAt(px, pz); if (psl[2] > pc.maxSlope) continue;
        emit(out2, pickU('rockpebble', hash(seed, gi, gj, salt + 22 + k * 3)), px, heightAt(px, pz) - 0.02, pz, hash(seed, gi, gj, salt + 23 + k * 3) * TAU, pc.scale[0] + (pc.scale[1] - pc.scale[0]) * hash(seed, gi, gj, salt + 24 + k * 3), 0, 0);
      }
    },
    grass(gi, gj, out) {
      const c = cfg.cats.groundcover, salt = SALT.grass, m = mul.groundcover; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const cover = 0.55 + 0.45 * vnoise(seed, 61, x / N.cover, z / N.cover);
      if (u >= 0.8 * cover * m) return;
      const s = map.surfaceAt(x, z), d = 0.8 * Math.pow(s.weights[0], gamma) * cover * m; if (u >= d) return;
      const sl = envOk(c, 'groundcover', x, z, s); if (!sl) return;
      common(c, out, pickW('grass', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0);
    },
    forestfloor(gi, gj, out) {
      const c = cfg.cats.groundcover, salt = SALT.forestfloor, m = mul.groundcover, g2 = { ...c, cell: 2.0 }; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(g2, gi, gj, salt);
      const s = map.surfaceAt(x, z), d = 0.6 * Math.pow(s.weights[1], gamma) * m; if (u >= d) return;
      const sl = envOk(c, 'groundcover', x, z, s); if (!sl) return;
      common(c, out, pickW('forestfloor', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0);
    },
    flower(gi, gj, out) {
      const c = cfg.cats.flower, salt = SALT.flower, m = mul.flower; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const patch = sstep(0.52, 0.68, vnoise(seed, 71, x / N.meadow, z / N.meadow)); if (patch <= 0 || u >= 0.55 * patch * m) return;
      const s = map.surfaceAt(x, z), d = 0.55 * Math.pow(s.weights[0], gamma) * patch * m; if (u >= d) return;
      const sl = envOk(c, 'flower', x, z, s); if (!sl) return;
      // the meadow patch decides the dominant flower (80 %), the rest is mixed
      const pid = hash(seed, Math.floor(x / N.meadow), Math.floor(z / N.meadow), 72), dom = hash(seed, gi, gj, salt + 6) < 0.8;
      common(c, out, dom ? pickU('flower', pid) : pickU('flower', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0);
    },
    pebble(gi, gj, out) {
      const c = cfg.cats.pebble, salt = SALT.pebble, m = mul.pebble; if (m <= 0) return;
      const u = hash(seed, gi, gj, salt), [x, z] = cellPos(c, gi, gj, salt);
      const s = map.surfaceAt(x, z), w = s.weights;
      const d = (0.35 * (Math.pow(w[2], gamma) + Math.pow(w[3], gamma) * 0.8) + 0.4 * Math.pow(w[4], gamma)) * m; if (u >= d) return;
      const sl = envOk(c, 'pebble', x, z, s); if (!sl) return;
      common(c, out, pickU('pebble', hash(seed, gi, gj, salt + 7)), x, z, sl, gi, gj, salt, 0);
    },
  };
  const layerCell = { tree: cfg.cats.tree.cell, deadtree: cfg.cats.deadtree.cell, bush: cfg.cats.bush.cell, rock: cfg.cats.rock.cell, grass: cfg.cats.groundcover.cell, forestfloor: 2.0, flower: cfg.cats.flower.cell, pebble: cfg.cats.pebble.cell };
  const layerCats = { tree: ['tree'], deadtree: ['deadtree'], bush: ['bush'], rock: ['rock', 'rockpebble'], grass: ['groundcover'], forestfloor: ['groundcover'], flower: ['flower'], pebble: ['pebble'] };

  // ---- public: layer(name, cx, cz) ----
  const cache = new Map(); let cacheCap = 1500;
  const stats = { chunks: 0, ms: 0, perLayer: {} };
  function layer(name, cx, cz) {
    const key = name + ':' + cx + ':' + cz, hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const t0 = performance.now();
    const group = LAYERS[name], size = CS[group], g = layerCell[name];
    const outs = layerCats[name].map(newOut), fn = layerFns[name];
    if (!disabled && cx >= 0 && cz >= 0 && cx * size < W && cz * size < W) {
      // a grid cell belongs to the chunk that contains its CENTRE (so chunks tile the cells exactly, any cell size); its candidate may poke out by < g/2
      const i0 = Math.ceil(cx * size / g - 0.5), i1 = Math.ceil((cx + 1) * size / g - 0.5), j0 = Math.ceil(cz * size / g - 0.5), j1 = Math.ceil((cz + 1) * size / g - 0.5);
      for (let gj = j0; gj < j1; gj++) for (let gi = i0; gi < i1; gi++) fn(gi, gj, outs[0], outs[1]);
    }
    const parts = {}; layerCats[name].forEach((c, k) => { parts[c] = finish(outs[k]); });
    const res = { name, cx, cz, group, parts };
    cache.set(key, res); if (cache.size > cacheCap) cache.delete(cache.keys().next().value);
    const dt = performance.now() - t0; stats.chunks++; stats.ms += dt;
    const pl = stats.perLayer[name] || (stats.perLayer[name] = { n: 0, ms: 0, max: 0 }); pl.n++; pl.ms += dt; if (dt > pl.max) pl.max = dt;
    return res;
  }

  return {
    cfg, seed, species, speciesIndex: byName, layer, stats, disabled,
    layerNames: (group) => Object.keys(LAYERS).filter((n) => LAYERS[n] === group),
    chunkSize: CS, worldSize: W, elevRange: [hLo, hHi], elev01, mul,
    clearCache: () => cache.clear(), setCacheCap: (n) => { cacheCap = n; },
    // exposed so tests can cross-check the exclusion rules and the pure tree rule
    envOk: (cat, x, z) => !!envOk(cfg.cats[cat], cat, x, z, map.surfaceAt(x, z)),
    slopeAt,
  };
}

// ================================================================================================
// LOD selection (shared by the renderer and the tests): distance (xz) -> lod 0..2, or -1 = culled. Species without LOD meshes use lod 0 at every distance.
// ================================================================================================
export function lodOf(cfg, cat, dist, qDist = 1) {
  const L = cfg.lod[cat], cull = L.cull * qDist;
  if (dist >= cull) return -1;
  let k = 0; while (k < L.d.length && dist >= L.d[k] * qDist) k++;
  return k;
}
// counts of instances per category and LOD for a camera position over the given layer results
export function lodCounts(gen, layers, cx, cz, qDist = 1) {
  const out = {};
  for (const L of layers) for (const cat of Object.keys(L.parts)) {
    const p = L.parts[cat], o = out[cat] || (out[cat] = { lod0: 0, lod1: 0, lod2: 0, culled: 0, tris: 0, total: 0 });
    for (let i = 0; i < p.n; i++) {
      const d = Math.hypot(p.data[i * 7] - cx, p.data[i * 7 + 2] - cz), sp = gen.species[p.species[i]];
      let k = lodOf(gen.cfg, cat, d, qDist); o.total++;
      if (k < 0) { o.culled++; continue; }
      k = Math.min(k, sp.lods.length); o['lod' + k]++;
      o.tris += k === 0 ? sp.tris : sp.lodTris[k - 1];
    }
  }
  return out;
}
