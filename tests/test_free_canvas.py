"""Free Canvas integration test.

Drives the editor in headless Chromium: switch the demo figure into Free Canvas,
then move / resize / rotate / re-view / add a panel — asserting each mutates the
live config — and finally renders a free-canvas spec headlessly via --spec to prove
the editor↔CLI round-trip. No Pyodide needed (uses the baked demo overlay).
"""
import functools
import http.server
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from glass_brains.render import render_to_png, load_spec

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
        logs = []
        page.on("console", lambda m: (errors.append(m.text) if m.type == "error" else logs.append(m.text)))
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        page.goto(url)

        ev = page.evaluate
        # Center of an element via JS rect — robust for tiny absolutely-positioned handles
        # (Playwright's bounding_box() auto-visibility check is finicky with these; a real
        # mouse at these coords hits them, which is what we simulate).
        def center(loc):
            c = loc.evaluate("e => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }")
            return c[0], c[1]
        page.wait_for_function("window.__engine && window.__engine() && window.__engine().overlays.length >= 1", timeout=60_000)
        assert ev("window.__engine().config.layout.mode") == "grid", "default layout should be grid mode"

        # 1) switch to Free Canvas: frames appear, mode flips, panels keep their count
        n_panels = ev("window.__engine().getPanelRects().length")
        page.select_option("#c-layout", "freeCanvas")
        page.wait_for_timeout(400)
        assert ev("window.__engine().config.layout.mode") == "free", "mode should be 'free'"
        n_frames = ev("document.querySelectorAll('.fc-frame').length")
        assert n_frames == n_panels, f"expected {n_panels} editor frames, got {n_frames}"
        assert ev("!!document.querySelector('.fc-toolbar')"), "toolbar missing"
        assert ev("window.__engine().config.layout.panels[0].place != null"), "panel[0] has no place"
        print(f"[1] Free Canvas: mode=free, {n_frames} frames over {n_panels} panels, toolbar ✓")

        # Operate on the LAST frame (top of the paint stack) so nothing occludes its
        # body/resize handle — adjacent tiled panels overlap each other's edges.
        j = n_panels - 1
        frame = page.locator(".fc-frame").nth(j)
        pj = lambda field: ev(f"window.__engine().config.layout.panels[{j}].place.{field}")

        # 2) drag the body to MOVE → place.x/y change
        bx, by = center(frame.locator(".fc-body"))
        x0 = pj("x")
        page.mouse.move(bx, by); page.mouse.down()
        page.mouse.move(bx - 120, by - 70, steps=8); page.mouse.up()
        page.wait_for_timeout(120)   # let the RAF loop reposition the frame
        x1 = pj("x")
        assert abs(x1 - x0) > 0.02, f"move did not change place.x ({x0} -> {x1})"
        print(f"[2] move: place.x {round(x0,3)} -> {round(x1,3)} ✓")

        # 3) drag the corner to RESIZE → place.w changes
        w0 = pj("w")
        rx, ry = center(frame.locator(".fc-resize"))
        page.mouse.move(rx, ry); page.mouse.down()
        page.mouse.move(rx + 80, ry + 55, steps=6); page.mouse.up()
        page.wait_for_timeout(120)
        w1 = pj("w")
        assert abs(w1 - w0) > 0.02, f"resize did not change place.w ({w0} -> {w1})"
        print(f"[3] resize: place.w {round(w0,3)} -> {round(w1,3)} ✓")

        # 4) rotate button (◀ = yaw -15)
        frame.locator("button", has_text="◀").click()
        yaw = ev(f"window.__engine().config.layout.panels[{j}].rotate.yaw")
        assert yaw == -15, f"yaw button should set -15, got {yaw}"
        print(f"[4] rotate ◀: yaw = {yaw} ✓")

        # 5) view picker change → camera.plane + view name update, rotate preserved
        frame.locator(".fc-view").select_option("anterior")
        page.wait_for_timeout(150)
        assert ev(f"window.__engine().config.layout.panels[{j}].camera.plane") == "anterior", "view change didn't set plane"
        assert ev(f"window.__engine().config.layout.panels[{j}].view") == "anterior", "view name not recorded"
        assert ev(f"window.__engine().config.layout.panels[{j}].rotate.yaw") == -15, "rotate lost on view change"
        print("[5] view picker -> anterior (rotate preserved) ✓")

        # 6) slice ✂ cycles a slice on; cycle to a sphere bite, then DRAG its anchor handle
        slbtn = frame.locator("button", has_text="✂")
        slbtn.click()
        page.wait_for_timeout(100)
        assert ev(f"window.__engine().config.layout.panels[{j}].slice.shape") == "plane", "first slice should be a plane cut"
        for _ in range(3):                     # plane→coronal→sagittal→sphere
            slbtn.click()
        page.wait_for_timeout(150)
        assert ev(f"window.__engine().config.layout.panels[{j}].slice.shape") == "sphere", "expected sphere bite after 4 cycles"
        cx0 = ev(f"window.__engine().config.layout.panels[{j}].slice.center[0]")
        ax, ay = center(frame.locator(".fc-slice-handle").first)   # anchor handle (not the size one)
        page.mouse.move(ax, ay); page.mouse.down()
        page.mouse.move(ax - 70, ay, steps=6); page.mouse.up()
        page.wait_for_timeout(120)
        cx1 = ev(f"window.__engine().config.layout.panels[{j}].slice.center[0]")
        assert abs(cx1 - cx0) > 1.0, f"slice anchor drag did not move center.x ({cx0} -> {cx1})"
        print(f"[6] slice ✂ + drag anchor: sphere center.x {round(cx0,1)} -> {round(cx1,1)} ✓")

        # 7) + panel → panel set grows, engine rebuilt, frame added
        page.locator(".fc-toolbar button", has_text="+ panel").click()
        page.wait_for_timeout(300)
        assert ev("window.__engine().getPanelRects().length") == n_panels + 1, "panel not added"
        assert ev("document.querySelectorAll('.fc-frame').length") == n_panels + 1, "frame not added"
        print(f"[7] + panel -> {n_panels + 1} panels ✓")

        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "free_canvas_editor.png"))

        # 8) Copy CLI must emit a --spec command for this free figure (it console.logs the text).
        page.click("#c-cli")
        page.wait_for_timeout(250)
        cli_text = next((t for t in logs if "--spec figure.json" in t), None)
        assert cli_text, "Copy CLI did not emit a --spec command for the free figure"
        assert '"mode": "free"' in cli_text, "emitted figure.json is not a free layout"
        assert '"slice"' in cli_text, "slice not serialized into figure.json"
        print("[8] Copy CLI -> --spec figure.json (free layout + slice embedded) ✓")

        # capture the LIVE edited config (moved/resized/rotated/added panel + slice) for the
        # round-trip render BEFORE resetting.
        live_layout = page.evaluate("JSON.parse(JSON.stringify(window.__engine().config.layout))")
        live_style = page.evaluate("JSON.parse(JSON.stringify(window.__engine().config.style))")

        # 9) Reset → the moved/sliced panel returns to its original place, slice cleared
        ox = pj("x")
        page.locator(".fc-toolbar button", has_text="Reset").click()
        page.wait_for_timeout(300)
        rx = pj("x")
        assert abs(rx - 0.75) < 0.02, f"reset did not restore place.x to ~0.75 (moved {ox} -> {rx})"
        assert ev(f"window.__engine().config.layout.panels[{j}].slice") is None, "reset did not clear the slice"
        print(f"[9] reset: place.x {round(ox,3)} -> {round(rx,3)} (~original), slice cleared ✓")
        browser.close()
    httpd.shutdown()

    real_errors = [e for e in errors if "favicon" not in e.lower()]
    if real_errors:
        print("\nCONSOLE/PAGE ERRORS:")
        for e in real_errors:
            print("  -", e[:300])
        raise SystemExit(1)

    # 8) TRUE round-trip: render the exact edited figure headlessly from the live config.
    cv = live_layout.get("canvas", {})
    out = SHOTS / "free_roundtrip.png"
    render_to_png(str(ROOT / "test_sphere.nii.gz"), str(out), layout=live_layout, style=live_style,
                  width=int(cv.get("w", 900)), height=int(cv.get("h", 500)), scale=1, colorbar=False)
    assert out.exists() and out.stat().st_size > 1000, "round-trip render produced no PNG"
    print(f"[10] live-config round-trip render (with slice) -> {out.name} ({out.stat().st_size} bytes) ✓")

    print("\nPASS — Free Canvas: switch, move, resize, rotate, re-view, slice, add panel, reset, Copy-CLI --spec, and headless round-trip all work. No console errors.")


if __name__ == "__main__":
    main()
