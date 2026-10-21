"""Renaming one Memory Access block's memVar renames it for every sharing block.

`rd.memVar.labelName = in_buf; wr.memVar.labelName = out_buf` leaves both blocks on out_buf
and never reserves in_buf. The block must warn when two Memory Access blocks share one memVar
object, and its AI guidance must show explicit Memory Variable instances assigned by reference.
Runs the REAL memory_access_block.syscfg.js through scripts/shared_memvar_runner.js.
"""
import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(ROOT, "scripts", "shared_memvar_runner.js")

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


@pytest.fixture(scope="module")
def result():
    res = subprocess.run(["node", RUNNER], capture_output=True, text=True)
    assert res.stdout.strip(), res.stderr
    return json.loads(res.stdout)


@needs_node
def test_two_blocks_sharing_one_memvar_warn_on_both(result):
    for name in ("rd", "wr"):
        entry = result["cases"]["sharedMemVar"][name]
        assert entry["errors"] == []
        assert len(entry["warnings"]) == 1, entry
        assert "Shares one Memory Variable" in entry["warnings"][0]
        assert "renames the variable for every block" in entry["warnings"][0]
    assert "wr" in result["cases"]["sharedMemVar"]["rd"]["warnings"][0]
    assert "rd" in result["cases"]["sharedMemVar"]["wr"]["warnings"][0]


@needs_node
@pytest.mark.parametrize("case", ["separateMemVars", "symbolSelected", "single"])
def test_no_warning_without_a_shared_rename_hazard(result, case):
    for name, entry in result["cases"][case].items():
        assert entry["warnings"] == [], (case, name, entry)
        assert entry["errors"] == [], (case, name, entry)


@needs_node
def test_guidance_shows_explicit_memory_variable_instances(result):
    g = result["guidance"]
    assert "WRONG" in g and "rd.memVar.labelName" in g
    assert "rd.memVar = in_buf;" in g and "wr.memVar = out_buf;" in g
    assert 'memory_reserve.addInstance()' in g
