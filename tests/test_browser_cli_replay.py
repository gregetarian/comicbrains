"""Optional Chromium regression: Copy CLI retains offscreen viewport cropping.

Run directly after installing Playwright/Chromium. Uses the bundled fixture without
Pyodide or external scientific-data downloads. Captures the actual Copy CLI download,
then feeds that recipe and the same baked data into the real headless browser route.
"""
import base64
import functools
from io import BytesIO
import http.server
import json
from pathlib import Path
import threading

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent / "comic" / "web"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader"])
            context = browser.new_context(viewport={"width": 1000, "height": 720}, device_scale_factor=1)
            live = context.new_page()
            live.on("pageerror", lambda exc: errors.append(str(exc)))
            live.goto(url + "/index.html?baked=1&preset=fourPanel", wait_until="domcontentloaded")
            live.wait_for_function("window.__engine && window.__engine().overlays.length === 1", timeout=60000)
            live.evaluate("document.fonts.ready")
            # Put panels partially outside the window. A replay at the design size (the former
            # exporter behavior) would expose additional brain geometry and move every frame.
            live.evaluate("""() => {
                const e = window.__engine(), v = e.getView();
                e.setView({s: 1.15, cx: v.W0 * 0.3, cy: v.H0 * 0.4}); e.renderFrame();
            }""")
            with live.expect_download() as download_info:
                live.click("#c-cli")
            download = download_info.value
            assert download.suggested_filename == "figure.json"
            recipe = json.loads(Path(download.path()).read_text())
            before = live.evaluate("""() => {
                const e = window.__engine(); e.renderFrame();
                return {view: e.getView(), rects: e.getPanelRects(), box: window.__contentBBox(),
                    png: document.getElementById("canvas").toDataURL("image/png")};
            }""")
            assert recipe["render"]["width"] == before["view"]["VW"]
            assert recipe["render"]["height"] == before["view"]["VH"]
            assert recipe["layout"]["canvas"]["w"] == before["view"]["W0"]
            assert recipe["render"]["width"] != recipe["layout"]["canvas"]["w"]
            assert recipe["render"]["pixelRatio"] == 1
            assert recipe["render"]["colorbar"] is False
            assert any(r["cssLeft"] < 0 or r["cssTop"] < 0 for r in before["rects"])

            live.close()  # Stop the interactive RAF loop before a second software-GL context starts.
            scene = json.loads((ROOT / "data/scene.json").read_text())
            meta = json.loads((ROOT / "data/demo/meta.json").read_text())
            meta["buffersFile"] = "demo/" + meta["buffersFile"]
            scene["overlays"] = [meta]
            replay = context.new_page()
            replay.on("pageerror", lambda exc: errors.append(str(exc)))
            replay.set_viewport_size({"width": recipe["render"]["width"], "height": recipe["render"]["height"]})
            replay.route("**/replay-config.json", lambda route: route.fulfill(json=recipe))
            replay.route("**/data/scene.json", lambda route: route.fulfill(json=scene))
            replay.goto(url + "/index.html?headless=1&config=replay-config.json", wait_until="domcontentloaded")
            replay.wait_for_function("window.__GB_DONE__ === true || window.__GB_ERR__", timeout=60000)
            assert replay.evaluate("window.__GB_ERR__ || null") is None
            after = replay.evaluate("""() => {
                const e = window.__engine(); e.renderFrame();
                return {view: e.getView(), rects: e.getPanelRects(), box: window.__contentBBox(),
                    png: document.getElementById("canvas").toDataURL("image/png")};
            }""")
            def pixels(snapshot):
                return Image.open(BytesIO(base64.b64decode(snapshot.pop("png").split(",", 1)[1]))).convert("RGBA")
            live_pixels, replay_pixels = pixels(before), pixels(after)
            assert before == after, {"live": before, "replay": after}
            assert live_pixels.size == replay_pixels.size
            colors = live_pixels.convert("RGB").getcolors(maxcolors=live_pixels.width * live_pixels.height)
            assert sum(count for count, color in colors if color != (255, 255, 255)) > 1000, "rendered brain is blank"
            difference = ImageChops.difference(live_pixels, replay_pixels)
            # Compare all four channels; RGBA.getbbox alone ignores RGB changes with zero alpha.
            assert all(band.getbbox() is None for band in difference.split()), difference.getextrema()
            assert not errors, errors
            print("PASS: actual Copy CLI preserves design size, viewport, pan/zoom, clipped panel positions, crop, pixel ratio and every RGBA pixel")
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


def test_browser_cli_replay():
    main()


if __name__ == "__main__":
    main()
