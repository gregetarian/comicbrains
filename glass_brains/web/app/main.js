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
import { loadBaseScene, buildOverlayMeshes, loadOverlayArrays } from '../scene/asset-loader.js';
import { createEngine } from '../scene/renderer.js';
import { createColorbar } from '../controls/colorbar.js';
import { initKapow } from '../controls/kapow.js';
import { bindGlobalControls, buildOverlayRows } from '../controls/bind.js';
import { buildRenderText } from '../controls/cli-export.js';
import { processNifti } from '../pyodide/bootstrap.js';

const DATA = 'data/';

// --- session state (engine + colorbar are recreated on every rebuild) ---
let renderer, colormaps, baseScene, config, engine, colorbar;
let overlays = [];   // [{ meta, meshObjs: [{ mesh, meta, values, aabb }, ...] }]
let zoomEls = [];
let container, canvas;
let preset;            // current layout preset name (for the CLI-command export)
let panelZoomUsed = false;  // the +/- buttons have no CLI equivalent; flag for the export note
let colorbarsVisible = true;  // live colorbar visibility (✕ to hide → brains reclaim full canvas)
let isHeadless = false;       // ?headless=1: render-to-PNG mode (no controls, no ✕, sets __GB_DONE__)

async function fetchJSON(url, fb) {
    try { const r = await fetch(url); if (!r.ok) throw 0; return await r.json(); }
    catch { return fb; }
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

    // Config: ?config=… (render dir, headless) else data/render-config.json (static site).
    const cfgUrl = params.get('config') || (DATA + 'render-config.json');
    const rc = await fetchJSON(cfgUrl, { preset: 'ninePanel', style: {} });
    preset = params.get('preset') || rc.preset || 'ninePanel';
    config = (rc.layout && !params.get('preset')) ? resolveConfig(rc) : resolveConfig(preset, { style: rc.style || {} });

    colormaps = loadColormaps(await fetchJSON(DATA + 'colormaps.json', { n: 2, maps: {} }));
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

    rebuild();                 // base glass brain renders immediately (no Pyodide)
    startLoopAndResize();
    setLoading(null);

    // Demo overlay from baked buffers — instant, no Pyodide download.
    loadDemo().catch((e) => console.warn('demo overlay unavailable:', e));
}

/** Headless render (glass-brains render): fixed-size figure, overlays from the manifest's
 *  array .bin files, a few frames, then window.__GB_DONE__ for the Playwright screenshot. */
async function runHeadless() {
    for (const sel of ['#controls', '.kapow-toggle', '.title']) {
        const el = document.querySelector(sel); if (el) el.style.display = 'none';
    }
    container.style.width = config.render.width + 'px';
    container.style.height = config.render.height + 'px';

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
    document.getElementById('loading').style.display = 'none';
    for (let i = 0; i < 4; i++) { engine.renderFrame(); colorbar?.update(); }
    requestAnimationFrame(() => {
        engine.renderFrame(); colorbar?.update();
        requestAnimationFrame(() => { window.__GB_DONE__ = true; });
    });
    window.__engine = () => engine;
}

/** Load the pre-baked demo overlay (static files) — identical path to a live upload. */
async function loadDemo() {
    const meta = await fetch(DATA + 'demo/meta.json').then((r) => r.json());
    const buffers = await loadOverlayArrays(DATA + 'demo/', meta);
    addOverlay(meta, buffers);
}

/** Build + register one overlay from a (meta, flat-buffers) pair, then rebuild. */
function addOverlay(meta, buffers) {
    const meshObjs = buildOverlayMeshes(meta, buffers, overlays.length);
    overlays.push({ meta, meshObjs });
    (config.style.overlays ||= []).push({});
    rebuild();
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
            addOverlay(meta, buffers);
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

/** Switch layout preset without a reload: swap only config.layout, keep overlays + style. */
function setPreset(name) {
    preset = name;
    config.layout = resolveConfig(name).layout;
    rebuild();
}

/** Dispose the old engine and recreate it for the current overlay set. */
function rebuild() {
    if (engine) engine.dispose();
    // Re-tag each overlay mesh with its CURRENT index (so removals renumber layers/styles).
    overlays.forEach((o, i) => o.meshObjs.forEach((mo) => { mo.meta.overlay = i; }));

    const sceneModel = {
        meshes: [...baseScene.meshes, ...overlays.flatMap((o) => o.meshObjs)],
        manifest: { ...baseScene.manifest, overlays: overlays.map((o) => o.meta) },
    };
    engine = createEngine({ renderer, width: canvas.clientWidth || 1, height: canvas.clientHeight || 1, sceneModel, colormaps, config });

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
        const tgl = document.getElementById('c-colorbar'); if (tgl) tgl.classList.toggle('active', colorbarsVisible);
        buildOverlayRows({ engine, config, colormaps, onRemove: removeOverlay });
        rebuildPanelZoom();
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
    if (w > 0 && h > 0 && engine) { engine.resize(w, h); placeZoom(); }
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

    (function loop() { requestAnimationFrame(loop); engine.renderFrame(); colorbar?.update(); })();
    window.__engine = () => engine;   // debug handle
}

/** Build a `glass-brains render` command reproducing the current view; copy it to the
 *  clipboard (falling back to a .txt download if the clipboard is unavailable). */
async function copyCliCommand() {
    const btn = document.getElementById('c-cli');
    const label = btn.textContent;
    const text = buildRenderText({ config, overlays, preset, colormaps, panelZoomUsed });
    const flash = (m) => { btn.textContent = m; setTimeout(() => { btn.textContent = label; }, 1600); };
    console.log(text);
    try {
        await navigator.clipboard.writeText(text);
        flash(overlays.length ? 'Copied!' : 'Load a map');
    } catch {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        a.download = 'glassbrain-cli.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        flash('Saved .txt');
    }
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
        engine.resize(cssW, cssH);
        engine.renderFrame();

        const out = document.createElement('canvas');
        out.width = Math.round(cssW * savePr); out.height = Math.round(cssH * savePr);
        const g = out.getContext('2d');
        g.fillStyle = (config.render && config.render.background) || '#ffffff';
        g.fillRect(0, 0, out.width, out.height);
        g.drawImage(canvas, 0, 0, out.width, out.height);
        downloadPng(out, 'glassbrain.png');
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
        btn.textContent = label;
    }
}

main().catch((err) => {
    console.error(err);
    setLoading('Error: ' + (err && err.message));
});
