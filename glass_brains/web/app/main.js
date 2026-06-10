/**
 * main.js — the ONE viewer entry, for both modes:
 *   interactive (default)  — the static/Pyodide app (served by Pages and `glass-brains
 *     open`): fixed fsaverage template from baked GLBs, demo overlay from baked buffers,
 *     uploads processed by the Pyodide pipeline (lazy-loaded on first upload). Overlays
 *     live in browser memory; the engine (which bakes N overlays into its
 *     materials/layers/passes) is disposed + recreated in place on each add/remove.
 *   headless (?headless=1) — used by `glass-brains render`: fixed size from config.render,
 *     controls hidden, overlays loaded from the manifest's array .bin files (produced by
 *     the in-process CPython pipeline), a few frames rendered, then window.__GB_DONE__ set
 *     for the Playwright driver to screenshot. Same engine + same array geometry as the browser.
 */
import * as THREE from 'three';
import { resolveConfig } from '../core/presets.js';
import { loadColormaps } from '../core/colormap.js';
import { setOverlayStyle } from '../core/config-schema.js';
import { createPresetsUI, randomColormapName } from '../controls/style-presets.js';
import { contentBBoxPx } from '../core/bbox.js';
import { loadBaseScene, buildOverlayMeshes, loadOverlayArrays } from '../scene/asset-loader.js';
import { createEngine } from '../scene/renderer.js';
import { createColorbar } from '../controls/colorbar.js';
import { initKapow } from '../controls/kapow.js';
import { bindGlobalControls, buildOverlayRows } from '../controls/bind.js';
import { buildRenderText, isFreeFigure, buildSpec } from '../controls/cli-export.js';
import { createFreeCanvasEditor } from '../controls/freecanvas.js';
import { processNifti } from '../pyodide/bootstrap.js';

const DATA = 'data/';

// --- session state (engine + colorbar are recreated on every rebuild) ---
let renderer, colormaps, baseScene, config, engine, colorbar;
let overlays = [];   // [{ meta, meshObjs: [{ mesh, meta, values, aabb }, ...] }]
let zoomEls = [];
let fcEditor = null;   // Free Canvas editor overlay (only in layout.mode === 'free')
let container, canvas;
let preset;            // current layout preset name (for the CLI-command export)
let panelZoomUsed = false;  // the +/- buttons have no CLI equivalent; flag for the export note
let colorbarsVisible = false;  // live colorbars OFF by default; the Colorbar button (or ✕) toggles them on
let demoLoaded = false;        // the Neurosynth Demo has loaded once (guards ?demo=1 + the Demo button against stacking duplicates)
let viewInitialized = false;   // the whole-canvas view has been fit-to-viewport once (then it's user-controlled)
let isHeadless = false;       // ?headless=1: render-to-PNG mode (no controls, no ✕, sets __GB_DONE__)

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
    isHeadless = params.get('headless') === '1';
    // Colorbars are off by default in the interactive viewer, but the headless/CLI render
    // path governs them via config.render.colorbar (render.py screenshots the .colorbar
    // element), so keep them present headlessly.
    if (isHeadless) colorbarsVisible = true;

    // Config: ?config=… (render dir, headless) else data/render-config.json (static site).
    const cfgUrl = params.get('config') || (DATA + 'render-config.json');
    const rc = isHeadless ? await fetchJSONStrict(cfgUrl)
                          : await fetchJSON(cfgUrl, { preset: 'freeDefault', style: {} });
    preset = params.get('preset') || rc.preset || 'freeDefault';
    config = (rc.layout && !params.get('preset')) ? resolveConfig(rc) : resolveConfig(preset, { style: rc.style || {} });

    colormaps = loadColormaps(isHeadless ? await fetchJSONStrict(DATA + 'colormaps.json')
                                         : await fetchJSON(DATA + 'colormaps.json', { n: 2, maps: {} }));
    if (isHeadless && colormaps.size === 0) throw new Error('colormaps.json contained no colormaps');
    baseScene = await loadBaseScene(DATA);

    // preserveDrawingBuffer for the headless screenshot path; CSS-driven pixelRatio interactively.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: isHeadless });
    renderer.setPixelRatio(isHeadless ? (config.render.pixelRatio || 2) : window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);

    if (isHeadless) { await runHeadless(); return; }

    // ---- interactive ----
    document.body.classList.toggle('nobar', config.render.colorbar === false);
    bindGlobalControls({
        config, colormaps, preset,
        getEngine: () => engine,
        onUpload: handleUpload,
        onPreset: setPreset,
    });
    initKapow(document.getElementById('c-kapow'));
    document.getElementById('c-save-brain').addEventListener('click', saveBrain);
    document.getElementById('c-save-bars').addEventListener('click', saveBars);
    document.getElementById('c-colorbar').addEventListener('click', () => setColorbarVisible(!colorbarsVisible));
    document.getElementById('c-cli').addEventListener('click', copyCliCommand);
    // Demo: load the example Neurosynth maps on demand. Disable on click; loadNeurosynthDemo is
    // idempotent (demoLoaded guard), so a second click — or ?demo=1 then a click — can't stack dupes.
    const demoBtn = document.getElementById('c-demo');
    demoBtn.addEventListener('click', () => {
        demoBtn.disabled = true;
        loadNeurosynthDemo().catch((e) => { console.warn('demo load failed:', e); demoLoaded = false; demoBtn.disabled = false; });
    });
    // Onboarding card's demo button + viewer-wide drag-and-drop upload (the card says "drop here").
    document.getElementById('onboard-demo')?.addEventListener('click', () => {
        demoBtn.disabled = true;
        loadNeurosynthDemo().catch((e) => { console.warn('demo load failed:', e); demoLoaded = false; demoBtn.disabled = false; });
    });
    const viewerEl = document.getElementById('viewer');
    ['dragenter', 'dragover'].forEach((ev) => viewerEl.addEventListener(ev, (e) => { e.preventDefault(); viewerEl.classList.add('dragging'); }));
    viewerEl.addEventListener('dragleave', (e) => { if (e.target === viewerEl) viewerEl.classList.remove('dragging'); });
    viewerEl.addEventListener('drop', (e) => {
        e.preventDefault(); viewerEl.classList.remove('dragging');
        const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.nii(\.gz)?$|\.gz$/i.test(f.name));
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
    setLoading(null);

    // Boot EMPTY — just the glass brain; the user uploads their own maps or clicks "Demo".
    // ?demo=1 auto-loads the example Neurosynth maps (meshed in-browser via Pyodide), the same
    // as the Demo button. ?baked=1 loads the single pre-baked overlay (instant + offline) — the
    // fast fixture used by the headless tests.
    const demoParam = params.get('demo');
    (demoParam === '1' ? loadNeurosynthDemo() : params.get('baked') === '1' ? loadBakedFixture() : Promise.resolve())
        .catch((e) => console.warn('demo overlays unavailable:', e));
}

/** Headless render (glass-brains render): fixed-size figure, overlays from the manifest's
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
        overlays.push({ meta: metas[oi], meshObjs: buildOverlayMeshes(metas[oi], buffers, oi) });
    }
    rebuild();   // engine + (colorbar, no ✕) for the current overlays

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
}

/** Load the single pre-baked overlay (static files) — identical path to a live upload.
 *  Instant + offline (no Pyodide); the headless tests boot this via ?baked=1. */
async function loadBakedFixture() {
    const meta = await fetch(DATA + 'demo/meta.json').then((r) => r.json());
    const buffers = await loadOverlayArrays(DATA + 'demo/', meta);
    addOverlay(meta, buffers);
}

/** Load the example Neurosynth maps (data/defaults/manifest.json) — the "Demo" figure.
 *  These are the raw NIfTIs (tiny), meshed in-browser via the SAME Pyodide path as a
 *  user upload (so the result is identical to dragging them in). The first one boots
 *  Pyodide (~30 MB, once). Falls back to the pre-baked overlay if the manifest is missing. */
async function loadNeurosynthDemo() {
    if (demoLoaded) return;     // idempotent: ?demo=1 + the Demo button must never stack duplicate overlays
    demoLoaded = true;
    const man = await fetchJSON(DATA + 'defaults/manifest.json', null);
    if (!man || !Array.isArray(man.overlays) || !man.overlays.length) return loadBakedFixture();
    const note = 'First load fetches the ~30 MB scientific stack once, then meshes the maps.';
    for (const ov of man.overlays) {
        try {
            const blob = await fetch(DATA + 'defaults/' + ov.file).then((r) => r.blob());
            const { meta, buffers } = await processNifti(new File([blob], ov.file), ov.threshold ?? 2.3,
                (m) => setLoading(m + ' — ' + (ov.name || ov.file), note));
            if (ov.name) meta.name = ov.name;
            overlays.push({ meta, meshObjs: buildOverlayMeshes(meta, buffers, overlays.length),
                            src: { file: new File([blob], ov.file), threshold: ov.threshold ?? 2.3 } });
            (config.style.overlays ||= []).push(ov.style || {});
        } catch (e) { console.warn('default overlay failed:', ov.file, e); }
    }
    if (overlays.length) rebuild();
    setLoading(null);
}

/** Build + register one overlay from a (meta, flat-buffers) pair, then rebuild. `src`
 *  ({file, threshold}) is kept so the overlay can be re-meshed for surface mode. */
function addOverlay(meta, buffers, src) {
    const meshObjs = buildOverlayMeshes(meta, buffers, overlays.length);
    overlays.push({ meta, meshObjs, src });
    (config.style.overlays ||= []).push({});
    rebuild();
}

/** Switch overlay i to/from surface-projection mode. Surface geometry is meshed on demand
 *  (re-runs the pipeline with surface=True, lazy-loading the cortical sidecar) the first time. */
async function setOverlaySurface(i, repSel) {
    const o = overlays[i];
    if (!o) return;
    try {
        if (!o.src || !o.src.file) {
            setLoading('Surface mode needs a re-meshable map (drag a NIfTI in, or use Demo).');
            setTimeout(() => setLoading(null), 2600);
            if (repSel) repSel.value = o.meta && o.meta.surface ? 'surface' : 'smooth';
            return;
        }
        if (!o._surfaced) {
            const { meta, buffers } = await processNifti(o.src.file, o.src.threshold,
                (m) => setLoading(m, 'First use loads the cortical surface (~11 MB), then re-meshes.'), true);
            for (const mo of o.meshObjs) mo.mesh.geometry.dispose();
            o.meta = meta; o.meshObjs = buildOverlayMeshes(meta, buffers, i); o._surfaced = true;
            setLoading(null);
        }
        setOverlayStyle(config, i, { voxel: { representation: 'surface' } });
        rebuild();
    } catch (err) {
        console.error(err);
        setLoading('Surface projection failed: ' + (err && err.message));
        setTimeout(() => setLoading(null), 3000);
        if (repSel) repSel.value = 'smooth';
    }
}

/** Process uploaded NIfTI File(s) entirely in-browser (lazy-loads Pyodide). */
async function handleUpload(files) {
    // isFinite (not `|| 2.3`): a deliberate threshold of 0 (keep all non-zero voxels)
    // is valid and must not be clobbered to the default.
    const thr = (v => isFinite(v) ? v : 2.3)(parseFloat(document.getElementById('c-threshold').value));
    try {
        for (let k = 0; k < files.length; k++) {
            const tag = files.length > 1 ? ` (${k + 1}/${files.length})` : '';
            const note = 'First upload downloads the ~30 MB scientific stack once.';
            const { meta, buffers } = await processNifti(files[k], thr,
                (m) => setLoading(m + tag, note));
            if (!meta.structures || Object.keys(meta.structures).length === 0) {
                setLoading('No brain voxels classified for ' + meta.name + '.',
                    'Maps must be in MNI152 space and survive the threshold.');
                await new Promise((r) => setTimeout(r, 2500));
                continue;
            }
            addOverlay(meta, buffers, { file: files[k], threshold: thr });
        }
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
function setPreset(name) {
    preset = name;
    // Bake from DESIGN rects + the design size (view-transform-independent), so switching
    // to Free Canvas preserves the fixed layout regardless of the current zoom/pan.
    const v = engine.getView ? engine.getView() : { W0: canvas.clientWidth || 1, H0: canvas.clientHeight || 1 };
    config.layout = (name === 'freeCanvas')
        ? toFreeCanvas(config.layout, engine.getPanelDesignRects(), v.W0, v.H0)
        : resolveConfig(name).layout;
    rebuild();
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
    };
    engine = createEngine({ renderer, width: canvas.clientWidth || 1, height: canvas.clientHeight || 1, sceneModel, colormaps, config });
    // Preserve the user's pan/zoom across rebuilds that KEEP the design size (overlay
    // add/remove). When the design size CHANGES (a preset switch), re-fit instead — a
    // carried-over view is centred/scaled for the old size and would overflow. The very
    // first fit happens in fit() once the canvas has its real (post-layout) size. Headless
    // keeps the default s=1/centred (design size = render size) so renders are byte-identical.
    if (!isHeadless && viewInitialized) {
        const nv = engine.getView();
        if (prevView && prevView.W0 === nv.W0 && prevView.H0 === nv.H0)
            engine.setView({ s: prevView.s, cx: prevView.cx, cy: prevView.cy });
        else
            engine.fitView();
    }

    // Colorbar: remove the previous one, recreate for the new overlay set (unless the
    // user has hidden it via ✕). The ✕ calls setColorbarVisible(false).
    if (colorbar) colorbar.el.remove();
    const showColorbar = config.render.colorbar !== false && overlays.length > 0 && colorbarsVisible;
    colorbar = showColorbar
        ? createColorbar(container, { engine, config, colormaps, onHide: isHeadless ? undefined : (() => setColorbarVisible(false)) })
        : null;
    document.body.classList.toggle('nobar', !colorbar);

    // Interactive-only chrome (control rows, the Colorbar toggle state, hover zoom buttons).
    if (!isHeadless) {
        const onb = document.getElementById('onboard'); if (onb) onb.style.display = overlays.length ? 'none' : 'flex';
        const tgl = document.getElementById('c-colorbar'); if (tgl) tgl.classList.toggle('active', colorbarsVisible);
        buildOverlayRows({ engine, config, colormaps, onRemove: removeOverlay, onSurface: setOverlaySurface, onReorder: reorderOverlays });
        if (config.layout.mode === 'free') {
            // Free Canvas: the per-panel editor frames replace the hover +/- zoom.
            zoomEls.forEach((el) => el.remove()); zoomEls = [];
            if (!fcEditor) fcEditor = createFreeCanvasEditor({
                container, canvas, config, getEngine: () => engine, onStructureChange: rebuild, onBgAlpha: setBgAlpha,
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
    colorbarsVisible = v;
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
}

// --- per-panel zoom controls (recreated each rebuild; layout/panel count can change) ---
function rebuildPanelZoom() {
    zoomEls.forEach((el) => el.remove());
    zoomEls = engine.getPanelRects().map((p, i) => {
        const el = document.createElement('div');
        el.className = 'panel-zoom';
        const plus = document.createElement('button'); plus.textContent = '+'; plus.title = 'Zoom in';
        const minus = document.createElement('button'); minus.textContent = '–'; minus.title = 'Zoom out';
        plus.addEventListener('click', (e) => { e.stopPropagation(); panelZoomUsed = true; engine.zoomPanel(i, 1.15); });
        minus.addEventListener('click', (e) => { e.stopPropagation(); panelZoomUsed = true; engine.zoomPanel(i, 1 / 1.15); });
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
        if (!isHeadless && !viewInitialized) { engine.fitView(); viewInitialized = true; }
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
    // The tight content bbox in CSS px (used by `glass-brains render --crop content` to
    // screenshot just the brains; computed at the default view, so it's reproducible).
    window.__contentBBox = () => contentBBoxPx(engine);
}

/** Build a `glass-brains render` command reproducing the current view; copy it to the
 *  clipboard (falling back to a .txt download if the clipboard is unavailable). */
async function copyCliCommand() {
    const btn = document.getElementById('c-cli');
    const label = btn.textContent;
    // M3: capture the live whole-canvas pan/zoom into the config so buildSpec/figure.json
    // round-trips it (identity by default → existing figures unchanged).
    if (engine && engine.getView) { const v = engine.getView(); config.layout.view = { s: v.s, cx: v.cx, cy: v.cy }; }
    const text = buildRenderText({ config, overlays, preset, colormaps, panelZoomUsed });
    const flash = (m) => { btn.textContent = m; setTimeout(() => { btn.textContent = label; }, 1600); };
    console.log(text);
    // For a Free Canvas figure, also hand the user figure.json (the command needs it).
    const free = overlays.length && isFreeFigure(config);
    if (free) downloadText(JSON.stringify(buildSpec(config), null, 2), 'figure.json');
    try {
        await navigator.clipboard.writeText(text);
        flash(!overlays.length ? 'Load a map' : free ? 'Copied + figure.json' : 'Copied!');
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

/** Save the brains ONLY at full resolution — no colorbars, never squashed. Temporarily
 *  drops the colorbar strip so the canvas fills the full container height. */
function saveBrain() {
    const btn = document.getElementById('c-save-brain');
    const label = btn.textContent; btn.textContent = 'Saving…';
    const basePr = window.devicePixelRatio || 1;
    const saved = { ow: config.style.outline.width, margin: config.style.margin };
    const barEl = colorbar && colorbar.el;
    try {
        if (barEl) barEl.style.display = 'none';
        document.documentElement.style.setProperty('--cbstrip', '0px');   // canvas → full height
        const cssW = canvas.clientWidth, cssH = canvas.clientHeight;       // forces reflow; cssH is now full
        const savePr = Math.min(4, Math.max(basePr, Math.ceil(3800 / cssW)));
        config.style.outline.width = saved.ow * 0.6;                       // print look: thinner lines
        config.style.margin = (saved.margin ?? 0.95) + 0.13;
        engine.applyStyle();
        engine.setPixelRatio(savePr);
        // Outline/edge widths are in DEVICE TEXELS, so the higher save pixel ratio would
        // thin them (and make the line-width slider look inert in the PNG). Compensate so
        // the saved line keeps its on-screen relative thickness. Restored by applyStyle() below.
        engine.scaleOutlines(savePr / basePr);
        engine.resize(cssW, cssH);
        engine.renderFrame();

        const out = document.createElement('canvas');
        out.width = Math.round(cssW * savePr); out.height = Math.round(cssH * savePr);
        const g = out.getContext('2d');
        // Transparent background (Free Canvas bgAlpha<1): skip the white fill so the saved
        // PNG keeps its alpha; the live canvas is already cleared with the same alpha.
        if ((config.layout?.canvas?.bgAlpha ?? 1) >= 1) {
            g.fillStyle = (config.render && config.render.background) || '#ffffff';
            g.fillRect(0, 0, out.width, out.height);
        }
        g.drawImage(canvas, 0, 0, out.width, out.height);
        // Crop to the tight bounding box of the visible brains (no clipping, small AA pad)
        // — the saved PNG is just the brains, not the whole (possibly zoomed/panned) canvas.
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
        config.style.outline.width = saved.ow;
        config.style.margin = saved.margin;
        if (barEl) barEl.style.display = '';
        engine.applyStyle();
        engine.setPixelRatio(basePr);
        fit();                  // recomputes the strip + canvas size and re-renders
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
        const savePr = Math.min(4, Math.max(basePr, 3));
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
