/**
 * framing.js — geometry-based auto-framing. Pure.
 *
 * Computes an orthographic camera extent that tightly fits the geometry visible
 * in a panel, replacing the old hand-tuned per-view "footprint" constants.
 * Because each panel frames only the geometry it actually shows, "tight fill"
 * and "near-hemisphere only" fall out for free, and we get a tight per-panel
 * near/far that feeds the depth-veil shader.
 */
import { resolveCamera, cameraBasis } from './cameras.js';
import { normalize, sub, dot } from './units.js';

const EMPTY = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

/** AABB of an interleaved xyz Float32Array (or plain array). */
export function aabbOfPositions(positions) {
    const b = EMPTY();
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = positions[i + k];
            if (v < b.min[k]) b.min[k] = v;
            if (v > b.max[k]) b.max[k] = v;
        }
    }
    return b;
}

export function mergeAABB(boxes) {
    const b = EMPTY();
    for (const box of boxes) {
        if (!box) continue;
        for (let k = 0; k < 3; k++) {
            if (box.min[k] < b.min[k]) b.min[k] = box.min[k];
            if (box.max[k] > b.max[k]) b.max[k] = box.max[k];
        }
    }
    return b;
}

export const aabbCenter = (b) => [
    (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
];
export const aabbHalf = (b) => [
    (b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2,
];
export const aabbValid = (b) => b.max[0] >= b.min[0];

/** Support half-span of an axis-aligned box (half-extents he) onto unit axis a. */
const projHalf = (he, a) => Math.abs(he[0] * a[0]) + Math.abs(he[1] * a[1]) + Math.abs(he[2] * a[2]);

/**
 * View-space depth range (vViewZ = distance in front of the camera) of an AABB.
 * Used to anchor the depth veil to the nearest/farthest VOXEL specifically, so
 * the closest voxel is always un-veiled and it scales back from there.
 */
export function viewDepthRange(aabb, position, lookAt) {
    const fwd = normalize(sub(lookAt, position));
    const c = aabbCenter(aabb), he = aabbHalf(aabb);
    const depth = dot(sub(c, position), fwd);
    const halfD = projHalf(he, fwd);
    return { nearZ: depth - halfD, farZ: depth + halfD };
}

/**
 * Frame `aabb` for a panel.
 * @param {object} aabb - {min,max}
 * @param {object} cameraSpec - {plane} | {pose}
 * @param {number} aspect - panel pixel width/height
 * @param {object} [opts] - { margin=1.06, distance=400, pad=10 }
 * @returns pose + orthographic frustum: {position,up,lookAt, left,right,top,bottom, near,far, ext}
 */
export function frameContent(aabb, cameraSpec, aspect, opts = {}) {
    const { margin = 1.06, distance = 400, pad = 10, tilt = null } = opts;
    const center = aabbValid(aabb) ? aabbCenter(aabb) : [0, 0, 0];
    const he = aabbValid(aabb) ? aabbHalf(aabb) : [80, 80, 80];

    const pose = resolveCamera(cameraSpec, center, distance, tilt);
    const { r, u, f } = cameraBasis(pose);

    const halfW = projHalf(he, r);
    const halfH = projHalf(he, u);
    const halfD = projHalf(he, f);

    const ext = Math.max(halfH, halfW / aspect) * margin;
    const near = Math.max(1, distance - halfD - pad);
    const far = distance + halfD + pad;

    return {
        position: pose.position, up: pose.up, lookAt: pose.lookAt,
        left: -ext * aspect, right: ext * aspect, top: ext, bottom: -ext,
        near, far, ext,
        // view-space depth range of the content, for the depth veil (vViewZ).
        nearZ: distance - halfD, farZ: distance + halfD,
    };
}
