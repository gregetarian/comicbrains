/**
 * renderer.js — the multi-panel, multi-overlay engine. Browser side; contains NO
 * layout literals — everything comes from `config` + the pure core modules.
 *
 * Each loaded NIfTI (overlay) gets its OWN voxel material + uniforms + edge pass +
 * colour, resolved from `overlayStyle(config, i)` (per-overlay overrides on top of
 * the global voxel template). Cortex/anatomy/lighting/outline stay global.
 */
import * as THREE from 'three';
import { layoutGrid, freeRect } from '../core/grid.js?v=depth-auto-v3';
import { frameContent, mergeAABB, viewDepthRange, viewDepthRangeOfPositions } from '../core/framing.js?v=depth-auto-v3';
import { normalize, sub } from '../core/units.js?v=depth-auto-v3';
import { cameraBasis } from '../core/cameras.js?v=depth-auto-v3';
import { visible } from '../core/visibility.js?v=depth-auto-v3';
import { resolveColormap, colorizeValues, deriveMaxAbs } from '../core/colormap.js?v=depth-auto-v3';
import { overlayStyle } from '../core/config-schema.js?v=depth-auto-v3';
import { outlinePlan } from '../core/outline-plan.js?v=depth-auto-v3';
import { meshLayer, anatomyLayer } from '../core/mesh-meta.js?v=depth-auto-v3';
import { createAnatomyCap } from './anatomy-cap.js?v=depth-auto-v3';
import { makeGlassMaterial, makeAnatomyMaterial, makeOpaqueAnatomyMaterial, makeVoxelMaterial, makeSurfaceMaterial, makeSharedVoxelUniforms } from './materials.js?v=depth-auto-v3';
import { makeBorderMaterial, makeBorderGeometry, applyLabels } from './parcellation.js?v=depth-auto-v3';
import { OutlinePass, makeThresholdDepthMaterial, makePlainDepthMaterial, makeHardOccluderDepthMaterial, DEPTH_CLEAR } from './passes.js?v=depth-auto-v3';

const _clearScratch = new THREE.Color();   // save/restore around a depth-target clear
const _colScratch = new THREE.Color();     // hex → linear RGB for the live line-colour uniforms
const _lightScratch = new THREE.Vector3(); // world light direction → current panel view space

/** Blob translucency. Below 1 the voxels stop writing depth — otherwise a nearer blob still hides
 *  a farther one and the alpha only tints the background, which is not what "see through it" means.
 *  The cost is order-dependent overlap between translucent blobs; the depth veil stays as the
 *  order-independent depth cue. `transparent` changes the shader program, hence needsUpdate. */
function applyVoxelAlpha(mat, alpha) {
    const t = alpha < 1;
    if (mat.transparent !== t) { mat.transparent = t; mat.needsUpdate = true; }
    mat.opacity = alpha;
    mat.depthWrite = !t;
}

/** Push a CSS hex colour into an OutlinePass's uColor (a vec3, not a THREE.Color). */
function setPassColor(pass, hex) {
    _colScratch.set(hex);
    pass.outlineMaterial.uniforms.uColor.value.set(_colScratch.r, _colScratch.g, _colScratch.b);
}

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
    let spinFit = false;   // true only while actively spinning (orbit / GIF / shift-drag) → constant-size sphere fit

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
    // Cortex-alpha occlusion needs the surface the viewer actually faces. Keep a dedicated
    // FrontSide depth material; the ordinary cortex outline intentionally uses DoubleSide.
    const cortexFrontDepthMat = makePlainDepthMaterial(THREE.FrontSide);
    const anatomyMat = makeAnatomyMaterial(config.style.anatomy);
    // Opaque subcortical shell, selected per-panel when content.anatomyStyle === 'opaque'.
    const anatomyOpaqueMat = makeOpaqueAnatomyMaterial(config.style.anatomy);
    // Depth-only version of that shell (same BackSide), folded into the edge/outline clip so
    // cortical voxel edges + cortex lines BEHIND the opaque subcortex are occluded, not drawn through.
    const anatomyClipDepthMat = makeHardOccluderDepthMaterial(THREE.FrontSide);
    const anatomyMeshes = sceneModel.meshes.filter((tm) => tm.meta.role === 'anatomy').map((tm) => tm.mesh);
    const cortexMeshes = sceneModel.meshes.filter((tm) => tm.meta.role === 'cortex').map((tm) => tm.mesh);
    const surfaceVariants = [...new Set(sceneModel.meshes
        .filter((tm) => tm.meta.role === 'cortex' && tm.meta.variant)
        .map((tm) => tm.meta.variant))];
    // Subcortex gets its OWN layer (past the N overlay layers) so it can carry a SEPARATE outline
    // pass: the cortex stays the sole occupant of layer 0's pass (its line-art unchanged), while the
    // subcortical structures are stroked on their own layer at anatomyWidthMul × the cortex width
    // (1.0 = uniform; <1 thins the densely-packed structures that merge under the depth-edge filter).
    const ANATOMY_LAYER = anatomyLayer(N);
    // The scissor cut-cap (T1 cross-section on a sliced face) lives on its OWN layer, past the
    // subcortex layer, so the main camera draws it but the outline/edge depth passes never do.
    const CAP_LAYER = N + 2;
    const CUT_OVERLAY_LAYER = N + 3;
    // Parcel borders are ordinary depth-tested geometry (not a screen-space pass), so they need a
    // layer the panel cameras draw but no outline/edge depth pass ever renders.
    const PARC_LAYER = N + 4;
    let anatomyCap = null;   // set by setAnatomyVolume() once the volume asset is loaded
    const cutVolumes = sceneModel.cutVolumes || [];

    // --- per-overlay voxel materials + uniforms (overlay i → layer 1+i) ---
    const uniforms = [], voxelMats = [], surfaceMats = [];
    for (let i = 0; i < N; i++) {
        const os = overlayStyle(config, i);
        const u = makeSharedVoxelUniforms({
            positiveOnly: os.positiveOnly,
            voxel: { veil: os.veil, depthCut: os.depthCut, emissive: os.emissive, specular: os.specular, shininess: os.shininess, clusterMin: os.clusterMin },
        });
        u.uMaxAbs.value = deriveMaxAbs(os.clim, overlays[i].maxAbsValue ?? 1.0);   // clim pins the scale
        u.uThreshold.value = os.threshold ?? overlays[i].threshold ?? 0;
        u.uBaseApply.value = os.surfaceBase ? 1 : 0;
        if (os.surfaceBase) u.uBaseColor.value.set(os.surfaceBase);
        uniforms.push(u);
        const mat = makeVoxelMaterial({}, u);
        // Row order = display priority: where overlays coincide in depth, the
        // lower index (higher row) wins. A small per-overlay depth bias pushes
        // later overlays back so the top row draws on top, without disturbing
        // genuine front/back occlusion at clearly different depths.
        mat.polygonOffset = true; mat.polygonOffsetFactor = 0; mat.polygonOffsetUnits = i * 6;
        applyVoxelAlpha(mat, os.opacity ?? 1);
        voxelMats.push(mat);
        surfaceMats.push(makeSurfaceMaterial({}, u));   // variant:'surface' meshes (M8) share the uniforms
    }

    function resolvedCutOverlaySpecs() {
        return overlays.map((meta, i) => {
            const os = overlayStyle(config, i);
            const resolved = resolveColormap(os, !!meta.diverging, colormaps, !!meta.negativeOnly);
            return {
                cut: os.cutOverlay,
                threshold: os.threshold ?? meta.threshold ?? 0,
                clusterMin: os.clusterMin ?? 0,
                positiveOnly: os.positiveOnly,
                gamma: os.gamma,
                clim: os.clim,
                maxAbs: deriveMaxAbs(os.clim, meta.maxAbsValue ?? 1),
                mode: resolved.mode,
                divergingMapOnPositive: resolved.divergingMapOnPositive,
                divergingMapOnNegative: resolved.divergingMapOnNegative,
                cmap: colormaps.get(resolved.name) || colormaps.values().next().value,
                emissive: os.emissive,
                hidden: !!config.style.overlays?.[i]?.hidden,
            };
        });
    }

    // --- place meshes, assign materials + layers + shadows ---
    // Layer + renderOrder come from the shared scheme (core/mesh-meta): cortex→0,
    // overlay i→1+i, subcortex shell→N+1; only the THREE material/shadow wiring stays here.
    for (const tm of sceneModel.meshes) {
        const m = tm.mesh;
        const { layer, renderOrder } = meshLayer(tm.meta, N);
        m.renderOrder = renderOrder;
        m.layers.set(layer);
        if (tm.meta.role === 'cortex') { m.material = glassMat; }
        else if (tm.meta.role === 'anatomy') { m.material = anatomyMat; m.receiveShadow = SH.enabled; }
        else {
            const oi = tm.meta.overlay ?? 0;
            const surf = tm.meta.variant === 'surface';
            m.material = (surf ? surfaceMats[oi] : voxelMats[oi]) || voxelMats[0];
            m.castShadow = SH.enabled; m.receiveShadow = SH.enabled;
        }
        scene.add(m);
    }

    // --- parcellation borders -------------------------------------------------------------
    // One border mesh per cortex mesh, sharing that mesh's position/index buffers (so the whole
    // layer costs one Float32Array of distances per hemisphere, not a second copy of the
    // surface). Each is created up front and stays in the scene; changing atlas only rewrites
    // the aDist attribute, so it never needs an engine rebuild.
    // --- surface sheets follow the DISPLAYED cortex surface ---------------------------------
    // pipeline._stage_surface stages the sheet on PIAL vertices, but the shell shown is whatever
    // cortexSurface/content.surface selects (inflated by default). They differ by up to ~3.4 mm, so
    // the fill sat on a different surface from the shell it was meant to lie on: fold lines landed
    // off the folds, and the sheet poked through the shell in places. Every cortex variant is
    // fsaverage ico7 with the SAME vertex order and the SAME index buffer, so the sheet can simply
    // borrow the displayed variant's position/normal attributes — no resampling, no extra geometry,
    // and both buffers are already on the GPU.
    const cortexGeo = {};        // variant -> hemi -> BufferGeometry
    for (const tm of sceneModel.meshes)
        if (tm.meta.role === 'cortex' && tm.meta.variant)
            (cortexGeo[tm.meta.variant] ||= {})[tm.meta.hemisphere] = tm.mesh.geometry;
    const surfaceSheets = sceneModel.meshes.filter(
        (tm) => tm.meta.role === 'voxel' && tm.meta.variant === 'surface');

    function alignSurfaceSheets(content) {
        if (!surfaceSheets.length) return;
        const variant = (content && content.surface) || config.style.cortexSurface || 'pial';
        const byHemi = cortexGeo[variant];
        if (!byHemi) return;                     // 'hidden', or a template without that variant
        for (const tm of surfaceSheets) {
            const src = byHemi[tm.meta.hemisphere];
            if (!src || src.attributes.position.count !== tm.mesh.geometry.attributes.position.count) continue;
            const g = tm.mesh.geometry;
            if (g.attributes.position === src.attributes.position) continue;
            g.setAttribute('position', src.attributes.position);
            if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal);
        }
    }

    // Borders attach to the cortex shells only. Now that a sheet shares the shell's positions the
    // two coincide exactly, so one border per shell is enough.
    const borderMat = makeBorderMaterial(config.style.parcellation || {});
    const borderSources = sceneModel.meshes.filter((tm) => tm.meta.role === 'cortex');
    const borderMeshes = borderSources.map((tm) => {
        const geo = makeBorderGeometry(tm.mesh.geometry);
        const mesh = new THREE.Mesh(geo, borderMat);
        mesh.renderOrder = 3;                // after the glass cortex (1), before the voxels (15)
        mesh.layers.set(PARC_LAYER);
        mesh.visible = false;
        scene.add(mesh);
        return { mesh, geo, src: tm };       // src.mesh.visible drives this one's visibility
    });
    let parcLoaded = null;                   // name of the atlas currently written into aDist
    let parcAtlas = null;                    // its {lh, rh} label arrays, kept so `smooth` can re-derive

    /** Push the medial-wall mask uniforms. Called from setParcellation as well as applyStyle,
     *  because the headless path never calls applyStyle — it renders straight after loading the
     *  atlas, so a mask wired only into applyStyle silently did nothing in every CLI render. */
    function pushMaskUniforms() {
        const parc = config.style.parcellation || {};
        const on = (parcLoaded && parc.maskMedialWall) ? 1 : 0;
        for (let i = 0; i < N; i++) {
            uniforms[i].uMaskApply.value = on;
            uniforms[i].uMaskColor.value.set(parc.maskColor ?? overlayStyle(config, i).surfaceBase ?? '#dcdcdc');
        }
    }

    /** Write an atlas's labels into every border geometry. `atlas` is {lh, rh} Int16Arrays.
     *  Pass null to detach. Cheap enough to call on every `smooth` change (~a few hundred ms for
     *  both hemispheres × the surface variants in the scene). */
    function setParcellation(name, atlas) {
        parcLoaded = atlas ? name : null;
        parcAtlas = atlas || null;
        pushMaskUniforms();
        if (!atlas) return;
        // Write the cortex mask onto every surface sheet (same fsaverage vertex order).
        for (const tm of surfaceSheets) {
            const labels = atlas[tm.meta.hemisphere];
            const a = tm.mesh.geometry.attributes.aMask;
            if (!labels || !a || labels.length !== a.count) continue;
            for (let i = 0; i < labels.length; i++) a.array[i] = labels[i] >= 0 ? 1 : 0;
            a.needsUpdate = true;
        }
        for (const b of borderMeshes) {
            const labels = atlas[b.src.meta.hemisphere];
            if (!labels) continue;           // a template with no lh/rh split has no atlas to draw
            applyLabels(b.geo, b.src.mesh.geometry, labels, {
                medialWall: config.style.parcellation?.medialWall !== false,
            });
        }
    }

    // Downsampled WORLD vertices for view-relative depth cues. Statistical samples
    // anchor the colour veil to real voxels. Cortex/anatomy samples anchor the hard depth gate to
    // real anatomical surfaces, so every panel (including a rotated Free Canvas panel) derives its
    // own near/far range along its current camera direction rather than from empty AABB corners.
    scene.updateMatrixWorld(true);
    {
        const v = new THREE.Vector3();
        const sampleWorld = (tm, target, preserveAxisExtrema = false) => {
            const pos = tm.mesh.geometry.attributes.position;
            const n = pos ? pos.count : 0;
            if (!n) return new Float32Array();
            const step = Math.max(1, Math.ceil(n / target));
            const pts = [];
            if (!preserveAxisExtrema) {
                // Statistical meshes can be very large and already only need an approximate veil
                // range. Keep their old strided cost rather than scanning every hidden variant.
                for (let i = 0; i < n; i += step) {
                    v.fromBufferAttribute(pos, i).applyMatrix4(tm.mesh.matrixWorld);
                    pts.push(v.x, v.y, v.z);
                }
                return new Float32Array(pts);
            }
            const extrema = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
            const extremeIdx = new Int32Array(6).fill(-1);
            for (let i = 0; i < n; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(tm.mesh.matrixWorld);
                if (i % step === 0) pts.push(v.x, v.y, v.z);
                if (v.x < extrema[0]) { extrema[0] = v.x; extremeIdx[0] = i; }
                if (v.x > extrema[1]) { extrema[1] = v.x; extremeIdx[1] = i; }
                if (v.y < extrema[2]) { extrema[2] = v.y; extremeIdx[2] = i; }
                if (v.y > extrema[3]) { extrema[3] = v.y; extremeIdx[3] = i; }
                if (v.z < extrema[4]) { extrema[4] = v.z; extremeIdx[4] = i; }
                if (v.z > extrema[5]) { extrema[5] = v.z; extremeIdx[5] = i; }
            }
            for (const i of new Set(extremeIdx)) {
                if (i < 0) continue;
                v.fromBufferAttribute(pos, i).applyMatrix4(tm.mesh.matrixWorld);
                pts.push(v.x, v.y, v.z);
            }
            return new Float32Array(pts);
        };
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role === 'voxel') tm.depthSamples = sampleWorld(tm, 300);
            else if (tm.meta.role === 'cortex') tm.anatomyDepthSamples = sampleWorld(tm, 4096, true);
            else if (tm.meta.role === 'anatomy') tm.anatomyDepthSamples = sampleWorld(tm, 512, true);
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
            const mAbs = deriveMaxAbs(os.clim, overlays[i].maxAbsValue ?? 1.0);   // clim pins the scale
            if (uniforms[i]) uniforms[i].uMaxAbs.value = mAbs;                    // keep the uniform in sync (live clim)
            const climRange = Array.isArray(os.clim) ? os.clim : null;           // explicit [vmin,vmax] → linear map
            for (const tm of sceneModel.meshes) {
                if (tm.meta.role !== 'voxel' || (tm.meta.overlay ?? 0) !== i || !tm.values) continue;
                const lin = colorizeValues(tm.values, cmap, mAbs, mode, os.gamma, divergingMapOnPositive, divergingMapOnNegative, climRange);
                tm.mesh.geometry.attributes.color.copyArray(lin);
                tm.mesh.geometry.attributes.color.needsUpdate = true;
            }
        }
        pushMaskUniforms();
        if (anatomyCap) anatomyCap.setOverlayStyles(resolvedCutOverlaySpecs());
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
        cam.layers.enable(ANATOMY_LAYER);                    // draw the subcortex shell (own layer)
        cam.layers.enable(CAP_LAYER);                        // draw the anatomy cut-cap (own layer)
        cam.layers.enable(CUT_OVERLAY_LAYER);                // thresholded maps composited on that cap
        cam.layers.enable(PARC_LAYER);                       // parcellation boundary lines
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
    let outlineSaveScale = 1;   // Save-PNG supersampling factor for the cortex outline width (see scaleOutlines)
    const maxCellW = width, maxCellH = height;          // outline-pass targets track the VIEWPORT
    const cortexOutline = new OutlinePass(renderer, scene, maxCellW, maxCellH, {
        layer: 0, color: config.style.outline.color, width: config.style.outline.width, threshold: config.style.outline.threshold,
    });
    // Subcortex outline — its OWN pass on ANATOMY_LAYER so its width is independent of the cortex
    // line (anatomyWidthMul, default 1.0 = uniform) without disturbing the cortex silhouette/sulci.
    // It is given an EXPLICIT depth material (rather than the constructor's private one) so
    // applyPanelSlice can reach it: without that the subcortex outline was computed from uncut
    // geometry and kept stroking structures the Free Canvas cut had already removed.
    const anatomyDepthMat = makePlainDepthMaterial(THREE.DoubleSide);
    const anatomyOutline = new OutlinePass(renderer, scene, maxCellW, maxCellH, {
        layer: ANATOMY_LAYER, color: config.style.outline.anatomyColor ?? config.style.outline.color,
        width: config.style.outline.width, threshold: config.style.outline.threshold,
        depthMaterial: anatomyDepthMat,
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
    // Kept separate from clipTarget because cluster-only automation must not inherit
    // cortex/anatomy depth that the ordinary line compositor folds into clipTarget.
    let voxelOnlyDepthTarget = makeDepthTarget(maxCellW, maxCellH);
    let cortexFrontDepthTarget = makeDepthTarget(maxCellW, maxCellH);
    const clipCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
    glassMat.uniforms.uFrontDepth.value = cortexFrontDepthTarget.texture;
    glassMat.uniforms.uFrontDepthApply.value = 1.0;
    cortexOutline.outlineMaterial.uniforms.uClipDepth.value = clipTarget.texture;
    // Subcortical lines clip against the cortex depth field. This preserves their independent
    // anatomical outline while letting whichever surface is nearer to the camera occlude the other.
    anatomyOutline.outlineMaterial.uniforms.uClipDepth.value = cortexOutline.depthTarget.texture;
    // Voxel edges clip against the SAME combined depth, so an overlay's edges are
    // occluded where a closer overlay's volume covers them (no longer see-through).
    for (const ep of edgePasses) ep.outlineMaterial.uniforms.uClipDepth.value = clipTarget.texture;

    function renderCortexFrontDepth(camera) {
        const prev = scene.overrideMaterial;
        renderer.setRenderTarget(cortexFrontDepthTarget);
        renderer.setScissorTest(false);
        const prevClear = renderer.getClearColor(_clearScratch), prevAlpha = renderer.getClearAlpha();
        renderer.setClearColor(DEPTH_CLEAR, 1);
        renderer.clear();
        clipCam.copy(camera); clipCam.layers.set(0);
        scene.overrideMaterial = cortexFrontDepthMat;
        renderer.render(scene, clipCam);
        scene.overrideMaterial = prev;
        renderer.setClearColor(prevClear, prevAlpha);
        renderer.setRenderTarget(null);
    }

    function renderClipDepth(camera, target, anatomyOccluder, includeVoxels, capActive, cortexOccluder = false) {
        const prev = scene.overrideMaterial;
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        // Fixed far/no-coverage sentinel — see passes.js. Clearing to the FIGURE background instead
        // (as this used to) meant a dark `render.background` read as depth 0, i.e. nearer than every
        // surface, so the clip test treated empty space as an occluder and dimmed the whole outline.
        const prevClear = renderer.getClearColor(_clearScratch), prevAlpha = renderer.getClearAlpha();
        renderer.setClearColor(DEPTH_CLEAR, 1);
        renderer.clear();                                   // clears colour (far/empty) + depth
        // Fold the nearest VOXEL depth in ONLY when voxel edges are shown — that clip exists so an
        // edge (and the cortex line over it) yields to a voxel genuinely in front. With smooth fills
        // (no edges) the cortex line-art should stay complete, so we DON'T let the volumes erase it.
        if (includeVoxels) {
            for (let i = 0; i < N; i++) {
                clipCam.copy(camera); clipCam.layers.set(1 + i);
                scene.overrideMaterial = edgePasses[i].depthMaterial;
                renderer.render(scene, clipCam);            // depth-tested: nearest accumulates
            }
        }
        if (cortexOccluder) {
            clipCam.copy(camera); clipCam.layers.set(0);
            scene.overrideMaterial = cortexFrontDepthMat;
            renderer.render(scene, clipCam);
        }
        // Fold the opaque subcortex's depth in → edges/outline behind it get occluded like the
        // fills. The subcortex is on its own layer, so we render just it (no cortex to hide).
        if (anatomyOccluder) {
            clipCam.copy(camera); clipCam.layers.set(ANATOMY_LAYER);
            scene.overrideMaterial = anatomyClipDepthMat;
            renderer.render(scene, clipCam);
        }
        // The cap's mask-aware depth material writes NEGATIVE view depth. That lets the outline
        // shader distinguish an opaque MRI face (line must disappear completely) from an ordinary
        // voxel (which may retain outline.overVoxelOpacity).
        if (capActive && anatomyCap) {
            clipCam.copy(camera); clipCam.layers.set(CAP_LAYER);
            scene.overrideMaterial = anatomyCap.depthMaterial;
            renderer.render(scene, clipCam);
        }
        scene.overrideMaterial = prev;
        renderer.setClearColor(prevClear, prevAlpha);
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
            return { cortexSurface: config.style.cortexSurface, voxel: {
                representation: os ? os.representation : config.style.voxel.representation,
                subcortexRepresentation: os ? os.subcortexRepresentation
                    : config.style.voxel.subcortexRepresentation,
            } };
        }
        return globalVis();
    }
    const meshVisible = (content, meta) => visible(content, meta, visStyleFor(meta));

    function panelAABB(content) {
        const boxes = [];
        for (const tm of sceneModel.meshes) if (meshVisible(content, tm.meta)) boxes.push(tm.aabb);
        return mergeAABB(boxes);
    }
    // The hard depth gate is relative to the visible anatomical shell, measured along THIS
    // panel's current camera direction. Thus a dorsal panel treats SMA as superficial and thalamus
    // as deep; rotating only that panel rotates the depth slab with it. Real sampled vertices avoid
    // an oblique AABB's empty-corner bias. Volume-only panels fall back to the panel range below.
    function anatomicalDepthRange(content, position, lookAt) {
        let nearZ = Infinity, farZ = -Infinity;
        const boxes = [];
        for (const tm of sceneModel.meshes) {
            if (tm.meta.role !== 'cortex' && tm.meta.role !== 'anatomy') continue;
            if (!meshVisible(content, tm.meta)) continue;
            boxes.push(tm.aabb);
            const r = tm.anatomyDepthSamples
                ? viewDepthRangeOfPositions(tm.anatomyDepthSamples, position, lookAt) : null;
            if (!r) continue;
            if (r.nearZ < nearZ) nearZ = r.nearZ;
            if (r.farZ > farZ) farZ = r.farZ;
        }
        if (isFinite(nearZ)) return { nearZ, farZ };
        return boxes.length ? viewDepthRange(mergeAABB(boxes), position, lookAt) : null;
    }
    function applyVisibility(content) {
        const ov = config.style.overlays || [];
        for (const tm of sceneModel.meshes) {
            let vis = meshVisible(content, tm.meta);
            // per-overlay show/hide: a hidden overlay's voxels never draw (any panel).
            if (vis && tm.meta.role === 'voxel' && ov[tm.meta.overlay ?? 0] && ov[tm.meta.overlay ?? 0].hidden) vis = false;
            tm.mesh.visible = vis;
        }
        // Borders follow whichever cortex surface this panel actually shows (pial / white /
        // inflated, one hemisphere or both) — they are per-vertex, so they are correct on all of
        // them without recomputation.
        const pOn = !!(config.style.parcellation?.enabled && parcLoaded);
        for (const b of borderMeshes) b.mesh.visible = pOn && b.src.mesh.visible;
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
        writeSlice(cortexFrontDepthMat.uniforms, slice);
        writeSlice(anatomyMat.uniforms, slice);
        writeSlice(anatomyOpaqueMat.uniforms, slice);
        writeSlice(anatomyClipDepthMat.uniforms, slice);
        for (let i = 0; i < N; i++) writeSlice(uniforms[i], slice);   // voxel + its edge depth material
        writeSlice(cortexOutline.depthMaterial.uniforms, slice);      // cortex outline + silhouette depth
        writeSlice(anatomyDepthMat.uniforms, slice);                  // subcortex outline + silhouette depth
        writeSlice(borderMat.uniforms, slice);                        // parcel borders follow the cut
    }

    // Install (or clear) the anatomy cut-cap volume. `vol` is {data,dims,affine} from the baked
    // asset, or null to remove. Idempotent-ish: disposes any previous cap first. The cap only
    // actually draws on panels that have a slice AND with config.style.sliceAnatomy on (renderFrame).
    function setAnatomyVolume(vol) {
        if (anatomyCap) { scene.remove(anatomyCap.root); anatomyCap.dispose(); anatomyCap = null; }
        if (vol) {
            anatomyCap = createAnatomyCap(vol, CAP_LAYER, CUT_OVERLAY_LAYER);
            anatomyCap.setOverlayVolumes(cutVolumes);
            anatomyCap.setOverlayStyles(resolvedCutOverlaySpecs());
            scene.add(anatomyCap.root);
        }
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
                ? (def.framing && def.framing.margin != null ? def.framing.margin : 1.04)
                : (config.style.margin ?? def.framing.margin);
            const fr = frameContent(aabb, def.camera, rect.aspect,
                { ...def.framing, margin, tilt: config.style.tilt, rotate: def.rotate, spinFit });
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

        // fit:'normalize' panels adopt a common on-screen FOOTPRINT (the projected brain bbox's
        // larger side reads the same size in every panel) — so a wide lateral hemisphere and a
        // compact anterior whole-brain look equally big, independent of view or cell. Footprints
        // are view-dependent, so this can't be done with a view-invariant scale; we measure each
        // panel's projected extent and shrink all to the SMALLEST (shrink-only → no cell overflow).
        let normFoot = Infinity;
        for (const { def, rect, fr } of frames)
            if (def.framing.fit === 'normalize')
                normFoot = Math.min(normFoot, Math.max(fr.pHalfW || 0, fr.pHalfH || 0) * rect.h / fr.ext);
        if (normFoot < Infinity) {
            for (const { def, rect, fr } of frames) {
                if (def.framing.fit !== 'normalize') continue;
                const ext = Math.max(fr.pHalfW || 0, fr.pHalfH || 0) * rect.h / normFoot;
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

        // Per-panel CONTENT rect: the brain's on-screen bbox (centred in the cell, sized by its
        // projected extent / the final ext). The Free Canvas frame hugs THIS, not the looser cell.
        for (const { rect, fr } of frames) {
            const pxPerMm = (rect.h / 2) / fr.ext;
            const hw = (fr.pHalfW || 0) * pxPerMm, hh = (fr.pHalfH || 0) * pxPerMm;
            const cx = rect.cssLeft + rect.w / 2, cy = rect.cssTop + rect.h / 2;
            fr.contentRect = { cssLeft: cx - hw, cssTop: cy - hh, w: 2 * hw, h: 2 * hh };
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
            alignSurfaceSheets(def.content);   // sheet borrows THIS panel's cortex surface
            applyPanelSlice(def.slice);     // per-panel cut (resets to OFF when absent)
            // Anatomy cut-cap: on a sliced panel (with slice-anatomy on), paint the T1 cross-section
            // on the exposed cut face; hide it everywhere else (the mesh is shared across panels).
            // The cut-cap is OPAQUE and sits at the cut plane, so it naturally occludes whatever is
            // behind it — the glass cortex stays drawn (sliced by the same cut), giving the "glass
            // brain cut open with the MRI core exposed" look, not a bare floating slice.
            const wantsCap = !!config.style.sliceAnatomy || !!config.style.cutOverlay?.enabled;
            const capActive = !!(wantsCap && def.slice) && !!anatomyCap
                && anatomyCap.configureForSlice(def.slice, def.content?.hemisphere || 'both');
            if (anatomyCap) {
                anatomyCap.root.visible = capActive;
                const showsVoxels = (def.content?.roles || []).includes('voxel');
                anatomyCap.setOverlayVisibility((i) => showsVoxels && !config.style.overlays?.[i]?.hidden);
            }
            if (def.anatomyOpacity != null) { anatomyMat.opacity = def.anatomyOpacity; anatomyMat.transparent = def.anatomyOpacity < 1; }
            else { anatomyMat.opacity = config.style.anatomy.opacity; anatomyMat.transparent = anatomyMat.opacity < 1; }
            // Per-panel subcortical style: opaque shell (occludes cortex lines + overlays
            // behind it; its own voxels still show) vs the default glass. Reset EVERY panel
            // (anatomy meshes are shared) so an opaque panel doesn't bleed into the next.
            const opaqueAnat = def.content && def.content.anatomyStyle === 'opaque';
            for (const m of anatomyMeshes) m.material = opaqueAnat ? anatomyOpaqueMat : anatomyMat;

            // The colour veil stays anchored to each overlay's own depth range. The separate hard
            // gate uses the visible anatomical shell (or the panel range for volume-only figures).
            const fwd = normalize(sub(fr.lookAt, fr.position));
            const gateRange = anatomicalDepthRange(def.content, fr.position, fr.lookAt)
                || { nearZ: fr.nearZ, farZ: fr.farZ };
            for (let i = 0; i < N; i++) {
                const drng = voxelDepthRange(def.content, i, fr.position, fwd);
                if (isFinite(drng.near)) { uniforms[i].uNearZ.value = drng.near; uniforms[i].uFarZ.value = Math.max(drng.far, drng.near + 1e-3); }
                else { uniforms[i].uNearZ.value = fr.nearZ; uniforms[i].uFarZ.value = fr.farZ; }
                uniforms[i].uDepthNearZ.value = gateRange.nearZ;
                uniforms[i].uDepthFarZ.value = Math.max(gateRange.farZ, gateRange.nearZ + 1e-3);
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
            if (anatomyCap && capActive) {
                const lightView = _lightScratch.subVectors(dir.position, dir.target.position)
                    .normalize().transformDirection(camera.matrixWorldInverse);
                anatomyCap.setLighting({ direction: lightView, directional: dir.intensity, ambient: amb.intensity });
            }

            // Compute a nearest FRONT-facing cortex depth field separately for THIS pane.
            // It lives only offscreen, so it filters cortex-on-cortex alpha stacking while the
            // main framebuffer remains free to show internal statistical and subcortical geometry.
            renderCortexFrontDepth(camera);
            const pr = renderer.getPixelRatio();
            glassMat.uniforms.uFrontViewportOrigin.value.set(rect.x * pr, rect.y * pr);
            glassMat.uniforms.uFrontViewportSize.value.set(rect.w * pr, rect.h * pr);
            glassMat.uniforms.uFrontTextureSize.value.set(cortexFrontDepthTarget.width, cortexFrontDepthTarget.height);

            // Combined nearest-overlay depth, built ONCE per panel BEFORE the edge passes,
            // then used to occlude BOTH the per-overlay voxel edges and the cortex outline
            // where a closer overlay volume sits in front (edges no longer draw through).
            let anyEdges = false;
            for (let i = 0; i < N; i++) if (osR[i].edges.enabled) anyEdges = true;
            const anyAutoDepth = osR.some((os) => os.depthMode !== 'manual');
            const anyAnatomyDepth = osR.some((os) => os.depthMode === 'anatomy');
            const showsAnatomy = (def.content?.roles || []).includes('anatomy');
            // `vox α` controls cortex-line strength where a statistical voxel is in front,
            // independently of whether voxel EDGE outlines are enabled. The front-depth cortex
            // pass made this dependency visible because clipTarget was only receiving voxel depth
            // when `anyEdges` was true. Render voxel depth whenever over-voxel line control is on.
            const wantsVoxelClip = anyEdges || !!config.style.outline.overVoxels || anyAutoDepth;
            // Visible subcortex remains a hard occluder and never inherits vox-alpha strength.
            const clip = wantsVoxelClip || showsAnatomy || capActive || anyAnatomyDepth;
            if (clip) renderClipDepth(camera, clipTarget, showsAnatomy || anyAnatomyDepth, wantsVoxelClip, capActive, anyAnatomyDepth);
            if (anyAutoDepth) renderClipDepth(camera, voxelOnlyDepthTarget, false, true, false, false);
            const prOcc = renderer.getPixelRatio();
            for (let i = 0; i < N; i++) {
                const u = uniforms[i];
                u.uDepthMode.value = osR[i].depthMode === 'manual' ? 0.0 : 1.0;
                u.uOcclusionDepth.value = osR[i].depthMode === 'clusters'
                    ? voxelOnlyDepthTarget.texture : clipTarget.texture;
                u.uOcclusionViewportOrigin.value.set(rect.x * prOcc, rect.y * prOcc);
                u.uOcclusionViewportSize.value.set(rect.w * prOcc, rect.h * prOcc);
            }

            renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissorTest(true);
            renderer.render(scene, camera);
            const trueDepthLines = config.style.outline.voxelLineMode === 'depth';
            // True-depth ownership needs the current panel's cortex depth before voxel edges draw.
            // The alpha-mix mode keeps the historical combined-voxel clip target.
            if (trueDepthLines && anyEdges) cortexOutline.renderDepth(camera);
            // Per-overlay voxel edges first (underneath), depth-clipped against the others.
            for (let i = 0; i < N; i++) {
                if (!osR[i].edges.enabled) continue;
                const eu = edgePasses[i].outlineMaterial.uniforms;
                eu.uClipDepth.value = trueDepthLines ? cortexOutline.depthTarget.texture : clipTarget.texture;
                eu.uClipApply.value = trueDepthLines ? 1.0 : (clip ? 1.0 : 0.0);
                eu.uBgMode.value = osR[i].edges.mode === 'outer' ? 2.0 : 0.0;
                edgePasses[i].update(camera, rect.x, rect.y, rect.w, rect.h);
            }
            // Plan cortex and subcortex as separate anatomical outline groups. A custom/thick
            // silhouette is never computed from the union with voxel geometry, so jagged blobs
            // cannot become the figure contour and the subcortex keeps its own boundary.
            const op = outlinePlan(config.style.outline, def.outline);
            const overVoxelAlpha = !trueDepthLines && config.style.outline.overVoxels
                ? (config.style.outline.overVoxelOpacity ?? 1.0) : 0.0;

            // Fold/depth lines. When a separately styled silhouette follows, these passes omit
            // background-touching edges so the contour is not drawn twice.
            if (op.folds) {
                const ou = cortexOutline.outlineMaterial.uniforms;
                setPassColor(cortexOutline, op.cortexFold.color);
                ou.uLineWidth.value = op.cortexFold.width * outlineSaveScale;
                ou.uThreshold.value = op.threshold;
                ou.uClipApply.value = clip ? 1.0 : 0.0;
                ou.uOverVoxelAlpha.value = overVoxelAlpha;
                ou.uClipOverlapMode.value = trueDepthLines ? 0.0 : 1.0;
                ou.uBgMode.value = op.foldBgMode;
                cortexOutline.update(camera, rect.x, rect.y, rect.w, rect.h);

                if (showsAnatomy) {
                    const au = anatomyOutline.outlineMaterial.uniforms;
                    setPassColor(anatomyOutline, op.anatomyFold.color);
                    au.uLineWidth.value = op.anatomyFold.width * outlineSaveScale;
                    au.uThreshold.value = op.threshold;
                    // The cortex depth target was rendered immediately above. Hide this line
                    // only where cortex is genuinely nearer; keep it where subcortex is in front.
                    au.uClipApply.value = 1.0;
                    au.uOverVoxelAlpha.value = 0.0;
                    au.uBgMode.value = op.foldBgMode;
                    anatomyOutline.update(camera, rect.x, rect.y, rect.w, rect.h);
                }
            }

            // Separately styled silhouettes run once per anatomical group, last. Each contour
            // retains its own depth field, and the cortex depth-clips the subcortex wherever it
            // is nearer to the camera.
            if (op.splitSilhouettes) {
                const ou = cortexOutline.outlineMaterial.uniforms;
                setPassColor(cortexOutline, op.cortexSilhouette.color);
                ou.uLineWidth.value = op.cortexSilhouette.width * outlineSaveScale;
                ou.uThreshold.value = op.threshold;
                ou.uClipApply.value = clip ? 1.0 : 0.0;
                ou.uOverVoxelAlpha.value = overVoxelAlpha;
                ou.uClipOverlapMode.value = trueDepthLines ? 0.0 : 1.0;
                ou.uBgMode.value = 2.0;
                cortexOutline.update(camera, rect.x, rect.y, rect.w, rect.h);

                if (showsAnatomy) {
                    const au = anatomyOutline.outlineMaterial.uniforms;
                    setPassColor(anatomyOutline, op.anatomySilhouette.color);
                    au.uLineWidth.value = op.anatomySilhouette.width * outlineSaveScale;
                    au.uThreshold.value = op.threshold;
                    au.uClipApply.value = 1.0;
                    au.uOverVoxelAlpha.value = 0.0;
                    au.uBgMode.value = 2.0;
                    anatomyOutline.update(camera, rect.x, rect.y, rect.w, rect.h);
                }
            }
        }
    }

    function resize(w, h) {
        width = w; height = h; VW = w; VH = h;
        renderer.setSize(w, h, false);   // updateStyle=false: let CSS control display size
        // grid is DESIGN-space (built once against W0×H0) — NOT rebuilt on viewport resize,
        // so the brains keep a fixed size; only the view transform's screen mapping changes.
        cortexOutline.setSize(w, h);
        anatomyOutline.setSize(w, h);
        for (const ep of edgePasses) ep.setSize(w, h);
        clipTarget.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
        voxelOnlyDepthTarget.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
        cortexFrontDepthTarget.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
    }

    function setPixelRatio(pr) {
        renderer.setPixelRatio(pr);
        renderer.setSize(width, height, false);
        cortexOutline.pr = pr; cortexOutline.setSize(width, height);
        anatomyOutline.pr = pr; anatomyOutline.setSize(width, height);
        for (const ep of edgePasses) { ep.pr = pr; ep.setSize(width, height); }
        clipTarget.setSize(Math.round(width * pr), Math.round(height * pr));
        voxelOnlyDepthTarget.setSize(Math.round(width * pr), Math.round(height * pr));
        cortexFrontDepthTarget.setSize(Math.round(width * pr), Math.round(height * pr));
    }

    // Push current config.style to live uniforms/materials/lights (global + per-overlay).
    function applyStyle() {
        const s = config.style;
        // Reset the Save-PNG outline supersampling: scaleOutlines() bumps it during a save and
        // relies on the next applyStyle() to clear it. Without this the cortex outline (recomputed
        // per-frame as outline.width * outlineSaveScale) stays thickened after a save, and grows
        // on each repeated save whenever savePr > basePr.
        outlineSaveScale = 1;
        dir.intensity = s.lighting.directional;
        amb.intensity = s.lighting.ambient;
        const glassControl = Math.max(0, s.glass.maxOpacity ?? 0);
        const glassMax = Math.min(1, glassControl);
        const glassMin = glassControl > 1
            ? Math.min(1, glassControl - 1)
            : Math.min(glassMax, s.glass.minOpacity ?? 0);
        glassMat.uniforms.uMaxOpacity.value = glassMax;
        glassMat.uniforms.uMinOpacity.value = glassMin;
        glassMat.uniforms.uColor.value.set(s.glass.color ?? '#ffffff');
        anatomyMat.uniforms.uColor.value.set(s.anatomy.color ?? s.glass.color ?? '#ffffff');
        anatomyOpaqueMat.uniforms.uColor.value.set(s.anatomy.opaqueColor ?? s.anatomy.color ?? s.glass.color ?? '#ffffff');
        cortexOutline.outlineMaterial.uniforms.uLineWidth.value = s.outline.width;
        cortexOutline.outlineMaterial.uniforms.uThreshold.value = s.outline.threshold;
        // Line COLOURS are pushed here and nowhere else. They used to be baked in at pass
        // construction, which is why changing one needed a full engine rebuild — and why the
        // colour fields in the schema had no UI at all.
        setPassColor(cortexOutline, s.outline.color);
        setPassColor(anatomyOutline, s.outline.anatomyColor ?? s.outline.color);
        const parc = s.parcellation || {};
        _colScratch.set(parc.color ?? '#1a1a1a');
        borderMat.uniforms.uColor.value.set(_colScratch.r, _colScratch.g, _colScratch.b);
        // Border width is in device px, so this doubles as the post-save RESTORE: applyStyle has
        // just reset outlineSaveScale, and scaleOutlines multiplies the uniform during a save
        // exactly as it does for the voxel edge passes.
        borderMat.uniforms.uHalfWidth.value = (parc.width ?? 2.0) * 0.5;
        borderMat.uniforms.uOpacity.value = parc.opacity ?? 1.0;
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
            u.uDepthCut.value = os.depthCut ?? 0;
            u.uDepthMode.value = os.depthMode === 'manual' ? 0 : 1;
            u.uBaseApply.value = os.surfaceBase ? 1 : 0;
            if (os.surfaceBase) u.uBaseColor.value.set(os.surfaceBase);
            applyVoxelAlpha(voxelMats[i], os.opacity ?? 1);
            const em = edgePasses[i].outlineMaterial.uniforms;
            em.uOpacity.value = os.edges.opacity;
            em.uLineWidth.value = os.edges.width;
            em.uThreshold.value = os.edges.threshold;   // was construction-only, like the colour
            setPassColor(edgePasses[i], os.edges.color);
        }
        if (anatomyCap) anatomyCap.setOverlayStyles(resolvedCutOverlaySpecs());
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
    // The brain's on-screen bbox per panel (from the last framing pass), so the Free Canvas frame
    // hugs the rendered brain rather than the looser panel cell. Falls back to the cell if missing.
    function getPanelContentRects() {
        return panels.map(({ def }) => {
            const fo = lastFrames.find((x) => x.def === def);
            const c = fo && fo.fr && fo.fr.contentRect;
            const r = panelRect(def);
            const cr = (c && c.w > 4 && c.h > 4) ? c : { cssLeft: r.cssLeft, cssTop: r.cssTop, w: r.w, h: r.h };
            return { id: def.id, title: def.title, cssLeft: cr.cssLeft, cssTop: cr.cssTop, w: cr.w, h: cr.h };
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
        outlineSaveScale *= f;   // cortex outline width is recomputed per-panel from this each frame
        for (const ep of edgePasses) ep.outlineMaterial.uniforms.uLineWidth.value *= f;
        borderMat.uniforms.uHalfWidth.value *= f;

    }

    // Free this engine's GPU resources so it can be rebuilt in-place when the
    // overlay set changes (the static app adds/removes overlays without a reload).
    // Mesh geometries are NOT disposed — they're owned by the app and reused across
    // rebuilds; only this engine's materials, outline passes, and targets are freed.
    function dispose() {
        glassMat.dispose(); cortexFrontDepthMat.dispose(); anatomyMat.dispose(); anatomyOpaqueMat.dispose(); anatomyClipDepthMat.dispose();
        for (const m of voxelMats) m.dispose();
        cortexOutline.dispose();
        anatomyOutline.dispose();
        anatomyDepthMat.dispose();
        borderMat.dispose();
        // Only the border geometries' own aDist buffers are freed — position/index are the cortex
        // meshes' attributes, which outlive the engine.
        for (const b of borderMeshes) { b.geo.deleteAttribute('position'); b.geo.setIndex(null); b.geo.dispose(); }
        for (const ep of edgePasses) ep.dispose();
        clipTarget.dispose();
        voxelOnlyDepthTarget.dispose();
        cortexFrontDepthTarget.dispose();
        if (anatomyCap) anatomyCap.dispose();
        scene.clear();
    }

    return {
        scene, renderFrame, resize, setPixelRatio, getPanelRects, getPanelContentRects, getPanelDesignRects, getPanelContentAABB, getPanelView, zoomPanel, scaleOutlines, recolor, applyStyle, applySmoothing, setColormap, dispose,
        setView, getView, panView, zoomViewAt, resetView, fitView, setAnatomyVolume,
        setParcellation, getParcellation: () => parcLoaded,
        getSurfaceVariants: () => surfaceVariants.slice(),
        setSpinFit: (v) => { spinFit = !!v; },   // sphere-fit (constant size) only while spinning
        overlays, config, colormaps, renderer, THREE, sceneModel,
        _internals: { uniforms, glassMat, anatomyMat, voxelMats, dir, amb },
    };
}
