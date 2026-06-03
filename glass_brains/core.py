"""GlassBrain — loads the fsaverage template (cortex + subcortical + aseg) for the
one-time asset bake (see glass_brains/bake.py). Per-upload meshing lives in
glass_brains/pipeline.py; the interactive viewer is served by `open_viewer`."""

import numpy as np
from pathlib import Path

from .surfaces import load_template_surfaces
from .subcortical import extract_all_subcortical, LABEL_COLORS

WEB_DIR = Path(__file__).parent / 'web'   # the single static viewer (served by `open`)


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
    def __init__(self, template='fsaverage', space='MNI152',
                 include_subcortical=True, layout='ninePanel',
                 display_cmap='YlGnBu', colormap_names=None, cluster_min=105):
        self.template = template
        self.space = space
        self.layout = layout              # viewer preset: 'fourPanel' | 'ninePanel'
        self._display_cmap = display_cmap  # 'auto' lets the viewer pick seq/div
        self._colormap_names = colormap_names  # None = curated set; 'all' = full catalog
        self._cluster_min = cluster_min   # initial cluster-extent threshold (voxels)
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
    r.add_argument('nifti', help='NIfTI stat map')
    r.add_argument('-o', '--out', required=True, help='output PNG path')
    r.add_argument('--grid', default='2x4', help='grid as RxC, e.g. 2x2')
    r.add_argument('--views',
                   default='left_lateral,right_lateral,left_medial,right_medial,anterior,dorsal,subcortical_l,subcortical_r',
                   help="comma-separated views, row-major. e.g. left_lateral,right_lateral,axial,frontal. "
                        "'_' = blank cell. Aliases: axial=dorsal, frontal=anterior, etc.")
    r.add_argument('--threshold', type=float, default=2.3)
    r.add_argument('-k', '--cluster-size', type=int, default=105,
                   help='cluster-extent threshold: drop clusters smaller than this many voxels')
    r.add_argument('--cmap', default='YlGnBu', help="colormap name, or 'auto' (seq/div from data)")
    r.add_argument('--colormap-mode', choices=['auto', 'sequential', 'diverging'], default=None)
    r.add_argument('--width', type=int, default=1600)
    r.add_argument('--height', type=int, default=1000)
    r.add_argument('--scale', type=float, default=2, help='pixel ratio / supersampling (DPI)')
    r.add_argument('--no-subcortical', action='store_true')
    # style overrides (unset = use viewer defaults)
    r.add_argument('--surface', choices=['inflated', 'pial'], default=None)
    r.add_argument('--voxels', choices=['blocky', 'smooth'], default=None)
    r.add_argument('--smooth', type=int, default=None,
                   help='extra surface smoothing of the smooth (0.5mm-grid) mesh: Taubin iterations (0 = off)')
    r.add_argument('--gamma', type=float, default=None)
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
        from .render import build_layout, render_to_png

        layout = build_layout(args.grid, [v for v in args.views.split(',')])

        style = {}
        def setp(path, val):
            if val is None:
                return
            d = style
            keys = path.split('.')
            for k in keys[:-1]:
                d = d.setdefault(k, {})
            d[keys[-1]] = val

        setp('cortexSurface', args.surface)
        setp('voxel.representation', args.voxels)
        setp('voxel.clusterMin', args.cluster_size)
        setp('voxel.smoothing', args.smooth)
        setp('margin', args.margin)
        setp('shadows.enabled', args.shadows)
        setp('colormapMode', args.colormap_mode)
        setp('gamma', args.gamma)
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
        if args.positive_only:
            setp('positiveOnly', True)
        if args.no_edges:
            setp('voxel.edges.enabled', False)
        if args.no_outline:
            setp('outline.enabled', False)

        render_to_png(args.nifti, args.out, layout=layout, style=style,
                      threshold=args.threshold, cmap=args.cmap,
                      width=args.width, height=args.height, scale=args.scale,
                      include_subcortical=not args.no_subcortical,
                      colorbar=args.colorbar, colorbar_font=args.colorbar_font,
                      colorbar_fontsize=args.colorbar_fontsize)

    else:
        parser.print_help()
