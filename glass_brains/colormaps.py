"""Export colormaps from the `cmap` package to a JSON LUT the viewer reads.

JS holds no hardcoded colormaps; it samples these LUTs. Each entry carries its
`cmap` category (sequential/diverging/...), which drives the automatic
sequential-vs-diverging default and the positive-data washout guard.
"""

import json
import numpy as np
import cmap as cmaplib

# Curated neuroimaging-relevant default set (small JSON). Use --all for everything.
CURATED = [
    # sequential
    "viridis", "plasma", "inferno", "magma", "cividis", "turbo",
    "hot", "afmhot", "gist_heat", "YlOrRd", "YlOrBr", "OrRd", "Reds",
    "YlGnBu", "Blues", "Greens", "Purples", "Greys", "cool", "Wistia", "bone",
    # diverging
    "coolwarm", "bwr", "seismic", "RdBu", "RdBu_r", "RdYlBu", "Spectral",
    "PiYG", "BrBG", "PuOr", "RdGy",
    # misc
    "jet", "rainbow", "gist_rainbow",
]


def export_colormaps(out_path, names=None, n=256):
    """Write {n, maps:{name:{lut:[[r,g,b],...] sRGB 0..1, category}}} to out_path."""
    cat = cmaplib.Catalog()
    available = set(cat)
    if names is None:
        names = [nm for nm in CURATED if nm in available]
    elif names == "all":
        names = sorted(available)

    x = np.linspace(0.0, 1.0, n)
    maps = {}
    for name in names:
        if name not in available:
            print(f"  colormap '{name}' not in cmap catalog — skipping")
            continue
        lut = np.asarray(cmaplib.Colormap(name)(x))[:, :3]  # (n,3) sRGB 0..1
        try:
            category = cat[name].category
        except Exception:
            category = "sequential"
        maps[name] = {"lut": np.round(lut, 4).tolist(), "category": category}

    with open(out_path, "w") as f:
        json.dump({"n": n, "maps": maps}, f)
    print(f"Exported {len(maps)} colormaps -> {out_path}")
    return list(maps)
