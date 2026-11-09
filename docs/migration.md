# Migrating a map to another engine

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

How to move an exported map to Unity, Unreal, Godot, Blender, Babylon.js or a
custom engine using only the export files or the `.tmap` project. Engine menu
names change between versions; steps marked **typical** describe the concept and
should be checked against your engine version.

## Contents

- [The data model](#the-data-model)
- [Coordinates and units](#coordinates-and-units)
- [Heightfield import](#heightfield-import)
- [Splat layers](#splat-layers)
- [Water](#water)
- [Roads and splines](#roads-and-splines)
- [Markers](#markers)
- [Bridges, junctions and signs](#bridges-junctions-and-signs)
- [What you must reimplement](#what-you-must-reimplement)
- [Conversion scripts](#conversion-scripts)

## The data model

A map is five independent layers:

| Layer | Source | Shape |
|---|---|---|
| Heightfield | `heightmap.r16` (or `heightmap16.png`) | N×N samples, 16-bit, `metres = v/65535 * maxHeightMeters` |
| Surface weights | `splat0.png`, `splat1.png` | N×N×8, each 0..255; class order fixed |
| Lake/river water | `water.png` | N×N 16-bit; 0 = none, `metres = (v-1)/65534 * maxHeightMeters` |
| Ocean | `map.json` `seaLevelMeters` | one horizontal plane |
| Roads | `roads.json` | control points + Catmull-Rom splines + metadata |
| Markers | `markers.json` | points with name, tags, yaw, radius, props |

The height and splat samples are **pixel centres**, not grid corners:

```text
x = (i + 0.5) * worldSizeMeters / N
z = (j + 0.5) * worldSizeMeters / N
y = raw16 / 65535 * maxHeightMeters
```

A heightfield grid with N×N vertices covers slightly less than the full square
(`cell/2` in from each edge). If your engine expects vertices on the full
`[0, W]` square, either resample or add an edge ring, as the loader does.

Class order is fixed by the format:

| id | class | id | class |
|---|---|---|---|
| 0 | grass | 4 | rock |
| 1 | forest | 5 | snow |
| 2 | dirt | 6 | road |
| 3 | sand | 7 | city |

## Coordinates and units

The export uses **+X east, +Y up, +Z south, metres**, right-handed. That is a
top-down view where the image's top row is world z = 0. This page calls it map
space.

| Engine | Up | Handedness | Unit | Common position mapping from map space |
|---|---|---|---|---|
| three.js | Y | right | m | `(x, y, z)`; note three.js treats −Z as forward |
| Babylon.js | Y | left | m | `(x, y, z)`; flip triangle winding if faces are inside-out |
| Unity | Y | left | m | `(x, y, -z)` to keep north up, or `(x, y, z)` with winding flip |
| Unreal | Z | left | cm | `(X, Y, Z) = (z*100, x*100, y*100)`; fix winding |
| Godot 4 | Y | right | m | `(x, y, -z)` to keep north up |
| Blender | Z | right | m | `(x, -z, y)` (a +90° rotation about X) |
| Generic RH Z-up | Z | right | m | `(x, -z, y)` |

These are starting points, not laws. **Always verify with a landmark**: place a
marker on an obvious feature, convert it, and check that it lands on the same
feature. If the terrain is mirrored, negate one horizontal axis and reverse the
triangle winding.

Winding matters because heightfield triangles are usually emitted row by row.
Our loader winds `a, b, a+1 / a+1, b, b+1` to face +Y. A left-handed engine, or a
mapping that mirrors an axis, needs the opposite winding or the terrain renders
inside-out and physics may ignore it.

Unit conversions:

| From | To | Multiply |
|---|---|---|
| metres | centimetres (Unreal) | 100 |
| normalized height | metres | × `maxHeightMeters` |
| raw 16-bit | normalized | ÷ 65535 |
| raw 16-bit | metres | × `maxHeightMeters / 65535` |

Height precision: 65 536 steps over `maxHeightMeters`. At 200 m that is about
3 mm; at 2000 m, about 3 cm.

## Heightfield import

### Unity (typical)

Unity Terrain RAW import expects 16-bit, headerless, row-major samples. The
**byte order** option must match the file: the export `.r16` is **little-endian**,
so choose the Windows/PC order (check the label in your Unity version).

- Terrain resolution must be `2^n + 1` (513, 1025, 2049, ...). The export is
  512/1024/2048. Resample by one row/column, or import at 513/1025/2049.
- Set terrain width and length to `worldSizeMeters`.
- Set terrain height to `maxHeightMeters`; the RAW import maps 0..65535 to
  0..1 of that height.
- Unity's terrain grid runs X to the right and Z forward. Depending on how you
  want north to appear, you may need to mirror one axis; verify with a landmark.

Convert the raw file to a Unity-friendly name or use a small editor script that
reads `.r16` and calls `TerrainData.SetHeightsDelayLOD`.

### Unreal (typical)

Unreal Landscape imports 16-bit heightmaps (PNG or raw, depending on version).
Landscape sizes follow component rules, commonly `505`, `1009`, `2017`, `4033`
or `8129` vertices per side. 512/1024/2048 do not match those exactly; resample
to the next supported size or accept a small scale error.

Unreal is Z-up, left-handed, centimetres. The landscape Z scale is the height in
centimetres represented by the full 16-bit range:

```text
Z scale (cm) = maxHeightMeters * 100
worldZ (cm)  = (raw16 / 65535) * Zscale
```

Set the landscape X/Y scale from `worldSizeMeters * 100` divided by the imported
resolution. If the map is mirrored, negate the Y scale (check visually).

### Godot 4 (typical)

Read the `.r16` directly rather than relying on a PNG import:

```gdscript
var f := FileAccess.open("res://maps/sample/heightmap.r16", FileAccess.READ)
var N := 1024
var raw := f.get_buffer(N * N * 2)
var img := Image.create_from_data(N, N, false, Image.FORMAT_RH, raw)
var heights := img.get_data() # or iterate get_pixel
```

Build an `ArrayMesh` with a grid of vertices, or use `HeightMapShape3D` for
collision. Scale X/Z by `worldSizeMeters / N`, scale Y by
`maxHeightMeters / 65535`. Godot is right-handed and Y-up. Remember Godot's
convention that −Z is "forward"; use the landmark check.

### Blender (typical)

The easiest path is the OBJ converter:

```bash
python docs/examples/heightmap-to-obj.py public/maps/sample out/sample.obj --step 4
```

The OBJ is written Y-up with x east and z south. In Blender, rotate +90° about X
to get Z-up: `(x, y, z) → (x, -z, y)`. Scale is already in metres.

Alternatively, create a grid primitive with `N × N` vertices, set each Z from the
raw height, and use a Displace modifier with a texture. Blender's texture image
import may treat the PNG as 8-bit; prefer the OBJ or a short Python import of
`.r16` for full precision.

### Babylon.js (typical)

`CreateGroundFromHeightMap` takes a URL and reads it through the browser's image
decoder. Browsers may reduce a 16-bit PNG to 8-bit, which loses the precision
that avoids terracing. It also has practical limits on subdivisions.

For accurate maps, build a custom mesh:

```js
const N = map.N, W = map.worldSizeMeters, MAXH = map.maxHeightMeters;
const positions = [], indices = [], uvs = [];
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    positions.push((i + 0.5) * W / N, raw16[j * N + i] / 65535 * MAXH, (j + 0.5) * W / N);
    uvs.push((i + 0.5) / N, (j + 0.5) / N);
  }
}
for (let j = 0; j < N - 1; j++) {
  for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    indices.push(a, c, b, b, c, d); // check winding for Babylon's handedness
  }
}
```

Then apply a custom material that samples `splat0` and `splat1`.

### Generic engine

Read `N`, `worldSizeMeters`, `maxHeightMeters` from `map.json`; read the `.r16`
as little-endian uint16; build an N×N vertex grid at pixel centres; triangulate
with consistent winding; scale and orient with the landmark check.

## Splat layers

The eight classes are split across two RGBA images:

| Texture | R | G | B | A |
|---|---|---|---|---|
| `splat0.png` | grass | forest | dirt | sand |
| `splat1.png` | rock | snow | road | city |

Weight = channel / 255. The eight weights sum to 255 per pixel.

- **Unity**: a Terrain with 8 layers has two alphamaps (4 layers each). Map
  splat0 to the first alphamap and splat1 to the second, with terrain layer order
  0..7 matching the class ids. Unity expects alphamap resolution `2^n + 1` in
  older versions; resample.
- **Unreal**: landscape material with eight weight layers; sample `splat0.r/g/b/a`
  and `splat1.r/g/b/a` and use them as blend weights.
- **Godot**: a spatial shader or `VertexColor` channels; two RGBA textures give
  eight weights.
- **Blender**: eight images or vertex colour attributes; mix in the shader.
- **Babylon.js / custom**: a custom `ShaderMaterial` sampling both textures.

Road class 6 is special: the format stores a blurry road halo, while the loader
decides roads analytically. If you only use the PNG, roads will have soft edges.

## Water

Lakes and rivers: `water.png` gives a surface level per sample. A sample is water
when `value != 0` and the surface is above the terrain. Build one water mesh:

1. For every wet sample, emit a vertex at
   `((i+0.5)*cell, (value-1)/65534*maxHeightMeters, (j+0.5)*cell)`.
2. Triangulate cells whose corners are wet.
3. Use a transparent water material.

The loader emits a quad when **any** of its four corners is wet, and fills dry
corners with the mean of wet neighbours so shore quads have defined heights. That
is a reasonable reference behaviour.

Ocean: a single horizontal plane at `seaLevelMeters`, covering at least
`worldSize × worldSize`. It is not stored in `water.png`.

## Roads and splines

`roads.json` control points are joined by a **uniform Catmull-Rom** spline in
the x,z plane. y is not splined: normal segments take the terrain height, bridge
segments interpolate the two control-point y values linearly.

JavaScript evaluator:

```js
const cr = (a, b, c, d, t) =>
  0.5 * (2*b + (-a + c)*t + (2*a - 5*b + 4*c - d)*t*t + (-a + 3*b - 3*c + d)*t*t*t);

function sampleSegment(P, i, f) {
  const p0 = P[Math.max(i - 1, 0)];
  const p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(i + 2, P.length - 1)];
  return {
    x: cr(p0.x, p1.x, p2.x, p3.x, f),
    z: cr(p0.z, p1.z, p2.z, p3.z, f),
  };
}
```

Python evaluator:

```python
def cr(a, b, c, d, t):
    return 0.5 * (2*b + (-a + c)*t + (2*a - 5*b + 4*c - d)*t*t
                  + (-a + 3*b - 3*c + d)*t*t*t)

def sample_segment(P, i, f):
    p0 = P[max(i - 1, 0)]
    p1, p2 = P[i], P[i + 1]
    p3 = P[min(i + 2, len(P) - 1)]
    return (cr(p0["x"], p1["x"], p2["x"], p3["x"], f),
            cr(p0["z"], p1["z"], p2["z"], p3["z"], f))
```

Both are exercised by [examples/road-spline.mjs](examples/road-spline.mjs) and
[examples/road-spline.py](examples/road-spline.py) and match the loader's
`getPoints(spacing)`.

To use an engine's native spline, convert each Catmull-Rom segment to a cubic
Bezier segment between `P1` and `P2`:

```text
B0 = P1
B1 = P1 + (P2 - P0) / 6
B2 = P2 - (P3 - P1) / 6
B3 = P2
```

with `P0` and `P3` clamped at the ends. That is the same curve; feed `B0..B3`
into Unity/Unreal/Godot/Blender spline APIs.

Build the road ribbon by walking the spline at about 1 m spacing, offsetting
`±widthMeters/2` along the horizontal normal `(-tz, tx)`, and emitting a quad
strip. Use the segment's `surface` to choose a material.

Do not forget the last point's attributes are unused, and `features` apply at
the point, not the segment.

## Markers

Place one empty per marker:

```text
position = (x, heightAt(x,z) + yOffset, z)
rotation = yaw about Y (0 = +X, +90 = +Z)
```

Use `radius` for a trigger volume, `tags` for lookup, and `props` for arbitrary
string data. Names are not enforced unique by the loader; resolve duplicates in
your own code if it matters.

The loader recomputes `marker.y` from its own terrain. If you import markers
without the terrain, use the file's `y`, which was sampled from the editor's
ground.

## Bridges, junctions and signs

### Bridges

`bridge: true` on a control point means the next segment is elevated. Draw a
deck, rails and pillars; the loader uses the straight line between the two
control point y values and does not bake the span into the terrain.

Automatic bridges over water are a loader feature, **not stored in the export**.
If you want the same result in another engine, either:

- export a version with road points adjusted to deck height, or
- reimplement the rule: a non-bridge stretch below `water + 0.3 m` becomes a
  bridge at `max(road y, water + 1.5 m)`, with approach ramps at most 7% grade,
  ignoring wet runs under 4 m unless more than 0.5 m deep, merging runs closer
  than 20 m, and skipping spans that reach a junction.

The loader exposes its plan as `roadDetail.autoBridges`; a Node script can dump
it to JSON for your engine.

### Junctions

`roads.json` has **no junction data**. The loader detects:
crossings, road ends (T/Y/L), and self-meetings, excluding overpasses where one
road is a bridge or heights differ by more than 4 m. It then chooses a style:

- 4+ arms: roundabout;
- any highway arm: plain junction;
- 3+ arms with a city arm: signals;
- otherwise: plain junction.

Markers within 15 m with tags `roundabout`, `signals` or `junction_plain`, and
an optional loader-side `junctions.json`, override the style.

To migrate junctions without reimplementing detection, dump them from the loader:

```js
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadMap } from './src/world/mapLoader.js';

const dir = path.resolve('public/maps/sample');
globalThis.fetch = async (u) => {
  const f = path.join(dir, path.basename(u));
  return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 });
};
const map = await loadMap('/maps/sample/', { THREE, physics: false });
fs.writeFileSync('junctions.json', JSON.stringify(map.junctions, null, 1));
```

Each entry has `{x, z, y, style, radius, arms[{roadId, angle, width, type}]}`.
Build a patch, ring or signalised junction from that.

### Signs and edges

Warning signs are generated at load time from the road geometry:
curve/sharp/winding signs from heading rate, hill signs from grade, and
roadworks signs from features. They are country-only, stand on the drive side,
and face oncoming traffic. Reimplement the detection or export the sign list from
`map.roadDetail.signs` and place billboards.

Edges (`fence`, `guardrail`, `barrier`, `lamps`) are instanced along the segment.
`oneway` suppresses the centre line and adds arrows. City segments add kerbs and
2.65 m footpaths; highway segments add shoulders and a two-way median barrier.

## What you must reimplement

| Feature | Why |
|---|---|
| Terrain shader | procedural splat noise, steep-rock tint, road-class removal |
| Road ribbon and markings | shader-drawn lanes, dashes, arrows, surface looks |
| Junction geometry | patches, fillets, roundabout rings, stop lines |
| City footpaths and corner blocks | procedural bands and prisms |
| Warning signs | detected from curvature and grade; pictograms drawn in code |
| Signal animation | phase cycle is visual only, not in the files |
| Automatic bridges | computed from water, not exported |
| Colliders | loader builds Rapier heightfield/trimeshes; rebuild for your engine |
| Vehicle handling | `handling.js` profiles are engine-specific data; re-tune |

What transfers cleanly: heightfield, splat weights, water levels, road control
points and metadata, markers, map settings (`driveSide`, `signStyle`), and the
class colour table.

## Conversion scripts

| Script | Use |
|---|---|
| [examples/heightmap-to-obj.py](examples/heightmap-to-obj.py) | heightmap → OBJ grid for Blender or any mesh importer |
| [examples/read-export.mjs](examples/read-export.mjs) | decode `.r16` and 16-bit PNG, sample heights |
| [examples/read-tmap.mjs](examples/read-tmap.mjs) | `.tmap` → raw layers + JSON |
| [examples/read-tmap.py](examples/read-tmap.py) | same in Python |
| [examples/road-spline.mjs](examples/road-spline.mjs) | road spline evaluation in JS |
| [examples/road-spline.py](examples/road-spline.py) | road spline evaluation in Python |

All are standard-library only and run against the maps in `public/maps/`.
