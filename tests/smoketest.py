"""Headless-browser smoke test: prove the in-browser Pyodide pipeline works.

Serves comicbrains-in-browser/ over HTTP, loads smoketest.html in headless Chromium
(which boots Pyodide, installs numpy/scipy/scikit-image + nibabel from CDN, runs
pipeline.py on test_sphere.nii.gz), then asserts the result matches the ground truth
captured from the native Python pipeline.
"""

import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent / "glass_brains" / "web"  # the single viewer

# Ground truth from the native pipeline on test_sphere.nii.gz (see bake/validation).
GT = {
    'maxAbsValue': 4.58, 'maxClusterSize': 81, 'diverging': False,
    'blocky': {'lh_cortex': 248, 'rh_cortex': 128, 'subcort_l': 144, 'subcort_r': 104},
    'smooth': {'lh_cortex': 2268, 'rh_cortex': 1126, 'subcort_l': 924, 'subcort_r': 764},
}


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    httpd, port = serve()
    url = f"http://127.0.0.1:{port}/smoketest.html"
    print(f"serving {ROOT} at {url}")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("console", lambda msg: print("  [browser]", msg.text))
        page.on("pageerror", lambda err: print("  [pageerror]", err))
        page.goto(url)
        # First load downloads Pyodide + scipy + scikit-image + nibabel — allow a few min.
        page.wait_for_function("window.__RESULT__ !== undefined || window.__ERROR__ !== undefined",
                               timeout=300_000)
        err = page.evaluate("window.__ERROR__")
        if err:
            print("\nFAIL — browser error:\n", err)
            browser.close(); httpd.shutdown(); raise SystemExit(1)
        res = page.evaluate("window.__RESULT__")
        browser.close()
    httpd.shutdown()

    print("\n=== browser result ===")
    import json
    print(json.dumps(res, indent=2))

    # --- assertions vs ground truth ---
    ok = True
    def check(name, got, want):
        nonlocal ok
        good = got == want
        ok &= good
        print(f"  {'OK ' if good else 'BAD'} {name}: got {got} want {want}")

    check("maxClusterSize", res['maxClusterSize'], GT['maxClusterSize'])
    check("diverging", res['diverging'], GT['diverging'])
    check("maxAbsValue~4.58", round(res['maxAbsValue'], 2), GT['maxAbsValue'])
    for cat, want in GT['blocky'].items():
        s = res['structures'].get(cat, {})
        check(f"{cat} blockyVerts", s.get('blockyVerts'), want)
        check(f"{cat} smoothVerts", s.get('smoothVerts'), GT['smooth'][cat])
        # face indices must be in range
        if s:
            check(f"{cat} idxMax<nverts", s['idxMax'] < s['blockyVerts'], True)

    print("\n" + ("PASS — in-browser pipeline matches native ground truth" if ok else "FAIL"))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
