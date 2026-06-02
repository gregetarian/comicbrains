"""Export meshes to glTF/GLB and write scene.json manifest."""

import json
import struct
import numpy as np
import trimesh
from pathlib import Path


def export_mesh(mesh, path, vertex_colors=None):
    """Export a trimesh to GLB format.

    Parameters
    ----------
    mesh : trimesh.Trimesh
    path : str or Path
        Output .glb path.
    vertex_colors : ndarray, optional
        Per-vertex RGBA colours, shape (n, 4), values 0-255.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if vertex_colors is not None:
        mesh.visual = trimesh.visual.ColorVisuals(
            mesh=mesh,
            vertex_colors=vertex_colors,
        )

    mesh.export(str(path), file_type='glb')


def export_mesh_with_scalars(mesh, path, scalar_name='curvature'):
    """Export mesh to GLB with a scalar vertex attribute encoded as vertex colours.

    Since standard glTF doesn't support arbitrary vertex attributes easily,
    we encode the scalar in the red channel of vertex colours. The shader
    can then read it from the colour attribute.

    Parameters
    ----------
    mesh : trimesh.Trimesh
        Must have vertex_attributes[scalar_name].
    path : str or Path
    scalar_name : str
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    scalars = mesh.vertex_attributes.get(scalar_name)
    if scalars is not None:
        # Normalise scalars to [0, 255] for vertex colour encoding
        # Map curvature: negative (sulci) → 0, positive (gyri) → 255
        s = np.asarray(scalars, dtype=np.float32)
        smin, smax = s.min(), s.max()
        if smax - smin > 0:
            normed = (s - smin) / (smax - smin)
        else:
            normed = np.zeros_like(s)

        # Encode in vertex colours: R = normalised scalar, G = B = 128, A = 255
        n = len(scalars)
        colors = np.zeros((n, 4), dtype=np.uint8)
        colors[:, 0] = (normed * 255).astype(np.uint8)
        colors[:, 1] = 128
        colors[:, 2] = 128
        colors[:, 3] = 255

        mesh.visual = trimesh.visual.ColorVisuals(mesh=mesh, vertex_colors=colors)

    mesh.export(str(path), file_type='glb')


def export_volume(volume_info, bin_path, json_path):
    """Write volume data as raw float32 binary + JSON sidecar.

    Parameters
    ----------
    volume_info : dict
        From overlays.prepare_volume_texture.
    bin_path : str or Path
    json_path : str or Path
    """
    bin_path = Path(bin_path)
    json_path = Path(json_path)
    bin_path.parent.mkdir(parents=True, exist_ok=True)

    # Write raw float32 binary (C-order)
    data = volume_info['data'].flatten(order='C')
    with open(bin_path, 'wb') as f:
        f.write(data.tobytes())

    # Write JSON sidecar
    meta = {
        'dims': volume_info['dims'],
        'affine': volume_info['affine'],
        'clim': volume_info['clim'],
        'dtype': 'float32',
        'order': 'C',
    }
    with open(json_path, 'w') as f:
        json.dump(meta, f, indent=2)


def write_scene_json(out_dir, cortex_meshes=None, subcortical_meshes=None,
                     subcortical_colors=None, overlays=None):
    """Write the scene.json manifest that the Three.js viewer reads.

    Parameters
    ----------
    out_dir : str or Path
    cortex_meshes : dict, optional
        Keys 'lh', 'rh' → relative .glb paths.
    subcortical_meshes : dict, optional
        Structure name → relative .glb path.
    subcortical_colors : dict, optional
        Structure name → (r, g, b) tuple.
    overlays : list[dict], optional
        Each with 'name', 'clusters' (list of .glb paths), 'colormap',
        'threshold', optionally 'volume' and 'volume_meta'.
    """
    out_dir = Path(out_dir)

    scene = {
        'version': '2.0',
        'space': 'MNI152',
    }

    if cortex_meshes:
        scene['cortex'] = {}
        for hemi, info in cortex_meshes.items():
            if isinstance(info, dict):
                scene['cortex'][hemi] = {'role': 'glass', **info}
            else:
                scene['cortex'][hemi] = {'mesh': str(info), 'role': 'glass'}

    if subcortical_meshes:
        scene['subcortical'] = {}
        for name, mesh_path in subcortical_meshes.items():
            entry = {
                'mesh': str(mesh_path),
                'role': 'interior',
            }
            if subcortical_colors and name in subcortical_colors:
                entry['color'] = list(subcortical_colors[name])
            scene['subcortical'][name] = entry

    if overlays:
        scene['overlays'] = overlays

    with open(out_dir / 'scene.json', 'w') as f:
        json.dump(scene, f, indent=2)
