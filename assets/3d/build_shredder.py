"""
Builds the SafePrint shredder model and exports it for the post-print
animation (components/ShredderScene.tsx).

    pip install bpy            # Blender as a Python module (5.x)
    python assets/3d/build_shredder.py [--preview out_dir]

Writes public/models/shredder.glb. With --preview it also renders a couple of
Cycles stills for review.

Units are metres, Blender Z-up (the glTF exporter converts to Y-up). Named
nodes the scene animates: Head, Bin, Window, BladeL, BladeR, LED, Slot.
The slot runs along X at the top centre; paper enters at y=0.
"""
import math
import os
import sys

import bpy  # noqa: I001 — must load before bmesh
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "shredder.glb")

# Overall dimensions (a typical office cross-cut shredder).
W, D = 0.34, 0.24  # width (x), depth (y)
BIN_H = 0.34
HEAD_H = 0.10
SLOT_W, SLOT_GAP = 0.25, 0.006


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    return scene


def box(name, size, loc, bevel=0.0, segments=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        add_bevel(ob, bevel, segments)
    return ob


def add_bevel(ob, width, segments=3):
    m = ob.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.harden_normals = True
    return m


def boolean(ob, cutter, op="DIFFERENCE"):
    m = ob.modifiers.new(f"Bool-{cutter.name}", "BOOLEAN")
    m.operation = op
    m.object = cutter
    m.solver = "EXACT"
    cutter.hide_render = True
    cutter.hide_viewport = True
    return m


def apply_all(ob):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    ob.select_set(False)


def smooth(ob, angle=35):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
    ob.select_set(False)


def delete(ob):
    bpy.data.objects.remove(ob, do_unlink=True)


def material(name, color, metallic=0.0, roughness=0.5, alpha=1.0, emission=None, strength=0.0, specular=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = specular
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


def brushed_metal(name, size=512):
    """Brushed aluminium: streaky roughness + subtle tint, baked to an image
    so it survives glTF export (procedural nodes don't)."""
    img = bpy.data.images.new(f"{name}-rough", size, size)
    px = []
    import random

    rnd = random.Random(7)
    rows = []
    for y in range(size):
        base = 0.28 + 0.10 * rnd.random()
        rows.append(base)
    for y in range(size):
        # Streaks run along X; neighbouring rows blend so it reads as brushing.
        r = (rows[y] * 2 + rows[(y + 1) % size] + rows[y - 1]) / 4
        for x in range(size):
            v = r + 0.03 * math.sin(x * 0.05 + y)
            px += [v, v, v, 1.0]
    img.pixels = px
    img.file_format = "JPEG"
    img.pack()

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.80, 0.81, 0.83, 1)
    bsdf.inputs["Metallic"].default_value = 1.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
    return mat


def uv_unwrap(ob):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    ob.select_set(False)


# ---------------------------------------------------------------------------
# parts
# ---------------------------------------------------------------------------
def build_bin(mats):
    """Hollow bin (open top, covered by the head) with a smoked front window."""
    outer = box("Bin", (W, D, BIN_H), (0, 0, BIN_H / 2), bevel=0.012)
    apply_all(outer)
    inner = box("bin-inner", (W - 0.012, D - 0.012, BIN_H), (0, 0, BIN_H / 2 + 0.006))
    win = box("bin-window-cut", (0.20, 0.05, 0.13), (0, -D / 2, 0.20), bevel=0.01)
    apply_all(win)
    boolean(outer, inner)
    boolean(outer, win)
    # Finger grip under the head seam.
    # A shallow recess (the wall is 6 mm), so it never opens into the bin.
    grip = box("bin-grip", (0.12, 0.008, 0.018), (0, -D / 2, BIN_H - 0.035), bevel=0.003)
    apply_all(grip)
    boolean(outer, grip)
    apply_all(outer)
    for c in (inner, win, grip):
        delete(c)
    smooth(outer)
    assign(outer, mats["plastic"])

    # Dark gasket closing the seam between bin rim and motor head.
    seam = box("Seam", (W - 0.004, D - 0.004, 0.006), (0, 0, BIN_H + 0.001))
    assign(seam, mats["rubber"])

    pane = box("Window", (0.21, 0.004, 0.14), (0, -D / 2 + 0.004, 0.20), bevel=0.008)
    apply_all(pane)
    assign(pane, mats["glass"])

    for i, (x, y) in enumerate([(-1, -1), (1, -1), (-1, 1), (1, 1)]):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.014, depth=0.008, location=(x * (W / 2 - 0.035), y * (D / 2 - 0.035), -0.004))
        foot = bpy.context.active_object
        foot.name = f"Foot{i}"
        assign(foot, mats["rubber"])
    return outer, pane


def build_head(mats):
    z0 = BIN_H + 0.004  # small seam between bin and head
    head = box("Head", (W + 0.008, D + 0.008, HEAD_H), (0, 0, z0 + HEAD_H / 2), bevel=0.016, segments=4)
    apply_all(head)
    slot = box("slot-cut", (SLOT_W, SLOT_GAP, HEAD_H * 2), (0, 0, z0 + HEAD_H))
    boolean(head, slot)
    apply_all(head)
    # Cooling vents on both sides of the motor head.
    vents = []
    for side in (-1, 1):
        for i in range(6):
            v = box(f"vent{side}{i}", (0.03, 0.12, 0.004), (side * (W / 2 + 0.004), 0.03 - 0.0, z0 + 0.025 + i * 0.009), bevel=0.0018)
            apply_all(v)
            boolean(head, v)
            vents.append(v)
    apply_all(head)
    for v in vents:
        delete(v)
    smooth(head)
    assign(head, mats["plastic"])

    # Brushed top plate, slightly inset, with the same slot.
    plate = box("TopPlate", (W - 0.02, D - 0.02, 0.004), (0, 0, z0 + HEAD_H + 0.002), bevel=0.003)
    slot2 = box("slot-cut2", (SLOT_W + 0.01, SLOT_GAP + 0.006, 0.05), (0, 0, z0 + HEAD_H))
    boolean(plate, slot2)
    apply_all(plate)
    delete(slot2)
    uv_unwrap(plate)
    assign(plate, mats["metal"])

    # Rubber lips along the slot.
    for side, name in ((-1, "LipF"), (1, "LipB")):
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.004, depth=SLOT_W + 0.014,
            location=(0, side * (SLOT_GAP / 2 + 0.004), z0 + HEAD_H + 0.004),
            rotation=(0, math.radians(90), 0),
        )
        lip = bpy.context.active_object
        lip.name = name
        smooth(lip)
        assign(lip, mats["rubber"])

    # Dark throat under the slot so you don't see through the head.
    throat = box("Slot", (SLOT_W, 0.03, HEAD_H - 0.02), (0, 0, z0 + HEAD_H / 2), bevel=0)
    assign(throat, mats["throat"])
    delete(slot)

    # Cutter shafts with toothed discs (spun in the browser).
    for side, name in ((-1, "BladeL"), (1, "BladeR")):
        blade = toothed_shaft(name, length=SLOT_W - 0.01, radius=0.011)
        blade.location = (0, side * 0.0115, z0 + HEAD_H - 0.03)
        assign(blade, mats["steel"])

    # Control strip: power rocker + status LED + label.
    rocker = box("Switch", (0.026, 0.016, 0.007), (W / 2 - 0.045, -D / 2 + 0.032, z0 + HEAD_H + 0.006), bevel=0.003)
    rocker.rotation_euler = (math.radians(8), 0, 0)
    assign(rocker, mats["rubber"])
    bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=0.004, location=(W / 2 - 0.085, -D / 2 + 0.035, z0 + HEAD_H + 0.004))
    led = bpy.context.active_object
    led.name = "LED"
    assign(led, mats["led"])

    bpy.ops.object.text_add(location=(0, -(D + 0.008) / 2 - 0.0005, z0 + HEAD_H / 2 - 0.012), rotation=(math.radians(90), 0, 0))
    label = bpy.context.active_object
    label.name = "Label"
    label.data.body = "SAFEPRINT"
    label.data.align_x = "CENTER"
    label.data.align_y = "CENTER"
    label.data.size = 0.028
    label.data.space_character = 1.25
    label.data.extrude = 0.0008
    bpy.ops.object.convert(target="MESH")
    assign(label, mats["label"])

    bpy.ops.object.text_add(location=(0, -(D + 0.008) / 2 - 0.0005, z0 + HEAD_H / 2 - 0.034), rotation=(math.radians(90), 0, 0))
    sub = bpy.context.active_object
    sub.name = "LabelSub"
    sub.data.body = "SECURE DOCUMENT DESTRUCTION"
    sub.data.align_x = "CENTER"
    sub.data.size = 0.0075
    sub.data.space_character = 1.4
    sub.data.extrude = 0.0003
    bpy.ops.object.convert(target="MESH")
    assign(sub, mats["label_dim"])
    return head


def toothed_shaft(name, length, radius, discs=22, teeth=10):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    # Core shaft.
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=radius * 0.45, radius2=radius * 0.45, depth=length,
                          matrix=_rot_y())
    step = length / discs
    for i in range(discs):
        x = -length / 2 + step * (i + 0.5)
        ring = []
        for k in range(teeth * 2):
            a = math.pi * 2 * k / (teeth * 2)
            r = radius if k % 2 == 0 else radius * 0.78
            ring.append((r * math.cos(a), r * math.sin(a)))
        t = step * 0.55
        verts_a = [bm.verts.new((x - t / 2, c, s)) for c, s in ring]
        verts_b = [bm.verts.new((x + t / 2, c, s)) for c, s in ring]
        bm.faces.new(verts_a[::-1])
        bm.faces.new(verts_b)
        n = len(ring)
        for k in range(n):
            bm.faces.new((verts_a[k], verts_a[(k + 1) % n], verts_b[(k + 1) % n], verts_b[k]))
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def _rot_y():
    from mathutils import Matrix

    return Matrix.Rotation(math.radians(90), 4, "Y")


def make_materials():
    return {
        "plastic": material("Plastic", (0.018, 0.019, 0.022), roughness=0.62, specular=0.25),
        "rubber": material("Rubber", (0.008, 0.008, 0.009), roughness=0.9, specular=0.15),
        "glass": material("SmokedGlass", (0.05, 0.06, 0.07), roughness=0.05, alpha=0.32),
        "metal": brushed_metal("BrushedAluminium"),
        "steel": material("Steel", (0.6, 0.6, 0.62), metallic=1.0, roughness=0.32),
        "throat": material("Throat", (0.0, 0.0, 0.0), roughness=1.0),
        "led": material("LED", (0.2, 1.0, 0.4), roughness=0.2, emission=(0.2, 1.0, 0.4), strength=4.0),
        "label": material("Label", (0.85, 0.85, 0.86), metallic=1.0, roughness=0.25),
        "label_dim": material("LabelDim", (0.45, 0.46, 0.48), metallic=0.6, roughness=0.4),
    }


# ---------------------------------------------------------------------------
# export + preview
# ---------------------------------------------------------------------------
def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for ob in list(bpy.data.objects):
        if ob.hide_render:
            delete(ob)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_image_format="JPEG",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        use_selection=False,
    )
    print(f"exported {path} ({os.path.getsize(path) / 1024:.0f} KB)")


def preview(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 900
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.92, 0.9, 0.86, 1)
    bg.inputs["Strength"].default_value = 0.18
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, -0.008))
    floor = bpy.context.active_object
    assign(floor, material("Floor", (0.85, 0.83, 0.79), roughness=0.7))

    def area(loc, energy, size):
        bpy.ops.object.light_add(type="AREA", location=loc)
        light = bpy.context.active_object
        light.data.energy = energy
        light.data.size = size
        light.rotation_euler = (Vector((0, 0, 0.25)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    area((0.9, -1.0, 1.3), 160, 1.0)
    area((-1.2, -0.4, 0.8), 40, 1.5)
    area((0.2, 1.2, 1.2), 120, 0.8)

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.data.lens = 50
    scene.camera = cam
    for name, loc, target in (
        ("three-quarter", (0.72, -1.05, 0.78), (0, 0, 0.24)),
        ("slot-closeup", (0.18, -0.38, 0.72), (0, 0, 0.43)),
    ):
        cam.location = loc
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(out_dir, f"shredder-{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", scene.render.filepath)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    reset()
    mats = make_materials()
    build_bin(mats)
    build_head(mats)
    export(OUT)
    if "--preview" in argv:
        preview(argv[argv.index("--preview") + 1])


if __name__ == "__main__":
    main()
