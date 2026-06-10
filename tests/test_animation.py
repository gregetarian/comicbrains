"""M10: turntable / orbit animation export (render_orbit + `render --orbit`)."""
import subprocess
import sys
from pathlib import Path

import glass_brains as gb
from glass_brains.render import render_orbit, build_layout

ROOT = Path(__file__).resolve().parent.parent
F = str(ROOT / "glass_brains" / "web" / "data" / "defaults" / "faces.nii.gz")


def test_render_orbit_frames_differ(tmp_path):
    frames = render_orbit(F, tmp_path / "spin.png", layout=build_layout("1x1", ["dorsal"]),
                          frames=3, degrees=270, width=240, height=240, scale=1)
    assert len(frames) == 3 and all(Path(f).exists() for f in frames)
    assert Path(frames[0]).read_bytes() != Path(frames[1]).read_bytes()   # rotation changes each frame


def test_cli_orbit(tmp_path):
    out = tmp_path / "o.png"
    r = subprocess.run(
        [sys.executable, "-m", "glass_brains.core", "render", F, "-o", str(out),
         "--grid", "1x1", "--views", "dorsal", "--orbit", "180", "--frames", "2",
         "--width", "240", "--height", "240", "--scale", "1"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert (tmp_path / "o_000.png").exists() and (tmp_path / "o_001.png").exists()


def test_render_orbit_and_batch_exported():
    assert hasattr(gb, "render_orbit") and hasattr(gb, "render_batch")
