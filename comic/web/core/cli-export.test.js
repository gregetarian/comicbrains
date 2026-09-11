import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildInputDescriptors, buildRenderText, buildSpec, usesFigureSpec } from '../controls/cli-export.js';

const gridConfig = () => ({
    version: '2.0',
    template: { kind: 'mni', dir: null, space: 'MNI152' },
    layout: { mode: 'grid', canvas: { w: 720, h: 480, bgAlpha: 0.3 },
        grid: { rows: 1, cols: 1 }, view: { s: 1.3, cx: 111, cy: 222 },
        panels: [{ id: 'medial', cell: { row: 0, col: 0 }, camera: { plane: 'right' },
            content: { hemisphere: 'lh', anatomyHemisphere: 'rh', representation: 'surface' } }] },
    style: { gamma: 0.5, threshold: 4, positiveOnly: true, clim: [0, 16],
        voxel: { representation: 'smooth', depthMode: 'anatomy',
            edges: { enabled: true, mode: 'outer', color: '#123abc' } },
        outline: { enabled: true, color: '#abc123', silhouette: { color: '#fedcba' } },
        overlays: [{ gamma: 0.7, voxel: { surfaceBase: '#cccccc' } }] },
    render: { width: 720, height: 480, pixelRatio: 3, background: '#112233', colorbar: false,
        colorbarFont: 'A font, serif', colorbarFontSize: 16, futureSetting: { preserved: true } },
});
const volume = (name = 'map.nii.gz', threshold = 2.3) => ({
    src: { file: { name }, threshold }, meta: { name, threshold },
});
const commandFrom = (text) => text.split('\n\n# Terminal (ready to run):\n')[1].split('\n\n# Python equivalent:')[0];
// Parse the generated command with a real POSIX shell. The fake `comic` only prints argv;
// any unwanted interpolation in a filename changes the arguments and fails assertions.
const shellArgs = (command) => execFileSync('/bin/sh', ['-c',
    'comic() { printf "%s\\000" "$@"; }; ' + command], { encoding: 'utf8' }).split('\0').slice(0, -1);

test('simple-grid export preserves full style, template, legends and view without flag translation', () => {
    const config = gridConfig();
    const overlays = [volume()];
    const text = buildRenderText({ config, overlays });
    const spec = buildSpec(config, overlays);
    assert.equal(usesFigureSpec(config, overlays), true);
    assert.deepEqual(spec.style, config.style);
    assert.deepEqual(spec.template, config.template);
    assert.deepEqual(spec.layout, config.layout);
    assert.deepEqual(spec.render, { ...config.render, colorbarWidth: 240, colorbarHeight: 14 });
    assert.match(commandFrom(text), /--spec figure\.json/);
    assert.match(text, /crop="content"\)\.save/);
    assert.doesNotMatch(commandFrom(text), /--voxels|--line-color|--grid|--gamma/);
    assert.equal(spec.inputs[0].processingThreshold, 2.3);
    assert.equal(spec.style.threshold, 4);
    config.style.gamma = 3;
    config.layout.view.s = 9;
    config.render.futureSetting.preserved = false;
    assert.equal(spec.style.gamma, 0.5);
    assert.equal(spec.layout.view.s, 1.3);
    assert.equal(spec.render.futureSetting.preserved, true);
});

test('loading thresholds preserve zero, prefer baked metadata and never use live display threshold', () => {
    const spec = buildSpec(gridConfig(), [
        { src: { threshold: 2.3 }, meta: { name: 'zero.nii.gz', threshold: 0 } },
        { src: { threshold: 1.2 }, meta: { name: 'source.nii.gz' } },
        { meta: { name: 'unknown.nii.gz' } },
        { meta: { name: 'bad.nii.gz', threshold: NaN } },
    ]);
    assert.equal(spec.inputs[0].processingThreshold, 0);
    assert.equal(spec.inputs[1].processingThreshold, 1.2);
    assert.equal(Object.hasOwn(spec.inputs[2], 'processingThreshold'), false);
    assert.equal(Object.hasOwn(spec.inputs[3], 'processingThreshold'), false);
});

test('mixed parcel, volume and native inputs keep browser overlay/style order through actual command', () => {
    const overlays = [
        { src: { surface: true, parcel: true, file: { name: 'eigen field.csv' }, atlas: 'schaefer100_17', threshold: 1e-9 },
            meta: { name: 'Eigenfield', threshold: 1e-9 } },
        { ...volume('language.nii.gz'), meta: { name: 'Language (Neurosynth)', threshold: 2.3 } },
        { src: { surface: true, lh: { name: 'lh.stat.gii' }, rh: { name: 'rh.stat.gii' } },
            meta: { name: 'Native statistic', threshold: 1.1 } },
        { src: { surface: true, parcel: true, file: { name: 'second.csv' }, atlas: 'schaefer100_7' },
            meta: { name: 'Another atlas', threshold: 1e-9 } },
    ];
    const config = gridConfig();
    config.style.overlays = overlays.map((_, i) => ({ gamma: i + 1 }));
    const text = buildRenderText({ config, overlays });
    const argv = shellArgs(commandFrom(text));
    const descriptors = argv.flatMap((arg, i) => arg === '--input-json' ? [JSON.parse(argv[i + 1])] : []);
    assert.deepEqual(descriptors, [
        { type: 'parcel', path: 'eigen field.csv', atlas: 'schaefer100_17', name: 'Eigenfield' },
        { type: 'volume', path: 'language.nii.gz', name: 'Language (Neurosynth)' },
        { type: 'surface', name: 'Native statistic', lh: 'lh.stat.gii', rh: 'rh.stat.gii' },
        { type: 'parcel', path: 'second.csv', atlas: 'schaefer100_7', name: 'Another atlas' },
    ]);
    const spec = buildSpec(config, overlays);
    assert.deepEqual(spec.inputs.map((d) => d.type), ['parcel', 'volume', 'surface', 'parcel']);
    assert.deepEqual(spec.style.overlays.map((s) => s.gamma), [1, 2, 3, 4]);
    assert.equal(spec.inputs[0].atlas, 'schaefer100_17');
    assert.equal(spec.inputs[1].name, 'language.nii.gz');
    assert.equal(spec.inputs[1].label, 'Language (Neurosynth)');
    assert.deepEqual(spec.inputs[2].files, { lh: 'lh.stat.gii', rh: 'rh.stat.gii' });
    assert.match(text, /gb\.render_spec\("figure\.json", \[\{"type":"parcel"/);
});

test('surface-only, lone-hemisphere and parcel-only figures never route to positional NIfTI', () => {
    for (const overlay of [
        { src: { surface: true, rh: { name: 'rh.data.mgh' } }, meta: { name: 'right map' } },
        { src: { surface: true, parcel: true, file: { name: 'values.tsv' }, atlas: 'schaefer100_17' }, meta: {} },
    ]) {
        const argv = shellArgs(commandFrom(buildRenderText({ config: gridConfig(), overlays: [overlay] })));
        assert.equal(argv[1], '--input-json');
        const d = JSON.parse(argv[2]);
        assert.notEqual(d.type, 'volume');
        if (d.type === 'surface') { assert.equal(d.rh, 'rh.data.mgh'); assert.equal(Object.hasOwn(d, 'lh'), false); }
    }
});

test('POSIX command preserves special filenames and option-like positional paths literally', () => {
    const names = ["a map's #1,$(printf INJECTED)`printf WRONG`=ok.nii.gz", '-data.nii.gz', 'line\nbreak.nii.gz'];
    const argv = shellArgs(commandFrom(buildRenderText({ config: gridConfig(), overlays: names.map((n) => volume(n)) })));
    assert.deepEqual(argv.slice(1, 4), [names[0], './' + names[1], names[2]]);
    const lh = "lh.a,b=c's $(printf INJECTED).gii";
    const argv2 = shellArgs(commandFrom(buildRenderText({ config: gridConfig(), overlays: [
        { src: { surface: true, lh: { name: lh } }, meta: { name: 'a "label"' } },
    ] })));
    assert.equal(JSON.parse(argv2[2]).lh, lh);
    assert.equal(JSON.parse(argv2[2]).name, 'a "label"');
});

test('exports without overlay data do not download an empty recipe or invent an input command', () => {
    assert.equal(usesFigureSpec(gridConfig(), []), false);
    assert.equal(buildInputDescriptors([]).length, 0);
    assert.doesNotMatch(buildRenderText({ config: gridConfig(), overlays: [] }), /comic render/);
});
