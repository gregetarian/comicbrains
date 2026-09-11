# Reuse a browser figure with new data

`figure.json` is a reusable Comic display recipe. It records the panel positions and sizes,
camera rotations, cuts, selected cortical surfaces, overlay colours, thresholds, line
styling, transparency and output dimensions. Keep scientific input files separately;
the recipe does not embed them.

This separation is useful: design a figure once in the browser, then apply the same design
to one map, many subjects, or many sets of overlays from the terminal or Python.

## 1. Install the headless renderer once

The terminal and Python rendering interfaces use the same Three.js renderer as the hosted
viewer. They therefore launch Chromium through Playwright in headless mode, capture its
canvas and close it. Both Playwright and its separate Chromium binary are required.

From a Comic checkout:

```bash
python -m pip install -e ".[render]"
python -m playwright install chromium
```

Use the same Python environment for `comic render` and for the Python examples below.

## 2. Export the recipe from the browser

1. Load the maps you need as design placeholders.
2. Choose a grid layout, or switch to **Free Canvas** for freely arranged panels.
3. Arrange and rotate the panels; choose surfaces, cuts, colours, thresholds and other
   styling.
4. Click **Copy CLI**.

The button does two things:

- downloads `figure.json`; and
- copies a ready terminal command plus its Python equivalent.

Every nonempty figure exports the complete recipe, including simple grids. The copied
command contains input filenames with shell quoting. A browser cannot know their full
paths on disk, so replace each filename with its local path when necessary.

## 3. Render one figure

### Terminal

One overlay:

```bash
comic render maps/zstat.nii.gz \
  --spec figure.json \
  -o figures/zstat.png \
  --crop content
```

Several overlays:

```bash
comic render maps/language.nii.gz maps/default_mode.nii.gz maps/faces.nii.gz \
  --spec figure.json \
  -o figures/networks.png \
  --crop content
```

### Python

```python
import comic as gb

gb.render_spec(
    "figure.json",
    ["maps/language.nii.gz", "maps/default_mode.nii.gz", "maps/faces.nii.gz"],
).save("figures/networks.png")
```

In Jupyter or VS Code, leave off `.save(...)` and evaluate the returned figure to display
it inline. Rendering still occurs in the invisible Chromium process before the PNG is
shown in the notebook.

## 4. Understand overlay slots

Files bind to styles by position:

| Input position | JSON style | Meaning |
|---:|---|---|
| first file | `style.overlays[0]` | first browser overlay row |
| second file | `style.overlays[1]` | second browser overlay row |
| third file | `style.overlays[2]` | third browser overlay row |

Therefore, if the first browser row was purple and the second red, the first file passed to
`comic render` will be purple and the second will be red. Reordering browser overlay rows
before exporting also changes draw priority where maps overlap.

New exports contain an `inputs` list like this as a reminder:

```json
"inputs": [
  {"slot": 1, "name": "language.nii.gz", "type": "volume", "processingThreshold": 0},
  {"slot": 2, "name": "default_mode.nii.gz", "type": "volume", "processingThreshold": 0}
]
```

`processingThreshold` records the cutoff used to prepare each input; the live display
threshold remains in its overlay style. The names are hints, not fixed paths. Supplying
different files in the same positions is the intended reuse workflow. New exports fail
loudly if the number of supplied inputs does not match the declared slots, preventing an
accidental colour/style shift.

## 5. Mix volume, surface and parcel inputs

For mixed compositions, the browser copies one `--input-json` description per overlay,
in the original overlay order. This avoids imposing a volumes-first ordering:

```bash
comic render --spec figure.json \
  --input-json '{"type":"surface","lh":"maps/lh.effect.func.gii","rh":"maps/rh.effect.func.gii","name":"Effect"}' \
  --input-json '{"type":"volume","path":"maps/language.nii.gz","name":"Language"}' \
  --input-json '{"type":"parcel","path":"maps/regions.csv","atlas":"schaefer100_17","name":"Regions"}' \
  --crop content -o figures/mixed.png
```

Use this command with a recipe whose slots are surface, volume and parcel, respectively.
A surface description may contain either hemisphere or both. Parcel tables use named
region/value columns and an explicit atlas. Do not mix `--input-json` with positional
volumes, `--surface-map` or `--parcel-values` in one command.

The Python equivalent takes the same ordered descriptions:

```python
import comic as gb

gb.render_spec("figure.json", [
    {"type": "surface", "lh": "maps/lh.effect.func.gii",
     "rh": "maps/rh.effect.func.gii", "name": "Effect"},
    {"type": "volume", "path": "maps/language.nii.gz", "name": "Language"},
    {"type": "parcel", "path": "maps/regions.csv",
     "atlas": "schaefer100_17", "name": "Regions"},
], crop="content").save("figures/mixed.png")
```

## 6. Keep processing and display thresholds separate

The processing threshold determines which values enter the prepared geometry, connected
components and volume-to-surface sampling. A live display threshold hides parts of that
prepared result without recomputing it. New recipes record both.

For a new recipe with `processingThreshold` metadata, this changes the display cutoff
and colour gamma while preserving the saved processing cutoff:

```bash
comic render maps/language.nii.gz --spec figure.json \
  --threshold 3.1 --gamma 1 --crop content -o figures/language.png
```

To rebuild the geometry deliberately, also supply `--processing-threshold 3.1`.
Without a recipe, `--threshold` sets both cutoffs unless a separate processing threshold
is supplied. Older recipes without processing metadata fall back to the effective display
threshold; they cannot recover an unrecorded loading state. Re-export from the original
browser session when that distinction matters.

## 7. Render many figures quickly

For a few jobs, repeat the terminal command with different input and output paths. For a
larger batch, reuse one browser process from Python so Chromium starts only once:

```python
from pathlib import Path
import comic as gb

jobs = {
    "subject-01": ["maps/sub-01_language.nii.gz", "maps/sub-01_dmn.nii.gz"],
    "subject-02": ["maps/sub-02_language.nii.gz", "maps/sub-02_dmn.nii.gz"],
    "subject-03": ["maps/sub-03_language.nii.gz", "maps/sub-03_dmn.nii.gz"],
}

Path("figures").mkdir(exist_ok=True)
with gb.RenderSession() as session:
    for name, volumes in jobs.items():
        gb.render_spec(
            "figure.json",
            volumes,
            out=f"figures/{name}.png",
            session=session,
            crop="content",
        )
```

Each job receives the same layout and styles. Only the supplied volume data and output path
change.

## Output controls

- `--crop content` matches the browser's tightly cropped **Save brain** output. Omit it to
  preserve the complete saved canvas, including its outer whitespace.
- `--scale 2` is the default supersampling. Increase it for more output pixels without
  changing the saved layout.
- The terminal writes the brain to the `-o` path and, by default, a separate
  `<name>_colorbars.png`. Use `--no-colorbar` if the legend is not needed.
- In Python, use `colorbar=False` to skip the separate legend.
- Explicit `--width` or `--height` overrides the dimensions stored in `figure.json`.
- With `--spec`, explicitly supplied style flags override saved settings, including
  per-overlay values. Repeated `--overlay-json` entries apply last. Omitted flags leave
  the recipe unchanged.
- The recipe owns the layout. `--grid` and `--views` cannot be combined with `--spec`;
  edit the panels in the browser or JSON instead.

## What is fixed and what can change?

The JSON supplies the presentation: layout, camera, styling, thresholds, colour limits
and render dimensions. The input data can change, and explicit overrides can change
selected settings. If a colour limit was pinned in the browser,
the same limit is reused; if it was automatic, Comic derives it from each replacement map.

To reproduce a published figure, retain the original data, the JSON, any custom
template assets, and a pinned Comic release or commit. The shared renderer keeps the display
semantics aligned, but different WebGL backends may produce small pixel-level differences.

For comparable figures, use maps in the same spatial template and keep the same
slot meaning across jobs. A replacement map may have a different voxel size, but the 1-mm cut
anatomy does not increase that map's underlying resolution.

## Common problems

- **Wrong colour on a map:** the files were supplied in the wrong order. Check `inputs` and
  the browser overlay-row order.
- **Wrong number of inputs:** pass exactly one file for every declared `inputs` slot. Older
  recipes without `inputs` remain supported.
- **Map is empty:** its values do not survive the threshold/cluster cutoff saved in the JSON,
  or the volume is not aligned with the selected template.
- **Command not found:** activate the environment where Comic was installed.
- **Chromium missing:** run `python -m playwright install chromium` in that environment.
- **Margins differ:** use `--crop content` to match **Save brain**, or omit it to preserve the
  full Free Canvas dimensions.
