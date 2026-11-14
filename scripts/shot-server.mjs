// Dev helper for the gallery capture (docs/gallery/README.md): accepts POST /save?name=01-hero.webp (body = data URL or raw bytes) on :5188 and writes docs/gallery/<name>. CORS open, localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('docs/gallery'); fs.mkdirSync(dir, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') || '');
  if (!/^[\w.-]+\.(webp|png|jpg)$/.test(name)) { res.statusCode = 400; return res.end('bad name'); }
  const chunks = []; req.on('data', (c) => chunks.push(c)).on('end', () => {
    let b = Buffer.concat(chunks); const m = /^data:[^,]*;base64,/.exec(b.subarray(0, 60).toString('latin1')); if (m) b = Buffer.from(b.toString('latin1').slice(m[0].length), 'base64');
    fs.writeFileSync(path.join(dir, name), b); console.log('saved', name, (b.length / 1024).toFixed(0) + ' KB'); res.end('ok');
  });
}).listen(5188, '127.0.0.1', () => console.log('shot server on :5188 ->', dir));
