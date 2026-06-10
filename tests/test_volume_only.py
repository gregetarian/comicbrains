"""M6/M7: classifier-as-data + no-template volume-only mode.

The category tables now live in aseg.json (data, not hardcoded), so a custom segmentation can
drive classification (M9); the bundled fsaverage tables must load back byte-identically.
classify=False emits a single 'volume' bucket of every supra-threshold voxel (the no-template
path, M7) — meshed in the map's own space with no anatomical classification.
"""
import json
from pathlib import Path

from glass_brains import pipeline as P

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "glass_brains" / "web" / "data"
SPHERE = str(ROOT / "test_sphere.nii.gz")


def _init():
    P.init_aseg((DATA / "aseg_uint8.bin.gz").read_bytes(), (DATA / "aseg.json").read_text())


def test_categories_loaded_from_sidecar_match_defaults():
    _init()
    assert P._ASEG["categories"] == P.ASEG_CATEGORIES               # data path == bundled tables
    assert P._ASEG["structureCategories"] == P.STRUCTURE_CATEGORIES


def test_classify_false_single_volume_bucket():
    _init()
    meta = json.loads(P.process_nifti(SPHERE, "t", 2.3, classify=False))
    assert set(meta["structures"]) == {"volume"}
    assert meta["structures"]["volume"]["blocky"]["nverts"] > 0     # non-empty geometry


def test_classify_true_never_produces_a_volume_bucket():
    _init()
    meta = json.loads(P.process_nifti(SPHERE, "t", 2.3))            # default classify=True
    assert "volume" not in meta["structures"]                       # regions, not the relaxed bucket


if __name__ == "__main__":
    test_categories_loaded_from_sidecar_match_defaults()
    test_classify_false_single_volume_bucket()
    test_classify_true_never_produces_a_volume_bucket()
    print("PASS — classifier-as-data + volume-only bucket")
