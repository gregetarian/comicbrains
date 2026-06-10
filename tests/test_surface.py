"""M8: surface-projection sampling — init_cortex + build_surface_projection (pial->white
K-depth line average). Emits a cortex sheet per hemi sampled from the volume."""
import json
from pathlib import Path

import numpy as np

from glass_brains import pipeline as P

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "glass_brains" / "web" / "data"
DEF = DATA / "defaults"


def _init():
    P.init_aseg((DATA / "aseg_uint8.bin.gz").read_bytes(), (DATA / "aseg.json").read_text())
    P.init_cortex((DATA / "cortex_surface.bin.gz").read_bytes(), (DATA / "cortex_surface.json").read_text())


def test_init_cortex_loads_both_hemis():
    _init()
    assert P._CORTEX["lh"]["verts"].shape == (163842, 3)
    assert P._CORTEX["lh"]["inward"].shape == (163842, 3)
    assert P._CORTEX["rh"]["faces"].shape[1] == 3


def test_surface_projection_samples_cortical_activation():
    _init()
    meta = json.loads(P.process_nifti(str(DEF / "faces.nii.gz"), "faces", 2.3, surface=True))
    assert "surface" in meta and set(meta["surface"]) <= {"lh", "rh"}
    bufs = P.get_all_buffers()
    nonzero = any(np.any(np.frombuffer(bufs[d["val"]], dtype=np.float32) != 0)
                  for d in meta["surface"].values())
    assert nonzero, "no supra-threshold cortical vertices sampled from a real cortical map"


def test_no_surface_when_not_requested():
    _init()
    meta = json.loads(P.process_nifti(str(DEF / "faces.nii.gz"), "faces", 2.3))  # surface=False default
    assert "surface" not in meta


def test_surface_render_is_nonblank_and_differs_from_voxel():
    import glass_brains as gb
    kw = dict(views=["left_lateral"], grid="1x1", width=400, height=320, scale=1, colorbar=False)
    surf = gb.render(str(DEF / "faces.nii.gz"), voxels="surface", **kw)
    vox = gb.render(str(DEF / "faces.nii.gz"), voxels="smooth", **kw)
    assert surf.png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(surf.png) > 5000           # a full cortex sheet, not a blank frame
    assert surf.png != vox.png            # surface projection differs from volumetric voxels


if __name__ == "__main__":
    test_init_cortex_loads_both_hemis()
    test_surface_projection_samples_cortical_activation()
    test_no_surface_when_not_requested()
    print("PASS — surface projection sampling")
