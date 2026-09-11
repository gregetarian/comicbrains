/**
 * Unit tests for the pure core. Run with:  node --test  (from viewer/)
 * No THREE, no DOM — these guard the load-bearing geometry/visibility/colour math.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { det3, normalize, cross, sub } from './units.js';
import { resolveCamera, cameraBasis, PLANES } from './cameras.js';
import { aabbOfPositions, mergeAABB, frameContent, viewDepthRangeOfPositions } from './framing.js';
import { layoutGrid, freeRect } from './grid.js';
import { visible } from './visibility.js';
import { outlinePlan } from './outline-plan.js';
import { valueToT, resolveColormap, loadColormaps, sampleLUT, deriveMaxAbs, colorbarScale } from './colormap.js';
import { normalizeConfig, validateConfig, overlayStyle, DEFAULTS } from './config-schema.js';
import { applyView, panelViewName, VIEWS } from './views.js';
import { resolveConfig } from './presets.js';
import { isFreeFigure, usesFigureSpec, buildSpec, buildRenderText } from '../controls/cli-export.js';
import { rotateAroundWorldAxis, snapPlaneForAxis, wrapDegrees } from './rotation.js';
import { normalizeTemplateBundle, validateTemplateBundle } from './template-bundle.js';

test('default display is blocky, depth-correct, and has no intensity or cluster cutoff', () => {
    assert.equal(DEFAULTS.style.voxel.representation, 'blocky');
    assert.equal(DEFAULTS.style.outline.overVoxelOpacity, 0);
    assert.equal(DEFAULTS.style.outline.voxelLineMode, 'alpha');
    assert.equal(DEFAULTS.style.voxel.depthCut, 0);
    assert.equal(DEFAULTS.style.voxel.clusterMin, 0);
    const cfg = normalizeConfig({
        style: { threshold: 0 },
        layout: { panels: [{ id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } }] },
    });
    assert.equal(cfg.style.threshold, 0);
    assert.equal(cfg.style.voxel.representation, 'blocky');
    assert.equal(cfg.style.outline.overVoxelOpacity, 0);
    assert.equal(cfg.style.outline.voxelLineMode, 'alpha');
    assert.equal(cfg.style.voxel.depthCut, 0);
    assert.equal(cfg.style.voxel.depthMode, 'manual');
    assert.equal(cfg.style.voxel.clusterMin, 0);
});

test('automatic depth ownership resolves per overlay and validates its modes', () => {
    const cfg = { style: { voxel: { depthMode: 'clusters' }, overlays: [{ voxel: { depthMode: 'anatomy' } }] } };
    assert.equal(overlayStyle(cfg, 0).depthMode, 'anatomy');
    assert.equal(overlayStyle(cfg, 1).depthMode, 'clusters');
    const panel = { id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } };
    for (const depthMode of ['manual', 'clusters', 'anatomy']) {
        assert.equal(validateConfig({ style: { voxel: { depthMode } }, layout: { panels: [panel] } }).ok, true);
    }
    assert.equal(validateConfig({ style: { voxel: { depthMode: 'rear-most' } }, layout: { panels: [panel] } }).ok, false);
});

test('blob edge mode defaults by representation and can be overridden', () => {
    const base = { style: { voxel: { representation: 'blocky', edges: { enabled: true, mode: 'auto' } }, overlays: [] } };
    assert.equal(overlayStyle(base, 0).edges.mode, 'full');
    base.style.voxel.representation = 'smooth';
    assert.equal(overlayStyle(base, 0).edges.mode, 'outer');
    base.style.overlays = [{ voxel: { edges: { mode: 'full' } } }];
    assert.equal(overlayStyle(base, 0).edges.mode, 'full');
    base.style.voxel.representation = 'blocky';
    base.style.overlays = [{ voxel: { edges: { mode: 'outer' } } }];
    assert.equal(overlayStyle(base, 0).edges.mode, 'outer');
});

test('viewer-relative depth cut resolves per overlay and validates as a 0..1 amount', () => {
    const cfg = { style: { voxel: { depthCut: 0.25 }, overlays: [{ voxel: { depthCut: 0.75 } }] } };
    assert.equal(overlayStyle(cfg, 0).depthCut, 0.75);
    assert.equal(overlayStyle(cfg, 1).depthCut, 0.25);
    const panel = { id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } };
    assert.equal(validateConfig({ style: { voxel: { depthCut: 1 } }, layout: { panels: [panel] } }).ok, true);
    assert.equal(validateConfig({ style: { voxel: { depthCut: 1.01 } }, layout: { panels: [panel] } }).ok, false);
    assert.equal(validateConfig({ style: { overlays: [{ voxel: { depthCut: -0.01 } }] }, layout: { panels: [panel] } }).ok, false);
});

// --- cameras: every plane yields a right-handed (positive-determinant) basis ---
test('camera bases are right-handed (no mirror → medials light correctly)', () => {
    for (const name of Object.keys(PLANES)) {
        const pose = resolveCamera({ plane: name }, [0, 0, 0], 400);
        const { r, u, f } = cameraBasis(pose);
        assert.ok(det3(r, u, f) > 0.9, `${name} basis determinant must be ~+1, got ${det3(r, u, f)}`);
    }
});

test('world-space tilt makes L/R lateral mirror-consistent (antipodal positions)', () => {
    const tilt = { azimuth: 8, elevation: 6 };
    const l = resolveCamera({ plane: 'left_lateral' }, [0, 0, 0], 400, tilt);
    const r = resolveCamera({ plane: 'right_lateral' }, [0, 0, 0], 400, tilt);
    for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(l.position[k] + r.position[k]) < 1e-6, `axis ${k}: L and R must mirror about centre`);
    }
});

test('lateral vs medial of the same hemisphere are opposite-side cameras', () => {
    const lat = resolveCamera({ plane: 'left_lateral' }, [0, 0, 0], 400);
    const med = resolveCamera({ plane: 'left_medial' }, [0, 0, 0], 400);
    assert.ok(lat.position[0] < 0 && med.position[0] > 0, 'L lateral camera at -x, L medial at +x');
});

// --- per-panel rotation (Free Canvas l/r/u/d/roll): orbit preserves distance + handedness ---
test('resolveCamera rotate is a no-op at zero and absent', () => {
    const base = resolveCamera({ plane: 'left_lateral' }, [0, 0, 0], 400, { azimuth: 8, elevation: 6 });
    const zero = resolveCamera({ plane: 'left_lateral' }, [0, 0, 0], 400, { azimuth: 8, elevation: 6 }, { yaw: 0, pitch: 0, roll: 0 });
    assert.deepEqual(zero.position.map((x) => Math.round(x * 1e6)), base.position.map((x) => Math.round(x * 1e6)));
});

test('resolveCamera orbit keeps distance-from-centre and a right-handed basis', () => {
    const center = [0, -10, 5];
    const r0 = resolveCamera({ plane: 'left_lateral' }, center, 400);
    for (const rot of [{ yaw: 40 }, { pitch: 35 }, { yaw: -25, pitch: 20, roll: 15 }, { pitch: 88 }]) {
        const r = resolveCamera({ plane: 'left_lateral' }, center, 400, null, rot);
        const d0 = Math.hypot(...sub(r0.position, center));
        const d = Math.hypot(...sub(r.position, center));
        assert.ok(Math.abs(d - d0) < 1e-6, `orbit must preserve radius (rot ${JSON.stringify(rot)})`);
        const { r: rr, u, f } = cameraBasis(r);
        assert.ok(det3(rr, u, f) > 0.9, `basis must stay right-handed (rot ${JSON.stringify(rot)})`);
        assert.ok(r.position.every(Number.isFinite) && r.up.every(Number.isFinite), 'no NaN at extreme pitch');
    }
});

test('MNI-axis gizmo rotations preserve radius and camera handedness', () => {
    const center = [4, -12, 7];
    const base = resolveCamera({ plane: 'right_medial' }, center, 400);
    for (const rot of [{ worldX: 40 }, { worldY: -35 }, { worldZ: 95 },
        { yaw: 10, pitch: -20, worldX: 15, worldY: 25, worldZ: -30 }]) {
        const pose = resolveCamera({ plane: 'right_medial' }, center, 400, null, rot);
        assert.ok(Math.abs(Math.hypot(...sub(pose.position, center))
            - Math.hypot(...sub(base.position, center))) < 1e-6);
        const { r, u, f } = cameraBasis(pose);
        assert.ok(det3(r, u, f) > 0.9);
    }
});

test('MNI gizmo helpers wrap angles and snap without changing hemisphere intent', () => {
    assert.equal(wrapDegrees(190), -170);
    assert.equal(rotateAroundWorldAxis({ worldX: 175 }, 'x', 15).worldX, -170);
    assert.equal(snapPlaneForAxis('x', 1, 'lh'), 'left_medial');
    assert.equal(snapPlaneForAxis('x', -1, 'rh'), 'right_medial');
    assert.equal(snapPlaneForAxis('y', -1, 'both'), 'posterior');
    assert.equal(snapPlaneForAxis('z', 1, 'both'), 'dorsal');
});

// --- framing: extent fits a known AABB; brain is centred ---
test('frameContent fits the AABB with margin and centres on it', () => {
    // a box 180(AP) x 140(LR) x 130(IS), centred at (0,-15,5)
    const aabb = { min: [-70, -105, -60], max: [70, 75, 70] };
    const f = frameContent(aabb, { plane: 'left_lateral' }, 1.0, { margin: 1.06 });
    // sagittal view: width≈AP=180, height≈IS=130 → half-height ext≈ max(65, 90)*1.06 ≈ 95.4
    assert.ok(f.ext > 90 && f.ext < 100, `ext ~95, got ${f.ext}`);
    assert.ok(f.near > 0, 'near plane positive');
    assert.ok(f.far > f.near, 'far > near');
    // lookAt is the AABB centre
    assert.deepEqual(f.lookAt.map((x) => Math.round(x)), [0, -15, 5]);
});

test('aabb helpers merge correctly', () => {
    const a = aabbOfPositions(new Float32Array([0, 0, 0, 10, 0, 0]));
    const b = aabbOfPositions(new Float32Array([-5, 2, 0]));
    const m = mergeAABB([a, b]);
    assert.deepEqual(m.min, [-5, 0, 0]);
    assert.deepEqual(m.max, [10, 2, 0]);
});

test('sampled anatomical depth follows each panel current viewing direction', () => {
    const pts = new Float32Array([
        0, 0, 70,
        0, 50, 0,
        0, 0, 0,
    ]);
    const dorsal = viewDepthRangeOfPositions(pts, [0, 0, 400], [0, 0, 0]);
    const anterior = viewDepthRangeOfPositions(pts, [0, 400, 0], [0, 0, 0]);
    assert.deepEqual(dorsal, { nearZ: 330, farZ: 400 });
    assert.deepEqual(anterior, { nearZ: 350, farZ: 400 });
    const oblique = viewDepthRangeOfPositions(pts, [0, 400, 400], [0, 0, 0]);
    assert.ok(oblique.nearZ < oblique.farZ);
    assert.notDeepEqual(oblique, dorsal);
    assert.notDeepEqual(oblique, anterior);
});

// --- grid: cells exactly tile the container ---
test('grid spans tile the container exactly', () => {
    const g = layoutGrid({ width: 1000, height: 600, rows: 3, cols: 3, rowWeights: [0.4, 0.2, 0.4] });
    const r0 = g.rect(0, 0), r2c2 = g.rect(2, 2);
    assert.equal(r0.cssLeft, 0);
    assert.equal(r0.cssTop, 0);
    // bottom-right cell ends exactly at width/height
    assert.equal(r2c2.cssLeft + r2c2.w, 1000);
    assert.equal(r2c2.cssTop + r2c2.h, 600);
    // GL y origin bottom-left: top row sits at the top of the canvas
    assert.equal(r0.y + r0.h, 600);
});

// --- visibility: the lateral far-hemisphere bug is structurally impossible ---
test('hemisphere filter hides the far hemisphere', () => {
    const content = { roles: ['cortex', 'voxel'], hemisphere: 'lh' };
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'lh_cortex', variant: 'blocky' }), true);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'rh', category: 'rh_cortex', variant: 'blocky' }), false);
});

test('subcort panel shows only its categories; representation gate works', () => {
    const content = { roles: ['anatomy', 'voxel'], hemisphere: 'lh', categories: ['subcort_l', 'cereb_l', 'brainstem'] };
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'blocky' }), true);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'lh_cortex', variant: 'blocky' }), false);
    // smooth variant hidden when style asks for blocky
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'smooth' },
        { voxel: { representation: 'blocky' } }), false);
});

test('paired cortex + contralateral-interior views retain the selected voxel representation', () => {
    const blocky = { voxel: { representation: 'blocky', subcortexRepresentation: 'blocky' } };
    const smooth = { voxel: { representation: 'smooth', subcortexRepresentation: 'smooth' } };
    const surface = { voxel: { representation: 'surface', subcortexRepresentation: 'blocky' } };
    for (const [view, cortexHemi, internalHemi, cortexCat, subCat, cerebCat, wrongSub, wrongCereb] of [
        ['cortex_subcort_l', 'lh', 'rh', 'lh_cortex', 'subcort_r', 'cereb_r', 'subcort_l', 'cereb_l'],
        ['cortex_subcort_r', 'rh', 'lh', 'rh_cortex', 'subcort_l', 'cereb_l', 'subcort_r', 'cereb_r'],
        ['cortex_subcort_lm', 'lh', 'rh', 'lh_cortex', 'subcort_r', 'cereb_r', 'subcort_l', 'cereb_l'],
        ['cortex_subcort_rm', 'rh', 'lh', 'rh_cortex', 'subcort_l', 'cereb_l', 'subcort_r', 'cereb_r'],
    ]) {
        const content = VIEWS[view].content;
        assert.equal(content.representation, undefined);
        assert.deepEqual(content.voxelCategories, [cortexCat, subCat, cerebCat, 'brainstem']);
        assert.deepEqual(content.anatomyCategories, [subCat, cerebCat, 'brainstem']);
        assert.equal(visible(content, { role: 'voxel', hemisphere: cortexHemi, category: cortexCat, variant: 'blocky' }, blocky), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: cortexHemi, category: cortexCat, variant: 'smooth' }, blocky), false);
        assert.equal(visible(content, { role: 'voxel', hemisphere: cortexHemi, category: cortexCat, variant: 'smooth' }, smooth), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: cortexHemi, category: cortexCat, variant: 'surface' }, surface), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi, category: subCat, variant: 'blocky' }, blocky), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi, category: subCat, variant: 'smooth' }, smooth), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi, category: subCat, variant: 'blocky' }, surface), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi, category: cerebCat, variant: 'blocky' }, blocky), true);
        assert.equal(visible(content, { role: 'anatomy', hemisphere: internalHemi, category: subCat }, blocky), true);
        assert.equal(visible(content, { role: 'anatomy', hemisphere: internalHemi, category: cerebCat }, blocky), true);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi === 'lh' ? 'rh' : 'lh', category: wrongSub, variant: 'blocky' }, blocky), false);
        assert.equal(visible(content, { role: 'voxel', hemisphere: internalHemi === 'lh' ? 'rh' : 'lh', category: wrongCereb, variant: 'blocky' }, blocky), false);
        assert.equal(visible(content, { role: 'anatomy', hemisphere: internalHemi === 'lh' ? 'rh' : 'lh', category: wrongCereb }, blocky), false);
    }
});

// --- anatomical outline planning: cortex and subcortex remain independent groups ---
test('outline plan keeps the inherited default in combined fold + silhouette passes', () => {
    const p = outlinePlan({
        enabled: true, color: '#111111', width: 4, threshold: 0.01,
        anatomyWidthMul: 0.75, anatomyColor: '#222222',
        silhouette: { enabled: true, color: null, width: null },
    }, { widthMul: 1.5, thresholdMul: 2 });
    assert.equal(p.folds, true);
    assert.equal(p.splitSilhouettes, false);
    assert.equal(p.foldBgMode, 0);
    assert.equal(p.threshold, 0.02);
    assert.deepEqual(p.cortexFold, { color: '#111111', width: 6 });
    assert.deepEqual(p.anatomyFold, { color: '#222222', width: 4.5 });
});

test('outline plan splits custom silhouettes into cortex and subcortex styles', () => {
    const p = outlinePlan({
        enabled: false, color: '#111111', width: 3, threshold: 0.005,
        anatomyWidthMul: 0.5, anatomyColor: '#333333',
        silhouette: { enabled: true, color: '#abcdef', width: 8 },
    });
    assert.equal(p.folds, false);
    assert.equal(p.splitSilhouettes, true);
    assert.equal(p.foldBgMode, 1);
    assert.deepEqual(p.cortexSilhouette, { color: '#abcdef', width: 8 });
    assert.deepEqual(p.anatomySilhouette, { color: '#abcdef', width: 4 });
});

test('outline plan gives custom silhouettes ownership of background edges', () => {
    const p = outlinePlan({
        enabled: true, color: '#000000', width: 2,
        silhouette: { enabled: true, color: null, width: 6 },
    });
    assert.equal(p.folds, true);
    assert.equal(p.splitSilhouettes, true);
    assert.equal(p.foldBgMode, 1);
});

test('outline plan can disable silhouettes while retaining interior folds only', () => {
    const p = outlinePlan({
        enabled: true, color: '#000000', width: 2,
        silhouette: { enabled: false, color: null, width: null },
    });
    assert.equal(p.folds, true);
    assert.equal(p.splitSilhouettes, false);
    assert.equal(p.foldBgMode, 1);
});

// --- colormap: positive-only data never collapses onto a diverging white centre ---
test('valueToT positive-only-guard pushes values into the LUT hot half', () => {
    // sequential mode, no guard: a small positive value maps near 0
    assert.ok(valueToT(0.1, 1, 'sequential', 0.5, false) < 0.4);
    // with the diverging-on-positive guard, the same value is pushed to >=0.5
    assert.ok(valueToT(0.1, 1, 'sequential', 0.5, true) >= 0.5);
    assert.equal(valueToT(0, 1, 'sequential', 0.5, true), 0.5);
});

test('valueToT negative-only-guard confines values to the LUT cool half', () => {
    // a small negative value, no guard: clamps to 0 (collapses to the LUT cool extreme)
    // with the diverging-on-negative guard, it sits just below the white centre and never on it
    assert.ok(valueToT(-0.1, 1, 'sequential', 0.5, false, true) < 0.5);
    assert.ok(valueToT(-0.1, 1, 'sequential', 0.5, false, true) > 0.0);
    assert.equal(valueToT(0, 1, 'sequential', 0.5, false, true), 0.5);   // zero → white centre
    assert.equal(valueToT(-1, 1, 'sequential', 0.5, false, true), 0.0);  // most negative → cool extreme
});

test('valueToT explicit [vmin,vmax] is a linear map across the whole LUT', () => {
    const cr = [2, 8];   // asymmetric colour limits
    assert.equal(valueToT(2, 1, 'diverging', 1.0, false, false, cr), 0);    // vmin → bottom of LUT
    assert.equal(valueToT(8, 1, 'diverging', 1.0, false, false, cr), 1);    // vmax → top of LUT
    assert.equal(valueToT(5, 1, 'diverging', 1.0, false, false, cr), 0.5);  // midpoint (gamma 1)
    assert.equal(valueToT(0, 1, 'sequential', 1.0, false, false, cr), 0);   // below vmin clamps to 0
    assert.equal(valueToT(99, 1, 'sequential', 1.0, false, false, cr), 1);  // above vmax clamps to 1
    assert.ok(Math.abs(valueToT(5, 1, 'sequential', 0.5, false, false, cr) - Math.sqrt(0.5)) < 1e-6); // gamma lifts mid
});

test('deriveMaxAbs: an explicit clim overrides the data-derived fallback', () => {
    assert.equal(deriveMaxAbs(null, 7), 7);        // no clim -> data fallback
    assert.equal(deriveMaxAbs(8, 7), 8);           // scalar -> |v|
    assert.equal(deriveMaxAbs([-3, 5], 7), 5);     // pair -> larger magnitude bound
    assert.equal(deriveMaxAbs([-9, 2], 7), 9);
});

test('colorbarScale preserves zero and greys the excluded positive vmin interval', () => {
    const s = colorbarScale({ clim: [2.3, 9.5], maxAbs: 9.5, threshold: 0 });
    assert.deepEqual([s.min, s.max], [0, 9.5]);
    assert.equal(s.excluded(0), true);
    assert.equal(s.excluded(2.29), true);
    assert.equal(s.excluded(2.3), false);
    assert.equal(s.excluded(9.5), false);
});

test('colorbarScale greys threshold gaps and the negative half in positive-only mode', () => {
    const s = colorbarScale({ maxAbs: 8, diverging: true, positiveOnly: true, threshold: 2.3 });
    assert.deepEqual([s.min, s.max], [-8, 8]);
    assert.equal(s.excluded(-8), true);
    assert.equal(s.excluded(0), true);
    assert.equal(s.excluded(2.29), true);
    assert.equal(s.excluded(2.3), false);
});

test('colorbarScale mirrors the vmin convention for negative-only limits', () => {
    const s = colorbarScale({ clim: [-9, -2], maxAbs: 9, negativeOnly: true });
    assert.deepEqual([s.min, s.max], [-9, 0]);
    assert.equal(s.excluded(-9), false);
    assert.equal(s.excluded(-2), false);
    assert.equal(s.excluded(-1.99), true);
});

test('resolveColormap guards a diverging map on negative-only data', () => {
    const maps = loadColormaps({ n: 2, maps: { coolwarm: { lut: [[0, 0, 1], [1, 0, 0]], category: 'diverging' } } });
    const neg = resolveColormap({ colormap: 'coolwarm', colormapMode: 'auto' }, false, maps, true);
    assert.equal(neg.divergingMapOnNegative, true);
    assert.equal(neg.divergingMapOnPositive, false);   // negative data must NOT take the positive guard
});

test('resolveColormap auto-picks sequential for positive data and guards diverging maps', () => {
    const maps = loadColormaps({ n: 2, maps: { coolwarm: { lut: [[0, 0, 1], [1, 0, 0]], category: 'diverging' }, viridis: { lut: [[0, 0, 0], [1, 1, 0]], category: 'sequential' } } });
    const auto = resolveColormap({ colormap: 'auto', colormapMode: 'auto' }, false, maps);
    assert.equal(auto.mode, 'sequential');
    // user forces coolwarm on positive data → guard engages
    const forced = resolveColormap({ colormap: 'coolwarm', colormapMode: 'auto' }, false, maps);
    assert.equal(forced.divergingMapOnPositive, true);
    // LUT sampling interpolates
    assert.deepEqual(sampleLUT(maps.get('coolwarm'), 0.5), [0.5, 0, 0.5]);
});

// --- M8: surface-projection visibility (cel-shaded patches OVER the kept glass cortex) ---
test('visibility: surface mode shows the surface variant, glass cortex stays', () => {
    const panel = { roles: ['cortex', 'voxel'], hemisphere: 'lh' };
    const style = { voxel: { representation: 'surface' }, cortexSurface: 'pial' };
    assert.equal(visible(panel, { role: 'cortex', hemisphere: 'lh', variant: 'pial' }, style), true);   // glass cortex KEPT (signature look)
    assert.equal(visible(panel, { role: 'voxel', hemisphere: 'lh', variant: 'surface', category: 'lh_cortex' }, style), true);
    assert.equal(visible(panel, { role: 'voxel', hemisphere: 'lh', variant: 'blocky', category: 'lh_cortex' }, style), false);
});

test('surface mode keeps subcortical voxels volumetric with a smooth/blocky choice', () => {
    const content = VIEWS.cortex_subcort_r.content; // right cortex + left subcortex
    const smooth = { voxel: { representation: 'surface', subcortexRepresentation: 'smooth' }, cortexSurface: 'pial' };
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'rh', category: 'rh_cortex', variant: 'surface' }, smooth), true);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'smooth' }, smooth), true);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'blocky' }, smooth), false);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'rh', category: 'subcort_r', variant: 'smooth' }, smooth), false);
    const blocky = { voxel: { representation: 'surface', subcortexRepresentation: 'blocky' } };
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'blocky' }, blocky), true);
    assert.equal(visible(content, { role: 'voxel', hemisphere: 'lh', category: 'subcort_l', variant: 'smooth' }, blocky), false);
});

test('per-panel cortical surface selection is independent of overlay representation', () => {
    const style = { cortexSurface: 'inflated', voxel: { representation: 'smooth' } };
    const panel = { roles: ['cortex', 'voxel'], hemisphere: 'lh', surface: 'white' };
    assert.equal(visible(panel, { role: 'cortex', hemisphere: 'lh', variant: 'white' }, style), true);
    assert.equal(visible(panel, { role: 'cortex', hemisphere: 'lh', variant: 'inflated' }, style), false);
    assert.equal(visible(panel, { role: 'voxel', hemisphere: 'lh', variant: 'smooth' }, style), true);
    assert.equal(visible({ ...panel, surface: 'hidden' },
        { role: 'cortex', hemisphere: 'lh', variant: 'white' }, style), false);
});

test('view changes preserve an explicit per-panel surface', () => {
    const panel = { content: { surface: 'white' } };
    applyView(panel, 'dorsal');
    assert.equal(panel.content.surface, 'white');
    assert.equal(panel.camera.plane, 'dorsal');
});

test('template bundles expose arbitrary surface variants and reject failed alignment', () => {
    const manifest = { space: 'toy', templateMode: 'custom', templateBundle: {
        id: 'toy-v1', space: 'toy', coordinateSystem: 'RAS', transformId: 'toy-world-v1',
        surfaces: { pial: { lh: 'lh.glb', rh: 'rh.glb' }, white: { lh: 'lhw.glb', rh: 'rhw.glb' },
            customHull: { lh: 'lhc.glb' } },
        anatomy: { meta: 'anat.json', data: 'anat.bin.gz', transformId: 'toy-world-v1' },
        alignment: { status: 'pass', worstP95Mm: 1.2 },
    } };
    const ok = validateTemplateBundle(manifest);
    assert.equal(ok.ok, true);
    assert.deepEqual(Object.keys(ok.bundle.surfaces), ['pial', 'white', 'customHull']);
    manifest.templateBundle.alignment.status = 'fail';
    assert.equal(validateTemplateBundle(manifest).ok, false);
    // Old scene.json remains readable through normalization.
    const legacy = normalizeTemplateBundle({ space: 'MNI152', cortex: {
        lh: { mesh: 'lh.glb', meshInflated: 'lhi.glb' }, rh: { mesh: 'rh.glb' },
    } });
    assert.equal(legacy.surfaces.pial.rh, 'rh.glb');
    assert.equal(legacy.surfaces.inflated.lh, 'lhi.glb');
});

// A native surface overlay (surfaceOnly) forces its 'surface' variant to show even when the
// panel/global representation is a volumetric mode — so no blocky/smooth is ever needed for it.
test('visibility: a surfaceOnly overlay always shows its surface variant regardless of representation', () => {
    const panel = { roles: ['cortex', 'voxel'], hemisphere: 'lh' };
    const volStyle = { voxel: { representation: 'blocky' } };   // global says blocky
    const surfMesh = { role: 'voxel', hemisphere: 'lh', variant: 'surface', category: 'lh_cortex', surfaceOnly: true };
    assert.equal(visible(panel, surfMesh, volStyle), true);     // forced on despite representation:blocky
    // and a NON-surfaceOnly surface mesh still obeys the representation gate (hidden under blocky)
    assert.equal(visible(panel, { ...surfMesh, surfaceOnly: false }, volStyle), false);
});

// --- config + presets ---
test('normalizeConfig fills defaults and validates panels', () => {
    const cfg = resolveConfig('fourPanel');
    assert.equal(cfg.layout.panels.length, 4);
    assert.equal(cfg.style.lighting.ambient, 0);
    // each panel got content defaults
    assert.equal(cfg.layout.panels[0].content.representation, null);
    assert.equal(cfg.layout.panels[0].framing.margin, 1.06);
});

test('validateConfig rejects an empty layout', () => {
    const { ok, errors } = validateConfig(normalizeDefaultsOnly());
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('panels')));
});
function normalizeDefaultsOnly() {
    // a config with no panels (bypass normalizeConfig's throw to test validate directly)
    return { layout: { panels: [] } };
}

test('ninePanel and fourPanel both normalize', () => {
    assert.equal(resolveConfig('ninePanel').layout.panels.length, 8); // posterior dropped
    assert.equal(resolveConfig('fourPanel').layout.panels.length, 4);
});

test('the montage presets (5-view, 6-view) normalize with the right panel counts', () => {
    assert.equal(resolveConfig('fiveView').layout.panels.length, 5);
    assert.equal(resolveConfig('sixView').layout.panels.length, 6);
    // every montage panel has a valid camera plane + a grid cell
    for (const name of ['fiveView', 'sixView']) {
        for (const p of resolveConfig(name).layout.panels) {
            assert.ok(p.camera && p.camera.plane, `${name} panel ${p.id} has a plane`);
            assert.ok(p.cell && p.cell.row != null && p.cell.col != null, `${name} panel ${p.id} has a cell`);
        }
    }
});

// --- Free Canvas: free-rect placement + cell-XOR-place schema ---
test('freeRect maps place fractions to a GL bottom-left rect', () => {
    const r = freeRect({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, 1000, 600);
    assert.equal(r.w, 500);
    assert.equal(r.h, 300);
    assert.equal(r.cssLeft, 250);
    assert.equal(r.cssTop, 60);
    assert.equal(r.y, 600 - 60 - 300); // GL origin bottom-left (matches layoutGrid)
    assert.ok(Math.abs(r.aspect - 500 / 300) < 1e-9);
});

test('defaults add grid mode + opaque canvas (so existing configs are unchanged)', () => {
    const cfg = resolveConfig('fourPanel');
    assert.equal(cfg.layout.mode, 'grid');
    assert.equal(cfg.layout.canvas.bgAlpha, 1);
});

test('panels default to glass subcortical; the opaque view sets anatomyStyle=opaque + cortex+anatomy', () => {
    const cfg = normalizeConfig({ layout: { panels: [{ id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } }] } });
    assert.equal(cfg.layout.panels[0].content.anatomyStyle, 'glass');   // default unchanged
    const p = applyView({}, 'cortex_subcort_l');
    assert.equal(p.content.anatomyStyle, 'opaque');
    assert.ok(p.content.roles.includes('cortex') && p.content.roles.includes('anatomy') && p.content.roles.includes('voxel'));
    assert.equal(p.content.categories, null);   // categories null so cortex isn't filtered out
    assert.equal(VIEWS.cortex_subcort_l.plane, 'left_lateral');
});

test('named paired views refresh stale saved-layout content and remain inferable without view', () => {
    const cfg = normalizeConfig({ layout: { mode: 'free', panels: [{
        id: 'paired', view: 'cortex_subcort_lm', camera: { plane: 'left_medial' },
        place: { x: 0, y: 0, w: 1, h: 1 },
        // Simulate an old saved panel which still paired every role to the left hemisphere.
        content: { roles: ['cortex', 'anatomy', 'voxel'], hemisphere: 'lh', anatomyHemisphere: 'lh' },
    }] } });
    const panel = cfg.layout.panels[0];
    assert.equal(panel.content.hemisphere, 'lh');
    assert.equal(panel.content.anatomyHemisphere, 'rh');
    assert.deepEqual(panel.content.anatomyCategories, ['subcort_r', 'cereb_r', 'brainstem']);
    assert.deepEqual(panel.content.voxelCategories, ['lh_cortex', 'subcort_r', 'cereb_r', 'brainstem']);
    const inferred = { ...panel };
    delete inferred.view;
    assert.equal(panelViewName(inferred), 'cortex_subcort_lm');
});

test('normalizeConfig accepts a place-based panel (free mode) and preserves rotate/slice', () => {
    const cfg = normalizeConfig({
        layout: { mode: 'free', panels: [{
            id: 'a', camera: { plane: 'dorsal' }, place: { x: 0, y: 0, w: 0.5, h: 0.5 },
            rotate: { yaw: 30, pitch: 10 }, slice: { shape: 'sphere', mode: 'bite', center: [0, -18, 22], radius: 45 },
        }] },
    });
    assert.equal(cfg.layout.mode, 'free');
    assert.equal(cfg.layout.panels[0].place.w, 0.5);
    assert.equal(cfg.layout.panels[0].rotate.yaw, 30);
    assert.equal(cfg.layout.panels[0].slice.shape, 'sphere');
    assert.equal(cfg.layout.panels[0].slice.mode, 'bite');
});

// --- CLI export: free figures emit --spec figure.json; grids keep --grid/--views ---
test('isFreeFigure detects free mode / place / rotate / slice', () => {
    assert.equal(isFreeFigure({ layout: { mode: 'free', panels: [] } }), true);
    assert.equal(isFreeFigure({ layout: { mode: 'grid', panels: [{ cell: { row: 0, col: 0 } }] } }), false);
    assert.equal(isFreeFigure({ layout: { panels: [{ place: { x: 0, y: 0, w: 1, h: 1 } }] } }), true);
    assert.equal(isFreeFigure({ layout: { panels: [{ cell: { row: 0, col: 0 }, rotate: { yaw: 10 } }] } }), true);
});

test('usesFigureSpec preserves every grid style through a recipe', () => {
    const grid = { layout: { mode: 'grid', panels: [{ cell: { row: 0, col: 0 } }] } };
    assert.equal(usesFigureSpec(grid, [{ meta: { name: 'one.nii.gz' } }], false), true);
    assert.equal(usesFigureSpec(grid, [{ meta: { name: 'one.nii.gz' } }, { meta: { name: 'two.nii.gz' } }], false), true);
    assert.equal(usesFigureSpec(grid, [{ meta: { name: 'one.nii.gz' } }], true), true);
});

test('buildRenderText emits --spec + an embedded figure.json for a free figure', () => {
    const config = {
        layout: {
            mode: 'free', canvas: { w: 800, h: 500, bgAlpha: 0 },
            panels: [{ id: 'a', place: { x: 0, y: 0, w: 1, h: 1, z: 0 }, camera: { plane: 'dorsal' },
                       content: { roles: ['cortex', 'voxel'], hemisphere: 'both' }, rotate: { yaw: 25 } }],
        },
        style: { colormap: 'YlGnBu' },
        render: { width: 800, height: 500, background: '#ffffff' },
    };
    const text = buildRenderText({ config, overlays: [{ meta: { name: 'zstat.nii.gz' } }], preset: 'freeCanvas', colormaps: new Map() });
    assert.match(text, /--spec figure\.json/);
    assert.match(text, /comic render/);
    // the embedded JSON carries the free layout (mode, place, rotate, transparent bg)
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    assert.equal(json.layout.mode, 'free');
    assert.equal(json.layout.canvas.bgAlpha, 0);
    assert.equal(json.layout.panels[0].rotate.yaw, 25);
    assert.equal(json.render.width, 800);
    assert.deepEqual(json.inputs, [{ slot: 1, name: 'zstat.nii.gz', type: 'volume', label: 'zstat.nii.gz' }]);
});

test('Free Canvas Copy CLI includes every overlay in slot order', () => {
    const config = {
        layout: {
            mode: 'free', canvas: { w: 800, h: 500, bgAlpha: 1 },
            panels: [{ id: 'a', place: { x: 0, y: 0, w: 1, h: 1, z: 0 },
                       camera: { plane: 'dorsal' },
                       content: { roles: ['cortex', 'voxel'], hemisphere: 'both' } }],
        },
        style: { overlays: [{ colormap: 'Reds' }, { colormap: 'Blues' }] },
        render: { width: 800, height: 500, background: '#ffffff' },
    };
    const overlays = [
        { meta: { name: 'first map.nii.gz' }, src: { file: {} } },
        { meta: { name: 'second.nii.gz' }, src: { file: {} } },
    ];
    const text = buildRenderText({ config, overlays, preset: 'freeCanvas', colormaps: new Map() });
    assert.match(text, /comic render 'first map\.nii\.gz' second\.nii\.gz --spec figure\.json/);
    assert.match(text, /gb\.render_spec\("figure\.json", \["first map\.nii\.gz","second\.nii\.gz"\], crop="content"\)/);
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    assert.deepEqual(json.inputs.map((x) => [x.slot, x.name]), [
        [1, 'first map.nii.gz'], [2, 'second.nii.gz'],
    ]);
});

// --- M2: extended schema (clim/units/surfaceDepth, template kinds, surface representation) ---
test('DEFAULTS carry the M2 additions with backward-compatible identities', () => {
    assert.equal(DEFAULTS.template.kind, 'mni');
    assert.equal(DEFAULTS.style.clim, null);                 // null = derive from data (today's behaviour)
    assert.equal(DEFAULTS.style.units.cluster, 'voxels');
    assert.equal(DEFAULTS.style.voxel.surfaceDepth, 6);
    assert.equal(DEFAULTS.style.voxel.subcortexRepresentation, 'blocky');
    assert.equal(DEFAULTS.layout.view.s, 1);                 // identity → existing renders unchanged
});

test('overlayStyle resolves clim/units/surfaceDepth with per-overlay override', () => {
    const cfg = { style: { clim: null, units: { value: 'stat', cluster: 'voxels' },
        voxel: { surfaceDepth: 6, representation: 'smooth', subcortexRepresentation: 'smooth' },
        cutOverlay: { enabled: false, slabMm: 80, interpolation: 'linear', opacity: 0.88 },
        overlays: [{ clim: [0, 8], units: { value: 'z' }, voxel: {
            representation: 'surface', subcortexRepresentation: 'blocky' },
            cutOverlay: { enabled: true, slabMm: 3, interpolation: 'nearest' } }] } };
    const os = overlayStyle(cfg, 0);
    assert.deepEqual(os.clim, [0, 8]);                       // per-overlay clim wins
    assert.equal(os.units.value, 'z');                       // overridden
    assert.equal(os.units.cluster, 'voxels');                // inherited
    assert.equal(os.representation, 'surface');
    assert.equal(os.subcortexRepresentation, 'blocky');
    assert.equal(os.surfaceDepth, 6);                        // inherited from global voxel
    assert.deepEqual(os.cutOverlay, { enabled: true, slabMm: 3, interpolation: 'nearest', opacity: 0.88 });
    assert.equal(overlayStyle(cfg, 1).clim, null);           // absent overlay → global (null)
});

test('cut-overlay sampling config validates interpolation, slab thickness, and opacity', () => {
    const panel = { id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } };
    assert.doesNotThrow(() => normalizeConfig({ style: { cutOverlay: { enabled: true, slabMm: 2, interpolation: 'nearest', opacity: 0.7 } }, layout: { panels: [panel] } }));
    assert.throws(() => normalizeConfig({ style: { cutOverlay: { slabMm: -1 } }, layout: { panels: [panel] } }), /style.cutOverlay/);
    assert.throws(() => normalizeConfig({ style: { cutOverlay: { interpolation: 'cubic' } }, layout: { panels: [panel] } }), /style.cutOverlay/);
});

test('normalizeConfig promotes per-panel zoom/rotate/slice to declared fields', () => {
    const cfg = normalizeConfig({ layout: { panels: [{ id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } }] } });
    assert.equal(cfg.layout.panels[0].zoom, 1);
    assert.equal(cfg.layout.panels[0].rotate, null);
    assert.equal(cfg.layout.panels[0].slice, null);
});

test('validateConfig enforces template.kind, clim shape, representation enum', () => {
    const base = { template: { kind: 'mni' }, style: {}, layout: { panels: [{ id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 } }] } };
    assert.equal(validateConfig(base).ok, true);
    assert.equal(validateConfig({ ...base, template: { kind: 'bogus' } }).ok, false);
    assert.equal(validateConfig({ ...base, style: { clim: [8, 1] } }).ok, false);     // vmin>vmax
    assert.equal(validateConfig({ ...base, style: { clim: 8 } }).ok, true);           // scalar ok
    assert.equal(validateConfig({ ...base, style: { voxel: { representation: 'surface' } } }).ok, true);
    assert.equal(validateConfig({ ...base, style: { voxel: { representation: 'blobby' } } }).ok, false);
});

test("template.kind 'none' rejects cortex/anatomy roles + hemisphere split", () => {
    const noTpl = (content) => validateConfig({ template: { kind: 'none' }, style: {},
        layout: { panels: [{ id: 'a', camera: { plane: 'dorsal' }, cell: { row: 0, col: 0 }, content }] } });
    assert.equal(noTpl({ roles: ['voxel'], hemisphere: 'both' }).ok, true);
    assert.equal(noTpl({ roles: ['cortex', 'voxel'], hemisphere: 'both' }).ok, false);  // shell not allowed
    assert.equal(noTpl({ roles: ['voxel'], hemisphere: 'lh' }).ok, false);              // no hemi split
});

test('validateConfig requires exactly one of cell / place', () => {
    const camera = { plane: 'dorsal' };
    // neither cell nor place → invalid
    assert.throws(() => normalizeConfig({ layout: { panels: [{ id: 'a', camera }] } }), /exactly one of cell/);
    // both cell and place → invalid
    assert.throws(() => normalizeConfig({ layout: { panels: [{ id: 'a', camera, cell: { row: 0, col: 0 }, place: { x: 0, y: 0, w: 1, h: 1 } }] } }), /exactly one of cell/);
    // cell only → valid;  place only → valid
    assert.doesNotThrow(() => normalizeConfig({ layout: { panels: [{ id: 'a', camera, cell: { row: 0, col: 0 } }] } }));
    assert.doesNotThrow(() => normalizeConfig({ layout: { panels: [{ id: 'a', camera, place: { x: 0, y: 0, w: 1, h: 1 } }] } }));
});

test('voxel edges default OFF in surface mode, but a per-overlay setting still wins', () => {
    // The edge pass finds depth steps in VOXEL geometry; a cortical sheet has none, so on a
    // surface overlay it just traces the threshold boundary and reads as noise.
    // built from DEFAULTS, i.e. the shape overlayStyle actually receives after normalizeConfig
    const cfg = (rep, ov = {}) => ({
        style: { ...DEFAULTS.style,
                 voxel: { ...DEFAULTS.style.voxel, representation: rep },
                 overlays: [ov] },
    });
    assert.equal(overlayStyle(cfg('smooth'), 0).edges.enabled, true, 'volumetric keeps its edges');
    assert.equal(overlayStyle(cfg('surface'), 0).edges.enabled, false, 'surface mode drops them');
    // per-overlay representation, not just the global one
    assert.equal(overlayStyle(cfg('smooth', { voxel: { representation: 'surface' } }), 0).edges.enabled, false);
    // an explicit per-overlay enable (what the Edges button writes) turns them back on
    assert.equal(overlayStyle(cfg('surface', { voxel: { edges: { enabled: true } } }), 0).edges.enabled, true,
        'explicit per-overlay wins');
});

test('the depth veil is off by default', () => {
    assert.equal(DEFAULTS.style.voxel.veil.strength, 0);
});
