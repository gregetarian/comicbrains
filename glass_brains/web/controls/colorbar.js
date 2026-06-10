/**
 * colorbar.js — one on-screen colorbar per overlay, each matching its voxels
 * exactly. Each bar runs its overlay's resolved style through the SAME pipeline
 * as the voxel shader:  value → t (gamma, seq/div, +guard) → LUT (sRGB)
 *   → sRGB→linear albedo → ×emissive + glint → linear→sRGB.
 */
import { resolveColormap, sampleLUT, srgbToLinear, linearToSrgb, valueToT, clamp01, deriveMaxAbs } from '../core/colormap.js';
import { overlayStyle } from '../core/config-schema.js';

// View-space half-vector z for a front-facing swatch (matches the shader glint).
const GLINT_NDOTH = 2.0 / Math.hypot(-0.3, 0.4, 2.0);

function swatch(t, os, lighting, cmap) {
    const [r, g, b] = sampleLUT(cmap, t);
    const glint = Math.pow(Math.max(GLINT_NDOTH, 0.0), Math.max(os.shininess, 1)) * os.specular;
    const k = os.emissive + (lighting.directional + lighting.ambient) / Math.PI;
    return [r, g, b].map((c) => Math.round(clamp01(linearToSrgb(srgbToLinear(c) * k + glint)) * 255));
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
        const lighting = config.style.lighting;
        for (const bar of bars) {
            const os = overlayStyle(config, bar.i);
            const diverging = !!bar.ov.diverging;
            const negativeOnly = !!bar.ov.negativeOnly;
            const maxAbs = deriveMaxAbs(os.clim, bar.ov.maxAbsValue ?? 1.0);   // clim pins the bar to match the voxels
            const { name, mode, divergingMapOnPositive, divergingMapOnNegative } = resolveColormap(os, diverging, colormaps, negativeOnly);
            const cmap = colormaps.get(name);
            if (!cmap) continue;
            const W = bar.canvas.width, H = bar.canvas.height;
            // Single-signed negative data reads as [-maxAbs, 0]; positive as [0, maxAbs]; diverging spans both.
            const minVal = (diverging || negativeOnly) ? -maxAbs : 0;
            const maxVal = negativeOnly ? 0 : maxAbs;
            const img = bar.ctx.createImageData(W, H);
            for (let x = 0; x < W; x++) {
                const value = minVal + (maxVal - minVal) * (x / (W - 1));
                const t = valueToT(value, maxAbs, mode, os.gamma, divergingMapOnPositive, divergingMapOnNegative);
                const [R, G, B] = swatch(t, os, lighting, cmap);
                for (let y = 0; y < H; y++) {
                    const k = (y * W + x) * 4;
                    img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = 255;
                }
            }
            bar.ctx.putImageData(img, 0, 0);
            const ticks = diverging ? [minVal, 0, maxVal]
                : negativeOnly ? [minVal, minVal / 2, 0] : [0, maxVal / 2, maxVal];
            bar.labels.innerHTML = ticks.map((v) => `<span>${v.toFixed(1)}</span>`).join('');
            const u = os.units && os.units.value;          // 'stat' = unitless default → no caption
            bar.units.textContent = (u && u !== 'stat') ? u : '';
        }
    }

    return { update, el: wrap };
}
