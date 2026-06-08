/**
 * materials.js — config-driven material factories. Browser (three.js) side.
 *
 * - Glass cortex: fresnel transparency + cel shading (view-space headlight).
 * - Anatomy: matte Lambert (occludes voxels behind it; no specular).
 * - Voxel: shiny Phong, OPAQUE (self-occluding "100" look, no transparent pass
 *   snap), with injected threshold-discard + logarithmic depth veil (a colour
 *   effect that tints deep voxels toward the brain colour).
 *
 * Voxel uniforms are created PER ENGINE (not a module global) so multiple
 * configs can coexist (e.g. a headless render in the same process).
 */
import * as THREE from 'three';

// ---- Slicing (Free Canvas) ----------------------------------------------
// A per-panel SDF "cut" shared by EVERY material (voxel, glass, anatomy, and the
// two depth materials in passes.js) so the whole brain slices together and the
// edge/outline passes follow the cut. THREE.clippingPlanes can't do this (materials
// are shared across panels, and it can't express a sphere/box BITE), so we inject a
// world-space discard. uSliceType 0 = off (default), so unsliced panels are untouched.
export function sliceUniforms() {
    return {
        uSliceType: { value: 0 },   // 0 none · 1 plane · 2 sphere · 3 cube
        uSliceMode: { value: 0 },   // 0 keep (show region) · 1 bite (remove region)
        uSliceNormal: { value: new THREE.Vector3(0, 0, 1) },
        uSliceOffset: { value: 0 },
        uSliceCenter: { value: new THREE.Vector3(0, 0, 0) },
        uSliceRadius: { value: 0 },
        uSliceMin: { value: new THREE.Vector3(0, 0, 0) },
        uSliceMax: { value: new THREE.Vector3(0, 0, 0) },
    };
}
// Fragment-stage declarations + the discard predicate (global scope, so it can be
// prepended before main()). Coordinates are world mm (== vertex position; meshes at identity).
export const SLICE_FRAG_PARS = `
uniform float uSliceType, uSliceMode, uSliceOffset, uSliceRadius;
uniform vec3 uSliceNormal, uSliceCenter, uSliceMin, uSliceMax;
varying vec3 vWorldPos;
bool gbSliceDiscard(vec3 p){
    if (uSliceType < 0.5) return false;
    bool ins;
    if (uSliceType < 1.5) ins = dot(p, normalize(uSliceNormal)) > uSliceOffset;     // plane half-space
    else if (uSliceType < 2.5) ins = length(p - uSliceCenter) < uSliceRadius;        // sphere
    else ins = all(greaterThan(p, uSliceMin)) && all(lessThan(p, uSliceMax));        // cube AABB
    return (uSliceMode < 0.5) ? !ins : ins;   // keep: drop outside · bite: drop inside
}`;
export const SLICE_VERT_PARS = `varying vec3 vWorldPos;`;
export const SLICE_VERT_ASSIGN = `vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`;

// ---- Glass cortex --------------------------------------------------------
const glassVert = `
varying vec3 vNormal;
varying vec3 vViewDir;
${SLICE_VERT_PARS}
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    ${SLICE_VERT_ASSIGN}
    gl_Position = projectionMatrix * mvPosition;
}`;
const glassFrag = `
uniform vec3 uColor;
uniform float uFresnelPower, uMinOpacity, uMaxOpacity, uCelBands;
uniform vec3 uLightDir;
varying vec3 vNormal;
varying vec3 vViewDir;
${SLICE_FRAG_PARS}
void main() {
    if (gbSliceDiscard(vWorldPos)) discard;
    vec3 n = gl_FrontFacing ? normalize(vNormal) : -normalize(vNormal);
    vec3 v = normalize(vViewDir);
    float fresnel = pow(1.0 - abs(dot(v, n)), uFresnelPower);
    float alpha = mix(uMinOpacity, uMaxOpacity, fresnel);
    float intensity = 0.5 * dot(n, normalize(uLightDir)) + 0.5;
    intensity = floor(intensity * uCelBands + 0.001) / uCelBands;
    gl_FragColor = vec4(uColor * mix(0.3, 1.0, intensity), alpha);
}`;

export function makeGlassMaterial(glass = {}) {
    return new THREE.ShaderMaterial({
        vertexShader: glassVert,
        fragmentShader: glassFrag,
        transparent: true,
        depthWrite: true,
        side: THREE.FrontSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        uniforms: {
            uColor: { value: new THREE.Color(glass.color ?? 0xffffff) },
            uFresnelPower: { value: glass.fresnelPower ?? 2.5 },
            uMinOpacity: { value: glass.minOpacity ?? 0.0 },
            uMaxOpacity: { value: glass.maxOpacity ?? 0.08 },
            uCelBands: { value: glass.celBands ?? 3.0 },
            uLightDir: { value: new THREE.Vector3(0, 0, 1) }, // view-space headlight
            ...sliceUniforms(),                               // per-panel cut (set by the renderer)
        },
    });
}

// ---- Anatomy (white glass shell) -----------------------------------------
export function makeAnatomyMaterial(anatomy = {}) {
    // White fresnel glass: transparent face-on (so the voxels inside show
    // clearly) and faint at the silhouette, plus the black outline pass. Drops
    // the baked structure colours — the subcortical structures read as faint
    // glass shells, not solid grey.
    return makeGlassMaterial({
        color: anatomy.color ?? 0xffffff,
        maxOpacity: anatomy.maxOpacity ?? 0.14,
        fresnelPower: anatomy.fresnelPower ?? 2.0,
    });
}

// ---- Anatomy: OPAQUE shell (per-panel option) ----------------------------
// Still WHITE and "translucent to itself" (you see the overlay's own voxels inside the
// structure), but it OBSCURES whatever is behind it (the background, cortex lines, other
// overlays' voxels). Trick: render the BACK faces only as an opaque white wall that writes
// depth. The front is open, so you look INTO the structure (its interior voxels — which are
// nearer than the back wall — still draw); the white back wall fills the structure and its
// depth occludes everything behind it. Shares the slice uniforms (per-panel cut applies).
const anatomyOpaqueFrag = `
uniform vec3 uColor;
uniform float uCelBands;
uniform vec3 uLightDir;
varying vec3 vNormal;
varying vec3 vViewDir;
${SLICE_FRAG_PARS}
void main() {
    if (gbSliceDiscard(vWorldPos)) discard;
    vec3 n = gl_FrontFacing ? normalize(vNormal) : -normalize(vNormal);
    float intensity = 0.5 * dot(n, normalize(uLightDir)) + 0.5;
    intensity = floor(intensity * uCelBands + 0.001) / uCelBands;
    gl_FragColor = vec4(uColor * mix(0.82, 1.0, intensity), 1.0);   // opaque WHITE, gentle shading
}`;

export function makeOpaqueAnatomyMaterial(anatomy = {}) {
    return new THREE.ShaderMaterial({
        vertexShader: glassVert,
        fragmentShader: anatomyOpaqueFrag,
        transparent: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.BackSide,   // back wall only → open front, interior voxels still show
        // push the wall slightly back so voxels at the structure surface win the depth test.
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
        uniforms: {
            uColor: { value: new THREE.Color(anatomy.opaqueColor ?? 0xffffff) },
            uCelBands: { value: anatomy.celBands ?? 3.0 },
            uLightDir: { value: new THREE.Vector3(0, 0, 1) },   // view-space headlight
            ...sliceUniforms(),
        },
    });
}

// ---- Voxel (shiny, opaque, threshold + depth veil) -----------------------
export function makeSharedVoxelUniforms(style = {}) {
    const v = style.voxel || {};
    const veil = v.veil || {};
    return {
        uThreshold: { value: 0.0 },
        uMaxAbs: { value: 1.0 },
        uPositiveOnly: { value: style.positiveOnly ? 1.0 : 0.0 },
        uClusterMin: { value: v.clusterMin ?? 0.0 }, // cluster-extent filter (min voxels)
        uNearZ: { value: 200.0 },   // set per-panel from framing
        uFarZ: { value: 400.0 },
        uVeilStrength: { value: veil.strength ?? 0.40 },
        uVeilColor: { value: new THREE.Color(veil.color ?? 0xffffff) },
        uVeilK: { value: veil.k ?? 6.0 },
        // Emissive boost: show the colormap colour faithfully (view-independent,
        // like the flat look) so Phong's 1/π darkening doesn't wash it out; the
        // diffuse+glint terms then add shading/shine on top.
        uEmissiveBoost: { value: v.emissive ?? 0.6 },
        // Light-INDEPENDENT specular glint (a view-space highlight) so the
        // specular/shine sliders work even with the scene lights at zero.
        uGlintAmt: { value: v.specular ?? 0.10 },
        uGlintPow: { value: v.shininess ?? 80 },
        // Per-panel slice (shared with this overlay's edge depth material in passes.js).
        ...sliceUniforms(),
    };
}

export function makeVoxelMaterial(style = {}, shared) {
    const v = style.voxel || {};
    const mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        specular: new THREE.Color(0, 0, 0), // Phong specular off; we use uGlint (light-independent)
        shininess: 1,
    });
    // Voxels are ALWAYS opaque: they occlude each other via the depth buffer
    // regardless of how faded they look against the surface. The "fade" is the
    // colour-only depth veil — it never reduces occlusion. (No opacity control
    // should ever make these transparent.)
    mat.transparent = false;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, shared);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                `#include <common>\n attribute float aValue;\n attribute float aClusterSize;\n varying float vThreshValue;\n varying float vClusterSize;\n varying float vViewZ;\n ${SLICE_VERT_PARS}`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>\n vThreshValue = aValue;\n vClusterSize = aClusterSize;`)
            .replace('#include <project_vertex>',
                `#include <project_vertex>\n vViewZ = -mvPosition.z;\n ${SLICE_VERT_ASSIGN}`);
        shader.fragmentShader =
            `uniform float uThreshold, uMaxAbs, uPositiveOnly, uClusterMin, uNearZ, uFarZ, uVeilStrength, uVeilK, uEmissiveBoost, uGlintAmt, uGlintPow;
             uniform vec3 uVeilColor;
             varying float vThreshValue; varying float vClusterSize; varying float vViewZ;
             ${SLICE_FRAG_PARS}\n` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
            `#include <color_fragment>
             if (gbSliceDiscard(vWorldPos)) discard;
             if (abs(vThreshValue) < uThreshold) discard;
             if (uPositiveOnly > 0.5 && vThreshValue < 0.0) discard;
             if (vClusterSize < uClusterMin) discard;
             float zf = clamp((vViewZ - uNearZ) / max(uFarZ - uNearZ, 1e-3), 0.0, 1.0);
             float veil = log(1.0 + uVeilK * zf) / log(1.0 + uVeilK);
             diffuseColor.rgb = mix(diffuseColor.rgb, uVeilColor, veil * uVeilStrength);
             totalEmissiveRadiance += diffuseColor.rgb * uEmissiveBoost;`);
        // Light-independent view-space specular glint (works with lights at 0).
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
            `{
                vec3 Hg = normalize(vec3(-0.3, 0.4, 1.0) + vec3(0.0, 0.0, 1.0));
                float g = pow(max(dot(normal, Hg), 0.0), max(uGlintPow, 1.0)) * uGlintAmt;
                outgoingLight += vec3(g);
             }
             #include <opaque_fragment>`);
    };
    return mat;
}
