/**
 * renderer.js — the multi-panel, multi-overlay engine. Browser side; contains NO
 * layout literals — everything comes from `config` + the pure core modules.
 *
 * Each loaded NIfTI (overlay) gets its OWN voxel material + uniforms + edge pass +
 * colour, resolved from `overlayStyle(config, i)` (per-overlay overrides on top of
 * the global voxel template). Cortex/anatomy/lighting/outline stay global.
 */
import * as THREE from 'three';
import { layoutGrid, freeRect } from '../core/grid.js';
import { frameContent, mergeAABB } from '../core/framing.js';
import { normalize, sub } from '../core/units.js';
import { cameraBasis } from '../core/cameras.js';
import { visible } from '../core/visibility.js';
import { resolveColormap, colorizeValues } from '../core/colormap.js';
import { overlayStyle } from '../core/config-schema.js';
import { makeGlassMaterial, makeAnatomyMaterial, makeOpaqueAnatomyMaterial, makeVoxelMaterial, makeSharedVoxelUniforms } from './materials.js';
import { OutlinePass, makeThresholdDepthMaterial, makePlainDepthMaterial } from './passes.js';

export function createEngine({ renderer, width, height, sceneModel, colormaps, config }) {
    const scene = new THREE.Scene();
    renderer.autoClear = false;
    // Clear alpha = canvas.bgAlpha (Free Canvas transparent background; default 1 = opaque,
    // so grid figures are unchanged). main.js can update this live via renderer.setClearColor.
    renderer.setClearColor(new THREE.Color(config.render.background ?? '#ffffff'), config.layout?.canvas?.bgAlpha ?? 1);

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
    // Opaque subcortical shell, selected per-panel when content.anatomyStyle === 'opaque'.
    const anatomyOpaqueMat = makeOpaqueAnatomyMaterial(config.style.anatomy);
    // Depth-only version of that shell (same BackSide), folded into the edge/outline clip so
    // cortical voxel edges + cortex lines BEHIND the opaque subcortex are occluded, not drawn through.
    const anatomyClipDepthMat = makePlainDepthMaterial(THREE.BackSide);
    const anatomyMeshes = sceneModel.meshes.filter((tm) => tm.meta.role === 'anatomy').map((tm) => tm.mesh);
    const cortexMeshes = sceneModel.meshes.filter((tm) => tm.meta.role === 'cortex').map((tm) => tm.mesh);

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
        const mat = makeVoxelMaterial({}, u);
        // Row order = display priority: where overlays coincide in depth, the
        // lower index (higher row) wins. A small per-overlay depth bias pushes
        // later overlays back so the top row draws on top, without disturbing
        // genuine front/back occlusion at clearly different depths.
        mat.polygonOffset = true; mat.polygonOffsetFactor = 0; mat.polygonOffsetUnits = i * 6;
        voxelMats.push(mat);
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
            const neg = !!overlays[i].negativeOnly;
            const { name, mode, divergingMapOnPositive, divergingMapOnNegative } = resolveColormap(os, div, colormaps, neg);
            const cmap = colormaps.get(name) || colormaps.values().next().value;
            if (!cmap) continue;
            const mAbs = overlays[i].maxAbsValue ?? 1.0;
            for (const tm of sceneModel.meshes) {
                if (tm.meta.role !== 'voxel' || (tm.meta.overlay ?? 0) !== i || !tm.values) continue;
                const lin = colorizeValues(tm.values, cmap, mAbs, mode, os.gamma, divergingMapOnPositive, divergingMapOnNegative);
                tm.mesh.geometry.attributes.color.copyArray(lin);
                tm.mesh.geometry.attributes.color.needsUpdate = true;
            }
        }
    }
    recolor();

    // --- optional extra smoothing of the marching-cubes ('smooth' variant) meshes ---
    // `iters` Laplacian passes that VISIBLY round the surface, then each connected blob is
    // rescaled about its own centroid back to its original mean radius — so it smooths
    // without shrinking or drifting (the trick the cortex inflation uses). Re-smooths from
    // cached originals each call (non-cumulative). Only 'smooth' meshes; blocky voxels are
    // never touched. aValue/aClusterSize (threshold + cluster) are per-vertex and unaffected.
    function meshTopo(geo) {
        if (geo.userData.gbTopo) return geo.userData.gbTopo;
        const idx = geo.index.array, n = geo.attributes.position.count;
        const adj = Array.from({ length: n }, () => []);
        const seen = Array.from({ length: n }, () => new Set());
        const link = (a, b) => { if (!seen[a].has(b)) { seen[a].add(b); adj[a].push(b); } };
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            link(a, b); link(a, c); link(b, a); link(b, c); link(c, a); link(c, b);
        }
        const orig = new Float32Array(geo.attributes.position.array);
        // connected components (disjoint blobs) + each one's original centroid + mean radius
        const comp = new Int32Array(n).fill(-1), comps = [];
        for (let s = 0; s < n; s++) {
            if (comp[s] !== -1) continue;
            const members = [], stack = [s]; comp[s] = comps.length;
            while (stack.length) { const v = stack.pop(); members.push(v); for (const w of adj[v]) if (comp[w] === -1) { comp[w] = comps.length; stack.push(w); } }
            comps.push(members);
        }
        const c0 = [], r0 = [];
        for (const m of comps) {
            let cx = 0, cy = 0, cz = 0;
            for (const v of m) { cx += orig[3 * v]; cy += orig[3 * v + 1]; cz += orig[3 * v + 2]; }
            cx /= m.length; cy /= m.length; cz /= m.length;
            let r = 0; for (const v of m) r += Math.hypot(orig[3 * v] - cx, orig[3 * v + 1] - cy, orig[3 * v + 2] - cz);
            c0.push([cx, cy, cz]); r0.push(r / m.length);
        }
        return (geo.userData.gbTopo = { adj, orig, comps, c0, r0 });
    }
    function smoothMesh(geo, iters, lambda = 0.55) {
        const T = meshTopo(geo), pos = geo.attributes.position.array;
        pos.set(T.orig);                                     // always re-smooth from the original
        if (iters > 0) {
            // A finely-triangulated marching-cubes blob is already fairly smooth, so each
            // Laplacian pass barely moves it (displacement grows ~sqrt(passes)). Drive MANY
            // passes per slider unit so the 0–20 slider gives a VISIBLE range of rounding
            // (~2–3 mm at the top); the per-component rescale below keeps the blob's size.
            const passes = iters * 10;
            const n = pos.length / 3, adj = T.adj, tmp = new Float32Array(pos.length);
            for (let it = 0; it < passes; it++) {
                for (let v = 0; v < n; v++) {
                    const ns = adj[v], k = ns.length;
                    if (!k) { tmp[3 * v] = pos[3 * v]; tmp[3 * v + 1] = pos[3 * v + 1]; tmp[3 * v + 2] = pos[3 * v + 2]; continue; }
                    let x = 0, y = 0, z = 0;
                    for (const w of ns) { x += pos[3 * w]; y += pos[3 * w + 1]; z += pos[3 * w + 2]; }
                    tmp[3 * v] = pos[3 * v] + lambda * (x / k - pos[3 * v]);
                    tmp[3 * v + 1] = pos[3 * v + 1] + lambda * (y / k - pos[3 * v + 1]);
                    tmp[3 * v + 2] = pos[3 * v + 2] + lambda * (z / k - pos[3 * v + 2]);
                }
                pos.set(tmp);
            }
            // restore each blob's original size about its centroid (undo the shrink)
            for (let ci = 0; ci < T.comps.length; ci++) {
                const m = T.comps[ci];
                let cx = 0, cy = 0, cz = 0;
                for (const v of m) { cx += pos[3 * v]; cy += pos[3 * v + 1]; cz += pos[3 * v + 2]; }
                cx /= m.length; cy /= m.length; cz /= m.length;
                let r1 = 0; for (const v of m) r1 += Math.hypot(pos[3 * v] - cx, pos[3 * v + 1] - cy, pos[3 * v + 2] - cz);
                r1 /= m.length;
                const s = r1 > 1e-6 ? T.r0[ci] / r1 : 1, o = T.c0[ci];
                for (const v of m) {
                    pos[3 * v] = (pos[3 * v] - cx) * s + o[0];
                    pos[3 * v + 1] = (pos[3 * v + 1] - cy) * s + o[1];
                    pos[3 * v + 2] = (pos[3 * v + 2] - cz) * s + o[2];
                }
            }
        }
        geo.attributes.position.needsUpdate = true;
        geo.computeVertexNormals();
    }
    /** (Re)apply each overlay's `voxel.smoothing` iteration count to its smooth meshes.
     *  Pass an overlay index to re-smooth just that one (cheap during a slider drag). */
    function applySmoothing(only = null) {
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'voxel' || tm.meta.variant !== 'smooth') continue;
            const oi = tm.meta.overlay ?? 0;
            if (only != null && oi !== only) continue;
            smoothMesh(tm.mesh.geometry, overlayStyle(config, oi).smoothing | 0);
        }
    }
    applySmoothing();   // honour any smoothing requested by the config (e.g. headless --smooth)

    // Last frame's resolved panel framing (def→{rect,fr}), for the Free Canvas editor's
    // screen↔world mapping (slice handles). Refreshed each renderFrame.
    let lastFrames = [];

    // --- panels: one ortho camera each, seeing all overlay layers ---
    const panels = config.layout.panels.map((p) => {
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
        for (let i = 0; i < N; i++) cam.layers.enable(1 + i);
        return { def: p, camera: cam, zoom: p.zoom || 1 };   // zoom: live per-panel rescale
    });

    // --- fixed DESIGN space + whole-canvas view transform --------------------
    // Panels are laid out in a fixed design space (W0×H0 = config.layout.canvas), then
    // mapped to the live viewport (VW×VH) by a 2D view transform {zoom s, design-point
    // (cx,cy) shown at the viewport centre}. So the brain's on-screen SIZE depends on s,
    // NOT the viewport — resizing the window/minimising the controls never rescales it;
    // the user zooms/pans instead. At s=1, centred, on a viewport == design size, the
    // screen rect == the design rect == the old layout, so headless/grid stay byte-identical.
    const _cv = config.layout?.canvas || {};
    const W0 = _cv.w || width, H0 = _cv.h || height;   // design size (CSS px)
    let VW = width, VH = height;                        // live viewport (CSS px)
    const view = { s: 1, cx: W0 / 2, cy: H0 / 2 };

    // --- grid + outline passes ---
    let grid = layoutGrid({ width: W0, height: H0, ...config.layout.grid });   // design-space grid
    const maxCellW = width, maxCellH = height;          // outline-pass targets track the VIEWPORT
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
    // Voxel edges clip against the SAME combined depth, so an overlay's edges are
    // occluded where a closer overlay's volume covers them (no longer see-through).
    for (const ep of edgePasses) ep.outlineMaterial.uniforms.uClipDepth.value = clipTarget.texture;

    function renderClipDepth(camera, opaqueAnat) {
        const prev = scene.overrideMaterial;
        renderer.setRenderTarget(clipTarget);
        renderer.setScissorTest(false);
        renderer.clear();                                   // clears colour (white→far) + depth
        for (let i = 0; i < N; i++) {
            clipCam.copy(camera); clipCam.layers.set(1 + i);
            scene.overrideMaterial = edgePasses[i].depthMaterial;
            renderer.render(scene, clipCam);                // depth-tested: nearest accumulates
        }
        // Fold the opaque subcortex's depth in (cortex hidden so only the shell contributes,
        // not the see-through cortex) → edges/outline behind it get occluded like the fills.
        if (opaqueAnat) {
            const vis = cortexMeshes.map((m) => m.visible);
            for (const m of cortexMeshes) m.visible = false;
            clipCam.copy(camera); clipCam.layers.set(0);
            scene.overrideMaterial = anatomyClipDepthMat;
            renderer.render(scene, clipCam);
            cortexMeshes.forEach((m, k) => { m.visible = vis[k]; });
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
        const ov = config.style.overlays || [];
        for (const tm of sceneModel.meshes) {
            let vis = meshVisible(content, tm.meta);
            // per-overlay show/hide: a hidden overlay's voxels never draw (any panel).
            if (vis && tm.meta.role === 'voxel' && ov[tm.meta.overlay ?? 0] && ov[tm.meta.overlay ?? 0].hidden) vis = false;
            tm.mesh.visible = vis;
        }
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

    // A panel's rect in DESIGN space (free-canvas `place` fractions OR a grid cell) — the
    // fixed layout, independent of the viewport. Both produce the same Rect shape.
    function panelDesignRect(def) {
        return def.place
            ? freeRect(def.place, W0, H0)
            : grid.rect(def.cell.row, def.cell.col, def.rowSpan, def.colSpan);
    }
    // Map a design rect to the live viewport via the view transform → the SCREEN rect the
    // panel actually renders into (CSS px). aspect is scale-invariant (unchanged by s).
    function viewRect(d) {
        const s = view.s;
        const cssLeft = VW / 2 + (d.cssLeft - view.cx) * s;
        const cssTop = VH / 2 + (d.cssTop - view.cy) * s;
        const w = d.w * s, h = d.h * s;
        return { x: cssLeft, y: VH - cssTop - h, w, h, cssLeft, cssTop, aspect: d.aspect };
    }
    function panelRect(def) { return viewRect(panelDesignRect(def)); }

    // Write one panel's slice spec into a material's slice uniforms (or reset to OFF).
    function writeSlice(u, slice) {
        if (!u || !u.uSliceType) return;
        if (!slice || !slice.shape) { u.uSliceType.value = 0; return; }
        u.uSliceType.value = slice.shape === 'plane' ? 1 : slice.shape === 'sphere' ? 2 : 3;
        u.uSliceMode.value = slice.mode === 'bite' ? 1 : 0;
        if (slice.normal) u.uSliceNormal.value.set(slice.normal[0], slice.normal[1], slice.normal[2]);
        if (slice.offset != null) u.uSliceOffset.value = slice.offset;
        if (slice.center) u.uSliceCenter.value.set(slice.center[0], slice.center[1], slice.center[2]);
        if (slice.radius != null) u.uSliceRadius.value = slice.radius;
        if (slice.min) u.uSliceMin.value.set(slice.min[0], slice.min[1], slice.min[2]);
        if (slice.max) u.uSliceMax.value.set(slice.max[0], slice.max[1], slice.max[2]);
    }
    // Apply (or clear) a panel's slice across EVERY material so the whole brain cuts
    // together and the edge/outline passes follow. RESET (slice=null) on unsliced
    // panels is essential — materials are shared, so a stale slice would bleed across.
    function applyPanelSlice(slice) {
        writeSlice(glassMat.uniforms, slice);
        writeSlice(anatomyMat.uniforms, slice);
        writeSlice(anatomyOpaqueMat.uniforms, slice);
        writeSlice(anatomyClipDepthMat.uniforms, slice);
        for (let i = 0; i < N; i++) writeSlice(uniforms[i], slice);   // voxel + its edge depth material
        writeSlice(cortexOutline.depthMaterial.uniforms, slice);      // cortex silhouette
    }

    function renderFrame() {
        // Full-buffer clear (a prior frame's outline pass leaves the scissor test on,
        // which would restrict clear() to one panel and ghost old frames otherwise).
        renderer.setScissorTest(false);
        renderer.clear();
        refreshResolved();

        // Pass 1 — framing per panel.
        const frames = panels.map((panel, idx) => {
            const { def, camera } = panel;
            const rect = panelRect(def);
            const aabb = panelAABB(def.content);
            // Grid panels use the global (snug) margin; free-canvas panels use their own
            // roomier margin (default 1.1) so the volume + its outline stroke aren't
            // clipped by the frame — a rotated/standalone panel has no neighbour to hide a
            // slight overflow behind.
            const margin = def.place
                ? (def.framing && def.framing.margin != null ? def.framing.margin : 1.1)
                : (config.style.margin ?? def.framing.margin);
            const fr = frameContent(aabb, def.camera, rect.aspect,
                { ...def.framing, margin, tilt: config.style.tilt, rotate: def.rotate });
            // Paint order: explicit place.z, else the array index (so grid panels keep
            // their natural order and free panels overdraw lower-z neighbours).
            const z = (def.place && def.place.z != null) ? def.place.z : idx;
            return { panel, def, camera, rect, fr, z };
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

        // Per-panel manual zoom (the hover +/- controls): shrink the extent to
        // zoom in. Applied after the shared scale so it's a manual override.
        for (const { panel, rect, fr } of frames) {
            const z = panel.zoom || 1;
            if (z === 1) continue;
            const ext = fr.ext / z;
            fr.ext = ext;
            fr.left = -ext * rect.aspect; fr.right = ext * rect.aspect;
            fr.top = ext; fr.bottom = -ext;
        }

        lastFrames = frames;   // expose this frame's framing for the editor (slice handles)

        // Paint back-to-front by z so higher-z (free-canvas) panels overdraw lower
        // ones where they overlap. Stable sort keeps equal-z panels in array order;
        // grid panels (z = index) are therefore unaffected.
        frames.sort((a, b) => a.z - b.z);

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
            applyPanelSlice(def.slice);     // per-panel cut (resets to OFF when absent)
            if (def.anatomyOpacity != null) { anatomyMat.opacity = def.anatomyOpacity; anatomyMat.transparent = def.anatomyOpacity < 1; }
            else { anatomyMat.opacity = config.style.anatomy.opacity; anatomyMat.transparent = anatomyMat.opacity < 1; }
            // Per-panel subcortical style: opaque shell (occludes cortex lines + overlays
            // behind it; its own voxels still show) vs the default glass. Reset EVERY panel
            // (anatomy meshes are shared) so an opaque panel doesn't bleed into the next.
            const opaqueAnat = def.content && def.content.anatomyStyle === 'opaque';
            for (const m of anatomyMeshes) m.material = opaqueAnat ? anatomyOpaqueMat : anatomyMat;

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

            // Combined nearest-overlay depth, built ONCE per panel BEFORE the edge passes,
            // then used to occlude BOTH the per-overlay voxel edges and the cortex outline
            // where a closer overlay volume sits in front (edges no longer draw through).
            let anyEdges = false;
            for (let i = 0; i < N; i++) if (osR[i].edges.enabled) anyEdges = true;
            // Clip when there are voxel edges OR an opaque subcortex (so edges + cortex lines
            // behind the shell are occluded). Opaque-anatomy folds its depth into the target.
            const clip = anyEdges || opaqueAnat;
            if (clip) renderClipDepth(camera, opaqueAnat);
            // Per-overlay voxel edges first (underneath), depth-clipped against the others.
            for (let i = 0; i < N; i++) {
                if (!osR[i].edges.enabled) continue;
                edgePasses[i].outlineMaterial.uniforms.uClipApply.value = clip ? 1.0 : 0.0;
                edgePasses[i].update(camera, rect.x, rect.y, rect.w, rect.h);
            }
            // Black cortex outline on top — clipped so any voxel genuinely in front shows.
            if (config.style.outline.enabled) {
                cortexOutline.outlineMaterial.uniforms.uClipApply.value = clip ? 1.0 : 0.0;
                cortexOutline.update(camera, rect.x, rect.y, rect.w, rect.h);
            }
        }
    }

    function resize(w, h) {
        width = w; height = h; VW = w; VH = h;
        renderer.setSize(w, h, false);   // updateStyle=false: let CSS control display size
        // grid is DESIGN-space (built once against W0×H0) — NOT rebuilt on viewport resize,
        // so the brains keep a fixed size; only the view transform's screen mapping changes.
        cortexOutline.setSize(w, h);
        for (const ep of edgePasses) ep.setSize(w, h);
        clipTarget.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
    }

    function setPixelRatio(pr) {
        renderer.setPixelRatio(pr);
        renderer.setSize(width, height, false);
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
            const r = panelRect(def);   // SCREEN rect (post view-transform) — DOM overlays align with what's drawn
            return { id: def.id, title: def.title, cssLeft: r.cssLeft, cssTop: r.cssTop, w: r.w, h: r.h };
        });
    }
    // World-space AABB of a panel's visible meshes (for the tight-crop bbox).
    function getPanelContentAABB(def) { return panelAABB(def.content); }
    // Design-space rects (pre view-transform), for baking grid→free `place` fractions.
    function getPanelDesignRects() {
        return panels.map(({ def }) => {
            const r = panelDesignRect(def);
            return { id: def.id, title: def.title, cssLeft: r.cssLeft, cssTop: r.cssTop, w: r.w, h: r.h };
        });
    }

    // --- whole-canvas view transform (2D pan + zoom; brain size = design size × s) ---
    function setView(v) {
        if (v.s != null) view.s = Math.max(0.1, Math.min(8, v.s));
        if (v.cx != null) view.cx = v.cx;
        if (v.cy != null) view.cy = v.cy;
    }
    function getView() { return { s: view.s, cx: view.cx, cy: view.cy, W0, H0, VW, VH }; }
    function panView(dxScreen, dyScreen) { view.cx -= dxScreen / view.s; view.cy -= dyScreen / view.s; }
    function zoomViewAt(factor, sx, sy) {   // zoom toward the cursor (keep its design point fixed)
        const s0 = view.s, s1 = Math.max(0.1, Math.min(8, s0 * factor));
        const dX = view.cx + (sx - VW / 2) / s0, dY = view.cy + (sy - VH / 2) / s0;
        view.s = s1; view.cx = dX - (sx - VW / 2) / s1; view.cy = dY - (sy - VH / 2) / s1;
    }
    function resetView() { view.s = 1; view.cx = W0 / 2; view.cy = H0 / 2; }
    function fitView() {   // scale the design composition to fit the viewport, centred
        const s = Math.min(VW / W0, VH / H0);
        view.s = (s > 0 && isFinite(s)) ? s : 1; view.cx = W0 / 2; view.cy = H0 / 2;
    }

    // Screen↔world mapping for one panel (its last rendered framing), for the Free
    // Canvas slice handles: orthonormal image basis {r,u,f}, the framed centre, the
    // panel's CSS rect, and mm-per-pixel (uniform — square pixels). null if not drawn yet.
    function getPanelView(def) {
        const fo = lastFrames.find((x) => x.def === def);
        if (!fo) return null;
        const { rect, fr } = fo;
        const { r, u, f } = cameraBasis({ position: fr.position, up: fr.up, lookAt: fr.lookAt });
        return {
            rect: { cssLeft: rect.cssLeft, cssTop: rect.cssTop, w: rect.w, h: rect.h },
            center: fr.lookAt.slice(), r, u, f, mmPerPx: fr.ext / (rect.h / 2),
        };
    }

    // Multiply panel `i`'s zoom (the hover +/- controls), clamped to a sane range.
    function zoomPanel(i, factor) {
        const p = panels[i]; if (!p) return;
        p.zoom = Math.min(8, Math.max(0.25, (p.zoom || 1) * factor));
        if (p.def) p.def.zoom = p.zoom;   // M3: persist into the config panel so it round-trips through buildSpec
    }

    // Scale every outline pass's line width by `f`. Outline width is in device
    // texels, so a higher pixel ratio (Save-PNG supersampling) thins the lines;
    // the Save path multiplies by savePr/basePr here to keep the on-screen look.
    function scaleOutlines(f) {
        cortexOutline.outlineMaterial.uniforms.uLineWidth.value *= f;
        for (const ep of edgePasses) ep.outlineMaterial.uniforms.uLineWidth.value *= f;
    }

    // Free this engine's GPU resources so it can be rebuilt in-place when the
    // overlay set changes (the static app adds/removes overlays without a reload).
    // Mesh geometries are NOT disposed — they're owned by the app and reused across
    // rebuilds; only this engine's materials, outline passes, and targets are freed.
    function dispose() {
        glassMat.dispose(); anatomyMat.dispose(); anatomyOpaqueMat.dispose(); anatomyClipDepthMat.dispose();
        for (const m of voxelMats) m.dispose();
        cortexOutline.dispose();
        for (const ep of edgePasses) ep.dispose();
        clipTarget.dispose();
        scene.clear();
    }

    return {
        scene, renderFrame, resize, setPixelRatio, getPanelRects, getPanelDesignRects, getPanelContentAABB, getPanelView, zoomPanel, scaleOutlines, recolor, applyStyle, applySmoothing, setColormap, dispose,
        setView, getView, panView, zoomViewAt, resetView, fitView,
        overlays, config, renderer, THREE, sceneModel,
        _internals: { uniforms, glassMat, anatomyMat, voxelMats, dir, amb },
    };
}
