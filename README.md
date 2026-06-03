# Glass Brains 2.0

Interactive 3D **glass-brain** viewer and **headless figure renderer** for
volumetric neuroimaging statistics, with a clean cel-shaded aesthetic: a
translucent fresnel cortex, opaque self-occluding stat voxels, live-threshold
silhouette edges, and a depth "veil" that fades deep voxels toward white.

One Python pipeline turns a NIfTI stat map into per-structure geometry; a single
config-driven Three.js viewer renders multi-panel brain views **interactively in the
browser** (locally or on GitHub Pages — the meshing runs client-side via Pyodide, no
backend) or **headlessly to a PNG** (the same pipeline in-process). One backend, one
renderer — so the figure matches the interactive view pixel-for-pixel.

![Glass Brains 2.0 — nine-panel view](figures/9panel_default.png)

---

## Features

- **One config, two renderers** — the same declarative config drives the
  interactive browser viewer and the headless PNG renderer.
- **Multiple overlays** — load several NIfTIs at once; each gets its own control
  row (colormap, threshold, cluster, veil, …). **Row order = draw priority**: the
  top row is drawn on top where overlays overlap. Add with **`+ NIfTI`**, remove
  with **✕**.
- **Fully customisable layouts** — any grid of any anatomical views
  (`left_lateral`, `right_medial`, `dorsal`/`axial`, `anterior`/`frontal`,
  subcortical close-ups, …), 2×2 to N×M, from the CLI.
- **Statistical controls** — voxelwise threshold, **cluster-extent threshold**
  (drop clusters below *k* voxels), positive-only.
- **Faithful colour** — the full `cmap` colormap catalogue, auto
  sequential-vs-diverging selection, and a positive-data washout guard; an
  on-screen colorbar (one per overlay) runs the *same* shader pipeline so it
  matches the voxels. **Show/hide** the colorbars (the `✕` on them, or the
  **Colorbar** toggle) so a stack of bars never squashes the brains.
- **Blocky or smooth** voxels, pial or inflated cortex; an optional **extra
  smoothing** pass (Taubin) on the smooth (0.5 mm-grid) meshes for rounder surfaces.
- **Shared world scale** so every brain renders at the same physical size across
  a figure, plus **per-panel zoom** (hover a panel for `+ / –`).
- **Save brain** / **Save bars** — the brains export at full resolution with no
  colorbars (never squashed); the colorbars export as a separate legend image you
  place yourself.
- **Comic SFX** — because brains rendered like comic panels deserve the
  occasional *BOOM!* (toggle the **Kapow** checkbox).

---

## Install

```bash
git clone https://github.com/gregetarian/comicbrains
cd comicbrains
pip install -e .                 # runtime: nibabel/numpy/scipy/scikit-image (the pipeline)

# Headless figure rendering (glass-brains render):
pip install -e ".[render]"
python -m playwright install chromium

# Only to RE-BAKE the fsaverage template (glass-brains bake) — most users never need this:
pip install -e ".[bake]"         # adds trimesh/mne/cmap
```

The fsaverage template is **pre-baked** and committed under `glass_brains/web/data/`,
so normal use needs no `mne`/fsaverage download — only `glass-brains bake` fetches
fsaverage via MNE (cached under `~/mne_data/`).

---

## Quickstart

```bash
# Interactive viewer — serves the local site + opens the browser. Drag NIfTIs in;
# they're meshed in-browser via Pyodide (identical to the GitHub Pages site).
glass-brains open

# Headless figure → PNG (default: 9-panel, YlGnBu, smooth voxels). Writes a clean
# full-size brain PNG + a separate <out>_colorbars.png legend.
glass-brains render zstat.nii.gz -o figure.png

# Custom layout: L/R lateral on top, axial + frontal on the bottom; extra smoothing.
glass-brains render zstat.nii.gz -o figure.png \
    --grid 2x2 --views left_lateral,right_lateral,axial,frontal \
    --cmap YlGnBu -k 100 --smooth 6 --width 1600 --height 1000

# Re-bake the fsaverage template assets into web/data/ (one-time; needs the [bake] extra)
glass-brains bake
```

> **Hosted:** the same viewer is a static site at `glass_brains/web/`, deployed to
> GitHub Pages — upload a NIfTI in the browser, no install required.

---

## The interactive viewer

The control bar is split into a **global surface row** and **one row per loaded
NIfTI**. Every slider has a type-in box and a hover tooltip.

**Surface row (applies to the whole figure):**

- **`+ NIfTI`** — load one or more stat maps (meshed in-browser via Pyodide; the first
  upload fetches the ~30 MB scientific stack once). Each appends a new overlay row.
- **Copy CLI** — copy a `glass-brains render` command that reproduces the current view.
- **layout** — switch 4-panel / 9-panel / overview.
- **Save brain** — high-res, print-tuned capture of the brains only (no colorbars,
  full canvas — never squashed by a stack of bars).
- **Save bars** — the colorbars on their own as a separate legend image.
- **Colorbar** — show/hide the on-screen colorbars (also the `✕` on the bars).
- **Inflate / Outline** — inflated vs pial cortex; black silhouette on/off.
- **cortex α / edge thr / line w** — cortex glass opacity, sulcal-line density, line width.
- **Light: direct / ambient** — scene lighting (off by default; voxel colour
  comes from emissive + a light-independent glint).

**Per-overlay row (one per NIfTI):**

- name + **✕** to remove · **colormap** · **Smooth** (blocky↔smooth) ·
  **thr** (threshold) · **cluster k** (cluster-extent) · **smooth+** (extra Taubin
  smoothing of the smooth/0.5mm-grid mesh; 0 = off) · **+only** ·
  **Edges** + **edge w** · **veil / veil log** (depth fade) ·
  **emissive / specular / shine**.
- **Row order = display priority** — drag-free: the higher row wins where
  overlays overlap.

**On the panels themselves:**

- **Hover a panel** → a small **`+ / –`** appears top-left to rescale just that view.
- **Kapow** (top-right checkbox) → comic SFX on click, for fun.

## CLI reference

`glass-brains render` is fully parameterised — `--grid RxC`, `--views ...`
(row-major; `_` = blank cell; aliases like `axial=dorsal`, `frontal=anterior`),
plus style flags: `--surface`, `--voxels`, `--cmap`, `-k/--cluster-size`,
`--threshold`, `--veil`, `--veil-k`, `--emissive`, `--specular`, `--shininess`,
`--directional`, `--ambient`, `--cortex-alpha`, `--edge-thr`, `--line-w`,
`--voxel-edge-w`, `--margin`, `--colorbar/--no-colorbar`, `--colorbar-font`,
`--colorbar-fontsize`, `--shadows/--no-shadows`, `--positive-only`,
`--no-edges`, `--no-outline`, `--no-subcortical`, and output `--width`,
`--height`, `--scale`. Run `glass-brains render -h` for the full list.

---

## How it works

See [METHODS.md](METHODS.md) for the full pipeline: surface/subcortical
extraction and MNI305→MNI152 alignment, per-structure voxel meshing (blocky
exposed-face quads + smooth marching-cubes), colormap normalisation and the
washout guard, connected-component cluster sizing, and the Three.js render
pipeline (fresnel glass, opaque depth-veiled voxels, light-independent glint,
depth-edge silhouette passes, headless Playwright capture).

```
glass_brains/
  pipeline.py      THE backend: NIfTI → per-structure geometry ARRAYS. Pure
                   numpy/scipy/scikit-image/nibabel — the SAME file runs in CPython
                   (CLI) and in Pyodide (browser, a byte-identical copy in web/pyodide/).
  arrays.py        write a processed overlay as one .bin + bufferLayout (for the CLI render)
  core.py          GlassBrain (template loader for the bake) + `open`/`bake`/`render` CLI
  render.py        headless layout builder + Playwright PNG renderer (in-process pipeline)
  bake.py          one-time fsaverage template bake → web/data/ (needs the [bake] extra)
  surfaces.py / subcortical.py / colormaps.py / export.py   bake-only (mne/trimesh/cmap)
  web/             THE single Three.js viewer — served by Pages, by `glass-brains open`,
                   and shipped in the wheel:
    index.html · app/main.js (one shell; ?headless=1 for render)
    core/          pure, unit-tested geometry/visibility/colour (node --test)
    scene/         materials, passes, renderer, asset-loader (GLB template + array overlays)
    controls/      UI bindings, colorbar, Copy-CLI, comic SFX
    pyodide/       bootstrap.js + pipeline.py (copy of glass_brains/pipeline.py)
    data/          baked template (cortex/subcortical GLB, colormaps, aseg) + demo + nibabel wheel
```

**One backend, one renderer, three ways to run it.** `glass_brains/pipeline.py` is the
only per-upload meshing code; `glass_brains/web/` is the only viewer. They power:
`glass-brains render` (headless PNG, pipeline in-process), `glass-brains open` (local
interactive — serves `web/`, meshing in-browser via Pyodide), and the GitHub Pages site
(the same `web/`). The fixed fsaverage template is baked once (`glass-brains bake`) and
committed under `web/data/`.

## Development

```bash
# Pure-core JS unit tests (no browser needed)
cd glass_brains/web && node --test

# Python + headless-browser tests (Playwright):
python tests/test_pipeline_parity.py   # CPython pipeline == browser ground truth
python tests/test_cli_arrays.py        # render uses array overlays, not GLB
python tests/test_pyodide_sync.py      # web/pyodide/pipeline.py == glass_brains/pipeline.py
python tests/smoketest.py              # Pyodide boots + meshes the demo in a browser
python tests/integration_test.py       # full app: demo, upload, preset switch, remove
```

---

## License

MIT — see [LICENSE](LICENSE).
