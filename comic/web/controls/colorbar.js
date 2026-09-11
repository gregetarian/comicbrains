/**
 * colorbar.js — one on-screen colorbar per overlay, each matching its voxels
 * exactly. Each bar runs its overlay's resolved style through the SAME pipeline
 * as the voxel shader:  value → t (gamma, seq/div, +guard) → LUT (sRGB)
 *   → sRGB→linear albedo → ×emissive + glint → linear→sRGB.
 */
import { resolveColormap, sampleLUT, srgbToLinear, linearToSrgb, valueToT, clamp01, deriveMaxAbs, colorbarScale } from '../core/colormap.js?v=depth-auto-v3';
import { overlayStyle } from '../core/config-schema.js?v=depth-auto-v3';

// View-space half-vector z for a front-facing swatch (matches the shader glint).
const GLINT_NDOTH = 2.0 / Math.hypot(-0.3, 0.4, 2.0);

function swatch(t, os, lighting, cmap) {
    const [r, g, b] = sampleLUT(cmap, t);
    const glint = Math.pow(Math.max(GLINT_NDOTH, 0.0), Math.max(os.shininess ?? 200, 1)) * (os.specular ?? 0);
    const k = (os.emissive ?? 1) + ((lighting.directional ?? 0) + (lighting.ambient ?? 0)) / Math.PI;
    return [r, g, b].map((c) => Math.round(clamp01(linearToSrgb(srgbToLinear(c) * k + glint)) * 255));
}

/** Pure legend model shared by the live canvas, raster sidecar and vector SVG export.
 * Axis positions are linear in data values; gamma affects the sampled colour only. */
export function colorbarModel(config, meta, colormaps, i = 0) {
    const os = overlayStyle(config, i);
    const diverging = !!meta.diverging, negativeOnly = !!meta.negativeOnly;
    const maxAbs = deriveMaxAbs(os.clim, meta.maxAbsValue ?? 1);
    const { name, mode, divergingMapOnPositive, divergingMapOnNegative } = resolveColormap(os, diverging, colormaps, negativeOnly);
    const cmap = colormaps.get(name);
    if (!cmap) return null;
    const climRange = Array.isArray(os.clim) ? os.clim : null;
    const threshold = os.threshold ?? meta.threshold ?? 0;
    const scale = colorbarScale({ clim: os.clim, maxAbs, diverging, negativeOnly,
        positiveOnly: !!os.positiveOnly, threshold });
    const { min, max } = scale;
    const lighting = config.style?.lighting || {};
    const colorAt = (value) => swatch(valueToT(value, maxAbs, mode, os.gamma,
        divergingMapOnPositive, divergingMapOnNegative, climRange), os, lighting, cmap);
    const rgbAt = (value) => scale.excluded(value) ? [128, 128, 128] : colorAt(value);
    const ticks = climRange ? [min, (min + max) / 2, max]
        : diverging ? [min, 0, max]
        : negativeOnly ? [min, min / 2, 0] : [0, max / 2, max];
    const cutoff = Math.max(0, Number(threshold) || 0);
    const boundaries = [min, max, ...(climRange || []), -cutoff, cutoff, 0]
        .filter((value) => value >= min && value <= max);
    const units = os.units?.value;
    return { min, max, ticks, name: meta.name || `overlay ${i + 1}`,
        units: units && units !== 'stat' ? units : '',
        colorAt, rgbAt, excluded: scale.excluded, boundaries,
        sampleColumns: (width) => Array.from({ length: width }, (_, x) =>
            rgbAt(min + (max - min) * x / Math.max(1, width - 1))),
    };
}

const xml = (value) => String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const rgbHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/** One standalone SVG per overlay, sampled from the same model as the live legend.
 * Duplicate stops at excluded-region boundaries keep grey threshold gaps sharp instead
 * of blending them into the colour ramp. No separate Python normalisation is involved. */
export function colorbarSVGs(config, metas = [], colormaps) {
    return metas.map((meta, i) => {
        const model = colorbarModel(config, meta, colormaps, i);
        if (!model) throw new Error(`No colour map is available for overlay ${i + 1}`);
        const width = Math.max(2, Math.round(config.render?.colorbarWidth ?? 240));
        const barH = Math.max(1, Math.round(config.render?.colorbarHeight ?? 14));
        const fontSize = config.render?.colorbarFontSize ?? 11;
        const font = xml(config.render?.colorbarFont || 'serif');
        const pad = 4, nameH = 15, tickH = fontSize + 5, unitsH = model.units ? fontSize + 5 : 0;
        const height = nameH + barH + tickH + unitsH + 4;
        const span = model.max - model.min || 1;
        const values = [...new Set([...model.boundaries, ...Array.from({ length: width }, (_, x) =>
            model.min + (model.max - model.min) * x / (width - 1))])].sort((a, b) => a - b);
        const stops = [];
        values.forEach((value, j) => {
            // At a discontinuity, draw the colour approached from EACH side at the same offset.
            // Midpoint probes identify the exclusion interval without numeric epsilon guesses.
            const left = j ? (values[j - 1] + value) / 2 : value;
            const right = j + 1 < values.length ? (value + values[j + 1]) / 2 : value;
            const leftColor = model.excluded(left) ? '#808080' : rgbHex(model.colorAt(value));
            const rightColor = model.excluded(right) ? '#808080' : rgbHex(model.colorAt(value));
            const offset = ((value - model.min) / span * 100).toFixed(8).replace(/\.?0+$/, '');
            stops.push(`<stop offset="${offset}%" stop-color="${leftColor}"/>`);
            if (rightColor !== leftColor) stops.push(`<stop offset="${offset}%" stop-color="${rightColor}"/>`);
        });
        const ticks = model.ticks.map((value, j) => {
            const x = pad + (value - model.min) / span * (width - 1);
            const anchor = ['start', 'middle', 'end'][j];
            return `<text x="${x.toFixed(2)}" y="${nameH + barH + fontSize + 2}" font-size="${fontSize}" font-family="${font}" text-anchor="${anchor}" fill="#555">${value.toFixed(1)}</text>`;
        }).join('');
        const units = model.units ? `<text x="${pad + width / 2}" y="${nameH + barH + tickH + fontSize}" font-size="${fontSize}" font-family="${font}" text-anchor="middle" fill="#555">${xml(model.units)}</text>` : '';
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + pad * 2}" height="${height}" viewBox="0 0 ${width + pad * 2} ${height}">`
            + `<defs><linearGradient id="cb${i}" color-interpolation="sRGB">${stops.join('')}</linearGradient></defs>`
            + `<text x="${pad}" y="11" font-size="10" font-family="sans-serif" fill="#555">${xml(model.name)}</text>`
            + `<rect x="${pad}" y="${nameH}" width="${width}" height="${barH}" fill="url(#cb${i})" stroke="#d0d0d0"/>${ticks}${units}</svg>`;
    });
}

export function createColorbar(container, { engine, config, colormaps, onHide }) {
    const overlays = engine.overlays || engine.sceneModel.manifest.overlays || [];
    const wrap = document.createElement('div');
    wrap.className = 'colorbar';
    if (onHide) {
        const close = document.createElement('button');
        close.className = 'cbar-close'; close.textContent = '✕'; close.title = 'Hide colorbars';
        close.addEventListener('click', onHide);
        wrap.appendChild(close);
    }
    container.appendChild(wrap);

    const cbW = config.render?.colorbarWidth ?? 240;
    const cbH = config.render?.colorbarHeight ?? 14;
    const showNames = overlays.length > 1;

    const bars = overlays.map((ov, i) => {
        const row = document.createElement('div');
        row.className = 'cbar-row';
        if (showNames) {
            const nm = document.createElement('div');
            nm.className = 'cbar-name'; nm.style.width = cbW + 'px';
            nm.textContent = ov.name || ('overlay ' + (i + 1));
            row.appendChild(nm);
        }
        const canvas = document.createElement('canvas');
        canvas.width = cbW; canvas.height = cbH;
        canvas.style.width = cbW + 'px'; canvas.style.height = cbH + 'px';
        const labels = document.createElement('div');
        labels.className = 'colorbar-labels'; labels.style.width = cbW + 'px';
        if (config.render?.colorbarFont) labels.style.fontFamily = config.render.colorbarFont;
        if (config.render?.colorbarFontSize != null) labels.style.fontSize = config.render.colorbarFontSize + 'px';
        // M11/M5: value-unit caption (z / t / % …) so a reader of the figure knows WHAT the
        // numbers are. Same DOM in browser + the headless colorbar sidecar.
        const units = document.createElement('div');
        units.className = 'cbar-units'; units.style.width = cbW + 'px';
        if (config.render?.colorbarFont) units.style.fontFamily = config.render.colorbarFont;
        row.append(canvas, labels, units);
        wrap.append(row);
        return { i, ov, canvas, labels, units, ctx: canvas.getContext('2d') };
    });

    function update() {
        for (const bar of bars) {
            const model = colorbarModel(config, bar.ov, colormaps, bar.i);
            if (!model) continue;
            const W = bar.canvas.width, H = bar.canvas.height;
            const img = bar.ctx.createImageData(W, H);
            const columns = model.sampleColumns(W);
            for (let x = 0; x < W; x++) {
                const [R, G, B] = columns[x];
                for (let y = 0; y < H; y++) {
                    const k = (y * W + x) * 4;
                    img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = 255;
                }
            }
            bar.ctx.putImageData(img, 0, 0);
            bar.labels.innerHTML = model.ticks.map((v) => `<span>${v.toFixed(1)}</span>`).join('');
            bar.units.textContent = model.units;
        }
    }

    return { update, el: wrap };
}
