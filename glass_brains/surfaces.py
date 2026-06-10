"""FreeSurfer surface loading, MNI305→MNI152 transform, curvature processing."""

import numpy as np
import nibabel as nib
import trimesh
from pathlib import Path


# MNI305-to-MNI152 affine (Freesurfer's talairach.xfm inverse applied to MNI152).
# From: https://surfer.nmr.mgh.harvard.edu/fswiki/CoordinateSystems
# This is the standard 4x4 matrix that maps fsaverage (MNI305) coords to MNI152.
MNI305_TO_MNI152 = np.array([
    [ 0.9975,  -0.0073,   0.0176,  -0.0429],
    [ 0.0146,   1.0009,  -0.0024,   1.5496],
    [-0.0130,  -0.0093,   0.9971,   1.1840],
    [ 0.0,      0.0,      0.0,      1.0   ],
])


def load_hemisphere(surf_dir, hemi):
    """Load pial surface + curvature for one hemisphere.

    Parameters
    ----------
    surf_dir : str or Path
        Path to FreeSurfer surf/ directory.
    hemi : str
        'lh' or 'rh'.

    Returns
    -------
    vertices : ndarray, shape (n_vertices, 3)
    faces : ndarray, shape (n_faces, 3)
    curvature : ndarray, shape (n_vertices,)
    """
    surf_dir = Path(surf_dir)
    coords, faces = nib.freesurfer.read_geometry(str(surf_dir / f'{hemi}.pial'))
    curv = nib.freesurfer.read_morph_data(str(surf_dir / f'{hemi}.curv'))
    return coords, faces, curv


def load_surface_file(path):
    """Load a cortical surface mesh for a custom template (M9): FreeSurfer geometry
    (lh.pial / lh.white / ...), GIFTI (.gii), or any mesh trimesh reads (.glb/.ply/.obj/.stl).
    Returns (vertices, faces). Curvature, if any, is supplied separately."""
    p = str(path)
    name = Path(p).name.lower()
    if name.endswith((".gii", ".gii.gz")):
        g = nib.load(p)
        pts = g.get_arrays_from_intent("NIFTI_INTENT_POINTSET")[0].data
        tris = g.get_arrays_from_intent("NIFTI_INTENT_TRIANGLE")[0].data
        return np.asarray(pts), np.asarray(tris)
    if any(name.endswith(e) for e in (".glb", ".gltf", ".ply", ".obj", ".stl", ".off")):
        m = trimesh.load(p, process=False)
        return np.asarray(m.vertices), np.asarray(m.faces)
    coords, faces = nib.freesurfer.read_geometry(p)   # FreeSurfer geometry
    return np.asarray(coords), np.asarray(faces)


def mni305_to_mni152(vertices):
    """Transform vertices from MNI305 (fsaverage) to MNI152 space.

    Parameters
    ----------
    vertices : ndarray, shape (n, 3)

    Returns
    -------
    transformed : ndarray, shape (n, 3)
    """
    n = vertices.shape[0]
    homogeneous = np.hstack([vertices, np.ones((n, 1))])  # (n, 4)
    transformed = (MNI305_TO_MNI152 @ homogeneous.T).T    # (n, 4)
    return transformed[:, :3]


def curvature_contours(vertices, faces, curvature, level=0.0):
    """Extract line segments at curvature zero-crossings (gyral/sulcal boundaries).

    Uses edge-based interpolation: for each triangle edge where curvature
    crosses the level, interpolate the crossing point.

    Parameters
    ----------
    vertices : ndarray, shape (n_vertices, 3)
    faces : ndarray, shape (n_faces, 3)
    curvature : ndarray, shape (n_vertices,)
    level : float
        Curvature level for contour extraction.

    Returns
    -------
    segments : ndarray, shape (n_segments, 2, 3)
        Pairs of 3D points forming line segments.
    """
    shifted = curvature - level
    segments = []

    for tri in faces:
        vals = shifted[tri]
        signs = np.sign(vals)

        # Count sign changes — need exactly 2 crossing points for a segment
        crossings = []
        edges = [(0, 1), (1, 2), (2, 0)]
        for i, j in edges:
            if signs[i] != signs[j] and signs[i] != 0 and signs[j] != 0:
                # Linear interpolation
                t = vals[i] / (vals[i] - vals[j])
                pt = vertices[tri[i]] * (1 - t) + vertices[tri[j]] * t
                crossings.append(pt)

        if len(crossings) == 2:
            segments.append(crossings)

    if not segments:
        return np.empty((0, 2, 3))
    return np.array(segments)


def to_trimesh(vertices, faces, vertex_data=None):
    """Convert arrays to a trimesh.Trimesh, optionally attaching vertex data.

    Parameters
    ----------
    vertices : ndarray, shape (n, 3)
    faces : ndarray, shape (m, 3)
    vertex_data : dict, optional
        Keys are attribute names, values are per-vertex arrays.

    Returns
    -------
    mesh : trimesh.Trimesh
    """
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if vertex_data:
        for key, vals in vertex_data.items():
            mesh.vertex_attributes[key] = np.asarray(vals, dtype=np.float32)
    return mesh


def inflate_surfaces(surfaces, iterations=30, lamb=0.7):
    """Produce 'slightly inflated' copies by Laplacian-smoothing the pial surface
    (fills the sulci) and rescaling about the centroid to undo the shrinkage.

    The result stays centred and at the original size in MNI space, so overlay
    voxels still align; it just rounds out the folds for a cleaner, puffier glass
    shell. Higher `iterations` = more inflated.
    """
    from trimesh.smoothing import filter_laplacian
    out = {}
    for hemi, mesh in surfaces.items():
        m = mesh.copy()
        c0 = m.vertices.mean(axis=0)
        r0 = np.linalg.norm(m.vertices - c0, axis=1).mean()
        filter_laplacian(m, iterations=iterations, lamb=lamb)
        c1 = m.vertices.mean(axis=0)
        r1 = np.linalg.norm(m.vertices - c1, axis=1).mean()
        m.vertices = (m.vertices - c1) * (r0 / max(r1, 1e-6)) + c0
        out[hemi] = m
    return out


def load_template_surfaces(template='fsaverage', space='MNI152'):
    """Load both hemispheres from a template, transformed to the target space.

    Parameters
    ----------
    template : str
        'fsaverage' — uses mne.datasets.fetch_fsaverage to get the files.
    space : str
        'MNI152' applies the MNI305→MNI152 transform. 'MNI305' leaves as-is.

    Returns
    -------
    surfaces : dict
        Keys 'lh', 'rh', each a trimesh.Trimesh with curvature vertex attribute.
    """
    import mne
    fs_dir = Path(mne.datasets.fetch_fsaverage(verbose=False))
    surf_dir = fs_dir / 'bem' / 'fsaverage-head.fif'

    # mne's fsaverage ships surf files under bem/ or we find them directly
    # The fetch_fsaverage returns a directory; surfaces are in <dir>/surf/
    # Actually mne.datasets.fetch_fsaverage returns the subjects_dir path
    # and the fsaverage is at subjects_dir/fsaverage
    # But the newer mne returns the fsaverage dir directly
    surf_dir = fs_dir / 'surf'
    if not surf_dir.exists():
        # Try the subjects_dir layout
        surf_dir = fs_dir / 'fsaverage' / 'surf'

    surfaces = {}
    for hemi in ('lh', 'rh'):
        verts, faces, curv = load_hemisphere(surf_dir, hemi)
        if space == 'MNI152':
            verts = mni305_to_mni152(verts)
        mesh = to_trimesh(verts, faces, vertex_data={'curvature': curv})
        surfaces[hemi] = mesh

    return surfaces
