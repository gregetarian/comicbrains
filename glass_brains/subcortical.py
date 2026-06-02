"""Extract subcortical structures from FreeSurfer aseg.mgz via marching cubes."""

import numpy as np
import nibabel as nib
import trimesh
from scipy.ndimage import gaussian_filter
from skimage.measure import marching_cubes
from pathlib import Path


# FreeSurfer aseg label IDs and names for grey matter subcortical structures.
# Excludes: ventricles (4,5,14,15,43,44), white matter (2,41), CSF (24).
SUBCORTICAL_LABELS = {
    10: 'L-Thalamus',
    11: 'L-Caudate',
    12: 'L-Putamen',
    13: 'L-Pallidum',
    17: 'L-Hippocampus',
    18: 'L-Amygdala',
    26: 'L-Accumbens',
    49: 'R-Thalamus',
    50: 'R-Caudate',
    51: 'R-Putamen',
    52: 'R-Pallidum',
    53: 'R-Hippocampus',
    54: 'R-Amygdala',
    58: 'R-Accumbens',
    16: 'Brainstem',
    8:  'L-Cerebellum',
    47: 'R-Cerebellum',
}

# Default colours (RGB 0-1) for each structure
LABEL_COLORS = {
    'L-Thalamus':     (0.55, 0.75, 0.55),
    'R-Thalamus':     (0.55, 0.75, 0.55),
    'L-Caudate':      (0.48, 0.58, 0.82),
    'R-Caudate':      (0.48, 0.58, 0.82),
    'L-Putamen':      (0.82, 0.55, 0.55),
    'R-Putamen':      (0.82, 0.55, 0.55),
    'L-Pallidum':     (0.75, 0.75, 0.50),
    'R-Pallidum':     (0.75, 0.75, 0.50),
    'L-Hippocampus':  (0.85, 0.65, 0.45),
    'R-Hippocampus':  (0.85, 0.65, 0.45),
    'L-Amygdala':     (0.72, 0.52, 0.72),
    'R-Amygdala':     (0.72, 0.52, 0.72),
    'L-Accumbens':    (0.60, 0.80, 0.80),
    'R-Accumbens':    (0.60, 0.80, 0.80),
    'Brainstem':      (0.65, 0.65, 0.65),
    'L-Cerebellum':   (0.80, 0.70, 0.55),
    'R-Cerebellum':   (0.80, 0.70, 0.55),
}


def extract_structure(aseg_data, affine, label_id, sigma=0.5):
    """Extract a single subcortical structure as a smoothed isosurface mesh.

    Parameters
    ----------
    aseg_data : ndarray, shape (X, Y, Z)
        Segmentation volume (integer labels).
    affine : ndarray, shape (4, 4)
        Voxel-to-world affine.
    label_id : int
        FreeSurfer aseg label ID.
    sigma : float
        Gaussian smoothing sigma (voxels) applied before marching cubes.

    Returns
    -------
    mesh : trimesh.Trimesh or None
        Mesh in world coordinates, or None if label not found.
    """
    mask = (aseg_data == label_id).astype(np.float32)
    if mask.sum() < 10:
        return None

    # Smooth the binary mask for nicer isosurfaces
    smoothed = gaussian_filter(mask, sigma=sigma)

    verts, faces, _, _ = marching_cubes(smoothed, level=0.5)

    # Transform vertices from voxel to world coordinates
    n = verts.shape[0]
    homogeneous = np.hstack([verts, np.ones((n, 1))])
    world_verts = (affine @ homogeneous.T).T[:, :3]

    return trimesh.Trimesh(vertices=world_verts, faces=faces, process=False)


def extract_all_subcortical(template='fsaverage'):
    """Extract all subcortical structures from the template's aseg.

    Parameters
    ----------
    template : str
        'fsaverage' — uses mne to locate the aseg.mgz.

    Returns
    -------
    structures : dict[str, trimesh.Trimesh]
        Mapping from structure name to mesh.
    colors : dict[str, tuple]
        Mapping from structure name to RGB colour.
    """
    import mne
    fs_dir = Path(mne.datasets.fetch_fsaverage(verbose=False))
    aseg_path = fs_dir / 'mri' / 'aseg.mgz'
    if not aseg_path.exists():
        aseg_path = fs_dir / 'fsaverage' / 'mri' / 'aseg.mgz'

    if not aseg_path.exists():
        # fsaverage from mne doesn't always ship aseg.mgz
        # Return empty if not available
        return {}, LABEL_COLORS

    img = nib.load(str(aseg_path))
    data = np.asarray(img.dataobj)
    affine = img.affine

    structures = {}
    for label_id, name in SUBCORTICAL_LABELS.items():
        mesh = extract_structure(data, affine, label_id)
        if mesh is not None:
            structures[name] = mesh

    return structures, LABEL_COLORS
