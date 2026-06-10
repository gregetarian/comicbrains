# Glass Brains 2.0 — Implementation Plan

A dependency-ordered roadmap for: the Free Canvas corner-steal fix, headless/test
speedup, **project-to-surface** mode, a **custom / non-MNI template upload**, all the
bug fixes, the full UI backlog, all new figure features, and — the spine of the whole
thing — **full parity across the three front-ends: interactive browser ⇄ standalone CLI
⇄ Python/notebook**. Plus a v1/v2 plan for the paper.

> Status: **plan only — nothing implemented yet.** Produced by a multi-agent design pass
> (8 workstreams → reconciled schema/parity → sequenced milestones). Sources are grounded
> in the current code (file:line) throughout.

---

## 0. The one idea

Glass Brains is **one engine** (`pipeline.py`, byte-mirrored to `web/pyodide/pipeline.py`)
driving **one renderer** (`web/`) from **one declarative config** (`config-schema.js`).
Today there are effectively *two* front-ends (browser, headless CLI) and they diverge in
small, fixable ways. The goal of this round is **three** front-ends — browser, CLI, and an
importable **Python/notebook API** — that *cannot drift*, because they all (a) write the
same config, (b) serialize through one canonical function (`buildSpec`), and (c) render
through one path (`RenderSession`). "Any capability reachable from only one front-end" is
treated as a bug.

Everything else (surface mode, custom templates, clim, animation, …) is layered **on top
of that spine** so each new capability is automatically reachable from all three.

---

## 1. Build order at a glance

| # | Milestone | Effort | Risk | Depends on |
|---|-----------|--------|------|------------|
| **M0** | Quick-win bug & hygiene sweep (ships in isolation) | M | low | — |
| **M1** | Golden-image regression net + vendored offline assets | M | low | — |
| **M2** | Extended `config-schema.js` (clim, units, template, surface, view, panel keys) — *the spine* | M | med | M1 |
| **M3** | Canonical `buildSpec` serializer + Python `spec.py` mirror | M | med | M2 |
| **M4** | `RenderSession` (one browser+server, stage-only-diff, `return_bytes`, `template_dir`, `init_cortex`) | L | high | M1 |
| **M5** | **Notebook/Python API + per-overlay CLI flags + clim/units** — *the parity headline* | L | med | M2, M3, M4 |
| **M6** | Classifier-as-data + space-aware `scene.json` — *the de-MNI refactor* | M | high | M1, M4 |
| **M7** | No-template / volume-only mode (Tier a) | L | med | M5, M6 |
| **M8** | Surface-projection voxel representation | L | high | M4, M5, M6 |
| **M9** | Generalized bake + custom-template render (Tier b) | XL | high | M6, M7, M8 |
| **M10** | Figure features: clim UI, SVG colorbar, region labels, sweeps, orbit/batch | XL | med | M5 |
| **M11** | UI/UX backlog (onboarding, editor depth, a11y/touch, session restore) | XL | med | M3, M5 |
| **M12** | Paper v2 revision (gated on features landing) | M | low | M5, M7, M8, M9 |

**Critical path:** M1 → M2 → M3 → M4 → M5 → M6 → M9 → M12.

**Quick wins (do first, in parallel, gate nothing):** corner-steal fix · NaN/inf clim
guard · fatal headless load errors · negative-only washout guard · cluster-min decision ·
fix the regressed `examples/*.py` · stale `cli-export.js` note · rewrite `METHODS.md` ·
`networkidle`→`domcontentloaded`.

---

## 2. Shared foundations (build before the features lean on them)

1. **Golden-image + vendored-assets regression net (M1).** Commit reference PNGs (single
   panel + 2-overlay grid) with a numpy mean-abs-diff tolerance (~2/255); vendor
   `three@0.170.0` + GLTFLoader + the CM web font under `web/vendor/` with a `VERSION`
   drift check. *Every later refactor claims byte/near-byte identity — that claim must be
   testable, and the renders must be offline-deterministic.*
2. **Extended `config-schema.js` (M2).** The single source of truth both runtimes normalize
   through. Landed in **one coherent commit** so parity/surface/custom-template/serializer
   don't race the same file. Each passenger gets a disjoint subtree (clim/units under
   `style`; `voxel.representation:'surface'`+`surfaceDepth` under `style.voxel`; `template`
   top-level; `layout.view`; promoted `panel.zoom/rotate/slice`).
3. **Canonical `buildSpec` + Python `spec.py` mirror (M3).** The sole figure document for
   Copy-CLI, `--spec`, notebook `render_spec`, presets, and URL-state. `spec.py:normalize`
   enforces the same invariants in CPython so a hand-authored/notebook spec fails loudly.
4. **`RenderSession` (M4).** One Chromium + one server held open; stage only the diff
   (`scene.json` + `overlay_*.bin` + `render-config.json`), symlink heavy assets; `render()`
   returns `Path` or bytes; `__init__` takes `template_dir`; `prepare_render_dir` calls
   `init_aseg`+`init_cortex` once per session. `render_to_png` becomes a byte-identical
   wrapper. **Its signature is the frozen contract** the notebook API, custom-template, and
   surface mode all consume.
5. **Classifier-as-data + space-aware `scene.json` (M6).** Move `ASEG_CATEGORIES` /
   `STRUCTURE_CATEGORIES` out of `pipeline.py` code into `aseg.json`; make the dead
   `scene.json.space` load-bearing. Unblocks both custom templates and the no-template mode.
6. **`core/slices.js` shared SLICE table.** Extract `freecanvas.js` `SLICE_CYCLE` so the
   browser and the CLI `+slice:NAME` modifier materialize the *same* presets (JS↔Python
   equality test, extending the `test_pyodide_sync` discipline).

---

## 3. Canonical config schema (the merged target)

All eight workstreams' additions, reconciled into one non-colliding schema:

```js
export const DEFAULTS = {
  version: '2.0',
  template: { kind: 'mni', dir: null, space: 'MNI152' },   // NEW kind:'mni'|'custom'|'none'
  data: { manifest: 'scene.json', colormaps: 'colormaps.json' },
  render: { width:1600, height:1200, pixelRatio:2, background:'#ffffff', colorbar:true,
            colorbarFont:'…serif', colorbarFontSize:11 },
  style: {
    colormap:'YlGnBu', colormapMode:'auto', threshold:null, positiveOnly:false, gamma:0.5,
    clim: null,                              // NEW null=derive(99th pct); [vmin,vmax]; scalar v→symmetric/seq
    units: { value:'stat', cluster:'voxels' }, // NEW value:'stat'|'z'|'t'; cluster:'voxels'|'mm3'
    margin:0.95, cortexSurface:'inflated',
    voxel: {
      representation:'smooth',               // CHANGED enum: 'blocky'|'smooth'|'surface'
      clusterMin:105, smoothing:0, shininess:200, specular:0.0, emissive:1.0,
      surfaceDepth:6,                         // NEW K depth samples pial→white
      veil:{strength:0.66,k:7.4,color:'#fff'}, edges:{…} },
    overlays: [],                             // per-overlay overrides incl. clim, voxel.*
    glass:{maxOpacity:0.0,…}, anatomy:{…}, outline:{…}, lighting:{…}, tilt:{…}, shadows:{…},
  },
  layout: {
    mode:'grid', grid:{…}, canvas:{w:1600,h:1000,bgAlpha:1},
    view: { s:1, cx:null, cy:null },          // NEW whole-canvas pan/zoom round-trip (identity default)
    panels: [],                               // each panel now declares zoom:1, rotate:null, slice:null
  },
};
```

- `overlayStyle(cfg,i)` additionally returns `clim`, `units`, `surfaceDepth`.
- `validateConfig` (loud failure): `template.kind∈{mni,custom,none}`; in `none` mode reject
  anatomical-split/subcortical views and force `hemisphere:'both'`; `representation∈{blocky,smooth,surface}`;
  `clim` is `null|number|[vmin<vmax]`. `'volume'` is a *category* → hemisphere `'mid'`, so the HEMI set stays `{lh,rh,both}`.
- New `pipeline.py` meta: `meta.structures.volume` (single bucket when `classify=False`/no aseg),
  `meta.surface = {lh,rh}` (only when `_CORTEX` loaded and ≥1 supra-threshold vertex), plus
  `init_cortex(...)`, `SURFACE_DEPTH`, `process_nifti(..., classify=True)`.
- New `scene.json`: `space` (now read by JS), `templateMode:'mni'|'custom'|'none'`,
  `categories`, `structureCategories`, `hasWhiteSurface`.

---

## 4. Parity matrix (post-implementation target)

`✓` reachable · `✓(F)` full-fidelity escape hatch (`--spec`/`--overlay-json`) · `—` N/A.

| Capability | Browser | `--spec` | CLI flags | Notebook |
|---|---|---|---|---|
| colormap / colormapMode | ✓ (+new mode widget) | ✓ | ✓ | ✓ |
| gamma | ✓ (+new slider) | ✓ | ✓ | ✓ |
| threshold / clusterMin | ✓ | ✓ | ✓ | ✓ |
| **clim / vmin–vmax** | ✓ (new row) | ✓ `style.clim` | ✓ `--clim` | ✓ `clim=` |
| **units (z/t/mm³)** | ✓ | ✓ | ✓ `--units` | ✓ |
| **per-overlay full style** | ✓ | ✓ | ✓ comma-lists | ✓ scalar-or-list |
| per-overlay long-tail (veil/edges/…) | ✓ | ✓ | ✓(F) `--overlay-json` | ✓ |
| **style-preset ingest** | ✓ | ✓ | ✓ `--style p.json` | ✓ |
| **per-panel zoom** | ✓ (round-trips now) | ✓ `panel.zoom` | ✓(F) | ✓(F) |
| **whole-canvas pan/zoom** | ✓ (round-trips now) | ✓ `layout.view` | ✓ `--view-zoom/pan` | ✓ |
| per-panel slice | ✓ | ✓ | ✓ `+slice:NAME` | ✓(F) |
| per-panel pose/oblique | ✓ | ✓ | ✓ `@yaw=,pitch=` (common); ✓(F) arbitrary | ✓(F) |
| representation blocky/smooth | ✓ | ✓ | ✓ `--voxels` | ✓ |
| **representation surface** | ✓ (3-way) | ✓ | ✓ `--voxels surface` | ✓ |
| **custom template (BYO)** | ✓ `.zip` bundle | ✓ `template{…}` | ✓ `--template DIR` | ✓ `template=` / `bake_template()` |
| **no-template / volume-only** | ✓ toggle | ✓ `kind:'none'` | ✓ `--no-template` | ✓ `template='none'` |
| inline PNG/HTML display | — (is the UI) | — | — | ✓ `Figure/Scene._repr_png_` |
| Copy-CLI emits ONE command | ✓ | — | — | — |
| GPU / fast / batch lanes | — | — | ✓ `--gpu/--fast/render-batch` | ✓ `RenderSession`/`render_batch` |

**The one documented non-parity:** the browser can't know a NIfTI's disk path, so multi-overlay
Copy-CLI emits placeholder filenames (`<map1.nii.gz>`).

---

## 5. Milestones in detail

### M0 — Quick-win bug & hygiene sweep `[M, low]`
- **NaN/inf guard** in `load_stat_map` (`data[~isfinite]=0` before threshold; `nanpercentile`)
  in **both** `pipeline.py` copies (then re-run the bake copy step); a test that a NaN map
  yields finite `maxAbsValue`. *Real bug: NaN poisons the percentile clim → whole overlay's colour breaks.*
- **Fatal headless load errors:** strict `fetchJSON` sets `window.__GB_ERR__` and throws on
  config/colormap/empty-LUT failure instead of silently booting empty (matches crash-loudly).
- **Negative-only washout guard:** `divergingMapOnNegative` in `colormap.js` mirroring the
  existing positive guard; threaded through `renderer.js` + `colorbar.js` + a mirror test.
- **Free Canvas corner-steal fix:** sticky `activeId` + 3-tier z (`active 300 / hover 200 / 14+z`)
  + `.fc-active` CSS + grow `.fc-resize` to ~18px. *Do before M11's multi-handle resize so it
  inherits the corrected stacking.*
- **cluster-min decision:** keep DEFAULTS=105 and `-k` default=105; make `bake.py`'s demo
  `clusterMin:0` an explicit recorded choice, not a schema default. (mm³ units escape hatch arrives in M2.)
- **Hygiene:** fix the regressed `examples/*.py` (they call removed `GlassBrain.show()/.add_overlay()`);
  delete dead `GlassBrain` ctor params; fix the stale `cli-export.js` "cannot composite" note;
  **rewrite `METHODS.md`** to the current `pipeline.py`/`arrays.py`/`web/` architecture.
- **speedup:** `render.py` `wait_until` `networkidle`→`domcontentloaded` (the `__GB_DONE__`
  gate already handles readiness; ~0.4–1.0s/render).

### M1 — Golden net + vendored assets `[M, low]`
Commit `tests/golden/` reference PNGs + `test_golden_renders.py` (mean-abs-diff < ~2/255,
fast lane). Vendor three.js+GLTFLoader+CM font under `web/vendor/`, rewrite the
`index.html`/`smoketest.html` importmap, add `web/vendor/VERSION` + `test_vendor_sync.py`,
extend pyproject package-data.

### M2 — Extended config-schema (the spine) `[M, med]`
The schema block in §3, in one coherent commit: `template`, `style.clim`, `style.units`,
`voxel.representation:'surface'`+`surfaceDepth`, `layout.view`, promoted `panel.zoom/rotate/slice`,
extended `validateConfig`/`overlayStyle`, and `core.test.js` assertions (the node-`--test` keystone).

### M3 — Canonical serializer + `spec.py` `[M, med]`
`buildSpec` includes `layout.view` and relies on `panel.zoom` in the def (drop the shadow
field); `renderer.js zoomPanel` writes `def.zoom`; `main.js` applies `layout.view` on boot
(identity-safe headless). New `glass_brains/spec.py:normalize/validate` mirrors
`validateConfig`. Keystone test: `normalizeConfig → buildSpec → spec.normalize → re-serialize`
is a fixed point carrying clim/units/surface/zoom/view/template.

### M4 — RenderSession `[L, high]`
```python
class RenderSession:
    def __init__(self, *, headless=True, gpu=False, base_dir=WEB_DIR, template_dir=None, keep_dirs=False): ...
    def render(self, nifti, out_png=None, *, layout, style=None, threshold=2.3, …, return_bytes=False): ...
def render_to_png(nifti, out_png, **kw):       # byte-identical wrapper
    with RenderSession() as s: return s.render(nifti, out_png, **kw)
def render_batch(jobs, *, gpu=False): ...
```
Serve `WEB_DIR` once, stage only the 3 diff files (symlink heavy assets), `.gitignore`
`web/.render/`, drop the 37MB `copytree`. Plus pytest+xdist harness, convert the 8
`SystemExit` scripts to `def test_*` behind a session-scoped shared-browser fixture, mark the
2 Pyodide tests slow, a `justfile`/`make test`; `node --test --watch` for pure core; opt-in
`--fast` (skip colorbar 2nd screenshot) + `--gpu` lane.

### M5 — Notebook/Python API + per-overlay CLI + clim/units (PARITY HEADLINE) `[L, med]`
- `glass_brains/figure.py`: `render()`, `render_spec()`, `Figure` (`png`/`colorbar_png`/`config`,
  `.save`/`.pil`/`.to_ipython_image`/`_repr_png_`/`_repr_html_`), `Scene` fluent builder; re-export
  from `__init__`. Per-overlay kwargs accept scalar (broadcast) or list. Inline display in
  Jupyter/VSCode via the repr hooks — no `display()` needed.
- `core.py`: list-valued `--threshold/-k/--cmap/--colormap-mode/--gamma/--clim/--voxels/--positive-only`
  → `style.overlays[i]`; repeatable `--overlay-json`; `--names`; `--style p.json` deep-merge;
  `--units`. **One parser rule:** no comma ⇒ global broadcast (today's behaviour); comma ⇒ per-overlay.
- Wire `clim` into `renderer.js` `uMaxAbs` (:71,:123) + `colorbar.js` (:67).
- Pose/slice in `--views`: `left_lateral@yaw=20,pitch=10` → `panel.rotate`; `dorsal+slice:axial`
  → `panel.slice` (from the shared `core/slices.js`). Rewrite `cli-export.js buildRenderText`
  to emit **one** command. Re-point the M0 examples to `figure.render()`.

### M6 — Classifier-as-data + space-aware scene.json `[M, high]`
Move the FreeSurfer label tables into `aseg.json` (`init_aseg` loads them into `_ASEG`);
`process_nifti(classify=False)` emits a single `volume` bucket; `write_scene_json` emits real
`space`/`templateMode`/`categories`/`structureCategories`/`hasWhiteSurface`. **Gated behind the
M1 golden baseline** — assert byte-identical fsaverage buckets at the array level and re-bake
`web/pyodide/pipeline.py` in the same commit so `test_pyodide_sync` stays green. Fold in the
`classify_overlay_voxels` vectorization here (same file).

### M7 — No-template / volume-only (Tier a) `[L, med]`
`template.kind:'none'` drops cortex+subcortical; single `volume` bucket (hemisphere `mid`);
generic box-face view set (relabelled `PLANES`); none-mode view gating (added in M2). Reachable
from all three front-ends via M5/M3. Retires the paper's MNI152-only-input limitation.

### M8 — Surface-projection representation `[L, high]`
Bake `lh/rh.white` as a per-vertex inward-offset sidecar; `init_cortex` (mirrors `init_aseg`,
set up once per session in M4); `build_surface_projection` (K-depth pial→white line average via
`map_coordinates`, K=1 fallback when no offset); `meta.surface`; `asset-loader` builds surface
meshes reusing `attachValues`/`recolor`; `makeSurfaceMaterial` (opaque cel, curvature-grey below
threshold); visibility gate + hide same-hemi glass shell when surface is shown.
`--voxels surface` (per the M5 parser rule); 3-way browser control. Degrades on
`hasWhiteSurface:false`. Retires the paper's "renders the volume, not a surface" limitation.

### M9 — Generalized bake + custom-template render (Tier b) `[XL, high]`
`surfaces.load_surface_file` (FreeSurfer/.gii/GLB) + `space` (native|MNI152|custom 4×4);
`subcortical.extract_subcortical` from an external label map; `bake` CLI args
(`--out/--surfaces/--inflated/--aseg/--aseg-labels/--space/--surface-affine/--colors/--subcortical-from-aseg`);
`bake_template()` Python wrapper. `prepare_render_dir(template_dir=…)` overlays the custom
`data/` onto the engine copytree; `render --template DIR`. Browser: a pre-baked `.zip` bundle
(raw in-browser surface meshing deferred — keeps Pyodide light). **Honest scope: visualisation-grade,
bring-your-own-and-align — not registration.** Retires the fixed-fsaverage-template limitation.

### M10 — Figure features `[XL, med]`
Per-panel voxel-uniform override pass (enables sweeps) · `clim`/`vmax` UI + `--clim` (closes the
UI parity cell) · SVG colorbar legend sidecar (vector **legend only**, never the brain) · region
labels from the aseg classification already computed · threshold/cluster sweep small-multiples ·
turntable/orbit animation (PNG sequence core, opt-in ffmpeg/imageio GIF/MP4, one `RenderSession`) +
`render-batch`.

### M11 — UI/UX backlog `[XL, med]`
Empty-state onboarding + viewer-wide drop target · disable/dim Save/Copy-CLI/Presets when
`overlays==0` · Free Canvas gesture legend · control-bar wrap/Advanced disclosure ·
colormapMode/gamma/clim widgets · drag-to-reorder overlay rows · units field · live
threshold/cluster/value readout · undo/redo · 8-way resize + Shift aspect-lock · alignment
guides/snap · keyboard nav + ARIA · touch/pinch · **URL-hash + localStorage session restore**
(reusing the M3 serializer). Everything writes through the config, so none of it forks from CLI/notebook.

### M12 — Paper v2 (see §7) `[M, low]`

---

## 6. Conflicts resolved (so the workstreams compose)

- **Surface vs custom-template white-surface fallback.** One contract, two gates:
  `scene.json.hasWhiteSurface` = *availability* (true only when bake produced a matching-vertex
  white surface); `meta.surface` = *per-map result*. Custom templates bake pial-only →
  `hasWhiteSurface:false` → surface auto-degrades to K=1 / toggle disabled. Agreed
  `cortex_surface.json` layout: pial required, offset optional.
- **buildSpec ownership.** Parity **owns and is the sole editor** of `buildSpec`. Surface adds
  nothing (its `representation` already lives in `style.voxel`); custom-template adds only the
  top-level `template` block. Disjoint subtrees ⇒ no field collision.
- **RenderSession shared by 4 workstreams.** Speedup builds it first and **freezes the
  signature** (`template_dir` in `__init__`, `return_bytes`, `init_cortex` hook). If it lands
  late, ship `figure.render()` over a per-call browser and swap the session in behind the stable
  interface.
- **Classifier-as-data vs byte-identity.** M1 golden baseline **must** precede M6; M6 asserts
  identical fsaverage buckets at the array level (the ~2/255 pixel tolerance absorbs *nothing*
  here) and re-bakes the Pyodide copy in the same commit.
- **cluster-min default (0 vs 100 vs 105).** Keep DEFAULTS=105; the bake demo's 0 becomes an
  explicit recorded choice; add `units.cluster:'mm3'` so non-MNI voxel sizes can express the
  threshold physically.
- **Surface (pial) vs default inflated shell.** When `representation==='surface'`, hide the
  same-hemisphere glass cortex and drive the outline from the pial silhouette — local to the
  panel, not a global `cortexSurface` flip.
- **`--voxels` scalar vs list vs new `surface` value.** The one parser rule (comma ⇒ per-overlay,
  scalar ⇒ broadcast) owned by M5; M8 adopts it, no parallel parse path.

---

## 7. Paper: v1 now, v2 after features land

**Ship `paper.tex` as v1 immediately** — it is internally consistent and grounded in shipped
code; the M0 sweep changes no claim it makes. Optional single hedge: add "at the time of
writing" to the MNI152-only / surface lines so a future v2 reads as evolution, not contradiction.
**Do not pre-announce features.**

**v2 is gated, edit-by-edit, on the milestone that retires each stated limitation:**

| paper.tex location | Current claim | Retired by | v2 edit |
|---|---|---|---|
| Abstract :42–44; Design :108 "two hosts", :124–131 | two hosts / two rentimes | **M5** | "one viewer drives **all three** front-ends" — browser, CLI, importable notebook library; rename "One renderer, two hosts" → "three front-ends" |
| Discussion :273 | "Input must be a 3D map in MNI152 space" | **M7 + M9** | "By default … MNI152 … or on a user-supplied template" |
| Design :128–130; Discussion :274 | "fixed fsaverage … no per-subject cortex" | **M9** | "a user may supply their own template (surfaces + segmentation), including non-MNI" — BYO-and-align, not auto-registration |
| Discussion :277 | "renders the volume, not values painted on a cortical surface mesh" | **M8** | "can also project a map onto the template surface … not a general surface-analysis package" |
| Discussion table `tab:comparison` | 5 columns | M5/M8 | add **Surface** + **Scriptable** columns; GB row: 3D volume "yes (+surface)", scriptable "CLI + notebook" |
| Discussion novelty para :258–271 | engages NiiVue | M5/M8 | add a clause: surface display (PySurfer/nilearn/Workbench) and notebook rendering are **likewise established** — "now also offers … claims no novelty in the capabilities themselves" |

**New v2 figures:** surface-vs-volume of the same map (same config) · a custom/non-MNI template
example (caption states the user supplied + aligned it) · a notebook inline-render (reuse
`quickstart.py`). **Honesty rule:** every added-capability sentence is paired with a "this exists
elsewhere" acknowledgement; the differentiator list (aesthetic · one engine · Free Canvas ·
reproducibility · AI transparency) is *strengthened* (two front-ends → three), never changed in kind.
Keep the volume-forward title (volume stays the default and the distinctive thing).

---

## 8. Cross-cutting tests (the parity guarantees)

- `test_pyodide_sync.py` (keep green): `web/pyodide/pipeline.py` byte-identical after **both** the
  classifier-as-data refactor (M6) and the `init_cortex`/surface additions (M8). Every
  pipeline-touching phase ends with `glass-brains bake`.
- `test_pipeline_parity.py` (extend): data-driven categories produce byte-identical buckets vs the
  old hardcoded tables; add `GT_SURFACE` (K-depth average vs numpy recompute).
- `test_config_roundtrip` (**the parity keystone**): `render_spec(spec)` stages the same
  `render-config.json` as `core.py --spec`; a config carrying clim/units/surface/zoom/view/template
  is a `normalize→buildSpec→spec.normalize` fixed point.
- `test_cli_per_overlay.py`: comma-lists bind per-overlay; a bare scalar still broadcasts (regression).
- `test_golden_renders.py` (M1, fast lane): stays green through RenderSession, stage-only-diff,
  classifier-as-data, clim, and the `layout.view` identity addition.
- `test_clim.py` · `core.test.js` (surface/none-mode/zoom assertions) · `test_vendor_sync.py` ·
  `test_examples_import.py` (no removed APIs) · `test_volume_only.py` + `test_bake_custom.py` ·
  a slow-marked headless golden smoke for surface / `--template` / `--no-template`.

---

## 9. Decisions

**Decided (2026-06-10):**

1. ✅ **Notebook surface = both `render()` and `Scene`.** `render()` for one-shot inline figures;
   `Scene` is a fluent builder over a persistent `RenderSession` for sub-second iterative tweaking;
   `Scene` wraps `render()`.
2. ✅ **Custom template = visualisation-grade, BYO-and-align — no registration.** The user supplies
   surfaces + segmentation already in a common world frame; we never resample/register. Paper wording:
   "user-supplied and user-aligned." Light sanity checks only (dims>0, invertible affine, ≥1 category),
   crash loudly on malformed bundles.
3. ✅ **Browser custom-template ingest = pre-baked `.zip` bundle only for v1.** The bundle is produced by
   `glass-brains bake`; raw `.pial`/`.gii` in-browser meshing is deferred (keeps Pyodide light).
4. ✅ **`clim` = sign-aware scalar default, with an explicit `[vmin,vmax]` form also accepted.** A bare
   value `v` → `[-v,v]` on diverging maps / `[0,v]` on sequential (the nilearn-style `vmax` intuition);
   passing `[vmin,vmax]` (CLI `--clim 1,8`, leading-blank `--clim ,8` = auto vmin) overrides explicitly.
   `null` = derive from data (today's 99th-pct behaviour).

**Still open (have working defaults — confirm at implementation time):**

5. **Per-overlay CLI syntax:** comma-lists (`--threshold 2.3,4.0`) vs repeatable `--overlay` groups?
   *(Default: comma-lists; matches Copy-CLI emission. `--overlay-json` remains the lossless escape hatch.)*
6. **Notebook NIfTI input:** accept nibabel images / numpy+affine / file-bytes, or paths only?
   *(Default: paths + nibabel images; `pipeline.load_stat_map` already takes bytes, so it's cheap to add.)*
7. **`layout.view` (whole-canvas pan/zoom):** part of the reproducible figure, or always export the
   fitted (`s=1`) view? *(Default: serialize it, identity by default — costs nothing and stays faithful.)*
8. **Paper:** ship v1 now + v2 later? *(Default/recommended: yes — v1 is honest and ready today.)*
9. **cluster threshold units** in non-MNI/custom mode: 105 voxels or mm³? *(Default: keep 105 voxels;
   `units.cluster:'mm3'` available as an opt-in since voxel size differs per template.)*

---

*Generated from the `glassbrains-impl-plan` design workflow. Per-workstream sub-plans (with
file:line current-state, full `code_sketch`s, and per-phase test lists) are the source of this
summary; ask to expand any milestone into its full sub-plan before implementation.*
