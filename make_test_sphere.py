# %% Make a synthetic NIfTI sphere with radial gradient at MNI origin, 3mm res
import numpy as np
import nibabel as nib

# MNI152 3mm grid
voxsize = 3.0
shape = (61, 73, 61)
affine = np.array([
    [-voxsize, 0., 0.,  90.],
    [0., voxsize, 0., -126.],
    [0., 0., voxsize,  -72.],
    [0., 0., 0.,         1.],
])

data = np.zeros(shape, dtype=np.float32)

# Sphere centred at MNI (0, 0, 0)
inv_affine = np.linalg.inv(affine)
center_vox = (inv_affine @ np.array([0., 0., 0., 1.]))[:3]

ii, jj, kk = np.mgrid[:shape[0], :shape[1], :shape[2]]
dist = np.sqrt(
    (ii - center_vox[0])**2 +
    (jj - center_vox[1])**2 +
    (kk - center_vox[2])**2
)

# Sphere radius 15mm = 5 voxels at 3mm
radius_vox = 5.0
mask = dist < radius_vox

# Radial gradient: peak=5 at centre, falls to threshold at edge
data[mask] = 5.0 * (1.0 - dist[mask] / radius_vox)

img = nib.Nifti1Image(data, affine)
nib.save(img, 'test_sphere.nii.gz')

n_active = mask.sum()
print(f"Sphere: {n_active} voxels, peak={data.max():.1f}, voxsize={voxsize}mm, centre_vox={center_vox}")
