/**
 * Lossless browser -> CLI export. Every figure uses the shared JSON display document;
 * translating only a subset of its style into flags silently loses browser settings.
 * Files stay separate. Browsers expose upload names, not their original disk paths.
 */

// POSIX-shell quoting. JSON descriptors also keep commas/equals in native-surface paths
// unambiguous, unlike the legacy --surface-map lh=...,rh=... syntax.
const q = (value) => {
    const s = String(value);
    return s && /^[\w.\-/]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
};
const inputName = (o, i) => o.src?.file?.name || o.meta?.name || `map${i + 1}.nii.gz`;
const copyJSON = (value) => JSON.parse(JSON.stringify(value));
// Quoting alone does not prevent an input called --help.nii.gz being parsed as an option.
const positionalPath = (path) => path.startsWith('-') ? `./${path}` : path;

/** Retained for callers that need to distinguish grid and freely placed layouts. */
export function isFreeFigure(config) {
    const L = config.layout || {};
    return L.mode === 'free' || (L.panels || []).some((p) => p.place || p.rotate || p.slice);
}

/** All browser figures need a recipe, including a single unzoomed grid overlay. */
export function usesFigureSpec(_config, overlays = [], _panelZoomUsed = false) {
    return overlays.length > 0;
}

/** Source descriptors follow the actual overlay order, which can change after upload.
 * Native surfaces retain their hemisphere files; parcel tables retain their selected atlas.
 * Missing names are explicit replacement hints, never mislabelled as NIfTI inputs. */
export function buildInputDescriptors(overlays = []) {
    return overlays.map((o, i) => {
        const src = o.src || {};
        const name = o.meta?.name || inputName(o, i);
        if (src.parcel) {
            return { type: 'parcel', path: src.file?.name || `REPLACE_WITH_parcels${i + 1}.csv`,
                atlas: src.atlas, name };
        }
        if (src.surface || (!src.file && o.meta?.surfaceOnly)) {
            const d = { type: 'surface', name };
            if (src.lh?.name) d.lh = src.lh.name;
            if (src.rh?.name) d.rh = src.rh.name;
            if (!d.lh && !d.rh) d.lh = `REPLACE_WITH_lh.map${i + 1}.gii`;
            return d;
        }
        return { type: 'volume', path: inputName(o, i), name };
    });
}

/** Portable display document. Preserve the entire render object, including legend font,
 * visibility, pixel ratio and future fields, as well as the full template/layout/style.
 * The processing threshold records the geometry loaded originally, independently of a
 * later display-threshold edit. Input paths remain hints; --spec does not open them. */
export function buildSpec(config, overlays = []) {
    const cv = config.layout?.canvas;
    const spec = {
        ...(config.version != null ? { version: config.version } : {}),
        template: config.template,
        layout: config.layout,
        style: config.style,
        render: {
            ...config.render,
            width: Math.round(cv?.w || config.render?.width || 1600),
            height: Math.round(cv?.h || config.render?.height || 1000),
            background: config.render?.background ?? '#ffffff',
            colorbarWidth: config.render?.colorbarWidth ?? 240,
            colorbarHeight: config.render?.colorbarHeight ?? 14,
        },
    };
    if (overlays.length) {
        const descriptors = buildInputDescriptors(overlays);
        spec.inputs = overlays.map((o, i) => {
            const d = descriptors[i];
            const input = { slot: i + 1, name: inputName(o, i), type: d.type };
            if (o.meta?.name) input.label = o.meta.name;
            if (d.type === 'surface') {
                input.files = { ...(d.lh ? { lh: d.lh } : {}), ...(d.rh ? { rh: d.rh } : {}) };
            } else if (d.type === 'parcel') input.atlas = d.atlas;
            const threshold = o.meta?.threshold ?? o.src?.threshold;
            if (typeof threshold === 'number' && Number.isFinite(threshold)) input.processingThreshold = threshold;
            return input;
        });
    }
    // A saved recipe must not keep references to subsequently edited live settings.
    return copyJSON(spec);
}

/** Clipboard text: one command for the complete figure, matching Python example, and recipe.
 * --input-json is repeated for mixed/native inputs so route grouping cannot reorder styles. */
export function buildRenderText({ config, overlays = [] }) {
    if (!overlays.length) return '# Load a volume, surface map or parcel table first — there is no overlay to reproduce.';

    const spec = buildSpec(config, overlays);
    const inputs = buildInputDescriptors(overlays);
    const volumeOnly = inputs.every((d) => d.type === 'volume');
    const args = volumeOnly
        ? inputs.map((d) => q(positionalPath(d.path))).join(' ')
        : inputs.map((d) => `--input-json ${q(JSON.stringify(d))}`).join(' ');
    const pythonInputs = volumeOnly ? inputs.map((d) => d.path) : inputs;
    const notes = [
        '# COMIC browser figure -> reproducible PNG',
        '# figure.json stores the complete layout, style, template, render size and legend settings.',
        '# Keep figure.json beside this command. Replace source filenames with local paths if needed.',
        '# Inputs bind to style slots in the displayed order; native surfaces and parcel tables keep their own routes.',
        '# Original processing thresholds are saved separately from the current display thresholds.',
    ];
    const cmd = `comic render ${args} --spec figure.json -o glassbrain.png --crop content`;
    const py = `# gb.render_spec("figure.json", ${JSON.stringify(pythonInputs)}, crop="content").save("glassbrain.png")`;
    return notes.join('\n') + '\n\n# Terminal (ready to run):\n' + cmd
        + '\n\n# Python equivalent:\n# import comic as gb\n' + py
        + '\n\n# ---- figure.json (also downloaded separately) ----\n' + JSON.stringify(spec, null, 2) + '\n';
}
