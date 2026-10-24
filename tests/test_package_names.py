"""This repository's Python packages must not shadow the pru-simulator checkout's.

The simulation tests import this repository's device models and TI pru-simulator in the same process (pytest puts the
repository root on sys.path). A repository-root package named like one of the simulator's (core, perif, pru_io, ...)
is cached in sys.modules by the first import and then hides the simulator's package, so a later
`from core.pru_core import PRUCore` inside simulator.py fails with ModuleNotFoundError.

The static check needs nothing installed. The import check runs in a fresh interpreter and needs a pru-simulator
checkout (PRU_SIMULATOR_PATH); it skips without one.
"""
import os
import subprocess
import sys
import textwrap

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SIMDIR = os.environ.get("PRU_SIMULATOR_PATH", "")
HAVE_SIM = os.path.isfile(os.path.join(SIMDIR, "simulator.py"))

# Top-level packages of the pru-simulator checkout (simulator.py imports core.*, perif.*, pru_io.*, xfr.*).
SIMULATOR_TOPS = {"core", "perif", "pru_io", "xfr", "simulator", "tools", "mcp_server", "ui"}


def _repo_packages():
    return {d for d in os.listdir(ROOT)
            if os.path.isfile(os.path.join(ROOT, d, "__init__.py")) or (d.endswith(".py") and d != "conftest.py")}


def _simulator_packages():
    tops = set(SIMULATOR_TOPS)
    if HAVE_SIM:
        tops |= {d for d in os.listdir(SIMDIR) if os.path.isfile(os.path.join(SIMDIR, d, "__init__.py"))}
    return tops


def test_no_repository_package_has_a_simulator_package_name():
    clash = sorted({p[:-3] if p.endswith(".py") else p for p in _repo_packages()} & _simulator_packages())
    assert not clash, "repository-root package(s) shadow the pru-simulator's: " + ", ".join(clash)


@pytest.mark.skipif(not HAVE_SIM, reason="TI pru-simulator checkout (PRU_SIMULATOR_PATH) missing")
@pytest.mark.parametrize("model", ["pru_device_models.spi_adc", "pru_device_models.bissline_device_model",
                                   "pru_device_models.waveform_player"])
def test_a_model_import_does_not_hide_the_simulator(model):
    code = textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {ROOT!r})
        import {model}
        sys.path.insert(0, {SIMDIR!r})
        from core.pru_core import PRUCore
        from simulator import Simulator
        print("ok")
    """)
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stdout + r.stderr
