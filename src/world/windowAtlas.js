// Procedural window textures for windows-in-texture facade bands (pure: no THREE, runs in Node).
//
//   windowTexture(style, { cellPx = 64, cells = 4, seed = 1, variant = 0, tintMask = false }) -> { data, emissive, width, height, cells }
//        data = RGBA Uint8Array, meant to be MULTIPLIED by the vertex tint; emissive = RGBA Uint8Array (black except lit windows, for night).
//        One texture per (style, variant), no atlas: cells x cells window cells (one bay x one storey each) so neighbouring windows differ (lit / blinds / reflection).
//        Row 0 = v 0 (bottom), i.e. THREE.DataTexture with flipY = false (its default).
//        variant (0..STYLE_VARIANTS-1) changes glass colour (masonry styles), frame tone, lit share, blinds and mullion layout (curtain styles).
//        tintMask: alpha = 255 on wall pixels (take the vertex tint), 0 on glass (keeps its own baked colour) -> use with patchTintMask(material). Default: alpha 255 everywhere.
//   WINDOW_STYLES (17: 13 facade + lobby / retail / office / dark ground-floor glass for lobbyGlass / retailGlass / officeGlass, uv = whole cells per bay panel), STYLE_BY_MAT = material key -> default style (variant 0), STYLE_POOL = material key -> styles a building may pick, STYLE_VARIANTS = 3.
//   textureKeyFor(materialKey, buildingSeed) -> 'style:variant'     deterministic per-building pick (towerKit already returns these as planTower(...).tex[matKey]).
//   parseTextureKey(key) -> { style, variant };  textureFromKey(key, opts) = windowTexture(style, { ...opts, variant }).
//   patchTintMask(material)  sets material.onBeforeCompile so the vertex colour only tints pixels whose map alpha is 1 (glass keeps its baked colour). Pure string patch.
//
// UV CONTRACT (shapeGrammar Mesh.band): u = bays, v = storeys, 1 uv unit = 1 window cell (towerKit adds a whole-cell per-building offset). Bind with
// wrapS = wrapT = RepeatWrapping and repeat = (1 / cells, 1 / cells). metalPanel boxes carry uv in metres, so with the same repeat one panel = 1 m.
// RENDERER: one material per texture key (b.tex[p.mat] ?? STYLE_BY_MAT[p.mat] + ':0'); masonry keys (windowBand / windowGrid / windowDeco pools) with tintMask + patchTintMask.
import { hash } from './scatterGen.js';

export const WINDOW_STYLES = ['punched', 'curtain', 'grid', 'deco', 'panel', 'doubleHung', 'arched', 'stoneMullion', 'ribbon', 'louvre', 'checker', 'gothic', 'curtainGrid', 'lobby', 'retail', 'office', 'dark'];
export const STYLE_BY_MAT = { windowBand: 'punched', curtainGlass: 'curtain', windowGrid: 'grid', windowDeco: 'deco', metalPanel: 'panel', lobbyGlass: 'lobby', retailGlass: 'retail', officeGlass: 'office' };
export const STYLE_POOL = {
  windowBand: ['punched', 'doubleHung', 'arched', 'stoneMullion'], windowGrid: ['grid', 'ribbon', 'louvre', 'checker'],
  windowDeco: ['deco', 'gothic', 'stoneMullion'], curtainGlass: ['curtain', 'curtainGrid'], metalPanel: ['panel'],
  lobbyGlass: ['lobby', 'lobby', 'dark'], retailGlass: ['retail'], officeGlass: ['office', 'dark'],   // ground floor
};
export const STYLE_VARIANTS = 3;
const CURTAIN = new Set(['curtain', 'curtainGrid']);
const GLASS = [[0.32, 0.42, 0.55], [0.3, 0.48, 0.48], [0.36, 0.46, 0.36], [0.5, 0.4, 0.3], [0.4, 0.42, 0.45], [0.18, 0.2, 0.24]];   // blue teal green bronze grey black

export const parseTextureKey = (key) => { const [style, v] = String(key).split(':'); return { style, variant: +v || 0 }; };
export function textureKeyFor(mat, seed) {
  const pool = STYLE_POOL[mat] || [STYLE_BY_MAT[mat] || 'panel'], r = (k) => hash(seed >>> 0, k, 0, 9091);
  return `${pool[Math.floor(r(1) * pool.length) % pool.length]}:${Math.floor(r(2) * STYLE_VARIANTS) % STYLE_VARIANTS}`;
}
export const textureFromKey = (key, opts = {}) => { const { style, variant } = parseTextureKey(key); return windowTexture(style, { ...opts, variant }); };

// each style: f(x, y, cx, cy, v) -> [brightness, glass?] for cell-local x, y in 0..1 (y up), cell index cx, cy, variant v
const inR = (x, y, x0, x1, y0, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
const framed = (x, y, x0, x1, y0, y1, t = 0.03) => (inR(x, y, x0 + t, x1 - t, y0 + t, y1 - t) ? [0, 1] : [0.82, 0]);
const STYLE = {
  punched(x, y) {   // masonry wall, framed window with sill and lintel
    if (inR(x, y, 0.25, 0.75, 0.2, 0.82)) {
      if (!inR(x, y, 0.28, 0.72, 0.23, 0.79) || Math.abs(x - 0.5) < 0.012 || Math.abs(y - 0.6) < 0.012) return [0.82, 0];
      return [0, 1];
    }
    if (inR(x, y, 0.22, 0.78, 0.15, 0.2) || inR(x, y, 0.23, 0.77, 0.82, 0.88)) return [1.15, 0];
    return [1, 0];
  },
  curtain(x, y, cx, cy, v) {   // glass with vertical mullions (variant: 2 / 1 / 3 lights), transom and an opaque spandrel at the floor line
    const m = [[0, 0.5, 1], [0, 1], [0, 1 / 3, 2 / 3, 1]][v % 3];
    if (m.some((p) => Math.abs(x - p) < 0.025)) return [1.1, 0];
    if (y < 0.16) return y > 0.14 || y < 0.02 ? [1.1, 0] : [0.5, 0];
    if (v !== 1 && Math.abs(y - 0.85) < 0.012) return [1.05, 0];
    return [0, 1];
  },
  curtainGrid(x, y, cx, cy, v) {   // square-gridded glazing with alternate solid panels
    if (Math.abs(((x * 2) % 1) - 0.5) > 0.47 || Math.abs(((y * 2) % 1) - 0.5) > 0.46) return [1.1, 0];
    if (v === 2 && y < 0.5 && (cx + cy) % 2) return [0.55, 0];
    return [0, 1];
  },
  grid(x, y) {   // concrete frame, deep recessed window: shadow along top and left of the opening
    if (!inR(x, y, 0.1, 0.9, 0.18, 0.88)) return [1, 0];
    if (y > 0.84 || x < 0.14) return [0.55, 0];
    if (Math.abs(x - 0.5) < 0.01) return [0.8, 0];
    return [0, 1];
  },
  deco(x, y) {   // pale vertical piers, dark recessed strip between with a patterned spandrel
    if (x < 0.16 || x > 0.84) return [x < 0.04 || x > 0.96 ? 0.9 : 1.12, 0];
    if (y < 0.18) return [Math.abs(((x * 8) % 1) - 0.5) * 2 > 0.6 - y * 2 ? 0.75 : 0.6, 0];
    if (y > 0.9) return [0.7, 0];
    return [0, 1];
  },
  panel(x, y) {   // metal cladding panels with joints
    return [x < 0.02 || y < 0.03 || Math.abs(x - 0.5) < 0.01 ? 0.7 : 0.95 + 0.05 * y, 0];
  },
  doubleHung(x, y) {   // pair of tall sash windows with meeting rails
    for (const [x0, x1] of [[0.14, 0.44], [0.56, 0.86]]) if (inR(x, y, x0, x1, 0.2, 0.82)) return Math.abs(y - 0.52) < 0.015 ? [0.82, 0] : framed(x, y, x0, x1, 0.2, 0.82);
    if (inR(x, y, 0.12, 0.88, 0.15, 0.2)) return [1.15, 0];
    return [1, 0];
  },
  arched(x, y) {   // round-headed window with keystone
    const r = 0.2, dy = y - 0.68, inArch = dy > 0 && Math.hypot(x - 0.5, dy) < r;
    if (inR(x, y, 0.3, 0.7, 0.18, 0.68) || inArch) return (x < 0.33 || x > 0.67 || y < 0.21 || (dy > 0 && Math.hypot(x - 0.5, dy) > r - 0.03)) ? [0.82, 0] : [0, 1];
    if (dy > 0 && Math.hypot(x - 0.5, dy) < r + 0.05) return [1.12, 0];
    return inR(x, y, 0.46, 0.54, 0.86, 0.93) ? [1.2, 0] : [1, 0];
  },
  stoneMullion(x, y) {   // wide office window split by stone mullions and a transom
    if (!inR(x, y, 0.1, 0.9, 0.2, 0.82)) return [1, 0];
    if (Math.abs(x - 0.37) < 0.025 || Math.abs(x - 0.63) < 0.025 || Math.abs(y - 0.66) < 0.02) return [1.05, 0];
    return framed(x, y, 0.1, 0.9, 0.2, 0.82, 0.02);
  },
  ribbon(x, y) {   // continuous horizontal glazing strip, thin mullions
    if (!inR(x, y, 0, 1, 0.32, 0.86)) return [y > 0.86 && y < 0.9 ? 0.7 : 1, 0];
    return x < 0.015 || Math.abs(x - 0.5) < 0.008 ? [0.85, 0] : [0, 1];
  },
  louvre(x, y) {   // brise-soleil: horizontal sun slats over the glass
    if (x < 0.08 || x > 0.92 || y < 0.14) return [1, 0];
    if (((y * 10) % 1) < 0.28) return [1.08 - ((y * 10) % 1), 0];
    return [0, 1];
  },
  checker(x, y, cx, cy) {   // windows shift left / right per cell, checker spandrel tone
    const o = (cx + cy) % 2 ? 0.12 : -0.12;
    if (inR(x, y, 0.22 + o, 0.78 + o, 0.25, 0.85)) return framed(x, y, 0.22 + o, 0.78 + o, 0.25, 0.85);
    return [(cx + cy) % 2 ? 0.8 : 1, 0];
  },
  // GROUND-FLOOR glass (cell = one ~1.5 m wide panel x the full glass height; towerKit uses Mesh.rectUV so cells never stretch). Return { rgb, e }.
  lobby(x, y, cx, cy, v, s) {   // dark reflective glass, transom, faint ceiling downlights
    const fr = [[0.2, 0.2, 0.22], [0.42, 0.33, 0.22], [0.75, 0.76, 0.78]][v % 3];
    if (x < 0.04 || x > 0.96 || y < 0.03 || Math.abs(y - 0.78) < 0.012) return { rgb: fr };
    if (y > 0.86 && y < 0.9 && Math.abs(((x * 2) % 1) - 0.5) < 0.12) return { rgb: [1, 0.95, 0.8], e: 0.8 };
    const k = 0.18 + 0.22 * y + 0.08 * Math.max(0, 1 - Math.abs(x - y - 0.2) * 6) + (hash(s, cx, cy, 3) - 0.5) * 0.06;
    return { rgb: [k * 0.85, k * 0.95, k * 1.1] };
  },
  retail(x, y, cx, cy, v, s) {   // lit shop display: warm/cool back wall, goods blobs, frame
    if (x < 0.04 || x > 0.96 || y < 0.04) return { rgb: [[0.15, 0.15, 0.15], [0.5, 0.4, 0.25], [0.7, 0.7, 0.7]][v % 3] };
    const r = (k) => hash(s, cx, cy, 50 + k), bg = [[0.95, 0.88, 0.7], [0.8, 0.88, 0.95], [0.95, 0.75, 0.75], [0.85, 0.95, 0.8]][Math.floor(r(0) * 4) % 4];
    if (r(9) < 0.15) return { rgb: [0.12, 0.13, 0.15] };   // closed / dark shop
    for (let i = 0; i < 3; i++) {
      const gx = 0.12 + r(i + 1) * 0.6, gw = 0.12 + r(i + 4) * 0.18, gh = 0.15 + r(i + 7) * 0.35;
      if (inR(x, y, gx, gx + gw, 0.08, 0.08 + gh)) return { rgb: [0.3 + r(i + 10) * 0.7, 0.2 + r(i + 13) * 0.6, 0.2 + r(i + 16) * 0.7], e: 0.4 };
    }
    return { rgb: bg.map((c) => c * (0.75 + 0.25 * y)), e: 0.7 };
  },
  office(x, y, cx, cy, v, s) {   // glass with venetian blinds at random heights, some lit
    if (x < 0.04 || x > 0.96 || y < 0.03) return { rgb: [0.3, 0.3, 0.32] };
    const b = 1 - hash(s, cx, cy, 70) * (0.4 + v * 0.2), lit = hash(s, cx, cy, 71) < 0.3;
    if (y > b) return { rgb: ((y * 30) % 1) < 0.3 ? [0.55, 0.53, 0.5] : [0.85, 0.83, 0.78] };
    return lit ? { rgb: [0.95, 0.9, 0.75], e: 0.6 } : { rgb: [0.22, 0.26, 0.3].map((c) => c + 0.15 * y) };
  },
  dark(x, y, cx, cy, v) {   // tinted, near-opaque glass with a diagonal reflection streak
    if (x < 0.03 || x > 0.97) return { rgb: [0.25, 0.25, 0.27] };
    const k = 0.1 + 0.05 * v + 0.12 * Math.max(0, 1 - Math.abs(x * 0.7 - y + 0.3) * 5);
    return { rgb: [k, k * 1.05, k * 1.15] };
  },
  gothic(x, y) {   // narrow pointed lancets between piers
    if (x < 0.14 || x > 0.86) return [1.12, 0];
    const top = 0.72 + 0.2 * (1 - Math.abs(x - 0.5) / 0.36);
    if (y < 0.16 || y > top) return [0.72, 0];
    return Math.abs(x - 0.5) < 0.02 ? [0.9, 0] : [0, 1];
  },
};

export function windowTexture(style, { cellPx = 64, cells = 4, seed = 1, variant = 0, tintMask = false } = {}) {
  const f = STYLE[style]; if (!f) throw new Error(`unknown window style ${style}`);
  const N = cellPx * cells, data = new Uint8Array(N * N * 4), emissive = new Uint8Array(N * N * 4), curtain = CURTAIN.has(style);
  const vs = (seed >>> 0) + variant * 7919, vr = (k) => hash(vs, k, 0, 4241);
  const glass = curtain ? [0.62, 0.66, 0.72] : GLASS[Math.floor(vr(1) * GLASS.length) % GLASS.length], frame = 0.85 + vr(2) * 0.3;
  const litP = 0.08 + vr(3) * 0.2, blindP = 0.2 + vr(4) * 0.4;
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    const r = (k) => hash(vs, cx, cy, 31 + k);
    const lit = r(0) < litP, blind = r(1) < blindP ? 0.25 + r(2) * 0.45 : 0, tone = (r(3) - 0.5) * 0.14;
    for (let py = 0; py < cellPx; py++) for (let px = 0; px < cellPx; px++) {
      const x = (px + 0.5) / cellPx, y = (py + 0.5) / cellPx, res = f(x, y, cx, cy, variant, vs), [v0, isGlass] = res.rgb ? [0, 0] : res;
      let R, G, B, e = 0;
      if (res.rgb) { [R, G, B] = res.rgb; e = res.e || 0; }   // ground-floor styles paint their own colour
      else if (!isGlass) { const n = (hash(vs, cx * cellPx + px, cy * cellPx + py, 5) - 0.5) * 0.04, v = (v0 < 0.9 ? v0 * frame : v0) + n; R = G = B = v; }
      else {
        const k = 1 + tone + 0.3 * (y - 0.5);   // sky reflection brighter towards the top
        if (!curtain && blind && y > 0.85 - blind * 0.6) { R = 0.85; G = 0.82; B = 0.74; }
        else if (lit && !curtain) { R = 1; G = 0.86; B = 0.55; e = 1; }
        else { R = glass[0] * k; G = glass[1] * k; B = glass[2] * k; if (lit) e = 0.6; }
      }
      const o = 4 * ((cy * cellPx + py) * N + cx * cellPx + px), c = (v) => Math.max(0, Math.min(255, Math.round(v * 220)));   // 220: headroom for > 1 highlights
      data[o] = c(R); data[o + 1] = c(G); data[o + 2] = c(B); data[o + 3] = tintMask && isGlass && !curtain ? 0 : 255;
      emissive[o] = Math.round(e * 255); emissive[o + 1] = Math.round(e * 215); emissive[o + 2] = Math.round(e * 140); emissive[o + 3] = 255;
    }
  }
  return { data, emissive, width: N, height: N, cells };
}

// vertex colour tints only where map alpha = 1 (wall), glass keeps the baked colour. For MeshLambert / Standard with vertexColors + map (three r15x+ chunk names).
export function patchTintMask(material) {
  material.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', '#ifdef USE_MAP\n vec4 twTex = texture2D( map, vMapUv ); diffuseColor.rgb *= twTex.rgb; float twMask = twTex.a;\n#else\n float twMask = 1.0;\n#endif')
      .replace('#include <color_fragment>', '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, twMask );\n#endif');
  };
  material.customProgramCacheKey = () => 'tintMask';
  return material;
}
