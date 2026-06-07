/**
 * Unit tests for the pure core. Run with:  node --test  (from viewer/)
 * No THREE, no DOM — these guard the load-bearing geometry/visibility/colour math.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { det3, normalize, cross, sub } from './units.js';
import { resolveCamera, cameraBasis, PLANES } from './cameras.js';
import { aabbOfPositions, mergeAABB, frameContent } from './framing.js';
import { layoutGrid, freeRect } from './grid.js';
import { visible } from './visibility.js';
import { valueToT, resolveColormap, loadColormaps, sampleLUT } from './colormap.js';
import { normalizeConfig, validateConfig } from './config-schema.js';
import { applyView, VIEWS } from './views.js';
import { resolveConfig } from './presets.js';
import { isFreeFigure, buildSpec, buildRenderText } from '../controls/cli-export.js';

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
    assert.match(text, /glass-brains render/);
    // the embedded JSON carries the free layout (mode, place, rotate, transparent bg)
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    assert.equal(json.layout.mode, 'free');
    assert.equal(json.layout.canvas.bgAlpha, 0);
    assert.equal(json.layout.panels[0].rotate.yaw, 25);
    assert.equal(json.render.width, 800);
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
