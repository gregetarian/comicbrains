/**
 * config-schema.js — the single source of truth for a viewer config. Pure.
 *
 * normalizeConfig(raw) deep-merges `raw` over DEFAULTS and validates a few
 * load-bearing invariants. The result is a plain JSON-serializable object that
 * drives BOTH the browser and the headless renderer.
 */

export const DEFAULTS = {
    version: '2.0',
    data: { manifest: 'scene.json', colormaps: 'colormaps.json' },
    render: {
        width: 1600, height: 1200, pixelRatio: 2, background: '#ffffff',
        colorbar: true,
        // Colorbar tick font — Computer Modern (LaTeX roman) by default, serif fallback.
        colorbarFont: 'Computer Modern Serif, CMU Serif, Latin Modern Roman, serif',
        colorbarFontSize: 11,
    },
    style: {
        colormap: 'YlGnBu',
        colormapMode: 'auto',     // 'auto' | 'diverging' | 'sequential'
        threshold: null,          // null = use manifest threshold
        positiveOnly: false,
        gamma: 0.5,
        // Global framing tightness: <1 packs brains closer (driver view fills its
        // cell at this fraction). 0.95 = snug; 1.0 = no padding; 1.06 = old roomy.
        margin: 0.95,
        cortexSurface: 'inflated', // 'pial' | 'inflated'
        voxel: {
            representation: 'smooth', // 'blocky' (voxelwise) | 'smooth'
            clusterMin: 105,          // cluster-extent threshold: hide clusters < N voxels
            shininess: 200,
            specular: 0.0,   // light-independent glint amount (slider 0..0.6); off = flat matte
            emissive: 1.0,   // full flat colormap colour (scene lights are 0 by default)
            veil: { strength: 0.66, k: 7.4, color: '#ffffff' },
            edges: { enabled: true, color: '#808080', opacity: 1.0, width: 1.9, threshold: 0.003 },
        },
        glass: { color: '#ffffff', maxOpacity: 0.0, minOpacity: 0.0, fresnelPower: 2.5, celBands: 3 },
        anatomy: { color: '#ffffff', maxOpacity: 0.14, opacity: 1.0 },
        // Higher threshold = fewer/weaker cortex lines (less sulcal density).
        outline: { enabled: true, color: '#000000', width: 4.0, threshold: 0.02 },
        // Scene lights off by default — voxel colour comes from emissive (full flat
        // colormap) + the light-independent glint, so the colours stay saturated.
        lighting: { directional: 0, ambient: 0, headlight: true },
        // Slight oblique tilt of every view (degrees) — a depth cue without full
        // perspective; keeps a right-handed basis so lighting stays correct.
        tilt: { azimuth: 8, elevation: 6 },
        // Inter-voxel shadows (clusters casting onto each other). Off by default —
        // the depth veil + voxel edges carry the depth cue without darkening
        // clusters where they overlap. Re-enable with --shadows.
        shadows: { enabled: false, offset: 0.30, mapSize: 1024 },
    },
    layout: {
        grid: { rows: 2, cols: 2, rowWeights: [1, 1], colWeights: [1, 1] },
        panels: [],
    },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Deep-merge `src` onto a clone of `base` (arrays replace, objects merge). */
export function deepMerge(base, src) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isObj(src)) return src === undefined ? out : src;
    for (const [k, v] of Object.entries(src)) {
        out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : (Array.isArray(v) ? v.slice() : v);
    }
    return out;
}

const ROLES = new Set(['cortex', 'anatomy', 'voxel']);
const HEMI = new Set(['lh', 'rh', 'both']);

export function validateConfig(cfg) {
    const errors = [];
    const panels = cfg.layout?.panels || [];
    if (!Array.isArray(panels) || panels.length === 0) errors.push('layout.panels must be a non-empty array');
    panels.forEach((p, i) => {
        if (!p.id) errors.push(`panel[${i}] missing id`);
        if (!p.camera) errors.push(`panel[${i}] (${p.id}) missing camera`);
        if (!p.cell || p.cell.row == null || p.cell.col == null) errors.push(`panel[${i}] (${p.id}) missing cell {row,col}`);
        const content = p.content || {};
        (content.roles || []).forEach((r) => { if (!ROLES.has(r)) errors.push(`panel ${p.id}: bad role '${r}'`); });
        if (content.hemisphere && !HEMI.has(content.hemisphere)) errors.push(`panel ${p.id}: bad hemisphere '${content.hemisphere}'`);
    });
    return { ok: errors.length === 0, errors };
}

/** Merge over defaults, fill panel defaults, validate. Throws on invalid. */
export function normalizeConfig(raw = {}) {
    const cfg = deepMerge(DEFAULTS, raw);
    cfg.layout.panels = (cfg.layout.panels || []).map((p) => ({
        rowSpan: 1, colSpan: 1,
        anatomyOpacity: null,
        framing: { margin: 1.06, fit: 'auto' },
        ...p,
        content: { roles: ['cortex', 'voxel'], hemisphere: 'both', categories: null, representation: null, ...(p.content || {}) },
        framing: { margin: 1.06, fit: 'auto', ...(p.framing || {}) },
    }));
    const { ok, errors } = validateConfig(cfg);
    if (!ok) throw new Error('Invalid config:\n  ' + errors.join('\n  '));
    return cfg;
}
