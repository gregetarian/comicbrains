/**
 * bind.js — UI controls bound to the engine config (single source of truth).
 * Each widget mutates config + calls an engine method; the RAF loop reflects it.
 */
import { resolveColormap } from '../core/colormap.js';

const $ = (id) => document.getElementById(id);

// Hover tooltips (what each control does). Keyed by element id.
const TIPS = {
    'c-colormap': 'Colormap applied to the voxel values.',
    'c-smooth': 'Smooth (marching-cubes) voxels vs blocky voxelwise cubes.',
    'c-inflate': 'Inflated cortical surface vs the folded pial surface.',
    'c-threshold': 'Statistical threshold — hide voxels with |value| below this.',
    'c-cluster': 'Cluster-extent threshold — hide clusters smaller than this many voxels.',
    'c-posonly': 'Show only positive values (hide negatives).',
    'c-outline': 'Toggle the black cortical-surface outline.',
    'c-edges': 'Toggle the per-voxel edge outlines.',
    'c-cortex': 'Cortex glass opacity. 0 = invisible (only the outline shows).',
    'c-outline-thresh': 'Surface-line density — higher hides shallower folds (fewer lines).',
    'c-outline-width': 'Surface (cortex outline) line thickness.',
    'c-edge-width': 'Voxel edge line thickness.',
    'c-veil': 'Depth veil strength — fades deeper voxels toward white.',
    'c-veilk': 'Veil steepness — curvature of the depth fade (higher = sharper near the front).',
    'c-emissive': 'Flat colormap-colour brightness (light-independent).',
    'c-specular': 'Glossiness — light-independent specular glint amount.',
    'c-shininess': 'Highlight tightness — higher = smaller, sharper glint.',
    'c-directional': 'Directional (headlight) intensity.',
    'c-ambient': 'Ambient light intensity.',
};

const trimNum = (v) => { const n = parseFloat(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4); };

function slider(id, value, oninput, { min, max, step } = {}) {
    const el = $(id); if (!el) return;
    if (min != null) el.min = min;
    if (max != null) el.max = max;
    if (step != null) el.step = step;
    el.value = value;
    if (TIPS[id]) el.title = TIPS[id];

    // A small numeric box mirroring the slider, so values can be typed exactly.
    const box = document.createElement('input');
    box.type = 'number'; box.className = 'numbox';
    if (min != null) box.min = min;
    if (max != null) box.max = max;
    if (step != null) box.step = step;
    if (TIPS[id]) box.title = TIPS[id];
    box.value = trimNum(value);
    el.insertAdjacentElement('afterend', box);

    el.addEventListener('input', () => { box.value = trimNum(el.value); oninput(parseFloat(el.value)); });
    box.addEventListener('input', () => {
        const v = parseFloat(box.value); if (!isFinite(v)) return;
        el.value = v;                       // the range clamps to [min,max]
        oninput(parseFloat(el.value));
    });
}
function toggle(id, active, onchange) {
    const el = $(id); if (!el) return;
    if (TIPS[id]) el.title = TIPS[id];
    el.classList.toggle('active', !!active);
    el.addEventListener('click', () => { el.classList.toggle('active'); onchange(el.classList.contains('active')); });
}

export function bindControls({ engine, config, colormaps }) {
    const s = config.style;
    const manifest = engine.sceneModel.manifest;
    const ov = manifest.overlays?.[0];
    const maxAbs = ov?.maxAbsValue ?? 1.0;

    // --- Colormap dropdown (full cmap set, grouped by category) ---
    const cm = $('c-colormap');
    if (cm) cm.title = TIPS['c-colormap'];
    if (cm && colormaps.size) {
        const byCat = {};
        for (const [name, m] of colormaps) (byCat[m.category] ||= []).push(name);
        for (const cat of Object.keys(byCat).sort()) {
            const og = document.createElement('optgroup'); og.label = cat;
            for (const name of byCat[cat].sort()) {
                const o = document.createElement('option'); o.value = name; o.textContent = name; og.appendChild(o);
            }
            cm.appendChild(og);
        }
        const resolved = resolveColormap(s, !!ov?.diverging, colormaps).name;
        cm.value = resolved;
        cm.addEventListener('change', () => engine.setColormap(cm.value));
    }

    // --- Layout (reload with a preset query) ---
    const lay = $('c-layout');
    if (lay) {
        const cur = new URLSearchParams(location.search).get('preset') || 'fourPanel';
        lay.value = cur;
        lay.addEventListener('change', () => { location.search = '?preset=' + lay.value; });
    }

    // --- Representation (blocky/smooth) + cortex surface (pial/inflated) ---
    toggle('c-smooth', s.voxel.representation === 'smooth', (on) => { s.voxel.representation = on ? 'smooth' : 'blocky'; });
    toggle('c-inflate', s.cortexSurface === 'inflated', (on) => { s.cortexSurface = on ? 'inflated' : 'pial'; });

    // --- Threshold ---
    slider('c-threshold', s.threshold ?? ov?.threshold ?? 0,
        (v) => { s.threshold = v; engine.applyStyle(); const o = $('c-threshold-v'); if (o) o.textContent = v.toFixed(1); },
        { min: 0, max: maxAbs, step: maxAbs / 200 });
    { const o = $('c-threshold-v'); if (o) o.textContent = (s.threshold ?? ov?.threshold ?? 0).toFixed(1); }

    // --- Cluster-extent threshold (min voxels per cluster; live shader filter) ---
    const maxCluster = Math.max(ov?.maxClusterSize ?? 0, 1);
    slider('c-cluster', s.voxel.clusterMin ?? 0,
        (v) => { s.voxel.clusterMin = v; engine.applyStyle(); const o = $('c-cluster-v'); if (o) o.textContent = String(Math.round(v)); },
        { min: 0, max: maxCluster, step: 1 });
    { const o = $('c-cluster-v'); if (o) o.textContent = String(Math.round(s.voxel.clusterMin ?? 0)); }

    toggle('c-posonly', s.positiveOnly, (on) => { s.positiveOnly = on; engine.applyStyle(); });

    // --- Outline / edges / cortex opacity ---
    toggle('c-outline', s.outline.enabled, (on) => { s.outline.enabled = on; });
    toggle('c-edges', s.voxel.edges.enabled, (on) => { s.voxel.edges.enabled = on; });
    slider('c-cortex', s.glass.maxOpacity, (v) => { s.glass.maxOpacity = v; engine.applyStyle(); });
    // cortex edge density (threshold; higher = fewer lines) + line width, voxel edge thickness
    slider('c-outline-thresh', s.outline.threshold, (v) => { s.outline.threshold = v; engine.applyStyle(); });
    slider('c-outline-width', s.outline.width, (v) => { s.outline.width = v; engine.applyStyle(); });
    slider('c-edge-width', s.voxel.edges.width, (v) => { s.voxel.edges.width = v; engine.applyStyle(); });

    // --- Voxel material ---
    slider('c-veil', s.voxel.veil.strength, (v) => { s.voxel.veil.strength = v; engine.applyStyle(); });
    slider('c-veilk', s.voxel.veil.k, (v) => { s.voxel.veil.k = v; engine.applyStyle(); });
    slider('c-emissive', s.voxel.emissive, (v) => { s.voxel.emissive = v; engine.applyStyle(); });
    slider('c-specular', s.voxel.specular, (v) => { s.voxel.specular = v; engine.applyStyle(); });
    slider('c-shininess', s.voxel.shininess, (v) => { s.voxel.shininess = v; engine.applyStyle(); });

    // --- Lighting ---
    slider('c-directional', s.lighting.directional, (v) => { s.lighting.directional = v; engine.applyStyle(); });
    slider('c-ambient', s.lighting.ambient, (v) => { s.lighting.ambient = v; engine.applyStyle(); });

    // --- NIfTI upload (POST to the server, then reload to pick up new scene.json) ---
    const up = $('c-upload');
    if (up) up.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const loading = $('loading'); loading.style.display = ''; loading.textContent = 'Processing overlay…';
        const fd = new FormData();
        fd.append('file', file);
        fd.append('threshold', String(s.threshold ?? ov?.threshold ?? 2.3));
        fd.append('cmap', cm?.value || 'auto');
        fd.append('name', file.name.replace(/\.nii(\.gz)?$/, ''));
        try {
            const r = await fetch('/api/load-overlay', { method: 'POST', body: fd });
            const res = await r.json();
            if (!res.ok) throw new Error(res.error || 'upload failed');
            location.reload();
        } catch (err) {
            loading.textContent = 'Error: ' + err.message;
            setTimeout(() => { loading.style.display = 'none'; }, 3000);
            e.target.value = '';
        }
    });
}
