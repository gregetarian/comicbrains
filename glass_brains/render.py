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
def to_volume_layout(layout):
    """Strip a layout to no-template / volume-only (M7): every panel shows only the voxel role
    with no hemisphere split, so it validates + renders against a 'none' template (no shell)."""
    out = {**layout, "panels": []}
    for p in layout.get("panels", []):
        c = p.get("content") or {}
        out["panels"].append({**p, "content": {"roles": ["voxel"], "hemisphere": "both",
                                               "categories": None, "representation": c.get("representation")}})
    return out


def _wants_surface(style):
    """True if any overlay's resolved representation is 'surface' (surface-projection mode, M8)."""
    if not style:
        return False
    if ((style.get("voxel") or {}).get("representation")) == "surface":
        return True
    return any(o and ((o.get("voxel") or {}).get("representation")) == "surface"
               for o in (style.get("overlays") or []))


def prepare_render_dir(nifti, threshold=2.3, include_subcortical=True, names=None, template_dir=None,
                       classify=True, surface=False):
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
    # M4 hook (custom/non-MNI template, exercised in M9): overlay a template bundle's data/
    # (cortex/subcortical GLBs + aseg + scene.json) on top of the bundled fsaverage assets.
    if template_dir is not None:
        shutil.copytree(Path(template_dir) / "data", data, dirs_exist_ok=True)
    P.init_aseg((data / "aseg_uint8.bin.gz").read_bytes(), (data / "aseg.json").read_text())
    if surface and (data / "cortex_surface.bin.gz").exists():
        P.init_cortex((data / "cortex_surface.bin.gz").read_bytes(), (data / "cortex_surface.json").read_text())

    metas = []
    for i, src in enumerate(niftis):
        name = names[i] or Path(src).name.replace(".nii.gz", "").replace(".nii", "")
        meta = json.loads(P.process_nifti(str(src), name, thresholds[i], classify=classify, surface=surface))
        # grab THIS overlay's buffers before the next process_nifti clears _BUFFERS
        metas.append(write_overlay_arrays(data, meta, P.get_all_buffers(), index=i))

    scene = json.loads((data / "scene.json").read_text())
    if not include_subcortical:
        scene.pop("subcortical", None)
    if not classify:
        # No-template / volume-only (M7): drop the anatomical shell; the volume stands alone.
        scene.pop("cortex", None)
        scene.pop("subcortical", None)
        scene["templateMode"] = "none"
    scene["overlays"] = metas
    (data / "scene.json").write_text(json.dumps(scene))
    return out_dir


def _render_config(layout, style, *, cmap, width, height, scale, background, colorbar,
                   colorbar_font, colorbar_fontsize, background_alpha):
    """Build the render-config.json the headless viewer consumes (the exact dict the old
    render_to_png built inline). Returns (config, transparent)."""
    # Transparent background (Free Canvas): record bgAlpha in the layout so the WebGL clear is
    # transparent; the screenshot then captures real alpha. Default 1 = opaque → byte-identical.
    transparent = background_alpha < 1
    if transparent:
        layout = {**layout, "canvas": {**layout.get("canvas", {}), "bgAlpha": background_alpha}}
    # CLI figures (print) want thicker surface lines, a little more breathing room, and no faint
    # subcortical glass shell. Defaults — any explicit flag in `style` wins via the deep-merge.
    cli_style = {"margin": 1.05, "outline": {"width": 7.0}, "anatomy": {"maxOpacity": 0.0}}
    merged_style = _deep_merge(cli_style, style or {})
    merged_style["colormap"] = cmap
    cb_w = round(width * 0.22)   # colorbar scaled to the figure
    config = {
        "layout": layout,
        "style": merged_style,
        "render": {"width": width, "height": height, "pixelRatio": scale,
                   "background": background, "colorbar": colorbar,
                   "colorbarWidth": cb_w, "colorbarHeight": max(16, round(cb_w / 15)),
                   "colorbarFontSize": colorbar_fontsize or max(13, round(width * 0.011)),
                   **({"colorbarFont": colorbar_font} if colorbar_font else {})},
    }
    return config, transparent


class RenderSession:
    """Holds ONE Playwright browser open across many renders (amortizes the ~0.7s launch) and
    can return PNG *bytes* (for inline notebook display) as well as write files. render_to_png,
    the notebook API (M5), and render_batch all go through this one path, so the byte-identical
    output guarantee holds for every front-end.

    Args: gpu=True swaps swiftshader for the ANGLE GL backend (faster locally, no GPU on CI);
    template_dir overlays a custom/non-MNI template bundle (M9); keep_dirs leaves the staged
    temp dirs for debugging.
    """

    def __init__(self, *, headless=True, gpu=False, template_dir=None, keep_dirs=False):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        args = ["--ignore-gpu-blocklist"] + ([] if gpu else ["--use-gl=angle", "--use-angle=swiftshader"])
        self.browser = self._pw.chromium.launch(headless=headless, args=args)
        self.template_dir = template_dir
        self.keep_dirs = keep_dirs

    def render(self, nifti, out_png=None, *, layout, style=None, threshold=2.3, cmap="auto",
               width=1600, height=1000, scale=2, include_subcortical=True,
               background="#ffffff", background_alpha=1.0, colorbar=True, colorbar_font=None,
               colorbar_fontsize=None, crop="none", names=None, timeout_ms=90000, return_bytes=False,
               classify=True):
        """Render one figure. Writes <out_png> (+ <out_png>_colorbars) when out_png is given;
        returns its Path. With return_bytes=True returns (brain_png_bytes, colorbar_png_bytes|None)
        — the inline-display path. `nifti` is one path or a list (one overlay each). classify=False
        is the no-template / volume-only path (no anatomical shell)."""
        if names is None and style and isinstance(style.get("overlays"), list):
            names = [(o or {}).get("name") for o in style["overlays"]] or None
        n_overlays = 1 if isinstance(nifti, (str, Path)) else len(nifti)
        out_dir = prepare_render_dir(nifti, threshold, include_subcortical, names=names,
                                     template_dir=self.template_dir, classify=classify,
                                     surface=_wants_surface(style))
        config, transparent = _render_config(
            layout, style, cmap=cmap, width=width, height=height, scale=scale,
            background=background, colorbar=colorbar, colorbar_font=colorbar_font,
            colorbar_fontsize=colorbar_fontsize, background_alpha=background_alpha)
        (out_dir / "render-config.json").write_text(json.dumps(config, indent=2))

        httpd, port = _serve_dir(out_dir)
        page = self.browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=scale)
        try:
            # domcontentloaded (not networkidle): __GB_DONE__ is the real readiness gate and the
            # vendored assets mean no late network to idle-wait on.
            page.goto(f"http://localhost:{port}/index.html?headless=1&config=render-config.json",
                      wait_until="domcontentloaded")
            page.wait_for_function("window.__GB_DONE__ === true || window.__GB_ERR__", timeout=timeout_ms)
            err = page.evaluate("window.__GB_ERR__ || null")
            if err:
                raise RuntimeError(f"viewer error: {err}")
            # Brain: hide the colorbar so the brains fill the full frame, then screenshot to bytes.
            page.evaluate("() => { const c = document.querySelector('.colorbar'); if (c) c.style.display = 'none'; }")
            if transparent:
                page.evaluate("() => { for (const s of ['html','body','#viewer']) { const e = document.querySelector(s); if (e) e.style.background = 'transparent'; } }")
            bbox = page.evaluate("window.__contentBBox && window.__contentBBox()") if crop == "content" else None
            if bbox:
                brain = page.screenshot(omit_background=transparent,
                                        clip={"x": bbox["x"], "y": bbox["y"], "width": bbox["w"], "height": bbox["h"]})
            else:
                brain = page.locator("#viewer").screenshot(omit_background=transparent)
            cbar = None
            if colorbar:
                # Reveal the bars on an opaque white strip so a multi-bar legend screenshots clean.
                page.evaluate("() => { const c = document.querySelector('.colorbar');"
                              " if (c) { c.style.display = ''; c.style.background = '#ffffff'; c.style.padding = '6px 10px'; } }")
                page.wait_for_timeout(60)
                bar = page.locator('.colorbar')
                if bar.count() and bar.bounding_box():
                    cbar = bar.screenshot()
        finally:
            page.close()
            httpd.shutdown()
            if not self.keep_dirs:
                shutil.rmtree(out_dir, ignore_errors=True)

        if out_png is not None:
            Path(out_png).write_bytes(brain)
            outputs = [out_png]
            if cbar is not None:
                side = Path(out_png).with_name(Path(out_png).stem + "_colorbars" + Path(out_png).suffix)
                Path(side).write_bytes(cbar)
                outputs.append(side)
            print("Rendered " + ", ".join(str(o) for o in outputs) +
                  f"  ({width}x{height} @{scale}x, {n_overlays} overlay{'s' if n_overlays != 1 else ''})")
        return (brain, cbar) if return_bytes else (Path(out_png) if out_png is not None else brain)

    def close(self):
        self.browser.close()
        self._pw.stop()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def render_to_png(nifti, out_png, **kwargs):
    """Byte-identical one-shot wrapper over RenderSession (existing CLI/callers unchanged)."""
    with RenderSession() as s:
        s.render(nifti, out_png, **kwargs)
    return out_png


def render_batch(jobs, **session_kwargs):
    """Render many figures reusing ONE browser. `jobs` is a list of dicts, each carrying
    `nifti`, `out`/`out_png`, and the per-job render kwargs (layout, style, ...)."""
    outs = []
    with RenderSession(**session_kwargs) as s:
        for job in jobs:
            j = dict(job)
            out = j.pop("out_png", None) or j.pop("out")
            outs.append(s.render(j.pop("nifti"), out, **j))
    return outs
