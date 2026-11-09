"""
FBX -> game-ready GLB car converter (Blender headless, idempotent, re-runnable).

  blender --background --python scripts/cars/convert.py -- <srcDir> <outDir>

Reads every *.fbx under <srcDir> (read-only), writes <outDir>/<slug>.glb and merges each car's
entry into <outDir>/cars.json (other entries are kept, so adding cars later is just a re-run).
LOD / damaged duplicates (file name contains lod, damaged, destroyed, broken, wreck) are skipped.
Per-car overrides (name, drivable, roles) and a credits string live in scripts/cars/config.json.

OUTPUT CONVENTION (glTF space, i.e. what Three.js sees)
  * Y-up, metres, all transforms applied, no cameras / lights / empties. Flat scene: the glTF scene root
    is the "car root"; its children are  body, wheel_fl, wheel_fr, wheel_rl, wheel_rr (+ extras).
  * Car faces +Z. Origin = on the ground (y = 0 = lowest point of the wheels) at the centre of the wheelbase and
    track (mean of the four corner wheel hubs in x and z).
  * Left / right are as seen from BEHIND the car looking along +Z:  left = +X, right = -X.
    fl = front left, fr = front right, rl = rear left, rr = rear right.
  * body = every non-wheel mesh joined, origin (0,0,0). Each wheel node's origin is its hub centre (bbox centre),
    the axle is the local X axis, so  node.rotation.x += a  spins it in place.
  * Multi-axle trucks: fl/fr = front axle, rl/rr = first rear axle, further wheels (front-to-back order) are
    wheel_rl2, wheel_rr2, wheel_rl3 ... and are listed under "extraWheels" in cars.json.
  * Materials are kept (this pack uses plain colour materials, no textures); any textures are embedded in the GLB
    and downscaled to <= 1024 px.
  * drivable = the four corner wheels exist as separate parts (named, or split off the body by the loose-parts
    heuristic) and config.json does not override it.
Facing is detected from the 'headlight' / 'rear light' materials (fallback: front/rear in wheel names, last resort
-Y in Blender = +Z in glTF). The long horizontal axis is rotated onto Y; wrong-scale (cm / mm) exports are rescaled
by powers of ten until the length is within 1.5..30 m.
"""
import bpy, bmesh, sys, os, re, json, glob
import numpy as np
from mathutils import Vector, Matrix

SKIP_RE = re.compile(r'(^|[\s_\-.])(lods?\d*|damaged?|destroyed|broken|wreck(ed)?|dmg)([\s_\-.]|$)', re.I)
TAG = '[cars]'


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def coords(me):
    a = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def xform(me, M):
    me.transform(M)
    if M.determinant() < 0:
        me.flip_normals()
    me.update()


def meshes():
    return [o for o in bpy.data.objects if o.type == 'MESH']


def bounds(objs):
    pts = np.concatenate([coords(o.data) for o in objs])
    return pts.min(0), pts.max(0)


def split_wheels(body):
    """Fallback when the wheels are merged into the body: find round loose parts (axle = X) at the lowest corners.
    Returns new wheel meshes and removes their faces from body.data; [] if it cannot find >= 4 on both sides.
    ponytail: assumes round parts whose axle is X; fine for 4-wheelers, unusual rigs fall back to drivable=false."""
    me = body.data
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    seen, islands = set(), []
    for f in bm.faces:
        if f.index in seen: continue
        stack, isl = [f], []; seen.add(f.index)
        while stack:
            c = stack.pop(); isl.append(c.index)
            for v in c.verts:
                for nf in v.link_faces:
                    if nf.index not in seen: seen.add(nf.index); stack.append(nf)
        islands.append(isl)
    zmin = min(v.co.z for v in bm.verts)
    groups = []  # tire + rim islands sharing a hub are merged
    for isl in islands:
        p = np.array([v.co[:] for i in isl for v in bm.faces[i].verts])
        lo, hi = p.min(0), p.max(0); d = hi - lo; c = (lo + hi) / 2; m = max(d[1], d[2])
        if not (0.25 <= m / 2 <= 1.6 and abs(d[1] - d[2]) <= 0.3 * m and d[0] <= 0.9 * m and lo[2] <= zmin + 0.15):
            continue
        for g in groups:
            if np.all(np.abs(g['c'] - c) < 0.3 * g['r']): g['f'] |= set(isl); break
        else: groups.append({'f': set(isl), 'c': c, 'r': m / 2})
    bm.free()
    if len(groups) < 4 or len({g['c'][0] > 0 for g in groups}) < 2: return []

    def keep(faces, invert):
        b = bmesh.new(); b.from_mesh(me); b.faces.ensure_lookup_table()
        bmesh.ops.delete(b, geom=[f for f in b.faces if (f.index in faces) == invert], context='FACES')
        return b
    out = []
    for g in groups:
        b = keep(g['f'], False); nm = me.copy(); b.to_mesh(nm); b.free(); out.append(nm)
    b = keep(set().union(*[g['f'] for g in groups]), True); b.to_mesh(me); b.free()
    return out


def face_centroid_y(obj, name_re):
    me = obj.data
    idx = [i for i, m in enumerate(me.materials) if m and re.search(name_re, m.name, re.I)]
    ys = [np.mean([me.vertices[v].co.y for v in p.vertices]) for p in me.polygons if p.material_index in idx]
    return float(np.mean(ys)) if ys else None


def load_and_flatten(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    for o in list(bpy.data.objects):
        if o.type != 'MESH': bpy.data.objects.remove(o)
    for o in meshes():  # bake world transform into the vertices, detach from any parent
        mw = o.matrix_world.copy()
        o.parent = None
        o.data = o.data.copy()
        xform(o.data, mw)
        o.matrix_world = Matrix.Identity(4)


def process(path, outdir, cfg):
    name = os.path.splitext(os.path.basename(path))[0]
    cid = slug(name)
    load_and_flatten(path)
    notes = []
    objs = meshes()
    if not objs: raise RuntimeError('no meshes')

    # --- scale: powers of ten until the longer horizontal side is 1.5..30 m
    lo, hi = bounds(objs); L = max(hi[0] - lo[0], hi[1] - lo[1]); f = 1.0
    while L * f > 30 and f > 1e-4: f /= 10
    while L * f < 1.5 and f < 1e4: f *= 10
    if f != 1.0:
        notes.append('rescaled x%g' % f)
        for o in objs: xform(o.data, Matrix.Scale(f, 4))

    # --- wheels / body
    wheels = [o for o in objs if 'wheel' in o.name.lower()]
    bodies = [o for o in objs if o not in wheels]
    if not bodies: raise RuntimeError('only wheel meshes found')
    body = bodies[0]
    if len(bodies) > 1:
        bpy.ops.object.select_all(action='DESELECT')
        for o in bodies: o.select_set(True)
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.join()
    if len(wheels) < 4:
        for wm in split_wheels(body):
            o = bpy.data.objects.new('wheel_split', wm); bpy.context.scene.collection.objects.link(o); wheels.append(o)
        if len(wheels) >= 4: notes.append('wheels split off body by loose-part heuristic')
    parts = [body] + wheels

    # --- long axis -> Y
    lo, hi = bounds(parts)
    if hi[0] - lo[0] > hi[1] - lo[1]:
        for o in parts: xform(o.data, Matrix.Rotation(np.pi / 2, 4, 'Z'))
        notes.append('rotated 90deg about Z')

    # --- facing: front must be at -Y (Blender) == +Z (glTF)
    fy, ry = face_centroid_y(body, r'head\s*light'), face_centroid_y(body, r'rear\s*light|tail\s*light|brake')
    if fy is not None and ry is not None:
        front_neg, how = fy < ry, 'lights'
    else:
        fw = [coords(w.data)[:, 1].mean() for w in wheels if 'front' in w.name.lower()]
        rw = [coords(w.data)[:, 1].mean() for w in wheels if 'rear' in w.name.lower()]
        front_neg, how = (np.mean(fw) < np.mean(rw), 'wheel names') if fw and rw else (True, 'assumed')
    if not front_neg:
        for o in parts: xform(o.data, Matrix.Rotation(np.pi, 4, 'Z'))
        notes.append('flipped 180deg (facing by %s)' % how)

    # --- wheel hubs, classify by position (left = +X, front = most -Y on each side)
    info = []
    for w in wheels:
        c = coords(w.data); lo_, hi_ = c.min(0), c.max(0)
        info.append({'o': w, 'hub': Vector((lo_ + hi_) / 2), 'r': float((hi_[2] - lo_[2]) / 2), 'bot': float(lo_[2])})
    xm = np.mean([i['hub'].x for i in info]) if info else 0
    sides = {'l': sorted([i for i in info if i['hub'].x > xm], key=lambda i: i['hub'].y),
             'r': sorted([i for i in info if i['hub'].x <= xm], key=lambda i: i['hub'].y)}
    named = {}
    for s, lst in sides.items():
        for k, i in enumerate(lst):
            named['f' + s if k == 0 else ('r' + s if k == 1 else 'r%s%d' % (s, k))] = i
    drivable = all(k in named for k in ('fl', 'fr', 'rl', 'rr')) and len(sides['l']) == len(sides['r'])
    if not drivable: notes.append('wheels not identified reliably -> drivable=false')
    if not info: raise RuntimeError('no wheels found')

    # --- re-centre: x/y on the corner-wheel centre, z so the wheels touch 0
    core = [named[k] for k in ('fl', 'fr', 'rl', 'rr') if k in named] or info
    cx, cy = np.mean([i['hub'].x for i in core]), np.mean([i['hub'].y for i in core])
    T = Matrix.Translation((-cx, -cy, -min(i['bot'] for i in info)))
    for o in parts: xform(o.data, T)
    for i in info: i['hub'] = T @ i['hub']

    # --- rename, re-pivot wheels onto the hub
    body.name = body.data.name = 'body'
    for k, i in named.items(): i['o'].name = i['o'].data.name = 'wheel_' + k
    for i in info:
        i['o'].data.transform(Matrix.Translation(-i['hub'])); i['o'].location = i['hub']

    # --- textures <= 1024
    for img in bpy.data.images:
        if max(img.size) > 1024:
            s = 1024 / max(img.size); img.scale(max(1, int(img.size[0] * s)), max(1, int(img.size[1] * s))); notes.append('texture downscaled')

    # --- metadata (glTF space: x, y = Blender z, z = -Blender y)
    g = lambda v: [round(float(v[0]), 4), round(float(v[2]), 4), round(float(-v[1]), 4)]
    allp = np.concatenate([coords(body.data)] + [coords(i['o'].data) + np.array(i['hub']) for i in info])
    lo, hi = allp.min(0), allp.max(0)
    meta = {
        'id': cid, 'name': name, 'glb': '/cars/%s.glb' % cid, 'drivable': drivable,
        'dimensions': {'length': round(float(hi[1] - lo[1]), 3), 'width': round(float(hi[0] - lo[0]), 3), 'height': round(float(hi[2] - lo[2]), 3)},
        'wheelRadius': round(float(np.mean([i['r'] for i in core])), 4),
    }
    if drivable:
        w = {k: g(named[k]['hub']) for k in ('fl', 'fr', 'rl', 'rr')}
        meta['wheelbase'] = round(abs(w['fl'][2] - w['rl'][2]), 4)
        meta['trackWidth'] = round(abs(w['fl'][0] - w['fr'][0]), 4)
        meta['wheels'] = w
        extra = {'wheel_' + k: g(i['hub']) for k, i in named.items() if k not in w}
        if extra: meta['extraWheels'] = extra
    meta['triangles'] = sum(len(p.vertices) - 2 for o in parts for p in o.data.polygons)
    ov = cfg.get('overrides', {}).get(cid, {})
    meta.update({k: v for k, v in ov.items() if k in ('name', 'drivable', 'roles')})
    if drivable and meta['drivable'] is False: notes.append('config override: drivable=false')
    meta['roles'] = ov.get('roles') or (['player', 'static'] if meta['drivable'] else ['static'])

    os.makedirs(outdir, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(outdir, cid + '.glb'), export_format='GLB', export_yup=True,
                              export_cameras=False, export_lights=False, export_apply=True)
    return meta, notes


def find_credits(src):
    for p in glob.glob(os.path.join(src, '**', '*'), recursive=True):
        if os.path.isfile(p) and re.search(r'licen[cs]e|readme|credit', os.path.basename(p), re.I):
            with open(p, encoding='utf-8', errors='replace') as fh:  # untrusted text: read only, truncated
                t = ' '.join(fh.read(600).split())
            if t: return t[:300]
    return None


def main():
    src, out = [os.path.abspath(a) for a in sys.argv[sys.argv.index('--') + 1:][:2]]
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    credits = cfg.get('credits') or find_credits(src)
    mpath = os.path.join(out, 'cars.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {'version': 1, 'cars': []}
    cars = {c['id']: c for c in manifest.get('cars', [])}
    done, skipped, seen = [], [], set()
    for path in sorted(glob.glob(os.path.join(src, '**', '*.fbx'), recursive=True)):
        stem = os.path.splitext(os.path.basename(path))[0]
        if SKIP_RE.search(stem): skipped.append((stem, 'LOD/damaged variant')); continue
        if slug(stem) in seen: skipped.append((stem, 'duplicate id ' + slug(stem))); continue
        seen.add(slug(stem))
        try:
            meta, notes = process(path, out, cfg)
        except Exception as e:  # keep going, reported at the end
            skipped.append((stem, 'error: %s' % e)); continue
        meta['credits'] = credits
        if 'sprite' in cars.get(meta['id'], {}): meta['sprite'] = cars[meta['id']]['sprite']
        cars[meta['id']] = meta
        done.append((meta, notes))
    manifest['cars'] = sorted(cars.values(), key=lambda c: c['name'].lower())
    json.dump(manifest, open(mpath, 'w'), indent=1)
    for m, n in done:
        print(TAG, 'OK  %-20s drivable=%-5s tris=%-5d L=%.2f W=%.2f H=%.2f r=%s %s' % (m['id'], m['drivable'], m['triangles'], m['dimensions']['length'], m['dimensions']['width'], m['dimensions']['height'], m['wheelRadius'], '; '.join(n)))
    for s, why in skipped: print(TAG, 'SKIP', s, '-', why)
    print(TAG, 'converted %d, skipped %d' % (len(done), len(skipped)))


if __name__ == '__main__':
    main()
