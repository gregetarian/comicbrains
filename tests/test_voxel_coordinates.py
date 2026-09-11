"""Voxel geometry, classification and cut samples share NIfTI centre coordinates."""
import itertools
import json

import nibabel as nib
import numpy as np
import pytest

from comic import pipeline as P


def _affine(linear):
    affine = np.eye(4)
    affine[:3, :3] = linear
    affine[:3, 3] = [-20, 11, -7]
    return affine


AFFINES = [
    pytest.param(_affine(np.diag([1.5, 2.0, 3.0])), id="anisotropic"),
    pytest.param(_affine([[0, -2, 0], [1.5, 0, 0], [0, 0, 3]]), id="rotated"),
    pytest.param(_affine([[1.5, 0.4, 0.2], [0, 2, -0.3], [0, 0, 3]]), id="sheared"),
    pytest.param(_affine(np.diag([-1.5, 2.0, 3.0])), id="reflected"),
]


@pytest.mark.parametrize("affine", AFFINES)
def test_nifti_voxel_faces_classification_and_cut_agree_at_world_landmark(affine, monkeypatch):
    # Exercise the public pipeline, not just its mesh helper: all representations of
    # this synthetic landmark must use the same centre after the full input affine.
    monkeypatch.setattr(P, "_warn_if_not_mni", lambda *_: None)
    data = np.zeros((11, 13, 15), np.float32)
    centre = np.array([4, 5, 6])
    data[tuple(centre)] = 3.5
    img = nib.Nifti1Image(data, affine)
    # The NIfTI header stores affine coefficients as float32.
    affine = img.affine
    meta = json.loads(P.process_nifti(img.to_bytes(), "landmark.nii", 1.0, classify=False))
    blocky = meta["structures"]["volume"]["blocky"]
    positions = np.frombuffer(P.get_buffer(blocky["pos"]), np.float32).reshape(-1, 3)
    corners = centre + np.array(list(itertools.product([-0.5, 0.5], repeat=3)))
    expected = nib.affines.apply_affine(affine, corners)
    # Each of the eight physical corners belongs to three exposed faces.
    assert positions.shape == (24, 3)
    for corner in expected:
        assert np.count_nonzero(np.all(np.isclose(positions, corner, atol=2e-6), axis=1)) == 3
    world_centre = nib.affines.apply_affine(affine, centre)
    np.testing.assert_allclose(positions.mean(axis=0), world_centre, atol=2e-6)
    values = np.frombuffer(P.get_buffer(blocky["val"]), np.float32)
    assert np.all(values == data[tuple(centre)])

    cut = meta["cutVolume"]
    packed = np.frombuffer(P.get_buffer(cut["buffer"]), np.float32)
    cut_values = packed[0::2].reshape(cut["dims"], order="F")
    cut_index = np.argwhere(cut_values == 3.5)
    assert cut_index.shape == (1, 3)
    np.testing.assert_allclose(
        nib.affines.apply_affine(cut["affine"], cut_index[0]), world_centre, atol=2e-6,
    )

    # A segmentation with a different grid origin should still classify that same
    # physical voxel centre, regardless of rotation, shear or axis direction.
    shift = np.eye(4)
    shift[:3, 3] = [1, 1, 1]
    aseg = np.zeros(data.shape, np.uint8)
    aseg[tuple(centre - 1)] = 7
    categories = P.classify_overlay_voxels(
        data, affine, aseg, affine @ shift,
        categories={7: "landmark"}, structure_categories=["landmark"],
    )
    np.testing.assert_array_equal(categories["landmark"], data != 0)


def test_touching_voxels_share_a_face_and_keep_their_own_values():
    data = np.zeros((4, 4, 4), np.float32)
    data[1, 1, 1] = 3
    data[2, 1, 1] = -4
    verts, faces, (values,) = P._voxel_mesh(data != 0, data)
    # Two adjacent cubes expose ten faces; the internal face is omitted.
    assert verts.shape == (40, 3) and faces.shape == (20, 3)
    np.testing.assert_array_equal(verts.min(axis=0), [0.5, 0.5, 0.5])
    np.testing.assert_array_equal(verts.max(axis=0), [2.5, 1.5, 1.5])
    assert np.count_nonzero(values == 3) == np.count_nonzero(values == -4) == 20
    # Values at the left/right outside faces come from the owning voxel.
    assert np.all(values[verts[:, 0] == 0.5] == 3)
    assert np.all(values[verts[:, 0] == 2.5] == -4)


@pytest.mark.parametrize("affine", AFFINES)
@pytest.mark.parametrize("budget", [None, 12_000], ids=["default", "coarsened"])
def test_smooth_symmetric_blob_stays_centred_across_zoom_resolutions(affine, budget):
    mask = np.zeros((17, 19, 21), bool)
    mask[5:10, 6:11, 7:12] = True
    centre = np.array([7, 8, 9])
    data = np.where(mask, 3.5, 0).astype(np.float32)
    verts, faces, values, _ = P.build_smooth_mesh(
        mask, data, affine, max_upsampled_voxels=budget, warn_on_coarsen=False,
    )
    assert len(verts) > 0 and faces.max() < len(verts)
    native = nib.affines.apply_affine(np.linalg.inv(affine), verts)
    # A symmetric input cannot acquire an offset from interpolation or a memory
    # guard changing resolution. Test both bounding planes and mesh centroid.
    np.testing.assert_allclose((native.min(axis=0) + native.max(axis=0)) / 2, centre, atol=2e-6)
    np.testing.assert_allclose(native.mean(axis=0), centre, atol=2e-6)
    np.testing.assert_allclose(values, 3.5, atol=1e-6)


@pytest.mark.parametrize("affine", AFFINES)
def test_smooth_vertex_values_remain_registered_to_a_linear_scalar_field(affine):
    mask = np.zeros((17, 19, 21), bool)
    mask[5:10, 6:11, 7:12] = True
    # Extend an analytic field beyond the support mask so its interpolation has an
    # exact solution, independent of the nearest-value extension at masked edges.
    indices = np.indices(mask.shape)
    gradient = np.array([0.25, 0.5, 0.75])
    field = 2 + np.einsum("i,ijkl->jkl", gradient, indices)
    verts, _, values, _ = P.build_smooth_mesh(mask, field, affine)
    native = nib.affines.apply_affine(np.linalg.inv(affine), verts)
    np.testing.assert_allclose(values, 2 + native @ gradient, atol=3e-6, rtol=0)
