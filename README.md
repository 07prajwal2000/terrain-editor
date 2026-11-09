# Monster Mash

An open-world offroad and stunt driving game that runs in the browser, with a
built-in terrain map editor and a documented export format. Build a map in
`editor.html`, export it as a folder, and drive it in `play.html`.

Vite + Three.js + Rapier, plain JavaScript ES modules, no build step beyond Vite.

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

## Features

- Terrain sculpting on 512, 1024 or 2048 grids: raise/lower/smooth/flatten,
  procedural mountains and hills, lakes and rivers, sea level, eight surface
  classes with automatic slope/height painting.
- Road network with per-segment metadata: country, city and highway types,
  one-way roads, fences/guardrails/barriers/lamps, four surface looks, warning
  signs, and point features (crosswalk, speed bump, rumble strip, roadworks).
- Automatic junction detection: T/Y junctions, roundabouts, signalised city
  crossings, self-crossing roads, marker and `junctions.json` overrides.
- Automatic bridges where a road crosses below water, with graded approach ramps.
- Markers with names, tags, colours, yaw, radius and free-form props for spawns
  and triggers.
- Rapier physics, 21 cars (20 drivable), seven handling archetypes, per-wheel
  surface friction, a tuning panel and a garage with a rendered car sheet.
- Free-look chase/hood cameras, gamepad support, HUD.

## Quick start

```bash
npm install
npm run dev
```

Vite serves on `http://127.0.0.1:5173`. Open:

| URL | What it is |
|---|---|
| `/editor.html` | terrain and road editor with a live 3D preview |
| `/play.html` | the game; `?map=/maps/sample/&car=sports` |
| `/garage.html` | car selection; stores the choice in `localStorage` |
| `/index.html` | developer map viewer with debug toggles and collider views |

Useful query parameters on `play.html`:

| Parameter | Example | Meaning |
|---|---|---|
| `map` | `?map=/maps/citytest/` | map folder to load (default `/maps/sample/`) |
| `car` | `?car=monster-truck` | car id from `public/cars/cars.json` |
| `spawn` | `?spawn=250,250,90` | spawn at `x,z` with yaw in degrees |
| `testRamp` | `?testRamp` | adds a test wedge near the spawn |

The map viewer uses `?map=` too.

## Driving controls

| Input | Action |
|---|---|
| `W` / `↑` | throttle |
| `S` / `↓` | brake, then reverse |
| `A` `D` / `←` `→` | steer (`D`/right = right) |
| `Space` | handbrake |
| `Q` / `E` | yaw in the air |
| `W` `S` `A` `D` | pitch/roll in the air |
| `R` | reset car |
| `C` | switch chase / hood camera |
| `B` (hold) | look behind |
| Mouse | free look (click the canvas for pointer lock); never steers |
| `` ` `` or `F1` | tuning panel |
| Gamepad | RT throttle, LT brake, left stick steer, A handbrake, Y reset, X camera, LB/RB yaw, right stick look, R3 look behind |

## Repository layout

```text
monster-mash/
  index.html          developer map viewer (src/main.js)
  editor.html         terrain/road editor shell (src/editor/editor.js)
  garage.html         car selection page (src/garage/garage.js)
  play.html           the game page (src/game/main.js)
  src/
    editor/           editor state, brushes, export, 3D preview
    game/             game bootstrap and fixed-step loop
    garage/           garage UI
    ui/               shared CSS and UI sound helper
    vehicles/         vehicle physics, handling profiles, cameras, HUD, input
    world/            map loader, roads, junctions, bridges, signs, scene env
    main.js           dev viewer
  public/
    maps/             sample maps: sample, sample2, junctions, citytest, roadmeta
    cars/             cars.json, GLB cars, preview sheet
    models/Cars/      source FBX files for the car pipeline
    ui/               Kenney UI assets (SVG, font, sounds)
  scripts/            test suites, map generators, FBX to GLB pipeline
  tools/              older single-file editor copy
  docs/               documentation and tested examples
  vite.config.js
  package.json
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | start the Vite dev server |
| `npm run build` | production build of the four HTML pages |
| `npm run test:loader` | map loader, PNG/`.r16`, colliders, live edits |
| `npm run test:roads` | signs, edges, features, surfaces, back-compat |
| `npm run test:city` | junction styles, self-meetings, city/road stamping |
| `npm run test:bridges` | automatic bridges over lakes, rivers and the ocean |
| `npm run test:vehicles` | car physics, handling bands, cameras, road surfaces |
| `npm run city-map` | regenerate `public/maps/citytest/` from `junctions/` |
| `npm run cars` | Blender FBX → GLB + preview sheet (needs Blender) |

There is no aggregate `test` script. The Node suites run the loader headless.

## Browser requirements

- A WebGL2 browser (current Chrome, Edge, Firefox or Safari).
- The **folder-picker export** uses `showDirectoryPicker`, which is Chromium-only
  (Chrome, Edge, Opera). Elsewhere the editor falls back to nine `<a download>`
  clicks; Chrome can block all but the first automatic download, so use the
  folder picker there.
- The editor and game must be served over HTTP (the dev server or a built site).
  Opening the HTML files with `file://` fails because they use ES modules.

## What is built vs planned

| Built | Planned, not implemented |
|---|---|
| Terrain, splat surfaces, lakes, ocean, sea level | Forest/rock/grass scatter |
| Country, city and highway road types and metadata | City building fill and street props |
| Junction detection, roundabouts, signalised junctions | Real ground textures (terrain uses flat class colours) |
| Automatic bridges over water | Stunt ramps and loops |
| Warning signs, edges, crosswalks, bumps, rumble strips, roadworks | Edge walls at the map border |
| Markers and `.tmap` projects | Traffic and AI |
| 21 cars, garage, handling archetypes, tuning panel | Skid marks, dust, engine sound, damage |
| Rapier vehicle physics, cameras, HUD, gamepad | |

## Known limitations

- No LOD: a 2048² terrain is about 8.4 million triangles. 512–1024 is comfortable;
  2048 is usable but heavy.
- The lake mesh is one un-chunked mesh; the ocean is a flat plane.
- Junction road markings are capped at 32 junctions (dashes still render beyond
  that, but the junction mask does not).
- Bridge rails and pillars, and roadwork cones, have no colliders. The bridge deck
  itself is solid.
- Potholes are a shader look plus a roughness value, not geometry.
- The traffic-signal cycle is visual only; there is no traffic.
- `.r16` assumes a little-endian host.
- The editor's vertical exaggeration also stretches marker pins.
- Autosave restore uses a blocking `confirm()`.
- Very large brush radii on a 2048² map are slow; this has not been benchmarked.

## Documentation

| Page | Contents |
|---|---|
| [docs/editor-guide.md](docs/editor-guide.md) | task-oriented editor guide and tutorial |
| [docs/file-formats.md](docs/file-formats.md) | exact export and `.tmap` reference |
| [docs/loader-api.md](docs/loader-api.md) | embedding the loader in Three.js + Rapier |
| [docs/roads-and-junctions.md](docs/roads-and-junctions.md) | road metadata, junctions, bridges, signs |
| [docs/migration.md](docs/migration.md) | porting a map to Unity, Unreal, Godot, Blender, Babylon |
| [docs/vehicles-and-cars.md](docs/vehicles-and-cars.md) | car pipeline, handling, garage, tuning |
| [docs/architecture-and-testing.md](docs/architecture-and-testing.md) | module map, data flow, tests, extending |
| [docs/faq-troubleshooting.md](docs/faq-troubleshooting.md) | common problems and fixes |
| [docs/examples/](docs/examples/) | small tested readers and converters |

## Credits and licence

The repository contains **no `LICENSE` file**, so the project's own licence is
undecided and must be set by the owner. Do not assume one.

- The shared UI look uses the **Kenney UI pack** in `public/ui/`; the comments in
  `src/ui/ui.css` and `src/ui/sfx.js` identify it as CC0.
- The car models in `public/models/Cars/` and `public/cars/` have **no licence or
  credit statement** in the repository, and `scripts/cars/config.json` sets
  `"credits": null`. Confirm the car pack's terms and add credits before
  distributing.
- Runtime dependencies: `three` (MIT), `@dimforge/rapier3d-compat` (Apache-2.0),
  `vite` (MIT). Their licences live in `node_modules`.
