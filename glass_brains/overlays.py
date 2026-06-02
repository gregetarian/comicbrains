"""Statistical map processing: per-structure voxel meshes, colormaps, thresholding."""

import numpy as np
import nibabel as nib
import trimesh
from pathlib import Path
from scipy import ndimage
from skimage import measure
import cmap as cmaplib


# Aseg label → structure category mapping
ASEG_CATEGORIES = {
    # LH cortex + white matter
    3: 'lh_cortex', 2: 'lh_cortex',
    # RH cortex + white matter
    42: 'rh_cortex', 41: 'rh_cortex',
    # L subcortical
    10: 'subcort_l', 11: 'subcort_l', 12: 'subcort_l', 13: 'subcort_l',
    17: 'subcort_l', 18: 'subcort_l', 26: 'subcort_l',
    # R subcortical
    49: 'subcort_r', 50: 'subcort_r', 51: 'subcort_r', 52: 'subcort_r',
    53: 'subcort_r', 54: 'subcort_r', 58: 'subcort_r',
    # Cerebellum
    8: 'cereb_l', 47: 'cereb_r',
    # Brainstem
    16: 'brainstem',
}

STRUCTURE_CATEGORIES = [
    'lh_cortex', 'rh_cortex', 'subcort_l', 'subcort_r',
    'cereb_l', 'cereb_r', 'brainstem',
]


def load_stat_map(nifti_path, threshold=2.3):
    """Load a NIfTI stat map and apply threshold."""
    img = nib.load(str(nifti_path))
    data = np.asarray(img.dataobj, dtype=np.float32)
    affine = img.affine
    data[np.abs(data) < threshold] = 0.0
    return data, affine


def cluster_sizes(data, connectivity=26):
    """Per-voxel connected-cluster size, in native voxels.

    Positive and negative supra-threshold blobs are labelled separately so a
    +blob touching a -blob is never merged. 26-connectivity (face+edge+corner)
    by default, matching FSL's `cluster`. The returned volume (same shape as
    `data`) assigns every non-zero voxel the size of the cluster it belongs to;
    it feeds the live cluster-extent filter (a per-voxel `aClusterSize` attribute
    + a `uClusterMin` shader threshold), so the cluster size shown is the one at
    the bake threshold — raising the live intensity threshold makes it approximate.
    """
    rank = {6: 1, 18: 2, 26: 3}[connectivity]
    structure = ndimage.generate_binary_structure(3, rank)
    sizes = np.zeros(data.shape, dtype=np.float32)
    for mask in (data > 0, data < 0):
        if not mask.any():
            continue
        labels, _ = ndimage.label(mask, structure=structure)
        counts = np.bincount(labels.ravel())          # counts[0] = background
        sizes[mask] = counts[labels[mask]]
    return sizes


def _voxel_mesh(mask, *fields):
    """Build axis-aligned voxel mesh; sample each scalar field per vertex.

    Returns verts (n,3) float32, faces (m,3) int, and a list of per-vertex
    arrays — one per scalar field in `fields`, in the same vertex order.
    """
    padded = np.pad(mask, 1, mode='constant', constant_values=False)

    directions = [
        (0, +1, np.array([[1,0,0],[1,1,0],[1,1,1],[1,0,1]], dtype=np.float32)),
        (0, -1, np.array([[0,0,0],[0,0,1],[0,1,1],[0,1,0]], dtype=np.float32)),
        (1, +1, np.array([[0,1,0],[0,1,1],[1,1,1],[1,1,0]], dtype=np.float32)),
        (1, -1, np.array([[0,0,0],[1,0,0],[1,0,1],[0,0,1]], dtype=np.float32)),
        (2, +1, np.array([[0,0,1],[1,0,1],[1,1,1],[0,1,1]], dtype=np.float32)),
        (2, -1, np.array([[0,0,0],[0,1,0],[1,1,0],[1,0,0]], dtype=np.float32)),
    ]

    all_verts, all_faces = [], []
    all_fields = [[] for _ in fields]
    vert_offset = 0

    for axis, direction, corners in directions:
        slc_self = [slice(1, -1)] * 3
        slc_neighbour = [slice(1, -1)] * 3
        if direction > 0:
            slc_neighbour[axis] = slice(2, None)
        else:
            slc_neighbour[axis] = slice(0, -2)

        exposed = padded[tuple(slc_self)] & ~padded[tuple(slc_neighbour)]
        voxels = np.argwhere(exposed)
        if len(voxels) == 0:
            continue

        n = len(voxels)
        quad_verts = (voxels[:, np.newaxis, :] + corners[np.newaxis, :, :]).reshape(-1, 3)
        for fi, fld in enumerate(fields):
            voxel_vals = fld[voxels[:, 0], voxels[:, 1], voxels[:, 2]]
            all_fields[fi].append(np.repeat(voxel_vals, 4))

        idx = np.arange(n) * 4 + vert_offset
        tri1 = np.stack([idx, idx + 1, idx + 2], axis=1)
        tri2 = np.stack([idx, idx + 2, idx + 3], axis=1)

        all_verts.append(quad_verts)
        all_faces.append(np.vstack([tri1, tri2]))
        vert_offset += n * 4

    if not all_verts:
        return (np.empty((0, 3), np.float32), np.empty((0, 3), dtype=int),
                [np.empty(0, np.float32) for _ in fields])

    return (np.vstack(all_verts).astype(np.float32),
            np.vstack(all_faces),
            [np.concatenate(f).astype(np.float32) for f in all_fields])


def classify_overlay_voxels(data, overlay_affine, aseg_data, aseg_affine):
    """Classify each non-zero overlay voxel by its aseg brain region.

    Returns dict mapping category name → boolean mask (same shape as data).
    """
    nz_ijk = np.argwhere(data != 0)
    if len(nz_ijk) == 0:
        return {}

    # Overlay voxel → world → aseg voxel
    nz_h = np.column_stack([nz_ijk, np.ones(len(nz_ijk))])
    nz_world = (overlay_affine @ nz_h.T).T[:, :3]
    inv_aseg = np.linalg.inv(aseg_affine)
    aseg_ijk = np.round(
        (inv_aseg @ np.column_stack([nz_world, np.ones(len(nz_world))]).T).T[:, :3]
    ).astype(int)

    # Classify each voxel
    masks = {cat: np.zeros(data.shape, dtype=bool) for cat in STRUCTURE_CATEGORIES}

    for ov_idx, (ai, aj, ak) in zip(nz_ijk, aseg_ijk):
        if (0 <= ai < aseg_data.shape[0] and
            0 <= aj < aseg_data.shape[1] and
            0 <= ak < aseg_data.shape[2]):
            label = int(aseg_data[ai, aj, ak])
            cat = ASEG_CATEGORIES.get(label)
            if cat:
                masks[cat][tuple(ov_idx)] = True

    # Remove empty categories
    return {cat: mask for cat, mask in masks.items() if mask.any()}


def _normalize_for_cmap(values, max_abs, diverging, gamma=0.5):
    """Power-law normalize signed values to [0,1] for colormap lookup.

    gamma<1 (default sqrt) pushes mid-range values toward saturated extremes.
    """
    if diverging:
        signed_norm = np.clip(values / max_abs, -1.0, 1.0)
        amplified = np.sign(signed_norm) * np.abs(signed_norm) ** gamma
        return (amplified + 1.0) / 2.0
    return np.clip((values / max_abs) ** gamma, 0.0, 1.0)


def build_smooth_mesh(mask, signed_data, affine, sigma_mm=1.0, target_mm=0.5,
                      pad=2, cluster_data=None):
    """Resample a voxel mask to a fine grid, smooth, marching-cubes to a surface.

    Operates per connected component so the fine grid only covers active tissue,
    not the whole bounding box. Surface vertices are coloured by the *nearest*
    active voxel value (nearest-fill before sampling) so the smooth surface
    stays saturated rather than fading toward zero at the edges.

    Parameters
    ----------
    mask : ndarray bool — this category's supra-threshold voxels
    signed_data : ndarray — signed stat values (zero outside the cluster)
    affine : ndarray (4,4) — voxel→world
    sigma_mm : float — Gaussian smoothing on the upsampled occupancy
    target_mm : float — target grid spacing (0.5 mm)
    pad : int — native-voxel padding around each component bbox

    Returns
    -------
    world_verts (n,3) float32, faces (m,3) int, vert_values (n,) float32
    """
    vox = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))   # native mm/voxel per axis
    zoom = vox / target_mm                              # upsample factor per axis
    sigma_vox = sigma_mm / target_mm

    labels, n_comp = ndimage.label(mask)
    all_v, all_f, all_vals, all_clu, offset = [], [], [], [], 0

    for lab in range(1, n_comp + 1):
        comp = labels == lab
        idx = np.argwhere(comp)
        lo = np.maximum(idx.min(0) - pad, 0)
        hi = np.minimum(idx.max(0) + pad + 1, np.array(mask.shape))
        sl = tuple(slice(a, b) for a, b in zip(lo, hi))

        sub_occ = comp[sl].astype(np.float32)
        sub_val = signed_data[sl].astype(np.float32)

        # Nearest-fill the value field so boundary vertices get real colours
        zero = sub_val == 0
        if zero.any() and (~zero).any():
            ind = ndimage.distance_transform_edt(
                zero, return_distances=False, return_indices=True)
            sub_val = sub_val[tuple(ind)]

        occ = ndimage.gaussian_filter(ndimage.zoom(sub_occ, zoom, order=1),
                                      sigma_vox)
        if occ.max() < 0.5:
            continue
        val = ndimage.zoom(sub_val, zoom, order=1)

        verts, faces, _, _ = measure.marching_cubes(occ, level=0.5)
        vert_vals = ndimage.map_coordinates(val, verts.T, order=1)

        # Cluster size sampled at order=0 (nearest) to keep integer extents.
        if cluster_data is not None:
            sub_clu = cluster_data[sl].astype(np.float32)
            czero = sub_clu == 0
            if czero.any() and (~czero).any():
                ind = ndimage.distance_transform_edt(
                    czero, return_distances=False, return_indices=True)
                sub_clu = sub_clu[tuple(ind)]
            clu = ndimage.zoom(sub_clu, zoom, order=0)
            all_clu.append(ndimage.map_coordinates(clu, verts.T, order=0).astype(np.float32))

        # resampled index → native voxel index → world
        native_idx = lo[np.newaxis, :] + verts / zoom[np.newaxis, :]
        homo = np.column_stack([native_idx, np.ones(len(native_idx))])
        world = (affine @ homo.T).T[:, :3]

        all_v.append(world.astype(np.float32))
        all_f.append(faces + offset)
        all_vals.append(vert_vals.astype(np.float32))
        offset += len(verts)

    if not all_v:
        return (np.empty((0, 3), np.float32), np.empty((0, 3), int),
                np.empty(0, np.float32), np.empty(0, np.float32))
    clusters = np.concatenate(all_clu) if all_clu else np.zeros(offset, np.float32)
    return np.vstack(all_v), np.vstack(all_f), np.concatenate(all_vals), clusters


def build_structure_overlays(data, affine, category_masks, cmap_name='coolwarm',
                             clim_percentile=99, cluster_data=None):
    """Build one voxel mesh per brain structure category.

    Parameters
    ----------
    data : ndarray — thresholded stat volume (signed)
    affine : ndarray (4,4)
    category_masks : dict[str, ndarray bool] — from classify_overlay_voxels
    cmap_name : str — colormap name (cmap package)
    clim_percentile : int — percentile of |values| for colormap normalization

    Returns
    -------
    structure_overlays : dict[str, dict] with keys:
        'mesh': trimesh.Trimesh with vertex colors
        'values': list of per-vertex signed floats
    max_abs : float — the clim value (p95 of |values|)
    diverging : bool — whether data has both positive and negative values
    """
    # Compute global clim from all categorized voxels
    all_vals = []
    for mask in category_masks.values():
        all_vals.append(data[mask])
    all_vals = np.concatenate(all_vals) if all_vals else np.array([0.0])

    has_neg = all_vals.min() < 0
    has_pos = all_vals.max() > 0
    diverging = has_neg and has_pos

    abs_vals = np.abs(all_vals[all_vals != 0])
    if len(abs_vals) == 0:
        max_abs = 1.0
    else:
        max_abs = float(np.percentile(abs_vals, clim_percentile))
        max_abs = max(max_abs, 1e-10)

    if cluster_data is None:
        cluster_data = np.zeros(data.shape, np.float32)

    colormap = cmaplib.Colormap(cmap_name)

    def colorize(vals):
        rgba = (colormap(_normalize_for_cmap(vals, max_abs, diverging)) * 255
                ).astype(np.uint8)
        rgba[:, 3] = 255
        return rgba

    structure_overlays = {}
    for cat, mask in category_masks.items():
        cat_data = np.where(mask, data, 0.0).astype(np.float32)
        cat_clu = np.where(mask, cluster_data, 0.0).astype(np.float32)
        verts, faces, (vert_values, vert_clusters) = _voxel_mesh(mask, cat_data, cat_clu)
        if len(verts) == 0:
            continue

        # Voxel to world
        n = verts.shape[0]
        homogeneous = np.hstack([verts, np.ones((n, 1))])
        world_verts = (affine @ homogeneous.T).T[:, :3]

        mesh = trimesh.Trimesh(vertices=world_verts, faces=faces, process=False)
        mesh.visual = trimesh.visual.ColorVisuals(
            mesh=mesh, vertex_colors=colorize(vert_values))

        entry = {'mesh': mesh, 'values': vert_values.tolist(),
                 'clusters': vert_clusters.tolist()}

        # Smooth variant: voxels resampled to a fine grid + marching cubes
        sv, sf, svals, sclu = build_smooth_mesh(mask, cat_data, affine,
                                                cluster_data=cat_clu)
        if len(sv):
            smesh = trimesh.Trimesh(vertices=sv, faces=sf, process=False)
            smesh.visual = trimesh.visual.ColorVisuals(
                mesh=smesh, vertex_colors=colorize(svals))
            entry['mesh_smooth'] = smesh
            entry['values_smooth'] = svals.tolist()
            entry['clusters_smooth'] = sclu.tolist()

        n_voxels = mask.sum()
        print(f"  {cat}: {n_voxels} voxels, {len(verts)} verts"
              + (f", {len(sv)} smooth verts" if len(sv) else ""))

        structure_overlays[cat] = entry

    return structure_overlays, float(max_abs), diverging


def prepare_volume_texture(data, affine, clim=None):
    """Prepare a stat map for 3D texture volume rendering."""
    if clim is None:
        nonzero = data[data != 0]
        if len(nonzero) == 0:
            clim = (0.0, 1.0)
        else:
            clim = (float(np.min(np.abs(nonzero))), float(np.max(np.abs(data))))

    vmin, vmax = clim
    normed = np.clip((np.abs(data) - vmin) / (vmax - vmin + 1e-10), 0, 1)
    normed[data == 0] = 0.0

    return {
        'data': normed.astype(np.float32),
        'dims': list(data.shape),
        'affine': affine.tolist(),
        'clim': list(clim),
    }
