/**
 * Unit tests for the pure core. Run with:  node --test  (from viewer/)
 * No THREE, no DOM — these guard the load-bearing geometry/visibility/colour math.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { det3, normalize, cross } from './units.js';
import { resolveCamera, cameraBasis, PLANES } from './cameras.js';
import { aabbOfPositions, mergeAABB, frameContent } from './framing.js';
import { layoutGrid } from './grid.js';
import { visible } from './visibility.js';
import { valueToT, resolveColormap, loadColormaps, sampleLUT } from './colormap.js';
import { normalizeConfig, validateConfig } from './config-schema.js';
import { resolveConfig } from './presets.js';

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

// --- colormap: positive-only data never collapses onto a diverging white centre ---
test('valueToT positive-only-guard pushes values into the LUT hot half', () => {
    // sequential mode, no guard: a small positive value maps near 0
    assert.ok(valueToT(0.1, 1, 'sequential', 0.5, false) < 0.4);
    // with the diverging-on-positive guard, the same value is pushed to >=0.5
    assert.ok(valueToT(0.1, 1, 'sequential', 0.5, true) >= 0.5);
    assert.equal(valueToT(0, 1, 'sequential', 0.5, true), 0.5);
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
