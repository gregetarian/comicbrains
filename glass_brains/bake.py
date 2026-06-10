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


if __name__ == "__main__":
    bake()
