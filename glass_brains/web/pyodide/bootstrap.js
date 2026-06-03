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

let _ready = null;   // memoised init promise (load runtime + packages + aseg + pipeline)

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
        const src = await fetch('pyodide/pipeline.py').then((r) => r.text());
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

/**
 * Process one uploaded NIfTI File entirely in the browser.
 * @returns {{ meta: object, buffers: Uint8Array[] }} — meta references buffer indices
 *   for each structure/variant; asset-loader.buildOverlayMeshes turns them into meshes.
 */
export async function processNifti(file, threshold = 2.3, onProgress = () => {}) {
    const { pipeline } = await ensurePyodide(onProgress);
    onProgress('Processing ' + file.name + '…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metaStr = pipeline.process_nifti(bytes, file.name, threshold);
    const meta = JSON.parse(metaStr);
    const proxy = pipeline.get_all_buffers();
    const buffers = proxy.toJs();   // [Uint8Array, ...] — one copy out of WASM memory
    proxy.destroy();
    pipeline.clear_buffers();        // free the WASM-side copies promptly
    return { meta, buffers };
}
