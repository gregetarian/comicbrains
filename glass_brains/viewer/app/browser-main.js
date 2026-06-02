/**
 * browser-main.js — interactive browser entry.
 * Loads config + colormaps + scene, builds the engine, runs a RAF loop, places
 * panel labels, and handles resize. Controls are wired separately (controls/).
 */
import * as THREE from 'three';
import { resolveConfig } from '../core/presets.js';
import { loadColormaps } from '../core/colormap.js';
import { loadScene } from '../scene/asset-loader.js';
import { createEngine } from '../scene/renderer.js';
import { bindControls } from '../controls/bind.js';
import { createColorbar } from '../controls/colorbar.js';
import { initKapow } from '../controls/kapow.js';

async function fetchJSON(url, fallback) {
    try { const r = await fetch(url); if (!r.ok) throw 0; return await r.json(); }
    catch { return fallback; }
}

async function main() {
    const params = new URLSearchParams(location.search);
    const rc = await fetchJSON(params.get('config') || 'render-config.json', { preset: 'fourPanel', style: {} });
    const presetOverride = params.get('preset');
    const config = (rc.layout && !presetOverride)
        ? resolveConfig(rc)                                              // full custom layout
        : resolveConfig(presetOverride || rc.preset || 'fourPanel', { style: rc.style || {} });

    const cmJson = await fetchJSON(config.data.colormaps, { n: 2, maps: {} });
    const colormaps = loadColormaps(cmJson);

    const sceneModel = await loadScene(config.data.manifest);

    const showColorbar = config.render.colorbar !== false;
    document.body.classList.toggle('nobar', !showColorbar);

    const container = document.getElementById('viewer');
    const canvas = document.getElementById('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    // Provisional size; the ResizeObserver below makes the renderer track the real
    // canvas box once the control rows + colorbar settle (so nothing depends on the
    // exact timing of a refresh). updateStyle=false: CSS owns the display size.
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
    const engine = createEngine({ renderer, width: canvas.clientWidth || 1, height: canvas.clientHeight || 1, sceneModel, colormaps, config });

    bindControls({ engine, config, colormaps });          // builds the per-overlay rows
    const colorbar = showColorbar ? createColorbar(container, { engine, config, colormaps }) : null;
    initKapow(document.getElementById('c-kapow'));         // comic SFX on click

    const saveBtn = document.getElementById('c-save');
    if (saveBtn) saveBtn.addEventListener('click', () =>
        saveFigure({ engine, canvas, container, colorbar, config, saveBtn }));

    // Robust sizing: reserve the bottom strip from the MEASURED colorbar height,
    // then keep the renderer synced to the actual canvas via a ResizeObserver. This
    // survives control-row reflow, overlay add/remove, window resize, and the async
    // web-font load — the canvas size is the single source of truth.
    const syncStrip = () => {
        const strip = (!colorbar) ? 0 : Math.ceil(colorbar.el.getBoundingClientRect().height) + 22;
        document.documentElement.style.setProperty('--cbstrip', strip + 'px');
    };
    const fit = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (w > 0 && h > 0) engine.resize(w, h); };
    syncStrip(); fit();
    new ResizeObserver(fit).observe(canvas);     // control-row reflow / overlay add-remove
    window.addEventListener('resize', fit);      // window/viewport resize
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { syncStrip(); fit(); });

    document.getElementById('loading').style.display = 'none';
    (function loop() { requestAnimationFrame(loop); engine.renderFrame(); colorbar?.update(); })();

    window.__engine = engine; // debug handle
}

/** Save the current view as a high-res PNG: supersample the WebGL panels, then
 *  composite the colorbar (gradient + tick text) on top, and download. */
function saveFigure({ engine, canvas, container, colorbar, config, saveBtn }) {
    const label = saveBtn && saveBtn.textContent;
    if (saveBtn) saveBtn.textContent = 'Saving…';
    const cssW = canvas.clientWidth;
    const basePr = window.devicePixelRatio || 1;
    const savePr = Math.min(4, Math.max(basePr, Math.ceil(3800 / cssW))); // ≳3800px wide
    try {
        engine.setPixelRatio(savePr);
        engine.renderFrame();
        colorbar?.update();

        const out = document.createElement('canvas');
        out.width = Math.round(container.clientWidth * savePr);
        out.height = Math.round(container.clientHeight * savePr);
        const g = out.getContext('2d');
        g.fillStyle = (config.render && config.render.background) || '#ffffff';
        g.fillRect(0, 0, out.width, out.height);
        // Panels (the WebGL canvas covers the top panel region).
        g.drawImage(canvas, 0, 0, out.width, Math.round(canvas.clientHeight * savePr));
        // Colorbar(s): one bar per overlay, gradient + name + ticks, from live DOM rects.
        if (colorbar) {
            const cont = container.getBoundingClientRect();
            g.textBaseline = 'top';
            colorbar.el.querySelectorAll('.cbar-row').forEach((row) => {
                const bar = row.querySelector('canvas');
                const br = bar.getBoundingClientRect();
                g.drawImage(bar, (br.left - cont.left) * savePr, (br.top - cont.top) * savePr, br.width * savePr, br.height * savePr);
                const nm = row.querySelector('.cbar-name');
                if (nm) {
                    const nr = nm.getBoundingClientRect();
                    g.fillStyle = '#555'; g.font = `${10 * savePr}px sans-serif`;
                    g.fillText(nm.textContent, (nr.left - cont.left) * savePr, (nr.top - cont.top) * savePr);
                }
                g.fillStyle = '#777';
                g.font = `${(config.render.colorbarFontSize ?? 11) * savePr}px ${config.render.colorbarFont || 'serif'}`;
                row.querySelectorAll('.colorbar-labels span').forEach((s) => {
                    const sr = s.getBoundingClientRect();
                    g.fillText(s.textContent, (sr.left - cont.left) * savePr, (sr.top - cont.top) * savePr);
                });
            });
        }
        out.toBlob((blob) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'glassbrain.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }, 'image/png');
    } finally {
        engine.setPixelRatio(basePr);
        engine.renderFrame();
        if (saveBtn) saveBtn.textContent = label;
    }
}

main().catch((err) => {
    console.error(err);
    const el = document.getElementById('loading');
    if (el) el.textContent = 'Error: ' + err.message;
});
