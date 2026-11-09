# Loader API

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

How to use `src/world/*` in your own Three.js + Rapier project, and how to run it
headless in Node. The loader never imports Three.js or Rapier itself: you pass
both in, so the game owns the single instance of each.

## Contents

- [Files and dependencies](#files-and-dependencies)
- [Rapier initialisation](#rapier-initialisation)
- [Minimal page](#minimal-page)
- [loadMap and loadMapFromData](#loadmap-and-loadmapfromdata)
- [Options](#options)
- [Returned map object](#returned-map-object)
- [Sampling the world](#sampling-the-world)
- [Roads, junctions and markers](#roads-junctions-and-markers)
- [Live editing](#live-editing)
- [Headless Node](#headless-node)
- [Performance notes](#performance-notes)

## Files and dependencies

Copy these files, keeping the directory structure:

| File | Purpose |
|---|---|
| `src/world/mapLoader.js` | PNG/`.r16` decoding, heightfield, terrain/water meshes, public API |
| `src/world/roads.js` | junction detection, terrain stamping, road/bridge/roundabout meshes |
| `src/world/roadMeta.js` | enums, defaults, node/map metadata parsing (pure data) |
| `src/world/roadEdges.js` | fences, guardrails, barriers, lamps, bumps, rumble, roadworks |
| `src/world/roadSigns.js` | automatic warning signs and sign detection |
| `src/world/roadCity.js` | city corridors, kerbs, footpaths, corner blocks, crosswalks |
| `src/world/roadSignals.js` | signal posts, zebra crossings, phase cycle |
| `src/world/roadBridges.js` | automatic bridges over water |
| `src/world/roadGeo.js` | shared geometry helpers (instancing, part merging) |

`src/world/sceneEnv.js` (renderer, sky, fog) and `src/world/markerPins.js`
(canvas marker labels) are browser helpers; the loader does not need them.

Dependencies: `three` 0.187.0 and `@dimforge/rapier3d-compat` 0.21.0. The loader
works without Rapier if you pass `physics: false` or omit `physicsWorld`.

## Rapier initialisation

Use the compat build and await its WASM init before creating a world:

```js
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
```

With Vite, add `optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] }` (the
project's `vite.config.js` does this) so pre-bundling does not mangle top-level
`await`.

## Minimal page

The smallest working page is in
[examples/minimal-viewer.html](examples/minimal-viewer.html) and
[examples/minimal-viewer.js](examples/minimal-viewer.js). Run `npm run dev` and
open `/docs/examples/minimal-viewer.html?map=/maps/sample/`. The essential part:

```js
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap } from '/src/world/mapLoader.js';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

const map = await loadMap('/maps/sample/', {
  THREE,
  RAPIER,
  physicsWorld: world,
});

const scene = new THREE.Scene();
scene.add(map.group);
```

`loadMap` fetches `map.json` from `baseUrl`, then every file named in
`map.json.files`, plus optional `junctions.json` and `markers.json`. The URL
needs a trailing slash (one is added if missing).

## loadMap and loadMapFromData

```js
const map = await loadMap(baseUrl, opts);       // fetch + decode + build
const map = loadMapFromData(data, opts);        // synchronous, in-memory build
```

`loadMapFromData({ info, height, splat0, splat1, water, roads, junctions?, markers? }, opts)`

| Data field | Type | Notes |
|---|---|---|
| `info` | object | `map.json` shape; `N`, `worldSizeMeters`, `maxHeightMeters`, `seaLevelMeters`, 8 `classes` |
| `height` | `Uint16Array(N*N)` | raw 0..65535, as in `.r16` |
| `splat0`, `splat1` | `Uint8Array(N*N*4)` | RGBA8 class weights |
| `water` | `Uint16Array(N*N)` | 0 = none, `v → (v-1)/65534 * maxHeight` |
| `roads` | object | `{ roads: [...] }` |
| `junctions` | array, optional | `[{ x, z, style, radius? }]` |
| `markers` | object, optional | `{ version, markers: [...] }` |

The arrays are copied, so you can keep editing your own buffers. This is the
path the editor's live 3D preview uses (`physics: false`).

## Options

| Option | Default | Meaning |
|---|---|---|
| `THREE` | required | Three.js namespace |
| `RAPIER` | required with `physicsWorld` | Rapier namespace |
| `physicsWorld` | `undefined` | Rapier `World`; without it no terrain/bridge collider is built |
| `physics` | `true` | `false` forces no colliders even if `physicsWorld` is given |
| `physicsResolution` | `512` | heightfield samples per side, clamped 2..4096 |
| `chunkSize` | `128` | target terrain chunk edge in cells |
| `autoBridge` | `true` | `false` disables automatic bridges (roads drape on the terrain) |

`driveSide` and `signStyle` come from `map.json`, not from options.

## Returned map object

| Member | Type / signature | Units / notes |
|---|---|---|
| `map.group` | `THREE.Group` | terrain, lakes, ocean and roads |
| `map.info` | object | `worldSize`, `maxHeight`, `seaLevel` (metres), `seaLevelNormalized`, `N`, `cellSize`, `classes`, `chunks`, `chunkCells`, `loadMs`, `driveSide`, `signStyle` |
| `map.heightAt(x, z)` | number | metres, bilinear over pixel-centre samples |
| `map.normalAt(x, z, out?)` | `THREE.Vector3` | unit surface normal (central differences) |
| `map.surfaceAt(x, z)` | object | see below |
| `map.waterLevelAt(x, z)` | number \| null | lake level if above terrain, else sea level if below it |
| `map.isUnderwater(x, z, y)` | boolean | `y < waterLevelAt` |
| `map.roads` | array | road objects, below |
| `map.junctions` | array | junction objects, below |
| `map.markers` | array | markers with `y` recomputed |
| `map.getMarkers({tag?, name?})` | array | filters are ANDed; `undefined` means no filter |
| `map.markerByName(name)` | marker \| null | |
| `map.roadDetail` | object | what the road builder generated |
| `map.update(dt)` | void | advances the signal clock (seconds) |
| `map.signalState(group)` | `'green' \| 'amber' \| 'red'` | phase group 0 or 1 |
| `map.updateRegion(rect, data)` | object | live edit, see below |
| `map.flush()` | void | run the debounced road rebuild now |
| `map.setSeaLevel(metres)` | void | move the ocean and rebuild roads after 300 ms |
| `map.dispose()` | void | remove colliders, dispose geometry/material, detach group |
| `map.parts` | object | `terrain`, `lakes`, `ocean`, `material`, `waterMaterial`, `roadMesh`, `roadGroup`, `roadEdges`, `roadProps`, `roadSigns` |
| `map.physics` | object \| null | `{ collider, resolution, heights }` |
| `map.SURFACE_FRICTION` | array | same as the module export |
| `map.onRebuild` | callback | assign to be notified after a debounced road rebuild |

### surfaceAt

```js
{
  classId,        // 0..7, strongest class at this point
  weights,        // Float32Array(8), values sum to about 1
  roadSurface,    // null | 'smooth' | 'worn' | 'potholes' | 'gravel' | 'footpath'
  roughness,      // 0 smooth .. 1 very rough (includes rumble strips)
  gripMul,        // multiplies tyre grip
}
```

On asphalt or gravel the road wins analytically: `classId` is 6 and
`roadSurface` is the road surface name. On a city footpath or corner block:
`classId` is 7, `roadSurface` is `'footpath'`, roughness 0, grip 1. Elsewhere
`classId` is the strongest non-road splat class.

| Class | Surface | Friction |
|---|---|---|
| 0 | grass | 0.8 |
| 1 | forest | 0.8 |
| 2 | dirt | 0.7 |
| 3 | sand | 0.5 |
| 4 | rock | 0.9 |
| 5 | snow | 0.3 |
| 6 | road | 1.0 |
| 7 | city | 1.0 |

| Road surface | Roughness | gripMul |
|---|---|---|
| smooth | 0 | 1.0 |
| worn | 0.2 | 0.95 |
| potholes | 0.6 | 0.9 |
| gravel | 0.5 | 0.7 |

Rumble-strip zones raise roughness to 0.45. These values are read per wheel by
the vehicle; see [vehicles-and-cars.md](vehicles-and-cars.md).

## Roads, junctions and markers

### Road object

`map.roads[i]` has:

| Member | Meaning |
|---|---|
| `id`, `width` | from `roads.json` |
| `points[j]` | control point `{x,y,z,bridge,type,oneway,edgeL,edgeR,surface,signs,features}` with defaults filled in |
| `sample(t)` | one point, `t` uniform in control-point index over `[0,1]` |
| `getPoints(spacingMeters)` | samples about `spacingMeters` apart (never fewer than 2 per segment) |
| `setDeck({u,y,mod,auto})` | internal, used by automatic bridges |
| `autoBridges` | spans created for this road |

A sample is `{x,y,z,bridge,auto,seg,tx,tz,u}`: unit horizontal tangent `tx,tz`,
control-point index `seg`, and `u = seg + f`.

### Junction object

```js
{
  x, z, y,
  style,        // 'junction' | 'roundabout' | 'signals'
  radius,       // patch or outer roundabout radius in metres
  arms: [{ roadId, angle, width, type }],
  source,       // 'default' | 'marker' | 'json'
  signals: [{ x, y, z, roadId, group, fx, fz }],
}
```

`signals` is filled after the road mesh build. Signal heads are visual only; use
`map.signalState(group)` to read the cycle if you implement traffic.

### roadDetail

`map.roadDetail` inventories what was generated:

```js
{ signs[], edgePieces[], colliderBoxes, lamps[], features[],
  footpaths[], cornerBlocks[], zebras[], crosswalkSigns[], signals[],
  autoBridges[], autoBridgeSkipped[],
  drawCalls, counts{ ... } }
```

`counts` includes `signs`, `edgeInstances`, `pieces`, `colliders`, `features`,
`footpathPieces`, `footpathColliders`, `cornerBlocks`, `zebras`,
`crosswalkSigns`, `signalPosts`, `signalRails`, `signalColliders`,
`autoBridges`.

### Markers

Each marker has `{id, name, tags, color, x, z, nx, nz, y, yOffset, yaw, radius,
props}`. `y` is always recomputed as `heightAt(x,z) + yOffset`; the file's `y` is
ignored. `yaw` is in degrees, 0 = +X, +90 = +Z.

```js
const spawns = map.getMarkers({ tag: 'spawn' });
const start = map.markerByName('player_start');
```

## Live editing

`updateRegion(rect, data)` updates part of the world without rebuilding
everything. `rect` is in **map pixels**, `{x0,y0,x1,y1}` with `x1,y1` exclusive.
The data arrays are full-size; only the rectangle is read.

```js
map.updateRegion(
  { x0: 100, y0: 100, x1: 200, y1: 200 },
  { height, splat, water, roads, markers }
);
```

It returns `{height, splat, water, roads, markers}` booleans describing what
changed. Terrain chunks overlapping the rect are recomputed, splat textures are
re-uploaded, the lake mesh is rebuilt only if water changed, and road/junction/
bridge meshes are rebuilt on a 300 ms debounce when roads or heights under roads
change. Call `map.flush()` to rebuild immediately.

`updateRegion` does **not** update the Rapier heightfield. If you need live
physics edits, rebuild the collider yourself or call `dispose()` and reload.

`setSeaLevel(metres)` moves the ocean plane and schedules a road rebuild, because
the ocean decides which road stretches are automatically bridged.

`dispose()` removes the heightfield collider, all road colliders, disposes
geometry and materials, and detaches the group. It is idempotent.

## Headless Node

The loader runs in Node without a browser. Provide `fetch` (Node has a global
`fetch`, but it cannot read `public/` paths), so shim it to the disk:

```js
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadMap } from './src/world/mapLoader.js';

const dir = path.resolve('public/maps/sample');
globalThis.fetch = async (url) => {
  const file = path.join(dir, path.basename(url));
  return fs.existsSync(file)
    ? new Response(fs.readFileSync(file))
    : new Response(null, { status: 404 });
};

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const map = await loadMap('/maps/sample/', {
  THREE,
  RAPIER,
  physicsWorld: world,
});
```

For tests and tools that do not need colliders, use
`loadMapFromData(data, { THREE, physics: false })`. Three.js geometry, materials
and `DataTexture` work in Node; only `WebGLRenderer` and DOM helpers need a
browser. See `scripts/test-loader.mjs` for a complete harness.

## Performance notes

- Terrain is split into chunks of about `chunkSize` cells. At `N=1024` that is 81
  chunks; at `N=2048`, 289 chunks. Chunks share an index buffer per shape.
- There is no LOD. Every chunk is full resolution: `2 * (N+1)^2` triangles, about
  8.4 million at `N=2048`.
- The physics collider is a separate Rapier heightfield with `physicsResolution`
  samples per side (default 512). The game uses 1024. Raising it improves collider
  agreement with `heightAt` and costs memory/build time.
- Lakes are one un-chunked mesh; the ocean is one large flat plane.
- `map.info.loadMs` breaks the load into `fetchDecode`, `prep`, `terrainMesh`,
  `water`, `physics`, `roads`, `total`.
