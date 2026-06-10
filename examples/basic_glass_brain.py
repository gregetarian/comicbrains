"""Basic glass brain — serve the interactive viewer locally.

Drop a NIfTI into the browser to render it (processed in-browser via Pyodide, no backend).
`GlassBrain` itself is the bake-only template loader; display config lives in the viewer.
"""

from glass_brains import open_viewer

open_viewer()
