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

const $ = (id) => document.getElementById(id);
const trimNum = (v) => { const n = parseFloat(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4); };

const TIPS = {
    'c-inflate': 'Inflated cortical surface vs the folded pial surface.',
    'c-outline': 'Toggle the black cortical-surface outline.',
    'c-cortex': 'Cortex glass opacity. 0 = invisible (only the outline shows).',
    'c-outline-thresh': 'Surface-line density — higher hides shallower folds (fewer lines).',
    'c-outline-width': 'Surface (cortex outline) line thickness.',
    'c-directional': 'Directional (headlight) intensity — global.',
    'c-ambient': 'Ambient light intensity — global.',
};

function bindRange(el, value, oninput, { min, max, step } = {}, tip) {
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
}
function bindToggle(el, active, onchange, tip) {
    if (!el) return;
    if (tip) el.title = tip;
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
const btn = (text) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = text; return b; };

function populateCmap(sel, colormaps) {
    if (!colormaps || !colormaps.size) return;
    const byCat = {};
    for (const [name, m] of colormaps) (byCat[m.category] ||= []).push(name);
    for (const cat of Object.keys(byCat).sort()) {
        const og = document.createElement('optgroup'); og.label = cat;
        for (const name of byCat[cat].sort()) { const o = document.createElement('option'); o.value = name; o.textContent = name; og.appendChild(o); }
        sel.appendChild(og);
    }
}

/** Build one control row per overlay. Re-callable: clears + rebuilds on each engine rebuild. */
export function buildOverlayRows({ engine, config, colormaps, onRemove }) {
    const host = $('overlay-rows'); if (!host) return;
    host.innerHTML = '';
    const overlays = engine.overlays || [];
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
        const rm = document.createElement('button'); rm.className = 'btn rm'; rm.textContent = '✕';
        rm.title = 'Remove this overlay';
        rm.addEventListener('click', () => onRemove(i));
        gName.append(nm, rm); row.append(gName);

        const g = document.createElement('div'); g.className = 'grp';

        const cmap = document.createElement('select');
        populateCmap(cmap, colormaps);
        cmap.value = resolveColormap(os, !!ov.diverging, colormaps).name;
        cmap.title = 'Colormap for this overlay.';
        cmap.addEventListener('change', () => { set({ colormap: cmap.value }); engine.recolor(); });
        g.append(cmap);

        const smooth = btn('Smooth');
        bindToggle(smooth, os.representation === 'smooth', (on) => set({ voxel: { representation: on ? 'smooth' : 'blocky' } }), 'Smooth (marching-cubes) vs blocky voxels.');
        g.append(smooth);

        const thr = sw('thr');
        bindRange(thr.range, os.threshold ?? ov.threshold ?? 0, (v) => { set({ threshold: v }); engine.applyStyle(); }, { min: 0, max: maxAbs, step: maxAbs / 200 }, 'Statistical threshold — hide |value| below this.');
        g.append(thr.wrap);

        const clu = sw('cluster k');
        bindRange(clu.range, os.clusterMin ?? 0, (v) => { set({ voxel: { clusterMin: v } }); engine.applyStyle(); }, { min: 0, max: maxClu, step: 1 }, 'Cluster-extent threshold — hide clusters < N voxels.');
        g.append(clu.wrap);

        const sm = sw('smooth+');
        bindRange(sm.range, os.smoothing ?? 0, (v) => { set({ voxel: { smoothing: v } }); engine.applySmoothing(i); }, { min: 0, max: 12, step: 1 }, 'Extra surface smoothing of the smooth (0.5mm-grid) mesh — Taubin iterations. 0 = off.');
        g.append(sm.wrap);

        const pos = btn('+only');
        bindToggle(pos, !!os.positiveOnly, (on) => { set({ positiveOnly: on }); engine.applyStyle(); }, 'Show only positive values.');
        g.append(pos);

        const edges = btn('Edges');
        bindToggle(edges, os.edges.enabled !== false, (on) => set({ voxel: { edges: { enabled: on } } }), 'Per-voxel edge outlines.');
        g.append(edges);

        const ew = sw('edge w');
        bindRange(ew.range, os.edges.width, (v) => { set({ voxel: { edges: { width: v } } }); engine.applyStyle(); }, { min: 0.3, max: 3, step: 0.1 }, 'Voxel edge thickness.');
        g.append(ew.wrap);

        const veil = sw('veil');
        bindRange(veil.range, os.veil.strength, (v) => { set({ voxel: { veil: { strength: v } } }); engine.applyStyle(); }, { min: 0, max: 1, step: 0.02 }, 'Depth veil strength — fades deeper voxels toward white.');
        g.append(veil.wrap);

        const veilk = sw('veil log');
        bindRange(veilk.range, os.veil.k, (v) => { set({ voxel: { veil: { k: v } } }); engine.applyStyle(); }, { min: 0.1, max: 20, step: 0.1 }, 'Veil steepness.');
        g.append(veilk.wrap);

        const em = sw('emissive');
        bindRange(em.range, os.emissive, (v) => { set({ voxel: { emissive: v } }); engine.applyStyle(); }, { min: 0, max: 1, step: 0.02 }, 'Flat colormap-colour brightness.');
        g.append(em.wrap);

        const sp = sw('specular');
        bindRange(sp.range, os.specular, (v) => { set({ voxel: { specular: v } }); engine.applyStyle(); }, { min: 0, max: 0.6, step: 0.01 }, 'Glossiness — specular glint amount.');
        g.append(sp.wrap);

        const sh = sw('shine');
        bindRange(sh.range, os.shininess, (v) => { set({ voxel: { shininess: v } }); engine.applyStyle(); }, { min: 1, max: 200, step: 1 }, 'Highlight tightness.');
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
        lay.value = preset || 'ninePanel';
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
