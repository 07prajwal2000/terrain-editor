#!/usr/bin/env python3
"""heightmap-to-obj.py - turn a 16-bit heightmap into an OBJ grid mesh.

Standard library only. Writes world-scale vertices so the mesh can be imported
into Blender or any other DCC tool without rescaling.

Axes written to the OBJ (same as the game, right-handed with +Y up):
  x = (i + 0.5) * cell   east  (increasing pixel column)
  z = (j + 0.5) * cell   south (increasing pixel row, i.e. DOWN the image)
  y = raw16 / 65535 * maxHeightMeters

Because +Z points south, a model viewed from +Y is mirrored compared with
north-up tools. If you need north-up, negate z (and reverse the face winding).

Usage:
  python docs/examples/heightmap-to-obj.py public/maps/sample out/sample.obj
  python docs/examples/heightmap-to-obj.py public/maps/sample out/sample-low.obj --step 4
  python docs/examples/heightmap-to-obj.py public/maps/sample out/sample.obj --center

--step N  decimate by N (default 1, i.e. every sample)
--center  shift x/z to be centred on the origin
"""

import json
import os
import struct
import sys


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print("usage: python docs/examples/heightmap-to-obj.py <map-folder> <out.obj> [--step N] [--center]", file=sys.stderr)
        sys.exit(1)
    folder, out_path = args[0], args[1]
    step = 1
    if "--step" in sys.argv:
        step = max(1, int(sys.argv[sys.argv.index("--step") + 1]))
    center = "--center" in sys.argv

    map_json = json.load(open(os.path.join(folder, "map.json")))
    n = map_json["N"]
    world = map_json["worldSizeMeters"]
    max_h = map_json["maxHeightMeters"]
    cell = world / n

    blob = open(os.path.join(folder, map_json["files"].get("heightRaw16", "heightmap.r16")), "rb").read()
    if len(blob) != n * n * 2:
        raise SystemExit(f"heightmap.r16 is {len(blob)} bytes, expected {n * n * 2}")
    heights = struct.unpack("<" + "H" * (n * n), blob)
    half = world / 2.0

    indices = list(range(0, n, step))
    if indices[-1] != n - 1:
        indices.append(n - 1)
    x0 = (indices[0] + 0.5) * cell - (half if center else 0.0)
    z0 = x0

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# heightmap-to-obj.py\n")
        f.write(f"# source {folder}, N={n}, world={world} m, maxHeight={max_h} m, step={step}\n")
        f.write("# x=east, z=south (down the image), y=up\n")
        f.write(f"o {os.path.splitext(os.path.basename(out_path))[0]}\n")
        for j in indices:
            z = (j + 0.5) * cell - (half if center else 0.0)
            for i in indices:
                x = (i + 0.5) * cell - (half if center else 0.0)
                y = heights[i + j * n] / 65535.0 * max_h
                f.write(f"v {x:.4f} {y:.4f} {z:.4f}\n")

        cols = len(indices)
        for jj in range(len(indices) - 1):
            for ii in range(cols - 1):
                a = jj * cols + ii + 1
                b = a + 1
                c = a + cols
                d = c + 1
                # a=(i,j) b=(i+1,j) c=(i,j+1) d=(i+1,j+1); (a,c,b) winds +Y.
                f.write(f"f {a} {c} {b}\n")
                f.write(f"f {b} {c} {d}\n")
    print(f"wrote {out_path}: {(cols) * (cols)} vertices, 2*{(cols - 1) * (cols - 1)} triangles")


if __name__ == "__main__":
    main()
