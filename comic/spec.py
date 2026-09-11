"""Validate a figure spec (the figure.json the browser Copy-CLI emits) in CPython,
mirroring web/core/config-schema.js:validateConfig so a hand-authored or notebook-built
spec fails LOUDLY the same way the browser would — never a silent degrade.

`comic render --spec` and the (M5) notebook API both run a spec through validate()
before handing it to the engine, so the three front-ends agree on what a valid figure is.
"""

import re
import math

TEMPLATE_KINDS = {"mni", "custom", "none"}
REPRESENTATIONS = {"blocky", "smooth", "surface", None}
VOLUME_REPRESENTATIONS = {"blocky", "smooth", None}
ROLES = {"cortex", "anatomy", "voxel"}
HEMI = {"lh", "rh", "both"}
INPUT_TYPES = {"volume", "surface", "parcel"}


_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _clim_ok(c):
    return (c is None or isinstance(c, (int, float))
            or (isinstance(c, (list, tuple)) and len(c) == 2
                and all(isinstance(x, (int, float)) for x in c) and c[0] < c[1]))


def _color_ok(c):
    """None = 'inherit' and always passes, mirroring colorOk in config-schema.js."""
    return c is None or (isinstance(c, str) and _HEX_RE.match(c) is not None)


def _width_ok(w):
    return w is None or (isinstance(w, (int, float)) and not isinstance(w, bool) and w > 0)


def validate(spec):
    """Raise ValueError on any invariant violation. `spec` is a full config
    ({layout, style?, template?, render?}) or a bare layout ({panels:[...]}).
    Returns the config dict (with `layout` present) on success."""
    cfg = spec if "layout" in spec else {"layout": spec}
    errs = []

    kind = (cfg.get("template") or {}).get("kind", "mni")
    if kind not in TEMPLATE_KINDS:
        errs.append(f"template.kind must be one of {sorted(TEMPLATE_KINDS)}, got {kind!r}")
    no_template = kind == "none"

    inputs = cfg.get("inputs")
    if inputs is not None:
        if not isinstance(inputs, list) or not inputs:
            errs.append("inputs must be a non-empty list when present")
        else:
            for i, item in enumerate(inputs):
                if not isinstance(item, dict):
                    errs.append(f"inputs[{i}] must be an object")
                    continue
                if item.get("slot") != i + 1:
                    errs.append(f"inputs[{i}].slot must be {i + 1}")
                if not isinstance(item.get("name"), str) or not item.get("name"):
                    errs.append(f"inputs[{i}].name must be a non-empty string")
                if item.get("type", "volume") not in INPUT_TYPES:
                    errs.append(f"inputs[{i}].type must be one of {sorted(INPUT_TYPES)}")
                t = item.get('processingThreshold')
                if t is not None and (isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0):
                    errs.append(f"inputs[{i}].processingThreshold must be finite and nonnegative")

    style = cfg.get("style") or {}
    if not _clim_ok(style.get("clim")):
        errs.append("style.clim must be null, a number, or [vmin, vmax] with vmin < vmax")
    rep = (style.get("voxel") or {}).get("representation")
    if rep not in REPRESENTATIONS:
        errs.append(f"style.voxel.representation invalid: {rep!r}")
    subrep = (style.get("voxel") or {}).get("subcortexRepresentation")
    if subrep not in VOLUME_REPRESENTATIONS:
        errs.append(f"style.voxel.subcortexRepresentation invalid: {subrep!r}")
    outline = style.get("outline") or {}
    silhouette = outline.get("silhouette") or {}
    for path, value in (("style.outline.color", outline.get("color")),
                        ("style.outline.anatomyColor", outline.get("anatomyColor")),
                        ("style.outline.silhouette.color", silhouette.get("color")),
                        ("style.voxel.edges.color", ((style.get("voxel") or {}).get("edges") or {}).get("color"))):
        if not _color_ok(value):
            errs.append(f"{path} must be null or a #rgb/#rrggbb colour, got {value!r}")
    if not _width_ok(silhouette.get("width")):
        errs.append(f"style.outline.silhouette.width must be null or a positive number, got {silhouette.get('width')!r}")
    vox = style.get("voxel") or {}
    for path, a in (("style.voxel.opacity", vox.get("opacity")),
                    ("style.voxel.edges.opacity", (vox.get("edges") or {}).get("opacity"))):
        if a is not None and not (isinstance(a, (int, float)) and 0 <= a <= 1):
            errs.append(f"{path} must be 0..1, got {a!r}")
    parc = style.get("parcellation") or {}
    if parc:
        if not _color_ok(parc.get("color")):
            errs.append(f"style.parcellation.color must be a #rgb/#rrggbb colour, got {parc.get('color')!r}")
        if not _width_ok(parc.get("width")):
            errs.append(f"style.parcellation.width must be a positive number, got {parc.get('width')!r}")
        op = parc.get("opacity")
        if op is not None and not (isinstance(op, (int, float)) and 0 <= op <= 1):
            errs.append(f"style.parcellation.opacity must be 0..1, got {op!r}")
    for i, o in enumerate(style.get("overlays") or []):
        if not o:
            continue
        if not _clim_ok(o.get("clim")):
            errs.append(f"style.overlays[{i}].clim invalid (null | number | [vmin<vmax])")
        orep = (o.get("voxel") or {}).get("representation")
        if orep not in REPRESENTATIONS:
            errs.append(f"style.overlays[{i}].voxel.representation invalid: {orep!r}")
        osubrep = (o.get("voxel") or {}).get("subcortexRepresentation")
        if osubrep not in VOLUME_REPRESENTATIONS:
            errs.append(f"style.overlays[{i}].voxel.subcortexRepresentation invalid: {osubrep!r}")

    panels = (cfg.get("layout") or {}).get("panels")
    if not isinstance(panels, list) or not panels:
        errs.append("layout.panels must be a non-empty array")
    for i, p in enumerate(panels or []):
        if not p.get("id"):
            errs.append(f"panel[{i}] missing id")
        if not p.get("camera"):
            errs.append(f"panel[{i}] ({p.get('id')}) missing camera")
        cell, place = p.get("cell"), p.get("place")
        has_cell = bool(cell and cell.get("row") is not None and cell.get("col") is not None)
        has_place = bool(place and place.get("w") is not None and place.get("h") is not None)
        if has_cell == has_place:
            errs.append(f"panel[{i}] ({p.get('id')}) needs exactly one of cell {{row,col}} or place {{x,y,w,h}}")
        content = p.get("content") or {}
        for r in content.get("roles") or []:
            if r not in ROLES:
                errs.append(f"panel {p.get('id')}: bad role {r!r}")
        hemi = content.get("hemisphere")
        if hemi and hemi not in HEMI:
            errs.append(f"panel {p.get('id')}: bad hemisphere {hemi!r}")
        anatomy_hemi = content.get("anatomyHemisphere")
        if anatomy_hemi and anatomy_hemi not in HEMI:
            errs.append(f"panel {p.get('id')}: bad anatomy hemisphere {anatomy_hemi!r}")
        for key in ("categories", "anatomyCategories", "voxelCategories"):
            cats = content.get(key)
            if cats is not None and (not isinstance(cats, (list, tuple))
                                     or any(not isinstance(cat, str) for cat in cats)):
                errs.append(f"panel {p.get('id')}: {key} must be null or a list of category names")
        crep = content.get("representation")
        if crep not in REPRESENTATIONS:
            errs.append(f"panel {p.get('id')}: bad representation {crep!r}")
        if no_template:
            if any(r in ("cortex", "anatomy") for r in content.get("roles") or []):
                errs.append(f"panel {p.get('id')}: template.kind 'none' has no shell — use roles ['voxel']")
            if hemi in ("lh", "rh"):
                errs.append(f"panel {p.get('id')}: template.kind 'none' has no hemisphere split — use 'both'")

    if errs:
        raise ValueError("Invalid figure spec:\n  " + "\n  ".join(errs))
    return cfg


def validate_input_count(spec, n, *, volume_only=False):
    """Fail loudly when a new browser export declares data slots but the caller supplies a
    different number. Older specs without `inputs` remain backward-compatible."""
    inputs = spec.get("inputs")
    if inputs is None:
        return
    if len(inputs) != n:
        names = ", ".join(f"{x.get('slot')}:{x.get('name')}" for x in inputs if isinstance(x, dict))
        raise ValueError(f"figure.json expects {len(inputs)} input(s) ({names}); received {n}")
    if volume_only and any(x.get("type", "volume") != "volume" for x in inputs):
        raise ValueError("comic.render_spec currently accepts volume slots only; use `comic render --surface-map ... --spec figure.json` for native surface inputs")
