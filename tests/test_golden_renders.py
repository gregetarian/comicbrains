"""Golden-image regression net for the headless renderer.

Renders a few small reference figures and compares them, pixel-wise, to committed
baselines under tests/golden/. This is the net every later refactor (RenderSession,
classifier-as-data, clim plumbing, surface meshes, stage-only-diff) must stay green
through — they all claim byte/near-byte-identical output, and this makes that testable.

The tolerance (mean abs diff < ~2/255) absorbs only the tiny swiftshader anti-aliasing
jitter between two renders of the SAME config; it deliberately does NOT absorb a changed
colormap, threshold bucket, or geometry — those move pixels far more than 2/255.

Bless / re-bless the baselines after an INTENTIONAL visual change:
    python tests/test_golden_renders.py --update
Check (the default; also what pytest collects):
    python tests/test_golden_renders.py
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from glass_brains.render import build_layout, render_to_png

GOLD = Path(__file__).parent / "golden"
ROOT = Path(__file__).resolve().parent.parent
DEF = ROOT / "glass_brains" / "web" / "data" / "defaults"
TOL = 2.0          # mean abs diff over 0..255 channels
W, H, SCALE = 600, 400, 1

# (name, nifti(s), grid, views, style) — small, deterministic, white background, no colorbar.
JOBS = [
    ("sphere_1x2", str(ROOT / "test_sphere.nii.gz"), "1x2",
     ["left_lateral", "dorsal"], {}),
    ("sphere_2x2", str(ROOT / "test_sphere.nii.gz"), "2x2",
     ["left_lateral", "right_lateral", "dorsal", "anterior"], {}),
    ("multi_faces_language_1x2",
     [str(DEF / "faces.nii.gz"), str(DEF / "language.nii.gz")], "1x2",
     ["left_lateral", "dorsal"], {"overlays": [{"colormap": "Reds"}, {"colormap": "YlGnBu"}]}),
    ("surface_faces_llat", str(DEF / "faces.nii.gz"), "1x1",
     ["left_lateral"], {"voxel": {"representation": "surface"}}),   # M8 surface projection
]


def _render(job):
    name, nifti, grid, views, style = job
    out = Path("/tmp") / f"_golden_{name}.png"
    render_to_png(nifti, str(out), layout=build_layout(grid, views), style=style,
                  threshold=2.3, width=W, height=H, scale=SCALE, colorbar=False)
    return np.asarray(Image.open(out).convert("RGB"), dtype=np.float32)


def _diff(a, b):
    if a.shape != b.shape:
        return float("inf")
    return float(np.abs(a - b).mean())


def main(update=False):
    GOLD.mkdir(exist_ok=True)
    failures = []
    for job in JOBS:
        name = job[0]
        img = _render(job)
        ref_path = GOLD / f"{name}.png"
        if update or not ref_path.exists():
            Image.fromarray(img.astype(np.uint8)).save(ref_path)
            print(f"BLESSED {name} -> {ref_path}")
            continue
        ref = np.asarray(Image.open(ref_path).convert("RGB"), dtype=np.float32)
        d = _diff(img, ref)
        if d < TOL:
            print(f"PASS — {name}: mean abs diff {d:.4f} < {TOL}")
        else:
            failures.append((name, d))
            print(f"FAIL — {name}: mean abs diff {d:.4f} >= {TOL}")
    if failures:
        raise SystemExit("golden mismatch: " + ", ".join(f"{n} ({d:.3f})" for n, d in failures))


def test_golden_renders():
    main(update=False)


if __name__ == "__main__":
    main(update="--update" in sys.argv)
