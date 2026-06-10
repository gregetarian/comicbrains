/**
 * bind.js — UI controls, static/in-browser variant.
 *
 * Forked from the server app's bind.js. Two differences:
 *  - Split into bindGlobalControls() (the static surface/light row, bound ONCE) and
 *    buildOverlayRows() (rebuilt on every overlay add/remove). The engine is recreated
 *    on each rebuild, so global handlers reach it through getEngine().
 *  - No server: upload / remove / layout-change call back into app.js (which runs the
 *    Pyodide pipeline and rebuilds the engine in-place) instead of POSTing + reloading.
 */
import { resolveColormap } from '../core/colormap.js';
import { overlayStyle, setOverlayStyle } from '../core/config-schema.js';
import { createCmapPicker } from './cmap-picker.js';

const $ = (id) => document.getElementById(id);
const trimNum = (v) => { const n = parseFloat(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4); };

// --- clickable info popovers: one shared box; click an anchor to toggle, click away to close.
// Each parameter's label (above its slider) is clickable; toggles/selects get a small ⓘ. ---
let _pop = null, _popFor = null;
function _popover() {
    if (_pop) return _pop;
    _pop = document.createElement('div');
    _pop.className = 'info-pop';
    document.body.appendChild(_pop);
    document.addEventListener('click', (e) => { if (!e.target.closest('.has-info, .info')) hideInfo(); }, true);
    window.addEventListener('resize', hideInfo);
    return _pop;
}
function hideInfo() { if (_pop) _pop.classList.remove('show'); _popFor = null; }
function showInfo(anchor, text) {
    const pop = _popover();
    if (_popFor === anchor) { hideInfo(); return; }            // click again to dismiss
    pop.textContent = text; pop.classList.add('show'); _popFor = anchor;
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    // prefer above (controls live in the bottom bar); fall back to below if no room
    pop.style.top = (r.top - pop.offsetHeight - 6 >= 0 ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + 'px';
}
/** Make a slider's label (the span above it, in .sw) a clickable info trigger. */
function infoLabel(rangeEl, tip) {
    if (!rangeEl || !tip) return;
    const label = rangeEl.closest('.sw')?.querySelector('span');
    if (!label) return;
    label.classList.add('has-info'); label.title = tip;
    label.addEventListener('click', (e) => { e.stopPropagation(); showInfo(label, tip); });
}
/** A small ⓘ button after a toggle/select that pops its info. */
function infoIcon(afterEl, tip) {
    if (!afterEl || !tip) return;
    const b = document.createElement('button');
    b.className = 'info'; b.type = 'button'; b.textContent = 'i'; b.title = tip; b.setAttribute('aria-label', 'info');
    b.addEventListener('click', (e) => { e.stopPropagation(); showInfo(b, tip); });
    afterEl.insertAdjacentElement('afterend', b);
}

const TIPS = {
    'c-inflate': 'Inflated cortical surface vs the folded pial surface.',
    'c-outline': 'Toggle the black cortical-surface outline.',
    'c-cortex': 'Cortex glass opacity. 0 = invisible (only the outline shows).',
    'c-outline-thresh': 'Surface-line density — higher hides shallower folds (fewer lines).',
    'c-outline-width': 'Surface (cortex outline) line thickness.',
    'c-directional': 'Directional (headlight) intensity — global.',
    'c-ambient': 'Ambient light intensity — global.',
};

function bindRange(el, value, oninput, { min, max, step } = {}, tip, propagate) {
    if (!el) return;
    if (min != null) el.min = min;
    if (max != null) el.max = max;
    if (step != null) el.step = step;
    el.value = value;
    if (tip) el.title = tip;
    const box = document.createElement('input');
    box.type = 'number'; box.className = 'numbox';
    if (min != null) box.min = min;
    if (max != null) box.max = max;
    if (step != null) box.step = step;
    if (tip) box.title = tip;
    box.value = trimNum(value);
    el.insertAdjacentElement('afterend', box);
    el.addEventListener('input', () => { box.value = trimNum(el.value); oninput(parseFloat(el.value)); });
    box.addEventListener('input', () => { const v = parseFloat(box.value); if (!isFinite(v)) return; el.value = v; oninput(parseFloat(el.value)); });
    infoLabel(el, tip);                              // clickable ⓘ on the label above the slider
    if (propagate) {                                 // "⇶": copy THIS value to every loaded volume
        const all = document.createElement('button');
        all.type = 'button'; all.className = 'btn propagate'; all.textContent = '⇶';
        all.title = 'Apply this value to every loaded volume';
        all.addEventListener('click', () => propagate(parseFloat(el.value)));
        box.insertAdjacentElement('afterend', all);
    }
}
function bindToggle(el, active, onchange, tip) {
    if (!el) return;
    // defer the ⓘ so it's inserted after the button is appended to the DOM (per-overlay
    // toggles are bound before append; globals are already in the DOM — both work).
    if (tip) { el.title = tip; queueMicrotask(() => infoIcon(el, tip)); }
    el.classList.toggle('active', !!active);
    el.addEventListener('click', () => { el.classList.toggle('active'); onchange(el.classList.contains('active')); });
}
const slider = (id, value, oninput, opts) => bindRange($(id), value, oninput, opts, TIPS[id]);
const toggle = (id, active, onchange) => bindToggle($(id), active, onchange, TIPS[id]);

function sw(labelText) {
    const wrap = document.createElement('div'); wrap.className = 'sw';
    const span = document.createElement('span'); span.textContent = labelText;
    const range = document.createElement('input'); range.type = 'range';
    wrap.append(span, range);
    return { wrap, range };
}
const btn = (text) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = text; return b; };

/** Build one control row per overlay. Re-callable: clears + rebuilds on each engine rebuild. */
export function buildOverlayRows({ engine, config, colormaps, onRemove }) {
    const host = $('overlay-rows'); if (!host) return;
    host.innerHTML = '';
    const overlays = engine.overlays || [];
    const multi = overlays.length > 1;
    // Copy ONE parameter's value onto every loaded volume, then refresh all rows (no confirm).
    const propagateAll = (patch) => {
        for (let k = 0; k < overlays.length; k++) setOverlayStyle(config, k, patch);
        engine.applyStyle(); engine.recolor(); engine.applySmoothing();
        buildOverlayRows({ engine, config, colormaps, onRemove });
    };
    // A per-overlay slider that (with >1 volume) shows a "⇶" to propagate its value to all.
    const ovRange = (el, val, oninput, opts, tip, patch) =>
        bindRange(el, val, oninput, opts, tip, multi && patch ? (v) => propagateAll(patch(v)) : null);
    overlays.forEach((ov, i) => {
        const os = overlayStyle(config, i);
        const maxAbs = ov.maxAbsValue ?? 1.0;
        let maxClu = ov.maxClusterSize ?? 0;
        if (!maxClu) {
            for (const t of (engine.sceneModel.meshes || [])) {
                if (t.meta.role === 'voxel' && (t.meta.overlay ?? 0) === i) {
                    const a = t.mesh.geometry.getAttribute('aClusterSize');
                    if (a) for (let k = 0; k < a.array.length; k++) { const v = a.array[k]; if (v < 1e8 && v > maxClu) maxClu = v; }
                }
            }
        }
        maxClu = Math.max(maxClu, 1);
        const set = (patch) => setOverlayStyle(config, i, patch);

        const row = document.createElement('div'); row.className = 'row overlay-row';
        const gName = document.createElement('div'); gName.className = 'grp';
        const nm = document.createElement('span'); nm.className = 'lab ov-name';
        nm.textContent = ov.name || ('NIfTI ' + (i + 1));
        nm.title = ov.name || '';
        // Show/hide this volume (toggles config.style.overlays[i].hidden; the renderer's
        // visibility gate skips a hidden overlay's voxels live — no rebuild needed).
        const eye = btn('👁'); eye.classList.add('eye');
        const hidden0 = !!(config.style.overlays && config.style.overlays[i] && config.style.overlays[i].hidden);
        eye.classList.toggle('off', hidden0); eye.title = hidden0 ? 'Show this volume' : 'Hide this volume';
        eye.addEventListener('click', () => {
            const h = !eye.classList.contains('off');
            set({ hidden: h }); eye.classList.toggle('off', h); eye.title = h ? 'Show this volume' : 'Hide this volume';
        });
        const rm = document.createElement('button'); rm.className = 'btn rm'; rm.textContent = '✕';
        rm.title = 'Remove this overlay';
        rm.addEventListener('click', () => onRemove(i));
        gName.append(nm, eye, rm); row.append(gName);

        const g = document.createElement('div'); g.className = 'grp';

        // Colormap picker with swatch previews: trigger (name + gradient), a popup of all
        // ~150 maps each with a swatch, and ‹ › steppers (live preview). Same apply path.
        const picker = createCmapPicker({
            colormaps,
            value: resolveColormap(os, !!ov.diverging, colormaps).name,
            onChange: (name) => { set({ colormap: name }); engine.recolor(); },
        });
        g.append(picker.el);
        infoIcon(picker.el, 'Colormap for this overlay — click for swatches, or step with ‹ ›. Each overlay can use a different one; sequential vs diverging is auto-picked from the data.');

        // Colour-scale mode (M11 parity: was CLI/notebook-only). Recolour only, no re-mesh.
        const modeSel = document.createElement('select'); modeSel.className = 'btn';
        for (const m of ['auto', 'sequential', 'diverging']) {
            const o = document.createElement('option'); o.value = m; o.textContent = m; modeSel.append(o);
        }
        modeSel.value = os.colormapMode || 'auto';
        modeSel.addEventListener('change', () => { set({ colormapMode: modeSel.value }); engine.recolor(); });
        g.append(modeSel);
        infoIcon(modeSel, 'Colour scale: auto (sequential/diverging picked from the data), or force one.');

        const smooth = btn('Smooth');
        bindToggle(smooth, os.representation === 'smooth', (on) => set({ voxel: { representation: on ? 'smooth' : 'blocky' } }), 'Smooth (marching-cubes) vs blocky voxels.');
        g.append(smooth);

        const thr = sw('thr');
        ovRange(thr.range, os.threshold ?? ov.threshold ?? 0, (v) => { set({ threshold: v }); engine.applyStyle(); }, { min: 0, max: maxAbs, step: maxAbs / 200 }, 'Statistical threshold — hide |value| below this.', (v) => ({ threshold: v }));
        g.append(thr.wrap);

        const clu = sw('cluster k');
        ovRange(clu.range, os.clusterMin ?? 0, (v) => { set({ voxel: { clusterMin: v } }); engine.applyStyle(); }, { min: 0, max: maxClu, step: 1 }, 'Cluster-extent threshold — hide clusters < N voxels.', (v) => ({ voxel: { clusterMin: v } }));
        g.append(clu.wrap);

        const sm = sw('smooth+');
        ovRange(sm.range, os.smoothing ?? 0, (v) => {
            set({ voxel: { smoothing: v } });
            // smooth+ only affects the SMOOTH mesh — if the overlay is showing blocky voxels
            // the smoothing would be invisible, so switch it to smooth when the user dials it up.
            if (v > 0) { set({ voxel: { representation: 'smooth' } }); smooth.classList.add('active'); }
            engine.applySmoothing(i);
        }, { min: 0, max: 20, step: 1 }, 'Extra surface smoothing of the smooth (marching-cubes) mesh — rounds rough cluster surfaces (size-preserving). Auto-switches the overlay to Smooth. 0 = off; most visible on large/irregular blobs.', (v) => ({ voxel: { smoothing: v } }));
        g.append(sm.wrap);

        const gam = sw('gamma');
        ovRange(gam.range, os.gamma ?? 0.5, (v) => { set({ gamma: v }); engine.recolor(); },
                { min: 0.2, max: 1.5, step: 0.05 },
                'Colormap gamma (power-law) — <1 lifts low values (0.5 = sqrt).', (v) => ({ gamma: v }));
        g.append(gam.wrap);

        const pos = btn('+only');
        bindToggle(pos, !!os.positiveOnly, (on) => { set({ positiveOnly: on }); engine.applyStyle(); }, 'Show only positive values.');
        g.append(pos);

        const edges = btn('Edges');
        bindToggle(edges, os.edges.enabled !== false, (on) => set({ voxel: { edges: { enabled: on } } }), 'Per-voxel edge outlines.');
        g.append(edges);

        const ew = sw('edge w');
        ovRange(ew.range, os.edges.width, (v) => { set({ voxel: { edges: { width: v } } }); engine.applyStyle(); }, { min: 0.3, max: 3, step: 0.1 }, 'Voxel edge thickness.', (v) => ({ voxel: { edges: { width: v } } }));
        g.append(ew.wrap);

        const veil = sw('veil');
        ovRange(veil.range, os.veil.strength, (v) => { set({ voxel: { veil: { strength: v } } }); engine.applyStyle(); }, { min: 0, max: 1, step: 0.02 }, 'Depth veil strength — fades deeper voxels toward white.', (v) => ({ voxel: { veil: { strength: v } } }));
        g.append(veil.wrap);

        const veilk = sw('veil log');
        ovRange(veilk.range, os.veil.k, (v) => { set({ voxel: { veil: { k: v } } }); engine.applyStyle(); }, { min: 0.1, max: 20, step: 0.1 }, 'Veil steepness.', (v) => ({ voxel: { veil: { k: v } } }));
        g.append(veilk.wrap);

        const em = sw('emissive');
        ovRange(em.range, os.emissive, (v) => { set({ voxel: { emissive: v } }); engine.applyStyle(); }, { min: 0, max: 1, step: 0.02 }, 'Flat colormap-colour brightness.', (v) => ({ voxel: { emissive: v } }));
        g.append(em.wrap);

        const sp = sw('specular');
        ovRange(sp.range, os.specular, (v) => { set({ voxel: { specular: v } }); engine.applyStyle(); }, { min: 0, max: 0.6, step: 0.01 }, 'Glossiness — specular glint amount.', (v) => ({ voxel: { specular: v } }));
        g.append(sp.wrap);

        const sh = sw('shine');
        ovRange(sh.range, os.shininess, (v) => { set({ voxel: { shininess: v } }); engine.applyStyle(); }, { min: 1, max: 200, step: 1 }, 'Highlight tightness.', (v) => ({ voxel: { shininess: v } }));
        g.append(sh.wrap);

        row.append(g); host.append(row);
    });
}

/** Bind the static global surface/light row + upload + layout. Called ONCE; reaches
 *  the live engine through getEngine() since the engine is recreated on rebuild. */
export function bindGlobalControls({ config, colormaps, getEngine, preset, onUpload, onPreset }) {
    const s = config.style;
    const apply = () => getEngine().applyStyle();

    const lay = $('c-layout');
    if (lay) {
        lay.value = preset || 'freeDefault';
        lay.addEventListener('change', () => onPreset(lay.value));
    }

    toggle('c-inflate', s.cortexSurface === 'inflated', (on) => { s.cortexSurface = on ? 'inflated' : 'pial'; });
    toggle('c-outline', s.outline.enabled, (on) => { s.outline.enabled = on; });
    slider('c-cortex', s.glass.maxOpacity, (v) => { s.glass.maxOpacity = v; apply(); }, { min: 0, max: 0.3, step: 0.005 });
    slider('c-outline-thresh', s.outline.threshold, (v) => { s.outline.threshold = v; apply(); }, { min: 0.001, max: 0.02, step: 0.0005 });
    slider('c-outline-width', s.outline.width, (v) => { s.outline.width = v; apply(); }, { min: 0.3, max: 8, step: 0.1 });
    slider('c-directional', s.lighting.directional, (v) => { s.lighting.directional = v; apply(); }, { min: 0, max: 4, step: 0.05 });
    slider('c-ambient', s.lighting.ambient, (v) => { s.lighting.ambient = v; apply(); }, { min: 0, max: 4, step: 0.05 });

    const up = $('c-upload');
    if (up) up.addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) onUpload(files);
    });
}
