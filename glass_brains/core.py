"""GlassBrain — loads the fsaverage template (cortex + subcortical + aseg) for the
one-time asset bake (see glass_brains/bake.py). Per-upload meshing lives in
glass_brains/pipeline.py; the interactive viewer is served by `open_viewer`."""

import json
import numpy as np
from pathlib import Path

from .surfaces import load_template_surfaces
from .subcortical import extract_all_subcortical, LABEL_COLORS

WEB_DIR = Path(__file__).parent / 'web'   # the single static viewer (served by `open`)


# --- CLI per-overlay parsing (the M5 "one parser rule"): a bare scalar broadcasts to every
# overlay; a comma list binds per overlay -> style.overlays[i]. Same semantics as the notebook
# figure.build_style, so the standalone CLI reaches --spec/notebook per-overlay parity. ---
def _los(s, cast):
    """'a,b,c' -> [cast(a),cast(b),cast(c)] per overlay (blank element -> None); else cast(s)."""
    if s is None:
        return None
    s = str(s)
    if ',' in s:
        return [cast(x) if x.strip() != '' else None for x in s.split(',')]
    return cast(s)


def _parse_clim(s):
    """--clim 'VMIN,VMAX' -> [vmin,vmax]; ',8' or '8' -> 8.0 (a single bound). Global (clim is
    itself a pair); per-overlay clim goes through --overlay-json."""
    if s is None:
        return None
    parts = [p.strip() for p in str(s).split(',')]
    if len(parts) == 1:
        return float(parts[0])
    lo = float(parts[0]) if parts[0] else None
    hi = float(parts[1]) if parts[1] else None
    return hi if lo is None else lo if hi is None else [lo, hi]


def _parse_units(s):
    """--units 'value=z,cluster=mm3' -> {'value':'z','cluster':'mm3'}."""
    if s is None:
        return None
    return dict(kv.split('=', 1) for kv in (p.strip() for p in str(s).split(',')) if '=' in kv)


def open_viewer(port=8421):
    """Serve the static viewer locally and open it in the browser. Uploads are processed
    in-browser via Pyodide — identical to the GitHub Pages site; no Python backend."""
    import http.server
    import functools
    import threading
    import webbrowser
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB_DIR))
    for p in range(port, port + 100):
        try:
            httpd = http.server.ThreadingHTTPServer(("", p), handler)
            break
        except OSError:
            continue
    else:
        raise RuntimeError(f"No available port found near {port}")
    url = f"http://localhost:{p}/"
    print(f"Serving glass brain viewer at {url}")
    print("Drop a NIfTI in the browser to render it (processed locally via Pyodide). Press Ctrl+C to stop.")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


class GlassBrain:
    """Loads the fsaverage template (cortex + subcortical + aseg) for the one-time asset bake.
    Display config (colormap, layout, cluster threshold) lives in the viewer
    (config-schema.js / render-config.json), not here."""
    def __init__(self, template='fsaverage', space='MNI152', include_subcortical=True):
        self.template = template
        self.space = space
        self.surfaces = load_template_surfaces(template, space)
        self.subcortical = {}
        self.subcortical_colors = LABEL_COLORS
        self._aseg_data = None
        self._aseg_affine = None
        if include_subcortical:
            self.subcortical, self.subcortical_colors = extract_all_subcortical(template)
            self._load_aseg(template)

    def _load_aseg(self, template):
        import mne
        import nibabel as nib
        fs_dir = Path(mne.datasets.fetch_fsaverage(verbose=False))
        for p in [fs_dir / 'mri' / 'aseg.mgz', fs_dir / 'fsaverage' / 'mri' / 'aseg.mgz']:
            if p.exists():
                img = nib.load(str(p))
                self._aseg_data = np.asarray(img.dataobj)
                self._aseg_affine = img.affine
                return

    def _repr_html_(self):
        return "<p><b>GlassBrain</b>: bakes the fsaverage template. Run <code>glass-brains open</code> to view.</p>"


def cli():
    import argparse
    parser = argparse.ArgumentParser(description='Glass Brains 2.0 viewer')
    sub = parser.add_subparsers(dest='command')

    op = sub.add_parser('open', aliases=['show'],
                        help='Serve the interactive viewer locally; upload NIfTIs in the browser (Pyodide, no backend)')
    op.add_argument('nifti', nargs='*', help='(accepted for convenience but not loaded server-side; '
                                             'drag NIfTIs into the browser — processing is in-browser now)')
    op.add_argument('--port', type=int, default=8421)

    sub.add_parser('bake', help='Re-bake the fsaverage template assets into web/data/ (needs the [bake] extra)')

    r = sub.add_parser('render', help='Render a custom multi-panel figure to PNG (headless)')
    r.add_argument('nifti', nargs='+',
                   help='NIfTI stat map(s). Pass several for a multi-overlay figure (each map '
                        'is one overlay, with its own colormap/colorbar). With --spec, the i-th '
                        'map fills the i-th overlay slot (style.overlays[i]).')
    r.add_argument('-o', '--out', required=True, help='output PNG path')
    r.add_argument('--grid', default='2x4', help='grid as RxC, e.g. 2x2')
    r.add_argument('--views',
                   default='left_lateral,right_lateral,left_medial,right_medial,anterior,dorsal,subcortical_l,subcortical_r',
                   help="comma-separated views, row-major. e.g. left_lateral,right_lateral,axial,frontal. "
                        "'_' = blank cell. Aliases: axial=dorsal, frontal=anterior, etc.")
    r.add_argument('--spec', default=None,
                   help="path to a Free-Canvas figure JSON (the canvas document, as emitted by the "
                        "browser's Copy CLI). When given, it supplies the layout and overrides --grid/--views.")
    # Per-overlay flags accept a scalar (all maps) OR a comma list (one value per overlay).
    r.add_argument('--threshold', default='2.3', help='voxel threshold; scalar or per-overlay comma list, e.g. 2.3,4.0')
    r.add_argument('-k', '--cluster-size', default='105',
                   help='cluster-extent threshold (voxels); scalar or per-overlay comma list')
    r.add_argument('--cmap', default='YlGnBu', help="colormap name(s), or 'auto'; scalar or per-overlay comma list, e.g. Reds,YlGnBu")
    r.add_argument('--colormap-mode', default=None, help='auto|sequential|diverging; scalar or per-overlay comma list')
    r.add_argument('--clim', default=None, help="colour limit 'VMIN,VMAX' (or ',VMAX'); pins the colour scale")
    r.add_argument('--units', default=None, help="display units, e.g. 'value=z,cluster=mm3'")
    r.add_argument('--names', default=None, help='per-overlay colorbar labels, comma-separated')
    r.add_argument('--style', default=None, help='path to a saved style-preset JSON (deep-merged under the flags)')
    r.add_argument('--overlay-json', action='append', default=None,
                   help='per-overlay style JSON (repeatable; the i-th binds overlay i) — the lossless escape hatch')
    r.add_argument('--width', type=int, default=None, help='output width px (default 1600, or the --spec canvas width)')
    r.add_argument('--height', type=int, default=None, help='output height px (default 1000, or the --spec canvas height)')
    r.add_argument('--scale', type=float, default=2, help='pixel ratio / supersampling (DPI)')
    r.add_argument('--no-subcortical', action='store_true')
    r.add_argument('--no-template', action='store_true',
                   help='no-template / volume-only: mesh the volume in its own space with no '
                        'anatomical shell or classification (for non-MNI / edge-case maps)')
    # style overrides (unset = use viewer defaults)
    r.add_argument('--surface', choices=['inflated', 'pial'], default=None)
    r.add_argument('--voxels', default=None, help='blocky|smooth|surface; scalar or per-overlay comma list')
    r.add_argument('--smooth', type=int, default=None,
                   help='extra surface smoothing of the smooth (0.5mm-grid) mesh: Taubin iterations (0 = off)')
    r.add_argument('--gamma', default=None, help='colormap gamma; scalar or per-overlay comma list')
    r.add_argument('--veil', type=float, default=None)
    r.add_argument('--veil-k', type=float, default=None)
    r.add_argument('--emissive', type=float, default=None)
    r.add_argument('--specular', type=float, default=None)
    r.add_argument('--shininess', type=float, default=None)
    r.add_argument('--directional', type=float, default=None)
    r.add_argument('--ambient', type=float, default=None)
    r.add_argument('--cortex-alpha', type=float, default=None)
    r.add_argument('--edge-thr', type=float, default=None)
    r.add_argument('--line-w', type=float, default=None)
    r.add_argument('--voxel-edge-w', type=float, default=None)
    r.add_argument('--positive-only', action='store_true')
    r.add_argument('--no-edges', action='store_true')
    r.add_argument('--no-outline', action='store_true')
    r.add_argument('--shadows', action=argparse.BooleanOptionalAction, default=None,
                   help='inter-voxel shadows (clusters cast onto each other); off by default')
    r.add_argument('--colorbar', action=argparse.BooleanOptionalAction, default=True,
                   help='also write the colorbar legend as a separate <out>_colorbars.png '
                        '(the brain PNG is always clean + full-size; --no-colorbar skips the legend)')
    r.add_argument('--colorbar-font', default=None,
                   help="colorbar tick font-family (default Computer Modern roman)")
    r.add_argument('--colorbar-fontsize', type=float, default=None, help='colorbar tick font size (px)')
    r.add_argument('--margin', type=float, default=None,
                   help='framing tightness; <1 packs brains closer (1.0 = no padding, default)')
    r.add_argument('--bg-alpha', type=float, default=None,
                   help='canvas background opacity 0..1; <1 writes a TRANSPARENT PNG (Free Canvas). '
                        'Defaults to the spec canvas.bgAlpha, or 1 (opaque).')
    r.add_argument('--crop', choices=['none', 'content'], default='none',
                   help="'content' crops the PNG to the tight bounding box of the visible brains "
                        "(matches the browser's Save PNG / Copy CLI). Default 'none' = full figure.")

    args = parser.parse_args()

    if args.command in ('open', 'show'):
        if args.nifti:
            print("Note: NIfTIs are uploaded in the browser now (processed locally via Pyodide). "
                  "Drag them in once the page opens.")
        open_viewer(port=args.port)

    elif args.command == 'bake':
        from . import bake
        bake.bake()

    elif args.command == 'render':
        from .render import build_layout, render_to_png, load_spec, _deep_merge, to_volume_layout
        from .figure import build_style

        n = len(args.nifti)
        names = [s.strip() for s in args.names.split(',')] if args.names else None

        if args.spec:
            # --spec is self-contained (layout + style + size): reproduce it verbatim.
            # CLI style flags are ignored here; --width/--height/--bg-alpha still override.
            layout, style, spec_render = load_spec(args.spec)
            cmap = style.get('colormap', args.cmap)
            width = args.width if args.width is not None else spec_render.get('width', 1600)
            height = args.height if args.height is not None else spec_render.get('height', 1000)
            # Per-overlay BAKE threshold = that overlay's live threshold, so baked == shown
            # (style.overlays[i].threshold -> global style.threshold -> --threshold).
            ov = style.get('overlays') or []
            thresholds = [
                (ov[i]['threshold'] if i < len(ov) and ov[i].get('threshold') is not None
                 else style['threshold'] if style.get('threshold') is not None
                 else float(args.threshold))
                for i in range(n)
            ]
        else:
            layout = build_layout(args.grid, [v for v in args.views.split(',')])
            # Per-overlay style from comma-list flags (scalar broadcasts), over an optional preset.
            base = {}
            if args.style:
                loaded = json.loads(Path(args.style).read_text())
                base = loaded.get('style', loaded)
            style, thresholds = build_style(
                n, base=base,
                cmap=_los(args.cmap, str), colormapMode=_los(args.colormap_mode, str),
                gamma=_los(args.gamma, float), clim=_parse_clim(args.clim),
                threshold=_los(args.threshold, float), clusterMin=_los(args.cluster_size, int),
                positiveOnly=(True if args.positive_only else None),
                voxels=_los(args.voxels, str), units=_parse_units(args.units),
            )

            # Remaining GLOBAL style flags (build_style handled the per-overlay ones above).
            def setp(path, val):
                if val is None:
                    return
                d = style
                keys = path.split('.')
                for k in keys[:-1]:
                    d = d.setdefault(k, {})
                d[keys[-1]] = val

            setp('cortexSurface', args.surface)
            setp('voxel.smoothing', args.smooth)
            setp('margin', args.margin)
            setp('shadows.enabled', args.shadows)
            setp('voxel.veil.strength', args.veil)
            setp('voxel.veil.k', args.veil_k)
            setp('voxel.emissive', args.emissive)
            setp('voxel.specular', args.specular)
            setp('voxel.shininess', args.shininess)
            setp('lighting.directional', args.directional)
            setp('lighting.ambient', args.ambient)
            setp('glass.maxOpacity', args.cortex_alpha)
            setp('outline.threshold', args.edge_thr)
            setp('outline.width', args.line_w)
            setp('voxel.edges.width', args.voxel_edge_w)
            if args.no_edges:
                setp('voxel.edges.enabled', False)
            if args.no_outline:
                setp('outline.enabled', False)
            # --overlay-json: lossless per-overlay escape hatch (the i-th binds overlay i).
            if args.overlay_json:
                ovl = style.setdefault('overlays', [])
                for i, oj in enumerate(args.overlay_json):
                    while len(ovl) <= i:
                        ovl.append({})
                    ovl[i] = _deep_merge(ovl[i], json.loads(oj))
            # Several maps without explicit per-overlay colormaps: distinct default palette.
            if n > 1:
                ovl = style.setdefault('overlays', [])
                while len(ovl) < n:
                    ovl.append({})
                if not any((o or {}).get('colormap') for o in ovl):
                    palette = ['YlGnBu', 'Reds', 'Greens', 'Purples', 'Oranges', 'Blues', 'YlOrRd', 'BuPu']
                    for i in range(n):
                        ovl[i]['colormap'] = palette[i % len(palette)]
            # Global colormap for render_to_png: the scalar --cmap, or 'auto' when per-overlay
            # colormaps drive each map (so the global doesn't override them).
            cmap = args.cmap if ',' not in str(args.cmap) else 'auto'
            width = args.width if args.width is not None else 1600
            height = args.height if args.height is not None else 1000
            if args.no_template:
                layout = to_volume_layout(layout)   # volume-only: voxel role, no hemisphere split

        # Transparent background: explicit --bg-alpha wins; else the spec's canvas.bgAlpha; else opaque.
        bg_alpha = args.bg_alpha
        if bg_alpha is None:
            bg_alpha = (layout.get('canvas') or {}).get('bgAlpha', 1.0)

        render_to_png(args.nifti, args.out, layout=layout, style=style,
                      threshold=thresholds, cmap=cmap, names=names,
                      width=width, height=height, scale=args.scale,
                      include_subcortical=not args.no_subcortical, classify=not args.no_template,
                      background_alpha=bg_alpha, crop=args.crop,
                      colorbar=args.colorbar, colorbar_font=args.colorbar_font,
                      colorbar_fontsize=args.colorbar_fontsize)

    else:
        parser.print_help()


if __name__ == "__main__":
    cli()
