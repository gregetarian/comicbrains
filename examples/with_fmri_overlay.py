"""Glass brain with a statistical overlay.

Interactive viewer, plus how to render the same data to a PNG headlessly.
Replace the path with your own z/t-stat NIfTI (MNI152 space).
"""

from glass_brains import GlassBrain

gb = GlassBrain()
gb.add_overlay("your_stat_map.nii.gz", threshold=2.3)
gb.show()                      # build assets, serve, open the browser

# Headless figure straight to PNG (needs the `render` extra + chromium):
#   from glass_brains.render import build_layout, render_to_png
#   render_to_png(
#       "your_stat_map.nii.gz", "figure.png",
#       layout=build_layout("2x2", ["left_lateral", "right_lateral", "axial", "frontal"]),
#   )
