"""Headless figure rendering — build a custom multi-panel PNG from a NIfTI.

Reuses the exact browser viewer (run in headless Chromium via Playwright), so
the PNG matches the interactive look pixel-for-pixel. Fully customisable layout:
any grid of any anatomical views, plus all style parameters.
"""

import json
import shutil
import tempfile
import threading
import http.server
from pathlib import Path

WEB_DIR = Path(__file__).parent / "web"   # the single viewer (engine + baked template assets)


# --- view vocabulary ------------------------------------------------------
def _cortex(hemi):
    return {"roles": ["cortex", "voxel"], "hemisphere": hemi}


def _subcort(hemi, cats):
    return {"roles": ["anatomy", "voxel"], "hemisphere": hemi, "categories": cats}


def _cortex_subcort_opaque(hemi):
    # cortex + subcortical together; subcortex OPAQUE (occludes content behind it).
    return {"roles": ["cortex", "anatomy", "voxel"], "hemisphere": hemi, "anatomyStyle": "opaque"}


def _cortex_subcort_contra(cortex_hemi, sub_hemi):
    # cortex of one hemisphere + the CONTRALATERAL subcortex (sits in front of it, occluding).
    return {"roles": ["cortex", "anatomy", "voxel"], "hemisphere": cortex_hemi,
            "anatomyHemisphere": sub_hemi, "anatomyStyle": "opaque"}


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
    "cortex_subcort_l": ("left_lateral",  _cortex_subcort_contra("lh", "rh"), "L + Subcort (opaque)"),
    "cortex_subcort_r": ("right_lateral", _cortex_subcort_contra("rh", "lh"), "R + Subcort (opaque)"),
    "cortex_subcort":   ("dorsal",        _cortex_subcort_opaque("both"),     "Cortex + Subcort (opaque)"),
    "cortex_subcort_lm": ("left_medial",  _cortex_subcort_contra("lh", "rh"), "L Medial + Subcort"),
    "cortex_subcort_rm": ("right_medial", _cortex_subcort_contra("rh", "lh"), "R Medial + Subcort"),
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


def load_spec(path):
    """Load a Free-Canvas figure spec (the canvas document) → its layout dict.

    The spec is the same JSON the browser's Copy-CLI emits: either a bare layout
    ({grid?, canvas?, panels:[...]}) or a full config ({layout, style?, render?}).
    Returns (layout, style, render) where style/render are {} if absent, so the
    caller can deep-merge them under the explicit --flags."""
    from . import spec as gb_spec
    doc = json.loads(Path(path).read_text())
    gb_spec.validate(doc)                        # loud failure on a malformed spec (mirrors the browser)
    layout = doc.get("layout", doc)              # accept a full config OR a bare layout
    if "panels" not in layout:
        raise ValueError(f"spec '{path}' has no layout.panels")
    return layout, doc.get("style", {}), doc.get("render", {})


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
def prepare_render_dir(nifti, threshold=2.3, include_subcortical=True, names=None):
    """Stage a self-contained render dir: a copy of the single viewer with the overlay(s)
    processed in-process (same pipeline.py the browser runs) and written as ARRAYS
    (overlay_<i>.bin + meta in scene.json) — no GLB, no per-render template re-bake.

    `nifti` is a single path (str/Path) OR a list of paths for a multi-overlay figure;
    `threshold` is a scalar (applied to every map) OR a per-overlay list. `names` (optional)
    is a per-overlay display name (used as the colorbar label; defaults to the filename).
    Each map becomes its own overlay, so the engine renders N overlays with per-overlay style
    from `style.overlays[i]` — the same path the browser uses for N dragged-in NIfTIs.
    Returns the dir path."""
    from . import pipeline as P
    from .arrays import write_overlay_arrays

    niftis = [nifti] if isinstance(nifti, (str, Path)) else list(nifti)
    thresholds = ([float(threshold)] * len(niftis) if isinstance(threshold, (int, float))
                  else [float(t) for t in threshold])
    names = names or [None] * len(niftis)

    out_dir = Path(tempfile.mkdtemp(prefix="gb_render_"))
    shutil.copytree(WEB_DIR, out_dir, dirs_exist_ok=True)
    data = out_dir / "data"
    P.init_aseg((data / "aseg_uint8.bin.gz").read_bytes(), (data / "aseg.json").read_text())

    metas = []
    for i, src in enumerate(niftis):
        name = names[i] or Path(src).name.replace(".nii.gz", "").replace(".nii", "")
        meta = json.loads(P.process_nifti(str(src), name, thresholds[i]))
        # grab THIS overlay's buffers before the next process_nifti clears _BUFFERS
        metas.append(write_overlay_arrays(data, meta, P.get_all_buffers(), index=i))

    scene = json.loads((data / "scene.json").read_text())
    if not include_subcortical:
        scene.pop("subcortical", None)
    scene["overlays"] = metas
    (data / "scene.json").write_text(json.dumps(scene))
    return out_dir


def render_to_png(nifti, out_png, *, layout, style=None, threshold=2.3, cmap="auto",
                  width=1600, height=1000, scale=2, include_subcortical=True,
                  background="#ffffff", background_alpha=1.0, colorbar=True, colorbar_font=None,
                  colorbar_fontsize=None, crop="none", names=None, timeout_ms=90000):
    """`nifti` is one path or a list of paths (one overlay each); `threshold` is a scalar
    or per-overlay list. Per-overlay colour/threshold come from `style['overlays'][i]`.
    `names` (optional) sets each overlay's colorbar label; if omitted it falls back to
    `style['overlays'][i]['name']`, else the filename."""
    n_overlays = 1 if isinstance(nifti, (str, Path)) else len(nifti)
    if names is None and style and isinstance(style.get("overlays"), list):
        names = [(o or {}).get("name") for o in style["overlays"]] or None
    out_dir = prepare_render_dir(nifti, threshold, include_subcortical, names=names)

    # Transparent background (Free Canvas): record bgAlpha in the layout so the WebGL
    # clear is transparent; the screenshot below then captures real alpha. Default 1 =
    # opaque, so every existing figure is byte-identical.
    transparent = background_alpha < 1
    if transparent:
        layout = {**layout, "canvas": {**layout.get("canvas", {}), "bgAlpha": background_alpha}}

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
            # domcontentloaded (not networkidle): the real readiness gate is __GB_DONE__
            # below, and with vendored assets there is no late network to idle-wait on.
            page.goto(f"http://localhost:{port}/index.html?headless=1&config=render-config.json",
                      wait_until="domcontentloaded")
            page.wait_for_function("window.__GB_DONE__ === true || window.__GB_ERR__", timeout=timeout_ms)
            err = page.evaluate("window.__GB_ERR__ || null")
            if err:
                raise RuntimeError(f"viewer error: {err}")
            # Brain figure: hide the colorbar so the brains fill the full frame (never
            # squashed), then screenshot.
            page.evaluate("() => { const c = document.querySelector('.colorbar'); if (c) c.style.display = 'none'; }")
            # Transparent background: clear the page/#viewer fills so omit_background can
            # capture the WebGL canvas's alpha (the canvas was already cleared transparent).
            if transparent:
                page.evaluate("() => { for (const s of ['html','body','#viewer']) { const e = document.querySelector(s); if (e) e.style.background = 'transparent'; } }")
            # --crop content: clip to the tight bounding box of the visible brains (CSS px;
            # #viewer is at the page origin in headless, so the bbox doubles as a page clip).
            bbox = page.evaluate("window.__contentBBox && window.__contentBBox()") if crop == "content" else None
            if bbox:
                page.screenshot(path=str(out_png), omit_background=transparent,
                                clip={"x": bbox["x"], "y": bbox["y"], "width": bbox["w"], "height": bbox["h"]})
            else:
                page.locator("#viewer").screenshot(path=str(out_png), omit_background=transparent)
            outputs = [out_png]
            # Colorbar legend as a SEPARATE sidecar image (place it in your figure yourself).
            if colorbar:
                # Reveal the bars and paint the strip opaque white so a multi-bar legend
                # (taller strip, overlaps the brain) screenshots clean — no brain bleed-through
                # in the gaps between rows. This is after the brain capture, so the figure is
                # untouched; it only affects the separate legend sidecar.
                page.evaluate("() => { const c = document.querySelector('.colorbar');"
                              " if (c) { c.style.display = ''; c.style.background = '#ffffff'; c.style.padding = '6px 10px'; } }")
                page.wait_for_timeout(60)
                bar = page.locator('.colorbar')
                if bar.count() and bar.bounding_box():
                    side = Path(out_png)
                    side = side.with_name(side.stem + "_colorbars" + side.suffix)
                    bar.screenshot(path=str(side))
                    outputs.append(side)
            browser.close()
    finally:
        httpd.shutdown()
    print("Rendered " + ", ".join(str(o) for o in outputs) +
          f"  ({width}x{height} @{scale}x, {n_overlays} overlay{'s' if n_overlays != 1 else ''})")
    return out_png
