/**
 * asset-loader.js — load scene.json + GLBs into tagged meshes. Browser side.
 *
 * Every mesh is tagged ONCE here with metadata derived from its position in the
 * manifest (role / hemisphere / structure / category / variant), so no other
 * module has to string-match names. Per-mesh AABBs are computed for framing.
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

/** Attach a per-vertex value attribute (for threshold + JS colorization). */
function attachValues(mesh, values) {
    if (!values || !values.length) return null;
    const arr = new Float32Array(values);
    mesh.geometry.setAttribute('aValue', new THREE.BufferAttribute(arr, 1));
    // ensure a writable color attribute exists (engine fills it via colormap)
    const n = mesh.geometry.attributes.position.count;
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return arr;
}

/** Attach per-vertex cluster size (for the live cluster-extent filter). When the
 *  cluster sidecar is missing/mismatched (e.g. assets predating the feature), fill
 *  a huge value so the cluster threshold never hides the voxels (unknown ⇒ show). */
function attachClusters(mesh, clusters) {
    const n = mesh.geometry.attributes.position.count;
    const arr = new Float32Array(n);
    if (clusters && clusters.length === n) arr.set(clusters);
    else arr.fill(1e9);
    mesh.geometry.setAttribute('aClusterSize', new THREE.BufferAttribute(arr, 1));
}

export async function loadScene(manifestUrl) {
    const manifest = await fetch(manifestUrl).then((r) => r.json());
    const meshes = [];

    const push = (mesh, meta, values = null) => {
        if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
        meshes.push({ mesh, meta, values, aabb: bboxOf(mesh) });
    };

    // Cortex (pial + slightly-inflated variant)
    for (const [hemi, info] of Object.entries(manifest.cortex || {})) {
        const hk = hemi === 'lh' ? 'lh' : 'rh';
        const base = { role: 'cortex', hemisphere: hk, structure: `cortex_${hemi}`, category: `${hemi}_cortex` };
        push(firstMesh((await loadGLB(info.mesh)).scene), { ...base, variant: 'pial' });
        if (info.meshInflated) push(firstMesh((await loadGLB(info.meshInflated)).scene), { ...base, variant: 'inflated' });
    }

    // Subcortical / cerebellum anatomy
    for (const [name, info] of Object.entries(manifest.subcortical || {})) {
        const m = firstMesh((await loadGLB(info.mesh)).scene);
        const cat = categoryOfStructure(name);
        push(m, { role: 'anatomy', hemisphere: hemiOfCategory(cat), structure: name, category: cat, variant: null });
    }

    // Overlay voxels — blocky + smooth variants, tagged with their overlay index
    const overlayList = manifest.overlays || [];
    for (let oi = 0; oi < overlayList.length; oi++) {
        const ov = overlayList[oi];
        for (const [cat, so] of Object.entries(ov.structureOverlays || {})) {
            const hemi = hemiOfCategory(cat);
            const variants = [['blocky', so.mesh, so.values, so.clusters],
                              ['smooth', so.meshSmooth, so.valuesSmooth, so.clustersSmooth]];
            for (const [variant, meshUrl, valsUrl, cluUrl] of variants) {
                if (!meshUrl) continue;
                const m = firstMesh((await loadGLB(meshUrl)).scene);
                const vals = valsUrl ? await fetch(valsUrl).then((r) => r.json()).catch(() => []) : [];
                const arr = attachValues(m, vals);
                const clu = cluUrl ? await fetch(cluUrl).then((r) => r.json()).catch(() => []) : [];
                attachClusters(m, clu);
                push(m, { role: 'voxel', overlay: oi, hemisphere: hemi, structure: `${ov.name}_${cat}`, category: cat, variant }, arr);
            }
        }
    }

    return { meshes, manifest };
}
