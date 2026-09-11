/**
 * main.js — the ONE viewer entry, for both modes:
 *   interactive (default)  — the static/Pyodide app (served by Pages and `comic
 *     open`): fixed fsaverage template from baked GLBs, demo overlay from baked buffers,
 *     uploads processed by the Pyodide pipeline (lazy-loaded on first upload). Overlays
 *     live in browser memory; the engine (which bakes N overlays into its
 *     materials/layers/passes) is disposed + recreated in place on each add/remove.
 *   headless (?headless=1) — used by `comic render`: fixed size from config.render,
 *     controls hidden, overlays loaded from the manifest's array .bin files (produced by
 *     the in-process CPython pipeline), a few frames rendered, then window.__GB_DONE__ set
 *     for the Playwright driver to screenshot. Same engine + same array geometry as the browser.
 */
import * as THREE from 'three';
import { resolveConfig } from '../core/presets.js?v=depth-auto-v3';
import { loadColormaps } from '../core/colormap.js?v=depth-auto-v3';
import { setOverlayStyle } from '../core/config-schema.js?v=depth-auto-v3';
import { createPresetsUI, randomColormapName } from '../controls/style-presets.js?v=depth-auto-v3';
import { contentBBoxPx } from '../core/bbox.js?v=depth-auto-v3';
import { loadBaseScene, buildOverlayMeshes, buildCutVolume, loadOverlayArrays, loadAnatomyVolume, loadParcellation, loadParcellationIndex } from '../scene/asset-loader.js?v=depth-auto-v3';
import { createEngine } from '../scene/renderer.js?v=depth-auto-v3';
import { createColorbar } from '../controls/colorbar.js?v=depth-auto-v3';
import { initKapow } from '../controls/kapow.js?v=depth-auto-v3';
import { bindGlobalControls, buildOverlayRows } from '../controls/bind.js?v=depth-auto-v3';
import { buildRenderText, usesFigureSpec, buildSpec } from '../controls/cli-export.js?v=depth-auto-v3';
import { createFreeCanvasEditor } from '../controls/freecanvas.js?v=depth-auto-v3';
import { exportSpinGif } from '../controls/gif-export.js?v=depth-auto-v3';
import { processNifti, processSurface, processParcelValues } from '../pyodide/bootstrap.js?v=depth-auto-v3';
import { VOL_RE, isSurfaceFile, isParcelValueFile, groupSurfaceFiles, surfaceOverlayName } from '../core/surface-files.js?v=depth-auto-v3';
import { parseValueTable, inferAtlas, valuesToVertexMaps, namedValuesToParcelOrder } from '../core/parcel-values.js?v=depth-auto-v3';
import { askAtlas } from '../controls/atlas-prompt.js?v=depth-auto-v3';
import { createSessionState } from './state.js?v=depth-auto-v3';

const DATA = 'data/';
const DEMO_ASSET_VER = 'cut-volume-v1';

// --- session state ---
// Session flags + the current preset live in ONE object (see app/state.js): state.isHeadless,
// state.colorbarsVisible, state.demoLoaded, state.viewInitialized, state.panelZoomUsed, state.preset.
// The render-pipeline HANDLES below stay module-level for now (engine + colorbar are recreated on
// every rebuild); folding them into `state` is a separate, browser-verified follow-up.
const state = createSessionState();
let renderer, colormaps, baseScene, config, engine, colorbar;
let overlays = [];   // [{ meta, meshObjs: [{ mesh, meta, values, aabb }, ...] }]
let anatomyVol = null;   // the cut-cap volume asset {data,dims,affine}, loaded on first use
let parcAtlas = null;    // the active parcellation's {lh,rh} label arrays, kept across rebuilds
let zoomEls = [];
let fcEditor = null;   // Free Canvas editor overlay (only in layout.mode === 'free')
let surfaceLayoutPromise = null; // coalesce rapid switches into a view that needs surface geometry
let container, canvas;

function makeOverlay(meta, buffers, oi, src) {
    return {
        meta,
        meshObjs: buildOverlayMeshes(meta, buffers, oi),
        cutVolume: buildCutVolume(meta, buffers),
        src,
        _surfaced: !!meta.surface || !!meta.surfaceOnly,
    };
}

async function fetchJSON(url, fb) {
    try { const r = await fetch(url); if (!r.ok) throw 0; return await r.json(); }
    catch { return fb; }
}
// Headless/CLI render must FAIL LOUDLY: a missing/broken config or colormaps file should
// surface as window.__GB_ERR__ (which render.py waits on), not silently boot a degraded scene.
async function fetchJSONStrict(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`failed to load ${url} (HTTP ${r.status})`);
    return await r.json();
}
const setLoading = (msg, sub) => {
    const el = document.getElementById('loading');
    if (!el) return;
    el.style.display = msg == null ? 'none' : '';
    if (msg == null) return;
    // textContent (not innerHTML): user-controlled filenames flow through here, so
    // building DOM avoids any markup injection from an upload's name.
    el.textContent = msg;
    if (sub) { const d = document.createElement('div'); d.className = 'sub'; d.textContent = sub; el.appendChild(d); }
};

async function main() {
    container = document.getElementById('viewer');
    canvas = document.getElementById('canvas');

    const params = new URLSearchParams(location.search);
    state.isHeadless = params.get('headless') === '1';
    // Colorbars are off by default in the interactive viewer, but the headless/CLI render
    // path governs them via config.render.colorbar (render.py screenshots the .colorbar
    // element), so keep them present headlessly.
    if (state.isHeadless) state.colorbarsVisible = true;

    // Config: ?config=… (render dir, headless) else data/render-config.json (static site).
    const cfgUrl = params.get('config') || (DATA + 'render-config.json');
    const rc = state.isHeadless ? await fetchJSONStrict(cfgUrl)
                          : await fetchJSON(cfgUrl, { preset: 'freeDefault', style: {} });
    state.preset = params.get('preset') || rc.preset || 'freeDefault';
    config = (rc.layout && !params.get('preset')) ? resolveConfig(rc) : resolveConfig(state.preset, { style: rc.style || {} });

    colormaps = loadColormaps(state.isHeadless ? await fetchJSONStrict(DATA + 'colormaps.json')
                                         : await fetchJSON(DATA + 'colormaps.json', { n: 2, maps: {} }));
    if (state.isHeadless && colormaps.size === 0) throw new Error('colormaps.json contained no colormaps');
    baseScene = await loadBaseScene(DATA);

    // preserveDrawingBuffer for the headless screenshot path; CSS-driven pixelRatio interactively.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: state.isHeadless });
    renderer.setPixelRatio(state.isHeadless ? (config.render.pixelRatio || 2) : window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);

    if (state.isHeadless) { await runHeadless(); return; }

    // ---- interactive ----
    document.body.classList.toggle('nobar', config.render.colorbar === false);
    bindGlobalControls({
        config, colormaps, preset: state.preset,
        getEngine: () => engine,
        onUpload: handleUpload,
        onPreset: setPreset,
        onParcellation: setParcellationUI,
    });
    populateAtlasPicker();
    initKapow(document.getElementById('c-kapow'));
    document.getElementById('c-save-brain').addEventListener('click', saveBrain);
    document.getElementById('c-save-bars').addEventListener('click', saveBars);
    document.getElementById('c-gif')?.addEventListener('click', exportGif);
    document.getElementById('c-colorbar').addEventListener('click', () => setColorbarVisible(!state.colorbarsVisible));
    document.getElementById('c-cli').addEventListener('click', copyCliCommand);
    document.getElementById('c-slice-anat')?.addEventListener('click', () => setSliceAnatomy(!config.style.sliceAnatomy));
    const cutBtn = document.getElementById('c-cut-overlay');
    const cutOptions = document.getElementById('c-cut-map-options');
    cutBtn?.classList.toggle('active', !!config.style.cutOverlay?.enabled);
    cutOptions?.classList.toggle('active', !!config.style.cutOverlay?.enabled);
    cutBtn?.addEventListener('click', () => setCutOverlay(!config.style.cutOverlay?.enabled));
    const slab = document.getElementById('c-cut-slab');
    const interp = document.getElementById('c-cut-interp');
    if (slab) {
        slab.value = config.style.cutOverlay?.slabMm ?? 80;
        slab.addEventListener('input', () => {
            config.style.cutOverlay.slabMm = Math.max(0, Number(slab.value) || 0);
            engine.applyStyle(); engine.renderFrame();
        });
    }
    if (interp) {
        interp.value = config.style.cutOverlay?.interpolation || 'linear';
        interp.addEventListener('change', () => {
            config.style.cutOverlay.interpolation = interp.value;
            engine.applyStyle(); engine.renderFrame();
        });
    }
    setupTemplateQA();
    // Help modal: open on ? Help, close on ✕, backdrop click, or Escape.
    const helpModal = document.getElementById('help-modal');
    const closeHelp = () => { if (helpModal) helpModal.hidden = true; };
    document.getElementById('c-help')?.addEventListener('click', () => { if (helpModal) helpModal.hidden = false; });
    document.getElementById('c-help-close')?.addEventListener('click', closeHelp);
    helpModal?.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && helpModal && !helpModal.hidden) closeHelp(); });
    // Demo: load the example Neurosynth maps on demand. Disable on click; loadNeurosynthDemo is
    // idempotent (demoLoaded guard), so a second click — or ?demo=1 then a click — can't stack dupes.
    const demoBtn = document.getElementById('c-demo');
    demoBtn.addEventListener('click', () => {
        demoBtn.disabled = true;
        loadNeurosynthDemo().catch((e) => { console.warn('demo load failed:', e); state.demoLoaded = false; demoBtn.disabled = false; });
    });
    // Viewer-wide drag-and-drop upload (drop a NIfTI anywhere on the canvas).
    const viewerEl = document.getElementById('viewer');
    ['dragenter', 'dragover'].forEach((ev) => viewerEl.addEventListener(ev, (e) => { e.preventDefault(); viewerEl.classList.add('dragging'); }));
    viewerEl.addEventListener('dragleave', (e) => { if (e.target === viewerEl) viewerEl.classList.remove('dragging'); });
    viewerEl.addEventListener('drop', (e) => {
        e.preventDefault(); viewerEl.classList.remove('dragging');
        const files = [...(e.dataTransfer?.files || [])].filter((f) => VOL_RE.test(f.name) || isSurfaceFile(f.name) || isParcelValueFile(f.name));
        if (files.length) handleUpload(files);
    });
    // Global Surface toggle: flip ALL loaded overlays to surface projection (and back to smooth).
    // Per-overlay re-mesh is lazy (setOverlaySurface); turning off is a pure style switch.
    const surfBtn = document.getElementById('c-surface-all');
    surfBtn?.addEventListener('click', async () => {
        if (!overlays.length) { setLoading('Load a map first.'); setTimeout(() => setLoading(null), 1500); return; }
        const turnOn = !surfBtn.classList.contains('active');
        surfBtn.classList.toggle('active', turnOn);
        surfBtn.disabled = true;
        try {
            if (turnOn) { for (let i = 0; i < overlays.length; i++) await setOverlaySurface(i); }
            else {
                for (let i = 0; i < overlays.length; i++) setOverlayStyle(config, i, { voxel: { representation: 'smooth' } });
                rebuild();
            }
        } finally { surfBtn.disabled = false; }
    });
    // Minimise/restore the bottom control panel (frees the collapsed height for the brains).
    document.getElementById('c-min').addEventListener('click', () => { document.body.classList.toggle('ctrl-min'); fit(); });
    // Whole-canvas zoom controls (the brains are a fixed size; these reframe the canvas).
    const zc = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    zc('c-zoom-in', () => engine.zoomViewAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
    zc('c-zoom-out', () => engine.zoomViewAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
    zc('c-zoom-fit', () => engine.fitView());
    // Randomise: give every loaded volume a different random colormap (no-op with none loaded).
    document.getElementById('c-random').addEventListener('click', randomizeColormaps);
    // Style presets: save/load the per-overlay + global style to the browser or a JSON file.
    createPresetsUI({
        button: document.getElementById('c-presets'),
        getConfig: () => config, getColormaps: () => colormaps, getNOverlays: () => overlays.length,
        download: downloadText,
        onApplied: () => {
            engine.applyStyle(); engine.recolor(); engine.applySmoothing();
            buildOverlayRows({ engine, config, colormaps, onRemove: removeOverlay, onSurface: setOverlaySurface, onReorder: reorderOverlays });
            syncGlobalControls();
        },
    });

    rebuild();                 // base glass brain renders immediately (no Pyodide)
    startLoopAndResize();
    if (config.style.sliceAnatomy || config.style.cutOverlay?.enabled) await setSliceAnatomy(true);
    setLoading(null);

    // Boot EMPTY — just the glass brain; the user uploads their own maps or clicks "Demo".
    // ?demo=1 auto-loads the example Neurosynth maps (meshed in-browser via Pyodide), the same
    // as the Demo button. ?baked=1 loads the single pre-baked overlay (instant + offline) — the
    // fast fixture used by the headless tests.
    const demoParam = params.get('demo');
    (demoParam === '1' ? loadNeurosynthDemo() : params.get('baked') === '1' ? loadBakedFixture() : Promise.resolve())
        .catch((e) => console.warn('demo overlays unavailable:', e));
}

function setupTemplateQA() {
    const btn = document.getElementById('c-template-qa');
    const modal = document.getElementById('template-qa-modal');
    if (!btn || !modal) return;
    const bundle = baseScene.templateBundle || {}, qa = bundle.alignment;
    const pass = qa?.status === 'pass';
    btn.textContent = qa ? `Template QA ${pass ? '✓' : '!'}` : 'Template QA —';
    btn.classList.toggle('pass', pass); btn.classList.toggle('fail', !!qa && !pass);
    const set = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
    set('qa-status', qa ? (pass ? 'PASS — registered bundle' : 'FAIL — bundle rejected') : 'not measured');
    document.getElementById('qa-status')?.classList.toggle('fail', !!qa && !pass);
    set('qa-summary', `${bundle.id || 'Template'} · ${bundle.space || 'unknown space'} · ${bundle.coordinateSystem || 'unknown axes'}. `
        + (qa ? `Measured with ${qa.method}.` : 'This legacy bundle has no stored alignment measurement.'));
    set('qa-lh', qa?.hemispheres?.lh?.p95Mm != null ? `${qa.hemispheres.lh.p95Mm} mm` : '—');
    set('qa-rh', qa?.hemispheres?.rh?.p95Mm != null ? `${qa.hemispheres.rh.p95Mm} mm` : '—');
    set('qa-tol', qa?.toleranceMm != null ? `${qa.toleranceMm} mm` : '—');
    set('qa-surfaces', Object.keys(bundle.surfaces || {}).join(' · ') || 'none');
    set('qa-contract', `Transform: ${bundle.transformId || 'legacy / undeclared'}. Anatomy, segmentation, and every surface must declare this same world transform; a failed stored alignment prevents the viewer from loading.`);
    const close = () => { modal.hidden = true; };
    btn.addEventListener('click', () => { modal.hidden = false; });
    document.getElementById('c-template-qa-close')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
}

/** Headless render (comic render): fixed-size figure, overlays from the manifest's
 *  array .bin files, a few frames, then window.__GB_DONE__ for the Playwright screenshot. */
async function runHeadless() {
    for (const sel of ['#controls', '.kapow-toggle', '.title']) {
        const el = document.querySelector(sel); if (el) el.style.display = 'none';
    }
    container.style.width = config.render.width + 'px';
    container.style.height = config.render.height + 'px';
    // Pin the DESIGN size to the render size so the view transform is the identity
    // (s=1, centred, viewport == design) → the headless figure is byte-identical to before.
    config.layout.canvas = { ...(config.layout.canvas || {}), w: config.render.width, h: config.render.height };

    const metas = baseScene.manifest.overlays || [];
    overlays = [];
    for (let oi = 0; oi < metas.length; oi++) {
        const buffers = await loadOverlayArrays(DATA, metas[oi]);
        overlays.push(makeOverlay(metas[oi], buffers, oi));
    }
    rebuild();   // engine + (colorbar, no ✕) for the current overlays

    // Scissor cut-cap: if the spec asks for it, load the anatomy volume + attach it BEFORE the
    // screenshot (the load is async; without awaiting it here __GB_DONE__ would fire cap-less).
    if (config.style.sliceAnatomy || config.style.cutOverlay?.enabled) {
        try { anatomyVol = await loadAnatomyVolume(DATA, baseScene.templateBundle); engine.setAnatomyVolume(anatomyVol); }
        catch (err) { console.warn('slice anatomy asset unavailable:', err); }
    }
    // Parcellation borders — same "await before the screenshot" rule as the cut anatomy. NOT
    // wrapped in a try: a figure that asked for an atlas and silently rendered without it would
    // be a wrong figure, so a missing/mismatched atlas must fail the render loudly.
    const parc = config.style.parcellation;
    if ((parc?.enabled || parc?.maskMedialWall) && parc.atlas)
        engine.setParcellation(parc.atlas, await loadParcellation(parc.atlas, DATA));

    // Brain fills the full figure (no strip → never squashed); render.py hides/shows the
    // colorbar to screenshot it separately. Wait for the web font so colorbar ticks settle.
    document.documentElement.style.setProperty('--cbstrip', '0px');
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
    engine.resize(canvas.clientWidth, canvas.clientHeight);
    // M3: reproduce a panned/zoomed canvas from the spec. Gated on a non-identity view so the
    // default (s=1) is a no-op and every existing headless figure stays byte-identical.
    const lv = config.layout.view;
    if (lv && lv.s != null && (lv.s !== 1 || lv.cx != null || lv.cy != null)) engine.setView(lv);
    document.getElementById('loading').style.display = 'none';
    for (let i = 0; i < 4; i++) { engine.renderFrame(); colorbar?.update(); }
    requestAnimationFrame(() => {
        engine.renderFrame(); colorbar?.update();
        requestAnimationFrame(() => { window.__GB_DONE__ = true; });
    });
    window.__engine = () => engine;
    window.__contentBBox = () => contentBBoxPx(engine);   // for `--crop content` (tight brain crop)

    // Turntable fast path: spin EVERY panel to a given yaw (added to its base rotation) and
    // re-render in place — NO page reload. render.py drives this per frame, so an N-frame orbit is
    // ONE page load (one WebGL context) instead of N. The engine reads def.rotate live, so mutating
    // the config panels + renderFrame re-frames (rotation-invariant size) and redraws.
    const __orbitBase = (config.layout.panels || []).map((p) => (p.rotate && p.rotate.yaw) || 0);
    window.__GB_orbit = (yawDeg) => {
        engine.setSpinFit(true);   // constant-size sphere fit across the spin (no bounce)
        const panels = config.layout.panels || [];
        for (let i = 0; i < panels.length; i++) {
            panels[i].rotate = { ...(panels[i].rotate || {}), yaw: __orbitBase[i] + yawDeg };
        }
        for (let k = 0; k < 3; k++) engine.renderFrame();
    };
}

/** Load the single pre-baked overlay (static files) — identical path to a live upload.
 *  Instant + offline (no Pyodide); the headless tests boot this via ?baked=1. */
async function loadBakedFixture() {
    const meta = await fetch(DATA + 'demo/meta.json?' + DEMO_ASSET_VER).then((r) => r.json());
    const buffers = await loadOverlayArrays(DATA + 'demo/', meta, DEMO_ASSET_VER);
    addOverlay(meta, buffers);
}

/** Whether the current composition contains a hybrid panel that paints cortical statistics on
 *  the surface while retaining subcortical voxels as a volume. This is panel-specific: the same
 *  overlay can remain blocky in an ordinary lateral panel and surface-painted in a paired panel. */
function layoutNeedsSurface() {
    return (config.layout?.panels || []).some((p) => p.content?.representation === 'surface');
}

/** Ensure one volume overlay owns a cortical surface projection, without changing its global
 *  representation. Paired cortex+subcortex panels consume this geometry through their own
 *  content.representation='surface'; ordinary panels continue to use the overlay's chosen mode. */
async function ensureOverlaySurfaceGeometry(i, automatic = false) {
    const o = overlays[i];
    if (!o) return false;
    if (o._surfaced || o.meta?.surface || o.meta?.surfaceOnly) { o._surfaced = true; return false; }
    if (!o.src?.file) return false;
    if (o._surfacePromise) return o._surfacePromise;

    o._surfacePromise = (async () => {
        const note = automatic
            ? 'Combined cortex + subcortex views paint cortical values on the surface.'
            : 'First use loads the cortical surface (~11 MB), then re-meshes.';
        const { meta, buffers } = await processNifti(o.src.file, o.src.threshold,
            (m) => setLoading(m, note), true);
        if (o.meta?.name) meta.name = o.meta.name;
        for (const mo of o.meshObjs) mo.mesh.geometry.dispose();
        o.meta = meta;
        o.meshObjs = buildOverlayMeshes(meta, buffers, i);
        o.cutVolume = buildCutVolume(meta, buffers);
        o._surfaced = true;
        return true;
    })();
    try { return await o._surfacePromise; }
    finally { o._surfacePromise = null; }
}

/** Lazily add surface geometry when a layout/view begins to require it. Several quick view
 *  changes share one job; the engine is rebuilt once after every eligible overlay is ready. */
async function ensureLayoutSurfaces() {
    if (!layoutNeedsSurface() || !overlays.length) return false;
    if (surfaceLayoutPromise) return surfaceLayoutPromise;
    surfaceLayoutPromise = (async () => {
        let changed = false;
        let failed = false;
        try {
            for (let i = 0; i < overlays.length; i++)
                changed = (await ensureOverlaySurfaceGeometry(i, true)) || changed;
            if (changed) rebuild();
            return changed;
        } catch (err) {
            failed = true;
            console.error(err);
            setLoading('Cortical surface projection failed: ' + (err && err.message));
            setTimeout(() => setLoading(null), 3000);
            return false;
        } finally {
            surfaceLayoutPromise = null;
            if (!failed) setLoading(null);
        }
    })();
    return surfaceLayoutPromise;
}

/** Load the example Neurosynth maps (data/defaults/manifest.json) — the "Demo" figure.
 *  These are the raw NIfTIs (tiny), meshed in-browser via the SAME Pyodide path as a
 *  user upload (so the result is identical to dragging them in). The first one boots
 *  Pyodide (~30 MB, once). Falls back to the pre-baked overlay if the manifest is missing. */
async function loadNeurosynthDemo() {
    if (state.demoLoaded) return;     // idempotent: ?demo=1 + the Demo button must never stack duplicate overlays
    state.demoLoaded = true;
    const man = await fetchJSON(DATA + 'defaults/manifest.json', null);
    if (!man || !Array.isArray(man.overlays) || !man.overlays.length) return loadBakedFixture();
    const note = 'First load fetches the ~30 MB scientific stack once, then meshes the maps.';
    for (const ov of man.overlays) {
        try {
            const blob = await fetch(DATA + 'defaults/' + ov.file).then((r) => r.blob());
            const { meta, buffers } = await processNifti(new File([blob], ov.file), ov.threshold ?? 2.3,
                (m) => setLoading(m + ' — ' + (ov.name || ov.file), note), layoutNeedsSurface());
            if (ov.name) meta.name = ov.name;
            overlays.push(makeOverlay(meta, buffers, overlays.length,
                { file: new File([blob], ov.file), threshold: ov.threshold ?? 2.3 }));
            (config.style.overlays ||= []).push(ov.style || {});
        } catch (e) { console.warn('default overlay failed:', ov.file, e); }
    }
    if (overlays.length) rebuild();
    setLoading(null);
}

/** Build + register one overlay from a (meta, flat-buffers) pair, then rebuild. `src`
 *  ({file, threshold}) is kept so the overlay can be re-meshed for surface mode. */
function addOverlay(meta, buffers, src, initialStyle = {}) {
    overlays.push(makeOverlay(meta, buffers, overlays.length, src));
    (config.style.overlays ||= []).push(initialStyle);
    rebuild();
}

/** Switch overlay i to/from surface-projection mode. Surface geometry is meshed on demand
 *  (re-runs the pipeline with surface=True, lazy-loading the cortical sidecar) the first time. */
async function setOverlaySurface(i, repSel) {
    const o = overlays[i];
    if (!o) return;
    try {
        if (!o._surfaced && (!o.src || !o.src.file)) {
            setLoading('Surface mode needs a re-meshable map (drag a NIfTI in, or use Demo).');
            setTimeout(() => setLoading(null), 2600);
            if (repSel) repSel.value = o.meta && o.meta.surface ? 'surface' : 'smooth';
            return;
        }
        await ensureOverlaySurfaceGeometry(i, false);
        setLoading(null);
        setOverlayStyle(config, i, { voxel: { representation: 'surface' } });
        rebuild();
    } catch (err) {
        console.error(err);
        setLoading('Surface projection failed: ' + (err && err.message));
        setTimeout(() => setLoading(null), 3000);
        if (repSel) repSel.value = 'smooth';
    }
}

/** Process uploaded File(s) entirely in-browser (lazy-loads Pyodide). Routes NIfTI volumes and
 *  native fsaverage surface maps (.gii/.mgh/.mgz, paired by hemisphere) to their own pipelines. */
async function handleUpload(files) {
    const parcelFiles = files.filter((f) => isParcelValueFile(f.name));
    const surfaceFiles = files.filter((f) => isSurfaceFile(f.name));
    const volumeFiles = files.filter((f) => !isSurfaceFile(f.name) && !isParcelValueFile(f.name) && VOL_RE.test(f.name));
    // isFinite (not `|| 2.3`): a deliberate threshold of 0 (unthresholded finite voxels)
    // is valid and must not be clobbered to the default.
    const thr = (v => isFinite(v) ? v : 0)(parseFloat(document.getElementById('c-threshold').value));
    const note = 'First upload downloads the ~30 MB scientific stack once.';
    try {
        for (let k = 0; k < volumeFiles.length; k++) {
            const tag = volumeFiles.length > 1 ? ` (${k + 1}/${volumeFiles.length})` : '';
            const { meta, buffers } = await processNifti(volumeFiles[k], thr,
                (m) => setLoading(m + tag, note), layoutNeedsSurface());
            if (!meta.structures || Object.keys(meta.structures).length === 0) {
                setLoading('No brain voxels classified for ' + meta.name + '.',
                    'Maps must be in MNI152 space and survive the threshold.');
                await new Promise((r) => setTimeout(r, 2500));
                continue;
            }
            // Preserve the bake threshold in the per-map style. An unthresholded continuous map
            // must also disable the inherited cluster-extent cutoff; otherwise it is not actually
            // unthresholded even though all of its geometry was loaded.
            const initialStyle = thr === 0 ? { threshold: 0, voxel: { clusterMin: 0 } } : { threshold: thr };
            addOverlay(meta, buffers, { file: volumeFiles[k], threshold: thr }, initialStyle);
        }
        // Surface maps: pair lh/rh by filename, one overlay per pair (or per lone hemisphere).
        const groups = groupSurfaceFiles(surfaceFiles);
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const name = surfaceOverlayName(g);
            const tag = groups.length > 1 ? ` (${gi + 1}/${groups.length})` : '';
            const { meta, buffers } = await processSurface(g.lh, g.rh, name, thr, (m) => setLoading(m + tag, note));
            if (!meta.surface || Object.keys(meta.surface).length === 0) {
                setLoading('No supra-threshold vertices for ' + name + '.',
                    'Surface maps must be on fsaverage (163842 vertices/hemisphere).');
                await new Promise((r) => setTimeout(r, 2500));
                continue;
            }
            addOverlay(meta, buffers, { surface: true, lh: g.lh, rh: g.rh, threshold: thr });
        }
        // Per-parcel value tables: infer the atlas, expand onto the vertices, paint through the
        // same surface path, and switch the matching borders on.
        for (const f of parcelFiles) await loadParcelValues(f, thr, note);
        setLoading(null);
    } catch (err) {
        console.error(err);
        setLoading('Error: ' + (err && err.message), 'See the browser console for details.');
        setTimeout(() => setLoading(null), 4000);
    }
}

/** Remove overlay i: free its GPU geometry, drop its style slot, rebuild. */
function removeOverlay(i) {
    const o = overlays[i];
    if (!o) return;
    for (const mo of o.meshObjs) mo.mesh.geometry.dispose();
    overlays.splice(i, 1);
    if (config.style.overlays) config.style.overlays.splice(i, 1);
    rebuild();
}

/** Move overlay `from` to position `to` (drag-to-reorder). Reorders the overlay AND its style slot
 *  in parallel; rebuild() re-tags meta.overlay by position, so layer/draw order follows. */
function reorderOverlays(from, to) {
    if (from === to || from < 0 || to < 0 || from >= overlays.length || to >= overlays.length) return;
    const [ov] = overlays.splice(from, 1); overlays.splice(to, 0, ov);
    const os = (config.style.overlays ||= []);
    while (os.length < overlays.length) os.push({});
    const [s] = os.splice(from, 1); os.splice(to, 0, s ?? {});
    rebuild();
}

/** Switch layout preset without a reload: swap only config.layout, keep overlays + style.
 *  'freeCanvas' is special: it bakes the CURRENT panels' on-screen rects into free `place`
 *  fractions (so the switch is visually seamless) and flips mode to 'free'. */
function setPreset(nameOrLayout) {
    // A saved custom layout (from localStorage) arrives as a raw layout object; a built-in
    // preset arrives as its string name.
    if (nameOrLayout && typeof nameOrLayout === 'object') {
        state.preset = 'custom';
        config.layout = resolveConfig({ layout: nameOrLayout }).layout;
        rebuild();
        void ensureLayoutSurfaces();
        return;
    }
    const name = nameOrLayout;
    state.preset = name;
    // Bake from DESIGN rects + the design size (view-transform-independent), so switching
    // to Free Canvas preserves the fixed layout regardless of the current zoom/pan.
    const v = engine.getView ? engine.getView() : { W0: canvas.clientWidth || 1, H0: canvas.clientHeight || 1 };
    config.layout = (name === 'freeCanvas')
        ? toFreeCanvas(config.layout, engine.getPanelDesignRects(), v.W0, v.H0)
        : resolveConfig(name).layout;
    rebuild();
    void ensureLayoutSurfaces();
}

/** Bake a grid layout into a Free Canvas document: each panel keeps its camera/content
 *  but is positioned by `place` fractions of the canvas (from its current on-screen rect).
 *  Per-panel auto-fit (not shared scale) so resizing a frame scales its brain. */
function toFreeCanvas(curLayout, rects, W, H) {
    const panels = curLayout.panels.map((p, i) => {
        const r = rects[i];
        const { cell, rowSpan, colSpan, ...rest } = p;     // drop grid-only fields
        return {
            ...rest,
            framing: { ...(p.framing || {}), fit: 'auto', margin: 1.1 },   // roomy: don't clip the volume
            place: { x: r.cssLeft / W, y: r.cssTop / H, w: r.w / W, h: r.h / H, z: i },
        };
    });
    return {
        mode: 'free',
        grid: curLayout.grid,
        canvas: { w: W, h: H, bgAlpha: (curLayout.canvas && curLayout.canvas.bgAlpha) ?? 1 },
        panels,
    };
}

/** Set the canvas background opacity (Free Canvas transparent background). Live, no
 *  rebuild: updates the renderer's clear alpha + a checkerboard body class so the user
 *  sees the transparency, and records it in config.layout.canvas for the CLI/Save-PNG. */
function setBgAlpha(a) {
    (config.layout.canvas ||= { w: canvas.clientWidth || 1, h: canvas.clientHeight || 1, bgAlpha: 1 }).bgAlpha = a;
    const bg = (config.render && config.render.background) || '#ffffff';
    renderer.setClearColor(new THREE.Color(bg), a);
    document.body.classList.toggle('fc-transparent', a < 1);
}

function showCutMapOptions(on) {
    document.getElementById('c-cut-map-options')?.classList.toggle('active', !!on);
}

/** Toggle the scissor cut-cap (anatomical T1 cross-section on sliced faces). Loads the volume
 *  asset on first enable (~3 MB compressed), then binds it to the engine; disabling detaches it. */
async function setSliceAnatomy(on) {
    config.style.sliceAnatomy = on;
    const btn = document.getElementById('c-slice-anat');
    if (btn) btn.classList.toggle('active', on);
    if (on) {
        if (!anatomyVol) {
            try {
                setLoading('Loading anatomy (T1) for the cut view…');
                anatomyVol = await loadAnatomyVolume(DATA, baseScene.templateBundle);
            } catch (err) {
                console.error(err); config.style.sliceAnatomy = false;
                config.style.cutOverlay.enabled = false;
                if (btn) btn.classList.remove('active');
                document.getElementById('c-cut-overlay')?.classList.remove('active');
                showCutMapOptions(false);
                setLoading('Anatomy asset unavailable.'); setTimeout(() => setLoading(null), 2500);
                return;
            }
            setLoading(null);
        }
        engine.setAnatomyVolume(anatomyVol);
    } else {
        // A statistical cut overlay is composited onto the MRI face, so it cannot remain
        // active after that face is removed.
        config.style.cutOverlay.enabled = false;
        document.getElementById('c-cut-overlay')?.classList.remove('active');
        showCutMapOptions(false);
        engine.setAnatomyVolume(null);
    }
    engine.renderFrame();
}

/** Toggle thresholded statistical values on the exposed MRI face. Enabling it also enables
 *  Cut MRI because the registered, opaque T1 cap is the masking/depth surface it composes on. */
async function setCutOverlay(on) {
    config.style.cutOverlay.enabled = !!on;
    document.getElementById('c-cut-overlay')?.classList.toggle('active', !!on);
    showCutMapOptions(on);
    if (on && (!config.style.sliceAnatomy || !anatomyVol)) await setSliceAnatomy(true);
    else { engine.applyStyle(); engine.renderFrame(); }
}

/**
 * A table of per-parcel values → a painted brain with its atlas borders on.
 *
 * The atlas is inferred from the row count, and from region names when the file has them. When the
 * count alone is ambiguous — every Schaefer size exists in both a 7- and a 17-network variant, and
 * the two disagree about which parcel each row is — the user is asked rather than guessed at.
 */
async function loadParcelValues(file, thr, note) {
    setLoading('Reading ' + file.name + '…', note);
    const parsed = parseValueTable(await file.text());

    // Offer only atlases whose payload this install actually has (index.json is committed but the
    // non-redistributable atlases are git-ignored, so it can over-promise on a fresh clone).
    const { atlases } = await loadParcellationIndex(DATA);
    const present = Object.fromEntries(await Promise.all(Object.entries(atlases).map(async ([k, v]) =>
        [k, (await fetch(`${DATA}parcels/${k}.bin.gz`, { method: 'HEAD' }).then((r) => r.ok).catch(() => false)) ? v : null])));
    const available = Object.fromEntries(Object.entries(present).filter(([, v]) => v));

    // When the file carries region names they can settle a length tie outright, but that needs the
    // candidates' name lists. Fetch just the sidecars (names only, not the label payload), and only
    // for the atlases the row count already narrowed us to.
    let nameLists = {};
    if (parsed.names) {
        const shortlist = Object.entries(available).filter(([, a]) => a.nparcels === parsed.values.length);
        nameLists = Object.fromEntries(await Promise.all(shortlist.map(async ([k]) =>
            [k, await fetch(`${DATA}parcels/${k}.json`).then((r) => (r.ok ? r.json() : null))
                .then((j) => (j ? j.names : [])).catch(() => [])])));
    }
    const { candidates, reason } = inferAtlas(parsed, available, nameLists);
    if (!candidates.length) {
        const sizes = [...new Set(Object.values(available).map((a) => a.nparcels))].sort((a, b) => a - b);
        throw new Error(`${file.name}: ${reason}. Baked atlases have ${sizes.join(', ')} parcels`
            + ' — bake more with `comic parcels bake`.');
    }
    const atlasName = candidates.length === 1 ? candidates[0]
        : await askAtlas(candidates, (k) => available[k].label || k,
            `${file.name}: ${reason}. Which is it?`);
    if (!atlasName) { setLoading(null); return; }             // dismissed

    setLoading('Loading ' + atlasName + '…', note);
    const atlas = await loadParcellation(atlasName, DATA);

    // A bare vector is positional, so it is only safe where the parcel ORDER is canonical. For an
    // atlas that spells a region identically in both hemispheres (aparc, yeo7) the order is the
    // FreeSurfer colour-table order, which is not alphabetical — while most exports of those
    // atlases are. Accepting a bare vector there would mis-assign nearly every region silently.
    if (!parsed.names && available[atlasName].uniqueNames === false)
        throw new Error(`${atlasName} needs a table with region names: its regions are named the same in`
            + ' both hemispheres and its parcel order is not alphabetical, so a bare list of numbers'
            + ' cannot be matched up safely.');

    const ordered = parsed.names
        ? namedValuesToParcelOrder(parsed.names, parsed.values, atlas)
        : parsed.values;
    const maps = valuesToVertexMaps(ordered, atlas);

    const name = file.name.replace(/\.(csv|tsv|txt)$/i, '');
    // Threshold: a per-parcel table is not a z-map, so the map-wide default would blank it. An
    // epsilon hides only exact zeros — the medial wall and any parcel absent from the table —
    // leaving the cortex showing through there. Matches the CLI's --parcel-values behaviour.
    const eps = 1e-9;
    const { meta, buffers } = await processParcelValues(maps.lh, maps.rh, name, eps,
        (m) => setLoading(m, note));
    // surfaceBase makes the cortical sheet SOLID. Without it the unpainted medial wall is a hole
    // in the geometry, and you see the far side of the same hemisphere through it.
    addOverlay(meta, buffers, { surface: true, parcel: true, file, atlas: atlasName, threshold: eps },
        { threshold: eps, voxel: { surfaceBase: '#cccccc' } });

    // The borders that go with the data, on the atlas we just resolved.
    config.style.parcellation.atlas = atlasName;
    const sel = document.getElementById('c-parc-atlas');
    if (sel && [...sel.options].some((o) => o.value === atlasName)) sel.value = atlasName;
    await setParcellationUI({ enabled: true, atlas: atlasName });
}

/** Fill the atlas <select> from what this install actually has baked. An install with no
 *  parcels/ directory simply gets a disabled picker — the rest of the viewer is unaffected. */
async function populateAtlasPicker() {
    const sel = document.getElementById('c-parc-atlas');
    if (!sel) return;
    const { atlases } = await loadParcellationIndex(DATA);
    // index.json is committed but the non-redistributable atlases are git-ignored, so a fresh
    // clone (and the GitHub Pages artifact) can list atlases whose payload was never shipped.
    // One HEAD each, in parallel, keeps the picker honest about what this install can actually
    // load instead of offering a choice that 404s.
    const listed = Object.keys(atlases);
    const ok = await Promise.all(listed.map((n) => fetch(`${DATA}parcels/${n}.bin.gz`, { method: 'HEAD' })
        .then((r) => r.ok).catch(() => false)));
    const names = listed.filter((_, i) => ok[i]);
    if (!names.length) {
        sel.innerHTML = '<option>none baked</option>';
        sel.disabled = true;
        document.getElementById('c-parc')?.setAttribute('disabled', '');
        return;
    }
    sel.innerHTML = '';
    for (const n of names) {
        const o = document.createElement('option');
        o.value = n; o.textContent = atlases[n].label || n;
        sel.append(o);
    }
    config.style.parcellation.atlas ||= names[0];
    sel.value = config.style.parcellation.atlas;
}

/** Enable/disable borders, switch atlas, or re-derive after a `smooth` change.
 *  Fetches the label field on first use (~30-100 kB) and reverts the toggle if it fails. */
async function setParcellationUI({ enabled, atlas, mask }) {
    const p = config.style.parcellation;
    // Masking needs the atlas labels but not the borders, so it loads them without enabling them.
    if (mask) {
        if (p.maskMedialWall && !parcAtlas && p.atlas) {
            setLoading('Loading ' + p.atlas + '…');
            parcAtlas = await loadParcellation(p.atlas, DATA);
            engine.setParcellation(p.atlas, parcAtlas);
            setLoading(null);
        }
        engine.applyStyle();
        return;
    }
    const btn = document.getElementById('c-parc');
    if (atlas) p.atlas = atlas;
    if (enabled != null) p.enabled = enabled;
    if (!p.enabled) { btn?.classList.remove('active'); return; }
    if (!p.atlas) { p.enabled = false; btn?.classList.remove('active'); return; }
    try {
        setLoading(`Loading ${p.atlas} boundaries…`);
        parcAtlas = await loadParcellation(p.atlas, DATA);
        engine.setParcellation(p.atlas, parcAtlas);
        setLoading(null);
        btn?.classList.add('active');
    } catch (err) {
        console.error(err);
        p.enabled = false; parcAtlas = null;
        btn?.classList.remove('active');
        setLoading('Parcellation unavailable.'); setTimeout(() => setLoading(null), 2500);
    }
}

/** Dispose the old engine and recreate it for the current overlay set. */
function rebuild() {
    // Preserve the user's whole-canvas zoom/pan across rebuilds (overlay add/remove,
    // preset switch); fit-to-viewport once on the very first build.
    const prevView = (engine && engine.getView) ? engine.getView() : null;
    if (engine) engine.dispose();
    // Re-tag each overlay mesh with its CURRENT index (so removals renumber layers/styles).
    overlays.forEach((o, i) => o.meshObjs.forEach((mo) => { mo.meta.overlay = i; }));

    const sceneModel = {
        meshes: [...baseScene.meshes, ...overlays.flatMap((o) => o.meshObjs)],
        manifest: { ...baseScene.manifest, overlays: overlays.map((o) => o.meta) },
        cutVolumes: overlays.map((o) => o.cutVolume || null),
    };
    engine = createEngine({ renderer, width: canvas.clientWidth || 1, height: canvas.clientHeight || 1, sceneModel, colormaps, config });
    // Re-attach the anatomy cut-cap volume after a rebuild (the engine is recreated fresh);
    // the volume asset itself is cached, so this is just a texture rebind, not a re-fetch.
    if ((config.style.sliceAnatomy || config.style.cutOverlay?.enabled) && anatomyVol) engine.setAnatomyVolume(anatomyVol);
    // Same for the parcellation: the new engine's border geometries start empty. The label
    // arrays are already in memory, so this only re-derives the distance field.
    if ((config.style.parcellation?.enabled || config.style.parcellation?.maskMedialWall) && parcAtlas)
        engine.setParcellation(config.style.parcellation.atlas, parcAtlas);
    // Preserve the user's pan/zoom across rebuilds that KEEP the design size (overlay
    // add/remove). When the design size CHANGES (a preset switch), re-fit instead — a
    // carried-over view is centred/scaled for the old size and would overflow. The very
    // first fit happens in fit() once the canvas has its real (post-layout) size. Headless
    // keeps the default s=1/centred (design size = render size) so renders are byte-identical.
    if (!state.isHeadless && state.viewInitialized) {
        const nv = engine.getView();
        if (prevView && prevView.W0 === nv.W0 && prevView.H0 === nv.H0)
            engine.setView({ s: prevView.s, cx: prevView.cx, cy: prevView.cy });
        else
            engine.fitView();
    }

    // Colorbar: remove the previous one, recreate for the new overlay set (unless the
    // user has hidden it via ✕). The ✕ calls setColorbarVisible(false).
    if (colorbar) colorbar.el.remove();
    const showColorbar = config.render.colorbar !== false && overlays.length > 0 && state.colorbarsVisible;
    colorbar = showColorbar
        ? createColorbar(container, { engine, config, colormaps, onHide: state.isHeadless ? undefined : (() => setColorbarVisible(false)) })
        : null;
    document.body.classList.toggle('nobar', !colorbar);

    // Interactive-only chrome (control rows, the Colorbar toggle state, hover zoom buttons).
    if (!state.isHeadless) {
        const tgl = document.getElementById('c-colorbar'); if (tgl) tgl.classList.toggle('active', state.colorbarsVisible);
        buildOverlayRows({ engine, config, colormaps, onRemove: removeOverlay, onSurface: setOverlaySurface, onReorder: reorderOverlays });
        if (config.layout.mode === 'free') {
            // Free Canvas: the per-panel editor frames replace the hover +/- zoom.
            zoomEls.forEach((el) => el.remove()); zoomEls = [];
            if (!fcEditor) fcEditor = createFreeCanvasEditor({
                container, canvas, config, getEngine: () => engine,
                onStructureChange: () => { rebuild(); void ensureLayoutSurfaces(); },
                onViewChange: () => { void ensureLayoutSurfaces(); },
                onBgAlpha: setBgAlpha,
            });
            fcEditor.refresh();
        } else {
            if (fcEditor) { fcEditor.destroy(); fcEditor = null; }
            document.body.classList.remove('fc-transparent');   // grid presets are opaque
            rebuildPanelZoom();
        }
    }
    fit();
}

/** Show/hide the live colorbars. Hiding sets the strip to 0 so the brains reclaim the
 *  full canvas height (no squash); showing recreates the bars for the current overlays. */
function setColorbarVisible(v) {
    state.colorbarsVisible = v;
    const tgl = document.getElementById('c-colorbar'); if (tgl) tgl.classList.toggle('active', v);
    if (v && !colorbar && overlays.length) {
        colorbar = createColorbar(container, { engine, config, colormaps, onHide: () => setColorbarVisible(false) });
    } else if (!v && colorbar) {
        colorbar.el.remove();
        colorbar = null;
    }
    document.body.classList.toggle('nobar', !colorbar);
    fit();   // syncStrip + engine.resize → canvas height tracks the (now absent/present) strip
}

/** Give every loaded overlay a *distinct* random colormap, recolor, and rebuild the
 *  control rows so each picker reflects its new map. Colorbars track on the next frame
 *  (the RAF loop calls colorbar.update(), which re-reads the resolved style). */
function randomizeColormaps() {
    if (!colormaps.size || !overlays.length) return;
    const used = new Set();
    overlays.forEach((o, i) => { const name = randomColormapName(colormaps, used); used.add(name); setOverlayStyle(config, i, { colormap: name }); });
    engine.recolor();
    buildOverlayRows({ engine, config, colormaps, onRemove: removeOverlay, onSurface: setOverlaySurface, onReorder: reorderOverlays });
}

/** Push config.style's global fields back onto the surface-row controls (after a preset
 *  load) so the sliders/toggles reflect the new values (the render already used them). */
function syncGlobalControls() {
    const s = config.style;
    const setRange = (id, val) => {
        const el = document.getElementById(id); if (!el) return;
        el.value = val;
        const box = el.nextElementSibling;
        if (box && box.classList.contains('numbox')) box.value = Number.isInteger(val) ? String(val) : String(Math.round(val * 1e4) / 1e4);
    };
    const setToggle = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', !!on); };
    setToggle('c-inflate', s.cortexSurface === 'inflated');
    setToggle('c-outline', s.outline.enabled);
    setRange('c-cortex', s.glass.maxOpacity);
    setRange('c-outline-thresh', s.outline.threshold);
    setRange('c-outline-width', s.outline.width);
    setRange('c-directional', s.lighting.directional);
    setRange('c-ambient', s.lighting.ambient);
    const setColor = (id, hex) => { const el = document.getElementById(id); if (el && hex) el.value = hex; };
    setColor('c-line-color', s.outline.color);
    setColor('c-line-anat-color', s.outline.anatomyColor ?? s.outline.color);
    setColor('c-sil-color', s.outline.silhouette?.color ?? s.outline.color);
    setRange('c-sil-width', s.outline.silhouette?.width ?? s.outline.width);
    setToggle('c-parc', s.parcellation?.enabled);
    setToggle('c-parc-mask', s.parcellation?.maskMedialWall);
    setColor('c-parc-color', s.parcellation?.color);
    setRange('c-parc-width', s.parcellation?.width ?? 2.0);
}

// --- per-panel zoom controls (recreated each rebuild; layout/panel count can change) ---
function rebuildPanelZoom() {
    zoomEls.forEach((el) => el.remove());
    zoomEls = engine.getPanelRects().map((p, i) => {
        const el = document.createElement('div');
        el.className = 'panel-zoom';
        const plus = document.createElement('button'); plus.textContent = '+'; plus.title = 'Zoom in';
        const minus = document.createElement('button'); minus.textContent = '–'; minus.title = 'Zoom out';
        plus.addEventListener('click', (e) => { e.stopPropagation(); state.panelZoomUsed = true; engine.zoomPanel(i, 1.15); });
        minus.addEventListener('click', (e) => { e.stopPropagation(); state.panelZoomUsed = true; engine.zoomPanel(i, 1 / 1.15); });
        el.append(plus, minus);
        container.appendChild(el);
        return el;
    });
    placeZoom();
}
function placeZoom() {
    engine.getPanelRects().forEach((p, i) => {
        if (!zoomEls[i]) return;
        zoomEls[i].style.left = (p.cssLeft + 6) + 'px';
        zoomEls[i].style.top = (p.cssTop + 6) + 'px';
    });
}

// --- sizing + RAF loop (set up ONCE; read the live engine/colorbar each frame) ---
function syncStrip() {
    const strip = (!colorbar) ? 0 : Math.ceil(colorbar.el.getBoundingClientRect().height) + 22;
    document.documentElement.style.setProperty('--cbstrip', strip + 'px');
}
function fit() {
    syncStrip();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w > 0 && h > 0 && engine) {
        // Resize the VIEWPORT only — the design size (config.layout.canvas) is fixed, so the
        // brains keep their on-screen size; the view transform stays put (recentred on the
        // same design point). The user zooms/pans to reframe; Fit re-fits on demand.
        engine.resize(w, h);
        // Fit-to-viewport ONCE, now that the canvas has its real (post-layout) size. NEVER
        // in headless (rebuild() calls fit() there too) — the CLI render keeps s=1 (identity)
        // so it stays byte-identical to the pre-view-transform output.
        if (!state.isHeadless && !state.viewInitialized) { engine.fitView(); state.viewInitialized = true; }
        placeZoom(); fcEditor?.reposition();
    }
}
function startLoopAndResize() {
    new ResizeObserver(fit).observe(canvas);
    window.addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

    container.addEventListener('mousemove', (e) => {
        const r = container.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        engine.getPanelRects().forEach((p, i) =>
            zoomEls[i]?.classList.toggle('show', x >= p.cssLeft && x < p.cssLeft + p.w && y >= p.cssTop && y < p.cssTop + p.h));
    });
    container.addEventListener('mouseleave', () => zoomEls.forEach((el) => el.classList.remove('show')));

    // --- whole-canvas 2D pan + zoom (listen on the container in CAPTURE so it works even
    // over Free-Canvas frames). Wheel zooms toward the cursor anywhere. Pan on MIDDLE-drag
    // anywhere, or LEFT-drag over empty canvas (so left-drag on a frame still moves it). ---
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        engine.zoomViewAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false, capture: true });
    let panning = false, lastX = 0, lastY = 0;
    container.addEventListener('pointerdown', (e) => {
        const wantPan = e.button === 1 || (e.button === 0 && e.target === canvas);
        if (!wantPan) return;
        if (e.button === 1) e.stopPropagation();   // middle-drag pans even over a frame
        e.preventDefault();
        panning = true; lastX = e.clientX; lastY = e.clientY;
        container.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing';
    }, true);
    container.addEventListener('pointermove', (e) => {
        if (!panning) return;
        engine.panView(e.clientX - lastX, e.clientY - lastY); lastX = e.clientX; lastY = e.clientY;
    });
    const endPan = (e) => { if (panning) { panning = false; canvas.style.cursor = ''; container.releasePointerCapture?.(e.pointerId); } };
    container.addEventListener('pointerup', endPan);
    container.addEventListener('pointercancel', endPan);

    (function loop() { requestAnimationFrame(loop); engine.renderFrame(); colorbar?.update(); fcEditor?.reposition(); })();
    window.__engine = () => engine;   // debug handle
    // The tight content bbox in CSS px (used by `comic render --crop content` to
    // screenshot just the brains; computed at the default view, so it's reproducible).
    window.__contentBBox = () => contentBBoxPx(engine);
}

/** Build a `comic render` command reproducing the current view; copy it to the
 *  clipboard (falling back to a .txt download if the clipboard is unavailable). */
async function copyCliCommand() {
    const btn = document.getElementById('c-cli');
    const label = btn.textContent;
    // M3: capture the live whole-canvas pan/zoom into the config so buildSpec/figure.json
    // round-trips it (identity by default → existing figures unchanged).
    if (engine && engine.getView) { const v = engine.getView(); config.layout.view = { s: v.s, cx: v.cx, cy: v.cy }; }
    // Legend visibility is live UI state, so capture it in the exported display document.
    const exportConfig = { ...config, render: { ...config.render, colorbar: state.colorbarsVisible } };
    const text = buildRenderText({ config: exportConfig, overlays });
    const flash = (m) => { btn.textContent = m; setTimeout(() => { btn.textContent = label; }, 1600); };
    console.log(text);
    // Every browser figure uses the same complete recipe, including simple grids.
    const recipe = usesFigureSpec(exportConfig, overlays);
    if (recipe) downloadText(JSON.stringify(buildSpec(exportConfig, overlays), null, 2), 'figure.json');
    try {
        await navigator.clipboard.writeText(text);
        flash(!overlays.length ? 'Load a map' : recipe ? 'Copied + figure.json' : 'Copied!');
    } catch {
        downloadText(text, 'glassbrain-cli.txt');
        flash('Saved .txt');
    }
}

/** Trigger a client-side download of a text blob. */
function downloadText(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: name.endsWith('.json') ? 'application/json' : 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function downloadPng(cnv, name) {
    cnv.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
}

/** Render + download a spinning turntable GIF of the current view, entirely in the browser. */
async function exportGif() {
    const btn = document.getElementById('c-gif');
    if (!overlays.length) {
        setLoading('Load a map first.'); setTimeout(() => setLoading(null), 1500); return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    try {
        const bytes = await exportSpinGif({
            engine, config, canvas, frames: 48, degrees: 360, fps: 20,
            background: (config.render && config.render.background) || '#ffffff',
            onProgress: (p) => { btn.textContent = 'GIF ' + Math.round(p * 100) + '%'; },
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
        a.download = 'glassbrain_spin.gif';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
        console.error(e);
        setLoading('GIF export failed: ' + (e && e.message)); setTimeout(() => setLoading(null), 3000);
    } finally {
        btn.textContent = label; btn.disabled = false;
    }
}

/** Composite a colorbar element's bars + names + tick labels onto ctx `g`, with the
 *  element's top-left mapped to (0,0) minus `pad`. Shared by saveBars (and mirrors the
 *  CLI's element-screenshot of `.colorbar`). */
function compositeBars(g, el, pad, savePr) {
    const wrap = el.getBoundingClientRect();
    const ox = wrap.left - pad, oy = wrap.top - pad;
    g.textBaseline = 'top';
    el.querySelectorAll('.cbar-row').forEach((row) => {
        const bar = row.querySelector('canvas');
        const br = bar.getBoundingClientRect();
        g.drawImage(bar, (br.left - ox) * savePr, (br.top - oy) * savePr, br.width * savePr, br.height * savePr);
        const nm = row.querySelector('.cbar-name');
        if (nm) {
            const nr = nm.getBoundingClientRect();
            g.fillStyle = '#555'; g.font = `${10 * savePr}px sans-serif`;
            g.fillText(nm.textContent, (nr.left - ox) * savePr, (nr.top - oy) * savePr);
        }
        g.fillStyle = '#777';
        g.font = `${(config.render.colorbarFontSize ?? 11) * savePr}px ${config.render.colorbarFont || 'serif'}`;
        row.querySelectorAll('.colorbar-labels span').forEach((s) => {
            const sr = s.getBoundingClientRect();
            g.fillText(s.textContent, (sr.left - ox) * savePr, (sr.top - oy) * savePr);
        });
    });
}

/** Save the brains exactly as they are framed/styled in the live viewer, but
 * rerender the SAME CSS viewport at publication resolution before the tight crop. */
function saveBrain() {
    const btn = document.getElementById('c-save-brain');
    const label = btn.textContent; btn.textContent = 'Saving…';
    const basePr = window.devicePixelRatio || 1;
    try {
        // Keep the live viewport, colourbar allocation, pan/zoom, margins and style untouched.
        // Resolution changes only the backing-store sampling density.
        const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
        const maxTex = renderer.capabilities?.maxTextureSize || 8192;
        const maxSafePr = Math.max(1, Math.floor(maxTex / Math.max(cssW, cssH)));
        const savePr = Math.max(1, Math.min(6, Math.max(basePr, 4), maxSafePr));

        engine.setPixelRatio(savePr);
        // Outline widths live in device texels. Scale only by the ratio change so the saved
        // lines retain exactly the same CSS-space thickness as the live viewer.
        engine.scaleOutlines(savePr / basePr);
        engine.resize(cssW, cssH);
        engine.renderFrame();

        const out = document.createElement('canvas');
        out.width = Math.round(cssW * savePr); out.height = Math.round(cssH * savePr);
        const g = out.getContext('2d');
        if ((config.layout?.canvas?.bgAlpha ?? 1) >= 1) {
            g.fillStyle = (config.render && config.render.background) || '#ffffff';
            g.fillRect(0, 0, out.width, out.height);
        }
        // At savePr the WebGL backing store already has this exact size: this is a 1:1 copy,
        // not a low-resolution browser image being enlarged.
        g.drawImage(canvas, 0, 0, out.width, out.height);

        // Crop only; do not reframe or restyle.
        const box = contentBBoxPx(engine);
        let final = out;
        if (box && box.w >= 4 && box.h >= 4) {
            const cr = document.createElement('canvas');
            cr.width = Math.round(box.w * savePr); cr.height = Math.round(box.h * savePr);
            cr.getContext('2d').drawImage(out, Math.round(box.x * savePr), Math.round(box.y * savePr), cr.width, cr.height, 0, 0, cr.width, cr.height);
            final = cr;
        }
        downloadPng(final, 'glassbrain.png');
    } finally {
        engine.applyStyle();
        engine.setPixelRatio(basePr);
        fit();
        btn.textContent = label;
    }
}

/** Save the colorbars on their own as a separate image (a legend you place yourself). */
function saveBars() {
    const btn = document.getElementById('c-save-bars');
    const label = btn.textContent;
    if (!overlays.length) { btn.textContent = 'No bars'; setTimeout(() => { btn.textContent = label; }, 1200); return; }
    btn.textContent = 'Saving…';
    // If the bars are hidden, build a throwaway one just to composite from.
    const temp = !colorbar;
    const cb = colorbar || createColorbar(container, { engine, config, colormaps });
    // A hidden session sets body.nobar, which CSS-hides .colorbar — so a throwaway bar would have
    // ZERO layout size when measured (blank export). Drop nobar for this synchronous measure +
    // composite, then restore it; no repaint happens mid-function, so the bars never flash on screen.
    const hadNobar = document.body.classList.contains('nobar');
    if (hadNobar) document.body.classList.remove('nobar');
    cb.update();
    try {
        const pad = 8;
        const basePr = window.devicePixelRatio || 1;
        const savePr = Math.min(6, Math.max(basePr, 4));
        const wrap = cb.el.getBoundingClientRect();
        const out = document.createElement('canvas');
        out.width = Math.round((wrap.width + pad * 2) * savePr);
        out.height = Math.round((wrap.height + pad * 2) * savePr);
        const g = out.getContext('2d');
        g.fillStyle = (config.render && config.render.background) || '#ffffff';
        g.fillRect(0, 0, out.width, out.height);
        compositeBars(g, cb.el, pad, savePr);
        downloadPng(out, 'glassbrain_colorbars.png');
    } finally {
        if (temp) cb.el.remove();
        if (hadNobar) document.body.classList.add('nobar');   // restore the hidden state
        btn.textContent = label;
    }
}

main().catch((err) => {
    console.error(err);
    // Signal the headless render harness (render.py waits on __GB_ERR__) so a boot failure
    // fails the render loudly instead of hanging until the timeout.
    window.__GB_ERR__ = (err && err.message) || 'viewer failed to start';
    setLoading('Error: ' + (err && err.message));
});
