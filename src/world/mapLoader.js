// Map loader for the exports of the terrain editor (editor.html / tools/terrain-editor.html; see the comment block at the top of
// the editor for the format; this file follows it exactly).
//
// World convention: x = pixel column (east), z = pixel row (south, DOWN the editor image), y up, metres.
// The map covers [0,worldSize]^2. Height/splat/water samples sit at pixel CENTRES ((i+0.5)*cell).
//
// THREE / RAPIER are injected so the game owns the single instance of each (and so this runs in Node).
//
// OPTIONAL junctions.json in the map folder (overrides for automatically detected junctions):
//   [ { "x": 250.0, "z": 300.0, "style": "junction" | "roundabout" | "signals" | "none", "radius": 20 } ]
//   Each entry is matched to the nearest detected junction within 15 m (unmatched entries are ignored).
//   style  = what to build there ('none' = plain overlapping roads, no patch/roundabout/terrain stamp; 'signals' = junction patch with
//            traffic signals, zebra crossings on every arm, corner pavements on city arms - see roadSignals.js);
//   radius = optional: roundabout OUTER radius in metres (min 12), or junction/signals-patch radius (min 10).
// JUNCTION STYLE RULES (precedence: junctions.json > markers > defaults):
//   defaults: 2-3 arms (T / Y / L) -> 'junction' patch, 4+ arms or a crossing -> 'roundabout' (country roads);
//             a junction with 3+ arms where ANY arm's road segment has type 'city' -> 'signals' (never a roundabout);
//             ANY arm of type 'highway' -> plain 'junction' (checked first: no roundabout, no signals).
//   markers:  a marker within 15 m of a detected junction with tag 'roundabout' | 'signals' | 'junction_plain' (= plain junction patch) forces that style
//             (the nearest such marker wins).
//   map.junctions[i].source = 'default' | 'marker' | 'json' tells which rule decided.
// Roads that cross over each other (either is a bridge there, or heights differ by > 4 m) make no junction.
//
// ROAD NODE METADATA (roads.json points, all optional, see roadMeta.js for the full definition; absent = default):
//   point: { nx, nz, x, y, z, bridge, type?, oneway?, edgeL?, edgeR?, surface?, features?, signs? }
//     type    'country' (default) | 'city' | 'highway'        city: darker smooth asphalt, kerbs + footpaths (2.65 m each side, roadCity.js), terrain flattened
//                                                             across the corridor, zebra/signals junctions; highway: lane markings, shoulders, median barrier
//     oneway  false (default) | true                          direction = point order; no centre line, arrows every ~40 m
//     edgeL / edgeR  'none' (default) | 'fence' | 'guardrail' | 'barrier' | 'lamps'   left / right looking forward along the point order
//     surface 'smooth' (default) | 'worn' | 'potholes' | 'gravel'   (shader look + surfaceAt roughness/grip; potholes are NOT geometry)
//     signs   'auto' (default) | 'off'                        automatic warning signs on this segment
//     features string[] of 'crosswalk' (zebra + 2 pedestrian signs; city: dropped kerb) | 'bump' | 'rumble' | 'roadworks'   at the point itself
//   Segment attributes (type, oneway, edgeL, edgeR, surface, signs) apply from a point to the NEXT point (like bridge); the last
//   point's are ignored. Loaded roads keep them: map.roads[i].points[j].type etc. (validated, defaults filled in, features sorted).
// map.json (optional): driveSide 'right' (default) | 'left', signStyle 'us' (default, yellow diamonds) | 'eu' (red-bordered triangles);
//   exposed as map.info.driveSide / map.info.signStyle.
// surfaceAt(x,z) additionally returns { roadSurface: string|null, roughness: 0..1, gripMul } (roadSurface = the road surface name when on
//   asphalt/gravel road, else null; roughness 0 smooth..1 very rough, also raised inside rumble-strip zones; gripMul multiplies tyre grip:
//   gravel 0.7, potholes 0.9, worn 0.95). classId stays 6 on any road surface. On a city FOOTPATH (incl. corner blocks) it returns
//   classId 7 (city), roadSurface 'footpath', roughness 0, gripMul 1.
// City edge items: lamps / fences / guardrails / barriers on a city segment stand FOOT_SHIFT (2.65 m = kerb 0.15 + footpath 2.5) further out than on country roads,
//   i.e. just outside the footpath; they stay user-controlled through edgeL / edgeR.
// AUTO BRIDGES OVER WATER (roadBridges.js; loader option autoBridge, default true; autoBridge:false = the old behaviour, roads drape on the terrain / under the water):
//   a non-bridge road stretch whose surface (centreline or either edge) is below the water surface + 0.3 m (lake/river = waterLevelAt, ocean = seaLevelMeters) is turned into
//   a bridge: deck y = max(road y, water + 1.5 m) over the wet stretch (tiny wet spots < 4 m are ignored unless > 0.5 m under water, wet stretches < 20 m apart merge),
//   plus approach ramps (<= 7% grade, smooth) on both sides that end exactly at the dry road height. The whole span is an ordinary bridge (deck slab, rails, pillars, Rapier
//   trimesh; no edges / lamps / features / warning signs / footpaths / terrain stamping / surfaceAt road). An editor-marked bridge over water keeps its flag and its deck
//   is raised the same way when it is lower than water + 1.5 m. JUNCTIONS: a span (ramps included) that comes within a junction's footprint (stamped extent + blend) is NOT bridged
//   (road stays on the terrain, listed in roadDetail.autoBridgeSkipped). Result: roadDetail.autoBridges = [{ roadId, s0, s1, deckY0, deckY1, maxY, reason: 'lake'|'ocean', raised, x0,z0,x1,z1, path[x,z,...] }]
//   (s = arc length in metres along getPoints(1)), also road.autoBridges per road; samples carry bridge:true + auto:true, control points inside a span carry auto:true.
// map.update(dt)       advance the signal-light clock (seconds); call once per frame (signals junctions only animate when you do).
// map.signalState(group) -> 'green' | 'amber' | 'red' for phase group 0 / 1 at the current clock. map.junctions[i] = { x, z, y, style, radius, arms[{roadId,angle,width,type}],
//   source, signals[{x,y,z,roadId,group,fx,fz}] } (signals: posts of a 'signals' junction; group = phase group, fx/fz = the way the head faces).
// map.roadDetail = { signs[], edgePieces[], lamps[], features[], drawCalls, counts{} } describes what the road builder generated
//   (additive: footpaths[], cornerBlocks[], zebras[], crosswalkSigns[], signals[]; counts footpathPieces/cornerBlocks/zebras/signalPosts/...).
// map.parts.roadEdges / roadProps / roadSigns are the toggleable groups (visibility survives rebuilds); colliders are not removed by toggling.
import { polyOf, detectJunctions, stampJunctions, makeRoadQuery, buildRoads, cityRuns, stampCityCorridors } from './roads.js';
import { planAutoBridges } from './roadBridges.js';
import { signalState } from './roadSignals.js';
import { parseNodeMeta, parseMapMeta, SURFACE_PROPS, JUNCTION_STYLES, MARKER_JUNCTION_TAGS, CITY, FOOT_SHIFT } from './roadMeta.js';

export const SURFACE_NAMES = Object.freeze(['grass', 'forest', 'dirt', 'sand', 'rock', 'snow', 'road', 'city']);
// Indexed by classId. Vehicles read this per wheel via surfaceAt(); the terrain collider itself uses friction 1.
export const SURFACE_FRICTION = Object.freeze([0.8, 0.8, 0.7, 0.5, 0.9, 0.3, 1, 1]);

// ------------------------------------------------------------------------------------------------
// PNG decoder (canvas premultiplies alpha and cannot read 16-bit, so we decode ourselves).
// Supports bit depth 8/16, colour types 0 (gray), 2 (RGB), 4 (gray+A), 6 (RGBA), all 5 filters, no interlace/palette.
// Returns { width, height, channels, bitDepth, data } where data is Uint8Array (8-bit) or Uint16Array (16-bit,
// native endian, converted from PNG big-endian). Values are exact (no colour management / alpha handling).
// ------------------------------------------------------------------------------------------------
async function inflate(u8) {
  const ds = new DecompressionStream('deflate'); // 'deflate' = zlib-wrapped, which is what PNG IDAT uses
  const w = ds.writable.getWriter();
  w.write(u8).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export async function decodePNG(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (u8.length < 33 || SIG.some((b, i) => u8[i] !== b)) throw new Error('decodePNG: not a PNG file');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1;
  const idat = [];
  while (pos + 12 <= u8.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const body = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      bitDepth = u8[pos + 16]; colorType = u8[pos + 17];
      if (u8[pos + 20] !== 0) throw new Error('decodePNG: interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('decodePNG: unsupported colour type ' + colorType);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('decodePNG: unsupported bit depth ' + bitDepth);
  let total = 0; for (const c of idat) total += c.length;
  const z = new Uint8Array(total); { let o = 0; for (const c of idat) { z.set(c, o); o += c.length; } }
  const raw = await inflate(z);
  const bpp = channels * bitDepth / 8, rowB = width * bpp;
  if (raw.length !== (rowB + 1) * height) throw new Error('decodePNG: decompressed size mismatch');
  const out = new Uint8Array(rowB * height);
  for (let y = 0; y < height; y++) {
    const s = y * (rowB + 1) + 1, d = y * rowB, p = d - rowB, ft = raw[s - 1];
    switch (ft) {
      case 0: out.set(raw.subarray(s, s + rowB), d); break;
      case 1: for (let i = 0; i < rowB; i++) out[d + i] = raw[s + i] + (i >= bpp ? out[d + i - bpp] : 0); break;
      case 2: for (let i = 0; i < rowB; i++) out[d + i] = raw[s + i] + (y ? out[p + i] : 0); break;
      case 3: for (let i = 0; i < rowB; i++) out[d + i] = raw[s + i] + (((i >= bpp ? out[d + i - bpp] : 0) + (y ? out[p + i] : 0)) >> 1); break;
      case 4: for (let i = 0; i < rowB; i++) {
        const a = i >= bpp ? out[d + i - bpp] : 0, b = y ? out[p + i] : 0, c = (y && i >= bpp) ? out[p + i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        out[d + i] = raw[s + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } break;
      default: throw new Error('decodePNG: bad filter type ' + ft + ' on row ' + y);
    }
  }
  let data = out;
  if (bitDepth === 16) {
    data = new Uint16Array(width * height * channels);
    for (let i = 0; i < data.length; i++) data[i] = (out[2 * i] << 8) | out[2 * i + 1];
  }
  return { width, height, channels, bitDepth, data };
}

// ------------------------------------------------------------------------------------------------
// Roads: uniform Catmull-Rom through the control points, end points duplicated as phantom neighbours,
// evaluated in the x,z plane (exactly the editor's sampleRoad). Parameter t of sample(t) is 0..1 over the
// whole road, uniform in CONTROL-POINT index (not arc length); getPoints() is ~arc-length spaced.
// Sample = { x, y, z, bridge, auto, seg, tx, tz, u }:
//   y      = terrain height at (x,z) on normal segments (roads are baked into the terrain by the editor);
//            on bridge segments the straight line between the two control-point heights (deck line); on auto-bridged spans the planned deck.
//   bridge = the segment starting at control point `seg` is a bridge (editor flag) OR the sample lies in an auto-bridged span.
//   auto   = the sample is part of an auto bridge over water (roadBridges.js); road.autoBridges lists the spans, point.auto marks control points inside one.
//   tx,tz  = unit horizontal tangent.
// ------------------------------------------------------------------------------------------------
function makeRoad(r, heightAt) {
  const P = r.points.map((p) => ({ x: p.x, y: p.y, z: p.z, bridge: !!p.bridge, ...parseNodeMeta(p) }));
  const n = P.length;
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const dcr = (a, b, c, d, t) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t);
  let deck = null; // auto-bridge deck table from roadBridges.js: { u[], y[], mod[], auto[] } per getPoints(1) sample (u = seg + f); mod = deck overrides y + bridge
  const deckAt = (u) => { // largest sample index k with deck.u[k] <= u
    let lo = 0, hi = deck.u.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (deck.u[m] <= u + 1e-9) lo = m; else hi = m - 1; }
    return lo;
  };
  function segPoint(i, f) {
    const p0 = P[Math.max(i - 1, 0)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(i + 2, n - 1)];
    const x = cr(p0.x, p1.x, p2.x, p3.x, f), z = cr(p0.z, p1.z, p2.z, p3.z, f);
    let tx = dcr(p0.x, p1.x, p2.x, p3.x, f), tz = dcr(p0.z, p1.z, p2.z, p3.z, f);
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    let bridge = p1.bridge, auto = false, y = bridge ? p1.y + (p2.y - p1.y) * f : heightAt(x, z);
    if (deck) {
      const k = deckAt(i + f);
      if (deck.mod[k]) { const k2 = Math.min(k + 1, deck.u.length - 1), d = deck.u[k2] - deck.u[k], t = d > 0 ? (i + f - deck.u[k]) / d : 0; bridge = true; auto = !!deck.auto[k]; y = deck.y[k] + (deck.y[k2] - deck.y[k]) * t; }
    }
    return { x, y, z, bridge, auto, seg: i, tx, tz, u: i + f };
  }
  const single = () => ({ x: P[0].x, y: P[0].y, z: P[0].z, bridge: false, auto: false, seg: 0, tx: 1, tz: 0, u: 0 });
  return {
    id: r.id, width: r.widthMeters, points: P, autoBridges: [],
    setDeck(d) { deck = d; },
    sample(t) {
      if (n === 0) return null;
      if (n === 1) return single();
      const u = Math.min(Math.max(t, 0), 1) * (n - 1), i = Math.min(Math.floor(u), n - 2);
      return segPoint(i, u - i);
    },
    getPoints(spacingMeters) {
      if (n === 0) return [];
      if (n === 1) return [single()];
      const out = [];
      for (let i = 0; i < n - 1; i++) {
        const m = Math.max(2, Math.ceil(Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z) / spacingMeters));
        for (let k = 0; k < m; k++) out.push(segPoint(i, k / m));
      }
      out.push(segPoint(n - 2, 1));
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Terrain material. One obvious place for per-class textures: the GLSL function classAlbedo() below plus the
// `uClassColor[8]` uniform array (material.userData.uniforms.uClassColor, linear-space THREE.Color x8, order =
// class ids 0..7). To add textures later: add sampler uniforms (e.g. a sampler2DArray, 8 layers) and return
// texture(..., vec3(wxz * scale, c)) from classAlbedo(); nothing else needs to change.
// ------------------------------------------------------------------------------------------------
function makeTerrainMaterial(THREE, splat0, splat1, classColors, worldSize) {
  const uniforms = {
    uSplat0: { value: splat0 }, uSplat1: { value: splat1 }, uWorld: { value: worldSize },
    uClassColor: { value: classColors },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'splat-terrain-v1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = position; vWN = normal; // chunks are in absolute world coords');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWP;
varying vec3 vWN;
uniform sampler2D uSplat0;
uniform sampler2D uSplat1;
uniform float uWorld;
uniform vec3 uClassColor[8];
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x), mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
}
// ===== PER-CLASS SURFACE HOOK: replace this body with texture fetches when textures exist =====
vec3 classAlbedo(int c, vec2 wxz){
  if (c == 6) return vec3(0.30, 0.27, 0.21); // road class = neutral gravel shoulder; the asphalt is the road mesh (roads.js)
  return uClassColor[c];
}
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 suv = vWP.xz / uWorld; // edge-to-edge; texel centres sit at (i+0.5)/N which is exactly the editor's sample point
  vec4 s0 = texture2D(uSplat0, suv), s1 = texture2D(uSplat1, suv);
  float w[8] = float[8](s0.r, s0.g, s0.b, s0.a, s1.r, s1.g, s1.b, s1.a);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 8; i++) col += w[i] * classAlbedo(i, vWP.xz);
  float nz = vnoise(vWP.xz * 0.35) * 0.5 + vnoise(vWP.xz * 1.7) * 0.3 + vnoise(vWP.xz * 7.0) * 0.2;
  col *= 0.78 + 0.44 * nz;
  float steep = smoothstep(0.18, 0.42, 1.0 - normalize(vWN).y) * (1.0 - w[6] - w[7]); // steep faces -> rock tint
  col = mix(col, classAlbedo(4, vWP.xz) * (0.75 + 0.5 * nz), steep * 0.75);
  diffuseColor.rgb = col;
}`);
  };
  return mat;
}

function makeWaterMaterial(THREE) {
  const mat = new THREE.MeshPhongMaterial({
    color: 0x2f7aa6, specular: 0x667788, shininess: 40, transparent: true, opacity: 0.72, depthWrite: false,
  });
  mat.customProgramCacheKey = () => 'water-v1';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = mat.userData.time;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWWP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWWP;\nuniform float uTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(normal + 0.025 * vec3(sin(vWWP.x * 0.21 + uTime * 0.8) + sin(vWWP.z * 0.17 - uTime * 0.6), 0.0, sin(vWWP.z * 0.25 + uTime * 0.7) + sin(vWWP.x * 0.13 + uTime * 0.5)));`);
  };
  mat.userData.time = { value: 0 };
  return mat;
}

// ------------------------------------------------------------------------------------------------
// Public loaders. Both end in the same builder (buildMap), so there is exactly one build code path.
//
//   loadMap(baseUrl, opts)         fetch the 8 export files, decode them, then buildMap.
//   loadMapFromData(data, opts)    build from in-memory arrays (what the editor's live 3D preview uses):
//     data = {
//       info:    map.json-style object { N, worldSizeMeters, maxHeightMeters, seaLevel, seaLevelMeters, classes[8] }
//       height:  Uint16Array N*N   exactly as heightmap.r16 / heightmap16.png hold it
//       splat0:  Uint8Array  N*N*4 RGBA8 of classes 0-3 (exactly the splat0.png pixels)
//       splat1:  Uint8Array  N*N*4 RGBA8 of classes 4-7
//       water:   Uint16Array N*N   same encoding as water.png (0 = none, v -> (v-1)/65534 * maxHeight)
//       roads:   the roads.json object { roads: [...] }
//       junctions?: optional junctions.json overrides
//       markers?:   optional markers.json object { version, markers: [...] } (see MARKERS below)
//     }
//     The arrays are COPIED, so the caller may keep editing its own buffers.
//   opts: { THREE, RAPIER, physicsWorld, physics = true, physicsResolution = 512, chunkSize = 128, autoBridge = true }
//     physics:false ignores physicsWorld (no Rapier heightfield / bridge colliders) - for previews.
//
// MARKERS (markers.json, optional; if absent map.markers = []): pins placed in the editor, to be looked up by name/tag.
//   file:  { version:1, markers:[ { id, name, tags[], color:'#rrggbb', x, z, y, yaw, radius, props{}, yOffset, nx, nz } ] }
//   x,z = world metres (same convention as roads.json: x east, z south), nx,nz = normalized; yaw in DEGREES, 0 = +X (east),
//   +90 = +Z (south): forward = (cos yaw, sin yaw) in (x,z). radius = trigger radius in metres (0 = point). yOffset = metres above ground.
//   The loader IGNORES the file's y and recomputes y = heightAt(x,z) + yOffset (after junction stamping), so it matches the game ground.
//   map.markers (array, same fields, y recomputed), map.getMarkers({tag?, name?}) -> array, map.markerByName(name) -> marker|null.
//
// The returned map additionally has (for live editing, see updateRegion below):
//   map.updateRegion({x0,y0,x1,y1}, { height, splat, water, roads, markers })  rect in MAP PIXELS (x1,y1 exclusive); the data arrays are
//        full-size (same layout as in `data`) and only the rect is read from them (roads: the whole object, compared by value).
//        Recomputes only the terrain chunks overlapping the rect, re-uploads the splat textures, rebuilds the lake mesh only
//        if water changed, and schedules a ~300 ms debounced rebuild of road/junction/bridge meshes if the roads changed or the
//        changed heights touch a road or junction. Junction stamping is always applied to an internal copy of the heights.
//        `markers` = the markers.json object (whole, compared by value); marker heights are re-derived after any terrain change.
//        Returns { height, splat, water, roads, markers } booleans = what actually changed.
//   map.flush()           run any debounced road rebuild now (tests, or before reading roads/junctions).
//   map.onRebuild         optional callback, called after the debounced road/junction rebuild (terrain under junctions + marker heights may have changed).
//   map.setSeaLevel(m)    change the ocean plane / sea level in metres.
// ponytail: updateRegion does not touch the Rapier collider (the preview has none); a game wanting live physics edits would
// need to rebuild its heightfield.
// ------------------------------------------------------------------------------------------------
const makeLap = (T) => (k) => { const t = performance.now(); T[k] = t - (T._last ?? T.start); T._last = t; };

export async function loadMap(baseUrl, opts = {}) {
  const need = (cond, msg) => { if (!cond) throw new Error('loadMap: ' + msg); };
  const T = { start: performance.now() }, lap = makeLap(T);
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const get = async (name) => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`loadMap: could not fetch ${base + name} (HTTP ${r.status})`);
    return r;
  };

  // ---- map.json (trust boundary: hand-exported files, validate everything we rely on; the rest is validated in buildMap) ----
  const mj = await (await get('map.json')).json();
  const N = mj.N;
  need(mj.files && ['heightRaw16', 'splat0', 'splat1', 'water', 'roads'].every((k) => typeof mj.files[k] === 'string'),
    'map.json files{} must name heightRaw16, splat0, splat1, water, roads');
  need(Number.isInteger(N) && N >= 2 && N <= 8192, `map.json N must be an integer 2..8192, got ${N}`);

  const optionalJson = (name) => fetch(base + name).then(async (r) => { // optional file; dev servers may answer a missing file with index.html
    if (!r.ok) return null;
    const t = await r.text(); if (t.trimStart().startsWith('<')) return null;
    try { return JSON.parse(t); } catch (e) { throw new Error(`loadMap: ${name} is not valid JSON: ${e.message}`); }
  });
  const [rBuf, s0, s1, wp, rj, jOverrides, markers] = await Promise.all([
    get(mj.files.heightRaw16).then((r) => r.arrayBuffer()),
    get(mj.files.splat0).then((r) => r.arrayBuffer()).then(decodePNG),
    get(mj.files.splat1).then((r) => r.arrayBuffer()).then(decodePNG),
    get(mj.files.water).then((r) => r.arrayBuffer()).then(decodePNG),
    get(mj.files.roads).then((r) => r.json()),
    optionalJson('junctions.json').then((j) => j || []),
    optionalJson(mj.files.markers || 'markers.json'),
  ]);
  lap('fetchDecode');

  need(rBuf.byteLength === N * N * 2, `${mj.files.heightRaw16} is ${rBuf.byteLength} bytes, expected ${N * N * 2} for N=${N}`);
  for (const [name, p, ch, bd] of [[mj.files.splat0, s0, 4, 8], [mj.files.splat1, s1, 4, 8], [mj.files.water, wp, 1, 16]]) {
    need(p.width === N && p.height === N, `${name} is ${p.width}x${p.height}, expected ${N}x${N}`);
    need(p.channels === ch && p.bitDepth === bd, `${name} must be ${bd}-bit with ${ch} channel(s), got ${p.bitDepth}-bit/${p.channels}`);
  }
  // ponytail: assumes a little-endian host (every browser/desktop); add a DataView pass if a big-endian target ever matters.
  return buildMap({ info: mj, height: new Uint16Array(rBuf), splat0: s0.data, splat1: s1.data, water: wp.data, roads: rj, junctions: jOverrides, markers }, opts, T);
}

export function loadMapFromData(data, opts = {}) {
  return buildMap(data, opts, { start: performance.now() });
}

function validateRoads(need, rj) {
  need(rj && Array.isArray(rj.roads), 'roads.json must contain a roads[] array');
  for (const r of rj.roads) {
    need(Array.isArray(r.points) && Number.isFinite(r.widthMeters), `road ${r.id}: needs widthMeters and points[]`);
    need(r.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), `road ${r.id}: points need numeric x,y,z`);
  }
}

// ------------------------------------------------------------------------------------------------
// buildMap: the one builder. All state lives in this closure; updateRegion mutates it in place.
// ------------------------------------------------------------------------------------------------
function buildMap(data, opts, T) {
  const { THREE, RAPIER, physicsResolution = 512, chunkSize = 128 } = opts;
  const physicsWorld = opts.physics === false ? null : opts.physicsWorld;
  if (!THREE) throw new Error('loadMap: options.THREE is required');
  const need = (cond, msg) => { if (!cond) throw new Error('loadMap: ' + msg); };
  const lap = makeLap(T);

  const mj = data.info || {};
  const N = mj.N, W = mj.worldSizeMeters, MAXH = mj.maxHeightMeters;
  need(Number.isInteger(N) && N >= 2 && N <= 8192, `map.json N must be an integer 2..8192, got ${N}`);
  need(Number.isFinite(W) && W > 0, 'map.json worldSizeMeters must be > 0');
  need(Number.isFinite(MAXH) && MAXH > 0, 'map.json maxHeightMeters must be > 0');
  need(Number.isFinite(mj.seaLevelMeters), 'map.json seaLevelMeters missing');
  need(Array.isArray(mj.classes) && mj.classes.length === 8 && mj.classes.every((c, i) => c.id === i && /^#[0-9a-f]{6}$/i.test(c.color)),
    'map.json classes must be 8 entries with id 0..7 and #rrggbb colours');
  need(Number.isInteger(chunkSize) && chunkSize >= 2, 'chunkSize must be an integer >= 2');
  need(data.height instanceof Uint16Array && data.height.length === N * N, `height must be a Uint16Array of N*N=${N * N}`);
  for (const k of ['splat0', 'splat1']) need(data[k] instanceof Uint8Array && data[k].length === N * N * 4, `${k} must be a Uint8Array of N*N*4`);
  need(data.water instanceof Uint16Array && data.water.length === N * N, `water must be a Uint16Array of N*N`);
  const jOverrides = data.junctions || [];
  need(Array.isArray(jOverrides) && jOverrides.every((o) => Number.isFinite(o.x) && Number.isFinite(o.z) && JUNCTION_STYLES.includes(o.style)),
    'junctions.json must be an array of {x, z, style: junction|roundabout|signals|none, radius?}');
  validateRoads(need, data.roads);
  const cell = W / N, mapMeta = parseMapMeta(mj);
  let SEA = mj.seaLevelMeters;
  let rj = data.roads, roadsJson = JSON.stringify(rj);
  const markerList = (o) => { // markers.json object -> validated array of raw markers
    const a = o && Array.isArray(o.markers) ? o.markers : [];
    need(a.every((m) => m && Number.isFinite(m.x ?? (m.nx * W)) && Number.isFinite(m.z ?? (m.nz * W))), 'markers.json: every marker needs numeric x,z (metres) or nx,nz');
    return a;
  };
  let markerRaw = markerList(data.markers), markersJson = JSON.stringify(markerRaw);

  // ---- grids (own copies: the caller keeps its buffers). Hbase = heights in metres exactly as exported; Hm = Hbase + junction
  //      stamps (what everything renders / samples). Stamping never touches Hbase and never writes back to the caller. ----
  const hk = MAXH / 65535, wk = MAXH / 65534;
  const Hbase = new Float32Array(N * N);
  for (let i = 0; i < Hbase.length; i++) Hbase[i] = data.height[i] * hk;
  const Hm = Float32Array.from(Hbase);
  const s0 = data.splat0.slice(), s1 = data.splat1.slice(), wraw = data.water.slice();

  // ---- sampling ----
  const inv = 1 / cell, N1 = N - 1;
  const heightAt = (x, z) => {
    let fx = x * inv - 0.5, fz = z * inv - 0.5;
    fx = fx < 0 ? 0 : fx > N1 ? N1 : fx; fz = fz < 0 ? 0 : fz > N1 ? N1 : fz;
    const i = Math.min(fx | 0, N - 2), j = Math.min(fz | 0, N - 2), tx = fx - i, tz = fz - j, o = j * N + i;
    const a = Hm[o] + (Hm[o + 1] - Hm[o]) * tx, b = Hm[o + N] + (Hm[o + N + 1] - Hm[o + N]) * tx;
    return a + (b - a) * tz;
  };
  const normalAt = (x, z, out = new THREE.Vector3()) => {
    const e = cell;
    return out.set(-(heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), 1, -(heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)).normalize();
  };

  // ---- lake/river water: surface grid (metres), NaN = none. Dry vertices next to wet ones get the mean of the wet
  //      neighbours so quads along the shore have defined corners (they end up hidden under the terrain). ----
  const wf = new Float32Array(N * N).fill(NaN);
  function recomputeWf(x0, y0, x1, y1) { // pixel rect [x0,x1)x[y0,y1) plus a 1 px border (dry pixels average their wet neighbours)
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(N, x1 + 1); y1 = Math.min(N, y1 + 1);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { const k = j * N + i; if (wraw[k] !== 0) wf[k] = (wraw[k] - 1) * wk; }
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
      if (wraw[j * N + i] !== 0) continue;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        const k = b * N + a; if (wraw[k] !== 0) { s += wf[k]; c++; }
      }
      wf[j * N + i] = c ? s / c : NaN;
    }
  }
  recomputeWf(0, 0, N, N);
  const lakeAt = (x, z) => { // lake/river surface level at (x,z) if any of the 4 surrounding samples is wet (the mesh-cell rule), else null (may be below the terrain there)
    let fx = x * inv - 0.5, fz = z * inv - 0.5;
    fx = fx < 0 ? 0 : fx > N1 ? N1 : fx; fz = fz < 0 ? 0 : fz > N1 ? N1 : fz;
    const i = Math.min(fx | 0, N - 2), j = Math.min(fz | 0, N - 2), tx = fx - i, tz = fz - j, o = j * N + i;
    if (!(wraw[o] | wraw[o + 1] | wraw[o + N] | wraw[o + N + 1])) return null;
    const a = wf[o] + (wf[o + 1] - wf[o]) * tx, b = wf[o + N] + (wf[o + N + 1] - wf[o + N]) * tx;
    return a + (b - a) * tz;
  };
  const waterLevelAt = (x, z) => {
    const h = heightAt(x, z), L = lakeAt(x, z), lake = L !== null && L > h ? L : null;
    const ocean = h < SEA ? SEA : null;
    return lake === null ? ocean : ocean === null ? lake : Math.max(lake, ocean);
  };
  // water SURFACE at (x,z) whether or not the terrain is below it (road auto-bridging compares the road with this): { level, kind } (the ocean plane covers the whole map)
  const waterSurfaceAt = (x, z) => { const L = lakeAt(x, z); return L !== null && L > SEA ? { level: L, kind: 'lake' } : { level: SEA, kind: 'ocean' }; };
  const isUnderwater = (x, z, y) => { const L = waterLevelAt(x, z); return L !== null && y < L; };
  // ---- roads: detect junctions from the raw heights, then stamp flat discs into the height grid BEFORE anything (render mesh,
  //      collider, road meshes) reads it, so heightAt / mesh / collider all agree. Re-runnable (updateRegion). ----
  let roads, junctions, roadAt, roadBoxes, cityList = [], autoInfo = { spans: [], skipped: [] };
  const markerPts = () => markerRaw.map((m) => ({ x: Number.isFinite(m.x) ? m.x : m.nx * W, z: Number.isFinite(m.z) ? m.z : m.nz * W, tags: Array.isArray(m.tags) ? m.tags : [] }));
  const junctionMarkersJson = () => JSON.stringify(markerPts().filter((m) => Object.keys(MARKER_JUNCTION_TAGS).some((t) => m.tags.includes(t))).map((m) => [m.x, m.z, m.tags.filter((t) => t in MARKER_JUNCTION_TAGS)]));
  function prepRoads() {
    Hm.set(Hbase);
    roads = rj.roads.map((r) => makeRoad(r, heightAt));
    junctions = detectJunctions(roads, heightAt, jOverrides, markerPts());
    // bridges over water (roadBridges.js): after junction detection (their footprints are avoided), before the city / junction stamping and every polyOf consumer
    autoInfo = opts.autoBridge === false ? { spans: [], skipped: [] } : planAutoBridges({ roads, junctions, heightAt, waterAt: waterSurfaceAt });
    // city corridors first (flatten carriageway + footpaths to the smoothed original profile), then the junction discs on top of that
    cityList = cityRuns(roads);
    stampCityCorridors(Hm, N, cell, cityList);
    for (const j of junctions) j.y = heightAt(j.x, j.z);
    stampJunctions(Hm, N, cell, junctions);
    for (const j of junctions) { j.y = heightAt(j.x, j.z); }
    roadAt = makeRoadQuery(roads, junctions);
    // metre boxes {x0,z0,x1,z1} around every road / junction: a height edit inside one means the road meshes must be rebuilt
    roadBoxes = roads.map((r) => {
      const P = polyOf(r), pad = r.width + 2 + (r.points.some((p) => p.type === 'city') ? FOOT_SHIFT + 1.5 * cell + CITY.BLEND : 0); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < P.n; i++) { x0 = Math.min(x0, P.x[i]); x1 = Math.max(x1, P.x[i]); z0 = Math.min(z0, P.z[i]); z1 = Math.max(z1, P.z[i]); }
      return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
    }).concat(junctions.map((j) => { const r = j._extent + j._blend + 2; return { x0: j.x - r, z0: j.z - r, x1: j.x + r, z1: j.z + r }; }));
  }
  prepRoads();

  const surfaceAt = (x, z) => {
    let fx = x * inv - 0.5, fz = z * inv - 0.5;
    fx = fx < 0 ? 0 : fx > N1 ? N1 : fx; fz = fz < 0 ? 0 : fz > N1 ? N1 : fz;
    const i = Math.min(fx | 0, N - 2), j = Math.min(fz | 0, N - 2), tx = fx - i, tz = fz - j;
    const o = (j * N + i) * 4, o2 = o + N * 4;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    const weights = new Float32Array(8);
    let classId = 0;
    for (let c = 0; c < 8; c++) {
      const d = c < 4 ? s0 : s1, k = c & 3;
      weights[c] = (d[o + k] * w00 + d[o + 4 + k] * w10 + d[o2 + k] * w01 + d[o2 + 4 + k] * w11) / 255;
    }
    // Road is decided analytically (the splat road class is a blurry gravel halo, not the road): on the road -> pure class 6,
    // off the road -> the strongest NON-road splat class.
    const rs = roadAt.surface(x, z);
    if (rs !== null) { weights.fill(0); weights[6] = 1; return { classId: 6, weights, roadSurface: rs, roughness: roadAt.roughness(x, z, rs), gripMul: SURFACE_PROPS[rs].gripMul }; }
    if (roadAt.footpath(x, z)) { weights.fill(0); weights[7] = 1; return { classId: 7, weights, roadSurface: 'footpath', roughness: 0, gripMul: 1 }; } // city footpath / corner block
    const rw = weights[6]; weights[6] = 0;
    if (rw >= 0.999) weights[0] = 1; // splat said pure road but the road mesh is not here (e.g. roundabout island): call it grass
    else if (rw > 0) { const k = 1 / (1 - rw); for (let c = 0; c < 8; c++) weights[c] *= k; }
    for (let c = 1; c < 8; c++) if (weights[c] > weights[classId]) classId = c;
    return { classId, weights, roadSurface: null, roughness: 0, gripMul: 1 };
  };

  lap('prep');

  // ---- render mesh: chunked, shared material, one shared index buffer per chunk shape ----
  // Vertex grid is (N+2)^2: the N pixel-centre samples plus one vertex on each map edge (same height as the nearest
  // sample, matching the clamped heightAt), so the mesh covers [0,W]^2 and interior vertices sit exactly on samples.
  // ponytail: no LOD; every chunk is full resolution (2048^2 = ~8.4M triangles). Upgrade path: per-chunk stride-2/4
  // index buffers over the same vertices + skirts to hide cracks.
  const colors = mj.classes.map((c) => new THREE.Color(c.color));
  const material = makeTerrainMaterial(THREE, mkSplatTex(THREE, s0, N), mkSplatTex(THREE, s1, N), colors, W);
  const V = N + 2, cells = N + 1;
  const sIdx = new Int32Array(V), xs = new Float32Array(V);
  for (let k = 0; k < V; k++) { sIdx[k] = k < 1 ? 0 : k > N ? N - 1 : k - 1; xs[k] = k === 0 ? 0 : k === N + 1 ? W : (k - 0.5) * cell; }
  const nCh = Math.ceil(cells / chunkSize), cs = Math.ceil(cells / nCh);
  const idxCache = new Map();
  const indexFor = (cw, ch) => {
    const key = cw + 'x' + ch; let a = idxCache.get(key); if (a) return a;
    const vw = cw + 1, ind = new ((cw + 1) * (ch + 1) > 65535 ? Uint32Array : Uint16Array)(cw * ch * 6);
    let p = 0;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const a0 = j * vw + i, b0 = a0 + vw; // (x,z) (x,z+1)
      ind[p++] = a0; ind[p++] = b0; ind[p++] = a0 + 1; // CCW seen from +Y
      ind[p++] = a0 + 1; ind[p++] = b0; ind[p++] = b0 + 1;
    }
    a = new THREE.BufferAttribute(ind, 1); idxCache.set(key, a); return a;
  };
  const terrain = new THREE.Group(); terrain.name = 'terrain';
  const geos = [], chunks = [];
  function fillChunk(c) { // (re)compute positions + normals of one chunk from Hm
    const pos = c.geo.attributes.position.array, nor = c.geo.attributes.normal.array;
    let q = 0;
    for (let vz = 0; vz < c.vh; vz++) {
      const kz = c.z0 + vz, sz = sIdx[kz], sz0 = sz > 0 ? sz - 1 : 0, sz1 = sz < N1 ? sz + 1 : N1, dz = (sz1 - sz0) * cell;
      for (let vx = 0; vx < c.vw; vx++, q += 3) {
        const kx = c.x0 + vx, sx = sIdx[kx], sx0 = sx > 0 ? sx - 1 : 0, sx1 = sx < N1 ? sx + 1 : N1, dx = (sx1 - sx0) * cell;
        pos[q] = xs[kx]; pos[q + 1] = Hm[sz * N + sx]; pos[q + 2] = xs[kz];
        // central differences on the height grid (same samples for neighbouring chunks -> seamless shading)
        const gx = (Hm[sz * N + sx1] - Hm[sz * N + sx0]) / dx, gz = (Hm[sz1 * N + sx] - Hm[sz0 * N + sx]) / dz;
        const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        nor[q] = -gx * il; nor[q + 1] = il; nor[q + 2] = -gz * il;
      }
    }
  }
  for (let cz = 0; cz < nCh; cz++) for (let cx = 0; cx < nCh; cx++) {
    const x0 = cx * cs, z0 = cz * cs, cw = Math.min(cs, cells - x0), ch = Math.min(cs, cells - z0), vw = cw + 1, vh = ch + 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vw * vh * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vw * vh * 3), 3));
    g.setIndex(indexFor(cw, ch));
    const c = { geo: g, x0, z0, cw, ch, vw, vh };
    fillChunk(c);
    g.computeBoundingBox(); g.computeBoundingSphere();
    geos.push(g); chunks.push(c);
    const m = new THREE.Mesh(g, material); m.name = `chunk_${cx}_${cz}`; m.matrixAutoUpdate = false; // frustum culled by default
    terrain.add(m);
  }
  // recompute the chunks whose vertices read samples in the pixel rect [x0,x1)x[y0,y1) (vertex k reads samples k-2..k)
  function updateTerrain(x0, y0, x1, y1) {
    const kx0 = Math.max(0, x0 - 1), kx1 = Math.min(N + 1, x1 + 2), kz0 = Math.max(0, y0 - 1), kz1 = Math.min(N + 1, y1 + 2);
    let n = 0;
    for (const c of chunks) {
      if (c.x0 > kx1 || c.x0 + c.cw < kx0 || c.z0 > kz1 || c.z0 + c.ch < kz0) continue;
      fillChunk(c); c.geo.attributes.position.needsUpdate = true; c.geo.attributes.normal.needsUpdate = true;
      c.geo.computeBoundingBox(); c.geo.computeBoundingSphere(); n++;
    }
    return n;
  }
  lap('terrainMesh');

  // ---- water: lakes/rivers (CPU mesh from wet cells) + ocean plane, same material ----
  const waterMat = makeWaterMaterial(THREE);
  const group = new THREE.Group(); group.name = 'map';
  group.add(terrain);
  let lakes = null;
  function buildLakes() { // rebuilds the whole lake mesh from wraw/wf (cheap enough for lakes; see ponytail below)
    let nv = 0, nc = 0;
    const remap = new Int32Array(N * N).fill(-1);
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const o = j * N + i;
      if (!(wraw[o] | wraw[o + 1] | wraw[o + N] | wraw[o + N + 1])) continue;
      nc++;
      for (const k of [o, o + 1, o + N, o + N + 1]) if (remap[k] < 0) remap[k] = nv++;
    }
    const wasVisible = lakes ? lakes.visible : true;
    if (lakes) { lakes.removeFromParent(); lakes.geometry.dispose(); lakes = null; }
    if (!nc) return;
    // ponytail: one un-chunked mesh; fine for lakes, a map that is mostly rivers would want per-chunk water meshes.
    const wpos = new Float32Array(nv * 3), wind = new (nv > 65535 ? Uint32Array : Uint16Array)(nc * 6);
    for (let k = 0; k < N * N; k++) if (remap[k] >= 0) {
      const r = remap[k] * 3; wpos[r] = ((k % N) + 0.5) * cell; wpos[r + 1] = wf[k]; wpos[r + 2] = (((k / N) | 0) + 0.5) * cell;
    }
    let p = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const o = j * N + i;
      if (!(wraw[o] | wraw[o + 1] | wraw[o + N] | wraw[o + N + 1])) continue;
      const a = remap[o], b = remap[o + N], c = remap[o + 1], d = remap[o + N + 1];
      wind[p++] = a; wind[p++] = b; wind[p++] = c; wind[p++] = c; wind[p++] = b; wind[p++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    g.setIndex(new THREE.BufferAttribute(wind, 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    lakes = new THREE.Mesh(g, waterMat); lakes.name = 'lakes'; lakes.renderOrder = 1; lakes.matrixAutoUpdate = false; lakes.visible = wasVisible;
    group.add(lakes);
  }
  buildLakes();
  const oceanGeo = new THREE.PlaneGeometry(W * 40, W * 40); oceanGeo.rotateX(-Math.PI / 2);
  const ocean = new THREE.Mesh(oceanGeo, waterMat); ocean.name = 'ocean'; ocean.renderOrder = 1;
  ocean.position.set(W / 2, SEA, W / 2); // ponytail: flat plane (shader ripples only); no depth fade or shoreline foam
  ocean.frustumCulled = false;
  ocean.onBeforeRender = () => { waterMat.userData.time.value = performance.now() / 1000; };
  group.add(ocean); geos.push(oceanGeo);
  lap('water');

  // ---- physics: Rapier heightfield from a downsampled copy (R samples per side, vertices span [0,W] edge to edge) ----
  let physics = null;
  if (physicsWorld) {
    need(RAPIER, 'options.RAPIER is required when physicsWorld is given');
    const R = Math.max(2, Math.min(Math.floor(physicsResolution), 4096));
    // Rapier: nrows/ncols = CELL counts, heights has (nrows+1)*(ncols+1) entries, column-major (heights[col*(nrows+1)+row]),
    // col runs along local +X, row along local +Z; `scale` is the extent of the whole field and it is centred on its
    // origin, so translate by (W/2,0,W/2). Orientation verified numerically by checkCollider().
    const heights = new Float32Array(R * R), step = W / (R - 1);
    for (let col = 0; col < R; col++) for (let row = 0; row < R; row++) heights[col * R + row] = heightAt(col * step, row * step);
    const desc = RAPIER.ColliderDesc.heightfield(R - 1, R - 1, heights, { x: W, y: 1, z: W })
      .setTranslation(W / 2, 0, W / 2).setFriction(1.0);
    const collider = physicsWorld.createCollider(desc);
    physics = { collider, resolution: R, heights /* heights[ix*R+iz] at x=ix*W/(R-1), z=iz*W/(R-1) */ };
  }
  lap('physics');

  // ---- road meshes, bridges (with deck colliders), junctions, roundabouts (rebuilt by updateRegion when needed) ----
  let roadsBuilt = null;
  function buildRoadMeshes() {
    const old = roadsBuilt;
    roadsBuilt = buildRoads({ THREE, RAPIER, physicsWorld, roads, junctions, heightAt, driveSide: mapMeta.driveSide, signStyle: mapMeta.signStyle });
    if (old) {
      roadsBuilt.group.visible = old.group.visible; roadsBuilt.edgesGroup.visible = old.edgesGroup.visible; roadsBuilt.propsGroup.visible = old.propsGroup.visible; roadsBuilt.signsGroup.visible = old.signsGroup.visible;
      old.group.removeFromParent(); old.dispose(physicsWorld);
    }
    group.add(roadsBuilt.group);
    map.parts.roadMesh = roadsBuilt.roadMesh; map.parts.roadGroup = roadsBuilt.group;
    map.parts.roadEdges = roadsBuilt.edgesGroup; map.parts.roadProps = roadsBuilt.propsGroup; map.parts.roadSigns = roadsBuilt.signsGroup; map.roadDetail = roadsBuilt.detail; roadsBuilt.detail.autoBridges = autoInfo.spans; roadsBuilt.detail.autoBridgeSkipped = autoInfo.skipped; roadsBuilt.detail.counts.autoBridges = autoInfo.spans.length;
    roadAt.setFootprints(roadsBuilt.footprints); roadsBuilt.setTime(signalTime); map.junctions = publicJunctions(); // signals[] exists only after the build
  }
  const publicJunctions = () => junctions.map((j) => ({ x: j.x, z: j.z, y: j.y, style: j.style, radius: j.radius, arms: j.arms, source: j.source, signals: j._signals || [] }));
  let disposed = false, timer = null, pendingRoads = false, signalTime = 0;
  const map = {
    group, heightAt, normalAt, surfaceAt, waterLevelAt, isUnderwater, roads, junctions: publicJunctions(),
    info: {
      worldSize: W, maxHeight: MAXH, seaLevel: SEA, seaLevelNormalized: mj.seaLevel, N, cellSize: cell,
      classes: mj.classes, chunks: nCh * nCh, chunkCells: cs, loadMs: T, driveSide: mapMeta.driveSide, signStyle: mapMeta.signStyle,
    },
    roadDetail: null,
    SURFACE_FRICTION,
    parts: { terrain, lakes, ocean, material, waterMaterial: waterMat, roadMesh: null, roadGroup: null },
    physics,
    markers: [], getMarkers, markerByName,
    updateRegion, flush, setSeaLevel,
    update(dt) { signalTime += dt; if (roadsBuilt) roadsBuilt.setTime(signalTime); }, // signal lights clock (seconds), call once per frame
    signalState: (group) => signalState(group, signalTime),
    dispose() {
      if (disposed) return; disposed = true; clearTimeout(timer);
      if (physics && physicsWorld) physicsWorld.removeCollider(physics.collider, false);
      roadsBuilt.dispose(physicsWorld);
      for (const g of geos) g.dispose();
      if (lakes) lakes.geometry.dispose();
      material.userData.uniforms.uSplat0.value.dispose(); material.userData.uniforms.uSplat1.value.dispose();
      material.dispose(); waterMat.dispose();
      group.removeFromParent(); group.clear();
    },
  };
  buildRoadMeshes();
  // ---- markers: y is always derived from OUR ground (after junction stamping) + yOffset ----
  function buildMarkers() {
    map.markers = markerRaw.map((m) => {
      const x = Number.isFinite(m.x) ? m.x : m.nx * W, z = Number.isFinite(m.z) ? m.z : m.nz * W, yOffset = Number(m.yOffset) || 0;
      return { id: m.id, name: m.name || '', tags: Array.isArray(m.tags) ? m.tags.slice() : [], color: m.color || '#ff3b30', x, z, nx: x / W, nz: z / W,
        yOffset, y: heightAt(x, z) + yOffset, yaw: Number(m.yaw) || 0, radius: Number(m.radius) || 0, props: { ...(m.props || {}) } };
    });
  }
  function refreshMarkerHeights() { for (const m of map.markers) m.y = heightAt(m.x, m.z) + m.yOffset; }
  function getMarkers({ tag, name } = {}) { return map.markers.filter((m) => (tag === undefined || m.tags.includes(tag)) && (name === undefined || m.name === name)); }
  function markerByName(name) { return map.markers.find((m) => m.name === name) || null; }
  buildMarkers();
  lap('roads');
  T.total = performance.now() - T.start; delete T._last; delete T.start;

  // ---------------------------------------------------------------------------------------------
  // live editing
  // ---------------------------------------------------------------------------------------------
  function copyRows(dst, src, x0, y0, x1, y1, stride) { // copy the rect, return true if anything differed
    let changed = false;
    for (let y = y0; y < y1; y++) {
      const a = (y * N + x0) * stride, b = (y * N + x1) * stride;
      if (!changed) for (let i = a; i < b; i++) if (dst[i] !== src[i]) { changed = true; break; }
      dst.set(src.subarray(a, b), a);
    }
    return changed;
  }
  function setSeaLevel(m) {
    SEA = m; ocean.position.y = m; map.info.seaLevel = m; map.info.seaLevelNormalized = m / MAXH;
    pendingRoads = true; clearTimeout(timer); timer = setTimeout(runRoads, 300); if (timer && timer.unref) timer.unref(); // the ocean decides which road stretches are bridged
  }
  function runRoads() { // the debounced part: re-detect junctions, restamp, refresh the terrain under old+new stamps, rebuild meshes
    clearTimeout(timer); timer = null; if (!pendingRoads || disposed) return; pendingRoads = false;
    // terrain to refresh = old + new junction stamps and city corridors (a flooded city road is no longer flattened); city runs as [cx, cz, radius] circles
    const stamped = () => junctions.map((j) => [j.x, j.z, j._extent + j._blend + 2]).concat(cityList.map((r) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < r.n; i++) { x0 = Math.min(x0, r.x[i]); x1 = Math.max(x1, r.x[i]); z0 = Math.min(z0, r.z[i]); z1 = Math.max(z1, r.z[i]); }
      return [(x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + r.hw + FOOT_SHIFT + CITY.BLEND + 2 * cell];
    }));
    const oldJ = stamped();
    prepRoads();
    const newJ = stamped();
    let x0 = N, y0 = N, x1 = 0, y1 = 0;
    for (const [x, z, r] of oldJ.concat(newJ)) {
      x0 = Math.min(x0, Math.floor((x - r) / cell)); x1 = Math.max(x1, Math.ceil((x + r) / cell));
      y0 = Math.min(y0, Math.floor((z - r) / cell)); y1 = Math.max(y1, Math.ceil((z + r) / cell));
    }
    if (x1 > x0) updateTerrain(Math.max(0, x0), Math.max(0, y0), Math.min(N, x1), Math.min(N, y1));
    map.roads = roads; map.junctions = publicJunctions();
    buildRoadMeshes(); refreshMarkerHeights();
    if (map.onRebuild) map.onRebuild(); // optional hook (editor preview): fired after the debounced road/junction rebuild
  }
  function flush() { runRoads(); }
  function updateRegion(rect, d = {}) {
    if (disposed) return null;
    const x0 = Math.max(0, Math.floor(rect.x0)), y0 = Math.max(0, Math.floor(rect.y0)), x1 = Math.min(N, Math.ceil(rect.x1)), y1 = Math.min(N, Math.ceil(rect.y1));
    const has = x1 > x0 && y1 > y0, res = { height: false, splat: false, water: false, roads: false, markers: false };
    if (has && d.height) {
      need(d.height instanceof Uint16Array && d.height.length === N * N, 'updateRegion: height must be a Uint16Array of N*N');
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { // heights in metres; compare to the old base to skip no-ops
        const i = y * N + x, v = Math.fround(d.height[i] * hk); if (Hbase[i] !== v) { Hbase[i] = v; res.height = true; }
      }
    }
    if (has && d.splat) {
      const [a, b] = Array.isArray(d.splat) ? d.splat : [d.splat.splat0, d.splat.splat1];
      need(a && b && a.length === N * N * 4 && b.length === N * N * 4, 'updateRegion: splat must be two Uint8Arrays of N*N*4');
      const ca = copyRows(s0, a, x0, y0, x1, y1, 4), cb = copyRows(s1, b, x0, y0, x1, y1, 4);
      if (ca || cb) { res.splat = true; material.userData.uniforms.uSplat0.value.needsUpdate = true; material.userData.uniforms.uSplat1.value.needsUpdate = true; }
    }
    if (has && d.water) {
      need(d.water instanceof Uint16Array && d.water.length === N * N, 'updateRegion: water must be a Uint16Array of N*N');
      if (copyRows(wraw, d.water, x0, y0, x1, y1, 1)) {
        res.water = true; recomputeWf(x0, y0, x1, y1); buildLakes(); map.parts.lakes = lakes;
        const e = 1.5 * cell; // flooding / draining next to a road changes its auto bridges (wf is smoothed over 1 px)
        if (roadBoxes.some((b) => b.x0 < x1 * cell + e && b.x1 > x0 * cell - e && b.z0 < y1 * cell + e && b.z1 > y0 * cell - e)) res.roads = true;
      }
    }
    if (d.roads) {
      const j = JSON.stringify(d.roads);
      if (j !== roadsJson) { validateRoads(need, d.roads); roadsJson = j; rj = d.roads; res.roads = true; }
    }
    if (d.markers) {
      const j = JSON.stringify(markerList(d.markers));
      if (j !== markersJson) {
        const before = junctionMarkersJson(); markersJson = j; markerRaw = markerList(d.markers); res.markers = true; buildMarkers();
        if (junctionMarkersJson() !== before) res.roads = true; // roundabout / signals / junction_plain markers change the junction styles
      }
    }
    if (res.height) {
      for (let y = y0; y < y1; y++) Hm.set(Hbase.subarray(y * N + x0, y * N + x1), y * N + x0);
      stampCityCorridors(Hm, N, cell, cityList, { x0, y0, x1, y1 });
      stampJunctions(Hm, N, cell, junctions, { x0, y0, x1, y1 }); // restricted to the rect: same result as a full restamp there
      updateTerrain(x0, y0, x1, y1); refreshMarkerHeights();
      const mx0 = x0 * cell, mx1 = x1 * cell, mz0 = y0 * cell, mz1 = y1 * cell;
      if (roadBoxes.some((b) => b.x0 < mx1 && b.x1 > mx0 && b.z0 < mz1 && b.z1 > mz0)) res.roads = true;
    }
    if (res.roads) { pendingRoads = true; clearTimeout(timer); timer = setTimeout(runRoads, 300); if (timer && timer.unref) timer.unref(); }
    return res;
  }
  return map;
}

function mkSplatTex(THREE, data, N) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace; // weights are data, never sRGB
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------------------------------------
// Orientation check for the physics heightfield: cast `count` vertical rays at pseudo-random points and compare the
// hit height against map.heightAt. Returns { n, misses, maxErr, meanErr }. Errors are expected to be on the order of
// the collider's interpolation error (terrain roughness at W/(resolution-1) metre spacing), NOT zero.
// ------------------------------------------------------------------------------------------------
export function checkCollider(map, RAPIER, physicsWorld, count = 256) {
  let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const { worldSize: W, maxHeight } = map.info, top = maxHeight + 50;
  let n = 0, misses = 0, maxErr = 0, sum = 0, worst = null;
  for (let i = 0; i < count; i++) {
    const x = 1 + rnd() * (W - 2), z = 1 + rnd() * (W - 2);
    const hit = physicsWorld.castRay(new RAPIER.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), top + 50, true);
    if (!hit) { misses++; continue; }
    const err = Math.abs(top - hit.timeOfImpact - map.heightAt(x, z));
    n++; sum += err; if (err > maxErr) { maxErr = err; worst = { x, z }; }
  }
  return { n, misses, maxErr, meanErr: n ? sum / n : NaN, worst };
}
