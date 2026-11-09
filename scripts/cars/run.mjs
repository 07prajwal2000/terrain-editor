// `npm run cars`: FBX -> GLB, then preview sheet. Blender path / source dir: env BLENDER, CARS_SRC (else scripts/cars/config.json).
// Needs only Blender (numpy ships with it); no Pillow.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const cfg = JSON.parse(readFileSync(resolve(here, 'config.json'), 'utf8'));
const blender = process.env.BLENDER || cfg.blender || 'blender';
const src = resolve(process.env.CARS_SRC || cfg.src);
const out = resolve(process.env.CARS_OUT || cfg.out);
for (const script of ['convert.py', 'render_sheet.py']) {
  const args = ['--background', '--python', resolve(here, script), '--', ...(script === 'convert.py' ? [src, out] : [out])];
  console.log(`> ${script}`);
  execFileSync(blender, args, { stdio: 'inherit' });
}
