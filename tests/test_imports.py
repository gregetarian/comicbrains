"""Hygiene: importing the package (the render / notebook path) must NOT pull the [bake]-only
heavy deps (trimesh, mne). They are imported lazily, only when baking a template."""
import subprocess
import sys


def test_import_glass_brains_is_bake_free():
    code = "import sys, glass_brains; print('trimesh' in sys.modules, 'mne' in sys.modules)"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False False", f"package import pulled a [bake] dep: {r.stdout!r}"


def test_render_api_surface_imports():
    code = ("import glass_brains as gb; "
            "assert all(hasattr(gb, n) for n in "
            "('render','render_spec','Scene','Figure','RenderSession','render_orbit',"
            "'render_batch','bake_template','open_viewer','build_layout')); print('ok')")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stderr or r.stdout


if __name__ == "__main__":
    test_import_glass_brains_is_bake_free()
    test_render_api_surface_imports()
    print("PASS — import is bake-free; full API surface present")
