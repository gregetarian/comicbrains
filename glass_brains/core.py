"""GlassBrain — public API for building and viewing glass brain visualisations."""

import shutil
import json
import numpy as np
from pathlib import Path

from .surfaces import load_template_surfaces
from .subcortical import extract_all_subcortical, LABEL_COLORS
from .overlays import (load_stat_map, classify_overlay_voxels,
                       build_structure_overlays, prepare_volume_texture,
                       cluster_sizes)
from .export import export_mesh, export_mesh_with_scalars, export_volume, write_scene_json
from .server import serve_and_open

VIEWER_DIR = Path(__file__).parent / 'viewer'


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
        self.overlays = []

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

    def add_overlay(self, nifti_path, threshold=2.3, cmap='coolwarm',
                    name=None, method='isosurface'):
        nifti_path = Path(nifti_path)
        if name is None:
            name = nifti_path.stem.replace('.nii', '')

        data, affine = load_stat_map(nifti_path, threshold)
        # Per-voxel cluster size (at this threshold) → baked as a vertex attribute
        # for the live cluster-extent filter.
        cluster_data = cluster_sizes(data)

        # Classify voxels by brain structure using aseg
        structure_overlays = {}
        max_abs = 1.0
        diverging = False

        if self._aseg_data is not None:
            category_masks = classify_overlay_voxels(
                data, affine, self._aseg_data, self._aseg_affine
            )
            print(f"Overlay '{name}': {len(category_masks)} structure categories")
            structure_overlays, max_abs, diverging = build_structure_overlays(
                data, affine, category_masks, cmap_name=cmap, cluster_data=cluster_data
            )

        volume_info = None
        if method in ('volume', 'both'):
            volume_info = prepare_volume_texture(data, affine)

        self.overlays.append({
            'name': name,
            'threshold': threshold,
            'cmap': cmap,
            'max_abs_value': max_abs,
            'diverging': diverging,
            'max_cluster': int(cluster_data.max()) if cluster_data.size else 0,
            'structure_overlays': structure_overlays,
            'volume_info': volume_info,
        })

    def export(self, out_dir='./glass_brain_viewer'):
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        # Copy viewer files
        if VIEWER_DIR.exists():
            for item in VIEWER_DIR.iterdir():
                dest = out_dir / item.name
                if item.is_dir():
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(item, dest)
                else:
                    shutil.copy2(item, dest)

        # Export cortex meshes (pial + a slightly-inflated Taubin-smoothed variant)
        from .surfaces import inflate_surfaces
        inflated = inflate_surfaces(self.surfaces)
        cortex_paths = {}
        for hemi, mesh in self.surfaces.items():
            rel_path = f'cortex_{hemi}.glb'
            export_mesh_with_scalars(mesh, out_dir / rel_path, scalar_name='curvature')
            infl_rel = f'cortex_{hemi}_inflated.glb'
            export_mesh_with_scalars(inflated[hemi], out_dir / infl_rel, scalar_name='curvature')
            cortex_paths[hemi] = {'mesh': rel_path, 'meshInflated': infl_rel}

        # Export subcortical meshes
        subcort_paths = {}
        for name, mesh in self.subcortical.items():
            safe_name = name.lower().replace('-', '_').replace(' ', '_')
            rel_path = f'subcortical/{safe_name}.glb'
            color = self.subcortical_colors.get(name, (0.6, 0.6, 0.6))
            n = len(mesh.vertices)
            vc = (np.array([*color, 1.0]) * 255).astype(np.uint8)
            vertex_colors = np.tile(vc, (n, 1))
            export_mesh(mesh, out_dir / rel_path, vertex_colors=vertex_colors)
            subcort_paths[name] = rel_path

        # Export overlays — per-structure voxel meshes
        overlay_entries = []
        for ov in self.overlays:
            entry = {
                'name': ov['name'],
                'colormap': ov['cmap'],
                'threshold': ov['threshold'],
                'maxAbsValue': ov['max_abs_value'],
                'maxClusterSize': ov.get('max_cluster', 0),
                'diverging': bool(ov['diverging']),
                'role': 'overlay',
                'structureOverlays': {},
            }

            overlay_dir = out_dir / 'overlay'
            overlay_dir.mkdir(parents=True, exist_ok=True)

            for cat, so in ov['structure_overlays'].items():
                mesh_rel = f"overlay/{ov['name']}_{cat}.glb"
                vals_rel = f"overlay/{ov['name']}_{cat}_values.json"
                clu_rel = f"overlay/{ov['name']}_{cat}_clusters.json"

                export_mesh(so['mesh'], out_dir / mesh_rel)
                with open(out_dir / vals_rel, 'w') as f:
                    json.dump(so['values'], f)
                with open(out_dir / clu_rel, 'w') as f:
                    json.dump(so['clusters'], f)

                cat_entry = {'mesh': mesh_rel, 'values': vals_rel, 'clusters': clu_rel}

                if 'mesh_smooth' in so:
                    smesh_rel = f"overlay/{ov['name']}_{cat}_smooth.glb"
                    svals_rel = f"overlay/{ov['name']}_{cat}_smooth_values.json"
                    sclu_rel = f"overlay/{ov['name']}_{cat}_smooth_clusters.json"
                    export_mesh(so['mesh_smooth'], out_dir / smesh_rel)
                    with open(out_dir / svals_rel, 'w') as f:
                        json.dump(so['values_smooth'], f)
                    with open(out_dir / sclu_rel, 'w') as f:
                        json.dump(so['clusters_smooth'], f)
                    cat_entry['meshSmooth'] = smesh_rel
                    cat_entry['valuesSmooth'] = svals_rel
                    cat_entry['clustersSmooth'] = sclu_rel

                entry['structureOverlays'][cat] = cat_entry

            if ov['volume_info'] is not None:
                bin_rel = f"volumes/{ov['name']}.bin"
                json_rel = f"volumes/{ov['name']}.json"
                export_volume(ov['volume_info'], out_dir / bin_rel, out_dir / json_rel)
                entry['volume'] = bin_rel
                entry['volume_meta'] = json_rel

            overlay_entries.append(entry)

        write_scene_json(
            out_dir,
            cortex_meshes=cortex_paths,
            subcortical_meshes=subcort_paths,
            subcortical_colors=self.subcortical_colors,
            overlays=overlay_entries if overlay_entries else None,
        )

        # Colormap LUTs for the viewer (JS holds no hardcoded colormaps).
        from .colormaps import export_colormaps
        export_colormaps(out_dir / 'colormaps.json', names=self._colormap_names)

        # Render config: preset + style. colormap='auto' lets the viewer pick a
        # sequential vs diverging map from the data (fixes coolwarm-on-positive).
        ov = self.overlays[0] if self.overlays else None
        render_config = {
            'preset': self.layout,
            'style': {
                'colormap': self._display_cmap,
                'threshold': ov['threshold'] if ov else None,
            },
        }
        if self._cluster_min:
            render_config['style']['voxel'] = {'clusterMin': self._cluster_min}
        with open(out_dir / 'render-config.json', 'w') as f:
            json.dump(render_config, f, indent=2)

        print(f"Exported to {out_dir.resolve()}")
        return out_dir

    def show(self, port=8421):
        import tempfile
        out_dir = Path(tempfile.mkdtemp(prefix='glass_brain_'))
        self.export(out_dir)
        serve_and_open(out_dir, port, glass_brain=self)

    def _repr_html_(self):
        return "<p><b>GlassBrain</b>: call <code>.show()</code> to open in browser.</p>"


def cli():
    import argparse
    parser = argparse.ArgumentParser(description='Glass Brains 2.0 viewer')
    sub = parser.add_subparsers(dest='command')

    show_parser = sub.add_parser('show', help='Open the interactive glass brain viewer')
    show_parser.add_argument('nifti', nargs='*', help='one or more NIfTI stat maps (one overlay row each; first = top)')
    show_parser.add_argument('--threshold', type=float, default=2.3)
    show_parser.add_argument('-k', '--cluster-size', type=int, default=105,
                             help='initial cluster-extent threshold in voxels (adjustable live)')
    show_parser.add_argument('--cmap', default='YlGnBu')
    show_parser.add_argument('--layout', default='ninePanel', help='fourPanel | ninePanel | overview')
    show_parser.add_argument('--port', type=int, default=8421)
    show_parser.add_argument('--no-subcortical', action='store_true')

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

    if args.command == 'show':
        gb = GlassBrain(include_subcortical=not args.no_subcortical,
                        layout=args.layout, display_cmap=args.cmap,
                        cluster_min=args.cluster_size)
        for nif in (args.nifti or []):
            gb.add_overlay(nif, threshold=args.threshold,
                           cmap=(args.cmap if args.cmap != 'auto' else 'viridis'))
        gb.show(port=args.port)

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
