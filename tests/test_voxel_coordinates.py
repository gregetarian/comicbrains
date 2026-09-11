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


def _assert_closed_surface(faces):
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    _, counts = np.unique(np.sort(edges, axis=1), axis=0, return_counts=True)
    assert np.all(counts == 2), "each edge of a closed surface belongs to two faces"


@pytest.mark.parametrize("affine", AFFINES)
def test_fully_occupied_input_has_a_closed_registered_smooth_surface(affine):
    shape = (5, 6, 7)
    mask = np.ones(shape, bool)
    values = np.full(shape, 3.5, np.float32)
    clusters = np.full(shape, mask.size, np.float32)
    verts, faces, sampled, sampled_clusters = P.build_smooth_mesh(
        mask, values, affine, cluster_data=clusters,
    )
    assert len(verts) > 0
    _assert_closed_surface(faces)
    native = nib.affines.apply_affine(np.linalg.inv(affine), verts)
    # The occupancy isosurface encloses the image centre and stays at the occupied
    # voxel boundaries to within 0.01 voxel of interpolation/discretization error.
    assert np.all(native.min(axis=0) >= -0.51)
    assert np.all(native.max(axis=0) <= np.asarray(shape) - 0.49)
    np.testing.assert_allclose(
        (native.min(axis=0) + native.max(axis=0)) / 2,
        (np.asarray(shape) - 1) / 2, atol=2e-6,
    )
    assert np.all(native.min(axis=0) < (np.asarray(shape) - 1) / 2)
    assert np.all(native.max(axis=0) > (np.asarray(shape) - 1) / 2)
    np.testing.assert_allclose(sampled, 3.5, atol=1e-6)
    np.testing.assert_allclose(sampled_clusters, mask.size)


@pytest.mark.parametrize("axis", [0, 1, 2])
@pytest.mark.parametrize("side", ["low", "high"])
def test_blob_touching_an_image_face_is_closed_without_a_coordinate_shift(axis, side):
    shape = np.array([11, 12, 13])
    start = np.array([3, 4, 5])
    stop = start + 4
    if side == "low":
        start[axis], stop[axis] = 0, 4
    else:
        start[axis], stop[axis] = shape[axis] - 4, shape[axis]
    mask = np.zeros(shape, bool)
    mask[tuple(slice(a, b) for a, b in zip(start, stop))] = True
    affine = _affine([[0, -2, 0.3], [1.5, 0, 0], [0, 0, 3]])
    verts, faces, _, _ = P.build_smooth_mesh(mask, np.where(mask, 3.5, 0), affine)
    assert len(verts) > 0
    _assert_closed_surface(faces)
    native = nib.affines.apply_affine(np.linalg.inv(affine), verts)
    assert np.all(native.min(axis=0) >= start - 0.51)
    assert np.all(native.max(axis=0) <= stop - 0.49)
    np.testing.assert_allclose(
        (native.min(axis=0) + native.max(axis=0)) / 2, (start + stop - 1) / 2, atol=2e-6,
    )


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_single_voxel_thick_input_retains_physical_thickness(axis):
    shape = np.array([6, 7, 8])
    shape[axis] = 1
    affine = _affine(np.diag([2., 2., 2.]))
    mask = np.ones(shape, bool)
    verts, faces, _, _ = P.build_smooth_mesh(mask, np.full(shape, 3.5), affine)
    assert len(verts) > 0
    _assert_closed_surface(faces)
    native = nib.affines.apply_affine(np.linalg.inv(affine), verts)
    assert -0.51 <= native[:, axis].min() < 0 < native[:, axis].max() <= 0.51
    np.testing.assert_allclose(
        (native.min(axis=0) + native.max(axis=0)) / 2, (shape - 1) / 2, atol=2e-6,
    )


@pytest.mark.parametrize("shape", [(1, 1, 1), (1, 5, 5)])
def test_tiny_fully_occupied_nifti_keeps_blocky_fallback_if_smoothing_removes_it(shape, monkeypatch):
    monkeypatch.setattr(P, "_warn_if_not_mni", lambda *_: None)
    affine = _affine(np.diag([1., 1., 1.]))
    image = nib.Nifti1Image(np.full(shape, 3.5, np.float32), affine)
    meta = json.loads(P.process_nifti(image.to_bytes(), "tiny.nii", 1.0, classify=False))
    entry = meta["structures"]["volume"]
    assert entry["smooth"] == entry["blocky"]
    pos = np.frombuffer(P.get_buffer(entry["smooth"]["pos"]), np.float32).reshape(-1, 3)
    native = nib.affines.apply_affine(np.linalg.inv(affine), pos)
    np.testing.assert_allclose(native.min(axis=0), -np.ones(3) / 2)
    np.testing.assert_allclose(native.max(axis=0), np.asarray(shape) - 0.5)


def test_loader_only_removes_nonspatial_singleton_dimensions(monkeypatch):
    monkeypatch.setattr(P, "_warn_if_not_mni", lambda *_: None)
    affine = _affine(np.diag([1., 2., 3.]))
    singleton_frame = nib.Nifti1Image(np.ones((1, 5, 6, 1), np.float32), affine)
    data, loaded_affine = P.load_stat_map(singleton_frame.to_bytes(), "slab.nii", 0)
    assert data.shape == (1, 5, 6)
    np.testing.assert_array_equal(loaded_affine, affine)
    timeseries = nib.Nifti1Image(np.ones((1, 5, 6, 4), np.float32), affine)
    with pytest.raises(ValueError, match="Expected a 3D statistical map"):
        P.load_stat_map(timeseries.to_bytes(), "timeseries.nii", 0)
