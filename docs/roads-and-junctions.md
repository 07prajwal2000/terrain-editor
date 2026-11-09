# Roads and junctions

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

The road model lives in `src/world/roads.js` with helpers in `roadMeta.js`,
`roadEdges.js`, `roadSigns.js`, `roadCity.js`, `roadSignals.js` and
`roadBridges.js`. This page is the semantics behind the fields documented in
[file-formats.md](file-formats.md).

## Contents

- [Node metadata](#node-metadata)
- [Bridges](#bridges)
- [Automatic bridges over water](#automatic-bridges-over-water)
- [Junction detection](#junction-detection)
- [Junction styles](#junction-styles)
- [Junction geometry and stamping](#junction-geometry-and-stamping)
- [Warning signs](#warning-signs)
- [City roads](#city-roads)
- [Highway roads](#highway-roads)
- [Edges and point features](#edges-and-point-features)
- [Signal cycle](#signal-cycle)
- [Test maps](#test-maps)

## Node metadata

Each control point carries `x, z, y, bridge` plus optional metadata. A missing
field means its default. Fields are written only when they differ from the
default, so old files stay byte-identical.

| Field | Values | Default | Scope | Renders as | Collider |
|---|---|---|---|---|---|
| `type` | `country`, `city`, `highway` | `country` | segment | shader look; city kerbs/footpaths; highway lanes/median | footpath prisms and median yes |
| `oneway` | boolean | `false` | segment | no centre line, arrows every ~40 m; no reverse signs | no |
| `edgeL` | `none`, `fence`, `guardrail`, `barrier`, `lamps` | `none` | segment | left edge objects looking forward | yes |
| `edgeR` | same | `none` | segment | right edge objects | yes |
| `surface` | `smooth`, `worn`, `potholes`, `gravel` | `smooth` | segment | shader look; `surfaceAt` roughness/grip | no |
| `signs` | `auto`, `off` | `auto` | segment | automatic warning signs | post cylinders |
| `features` | `crosswalk`, `bump`, `rumble`, `roadworks` | `[]` | **point** | zebra/bump/rumble/roadworks | bump and board yes, rumble/cones no |
| `bridge` | boolean | `false` | segment | elevated deck, dashed in the editor | deck trimesh |

"Segment" means the field applies from this point to the **next** point. The
last point's segment attributes are ignored. "Point" features apply at the point
itself. The loader validates values leniently: an unknown value falls back to the
default, so a newer editor cannot break an older loader.

Sides are defined looking forward along the point order: `edgeL` is lateral
negative, `edgeR` is lateral positive.

Surfaces change driving data, not just looks:

| Surface | Roughness | gripMul |
|---|---|---|
| smooth | 0 | 1.0 |
| worn | 0.2 | 0.95 |
| potholes | 0.6 | 0.9 |
| gravel | 0.5 | 0.7 |

Potholes are not geometry. Rumble strips raise roughness to 0.45 inside their
zone. On a city footpath `surfaceAt` returns class 7, `roadSurface: 'footpath'`,
roughness 0 and grip 1.

## Bridges

`bridge: true` on a point means the segment from that point to the next is a
bridge. The loader does not bake that span into the terrain; it draws a deck
slab, rails and pillars and adds a trimesh collider for the deck. The deck height
interpolates the two control-point `y` values, so the editor's exported `y` is
authoritative here (on normal segments the loader recomputes `y` from the
terrain).

Everything that needs dry ground skips bridge samples: no edge objects, lamps,
features, warning signs, city footpaths or terrain corridor stamping, and
`surfaceAt` does not report road there. Bridge rails and pillars have no
colliders; the deck does.

## Automatic bridges over water

Automatic bridging is implemented (`src/world/roadBridges.js`) and on by default
(`autoBridge: true`). A non-bridge road stretch is turned into a bridge when its
centreline or either edge is below the water surface plus a tolerance.

Constants (`AUTO_BRIDGE` in `roadBridges.js`):

| Constant | Value | Meaning |
|---|---|---|
| `CLEARANCE` | 1.5 m | deck sits at `max(road y, water + 1.5)` |
| `TOL` | 0.3 m | a stretch is wet when terrain `< water + 0.3` |
| `MIN_WET_M` | 4 m | shorter wet runs are ignored |
| `DEEP` | 0.5 m | ...unless the terrain is more than 0.5 m under water |
| `MERGE_M` | 20 m | wet runs closer than 20 m merge into one span |
| `RAMP_GRADE` | 0.07 | approach ramps are at most 7% grade |
| `BLUR_M` | 4 m | half-window of the vertical deck smoothing |
| `REACH_M` | 40 m | dry crest search distance for ramp ends |
| `PAD` | 0.2 m | extra target height so smoothing never dips under clearance |
| `MAX_GRADE` | 0.08 | declared but unused; the real cap is `RAMP_GRADE` |

Rules:

- Wet runs are detected from the road samples, then the wet stretches and their
  ramp ends are merged into a single span.
- Both ramp ends finish exactly at the dry road height; a 4 m box blur gives a
  smooth vertical curve.
- The resulting span is an ordinary bridge: deck, rails, pillars and a Rapier
  trimesh, with **no** edges, lamps, features, signs, footpaths, corridor
  stamping, or `surfaceAt` road result.
- An editor-marked bridge that is too low over water keeps its `bridge` flag and
  has its deck raised to `water + 1.5`. It is never un-bridged.
- A span whose ramp footprint reaches a junction (`extent + blend`) is **not**
  bridged; the road stays on the terrain and the skipped span is reported.
- `updateRegion`, `setSeaLevel` and `flush` all re-run the plan; the bridge tests
  compare live edits with a full rebuild.

Outputs:

```js
map.roadDetail.autoBridges = [
  { roadId, s0, s1, deckY0, deckY1, maxY,
    reason: 'lake' | 'ocean', raised,
    x0, z0, x1, z1 }
];
map.roadDetail.autoBridgeSkipped = [ { roadId, reason: 'junction', ... } ];
map.roadDetail.counts.autoBridges;
road.autoBridges;            // per road
sample.bridge === true && sample.auto === true;
```

`s0`, `s1` are arc length in metres along `getPoints(1)`.

## Junction detection

`detectJunctions(roads, heightAt, overrides, markers)` runs after roads are
built and before terrain stamping.

1. **Crossings** between two roads: segment/segment intersections with a 32 m
   spatial hash.
2. **Overpass exclusion**: no junction when either road is a bridge there, or the
   two heights differ by more than **4 m**.
3. **Self-meetings** of one road:
   - arc-length separation must be at least `SELF_JUNCTION.SEP_WIDTHS * width + SEP_M`
     = `3 * width + 10 m`;
   - crossings whose acute angle is below `MIN_ANGLE_DEG = 25°` are ignored
     (hairpin legs lying on each other);
   - the same bridge / 4 m rule applies.
4. **Endpoints**: a road end within `max(widthA, widthB)` of another centreline
   makes a T, Y or L junction. Two coincident endpoints make a join.
5. **Clustering**: events closer than `max(w_i, w_j)` merge into one junction.
6. **Arms**: every separate pass of any road within `max(1.5 * width, 6) m` of
   the centre contributes one or two arms. Fewer than two arms discards the
   junction.

The detection is exercised by `scripts/test-city.mjs`, including figure-eights,
lollipops, closed loops, hairpins, tight curves and self-crossing bridges.

## Junction styles

Precedence is **`junctions.json` > markers > defaults**.

Defaults:

```js
let style = arms.length >= 4 ? 'roundabout' : 'junction';
if (arms.some(a => a.type === 'highway')) style = 'junction';       // checked first
else if (arms.length >= 3 && arms.some(a => a.type === 'city')) style = 'signals';
```

- 2–3 arms: plain junction patch.
- 4+ arms or a crossing: roundabout.
- Any highway arm: plain junction, never a roundabout or signals.
- 3+ arms with at least one city arm: signals, never a roundabout.

Marker overrides: a marker within **15 m** of the detected junction forces a
style using its tags. If several qualify, the nearest wins.

| Marker tag | Style |
|---|---|
| `roundabout` | roundabout |
| `signals` | signals |
| `junction_plain` | plain junction patch |

`junctions.json` is checked after markers and wins. It matches the nearest
detected junction within 15 m. `style: "none"` removes the junction entirely.
`radius` overrides the roundabout outer radius (min 12 m) or the patch radius
(min 10 m).

`map.junctions[i].source` is `'default'`, `'marker'` or `'json'`.

**Mask cap**: the shader that clears road markings inside a junction patch takes
the first **32** junctions only. Junction 33 and beyond keep their geometry but
retain their centre dashes through the patch.

## Junction geometry and stamping

| Style | Geometry | Colliders |
|---|---|---|
| `junction` | asphalt patch polygon with fillets between arms, stop line and painted crosswalk | none (terrain heightfield is the ground) |
| `roundabout` | ring ribbon, trimmed approach ribbons, kerbed grass island | island cylinder |
| `signals` | patch + signal posts, stop lines, one zebra per arm, pedestrian railings on city arms | posts and railings; patch none |

Sizes:

- Roundabout outer radius `Ro = max(12, override || 2 * maxWidth)`; ring width
  `min(maxWidth, Ro - 4)`.
- Patch length `L = max(10, override || 1.2 * maxWidth + 2)`.
- Blend band `max(12, 1.5 * maxWidth)`.

Terrain stamping flattens a disc to the junction's `y` inside its extent and
smoothstep-blends outward. City corridors are stamped first, junctions on top.
The render mesh, the Rapier heightfield and `heightAt` all read the stamped grid,
which is why they agree to a few millimetres in the tests.

## Warning signs

Configuration (`SIGN_CFG` in `roadSigns.js`):

| Constant | Value |
|---|---|
| `CURVE_RATE_DEG_PER_M` | 0.3 |
| `CURVE_WINDOW_M` | 90 |
| `CURVE_MIN_DEG` | 25 |
| `CURVE_MERGE_GAP_M` | 20 |
| `SHARP_DEG` | 70 |
| `SHARP_RADIUS_M` | 30 |
| `SBEND_GAP_M` | 120 |
| `HILL_MIN_GRADE` | 0.09 (9%) |
| `HILL_MIN_LEN_M` | 60 m |
| `SIGN_BEFORE_M` | 55 m |
| `SLIDE_BACK_M` | 15 m |
| `MIN_SPACING_M` | 40 m |
| `SHOULDER_OFFSET` | 0.7 m |
| `EDGE_OFFSET` | fence 0.6, guardrail 0.6, barrier 0.55, lamps 0.9 |
| `EDGE_CLEARANCE` | 0.9 m |

Detection works per road and per travel direction: heading rate over ±5 m,
curves of at least 25° within 90 m, sharp curves at 70° or radius under 30 m,
S-bends collapsed into one `winding` sign, and hills of at least 9% over 60 m
(the grade is printed on a plate). Signs are placed about 55 m before the
trigger, may slide back 15 m, and keep 40 m spacing.

Signs are **country-only**. They are suppressed on bridges, inside junction
discs, on segments with `signs: "off"`, and in the reverse direction of a
one-way. The sign stands on the driver's side (`driveSide` from `map.json`) and
faces oncoming traffic.

Styles:

| `signStyle` | Look |
|---|---|
| `us` (default) | yellow diamond, black inner outline |
| `eu` | white triangle with red border |

Sign types produced: `curveL`, `curveR`, `sharpL`, `sharpR`, `winding`,
`hillUp`, `hillDown`. Roadworks boards add a `roadworks` sign 25 m upstream.

## City roads

Constants (`CITY` in `roadMeta.js`):

| Constant | Value |
|---|---|
| `KERB_H` | 0.15 m |
| `KERB_W` | 0.15 m |
| `FOOT_W` | 2.5 m |
| `TAPER` | 1.2 m |
| `BLEND` | 3 m |
| `CROSS_HALF` | 1.9 m |
| `FOOT_SHIFT` | 2.65 m (`KERB_W + FOOT_W`) |

- Maximal city, non-bridge stretches become corridors. The profile is the road
  height smoothed by a two-pass 8 m box filter, then the terrain is flattened
  across `halfWidth + FOOT_SHIFT + 1.5 * cell` with a 3 m smoothstep blend.
- Each side gets a kerb band and a 2.5 m footpath, with a 1.2 m end ramp.
  Footpath tops sit at `heightAt + max(kerbHeight, 0.012)`, so mesh and collider
  agree. Dropped kerbs at crossings keep a 12 mm flush lip.
- Footpaths are solid prisms in 6 m pieces where the kerb is above 3 cm, reaching
  0.35 m down. Merged into one draw call.
- Corner blocks fill the corner between two city arms, with their own prism
  collider.
- Crosswalks: a `crosswalk` feature draws a 3 m zebra and two pedestrian signs
  and drops the kerb. A signals junction adds one zebra per arm.
- Edge items on city segments stand `FOOT_SHIFT` further out, just outside the
  footpath. For a 10 m road, lamps sit 8.55 m from the centreline.
- `surfaceAt` on any footpath or corner block returns class 7.

## Highway roads

Constants (`HIGHWAY`): lane width 3.6 m, shoulder 2.5 m, median half-width 0.3 m,
median shy 0.4 m.

- Lane count: two-way `max(1, floor((width - shoulder - 0.7) / 3.6 + 0.5))` per
  direction; one-way measures both directions from the centre.
- A two-way highway gets a jersey-barrier median with cuboid colliders. One-way
  highways do not.
- Highway intersections are always plain junction patches.
- Highway asphalt is darker and smoother than country or city asphalt.

## Edges and point features

Edge objects (`roadEdges.js`):

| Edge | Spacing | Height | Collider |
|---|---|---|---|
| `fence` | 2.5 m | 1.05 m | cuboid chord every ~6 m |
| `guardrail` | 2.0 m | 0.78 m | cuboid chord every ~6 m |
| `barrier` | 3.0 m | 0.8 m | cuboid chord every ~6 m |
| `median` | 3.0 m | 0.8 m | cuboid chord every ~6 m |
| `lamps` | 35 m | 7.5 m, 2.2 m arm | cylinder radius 0.12 |

Edge pieces stop inside junctions (+3 m), on bridges, and where another road is
within `halfWidth + 3 m`.

Point features:

| Feature | Geometry | Collider |
|---|---|---|
| `bump` | cosine hump, 0.10 m high, 1.5 m long, yellow/black | trimesh |
| `rumble` | 8 grey strips, 0.35 m, pitch 0.9 m, 35 mm high | none (roughness 0.45) |
| `roadworks` | red/white board on two legs + 5-cone taper + 2 cones + upstream sign | board only |
| `crosswalk` | zebra + two pedestrian signs (city also drops the kerb) | none |

## Signal cycle

```js
SIGNAL_CYCLE = { green: 9, amber: 2, period: 24, shift: 12 };
```

Group 1 is shifted by half a cycle, giving 13 s red, 9 s green, 2 s amber and a
1 s all-red between phases. Phase groups alternate per road (per pass on a
self-meeting road). `map.signalState(0 | 1)` reads the current phase; the lens
shader repeats the same maths in GLSL.

This is **visual only**: no vehicle or pedestrian AI reacts to it, and
`map.update(dt)` must be called each frame for the lights and the shader clock to
advance.

## Test maps

| Folder | What it exercises |
|---|---|
| `public/maps/sample/` | 1024², 500 m, one 22-point road, one automatic lake bridge |
| `public/maps/sample2/` | 1024², 2000 m, two roads |
| `public/maps/junctions/` | 512², 7 roads, one roundabout and two plain junctions |
| `public/maps/citytest/` | 512², generated by `npm run city-map`: city/highway roads, signals, roundabouts, crosswalks, median |
| `public/maps/roadmeta/` | 512², 136 points with every sign, edge type and feature |

The Node suites load these directly; see
[architecture-and-testing.md](architecture-and-testing.md).
