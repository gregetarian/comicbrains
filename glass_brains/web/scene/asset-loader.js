/**
 * asset-loader.js — static/in-browser variant.
 *
 * Two responsibilities, split because the data now comes from two places:
 *   loadBaseScene(base)  — the FIXED fsaverage template (cortex + subcortical),
 *                          baked to GLB and loaded once, exactly as the server app did.
 *   buildOverlayMeshes() — the PER-UPLOAD overlay, built straight into THREE
 *                          BufferGeometries from the Pyodide pipeline's raw arrays
 *                          (no GLB, no trimesh round-trip).
 *
 * Every mesh is tagged with the same metadata the renderer expects
 * (role / hemisphere / structure / category / variant), so renderer.js is verbatim.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltfLoader = new GLTFLoader();
const loadGLB = (url) => new Promise((res, rej) => gltfLoader.load(url, res, undefined, rej));

function firstMesh(obj) {
    if (obj.isMesh) return obj;
    for (const c of obj.children) { const m = firstMesh(c); if (m) return m; }
    return null;
}

function hemiOfCategory(cat) {
    if (cat.endsWith('_l') || cat === 'lh_cortex') return 'lh';
    if (cat.endsWith('_r') || cat === 'rh_cortex') return 'rh';
    return 'mid'; // brainstem
}
function categoryOfStructure(name) {
    const cereb = name.includes('Cerebellum');
    if (name === 'Brainstem') return 'brainstem';
    if (name.startsWith('L-')) return cereb ? 'cereb_l' : 'subcort_l';
    if (name.startsWith('R-')) return cereb ? 'cereb_r' : 'subcort_r';
    return 'brainstem';
}

function bboxOf(mesh) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
}

/** Per-vertex value attribute (drives threshold + JS colorization) + writable colour. */
function attachValues(geometry, values) {
    geometry.setAttribute('aValue', new THREE.BufferAttribute(values, 1));
    const n = geometry.attributes.position.count;
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return values;
}

/** Per-vertex cluster size (live cluster-extent filter). */
function attachClusters(geometry, clusters) {
    const n = geometry.attributes.position.count;
    const arr = new Float32Array(n);
    if (clusters && clusters.length === n) arr.set(clusters);
    else arr.fill(1e9);   // unknown ⇒ never hidden by the cluster threshold
    geometry.setAttribute('aClusterSize', new THREE.BufferAttribute(arr, 1));
}

/** Load the fixed cortex + subcortical template from baked GLBs under `base`. */
export async function loadBaseScene(base = 'data/') {
    const manifest = await fetch(base + 'scene.json').then((r) => r.json());
    const meshes = [];
    const push = (mesh, meta, values = null) => {
        if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
        meshes.push({ mesh, meta, values, aabb: bboxOf(mesh) });
    };

    for (const [hemi, info] of Object.entries(manifest.cortex || {})) {
        const hk = hemi === 'lh' ? 'lh' : 'rh';
        const baseMeta = { role: 'cortex', hemisphere: hk, structure: `cortex_${hemi}`, category: `${hemi}_cortex` };
        push(firstMesh((await loadGLB(base + info.mesh)).scene), { ...baseMeta, variant: 'pial' });
        if (info.meshInflated) push(firstMesh((await loadGLB(base + info.meshInflated)).scene), { ...baseMeta, variant: 'inflated' });
    }
    for (const [name, info] of Object.entries(manifest.subcortical || {})) {
        const m = firstMesh((await loadGLB(base + info.mesh)).scene);
        const cat = categoryOfStructure(name);
        push(m, { role: 'anatomy', hemisphere: hemiOfCategory(cat), structure: name, category: cat, variant: null });
    }
    return { meshes, manifest };
}

/** Float32/Uint32 view over a transferred byte buffer (copied to a 0-offset buffer
 *  so the typed-array alignment is always valid regardless of the source offset). */
const asF32 = (u8) => new Float32Array(u8.slice().buffer);
const asU32 = (u8) => new Uint32Array(u8.slice().buffer);

/** Fetch a static overlay's `.bin` and slice it back into per-buffer Uint8Arrays via
 *  the meta's `bufferLayout` ([offset,length] per buffer index). Used for the baked
 *  demo (data/demo/) and for the CLI render (one overlay_<i>.bin) — the same arrays a
 *  live Pyodide upload produces, so all three paths feed buildOverlayMeshes() identically. */
export async function loadOverlayArrays(base, meta) {
    const file = meta.buffersFile || 'buffers.bin';
    const buf = await fetch(base + file).then((r) => r.arrayBuffer());
    return meta.bufferLayout.map(([o, l]) => new Uint8Array(buf, o, l));
}

/** Build one overlay's tagged THREE meshes from the Pyodide pipeline output.
 *  @param meta    one overlay's meta object (from pipeline.process_nifti)
 *  @param buffers array of Uint8Array, indexed by meta.structures[cat][variant].{pos,idx,val,clu}
 *  @param oi      overlay index (display row / layer)
 *  @returns array of { mesh, meta, values, aabb } tagged like the GLB overlay meshes */
export function buildOverlayMeshes(meta, buffers, oi) {
    const out = [];
    for (const [cat, variants] of Object.entries(meta.structures || {})) {
        const hemi = hemiOfCategory(cat);
        for (const variant of ['blocky', 'smooth']) {
            const d = variants[variant];
            if (!d) continue;
            const positions = asF32(buffers[d.pos]);
            const index = asU32(buffers[d.idx]);
            const values = asF32(buffers[d.val]);
            const clusters = asF32(buffers[d.clu]);

            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            g.setIndex(new THREE.BufferAttribute(index, 1));
            attachValues(g, values);
            attachClusters(g, clusters);
            g.computeVertexNormals();

            const mesh = new THREE.Mesh(g);   // material assigned by the engine
            out.push({
                mesh,
                meta: { role: 'voxel', overlay: oi, hemisphere: hemi, structure: `${meta.name}_${cat}`, category: cat, variant },
                values,
                aabb: bboxOf(mesh),
            });
        }
    }
    // Surface-projection meshes (M8): the cortex sheet per hemi, sampled from this volume. Same
    // voxel role + per-vertex aValue path (so recolor colours them through the LUT), variant
    // 'surface' (shown only when representation === 'surface'), + an aCurv attribute for the
    // surface material's curvature-grey fallback below threshold.
    for (const hemi of ['lh', 'rh']) {
        const d = meta.surface && meta.surface[hemi];
        if (!d) continue;
        const values = asF32(buffers[d.val]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(asF32(buffers[d.pos]), 3));
        g.setIndex(new THREE.BufferAttribute(asU32(buffers[d.idx]), 1));
        attachValues(g, values);
        attachClusters(g, asF32(buffers[d.clu]));
        g.setAttribute('aCurv', new THREE.BufferAttribute(asF32(buffers[d.crv]), 1));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g);
        out.push({
            mesh,
            meta: { role: 'voxel', overlay: oi, hemisphere: hemi,
                    structure: `${meta.name}_${hemi}_cortex`, category: `${hemi}_cortex`, variant: 'surface' },
            values,
            aabb: bboxOf(mesh),
        });
    }
    return out;
}
