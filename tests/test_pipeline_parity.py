"""Parity: the CPython pipeline produces the same geometry as the browser (Pyodide)
ground truth captured from test_sphere.nii.gz. Proves CLI + browser share one backend.

Run: PYTHONPATH=. .venv/bin/python tests/test_pipeline_parity.py   (or via pytest)
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from glass_brains import pipeline as P
from glass_brains.arrays import write_overlay_arrays

# Ground truth from the in-browser smoketest on test_sphere.nii.gz @ threshold 2.3.
GT_BLOCKY = {'lh_cortex': 248, 'rh_cortex': 128, 'subcort_l': 144, 'subcort_r': 104}
GT_SMOOTH = {'lh_cortex': 2268, 'rh_cortex': 1126, 'subcort_l': 924, 'subcort_r': 764}
GT_MAXABS, GT_MAXCLU, GT_DIVERGING = 4.58, 81, False


def _find(*relpaths):
    for r in relpaths:
        p = ROOT / r
        if p.exists():
            return p
    raise FileNotFoundError(relpaths)


def test_pipeline_parity():
    aseg_gz = _find('glass_brains/web/data/aseg_uint8.bin.gz', 'comicbrains-in-browser/data/aseg_uint8.bin.gz')
    aseg_json = _find('glass_brains/web/data/aseg.json', 'comicbrains-in-browser/data/aseg.json')
    nifti = _find('test_sphere.nii.gz', 'comicbrains-in-browser/test_sphere.nii.gz')

    P.init_aseg(aseg_gz.read_bytes(), aseg_json.read_text())
    meta = json.loads(P.process_nifti(str(nifti), 'test_sphere.nii.gz', 2.3))

    assert round(meta['maxAbsValue'], 2) == GT_MAXABS, meta['maxAbsValue']
    assert meta['maxClusterSize'] == GT_MAXCLU
    assert meta['diverging'] is GT_DIVERGING
    for cat, want in GT_BLOCKY.items():
        s = meta['structures'][cat]
        assert s['blocky']['nverts'] == want, (cat, 'blocky', s['blocky']['nverts'])
        assert s['smooth']['nverts'] == GT_SMOOTH[cat], (cat, 'smooth', s['smooth']['nverts'])

    # write_overlay_arrays round-trips: bufferLayout slices reconstruct each buffer.
    import tempfile
    out = Path(tempfile.mkdtemp())
    buffers = P.get_all_buffers()
    m2 = write_overlay_arrays(out, meta, buffers, index=0)
    blob = (out / m2['buffersFile']).read_bytes()
    assert len(m2['bufferLayout']) == len(buffers)
    for (off, ln), buf in zip(m2['bufferLayout'], buffers):
        assert blob[off:off + ln] == buf
    # face indices in range; positions length == nverts*3
    b = meta['structures']['lh_cortex']['blocky']
    pos = np.frombuffer(buffers[b['pos']], np.float32)
    idx = np.frombuffer(buffers[b['idx']], np.uint32)
    assert pos.size == b['nverts'] * 3 and idx.max() < b['nverts']
    print("PASS — CPython pipeline matches browser ground truth; arrays round-trip")


if __name__ == "__main__":
    test_pipeline_parity()
