/**
 * headless-entry.js — offscreen render entry for the CLI (loaded via
 * index.html?headless=1). Same engine as the browser, but: fixed size from
 * config.render, no controls, renders a few frames then sets window.__GB_DONE__
 * for the Playwright driver to screenshot #viewer.
 */
import * as THREE from 'three';
import { resolveConfig } from '../core/presets.js';
import { loadColormaps } from '../core/colormap.js';
import { loadScene } from '../scene/asset-loader.js';
import { createEngine } from '../scene/renderer.js';
import { createColorbar } from '../controls/colorbar.js';

async function fetchJSON(url, fb) {
    try { const r = await fetch(url); if (!r.ok) throw 0; return await r.json(); } catch { return fb; }
}

async function main() {
    const params = new URLSearchParams(location.search);
    const rc = await fetchJSON(params.get('config') || 'render-config.json', { preset: 'fourPanel', style: {} });
    const config = rc.layout ? resolveConfig(rc) : resolveConfig(rc.preset || 'fourPanel', { style: rc.style || {} });

    const cmJson = await fetchJSON(config.data.colormaps, { n: 2, maps: {} });
    const colormaps = loadColormaps(cmJson);
    const sceneModel = await loadScene(config.data.manifest);

    // Size the page to the requested figure; hide the control bar.
    const ctrls = document.getElementById('controls'); if (ctrls) ctrls.style.display = 'none';
    const showColorbar = config.render.colorbar !== false;
    document.body.classList.toggle('nobar', !showColorbar);   // before measuring the canvas
    { const r = config.render; const strip = showColorbar ? (r.colorbarHeight ?? 14) + (r.colorbarFontSize ?? 11) + 28 : 0;
      document.documentElement.style.setProperty('--cbstrip', strip + 'px'); }
    const container = document.getElementById('viewer');
    const W = config.render.width, H = config.render.height, pr = config.render.pixelRatio || 2;
    container.style.width = W + 'px'; container.style.height = H + 'px';

    const canvas = document.getElementById('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(pr);
    const cw = canvas.clientWidth, ch = canvas.clientHeight; // canvas minus colorbar strip
    renderer.setSize(cw, ch);

    const engine = createEngine({ renderer, width: cw, height: ch, sceneModel, colormaps, config });
    const colorbar = showColorbar ? createColorbar(container, { engine, config, colormaps }) : null;

    document.getElementById('loading').style.display = 'none';
    // A few frames to compile shaders + populate the colorbar, then flag done.
    for (let i = 0; i < 4; i++) { engine.renderFrame(); colorbar?.update(); }
    requestAnimationFrame(() => {
        engine.renderFrame(); colorbar?.update();
        requestAnimationFrame(() => { window.__GB_DONE__ = true; });
    });
}

main().catch((e) => { console.error(e); window.__GB_ERR__ = String((e && e.message) || e); });
