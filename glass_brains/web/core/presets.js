/**
 * presets.js — named layout presets as plain config fragments. Pure.
 *
 * A preset only specifies `layout` (+ optional style tweaks); everything else
 * comes from DEFAULTS via normalizeConfig. The 4-panel default and the legacy
 * 9-panel view are expressed in the SAME vocabulary — no code branches on panel
 * identity, so both render identically in the browser and headlessly.
 */
import { normalizeConfig } from './config-schema.js';

const cortexVoxel = (hemisphere) => ({ roles: ['cortex', 'voxel'], hemisphere });
// Cortex panels share one world scale so each brain is the same physical size.
const SHARED = { fit: 'shared' };

export const FOUR_PANEL = {
    layout: {
        grid: { rows: 2, cols: 2, rowWeights: [1, 1], colWeights: [1, 1] },
        panels: [
            { id: 'L_lat', title: 'L Lateral', cell: { row: 0, col: 0 }, camera: { plane: 'left_lateral' },  content: cortexVoxel('lh'), framing: SHARED },
            { id: 'R_lat', title: 'R Lateral', cell: { row: 0, col: 1 }, camera: { plane: 'right_lateral' }, content: cortexVoxel('rh'), framing: SHARED },
            { id: 'L_med', title: 'L Medial',  cell: { row: 1, col: 0 }, camera: { plane: 'left_medial' },   content: cortexVoxel('lh'), framing: SHARED },
            { id: 'R_med', title: 'R Medial',  cell: { row: 1, col: 1 }, camera: { plane: 'right_medial' },  content: cortexVoxel('rh'), framing: SHARED },
        ],
    },
};

const subcort = (hemi, cats) => ({
    roles: ['anatomy', 'voxel'], hemisphere: hemi, categories: cats,
});

// 8-panel: cortex profile views on top, extras (anterior/dorsal/subcortical)
// below. 2×4 so every panel — including the axial Dorsal — gets a full cell.
export const NINE_PANEL = {
    layout: {
        grid: { rows: 2, cols: 4, rowWeights: [1, 1], colWeights: [1, 1, 1, 1] },
        panels: [
            { id: 'L_lat', title: 'L Lateral', cell: { row: 0, col: 0 }, camera: { plane: 'left_lateral' },  content: cortexVoxel('lh'), framing: SHARED },
            { id: 'R_lat', title: 'R Lateral', cell: { row: 0, col: 1 }, camera: { plane: 'right_lateral' }, content: cortexVoxel('rh'), framing: SHARED },
            { id: 'L_med', title: 'L Medial',  cell: { row: 0, col: 2 }, camera: { plane: 'left_medial' },   content: cortexVoxel('lh'), framing: SHARED },
            { id: 'R_med', title: 'R Medial',  cell: { row: 0, col: 3 }, camera: { plane: 'right_medial' },  content: cortexVoxel('rh'), framing: SHARED },
            { id: 'ant',   title: 'Anterior',  cell: { row: 1, col: 0 }, camera: { plane: 'anterior' },      content: cortexVoxel('both'), framing: SHARED },
            { id: 'dor',   title: 'Dorsal',    cell: { row: 1, col: 1 }, camera: { plane: 'dorsal' },        content: cortexVoxel('both'), framing: SHARED },
            { id: 'sub_l', title: 'Subcort L', cell: { row: 1, col: 2 }, camera: { plane: 'left_lateral' },  content: subcort('lh', ['subcort_l', 'cereb_l', 'brainstem']), anatomyOpacity: 0.55 },
            { id: 'sub_r', title: 'Subcort R', cell: { row: 1, col: 3 }, camera: { plane: 'right_lateral' }, content: subcort('rh', ['subcort_r', 'cereb_r', 'brainstem']), anatomyOpacity: 0.55 },
        ],
    },
};

// Overview: one of each canonical view — a lateral, anterior, dorsal, and medial.
export const OVERVIEW = {
    layout: {
        grid: { rows: 2, cols: 2, rowWeights: [1, 1], colWeights: [1, 1] },
        panels: [
            { id: 'L_lat', title: 'L Lateral', cell: { row: 0, col: 0 }, camera: { plane: 'left_lateral' },  content: cortexVoxel('lh'),   framing: SHARED },
            { id: 'ant',   title: 'Anterior',  cell: { row: 0, col: 1 }, camera: { plane: 'anterior' },      content: cortexVoxel('both'), framing: SHARED },
            { id: 'dor',   title: 'Dorsal',    cell: { row: 1, col: 0 }, camera: { plane: 'dorsal' },        content: cortexVoxel('both'), framing: SHARED },
            { id: 'R_med', title: 'R Medial',  cell: { row: 1, col: 1 }, camera: { plane: 'right_medial' },  content: cortexVoxel('rh'),   framing: SHARED },
        ],
    },
};

export const PRESETS = { fourPanel: FOUR_PANEL, ninePanel: NINE_PANEL, overview: OVERVIEW };

/** Resolve a preset name or a raw config object → a normalized config. */
export function resolveConfig(nameOrConfig, overrides = {}) {
    const base = typeof nameOrConfig === 'string'
        ? (PRESETS[nameOrConfig] || (() => { throw new Error(`Unknown preset: ${nameOrConfig}`); })())
        : (nameOrConfig || FOUR_PANEL);
    // merge order: preset, then overrides (overrides win)
    return normalizeConfig(mergeRaw(base, overrides));
}

function mergeRaw(a, b) {
    // shallow-ish merge sufficient for {layout, style} fragments
    return {
        ...a, ...b,
        layout: b.layout ?? a.layout,
        style: { ...(a.style || {}), ...(b.style || {}) },
    };
}
