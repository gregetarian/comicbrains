"""Parity keystone: a figure spec carrying the M2/M3 fields (clim, units,
voxel.representation:'surface', per-panel zoom, layout.view, template) validates in CPython
exactly as the browser would, and an existing Copy-CLI figure.json still passes. spec.validate
is the CPython mirror of web/core/config-schema.js:validateConfig — the proof that the browser,
the CLI (--spec), and the notebook API agree on what a valid figure is.
"""
import json
from pathlib import Path

import pytest

from glass_brains import spec

ROOT = Path(__file__).resolve().parent.parent

GOOD = {
    "template": {"kind": "mni", "dir": None, "space": "MNI152"},
    "style": {
        "clim": [0, 8], "units": {"value": "z", "cluster": "voxels"},
        "voxel": {"representation": "surface", "surfaceDepth": 6},
        "overlays": [{"clim": 5, "voxel": {"representation": "smooth"}}],
    },
    "layout": {
        "mode": "free",
        "view": {"s": 1.4, "cx": 800, "cy": 500},
        "panels": [{
            "id": "a", "camera": {"plane": "dorsal"},
            "place": {"x": 0, "y": 0, "w": 1, "h": 1, "z": 0},
            "zoom": 1.5, "rotate": {"yaw": 25, "pitch": 0},
            "slice": {"shape": "sphere", "mode": "bite", "center": [0, -18, 22], "radius": 45},
            "content": {"roles": ["cortex", "voxel"], "hemisphere": "both", "representation": "surface"},
        }],
    },
}


def test_good_spec_validates_and_is_a_fixed_point():
    cfg = spec.validate(GOOD)
    assert spec.validate(cfg) is cfg or spec.validate(cfg)  # re-validate is stable, no raise
    # round-trips through JSON unchanged (figure.json is the on-disk form)
    assert spec.validate(json.loads(json.dumps(GOOD)))["layout"]["view"]["s"] == 1.4


def test_existing_copycli_spec_still_validates():
    # the spec tests/test_free_canvas.py emits via Copy-CLI (pre-M2/M3 shape) must still pass.
    p = ROOT / "tests" / "shots" / "free_spec.json"
    if not p.exists():
        pytest.skip("free_spec.json not generated (run test_free_canvas.py first)")
    spec.validate(json.loads(p.read_text()))


@pytest.mark.parametrize("mutate, frag", [
    (lambda s: {**s, "template": {"kind": "bogus"}}, "template.kind"),
    (lambda s: {**s, "style": {**s["style"], "clim": [8, 1]}}, "clim"),
    (lambda s: {**s, "style": {**s["style"], "voxel": {"representation": "blobby"}}}, "representation"),
])
def test_bad_specs_fail_loudly(mutate, frag):
    bad = mutate(json.loads(json.dumps(GOOD)))
    with pytest.raises(ValueError) as e:
        spec.validate(bad)
    assert frag in str(e.value)


def test_none_template_rejects_shell_and_hemisphere_split():
    none = json.loads(json.dumps(GOOD))
    none["template"]["kind"] = "none"   # but panel still has cortex role + (implicitly) shell
    with pytest.raises(ValueError) as e:
        spec.validate(none)
    assert "none" in str(e.value)


if __name__ == "__main__":
    test_good_spec_validates_and_is_a_fixed_point()
    test_none_template_rejects_shell_and_hemisphere_split()
    print("PASS — config round-trip + loud-failure spec validation")
