"""NIfTI -> per-structure geometry pipeline. The single backend, run two ways.

This module is the ONE source of the per-upload meshing. It is self-contained
(numpy / scipy.ndimage / scikit-image / nibabel only — no trimesh/cmap/mne, no
intra-package imports), so the exact same file runs:
  - in CPython for the CLI (`glass-brains render` imports it in-process), and
  - in Pyodide for the browser (a byte-identical copy is shipped to web/pyodide/
    and loaded into the Pyodide FS; see glass_brains/bake.py + web/pyodide/bootstrap.js).

The JS engine is the single COLOUR authority (it colourises from the per-vertex
`aValue` attribute via a colormap LUT), so the pipeline only emits raw geometry
ARRAYS — positions/faces/values/clusters — never colours or GLB.

Entry points:
  init_aseg(gz_bytes, meta_json)                 -> load the shipped segmentation once
  process_nifti(src, name, threshold)            -> JSON meta string; arrays staged in _BUFFERS
  get_all_buffers() / get_buffer(i) / clear_buffers()
`src` is a NIfTI path (CLI) OR raw bytes (browser upload).
"""

import gzip
import json
import os

import numpy as np
import nibabel as nib
from scipy import ndimage
from skimage import measure


# Aseg label -> structure category.
ASEG_CATEGORIES = {
    3: 'lh_cortex', 2: 'lh_cortex',
    42: 'rh_cortex', 41: 'rh_cortex',
    10: 'subcort_l', 11: 'subcort_l', 12: 'subcort_l', 13: 'subcort_l',
    17: 'subcort_l', 18: 'subcort_l', 26: 'subcort_l',
    49: 'subcort_r', 50: 'subcort_r', 51: 'subcort_r', 52: 'subcort_r',
    53: 'subcort_r', 54: 'subcort_r', 58: 'subcort_r',
    8: 'cereb_l', 47: 'cereb_r',
    16: 'brainstem',
}
STRUCTURE_CATEGORIES = ['lh_cortex', 'rh_cortex', 'subcort_l', 'subcort_r',
                        'cereb_l', 'cereb_r', 'brainstem']

# Segmentation volume + its category tables, loaded once via init_aseg(). The category maps
# above are the bundled fsaverage defaults; init_aseg overrides them from the sidecar when a
# custom template's segmentation ships its own (M9), so classification is DATA, not hardcoded.
_ASEG = {'data': None, 'affine': None, 'categories': None, 'structureCategories': None}
# Staging for the most recent process_nifti() result (flat buffer list).
_BUFFERS = []


def init_aseg(gz_bytes, meta_json):
    """Load the shipped gzipped uint8 aseg into memory (call once).

    meta_json is the text of data/aseg.json ({dims, affine, ...}); passing it as a
    string avoids JS->Python proxy conversion of the nested affine array.
    """
    meta = json.loads(meta_json)
    raw = gzip.decompress(bytes(gz_bytes))
    _ASEG['data'] = np.frombuffer(raw, dtype=np.uint8).reshape(tuple(meta['dims']))
    _ASEG['affine'] = np.asarray(meta['affine'], dtype=float)
    # Category tables are DATA (a custom seg can drive its own classification, M9); fall back to
    # the bundled fsaverage tables when the sidecar omits them, so fsaverage stays byte-identical.
    _ASEG['categories'] = ({int(k): v for k, v in meta['categories'].items()}
                           if meta.get('categories') else ASEG_CATEGORIES)
    _ASEG['structureCategories'] = meta.get('structureCategories') or STRUCTURE_CATEGORIES


def load_stat_map(src, filename=None, threshold=2.3):
    """Load a NIfTI from a path (CLI) or raw bytes (browser upload) and threshold.

    Bytes branch: nibabel chooses (de)compression by file EXTENSION, so a gzipped
    upload named foo.nii would be read as garbage. Detect the gzip magic (1f 8b)
    and pick the .nii.gz path regardless of name — the one defensive check worth it.
    """
    if isinstance(src, (str, os.PathLike)):
        img = nib.load(str(src))
    else:
        b = bytes(src)
        is_gz = len(b) >= 2 and b[0] == 0x1F and b[1] == 0x8B
        name = filename or ''
        suffix = '.nii.gz' if (is_gz or name.endswith(('.nii.gz', '.gz'))) else '.nii'
        path = '/tmp/gb_upload' + suffix
        with open(path, 'wb') as f:
            f.write(b)
        img = nib.load(path)
    data = np.squeeze(np.asarray(img.dataobj, dtype=np.float32))
    if data.ndim != 3:
        raise ValueError(
            f"Expected a 3D statistical map, got shape {np.asarray(img.dataobj).shape}. "
            "Upload a 3D stat map in MNI152 space (not a 4D timeseries).")
    # NaN/inf in a masked map mean "no data here" — zero them so they neither mesh nor
    # poison the colour limit. np.abs(nan) < threshold is False, so without this they would
    # survive thresholding and make np.percentile(maxAbsValue) NaN, breaking the whole overlay.
    data[~np.isfinite(data)] = 0.0
    data[np.abs(data) < threshold] = 0.0
    return data, img.affine


def cluster_sizes(data, connectivity=26):
    """Per-voxel connected-cluster size (signed blobs labelled separately)."""
    rank = {6: 1, 18: 2, 26: 3}[connectivity]
    structure = ndimage.generate_binary_structure(3, rank)
    sizes = np.zeros(data.shape, dtype=np.float32)
    for mask in (data > 0, data < 0):
        if not mask.any():
            continue
        labels, _ = ndimage.label(mask, structure=structure)
        counts = np.bincount(labels.ravel())
        sizes[mask] = counts[labels[mask]]
    return sizes


def _voxel_mesh(mask, *fields):
    """Axis-aligned exposed-face voxel mesh; sample each scalar field per vertex."""
    padded = np.pad(mask, 1, mode='constant', constant_values=False)
    directions = [
        (0, +1, np.array([[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], dtype=np.float32)),
        (0, -1, np.array([[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], dtype=np.float32)),
        (1, +1, np.array([[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], dtype=np.float32)),
        (1, -1, np.array([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], dtype=np.float32)),
        (2, +1, np.array([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=np.float32)),
        (2, -1, np.array([[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], dtype=np.float32)),
    ]
    all_verts, all_faces = [], []
    all_fields = [[] for _ in fields]
    vert_offset = 0
    for axis, direction, corners in directions:
        slc_self = [slice(1, -1)] * 3
        slc_neighbour = [slice(1, -1)] * 3
        slc_neighbour[axis] = slice(2, None) if direction > 0 else slice(0, -2)
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


def classify_overlay_voxels(data, overlay_affine, aseg_data, aseg_affine,
                            categories=None, structure_categories=None):
    """Classify each non-zero overlay voxel by its aseg brain region. `categories`
    (label-id -> category) and `structure_categories` (ordered category list) default to the
    bundled fsaverage tables but may be supplied (custom template, M9)."""
    categories = categories if categories is not None else ASEG_CATEGORIES
    structure_categories = structure_categories if structure_categories is not None else STRUCTURE_CATEGORIES
    nz_ijk = np.argwhere(data != 0)
    if len(nz_ijk) == 0:
        return {}
    nz_h = np.column_stack([nz_ijk, np.ones(len(nz_ijk))])
    nz_world = (overlay_affine @ nz_h.T).T[:, :3]
    inv_aseg = np.linalg.inv(aseg_affine)
    aseg_ijk = np.round(
        (inv_aseg @ np.column_stack([nz_world, np.ones(len(nz_world))]).T).T[:, :3]
    ).astype(int)
    masks = {cat: np.zeros(data.shape, dtype=bool) for cat in structure_categories}
    for ov_idx, (ai, aj, ak) in zip(nz_ijk, aseg_ijk):
        if (0 <= ai < aseg_data.shape[0] and 0 <= aj < aseg_data.shape[1]
                and 0 <= ak < aseg_data.shape[2]):
            cat = categories.get(int(aseg_data[ai, aj, ak]))
            if cat:
                masks[cat][tuple(ov_idx)] = True
    return {cat: mask for cat, mask in masks.items() if mask.any()}


def build_smooth_mesh(mask, signed_data, affine, sigma_mm=1.0, target_mm=0.5,
                      pad=2, cluster_data=None):
    """Per-component upsample + Gaussian smooth + marching cubes -> world mesh."""
    vox = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
    zoom = vox / target_mm
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
        zero = sub_val == 0
        if zero.any() and (~zero).any():
            ind = ndimage.distance_transform_edt(zero, return_distances=False, return_indices=True)
            sub_val = sub_val[tuple(ind)]
        occ = ndimage.gaussian_filter(ndimage.zoom(sub_occ, zoom, order=1), sigma_vox)
        if occ.max() < 0.5:
            continue
        val = ndimage.zoom(sub_val, zoom, order=1)
        verts, faces, _, _ = measure.marching_cubes(occ, level=0.5)
        vert_vals = ndimage.map_coordinates(val, verts.T, order=1)
        if cluster_data is not None:
            sub_clu = cluster_data[sl].astype(np.float32)
            czero = sub_clu == 0
            if czero.any() and (~czero).any():
                ind = ndimage.distance_transform_edt(czero, return_distances=False, return_indices=True)
                sub_clu = sub_clu[tuple(ind)]
            clu = ndimage.zoom(sub_clu, zoom, order=0)
            all_clu.append(ndimage.map_coordinates(clu, verts.T, order=0).astype(np.float32))
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


def _stage(arr, dtype):
    """Append an array to the transfer buffer; return its buffer index + count."""
    a = np.ascontiguousarray(arr, dtype=dtype)
    _BUFFERS.append(a.tobytes())
    return len(_BUFFERS) - 1, int(a.shape[0])


def _stage_mesh(verts, faces, values, clusters):
    """Stage one mesh's four arrays; return a JSON-able descriptor."""
    pos_i, nverts = _stage(verts.reshape(-1), np.float32)        # n*3 floats
    idx_i, nidx = _stage(faces.reshape(-1), np.uint32)           # m*3 uint32
    val_i, _ = _stage(values, np.float32)
    clu_i, _ = _stage(clusters, np.float32)
    return {'pos': pos_i, 'idx': idx_i, 'val': val_i, 'clu': clu_i,
            'nverts': int(verts.shape[0]), 'ntris': nidx // 3}


def process_nifti(src, name, threshold=2.3, classify=True):
    """Run the full pipeline on a NIfTI (path or bytes). Returns a JSON meta string;
    geometry arrays are staged in _BUFFERS for retrieval via get_all_buffers().

    classify=True (default) buckets voxels by aseg region. classify=False (or no aseg loaded)
    is the no-template / volume-only mode (M7): every supra-threshold voxel goes into one
    'volume' bucket, meshed in the map's own space with no anatomical classification."""
    _BUFFERS.clear()
    data, affine = load_stat_map(src, name, threshold)
    cluster_data = cluster_sizes(data)

    aseg_d, aseg_a = _ASEG['data'], _ASEG['affine']
    if classify and aseg_d is not None:
        cats = classify_overlay_voxels(data, affine, aseg_d, aseg_a,
                                       _ASEG.get('categories'), _ASEG.get('structureCategories'))
    else:
        m = data != 0
        cats = {'volume': m} if m.any() else {}

    # global clim + diverging from all categorised voxels
    all_vals = np.concatenate([data[m] for m in cats.values()]) if cats else np.array([0.0])
    diverging = bool(all_vals.min() < 0 and all_vals.max() > 0)
    negative_only = bool((all_vals < 0).any() and not (all_vals > 0).any())
    abs_vals = np.abs(all_vals[all_vals != 0])
    max_abs = max(float(np.percentile(abs_vals, 99)), 1e-10) if len(abs_vals) else 1.0

    structures = {}
    for cat, mask in cats.items():
        cat_data = np.where(mask, data, 0.0).astype(np.float32)
        cat_clu = np.where(mask, cluster_data, 0.0).astype(np.float32)
        verts, faces, (vvals, vclu) = _voxel_mesh(mask, cat_data, cat_clu)
        if len(verts) == 0:
            continue
        n = verts.shape[0]
        world = (affine @ np.hstack([verts, np.ones((n, 1))]).T).T[:, :3].astype(np.float32)
        entry = {'blocky': _stage_mesh(world, faces, vvals, vclu)}
        sv, sf, svals, sclu = build_smooth_mesh(mask, cat_data, affine, cluster_data=cat_clu)
        if len(sv):
            entry['smooth'] = _stage_mesh(sv.astype(np.float32), sf, svals, sclu)
        else:
            # Tiny/thin clusters can yield no marching-cubes surface. Reuse the blocky
            # geometry as the 'smooth' variant so smooth mode never silently hides them.
            entry['smooth'] = entry['blocky']
        structures[cat] = entry

    meta = {
        'name': name,
        'threshold': float(threshold),
        'maxAbsValue': max_abs,
        'maxClusterSize': int(cluster_data.max()) if cluster_data.size else 0,
        'diverging': diverging,
        'negativeOnly': negative_only,
        'structures': structures,
    }
    return json.dumps(meta)


def get_buffer(i):
    """Return the raw bytes of staged buffer i (JS reconstructs the typed array)."""
    return _BUFFERS[i]


def get_all_buffers():
    """Return all staged buffers in one list; JS does one .toJs() -> [Uint8Array]."""
    return list(_BUFFERS)


def clear_buffers():
    """Drop staged buffers from memory once they've been copied out."""
    _BUFFERS.clear()
