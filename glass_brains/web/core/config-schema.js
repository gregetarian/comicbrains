/**
 * config-schema.js — the single source of truth for a viewer config. Pure.
 *
 * normalizeConfig(raw) deep-merges `raw` over DEFAULTS and validates a few
 * load-bearing invariants. The result is a plain JSON-serializable object that
 * drives BOTH the browser and the headless renderer.
 */

export const DEFAULTS = {
    version: '2.0',
    // Template / space (M2). 'mni' = the bundled fsaverage; 'custom' = a user template dir
    // (M9); 'none' = render the volume in its own space with no anatomical shell (M7). The
    // baked scene.json.templateMode mirrors this and gates the view vocabulary.
    template: { kind: 'mni', dir: null, space: 'MNI152' },   // kind: 'mni' | 'custom' | 'none'
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
        // Colour limit (M2): null = derive from data (meta.maxAbsValue, the 99th pct). A
        // [vmin,vmax] pair sets it explicitly; a bare scalar v means symmetric [-v,v] when the
        // resolved mode is diverging, else [0,v]. Per-overlay override via overlays[i].clim.
        clim: null,
        // Units (M2): how thresholds / clim / cluster sizes read. value = the stat shown on the
        // colorbar ('stat' | 'z' | 't' | ...); cluster = 'voxels' (default) or 'mm3'.
        units: { value: 'stat', cluster: 'voxels' },
        // Global framing tightness: <1 packs brains closer (driver view fills its
        // cell at this fraction). 0.95 = snug; 1.0 = no padding; 1.06 = old roomy.
        margin: 0.95,
        cortexSurface: 'inflated', // 'pial' | 'inflated'
        voxel: {
            representation: 'smooth', // 'blocky' (voxelwise) | 'smooth' | 'surface' (project onto the cortex, M8)
            clusterMin: 105,          // cluster-extent threshold: hide clusters < N voxels
            smoothing: 0,             // extra Taubin smoothing iterations on the 'smooth' (0.5mm-grid) mesh; 0 = off
            shininess: 200,
            specular: 0.0,   // light-independent glint amount (slider 0..0.6); off = flat matte
            emissive: 1.0,   // full flat colormap colour (scene lights are 0 by default)
            surfaceDepth: 6, // M2: K depth samples pial->white when representation === 'surface' (M8)
            veil: { strength: 0.66, k: 7.4, color: '#ffffff' },
            edges: { enabled: true, color: '#808080', opacity: 1.0, width: 1.9, threshold: 0.003 },
        },
        // Per-NIfTI overrides. Each entry overrides the voxel/colour fields above
        // for one overlay (by index); empty/absent → inherit the globals. The GUI
        // renders one control row per entry; the CLI usually has a single overlay.
        overlays: [],
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
        // 'grid' (default) = panels positioned by grid cells; 'free' = Free Canvas,
        // panels positioned by per-panel `place` fractions (see normalizeConfig).
        mode: 'grid',
        grid: { rows: 2, cols: 2, rowWeights: [1, 1], colWeights: [1, 1] },
        // Free-canvas reference design space. w/h pin the aspect the `place` fractions
        // were authored against (so the CLI reproduces identical RELATIVE geometry at
        // any --width/--height); bgAlpha 0..1 is the canvas background opacity (1 = opaque).
        canvas: { w: 1600, h: 1000, bgAlpha: 1 },
        // Whole-canvas pan/zoom (M2). Identity by default so every existing grid render is
        // byte-identical (headless pins s=1); round-trips through buildSpec for Copy-CLI/--spec.
        view: { s: 1, cx: null, cy: null },
        panels: [],
    },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/**
 * Resolve the effective voxel/colour style for overlay `i`: the per-overlay
 * overrides in `style.overlays[i]` merged over the global `style` template.
 * Single source of truth so the renderer, colorbar, and controls agree.
 */
export function overlayStyle(config, i = 0) {
    const s = config.style || {};
    const v = s.voxel || {};
    const o = (s.overlays && s.overlays[i]) || {};
    const ov = o.voxel || {};
    return {
        colormap: o.colormap ?? s.colormap,
        colormapMode: o.colormapMode ?? s.colormapMode,
        threshold: o.threshold ?? s.threshold,
        positiveOnly: o.positiveOnly ?? s.positiveOnly,
        gamma: o.gamma ?? s.gamma,
        clim: o.clim ?? s.clim,
        units: { ...(s.units || {}), ...(o.units || {}) },
        representation: ov.representation ?? v.representation,
        clusterMin: ov.clusterMin ?? v.clusterMin,
        smoothing: ov.smoothing ?? v.smoothing,
        shininess: ov.shininess ?? v.shininess,
        specular: ov.specular ?? v.specular,
        emissive: ov.emissive ?? v.emissive,
        surfaceDepth: ov.surfaceDepth ?? v.surfaceDepth,
        veil: { ...(v.veil || {}), ...(ov.veil || {}) },
        edges: { ...(v.edges || {}), ...(ov.edges || {}) },
    };
}

/** Mutate config.style.overlays[i] with a (possibly nested) override patch. */
export function setOverlayStyle(config, i, patch) {
    const arr = (config.style.overlays ||= []);
    while (arr.length <= i) arr.push({});
    arr[i] = deepMerge(arr[i] || {}, patch);
    return arr[i];
}

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
const REPRESENTATIONS = new Set(['blocky', 'smooth', 'surface']);   // M2 (+ 'surface' for M8)
const TEMPLATE_KINDS = new Set(['mni', 'custom', 'none']);          // M2

// clim: null | a single number | a [vmin, vmax] pair with vmin < vmax.
const climOk = (c) => c == null || typeof c === 'number'
    || (Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number' && c[0] < c[1]);
const repOk = (r) => r == null || REPRESENTATIONS.has(r);

export function validateConfig(cfg) {
    const errors = [];
    const kind = cfg.template?.kind ?? 'mni';
    if (!TEMPLATE_KINDS.has(kind)) errors.push(`template.kind must be one of ${[...TEMPLATE_KINDS].join('/')}, got '${kind}'`);
    const noTemplate = kind === 'none';
    if (!climOk(cfg.style?.clim)) errors.push('style.clim must be null, a number, or [vmin, vmax] with vmin < vmax');
    if (!repOk(cfg.style?.voxel?.representation)) errors.push(`style.voxel.representation must be one of ${[...REPRESENTATIONS].join('/')}`);
    (cfg.style?.overlays || []).forEach((o, i) => {
        if (!o) return;
        if (!climOk(o.clim)) errors.push(`style.overlays[${i}].clim invalid (null | number | [vmin<vmax])`);
        if (!repOk(o.voxel?.representation)) errors.push(`style.overlays[${i}].voxel.representation invalid`);
    });
    const panels = cfg.layout?.panels || [];
    if (!Array.isArray(panels) || panels.length === 0) errors.push('layout.panels must be a non-empty array');
    panels.forEach((p, i) => {
        if (!p.id) errors.push(`panel[${i}] missing id`);
        if (!p.camera) errors.push(`panel[${i}] (${p.id}) missing camera`);
        // A panel is positioned EITHER by a grid cell (grid mode) OR by a free-canvas
        // `place` rectangle (free mode) — exactly one, never both, never neither.
        const hasCell = p.cell && p.cell.row != null && p.cell.col != null;
        const hasPlace = p.place && p.place.w != null && p.place.h != null;
        if (hasCell === hasPlace) errors.push(`panel[${i}] (${p.id}) needs exactly one of cell {row,col} or place {x,y,w,h}`);
        const content = p.content || {};
        (content.roles || []).forEach((r) => { if (!ROLES.has(r)) errors.push(`panel ${p.id}: bad role '${r}'`); });
        if (content.hemisphere && !HEMI.has(content.hemisphere)) errors.push(`panel ${p.id}: bad hemisphere '${content.hemisphere}'`);
        if (!repOk(content.representation)) errors.push(`panel ${p.id}: bad representation '${content.representation}'`);
        // 'none' mode has no shell and no hemisphere split: reject cortex/anatomy roles and L/R-only views.
        if (noTemplate) {
            if ((content.roles || []).some((r) => r === 'cortex' || r === 'anatomy'))
                errors.push(`panel ${p.id}: template.kind 'none' has no cortex/anatomy shell — use roles ['voxel']`);
            if (content.hemisphere === 'lh' || content.hemisphere === 'rh')
                errors.push(`panel ${p.id}: template.kind 'none' has no hemisphere split — use hemisphere 'both'`);
        }
    });
    return { ok: errors.length === 0, errors };
}

/** Merge over defaults, fill panel defaults, validate. Throws on invalid. */
export function normalizeConfig(raw = {}) {
    const cfg = deepMerge(DEFAULTS, raw);
    cfg.layout.panels = (cfg.layout.panels || []).map((p) => ({
        rowSpan: 1, colSpan: 1,
        anatomyOpacity: null,
        // M2: declared per-panel fields the engine already reads — now defaulted so they
        // round-trip losslessly through buildSpec (identity values change no render).
        zoom: 1, rotate: null, slice: null,
        framing: { margin: 1.06, fit: 'auto' },
        ...p,
        content: { roles: ['cortex', 'voxel'], hemisphere: 'both', categories: null, representation: null, anatomyStyle: 'glass', anatomyHemisphere: null, ...(p.content || {}) },
        framing: { margin: 1.06, fit: 'auto', ...(p.framing || {}) },
    }));
    const { ok, errors } = validateConfig(cfg);
    if (!ok) throw new Error('Invalid config:\n  ' + errors.join('\n  '));
    return cfg;
}
