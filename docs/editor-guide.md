# Editor guide

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

Task-oriented guide to the terrain and road editor at `/editor.html`. The editor
is a Vite module app; open it through the dev server, not `file://`.

## Contents

- [First run](#first-run)
- [Interface](#interface)
- [Creating a map](#creating-a-map)
- [View and preview](#view-and-preview)
- [Brush settings](#brush-settings)
- [Terrain tools](#terrain-tools)
- [Paint tools](#paint-tools)
- [Road tool](#road-tool)
- [Road node inspector](#road-node-inspector)
- [Markers](#markers)
- [Map settings](#map-settings)
- [Undo, autosave and projects](#undo-autosave-and-projects)
- [Export](#export)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Tutorial: island, lake, forest, coast road and town](#tutorial-island-lake-forest-coast-road-and-town)

## First run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/editor.html`. The editor starts with a 1024² map,
2000 m across, 200 m maximum height and sea level 0.10.

## Interface

| Area | Contents |
|---|---|
| Top bar | New, Open, Save, Export, Undo, Redo, Paint/Split/Preview, autosave time, Help (F1) |
| Left toolbar | Raise, Lower, Smooth, Flatten, Mountain, Hills, Water, Erase water, Paint, Road, Marker, Pan |
| Centre | 2D canvas (and the 3D preview in Split or Preview mode) |
| Right panel | Brush, the current tool's settings, 3D preview, View, Map |
| Status bar | pixel coordinates, world x/z, terrain height, zoom and grid state |

Only the sections for the active tool are shown. The status bar updates while
you move the pointer.

## Creating a map

**New** opens a dialog:

| Field | Default | Notes |
|---|---|---|
| Resolution | 1024 | 512, 1024 or 2048; the grid is N×N |
| World size (m) | 2000 | square, metres |
| Max height (m) | 200 | 65535 raw units map to this |
| Sea level (0–1) | 0.10 | normalized; ocean is everything below it |
| Start height | 0.20 | fills the whole map with this normalized height |

Creating a new map discards unsaved changes (it asks first if the map was
modified) and resets Drive side and Sign style to their defaults.

## View and preview

The **View** section controls the 2D map:

| Control | Meaning |
|---|---|
| Mode | `Height + biome` (default), `Shaded height`, `Biome colours` |
| Water | show the water overlay |
| Roads | show the road overlay |
| Grid | metric grid and quadrant overlay |
| Biome opacity | blend of the biome colours, 0..1 |
| Water opacity | blend of the water overlay, 0..1 |
| Sea level | 0..1, corresponds to `seaLevelMeters` on export |

The **3D preview** uses the game's own loader (`loadMapFromData`). It rebuilds
only when `N`, world size, max height, drive side or sign style change;
otherwise it patches the changed region. Toggles: Water, Roads, Road edges,
Warning signs, Wireframe. **Vertical exaggeration** (0.5×..6×) scales the whole
preview group, including marker pins.

Modes:

- **Paint** — 2D only.
- **Split** — 2D and 3D side by side.
- **Preview** — 3D only. Painting still happens in the 2D view, so switch back.

Preview controls: drag to orbit, right-drag to pan, wheel to zoom.

## Brush settings

The Brush section is always visible.

| Control | Range | Default | Meaning |
|---|---|---|---|
| Radius (px) | 2..500 | 60 | brush size in map pixels |
| Strength | 0.02..1 | 0.50 | how fast the tool applies |
| Hardness | 0..1 | 0.50 | 1 = hard cliff/plateau edge, 0 = soft rolling |
| Falloff shape | smooth, linear, sharp | smooth | radial curve inside the brush |

Pen pressure is used when the pointer type is `pen`: it scales the effect for
Flatten, Smooth and Paint. Raise, Lower, Mountain and Hills do not use pressure.
Holding the mouse still keeps applying the brush.

A soft brush (`hardness` near 0) is best for hills and beaches; a hard brush is
best for plateaus, cliffs and road cuttings.

## Terrain tools

| Tool | Key | Settings | What it does |
|---|---|---|---|
| Raise | `R` | brush | raises terrain; hold `Shift` to lower |
| Lower | `L` | brush | lowers terrain |
| Smooth | `S` | brush | averages nearby heights |
| Flatten | `F` | Typed target, Target (m), Clear pick | flattens to a target height |
| Mountain | `M` | Scale (px), Ridge sharp, Amplitude | ridged noise mountains |
| Hills | `H` | Scale (px), Amplitude | smooth fBm hills |
| Water | `W` | Bed depth (m) | carves a lake at the stroke's starting height |
| Erase water | `E` | none | removes lake/river water |
| Paint | `P` | surface swatches, auto-paint | paints surface classes |
| Road | `T` | see below | draws roads |
| Marker | `K` | see below | places markers |
| Pan | `V` | none | pans the view |

Details:

- **Flatten** target order: the typed metre value if enabled, else the height
  picked with `Alt+click` (Clear pick resets it), else the terrain height where
  the stroke started.
- **Mountain**: Scale 20..500 px (default 150), Ridge sharp 0.5..5 (2.0),
  Amplitude 0.1..4 (1.0). Large scale + high ridge yields sharp ranges.
- **Hills**: Scale 30..800 px (250), Amplitude 0.1..4 (1.0). Use a large radius
  and low strength for rolling ground.
- **Water**: Bed depth 0.5..60 m (6.0). The lake level is the terrain height where
  the stroke starts; dragging carves below it. The tool only stores water where
  the surface is above the terrain.
- **Sea level** in the View section controls the ocean, not the Water tool.

## Paint tools

**Surface** shows the eight classes: grass, forest, dirt, sand, rock, snow, road,
city. Strength controls density and hardness controls blend softness; the eight
weights always sum to 255.

**Auto-paint (only pure grass)** rewrites pixels that are still 100% grass:

| Setting | Default | Effect |
|---|---|---|
| Rock slope (deg) | 35 | paints rock on slopes steeper than this |
| Snow height | 0.75 | paints snow above this normalized height |
| Sand band | 0.03 | paints sand just above sea level |

**Auto-paint now** applies once, as a single undo step. It will not touch ground
you have already painted.

Tip: paint forest with a soft brush at moderate strength, then use the road tool
and let road baking stamp the road class.

## Road tool

Select **Road** (`T`). The right panel shows the road list and controls.

| Control | Meaning |
|---|---|
| New | clears the selection and starts a new road on the next click |
| Continue | appends points to the selected road |
| Finish | ends the current road (`Enter` or double-click also finishes) |
| Del road | deletes the selected road |
| Width (m) | 1..100, default 8 |
| Pt bridge | marks the segment from the selected point to the next as a bridge |
| Shoulder (m) | bake blend width, default 10 |
| Profile smooth (m) | bake profile smoothing, default 40 |
| Bake roads into terrain | flattens the terrain under non-bridge segments |

Drawing:

- Click empty space to add a point. It starts a new road if none is being drawn.
- Click a line to insert a point; a new point inherits the segment attributes of
  the segment it splits.
- Drag a point to move it.
- `Delete` / `Backspace` removes the selected point.
- `Enter` or double-click finishes the road. A road with fewer than two points is
  discarded.
- `Shift+click` selects the range between the anchor and the clicked point.
  `Ctrl`/`Cmd+click` adds or removes a point. Edits apply to every selected point
  as one undo step.

Bridge semantics: `Pt bridge` marks the segment from that point to the **next**
point. Bridges are dashed orange in 2D and are **not** baked into the terrain.

Bake: samples the spline, splits it into runs at bridge segments, smooths the
height profile, flattens the corridor with a shoulder blend and stamps the road
class. One undo step. The 3D preview updates after baking.

Junction control: the editor does not write `junctions.json`. Junction styles are
decided by the loader. To force a style, place a marker within 15 m of the
junction with tag `roundabout`, `signals` or `junction_plain`, or add
`junctions.json` to the exported folder by hand.

## Road node inspector

Select a road point to edit its metadata. The header says `ROAD NODE` and how
many points are selected.

| Control | Values |
|---|---|
| Type | `country`, `city`, `highway` |
| One-way | checkbox |
| Left edge | `none`, `fence`, `guardrail`, `barrier`, `lamps` |
| Right edge | same |
| Surface | `smooth`, `worn`, `potholes`, `gravel` |
| Warn signs | `auto`, `off` |
| Features at this node | `crosswalk`, `speed bump`, `rumble`, `roadworks` |

`Type`, `One-way`, `Left/Right edge`, `Surface` and `Warn signs` are **segment**
attributes: they apply from this point to the next. Features apply at the point.
The last point's segment attributes are ignored.

- **Apply to whole road** copies the primary point's segment attributes to every
  segment.
- **From here to end** copies them from the selected point onward.
- **Auto-set type from city paint** sets a segment to `city` where its midpoint
  lies on city-class paint.

The 2D overlay shows road type as a centre stripe (cyan = city, magenta =
highway), edge objects as dashed side lines, surface dots on the centreline,
arrows for one-way, and letter badges for features. Hover a badge for a tooltip.

## Markers

Select **Marker** (`K`) and click the map, or press `Enter` with the cursor over
the map. Click a pin to select it; drag to move it, drag the arrow tip to change
yaw (`Shift` snaps to 15°). `Delete` removes the selected marker, `Escape`
deselects it.

| Field | Notes |
|---|---|
| Show markers | toggles pins in the 2D view and preview |
| filter | filters the list by name or tag |
| Name | optional; duplicates are warned about but never renamed |
| Tags | lowercase slugs; `Enter` or comma adds one; click a chip to remove |
| Quick tags | spawn, checkpoint, ramp, loop, vehicle_spawn, pickup, trigger, prop |
| Color | 12 swatches plus a colour picker |
| Yaw (deg) | 0 = +X (east), +90 = +Z (south) |
| Radius (m) | 0 = point marker, >0 = trigger area |
| Y offset (m) | added to the terrain height |
| Props | `key=value` lines, one per line |

The game queries markers by name or tag:

```js
const start = map.markerByName('player_start');
const spawns = map.getMarkers({ tag: 'spawn' });
```

Junction tags matter to the loader: `roundabout`, `signals` and
`junction_plain` force a junction style when the marker is within 15 m.

## Map settings

The **Map** section edits:

| Control | Notes |
|---|---|
| World size (m) | changes the metre scale; the grid resolution is unchanged |
| Max height (m) | changes the height scale |
| Info line | shows `N × N px` and metres per pixel |
| Drive side | `right` or `left`; warning signs stand on the driver's edge |
| Sign style | `us` (yellow diamonds) or `eu` (red-bordered triangles) |

Changing world size or max height re-renders the map and writes new values to
`map.json`. It does not resample the underlying grid.

## Undo, autosave and projects

- **Undo/redo** keeps 40 steps in memory. Terrain edits are stored as 64 px tile
  patches; road and marker edits as JSON snapshots. Undo works across tools.
- **Autosave** writes the whole project to IndexedDB every 10 seconds when the
  map has changed and no stroke is in progress. Database `terrain-editor`, object
  store `kv`, key `autosave`. On startup the editor offers to restore it with a
  blocking `confirm()`. There is no "clear autosave" button: overwrite it by
  editing, or delete the `terrain-editor` database in your browser's developer
  tools.
- **Save** (`Ctrl+S`) writes a `.tmap` project. Chromium browsers use a save
  picker; other browsers fall back to a download.
- **Open** reads a `.tmap`.

## Export

**Export** writes the nine export files into a folder:

`heightmap16.png`, `heightmap.r16`, `splat0.png`, `splat1.png`,
`biome_color.png`, `water.png`, `roads.json`, `markers.json`, `map.json`.

On Chromium browsers it opens a directory picker. Firefox and Safari fall back to
nine automatic downloads 350 ms apart. Chrome may block all but the first
automatic download, so use the folder picker there.

Copy the exported folder under `public/maps/<name>/` and open
`/play.html?map=/maps/<name>/`.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `R` / `Shift+R` | Raise / lower |
| `L` | Lower |
| `S` | Smooth |
| `F` | Flatten (`Alt+click` samples a height) |
| `M` | Mountain |
| `H` | Hills |
| `W` | Water |
| `E` | Erase water |
| `P` | Paint surface |
| `T` | Road tool |
| `K` | Marker tool (`Enter` drops a marker) |
| `V` | Pan tool |
| `G` | Toggle grid |
| `[` / `]` | Brush radius down / up |
| `{` / `}` | Brush hardness down / up |
| `Space` + drag, or middle mouse | Pan |
| Wheel | Zoom to cursor |
| `Tab` | Cycle Paint / Split / Preview |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Y`, `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` / `Cmd+S` | Save `.tmap` |
| `Delete` / `Backspace` | Delete the selected road point or marker |
| `Enter` | Finish road, or drop a marker |
| `Escape` | Close dialogs; deselect a marker |
| `F1` or `?` | Help overlay |

Shortcuts are ignored while typing in a text or number input.

## Tutorial: island, lake, forest, coast road and town

This uses only real controls and labels.

1. **New map.** Click **New**. Set Resolution `1024`, World size (m) `2000`,
   Max height (m) `200`, Sea level `0.15`, Start height `0.10`. Click
   **Create**. The whole map starts below sea level, so it is ocean.
2. **Make the island.** Choose **Raise** (`R`). Set Radius about `300`, Strength
   `0.7`, Hardness `0.3`, Falloff `smooth`. Paint a broad island in the middle
   and leave a ring of ocean around the edges. Then choose **Smooth** (`S`) with
   a large radius and low strength to soften the coastline.
3. **Add a mountain.** Choose **Mountain** (`M`). Scale `300`, Ridge sharp `2.0`,
   Amplitude `1.5`. Apply two or three strokes in one half of the island. Use
   **Hills** (`H`) with Scale `250`, Amplitude `0.6` on the other half.
4. **Carve a lake.** Choose **Water** (`W`). Bed depth `8`. Click on the terrain
   where you want the water line and drag across the basin. The lake level is the
   terrain height at the stroke start. Holding the button keeps carving. Use
   **Erase water** (`E`) if it spills too far.
5. **Paint the forest.** Choose **Paint** (`P`) and the forest swatch. Radius
   `150`, Strength `0.6`, Hardness `0.2`; paint the mountain slopes. Optionally
   set Rock slope `35`, Snow height `0.75`, Sand band `0.03` and click
   **Auto-paint now** to fill the remaining pure grass with rock, snow and beach.
6. **Draw the coast road.** Choose **Road** (`T`), Width `10`. Click waypoints
   along the coast. To cross the lake or a river, draw the road straight across
   the water: on load, any non-bridge stretch below `water + 0.3 m` becomes an
   automatic bridge with graded ramps. If you want a bridge on dry ground, select
   a point and tick **Pt bridge** (the segment to the next point is elevated).
   Press `Enter` to finish. Use **Bake roads into terrain** for the dry
   segments; bridge segments are not baked.
7. **Make a town.** Draw two or three roads that cross. Select a point on each
   town road and set **Type** to `city`, then click **Apply to whole road**.
   Junctions with three or more arms and at least one city arm become signalised
   automatically. To force a roundabout on a crossing, choose **Marker** (`K`),
   click at the junction, add the tag `roundabout`, and export.
8. **Add a spawn.** With the Marker tool, click a flat grass spot, set Name to
   `player_start`, add the tag `spawn`, set Yaw to face the coast, and set Colour
   to something visible.
9. **Export.** Click **Export** and choose an empty folder (Chromium). Confirm
   nine files were written. Copy the folder to `public/maps/island/`.
10. **Drive it.** Open `/play.html?map=/maps/island/`. The game spawns at
    `player_start` if it exists. Press `R` to reset if the car lands badly.
11. **Save the project.** Press `Ctrl+S` and save `island.tmap` so you can reopen
    the editable project later.

Junctions and their overrides are loader-side: the editor does not write
`junctions.json`. Use markers for roundabout/signals/junction_plain overrides, or
add the JSON file by hand after export. See
[roads-and-junctions.md](roads-and-junctions.md) for the rules.
