#!/usr/bin/env python3
"""read-tmap.py - parse a .tmap project file with the Python standard library only.

Prints the magic, header length, format/version, N, settings, roads/markers and
the layer table. With --dump DIR it writes export-style raw arrays plus
map.json / roads.json / markers.json.

Usage:
  python docs/examples/read-tmap.py scripts/fixtures/roadmeta.tmap
  python docs/examples/read-tmap.py scripts/fixtures/roadmeta.tmap --dump out/roadmeta

Container layout:
  bytes 0..3   "TMAP"
  bytes 4..7   uint32 LE headerLength (JSON is 4-byte aligned, padded with spaces)
  bytes 8..    UTF-8 JSON header
  after that   raw little-endian typed arrays at 8 + headerLength + layer.offset
"""

import json
import os
import struct
import sys


def read_layer(blob, base, layer, fmt):
    start = base + layer["offset"]
    raw = blob[start:start + layer["byteLength"]]
    count = len(raw) // struct.calcsize(fmt)
    vals = struct.unpack("<" + fmt * count, raw)
    if sys.byteorder == "big" and fmt in ("f", "I"):
        # struct already decoded little-endian; nothing to swap here
        pass
    return vals


def main():
    if len(sys.argv) < 2:
        print("usage: python docs/examples/read-tmap.py <file.tmap> [--dump <dir>]", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    dump_dir = None
    if "--dump" in sys.argv:
        dump_dir = sys.argv[sys.argv.index("--dump") + 1] if sys.argv.index("--dump") + 1 < len(sys.argv) else None

    blob = open(path, "rb").read()
    if len(blob) < 8 or blob[0:4] != b"TMAP":
        raise SystemExit("missing TMAP magic")
    (header_length,) = struct.unpack_from("<I", blob, 4)
    header = json.loads(blob[8:8 + header_length].decode("utf-8"))
    base = 8 + header_length

    print(f"file            {path}")
    print("magic           TMAP")
    print(f"headerLength    {header_length} bytes (data starts at {base})")
    print(f"format/version  {header.get('format', '(none)')} / {header.get('version', '(none)')}")
    print(f"N               {header.get('N')}")
    print(f"settings        {json.dumps(header.get('settings', {}))}")
    print(f"roads           {len(header.get('roads', []))} (nextRoadId {header.get('nextRoadId', '-')})")
    print(f"markers         {len(header.get('markers', []))} (nextMarkerId {header.get('nextMarkerId', '-')})")
    print("layers:")
    for layer in header.get("layers", []):
        count = layer["byteLength"] // (4 if layer["type"] == "f32" else 1)
        print(f"  {layer['name']:<9} {layer['type']:<4} offset {layer['offset']:>9}  {layer['byteLength']:>9} bytes  {count} values")

    layers = {l["name"]: l for l in header.get("layers", [])}
    n = header.get("N", 0)
    max_h = header.get("settings", {}).get("maxHeightMeters", 0)

    height = None
    if "height" in layers:
        height = read_layer(blob, base, layers["height"], "f")
        print(f"height f32      {min(height):.4f} .. {max(height):.4f} normalized  ({min(height) * max_h:.3f} .. {max(height) * max_h:.3f} m)")
    if "water" in layers:
        water = read_layer(blob, base, layers["water"], "f")
        wet = sum(1 for v in water if v >= 0)
        print(f"water f32       {wet} wet samples, {len(water) - wet} dry (-1)")

    if dump_dir:
        os.makedirs(dump_dir, exist_ok=True)
        settings = header.get("settings", {})
        world = settings["worldSizeMeters"]
        max_h = settings["maxHeightMeters"]

        h16 = bytearray(n * n * 2)
        w16 = bytearray(n * n * 2)
        for i in range(n * n):
            hv = max(0.0, min(1.0, height[i]))
            struct.pack_into("<H", h16, i * 2, round(hv * 65535))
            if "water" in layers:
                wv = water[i]
                enc = 0 if wv < 0 else 1 + round(max(0.0, min(1.0, wv)) * 65534)
                struct.pack_into("<H", w16, i * 2, enc)
        open(os.path.join(dump_dir, "heightmap.r16"), "wb").write(h16)
        open(os.path.join(dump_dir, "heightmap.f32.raw"), "wb").write(
            blob[base + layers["height"]["offset"]:base + layers["height"]["offset"] + layers["height"]["byteLength"]])
        open(os.path.join(dump_dir, "water.u16.raw"), "wb").write(w16)
        if "water" in layers:
            open(os.path.join(dump_dir, "water.f32.raw"), "wb").write(
                blob[base + layers["water"]["offset"]:base + layers["water"]["offset"] + layers["water"]["byteLength"]])

        s0 = bytearray(n * n * 4)
        s1 = bytearray(n * n * 4)
        for c in range(8):
            layer = layers.get(f"weight{c}")
            if layer is None:
                continue
            data = blob[base + layer["offset"]:base + layer["offset"] + layer["byteLength"]]
            dst = s0 if c < 4 else s1
            for i in range(n * n):
                dst[i * 4 + (c & 3)] = data[i]
        open(os.path.join(dump_dir, "splat0.rgba8.raw"), "wb").write(s0)
        open(os.path.join(dump_dir, "splat1.rgba8.raw"), "wb").write(s1)

        colors = ["#5da130", "#1f5c2a", "#8a6a43", "#e0cf8f", "#7d7d7d", "#f2f6ff", "#333333", "#b0a0c0"]
        names = ["grass", "forest", "dirt", "sand", "rock", "snow", "road", "city"]
        map_json = {
            "formatVersion": 1,
            "N": n,
            "worldSizeMeters": world,
            "maxHeightMeters": max_h,
            "cellSizeMeters": world / n,
            "seaLevel": settings.get("seaLevel"),
            "seaLevelMeters": settings.get("seaLevel", 0) * max_h,
            "classes": [{"id": i, "name": names[i], "color": colors[i]} for i in range(8)],
            "files": {
                "heightRaw16": "heightmap.r16", "splat0": "splat0.rgba8.raw",
                "splat1": "splat1.rgba8.raw", "water": "water.u16.raw",
                "roads": "roads.json", "markers": "markers.json",
            },
        }
        if settings.get("driveSide", "right") != "right":
            map_json["driveSide"] = settings["driveSide"]
        if settings.get("signStyle", "us") != "us":
            map_json["signStyle"] = settings["signStyle"]
        json.dump(map_json, open(os.path.join(dump_dir, "map.json"), "w"), indent=1)
        json.dump({"formatVersion": 1, "roads": header.get("roads", [])},
                  open(os.path.join(dump_dir, "roads.json"), "w"), indent=1)
        json.dump({"version": 1, "markers": header.get("markers", [])},
                  open(os.path.join(dump_dir, "markers.json"), "w"), indent=1)
        print(f"dumped          {os.path.abspath(dump_dir)}")


if __name__ == "__main__":
    main()
