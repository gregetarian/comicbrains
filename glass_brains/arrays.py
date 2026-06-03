"""Write a processed overlay to the static array format the viewer loads.

Mirrors how glass_brains/bake.py stages the demo overlay: one concatenated `.bin`
holding all the staged geometry buffers, with a `bufferLayout` of [offset, length]
per buffer index recorded in the meta. The viewer's asset-loader slices the `.bin`
back into the per-buffer Uint8Arrays and feeds them to buildOverlayMeshes() — the
exact same code path the browser uses for an uploaded NIfTI. Used by the CLI render
so it feeds overlays as arrays (no GLB, no trimesh).
"""

import json
from pathlib import Path


def write_overlay_arrays(out_dir, meta, buffers, index=0):
    """Concatenate `buffers` into out_dir/overlay_<index>.bin and annotate `meta`.

    Parameters
    ----------
    out_dir : path
    meta : dict   — the parsed process_nifti() meta (structures reference buffer indices)
    buffers : list[bytes]  — from pipeline.get_all_buffers()
    index : int   — overlay index (one .bin per overlay)

    Returns the meta dict augmented with `bufferLayout` + `buffersFile` (drop it
    into scene.json's `overlays` list).
    """
    out_dir = Path(out_dir)
    blob = bytearray()
    layout = []
    for buf in buffers:
        layout.append([len(blob), len(buf)])
        blob.extend(buf)
    fname = f"overlay_{index}.bin"
    (out_dir / fname).write_bytes(bytes(blob))
    meta = dict(meta)
    meta['bufferLayout'] = layout
    meta['buffersFile'] = fname
    return meta
