"""Ordered scientific input descriptors shared by the CLI and saved-figure API."""
from pathlib import Path
import math


def input_descriptors(nifti=None, surface_maps=None, input_maps=None):
    if input_maps is not None:
        if nifti or surface_maps:
            raise ValueError("ordered inputs cannot be combined with positional volumes or surface_maps")
        items = list(input_maps)
    else:
        volumes = [] if nifti is None else ([nifti] if isinstance(nifti, (str, Path)) else list(nifti))
        items = [{"type": "volume", "path": p} for p in volumes]
        items += [{"type": "surface", **sm} for sm in (surface_maps or [])]
    out = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"input {i + 1} must be an object")
        d = dict(item)
        kind = d.get("type", "volume")
        if kind not in ("volume", "surface", "parcel"):
            raise ValueError(f"input {i + 1}: unknown type {kind!r}")
        if kind in ("volume", "parcel") and (not isinstance(d.get("path"), (str, Path)) or not str(d["path"]).strip()):
            raise ValueError(f"input {i + 1}: {kind} needs a path")
        if kind == "surface" and d.get("lh") is None and d.get("rh") is None:
            raise ValueError(f"input {i + 1}: surface needs lh or rh")
        if kind == "parcel" and (not isinstance(d.get("atlas"), str) or not d["atlas"].strip()):
            raise ValueError(f"input {i + 1}: parcel needs an atlas")
        d["type"] = kind
        out.append(d)
    return out


def processing_thresholds(doc, n, fallback=0):
    """Prefer recorded load cutoffs; old recipes retain their display-cutoff behavior."""
    style = doc.get("style") or {}
    overlays, slots = style.get("overlays") or [], doc.get("inputs") or []
    out = []
    for i in range(n):
        slot = slots[i] if i < len(slots) else {}
        ov = overlays[i] or {} if i < len(overlays) else {}
        value = slot.get("processingThreshold")
        if value is None:
            value = ov.get("threshold")
        if value is None:
            value = style.get("threshold")
        if value is None:
            value = fallback[i] if isinstance(fallback, (list, tuple)) else fallback
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"input {i + 1}: processing threshold must be finite and nonnegative")
        out.append(float(value))
    return out


def input_names(doc, n):
    slots = doc.get("inputs") or []
    overlays = (doc.get("style") or {}).get("overlays") or []
    return [((overlays[i] or {}).get("name") if i < len(overlays) else None)
            or (slots[i].get("label") if i < len(slots) else None) for i in range(n)]


def validate_input_types(doc, descriptors):
    for i, (slot, actual) in enumerate(zip(doc.get("inputs") or [], descriptors)):
        expected = slot.get("type", "volume")
        # Old parcel recipes advertised expanded native surfaces.
        if expected != actual["type"] and not (expected == "surface" and actual["type"] == "parcel"):
            raise ValueError(f"input {i + 1}: recipe expects {expected}, received {actual['type']}")
