// Road node metadata: the enums, defaults and parser shared by the editor (export side) and the loader (import side).
// Pure data, no imports. Data model is documented in editor.html (export format) and at the top of mapLoader.js.
//
// A road control point carries x,z,y,bridge plus these OPTIONAL fields (a missing field = its default; the editor only writes
// a field when it differs from the default, so old files stay byte-identical):
//   type     country | city | highway          segment attribute (this point -> next point)
//   oneway   boolean                           segment attribute; direction = point order, first to last
//   edgeL    none | fence | guardrail | barrier | lamps      segment attribute, LEFT edge looking forward along the point order
//   edgeR    same, RIGHT edge (left = lateral -, right = lateral +, where lateral + = (-tz, tx) for travel direction (tx,tz) in x,z)
//   surface  smooth | worn | potholes | gravel segment attribute
//   signs    auto | off                        segment attribute: 'off' suppresses the automatic warning signs
//   features string[] from crosswalk | bump | rumble | roadworks      applies AT the point itself
// Attributes of the LAST point's segment are ignored (there is no next point).
// Map level (map.json, optional): driveSide 'right'|'left' (default right), signStyle 'us'|'eu' (default us).
export const ROAD_TYPES = Object.freeze(['country', 'city', 'highway']);
export const EDGE_TYPES = Object.freeze(['none', 'fence', 'guardrail', 'barrier', 'lamps']);
export const SURFACES = Object.freeze(['smooth', 'worn', 'potholes', 'gravel']);
export const FEATURES = Object.freeze(['crosswalk', 'bump', 'rumble', 'roadworks']);
export const SIGN_MODES = Object.freeze(['auto', 'off']);
export const DRIVE_SIDES = Object.freeze(['right', 'left']);
export const SIGN_STYLES = Object.freeze(['us', 'eu']);

// Self-meetings: a road that crosses / touches / loops back onto ITSELF makes junctions too. Two parts of one road only count when their arc-length
// separation is at least SELF_JUNCTION.SEP_WIDTHS * width + SEP_M metres (excludes neighbours on tight curves), and crossings / T-contacts whose acute
// angle is below MIN_ANGLE_DEG degrees (hairpin legs lying nearly on top of each other) are ignored. An endpoint join (loop closing, last node on first) has no angle limit.
export const SELF_JUNCTION = Object.freeze({ SEP_WIDTHS: 3, SEP_M: 10, MIN_ANGLE_DEG: 25 });
export const JUNCTION_STYLES = Object.freeze(['junction', 'roundabout', 'signals', 'none']); // junctions.json 'style' values (+ map.junctions[i].style: all but 'none')
// marker tag -> junction style forced by a marker within 15 m of a detected junction (junctions.json beats markers beats the defaults)
export const MARKER_JUNCTION_TAGS = Object.freeze({ roundabout: 'roundabout', signals: 'signals', junction_plain: 'junction' });

// City road type: kerb + footpath on both sides (metres). The footpath is KERB_W (kerb stone band) + FOOT_W wide, FOOT_SHIFT in total, and its top is
// KERB_H above the road surface. Edge items (lamps etc.) on city segments stand FOOT_SHIFT further out. TAPER = length of the ramp that ends a footpath.
export const CITY = Object.freeze({ KERB_H: 0.15, KERB_W: 0.15, FOOT_W: 2.5, TAPER: 1.2, BLEND: 3, CROSS_HALF: 1.9 });
export const FOOT_SHIFT = CITY.KERB_W + CITY.FOOT_W;

// Highway road type: hard shoulder SHOULDER_W each side, central barrier half width MEDIAN_HALF (two-way only), lanes ~LANE_W wide.
// highwayLanes() is mirrored in the road shader (roads.js): keep both in sync.
export const HIGHWAY = Object.freeze({ LANE_W: 3.6, SHOULDER_W: 2.5, MEDIAN_HALF: 0.3, MEDIAN_SHY: 0.4 });
export function highwayLanes(hw, oneway) { // lanes PER DIRECTION (two-way) or in total (one-way), lane width, lateral offset of the first lane line from the centre
  const m0 = oneway ? 0 : HIGHWAY.MEDIAN_HALF + HIGHWAY.MEDIAN_SHY, usable = oneway ? 2 * (hw - HIGHWAY.SHOULDER_W) : hw - HIGHWAY.SHOULDER_W - m0;
  const lanes = Math.max(1, Math.floor(usable / HIGHWAY.LANE_W + 0.5));
  return { lanes, laneW: usable / lanes, m0 };
}

export const NODE_DEFAULTS = Object.freeze({ type: 'country', oneway: false, edgeL: 'none', edgeR: 'none', surface: 'smooth', signs: 'auto' });
export const MAP_DEFAULTS = Object.freeze({ driveSide: 'right', signStyle: 'us' });

// Driving data per surface (surfaceAt().roughness 0 smooth..1 very rough, gripMul multiplies tyre grip).
export const SURFACE_PROPS = Object.freeze({
  smooth: { roughness: 0, gripMul: 1 },
  worn: { roughness: 0.2, gripMul: 0.95 },
  potholes: { roughness: 0.6, gripMul: 0.9 },
  gravel: { roughness: 0.5, gripMul: 0.7 },
});
export const RUMBLE_ROUGHNESS = 0.45; // roughness inside a rumble-strip zone (max()-ed with the surface roughness)

const pick = (v, list, d) => (list.includes(v) ? v : d);

// raw control point (any subset of the optional fields) -> the full, validated set of node attributes.
// Unknown values fall back to the default (lenient on purpose: a newer editor must not break an older loader).
export function parseNodeMeta(p) {
  const f = Array.isArray(p.features) ? FEATURES.filter((k) => p.features.includes(k)) : [];
  return {
    type: pick(p.type, ROAD_TYPES, NODE_DEFAULTS.type), oneway: p.oneway === true,
    edgeL: pick(p.edgeL, EDGE_TYPES, 'none'), edgeR: pick(p.edgeR, EDGE_TYPES, 'none'),
    surface: pick(p.surface, SURFACES, 'smooth'), signs: pick(p.signs, SIGN_MODES, 'auto'), features: f,
  };
}
export function parseMapMeta(mj) {
  return { driveSide: pick(mj.driveSide, DRIVE_SIDES, 'right'), signStyle: pick(mj.signStyle, SIGN_STYLES, 'us') };
}
