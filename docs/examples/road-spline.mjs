// road-spline.mjs - evaluate roads.json Catmull-Rom splines the same way the loader does.
//
// Uniform Catmull-Rom over the control-point index (not arc length), evaluated in
// the x,z plane. End points are duplicated as phantom neighbours. On a normal
// segment y comes from the map heightmap; a bridge segment interpolates y linearly
// between its two control points.
//
// Usage:
//   node docs/examples/road-spline.mjs public/maps/sample
//   node docs/examples/road-spline.mjs public/maps/sample --spacing 10
//   node docs/examples/road-spline.mjs public/maps/sample --json
//
// The loader equivalent is map.roads[i].getPoints(spacing).

import fs from 'node:fs';
import path from 'node:path';

const folder = (process.argv[2] || 'public/maps/sample').replace(/^--.*/, '');
const dir = path.resolve(folder);
const spacingArg = process.argv.indexOf('--spacing');
const spacing = spacingArg > 0 ? Number(process.argv[spacingArg + 1]) : 5;
const asJSON = process.argv.includes('--json');

const mapJson = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
const roadsJson = JSON.parse(fs.readFileSync(path.join(dir, 'roads.json'), 'utf8'));
const N = mapJson.N;
const W = mapJson.worldSizeMeters;
const MAXH = mapJson.maxHeightMeters;
const cell = W / N;

// Optional heightmap for y on normal segments. Without it, y is interpolated
// linearly between control points (the bridge rule) for every segment.
let H = null;
if (fs.existsSync(path.join(dir, 'heightmap.r16'))) {
  const buf = fs.readFileSync(path.join(dir, 'heightmap.r16'));
  if (buf.length === N * N * 2) {
    H = new Float64Array(N * N);
    for (let i = 0; i < H.length; i++) H[i] = ((buf[i * 2] | (buf[i * 2 + 1] << 8)) / 65535) * MAXH;
  }
}
function heightAt(x, z) {
  if (!H) return null;
  let fx = Math.max(0, Math.min(N - 1, x / cell - 0.5));
  let fz = Math.max(0, Math.min(N - 1, z / cell - 0.5));
  const x0 = Math.min(Math.floor(fx), N - 2);
  const z0 = Math.min(Math.floor(fz), N - 2);
  const tx = fx - x0, tz = fz - z0;
  return (H[x0 + z0 * N] * (1 - tx) + H[x0 + 1 + z0 * N] * tx) * (1 - tz) +
         (H[x0 + (z0 + 1) * N] * (1 - tx) + H[x0 + 1 + (z0 + 1) * N] * tx) * tz;
}

const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
const dcr = (a, b, c, d, t) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t);

function getPoints(P, spacingMeters) {
  const n = P.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: P[0].x, y: P[0].y, z: P[0].z, bridge: !!P[0].bridge, seg: 0, u: 0 }];

  const segPoint = (i, f) => {
    const p0 = P[Math.max(i - 1, 0)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(i + 2, n - 1)];
    const x = cr(p0.x, p1.x, p2.x, p3.x, f);
    const z = cr(p0.z, p1.z, p2.z, p3.z, f);
    let tx = dcr(p0.x, p1.x, p2.x, p3.x, f);
    let tz = dcr(p0.z, p1.z, p2.z, p3.z, f);
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const bridge = !!p1.bridge;
    const y = bridge || !H ? p1.y + (p2.y - p1.y) * f : heightAt(x, z);
    return { x, y, z, bridge, seg: i, u: i + f, tx, tz };
  };

  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const m = Math.max(2, Math.ceil(Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z) / spacingMeters));
    for (let k = 0; k < m; k++) out.push(segPoint(i, k / m));
  }
  out.push(segPoint(n - 2, 1));
  return out;
}

const result = roadsJson.roads.map((r) => {
  const P = r.points.map((p) => ({
    x: p.x !== undefined ? p.x : p.nx * W,
    z: p.z !== undefined ? p.z : p.nz * W,
    y: p.y,
    bridge: !!p.bridge,
  }));
  const pts = getPoints(P, spacing);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return { id: r.id, width: r.widthMeters, controls: P.length, spacing, length, points: pts };
});

if (asJSON) {
  console.log(JSON.stringify(result, null, 1));
} else {
  for (const r of result) {
    console.log(`road ${r.id}: ${r.controls} control points, ${r.points.length} samples @ ${r.spacing} m, length ${r.length.toFixed(2)} m, width ${r.width} m`);
    for (const p of r.points.slice(0, 5)) {
      console.log(`  u=${p.u.toFixed(3)} seg=${p.seg} x=${p.x.toFixed(3)} y=${p.y === null ? 'n/a' : p.y.toFixed(3)} z=${p.z.toFixed(3)}${p.bridge ? ' bridge' : ''}`);
    }
    if (r.points.length > 5) {
      const p = r.points[r.points.length - 1];
      console.log(`  ... last: u=${p.u.toFixed(3)} x=${p.x.toFixed(3)} y=${p.y === null ? 'n/a' : p.y.toFixed(3)} z=${p.z.toFixed(3)}${p.bridge ? ' bridge' : ''}`);
    }
  }
}
