"""Saved recipes retain scientific inputs and display state across Python replay.

Only the browser session is substituted here. Input normalization, recipe
validation and render_spec argument binding all run their real implementations.
"""
import copy
import json
from pathlib import Path
import shutil
import subprocess

import pytest

import comic as gb
from comic import figure as figure_module
from comic.inputs import input_descriptors, input_names, processing_thresholds, validate_input_types
from comic.render import VIEWS, _render_config, _wants_surface, build_layout, to_volume_layout


class StubSession:
    def __init__(self, **kwargs):
        self.options = kwargs
        self.calls = []
        self.closed = False

    def render(self, nifti, out, **kwargs):
        self.calls.append((nifti, out, kwargs))
        return b"\x89PNG\r\n\x1a\n", None

    def close(self):
        self.closed = True


def recipe(types=("volume",)):
    return {
        "layout": build_layout("1x1", ["left_lateral"]),
        "style": {"threshold": 2.3, "voxel": {"representation": "smooth"}},
        "inputs": [{"slot": i + 1, "name": f"source-{i}", "type": kind}
                   for i, kind in enumerate(types)],
    }


def test_processing_threshold_precedence_preserves_zero_and_display_state():
    doc = recipe(("volume",) * 4)
    doc["inputs"][0]["processingThreshold"] = 0
    doc["inputs"][1]["processingThreshold"] = 1.5
    doc["style"]["overlays"] = [{"threshold": 4}, {"threshold": 5}, {"threshold": 0}, {}]
    unchanged = copy.deepcopy(doc)
    session = StubSession()
    gb.render_spec(doc, ["a.nii.gz", "b.nii.gz", "c.nii.gz", "d.nii.gz"], session=session)
    kwargs = session.calls[0][2]
    assert kwargs["threshold"] == [0, 1.5, 0, 2.3]
    assert kwargs["style"] == unchanged["style"]  # display thresholds stay independent
    assert doc == unchanged
    assert not session.closed  # caller owns a supplied reusable session


def test_legacy_threshold_fallbacks_and_per_input_defaults():
    assert processing_thresholds({}, 2) == [0, 0]
    assert processing_thresholds({}, 2, fallback=(1, 2)) == [1, 2]
    assert processing_thresholds({"style": {"threshold": 0}}, 2, fallback=5) == [0, 0]
    assert processing_thresholds({"style": {"overlays": [None, {"threshold": 3}]}}, 2) == [0, 3]


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), -float("inf"), True, "2.3"])
@pytest.mark.parametrize("location", ["processing", "overlay", "global", "fallback"])
def test_nonfinite_negative_and_nonnumeric_processing_cutoffs_fail(value, location):
    doc = {}
    fallback = 0
    if location == "processing":
        doc["inputs"] = [{"processingThreshold": value}]
    elif location == "overlay":
        doc["style"] = {"overlays": [{"threshold": value}]}
    elif location == "global":
        doc["style"] = {"threshold": value}
    else:
        fallback = value
    with pytest.raises(ValueError, match="finite and nonnegative"):
        processing_thresholds(doc, 1, fallback=fallback)


def test_mixed_descriptor_replay_preserves_slot_order_and_name_priority():
    doc = recipe(("surface", "volume", "parcel"))
    doc["inputs"][0].update(label="Saved surface", processingThreshold=0)
    doc["inputs"][1].update(label="Saved volume", processingThreshold=1)
    doc["inputs"][2].update(label="Saved parcels", processingThreshold=2)
    doc["style"]["overlays"] = [{"name": "Renamed surface"}, {}, {"name": "Renamed parcels"}]
    descriptors = [
        {"type": "surface", "lh": "left.func.gii", "rh": "right.func.gii"},
        Path("effect.nii.gz"),
        {"type": "parcel", "path": "values.csv", "atlas": "schaefer100_17"},
    ]
    before = copy.deepcopy(descriptors)
    session = StubSession()
    gb.render_spec(doc, descriptors, session=session)
    nifti, _, kwargs = session.calls[0]
    assert nifti is None
    assert [item["type"] for item in kwargs["input_maps"]] == ["surface", "volume", "parcel"]
    assert kwargs["input_maps"][1]["path"] == Path("effect.nii.gz")
    assert kwargs["threshold"] == [0, 1, 2]
    assert kwargs["names"] == ["Renamed surface", "Saved volume", "Renamed parcels"]
    assert descriptors == before
    explicit = ["A", "B", "C"]
    gb.render_spec(doc, descriptors, session=session, names=explicit)
    assert session.calls[-1][2]["names"] == explicit


def test_missing_display_names_leave_original_input_names_available():
    doc = recipe(("volume", "surface"))
    doc["inputs"][1]["label"] = "Surface label"
    doc["style"]["overlays"] = [{"name": ""}, None]
    assert input_names(doc, 2) == [None, "Surface label"]


@pytest.mark.parametrize("descriptor, message", [
    ({"type": "volume"}, "volume needs a path"),
    ({"type": "surface"}, "surface needs lh or rh"),
    ({"type": "parcel", "path": "values.csv"}, "parcel needs an atlas"),
    ({"type": "mystery", "path": "a"}, "unknown type"),
    ("not-an-object", "must be an object"),
])
def test_invalid_descriptors_are_rejected_before_loading_data(descriptor, message):
    with pytest.raises(ValueError, match=message):
        input_descriptors(input_maps=[descriptor])


def test_ordered_inputs_cannot_be_silently_combined_with_legacy_input_lists():
    with pytest.raises(ValueError, match="cannot be combined"):
        input_descriptors("extra.nii.gz", input_maps=[{"type": "volume", "path": "first.nii.gz"}])


def test_slot_type_mismatch_fails_before_a_session_renders():
    session = StubSession()
    with pytest.raises(ValueError, match="expects surface, received volume"):
        gb.render_spec(recipe(("surface",)), "actually-volume.nii.gz", session=session)
    assert session.calls == []
    # Earlier parcel recipes described the expanded data as a native surface.
    validate_input_types(recipe(("surface",)), [{"type": "parcel"}])
    with pytest.raises(ValueError, match="expects parcel, received surface"):
        validate_input_types(recipe(("parcel",)), [{"type": "surface"}])


def test_saved_background_scale_hidden_legend_and_volume_only_template_survive_replay():
    doc = recipe()
    doc["template"] = {"kind": "none", "dir": None, "space": "native"}
    doc["layout"] = to_volume_layout(doc["layout"])
    doc["layout"]["canvas"] = {"W": 640, "H": 480, "bgAlpha": 0}
    doc["render"] = {"width": 640, "height": 480, "pixelRatio": 3,
                     "background": "#dceeff", "colorbar": False,
                     "colorbarFont": "Georgia", "colorbarFontSize": 17}
    doc["inputs"][0]["processingThreshold"] = 0
    session = StubSession()
    result = gb.render_spec(doc, "map.nii.gz", session=session)
    kwargs = session.calls[0][2]
    assert (kwargs["width"], kwargs["height"], kwargs["scale"]) == (640, 480, 3)
    assert kwargs["background"] == "#dceeff" and kwargs["background_alpha"] == 0
    assert kwargs["colorbar"] is False and kwargs["classify"] is False
    assert kwargs["render_options"] == doc["render"]
    assert result.config["inputs"] == doc["inputs"]
    assert result.config["render"] == doc["render"]

    changed = gb.render_spec(doc, "map.nii.gz", session=session, width=900, height=700,
                             scale=1, colorbar=True, background_alpha=0.6)
    overridden = session.calls[-1][2]
    assert (overridden["width"], overridden["height"], overridden["scale"]) == (900, 700, 1)
    assert overridden["colorbar"] is True and overridden["background_alpha"] == 0.6
    assert changed.config["render"]["width"] == 900 and changed.config["render"]["height"] == 700
    assert changed.config["render"]["pixelRatio"] == 1 and changed.config["render"]["colorbar"] is True
    assert changed.config["layout"]["canvas"]["bgAlpha"] == 0.6
    assert changed.config["template"] == doc["template"]
    changed.config["inputs"][0]["processingThreshold"] = 9
    assert doc["inputs"][0]["processingThreshold"] == 0


@pytest.mark.parametrize("explicit", [None, "/replacement/template"])
def test_custom_template_directory_reaches_the_owned_session(monkeypatch, explicit):
    doc = recipe()
    doc["template"] = {"kind": "custom", "dir": "/saved/template", "space": "custom"}
    sessions = []

    def make_session(**kwargs):
        session = StubSession(**kwargs)
        sessions.append(session)
        return session

    monkeypatch.setattr(figure_module, "RenderSession", make_session)
    gb.render_spec(doc, "map.nii.gz", template=explicit)
    assert sessions[0].options["template_dir"] == (explicit or "/saved/template")
    assert sessions[0].closed


def test_custom_template_without_directory_requires_a_prepared_session():
    doc = recipe()
    doc["template"] = {"kind": "custom", "space": "custom"}
    with pytest.raises(ValueError, match="custom template recipe needs"):
        gb.render_spec(doc, "map.nii.gz")
    session = StubSession()
    gb.render_spec(doc, "map.nii.gz", session=session)
    assert len(session.calls) == 1


def test_editing_one_named_panel_does_not_change_other_panels_or_the_view_registry(monkeypatch):
    name = "cortex_subcort_lm"
    # Restore the original registry entry even if a regression causes this test to
    # mutate it, so later tests are not contaminated by the failure being diagnosed.
    monkeypatch.setitem(VIEWS, name, copy.deepcopy(VIEWS[name]))
    expected = copy.deepcopy(VIEWS[name][1])
    first = build_layout("1x2", [name, name])
    second = build_layout("1x1", [name])
    edited = first["panels"][0]["content"]
    edited["representation"] = "surface"
    edited["anatomyCategories"].append("additional-region")
    assert first["panels"][1]["content"] == expected
    assert second["panels"][0]["content"] == expected
    assert VIEWS[name][1] == expected


def test_named_paired_views_match_browser_and_do_not_force_surface_projection():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required to compare the browser view definitions")
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [node, "--input-type=module", "-e",
         "import {VIEWS} from './comic/web/core/views.js'; console.log(JSON.stringify(VIEWS));"],
        cwd=root, capture_output=True, text=True, check=True,
    )
    browser = json.loads(completed.stdout)
    for name in [name for name in VIEWS if name.startswith("cortex_subcort")]:
        plane, content, title = VIEWS[name]
        assert plane == browser[name]["plane"] and title == browser[name]["title"]
        # Explicit null and an absent optional filter both mean unrestricted.
        assert {k: v for k, v in content.items() if v is not None} == {
            k: v for k, v in browser[name]["content"].items() if v is not None}
        layout = build_layout("1x1", [name])
        assert "representation" not in content
        assert not _wants_surface({"voxel": {"representation": "smooth"}}, layout)
        assert not _wants_surface({"voxel": {"representation": "blocky"}}, layout)
        assert _wants_surface({"voxel": {"representation": "surface"}}, layout)


def test_cli_cosmetic_defaults_match_fresh_browser_style_and_allow_overrides():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required to compare the browser's startup preset")
    root = Path(__file__).resolve().parents[1]
    # Resolve the actual shipped startup config, not a second copy of expected
    # constants. This catches future changes to either the selected preset or style.
    script = """
        import fs from 'node:fs';
        import {resolveConfig} from './comic/web/core/presets.js';
        const rc = JSON.parse(fs.readFileSync('./comic/web/data/render-config.json'));
        console.log(JSON.stringify(resolveConfig(rc.preset, {style: rc.style})));
    """
    completed = subprocess.run([node, "--input-type=module", "-e", script], cwd=root,
                               capture_output=True, text=True, check=True)
    browser_config = json.loads(completed.stdout)
    browser_style = browser_config["style"]
    options = dict(cmap="YlGnBu", width=700, height=400, scale=1, background="#ffffff",
                   colorbar=True, colorbar_font=None, colorbar_fontsize=None, background_alpha=1)
    layout = build_layout("1x1", ["cortex_subcort_lm"])
    default, _ = _render_config(layout, {}, **options)
    # Normalize the staged CLI config through the real JS defaults, as headless
    # startup does, so inherited fields are compared as well as explicit fields.
    normalize = """
        import {normalizeConfig} from './comic/web/core/config-schema.js';
        console.log(JSON.stringify(normalizeConfig(JSON.parse(process.argv[1])).style));
    """
    completed = subprocess.run([node, "--input-type=module", "-e", normalize, json.dumps(default)],
                               cwd=root, capture_output=True, text=True, check=True)
    cli_style = json.loads(completed.stdout)
    # Browser Free Canvas panels explicitly override the global margin. A CLI
    # grid needs their effective margin as its fallback, not the tighter global
    # value; putting a margin on each CLI panel would defeat the --margin flag.
    effective_margins = {p.get("framing", {}).get("margin", browser_style["margin"])
                         for p in browser_config["layout"]["panels"]}
    assert effective_margins == {cli_style["margin"]}
    assert {k: v for k, v in cli_style.items() if k != "margin"} == {
        k: v for k, v in browser_style.items() if k != "margin"}
    custom = {"cortexSurface": "inflated", "outline": {"width": 1.25},
              "glass": {"maxOpacity": 0.2}, "margin": 1.1}
    styled, _ = _render_config(layout, custom, **options)
    for key, value in custom.items():
        assert styled["style"][key] == value
