/**
 * parcellation.js — atlas boundary lines on the cortical surface. Browser side.
 *
 * Parcel borders are NOT depth discontinuities, so the depth-edge OutlinePass that draws every
 * other line in Comic cannot draw them. They are rendered instead as a **geodesic distance
 * field** (built in core/parcel-field.js): each vertex carries `aDist`, its distance in mm to the
 * nearest parcel boundary, and the fragment shader converts that to screen pixels with
 *
 *     px = aDist / |∇aDist|
 *
 * which is valid because a distance field has |∇d| ≈ 1, so the screen-space gradient magnitude IS
 * mm-per-pixel. The result is a line of constant DEVICE-PIXEL width at any zoom, panel size or
 * surface variant, analytically anti-aliased, and — crucially — placed with sub-triangle
 * accuracy: it is free to sit part-way across a triangle instead of snapping to mesh edges.
 *
 * The alternative (render parcel IDs to a buffer and detect ID changes in screen space, like the
 * depth passes) needs a `flat` varying, which pins every boundary to a triangle edge. On ico7
 * (~1 mm triangles, ~3 px/mm in a typical figure) that is a visible ±1.5 px staircase that no
 * amount of smoothing removes, because the boundary is quantised to the mesh.
 *
 * Everything here runs in the browser, which means the headless CLI gets it too (that path drives
 * this same engine through Playwright) and a bring-your-own atlas needs no baking.
 */
import * as THREE from 'three';
import { sliceUniforms, SLICE_FRAG_PARS, SLICE_VERT_PARS, SLICE_VERT_ASSIGN } from './materials.js?v=depth-auto-v3';
import { buildAdjacency, colorParcels, signedBoundaryFields, smoothFields, PLANES } from '../core/parcel-field.js?v=depth-auto-v3';

/** Distances are capped here (mm). The line is ~1 mm wide, so anything beyond this is "far"; the
 *  cap is what keeps the propagation O(boundary ring count) instead of O(whole surface). */
export const DIST_MAX = 8.0;

/** Laplacian passes applied to the signed fields before rendering. Fixed, not a user parameter:
 *  it rounds the ~1 mm vertex staircase an atlas boundary inherits from its own resampling, and
 *  there is no figure for which the staircase is the desired look. */
const CONTOUR_SMOOTHING = 4;

const borderVert = `
attribute vec4 aSigned;
varying vec4 vS;
${SLICE_VERT_PARS}
void main(){
    vS = aSigned;
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    ${SLICE_VERT_ASSIGN}
    gl_Position = projectionMatrix * p;
}`;

// d / |∇d| converts the mm field to screen pixels: a distance field has |∇d| ≈ 1 in mm-per-mm,
// so the screen-space gradient magnitude IS mm-per-pixel. uHalfWidth is therefore a true
// device-pixel half-width, the same unit every other line in Comic uses.
//
// length(vec2(dFdx, dFdy)) — not fwidth() — because fwidth is |dFdx| + |dFdy|, which overestimates
// the gradient by up to √2 and, worse, varies with the boundary's orientation on screen: using it
// makes diagonal borders visibly thinner than axis-aligned ones. The ±0.7 px ramp is the AA.
// Each component of vS is a SIGNED distance field for one colour bit-plane, so each crosses zero
// exactly on the interfaces that bit separates. |s| / |∇s| is that crossing's distance in screen
// pixels; the nearest one across the four planes is the nearest parcel boundary, and every
// boundary is caught by at least one plane (adjacent parcels differ in at least one colour bit).
// Unused planes are constant, so their gradient is 0 and they map to an unreachable distance.
const borderFrag = `
uniform vec3 uColor;
uniform float uHalfWidth, uOpacity;
varying vec4 vS;
${SLICE_FRAG_PARS}
float pixelDist(float s){
    // length(vec2(dFdx,dFdy)) rather than fwidth(): fwidth is |dFdx|+|dFdy|, which overestimates
    // the gradient by up to sqrt(2) AND varies with the boundary's on-screen orientation, making
    // diagonal borders visibly thinner than axis-aligned ones.
    return abs(s) / max(length(vec2(dFdx(s), dFdy(s))), 1e-6);
}
void main(){
    if (gbSliceDiscard(vWorldPos)) discard;
    float px = min(min(pixelDist(vS.x), pixelDist(vS.y)),
                   min(pixelDist(vS.z), pixelDist(vS.w)));
    float a = (1.0 - smoothstep(uHalfWidth - 0.7, uHalfWidth + 0.7, px)) * uOpacity;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
}`;

export function makeBorderMaterial(parc = {}) {
    const c = new THREE.Color(parc.color ?? '#1a1a1a');
    return new THREE.ShaderMaterial({
        vertexShader: borderVert, fragmentShader: borderFrag,
        transparent: true,
        depthTest: true,
        // Never write depth: the border is paint on a surface that is already in the depth
        // buffer, and writing would let it occlude the very geometry it sits on.
        depthWrite: false,
        side: THREE.FrontSide,        // near surface only; the far side is killed by the cortex depth
        // Pull the line toward the camera so it wins against the cortex it is drawn on AND against
        // the surface-projection patches (which use -1 / -4), instead of z-fighting with them.
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
        uniforms: {
            uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
            uHalfWidth: { value: (parc.width ?? 2.0) * 0.5 },
            uOpacity: { value: parc.opacity ?? 1.0 },
            ...sliceUniforms(),
        },
    });
}

/** Border geometry for one cortex mesh: shares the source position/index buffers (so it costs
 *  no extra vertex memory) and adds the per-vertex distance field. */
export function makeBorderGeometry(srcGeo) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', srcGeo.attributes.position);
    g.setIndex(srcGeo.index);
    g.setAttribute('aSigned', new THREE.BufferAttribute(
        new Float32Array(srcGeo.attributes.position.count * PLANES).fill(DIST_MAX), PLANES));
    if (!srcGeo.boundingSphere) srcGeo.computeBoundingSphere();
    g.boundingSphere = srcGeo.boundingSphere;
    return g;
}

/**
 * Recompute one border geometry's distance field from an atlas.
 * `labels` is the int16 per-vertex array for this hemisphere (-1 = not cortex).
 * Fails loudly on a vertex-count mismatch — a custom template whose surfaces are not fsaverage
 * must not silently draw another brain's parcel boundaries.
 */
export function applyLabels(borderGeo, srcGeo, labels, { medialWall = true } = {}) {
    const n = srcGeo.attributes.position.count;
    if (labels.length !== n)
        throw new Error(`parcellation has ${labels.length} vertices but this surface has ${n} — `
            + 'the atlas and the template are not the same mesh');
    // Adjacency depends only on topology, which pial/white/inflated and every atlas share, so it
    // is built at most once per hemisphere and memoised on the source geometry.
    const adj = srcGeo.userData.gbAdj
        || (srcGeo.userData.gbAdj = buildAdjacency(srcGeo.index.array, n));
    let maxLabel = -1;
    for (let i = 0; i < n; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
    const colour = colorParcels(labels, adj, maxLabel + 1);
    const fields = signedBoundaryFields(labels, adj, srcGeo.attributes.position.array,
                                        colour, maxLabel + 1,
                                        { includeWall: medialWall, maxDist: DIST_MAX });
    // Round the contour. This is deliberately NOT exposed as a parameter and deliberately NOT done
    // by relabelling vertices: an atlas's parcel membership is data, and a viewer has no business
    // editing it to make a line look nicer. Smoothing the signed field moves only the rendered
    // zero crossing — every vertex keeps the parcel the atlas gave it.
    const active = new Uint8Array(n);
    for (let i = 0; i < n; i++) active[i] = (medialWall || labels[i] >= 0) ? 1 : 0;
    smoothFields(fields, adj, CONTOUR_SMOOTHING, active);
    borderGeo.attributes.aSigned.copyArray(fields);
    borderGeo.attributes.aSigned.needsUpdate = true;
}
