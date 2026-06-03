"""Full integration test in headless Chromium: load index.html, confirm the demo
overlay renders with NO Pyodide, then upload a NIfTI (triggering Pyodide), switch
layout preset, and remove an overlay — asserting state + capturing screenshots.
"""
import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent / "glass_brains" / "web"
SHOTS = Path(__file__).resolve().parent / "shots"
SHOTS.mkdir(exist_ok=True)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    httpd, port = serve()
    url = f"http://127.0.0.1:{port}/index.html"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("console", lambda m: (errors.append(m.text) if m.type == "error" else None))
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        page.goto(url)

        def n_overlays():
            return page.evaluate("window.__engine && window.__engine() ? window.__engine().overlays.length : -1")
        def n_voxel_meshes():
            return page.evaluate("window.__engine().sceneModel.meshes.filter(m=>m.meta.role==='voxel').length")

        # 1) demo overlay loads with NO Pyodide (base GLBs + baked buffers only)
        page.wait_for_function("window.__engine && window.__engine() && window.__engine().overlays.length >= 1", timeout=60_000)
        assert n_overlays() == 1, f"expected 1 demo overlay, got {n_overlays()}"
        assert n_voxel_meshes() == 8, f"expected 8 voxel meshes (4 cats x 2 variants), got {n_voxel_meshes()}"
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "1_demo.png"))
        print(f"[1] demo overlay rendered: {n_overlays()} overlay, {n_voxel_meshes()} voxel meshes  ✓")

        # 2) upload test_sphere -> triggers Pyodide pipeline -> 2nd overlay
        print("[2] uploading test_sphere.nii.gz (boots Pyodide; first run downloads wheels)…")
        page.set_input_files("#c-upload", str(ROOT / "test_sphere.nii.gz"))
        page.wait_for_function("window.__engine().overlays.length >= 2", timeout=300_000)
        assert n_voxel_meshes() == 16, f"expected 16 voxel meshes after upload, got {n_voxel_meshes()}"
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "2_after_upload.png"))
        print(f"[2] upload via Pyodide: {n_overlays()} overlays, {n_voxel_meshes()} voxel meshes  ✓")

        # 3) switch layout preset — overlays must survive (no reload)
        page.select_option("#c-layout", "fourPanel")
        page.wait_for_timeout(600)
        assert n_overlays() == 2, f"overlays lost on preset switch: {n_overlays()}"
        n_panels = page.evaluate("window.__engine().getPanelRects().length")
        assert n_panels == 4, f"fourPanel should have 4 panels, got {n_panels}"
        page.screenshot(path=str(SHOTS / "3_fourpanel.png"))
        print(f"[3] preset switch -> {n_panels} panels, {n_overlays()} overlays preserved  ✓")

        # 4) remove the first overlay via its ✕ button
        page.click(".overlay-row .btn.rm")
        page.wait_for_function("window.__engine().overlays.length === 1", timeout=10_000)
        assert n_voxel_meshes() == 8, f"expected 8 voxel meshes after remove, got {n_voxel_meshes()}"
        page.screenshot(path=str(SHOTS / "4_after_remove.png"))
        print(f"[4] removed an overlay -> {n_overlays()} overlay, {n_voxel_meshes()} voxel meshes  ✓")

        browser.close()
    httpd.shutdown()

    real_errors = [e for e in errors if "favicon" not in e.lower()]
    if real_errors:
        print("\nCONSOLE/PAGE ERRORS:")
        for e in real_errors:
            print("  -", e[:300])
        raise SystemExit(1)
    print("\nPASS — full in-browser app works: demo, Pyodide upload, preset switch, remove. No console errors.")


if __name__ == "__main__":
    main()
