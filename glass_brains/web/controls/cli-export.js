/**
 * cli-export.js — generate the `glass-brains render` CLI command that reproduces
 * the current on-screen view.
 *
 * This works because the browser viewer and the CLI `render` command consume the
 * SAME config schema (core/config-schema.js): render.py just turns flags into that
 * config and runs the identical headless viewer. So every browser style control maps
 * to a flag. The places they can't match are stated as `# note:` comments:
 *   - the CLI composites multiple overlays (pass several NIfTIs, or a --spec figure.json);
 *     a single Copy-CLI command for multi-overlay GRID figures is still pending (roadmap M5),
 *   - per-panel zoom has no CLI flag yet,
 *   - the browser never knows the upload's disk path (you supply it).
 */
import { overlayStyle } from '../core/config-schema.js';
import { resolveColormap } from '../core/colormap.js';

// Browser layout preset -> CLI --grid / --views (view names match render.py VIEWS).
const PRESET_VIEWS = {
    fourPanel: { grid: '2x2', views: 'left_lateral,right_lateral,left_medial,right_medial' },
    ninePanel: { grid: '2x4', views: 'left_lateral,right_lateral,left_medial,right_medial,anterior,dorsal,subcortical_l,subcortical_r' },
    overview:  { grid: '2x2', views: 'left_lateral,anterior,dorsal,right_medial' },
};

// Viewer defaults (core/config-schema.js DEFAULTS.style) — emit a flag only when the
// current value differs, so the command stays readable.
const D = {
    cortexSurface: 'inflated', representation: 'smooth', gamma: 0.5,
    veilStrength: 0.66, veilK: 7.4, emissive: 1.0, specular: 0.0, shininess: 200,
    directional: 0, ambient: 0, glassMaxOpacity: 0.0, outlineThreshold: 0.02,
    edgeWidth: 1.9, colormapMode: 'auto',
};

const fmt = (n) => { const v = +n; return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4); };
const q = (s) => (/[^\w.\-/]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : String(s));

/** A figure is "free" (needs --spec, not --grid/--views) if it's in Free Canvas mode or
 *  any panel carries free placement / per-panel rotation / a slice. */
export function isFreeFigure(config) {
    const L = config.layout || {};
    return L.mode === 'free' || (L.panels || []).some((p) => p.place || p.rotate || p.slice);
}

/** The self-contained canvas document the CLI reproduces with `--spec figure.json`.
 *  It bundles the layout (place/rotate/slice/canvas), the full style, and the render
 *  size/aspect — so `glass-brains render <nifti> --spec figure.json` round-trips exactly. */
export function buildSpec(config) {
    const cv = config.layout && config.layout.canvas;
    return {
        // M3: the ONE figure document. layout carries view{s,cx,cy} + per-panel zoom/rotate/slice
        // (declared in config-schema DEFAULTS), template records the space, style the full per-overlay
        // style — so Copy-CLI, --spec, the notebook render_spec, presets, and URL-state never drift.
        template: config.template,
        layout: config.layout,
        style: config.style,
        render: {
            width: Math.round((cv && cv.w) || (config.render && config.render.width) || 1600),
            height: Math.round((cv && cv.h) || (config.render && config.render.height) || 1000),
            background: (config.render && config.render.background) || '#ffffff',
        },
    };
}

/** Build the CLI command for a single overlay's resolved style. */
function commandFor(config, i, meta, colormaps, preset) {
    const s = config.style;
    const os = overlayStyle(config, i);
    const cmap = resolveColormap(os, !!meta.diverging, colormaps).name;
    const pv = PRESET_VIEWS[preset] || PRESET_VIEWS.ninePanel;

    const parts = [`glass-brains render ${q(meta.name)} -o glassbrain.png`];
    parts.push(`--grid ${pv.grid} --views ${pv.views}`);
    // data params — always explicit (the CLI's own defaults differ, e.g. -k 105)
    parts.push(`--threshold ${fmt(os.threshold ?? meta.threshold ?? 2.3)} -k ${fmt(os.clusterMin ?? 0)} --cmap ${cmap}`);
    if (os.colormapMode && os.colormapMode !== D.colormapMode) parts.push(`--colormap-mode ${os.colormapMode}`);
    // always override the CLI's print-look defaults so output matches the screen
    parts.push(`--margin ${fmt(s.margin ?? 0.95)} --line-w ${fmt(s.outline.width)}`);
    // crop the PNG to the tight bounding box of the visible brains (matches Save PNG)
    parts.push('--crop content');

    const extra = [];
    if (s.cortexSurface !== D.cortexSurface) extra.push(`--surface ${s.cortexSurface}`);
    if (os.representation !== D.representation) extra.push('--voxels blocky');
    if (os.gamma !== D.gamma) extra.push(`--gamma ${fmt(os.gamma)}`);
    if (os.veil.strength !== D.veilStrength) extra.push(`--veil ${fmt(os.veil.strength)}`);
    if (os.veil.k !== D.veilK) extra.push(`--veil-k ${fmt(os.veil.k)}`);
    if (os.emissive !== D.emissive) extra.push(`--emissive ${fmt(os.emissive)}`);
    if (os.specular !== D.specular) extra.push(`--specular ${fmt(os.specular)}`);
    if (os.shininess !== D.shininess) extra.push(`--shininess ${fmt(os.shininess)}`);
    if (s.lighting.directional !== D.directional) extra.push(`--directional ${fmt(s.lighting.directional)}`);
    if (s.lighting.ambient !== D.ambient) extra.push(`--ambient ${fmt(s.lighting.ambient)}`);
    if (s.glass.maxOpacity !== D.glassMaxOpacity) extra.push(`--cortex-alpha ${fmt(s.glass.maxOpacity)}`);
    if (s.outline.threshold !== D.outlineThreshold) extra.push(`--edge-thr ${fmt(s.outline.threshold)}`);
    if (os.edges.width !== D.edgeWidth) extra.push(`--voxel-edge-w ${fmt(os.edges.width)}`);
    if (os.positiveOnly) extra.push('--positive-only');
    if (os.edges.enabled === false) extra.push('--no-edges');
    if (s.outline.enabled === false) extra.push('--no-outline');
    if (extra.length) parts.push(extra.join(' '));

    return parts.join(' \\\n  ');
}

/**
 * Build the full clipboard/file text: header notes + one command per overlay.
 * @returns {string}
 */
export function buildRenderText({ config, overlays, preset, colormaps, panelZoomUsed }) {
    if (!overlays.length) return '# Load a NIfTI first — there is no overlay to reproduce.';

    // Free Canvas / per-panel rotation / slices can't be expressed by --grid/--views — emit
    // a self-contained figure.json and a `--spec` command that reproduces it exactly.
    if (isFreeFigure(config)) {
        const spec = buildSpec(config);
        const name = overlays[0].meta.name || 'stat.nii.gz';
        const notes = [
            '# glass-brains render — Free Canvas figure (reproduces the exact on-screen layout).',
            '# 1) save the JSON below as figure.json   2) run the command (point it at your NIfTI on disk).',
        ];
        if (overlays.length > 1)
            notes.push('# note: figure.json carries the layout/style for ALL overlays; pass your maps in argument order (the i-th fills style.overlays[i]).');
        const cmd = `glass-brains render ${q(name)} -o glassbrain.png --spec figure.json --crop content`;
        return notes.join('\n') + '\n\n' + cmd + '\n\n# ---- figure.json ----\n' + JSON.stringify(spec, null, 2) + '\n';
    }

    const notes = [
        '# glass-brains render — reproduces the on-screen view from the CLI tool',
        '# (needs the `glass-brains` Python package + Playwright/Chromium installed).',
        '# Replace the filename with the path to your NIfTI on disk.',
    ];
    if (overlays.length > 1)
        notes.push(`# note: ${overlays.length} overlays are shown; render.py composites all maps passed in one call —`,
                   '#       the per-map commands below each set one colormap (a single composite command lands in roadmap M5).');
    if (panelZoomUsed)
        notes.push('# note: per-panel zoom (the +/- buttons) has no CLI equivalent and is not captured.');
    notes.push('# note: resolution/aspect via --width/--height (default 1600x1000); the browser');
    notes.push('#       "Save PNG" also adds a slight print look (thinner lines, more margin).');

    const cmds = overlays.map((o, i) => {
        const head = overlays.length > 1 ? `# overlay ${i + 1}: ${o.meta.name}\n` : '';
        return head + commandFor(config, i, o.meta, colormaps, preset);
    });
    return notes.join('\n') + '\n\n' + cmds.join('\n\n') + '\n';
}
