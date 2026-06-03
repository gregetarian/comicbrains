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

// ---- Glass cortex --------------------------------------------------------
const glassVert = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
}`;
const glassFrag = `
uniform vec3 uColor;
uniform float uFresnelPower, uMinOpacity, uMaxOpacity, uCelBands;
uniform vec3 uLightDir;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
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
                `#include <common>\n attribute float aValue;\n attribute float aClusterSize;\n varying float vThreshValue;\n varying float vClusterSize;\n varying float vViewZ;`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>\n vThreshValue = aValue;\n vClusterSize = aClusterSize;`)
            .replace('#include <project_vertex>',
                `#include <project_vertex>\n vViewZ = -mvPosition.z;`);
        shader.fragmentShader =
            `uniform float uThreshold, uMaxAbs, uPositiveOnly, uClusterMin, uNearZ, uFarZ, uVeilStrength, uVeilK, uEmissiveBoost, uGlintAmt, uGlintPow;
             uniform vec3 uVeilColor;
             varying float vThreshValue; varying float vClusterSize; varying float vViewZ;\n` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
            `#include <color_fragment>
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
