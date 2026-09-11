import test from 'node:test';
import assert from 'node:assert/strict';
import { colorbarModel, colorbarSVGs, createColorbar } from '../controls/colorbar.js';
import { loadColormaps } from './colormap.js';

const colormaps = loadColormaps({ n: 3, maps: {
    gray: { category: 'sequential', lut: [[0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]] },
    signed: { category: 'diverging', lut: [[0, 0, 1], [1, 1, 1], [1, 0, 0]] },
} });
const cfg = (style = {}, render = {}) => ({
    style: { colormap: 'gray', colormapMode: 'auto', gamma: 1, threshold: 0,
        voxel: { emissive: 1, specular: 0, shininess: 200 },
        lighting: { directional: 0, ambient: 0 }, ...style },
    render: { colorbarWidth: 5, colorbarHeight: 2, ...render },
});
const meta = { name: 'Statistic', maxAbsValue: 4, threshold: 0, diverging: false };
const gradientStops = (svg) => [...svg.matchAll(/<stop offset="([\d.]+)%" stop-color="(#[a-f\d]{6})"\/>/g)]
    .map((m) => [Number(m[1]), m[2]]);

test('shared colour model applies gamma to RGB and leaves value ticks linear', () => {
    const linear = colorbarModel(cfg(), meta, colormaps);
    const gamma = colorbarModel(cfg({ gamma: 0.5 }), meta, colormaps);
    assert.deepEqual(linear.rgbAt(1), [64, 64, 64]);
    assert.deepEqual(gamma.rgbAt(1), [128, 128, 128]);
    assert.deepEqual(gamma.ticks, [0, 2, 4]);
    assert.deepEqual(gamma.sampleColumns(5)[1], gamma.rgbAt(1));
    const stops = gradientStops(colorbarSVGs(cfg({ gamma: 0.5 }), [meta], colormaps)[0]);
    assert.ok(stops.some(([x, color]) => x === 25 && color === '#808080'));
});

test('explicit limits and processing-threshold fallback produce sharp, correctly placed grey intervals', () => {
    const config = cfg({ clim: [2, 10], threshold: null });
    const model = colorbarModel(config, { ...meta, threshold: 3 }, colormaps);
    assert.deepEqual(model.ticks, [0, 5, 10]);
    assert.deepEqual(model.rgbAt(2.9), [128, 128, 128]);
    assert.deepEqual(model.rgbAt(6), [128, 128, 128]);  // (6 - 2)/(10 - 2), not 6/10
    assert.deepEqual(model.rgbAt(3), [32, 32, 32]);
    const stops = gradientStops(colorbarSVGs(config, [{ ...meta, threshold: 3 }], colormaps)[0]);
    assert.deepEqual(stops.filter(([x]) => x === 30), [[30, '#808080'], [30, '#202020']]);
});

test('signed and positive-only legends preserve full numeric ranges while excluding hidden signs', () => {
    const signed = { ...meta, diverging: true, maxAbsValue: 5 };
    const config = cfg({ colormap: 'signed', threshold: 2.5, positiveOnly: true });
    const model = colorbarModel(config, signed, colormaps);
    assert.deepEqual(model.ticks, [-5, 0, 5]);
    assert.deepEqual(model.rgbAt(-5), [128, 128, 128]);
    assert.deepEqual(model.rgbAt(0), [128, 128, 128]);
    assert.deepEqual(model.rgbAt(2.5), [255, 128, 128]);
    assert.deepEqual(model.rgbAt(5), [255, 0, 0]);
    const stops = gradientStops(colorbarSVGs(config, [signed], colormaps)[0]);
    assert.deepEqual(stops.filter(([x]) => x === 75), [[75, '#808080'], [75, '#ff8080']]);
    const negative = colorbarModel(cfg({ colormap: 'signed' }), { ...meta, maxAbsValue: 5, negativeOnly: true }, colormaps);
    assert.deepEqual(negative.ticks, [-5, -2.5, 0]);
    assert.deepEqual(negative.rgbAt(-5), [0, 0, 255]);
    assert.deepEqual(negative.rgbAt(0), [255, 255, 255]);
});

test('swatch lighting, per-overlay style, names, units and XML attributes survive SVG export', () => {
    const config = cfg({ units: { value: 'z' }, overlays: [
        { gamma: 0.5 }, { units: { value: '<t & "p">\'' }, voxel: { emissive: 0.25 } },
    ] }, { colorbarFont: 'A "font" & serif' });
    const labels = [{ ...meta, name: '<Language & "Faces">\'' }, { ...meta, name: 'Second' }];
    const svgs = colorbarSVGs(config, labels, colormaps);
    assert.equal(svgs.length, 2);
    assert.ok(svgs[0].startsWith('<svg'));
    assert.match(svgs[0], /linearGradient/);
    assert.match(svgs[0], />z<\/text>/);
    assert.match(svgs[0], /4\.0<\/text>/);
    assert.match(svgs[0], /&lt;Language &amp; &quot;Faces&quot;&gt;&apos;/);
    assert.match(svgs[0], /font-family="A &quot;font&quot; &amp; serif"/);
    assert.match(svgs[1], /&lt;t &amp; &quot;p&quot;&gt;&apos;/);
    assert.deepEqual(colorbarModel(config, labels[1], colormaps, 1).rgbAt(4), [137, 137, 137]);
    assert.deepEqual(colorbarModel(cfg({ voxel: { emissive: 0 }, lighting: { ambient: Math.PI, directional: 0 } }), meta, colormaps).rgbAt(4), [255, 255, 255]);
});

test('actual live-canvas update samples exactly the same RGB columns used by SVG', () => {
    const elements = [];
    const makeElement = (tag) => {
        const el = { tag, style: {}, children: [], append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); }, addEventListener() {} };
        if (tag === 'canvas') el.getContext = () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData(image) { el.image = image; },
        });
        elements.push(el);
        return el;
    };
    const prior = globalThis.document;
    globalThis.document = { createElement: makeElement };
    try {
        const config = cfg({ gamma: 0.5 });
        const legend = createColorbar(makeElement('div'), { engine: { overlays: [meta] }, config, colormaps });
        legend.update();
        const canvas = elements.find((el) => el.tag === 'canvas');
        const columns = colorbarModel(config, meta, colormaps).sampleColumns(canvas.width);
        const stops = gradientStops(colorbarSVGs(config, [meta], colormaps)[0]);
        columns.forEach((rgb, x) => {
            assert.deepEqual([...canvas.image.data.slice(x * 4, x * 4 + 3)], rgb);
            const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
            assert.ok(stops.some(([position, color]) => position === x * 25 && color === hex));
        });
        assert.equal(elements.find((el) => el.className === 'colorbar-labels').innerHTML,
            '<span>0.0</span><span>2.0</span><span>4.0</span>');
    } finally {
        if (prior === undefined) delete globalThis.document; else globalThis.document = prior;
    }
});
