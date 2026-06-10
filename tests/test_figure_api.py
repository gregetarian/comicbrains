"""M5: the notebook/Python API — figure.render / render_spec / Figure / Scene, and the
per-overlay scalar-or-list style builder shared with the CLI."""
from pathlib import Path

import glass_brains as gb
from glass_brains.figure import build_style

ROOT = Path(__file__).resolve().parent.parent
SPHERE = str(ROOT / "test_sphere.nii.gz")
PNG = b"\x89PNG\r\n\x1a\n"


def test_build_style_scalar_broadcast_vs_list():
    s, bake = build_style(2, cmap="Reds", threshold=2.3, gamma=0.7)
    assert s["colormap"] == "Reds" and s["threshold"] == 2.3 and s["gamma"] == 0.7 and bake == 2.3
    s2, bake2 = build_style(2, cmap=["Reds", "YlGnBu"], threshold=[4.0, 2.3], clusterMin=[50, 100])
    assert s2["overlays"][0]["colormap"] == "Reds" and s2["overlays"][1]["colormap"] == "YlGnBu"
    assert s2["overlays"][0]["threshold"] == 4.0 and s2["overlays"][1]["voxel"]["clusterMin"] == 100
    assert bake2 == [4.0, 2.3]
    # clim is always GLOBAL (it is itself a [vmin,vmax] pair, not a per-overlay list)
    s3, _ = build_style(2, clim=[0, 8])
    assert s3["clim"] == [0, 8] and "clim" not in (s3.get("overlays") or [{}])[0]


def test_render_returns_inline_figure(tmp_path):
    fig = gb.render(SPHERE, views=["left_lateral", "dorsal"], grid="1x2",
                    width=400, height=300, scale=1, colorbar=False)
    assert isinstance(fig, gb.Figure)
    assert fig.png[:8] == PNG and fig._repr_png_() == fig.png
    assert fig.config["layout"]["panels"]
    out = fig.save(tmp_path / "f.png")
    assert Path(out).read_bytes()[:8] == PNG


def test_render_spec_dict():
    spec = {
        "layout": {"grid": {"rows": 1, "cols": 2, "rowWeights": [1], "colWeights": [1, 1]},
                   "panels": [
                       {"id": "a", "camera": {"plane": "left_lateral"}, "cell": {"row": 0, "col": 0},
                        "content": {"roles": ["cortex", "voxel"], "hemisphere": "lh"}},
                       {"id": "b", "camera": {"plane": "dorsal"}, "cell": {"row": 0, "col": 1},
                        "content": {"roles": ["cortex", "voxel"], "hemisphere": "both"}}]},
        "style": {"colormap": "Reds"}, "render": {"width": 400, "height": 300}}
    fig = gb.render_spec(spec, SPHERE, scale=1, colorbar=False)
    assert fig.png[:8] == PNG


def test_clim_is_consumed():
    # An explicit clim must re-scale the colours (shader uMaxAbs + colorize). Use a real
    # gradient map (faces) + a clim well above the data range so every t drops measurably.
    faces = str(ROOT / "glass_brains" / "web" / "data" / "defaults" / "faces.nii.gz")
    kw = dict(views=["dorsal"], grid="1x1", width=300, height=300, scale=1, colorbar=False)
    base = gb.render(faces, **kw).png
    pinned = gb.render(faces, clim=20, **kw).png
    assert base != pinned, "clim was ignored by the shader"


def test_scene_reuses_one_session():
    with gb.Scene(grid="1x2", views=["left_lateral", "dorsal"], width=400, height=300, scale=1, colorbar=False) as s:
        s.add(SPHERE, cmap="Reds")
        a = s.render().png
        b = s.render().png
    assert a[:8] == PNG and a == b


if __name__ == "__main__":
    test_build_style_scalar_broadcast_vs_list()
    print("PASS — build_style scalar/list semantics")
