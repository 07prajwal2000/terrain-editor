# Examples

Last verified: 2026-11-09 · three 0.187.0 · @dimforge/rapier3d-compat 0.21.0 · Node 24.14.0

Small scripts that read the export format directly. They are run against the
sample maps in `public/maps/`; nothing here is imported by the game.

| File | Runtime | What it does | Example |
|---|---|---|---|
| `read-export.mjs` | Node, no deps | Decodes `.r16` and 16-bit grayscale PNG, prints map size, height range and a bilinear height at a world position. | `node docs/examples/read-export.mjs public/maps/sample 250 250` |
| `read-tmap.mjs` | Node, no deps | Parses a `.tmap`: magic, header, settings, layer table, height range. `--dump DIR` writes raw export-style arrays + JSON. | `node docs/examples/read-tmap.mjs scripts/fixtures/roadmeta.tmap` |
| `read-tmap.py` | Python 3, stdlib | Same as above for Python. | `python docs/examples/read-tmap.py scripts/fixtures/roadmeta.tmap` |
| `road-spline.mjs` | Node, no deps | Evaluates `roads.json` Catmull-Rom splines at a spacing, with `y` from the heightmap. | `node docs/examples/road-spline.mjs public/maps/sample --spacing 10` |
| `road-spline.py` | Python 3, stdlib | Same as above for Python. | `python docs/examples/road-spline.py public/maps/sample` |
| `heightmap-to-obj.py` | Python 3, stdlib | Writes the heightmap as an OBJ grid (`--step` decimation, `--center`). | `python docs/examples/heightmap-to-obj.py public/maps/sample out/sample.obj --step 4` |
| `minimal-viewer.html` + `minimal-viewer.js` | Vite (Three.js + Rapier) | Smallest page that loads a map folder with the loader and renders it with a fly camera. | `npm run dev`, then `/docs/examples/minimal-viewer.html?map=/maps/sample/` |

`minimal-viewer.html` needs the Vite dev server (or a build that includes it);
opening the file with `file://` fails because of ES modules and bare imports.
