/**
 * visibility.js — declarative per-panel mesh visibility. Pure.
 *
 * Replaces the tangled categoryVisible/applyVisibility boolean logic. A panel
 * declares WHAT it contains (roles, hemisphere, categories, representation);
 * this answers, per mesh, whether it shows. Because hemisphere is a first-class
 * filter, the "far hemisphere bleeds through the lateral view" bug is impossible.
 *
 * meshMeta = { role:'cortex'|'anatomy'|'voxel', hemisphere:'lh'|'rh'|'mid'|null,
 *              structure, category, variant:'blocky'|'smooth'|null }
 * panelContent = { roles:[...], hemisphere:'lh'|'rh'|'both', categories:null|[...],
 *                  representation:null|'blocky'|'smooth' }
 */

export function visible(panelContent, meshMeta, style = {}) {
    const c = panelContent || {};

    // role gate
    if (c.roles && !c.roles.includes(meshMeta.role)) return false;

    // category gate (e.g. a subcortical panel limited to subcort_l/cereb_l/brainstem)
    if (c.categories && meshMeta.category && !c.categories.includes(meshMeta.category)) {
        return false;
    }

    // hemisphere gate — midline structures (brainstem) are exempt
    const hemi = c.hemisphere || 'both';
    if (hemi !== 'both' && meshMeta.hemisphere && meshMeta.hemisphere !== 'mid'
        && meshMeta.hemisphere !== hemi) {
        return false;
    }

    // variant gate: voxels (blocky/smooth) and cortex (pial/inflated) each keep
    // both variants loaded; only the active one shows.
    if (meshMeta.variant) {
        if (meshMeta.role === 'voxel') {
            const rep = c.representation || (style.voxel && style.voxel.representation) || 'blocky';
            if (meshMeta.variant !== rep) return false;
        } else if (meshMeta.role === 'cortex') {
            const surf = style.cortexSurface || 'pial';
            if (meshMeta.variant !== surf) return false;
        }
    }

    return true;
}
