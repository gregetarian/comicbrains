"""NIfTI -> per-structure geometry pipeline. The single backend, run two ways.

This module is the ONE source of the per-upload meshing. It is self-contained
(numpy / scipy.ndimage / scikit-image / nibabel only — no trimesh/cmap/mne, no
intra-package imports), so the exact same file runs:
  - in CPython for the CLI (`comic render` imports it in-process), and
  - in Pyodide for the browser (a byte-identical copy is shipped to web/pyodide/
    and loaded into the Pyodide FS; see comic/bake.py + web/pyodide/bootstrap.js).

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
import warnings

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
# Cortical surface (pial verts + faces + curvature + inward offset to the white surface),
# loaded once via init_cortex() for surface-projection mode (M8). None until loaded.
_CORTEX = {'lh': None, 'rh': None}
SURFACE_DEPTH = 6   # samples along the pial->white ribbon (nilearn vol_to_surf 'line' kind)

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


def init_cortex(gz_bytes, meta_json):
    """Load the cortical-surface sidecar (pial verts/faces/curv + inward offset to white) for
    surface-projection mode (M8). meta_json is cortex_surface.json (per-hemi byte layout)."""
    layout = json.loads(meta_json)
    raw = gzip.decompress(bytes(gz_bytes))
    for hemi in ('lh', 'rh'):
        h = layout.get(hemi)
        if not h:
            _CORTEX[hemi] = None
            continue
        def arr(name, dtype, cols):
            off, ln = h[name]
            a = np.frombuffer(raw[off:off + ln], dtype=dtype)
            return a.reshape(-1, cols) if cols > 1 else a
        _CORTEX[hemi] = {'verts': arr('pial', np.float32, 3), 'inward': arr('inward', np.float32, 3),
                         'faces': arr('faces', np.uint32, 3), 'curv': arr('curv', np.float32, 1)}


# fsaverage icosahedral vertex counts (per hemisphere) -> ico order. Lower orders are a strict
# vertex PREFIX of the ico7 template (FreeSurfer's nested subdivision keeps old indices), so a
# lower-res map's vertices are exactly the first N template vertices.
_ICO_NVERTS = {42: 1, 162: 2, 642: 3, 2562: 4, 10242: 5, 40962: 6, 163842: 7}


def _upsample_to_template(vals, C):
    """Nearest-neighbour upsample a lower-res fsaverage map (ico1..6) to the ico7 template
    vertex count. The low-res vertices ARE the template's first N vertices (nested ordering),
    so a KDTree over that prefix maps every template vertex to its nearest low-res source."""
    n, m = len(vals), len(C['verts'])
    if n == m:
        return vals
    if n not in _ICO_NVERTS or n > m:
        raise ValueError(
            f"surface map has {n} vertices; expected an fsaverage size "
            f"({sorted(k for k in _ICO_NVERTS if k <= m)}) matching the ico7 template ({m}).")
    from scipy.spatial import cKDTree
    _, idx = cKDTree(C['verts'][:n]).query(C['verts'], k=1)   # each ico7 vertex -> nearest low-res vertex
    return np.ascontiguousarray(vals[idx], np.float32)


def _stage_surface(vals_by_hemi):
    """Stage the baked cortex sheet per hemisphere, coloured by a caller-supplied per-vertex
    scalar array (float32, length == that hemi's vertex count). Shared by the volume->surface
    projection and the native-surface path so both feed the engine identically. Returns
    {hemi: descriptor} for meta['surface']; staged into _BUFFERS in lh-then-rh order."""
    out = {}
    for hemi in ('lh', 'rh'):
        C = _CORTEX.get(hemi)
        vals = vals_by_hemi.get(hemi)
        if C is None or vals is None:
            continue
        vals = np.ascontiguousarray(vals, np.float32)
        if len(vals) != len(C['verts']):
            raise ValueError(
                f"{hemi} surface map has {len(vals)} vertices, but the loaded template cortex has "
                f"{len(C['verts'])} (fsaverage is 163842/hemisphere; resample the map to it first).")
        clu = np.zeros(len(vals), np.float32)
        desc = _stage_mesh(C['verts'].astype(np.float32), C['faces'], vals, clu)
        desc['crv'] = _stage(np.ascontiguousarray(C['curv'], np.float32), np.float32)[0]
        out[hemi] = desc
    return out


def build_surface_projection(data, overlay_affine, depth=SURFACE_DEPTH):
    """Project the thresholded volume onto each cortical hemisphere's vertices: average K
    trilinear samples taken along the inward normal from pial to white (nilearn vol_to_surf
    'line' kind). Emits the full cortex sheet per hemi (grey where sub-threshold via the
    surface material's curvature fallback); staged into _BUFFERS after the voxel structures."""
    inv = np.linalg.inv(overlay_affine)
    fracs = np.linspace(0.0, 1.0, max(1, depth))
    vals_by_hemi = {}
    for hemi, C in _CORTEX.items():
        if C is None:
            continue
        verts, inward = C['verts'], C['inward']
        acc = np.zeros(len(verts), np.float32)
        for f in fracs:
            world = verts + f * inward
            ijk = (inv @ np.column_stack([world, np.ones(len(world))]).T).T[:, :3]
            acc += ndimage.map_coordinates(data, ijk.T, order=1, mode='constant', cval=0.0).astype(np.float32)
        vals_by_hemi[hemi] = (acc / len(fracs)).astype(np.float32)
    return _stage_surface(vals_by_hemi)


# --- MNI152 sanity envelope (scientific-correctness guard) --------------------------------
# The whole pipeline assumes the uploaded stat map lives in MNI152 world space: geometry is
# placed by the map's own affine, and every voxel is aseg-classified by mapping its MNI world
# coordinate into the bundled MNI segmentation. If the map is NOT in MNI, placement and region
# labels are silently wrong. These bounds describe what a whole-brain MNI152 volume looks like;
# _warn_if_not_mni only WARNS (never crashes) on a CLEAR mismatch, and is deliberately permissive
# so real (near-)MNI stat maps never false-alarm.
MNI_VOX_MM_RANGE = (0.3, 6.0)        # plausible (near-isotropic) voxel size, mm
MNI_MAX_EXTENT_MM = 350.0            # longest world axis of a head-sized field of view, mm
MNI_WHOLEBRAIN_EXTENT_MM = 130.0     # >= this on the longest axis => expect the AC well inside
MNI_ORIGIN_INTERIOR_FRAC = 0.10      # AC (world origin) must sit in the central (1 - 2*frac) band


def _warn_if_not_mni(affine, shape):
    """Loudly warn (never crash) when a loaded volume is clearly NOT in MNI152 space.

    Placement and aseg-region classification both assume MNI152; a wrong space makes them
    silently incorrect. We only flag unambiguous mismatches (odd voxel size / units, a FOV far
    too large for a head, or the MNI origin sitting at a volume edge rather than inside), so the
    bundled MNI fixtures and any real MNI stat map pass without a warning. Near-MNI data still
    renders — hence a warning, not an exception."""
    reasons = []
    vox = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
    lo_mm, hi_mm = MNI_VOX_MM_RANGE
    if vox.min() < lo_mm or vox.max() > hi_mm:
        reasons.append(f"voxel size {np.round(vox, 3).tolist()} mm is outside the plausible "
                       f"[{lo_mm}, {hi_mm}] mm MNI range (wrong units?)")
    # World bounding box over the 8 voxel-grid corners (orientation/flip agnostic).
    d = np.asarray(shape[:3], float)
    corners = np.array([[i * d[0], j * d[1], k * d[2], 1.0]
                        for i in (0, 1) for j in (0, 1) for k in (0, 1)])
    world = (affine @ corners.T).T[:, :3]
    wmin, wmax = world.min(0), world.max(0)
    extent = wmax - wmin
    if extent.max() > MNI_MAX_EXTENT_MM:
        reasons.append(f"field of view {np.round(extent, 1).tolist()} mm is larger than a head "
                       f"(> {MNI_MAX_EXTENT_MM} mm); not a brain-sized volume")
    if extent.max() >= MNI_WHOLEBRAIN_EXTENT_MM:
        # In MNI152 the world origin IS the anterior commissure, which sits comfortably inside a
        # whole-brain volume. At/beyond an edge => the map was never MNI-normalised (e.g. a native
        # scanner grid with the origin at a corner).
        span = np.where(extent > 0, extent, 1.0)
        frac = (0.0 - wmin) / span                    # origin's fractional position per axis
        f = MNI_ORIGIN_INTERIOR_FRAC
        if np.any(frac < f) or np.any(frac > 1.0 - f):
            reasons.append(f"the MNI origin (anterior commissure) sits at a volume edge "
                           f"(fractional position {np.round(frac, 2).tolist()}); the brain is not "
                           f"centred where MNI152 expects it")
    if reasons:
        msg = ("Uploaded volume does not look like MNI152 space: " + "; ".join(reasons)
               + ". Rendering anyway, but spatial placement and aseg region classification "
                 "may be WRONG.")
        warnings.warn(msg, stacklevel=2)
        print("WARNING:", msg)


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
    data = np.asarray(img.dataobj, dtype=np.float32)
    # The first three axes are spatial even when one has length one: dropping it
    # would either reject a valid slab or reinterpret time as a spatial dimension.
    trailing_singletons = tuple(i for i in range(3, data.ndim) if data.shape[i] == 1)
    if trailing_singletons:
        data = np.squeeze(data, axis=trailing_singletons)
    if data.ndim != 3:
        raise ValueError(
            f"Expected a 3D statistical map, got shape {np.asarray(img.dataobj).shape}. "
            "Upload a 3D stat map in MNI152 space (not a 4D timeseries).")
    _warn_if_not_mni(img.affine, data.shape)
    # NaN/inf in a masked map mean "no data here" — zero them so they neither mesh nor
    # poison the colour limit. np.abs(nan) < threshold is False, so without this they would
    # survive thresholding and make np.percentile(maxAbsValue) NaN, breaking the whole overlay.
    data[~np.isfinite(data)] = 0.0
    data[np.abs(data) < threshold] = 0.0
    return data, img.affine


def load_surface_map(src, filename=None):
    """Read a per-vertex scalar map (one value per fsaverage vertex) from a path or raw bytes.

    Handles the formats a surface analysis emits: GIFTI (.gii, e.g. func.gii/shape.gii),
    FreeSurfer volume-encoded scalars (.mgh/.mgz), and FreeSurfer morphometry/curv binary.
    Returns a 1-D float32 array; the caller checks its length against the template vertex count."""
    import nibabel as nib
    # A JS TypedArray handed across the Pyodide FFI (the browser's parcel-vector upload). It is a
    # JsProxy, NOT an ndarray, and bytes() on a Float32Array raises — so convert first. .to_py()
    # gives a zero-copy-cost memoryview that preserves the source dtype; np.asarray(proxy) directly
    # would silently widen float32 to float64 (and uint8 to int32).
    if hasattr(src, 'to_py'):
        src = np.asarray(src.to_py())
    # An already-computed per-vertex array (e.g. a parcel value table expanded by comic.parcels)
    # is handed straight through — there is no file to read.
    if isinstance(src, np.ndarray):
        vals = np.ravel(np.asarray(src, dtype=np.float32))
        vals[~np.isfinite(vals)] = 0.0
        return vals
    name = (filename or (str(src) if isinstance(src, (str, os.PathLike)) else '')).lower()
    if not isinstance(src, (str, os.PathLike)):
        b = bytes(src)
        suffix = ('.gii' if name.endswith('.gii') else '.mgz' if name.endswith('.mgz')
                  else '.mgh' if name.endswith('.mgh') else '.surfdat')
        src = '/tmp/gb_surf_upload' + suffix
        with open(src, 'wb') as f:
            f.write(b)
    src = str(src)
    if src.endswith('.gii'):
        vals = np.asarray(nib.load(src).agg_data(), dtype=np.float32)
    elif src.endswith(('.mgh', '.mgz')):
        vals = np.asarray(nib.load(src).dataobj, dtype=np.float32)
    else:                                        # FreeSurfer morphometry/curv binary (thickness, curv, ...)
        import nibabel.freesurfer as fs
        vals = np.asarray(fs.read_morph_data(src), dtype=np.float32)
    vals = np.ravel(np.squeeze(vals))
    vals[~np.isfinite(vals)] = 0.0
    return vals


def process_surface(lh_src, rh_src, name, threshold=2.3, lh_name=None, rh_name=None):
    """Native fsaverage surface overlay: per-vertex scalars (lh and/or rh) painted directly on the
    baked cortex sheet — no volume, no aseg classification, no blocky/smooth voxel geometry.
    Requires init_cortex() to have loaded the template surface. Returns a JSON meta string with
    surfaceOnly=True (so the engine forces representation='surface'); buffers are staged in
    _BUFFERS like process_nifti. Values are staged RAW so the shader thresholds live."""
    _BUFFERS.clear()
    if _CORTEX.get('lh') is None and _CORTEX.get('rh') is None:
        raise RuntimeError("process_surface needs the cortical surface loaded — call init_cortex() first.")
    # A missing hemisphere is None in CPython, but Pyodide hands a JS null across as a JsNull
    # proxy (not Python None), so normalise by type name — else bytes(JsNull) would blow up.
    def _present(x):
        return None if x is None or type(x).__name__ in ('JsNull', 'JsUndefined') else x
    vals_by_hemi = {}
    for hemi, src, fn in (('lh', _present(lh_src), lh_name), ('rh', _present(rh_src), rh_name)):
        if src is not None:
            vals_by_hemi[hemi] = _upsample_to_template(load_surface_map(src, fn), _CORTEX[hemi])
    if not vals_by_hemi:
        raise ValueError("process_surface got no readable hemisphere (both lh and rh were empty).")

    # Colour scale + sign from the SUPRA-threshold vertices only (matches process_nifti, and
    # ignores the medial-wall zeros / sub-threshold noise).
    supra = np.concatenate([v[np.abs(v) >= threshold] for v in vals_by_hemi.values()]) \
        if vals_by_hemi else np.array([], np.float32)
    diverging = bool(supra.size and supra.min() < 0 and supra.max() > 0)
    negative_only = bool(supra.size and (supra < 0).any() and not (supra > 0).any())
    abs_vals = np.abs(supra[supra != 0])
    max_abs = max(float(np.percentile(abs_vals, 99)), 1e-10) if abs_vals.size else 1.0

    meta = {
        'name': name,
        'threshold': float(threshold),
        'maxAbsValue': max_abs,
        'maxClusterSize': 0,                # no volume clustering on a surface (M-surface: no -k)
        'diverging': diverging,
        'negativeOnly': negative_only,
        'regionCounts': {},
        'structures': {},                   # NO blocky/smooth voxel geometry
        'surfaceOnly': True,                # engine forces representation='surface'; UI hides blocky/smooth
        'surface': _stage_surface(vals_by_hemi),
    }
    return json.dumps(meta)


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
    """Exposed voxel faces in centre-index coordinates, with per-voxel scalars.

    A NIfTI affine maps integer indices to voxel centres. A voxel at index ``i``
    therefore spans ``i - 0.5`` to ``i + 0.5`` before the full affine transform.
    """
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
        quad_verts = (voxels[:, np.newaxis, :] + corners[np.newaxis, :, :] - 0.5).reshape(-1, 3)
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
    # Vectorized gather + label->category LUT (replaces the per-voxel Python loop; byte-identical
    # masks, guarded by tests/test_pipeline_parity). In-bounds voxels get their aseg label; a LUT
    # maps each label to a structure-category index (-1 = unclassified).
    shp = np.array(aseg_data.shape)
    inb = np.all((aseg_ijk >= 0) & (aseg_ijk < shp), axis=1)
    labels = np.zeros(len(nz_ijk), dtype=np.int64)
    ii = aseg_ijk[inb]
    labels[inb] = aseg_data[ii[:, 0], ii[:, 1], ii[:, 2]]
    cat_index = {cat: i for i, cat in enumerate(structure_categories)}
    maxlbl = int(max(int(aseg_data.max()), max((int(k) for k in categories), default=0))) + 1
    lut = np.full(maxlbl, -1, dtype=np.int64)
    for lbl, cat in categories.items():
        if 0 <= int(lbl) < maxlbl and cat in cat_index:
            lut[int(lbl)] = cat_index[cat]
    cat_of = np.where(inb, lut[np.clip(labels, 0, maxlbl - 1)], -1)
    masks = {}
    for cat, ci in cat_index.items():           # structure_categories order (stable buffer staging)
        sel = cat_of == ci
        if sel.any():
            m = np.zeros(data.shape, dtype=bool)
            v = nz_ijk[sel]
            m[v[:, 0], v[:, 1], v[:, 2]] = True
            masks[cat] = m
    return masks


# Memory guards for the per-component 0.5 mm upsample. zoom = vox / target_mm, so at 2 mm each
# component's bounding box grows ~64x in voxel count before Gaussian smoothing + marching cubes.
# A pathologically large low-threshold component (e.g. a near-whole-brain blob) can allocate
# several GB and OOM the browser tab (Pyodide/WASM). Cap the upsampled voxel count per component
# and coarsen that one component's resolution when it would exceed the budget. Sparse activation
# maps retain the generous legacy cap and therefore stay byte-identical. Dense continuous maps
# use a much smaller cap: their native grid is already only 2-3 mm, so a ~1-2 mm display mesh is
# visually smooth without manufacturing hundreds of MB of scientifically meaningless 0.5 mm
# geometry for every overlay.
SMOOTH_MAX_UPSAMPLED_VOXELS = 40_000_000   # ~160 MB per float32 array; keeps the working set ~<1 GB
DENSE_MAP_MIN_CLASSIFIED_VOXELS = 8_000
DENSE_SMOOTH_MAX_UPSAMPLED_VOXELS = 500_000


def smooth_mesh_budget(categories):
    """Return a per-component upsample budget for a classified overlay.

    ``None`` preserves the original high-resolution path. A dense whole-brain/effect map gets a
    tighter budget so threshold=0 is practical in a browser, while its native values and spatial
    support remain untouched.
    """
    n_voxels = sum(int(np.count_nonzero(mask)) for mask in categories.values())
    return DENSE_SMOOTH_MAX_UPSAMPLED_VOXELS if n_voxels >= DENSE_MAP_MIN_CLASSIFIED_VOXELS else None


def build_smooth_mesh(mask, signed_data, affine, sigma_mm=1.0, target_mm=0.5,
                      pad=2, cluster_data=None, max_upsampled_voxels=None,
                      warn_on_coarsen=True):
    """Per-component upsample + Gaussian smooth + marching cubes -> world mesh."""
    vox = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
    zoom = vox / target_mm
    sigma_vox = sigma_mm / target_mm
    # Include real background beyond the image boundary, not a clipped crop whose
    # occupied edge is reflected by the Gaussian filter. Three sigma of background
    # also keeps high-resolution images from truncating the smoothing kernel.
    padding = np.maximum(pad, np.ceil(3 * sigma_mm / vox).astype(int))
    padding = np.maximum(padding, 1)
    budget = (SMOOTH_MAX_UPSAMPLED_VOXELS if max_upsampled_voxels is None
              else max_upsampled_voxels)
    labels, n_comp = ndimage.label(mask)
    all_v, all_f, all_vals, all_clu, offset = [], [], [], [], 0
    for lab in range(1, n_comp + 1):
        comp = labels == lab
        idx = np.argwhere(comp)
        lo = idx.min(0) - padding
        hi = idx.max(0) + padding + 1
        source_lo = np.maximum(lo, 0)
        source_hi = np.minimum(hi, np.array(mask.shape))
        sl = tuple(slice(a, b) for a, b in zip(source_lo, source_hi))
        outside = tuple(zip(source_lo - lo, hi - source_hi))
        # Per-component resolution: coarsen only when this component's upsample blows the budget,
        # otherwise use the exact default zoom/sigma so normal output stays byte-identical.
        c_zoom, c_sigma_vox = zoom, sigma_vox
        up_count = float(np.prod((hi - lo) * c_zoom))
        if up_count > budget:
            scale = (budget / up_count) ** (1.0 / 3.0)   # <1, isotropic coarsen
            c_zoom = zoom * scale
            c_sigma_vox = sigma_vox * scale
            msg = (f"smooth mesh: a component would upsample to {up_count / 1e6:.1f}M voxels "
                   f"(> {budget / 1e6:.1f}M cap); coarsening its smoothing "
                   f"resolution to ~{target_mm / scale:.2f} mm (blockier) to stay within memory.")
            if warn_on_coarsen:
                warnings.warn(msg, stacklevel=2)
                print("WARNING:", msg)
        sub_occ = np.pad(comp[sl].astype(np.float32), outside)
        sub_val = np.pad(signed_data[sl].astype(np.float32), outside)
        zero = sub_val == 0
        if zero.any() and (~zero).any():
            ind = ndimage.distance_transform_edt(zero, return_distances=False, return_indices=True)
            sub_val = sub_val[tuple(ind)]
        occ = ndimage.gaussian_filter(ndimage.zoom(sub_occ, c_zoom, order=1), c_sigma_vox)
        if occ.max() < 0.5:
            continue
        val = ndimage.zoom(sub_val, c_zoom, order=1)
        verts, faces, _, _ = measure.marching_cubes(occ, level=0.5)
        vert_vals = ndimage.map_coordinates(val, verts.T, order=1)
        if cluster_data is not None:
            sub_clu = np.pad(cluster_data[sl].astype(np.float32), outside)
            czero = sub_clu == 0
            if czero.any() and (~czero).any():
                ind = ndimage.distance_transform_edt(czero, return_distances=False, return_indices=True)
                sub_clu = sub_clu[tuple(ind)]
            clu = ndimage.zoom(sub_clu, c_zoom, order=0)
            all_clu.append(ndimage.map_coordinates(clu, verts.T, order=0).astype(np.float32))
        # scipy.ndimage.zoom's default grid_mode=False aligns the FIRST and LAST
        # input voxel centres with the output endpoints. Its requested zoom is not
        # the coordinate scale: output lengths are rounded, and the centre-to-centre
        # extent is (length - 1). Using verts / c_zoom shifts and stretches the mesh,
        # even for an integer zoom. Recover the exact input coordinates instead.
        native_step = np.divide(
            np.asarray(sub_occ.shape, dtype=float) - 1,
            np.asarray(occ.shape, dtype=float) - 1,
            out=np.zeros(3, dtype=float),
            where=np.asarray(occ.shape) > 1,
        )
        native_idx = lo[np.newaxis, :] + verts * native_step[np.newaxis, :]
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


def _stage_cut_volume(data, cluster_data, affine):
    """Stage a compact, world-registered statistical grid for the MRI cut face.

    Geometry alone cannot reproduce a value map on an arbitrary cut plane.  Keep the
    thresholded values plus live cluster sizes in a cropped two-channel float texture.
    WebGL 3D textures are x-fastest, hence the Fortran-order flattening before the two
    channels are interleaved.  The cropped affine still maps voxel (0,0,0) exactly into
    source-world space.
    """
    ijk = np.argwhere(data != 0)
    if not len(ijk):
        return None
    lo = np.maximum(ijk.min(axis=0) - 1, 0)
    hi = np.minimum(ijk.max(axis=0) + 2, data.shape)
    sl = tuple(slice(int(lo[d]), int(hi[d])) for d in range(3))
    vals = np.asarray(data[sl], np.float32)
    clusters = np.asarray(cluster_data[sl], np.float32)

    packed = np.empty(vals.size * 2, np.float32)
    packed[0::2] = vals.ravel(order='F')
    packed[1::2] = clusters.ravel(order='F')
    buf, _ = _stage(packed, np.float32)

    shift = np.eye(4)
    shift[:3, 3] = lo
    cropped_affine = np.asarray(affine, dtype=float) @ shift
    return {
        'buffer': buf,
        'dims': [int(x) for x in vals.shape],
        'affine': cropped_affine.tolist(),
        'channels': 2,
        'channelOrder': ['value', 'clusterSize'],
        'order': 'x-fastest-interleaved',
    }


def process_nifti(src, name, threshold=2.3, classify=True, surface=False):
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
    smooth_budget = smooth_mesh_budget(cats)

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
        sv, sf, svals, sclu = build_smooth_mesh(
            mask, cat_data, affine, cluster_data=cat_clu,
            max_upsampled_voxels=smooth_budget,
            warn_on_coarsen=smooth_budget is None,
        )
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
        'regionCounts': {cat: int(m.sum()) for cat, m in cats.items()},   # M10: supra-threshold voxels per region
        'structures': structures,
        'adaptiveSmooth': smooth_budget is not None,
    }
    cut_volume = _stage_cut_volume(data, cluster_data, affine)
    if cut_volume is not None:
        meta['cutVolume'] = cut_volume
    # Surface-projection meshes (M8): the cortex sheet per hemi, sampled from this volume.
    if surface and (_CORTEX['lh'] is not None or _CORTEX['rh'] is not None):
        meta['surface'] = build_surface_projection(data, affine)
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
