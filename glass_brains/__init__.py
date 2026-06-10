"""Glass Brains 2.0 — Interactive 3D glass brain viewer + headless/notebook renderer."""

from .core import GlassBrain, open_viewer
from .figure import render, render_spec, Scene, Figure
from .render import RenderSession, render_to_png, render_batch, render_orbit, build_layout
from .bake import bake_template

__version__ = "0.1.0"
__all__ = [
    "GlassBrain", "open_viewer",
    "render", "render_spec", "Scene", "Figure",        # notebook / Python API
    "RenderSession", "render_to_png", "build_layout",  # headless render path
    "render_batch", "render_orbit",                     # batch + turntable animation (M10)
    "bake_template",                                    # custom / non-MNI template (M9)
]
