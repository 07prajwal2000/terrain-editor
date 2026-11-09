// read-export.mjs - read a map export folder with the Node standard library only.
//
// Decodes the 16-bit heightmap from heightmap.r16 and from heightmap16.png (a
// minimal PNG decoder using node:zlib), prints the map settings, the height range
// in metres and a bilinearly interpolated height at a world position.
//
// Usage:
//   node docs/examples/read-export.mjs public/maps/sample
//   node docs/examples/read-export.mjs public/maps/sample 250 250
//
// Coordinate convention (same as the loader):
//   +X = increasing pixel column (east), +Z = increasing pixel row (south), +Y up.
//   Sample (i,j) sits at the pixel centre: x=(i+0.5)*cell, z=(j+0.5)*cell.
//   metres = raw16 / 65535 * maxHeightMeters.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const folder = process.argv[2] || 'public/maps/sample';
const dir = path.resolve(folder);

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

// --- 16-bit grayscale PNG decoder (8/16-bit, gray/RGB/gray+A/RGBA, all filters) ---
function decodePNG(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || SIG.some((b, i) => buf[i] !== b)) throw new Error('not a PNG file');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      bitDepth = buf[pos + 16];
      colorType = buf[pos + 17];
      if (buf[pos + 20] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colour type ' + colorType);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('unsupported bit depth ' + bitDepth);
  const z = Buffer.concat(idat);
  const raw = zlib.inflateSync(z); // PNG IDAT is zlib-wrapped deflate
  const bpp = (channels * bitDepth) / 8;
  const rowB = width * bpp;
  if (raw.length !== (rowB + 1) * height) throw new Error('decompressed size mismatch');
  const out = Buffer.alloc(rowB * height);
  for (let y = 0; y < height; y++) {
    const s = y * (rowB + 1) + 1;
    const d = y * rowB;
    const p = d - rowB;
    const ft = raw[s - 1];
    for (let i = 0; i < rowB; i++) {
      const a = i >= bpp ? out[d + i - bpp] : 0;
      const b = y ? out[p + i] : 0;
      const c = y && i >= bpp ? out[p + i - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error('bad filter ' + ft);
      out[d + i] = (raw[s + i] + pred) & 0xff;
    }
  }
  let data;
  if (bitDepth === 16) {
    data = new Uint16Array(width * height * channels);
    for (let i = 0; i < data.length; i++) data[i] = (out[i * 2] << 8) | out[i * 2 + 1]; // PNG is big-endian
  } else {
    data = new Uint8Array(out);
  }
  return { width, height, channels, bitDepth, data };
}

const map = readJSON('map.json');
const { N, worldSizeMeters: W, maxHeightMeters: MAXH } = map;
if (![512, 1024, 2048].includes(N)) console.warn(`warning: unusual N=${N}`);
const cell = W / N;

// --- raw 16-bit little-endian heightmap ---
const rawBuf = fs.readFileSync(path.join(dir, map.files?.heightRaw16 || 'heightmap.r16'));
if (rawBuf.length !== N * N * 2) throw new Error(`heightmap.r16 is ${rawBuf.length} bytes, expected ${N * N * 2}`);
const Hraw = new Uint16Array(N * N);
for (let i = 0; i < Hraw.length; i++) Hraw[i] = rawBuf[i * 2] | (rawBuf[i * 2 + 1] << 8);
const Hm = new Float64Array(N * N);
for (let i = 0; i < Hm.length; i++) Hm[i] = (Hraw[i] / 65535) * MAXH;

// --- PNG heightmap (should match .r16 exactly) ---
const png = decodePNG(fs.readFileSync(path.join(dir, map.files?.height16 || 'heightmap16.png')));
if (png.width !== N || png.height !== N || png.channels !== 1 || png.bitDepth !== 16) {
  throw new Error(`expected a ${N}x${N} 16-bit grayscale PNG`);
}
let mismatch = 0;
for (let i = 0; i < Hraw.length; i++) if (png.data[i] !== Hraw[i]) mismatch++;
let min = Infinity;
let max = -Infinity;
for (const v of Hm) { if (v < min) min = v; if (v > max) max = v; }

function heightAt(x, z) {
  let fx = x / cell - 0.5;
  let fz = z / cell - 0.5;
  fx = Math.max(0, Math.min(N - 1, fx));
  fz = Math.max(0, Math.min(N - 1, fz));
  const x0 = Math.min(Math.floor(fx), N - 2);
  const z0 = Math.min(Math.floor(fz), N - 2);
  const tx = fx - x0;
  const tz = fz - z0;
  const h00 = Hm[x0 + z0 * N];
  const h10 = Hm[x0 + 1 + z0 * N];
  const h01 = Hm[x0 + (z0 + 1) * N];
  const h11 = Hm[x0 + 1 + (z0 + 1) * N];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

const sx = process.argv[3] !== undefined ? Number(process.argv[3]) : W / 2;
const sz = process.argv[4] !== undefined ? Number(process.argv[4]) : W / 2;
const roads = fs.existsSync(path.join(dir, 'roads.json')) ? readJSON('roads.json').roads : [];
const markers = fs.existsSync(path.join(dir, 'markers.json')) ? readJSON('markers.json').markers : [];

console.log(`folder               ${path.relative(process.cwd(), dir) || '.'}`);
console.log(`grid                 ${N} x ${N}, world ${W} m, cell ${cell.toFixed(4)} m`);
console.log(`max height           ${MAXH} m`);
console.log(`sea level            ${map.seaLevelMeters} m (normalized ${map.seaLevel})`);
console.log(`height range         ${min.toFixed(3)} .. ${max.toFixed(3)} m`);
console.log(`PNG vs .r16          ${mismatch === 0 ? 'identical' : mismatch + ' mismatching samples'}`);
console.log(`roads / markers      ${roads.length} / ${markers.length}`);
console.log(`heightAt(${sx}, ${sz})  ${heightAt(sx, sz).toFixed(4)} m`);
