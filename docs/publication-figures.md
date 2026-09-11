# Publication figures and reproducible colour scales

COMIC turns an existing neuroimaging result into a composed, three-dimensional figure. Start in the browser, then save the data and display recipe together so the figure can be rendered again.

[Open COMIC](https://gregetarian.github.io/comic/) · [Source code](https://github.com/gregetarian/comic) · [General usage](usage.md)

## Start in the browser

1. Open COMIC and drop in a 3D NIfTI map, a native fsaverage surface map, or a parcel table. **Demo** loads the bundled Neurosynth examples.
2. Choose how each result is drawn: exposed voxel faces, a smooth volume, or colour on the cortical surface. Each overlay has its own colourmap, threshold and legend.
3. Use **Free Canvas** to arrange the panels. Set the views, rotations and any cuts, then enter explicit colour limits if figures will be compared.
4. Export **Save brain** and **Save bars**. Click **Copy CLI** to download the display recipe, `figure.json`, and copy a rendering command. Both grid layouts and Free Canvas compositions use this complete recipe.

The hosted application processes loaded data on your computer. The first use downloads its code, anatomy and scientific Python runtime; input maps are not uploaded to a rendering service.

The recipe records panel layout, representation, cameras, colour settings and legend controls. Preserve it alongside the original inputs and the COMIC revision. Source filenames are path hints; replace them with local paths before running the copied command.

## Install the optional renderer

No installation is needed for browser use. To automate output, install from the source checkout:

```bash
git clone https://github.com/gregetarian/comic
cd comic
python -m pip install -e ".[render]"
python -m playwright install chromium
mkdir -p figures
```

The CLI and Python API run COMIC's web renderer in an invisible Chromium process. Install Playwright and its separate Chromium binary in the same environment that runs COMIC.

Run the examples below from the checkout root. Bundled maps are under `comic/web/data/defaults/`; replace their paths to use your own data. The paper reproduction commands in the final section run from the accompanying publication folder.

## Replay a volume composition

Export a two-overlay recipe with **Language** in the first overlay row and **Faces** in the second. Put `figure.json` in the checkout root, then run:

```bash
comic render \
  comic/web/data/defaults/language.nii.gz \
  comic/web/data/defaults/faces.nii.gz \
  --spec figure.json --crop content -o figures/composition.png
```

The recipe contains the presentation, including the panels, camera state, overlay styles and output dimensions. It does not embed the input maps or the COMIC version. Filenames in its `inputs` list are reminders, not paths that COMIC loads automatically.

| Input order | Saved style | What must stay consistent |
|---|---|---|
| First file | `style.overlays[0]` | The meaning of the first browser overlay row |
| Second file | `style.overlays[1]` | The meaning of the second browser overlay row |
| Subsequent files | Subsequent entries | The same order in every batch |

The number of inputs must match the slots declared by a new recipe. The renderer does not establish scientific equivalence between replacement maps: keep the spatial template, statistic and slot meanings consistent yourself. Overlay order also affects which result is visible where opaque geometry overlaps.

With `--spec`, the recipe supplies the layout and default settings. Explicit style flags override the corresponding saved values, including per-overlay values; repeated `--overlay-json` entries apply last. For example, `--gamma 1 --clim 0,16` deliberately gives every overlay a linear 0–16 scale. Flags you omit preserve the recipe. Change the recipe itself to alter panel layout: combining `--spec` with `--grid` or `--views` is rejected.

The equivalent Python call for volumetric inputs is:

```python
import comic as gb

gb.render_spec(
    "figure.json",
    ["comic/web/data/defaults/language.nii.gz",
     "comic/web/data/defaults/faces.nii.gz"],
    crop="content",
).save("figures/composition.png")
```

For a batch, reuse one browser process:

```python
from pathlib import Path
import comic as gb

Path("figures").mkdir(exist_ok=True)
jobs = {
    "subject-01": ["maps/sub-01_language.nii.gz", "maps/sub-01_faces.nii.gz"],
    "subject-02": ["maps/sub-02_language.nii.gz", "maps/sub-02_faces.nii.gz"],
}
with gb.RenderSession() as session:
    for name, maps in jobs.items():
        gb.render_spec("figure.json", maps, session=session, crop="content").save(
            f"figures/{name}.png"
        )
```

## Keep colour scales comparable

A threshold determines which values are visible. Colour limits determine how visible values map to colours. Set both explicitly: an automatically chosen scale can change when the data change.

COMIC's default colour gamma is `0.5`. Use `--gamma 1` for a linear scale, such as a comparison with an ordinary linear Nilearn colourbar. Matching the colourmap name and endpoints alone does not match the value-to-colour mapping.

For a darker sequential display, gamma below 1 moves intermediate values farther along the lookup table. Figure 2 uses gamma `0.5` for all four maps and all three Language representations; Figures 1 and 3 retain gamma `1`. The limits and lookup tables stay the same, but Figure 2 deliberately has a nonlinear value-to-colour mapping. Its legend positions remain linear in value, with colours sampled at `((value - lo) / (hi - lo)) ** gamma`, matching COMIC's colour bars.

For a positive-association comparison, first prepare the same input for both tools. The bundled language and faces maps also contain negative values; setting a sequential colour scale does not remove them.

```python
import nibabel as nib
import numpy as np
img = nib.load("comic/web/data/defaults/language.nii.gz")
a = img.get_fdata()
a = np.where(np.isfinite(a) & (a >= 2.3), a, 0).astype(np.float32)
nib.save(nib.Nifti1Image(a, img.affine, img.header), "language_positive.nii.gz")
```

This example draws the prepared language map with a cutoff of 2.3 and a fixed linear range of 0–16:

```bash
comic render language_positive.nii.gz \
  --grid 1x3 --views left_lateral,anterior,dorsal \
  --threshold 2.3 -k 0 --cmap YlGnBu --gamma 1 --clim 0,16 \
  --voxels blocky --names "Language (Neurosynth)" \
  --width 1800 --height 600 --scale 2 \
  --crop content -o figures/language.png
```

The corresponding Nilearn parameters are:

```python
from nilearn import plotting

plotting.plot_glass_brain(
    "language_positive.nii.gz",
    display_mode="ortho",
    threshold=2.3, vmin=0, vmax=16,
    cmap="YlGnBu", symmetric_cbar=False, plot_abs=False,
    resampling_interpolation="nearest",
    output_file="figures/language_nilearn.png",
)
```

Nilearn produces maximum-intensity projections; COMIC renders three-dimensional geometry. Matching inputs, cutoffs and colour normalization makes the encoding comparable, while visible anatomy and occlusion still differ. `plot_abs=False` preserves the sign of the projected values. See the [Nilearn API reference](https://nilearn.github.io/stable/modules/generated/nilearn.plotting.plot_glass_brain.html).

For the positive values in the four bundled Neurosynth maps, a useful fixed comparison specification is:

| Map | Colourmap | Display range | Display threshold |
|---|---|---:|---:|
| Language | `YlGnBu` | 0–16 | 2.3 |
| Addiction | `Reds` | 0–9.5 | 2.3 |
| Default network | `Greens` | 0–12 | 2.3 |
| Faces | `Purples` | 0–21 | 2.3 |

These are display choices, not inferential thresholds or estimates of each map's exact maximum. Values above the upper endpoint saturate. The publication script uses COMIC's exact lookup tables in both tools; the shorter example above uses the equivalent named Matplotlib colourmap. For a paired comparison, apply any cluster filtering before plotting and feed the same resulting volume to both tools. Use `-k 0` in COMIC to avoid an additional cluster cutoff. Retain the threshold and map provenance in the caption.

`--clim` sets one range for all overlays. To assign different ranges, use the recipe's per-overlay `clim` entries or repeat `--overlay-json` once for each overlay:

```bash
comic render \
  comic/web/data/defaults/language.nii.gz \
  comic/web/data/defaults/faces.nii.gz \
  --grid 1x3 --views left_lateral,dorsal,right_lateral \
  --cmap YlGnBu,Purples --threshold 2.3 --positive-only --gamma 1 -k 0 \
  --overlay-json '{"clim":[0,16]}' \
  --overlay-json '{"clim":[0,21]}' \
  --crop content -o figures/two_maps.png
```

For signed values, use a diverging colourmap and explicit symmetric limits, for example `--cmap coolwarm --gamma 1 --clim=-1,1`. The equals sign keeps the negative lower bound attached to its CLI option.

## Plot a Schaefer parcel table

Choose the atlas by both parcel count and network scheme. A 100-value vector cannot distinguish `schaefer100_7` from `schaefer100_17`. The browser can accept a single column and asks for the atlas when necessary; use a named, two-column table with the CLI.

For the supplied `fig2_eigenfield_03.csv`, use **Schaefer 100, 17 networks** and preserve its original row order. The following conversion adds COMIC's exact atlas names without changing the values. It assumes that the source rows follow the atlas order: left-hemisphere parcels followed by right-hemisphere parcels.

```python
import csv
import json
from pathlib import Path
import numpy as np

values = np.loadtxt("fig2_eigenfield_03.csv", delimiter=",")
atlas = json.loads(Path(
    "comic/web/data/parcels/schaefer100_17.json"
).read_text())
assert values.shape == (100,) and np.isfinite(values).all()
assert len(atlas["names"]) == len(values)

with open("schaefer100_17_values.csv", "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["region", "value"])
    writer.writerows(zip(atlas["names"], values))
```

Confirm the ordering against the analysis that produced the vector. A matching row count cannot establish that ordering. A named table makes the assumed assignment inspectable and avoids ambiguity on later reuse.

Render lateral and medial surfaces with one continuous, signed scale:

```bash
comic render \
  --parcel-values schaefer100_17_values.csv \
  --parcel-atlas schaefer100_17 --surface inflated \
  --grid 2x2 --views left_lateral,right_lateral,left_medial,right_medial \
  --cmap coolwarm --gamma 1 --clim=-1,1 --threshold 1e-9 \
  --surface-base '#eeeeee' --border-color '#333333' --border-w 1.2 \
  --width 1600 --height 1200 --scale 2 \
  --crop content -o figures/schaefer100_17.png
```

`--parcel-values` adds the atlas borders automatically. The small positive threshold leaves zero-filled unassigned regions and the medial wall uncoloured. It also hides exact-zero parcel values; consider whether this is appropriate for the data. The colourbar represents the supplied continuous values, not 17 categorical network colours.

To reuse a parcel recipe, pass the converted table with `--parcel-values`, the same atlas with `--parcel-atlas`, and `--spec parcel-figure.json`. The saved borders, surface base, limits and threshold are retained unless you explicitly override them.

## Use a native surface map

Native surface values must use the supported fsaverage vertex ordering. Supply them with `--surface-map`:

```bash
comic render --surface-map 'lh=lh.effect.func.gii,rh=rh.effect.func.gii,name=Effect' \
  --grid 2x2 --views left_lateral,right_lateral,left_medial,right_medial \
  --surface inflated --cmap coolwarm --gamma 1 --clim=-3,3 \
  --threshold 0 --surface-base '#eeeeee' \
  --crop content -o figures/surface.png
```

Use `--surface-map 'lh=...,rh=...' --spec surface-figure.json` to replay a surface recipe. The browser exports ordered `--input-json` descriptions for native, parcel or mixed compositions, preserving the overlay order. Each description identifies its type and local file paths. See [Reusing a browser figure](reusing-figure-json.md) for matching CLI and Python examples.

The shorter CLI options still bind positional volumes first, then `--surface-map` entries, then `--parcel-values`. Use `--input-json` when a recipe needs another order or filenames contain commas. Do not combine these two input conventions in one command. Native surface and ordered-description inputs are not supported by the CLI orbit or sweep options.

## Reproduce the paper figures

The accompanying publication folder contains three figures, their input files, named parcel conversion and JSON recipes. From that folder, with the pinned COMIC checkout installed, run:

```bash
python scripts/reproduce.py --comic-repo /path/to/comic
```

This produces PNG, TIFF and PDF figures in `figures/`. Figure 1 uses identical positive-only inputs, the exact COMIC lookup tables, gamma 1 and fixed colour limits. Figure 2 uses the same prepared inputs and limits, with gamma 0.5. **Positive only** is enabled globally and for every Figure 2 overlay. The prepared inputs also exclude negative values. Figure 3 uses gamma 1 for the signed parcel values. `provenance.json` records the input hashes, display settings, excluded-value handling and atlas assignment. `recipes/jobs.json` records the render jobs. `requirements-lock.txt` records the environment used here.

The following commands render representative brain panels directly from the package directory. The final plates add labels and calibrated legends through `scripts/reproduce.py`.

```bash
comic render data/language_positive.nii.gz \
  --spec recipes/comparison_language.json \
  --crop content --no-colorbar -o figures/comparison_language_brain.png

comic render \
  data/faces_positive.nii.gz data/addiction_positive.nii.gz \
  data/default_network_positive.nii.gz data/language_positive.nii.gz \
  --spec recipes/composition.json \
  --crop content --no-colorbar -o figures/composition_brains.png

comic render --parcel-values data/eigenfield_schaefer100_17_named.csv \
  --parcel-atlas schaefer100_17 --spec recipes/parcels_pial.json \
  --crop content --no-colorbar -o figures/parcels_pial_brains.png
```

Figure 2's paired side views combine cortex from the labelled hemisphere with contralateral subcortex and cerebellum, plus brainstem, and set `content.anatomyStyle` to `"opaque"`. The JSON specifies these contents while retaining the selected smooth overlay. The matching `cortex_subcort_*` named views also preserve the selected representation.

Figure 2 explicitly sets statistical blob outlines to `voxel.edges.enabled: true`, `mode: "outer"`, `width: 1.4` and `opacity: 1` in its saved styles. These outline the statistical blobs separately from the anatomical silhouette. A per-overlay setting is necessary to enable them for surface overlays. To set the same edges from the CLI, add:

```bash
--overlay-json '{"voxel":{"edges":{"enabled":true,"mode":"outer","width":1.4,"opacity":1}}}'
```

Repeat `--overlay-json` for each overlay. This override also works with `--spec`. Alternatively, edit the equivalent fields under each relevant `style.overlays` entry in the recipe.

## Export and archive

The renderer writes the brain PNG and a separate `<name>_colorbars.png`. `--no-colorbar` suppresses the second file. `--crop content` trims the surrounding canvas; omit it to preserve the saved canvas dimensions. `--scale 2` doubles the pixel dimensions relative to the configured width and height before cropping.

PNG and SVG colour bars use the same JavaScript sampling model, including explicit limits, gamma, sign selection and grey threshold gaps. The paper assembly script uses the declared normalisation and exact lookup tables to place calibrated legends within the multi-panel plates.

The browser quotes copied filenames for the shell. When editing commands by hand, quote paths containing spaces and hexadecimal colours, for example `--line-color '#124578'`. An unquoted `#` starts a shell comment.

Keep a small reproduction folder with:

- Original maps and parcel tables, including their spatial template, statistic and source.
- The figure JSON and exact input order, plus any custom template assets.
- The script or command that generated the final image, including any preprocessing and page composition.
- The COMIC commit, Python environment and browser version used for rendering.
- The final image and its legends, with captions recording display thresholds and colour limits.

From the checkout, record the exact code revision and environment with:

```bash
git rev-parse HEAD > figures/comic-commit.txt
python -m pip freeze > figures/python-environment.txt
```

The publication package records the checked COMIC revision in `provenance.json`. Pin that revision to reproduce the paper; the hosted viewer can change independently of an installed checkout. The bundled Neurosynth files' attribution is recorded in `comic/web/data/defaults/manifest.json`, and atlas/template terms are in [NOTICE.md](../NOTICE.md).

## Interpret the figure appropriately

COMIC displays already-computed results. It does not register maps or perform statistical inference. The bundled shell and anatomy are group templates. Projecting a volume onto a surface is a display operation, and a higher-resolution anatomical cut does not increase the statistical map's resolution.

Cluster membership is determined at the processing threshold; changing the live display threshold does not relabel components. New recipes retain the processing threshold for each input, independently of its display threshold. With this metadata present, `--threshold` changes display only; `--processing-threshold` deliberately rebuilds the prepared geometry. Older recipes without processing metadata fall back to their effective display threshold. Re-export them from the original session if the original loading state is needed.

For the paper examples, both thresholds are 2.3. Smooth geometry, camera angle and transparency affect what is visible. Small raster differences can occur across WebGL implementations, even with the same data and recipe.

For configuration details, see [Reusing a browser figure](reusing-figure-json.md). For implementation and scientific limits, see [METHODS.md](../METHODS.md).
