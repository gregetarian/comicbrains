/**
 * renderer.js — the multi-panel engine. Browser side; contains NO layout
 * literals — everything comes from `config` + the pure core modules.
 *
 * Per panel each frame: resolve viewport (grid) → visibility (visibility) →
 * camera pose + ortho extent (framing) → per-panel headlight → opaque pass
 * (anatomy + voxels) → glass transparent pass → outline + voxel-edge passes.
 */
import * as THREE from 'three';
import { layoutGrid } from '../core/grid.js';
import { frameContent, mergeAABB } from '../core/framing.js';
import { normalize, sub } from '../core/units.js';
import { visible } from '../core/visibility.js';
import { resolveColormap, colorizeValues } from '../core/colormap.js';
import { makeGlassMaterial, makeAnatomyMaterial, makeVoxelMaterial, makeSharedVoxelUniforms } from './materials.js';
import { OutlinePass, makeThresholdDepthMaterial } from './passes.js';

export function createEngine({ renderer, width, height, sceneModel, colormaps, config }) {
    const scene = new THREE.Scene();
    renderer.autoClear = false;
    renderer.setClearColor(new THREE.Color(config.render.background ?? '#ffffff'), 1);

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

    // --- shared materials ---
    const glassMat = makeGlassMaterial(config.style.glass);
    const anatomyMat = makeAnatomyMaterial(config.style.anatomy);
    const voxelUniforms = makeSharedVoxelUniforms(config.style);
    const voxelMat = makeVoxelMaterial(config.style, voxelUniforms);

    // --- place meshes, assign materials + layers + metadata ---
    for (const tm of sceneModel.meshes) {
        const m = tm.mesh;
        if (tm.meta.role === 'cortex') { m.material = glassMat; m.renderOrder = 1; m.layers.set(0); }
        else if (tm.meta.role === 'anatomy') { m.material = anatomyMat; m.renderOrder = 5; m.layers.set(0); m.receiveShadow = SH.enabled; }
        else { m.material = voxelMat; m.renderOrder = 15; m.layers.set(1); m.castShadow = SH.enabled; m.receiveShadow = SH.enabled; } // voxels excluded from cortex outline
        scene.add(m);
    }

    // Downsampled world-space voxel vertices, for anchoring the depth veil to the
    // ACTUAL nearest voxel (not a bounding-box corner, which sits in empty space
    // under the oblique tilt and would leave the nearest voxel slightly veiled).
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

    // --- colorize voxels (JS is the single colour authority) ---
    const overlay0 = sceneModel.manifest.overlays?.[0];
    const dataDiverging = !!overlay0?.diverging;
    const maxAbs = overlay0?.maxAbsValue ?? 1.0;
    voxelUniforms.uMaxAbs.value = maxAbs;
    voxelUniforms.uThreshold.value = config.style.threshold ?? overlay0?.threshold ?? 0;
    voxelUniforms.uClusterMin.value = config.style.voxel.clusterMin ?? 0;

    function recolor() {
        const { name, mode, divergingMapOnPositive } = resolveColormap(config.style, dataDiverging, colormaps);
        const cmap = colormaps.get(name) || colormaps.values().next().value;
        if (!cmap) return;
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'voxel' || !tm.values) continue;
            const lin = colorizeValues(tm.values, cmap, maxAbs, mode, config.style.gamma, divergingMapOnPositive);
            tm.mesh.geometry.attributes.color.copyArray(lin);
            tm.mesh.geometry.attributes.color.needsUpdate = true;
        }
    }
    recolor();

    // --- panels: one ortho camera each ---
    const panels = config.layout.panels.map((p) => {
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
        cam.layers.enable(1);
        return { def: p, camera: cam };
    });

    // --- grid + outline passes ---
    let grid = layoutGrid({ width, height, ...config.layout.grid });
    const maxCellW = width, maxCellH = height;
    const cortexOutline = new OutlinePass(renderer, scene, maxCellW, maxCellH, {
        layer: 0, color: config.style.outline.color, width: config.style.outline.width, threshold: config.style.outline.threshold,
    });
    const voxelEdge = new OutlinePass(renderer, scene, maxCellW, maxCellH, {
        layer: 1, color: config.style.voxel.edges.color, opacity: config.style.voxel.edges.opacity,
        width: config.style.voxel.edges.width, threshold: config.style.voxel.edges.threshold,
        depthMaterial: makeThresholdDepthMaterial(voxelUniforms),
        veil: voxelUniforms, // edges fade with the voxel veil
    });
    // The black cortex outline draws OVER the voxel edges, but clips itself where a
    // voxel is genuinely in front of the surface (sampling the voxel depth target).
    cortexOutline.outlineMaterial.uniforms.uClipDepth.value = voxelEdge.depthTarget.texture;

    function panelAABB(content, roleFilter) {
        const boxes = [];
        for (const tm of sceneModel.meshes) {
            if (roleFilter && tm.meta.role !== roleFilter) continue;
            if (visible(content, tm.meta, config.style)) boxes.push(tm.aabb);
        }
        return mergeAABB(boxes);
    }

    function applyVisibility(content) {
        for (const tm of sceneModel.meshes) tm.mesh.visible = visible(content, tm.meta, config.style);
    }

    // View-space depth range of the visible voxels (nearest/farthest real vertex).
    function voxelDepthRange(content, camPos, fwd) {
        let near = Infinity, far = -Infinity;
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'voxel' || !tm.depthSamples) continue;
            if (!visible(content, tm.meta, config.style)) continue;
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
        // Clear the FULL buffer: a prior frame's outline pass leaves the scissor
        // test enabled, which would otherwise restrict clear() to one panel and
        // let old frames accumulate (visible as doubled/ghosted geometry).
        renderer.setScissorTest(false);
        renderer.clear();

        // Pass 1 — resolve framing for every panel.
        const frames = panels.map(({ def, camera }) => {
            const rect = grid.rect(def.cell.row, def.cell.col, def.rowSpan, def.colSpan);
            const aabb = panelAABB(def.content);
            const fr = frameContent(aabb, def.camera, rect.aspect,
                { ...def.framing, margin: config.style.margin ?? def.framing.margin, tilt: config.style.tilt });
            return { def, camera, rect, fr };
        });

        // Shared world scale: panels with framing.fit==='shared' adopt a common
        // mm-per-pixel, so each brain is the SAME physical size across the figure
        // (as if one 3D scene). The view with the largest footprint fills its
        // cell; the rest render smaller, centred. Subcortical close-ups (fit
        // 'auto') keep their own zoom.
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
            // per-panel anatomy translucency (e.g. subcort views show voxels through anatomy)
            if (def.anatomyOpacity != null) { anatomyMat.opacity = def.anatomyOpacity; anatomyMat.transparent = def.anatomyOpacity < 1; }
            else { anatomyMat.opacity = config.style.anatomy.opacity; anatomyMat.transparent = anatomyMat.opacity < 1; }
            // Depth-veil range anchored to the ACTUAL nearest/farthest voxel
            // vertex, so the closest voxel is truly un-veiled (zf=0) and veiling
            // scales back from there. Falls back to content range if no voxels.
            const fwd = normalize(sub(fr.lookAt, fr.position));
            const dr = voxelDepthRange(def.content, fr.position, fwd);
            if (isFinite(dr.near)) {
                voxelUniforms.uNearZ.value = dr.near;
                voxelUniforms.uFarZ.value = Math.max(dr.far, dr.near + 1e-3);
            } else {
                voxelUniforms.uNearZ.value = fr.nearZ;
                voxelUniforms.uFarZ.value = fr.farZ;
            }
            // headlight along the camera axis; for shadows, offset it to one side
            // so voxel-on-voxel shadows are visible (depth cue).
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

            // Voxel edges first (underneath); then the black surface outline on top,
            // depth-clipped so voxels genuinely in front still show their edges.
            const edgesOn = config.style.voxel.edges.enabled;
            if (edgesOn) voxelEdge.update(camera, rect.x, rect.y, rect.w, rect.h);
            if (config.style.outline.enabled) {
                cortexOutline.outlineMaterial.uniforms.uClipApply.value = edgesOn ? 1.0 : 0.0;
                cortexOutline.update(camera, rect.x, rect.y, rect.w, rect.h);
            }
        }
    }

    function resize(w, h) {
        width = w; height = h;
        renderer.setSize(w, h);
        grid = layoutGrid({ width, height, ...config.layout.grid });
        cortexOutline.setSize(w, h);
        voxelEdge.setSize(w, h);
    }

    // Re-render at a different device-pixel-ratio (used by the GUI Save-PNG button
    // to supersample a high-res figure, then restore). Keeps the outline passes
    // in sync so their depth targets match the new resolution.
    function setPixelRatio(pr) {
        renderer.setPixelRatio(pr);
        renderer.setSize(width, height);
        cortexOutline.pr = pr; voxelEdge.pr = pr;
        cortexOutline.setSize(width, height);
        voxelEdge.setSize(width, height);
    }

    // Push the current config.style to live materials/uniforms/lights. The
    // per-frame parts (visibility, framing, outline on/off, anatomy opacity) are
    // read straight from config each frame; this handles the one-time uniforms.
    function applyStyle() {
        const s = config.style;
        dir.intensity = s.lighting.directional;
        amb.intensity = s.lighting.ambient;
        voxelUniforms.uGlintAmt.value = s.voxel.specular;
        voxelUniforms.uGlintPow.value = Math.max(1, s.voxel.shininess);
        voxelUniforms.uVeilStrength.value = s.voxel.veil.strength;
        voxelUniforms.uVeilK.value = s.voxel.veil.k;
        voxelUniforms.uEmissiveBoost.value = s.voxel.emissive;
        voxelUniforms.uThreshold.value = s.threshold ?? (overlay0?.threshold ?? 0);
        voxelUniforms.uPositiveOnly.value = s.positiveOnly ? 1 : 0;
        voxelUniforms.uClusterMin.value = s.voxel.clusterMin ?? 0;
        glassMat.uniforms.uMaxOpacity.value = s.glass.maxOpacity;
        cortexOutline.outlineMaterial.uniforms.uLineWidth.value = s.outline.width;
        cortexOutline.outlineMaterial.uniforms.uThreshold.value = s.outline.threshold;
        voxelEdge.outlineMaterial.uniforms.uOpacity.value = s.voxel.edges.opacity;
        voxelEdge.outlineMaterial.uniforms.uLineWidth.value = s.voxel.edges.width;
    }

    function setColormap(name) { config.style.colormap = name; recolor(); }

    function getPanelRects() {
        return panels.map(({ def }) => {
            const r = grid.rect(def.cell.row, def.cell.col, def.rowSpan, def.colSpan);
            return { id: def.id, title: def.title, cssLeft: r.cssLeft, cssTop: r.cssTop, w: r.w, h: r.h };
        });
    }

    return { scene, renderFrame, resize, setPixelRatio, getPanelRects, recolor, applyStyle, setColormap, config, renderer, THREE, sceneModel, _internals: { voxelUniforms, glassMat, anatomyMat, voxelMat, dir, amb } };
}
