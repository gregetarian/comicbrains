"""M10: per-region supra-threshold voxel-count report (from the aseg classification)."""
import csv
import subprocess
import sys
from pathlib import Path

import glass_brains as gb

ROOT = Path(__file__).resolve().parent.parent
F = str(ROOT / "glass_brains" / "web" / "data" / "defaults" / "faces.nii.gz")


def test_region_report_api():
    rc = gb.region_report(F, 2.3)
    assert rc and "lh_cortex" in rc
    assert all(isinstance(v, int) for v in rc.values()) and sum(rc.values()) > 0


def test_cli_regions_csv(tmp_path):
    out, reg = tmp_path / "f.png", tmp_path / "r.csv"
    r = subprocess.run(
        [sys.executable, "-m", "glass_brains.core", "render", F, "-o", str(out),
         "--grid", "1x1", "--views", "dorsal", "--regions", str(reg),
         "--width", "200", "--height", "200", "--scale", "1", "--no-colorbar"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    rows = list(csv.reader(open(reg)))
    assert rows[0] == ["overlay", "region", "voxels"] and len(rows) > 1
