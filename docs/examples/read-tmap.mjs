// read-tmap.mjs - parse a .tmap project file with the Node standard library only.
//
// Prints the magic, header length, format/version, N, settings, roads/markers and
// the layer table. With --dump <dir> it writes the layers back out as export-style
// raw arrays plus map.json / roads.json / markers.json.
//
// Usage:
//   node docs/examples/read-tmap.mjs scripts/fixtures/roadmeta.tmap
//   node docs/examples/read-tmap.mjs scripts/fixtures/roadmeta.tmap --dump out/roadmeta
//
// Container layout:
//   bytes 0..3   "TMAP"
//   bytes 4..7   uint32 LE headerLength (JSON is 4-byte aligned, padded with spaces)
//   bytes 8..    UTF-8 JSON header
//   after that   raw little-endian typed arrays at 8 + headerLength + layer.offset
//   layers       height f32, water f32 (-1 = none), weight0..weight7 u8

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node docs/examples/read-tmap.mjs <file.tmap> [--dump <dir>]');
  process.exit(1);
}
const dumpIdx = process.argv.indexOf('--dump');
const dumpDir = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;

const buf = fs.readFileSync(file);
if (buf.length < 8) throw new Error('file too short');
if (buf.toString('latin1', 0, 4) !== 'TMAP') throw new Error('missing TMAP magic');
const headerLength = buf.readUInt32LE(4);
const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLength));
const base = 8 + headerLength;

// Copy each slice so the typed array starts at byteOffset 0 (AlignmentError otherwise).
function layer(name, Ctor, bytesPer) {
  const l = header.layers.find((x) => x.name === name);
  if (!l) return null;
  const copy = new Uint8Array(buf.subarray(base + l.offset, base + l.offset + l.byteLength));
  return new Ctor(copy.buffer, 0, l.byteLength / bytesPer);
}

console.log(`file            ${file}`);
console.log(`magic           TMAP`);
console.log(`headerLength    ${headerLength} bytes (data starts at ${base})`);
console.log(`format/version  ${header.format ?? '(none)'} / ${header.version ?? '(none)'}`);
console.log(`N               ${header.N}`);
console.log(`settings        ${JSON.stringify(header.settings)}`);
console.log(`roads           ${header.roads?.length ?? 0} (nextRoadId ${header.nextRoadId ?? '-'})`);
console.log(`markers         ${header.markers?.length ?? 0} (nextMarkerId ${header.nextMarkerId ?? '-'})`);
console.log('layers:');
for (const l of header.layers) {
  const count = l.byteLength / (l.type === 'f32' ? 4 : 1);
  console.log(`  ${l.name.padEnd(9)} ${String(l.type).padEnd(4)} offset ${String(l.offset).padStart(9)}  ${String(l.byteLength).padStart(9)} bytes  ${count} values`);
}

const height = layer('height', Float32Array, 4);
const water = layer('water', Float32Array, 4);
if (height) {
  let mn = Infinity, mx = -Infinity;
  for (const v of height) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const N = header.N, maxH = header.settings?.maxHeightMeters ?? 0;
  console.log(`height f32      ${mn.toFixed(4)} .. ${mx.toFixed(4)} normalized  (${(mn * maxH).toFixed(3)} .. ${(mx * maxH).toFixed(3)} m)`);
}
if (water) {
  let wet = 0;
  for (const v of water) if (v >= 0) wet++;
  console.log(`water f32       ${wet} wet samples, ${water.length - wet} dry (-1)`);
}

if (dumpDir) {
  const N = header.N;
  const s = header.settings || {};
  const W = s.worldSizeMeters;
  const MAXH = s.maxHeightMeters;
  const cell = W / N;
  fs.mkdirSync(dumpDir, { recursive: true });

  const h16 = Buffer.alloc(N * N * 2);
  const w16 = Buffer.alloc(N * N * 2);
  for (let i = 0; i < N * N; i++) {
    const hv = Math.max(0, Math.min(1, height[i]));
    h16.writeUInt16LE(Math.round(hv * 65535), i * 2);
    const wv = water[i];
    w16.writeUInt16LE(wv >= 0 ? 1 + Math.round(Math.max(0, Math.min(1, wv)) * 65534) : 0, i * 2);
  }
  fs.writeFileSync(path.join(dumpDir, 'heightmap.r16'), h16);
  fs.writeFileSync(path.join(dumpDir, 'heightmap.f32.raw'), Buffer.from(height.buffer, height.byteOffset, height.byteLength));
  fs.writeFileSync(path.join(dumpDir, 'water.u16.raw'), w16);
  fs.writeFileSync(path.join(dumpDir, 'water.f32.raw'), Buffer.from(water.buffer, water.byteOffset, water.byteLength));

  const s0 = Buffer.alloc(N * N * 4);
  const s1 = Buffer.alloc(N * N * 4);
  for (let c = 0; c < 8; c++) {
    const layerData = layer(`weight${c}`, Uint8Array, 1);
    const dst = c < 4 ? s0 : s1;
    for (let i = 0; i < N * N; i++) dst[i * 4 + (c & 3)] = layerData[i];
  }
  fs.writeFileSync(path.join(dumpDir, 'splat0.rgba8.raw'), s0);
  fs.writeFileSync(path.join(dumpDir, 'splat1.rgba8.raw'), s1);

  const classes = ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow', 'road', 'city'].map((name, id) => ({
    id, name, color: ['#5da130', '#1f5c2a', '#8a6a43', '#e0cf8f', '#7d7d7d', '#f2f6ff', '#333333', '#b0a0c0'][id],
  }));
  const mapJson = {
    formatVersion: 1,
    N,
    worldSizeMeters: W,
    maxHeightMeters: MAXH,
    cellSizeMeters: cell,
    seaLevel: s.seaLevel,
    seaLevelMeters: s.seaLevel * MAXH,
    classes,
    files: {
      heightRaw16: 'heightmap.r16', splat0: 'splat0.rgba8.raw', splat1: 'splat1.rgba8.raw',
      water: 'water.u16.raw', roads: 'roads.json', markers: 'markers.json',
    },
  };
  if (s.driveSide && s.driveSide !== 'right') mapJson.driveSide = s.driveSide;
  if (s.signStyle && s.signStyle !== 'us') mapJson.signStyle = s.signStyle;
  fs.writeFileSync(path.join(dumpDir, 'map.json'), JSON.stringify(mapJson, null, 1));
  fs.writeFileSync(path.join(dumpDir, 'roads.json'), JSON.stringify({ formatVersion: 1, roads: header.roads || [] }, null, 1));
  fs.writeFileSync(path.join(dumpDir, 'markers.json'), JSON.stringify({ version: 1, markers: header.markers || [] }, null, 1));
  console.log(`dumped          ${path.resolve(dumpDir)}`);
}
