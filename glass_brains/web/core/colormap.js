/**
 * colormap.js — pure colormap math, identical in browser and headless.
 *
 * LUTs come from a Python-generated colormaps.json (sampled from the `cmap`
 * package), so JS hardcodes no colormaps. Values are mapped to a colormap
 * position t∈[0,1] using the same normalization as overlays._normalize_for_cmap,
 * then looked up in the LUT and converted sRGB→linear (three.js treats vertex
 * colours as linear-light).
 */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Parse colormaps.json → Map<name, { lut:Float32Array(n*3 sRGB 0..1), n, category }>.
 * @param {{n:number, maps:Object}} json
 */
export function loadColormaps(json) {
    const out = new Map();
    const n = json.n;
    for (const [name, m] of Object.entries(json.maps)) {
        const flat = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            flat[i * 3] = m.lut[i][0];
            flat[i * 3 + 1] = m.lut[i][1];
            flat[i * 3 + 2] = m.lut[i][2];
        }
        out.set(name, { lut: flat, n, category: m.category });
    }
    return out;
}

/** Linear interpolate the LUT (sRGB) at t∈[0,1] → [r,g,b] sRGB. */
export function sampleLUT(cmap, t) {
    const { lut, n } = cmap;
    t = clamp01(t);
    const x = t * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    const a = i * 3, b = (i + 1) * 3;
    return [
        lut[a] + (lut[b] - lut[a]) * f,
        lut[a + 1] + (lut[b + 1] - lut[a + 1]) * f,
        lut[a + 2] + (lut[b + 2] - lut[a + 2]) * f,
    ];
}

/**
 * Map a signed value to colormap position t∈[0,1].
 * @param {number} mode - 'diverging' (symmetric about 0) or 'sequential'
 * @param {boolean} divergingMapOnPositive - if a *diverging* LUT is used on
 *   positive-only data, confine t to the upper half [0.5,1] so values never
 *   collapse onto the white centre (the coolwarm-on-positive washout fix).
 * @param {boolean} divergingMapOnNegative - the mirror case: a *diverging* LUT on
 *   negative-only data, confine t to the lower half [0,0.5] (without this, the
 *   sequential branch clamps negatives to 0 → t collapses onto the white centre).
 */
export function valueToT(value, maxAbs, mode, gamma = 0.5, divergingMapOnPositive = false, divergingMapOnNegative = false) {
    if (mode === 'diverging') {
        const sn = clamp01(Math.abs(value) / maxAbs) * Math.sign(value);
        const amp = Math.sign(sn) * Math.pow(Math.abs(sn), gamma);
        return (amp + 1) / 2;
    }
    // sequential
    if (divergingMapOnNegative) {
        const m = clamp01(Math.pow(clamp01(-value / maxAbs), gamma));
        return 0.5 - 0.5 * m;   // 0.5 (near zero) → 0 (most negative): the LUT's cool half
    }
    const t = clamp01(Math.pow(clamp01(value / maxAbs), gamma));
    return divergingMapOnPositive ? 0.5 + 0.5 * t : t;
}

/** Pick a sensible default colormap name for the data. */
export function defaultColormap(diverging) {
    return diverging ? 'coolwarm' : 'viridis';
}

/**
 * The colour-scale magnitude. An explicit clim overrides the data-derived 99th-pct fallback:
 *   null      -> fallback (the per-overlay maxAbsValue from the pipeline)
 *   number v  -> |v|   (diverging: symmetric [-v,v]; sequential: [0,v], per valueToT)
 *   [lo, hi]  -> the larger-magnitude bound, which drives the single-scale shader/colorbar.
 */
export function deriveMaxAbs(clim, fallback) {
    if (clim == null) return fallback;
    if (typeof clim === 'number') return Math.abs(clim) || fallback;
    return Math.max(Math.abs(clim[0]), Math.abs(clim[1])) || fallback;
}

/**
 * Decide the effective colormap name + mode from style + data.
 * @returns {{ name, mode, divergingMapOnPositive }}
 */
export function resolveColormap(style, dataDiverging, colormapsMap, dataNegativeOnly = false) {
    const mode = (style.colormapMode && style.colormapMode !== 'auto')
        ? style.colormapMode
        : (dataDiverging ? 'diverging' : 'sequential');
    const name = (!style.colormap || style.colormap === 'auto')
        ? defaultColormap(dataDiverging)
        : style.colormap;
    // If the chosen LUT is a diverging map but the data is single-signed, remap onto the
    // matching half (hot for positive, cool for negative) so the white centre is never used.
    const cat = colormapsMap && colormapsMap.get(name)?.category;
    const singleSignedDiverging = mode === 'sequential' && cat === 'diverging';
    const divergingMapOnPositive = singleSignedDiverging && !dataNegativeOnly;
    const divergingMapOnNegative = singleSignedDiverging && dataNegativeOnly;
    return { name, mode, divergingMapOnPositive, divergingMapOnNegative };
}

/**
 * Colorize per-vertex values → linear-RGB Float32Array (n*3), the single source
 * of truth for displayed colour (browser and headless identical).
 */
export function colorizeValues(values, cmap, maxAbs, mode, gamma = 0.5, divergingMapOnPositive = false, divergingMapOnNegative = false) {
    const n = values.length;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const t = valueToT(values[i], maxAbs, mode, gamma, divergingMapOnPositive, divergingMapOnNegative);
        const [r, g, b] = sampleLUT(cmap, t);
        out[i * 3] = srgbToLinear(r);
        out[i * 3 + 1] = srgbToLinear(g);
        out[i * 3 + 2] = srgbToLinear(b);
    }
    return out;
}
