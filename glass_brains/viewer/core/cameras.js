/**
 * cameras.js — named anatomical view planes → camera poses. Pure.
 *
 * Coordinate frame is RAS/MNI mm: +x = right, +y = anterior, +z = superior.
 * `dir` is the direction from the brain centre TO the camera, so the camera
 * sits at  centre + dir*distance  and looks back at the centre.
 *
 * IMPORTANT (medial-lighting lesson): medial views are the genuinely OPPOSITE
 * side camera, never a horizontally-mirrored projection. A mirror flips the
 * view-basis determinant → gl_FrontFacing inverts → lit DoubleSide normals flip
 * → medial panels render dark. `poseFromPlane` keeps a right-handed basis.
 */
import { add, scale, normalize, sub, cross, dot, rotateAxis, deg2rad } from './units.js';

export const PLANES = {
    left_lateral:  { dir: [-1, 0, 0], up: [0, 0, 1], hemisphere: 'lh' },
    left_medial:   { dir: [ 1, 0, 0], up: [0, 0, 1], hemisphere: 'lh' },
    right_lateral: { dir: [ 1, 0, 0], up: [0, 0, 1], hemisphere: 'rh' },
    right_medial:  { dir: [-1, 0, 0], up: [0, 0, 1], hemisphere: 'rh' },
    anterior:      { dir: [0,  1, 0], up: [0, 0, 1], hemisphere: 'both' },
    posterior:     { dir: [0, -1, 0], up: [0, 0, 1], hemisphere: 'both' },
    dorsal:        { dir: [0, 0,  1], up: [0, 1, 0], hemisphere: 'both' },
    ventral:       { dir: [0, 0, -1], up: [0, 1, 0], hemisphere: 'both' },
};

/**
 * Resolve a camera spec to a concrete pose.
 * @param {object} cameraSpec - { plane: 'left_lateral' } OR { pose: {position,up,lookAt} }
 * @param {number[]} center - point to look at (usually the content AABB centre)
 * @param {number} distance - mm from centre (orthographic, so size-independent)
 * @returns {{ position, up, lookAt, hemisphere }}
 */
export function resolveCamera(cameraSpec, center = [0, 0, 0], distance = 400, tilt = null) {
    if (cameraSpec.pose) {
        const p = cameraSpec.pose;
        return {
            position: p.position,
            up: p.up,
            lookAt: p.lookAt ?? center,
            hemisphere: cameraSpec.hemisphere ?? 'both',
        };
    }
    const plane = PLANES[cameraSpec.plane];
    if (!plane) throw new Error(`Unknown camera plane: ${cameraSpec.plane}`);
    const up = plane.up.slice();

    // centre→camera offset, optionally tilted a few degrees off-axis for a
    // slight oblique (depth cue). The tilt is a FIXED WORLD-space rotation
    // (azimuth around world +z, elevation around world +x) applied identically
    // to every view — so the rig is consistent in space and opposite views
    // (L/R lateral, L/R medial) come out mirror-consistent, as if looking at one
    // consistently-tilted brain. Screen-up stays vertical (up is not rotated).
    let rel = scale(plane.dir, distance);
    if (tilt && (tilt.azimuth || tilt.elevation)) {
        rel = rotateAxis(rel, [0, 0, 1], deg2rad(tilt.azimuth || 0));
        rel = rotateAxis(rel, [1, 0, 0], deg2rad(tilt.elevation || 0));
    }
    return {
        position: add(center, rel),
        up,
        lookAt: center.slice(),
        hemisphere: plane.hemisphere,
    };
}

/**
 * Orthonormal camera basis from a pose.
 * forward (f) points INTO the scene (lookAt - position); right (r) and up (u)
 * span the image plane. Returns a right-handed {r, u, f} (det>0).
 */
export function cameraBasis(pose) {
    const f = normalize(sub(pose.lookAt, pose.position));
    // right = up × forward  gives a right-handed basis with the image-up matching `up`.
    let r = normalize(cross(pose.up, f));
    // Guard against degenerate up ∥ forward.
    if (!isFinite(r[0]) || (r[0] === 0 && r[1] === 0 && r[2] === 0)) {
        r = normalize(cross([0, 1, 0], f));
    }
    const u = cross(f, r); // already unit, right-handed
    return { r, u, f };
}
