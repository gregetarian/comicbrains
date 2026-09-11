/**
 * bootstrap.js — load Pyodide + the scientific stack in the browser, then run the
 * NIfTI->geometry pipeline. No backend: this replaces the Python server entirely.
 *
 * Everything (Pyodide runtime, numpy/scipy/scikit-image, nibabel) is fetched from
 * the jsDelivr CDN on FIRST upload, not at page load — so the viewer is interactive
 * with the demo brain immediately and only pays the ~tens-of-MB download once a user
 * actually uploads a map. Runs on the main thread with a progress spinner; the
 * pipeline is a few seconds of CPU for a typical stat map.
 */

const PYODIDE_VERSION = '0.29.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const DATA = 'data/';

let _ready = null;      // memoised init promise (load runtime + packages + aseg + pipeline)
let _cortexReady = null; // memoised cortical-surface load (lazy: only when surface mode is used)

/** Load Pyodide, the package stack, the pipeline module, and the aseg volume — once. */
export function ensurePyodide(onProgress = () => {}) {
    if (_ready) return _ready;
    _ready = (async () => {
        onProgress('Loading Pyodide runtime…');
        const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE_CDN + 'pyodide.mjs');
        const py = await loadPyodide({ indexURL: PYODIDE_CDN });

        onProgress('Loading numpy / scipy / scikit-image…');
        await py.loadPackage(['numpy', 'scipy', 'scikit-image', 'micropip']);

        onProgress('Installing nibabel…');
        // Install from the vendored wheel (same-origin) so the deployed app has no
        // runtime PyPI/CORS dependency. deps=false: numpy + packaging are already
        // loaded above, and nibabel needs nothing else on Python 3.13.
        const micropip = py.pyimport('micropip');
        const wheelUrl = new URL(DATA + 'nibabel-5.4.2-py3-none-any.whl', document.baseURI).href;
        await micropip.install.callKwargs(wheelUrl, { deps: false });
        micropip.destroy();

        onProgress('Loading pipeline…');
        const src = await fetch('pyodide/pipeline.py?v=voxel-centres-v2').then((r) => r.text());
        py.FS.writeFile('/pipeline.py', src);
        py.runPython('import sys; sys.path.insert(0, "/")');
        const pipeline = py.pyimport('pipeline');

        onProgress('Loading segmentation…');
        const asegJson = await fetch(DATA + 'aseg.json').then((r) => r.text());
        const gz = new Uint8Array(await fetch(DATA + 'aseg_uint8.bin.gz').then((r) => r.arrayBuffer()));
        pipeline.init_aseg(gz, asegJson);

        return { py, pipeline };
    })();
    return _ready;
}

/** Load the cortical-surface sidecar into the pipeline — lazily, only when surface mode is first
 *  used (it is ~11 MB, so we don't pay it on boot or for volume-only sessions). */
export async function ensureCortex(onProgress = () => {}) {
    const { pipeline } = await ensurePyodide(onProgress);
    if (!_cortexReady) {
        _cortexReady = (async () => {
            onProgress('Loading cortical surface…');
            const json = await fetch(DATA + 'cortex_surface.json').then((r) => r.text());
            const gz = new Uint8Array(await fetch(DATA + 'cortex_surface.bin.gz').then((r) => r.arrayBuffer()));
            pipeline.init_cortex(gz, json);
        })();
    }
    return _cortexReady;
}

/**
 * Process one uploaded NIfTI File entirely in the browser.
 * @param {boolean} surface — also project onto the cortical surface (loads the sidecar on demand).
 * @returns {{ meta: object, buffers: Uint8Array[] }} — meta references buffer indices
 *   for each structure/variant; asset-loader.buildOverlayMeshes turns them into meshes.
 */
export async function processNifti(file, threshold = 2.3, onProgress = () => {}, surface = false) {
    const { pipeline } = await ensurePyodide(onProgress);
    if (surface) await ensureCortex(onProgress);
    onProgress('Processing ' + file.name + '…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metaStr = pipeline.process_nifti(bytes, file.name, threshold, true, surface);
    const meta = JSON.parse(metaStr);
    const proxy = pipeline.get_all_buffers();
    const buffers = proxy.toJs();   // [Uint8Array, ...] — one copy out of WASM memory
    proxy.destroy();
    pipeline.clear_buffers();        // free the WASM-side copies promptly
    return { meta, buffers };
}

/**
 * Process a NATIVE fsaverage surface overlay (per-vertex .gii/.mgh/.mgz files) in the browser.
 * Needs the cortical surface sidecar (loaded on demand, ~11 MB). Either hemisphere may be null.
 * @returns {{ meta: object, buffers: Uint8Array[] }} — meta.surfaceOnly === true, structures === {}.
 */
export async function processSurface(lhFile, rhFile, name, threshold = 2.3, onProgress = () => {}) {
    const { pipeline } = await ensurePyodide(onProgress);
    await ensureCortex(onProgress);
    onProgress('Processing surface ' + name + '…');
    const lhBytes = lhFile ? new Uint8Array(await lhFile.arrayBuffer()) : null;
    const rhBytes = rhFile ? new Uint8Array(await rhFile.arrayBuffer()) : null;
    const metaStr = pipeline.process_surface(lhBytes, rhBytes, name, threshold,
        lhFile ? lhFile.name : null, rhFile ? rhFile.name : null);
    const meta = JSON.parse(metaStr);
    const proxy = pipeline.get_all_buffers();
    const buffers = proxy.toJs();
    proxy.destroy();
    pipeline.clear_buffers();
    return { meta, buffers };
}

/**
 * Process ALREADY-EXPANDED per-vertex values (the parcel-vector upload: a table of one number per
 * parcel, painted onto the vertices in JS because the browser already holds the atlas labels).
 * Goes through the SAME process_surface as a .gii, so the overlay, colormap, threshold and
 * colorbar behave identically — only the source of the numbers differs.
 *
 * `lhVals`/`rhVals` are Float32Array (or null). They are converted to real numpy arrays on the
 * Python side first: a TypedArray crosses the FFI as a JsProxy, so `isinstance(x, np.ndarray)` is
 * false and `bytes(x)` raises on a float array. `.to_py()` is the cheap, dtype-preserving
 * conversion (np.asarray on the proxy directly would silently widen float32 to float64).
 */
export async function processParcelValues(lhVals, rhVals, name, threshold, onProgress = () => {}) {
    const { py, pipeline } = await ensurePyodide(onProgress);
    await ensureCortex(onProgress);
    onProgress('Painting ' + name + '…');
    const toF32 = py.runPython(
        'import numpy as np\n'
        + 'def _gb_f32(x):\n'
        + '    return np.ascontiguousarray(np.asarray(x.to_py()), dtype=np.float32)\n'
        + '_gb_f32');
    const lhArr = lhVals ? toF32(lhVals) : null;
    const rhArr = rhVals ? toF32(rhVals) : null;
    try {
        const metaStr = pipeline.process_surface(lhArr, rhArr, name, threshold, null, null);
        const meta = JSON.parse(metaStr);
        const proxy = pipeline.get_all_buffers();
        const buffers = proxy.toJs();
        proxy.destroy();
        pipeline.clear_buffers();
        return { meta, buffers };
    } finally {
        lhArr?.destroy(); rhArr?.destroy(); toF32.destroy();
    }
}
