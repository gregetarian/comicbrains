"""Headless figure rendering: build a custom multi-panel PNG from a NIfTI.

Reuses the exact browser viewer (run in headless Chromium via Playwright), so
the interfaces share geometry, styling and rendering semantics. WebGL raster output
may vary slightly across browsers, operating systems and graphics backends. Fully
customisable layout: any grid of anatomical views, plus all style parameters.
"""

import json
import copy
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
    side = "l" if sub_hemi == "lh" else "r"
    anatomy_categories = [f"subcort_{side}", f"cereb_{side}", "brainstem"]
    return {"roles": ["cortex", "anatomy", "voxel"], "hemisphere": cortex_hemi,
            "anatomyHemisphere": sub_hemi,
            "categories": None,
            "anatomyCategories": anatomy_categories,
            "voxelCategories": [f"{cortex_hemi}_cortex", *anatomy_categories],
            "anatomyStyle": "opaque"}


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
                 "camera": {"plane": plane}, "content": copy.deepcopy(content)}
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
def _serve_dir(directory, port=0):
    directory = str(Path(directory).resolve())

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=directory, **k)

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache, no-store")
            super().end_headers()

        def log_message(self, *a):
            pass

    # Let the OS allocate a private port for each render session. Binding to
    # loopback also keeps temporary input data off the local network.
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


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


def _wants_surface(style, layout=None):
    """True when any overlay or panel needs volume-to-surface projection geometry."""
    for panel in ((layout or {}).get("panels") or []):
        if ((panel.get("content") or {}).get("representation") == "surface"):
            return True
        view = panel.get("view")
        if view in VIEWS and VIEWS[view][1].get("representation") == "surface":
            return True
    if not style:
        return False
    if ((style.get("voxel") or {}).get("representation")) == "surface":
        return True
    return any(o and ((o.get("voxel") or {}).get("representation")) == "surface"
               for o in (style.get("overlays") or []))


def _surface_map_name(sm):
    """Default display name for a surface overlay: strip a lh./rh. prefix + surface suffix."""
    import re
    src = sm.get("lh") or sm.get("rh") or "surface"
    base = Path(str(src)).name
    base = re.sub(r"\.(gii|mgh|mgz|surfdat)$", "", base, flags=re.I)
    base = re.sub(r"^(lh|rh)[._-]", "", base, flags=re.I)
    return base or "surface"


def prepare_render_dir(nifti=None, threshold=2.3, include_subcortical=True, names=None, template_dir=None,
                       classify=True, surface=False, surface_maps=None, input_maps=None):
    """Stage a self-contained render dir: a copy of the single viewer with the overlay(s)
    processed in-process (same pipeline.py the browser runs) and written as ARRAYS
    (overlay_<i>.bin + meta in scene.json) — no GLB, no per-render template re-bake.

    `nifti` is a single path (str/Path) OR a list of paths for a multi-overlay figure;
    `surface_maps` is an optional list of {lh, rh, name?} dicts — each a NATIVE fsaverage
    surface overlay (per-vertex .gii/.mgh/.mgz), rendered on the cortex sheet with no
    blocky/smooth geometry. Volume overlays come first, then surface overlays.
    `threshold` is a scalar (applied to every overlay) OR a per-overlay list spanning both;
    `names` (optional) is a per-overlay display name. Returns the dir path."""
    from . import pipeline as P
    from .arrays import write_overlay_arrays
    from .inputs import input_descriptors

    inputs = input_descriptors(nifti, surface_maps, input_maps)
    n_total = len(inputs)
    thresholds = ([float(threshold)] * n_total if isinstance(threshold, (int, float))
                  else [float(t) for t in threshold])
    names = list(names or [])
    names += [None] * (n_total - len(names))
    if len(thresholds) != n_total:
        raise ValueError(f"expected {n_total} processing thresholds, received {len(thresholds)}")

    out_dir = Path(tempfile.mkdtemp(prefix="gb_render_"))
    try:
        shutil.copytree(WEB_DIR, out_dir, dirs_exist_ok=True)
        data = out_dir / "data"
        # M4 hook (custom/non-MNI template, exercised in M9): overlay a template bundle's data/
        # (cortex/subcortical GLBs + aseg + scene.json) on top of the bundled fsaverage assets.
        if template_dir is not None:
            shutil.copytree(Path(template_dir) / "data", data, dirs_exist_ok=True)
        P.init_aseg((data / "aseg_uint8.bin.gz").read_bytes(), (data / "aseg.json").read_text())
        # Native surface overlays (and volume->surface projection) both need the cortex sidecar.
        if (surface or any(d['type'] != 'volume' for d in inputs)) and (data / "cortex_surface.bin.gz").exists():
            P.init_cortex((data / "cortex_surface.bin.gz").read_bytes(), (data / "cortex_surface.json").read_text())

        metas = []
        for i, item in enumerate(inputs):
            if item['type'] == 'volume':
                src = item['path']
                name = names[i] or item.get('name') or Path(src).name.replace('.nii.gz', '').replace('.nii', '')
                meta = json.loads(P.process_nifti(str(src), name, thresholds[i], classify=classify, surface=surface))
            else:
                sm = item
                if item['type'] == 'parcel':
                    from . import parcels
                    sm = parcels.values_to_vertex_maps(parcels.load_value_table(item['path']), item['atlas'],
                                                       data / 'parcels')
                name = names[i] or item.get('name') or (Path(item['path']).stem if item['type'] == 'parcel' else _surface_map_name(sm))
                meta = json.loads(P.process_surface(sm.get('lh'), sm.get('rh'), name, thresholds[i]))
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
    except BaseException:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    return out_dir


def _render_config(layout, style, *, cmap, width, height, scale, background, colorbar,
                   colorbar_font, colorbar_fontsize, background_alpha, render_options=None):
    """Build the render-config.json the headless viewer consumes (the exact dict the old
    render_to_png built inline). Returns (config, transparent)."""
    # Transparent background (Free Canvas): record bgAlpha in the layout so the WebGL clear is
    # transparent; the screenshot then captures real alpha. Default 1 preserves opaque output.
    transparent = background_alpha < 1
    layout = {**layout, "canvas": {**layout.get("canvas", {}), "bgAlpha": background_alpha}}
    # Match the fresh browser's FREE_DEFAULT cosmetic style. Explicit recipe/flag
    # settings win. A cross-source test guards this small mirrored preset fragment.
    cli_style = {"cortexSurface": "pial", "margin": 0.95, "glass": {"maxOpacity": 0.09},
                 "outline": {"width": 3.5}}
    merged_style = _deep_merge(cli_style, style or {})
    merged_style["colormap"] = cmap
    cb_w = round(width * 0.22)   # colorbar scaled to the figure
    config = {
        "layout": layout,
        "style": merged_style,
        "render": {**(render_options or {}), "width": width, "height": height, "pixelRatio": scale,
                   "background": background, "colorbar": colorbar,
                   "colorbarWidth": (render_options or {}).get('colorbarWidth', cb_w),
                   "colorbarHeight": (render_options or {}).get('colorbarHeight', max(16, round(cb_w / 15))),
                   "colorbarFontSize": colorbar_fontsize or (render_options or {}).get('colorbarFontSize', max(13, round(width * 0.011))),
                   **({"colorbarFont": colorbar_font} if colorbar_font else {})},
    }
    return config, transparent


class RenderSession:
    """Holds ONE Playwright browser open across many renders (amortizes the ~0.7s launch) and
    can return PNG *bytes* (for inline notebook display) as well as write files. render_to_png,
    the notebook API (M5), and render_batch all go through this one path, so every scripted
    interface uses the same renderer and configuration semantics.

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

    def render(self, nifti=None, out_png=None, *, layout, style=None, threshold=2.3, cmap="auto",
               width=1600, height=1000, scale=2, include_subcortical=True,
               background="#ffffff", background_alpha=1.0, colorbar=True, colorbar_font=None,
               colorbar_fontsize=None, crop="none", names=None, timeout_ms=90000, return_bytes=False,
               classify=True, surface_maps=None, input_maps=None, render_options=None, colorbar_svg=False):
        """Render one figure. Writes <out_png> (+ <out_png>_colorbars) when out_png is given;
        returns its Path. With return_bytes=True returns (brain_png_bytes, colorbar_png_bytes|None)
        — the inline-display path. `nifti` is one path or a list (one overlay each); `surface_maps`
        is an optional list of {lh, rh, name?} native fsaverage surface overlays. classify=False
        is the no-template / volume-only path (no anatomical shell)."""
        if names is None and style and isinstance(style.get("overlays"), list):
            names = [(o or {}).get("name") for o in style["overlays"]] or None
        from .inputs import input_descriptors
        n_overlays = len(input_descriptors(nifti, surface_maps, input_maps))
        out_dir = prepare_render_dir(nifti, threshold, include_subcortical, names=names,
                                     template_dir=self.template_dir, classify=classify,
                                     surface=_wants_surface(style, layout), surface_maps=surface_maps, input_maps=input_maps)
        config, transparent = _render_config(
            layout, style, cmap=cmap, width=width, height=height, scale=scale,
            background=background, colorbar=colorbar, colorbar_font=colorbar_font,
            colorbar_fontsize=colorbar_fontsize, background_alpha=background_alpha, render_options=render_options)
        (out_dir / "render-config.json").write_text(json.dumps(config, indent=2))

        httpd, port = _serve_dir(out_dir)
        try:
            brain = cbar = last = None
            svg_bars = []
            for attempt in range(3):   # retry transient headless stalls (__GB_DONE__ never fires)
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
                    if colorbar_svg:
                        svg_bars = page.evaluate("""async () => {
                            const {colorbarSVGs} = await import('./controls/colorbar.js?v=depth-auto-v3');
                            const e = window.__engine();
                            return colorbarSVGs(e.config, e.overlays, e.colormaps);
                        }""")
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
                    break   # success
                except RuntimeError:
                    raise   # deterministic viewer error — don't retry
                except Exception as e:   # transient headless stall — fresh page + retry
                    last = e
                    print(f"  (render attempt {attempt + 1}/3: {type(e).__name__}; retrying)")
                finally:
                    page.close()
            else:
                raise last
        finally:
            httpd.shutdown()
            httpd.server_close()
            if not self.keep_dirs:
                shutil.rmtree(out_dir, ignore_errors=True)

        if out_png is not None:
            Path(out_png).write_bytes(brain)
            outputs = [out_png]
            if cbar is not None:
                side = Path(out_png).with_name(Path(out_png).stem + "_colorbars" + Path(out_png).suffix)
                Path(side).write_bytes(cbar)
                outputs.append(side)
            for i, svg in enumerate(svg_bars):
                suffix = f'_overlay{i}' if len(svg_bars) > 1 else ''
                side = Path(out_png).with_name(Path(out_png).stem + suffix + '_colorbars.svg')
                side.write_text(svg)
                outputs.append(side)
            print("Rendered " + ", ".join(str(o) for o in outputs) +
                  f"  ({width}x{height} @{scale}x, {n_overlays} overlay{'s' if n_overlays != 1 else ''})")
        return (brain, cbar) if return_bytes else (Path(out_png) if out_png is not None else brain)

    def orbit(self, nifti, *, layout, yaws, style=None, threshold=2.3, cmap="auto",
              width=1600, height=1000, scale=2, include_subcortical=True,
              background="#ffffff", background_alpha=1.0, classify=True, names=None,
              crop="none", timeout_ms=90000):
        """Turntable: load the page ONCE, then spin the camera to each yaw via window.__GB_orbit and
        screenshot — no per-frame page reload / re-mesh / re-serve (so all frames are fast and a
        single WebGL context is used, sidestepping the multi-page software-GL slowdown). Returns a
        list of PNG bytes, one per yaw. colorbar is always off (a turntable shows brains only)."""
        if names is None and style and isinstance(style.get("overlays"), list):
            names = [(o or {}).get("name") for o in style["overlays"]] or None
        out_dir = prepare_render_dir(nifti, threshold, include_subcortical, names=names,
                                     template_dir=self.template_dir, classify=classify,
                                     surface=_wants_surface(style, layout))
        config, transparent = _render_config(
            layout, style, cmap=cmap, width=width, height=height, scale=scale, background=background,
            colorbar=False, colorbar_font=None, colorbar_fontsize=None, background_alpha=background_alpha)
        (out_dir / "render-config.json").write_text(json.dumps(config))

        httpd, port = _serve_dir(out_dir)
        out = []
        try:
            page = self.browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=scale)
            try:
                page.goto(f"http://localhost:{port}/index.html?headless=1&config=render-config.json",
                          wait_until="domcontentloaded")
                page.wait_for_function("window.__GB_DONE__ === true || window.__GB_ERR__", timeout=timeout_ms)
                err = page.evaluate("window.__GB_ERR__ || null")
                if err:
                    raise RuntimeError(f"viewer error: {err}")
                page.evaluate("() => { const c = document.querySelector('.colorbar'); if (c) c.style.display = 'none'; }")
                if transparent:
                    page.evaluate("() => { for (const s of ['html','body','#viewer']) { const e = document.querySelector(s); if (e) e.style.background = 'transparent'; } }")
                if not page.evaluate("typeof window.__GB_orbit === 'function'"):
                    raise RuntimeError("viewer has no __GB_orbit hook (stale web assets?)")
                for yaw in yaws:
                    page.evaluate(f"window.__GB_orbit({float(yaw)})")
                    page.wait_for_timeout(15)   # let the in-place re-render settle before the shot
                    out.append(page.locator("#viewer").screenshot(omit_background=transparent))
            finally:
                page.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            if not self.keep_dirs:
                shutil.rmtree(out_dir, ignore_errors=True)
        return out

    def close(self):
        self.browser.close()
        self._pw.stop()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def render_to_png(nifti, out_png, *, template_dir=None, **kwargs):
    """One-shot wrapper over RenderSession. template_dir overlays a custom/non-MNI template
    bundle (M9); omit it for the bundled fsaverage."""
    with RenderSession(template_dir=template_dir) as s:
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


def render_sweep(nifti, out, *, layout, param, values, cols=None, template_dir=None, **render_kwargs):
    """Small-multiples sweep (M10): render one panel per value of `param` ('cluster' or 'threshold')
    and montage them into a grid PNG, reusing ONE browser. clusterMin is a live filter; threshold
    re-meshes per tile. Returns the montage path."""
    import io
    import math
    from PIL import Image, ImageDraw
    cols = cols or min(len(values), 4)
    rows = math.ceil(len(values) / cols)
    render_kwargs.setdefault("timeout_ms", 45000)
    tiles = []
    with RenderSession(template_dir=template_dir) as s:
        for v in values:
            kw = dict(render_kwargs)
            if param == "threshold":
                kw["threshold"] = v
            else:  # cluster-extent: a live style filter (no re-mesh)
                st = dict(kw.get("style") or {})
                st["voxel"] = {**(st.get("voxel") or {}), "clusterMin": v}
                kw["style"] = st
            png, _ = s.render(nifti, layout=layout, colorbar=False, return_bytes=True, **kw)
            tiles.append((v, Image.open(io.BytesIO(png)).convert("RGB")))
    tw, th = tiles[0][1].size
    canvas = Image.new("RGB", (cols * tw, rows * th), "white")
    label = f"{'k' if param == 'cluster' else 'thr'}="
    for i, (v, t) in enumerate(tiles):
        x, y = (i % cols) * tw, (i // cols) * th
        canvas.paste(t, (x, y))
        ImageDraw.Draw(canvas).text((x + 8, y + 6), f"{label}{v:g}", fill="#333")
    canvas.save(out)
    print(f"Wrote sweep ({param}={','.join(f'{v:g}' for v in values)}) -> {out}")
    return out


def _colorbar_documents(config, metas, colormaps_json=None):
    """Ask the shared browser module for SVG; no parallel Python colour mathematics."""
    cj = colormaps_json or json.loads((WEB_DIR / 'data' / 'colormaps.json').read_text())
    httpd, port = _serve_dir(WEB_DIR)
    try:
        with RenderSession() as session:
            page = session.browser.new_page()
            try:
                page.goto(f'http://localhost:{port}/data/scene.json', wait_until='domcontentloaded')
                return page.evaluate("""async ({config, metas, cj}) => {
                    const {normalizeConfig} = await import('/core/config-schema.js');
                    const {loadColormaps} = await import('/core/colormap.js');
                    const {colorbarSVGs} = await import('/controls/colorbar.js');
                    return colorbarSVGs(normalizeConfig(config), metas, loadColormaps(cj));
                }""", {'config': config, 'metas': metas, 'cj': cj})
            finally:
                page.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


def colorbar_svg(out, *, colormap, vmin, vmax, units=None, n=64, width=460, bar_h=22,
                 colormaps_json=None, gamma=1, threshold=0, positive_only=False):
    """Write a vector legend using the same JavaScript model as the browser/CLI PNG bars.

    Requires the render extra and Chromium. ``n`` is retained for call compatibility;
    the shared model samples at the requested bar width for consistent PNG/SVG colour.
    """
    config = {'layout': build_layout('1x1', ['dorsal']),
              'style': {'colormap': colormap, 'clim': [vmin, vmax], 'gamma': gamma,
                        'threshold': threshold, 'positiveOnly': positive_only,
                        'units': {'value': units or 'stat'}},
              'render': {'colorbarWidth': width, 'colorbarHeight': bar_h, 'colorbarFontSize': 11}}
    meta = {'maxAbsValue': max(abs(vmin), abs(vmax)), 'diverging': vmin < 0 < vmax,
            'negativeOnly': vmax <= 0, 'threshold': threshold}
    Path(out).write_text(_colorbar_documents(config, [meta], colormaps_json)[0])
    return out


def export_colorbar_svgs(out, *, input_maps, style, thresholds, template_dir=None, classify=True):
    """Legends for animation/sweep routes, using their inputs and the shared colour model."""
    stage = prepare_render_dir(input_maps=input_maps, threshold=thresholds,
                               template_dir=template_dir, classify=classify)
    try:
        metas = json.loads((stage / 'data' / 'scene.json').read_text())['overlays']
        config = {'layout': build_layout('1x1', ['dorsal']), 'style': style,
                  'render': {'colorbarWidth': 460, 'colorbarHeight': 22, 'colorbarFontSize': 11}}
        docs = _colorbar_documents(config, metas)
        for i, svg in enumerate(docs):
            suffix = f'_overlay{i}' if len(docs) > 1 else ''
            path = Path(out).with_name(Path(out).stem + suffix + '_colorbars.svg')
            path.write_text(svg)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def region_report(nifti, threshold=2.3, template_dir=None):
    """Per-region supra-threshold voxel counts for a map, from the aseg classification the pipeline
    already computes (M10). Returns {category: voxel_count}. Uses the bundled fsaverage aseg, or a
    custom template's aseg when template_dir is given."""
    from . import pipeline as P
    data = (Path(template_dir) / "data") if template_dir else (WEB_DIR / "data")
    P.init_aseg((data / "aseg_uint8.bin.gz").read_bytes(), (data / "aseg.json").read_text())
    meta = json.loads(P.process_nifti(str(nifti), Path(nifti).name, threshold))
    return meta.get("regionCounts", {})


def render_orbit(nifti, out, *, layout, frames=24, degrees=360.0, fps=12, gif=False, template_dir=None, **render_kwargs):
    """Turntable animation (M10): spin the brain through `degrees` total over `frames` frames. Loads
    the page ONCE and rotates the camera in place per frame (RenderSession.orbit) — so an N-frame
    orbit is one page load, not N (fast + dodges the multi-page software-GL slowdown). Writes
    <stem>_000.png, _001.png, ... and, with gif=True (needs imageio), assembles them into <out>.
    Returns the frame paths (or the GIF path). What being a real 3D volume earns."""
    out = Path(out)
    stem, ext = out.with_suffix(""), (out.suffix if out.suffix not in ("", ".gif") else ".png")
    yaws = [degrees * i / max(frames, 1) for i in range(frames)]
    with RenderSession(template_dir=template_dir) as s:
        frame_bytes = s.orbit(nifti, layout=layout, yaws=yaws, **render_kwargs)
    frame_paths = []
    for i, b in enumerate(frame_bytes):
        fp = f"{stem}_{i:03d}{ext}"
        Path(fp).write_bytes(b)
        frame_paths.append(fp)
    if gif:
        try:
            import imageio.v2 as imageio
            imageio.mimsave(str(out), [imageio.imread(fp) for fp in frame_paths],
                            duration=1.0 / max(fps, 1), loop=0)
            print(f"Wrote {out} ({frames} frames @ {fps}fps)")
            return out
        except Exception as e:
            print(f"(GIF assembly skipped: {e}); wrote {len(frame_paths)} frame PNGs")
    print(f"Wrote {len(frame_paths)} orbit frames -> {stem}_NNN{ext}")
    return frame_paths
