# Vehicles and cars

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

The car pipeline, the garage, the handling profiles and the tuning panel.

## Contents

- [Source and pipeline](#source-and-pipeline)
- [Asset conventions](#asset-conventions)
- [cars.json](#carsjson)
- [Garage and spritesheet](#garage-and-spritesheet)
- [Adding a car](#adding-a-car)
- [Handling archetypes](#handling-archetypes)
- [Per-wheel surfaces and road grip](#per-wheel-surfaces-and-road-grip)
- [Camera and free look](#camera-and-free-look)
- [Tests](#tests)
- [Licensing](#licensing)

## Source and pipeline

Source FBX files live in `public/models/Cars/`. Run:

```bash
npm run cars
```

This calls `scripts/cars/run.mjs`, which runs Blender twice in background mode:

1. `scripts/cars/convert.py <src> <out>` — FBX → GLB, writing
   `public/cars/<id>.glb` and updating `public/cars/cars.json`.
2. `scripts/cars/render_sheet.py <out>` — renders each GLB into
   `public/cars/previews.png` (and `.webp`) and records sprite cells.

Configuration in `scripts/cars/config.json`:

| Field | Meaning |
|---|---|
| `blender` | path to the Blender executable (override with `BLENDER`) |
| `src` | source folder (override with `CARS_SRC`) |
| `out` | output folder (override with `CARS_OUT`) |
| `credits` | string copied onto every car; currently `null` |
| `overrides` | per-car `{ name?, drivable?, roles? }` |

`convert.py` skips source names matching `lod`, `damaged`, `destroyed`, `broken`,
`wreck` or `dmg`, dedupes ids, preserves an existing `sprite` cell, and sorts cars
by name.

## Asset conventions

These are the contract between Blender and the game (glTF space, what Three.js
sees):

| Convention | Value |
|---|---|
| Up axis | +Y, metres |
| Car forward | **+Z** |
| Left | **+X** (as seen from behind); right is −X |
| Origin | ground level (y = 0 at the lowest wheel point), centred on the wheelbase and track |
| Body | one node named `body`, all non-wheel meshes joined, origin (0,0,0) |
| Wheels | nodes `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr` |
| Wheel pivot | node origin at the hub centre; axle = local **X**, so `rotation.x` spins it in place |
| Extra wheels | `wheel_rl2`, `wheel_rr2`, ... listed under `extraWheels` |
| Materials | kept; textures embedded, downscaled to at most 1024 px |
| Transforms | applied; no cameras, lights or empties |

`convert.py` detects the facing direction from `headlight` / `rear light`
materials, then from wheel names, then from Blender −Y = glTF +Z. It rescales by
powers of ten until the longer horizontal side is 1.5–30 m. If fewer than four
wheels are separate parts, it tries to split round loose parts at the lowest
corners. `drivable` is true when four corner wheels exist and the config does not
override it.

Multi-axle vehicles keep their extra wheels as children of the car and reuse a
source wheel's spin and suspension (no steering on extras).

## cars.json

`public/cars/cars.json` is the manifest the game loads.

```json
{
  "version": 1,
  "cars": [
    {
      "id": "sports",
      "name": "Sports",
      "glb": "/cars/sports.glb",
      "drivable": true,
      "dimensions": { "length": 4.2, "width": 1.9, "height": 1.2 },
      "wheelRadius": 0.33,
      "wheelbase": 2.5,
      "trackWidth": 1.6,
      "wheels": { "fl": [0.8, 0.33, 1.25], "fr": [-0.8, 0.33, 1.25], "rl": [0.8, 0.33, -1.25], "rr": [-0.8, 0.33, -1.25] },
      "extraWheels": [],
      "triangles": 9000,
      "roles": ["player", "static"],
      "credits": null,
      "sprite": { "col": 0, "row": 0 }
    }
  ],
  "sheet": { "url": "/cars/previews.png", "cellW": 256, "cellH": 160, "cols": 8, "rows": 3, "width": 2048, "height": 480, "urlWebp": "/cars/previews.webp" }
}
```

| Field | Used by |
|---|---|
| `id`, `name` | garage, HUD, lookup |
| `glb` | game loader |
| `drivable` | garage filter, game selection |
| `dimensions` | vehicle mass estimate, chase camera |
| `wheelRadius`, `wheelbase`, `trackWidth`, `wheels` | wheel setup |
| `extraWheels` | extra axle binding |
| `triangles` | garage card |
| `roles` | `player` or `static` |
| `credits` | currently `null` for every car |
| `sprite` | garage spritesheet cell |

There are 21 cars, 20 drivable. `truck-with-trailer` is static.

## Garage and spritesheet

Open `/garage.html`. The page lists cars as cards with a Drivable/Static badge,
a CSS sprite crop, the name, length and triangle count, and filters All/Drivable.
The Drive link goes to `/play.html?car=<id>`.

The choice is stored in `localStorage` under `monsterMash.selectedCar`. The game
uses `?car=` first, then that value, then the first drivable car.

`render_sheet.py` renders each car from front-left with an orthographic camera
and a blob shadow, 256×160 cells at 2× supersampling, up to 8 columns and a
2048 px sheet. It rewrites the `sheet` block and each car's `sprite` cell.

## Adding a car

1. Put `mycar.fbx` in `public/models/Cars/`.
2. Name the wheel objects so they contain `wheel`; or rely on the loose-part
   splitter. Make sure the car faces the intended direction (headlight material
   names help detection).
3. Optionally add `public/models/Cars/license.txt` or set `credits` in
   `scripts/cars/config.json`; `convert.py` scans the source folder for a
   licence/readme/credit file.
4. Run `npm run cars` with Blender installed.
5. Check the new entry in `public/cars/cars.json`. If `drivable` is false, the
   wheel split or facing detection failed.
6. To give it bespoke handling, add an override in `src/vehicles/handling.js`
   under `CAR_OVERRIDES` (see below).

## Handling archetypes

`src/vehicles/handling.js` holds plain data. Each car maps to one of seven
archetypes via `CAR_ARCHETYPE`:

| Archetype | Feel | 0–100 km/h | Top speed |
|---|---|---|---|
| `sports` | light, low, grippy, quick steering | 4–5 s | 200+ km/h |
| `muscle` | RWD wheelspin, oversteer, easy drift | 5–6 s | ~190 km/h |
| `sedan` | balanced, forgiving | 8–10 s | ~160 km/h |
| `suv` | AWD, long travel, body roll, off-road | 9–12 s | ~140–150 km/h |
| `van` | heavy, understeer, roll; also limo/fire truck | 12–16 s | ~130–150 km/h |
| `bus` | heaviest and longest, wide circle | 16–22 s | 100–110 km/h |
| `monster` | huge travel, AWD + rear steer, top-heavy, climbs | 6–9 s | ~120 km/h |

Parameter groups (all SI unless named otherwise):

| Group | Keys | Meaning |
|---|---|---|
| Mass | `density`, `mass?` | mass from bounding-box volume, or an explicit kg override |
| Balance | `comFrac`, `comZ`, `inertia{pitch,yaw,roll}` | centre-of-mass height and offset; inertia multipliers |
| Drive | `drive`, `frontBias`, `launchAccel`, `kneeKmh` | FWD/RWD/AWD, front share, tractive acceleration, constant-force knee |
| Speed | `topSpeed`, `reverseKmh`, `gears` | soft limiter over the last 6%; fake gearbox for the HUD |
| Brakes | `brakeG`, `handbrakeG`, `handbrakeSlip` | service brake, rear handbrake, rear grip cut |
| Steering | `steerMaxDeg`, `steerSpeedKmh`, `steerMinFrac`, `steerRate`, `steerReturn`, `rearSteer`, `steerGrip` | lock, speed fade, rate, rear steer, understeer cap |
| Suspension | `suspRest`, `suspTravel`, `suspStiffness`, `suspCompression`, `suspRelaxation`, `suspMaxForceX` | droop, travel, spring rate, damping ratios, force cap |
| Tyres | `gripFront`, `gripRear`, `sideStiff`, `antiRoll` | friction, Rapier side stiffness, stabiliser |
| Body | `leanRoll`, `leanPitch`, `tipDeg`, `tipPitchDeg`, `downforce` | visual lean, anti-rollover thresholds, downforce |
| Air | `airControl`, `selfRight` (assist) | angular acceleration in the air |
| Surfaces | `offRoad`, `roughResponse` | soft-surface loss softening, jolt strength |
| Assist | `assist`, `angDamp`, `linDamp`, `maxAngVel` | arcade assist, damping, yaw-rate clamp |

`resolveProfile(car)` deep-clones the archetype, merges `CAR_OVERRIDES[car.id]`,
and derives `mass`, `comZ` and `reverseKmh`. Current overrides cover hatchback,
roadster, muscle-2, pickup, truck, ambulance, limousine and firetruck.

`ASSIST` gains: yaw damping 2.2, slide grip 2.6, slide max accel 4.5, self-right
4.0, tip gain 90, tip damping 5, anti-roll boost 0.4. `assist: 0` is raw physics.

### Tuning panel

Press `` ` `` or `F1` in the game. The panel groups Engine+brakes, Mass+balance,
Steering, Suspension, Tyres, Body+stability+air and Camera. Every slider writes
through to the live vehicle. **Copy profile JSON** prints exactly the differences
from the resolved base, in `CAR_OVERRIDES` shape:

```js
{
  "sports": {
    "gripRear": 1.9,
    "launchAccel": 7.0
  }
}
```

Paste it into `CAR_OVERRIDES` in `src/vehicles/handling.js`. **Reset to
defaults** re-resolves the profile.

Camera settings (sensitivity, invert Y, idle delay, shake) are saved to
`localStorage` under `monster-mash.camera`.

## Per-wheel surfaces and road grip

Every physics step, each wheel in contact queries `map.surfaceAt(x,z)`. If the
contact is more than `DECK_H = 0.8 m` above `map.heightAt`, it is treated as a
bridge deck and uses a smooth pseudo-surface instead of the ground below.

Soft-surface grip:

```text
classMult = clamp(1 - (1 - SURFACE_FRICTION[classId]) / offRoad, 0.2, 1.15)
soft      = classMult  (sand/snow drag scales with the loss squared)
road      = 1 - (1 - gripMul) / max(offRoad, 1)
```

`classMult` is 1 on every road class; the road factor applies the map's
`gripMul` (gravel 0.7, potholes 0.9, worn 0.95) and is softened, never doubled,
by `offRoad`. It scales engine force, braking and tyre friction, so gravel costs
drive as well as grip.

Roughness adds a vertical impulse per wheel:

```text
kick = clamp(2.0 * roughness * roughResponse * min(speed / 80 km/h, 1.5) * noise(x,z), ±0.6)
impulse = kick * wheelLoad * dt
```

`roughness` comes from the map's `surfaceAt`; the noise is deterministic on
~1.5 m cells. The same signal drives low-passed camera shake. Soft or heavy
vehicles set low `roughResponse` (bus 0.4, monster 0.3) and absorb potholes
better; the tests assert this.

## Camera and free look

`C` toggles chase and hood cameras.

- Chase distance `max(6.5, length * 1.15 + 3.2)`, height `height * 0.75 + 1.6`.
- Hood camera sits on the interpolated body, FOV +10° at speed.
- The chase heading follows the chassis yaw, blending 45% toward the velocity
  direction when the car is drifting.
- Critically damped position/look springs; vertical damping is slower so bumps
  do not shake the view. `smoothDamp` smooth time 0.12 s, 0.22 s vertical.
- Ground clamp: camera never below `heightAt + 1.2 m`.
- FOV `62 + 14 * speedFraction`.

Free look (`cameraLook.js`, pure maths and tested headless):

| Setting | Default |
|---|---|
| sensitivity | 0.0022 rad/px |
| pitch range | −15° .. +45° |
| invert Y | false |
| idle delay | 1.7 s |
| recentre | 0 below 2 m/s, ramping to 3/s at 25 m/s |
| shake | 0.05 m |

Mouse movement cancels recentre and restarts the delay. Holding `B` eases the
view to 180°. A deflected right stick suppresses recentre.

## Tests

`npm run test:vehicles` (add `-- --quick`, `--cars a,b`, `--road-only` or
`--smoke-only`) runs the real Rapier vehicle headless. It measures:

- 0–100 km/h, top speed, 100→0 braking, turning circle, roll and lateral g.
- Cornering speed on a 30 m circle, drops, a 30° climb, slope parking, flick
  stability and rest jitter.
- Camera pitch clamp, invert, 360° yaw wrap, recentre timing and speed, look
  behind, ground clamping.
- Road surfaces: gravel braking and acceleration, pothole RMS, no launch, camera
  shake, parked jitter, grip formula, and the bridge-deck rule.
- Bands per archetype (acceleration, top speed, turning circle, rolls, climbing)
  and per-car robustness (no NaN, no explosion, no flip, stable drop and park).

The test uses the real `cars.json` and GLB bounds, a synthetic flat map, and the
`surfaceAt`/`heightAt` values the loader produces. The quick run covers every
car and takes about 33 s on the reference machine.

## Licensing

The repo has no `LICENSE` file. The Kenney UI pack is credited as CC0 in source
comments. The **car pack has no licence or credit statement** in the repository:
`public/models/Cars/` contains only FBX files, `scripts/cars/config.json` sets
`"credits": null`, and every manifest entry has `"credits": null`. Confirm the
car pack's terms with its source and add credits before distributing. Do not
assume a licence.
