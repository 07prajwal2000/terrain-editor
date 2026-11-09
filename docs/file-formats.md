# File formats

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

Reference for everything the editor exports and for the `.tmap` project file. The
writer lives in `src/editor/editor.js`; the reader is `src/world/mapLoader.js`.
Where they disagree, this page follows the reader.

## Contents

- [Coordinate system](#coordinate-system)
- [Heightmaps](#heightmaps)
- [Splat weights](#splat-weights)
- [Biome colour](#biome-colour)
- [Water](#water)
- [roads.json](#roadsjson)
- [markers.json](#markersjson)
- [map.json](#mapjson)
- [junctions.json](#junctionsjson)
- [The .tmap container](#the-tmap-container)
- [Road spline evaluation](#road-spline-evaluation)
- [Minimal valid map](#minimal-valid-map)
- [Versioning and compatibility](#versioning-and-compatibility)

## Coordinate system

All grids are `N × N`, row-major, `N` is 512, 1024 or 2048, row 0 is the top
row of the editor image.

```text
(0,0) top-left corner
  +X  east  (increasing pixel column)  ---->
  |
  v
 +Z  south (increasing pixel row, DOWN the image)
 +Y  up, metres
```

The map covers the square `[0, worldSizeMeters] × [0, worldSizeMeters]`.

| Quantity | Formula |
|---|---|
| cell size | `cell = worldSizeMeters / N` |
| sample point of pixel `(i,j)` | `x = (i+0.5)*cell`, `z = (j+0.5)*cell` |
| normalized map coordinate | `u = x/worldSizeMeters`, `v = z/worldSizeMeters`; centre of pixel `i` is `u=(i+0.5)/N` |
| continuous pixel position | `px = u*N - 0.5`, `pz = v*N - 0.5` (bilinear sample) |

Samples sit at **pixel centres**, not corners. Bilinear interpolation clamps the
continuous position to `[0, N-1]` before flooring, so the outer half-cell is
extended:

```js
fx = clamp(x/cell - 0.5, 0, N-1);
fz = clamp(z/cell - 0.5, 0, N-1);
x0 = min(floor(fx), N-2); z0 = min(floor(fz), N-2);
```

The terrain mesh adds one vertex on each map edge (at the nearest sample height)
so it covers the full `[0, W]²` square; interior vertices still sit exactly on
samples. `map.heightAt` returns the bilinear value, which can differ from the
triangulated mesh inside a cell (about 2 cm at 0.49 m cells on the sample map).

## Heightmaps

Two files carry the same samples. The loader reads **only `.r16`**; the 16-bit
PNG is convenient for image tools.

### heightmap.r16

Raw headerless 16-bit unsigned, **little-endian**, `N*N*2` bytes, row-major.

```text
offset:  0        2        4                    N*N*2-2
         [sample 0][sample 1][sample 2] ... [sample N*N-1]
```

### heightmap16.png

16-bit grayscale PNG (colour type 0, bit depth 16, no interlace). PNG stores
samples **big-endian** by spec. The editor writes filter type 1 (Sub) per row;
any standard PNG decoder handles it.

### Conversion

```text
normalized = raw16 / 65535
metres     = normalized * maxHeightMeters
raw16      = round(clamp(metres / maxHeightMeters, 0, 1) * 65535)
```

The loader assumes a little-endian host when constructing the `Uint16Array` from
`.r16`.

## Splat weights

Two 8-bit RGBA PNGs hold the eight surface classes. Weights are straight
(non-premultiplied) and the 8 channels of both files sum to exactly 255 per pixel.

| File | Channels |
|---|---|
| `splat0.png` | R,G,B,A = classes 0,1,2,3 |
| `splat1.png` | R,G,B,A = classes 4,5,6,7 |

```text
coverage = channel / 255
```

| id | name | default colour |
|---|---|---|
| 0 | grass | `#5da130` |
| 1 | forest | `#1f5c2a` |
| 2 | dirt | `#8a6a43` |
| 3 | sand | `#e0cf8f` |
| 4 | rock | `#7d7d7d` |
| 5 | snow | `#f2f6ff` |
| 6 | road | `#333333` |
| 7 | city | `#b0a0c0` |

The loader does not renormalise a file whose channels do not sum to 255; it
removes the road class analytically when a road is present and rescales the
remainder. Hand-built maps should keep the sum exact.

## Biome colour

`biome_color.png` is an 8-bit RGB PNG with the colour of the dominant class per
pixel. It is a human preview only; neither the editor's live preview nor the
loader reads it. The editor's preview builds its own colours from the weights.

## Water

`water.png` is a 16-bit grayscale PNG, `N × N`, holding lake and river surfaces.

| value | meaning |
|---|---|
| `0` | no lake/river water at this pixel |
| `v ≥ 1` | surface normalized `(v-1)/65534`, metres `(v-1)/65534 * maxHeightMeters` |

```text
metres = (v - 1) / 65534 * maxHeightMeters
```

A pixel only counts as water where the surface is above the terrain. The ocean
is **not** stored in this file: every pixel whose terrain height is below
`seaLevelMeters` is ocean, with the surface at `seaLevelMeters`.

The loader also guards the lake surface: `waterLevelAt` returns the lake level
only where it is above the terrain, and the lake mesh emits a quad when any of
its four corners is wet.

## roads.json

The editor writes a wrapper object, not a bare array:

```json
{
  "formatVersion": 1,
  "note": "nx,nz normalized ...",
  "roads": [
    {
      "id": 1,
      "widthMeters": 8,
      "points": [
        { "nx": 0.5573, "nz": 0.0853, "x": 278.693, "y": 40.0, "z": 42.689, "bridge": false }
      ]
    }
  ]
}
```

### Road point fields

| Field | Type | Written | Loader use |
|---|---|---|---|
| `nx`, `nz` | number 0..1 | always | ignored by the loader |
| `x`, `z` | metres | always | required; control-point position |
| `y` | metres | always | used only for bridge segments and single-point roads; normal segments take `heightAt(x,z)` |
| `bridge` | boolean | always | segment from this point to the next is elevated |
| `type` | `"country"` (default), `"city"`, `"highway"` | only when not default | segment attribute |
| `oneway` | boolean | only when true | segment attribute |
| `edgeL`, `edgeR` | `"none"`, `"fence"`, `"guardrail"`, `"barrier"`, `"lamps"` | only when not none | segment attribute |
| `surface` | `"smooth"`, `"worn"`, `"potholes"`, `"gravel"` | only when not smooth | segment attribute |
| `signs` | `"auto"`, `"off"` | only when `"off"` | segment attribute |
| `features` | array of `"crosswalk"`, `"bump"`, `"rumble"`, `"roadworks"` | only when non-empty | applies at the point |

Segment attributes apply from a point to the **next** point, exactly like
`bridge`. The last point's segment attributes are ignored. Features apply at the
point itself. Writing a field only when it differs from its default keeps files
from older editors byte-identical.

A missing `x` or `z` fails validation even if `nx`/`nz` are present. For markers
the loaders accepts either pair.

## markers.json

```json
{
  "version": 1,
  "note": "...",
  "markers": [
    {
      "id": 1, "name": "player_start", "tags": ["spawn"], "color": "#ff3b30",
      "x": 80.0, "z": 147.0, "y": 27.4, "nx": 0.08, "nz": 0.147,
      "yaw": 90, "radius": 0, "props": { "team": "red" }, "yOffset": 0
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | integer, unique in the file |
| `name` | optional string; the editor warns on duplicates but does not rename |
| `tags` | lowercase slugs `[a-z0-9_-]`; queried by `getMarkers({tag})` |
| `color` | `#rrggbb` |
| `x`, `z` | world metres |
| `nx`, `nz` | normalized 0..1 |
| `y` | terrain height at export + `yOffset`; the loader ignores it and recomputes |
| `yaw` | degrees, 0 = +X (east), +90 = +Z (south) |
| `radius` | metres, 0 = point marker, >0 = trigger area |
| `props` | free-form string → string map |
| `yOffset` | metres added to the terrain height |

The loader requires numeric `x,z` **or** `nx,nz` for every marker and computes
`marker.y = heightAt(x,z) + yOffset`. It does not enforce unique names.

## map.json

```json
{
  "formatVersion": 1,
  "N": 1024,
  "worldSizeMeters": 500,
  "maxHeightMeters": 200,
  "cellSizeMeters": 0.48828125,
  "seaLevel": 0.1,
  "seaLevelMeters": 20,
  "classes": [ { "id": 0, "name": "grass", "color": "#5da130" }, "..."],
  "files": {
    "height16": "heightmap16.png",
    "heightRaw16": "heightmap.r16",
    "splat0": "splat0.png",
    "splat1": "splat1.png",
    "biomeColor": "biome_color.png",
    "water": "water.png",
    "roads": "roads.json",
    "markers": "markers.json"
  },
  "encodings": { "height": "...", "splat0": "...", "water": "..." },
  "coordinates": { "origin": "...", "xAxis": "...", "zAxis": "...", "yAxis": "...", "pixelToWorld": "..." },
  "driveSide": "left",
  "signStyle": "eu"
}
```

| Field | Required by loader | Notes |
|---|---|---|
| `N` | yes | integer 2..8192; the editor writes 512/1024/2048 |
| `worldSizeMeters` | yes | > 0 |
| `maxHeightMeters` | yes | > 0 |
| `seaLevelMeters` | **yes** | source of truth for the ocean |
| `seaLevel` | no | normalized; exposed as `info.seaLevelNormalized` |
| `cellSizeMeters` | no | ignored; the loader computes `worldSizeMeters / N` |
| `classes` | yes | exactly 8, `id === array index`, colour `#rrggbb` |
| `files.heightRaw16`, `.splat0`, `.splat1`, `.water`, `.roads` | yes | strings |
| `files.markers` | no | defaults to `markers.json` |
| `files.height16`, `.biomeColor` | no | ignored by the loader |
| `driveSide` | no | `"right"` (default) or `"left"` |
| `signStyle` | no | `"us"` (default) or `"eu"` |

Naming trap: `map.info.seaLevel` is **metres**, while the file's `seaLevel` is
**normalized**.

## junctions.json

Optional loader-side override file in the map folder. The editor does not write
it.

```json
[
  { "x": 250.0, "z": 300.0, "style": "roundabout", "radius": 24 },
  { "x": 100.0, "z": 80.0, "style": "none" }
]
```

| Field | Meaning |
|---|---|
| `x`, `z` | metres; matched to the nearest detected junction within 15 m |
| `style` | `"junction"`, `"roundabout"`, `"signals"`, `"none"` |
| `radius` | optional; roundabout **outer** radius (min 12) or junction/signals patch radius (min 10) |

Unmatched entries are ignored. Precedence is `junctions.json` > markers > the
defaults. `"none"` removes the junction patch/roundabout/terrain stamp, leaving
plain overlapping roads. See [roads-and-junctions.md](roads-and-junctions.md).

## The .tmap container

```text
byte 0            4            8                        8+headerLength
+----------------+------------+------------------------+-----------------+
| "TMAP"         | u32 LE     | UTF-8 JSON header      | raw layers      |
|                | headerLen  | (right-padded with     | (little-endian) |
|                |            | spaces to 4 bytes)     |                 |
+----------------+------------+------------------------+-----------------+
```

- Magic: bytes `84 77 65 80` (`"TMAP"`).
- `headerLength = (jsonBytes.length + 3) & ~3`; the padding bytes are spaces
  (`0x20`). Parse `[8, 8+headerLength)`, not the unpadded length.
- Layer offsets are relative to the **start of the data section**, `8 + headerLength`.

### Header

```json
{
  "format": "tmap",
  "version": 1,
  "N": 1024,
  "settings": { "worldSizeMeters": 2000, "maxHeightMeters": 200, "seaLevel": 0.1 },
  "roads": [ "..." ],
  "nextRoadId": 1,
  "markers": [ "..." ],
  "nextMarkerId": 1,
  "layers": [
    { "name": "height",  "type": "f32", "offset": 0,       "byteLength": 4194304 },
    { "name": "water",   "type": "f32", "offset": 4194304, "byteLength": 4194304 },
    { "name": "weight0", "type": "u8",  "offset": 8388608, "byteLength": 1048576 }
  ]
}
```

`settings.driveSide` and `settings.signStyle` are present only when they differ
from the defaults. Road points carry the same optional metadata fields as
`roads.json`.

### Layers

Fixed order, fixed sizes (`N²` samples):

| Layer | Type | Bytes | Meaning |
|---|---|---|---|
| `height` | f32 | `N*N*4` | normalized 0..1; metres = value × `maxHeightMeters` |
| `water` | f32 | `N*N*4` | normalized 0..1; `-1` = none |
| `weight0` … `weight7` | u8 | `N*N` each | class weights 0..255, as in `splat0/1.png` |

The editor writes the arrays in host endianness; all current desktop browsers and
the tests are little-endian. Values are not quantised to 16 bits in the project
file, so saving and reopening a `.tmap` keeps full float precision.

## Road spline evaluation

`roads.json` control points are joined with a **uniform Catmull-Rom** spline in
the `x,z` plane, parametrised by control-point index (not arc length). End points
are duplicated as phantom neighbours. `y` is not splined: on a normal segment it
comes from `heightAt(x,z)`, on a bridge segment it is linear between the two
control-point `y` values.

```js
const cr = (a, b, c, d, t) =>
  0.5 * (2*b + (-a + c)*t + (2*a - 5*b + 4*c - d)*t*t + (-a + 3*b - 3*c + d)*t*t*t);

function segPoint(P, i, f) {
  const p0 = P[Math.max(i - 1, 0)];
  const p1 = P[i];
  const p2 = P[i + 1];
  const p3 = P[Math.min(i + 2, P.length - 1)];
  const x = cr(p0.x, p1.x, p2.x, p3.x, f);
  const z = cr(p0.z, p1.z, p2.z, p3.z, f);
  const y = p1.bridge ? p1.y + (p2.y - p1.y) * f : heightAt(x, z);
  return { x, y, z, seg: i, u: i + f };
}

function getPoints(P, spacingMeters) {
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const chord = Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z);
    const m = Math.max(2, Math.ceil(chord / spacingMeters));
    for (let k = 0; k < m; k++) out.push(segPoint(P, i, k / m));
  }
  out.push(segPoint(P, P.length - 2, 1));
  return out;
}
```

The loader's samples also carry `tx,tz` (unit tangent from the analytic
derivative), `u = seg + f`, `bridge`, and `auto` for automatic bridges. Run the
standalone versions in [examples/road-spline.mjs](examples/road-spline.mjs) and
[examples/road-spline.py](examples/road-spline.py).

## Minimal valid map

The smallest folder `loadMap` accepts:

| File | Needed |
|---|---|
| `map.json` | yes, with `N`, `worldSizeMeters`, `maxHeightMeters`, `seaLevelMeters`, 8 valid `classes`, and `files` naming the files below |
| `heightmap.r16` | yes, exactly `N*N*2` bytes |
| `splat0.png` | yes, `N×N` RGBA8 |
| `splat1.png` | yes, `N×N` RGBA8 |
| `water.png` | yes, `N×N` 16-bit grayscale (all zero = no lakes) |
| `roads.json` | yes, may be `{ "roads": [] }` |
| `markers.json` | no; `[]` or absent is fine |
| `junctions.json` | no |
| `heightmap16.png`, `biome_color.png` | no |

The loader rejects a map whose `.r16` length is not exact, whose splat/water
channels or bit depth are wrong, or whose `classes` array is not the standard 8.

## Versioning and compatibility

- `formatVersion` is 1 in all exported JSON and `.tmap` headers.
- Road metadata parsing is lenient: unknown enum values fall back to the default,
  so a newer editor cannot break an older loader. Fields are written only when
  they differ from their default.
- `.tmap` version 1 without `driveSide`/`signStyle` in `settings`, or without the
  newer road metadata fields, opens with defaults. `scripts/fixtures/old.tmap`
  is the pre-metadata fixture.
- `scripts/fixtures/old-export-sha256.json` records SHA-256 hashes of an export
  from before the metadata work; it is a manual byte-identity baseline, not
  referenced by any test.
