/**
 * views.js — the named anatomical-view vocabulary, for the Free Canvas editor. Pure.
 *
 * Mirrors the CLI's VIEWS dict in glass_brains/render.py (keep the two in sync). Each
 * entry expands a short name into the panel fields the engine needs: a camera plane,
 * the content filter (roles / hemisphere / categories), a display title, and — for the
 * subcortical close-ups — an anatomyOpacity. This is the "selectable views" menu in
 * Free Canvas, and the same vocabulary the --views CLI flag accepts.
 */
const cortex = (hemi) => ({ roles: ['cortex', 'voxel'], hemisphere: hemi });
const subcort = (hemi, cats) => ({ roles: ['anatomy', 'voxel'], hemisphere: hemi, categories: cats });
// Cortex + subcortical together, with the subcortex rendered OPAQUE (occludes the
// cortex lines + other overlays behind it; its own voxels still show). categories
// stays null so cortex AND all subcortical of that hemisphere show.
const cortexSubcortOpaque = (hemi) => ({ roles: ['cortex', 'anatomy', 'voxel'], hemisphere: hemi, categories: null, anatomyStyle: 'opaque' });

export const VIEWS = {
    left_lateral:  { plane: 'left_lateral',  title: 'L Lateral', content: cortex('lh') },
    right_lateral: { plane: 'right_lateral', title: 'R Lateral', content: cortex('rh') },
    left_medial:   { plane: 'left_medial',   title: 'L Medial',  content: cortex('lh') },
    right_medial:  { plane: 'right_medial',  title: 'R Medial',  content: cortex('rh') },
    anterior:      { plane: 'anterior',      title: 'Anterior',  content: cortex('both') },
    posterior:     { plane: 'posterior',     title: 'Posterior', content: cortex('both') },
    dorsal:        { plane: 'dorsal',        title: 'Dorsal',    content: cortex('both') },
    ventral:       { plane: 'ventral',       title: 'Ventral',   content: cortex('both') },
    subcortical_l: { plane: 'left_lateral',  title: 'Subcort L', content: subcort('lh', ['subcort_l', 'cereb_l', 'brainstem']), anatomyOpacity: 0.55 },
    subcortical_r: { plane: 'right_lateral', title: 'Subcort R', content: subcort('rh', ['subcort_r', 'cereb_r', 'brainstem']), anatomyOpacity: 0.55 },
    cortex_subcort_l: { plane: 'left_lateral',  title: 'L + Subcort (opaque)', content: cortexSubcortOpaque('lh') },
    cortex_subcort_r: { plane: 'right_lateral', title: 'R + Subcort (opaque)', content: cortexSubcortOpaque('rh') },
    cortex_subcort:   { plane: 'dorsal',        title: 'Cortex + Subcort (opaque)', content: cortexSubcortOpaque('both') },
};

/** Order shown in the view picker. */
export const VIEW_ORDER = [
    'left_lateral', 'right_lateral', 'left_medial', 'right_medial',
    'anterior', 'posterior', 'dorsal', 'ventral', 'subcortical_l', 'subcortical_r',
    'cortex_subcort_l', 'cortex_subcort_r', 'cortex_subcort',
];

/** Apply a named view onto a panel object (mutates camera/content/title/anatomyOpacity). */
export function applyView(panel, name) {
    const v = VIEWS[name];
    if (!v) return panel;
    panel.camera = { plane: v.plane };
    panel.content = { ...v.content };
    panel.title = v.title;
    panel.view = name;                                   // remember the picked view (for the picker + CLI)
    panel.anatomyOpacity = v.anatomyOpacity != null ? v.anatomyOpacity : null;
    return panel;
}

/** Best-guess the view name a panel currently shows (for initialising the picker). */
export function panelViewName(panel) {
    if (panel.view && VIEWS[panel.view]) return panel.view;
    const plane = panel.camera && panel.camera.plane;
    const cats = panel.content && panel.content.categories;
    if (cats && cats.includes('subcort_l')) return 'subcortical_l';
    if (cats && cats.includes('subcort_r')) return 'subcortical_r';
    const hemi = panel.content && panel.content.hemisphere;
    for (const name of VIEW_ORDER) {
        const v = VIEWS[name];
        if (v.plane === plane && v.content.hemisphere === hemi && !v.content.categories) return name;
    }
    return plane || 'left_lateral';
}
