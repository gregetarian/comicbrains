"""M5: CLI per-overlay comma-list flags — the standalone-CLI parity. The "one parser rule":
a bare scalar broadcasts to every overlay; a comma list binds per overlay (-> style.overlays[i])."""
import subprocess
import sys
from pathlib import Path

from glass_brains.core import _los, _parse_clim, _parse_units
from glass_brains.figure import build_style

ROOT = Path(__file__).resolve().parent.parent
DEF = ROOT / "glass_brains" / "web" / "data" / "defaults"
PNG = b"\x89PNG\r\n\x1a\n"


def test_los_scalar_vs_list():
    assert _los(None, float) is None
    assert _los("2.3", float) == 2.3                    # scalar -> global
    assert _los("2.3,4.0", float) == [2.3, 4.0]         # comma -> per overlay
    assert _los("Reds,YlGnBu", str) == ["Reds", "YlGnBu"]
    assert _los("a,,c", str) == ["a", None, "c"]        # blank element -> inherit


def test_parse_clim_and_units():
    assert _parse_clim("8") == 8.0
    assert _parse_clim(",8") == 8.0                     # blank vmin -> single bound
    assert _parse_clim("1,8") == [1.0, 8.0]
    assert _parse_units("value=z,cluster=mm3") == {"value": "z", "cluster": "mm3"}


def test_per_overlay_binding_matches_build_style():
    style, bake = build_style(2, cmap=_los("Reds,YlGnBu", str), threshold=_los("4,2.3", float),
                              clusterMin=_los("50,100", int))
    assert style["overlays"][0]["colormap"] == "Reds" and style["overlays"][1]["colormap"] == "YlGnBu"
    assert style["overlays"][0]["threshold"] == 4.0 and style["overlays"][1]["voxel"]["clusterMin"] == 100
    assert bake == [4.0, 2.3]
    # a bare scalar still broadcasts (regression for the pre-M5 behaviour)
    s2, b2 = build_style(2, cmap=_los("YlGnBu", str), threshold=_los("2.3", float))
    assert s2.get("colormap") == "YlGnBu" and b2 == 2.3 and not any(o.get("colormap") for o in s2.get("overlays", []))


def test_cli_render_per_overlay_end_to_end(tmp_path):
    out = tmp_path / "fig.png"
    r = subprocess.run(
        [sys.executable, "-m", "glass_brains.core", "render",
         str(DEF / "faces.nii.gz"), str(DEF / "language.nii.gz"),
         "-o", str(out), "--grid", "1x2", "--views", "left_lateral,dorsal",
         "--cmap", "Reds,YlGnBu", "--threshold", "3,2.3", "-k", "50,100",
         "--width", "400", "--height", "300", "--scale", "1", "--no-colorbar"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert out.exists() and out.read_bytes()[:8] == PNG


if __name__ == "__main__":
    test_los_scalar_vs_list()
    test_parse_clim_and_units()
    test_per_overlay_binding_matches_build_style()
    print("PASS — CLI per-overlay parsing")
