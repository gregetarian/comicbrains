"""M9: custom / non-MNI template. bake_template() writes a template the engine consumes, and
`render --template DIR` overlays it onto the engine (visualisation-grade, bring-your-own-aligned)."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import trimesh

from glass_brains.bake import bake_template

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "glass_brains" / "web" / "data"
SPHERE = str(ROOT / "test_sphere.nii.gz")
PNG = b"\x89PNG\r\n\x1a\n"


def test_bake_template_writes_custom_assets(tmp_path):
    ico = trimesh.creation.icosphere(subdivisions=2, radius=60.0)
    surfaces = {"lh": (ico.vertices - [30, 0, 0], ico.faces),
                "rh": (ico.vertices + [30, 0, 0], ico.faces)}
    aseg = np.zeros((8, 8, 8), np.uint8)
    aseg[2:6, 2:6, 2:6] = 3                       # label 3 -> lh_cortex
    out = bake_template(tmp_path / "tpl", surfaces, aseg=aseg, aseg_affine=np.eye(4),
                        labels={3: "lh_cortex"}, space="toy")
    data = Path(out) / "data"
    assert (data / "cortex_lh.glb").exists() and (data / "cortex_rh.glb").exists()
    scene = json.loads((data / "scene.json").read_text())
    assert scene["space"] == "toy" and scene["templateMode"] == "custom"
    aj = json.loads((data / "aseg.json").read_text())
    assert aj["categories"] == {"3": "lh_cortex"} and aj["structureCategories"] == ["lh_cortex"]


def test_render_against_custom_template(tmp_path):
    # A custom template dir = the bundled assets tagged 'custom' — proves prepare_render_dir's
    # template overlay + render against a custom scene/aseg (the exact shape bake_template emits).
    tpl = tmp_path / "tpl"
    (tpl / "data" / "subcortical").mkdir(parents=True)
    for f in DATA.glob("*"):
        if f.is_file():
            shutil.copy2(f, tpl / "data" / f.name)
    for f in (DATA / "subcortical").glob("*"):
        shutil.copy2(f, tpl / "data" / "subcortical" / f.name)
    sc = json.loads((tpl / "data" / "scene.json").read_text())
    sc["templateMode"] = "custom"; sc["space"] = "customMNI"
    (tpl / "data" / "scene.json").write_text(json.dumps(sc))

    out = tmp_path / "fig.png"
    r = subprocess.run(
        [sys.executable, "-m", "glass_brains.core", "render", SPHERE, "-o", str(out),
         "--template", str(tpl), "--grid", "1x1", "--views", "left_lateral",
         "--width", "400", "--height", "320", "--scale", "1", "--no-colorbar"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert out.exists() and out.read_bytes()[:8] == PNG
