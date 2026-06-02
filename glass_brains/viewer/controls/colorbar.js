/**
 * colorbar.js — on-screen colorbar that matches the voxels exactly.
 *
 * It runs each value through the SAME pipeline as the voxel fragment shader:
 *   value → t (gamma, diverging/sequential, positive-guard) → LUT (sRGB)
 *   → sRGB→linear albedo → ×emissive + glint (light-independent) → linear→sRGB.
 * So the bar reflects the displayed colours under the current colormap and
 * lighting/emissive/specular settings (no veil — that is depth-only, 0 at front).
 */
import { resolveColormap, sampleLUT, srgbToLinear, linearToSrgb, valueToT, clamp01 } from '../core/colormap.js';

// View-space half-vector z for a front-facing swatch, matching the shader's
// uGlint term:  Hg = normalize((-0.3,0.4,1)+(0,0,1)); dot([0,0,1],Hg) = Hg.z.
const GLINT_NDOTH = 2.0 / Math.hypot(-0.3, 0.4, 2.0);

export function createColorbar(container, { engine, config, colormaps }) {
    const ov = engine.sceneModel.manifest.overlays?.[0];
    const maxAbs = ov?.maxAbsValue ?? 1.0;
    const diverging = !!ov?.diverging;

    const wrap = document.createElement('div');
    wrap.className = 'colorbar';
    const cbW = config.render?.colorbarWidth ?? 240;   // horizontal bar (left=min → right=max)
    const cbH = config.render?.colorbarHeight ?? 14;
    const canvas = document.createElement('canvas');
    canvas.width = cbW; canvas.height = cbH;
    canvas.style.width = cbW + 'px'; canvas.style.height = cbH + 'px';
    const labels = document.createElement('div');
    labels.className = 'colorbar-labels';
    labels.style.width = cbW + 'px';
    // Adjustable tick font (default Computer Modern roman).
    if (config.render?.colorbarFont) labels.style.fontFamily = config.render.colorbarFont;
    if (config.render?.colorbarFontSize != null) labels.style.fontSize = config.render.colorbarFontSize + 'px';
    wrap.append(canvas, labels);
    container.appendChild(wrap);
    const ctx = canvas.getContext('2d');

    function swatch(t, s, cmap) {
        const [r, g, b] = sampleLUT(cmap, t);                       // sRGB 0..1
        const glint = Math.pow(Math.max(GLINT_NDOTH, 0.0), Math.max(s.voxel.shininess, 1)) * s.voxel.specular;
        // emissive + front-facing diffuse (Lambert 1/π, NdotL=1): matches the
        // camera-facing voxel faces under the current emissive + scene lights.
        const k = s.voxel.emissive + (s.lighting.directional + s.lighting.ambient) / Math.PI;
        return [r, g, b].map((c) =>
            Math.round(clamp01(linearToSrgb(srgbToLinear(c) * k + glint)) * 255));
    }

    function update() {
        const s = config.style;
        const { name, mode, divergingMapOnPositive } = resolveColormap(s, diverging, colormaps);
        const cmap = colormaps.get(name);
        if (!cmap) return;
        const W = canvas.width, H = canvas.height;
        const minVal = diverging ? -maxAbs : 0, maxVal = maxAbs;
        const img = ctx.createImageData(W, H);
        for (let x = 0; x < W; x++) {
            const value = minVal + (maxVal - minVal) * (x / (W - 1)); // left = min, right = max
            const t = valueToT(value, maxAbs, mode, s.gamma, divergingMapOnPositive);
            const [R, G, B] = swatch(t, s, cmap);
            for (let y = 0; y < H; y++) {
                const i = (y * W + x) * 4;
                img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const ticks = diverging ? [minVal, 0, maxVal] : [0, maxVal / 2, maxVal];
        labels.innerHTML = ticks.map((v) => `<span>${v.toFixed(1)}</span>`).join('');
    }

    return { update, el: wrap };
}
