"""M8: surface-projection sampling — init_cortex + build_surface_projection (pial->white
K-depth line average). Emits a cortex sheet per hemi sampled from the volume."""
import json
from pathlib import Path

import numpy as np

from comic import pipeline as P
from comic.render import _wants_surface

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "comic" / "web" / "data"
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


def test_hybrid_panel_requests_surface_geometry_without_changing_global_voxel_mode():
    layout = {"panels": [{"content": {
        "roles": ["cortex", "anatomy", "voxel"],
        "representation": "surface",
    }}]}
    assert _wants_surface({"voxel": {"representation": "blocky"}}, layout) is True
    assert _wants_surface({}, {"panels": [{"view": "cortex_subcort_l", "content": {}}]}) is False
    assert _wants_surface({"voxel": {"representation": "blocky"}}, {"panels": []}) is False


def test_negative_cortical_values_survive_surface_projection(tmp_path):
    import nibabel as nib

    _init()
    src = nib.load(str(DEF / "faces.nii.gz"))
    data = -np.abs(np.asarray(src.dataobj, dtype=np.float32))
    path = tmp_path / "negative_faces.nii.gz"
    nib.save(nib.Nifti1Image(data, src.affine, src.header), path)
    meta = json.loads(P.process_nifti(str(path), "negative faces", 2.3, surface=True))
    bufs = P.get_all_buffers()
    values = [np.frombuffer(bufs[d["val"]], dtype=np.float32) for d in meta["surface"].values()]
    assert values and any(np.any(v < -2.3) for v in values)


def test_surface_render_is_nonblank_and_differs_from_voxel():
    import comic as gb
    kw = dict(views=["left_lateral"], grid="1x1", width=400, height=320, scale=1, colorbar=False)
    surf = gb.render(str(DEF / "faces.nii.gz"), voxels="surface", **kw)
    vox = gb.render(str(DEF / "faces.nii.gz"), voxels="smooth", **kw)
    assert surf.png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(surf.png) > 5000           # a full cortex sheet, not a blank frame
    assert surf.png != vox.png            # surface projection differs from volumetric voxels


# --- Native surface overlays (per-vertex .gii/.mgh files, no volume) ------------------------
import tempfile
import shutil


def _synth_mgh(path, n=163842):
    """A synthetic per-vertex map: a supra-threshold patch (value 5) on an otherwise-zero sheet."""
    import nibabel as nib
    vals = np.zeros(n, np.float32)
    vals[1000:3000] = 5.0
    nib.save(nib.MGHImage(vals.reshape(-1, 1, 1), np.eye(4)), str(path))
    return vals


def test_load_surface_map_reads_mgh():
    d = Path(tempfile.mkdtemp())
    try:
        _synth_mgh(d / "lh.mgh")
        v = P.load_surface_map(str(d / "lh.mgh"))
        assert v.shape == (163842,) and v.dtype == np.float32
        assert int(np.count_nonzero(v)) == 2000
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_process_surface_is_surface_only():
    _init()
    d = Path(tempfile.mkdtemp())
    try:
        _synth_mgh(d / "lh.mgh"); _synth_mgh(d / "rh.mgh")
        meta = json.loads(P.process_surface(str(d / "lh.mgh"), str(d / "rh.mgh"), "synth", threshold=2.3))
        assert meta["surfaceOnly"] is True
        assert meta["structures"] == {}                 # NO blocky/smooth voxel geometry
        assert set(meta["surface"]) == {"lh", "rh"}
        assert meta["maxClusterSize"] == 0              # no volume clustering on a surface
        assert meta["maxAbsValue"] >= 4.9               # 99th pct of the value-5 patch
        bufs = P.get_all_buffers()
        for h in ("lh", "rh"):
            assert np.any(np.frombuffer(bufs[meta["surface"][h]["val"]], np.float32) != 0)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_process_surface_upsamples_fsaverage5():
    _init()
    d = Path(tempfile.mkdtemp())
    try:
        _synth_mgh(d / "lh.mgh", n=10242)               # fsaverage5 -> upsampled to the ico7 template
        meta = json.loads(P.process_surface(str(d / "lh.mgh"), None, "fs5", threshold=2.3))
        assert meta["surface"]["lh"]["nverts"] == 163842
        # upsampling preserves signal (the value-5 patch survives)
        bufs = P.get_all_buffers()
        assert np.any(np.frombuffer(bufs[meta["surface"]["lh"]["val"]], np.float32) >= 4.9)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_process_surface_rejects_non_fsaverage_vertex_count():
    _init()
    d = Path(tempfile.mkdtemp())
    try:
        _synth_mgh(d / "lh.mgh", n=50000)               # not an icosahedral fsaverage size
        try:
            P.process_surface(str(d / "lh.mgh"), None, "weird", threshold=2.3)
            assert False, "expected a vertex-count error"
        except ValueError as e:
            assert "50000" in str(e)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_prepare_render_dir_stages_surface_only_overlay():
    from comic.render import prepare_render_dir
    d = Path(tempfile.mkdtemp())
    try:
        _synth_mgh(d / "lh.mgh"); _synth_mgh(d / "rh.mgh")
        out = prepare_render_dir(surface_maps=[{"lh": str(d / "lh.mgh"), "rh": str(d / "rh.mgh"),
                                                "name": "synth"}], threshold=2.3)
        try:
            scene = json.loads((out / "data" / "scene.json").read_text())
            assert len(scene["overlays"]) == 1
            ov = scene["overlays"][0]
            assert ov["surfaceOnly"] is True and ov["structures"] == {}
            assert ov["name"] == "synth"
            assert (out / "data" / "overlay_0.bin").exists()
        finally:
            shutil.rmtree(out, ignore_errors=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    test_init_cortex_loads_both_hemis()
    test_surface_projection_samples_cortical_activation()
    test_no_surface_when_not_requested()
    test_load_surface_map_reads_mgh()
    test_process_surface_is_surface_only()
    test_process_surface_upsamples_fsaverage5()
    test_process_surface_rejects_non_fsaverage_vertex_count()
    test_prepare_render_dir_stages_surface_only_overlay()
    print("PASS — surface projection sampling + native surface overlays")
