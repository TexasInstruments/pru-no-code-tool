"""An unconnected T or F port on If/Else is a validate() ERROR.

Problem: SysConfig only warned 'f_next port is not connected',
then clpru failed with [E0300] undefined symbol cmp_FALSE. Fix: fail early,
at validate time, with a clear message naming the port. A fully connected
design must still validate without that error.

The harness is scripts/block_validate_runner.js. The connected and the
unconnected cases differ only in the T/F lists.
"""

import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "block_validate_runner.js"
BLOCK = "program_control/conditional_block"


def _validate(t, f):
    inst = {"$name": "If_Else_0", "numOfInputPorts": 2,
            "input1": ["a"], "input2": ["b"], "T": t, "F": f}
    proc = subprocess.run(["node", str(RUNNER), BLOCK, json.dumps(inst)],
                          capture_output=True, text=True, cwd=str(ROOT), timeout=30)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(proc.stdout.strip())


def _branch_errors(data, port):
    return [e for e in data["errors"] if port in e["message"]]


def test_connected_design_has_no_branch_error():
    data = _validate(["x"], ["y"])
    assert data["errors"] == [], data


def test_unconnected_f_port_is_an_error():
    data = _validate(["x"], [])
    errs = _branch_errors(data, "f_next")
    assert errs, "unconnected F must be a validate ERROR, got %s" % data


def test_unconnected_t_port_is_an_error():
    data = _validate([], ["y"])
    errs = _branch_errors(data, "t_next")
    assert errs, "unconnected T must be a validate ERROR, got %s" % data


@pytest.mark.parametrize("t,f,port", [(["x"], [], "f_next"), ([], ["y"], "t_next")])
def test_error_not_just_warning(t, f, port):
    data = _validate(t, f)
    assert not [w for w in data["warnings"] if port in w["message"]], data
