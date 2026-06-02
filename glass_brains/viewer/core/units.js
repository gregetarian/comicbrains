/**
 * units.js — tiny pure vector/scalar helpers. No dependencies.
 * Vectors are plain [x, y, z] arrays.
 */

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const lerp = (a, b, t) => a + (b - a) * t;

export const lerp3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
];

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

export const length = (a) => Math.hypot(a[0], a[1], a[2]);

export function normalize(a) {
    const L = length(a) || 1;
    return [a[0] / L, a[1] / L, a[2] / L];
}

/** 3x3 determinant of three column vectors — used to assert a camera basis is
 *  right-handed (positive). A mirrored/negative basis flips gl_FrontFacing and
 *  darkens lit double-sided meshes (the medial-view bug). */
export const det3 = (r, u, f) => dot(r, cross(u, f));

/** Rotate vector v around unit-ish axis by angle (radians) — Rodrigues. */
export function rotateAxis(v, axis, angle) {
    const k = normalize(axis);
    const c = Math.cos(angle), s = Math.sin(angle);
    const kv = cross(k, v);
    const kkv = dot(k, v) * (1 - c);
    return [
        v[0] * c + kv[0] * s + k[0] * kkv,
        v[1] * c + kv[1] * s + k[1] * kkv,
        v[2] * c + kv[2] * s + k[2] * kkv,
    ];
}

export const deg2rad = (d) => (d * Math.PI) / 180;
