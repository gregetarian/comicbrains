"""Render a statistical overlay to a figure (needs the `[render]` extra + Chromium).

Replace the path with your own z/t-stat NIfTI in MNI152 space. In a Jupyter / VSCode
interactive notebook, `fig` displays inline. For the interactive viewer instead, call
open_viewer() and drag the NIfTI into the browser.
"""
import glass_brains as gb

fig = gb.render(
    "your_stat_map.nii.gz",
    views=["left_lateral", "right_lateral", "left_medial", "right_medial"],
    grid="2x2", threshold=2.3, cmap="YlGnBu",
)
fig.save("figure.png")   # in a notebook, just evaluate `fig` to show it inline

# Several maps, each its own colormap (scalar = same for all; list = one per overlay):
#   gb.render(["faces.nii.gz", "language.nii.gz"], cmap=["Reds", "YlGnBu"], threshold=[4.0, 2.3])
#
# Reproduce a browser Copy-CLI figure.json exactly:
#   gb.render_spec("figure.json", ["faces.nii.gz", "language.nii.gz"])
#
# Interactive viewer (drag the NIfTI into the browser):
#   gb.open_viewer()
