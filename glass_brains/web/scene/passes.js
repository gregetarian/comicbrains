/**
 * passes.js — depth-edge outline pass + its depth materials. Browser side.
 *
 * Renders a layer's view-space depth into a device-resolution target, then a
 * screen-space quad detects depth discontinuities → silhouette lines. Used for
 * the black cortex outline (layer 0) and the faint per-depth voxel edges
 * (layer 1, with a threshold-aware depth material so edges track the slider).
 */
import * as THREE from 'three';

const screenQuadVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`;

const depthVert = `varying float vDepth;
void main(){ vec4 p = modelViewMatrix*vec4(position,1.); vDepth = -p.z; gl_Position = projectionMatrix*p; }`;
const depthFrag = `varying float vDepth; void main(){ gl_FragColor = vec4(vDepth/500.,0.,0.,1.); }`;

const outlineFrag = `
uniform sampler2D tDepth; uniform vec2 uResolution; uniform float uLineWidth, uThreshold, uOpacity; uniform vec3 uColor;
uniform float uVeilApply, uNearZ, uFarZ, uVeilStrength, uVeilK; uniform vec3 uVeilColor;
uniform sampler2D uClipDepth; uniform float uClipApply;
varying vec2 vUv;
void main(){
    vec2 texel = 1.0/uResolution; float w = uLineWidth;
    float c = texture2D(tDepth, vUv).r;
    float l = texture2D(tDepth, vUv-vec2(texel.x*w,0.)).r, r = texture2D(tDepth, vUv+vec2(texel.x*w,0.)).r;
    float u = texture2D(tDepth, vUv+vec2(0.,texel.y*w)).r, d = texture2D(tDepth, vUv-vec2(0.,texel.y*w)).r;
    float edge = abs(l-r)+abs(u-d), edge2 = abs(c-l)+abs(c-r)+abs(c-u)+abs(c-d);
    float s = max(smoothstep(uThreshold*0.5,uThreshold,edge), smoothstep(uThreshold,uThreshold*2.,edge2));
    // Depth-correct vs voxels: this (black surface) edge draws OVER voxel edges,
    // except where a voxel is genuinely in front of the nearest surface sample —
    // there the voxel occludes the silhouette, so let the voxel edge show.
    if (uClipApply > 0.5 && s > 0.0) {
        float surfNear = min(min(min(c,l),min(r,u)),d);   // closest surface sample (depth/500)
        float vd = texture2D(uClipDepth, vUv).r;          // voxel depth/500 (1.0 = none)
        if (vd < surfNear - 0.0008 && vd < 0.999) s = 0.0;
    }
    vec3 col = uColor;
    // Voxel edges fade with the same depth veil as the voxels (scales with the
    // veil sliders). c*500 reconstructs the view-space depth stored by the pass.
    if (uVeilApply > 0.5) {
        float zf = clamp((c*500.0 - uNearZ)/max(uFarZ-uNearZ,1e-3), 0.0, 1.0);
        float vl = log(1.0+uVeilK*zf)/log(1.0+uVeilK);
        col = mix(uColor, uVeilColor, vl*uVeilStrength);
    }
    gl_FragColor = vec4(col, s*uOpacity);
}`;

/** Threshold-aware depth material — discards voxels below the live threshold so
 *  the voxel edge outline recomputes on the fly. Bound to shared voxel uniforms. */
export function makeThresholdDepthMaterial(sharedUniforms) {
    return new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
            uThreshold: sharedUniforms.uThreshold,
            uPositiveOnly: sharedUniforms.uPositiveOnly,
            uClusterMin: sharedUniforms.uClusterMin,
        },
        vertexShader: `attribute float aValue; attribute float aClusterSize; varying float vDepth; varying float vT; varying float vC;
            void main(){ vec4 p = modelViewMatrix*vec4(position,1.); vDepth=-p.z; vT=aValue; vC=aClusterSize; gl_Position=projectionMatrix*p; }`,
        fragmentShader: `uniform float uThreshold, uPositiveOnly, uClusterMin; varying float vDepth; varying float vT; varying float vC;
            void main(){ if(abs(vT)<uThreshold) discard; if(uPositiveOnly>0.5 && vT<0.0) discard; if(vC<uClusterMin) discard; gl_FragColor=vec4(vDepth/500.,0.,0.,1.); }`,
    });
}

export class OutlinePass {
    constructor(renderer, scene, width, height, opts = {}) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = null;
        this.layer = opts.layer ?? 0;
        this.pr = renderer.getPixelRatio();
        const pw = Math.round(width * this.pr), ph = Math.round(height * this.pr);

        this.depthCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
        this.depthTarget = new THREE.WebGLRenderTarget(pw, ph, {
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.FloatType,
        });
        this.depthMaterial = opts.depthMaterial || new THREE.ShaderMaterial({
            vertexShader: depthVert, fragmentShader: depthFrag, side: THREE.DoubleSide,
        });
        const col = new THREE.Color(opts.color ?? 0x000000);
        this.outlineMaterial = new THREE.ShaderMaterial({
            vertexShader: screenQuadVert, fragmentShader: outlineFrag,
            transparent: true, depthTest: false, depthWrite: false,
            uniforms: {
                tDepth: { value: this.depthTarget.texture },
                uResolution: { value: new THREE.Vector2(pw, ph) },
                uLineWidth: { value: opts.width ?? 1.5 },
                uThreshold: { value: opts.threshold ?? 0.004 },
                uColor: { value: new THREE.Vector3(col.r, col.g, col.b) },
                uOpacity: { value: opts.opacity ?? 1.0 },
                // veil: bind to the shared voxel uniforms so edges fade with the
                // voxels and scale with the veil sliders (uVeilApply=1 for voxels).
                uVeilApply: { value: opts.veil ? 1.0 : 0.0 },
                uNearZ: opts.veil ? opts.veil.uNearZ : { value: 0 },
                uFarZ: opts.veil ? opts.veil.uFarZ : { value: 1 },
                uVeilStrength: opts.veil ? opts.veil.uVeilStrength : { value: 0 },
                uVeilK: opts.veil ? opts.veil.uVeilK : { value: 6 },
                uVeilColor: opts.veil ? opts.veil.uVeilColor : { value: new THREE.Color(0xffffff) },
                // Depth-correct clipping against another layer's depth (set by the
                // engine: the cortex outline clips against the voxel depth).
                uClipDepth: { value: null },
                uClipApply: { value: 0.0 },
            },
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outlineMaterial);
        this.quadScene = new THREE.Scene(); this.quadScene.add(this.quad);
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    setSize(width, height) {
        const pw = Math.round(width * this.pr), ph = Math.round(height * this.pr);
        this.depthTarget.setSize(pw, ph);
        this.outlineMaterial.uniforms.uResolution.value.set(pw, ph);
    }

    /** Render outline for one viewport (vp in CSS px, GL bottom-left origin). */
    update(camera, x, y, w, h) {
        const r = this.renderer;
        const prevOverride = this.scene.overrideMaterial;
        this.depthCamera.copy(camera);
        this.depthCamera.layers.set(this.layer);
        this.scene.overrideMaterial = this.depthMaterial;
        r.setRenderTarget(this.depthTarget);
        r.setScissorTest(false);
        r.clear();
        r.render(this.scene, this.depthCamera);
        this.scene.overrideMaterial = prevOverride;
        r.setRenderTarget(null);
        r.setViewport(x, y, w, h);
        r.setScissor(x, y, w, h);
        r.setScissorTest(true);
        r.render(this.quadScene, this.quadCamera);
    }

    /** Free GPU resources. Called when the engine is rebuilt (overlay add/remove). */
    dispose() {
        this.depthTarget.dispose();
        this.depthMaterial.dispose();
        this.outlineMaterial.dispose();
        this.quad.geometry.dispose();
    }
}
