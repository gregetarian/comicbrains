"""Headless figure rendering — build a custom multi-panel PNG from a NIfTI.

Reuses the exact browser viewer (run in headless Chromium via Playwright), so
the PNG matches the interactive look pixel-for-pixel. Fully customisable layout:
any grid of any anatomical views, plus all style parameters.
"""

import json
import tempfile
import threading
import http.server
from pathlib import Path


# --- view vocabulary ------------------------------------------------------
def _cortex(hemi):
    return {"roles": ["cortex", "voxel"], "hemisphere": hemi}


def _subcort(hemi, cats):
    return {"roles": ["anatomy", "voxel"], "hemisphere": hemi, "categories": cats}


VIEWS = {
    "left_lateral":  ("left_lateral",  _cortex("lh"),   "L Lateral"),
    "right_lateral": ("right_lateral", _cortex("rh"),   "R Lateral"),
    "left_medial":   ("left_medial",   _cortex("lh"),   "L Medial"),
    "right_medial":  ("right_medial",  _cortex("rh"),   "R Medial"),
    "anterior":      ("anterior",      _cortex("both"), "Anterior"),
    "posterior":     ("posterior",     _cortex("both"), "Posterior"),
    "dorsal":        ("dorsal",        _cortex("both"), "Dorsal"),
    "ventral":       ("ventral",       _cortex("both"), "Ventral"),
    "subcortical_l": ("left_lateral",  _subcort("lh", ["subcort_l", "cereb_l", "brainstem"]), "Subcort L"),
    "subcortical_r": ("right_lateral", _subcort("rh", ["subcort_r", "cereb_r", "brainstem"]), "Subcort R"),
}

ALIASES = {
    "axial": "dorsal", "superior": "dorsal", "top": "dorsal",
    "frontal": "anterior", "front": "anterior", "coronal": "anterior",
    "back": "posterior", "occipital": "posterior",
    "inferior": "ventral", "bottom": "ventral",
    "left": "left_lateral", "l_lateral": "left_lateral", "lh_lateral": "left_lateral", "lateral_l": "left_lateral",
    "right": "right_lateral", "r_lateral": "right_lateral", "rh_lateral": "right_lateral", "lateral_r": "right_lateral",
    "l_medial": "left_medial", "r_medial": "right_medial", "medial_l": "left_medial", "medial_r": "right_medial",
    "subcort_l": "subcortical_l", "subcort_r": "subcortical_r", "sub_l": "subcortical_l", "sub_r": "subcortical_r",
    "empty": None, "blank": None, "_": None,
}


def resolve_view(name):
    key = ALIASES.get(name.strip().lower(), name.strip().lower())
    if key is None:
        return None
    if key not in VIEWS:
        raise ValueError(f"unknown view '{name}'. Options: {sorted(VIEWS)} (+ aliases {sorted(k for k in ALIASES if ALIASES[k])})")
    return VIEWS[key]


def build_layout(grid, views):
    """grid 'RxC', views list (row-major; '_' leaves a cell blank)."""
    rows, cols = (int(x) for x in grid.lower().split("x"))
    panels = []
    for i, vname in enumerate(views):
        r, c = divmod(i, cols)
        if r >= rows:
            break
        resolved = resolve_view(vname)
        if resolved is None:
            continue
        plane, content, title = resolved
        panel = {"id": f"p{i}", "title": title, "cell": {"row": r, "col": c},
                 "camera": {"plane": plane}, "content": content}
        if content["roles"][0] == "anatomy":
            panel["anatomyOpacity"] = 0.55          # subcort close-ups keep their own zoom
        else:
            panel["framing"] = {"fit": "shared"}    # whole-brain views share one world scale
        panels.append(panel)
    return {"grid": {"rows": rows, "cols": cols, "rowWeights": [1] * rows, "colWeights": [1] * cols},
            "panels": panels}


# --- background static server --------------------------------------------
def _serve_dir(directory, port=8500):
    directory = str(Path(directory).resolve())

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=directory, **k)

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache, no-store")
            super().end_headers()

        def log_message(self, *a):
            pass

    for p in range(port, port + 200):
        try:
            httpd = http.server.ThreadingHTTPServer(("", p), Handler)
            break
        except OSError:
            continue
    else:
        raise RuntimeError("no free port for render server")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, p


def _deep_merge(base, over):
    """Recursively merge `over` onto `base` (dicts merge; scalars replace)."""
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


# --- main render ----------------------------------------------------------
def render_to_png(nifti, out_png, *, layout, style=None, threshold=2.3, cmap="auto",
                  width=1600, height=1000, scale=2, include_subcortical=True,
                  background="#ffffff", colorbar=True, colorbar_font=None,
                  colorbar_fontsize=None, timeout_ms=90000):
    from .core import GlassBrain

    gb = GlassBrain(include_subcortical=include_subcortical, display_cmap=cmap)
    # cmap for the (legacy) Python bake; the JS viewer recolours from style.colormap
    bake_cmap = cmap if cmap != "auto" else "viridis"
    gb.add_overlay(nifti, threshold=threshold, cmap=bake_cmap)

    out_dir = Path(tempfile.mkdtemp(prefix="gb_render_"))
    gb.export(out_dir)

    # CLI figures (print) want a few things the interactive viewer doesn't:
    # thicker surface lines, a touch more breathing room between brains, and no
    # faint subcortical glass shell. These are defaults — any explicit --flag in
    # `style` wins via the deep-merge below.
    cli_style = {
        "margin": 1.05,                 # top row was a hair too close together
        "outline": {"width": 7.0},      # surface lines read too thin at print res
        "anatomy": {"maxOpacity": 0.0}, # drop the subcortical shell alpha entirely
    }
    merged_style = _deep_merge(cli_style, style or {})
    merged_style["colormap"] = cmap

    # Colorbar scaled to the figure (the fixed 240px bar looked tiny on big PNGs).
    cb_w = round(width * 0.22)
    config = {
        "layout": layout,
        "style": merged_style,
        "render": {"width": width, "height": height, "pixelRatio": scale,
                   "background": background, "colorbar": colorbar,
                   "colorbarWidth": cb_w, "colorbarHeight": max(16, round(cb_w / 15)),
                   "colorbarFontSize": colorbar_fontsize or max(13, round(width * 0.011)),
                   **({"colorbarFont": colorbar_font} if colorbar_font else {})},
    }
    (out_dir / "render-config.json").write_text(json.dumps(config, indent=2))

    httpd, port = _serve_dir(out_dir)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=[
                "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"])
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=scale)
            page.goto(f"http://localhost:{port}/index.html?headless=1&config=render-config.json",
                      wait_until="networkidle")
            page.wait_for_function("window.__GB_DONE__ === true || window.__GB_ERR__", timeout=timeout_ms)
            err = page.evaluate("window.__GB_ERR__ || null")
            if err:
                raise RuntimeError(f"viewer error: {err}")
            page.locator("#viewer").screenshot(path=str(out_png))
            browser.close()
    finally:
        httpd.shutdown()
    print(f"Rendered {out_png}  ({width}x{height} @{scale}x)")
    return out_png
