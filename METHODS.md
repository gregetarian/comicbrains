# Glass Brains 2.0 — Methods

How a NIfTI statistical map is turned into the rendered glass-brain figure.
The pipeline has two halves: a **Python asset builder** (surfaces + voxel meshes
+ colour LUTs → GLB/JSON) and a **config-driven Three.js renderer** (the same
config drives the interactive browser viewer and the headless PNG renderer, so
figures match the interactive view).

> This document supersedes the original PyVista/VTK prototype; none of that
> approach remains in the codebase.

---

## 1. Data sources

- **Template:** `fsaverage`, fetched via `mne.datasets.fetch_fsaverage()` and
  cached under `~/mne_data/`. Cortical **pial** surfaces (163,842 verts/hemi)
  and the `aseg.mgz` subcortical segmentation.
- **Space:** vertices are transformed MNI305 → **MNI152** with the standard
  FreeSurfer 4×4 affine (~2 mm accuracy — sufficient for visualisation; for
  publication-grade alignment a Registration-Fusion mapping would be needed).

## 2. Cortical surfaces — `surfaces.py`

- **Pial** surfaces are loaded and MNI-transformed as the outer cortical
  boundary visible in glass-brain views.
- **Inflated** variant: Laplacian smoothing (`trimesh.smoothing.filter_laplacian`,
  ~30 iterations, λ=0.7) then rescaled about the centroid to preserve overall
  size. Rationale: a gently inflated surface exposes sulcal voxels that the
  folded pial hides. (Taubin smoothing was tried but produced a ~0 mm net shift
  and less inflation.) Both variants ship; the viewer switches between them.

## 3. Subcortical / cerebellar surfaces — `subcortical.py`

Per `aseg` label: binary mask → Gaussian smoothing → `skimage.measure.marching_cubes`
(level 0.5) → world transform via the aseg affine → Taubin cleanup. Cerebellum
uses heavier smoothing (folia are noisy). These render as faint glass shells in
the dedicated subcortical panels.

## 4. Stat-map loading & thresholding — `overlays.load_stat_map`

`|value| < threshold → 0` (default z>2.3). The full (down-to-threshold) voxel
set is baked, so the interactive **threshold slider** can re-filter live in the
shader without re-exporting.

## 5. Voxel → structure classification — `overlays.classify_overlay_voxels`

Each non-zero overlay voxel is mapped to its `aseg` label (overlay→world→aseg
affine round-trip) and bucketed into a category: `lh_cortex`, `rh_cortex`,
`subcort_l/r`, `cereb_l/r`, `brainstem`. This lets each panel show only the
geometry it should (e.g. a left-lateral panel hides the right hemisphere) with
no name string-matching downstream.

## 6. Cluster-extent sizing — `overlays.cluster_sizes`

Connected-component labelling (`scipy.ndimage.label`) on the supra-threshold
mask, **positive and negative blobs labelled separately** (26-connectivity, the
FSL `cluster` default), assigning every voxel its cluster's size in voxels.

- **Rationale:** drives the **cluster-extent threshold** — hide clusters smaller
  than *k* voxels. Baked per-vertex (`aClusterSize`) so it filters live in the
  shader, exactly like the intensity threshold.
- **Assumption:** sizes are computed at the *bake* threshold; raising the live
  intensity threshold above it makes the displayed cluster sizes an upper bound.

## 7. Voxel meshing — `overlays.py`

Two representations are baked per structure; the viewer chooses one live.

- **Blocky** (`_voxel_mesh`): exposed-face extraction — for each of the 6 axis
  directions, emit a quad only where a voxel face is adjacent to empty space.
  This yields watertight, self-occluding clusters at a fraction of a full
  hexahedral mesh. Each scalar field (signed value, cluster size) is sampled
  per emitted vertex.
- **Smooth** (`build_smooth_mesh`): per connected component, upsample to a
  0.5 mm grid, Gaussian-smooth the occupancy, `marching_cubes(level=0.5)`. The
  value field is **nearest-filled** before sampling so boundary vertices keep
  saturated colours instead of fading toward zero.

## 8. Colour — `overlays._normalize_for_cmap`, `colormaps.py`, `viewer/core/colormap.js`

- **Normalisation:** power-law (`gamma`, default 0.5 = sqrt) pushes mid-range
  magnitudes toward the saturated ends. `max_abs` = 99th percentile of |value|.
- **Sequential vs diverging:** chosen automatically from whether the data has
  both signs. **Washout guard:** if a *diverging* map is used on *positive-only*
  data, `t` is remapped into the LUT's upper half (0.5–1.0) so values never
  collapse onto the white centre.
- **Single colour authority:** colormaps are exported as 256×3 sRGB **LUTs**
  (`colormaps.json`) from the `cmap` catalogue; the JS recolours voxels from the
  per-vertex value sidecar, so the interactive and headless images are identical
  and there is no Python/JS colour drift.

## 9. Asset export — `export.py`

Per overlay structure: a GLB mesh (+ smooth variant) and JSON sidecars for the
per-vertex `values` and `clusters`. Plus `scene.json` (the manifest:
cortex/subcortical/overlay mesh paths, hemispheres, categories, `maxAbsValue`,
`maxClusterSize`, `diverging`), `colormaps.json`, and `render-config.json`
(preset + style). The whole `viewer/` directory is copied alongside.

## 10. Render pipeline — `viewer/scene/*`, `viewer/core/*`

Pure, unit-tested **core** (no THREE/DOM) + thin three.js adapters.

- **Config** (`core/config-schema.js`) is the single source of truth; the
  browser and headless hosts differ only in canvas source / output sink.
- **Cameras** (`core/cameras.js`): named anatomical planes. A fixed oblique
  **world-space tilt** is applied to every view as a depth cue, kept
  right-handed (positive-determinant) so lighting stays correct and L/R laterals
  stay mirror-consistent.
- **Framing** (`core/framing.js`): each panel auto-frames the geometry it shows
  (tight fill, near-hemisphere only fall out for free). A **shared world scale**
  gives every whole-brain panel one mm-per-pixel, so each brain is the same
  physical size across the figure (the largest-footprint view fills its cell;
  the rest render smaller, centred).
- **Glass cortex** (`scene/materials.js`): fresnel transparency + cel banding,
  lit by a view-space headlight; depth-writing so it never "snaps" opacity.
- **Voxels** (`scene/materials.js`): `MeshPhong`, **always opaque** (they occlude
  each other via the depth buffer regardless of how faded they look). Injected
  shader discards (`|value|<threshold`, `clusterSize<k`, positive-only), an
  **emissive** term that shows the flat colormap colour, a **logarithmic depth
  veil** that tints deep voxels toward white (a colour effect anchored to the
  nearest real voxel vertex — never an alpha change), and a **light-independent
  specular glint** so shine works even with the scene lights at zero.
- **Outline passes** (`scene/passes.js`): view-space depth is rendered to a
  float target and a screen-space pass detects depth discontinuities → silhouette
  lines. Two layers: the black cortex outline (layer 0) and faint per-voxel edges
  (layer 1, threshold/cluster-aware, veil-faded). The black surface outline draws
  **over** voxel edges but is **depth-clipped** so a voxel genuinely in front of
  the surface still shows its own edge.
- **Lighting:** directional headlight + ambient (both **0** by default — colour
  comes from emissive + glint, keeping voxels saturated).

## 11. Headless rendering — `render.py`, `app/headless-entry.js`

`render_to_png` exports assets, writes a `render-config.json`, serves it, and
screenshots the `#viewer` element via **Playwright + headless Chromium**
(`--use-gl=angle --use-angle=swiftshader`). Multi-panel compositing is free (one
scissored canvas → one screenshot) and the result is deterministic. CLI figures
apply a few print-specific defaults over the interactive style (thicker surface
lines, slightly looser framing, no subcortical shell, a larger colorbar scaled
to the figure) — all overridable by flags.

## 12. Verification

- **Pure core:** `node --test` in `viewer/` guards the load-bearing maths —
  camera bases are right-handed (medials light correctly), world-space tilt makes
  L/R mirror-consistent, framing fits a known AABB, grid cells tile exactly,
  hemisphere/category visibility filters, and the colormap positive-only guard
  never lands on a diverging white centre.
- **Headless smoke:** `glass-brains render test_sphere.nii.gz -o /tmp/out.png`
  (generate the volume with `python make_test_sphere.py`).
