"""
Render a 3/4 front preview of every car in <outDir>/cars.json and pack them into ONE spritesheet grid.

  blender --background --python scripts/cars/render_sheet.py -- <outDir>

Reads <outDir>/cars.json + <outDir>/<id>.glb (the converted cars, so this also checks the GLBs),
writes <outDir>/previews.png (+ previews.webp when Blender can save it) and updates cars.json:
"sheet" {url, cellW, cellH, cols, rows, width, height} and each car's "sprite" {col, row} (row 0 = top).
Re-runnable; always re-renders everything. No Pillow needed (packing is numpy inside Blender).

View: orthographic, camera at the car's front-left, 35deg off the nose, 22deg above the horizon; each car is
auto-framed so it fills its cell with a 5% margin. Soft world light + sun, soft blob ground shadow, transparent bg.
"""
import bpy, sys, os, json, math, tempfile
import numpy as np
from mathutils import Vector

CELL_W, CELL_H, SS = 256, 160, 2      # cell size, supersampling factor (render 2x, box-filter down = crisp AA)
AZ, EL, MARGIN, MAX_SHEET = math.radians(35), math.radians(22), 0.05, 2048


def setup_engine(scene):
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = eng; break
        except TypeError: continue
    if 'EEVEE' in scene.render.engine: scene.eevee.taa_render_samples = 32
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = CELL_W * SS, CELL_H * SS, 100
    scene.render.image_settings.file_format, scene.render.image_settings.color_mode = 'PNG', 'RGBA'
    scene.view_settings.view_transform, scene.view_settings.look = 'Standard', 'None'
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.82, 0.86, 0.92, 1); bg.inputs[1].default_value = 0.9
    scene.world = w


def add_light(scene, rot, energy, angle):
    d = bpy.data.lights.new('sun', 'SUN'); d.energy, d.angle = energy, angle
    o = bpy.data.objects.new('sun', d); o.rotation_euler = rot; scene.collection.objects.link(o)


def blob_shadow(scene, lo, hi):
    """Soft elliptical dark blob on the ground: transparent <-> black mix driven by a spherical gradient."""
    m = bpy.data.materials.new('shadow'); m.use_nodes = True
    try: m.surface_render_method = 'BLENDED'
    except Exception: m.blend_method = 'BLEND'
    t = m.node_tree; t.nodes.clear()
    co, gr, ramp, mix, tr, em, out = (t.nodes.new(n) for n in ('ShaderNodeTexCoord', 'ShaderNodeTexGradient', 'ShaderNodeMapRange', 'ShaderNodeMixShader', 'ShaderNodeBsdfTransparent', 'ShaderNodeEmission', 'ShaderNodeOutputMaterial'))
    gr.gradient_type = 'SPHERICAL'; ramp.inputs[4].default_value = 0.55  # max opacity
    em.inputs[0].default_value = (0, 0, 0, 1)
    t.links.new(co.outputs['Object'], gr.inputs[0]); t.links.new(gr.outputs['Fac'], ramp.inputs[0])
    t.links.new(ramp.outputs[0], mix.inputs[0]); t.links.new(tr.outputs[0], mix.inputs[1]); t.links.new(em.outputs[0], mix.inputs[2])
    t.links.new(mix.outputs[0], out.inputs[0])
    bpy.ops.mesh.primitive_plane_add(size=2, location=((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0.002))
    p = bpy.context.active_object; p.data.materials.append(m)
    p.scale = ((hi[0] - lo[0]) * 0.62, (hi[1] - lo[1]) * 0.62, 1)


def render_car(glb, tmp):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in bpy.data.objects if o.type == 'MESH']
    pts = np.concatenate([np.array([o.matrix_world @ v.co for v in o.data.vertices]) for o in objs])
    lo, hi = pts.min(0), pts.max(0)
    setup_engine(scene)
    add_light(scene, (math.radians(50), math.radians(10), math.radians(-35)), 3.0, 0.3)   # key
    add_light(scene, (math.radians(70), 0, math.radians(150)), 1.0, 0.6)                  # soft fill from behind
    blob_shadow(scene, lo, hi)
    # camera: front is -Y, left is +X
    d = Vector((math.sin(AZ) * math.cos(EL), -math.cos(AZ) * math.cos(EL), math.sin(EL)))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
    cam.location = d * 60
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    R = cam.matrix_world.to_3x3().transposed()
    t = np.linspace(0, 2 * np.pi, 24, endpoint=False)  # frame the shadow blob too, so it is never cropped by the cell
    ell = np.stack([(lo[0] + hi[0]) / 2 + (hi[0] - lo[0]) * 0.62 * np.cos(t), (lo[1] + hi[1]) / 2 + (hi[1] - lo[1]) * 0.62 * np.sin(t), 0 * t], 1)
    q = np.array([(R @ (Vector(p) - cam.location))[:2] for p in np.concatenate([pts, ell])])
    (x0, y0), (x1, y1) = q.min(0), q.max(0)
    w, h = x1 - x0, y1 - y0
    cd = cam.data; cd.type, cd.sensor_fit = 'ORTHO', 'HORIZONTAL'; cd.clip_start, cd.clip_end = 1, 200
    cd.ortho_scale = max(w, h * CELL_W / CELL_H) * (1 + 2 * MARGIN)
    cd.shift_x, cd.shift_y = (x0 + x1) / 2 / cd.ortho_scale, (y0 + y1) / 2 / cd.ortho_scale
    scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp, check_existing=False)
    img.colorspace_settings.name, img.alpha_mode = 'Non-Color', 'CHANNEL_PACKED'
    a = np.empty(len(img.pixels), dtype=np.float32); img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    a = a.reshape(CELL_H * SS, CELL_W * SS, 4)          # bottom-up rows, straight alpha
    a = np.concatenate([a[..., :3] * a[..., 3:], a[..., 3:]], -1)   # premultiply, box-filter, un-premultiply
    a = a.reshape(CELL_H, SS, CELL_W, SS, 4).mean((1, 3))
    al = a[..., 3:]
    return np.concatenate([np.where(al > 1e-6, a[..., :3] / np.maximum(al, 1e-6), 0), al], -1)[::-1]   # -> top-down


def save_image(name, arr, path, fmt):
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name, img.alpha_mode = 'Non-Color', 'CHANNEL_PACKED'
    img.pixels.foreach_set(np.ascontiguousarray(np.clip(arr[::-1], 0, 1)).ravel())
    img.filepath_raw, img.file_format = path, fmt
    img.save()


def main():
    out = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
    mpath = os.path.join(out, 'cars.json')
    manifest = json.load(open(mpath))
    cars = [c for c in manifest['cars'] if os.path.exists(os.path.join(out, c['id'] + '.glb'))]
    cols = min(len(cars), MAX_SHEET // CELL_W); rows = -(-len(cars) // cols)
    assert rows * CELL_H <= MAX_SHEET, 'too many cars for one 2048 sheet; lower CELL_W/CELL_H'
    sheet = np.zeros((rows * CELL_H, cols * CELL_W, 4), dtype=np.float32)
    tmp = os.path.join(tempfile.gettempdir(), 'car_preview_tmp.png')
    for i, c in enumerate(cars):
        r, k = divmod(i, cols)
        sheet[r * CELL_H:(r + 1) * CELL_H, k * CELL_W:(k + 1) * CELL_W] = render_car(os.path.join(out, c['id'] + '.glb'), tmp)
        c['sprite'] = {'col': k, 'row': r}
        print('[cars] rendered', c['id'], c['sprite'])
    save_image('sheet', sheet, os.path.join(out, 'previews.png'), 'PNG')
    manifest['sheet'] = {'url': '/cars/previews.png', 'cellW': CELL_W, 'cellH': CELL_H, 'cols': cols, 'rows': rows, 'width': cols * CELL_W, 'height': rows * CELL_H}
    try:
        save_image('sheet_webp', sheet, os.path.join(out, 'previews.webp'), 'WEBP'); manifest['sheet']['urlWebp'] = '/cars/previews.webp'
    except Exception as e: print('[cars] webp not written:', e)
    manifest['cars'] = cars
    json.dump(manifest, open(mpath, 'w'), indent=1)
    if os.path.exists(tmp): os.remove(tmp)
    print('[cars] sheet %dx%d, %d cars' % (cols * CELL_W, rows * CELL_H, len(cars)))


if __name__ == '__main__':
    main()
