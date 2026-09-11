"""Comic — loads the fsaverage template (cortex + subcortical + aseg) for the
one-time asset bake (see comic/bake.py). Per-upload meshing lives in
comic/pipeline.py; the interactive viewer is served by `open_viewer`."""

import json
import numpy as np
from pathlib import Path

# NOTE: surfaces/subcortical (which import trimesh + mne) are imported LAZILY inside Comic
# so `import comic` and the [render]/notebook paths do NOT require the [bake] extra.

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


def _explicit_options(parser, argv):
    """Track supplied options, including values equal to defaults and --flag=value."""
    supplied = set()
    for token in argv:
        if token == '--':
            break
        if token.startswith('-'):
            parsed = parser._parse_optional(token)
            if isinstance(parsed, list):  # argparse 3.12+ returns candidate tuples
                parsed = parsed[0] if parsed else None
            if parsed and parsed[0] is not None:
                supplied.add(parsed[0].dest)
    return supplied


def _override_recipe_style(style, args, supplied, n):
    from .figure import build_style
    from .render import _deep_merge
    if 'style' in supplied:
        loaded = json.loads(Path(args.style).read_text())
        style = _deep_merge(style, loaded.get('style', loaded))
    def value(key, cast=None):
        v = getattr(args, key) if key in supplied else None
        return _los(v, cast) if cast else v
    style, _ = build_style(n, base=style, cmap=value('cmap', str), colormapMode=value('colormap_mode', str),
                          gamma=value('gamma', float), clim=_parse_clim(value('clim')),
                          threshold=value('threshold', float), clusterMin=value('cluster_size', int),
                          positiveOnly=value('positive_only'), voxels=value('voxels', str),
                          units=_parse_units(value('units')))
    paths = {
        'surface': 'cortexSurface', 'smooth': 'voxel.smoothing', 'margin': 'margin',
        'shadows': 'shadows.enabled', 'veil': 'voxel.veil.strength', 'veil_k': 'voxel.veil.k',
        'emissive': 'voxel.emissive', 'specular': 'voxel.specular', 'shininess': 'voxel.shininess',
        'directional': 'lighting.directional', 'ambient': 'lighting.ambient',
        'cortex_alpha': 'glass.maxOpacity', 'edge_thr': 'outline.threshold', 'line_w': 'outline.width',
        'lines_over_voxels': 'outline.overVoxels', 'over_voxel_opacity': 'outline.overVoxelOpacity',
        'voxel_edge_w': 'voxel.edges.width', 'voxel_alpha': 'voxel.opacity',
        'voxel_edge_alpha': 'voxel.edges.opacity', 'line_color': 'outline.color',
        'anat_line_color': 'outline.anatomyColor', 'voxel_edge_color': 'voxel.edges.color',
        'surface_base': 'voxel.surfaceBase', 'silhouette_color': 'outline.silhouette.color',
        'silhouette_w': 'outline.silhouette.width', 'border_color': 'parcellation.color',
        'border_w': 'parcellation.width', 'mask_color': 'parcellation.maskColor',
        'edge_mode': 'voxel.edges.mode', 'depth_mode': 'voxel.depthMode',
        'subcortex_voxels': 'voxel.subcortexRepresentation',
        'cut_slab': 'cutOverlay.slabMm', 'cut_interpolation': 'cutOverlay.interpolation',
    }
    def setp(path, val):
        d = style
        keys = path.split('.')
        for key in keys[:-1]:
            d = d.setdefault(key, {})
        d[keys[-1]] = val
        # Explicit global display flags broadcast over saved per-overlay overrides.
        if keys[0] in ('voxel', 'cutOverlay'):
            for o in style.get('overlays') or []:
                d = o
                for key in keys[:-1]:
                    d = d.get(key, {})
                d.pop(keys[-1], None)
    for flag, path in paths.items():
        if flag in supplied:
            setp(path, getattr(args, flag))
    for flag, path, val in [('no_edges', 'voxel.edges.enabled', False), ('no_outline', 'outline.enabled', False),
                            ('slice_anatomy', 'sliceAnatomy', True), ('mask_medial_wall', 'parcellation.maskMedialWall', True)]:
        if flag in supplied:
            setp(path, val)
    if args.borders and 'borders' in supplied:
        setp('parcellation.enabled', True)
        setp('parcellation.atlas', args.borders)
    if 'mask_medial_wall' in supplied and not (style.get('parcellation') or {}).get('atlas'):
        if not args.parcel_atlas:
            raise ValueError('--mask-medial-wall needs an atlas in the recipe, --borders or --parcel-atlas')
        setp('parcellation.atlas', args.parcel_atlas)
    if args.cut_overlay:
        setp('sliceAnatomy', True)
        setp('cutOverlay.enabled', True)
    for i, patch in enumerate(args.overlay_json or []):
        if i >= n:
            raise ValueError('--overlay-json has more entries than inputs')
        style['overlays'][i] = _deep_merge(style['overlays'][i], json.loads(patch))
    return style


def open_viewer(port=8421):
    """Serve the static viewer locally and open it in the browser. Uploads are processed
    in-browser via Pyodide — identical to the GitHub Pages site; no Python backend."""
    import http.server
    import threading
    import webbrowser

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(WEB_DIR), **k)

        def end_headers(self):   # never serve a stale asset after a re-bake / code edit
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            super().end_headers()

    handler = Handler
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


class Comic:
    """Loads the fsaverage template (cortex + subcortical + aseg) for the one-time asset bake.
    Display config (colormap, layout, cluster threshold) lives in the viewer
    (config-schema.js / render-config.json), not here."""
    def __init__(self, template='fsaverage', space='MNI152', include_subcortical=True):
        from .surfaces import load_template_surfaces            # lazy: needs the [bake] extra
        from .subcortical import extract_all_subcortical, LABEL_COLORS
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
        return "<p><b>Comic</b>: bakes the fsaverage template. Run <code>comic open</code> to view.</p>"


def cli(argv=None):
    import argparse
    import sys
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description='Comic neuroimaging figure composer')
    sub = parser.add_subparsers(dest='command')

    op = sub.add_parser('open', aliases=['show'],
                        help='Serve the interactive viewer locally; upload NIfTIs in the browser (Pyodide, no backend)')
    op.add_argument('nifti', nargs='*', help='(accepted for convenience but not loaded server-side; '
                                             'drag NIfTIs into the browser — processing is in-browser now)')
    op.add_argument('--port', type=int, default=8421)

    bk = sub.add_parser('bake', help='Bake template assets: the bundled fsaverage by default, OR a '
                                     'CUSTOM template with --out + --surfaces (needs the [bake] extra)')
    bk.add_argument('--out', default=None, help='custom template output dir (omit = re-bake bundled fsaverage)')
    bk.add_argument('--surfaces', default=None, help='lh=lh.pial,rh=rh.pial (FreeSurfer/.gii/.glb)')
    bk.add_argument('--inflated', default=None, help='lh=...,rh=... inflated surfaces (optional)')
    bk.add_argument('--aseg', default=None, help='label-volume NIfTI for voxel classification (optional)')
    bk.add_argument('--aseg-labels', default=None, help='JSON map {label_id: category} for the aseg')
    bk.add_argument('--space', default='custom', help='template space label (informational)')

    pc = sub.add_parser('parcels', help='List or bake cortical parcellations for --borders')
    pc.add_argument('action', choices=['list', 'bake'], nargs='?', default='list')
    pc.add_argument('names', nargs='*', help='atlas names to bake (default: every shipped one)')

    r = sub.add_parser('render', help='Render a custom multi-panel figure to PNG (headless)')
    r.add_argument('nifti', nargs='*',
                   help='NIfTI stat map(s). Pass several for a multi-overlay figure (each map '
                        'is one overlay, with its own colormap/colorbar). With --spec, the i-th '
                        'map fills the i-th overlay slot (style.overlays[i]).')
    r.add_argument('--surface-map', action='append', default=None, metavar='lh=..,rh=..',
                   help='a NATIVE fsaverage SURFACE overlay (per-vertex .gii/.mgh/.mgz), drawn on '
                        'the cortex sheet with no blocky/smooth geometry. Format: '
                        "'lh=lh.gii,rh=rh.gii[,name=Label]' (either hemi optional). Repeat for "
                        'several surface overlays. Volume overlays (positional) come first.')
    r.add_argument('--input-json', action='append', metavar='JSON',
                   help='ordered volume/surface/parcel descriptor; repeat in overlay order. '
                        'Use type+path for volumes, type+lh/rh for surfaces, type+path+atlas for parcels. '
                        'Cannot be combined with positional inputs, --surface-map or --parcel-values.')
    r.add_argument('-o', '--out', required=True, help='output PNG path')
    r.add_argument('--grid', default='2x4', help='grid as RxC, e.g. 2x2')
    r.add_argument('--views',
                   default='left_lateral,right_lateral,left_medial,right_medial,anterior,dorsal,subcortical_l,subcortical_r',
                   help="comma-separated views, row-major. e.g. left_lateral,right_lateral,axial,frontal. "
                        "'_' = blank cell. Aliases: axial=dorsal, frontal=anterior, etc.")
    r.add_argument('--spec', default=None,
                   help="browser figure JSON. Supplies layout and saved settings; explicit style/output flags "
                        "override them. Change layout in the recipe rather than combining --grid/--views.")
    # Per-overlay flags accept a scalar (all maps) OR a comma list (one value per overlay).
    r.add_argument('--threshold', default='0', help='voxel threshold; scalar or per-overlay comma list, e.g. 2.3,4.0. '
                        'Default 0 = keep the map unthresholded')
    r.add_argument('--processing-threshold', default=None,
                   help='geometry loading cutoff; scalar or per-overlay list. By default preserve the '
                        'recipe loading cutoff, or use the display threshold for older recipes/new figures.')
    r.add_argument('-k', '--cluster-size', default='0',
                   help='cluster-extent threshold (voxels); scalar or per-overlay comma list. '
                        'Default 0 = do not hide small clusters')
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
    r.add_argument('--template', default=None,
                   help='render against a CUSTOM template dir (as produced by `comic bake '
                        '--out DIR ...`) instead of the bundled fsaverage')
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
    r.add_argument('--voxel-alpha', type=float, default=None,
                   help='blob translucency 0..1 (default 1 = opaque, self-occluding). Below 1 the '
                        'blobs stop writing depth so you can see through them, which gives up exact '
                        'front/back sorting where blobs overlap')
    r.add_argument('--voxel-edge-alpha', type=float, default=None,
                   help='blob outline (edge line) opacity 0..1')
    r.add_argument('--edge-mode', choices=['auto', 'outer', 'full'], default=None,
                   help='outer blob contours or full visible depth edges')
    r.add_argument('--depth-mode', choices=['manual', 'clusters', 'anatomy'], default=None)
    r.add_argument('--subcortex-voxels', choices=['blocky', 'smooth'], default=None)
    r.add_argument('--line-color', default=None, metavar='#RRGGBB',
                   help='colour of the cortical fold (sulcal/gyral) lines (default #000000)')
    r.add_argument('--anat-line-color', default=None, metavar='#RRGGBB',
                   help='colour of the subcortical structure lines (default: same as --line-color)')
    r.add_argument('--voxel-edge-color', default=None, metavar='#RRGGBB',
                   help='colour of the voxel/blob edge lines (default #808080)')
    r.add_argument('--silhouette-color', default=None, metavar='#RRGGBB',
                   help="colour of the brain's outer contour. Setting it (or --silhouette-w) splits "
                        'the contour off from the fold lines, so the folds can be lightened or '
                        'switched off (--no-outline) while the dark outline survives')
    r.add_argument('--silhouette-w', type=float, default=None,
                   help='thickness of the outer contour, independent of the fold-line width')
    r.add_argument('--borders', default=None, metavar='ATLAS',
                   help='draw parcellation boundary lines on the cortical surface, e.g. '
                        'schaefer400_7 / aparc / yeo7. `comic parcels list` shows what is baked')
    r.add_argument('--border-color', default=None, metavar='#RRGGBB',
                   help='parcel boundary colour (default #1a1a1a)')
    r.add_argument('--border-w', type=float, default=None,
                   help='parcel boundary thickness in screen pixels (default 2.0)')
    r.add_argument('--parcel-values', default=None, metavar='TABLE.csv',
                   help='a CSV/TSV of `region,value` (one row per parcel) painted flat onto the '
                        'cortical surface through the colormap. Needs --parcel-atlas (or --borders) '
                        'to say which parcellation the region names belong to. Implies borders on '
                        'that atlas and a display threshold of 0 unless you set --threshold')
    r.add_argument('--parcel-atlas', default=None, metavar='ATLAS',
                   help='atlas the --parcel-values region names index (default: whatever --borders uses)')
    r.add_argument('--mask-medial-wall', action='store_true',
                   help='hide surface vertices the atlas marks as non-cortex. Needs --borders (or '
                        '--parcel-atlas) to say which atlas defines the wall')
    r.add_argument('--mask-color', default=None, metavar='#RRGGBB',
                   help='colour of the masked medial wall (default: --surface-base, else #dcdcdc)')
    r.add_argument('--surface-base', default=None, metavar='#RRGGBB',
                   help='in surface mode, fill cortex BELOW threshold with this colour instead of '
                        'letting the glass shell show through. Makes the cortical sheet solid, so an '
                        'unpainted medial wall reads as grey surface rather than a window onto the far '
                        'side of the hemisphere. Defaults on (#cccccc) with --parcel-values')
    r.add_argument('--positive-only', action=argparse.BooleanOptionalAction, default=None)
    r.add_argument('--no-edges', action='store_true')
    r.add_argument('--no-outline', action='store_true')
    r.add_argument('--slice-anatomy', action='store_true',
                   help='on sliced panels (a --spec with per-panel slices), paint the anatomical T1 '
                        'cross-section (white/gray matter) on the cut face, like a coronal MRI')
    r.add_argument('--cut-overlay', action='store_true',
                   help='on sliced panels, composite thresholded statistical values over the T1 cut face')
    r.add_argument('--cut-slab', type=float, default=None,
                   help='cut-overlay max-absolute slab thickness in millimetres (default 1)')
    r.add_argument('--cut-interpolation', choices=['linear', 'nearest'], default=None,
                   help='statistical-grid sampling on the cut face (default linear)')
    r.add_argument('--lines-over-voxels', action=argparse.BooleanOptionalAction, default=None,
                   help='draw the black cortex outline ON TOP of the voxels instead of letting '
                        'opaque blobs mask the sulcal lines behind them')
    r.add_argument('--over-voxel-opacity', type=float, default=None,
                   help='with --lines-over-voxels: stroke strength where a line crosses a voxel '
                        '(0..1; 1 = full black on top, <1 = a muted/greyed line that blends with the blob)')
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
    r.add_argument('--orbit', type=float, default=None,
                   help='turntable animation: spin the brain this many DEGREES total across --frames '
                        '(writes <out>_NNN.png; with --gif assembles a GIF at <out>)')
    r.add_argument('--frames', type=int, default=24, help='number of orbit frames (with --orbit)')
    r.add_argument('--fps', type=int, default=12, help='GIF frames per second (with --orbit --gif)')
    r.add_argument('--gif', action='store_true', help='assemble the orbit frames into a GIF (needs imageio)')
    r.add_argument('--regions', default=None,
                   help='also write a per-region supra-threshold voxel-count CSV to this path')
    r.add_argument('--sweep', default=None,
                   help="small-multiples sweep of one map, e.g. 'cluster=50,100,200' or 'threshold=2.3,3.1,4'")
    r.add_argument('--colorbar-svg', action='store_true',
                   help='also write the colorbar legend as vector SVG (<out>_colorbars.svg)')

    args = parser.parse_args(argv)
    supplied = _explicit_options(r, argv[1:]) if args.command == 'render' else set()

    if args.command in ('open', 'show'):
        if args.nifti:
            print("Note: NIfTIs are uploaded in the browser now (processed locally via Pyodide). "
                  "Drag them in once the page opens.")
        open_viewer(port=args.port)

    elif args.command == 'bake':
        from . import bake
        if args.out:                       # custom template from BYO surfaces (M9)
            from .surfaces import load_surface_file
            import nibabel as nib
            kv = lambda s: dict(p.split('=', 1) for p in s.split(',')) if s else {}
            surfs = {h: load_surface_file(p) for h, p in kv(args.surfaces).items()}
            infl = {h: load_surface_file(p) for h, p in kv(args.inflated).items()} or None
            aseg = aseg_aff = labels = None
            if args.aseg:
                img = nib.load(args.aseg); aseg = np.asarray(img.dataobj); aseg_aff = img.affine
                if args.aseg_labels:
                    labels = {int(k): v for k, v in json.loads(Path(args.aseg_labels).read_text()).items()}
            bake.bake_template(args.out, surfs, inflated=infl, aseg=aseg, aseg_affine=aseg_aff,
                               labels=labels, space=args.space)
        else:
            bake.bake()

    elif args.command == 'parcels':
        from . import parcels as P
        out = WEB_DIR / 'data' / 'parcels'
        if args.action == 'bake':
            P.bake_parcellations(out, args.names or None)
        else:
            index_path = out / 'index.json'
            baked = json.loads(index_path.read_text())['atlases'] if index_path.exists() else {}
            print(f"{'atlas':16s} {'parcels':>8s}  {'baked':5s}  source / licence")
            for name, spec in P.ATLASES.items():
                info = baked.get(name)
                n = str(info['nparcels']) if info else '-'
                print(f"{name:16s} {n:>8s}  {'yes' if info else 'no':5s}  {spec['source']} — {spec['license']}")
            print("\nBake with:  comic parcels bake <name> [<name> ...]"
                  "\nAtlases marked 'no' are not redistributable, so they are fetched from your own"
                  "\nFreeSurfer/MNE fsaverage install on demand rather than shipped with Comic.")

    elif args.command == 'render':
        try:
            from .render import build_layout, render_to_png, load_spec, to_volume_layout
            from .inputs import input_descriptors, processing_thresholds, input_names, validate_input_types
            spec_doc = json.loads(Path(args.spec).read_text()) if args.spec else {}
            template = spec_doc.get('template') or {}
            if args.spec and {'grid', 'views'} & supplied:
                parser.error('--spec supplies the layout; edit its panels instead of combining --grid/--views')
            if not args.template and template.get('kind') == 'custom':
                args.template = template.get('dir')
                if not args.template:
                    parser.error('custom template recipe needs --template DIR')
            if template.get('kind') == 'none' and not args.template:
                args.no_template = True
            input_maps = None
            if args.input_json:
                if args.nifti or args.surface_map or args.parcel_values:
                    parser.error('--input-json cannot be combined with positional inputs, --surface-map or --parcel-values')
                try:
                    input_maps = input_descriptors(input_maps=[json.loads(s) for s in args.input_json])
                except (ValueError, TypeError) as exc:
                    parser.error(str(exc))
                if args.sweep is not None or args.orbit is not None:
                    parser.error('--input-json is not supported with --sweep/--orbit; use positional volumes')

            # Native surface overlays: 'lh=..,rh=..[,name=..]' each -> a dict. They render AFTER the
            # positional volume overlays, so overlay indices are [volumes..., surfaces...].
            surface_maps = []
            for spec in (args.surface_map or []):
                d = dict(kv.split('=', 1) for kv in spec.split(',') if '=' in kv)
                if 'lh' not in d and 'rh' not in d:
                    parser.error(f"--surface-map '{spec}' needs at least lh=<file> or rh=<file>")
                surface_maps.append(d)
            # --parcel-values: expand a per-region table into per-vertex maps and hand them to the
            # SAME native-surface path a .gii would take. The atlas doubles as the border source, so
            # `--parcel-values t.csv --parcel-atlas schaefer400_7` is the whole figure in one flag.
            if args.parcel_values:
                from . import parcels as P
                atlas = args.parcel_atlas or args.borders
                if not atlas:
                    parser.error('--parcel-values needs --parcel-atlas (or --borders) to name the parcellation')
                maps = P.values_to_vertex_maps(P.load_value_table(args.parcel_values), atlas,
                                               (Path(args.template) / 'data' if args.template else WEB_DIR / 'data') / 'parcels')
                surface_maps.append({'lh': maps['lh'], 'rh': maps['rh'],
                                     'name': Path(args.parcel_values).stem})
                args.borders = args.borders or atlas
                # An atlas figure wants a SOLID cortical sheet: without it the unpainted medial wall is
                # a hole in the geometry and the far side of the hemisphere shows through it.
                if args.surface_base is None:
                    args.surface_base = '#cccccc'
                # The medial wall and any parcel absent from the table are 0,
                # and a 0 threshold would paint them as the bottom of the colormap instead of leaving
                # the cortex showing through. An epsilon hides exact zeros and nothing else.
                if 'threshold' not in supplied:
                    args.threshold = '1e-9'

            if not args.nifti and not surface_maps and not input_maps:
                parser.error("render needs at least one NIfTI (positional) or a --surface-map")
            if surface_maps and (args.sweep is not None or args.orbit is not None):
                parser.error("--surface-map is not supported with --sweep/--orbit yet")

            descriptors = input_descriptors(args.nifti or None, surface_maps, input_maps)
            if args.parcel_values:
                descriptors[-1] = {'type': 'parcel', 'path': args.parcel_values, 'atlas': args.parcel_atlas or args.borders}
            n = len(descriptors)
            names = [s.strip() for s in args.names.split(',')] if args.names else None
            if names is not None and len(names) != n:
                parser.error(f'--names expects {n} labels; received {len(names)}')

            if args.spec:
                # Preserve saved processing state; only explicitly supplied flags override display state.
                layout, style, spec_render = load_spec(args.spec)
                from . import spec as gb_spec
                spec_doc = json.loads(Path(args.spec).read_text())
                try:
                    gb_spec.validate_input_count(spec_doc, n)
                    validate_input_types(spec_doc, descriptors)
                    style = _override_recipe_style(style, args, supplied, n)
                except ValueError as e:
                    parser.error(str(e))
                if args.slice_anatomy:
                    style['sliceAnatomy'] = True
                if args.cut_overlay:
                    style['sliceAnatomy'] = True
                    style.setdefault('cutOverlay', {})['enabled'] = True
                if args.cut_slab is not None:
                    style.setdefault('cutOverlay', {})['slabMm'] = args.cut_slab
                if args.cut_interpolation is not None:
                    style.setdefault('cutOverlay', {})['interpolation'] = args.cut_interpolation
                cmap = style.get('colormap', args.cmap)
                width = args.width if args.width is not None else spec_render.get('width', 1600)
                height = args.height if args.height is not None else spec_render.get('height', 1000)
                thresholds = processing_thresholds({**spec_doc, 'style': style}, n)
                names = names or input_names({**spec_doc, 'style': style}, n)
            else:
                layout = build_layout(args.grid, [v for v in args.views.split(',')])
                # Apply defaults, then a style file, then only explicitly supplied flags.
                # Share the same override rules as --spec so presets cannot be silently
                # overwritten by argparse defaults.
                base = {'colormap': 'YlGnBu', 'threshold': 0, 'voxel': {'clusterMin': 0}}
                if args.parcel_values:
                    base['threshold'] = 1e-9
                    base['voxel']['surfaceBase'] = '#cccccc'
                    base['parcellation'] = {'enabled': True, 'atlas': args.borders}
                style = _override_recipe_style(base, args, supplied, n)
                if n > 1 and 'cmap' not in supplied and not args.style:
                    overlays = style.setdefault('overlays', [{} for _ in range(n)])
                    if not any((o or {}).get('colormap') for o in overlays):
                        palette = ['YlGnBu', 'Reds', 'Greens', 'Purples', 'Oranges', 'Blues', 'YlOrRd', 'BuPu']
                        for i, overlay in enumerate(overlays):
                            overlay['colormap'] = palette[i % len(palette)]
                cmap = style.get('colormap', 'auto')
                width = args.width if args.width is not None else 1600
                height = args.height if args.height is not None else 1000
                if args.no_template:
                    layout = to_volume_layout(layout)   # volume-only: voxel role, no hemisphere split

                thresholds = processing_thresholds({'style': style}, n)

            if args.processing_threshold is not None:
                raw = _los(args.processing_threshold, float)
                raw = raw if isinstance(raw, list) else [raw] * n
                if len(raw) != n or any(x is None for x in raw):
                    parser.error(f'--processing-threshold expects a scalar or {n} values')
                thresholds = processing_thresholds({'inputs': [{'processingThreshold': t} for t in raw]}, n)
            if args.no_template:
                layout = to_volume_layout(layout)
            spec_render = spec_doc.get('render') or {}
            if 'scale' not in supplied:
                args.scale = spec_render.get('pixelRatio', args.scale)
            if 'colorbar' not in supplied:
                args.colorbar = spec_render.get('colorbar', args.colorbar)

            # Transparent background: explicit --bg-alpha wins; else the spec's canvas.bgAlpha; else opaque.
            bg_alpha = args.bg_alpha
            if bg_alpha is None:
                bg_alpha = (layout.get('canvas') or {}).get('bgAlpha', 1.0)

            common = dict(layout=layout, style=style, threshold=thresholds, cmap=cmap, names=names,
                          template_dir=args.template, width=width, height=height, scale=args.scale,
                          include_subcortical=not args.no_subcortical, classify=not args.no_template,
                          background=spec_render.get('background', '#ffffff'), background_alpha=bg_alpha, crop=args.crop)
            if args.sweep is not None:                  # threshold/cluster sweep small-multiples (M10)
                from .render import render_sweep
                pname, vals = args.sweep.split('=', 1)
                cast = float if pname.strip() == 'threshold' else int
                render_sweep(args.nifti[0], args.out, param=pname.strip(),
                             values=[cast(x) for x in vals.split(',')], **common)
            elif args.orbit is not None:                # turntable animation (M10)
                from .render import render_orbit
                render_orbit(args.nifti, args.out, frames=args.frames, degrees=args.orbit,
                             fps=args.fps, gif=args.gif, **common)
            else:
                render_to_png(args.nifti, args.out, colorbar=args.colorbar,
                              colorbar_font=args.colorbar_font, colorbar_fontsize=args.colorbar_fontsize,
                              surface_maps=surface_maps, input_maps=input_maps, render_options=spec_render,
                              colorbar_svg=args.colorbar_svg, **common)

            if args.regions:                            # per-region voxel-count CSV (M10)
                import csv
                from .render import region_report
                with open(args.regions, 'w', newline='') as f:
                    w = csv.writer(f); w.writerow(['overlay', 'region', 'voxels'])
                    for i, item in enumerate(descriptors):
                        if item['type'] != 'volume':
                            continue
                        nif = item['path']
                        thr = thresholds[i] if isinstance(thresholds, list) else thresholds
                        for cat, n in region_report(nif, thr, template_dir=args.template).items():
                            w.writerow([Path(nif).name, cat, n])
                print('Wrote region report ->', args.regions)

            if args.colorbar_svg and (args.sweep is not None or args.orbit is not None):
                from .render import export_colorbar_svgs
                export_colorbar_svgs(args.out, input_maps=descriptors, style=style, thresholds=thresholds,
                                     template_dir=args.template, classify=not args.no_template)
        except (ValueError, FileNotFoundError) as exc:
            parser.error(str(exc))

    else:
        parser.print_help()


if __name__ == "__main__":
    cli()
