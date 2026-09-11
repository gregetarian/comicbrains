"""Exercise the real argument parser through its public CLI entry, without drawing."""
import copy
import json
import importlib

import pytest

from comic.core import cli
from comic.render import build_layout


@pytest.fixture
def command(tmp_path, monkeypatch):
    captured = {}
    def render(nifti, out, **kwargs):
        captured.update(nifti=nifti, out=out, **kwargs)
    monkeypatch.setattr(importlib.import_module('comic.render'), 'render_to_png', render)
    spec = {'layout': build_layout('1x1', ['dorsal']),
            'style': {'colormap': 'Purples', 'gamma': 1,
                      'overlays': [{'gamma': .2, 'positiveOnly': True, 'threshold': 4, 'clim': [0, 21],
                                    'units': {'value': 't', 'cluster': 'mm3'}}]},
            'render': {'width': 301, 'height': 205, 'pixelRatio': 3,
                       'background': '#123456', 'colorbar': False, 'colorbarWidth': 240},
            'inputs': [{'slot': 1, 'type': 'volume', 'name': 'map.nii.gz',
                        'label': 'Association', 'processingThreshold': 0}]}
    path = tmp_path / 'figure.json'
    def run(extra=(), document=None, files=('map.nii.gz',)):
        path.write_text(json.dumps(spec if document is None else document))
        cli(['render', *files, '--spec', str(path), '-o', str(tmp_path/'plot.png'), *extra])
        return captured
    return run, spec


def test_saved_settings_survive_when_no_overrides_supplied(command):
    run, _ = command
    result = run()
    assert result['style']['overlays'][0]['gamma'] == .2
    assert result['threshold'] == [0]
    assert result['names'] == ['Association']
    assert result['background'] == '#123456'
    assert result['scale'] == 3 and result['colorbar'] is False
    assert result['render_options']['colorbarWidth'] == 240


def test_explicit_flags_override_saved_overlay_values_even_when_equal_to_defaults(command):
    run, _ = command
    result = run(['--gamma=.5', '--cmap', 'YlGnBu', '--threshold', '0', '-k2',
                  '--no-positive-only', '--clim', '0,16', '--units', 'value=z',
                  '--edge-mode', 'outer', '--colorbar'])
    style, ov = result['style'], result['style']['overlays'][0]
    assert style['gamma'] == .5 and 'gamma' not in ov
    assert style['positiveOnly'] is False and 'positiveOnly' not in ov
    assert style['clim'] == [0, 16] and 'clim' not in ov
    assert style['threshold'] == 0 and 'threshold' not in ov
    assert style['voxel']['clusterMin'] == 2 and style['voxel']['edges']['mode'] == 'outer'
    assert style['units']['value'] == 'z' and ov['units'] == {'cluster': 'mm3'}
    assert result['cmap'] == 'YlGnBu' and result['threshold'] == [0] and result['colorbar']


def test_display_and_loading_cutoffs_can_be_changed_independently(command):
    run, _ = command
    result = run(['--threshold', '6'])
    assert result['style']['threshold'] == 6 and result['threshold'] == [0]
    result = run(['--threshold', '6', '--processing-threshold', '2'])
    assert result['threshold'] == [2]


def test_legacy_recipe_falls_back_to_effective_display_cutoff(command):
    run, spec = command
    doc = copy.deepcopy(spec)
    del doc['inputs'][0]['processingThreshold']
    assert run(['--threshold', '3'], document=doc)['threshold'] == [3]


def test_blank_threshold_slot_in_bare_recipe_inherits_default(command):
    run, _ = command
    result = run(['--threshold', '2,,4'], document=build_layout('1x1', ['dorsal']),
                 files=('a.nii.gz', 'b.nii.gz', 'c.nii.gz'))
    assert result['threshold'] == [2, 0, 4]


def test_style_file_defaults_survive_and_explicit_flags_broadcast(tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setattr(importlib.import_module('comic.render'), 'render_to_png',
                        lambda *a, **kw: captured.update(kw))
    path = tmp_path / 'style.json'
    path.write_text(json.dumps({'colormap': 'Greens', 'threshold': 5,
                               'voxel': {'clusterMin': 10},
                               'overlays': [{'gamma': .2}, {'gamma': .7}]}))
    base = ['render', 'a.nii.gz', 'b.nii.gz', '--style', str(path), '-o', str(tmp_path/'out.png')]
    cli(base)
    assert captured['cmap'] == 'Greens' and captured['threshold'] == [5, 5]
    assert captured['style']['voxel']['clusterMin'] == 10
    assert not any('colormap' in o for o in captured['style']['overlays'])
    cli([*base, '--threshold', '0', '-k0', '--cmap', 'Reds', '--gamma', '.5'])
    assert captured['cmap'] == 'Reds' and captured['threshold'] == [0, 0]
    assert captured['style']['voxel']['clusterMin'] == 0
    assert all('gamma' not in o for o in captured['style']['overlays'])


def test_parallel_render_servers_keep_their_own_assets(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from urllib.request import urlopen
    from comic.render import _serve_dir
    roots = []
    for i in range(4):
        root = tmp_path / str(i)
        root.mkdir()
        (root / 'sentinel.txt').write_text(str(i))
        roots.append(root)
    with ThreadPoolExecutor(max_workers=4) as pool:
        servers = list(pool.map(_serve_dir, roots))
    try:
        assert len({port for _, port in servers}) == 4
        for i, (server, port) in enumerate(servers):
            assert server.server_address[0] == '127.0.0.1'
            with urlopen(f'http://127.0.0.1:{port}/sentinel.txt') as response:
                assert response.read().decode() == str(i)
    finally:
        for server, _ in servers:
            server.shutdown()
            server.server_close()


def test_ordered_parcel_volume_surface_descriptors_keep_browser_order(command):
    run, spec = command
    descriptors = [{'type': 'parcel', 'path': "a,b's.csv", 'atlas': 'schaefer100_17'},
                   {'type': 'volume', 'path': 'b.nii.gz'},
                   {'type': 'surface', 'lh': "lh.c,=d.gii", 'name': 'C'}]
    doc = copy.deepcopy(spec)
    doc['style']['overlays'] = [{'gamma': .2}, {'gamma': .4}, {'gamma': .6}]
    doc['inputs'] = [{'slot': i+1, 'type': d['type'], 'name': str(i), 'processingThreshold': i}
                     for i, d in enumerate(descriptors)]
    flags = sum((['--input-json', json.dumps(d)] for d in descriptors), [])
    result = run(flags, document=doc, files=())
    assert result['input_maps'] == descriptors and result['nifti'] == []
    assert result['threshold'] == [0, 1, 2]
    assert [x['gamma'] for x in result['style']['overlays']] == [.2, .4, .6]


@pytest.mark.parametrize('flags, message', [
    (['--gamma', '.2,.3'], 'expected 1 per-overlay'),
    (['--processing-threshold', 'nan'], 'finite and nonnegative'),
    (['--grid', '1x1'], 'supplies the layout'),
    (['--input-json', '{"type":"volume","path":"x"}'], 'cannot be combined'),
    (['--overlay-json', '{}', '--overlay-json', '{}'], 'more entries than inputs'),
])
def test_invalid_requests_fail_before_loading_files(command, capsys, flags, message):
    run, _ = command
    with pytest.raises(SystemExit) as err:
        run(flags)
    assert err.value.code == 2 and message in capsys.readouterr().err
