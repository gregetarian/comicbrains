"""The notebook / Python front-end — the third way to drive the one engine (alongside the
browser and the standalone CLI), all over the same config + RenderSession.

    import comic as gb
    fig = gb.render("zstat.nii.gz", views=["left_lateral", "dorsal"], grid="1x2", cmap="Reds")
    fig                      # renders INLINE in Jupyter / VSCode interactive (via _repr_png_)
    fig.save("figure.png")

    # several maps, per-overlay style (scalar = same for all, list = per overlay):
    gb.render(["faces.nii.gz", "language.nii.gz"], cmap=["Reds", "YlGnBu"], threshold=[4.0, 2.3])

    # reproduce a browser Copy-CLI figure.json exactly:
    gb.render_spec("figure.json", ["faces.nii.gz", "language.nii.gz"])

    # iterate fast over one persistent browser:
    s = gb.Scene(grid="1x3", views=["left_lateral","dorsal","right_lateral"])
    s.add("faces.nii.gz", cmap="Reds"); s.add("language.nii.gz", cmap="YlGnBu")
    s            # re-renders inline on each cell-eval, sub-second after warmup
"""
import base64
import copy
import os
import tempfile

from .render import RenderSession, build_layout, to_volume_layout

DEFAULT_VIEWS = ["left_lateral", "right_lateral", "left_medial", "right_medial",
                 "anterior", "dorsal", "subcortical_l", "subcortical_r"]
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _set(d, path, value):
    *keys, last = path.split(".")
    for k in keys:
        d = d.setdefault(k, {})
    d[last] = value


def build_style(n, *, base=None, cmap=None, colormapMode=None, gamma=None, clim=None,
                threshold=None, clusterMin=None, positiveOnly=None, voxels=None, units=None):
    """Build a style dict from notebook/CLI kwargs. Per-overlay rule: a scalar broadcasts
    (global style.<key>); a *list* binds per overlay (style.overlays[i].<key>). `clim` is the
    one exception — it is itself a [vmin,vmax] pair, so it is always treated as GLOBAL; per-overlay
    clim goes through base=style['overlays']. Returns (style, bake_thresholds)."""
    style = copy.deepcopy(base) if base else {}
    overlays = style.setdefault("overlays", [])
    while len(overlays) < n:
        overlays.append({})

    def assign(value, gpath):
        if value is None:
            return
        if isinstance(value, (list, tuple)):           # per-overlay
            if len(value) != n:
                raise ValueError(f'{gpath}: expected {n} per-overlay values, received {len(value)}')
            for i in range(n):
                if value[i] is not None:
                    _set(overlays[i], gpath, value[i])
        else:                                          # global broadcast
            _set(style, gpath, value)
            for overlay in overlays:
                target = overlay
                *parents, key = gpath.split('.')
                for parent in parents:
                    target = target.get(parent, {})
                target.pop(key, None)

    assign(cmap, "colormap")
    assign(colormapMode, "colormapMode")
    assign(gamma, "gamma")
    assign(positiveOnly, "positiveOnly")
    assign(clusterMin, "voxel.clusterMin")
    assign(voxels, "voxel.representation")
    assign(threshold, "threshold")                     # live (display) threshold
    if clim is not None:
        style["clim"] = clim                           # global only (see docstring)
        for overlay in overlays:
            overlay.pop('clim', None)
    if units is not None:
        style['units'] = {**style.get('units', {}), **units}
        for overlay in overlays:
            for key in units:
                (overlay.get('units') or {}).pop(key, None)
    if not overlays:
        style.pop("overlays", None)
    # bake threshold (geometry cutoff): scalar broadcasts, list is per-overlay.
    bake = list(threshold) if isinstance(threshold, (list, tuple)) else (threshold if threshold is not None else 0)
    return style, bake


class Figure:
    """A rendered figure: PNG bytes (+ optional colorbar legend bytes) and the config used.
    Displays inline in Jupyter/VSCode via the repr hooks; .save() writes the file(s)."""

    def __init__(self, png, colorbar_png, config, out=None):
        self.png = png
        self.colorbar_png = colorbar_png
        self.config = config
        self._out = out

    def save(self, path):
        from pathlib import Path
        p = Path(path)
        p.write_bytes(self.png)
        outs = [p]
        if self.colorbar_png is not None:
            side = p.with_name(p.stem + "_colorbars" + p.suffix)
            side.write_bytes(self.colorbar_png)
            outs.append(side)
        return outs[0]

    def pil(self):
        import io
        from PIL import Image
        return Image.open(io.BytesIO(self.png))

    def to_ipython_image(self):
        from IPython.display import Image
        return Image(self.png)

    def _repr_png_(self):          # Jupyter image protocol — shows the brain inline
        return self.png

    def _repr_html_(self):         # brain + colorbar side by side when both exist
        b = base64.b64encode(self.png).decode()
        html = f'<img src="data:image/png;base64,{b}" style="max-width:100%">'
        if self.colorbar_png is not None:
            c = base64.b64encode(self.colorbar_png).decode()
            html += f'<br><img src="data:image/png;base64,{c}" style="max-width:60%">'
        return html


def _to_paths(items):
    """Materialize each overlay input to a NIfTI path so the engine can load it.
    Each item may be a path (str/PathLike), an in-memory nibabel image, or an
    (array, affine) pair; images/arrays are written to a temp .nii.gz. Returns
    (paths, tempfiles) so the caller can delete the temps after rendering."""
    import numpy as np
    import nibabel as nib
    paths, tmp = [], []
    for x in items:
        if isinstance(x, (str, os.PathLike)):
            paths.append(str(x))
            continue
        if isinstance(x, tuple) and len(x) == 2:          # (array, affine)
            x = nib.Nifti1Image(np.asarray(x[0], dtype=np.float32), np.asarray(x[1]))
        fd, name = tempfile.mkstemp(suffix=".nii.gz")     # a nibabel image
        os.close(fd)
        nib.save(x, name)
        paths.append(name)
        tmp.append(name)
    return paths, tmp


def _layout_from(layout, views, grid):
    if layout is not None:
        return layout
    vlist = views if views is not None else DEFAULT_VIEWS
    if isinstance(vlist, str):
        vlist = [v.strip() for v in vlist.split(",")]
    return build_layout(grid, vlist)


def render(nifti, *, out=None, layout=None, views=None, grid="2x4", style=None,
           threshold=0, cmap="auto", clusterMin=0, colormapMode=None, gamma=None,
           clim=None, positiveOnly=None, voxels=None, units=None, names=None,
           width=1600, height=1000, scale=2, include_subcortical=True,
           background="#ffffff", background_alpha=1.0, crop="none", colorbar=True,
           template=None, session=None):
    """Render a NIfTI to a Figure. `nifti` may be a path, an in-memory nibabel image, or an
    (array, affine) pair --- or a list of these for a multi-overlay figure. Per-overlay kwargs
    accept a scalar (same for every overlay) or a list (one value per overlay). Intensity and
    cluster thresholds both default to zero. `template` is a custom template dir (M9) or None.
    Pass an existing `session` (a RenderSession) to reuse one headless browser."""
    items = nifti if isinstance(nifti, list) else [nifti]
    paths, _tmpfiles = _to_paths(items)
    n = len(paths)
    nifti = paths[0] if n == 1 else paths
    layout = _layout_from(layout, views, grid)
    built, bake_thr = build_style(n, base=style, cmap=(None if cmap == "auto" else cmap),
                                  colormapMode=colormapMode, gamma=gamma, clim=clim,
                                  threshold=threshold, clusterMin=clusterMin,
                                  positiveOnly=positiveOnly, voxels=voxels, units=units)
    is_none = template == "none"   # no-template / volume-only (M7): no shell, no hemisphere split
    if is_none:
        layout = to_volume_layout(layout)
    sess = session or RenderSession(template_dir=(None if is_none else template))
    try:
        brain, cbar = sess.render(nifti, out, layout=layout, style=built, threshold=bake_thr,
                                  cmap=cmap, width=width, height=height, scale=scale,
                                  include_subcortical=include_subcortical, background=background,
                                  background_alpha=background_alpha, colorbar=colorbar,
                                  crop=crop, names=names, classify=not is_none, return_bytes=True)
    finally:
        if session is None:
            sess.close()
        for _p in _tmpfiles:            # clean up any temp NIfTIs written for in-memory inputs
            os.unlink(_p)
    kind = "none" if is_none else ("custom" if template else "mni")
    config = {"template": {"kind": kind, "dir": (None if is_none else template), "space": "MNI152"},
              "layout": layout, "style": built,
              "render": {"width": width, "height": height, "background": background}}
    return Figure(brain, cbar, config, out)


def render_spec(spec, nifti, *, out=None, session=None, width=None, height=None, scale=None,
                background_alpha=None, colorbar=None, crop="none", names=None, template=None):
    """Render the SAME figure.json the browser Copy-CLI emits. `spec` is a path or dict;
    `nifti` (path/list) fills the overlay slots in order. Validates loudly via spec.validate."""
    import json
    from pathlib import Path
    from . import spec as gb_spec
    from .inputs import input_descriptors, processing_thresholds, input_names, validate_input_types
    doc = spec if isinstance(spec, dict) else json.loads(Path(spec).read_text())
    gb_spec.validate(doc)
    layout = doc.get("layout", doc)
    style = doc.get("style", {})
    r = doc.get("render", {})
    w = width or r.get("width", 1600)
    h = height or r.get("height", 1000)
    bg_a = background_alpha if background_alpha is not None else (layout.get("canvas") or {}).get("bgAlpha", 1.0)
    items = [nifti] if isinstance(nifti, (str, os.PathLike, dict)) else list(nifti)
    ordered = any(isinstance(item, dict) for item in items)
    descriptors = input_descriptors(input_maps=[item if isinstance(item, dict) else {'type': 'volume', 'path': item}
                                               for item in items])
    nn = len(descriptors)
    gb_spec.validate_input_count(doc, nn)
    validate_input_types(doc, descriptors)
    thr = processing_thresholds(doc, nn)
    saved_template = doc.get('template') or {}
    kind = saved_template.get('kind', 'mni')
    template_dir = template or (saved_template.get('dir') if kind == 'custom' else None)
    if kind == 'custom' and not template_dir and session is None:
        raise ValueError('custom template recipe needs template=... or a prepared RenderSession')
    sess = session or RenderSession(template_dir=template_dir)
    try:
        brain, cbar = sess.render(None if ordered else nifti, out, layout=layout, style=style, threshold=thr,
                                  cmap=style.get("colormap", "auto"), width=w, height=h,
                                  scale=scale if scale is not None else r.get('pixelRatio', 2),
                                  background=r.get('background', '#ffffff'), background_alpha=bg_a,
                                  colorbar=colorbar if colorbar is not None else r.get('colorbar', True),
                                  crop=crop, names=names or input_names(doc, nn), classify=kind != 'none',
                                  input_maps=descriptors if ordered else None, render_options=r,
                                  return_bytes=True)
    finally:
        if session is None:
            sess.close()
    used = copy.deepcopy(doc)
    used.update({'layout': layout, 'style': style})
    used['render'] = {**r, 'width': w, 'height': h,
                      'pixelRatio': scale if scale is not None else r.get('pixelRatio', 2),
                      'background': r.get('background', '#ffffff'),
                      'colorbar': colorbar if colorbar is not None else r.get('colorbar', True)}
    if background_alpha is not None:
        used['layout'] = copy.deepcopy(layout)
        used['layout'].setdefault('canvas', {})['bgAlpha'] = bg_a
    if template_dir:
        used['template'] = {**saved_template, 'kind': 'custom', 'dir': str(template_dir)}
    return Figure(brain, cbar, used, out)


class Scene:
    """Fluent builder that holds ONE RenderSession open, for fast iterative work in a notebook:
    each cell-eval re-renders inline (sub-second after warmup). .add() appends an overlay with
    per-overlay style (friendly kwargs: cmap=, threshold=, gamma=, clusterMin=, voxels=, ...);
    .style() sets globals; .grid()/.layout() set the layout; .save() writes the file. It delegates
    to render() so the per-overlay scalar/list semantics are identical across the API."""

    def __init__(self, *, grid="2x4", views=None, layout=None, **render_kwargs):
        self._kw = dict(grid=grid, views=views, layout=layout, **render_kwargs)
        self._maps, self._ov, self._global = [], [], {}
        self._session = RenderSession(template_dir=render_kwargs.get("template"))

    def add(self, nifti, **overlay_style):
        self._maps.append(nifti)
        self._ov.append(overlay_style)
        return self

    def grid(self, grid, views):
        self._kw.update(grid=grid, views=views, layout=None)
        return self

    def layout(self, layout):
        self._kw["layout"] = layout
        return self

    def style(self, **global_style):
        self._global.update(global_style)
        return self

    def render(self, out=None):
        # transpose each overlay's friendly kwargs into per-overlay lists for render()
        keys = set().union(*[set(o) for o in self._ov]) if self._ov else set()
        per = {k: [o.get(k) for o in self._ov] for k in keys}
        nifti = self._maps[0] if len(self._maps) == 1 else self._maps
        return render(nifti, out=out, session=self._session, **{**self._kw, **self._global, **per})

    def save(self, path):
        return self.render(out=path).save(path)

    def _repr_png_(self):
        return self.render().png if self._maps else None

    def close(self):
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
