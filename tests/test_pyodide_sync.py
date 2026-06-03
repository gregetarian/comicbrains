"""The browser's Pyodide copy of the pipeline must be byte-identical to the canonical
one, so there is genuinely ONE pipeline source. `glass-brains bake` keeps them in sync."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_pyodide_pipeline_in_sync():
    canonical = (ROOT / "glass_brains" / "pipeline.py").read_bytes()
    shipped = (ROOT / "glass_brains" / "web" / "pyodide" / "pipeline.py").read_bytes()
    assert canonical == shipped, (
        "web/pyodide/pipeline.py has drifted from glass_brains/pipeline.py — run `glass-brains bake`")
    print("PASS — web/pyodide/pipeline.py is byte-identical to glass_brains/pipeline.py")


if __name__ == "__main__":
    test_pyodide_pipeline_in_sync()
