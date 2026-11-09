#!/usr/bin/env python3
"""road-spline.py - evaluate roads.json Catmull-Rom splines like the loader.

Uniform Catmull-Rom over the control-point index (not arc length), in the x,z
plane, end points duplicated as phantom neighbours. y comes from the map
heightmap on normal segments and is linearly interpolated on bridge segments.

Usage:
  python docs/examples/road-spline.py public/maps/sample
  python docs/examples/road-spline.py public/maps/sample --spacing 10
  python docs/examples/road-spline.py public/maps/sample --json
"""

import json
import math
import os
import struct
import sys


def load_height(dirname, n, world, max_h):
    path = os.path.join(dirname, "heightmap.r16")
    if not os.path.exists(path):
        return None
    blob = open(path, "rb").read()
    if len(blob) != n * n * 2:
        return None
    vals = struct.unpack("<" + "H" * (n * n), blob)
    return [v / 65535.0 * max_h for v in vals]


def height_at(height, n, cell, x, z):
    if height is None:
        return None
    fx = max(0.0, min(n - 1.0, x / cell - 0.5))
    fz = max(0.0, min(n - 1.0, z / cell - 0.5))
    x0 = min(int(fx), n - 2)
    z0 = min(int(fz), n - 2)
    tx, tz = fx - x0, fz - z0
    h00 = height[x0 + z0 * n]
    h10 = height[x0 + 1 + z0 * n]
    h01 = height[x0 + (z0 + 1) * n]
    h11 = height[x0 + 1 + (z0 + 1) * n]
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz


def cr(a, b, c, d, t):
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t +
                  (-a + 3 * b - 3 * c + d) * t * t * t)


def dcr(a, b, c, d, t):
    return 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t +
                  3 * (-a + 3 * b - 3 * c + d) * t * t)


def get_points(pts, spacing, height, n, cell):
    count = len(pts)
    if count == 0:
        return []
    if count == 1:
        p = pts[0]
        return [dict(x=p["x"], y=p["y"], z=p["z"], bridge=p["bridge"], seg=0, u=0.0)]

    def seg_point(i, f):
        p0 = pts[max(i - 1, 0)]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[min(i + 2, count - 1)]
        x = cr(p0["x"], p1["x"], p2["x"], p3["x"], f)
        z = cr(p0["z"], p1["z"], p2["z"], p3["z"], f)
        tx = dcr(p0["x"], p1["x"], p2["x"], p3["x"], f)
        tz = dcr(p0["z"], p1["z"], p2["z"], p3["z"], f)
        length = math.hypot(tx, tz) or 1.0
        bridge = bool(p1["bridge"])
        y = (p1["y"] + (p2["y"] - p1["y"]) * f if bridge or height is None
             else height_at(height, n, cell, x, z))
        return dict(x=x, y=y, z=z, bridge=bridge, seg=i, u=i + f, tx=tx / length, tz=tz / length)

    out = []
    for i in range(count - 1):
        chord = math.hypot(pts[i + 1]["x"] - pts[i]["x"], pts[i + 1]["z"] - pts[i]["z"])
        m = max(2, math.ceil(chord / spacing))
        for k in range(m):
            out.append(seg_point(i, k / m))
    out.append(seg_point(count - 2, 1.0))
    return out


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "public/maps/sample"
    spacing = 5.0
    if "--spacing" in sys.argv:
        i = sys.argv.index("--spacing")
        spacing = float(sys.argv[i + 1])
    as_json = "--json" in sys.argv

    map_json = json.load(open(os.path.join(folder, "map.json")))
    roads_json = json.load(open(os.path.join(folder, "roads.json")))
    n = map_json["N"]
    world = map_json["worldSizeMeters"]
    max_h = map_json["maxHeightMeters"]
    cell = world / n
    height = load_height(folder, n, world, max_h)

    result = []
    for road in roads_json["roads"]:
        pts = [dict(
            x=p["x"] if "x" in p else p["nx"] * world,
            z=p["z"] if "z" in p else p["nz"] * world,
            y=p["y"], bridge=bool(p.get("bridge", False))) for p in road["points"]]
        sampled = get_points(pts, spacing, height, n, cell)
        length = sum(math.hypot(sampled[i]["x"] - sampled[i - 1]["x"], sampled[i]["z"] - sampled[i - 1]["z"])
                     for i in range(1, len(sampled)))
        result.append(dict(id=road["id"], width=road["widthMeters"], controls=len(pts),
                           spacing=spacing, length=length, points=sampled))

    if as_json:
        print(json.dumps(result, indent=1))
        return
    for r in result:
        print(f"road {r['id']}: {r['controls']} control points, {len(r['points'])} samples @ {r['spacing']} m, "
              f"length {r['length']:.2f} m, width {r['width']} m")
        for p in r["points"][:5]:
            y = "n/a" if p["y"] is None else f"{p['y']:.3f}"
            print(f"  u={p['u']:.3f} seg={p['seg']} x={p['x']:.3f} y={y} z={p['z']:.3f}{' bridge' if p['bridge'] else ''}")
        if len(r["points"]) > 5:
            p = r["points"][-1]
            y = "n/a" if p["y"] is None else f"{p['y']:.3f}"
            print(f"  ... last: u={p['u']:.3f} x={p['x']:.3f} y={y} z={p['z']:.3f}{' bridge' if p['bridge'] else ''}")


if __name__ == "__main__":
    main()
