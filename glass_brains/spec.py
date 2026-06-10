"""Validate a figure spec (the figure.json the browser Copy-CLI emits) in CPython,
mirroring web/core/config-schema.js:validateConfig so a hand-authored or notebook-built
spec fails LOUDLY the same way the browser would — never a silent degrade.

`glass-brains render --spec` and the (M5) notebook API both run a spec through validate()
before handing it to the engine, so the three front-ends agree on what a valid figure is.
"""

TEMPLATE_KINDS = {"mni", "custom", "none"}
REPRESENTATIONS = {"blocky", "smooth", "surface", None}
ROLES = {"cortex", "anatomy", "voxel"}
HEMI = {"lh", "rh", "both"}


def _clim_ok(c):
    return (c is None or isinstance(c, (int, float))
            or (isinstance(c, (list, tuple)) and len(c) == 2
                and all(isinstance(x, (int, float)) for x in c) and c[0] < c[1]))


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

    style = cfg.get("style") or {}
    if not _clim_ok(style.get("clim")):
        errs.append("style.clim must be null, a number, or [vmin, vmax] with vmin < vmax")
    rep = (style.get("voxel") or {}).get("representation")
    if rep not in REPRESENTATIONS:
        errs.append(f"style.voxel.representation invalid: {rep!r}")
    for i, o in enumerate(style.get("overlays") or []):
        if not o:
            continue
        if not _clim_ok(o.get("clim")):
            errs.append(f"style.overlays[{i}].clim invalid (null | number | [vmin<vmax])")
        orep = (o.get("voxel") or {}).get("representation")
        if orep not in REPRESENTATIONS:
            errs.append(f"style.overlays[{i}].voxel.representation invalid: {orep!r}")

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
