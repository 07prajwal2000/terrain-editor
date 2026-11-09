# FAQ and troubleshooting

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

Problems verified against the code or the test suites. If a symptom is not here,
start with `npm run test:loader` and the browser console.

## Contents

- [Why must the editor be served?](#why-must-the-editor-be-served)
- [Export writes only one file](#export-writes-only-one-file)
- [The autosave restore prompt](#the-autosave-restore-prompt)
- [Why a 16-bit heightmap](#why-a-16-bit-heightmap)
- [Preview looks different from the 2D view](#preview-looks-different-from-the-2d-view)
- [2048 maps are slow](#2048-maps-are-slow)
- [The physics collider does not match the ground](#the-physics-collider-does-not-match-the-ground)
- [Cars fall off the map](#cars-fall-off-the-map)
- [A road looks wrong](#a-road-looks-wrong)
- [Force a roundabout or signals](#force-a-roundabout-or-signals)
- [Disable automatic warning signs](#disable-automatic-warning-signs)
- [The viewer's physics test fails](#the-viewers-physics-test-fails)
- [Markers float or sit too high](#markers-float-or-sit-too-high)
- [A junction is missing](#a-junction-is-missing)

## Why must the editor be served?

`editor.html` loads `/src/editor/editor.js` as an ES module, which imports
`preview3d.js`, `roadMeta.js`, `three` and the map loader. Browsers refuse module
imports and `fetch` from `file://` for security reasons. Use:

```bash
npm run dev
# http://127.0.0.1:5173/editor.html
```

or serve a production build over HTTP. Opening the HTML file directly gives a
blank page and console errors about modules or CORS.

## Export writes only one file

The folder picker uses `showDirectoryPicker`, which is Chromium-only. Firefox and
Safari fall back to nine automatic `<a download>` clicks 350 ms apart. Chrome can
block all but the first automatic download when multiple downloads are not
allowed, and some configurations block them entirely.

Use Chrome, Edge or Opera and click **Export** to open the directory picker. If
you must use the fallback, allow multiple automatic downloads for the site before
exporting.

## The autosave restore prompt

The editor autosaves a full `.tmap` blob to IndexedDB every 10 seconds after a
change. On startup it asks:

```text
Restore autosaved map from <date>?
```

There is no in-app "clear autosave" button. To clear it, open the browser
developer tools → Application → IndexedDB → `terrain-editor` → `kv`, and delete
the `autosave` record (or the whole database). Saving a `.tmap` does not clear
the autosave; the next change overwrites it.

## Why a 16-bit heightmap

An 8-bit heightmap would give `maxHeight / 255` steps: about 0.78 m on a 200 m
map, which shows as terraces. A 16-bit value gives `maxHeight / 65535` steps:
about 3 mm at 200 m. The editor writes both `heightmap.r16` and
`heightmap16.png` with the same samples; the loader reads only `.r16`.

Do not re-save the PNG as 8-bit. The loader requires 16-bit grayscale for a
direct PNG read, and the editor's PNG path is only for image tools.

## Preview looks different from the 2D view

The 2D view is a deliberately simple orthographic composite of shaded height and
biome colours. The 3D preview is the real game loader: it applies the terrain
material, splat textures, the sun and hemisphere light, fog, water shading and
road geometry. Lighting, specular water and road meshes cannot appear the same in
the 2D view.

The **Vertical exaggeration** slider also changes only the preview, scaling the
whole preview group (including marker pins). At 1.0× the preview matches the
game.

## 2048 maps are slow

There is no LOD. Every terrain chunk is full resolution, so a 2048² map is about
8.4 million triangles. 512 and 1024 are comfortable; 2048 is usable but heavy on
integrated GPUs.

Things that help:

- Use 1024 unless you really need the detail.
- Lower `physicsResolution` (default 512) if collider build time matters.
- Hide road edges, signs and water in the preview while sculpting.
- Large brush radii on 2048² maps are slow; this has not been benchmarked, but the
  brush loops are plain JavaScript per pixel.

## The physics collider does not match the ground

The terrain collider is a Rapier heightfield sampled at `physicsResolution`
points per side (default 512, the game uses 1024). It is a resampled version of
the same grid `heightAt` reads, not the render mesh.

- The `test:loader` suite verifies the heightfield orientation: mean raycast
  error is far below the transposed or mirrored error.
- On the sample map the worst raycast error at 512 resolution is about 1.3 m on
  steep ground, with a 2.4 cm mean.
- Inside stamped city corridors the agreement is a few millimetres.

Raise `physicsResolution` for better agreement, at the cost of memory and build
time. In the dev viewer, enable **collider debug** to see the exact array handed
to Rapier.

## Cars fall off the map

There are no edge walls. The map covers `[0, worldSize]²`; outside it there is no
terrain collider, so a car that drives off the edge falls. Edge walls are a
planned feature, not built.

Height sampling clamps to the edge, so the car may still be reported above ground
for a moment while it leaves the collider.

## A road looks wrong

Check, in this order:

1. **Type.** A point's `type` applies to the segment to the **next** point. The
   last point's type is ignored. Mixing `country`, `city` and `highway` on
   adjacent segments changes kerbs, footpaths, lanes and median.
2. **Bridge.** `bridge` also applies to the next segment. Editor bridges are not
   baked into the terrain; automatic bridges appear only where a non-bridge road
   dips below `water + 0.3 m`.
3. **Surface.** `smooth`, `worn`, `potholes` and `gravel` change look and grip.
   Potholes are not geometry.
4. **Bake.** Flat segments need **Bake roads into terrain**; a road drawn on
   steep ground without baking can float or clip.
5. **Junction stamping.** The loader flattens a disc at every detected junction
   and blends 12+ m outward. A road near a junction may be reshaped.
6. **City corridor.** City segments flatten the carriageway plus `FOOT_SHIFT`
   (2.65 m) per side with a 3 m blend.

If the 2D editor looks right but the game does not, reload the map folder: the
editor preview uses the same loader, so a difference usually means the exported
files are stale.

## Force a roundabout or signals

The editor does not write `junctions.json`. Two options:

1. **Marker.** Place a marker within 15 m of the junction with tag `roundabout`,
   `signals` or `junction_plain`. The nearest qualifying marker wins.
2. **Override file.** Add `junctions.json` to the exported folder:

```json
[
  { "x": 250, "z": 300, "style": "roundabout", "radius": 24 },
  { "x": 150, "z": 220, "style": "signals" }
]
```

Precedence is `junctions.json` > markers > defaults. `"none"` removes the
junction patch entirely.

A highway arm always forces a plain junction, even if a marker or JSON asks for a
roundabout or signals.

## Disable automatic warning signs

Select the road points and set **Warn signs** to `off`. The field is a segment
attribute: it applies from that point to the next, so set it on every affected
segment or use **Apply to whole road**.

Signs are country-only. Setting the segment type to `city` or `highway` also
removes them. Bridges and junction discs suppress signs regardless of the mode.

## The viewer's physics test fails

`/index.html` has **Physics test (20 balls)**. It drops balls, fast-forwards 12 s
and compares their resting height with `R / normalAt().y`, where `R` is the ball
radius and `normalAt` comes from `heightAt`.

If it fails:

- Enable **collider debug** and compare the drawn collider with the terrain.
- Check the map folder actually loads (`map.info.loadMs` and the HUD).
- Run `npm run test:loader`; it checks heightfield orientation with 400 raycasts
  and prints the transposed/mirrored errors for scale.
- On steep slopes a ball may never settle; the test is a smoke check, not a
  precision test.
- Remember that `physicsResolution` (default 512, 1024 in the game) is a
  downsampled collider, not the render mesh.

## Markers float or sit too high

The loader ignores the file's marker `y` and recomputes:

```text
marker.y = heightAt(x, z) + yOffset
```

after junction and city terrain stamping. If a marker is too high, clear or
reduce **Y offset** in the editor. If it moves when you edit terrain, that is
expected: the height follows the ground.

## A junction is missing

Detection requires at least two arms. It is skipped when:

- either road is a bridge at the crossing, or the heights differ by more than
  4 m (an overpass);
- two passes of one road are closer than `3 * width + 10 m` in arc length;
- a self-crossing has an acute angle below 25°;
- a road end is farther than `max(widthA, widthB)` from the other centreline.

Markers only override a junction that was detected; they do not create one. Road
markings are masked only for the first 32 junctions, but junction geometry still
exists beyond that.

See [roads-and-junctions.md](roads-and-junctions.md) for the full rules.
