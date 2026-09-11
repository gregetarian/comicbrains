# Contributing to Comic

Bug reports, documentation corrections and focused pull requests are welcome. For a bug,
please include the interface used, browser or operating system, input type, coordinate
space, the smallest reproducible example you can share, and any console or terminal error.
Do not upload identifiable participant data to a public issue.

## Development installation

Clone the repository and install the development and rendering dependencies:

```bash
git clone https://github.com/gregetarian/comic
cd comic
pip install -e ".[dev,render]"
python -m playwright install chromium
```

Template rebuilding is a maintainer task and needs the separate `bake` extra:

```bash
pip install -e ".[dev,bake]"
```

## Checks

Run the fast checks before opening a pull request:

```bash
ruff check .
pytest -q
node --test comic/web/core/*.test.js
```

Some Python tests launch Playwright and require the Chromium installation above. The
continuous-integration workflow separates pure tests from slower render tests so failures
are easier to diagnose.

## Architecture rules

Two constraints prevent the public interfaces from drifting apart.

### Keep one processing pipeline

`comic/pipeline.py` is the canonical per-input processing code. The browser copy at
`comic/web/pyodide/pipeline.py` must remain byte-for-byte identical.

- Edit `comic/pipeline.py`, not the Pyodide copy.
- Regenerate the browser copy through the existing bake/synchronisation step.
- Run `PYTHONPATH=. python tests/test_pyodide_sync.py` after changing the pipeline.

### Keep one rendering and colour path

`comic/web/` is the sole figure renderer. Scripted output runs that application in
headless Chromium rather than implementing a second Python renderer. Value-to-colour
normalisation belongs in `comic/web/core/colormap.js`; do not add a parallel Python colour
path.

Shared source does not make PNG bytes portable across every graphics backend. Tests should
assert geometry, configuration and bounded visual behaviour rather than claiming universal
pixel identity.

## Generated and third-party assets

Do not hand-edit baked geometry, atlas binaries, colormap lookup tables or the vendored
Pyodide pipeline. Explain any intentional asset regeneration in the pull request and run
the relevant provenance and synchronisation tests.

Only assets with redistribution terms compatible with the repository may be committed.
Update [NOTICE.md](NOTICE.md) whenever a bundled third-party component or dataset changes.
Atlases that Comic fetches from a user's local installation must remain untracked.

## Pull requests

Keep changes focused, describe their user-facing effect, and report the checks actually
run. Include before-and-after figures for visual changes. Do not re-bless golden images
without inspecting the difference and explaining why it is intentional.

By contributing, you agree that your contribution is distributed under the repository's
MIT licence. Third-party material remains under its original terms.
