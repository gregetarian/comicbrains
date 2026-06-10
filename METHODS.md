# Glass Brains 2.0 — Methods

How a NIfTI statistical map becomes a rendered glass-brain figure. There is ONE
meshing backend (`glass_brains/pipeline.py`) and ONE rendering engine (the
Three.js viewer under `glass_brains/web/`). The same files run three ways:

- **Browser** (GitHub Pages / `glass-brains open`): uploads are meshed in-browser
  by a byte-identical Pyodide copy of `pipeline.py`; the engine renders live.
- **Standalone CLI** (`glass-brains render`): `pipeline.py` runs in CPython
  in-process, geometry is written as arrays, and the *same* engine is driven
  headlessly in Playwright/Chromium to screenshot a PNG.
- **Python** (`glass_brains.render.render_to_png`): the function the CLI calls.

> This document supersedes the original PyVista/VTK prototype AND the later
> GLB-per-overlay `overlays.py`/`export.py`-overlay path. Per-upload meshing now
> emits raw geometry **arrays**, not GLB, and there is no `overlays.py`.

---

## 1. Data sources & the one-time bake — `bake.py`

Fixed `fsaverage` assets are baked once (needs the `[bake]` extra: mne/trimesh/cmap)
into `glass_brains/web/data/`:

- Cortical **pial** + **inflated** surface GLBs per hemisphere (curvature in the
  vertex-colour red channel — currently UNUSED by the glass material).
- Subcortical structure GLBs (one solid-colour mesh each).
- `aseg_uint8.bin.gz` + `aseg.json`: the FreeSurfer `aseg` segmentation as gzipped
  uint8 256³ plus a sidecar (dims, affine) — the volume used for voxel→region
  classification at runtime.
- `colormaps.json`: 256×3 sRGB LUTs sampled from the `cmap` catalogue.
- `scene.json` (base manifest, no overlays), `render-config.json` (default preset
  + style), and a pre-baked `demo/` overlay (instant landing render, no Pyodide).
- `bake()` also copies `pipeline.py` → `web/pyodide/pipeline.py` so the two stay
  byte-identical (guarded by `tests/test_pyodide_sync.py`).

Space: MNI305 → **MNI152** via the standard FreeSurfer 4×4 affine in `surfaces.py`
(~2 mm; visualisation-grade).

## 2. Stat-map loading & thresholding — `pipeline.load_stat_map`

Loads a NIfTI from a path (CLI) or raw bytes (browser upload). Bytes are written
to a temp file with the extension chosen from the gzip magic (`1f 8b`) so a
mislabelled `.nii` upload still decompresses correctly. The volume is squeezed to
3D (a 4D timeseries raises), then `|value| < threshold → 0` (default z = 2.3).
Non-finite voxels (NaN/±inf) are zeroed before thresholding so they cannot poison
the percentile clim. Returns `(data, affine)`.

## 3. Voxel → structure classification — `pipeline.classify_overlay_voxels`

Each non-zero overlay voxel is mapped to its `aseg` label via an
overlay-ijk → world → `inv(aseg_affine)` → aseg-ijk round-trip and bucketed into a
category: `lh_cortex`, `rh_cortex`, `subcort_l/r`, `cereb_l/r`, `brainstem`. This
lets each panel show only the geometry it should (e.g. a left-lateral panel hides
the right hemisphere) with no downstream string matching.

## 4. Cluster-extent sizing — `pipeline.cluster_sizes`

Connected-component labelling (`scipy.ndimage.label`, 26-connectivity = the FSL
`cluster` default), **positive and negative blobs labelled separately**, assigning
every voxel its cluster's size in voxels.

- Drives the **cluster-extent threshold** (hide clusters smaller than *k* voxels),
  applied live in the shader from the per-vertex cluster-size attribute.
- Sizes are computed at the bake threshold; raising the live intensity threshold
  above it makes displayed cluster sizes an upper bound.

## 5. Voxel meshing — `pipeline.py`

Two representations are produced per structure; the engine chooses one live.

- **Blocky** (`_voxel_mesh`): exposed-face extraction — for each of the 6 axis
  directions emit a quad only where a voxel face abuts empty space. Watertight,
  self-occluding clusters at a fraction of a full hexahedral mesh. Each scalar
  field (signed value, cluster size) is sampled per emitted vertex.
- **Smooth** (`build_smooth_mesh`): per connected component, upsample to a 0.5 mm
  grid, Gaussian-smooth the occupancy, `marching_cubes(level=0.5)`, transform to
  world via the overlay affine. The value field is **nearest-filled** before
  sampling so boundary vertices keep saturated colour. Tiny clusters that yield no
  marching-cubes surface fall back to the blocky geometry (smooth mode never
  silently hides them).

`process_nifti(src, name, threshold)` runs the whole chain and returns a JSON
meta string (`name`, `threshold`, `maxAbsValue` = 99th percentile of |value| over
classified voxels, `maxClusterSize`, `diverging` = data has both signs,
`structures` referencing staged buffer indices). The raw geometry arrays
(positions/faces/values/clusters) are staged in `_BUFFERS`. **No colour is emitted
— the JS engine is the single colour authority.**

## 6. Geometry handoff — `arrays.py` (CLI/Python) & Pyodide (browser)

- Browser: `get_all_buffers()` returns the staged buffers; JS reconstructs typed
  arrays and builds meshes directly.
- CLI/Python: `arrays.write_overlay_arrays(data_dir, meta, buffers, index)`
  concatenates the buffers into `overlay_<i>.bin` and records `bufferLayout`
  ([offset, length] per buffer) + `buffersFile` in `scene.json`'s `overlays` list.
  The viewer's asset-loader slices the `.bin` back into the same per-buffer arrays
  — the exact code path the browser uses for an upload.

## 7. Config — `web/core/config-schema.js`

The single source of truth for a viewer config, driving BOTH the browser and the
headless renderer. `DEFAULTS{render, style, layout}`; `normalizeConfig` deep-merges
over the defaults and validates; `overlayStyle(cfg, i)` resolves the effective
per-overlay style (per-NIfTI overrides in `style.overlays[i]` over the globals);
`validateConfig` enforces load-bearing invariants (every panel has an id + camera
and is positioned by EXACTLY ONE of `cell{row,col}` or `place{x,y,w,h}`).

- `style.voxel.{representation, clusterMin, smoothing, shininess, specular,
  emissive, veil, edges}`, `style.{colormap, colormapMode, threshold,
  positiveOnly, gamma, margin, cortexSurface}`, `glass`, `anatomy`, `outline`,
  `lighting`, `tilt`, `shadows`.
- `layout.{mode:'grid'|'free', grid, canvas{w,h,bgAlpha}, panels[]}`; a panel
  carries `content{roles, hemisphere, categories, representation, anatomyStyle,
  anatomyHemisphere}`, `camera{plane}` or `{pose}`, `framing`, and (free mode)
  `rotate` / `slice`.

## 8. Colour — `web/core/colormap.js`

The single colour authority (identical in browser and headless).

- **Normalisation:** power-law (`gamma`, default 0.5 = sqrt). `maxAbs` = the
  per-overlay 99th percentile from `process_nifti`.
- **Mode:** `diverging` (symmetric about 0) vs `sequential`, auto-chosen from the
  data's sign content unless `colormapMode` forces it.
- **Washout guards:** if a *diverging* LUT is used on single-sign data, `t` is
  confined to one half of the LUT so values never collapse onto the white centre
  (`divergingMapOnPositive` → upper half; the mirror `divergingMapOnNegative` →
  lower half).
- Voxels are coloured from the per-vertex value attribute via `colorizeValues`
  (sRGB→linear), so interactive and headless images are identical.

## 9. Rendering engine — `web/scene/*`, `web/app/main.js`

`createEngine` (in `renderer.js`) is the multi-panel multi-overlay engine: per-panel
cameras/scissors, per-overlay materials/layers, `recolor()` via `colormap.js`,
per-panel slice uniforms, draw priority = overlay index. `main.js` is the single
entry for both modes: interactive (boots empty; uploads via Pyodide) and headless
(`?headless=1`: loads overlays from the manifest `.bin` files, renders a few frames,
sets `window.__GB_DONE__` for Playwright; load failures set `window.__GB_ERR__`).

Cameras apply a fixed oblique world-space **tilt** kept right-handed (so lighting
stays correct and L/R laterals mirror). Framing auto-fits each panel; whole-brain
panels can share one world scale. Glass cortex = fresnel + cel material; voxels are
opaque `MeshPhong` with shader discards (threshold / clusterMin / positive-only),
an emissive flat-colour term, a logarithmic depth veil, and a light-independent
glint. Outline passes render view-space depth to a float target and detect depth
discontinuities → black cortex silhouette + faint per-voxel edges.

## 10. Headless / Python rendering — `render.py`

`render_to_png(nifti, out_png, *, layout, style, threshold, cmap, ...)` (one path
or a list for a multi-overlay figure): `prepare_render_dir` copies the viewer,
runs `pipeline.py` in-process, writes array overlays, and writes a
`render-config.json`. Playwright Chromium (`--use-angle=swiftshader`) loads
`index.html?headless=1`, waits for `__GB_DONE__` (or raises on `__GB_ERR__`),
screenshots the brain, and optionally writes the colorbar legend as a
`<out>_colorbars.png` sidecar. CLI print defaults (thicker outline, looser margin,
no subcortical shell alpha) are deep-merged UNDER any explicit style flags.
`build_layout(grid, views)` builds a grid layout from `RxC` + row-major view names;
`load_spec(path)` ingests a Free-Canvas figure JSON for `--spec`.

The CLI (`core.py cli()`) wraps this: `open`, `bake`, and `render` (NIfTIs `+`,
`--grid`, `--views`, `--spec`, plus per-overlay/global style flags).

## 11. Verification

- **Pyodide parity:** `tests/test_pyodide_sync.py` (byte-identity of the two
  `pipeline.py` copies) + `tests/test_pipeline_parity.py` (CPython geometry matches
  the in-browser ground truth) + `tests/smoketest.py` (Pyodide runs the pipeline).
- **Pure core:** `node --test` over `web/core/*.test.js` guards the load-bearing
  maths — right-handed camera bases, tilt mirror-consistency, framing, grid
  tiling, visibility filters, and the colormap washout guards.
- **CLI arrays:** `tests/test_cli_arrays.py`; **Free Canvas:** `tests/test_free_canvas.py`;
  **headless integration:** `tests/integration_test.py`.
