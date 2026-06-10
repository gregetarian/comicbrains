"""M4: RenderSession holds one browser across renders, returns PNG bytes (the inline-display
path the notebook API rides on), and render_to_png stays a byte-identical file-writing wrapper.
"""
from pathlib import Path

from glass_brains.render import RenderSession, render_to_png, render_batch, build_layout

ROOT = Path(__file__).resolve().parent.parent
SPHERE = str(ROOT / "test_sphere.nii.gz")
LAYOUT = build_layout("1x2", ["left_lateral", "dorsal"])
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def test_session_returns_bytes_and_reuses_browser():
    with RenderSession() as s:
        a, ca = s.render(SPHERE, layout=LAYOUT, width=400, height=300, scale=1, colorbar=False, return_bytes=True)
        b, cb = s.render(SPHERE, layout=LAYOUT, width=400, height=300, scale=1, colorbar=False, return_bytes=True)
    assert a[:8] == PNG_MAGIC and b[:8] == PNG_MAGIC
    assert a == b                     # two renders in one session are deterministic
    assert ca is None and cb is None  # colorbar=False → no sidecar bytes


def test_render_to_png_writes_file(tmp_path):
    out = tmp_path / "x.png"
    p = render_to_png(SPHERE, str(out), layout=LAYOUT, width=400, height=300, scale=1, colorbar=False)
    assert Path(p).exists() and Path(p).read_bytes()[:8] == PNG_MAGIC


def test_render_batch_one_browser(tmp_path):
    outs = render_batch([
        {"nifti": SPHERE, "out": str(tmp_path / "a.png"), "layout": LAYOUT, "width": 400, "height": 300, "scale": 1, "colorbar": False},
        {"nifti": SPHERE, "out": str(tmp_path / "b.png"), "layout": LAYOUT, "width": 400, "height": 300, "scale": 1, "colorbar": False},
    ])
    assert len(outs) == 2 and all(Path(o).exists() for o in outs)
    assert Path(outs[0]).read_bytes() == Path(outs[1]).read_bytes()   # same input → identical


if __name__ == "__main__":
    test_session_returns_bytes_and_reuses_browser()
    print("PASS — RenderSession bytes + browser reuse")
