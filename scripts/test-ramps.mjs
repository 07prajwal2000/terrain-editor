// Headless ramp and obstacle test: `npm run test:ramps` (options: --cars sports,sedan   --quick)
// Tests all drivable cars climbing:
//  - Wedge ramps at 10, 15, 20, 25, 30 degrees (forward @ 10 & 30 km/h, reverse @ 10 km/h)
//  - Hard steps of 0.15 m and 0.25 m (forward & reverse @ 10 km/h)
//  - Ramp-to-flat-top crest transition (15 & 20 degrees @ 10 km/h)
//  - Static vertical wall collision at 30 and 100 km/h (stops, no tunneling)
import fs from 'node:fs';
import path from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { resolveProfile, archetypeOf } from '../src/vehicles/handling.js';
import { addWedgeCollider } from '../src/vehicles/wedge.js';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const DT = 1 / 120, KMH = 3.6, G = 9.81;
const manifest = JSON.parse(fs.readFileSync(path.resolve('public/cars/cars.json'), 'utf8'));
const cars = Object.fromEntries(manifest.cars.map((c) => [c.id, c]));
const drivableCars = manifest.cars.filter((c) => c.drivable).map((c) => c.id);

function glbBodyBounds(id) {
  const b = fs.readFileSync(path.resolve(`public/cars/${id}.glb`)), len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString());
  const node = j.nodes.find((n) => n.name === 'body'), t = node.translation || [0, 0, 0];
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of j.meshes[node.mesh].primitives) {
    const a = j.accessors[p.attributes.POSITION];
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k] + t[k]); max[k] = Math.max(max[k], a.max[k] + t[k]); }
  }
  return { min, max };
}

await RAPIER.init();

function createSim(id, spawn = { x: 0, y: 0.15, z: 0, yaw: 0 }) {
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(300, 0.5, 300).setTranslation(0, -0.5, 0).setFriction(1.0).setRestitution(0));
  const map = {
    surfaceAt: () => ({ classId: 6, weights: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0]), roadSurface: 'smooth', roughness: 0, gripMul: 1 }),
    heightAt: () => 0,
    waterLevelAt: () => null,
  };
  const car = cars[id], profile = resolveProfile(car);
  const bounds = glbBodyBounds(id);
  const v = new Vehicle({ RAPIER, world, map, car, profile, bounds, spawn, dt: DT });
  return { world, v, bounds, profile };
}

function hasChassisContact(world, vehicle, targetCollider) {
  let hit = false;
  for (const c of vehicle.colliders) {
    world.contactPair(c, targetCollider, (m) => {
      if (m.numContacts() > 0) hit = true;
    });
    if (hit) break;
  }
  return hit;
}

// 1. Ramp test (forward)
export function runRampFwd(id, angleDeg, speedKmh = 10, maxSeconds = 7.0) {
  const a = angleDeg * Math.PI / 180;
  const H = Math.max(1.5, 12 * Math.sin(a));
  const slopeLen = H / Math.sin(a);
  const runLen = slopeLen * Math.cos(a);
  const zRamp = 0;

  const b0 = glbBodyBounds(id);
  const spawnZ = -Math.max(5.0, b0.max[2] + 1.8);
  const { world, v } = createSim(id, { x: 0, y: 0.15, z: spawnZ, yaw: 0 });
  const wedgeCol = addWedgeCollider(RAPIER, world, { x: 0, z0: zRamp, y0: 0, width: 14, angleDeg, length: slopeLen });

  for (let i = 0; i < 40; i++) v.fixedStep({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  const targetV = speedKmh / KMH;
  v.body.setLinvel({ x: 0, y: 0, z: targetV }, true);

  const goalZ = zRamp + runLen * 0.7;
  let stuckTime = 0, minVf = 1e9, contactFrames = 0, climbed = false, flipped = false;
  const timeout = Math.max(maxSeconds, ((Math.abs(spawnZ) + goalZ) / Math.max(targetV * 0.5, 1.0)));
  const maxSteps = Math.round(timeout / DT);

  for (let step = 0; step < maxSteps; step++) {
    const pos = v.body.translation();
    let inp;
    if (pos.z < zRamp - 1.0) {
      const err = targetV - v.state.vf;
      inp = { throttle: Math.max(0, Math.min(1, err * 2)), brake: Math.max(0, Math.min(1, -err * 2)), steer: 0, handbrake: 0 };
    } else {
      inp = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    }
    v.fixedStep(inp);

    const vf = v.state.vf;
    if (pos.z > zRamp - 1.5) {
      minVf = Math.min(minVf, vf);
      if (Math.abs(vf) < 0.2) stuckTime += DT;
    }
    if (v.ax.u[1] < 0.5) flipped = true;
    if (hasChassisContact(world, v, wedgeCol)) contactFrames++;

    if (pos.z >= goalZ && !flipped) { climbed = true; break; }
    if (stuckTime > 1.2 || flipped) break;
  }

  const stall = stuckTime > 1.0;
  const reason = climbed ? 'pass' : flipped ? 'flip' : contactFrames > 15 ? 'collider' : 'engine';
  return { id, angleDeg, speedKmh, climbed: climbed && !stall && !flipped, stuckTime, minKmh: Math.max(0, minVf * KMH), contactFrames, reason };
}

// 2. Ramp test (reverse)
export function runRampRev(id, angleDeg, speedKmh = 10, maxSeconds = 7.0) {
  const a = angleDeg * Math.PI / 180;
  const H = Math.max(1.5, 12 * Math.sin(a));
  const slopeLen = H / Math.sin(a);
  const runLen = slopeLen * Math.cos(a);
  const zRamp = 0;

  const b0 = glbBodyBounds(id);
  const spawnZ = -Math.max(5.0, Math.abs(b0.min[2]) + 1.8);
  const { world, v } = createSim(id, { x: 0, y: 0.15, z: spawnZ, yaw: Math.PI });
  const wedgeCol = addWedgeCollider(RAPIER, world, { x: 0, z0: zRamp, y0: 0, width: 14, angleDeg, length: slopeLen });

  for (let i = 0; i < 40; i++) v.fixedStep({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  const targetV = speedKmh / KMH;
  v.body.setLinvel({ x: 0, y: 0, z: targetV }, true);

  const goalZ = zRamp + runLen * 0.7;
  let stuckTime = 0, minSpd = 1e9, contactFrames = 0, climbed = false, flipped = false;
  const timeout = Math.max(maxSeconds, ((Math.abs(spawnZ) + goalZ) / Math.max(targetV * 0.5, 1.0)));
  const maxSteps = Math.round(timeout / DT);

  for (let step = 0; step < maxSteps; step++) {
    const pos = v.body.translation();
    const vz = v.body.linvel().z;
    let inp;
    if (pos.z < zRamp - 1.0) {
      const err = targetV - vz;
      inp = { throttle: 0, brake: Math.max(0, Math.min(1, 0.5 + err * 2)), steer: 0, handbrake: 0 };
    } else {
      inp = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
    }
    v.fixedStep(inp);

    const curSpd = v.body.linvel().z;
    if (pos.z > zRamp - 1.5) {
      minSpd = Math.min(minSpd, curSpd);
      if (Math.abs(curSpd) < 0.2) stuckTime += DT;
    }
    if (v.ax.u[1] < 0.5) flipped = true;
    if (hasChassisContact(world, v, wedgeCol)) contactFrames++;

    if (pos.z >= goalZ && !flipped) { climbed = true; break; }
    if (stuckTime > 1.2 || flipped) break;
  }

  const stall = stuckTime > 1.0;
  const reason = climbed ? 'pass' : flipped ? 'flip' : contactFrames > 15 ? 'collider' : 'engine';
  return { id, angleDeg, speedKmh, climbed: climbed && !stall && !flipped, stuckTime, minKmh: Math.max(0, minSpd * KMH), contactFrames, reason };
}

// 3. Step test (forward & reverse)
export function runStep(id, hStep, reverse = false, speedKmh = 10, maxSeconds = 6.0) {
  const b0 = glbBodyBounds(id);
  const spawnZ = -Math.max(4.5, (reverse ? Math.abs(b0.min[2]) : b0.max[2]) + 1.5);
  const yaw = reverse ? Math.PI : 0;
  const { world, v } = createSim(id, { x: 0, y: 0.15, z: spawnZ, yaw });

  const zStep = 0;
  const stepCol = world.createCollider(
    RAPIER.ColliderDesc.cuboid(8, hStep / 2, 12).setTranslation(0, hStep / 2, zStep + 12).setFriction(1.0).setRestitution(0)
  );

  for (let i = 0; i < 40; i++) v.fixedStep({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  const targetV = speedKmh / KMH;
  v.body.setLinvel({ x: 0, y: 0, z: targetV }, true);

  const goalZ = zStep + 5.0;
  let stuckTime = 0, minSpd = 1e9, contactFrames = 0, climbed = false, flipped = false;
  const timeout = Math.max(maxSeconds, ((Math.abs(spawnZ) + goalZ) / Math.max(targetV * 0.5, 1.0)));
  const maxSteps = Math.round(timeout / DT);

  for (let step = 0; step < maxSteps; step++) {
    const pos = v.body.translation();
    const vz = reverse ? v.body.linvel().z : v.state.vf;
    let inp;
    if (pos.z < zStep - 1.0) {
      const err = targetV - vz;
      inp = reverse
        ? { throttle: 0, brake: Math.max(0, Math.min(1, 0.5 + err * 2)), steer: 0, handbrake: 0 }
        : { throttle: Math.max(0, Math.min(1, err * 2)), brake: Math.max(0, Math.min(1, -err * 2)), steer: 0, handbrake: 0 };
    } else {
      inp = reverse ? { throttle: 0, brake: 1, steer: 0, handbrake: 0 } : { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    }
    v.fixedStep(inp);

    const curSpd = reverse ? v.body.linvel().z : v.state.vf;
    if (pos.z > zStep - 1.5) {
      minSpd = Math.min(minSpd, curSpd);
      if (Math.abs(curSpd) < 0.2) stuckTime += DT;
    }
    if (v.ax.u[1] < 0.5) flipped = true;
    if (hasChassisContact(world, v, stepCol)) contactFrames++;

    if (pos.z >= goalZ && !flipped) { climbed = true; break; }
    if (stuckTime > 1.2 || flipped) break;
  }

  const stall = stuckTime > 1.0;
  const reason = climbed ? 'pass' : flipped ? 'flip' : contactFrames > 15 ? 'collider' : 'engine';
  return { id, hStep, reverse, climbed: climbed && !stall && !flipped, stuckTime, minKmh: Math.max(0, minSpd * KMH), contactFrames, reason };
}

// 4. Crest test (flat -> ramp -> flat top)
export function runCrest(id, angleDeg = 15, speedKmh = 10, maxSeconds = 7.0) {
  const b0 = glbBodyBounds(id);
  const spawnZ = -Math.max(5.0, b0.max[2] + 1.8);
  const { world, v } = createSim(id, { x: 0, y: 0.15, z: spawnZ, yaw: 0 });

  const a = angleDeg * Math.PI / 180;
  const H = 1.8;
  const rampRun = H / Math.tan(a);
  const topLen = 15;
  const hw = 8;
  const pts = [
    [-hw, 0, 0], [hw, 0, 0],
    [-hw, H, rampRun], [hw, H, rampRun],
    [-hw, H, rampRun + topLen], [hw, H, rampRun + topLen],
    [-hw, 0, rampRun + topLen], [hw, 0, rampRun + topLen]
  ];
  const crestCol = world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flat())).setFriction(1.0).setRestitution(0));

  for (let i = 0; i < 40; i++) v.fixedStep({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  const targetV = speedKmh / KMH;
  v.body.setLinvel({ x: 0, y: 0, z: targetV }, true);

  const goalZ = rampRun + 5.0;
  let stuckTime = 0, minVf = 1e9, contactFrames = 0, climbed = false, flipped = false;
  const timeout = Math.max(maxSeconds, ((Math.abs(spawnZ) + goalZ) / Math.max(targetV * 0.5, 1.0)));
  const maxSteps = Math.round(timeout / DT);

  for (let step = 0; step < maxSteps; step++) {
    const pos = v.body.translation();
    let inp;
    if (pos.z < -1.0) {
      const err = targetV - v.state.vf;
      inp = { throttle: Math.max(0, Math.min(1, err * 2)), brake: Math.max(0, Math.min(1, -err * 2)), steer: 0, handbrake: 0 };
    } else {
      inp = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    }
    v.fixedStep(inp);

    const vf = v.state.vf;
    if (pos.z > -1.5) {
      minVf = Math.min(minVf, vf);
      if (Math.abs(vf) < 0.2) stuckTime += DT;
    }
    if (v.ax.u[1] < 0.5) flipped = true;
    if (hasChassisContact(world, v, crestCol)) contactFrames++;

    if (pos.z >= goalZ && !flipped) { climbed = true; break; }
    if (stuckTime > 1.2 || flipped) break;
  }

  const stall = stuckTime > 1.0;
  const reason = climbed ? 'pass' : flipped ? 'flip' : contactFrames > 15 ? 'collider' : 'engine';
  return { id, angleDeg, climbed: climbed && !stall && !flipped, stuckTime, minKmh: Math.max(0, minVf * KMH), contactFrames, reason };
}

// 5. Wall crash sanity (30 & 100 km/h)
export function runWallCrash(id, speedKmh = 30) {
  const { world, v, bounds } = createSim(id, { x: 0, y: 0.15, z: 0, yaw: 0 });
  const wallZ = 12.0;
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 5, 1).setTranslation(0, 5, wallZ + 1).setFriction(0.5).setRestitution(0));

  for (let i = 0; i < 30; i++) v.fixedStep({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  v.body.setLinvel({ x: 0, y: 0, z: speedKmh / KMH }, true);

  let tunneled = false;
  for (let step = 0; step < 120 * 3; step++) {
    v.fixedStep({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
    const pos = v.body.translation();
    if (pos.z > wallZ + 1.5) { tunneled = true; break; }
  }
  const endZ = v.body.translation().z;
  const stopped = !tunneled && endZ < wallZ + 0.8;
  return { id, speedKmh, stopped, endZ, tunneled };
}

// ---- Full benchmark run ----
export function runSuite(selectedCars = drivableCars) {
  const results = {};
  for (const id of selectedCars) {
    if (!cars[id]?.drivable) continue;
    const profile = resolveProfile(cars[id]);
    const revTop = Math.min(30, profile.reverseKmh);
    const carRes = results[id] = {
      id,
      arch: archetypeOf(id),
      fwd10: {}, fwd30: {},
      rev10: {}, rev30: {},
      stepFwd15: runStep(id, 0.15, false, 10),
      stepFwd25: runStep(id, 0.25, false, 10),
      stepRev15: runStep(id, 0.15, true, 10),
      stepRev25: runStep(id, 0.25, true, 10),
      crest15: runCrest(id, 15, 10),
      crest20: runCrest(id, 20, 10),
      wall30: runWallCrash(id, 30),
      wall100: runWallCrash(id, 100),
    };

    for (const deg of [10, 15, 20, 25, 30]) {
      carRes.fwd10[deg] = runRampFwd(id, deg, 10);
      carRes.fwd30[deg] = runRampFwd(id, deg, 30);
      carRes.rev10[deg] = runRampRev(id, deg, 10);
      carRes.rev30[deg] = runRampRev(id, deg, revTop);
    }
  }
  return results;
}

export function formatTable(results) {
  const carsList = Object.keys(results);
  const rows = [];
  for (const id of carsList) {
    const r = results[id];
    const maxFwd10 = Math.max(0, ...[10, 15, 20, 25, 30].filter((d) => r.fwd10[d].climbed));
    const maxFwd30 = Math.max(0, ...[10, 15, 20, 25, 30].filter((d) => r.fwd30[d].climbed));
    const maxRev10 = Math.max(0, ...[10, 15, 20, 25, 30].filter((d) => r.rev10[d].climbed));
    const maxRev30 = Math.max(0, ...[10, 15, 20, 25, 30].filter((d) => r.rev30[d].climbed));
    const step15 = r.stepFwd15.climbed && r.stepRev15.climbed ? 'PASS' : 'FAIL';
    const step25 = (r.stepFwd25.climbed ? 'F' : '-') + '/' + (r.stepRev25.climbed ? 'R' : '-');
    const crest = (r.crest15.climbed ? '15' : '-') + '/' + (r.crest20.climbed ? '20' : '-');
    const wall = r.wall30.stopped && r.wall100.stopped ? 'PASS' : 'FAIL';

    rows.push([
      id,
      r.arch,
      `${maxFwd10}°`,
      `${maxFwd30}°`,
      `${maxRev10}°`,
      `${maxRev30}°`,
      step15,
      step25,
      crest,
      wall
    ]);
  }

  const head = ['car', 'arch', 'fwd@10', 'fwd@30', 'rev@10', 'rev@30', 'step.15', 'step.25', 'crest', 'wall'];
  const wd = head.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const headerLine = head.map((h, i) => h.padEnd(wd[i])).join('  ');
  const dividerLine = wd.map((w) => '-'.repeat(w)).join('  ');
  const rowLines = rows.map((r) => r.map((c, i) => String(c).padEnd(wd[i])).join('  ')).join('\n');
  return `${headerLine}\n${dividerLine}\n${rowLines}`;
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/test-ramps.mjs')) {
  const wanted = opt('cars') ? opt('cars').split(',') : drivableCars;
  console.log(`\n--- Running Ramp & Step Obstacle Tests (${wanted.length} cars) ---`);
  const t0 = performance.now();
  const results = runSuite(wanted);
  console.log(`\n${formatTable(results)}\n`);
  console.log(`Completed in ${((performance.now() - t0) / 1000).toFixed(2)} s\n`);

  // Assertions for acceptance
  let failures = 0;
  for (const id of wanted) {
    const r = results[id];
    // 1. No collider-limited snags on 10, 15, 20 degrees forward or reverse
    for (const deg of [10, 15, 20]) {
      if (r.fwd10[deg].reason === 'collider' || r.fwd30[deg].reason === 'collider') {
        console.error(`FAIL: ${id} collider snagged on forward ramp at ${deg}°`);
        failures++;
      }
      if (r.rev10[deg].reason === 'collider' || r.rev30[deg].reason === 'collider') {
        console.error(`FAIL: ${id} collider snagged on reverse ramp at ${deg}°`);
        failures++;
      }
    }
    // 2. Must climb 10, 15, 20 forward at 30 km/h
    for (const deg of [10, 15, 20]) {
      if (!r.fwd30[deg].climbed) {
        console.error(`FAIL: ${id} failed forward ramp at ${deg}° (30 km/h): ${r.fwd30[deg].reason}`);
        failures++;
      }
    }
    // 3. Must climb 10, 15 forward at 10 km/h (20° pass is expected for all except torque-limited bus)
    for (const deg of [10, 15]) {
      if (!r.fwd10[deg].climbed) {
        console.error(`FAIL: ${id} failed forward ramp at ${deg}° (10 km/h): ${r.fwd10[deg].reason}`);
        failures++;
      }
    }
    // 4. Step 0.15m: must pass forward and reverse at 10 km/h
    if (!r.stepFwd15.climbed) {
      console.error(`FAIL: ${id} failed 0.15m forward step: ${r.stepFwd15.reason}`);
      failures++;
    }
    if (!r.stepRev15.climbed) {
      console.error(`FAIL: ${id} failed 0.15m reverse step: ${r.stepRev15.reason}`);
      failures++;
    }
    // 5. Wall collision sanity: must stop, no tunneling
    if (!r.wall30.stopped || !r.wall100.stopped) {
      console.error(`FAIL: ${id} wall collision sanity failed`);
      failures++;
    }
  }

  if (failures > 0) {
    console.log(`Total failures: ${failures}`);
    process.exitCode = 1;
  } else {
    console.log('All ramp and obstacle acceptance checks passed!');
  }
}
