"""Bake the fixed fsaverage template assets into glass_brains/web/data/.

These do NOT depend on a user's upload, so we compute them once (with the full Python
stack — mne/trimesh/cmap, the `[bake]` extra) and commit them as static files. At
runtime the browser (Pyodide) and the CLI render both load them directly; only the
per-NIfTI meshing runs live (glass_brains/pipeline.py, the same in both).

Outputs (web/data/): cortex_{lh,rh}{,_inflated}.glb, subcortical/*.glb, colormaps.json,
scene.json (base, no overlays), render-config.json, aseg_uint8.bin.gz + aseg.json,
demo/{meta.json,buffers.bin}. Also copies the canonical pipeline.py into web/pyodide/.

Run:  glass-brains bake     (or  python -m glass_brains.bake)
"""

import gzip
import json
import shutil
from pathlib import Path

import numpy as np

PKG = Path(__file__).resolve().parent           # glass_brains/
WEB = PKG / "web"
DATA = WEB / "data"


def bake(demo_nifti=None):
    from .core import GlassBrain
    from .surfaces import inflate_surfaces
    from .export import export_mesh, export_mesh_with_scalars, write_scene_json
    from .colormaps import export_colormaps
    from . import pipeline as P

    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "subcortical").mkdir(exist_ok=True)

    print("Loading fsaverage template (surfaces + subcortical via mne)…")
    gb = GlassBrain(include_subcortical=True)

    # cortex: pial + slightly-inflated, curvature encoded in vertex-colour red
    inflated = inflate_surfaces(gb.surfaces)
    cortex_paths = {}
    for hemi, mesh in gb.surfaces.items():
        export_mesh_with_scalars(mesh, DATA / f"cortex_{hemi}.glb", scalar_name="curvature")
        export_mesh_with_scalars(inflated[hemi], DATA / f"cortex_{hemi}_inflated.glb", scalar_name="curvature")
        cortex_paths[hemi] = {"mesh": f"cortex_{hemi}.glb", "meshInflated": f"cortex_{hemi}_inflated.glb"}

    # subcortical: one solid-colour GLB each
    subcort_paths = {}
    for nm, mesh in gb.subcortical.items():
        safe = nm.lower().replace("-", "_").replace(" ", "_")
        rel = f"subcortical/{safe}.glb"
        color = gb.subcortical_colors.get(nm, (0.6, 0.6, 0.6))
        vc = (np.array([*color, 1.0]) * 255).astype(np.uint8)
        export_mesh(mesh, DATA / rel, vertex_colors=np.tile(vc, (len(mesh.vertices), 1)))
        subcort_paths[nm] = rel

    write_scene_json(DATA, cortex_meshes=cortex_paths, subcortical_meshes=subcort_paths,
                     subcortical_colors=gb.subcortical_colors, overlays=None)
    export_colormaps(DATA / "colormaps.json")
    # clusterMin defaults to 0 (not the FSL-ish 105): a general tool must not silently
    # hide arbitrary uploads (or the small demo).
    (DATA / "render-config.json").write_text(json.dumps(
        {"preset": "ninePanel", "style": {"colormap": "YlGnBu", "voxel": {"clusterMin": 0}}}, indent=2))

    # aseg (for in-browser voxel classification): gzipped uint8 256^3 C-order + sidecar.
    aseg = np.asarray(gb._aseg_data)
    assert aseg.max() < 256, f"aseg has labels >= 256 ({aseg.max()}); need a wider dtype"
    aseg_gz = gzip.compress(aseg.astype(np.uint8).tobytes(order="C"), compresslevel=9)
    (DATA / "aseg_uint8.bin.gz").write_bytes(aseg_gz)
    # Ship the category tables AS DATA so init_aseg is data-driven (a custom seg carries its own; M9).
    (DATA / "aseg.json").write_text(json.dumps(
        {"dims": list(aseg.shape), "dtype": "uint8", "order": "C", "affine": gb._aseg_affine.tolist(),
         "categories": {str(k): v for k, v in P.ASEG_CATEGORIES.items()},
         "structureCategories": list(P.STRUCTURE_CATEGORIES),
         "hasWhiteSurface": False}, indent=2))

    # keep the browser's Pyodide copy byte-identical to the canonical pipeline
    shutil.copy2(PKG / "pipeline.py", WEB / "pyodide" / "pipeline.py")

    # demo overlay (instant landing render, no Pyodide) — run through the SAME pipeline
    demo_nifti = Path(demo_nifti or (PKG.parent / "test_sphere.nii.gz"))
    P.init_aseg(aseg_gz, (DATA / "aseg.json").read_text())
    meta = json.loads(P.process_nifti(str(demo_nifti), demo_nifti.name, 2.3))
    blob = bytearray()
    layout = []
    for buf in P.get_all_buffers():
        layout.append([len(blob), len(buf)])
        blob.extend(buf)
    meta["bufferLayout"] = layout
    meta["buffersFile"] = "buffers.bin"
    (DATA / "demo").mkdir(exist_ok=True)
    (DATA / "demo" / "meta.json").write_text(json.dumps(meta))
    (DATA / "demo" / "buffers.bin").write_bytes(bytes(blob))

    print(f"Baked template + demo -> {DATA}")


def bake_template(out_dir, surfaces, *, inflated=None, aseg=None, aseg_affine=None, labels=None,
                  structure_categories=None, subcortical=None, subcortical_colors=None,
                  space="custom", has_white_surface=False):
    """Bake a CUSTOM template into <out_dir>/data/ (the shape `render --template DIR` overlays).

    `surfaces` is {hemi: trimesh OR (verts, faces[, curv])} — bring-your-own cortical surfaces in
    ANY space (visualisation-grade: the user supplies maps already aligned to this template; we do
    not register). `aseg` (a uint8 label volume) + `labels` (int -> category name) + `aseg_affine`
    drive voxel classification; omit them for a shell-only template (render with --no-template, or
    a classifying aseg is required for hemisphere/subcortical views). Reuses the fsaverage exporters,
    so a custom template feeds the SAME engine. Returns out_dir."""
    import shutil
    from .export import export_mesh, export_mesh_with_scalars, write_scene_json
    from .surfaces import to_trimesh

    out = Path(out_dir)
    data = out / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "subcortical").mkdir(exist_ok=True)

    def _mesh(s):
        if hasattr(s, "vertices"):
            return s
        v, f = np.asarray(s[0]), np.asarray(s[1])
        curv = np.asarray(s[2]) if len(s) > 2 and s[2] is not None else np.zeros(len(v), np.float32)
        return to_trimesh(v, f, {"curvature": curv})

    cortex_paths = {}
    for hemi, s in surfaces.items():
        export_mesh_with_scalars(_mesh(s), data / f"cortex_{hemi}.glb", scalar_name="curvature")
        cortex_paths[hemi] = {"mesh": f"cortex_{hemi}.glb"}
        if inflated and hemi in inflated:
            export_mesh_with_scalars(_mesh(inflated[hemi]), data / f"cortex_{hemi}_inflated.glb", scalar_name="curvature")
            cortex_paths[hemi]["meshInflated"] = f"cortex_{hemi}_inflated.glb"

    subcort_paths = {}
    for nm, m in (subcortical or {}).items():
        mesh = _mesh(m)
        safe = nm.lower().replace("-", "_").replace(" ", "_")
        rel = f"subcortical/{safe}.glb"
        color = (subcortical_colors or {}).get(nm, (0.6, 0.6, 0.6))
        vc = (np.array([*color, 1.0]) * 255).astype(np.uint8)
        export_mesh(mesh, data / rel, vertex_colors=np.tile(vc, (len(mesh.vertices), 1)))
        subcort_paths[nm] = rel

    write_scene_json(data, cortex_meshes=cortex_paths, subcortical_meshes=subcort_paths or None,
                     subcortical_colors=subcortical_colors, space=space, template_mode="custom",
                     has_white_surface=has_white_surface)

    if aseg is not None:
        aseg = np.asarray(aseg)
        assert aseg.max() < 256, f"aseg labels must be < 256 for uint8 (got {aseg.max()})"
        (data / "aseg_uint8.bin.gz").write_bytes(gzip.compress(aseg.astype(np.uint8).tobytes(order="C"), 9))
        cats = {str(int(k)): v for k, v in (labels or {}).items()}
        (data / "aseg.json").write_text(json.dumps({
            "dims": list(aseg.shape), "dtype": "uint8", "order": "C",
            "affine": (np.asarray(aseg_affine).tolist() if aseg_affine is not None else np.eye(4).tolist()),
            "categories": cats, "structureCategories": structure_categories or sorted(set(cats.values())),
            "hasWhiteSurface": has_white_surface}))

    cm = DATA / "colormaps.json"          # self-contained bundle (a browser .zip can ship its own)
    if cm.exists():
        shutil.copy2(cm, data / "colormaps.json")
    print(f"Baked custom template -> {data} (space={space}, {len(cortex_paths)} hemis, "
          f"{'aseg' if aseg is not None else 'no aseg'})")
    return out


def bake_surface_sidecar(out_dir=None):
    """Bake the cortical-surface sidecar for surface-projection mode (M8): per hemisphere, the
    pial vertices (MNI152) + faces + curvature + the inward offset to the white surface (so the
    pipeline can K-depth line-sample a volume across the cortical ribbon). Standalone — does NOT
    regenerate the cortex/subcortical GLBs, so it leaves existing baked assets byte-identical.
    """
    import mne
    import nibabel as nib
    from .surfaces import load_hemisphere, mni305_to_mni152
    out = Path(out_dir) if out_dir else DATA
    fs = Path(mne.datasets.fetch_fsaverage(verbose=False))
    surf = fs / "surf"
    if not surf.exists():
        surf = fs / "fsaverage" / "surf"

    blob = bytearray()
    layout = {}
    for hemi in ("lh", "rh"):
        pial, faces, curv = load_hemisphere(surf, hemi)
        white, _ = nib.freesurfer.read_geometry(str(surf / f"{hemi}.white"))
        pial152 = mni305_to_mni152(pial).astype(np.float32)
        inward = (mni305_to_mni152(white).astype(np.float32) - pial152).astype(np.float32)
        h = {"nverts": int(len(pial152)), "ntris": int(len(faces))}
        for name, arr, dt in [("pial", pial152, np.float32), ("inward", inward, np.float32),
                              ("faces", np.asarray(faces), np.uint32), ("curv", np.asarray(curv), np.float32)]:
            b = np.ascontiguousarray(arr, dtype=dt).tobytes()
            h[name] = [len(blob), len(b)]
            blob.extend(b)
        layout[hemi] = h
    (out / "cortex_surface.bin.gz").write_bytes(gzip.compress(bytes(blob), 9))
    (out / "cortex_surface.json").write_text(json.dumps(layout))
    sp = out / "scene.json"      # advertise availability so the viewer/CLI can offer surface mode
    sc = json.loads(sp.read_text()); sc["hasWhiteSurface"] = True; sp.write_text(json.dumps(sc))
    print(f"Baked surface sidecar -> {out/'cortex_surface.bin.gz'} "
          f"(lh {layout['lh']['nverts']} + rh {layout['rh']['nverts']} verts)")
    return out / "cortex_surface.bin.gz"


if __name__ == "__main__":
    bake()
