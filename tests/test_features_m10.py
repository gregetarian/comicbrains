"""M10: sweep small-multiples + vector (SVG) colorbar legend."""
import subprocess
import sys
from pathlib import Path

from PIL import Image

from glass_brains.render import render_sweep, colorbar_svg, build_layout

ROOT = Path(__file__).resolve().parent.parent
F = str(ROOT / "glass_brains" / "web" / "data" / "defaults" / "faces.nii.gz")


def test_render_sweep_montage(tmp_path):
    out = render_sweep(F, tmp_path / "sw.png", layout=build_layout("1x1", ["dorsal"]),
                       param="cluster", values=[0, 100, 300], width=200, height=200, scale=1)
    im = Image.open(out)
    assert im.width > im.height and im.width >= 500   # 3 tiles wide


def test_colorbar_svg_builder(tmp_path):
    out = colorbar_svg(tmp_path / "cb.svg", colormap="coolwarm", vmin=-5, vmax=5, units="z")
    s = Path(out).read_text()
    assert s.startswith("<svg") and "linearGradient" in s and ">z</text>" in s and "5.0" in s


def test_cli_sweep_and_svg(tmp_path):
    out = tmp_path / "f.png"
    r = subprocess.run(
        [sys.executable, "-m", "glass_brains.core", "render", F, "-o", str(out),
         "--grid", "1x1", "--views", "dorsal", "--sweep", "cluster=0,150",
         "--colorbar-svg", "--width", "200", "--height", "200", "--scale", "1"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert out.exists() and (tmp_path / "f_colorbars.svg").exists()
