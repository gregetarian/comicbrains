"""Vendored-assets guard (pure-Python, no browser).

three.js and the Computer Modern font are vendored under glass_brains/web/vendor/ so the
viewer + headless render are fully offline and deterministic (no CDN on the critical path,
nothing to drift to @latest). This test asserts:
  - the three version in index.html's importmap matches web/vendor/VERSION,
  - every vendored file the importmap / font link points at actually exists,
  - index.html no longer references a CDN (so a render can't silently depend on the network).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "glass_brains" / "web"
VENDOR = WEB / "vendor"


def test_vendor_assets_in_sync():
    index = (WEB / "index.html").read_text()

    # three version: from the importmap path ./vendor/three/<ver>/three.module.js
    m = re.search(r'vendor/three/([0-9.]+)/three\.module\.js', index)
    assert m, "index.html importmap does not point at a vendored three.module.js"
    idx_ver = m.group(1)

    ver_txt = (VENDOR / "VERSION").read_text()
    vm = re.search(r'three=([0-9.]+)', ver_txt)
    assert vm, "web/vendor/VERSION has no three=<ver> line"
    assert vm.group(1) == idx_ver, (
        f"three version drift: importmap {idx_ver} != VERSION {vm.group(1)}")

    # vendored files exist
    must = [
        VENDOR / "three" / idx_ver / "three.module.js",
        VENDOR / "three" / idx_ver / "addons" / "loaders" / "GLTFLoader.js",
        VENDOR / "three" / idx_ver / "addons" / "utils" / "BufferGeometryUtils.js",
        VENDOR / "cm-fonts" / "fonts.css",
        VENDOR / "cm-fonts" / "cmunrm.woff",
    ]
    missing = [str(p.relative_to(ROOT)) for p in must if not p.exists()]
    assert not missing, f"missing vendored files: {missing}"

    # no CDN references in the shipped page (offline determinism)
    assert "cdn.jsdelivr" not in index and "https://" not in index.split("<style>")[0], (
        "index.html still references a CDN — renders must be fully offline")

    print(f"PASS — three {idx_ver} vendored offline; importmap + VERSION + files all agree")


if __name__ == "__main__":
    test_vendor_assets_in_sync()
