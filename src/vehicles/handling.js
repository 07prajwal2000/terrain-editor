// Handling profiles: one table of archetypes + per-car overrides, resolved against the car manifest (public/cars/cars.json).
//
//   resolveProfile(car)  ->  flat profile object (all SI units unless a name says otherwise) consumed by Vehicle.js
//   profile = ARCHETYPES[CAR_ARCHETYPE[car.id]]  +  CAR_OVERRIDES[car.id]  +  values derived from the manifest
//   (dimensions -> mass via `density`, COM height via `comFrac`; wheelbase/track/wheel radius are read straight from the manifest by Vehicle.js).
//
// TARGET NUMBERS (what scripts/test-vehicles.mjs prints and checks, flat tarmac; "approx" = the test uses tolerance bands):
//   archetype         0-100 km/h   top speed   min turning circle (dia, low speed)   feel
//   sports            4-5 s        200+ km/h   ~11 m                                  light, low COM, grippy, stiff, quick steering, little roll, hates sand/dirt
//   muscle            5-6 s        ~190        ~12 m                                  RWD wheelspin + oversteer, easy to drift, heavier than sports
//   sedan             8-10 s       ~160        ~12 m                                  balanced, forgiving
//   suv / pickup      9-12 s       ~140-150    ~13 m                                  AWD, long travel, higher COM, body roll, good off-road
//   van / ambulance   12-15 s      ~130-140    ~15 m                                  heavy, understeer, roll, inertia
//   limousine         12-16 s      ~150        18+ m                                  van-like but extremely long (wide circle)
//   firetruck         14-18 s      ~115        ~18 m                                  very heavy
//   bus               16-22 s      100-110     20+ m                                  heaviest + longest, wide circle, stable in a line, heavy roll
//   monster truck     6-9 s        ~120        14-16 m                                huge soft travel (0.6 m), AWD + rear steer, top-heavy, climbs anything
//
// UNITS / SEMANTICS (every key below):
//   density        kg per m^3 of the manifest bounding box (length*width*height) -> mass. Override with `mass` (kg) per car if you like.
//   comFrac        centre of mass height = comFrac * car height (m above the ground between the axles). comZ = metres forward of the origin.
//   inertia        {pitch,yaw,roll} multipliers on the box inertia (m/12 * (a^2+b^2)); >1 = sluggish rotation.
//   drive          'FWD' | 'RWD' | 'AWD' ; frontBias = front share of the force when AWD.
//   launchAccel    m/s^2 of tractive acceleration at standstill (engine force = mass * launchAccel, then limited by tyre grip).
//   kneeKmh        speed up to which that force is constant; above it force falls like 1/v (constant power).
//   topSpeed       km/h, force fades to 0 over the last 6 percent (soft limiter). Drag is derived from it (see Vehicle.js), so heavy things coast sensibly.
//   reverseKmh     max reverse speed. gears: fake gearbox, HUD only.
//   brakeG         service brake in g (tyre-limited). handbrakeG: rear-only brake in g, plus rear grip is cut (handbrakeSlip) so the tail steps out.
//   steerMaxDeg    centre steering angle at standstill (Ackermann is applied per wheel). Turning circle ~ 2*wheelbase/tan(angle).
//   steerSpeedKmh  speed at which steering has faded to steerMinFrac of its lock (smooth), steerRate / steerReturn: full-lock fractions per second
//                  when turning in / when centring. rearSteer: rear wheel angle as a fraction of the front angle, OPPOSITE sign (monster truck).
//   steerGrip      steering lock is also capped at atan(wheelbase * steerGrip * mu * g / v^2) (mu = current average tyre grip incl. surface), so the car
//                  understeers instead of asking for more lateral g than the tyres have. 1.0 = exactly at the limit, >1 allows a bit of slide.
//   suspRest       suspension length at full droop (m); suspTravel: how far it can compress below suspRest before the bump stop (m).
//                  The hub rests at the manifest position; static length = suspRest - sag, sag = share*g/suspStiffness.
//   suspStiffness  spring rate per kg of car (1/s^2). Body heave frequency = sqrt(4k)/(2 pi). Mass-normalised, so heavy cars are not stiffer by accident.
//   suspCompression / suspRelaxation: damping RATIOS (1 = critical for that spring) while compressing / extending.
//   suspMaxForceX  max spring force = suspMaxForceX * (m g / 4). Also caps tyre grip, so keep >= 3. High values + damping absorb big landings.
//   gripFront/Rear friction coefficient of the tyres (lateral g limit on dry tarmac ~ this value). Rear < front = oversteer, rear > front = understeer.
//   sideStiff      Rapier side-friction stiffness (1 = default). handbrakeSlip: rear grip multiplier while the handbrake is held.
//   antiRoll       stabiliser bar, same units as suspStiffness: resists left/right compression difference per axle.
//   leanRoll/leanPitch  body roll / pitch strength (1 = physical). Rapier applies tyre forces low, so Vehicle.js adds the inertial moment m*a*h about the
//                  COM (a = measured lateral / longitudinal specific force): bodies roll to the outside in corners and squat/dive; top-heavy trucks can tip over.
//   tipDeg         roll angle (relative to the ground) beyond which the anti-rollover assist ramps in (scaled by `assist`). Large = easy to roll.
//   tipPitchDeg    same for pitch (backflips / endos). Wheelies below this angle are allowed.
//   downforce      extra downward force at 100 km/h as a fraction of weight, grows with v^2 (keep for loops later: set 1+ and it sticks to anything).
//   airControl     angular acceleration (rad/s^2) the air-control keys apply about pitch/roll/yaw; scaled by the body inertia, so the torque is physical.
//   offRoad        >1 shrinks the grip loss of soft surfaces: grip multiplier = 1 - (1 - SURFACE_FRICTION[class]) / offRoad, and rolling resistance on
//                  soft ground = crr + (1 - SURFACE_FRICTION) * softDrag / offRoad. Sports ~0.6, sedan 1, SUV 1.6, monster 2.4.
//   assist         ARCADE ASSIST, one knob 0..1 (0 = raw physics). It scales: yaw damping (spin-out catching), slide assist (extra lateral grip when sliding
//                  sideways, off while the handbrake is held), air self-righting, and a bit of anti-roll. See ASSIST below for the gains.
//   angDamp/linDamp  Rapier damping (linDamp is tiny: it would also slow free-fall). maxAngVel: rad/s clamp.
//
// Everything here is plain data on purpose: the tuning panel (hud/tuningPanel.js) edits a copy live and prints the diff as a CAR_OVERRIDES entry.

export const ASSIST = {
  yawDamp: 2.2,      // 1/s of excess yaw rate removed at assist=1 (excess = yaw rate beyond what the steering asks for)
  slideGrip: 2.6,    // 1/s of lateral velocity removed at assist=1 ...
  slideMaxAccel: 4.5,// ... but never more than this lateral accel (m/s^2) at assist=1
  selfRight: 4.0,    // rad/s^2 gain levelling the car in the air when no air-control key is held (assist=1)
  tipGain: 90,       // rad/s^2 of restoring roll acceleration per rad beyond tipDeg at assist=1
  tipDamp: 5,        // 1/s roll-rate damping while beyond tipDeg
  rollBoost: 0.4,    // anti-roll multiplier bonus at assist=1
};

export const ARCHETYPES = {
  sports: {
    label: 'Sports', density: 47, comFrac: 0.22, inertia: { pitch: 0.85, yaw: 0.8, roll: 0.9 },
    drive: 'RWD', frontBias: 0.4, launchAccel: 6.6, kneeKmh: 115, topSpeed: 212, reverseKmh: 40, gears: 6,
    brakeG: 1.25, handbrakeG: 0.9, handbrakeSlip: 0.55,
    steerMaxDeg: 33, steerSpeedKmh: 140, steerMinFrac: 0.2, steerGrip: 1.25, steerRate: 5.5, steerReturn: 8, rearSteer: 0,
    suspRest: 0.22, suspTravel: 0.14, suspStiffness: 80, suspCompression: 0.6, suspRelaxation: 0.85, suspMaxForceX: 4,
    gripFront: 1.7, gripRear: 1.8, sideStiff: 1, leanRoll: 0.5, leanPitch: 0.3, tipDeg: 25, tipPitchDeg: 14, antiRoll: 12, downforce: 0.3, airControl: 3.2,
    offRoad: 0.7, assist: 0.55, angDamp: 0.6, linDamp: 0.01, maxAngVel: 7,
  },
  muscle: {
    label: 'Muscle', density: 56, comFrac: 0.26, inertia: { pitch: 1.0, yaw: 0.95, roll: 1.0 },
    drive: 'RWD', frontBias: 0.4, launchAccel: 5.5, kneeKmh: 100, topSpeed: 195, reverseKmh: 38, gears: 5,
    brakeG: 1.0, handbrakeG: 0.9, handbrakeSlip: 0.45,
    steerMaxDeg: 31, steerSpeedKmh: 120, steerMinFrac: 0.22, steerGrip: 1.5, steerRate: 4.8, steerReturn: 7, rearSteer: 0,
    suspRest: 0.26, suspTravel: 0.17, suspStiffness: 45, suspCompression: 0.55, suspRelaxation: 0.75, suspMaxForceX: 4,
    gripFront: 1.35, gripRear: 1.05, sideStiff: 0.9, leanRoll: 0.7, leanPitch: 0.5, tipDeg: 25, tipPitchDeg: 18, antiRoll: 6, downforce: 0.05, airControl: 2.8,
    offRoad: 0.8, assist: 0.3, angDamp: 0.5, linDamp: 0.01, maxAngVel: 7,
  },
  sedan: {
    label: 'Sedan', density: 52, comFrac: 0.28, inertia: { pitch: 1.0, yaw: 1.0, roll: 1.0 },
    drive: 'FWD', frontBias: 0.5, launchAccel: 3.6, kneeKmh: 80, topSpeed: 165, reverseKmh: 35, gears: 6,
    brakeG: 0.95, handbrakeG: 0.8, handbrakeSlip: 0.55,
    steerMaxDeg: 31, steerSpeedKmh: 110, steerMinFrac: 0.25, steerGrip: 1.2, steerRate: 4.2, steerReturn: 6, rearSteer: 0,
    suspRest: 0.28, suspTravel: 0.18, suspStiffness: 35, suspCompression: 0.55, suspRelaxation: 0.8, suspMaxForceX: 4,
    gripFront: 1.25, gripRear: 1.3, sideStiff: 1, leanRoll: 0.8, leanPitch: 0.5, tipDeg: 22, tipPitchDeg: 12, antiRoll: 8, downforce: 0.05, airControl: 2.6,
    offRoad: 1.0, assist: 0.6, angDamp: 0.5, linDamp: 0.01, maxAngVel: 6.5,
  },
  suv: {
    label: 'SUV / pickup', density: 56, comFrac: 0.31, inertia: { pitch: 1.05, yaw: 1.05, roll: 1.1 },
    drive: 'AWD', frontBias: 0.45, launchAccel: 3.3, kneeKmh: 70, topSpeed: 145, reverseKmh: 32, gears: 6,
    brakeG: 0.9, handbrakeG: 0.75, handbrakeSlip: 0.6,
    steerMaxDeg: 34, steerSpeedKmh: 100, steerMinFrac: 0.28, steerGrip: 1.15, steerRate: 3.6, steerReturn: 5.5, rearSteer: 0,
    suspRest: 0.4, suspTravel: 0.3, suspStiffness: 25, suspCompression: 0.5, suspRelaxation: 0.75, suspMaxForceX: 5,
    gripFront: 1.2, gripRear: 1.25, sideStiff: 1, leanRoll: 0.9, leanPitch: 0.55, tipDeg: 20, tipPitchDeg: 14, antiRoll: 5, downforce: 0.04, airControl: 2.4,
    offRoad: 1.7, assist: 0.6, angDamp: 0.5, linDamp: 0.01, maxAngVel: 6,
  },
  van: {
    label: 'Van / limo / fire truck', density: 54, comFrac: 0.33, inertia: { pitch: 1.2, yaw: 1.3, roll: 1.15 },
    drive: 'RWD', frontBias: 0.5, launchAccel: 2.9, kneeKmh: 60, topSpeed: 135, reverseKmh: 28, gears: 5,
    brakeG: 0.85, handbrakeG: 0.6, handbrakeSlip: 0.65,
    steerMaxDeg: 32, steerSpeedKmh: 90, steerMinFrac: 0.3, steerGrip: 1.1, steerRate: 2.8, steerReturn: 4.5, rearSteer: 0,
    suspRest: 0.36, suspTravel: 0.24, suspStiffness: 20, suspCompression: 0.45, suspRelaxation: 0.7, suspMaxForceX: 5,
    gripFront: 1.0, gripRear: 1.2, sideStiff: 1, leanRoll: 1, leanPitch: 0.6, tipDeg: 18, tipPitchDeg: 10, antiRoll: 3, downforce: 0.02, airControl: 1.8,
    offRoad: 1.0, assist: 0.7, angDamp: 0.6, linDamp: 0.01, maxAngVel: 5,
  },
  bus: {
    label: 'Bus', density: 54, comFrac: 0.33, inertia: { pitch: 1.4, yaw: 1.5, roll: 1.3 },
    drive: 'RWD', frontBias: 0.5, launchAccel: 2.25, kneeKmh: 70, topSpeed: 108, reverseKmh: 22, gears: 5,
    brakeG: 0.8, handbrakeG: 0.5, handbrakeSlip: 0.75,
    steerMaxDeg: 31, steerSpeedKmh: 70, steerMinFrac: 0.35, steerGrip: 1.1, steerRate: 2.0, steerReturn: 3.5, rearSteer: 0,
    suspRest: 0.46, suspTravel: 0.3, suspStiffness: 13, suspCompression: 0.4, suspRelaxation: 0.6, suspMaxForceX: 5,
    gripFront: 1.0, gripRear: 1.25, sideStiff: 1, leanRoll: 1, leanPitch: 0.6, tipDeg: 16, tipPitchDeg: 8, antiRoll: 1.5, downforce: 0.02, airControl: 1.0,
    offRoad: 0.9, assist: 0.8, angDamp: 0.8, linDamp: 0.01, maxAngVel: 3.5,
  },
  monster: {
    label: 'Monster truck', density: 55, comFrac: 0.39, inertia: { pitch: 1.1, yaw: 1.1, roll: 1.1 },
    drive: 'AWD', frontBias: 0.5, launchAccel: 8.0, kneeKmh: 42, topSpeed: 125, reverseKmh: 35, gears: 4,
    brakeG: 1.15, handbrakeG: 0.6, handbrakeSlip: 0.6,
    steerMaxDeg: 25, steerSpeedKmh: 90, steerMinFrac: 0.3, steerGrip: 0.9, steerRate: 2.8, steerReturn: 4, rearSteer: 0.12,
    suspRest: 0.9, suspTravel: 0.62, suspStiffness: 13, suspCompression: 0.4, suspRelaxation: 0.55, suspMaxForceX: 6,
    gripFront: 1.2, gripRear: 1.2, sideStiff: 1, leanRoll: 0.85, leanPitch: 0.6, tipDeg: 30, tipPitchDeg: 12, antiRoll: 2, downforce: 0, airControl: 2.2,
    offRoad: 2.6, assist: 0.55, angDamp: 0.5, linDamp: 0.01, maxAngVel: 5,
  },
};

// every drivable car -> archetype (police variants map to their base)
export const CAR_ARCHETYPE = {
  sports: 'sports', roadster: 'sports', 'police-sports': 'sports',
  muscle: 'muscle', 'muscle-2': 'muscle', 'police-muscle': 'muscle',
  sedan: 'sedan', hatchback: 'sedan', taxi: 'sedan', 'police-sedan': 'sedan',
  suv: 'suv', 'police-suv': 'suv', pickup: 'suv', truck: 'suv',
  van: 'van', ambulance: 'van', limousine: 'van', firetruck: 'van',
  bus: 'bus', 'monster-truck': 'monster',
};

// Per-car overrides (any ARCHETYPES key, plus `mass`). The tuning panel's "copy profile JSON" prints an object in this shape.
export const CAR_OVERRIDES = {
  hatchback: { density: 47, launchAccel: 4.6, topSpeed: 160 },
  roadster: { comFrac: 0.2, topSpeed: 205 },
  'muscle-2': { launchAccel: 8.0, topSpeed: 190 },
  pickup: { drive: 'AWD', comFrac: 0.33 },
  truck: { density: 62, comFrac: 0.3, launchAccel: 2.9, topSpeed: 120, kneeKmh: 60, steerMaxDeg: 31, suspStiffness: 20, inertia: { pitch: 1.2, yaw: 1.3, roll: 1.2 } },
  ambulance: { density: 62, launchAccel: 2.6, topSpeed: 140 },
  limousine: { density: 50, steerMaxDeg: 28, topSpeed: 150, launchAccel: 2.7, kneeKmh: 70, inertia: { pitch: 1.5, yaw: 1.7, roll: 1.1 }, gripFront: 1.1 },
  firetruck: { density: 105, launchAccel: 2.7, kneeKmh: 60, topSpeed: 115, steerMaxDeg: 31, inertia: { pitch: 1.5, yaw: 1.5, roll: 1.3 }, suspStiffness: 16 },
};

// Fields the tuning panel exposes: key -> [min, max, step]. (Nested/enum keys are handled by the panel itself.)
export const TUNABLE = {
  mass: [300, 30000, 10], comFrac: [0.1, 0.7, 0.005], comZ: [-1, 1, 0.01],
  launchAccel: [0.5, 14, 0.05], kneeKmh: [20, 250, 1], topSpeed: [60, 320, 1], brakeG: [0.2, 2, 0.01], handbrakeG: [0.1, 2, 0.01],
  steerMaxDeg: [10, 50, 0.5], steerSpeedKmh: [20, 250, 1], steerMinFrac: [0.05, 1, 0.01], steerGrip: [0.6, 2, 0.01], steerRate: [0.5, 12, 0.1], steerReturn: [0.5, 14, 0.1], rearSteer: [0, 1, 0.01],
  suspRest: [0.08, 1.2, 0.01], suspTravel: [0.03, 1, 0.01], suspStiffness: [4, 150, 0.5], suspCompression: [0.1, 1.5, 0.01], suspRelaxation: [0.1, 1.5, 0.01], suspMaxForceX: [1.5, 10, 0.1],
  gripFront: [0.3, 3.5, 0.01], gripRear: [0.3, 3.5, 0.01], sideStiff: [0.2, 3, 0.01], handbrakeSlip: [0.1, 1, 0.01],
  antiRoll: [0, 40, 0.5], tipDeg: [5, 90, 1], tipPitchDeg: [3, 90, 1], leanRoll: [0, 1.5, 0.01], leanPitch: [0, 1.5, 0.01], downforce: [0, 4, 0.01], airControl: [0, 8, 0.1], offRoad: [0.3, 4, 0.05], assist: [0, 1, 0.01],
  angDamp: [0, 4, 0.05], maxAngVel: [1, 12, 0.1],
};

export function archetypeOf(carId) { return CAR_ARCHETYPE[carId] || 'sedan'; }

const clone = (o) => JSON.parse(JSON.stringify(o));

// car: a cars.json entry. Returns a fresh, fully resolved profile (safe to mutate).
export function resolveProfile(car) {
  const arch = archetypeOf(car.id);
  const p = { ...clone(ARCHETYPES[arch]), ...clone(CAR_OVERRIDES[car.id] || {}) };
  if (CAR_OVERRIDES[car.id]?.inertia) p.inertia = { ...ARCHETYPES[arch].inertia, ...CAR_OVERRIDES[car.id].inertia };
  const d = car.dimensions;
  p.archetype = arch; p.carId = car.id;
  p.mass ??= Math.round(p.density * d.length * d.width * d.height / 10) * 10; // ponytail: bbox volume is a crude mass proxy; set `mass` per car where it matters
  p.comZ ??= 0;
  p.reverseKmh ??= 30;
  return p;
}

// Overrides = everything that differs from the freshly resolved base (used by the tuning panel's "copy JSON").
export function profileDiff(car, profile) {
  const base = resolveProfile(car), out = {};
  for (const k of Object.keys(profile)) {
    if (k === 'archetype' || k === 'carId' || k === 'label') continue;
    if (JSON.stringify(profile[k]) !== JSON.stringify(base[k])) out[k] = profile[k];
  }
  return out;
}
