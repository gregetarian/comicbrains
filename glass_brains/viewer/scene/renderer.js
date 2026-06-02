/**
 * renderer.js — the multi-panel, multi-overlay engine. Browser side; contains NO
 * layout literals — everything comes from `config` + the pure core modules.
 *
 * Each loaded NIfTI (overlay) gets its OWN voxel material + uniforms + edge pass +
 * colour, resolved from `overlayStyle(config, i)` (per-overlay overrides on top of
 * the global voxel template). Cortex/anatomy/lighting/outline stay global.
 */
import * as THREE from 'three';
import { layoutGrid } from '../core/grid.js';
import { frameContent, mergeAABB } from '../core/framing.js';
import { normalize, sub } from '../core/units.js';
import { visible } from '../core/visibility.js';
import { resolveColormap, colorizeValues } from '../core/colormap.js';
import { overlayStyle } from '../core/config-schema.js';
import { makeGlassMaterial, makeAnatomyMaterial, makeVoxelMaterial, makeSharedVoxelUniforms } from './materials.js';
import { OutlinePass, makeThresholdDepthMaterial } from './passes.js';

export function createEngine({ renderer, width, height, sceneModel, colormaps, config }) {
    const scene = new THREE.Scene();
    renderer.autoClear = false;
    renderer.setClearColor(new THREE.Color(config.render.background ?? '#ffffff'), 1);

    const overlays = sceneModel.manifest.overlays || [];
    const N = overlays.length;
    config.style.overlays ||= [];
    while (config.style.overlays.length < N) config.style.overlays.push({});

    // --- lighting (one directional headlight re-aimed per panel + ambient) ---
    const L = config.style.lighting;
    const dir = new THREE.DirectionalLight(0xffffff, L.directional);
    const amb = new THREE.AmbientLight(0xffffff, L.ambient);
    scene.add(dir, amb, dir.target);

    // --- subtle inter-voxel shadows ---
    const SH = config.style.shadows;
    if (SH.enabled) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        dir.castShadow = true;
        dir.shadow.mapSize.set(SH.mapSize, SH.mapSize);
        const sc = dir.shadow.camera;
        sc.left = -130; sc.right = 130; sc.top = 130; sc.bottom = -130; sc.near = 10; sc.far = 1300;
        sc.updateProjectionMatrix();
        dir.shadow.bias = -0.0012;
        dir.shadow.normalBias = 0.6;
    }

    // --- global surface/anatomy materials ---
    const glassMat = makeGlassMaterial(config.style.glass);
    const anatomyMat = makeAnatomyMaterial(config.style.anatomy);

    // --- per-overlay voxel materials + uniforms (overlay i → layer 1+i) ---
    const uniforms = [], voxelMats = [];
    for (let i = 0; i < N; i++) {
        const os = overlayStyle(config, i);
        const u = makeSharedVoxelUniforms({
            positiveOnly: os.positiveOnly,
            voxel: { veil: os.veil, emissive: os.emissive, specular: os.specular, shininess: os.shininess, clusterMin: os.clusterMin },
        });
        u.uMaxAbs.value = overlays[i].maxAbsValue ?? 1.0;
        u.uThreshold.value = os.threshold ?? overlays[i].threshold ?? 0;
        uniforms.push(u);
        voxelMats.push(makeVoxelMaterial({}, u));
    }

    // --- place meshes, assign materials + layers + shadows ---
    for (const tm of sceneModel.meshes) {
        const m = tm.mesh;
        if (tm.meta.role === 'cortex') { m.material = glassMat; m.renderOrder = 1; m.layers.set(0); }
        else if (tm.meta.role === 'anatomy') { m.material = anatomyMat; m.renderOrder = 5; m.layers.set(0); m.receiveShadow = SH.enabled; }
        else {
            const oi = tm.meta.overlay ?? 0;
            m.material = voxelMats[oi] || voxelMats[0];
            m.renderOrder = 15; m.layers.set(1 + oi);       // each overlay on its own layer
            m.castShadow = SH.enabled; m.receiveShadow = SH.enabled;
        }
        scene.add(m);
    }

    // Downsampled world voxel vertices, for anchoring the depth veil to the ACTUAL
    // nearest voxel (not a bounding-box corner that sits in empty space under tilt).
    scene.updateMatrixWorld(true);
    {
        const v = new THREE.Vector3();
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'voxel') continue;
            const pos = tm.mesh.geometry.attributes.position, n = pos.count;
            const step = Math.max(1, Math.floor(n / 300));
            const pts = [];
            for (let i = 0; i < n; i += step) {
                v.fromBufferAttribute(pos, i).applyMatrix4(tm.mesh.matrixWorld);
                pts.push(v.x, v.y, v.z);
            }
            tm.depthSamples = new Float32Array(pts);
        }
    }

    // --- colorize voxels per overlay (JS is the single colour authority) ---
    function recolor() {
        for (let i = 0; i < N; i++) {
            const os = overlayStyle(config, i);
            const div = !!overlays[i].diverging;
            const { name, mode, divergingMapOnPositive } = resolveColormap(os, div, colormaps);
            const cmap = colormaps.get(name) || colormaps.values().next().value;
            if (!cmap) continue;
            const mAbs = overlays[i].maxAbsValue ?? 1.0;
            for (const tm of sceneModel.meshes) {
                if (tm.meta.role !== 'voxel' || (tm.meta.overlay ?? 0) !== i || !tm.values) continue;
                const lin = colorizeValues(tm.values, cmap, mAbs, mode, os.gamma, divergingMapOnPositive);
                tm.mesh.geometry.attributes.color.copyArray(lin);
                tm.mesh.geometry.attributes.color.needsUpdate = true;
            }
        }
    }
    recolor();

    // --- panels: one ortho camera each, seeing all overlay layers ---
    const panels = config.layout.panels.map((p) => {
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
        for (let i = 0; i < N; i++) cam.layers.enable(1 + i);
        return { def: p, camera: cam };
    });

    // --- grid + outline passes ---
    let grid = layoutGrid({ width, height, ...config.layout.grid });
    const maxCellW = width, maxCellH = height;
    const cortexOutline = new OutlinePass(renderer, scene, maxCellW, maxCellH, {
        layer: 0, color: config.style.outline.color, width: config.style.outline.width, threshold: config.style.outline.threshold,
    });
    // Per-overlay voxel edge passes (each its own layer + edge style + veil).
    const edgePasses = [];
    for (let i = 0; i < N; i++) {
        const os = overlayStyle(config, i);
        edgePasses.push(new OutlinePass(renderer, scene, maxCellW, maxCellH, {
            layer: 1 + i, color: os.edges.color, opacity: os.edges.opacity,
            width: os.edges.width, threshold: os.edges.threshold,
            depthMaterial: makeThresholdDepthMaterial(uniforms[i]),
            veil: uniforms[i],
        }));
    }

    // Combined voxel depth (nearest passing-threshold voxel across ALL overlays),
    // for the cortex outline's depth-clip: each overlay's threshold depth material
    // is rendered in turn into one depth-tested target so the nearest wins.
    const pr0 = renderer.getPixelRatio();
    const makeDepthTarget = (w, h) => new THREE.WebGLRenderTarget(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()), {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.FloatType,
    });
    let clipTarget = makeDepthTarget(maxCellW, maxCellH);
    const clipCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
    cortexOutline.outlineMaterial.uniforms.uClipDepth.value = clipTarget.texture;

    function renderClipDepth(camera) {
        const prev = scene.overrideMaterial;
        renderer.setRenderTarget(clipTarget);
        renderer.setScissorTest(false);
        renderer.clear();                                   // clears colour (white→far) + depth
        for (let i = 0; i < N; i++) {
            clipCam.copy(camera); clipCam.layers.set(1 + i);
            scene.overrideMaterial = edgePasses[i].depthMaterial;
            renderer.render(scene, clipCam);                // depth-tested: nearest accumulates
        }
        scene.overrideMaterial = prev;
        renderer.setRenderTarget(null);
    }

    // --- per-frame resolved overlay styles + visibility helpers ---
    let osR = [];                                           // resolved overlay styles (per frame)
    function refreshResolved() { osR = []; for (let i = 0; i < N; i++) osR.push(overlayStyle(config, i)); }
    refreshResolved();
    const globalVis = () => ({ cortexSurface: config.style.cortexSurface, voxel: { representation: config.style.voxel.representation } });
    function visStyleFor(meta) {
        if (meta.role === 'voxel') {
            const os = osR[meta.overlay ?? 0];
            return { cortexSurface: config.style.cortexSurface, voxel: { representation: os ? os.representation : config.style.voxel.representation } };
        }
        return globalVis();
    }
    const meshVisible = (content, meta) => visible(content, meta, visStyleFor(meta));

    function panelAABB(content) {
        const boxes = [];
        for (const tm of sceneModel.meshes) if (meshVisible(content, tm.meta)) boxes.push(tm.aabb);
        return mergeAABB(boxes);
    }
    function applyVisibility(content) {
        for (const tm of sceneModel.meshes) tm.mesh.visible = meshVisible(content, tm.meta);
    }
    // View-space depth range of one overlay's visible voxels (nearest/farthest vertex).
    function voxelDepthRange(content, oi, camPos, fwd) {
        let near = Infinity, far = -Infinity;
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'voxel' || (tm.meta.overlay ?? 0) !== oi || !tm.depthSamples) continue;
            if (!meshVisible(content, tm.meta)) continue;
            const s = tm.depthSamples;
            for (let i = 0; i < s.length; i += 3) {
                const d = (s[i] - camPos[0]) * fwd[0] + (s[i + 1] - camPos[1]) * fwd[1] + (s[i + 2] - camPos[2]) * fwd[2];
                if (d < near) near = d;
                if (d > far) far = d;
            }
        }
        return { near, far };
    }

    function renderFrame() {
        // Full-buffer clear (a prior frame's outline pass leaves the scissor test on,
        // which would restrict clear() to one panel and ghost old frames otherwise).
        renderer.setScissorTest(false);
        renderer.clear();
        refreshResolved();

        // Pass 1 — framing per panel.
        const frames = panels.map(({ def, camera }) => {
            const rect = grid.rect(def.cell.row, def.cell.col, def.rowSpan, def.colSpan);
            const aabb = panelAABB(def.content);
            const fr = frameContent(aabb, def.camera, rect.aspect,
                { ...def.framing, margin: config.style.margin ?? def.framing.margin, tilt: config.style.tilt });
            return { def, camera, rect, fr };
        });

        // Shared world scale: fit:'shared' panels adopt a common mm-per-pixel.
        let sharedMmPx = 0;
        for (const { def, rect, fr } of frames)
            if (def.framing.fit === 'shared') sharedMmPx = Math.max(sharedMmPx, fr.ext / (rect.h / 2));
        if (sharedMmPx > 0) {
            for (const { def, rect, fr } of frames) {
                if (def.framing.fit !== 'shared') continue;
                const ext = sharedMmPx * (rect.h / 2);
                fr.ext = ext;
                fr.left = -ext * rect.aspect; fr.right = ext * rect.aspect;
                fr.top = ext; fr.bottom = -ext;
            }
        }

        // Pass 2 — render each panel.
        for (const { def, camera, rect, fr } of frames) {
            camera.position.set(...fr.position);
            camera.up.set(...fr.up);
            camera.left = fr.left; camera.right = fr.right; camera.top = fr.top; camera.bottom = fr.bottom;
            camera.near = fr.near; camera.far = fr.far;
            camera.lookAt(...fr.lookAt);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);

            applyVisibility(def.content);
            if (def.anatomyOpacity != null) { anatomyMat.opacity = def.anatomyOpacity; anatomyMat.transparent = def.anatomyOpacity < 1; }
            else { anatomyMat.opacity = config.style.anatomy.opacity; anatomyMat.transparent = anatomyMat.opacity < 1; }

            // Per-overlay depth-veil range anchored to that overlay's nearest voxel.
            const fwd = normalize(sub(fr.lookAt, fr.position));
            for (let i = 0; i < N; i++) {
                const drng = voxelDepthRange(def.content, i, fr.position, fwd);
                if (isFinite(drng.near)) { uniforms[i].uNearZ.value = drng.near; uniforms[i].uFarZ.value = Math.max(drng.far, drng.near + 1e-3); }
                else { uniforms[i].uNearZ.value = fr.nearZ; uniforms[i].uFarZ.value = fr.farZ; }
            }

            if (L.headlight) {
                dir.position.copy(camera.position);
                if (SH.enabled) {
                    const e = camera.matrixWorld.elements;
                    const off = SH.offset * camera.position.length();
                    dir.position.x += e[0] * off + e[4] * off * 0.7;
                    dir.position.y += e[1] * off + e[5] * off * 0.7;
                    dir.position.z += e[2] * off + e[6] * off * 0.7;
                }
                dir.target.position.set(...fr.lookAt);
                dir.target.updateMatrixWorld(true);
            }

            renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissorTest(true);
            renderer.render(scene, camera);

            // Per-overlay voxel edges first (underneath), then black cortex outline on
            // top — depth-clipped so any voxel genuinely in front shows its own edge.
            let anyEdges = false;
            for (let i = 0; i < N; i++) {
                if (osR[i].edges.enabled) { edgePasses[i].update(camera, rect.x, rect.y, rect.w, rect.h); anyEdges = true; }
            }
            if (config.style.outline.enabled) {
                if (anyEdges && N > 0) renderClipDepth(camera);
                cortexOutline.outlineMaterial.uniforms.uClipApply.value = (anyEdges && N > 0) ? 1.0 : 0.0;
                cortexOutline.update(camera, rect.x, rect.y, rect.w, rect.h);
            }
        }
    }

    function resize(w, h) {
        width = w; height = h;
        renderer.setSize(w, h);
        grid = layoutGrid({ width, height, ...config.layout.grid });
        cortexOutline.setSize(w, h);
        for (const ep of edgePasses) ep.setSize(w, h);
        clipTarget.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
    }

    function setPixelRatio(pr) {
        renderer.setPixelRatio(pr);
        renderer.setSize(width, height);
        cortexOutline.pr = pr; cortexOutline.setSize(width, height);
        for (const ep of edgePasses) { ep.pr = pr; ep.setSize(width, height); }
        clipTarget.setSize(Math.round(width * pr), Math.round(height * pr));
    }

    // Push current config.style to live uniforms/materials/lights (global + per-overlay).
    function applyStyle() {
        const s = config.style;
        dir.intensity = s.lighting.directional;
        amb.intensity = s.lighting.ambient;
        glassMat.uniforms.uMaxOpacity.value = s.glass.maxOpacity;
        cortexOutline.outlineMaterial.uniforms.uLineWidth.value = s.outline.width;
        cortexOutline.outlineMaterial.uniforms.uThreshold.value = s.outline.threshold;
        for (let i = 0; i < N; i++) {
            const os = overlayStyle(config, i), u = uniforms[i];
            u.uGlintAmt.value = os.specular;
            u.uGlintPow.value = Math.max(1, os.shininess);
            u.uVeilStrength.value = os.veil.strength;
            u.uVeilK.value = os.veil.k;
            u.uEmissiveBoost.value = os.emissive;
            u.uThreshold.value = os.threshold ?? overlays[i].threshold ?? 0;
            u.uPositiveOnly.value = os.positiveOnly ? 1 : 0;
            u.uClusterMin.value = os.clusterMin ?? 0;
            const em = edgePasses[i].outlineMaterial.uniforms;
            em.uOpacity.value = os.edges.opacity;
            em.uLineWidth.value = os.edges.width;
        }
    }

    function setColormap(name, i = 0) {
        (config.style.overlays[i] ||= {}).colormap = name;
        recolor();
    }

    function getPanelRects() {
        return panels.map(({ def }) => {
            const r = grid.rect(def.cell.row, def.cell.col, def.rowSpan, def.colSpan);
            return { id: def.id, title: def.title, cssLeft: r.cssLeft, cssTop: r.cssTop, w: r.w, h: r.h };
        });
    }

    return {
        scene, renderFrame, resize, setPixelRatio, getPanelRects, recolor, applyStyle, setColormap,
        overlays, config, renderer, THREE, sceneModel,
        _internals: { uniforms, glassMat, anatomyMat, voxelMats, dir, amb },
    };
}
