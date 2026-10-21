"""Run the EnDat and SSI clpru build scripts as real processes.

scripts/verify_endat_build.js and scripts/verify_ssi_build.js assemble the
blocks' real macros with clpru, so they SKIP when clpru is not found
(CGT_TI_PRU_PATH or the default install), like the other toolchain-gated
tests.

The `expanded.split('\n').map(formatAsmLine)` site in the two build scripts
is driven through buildAsmText's macroOverride with a same-line-label macro
body, and the `clpru build FAILED` line must be on stderr.
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "sim"))
import elf_cosim  # noqa: E402

try:
    CLPRU = elf_cosim.find_clpru()
except RuntimeError:
    CLPRU = None
HAVE_CLPRU = CLPRU is not None


def _cwd():
    return ROOT.replace("\\?\\", "")


def run_node(args):
    return subprocess.run(["node"] + args, cwd=_cwd(), text=True, capture_output=True, check=False)


@pytest.mark.skipif(not HAVE_CLPRU, reason="clpru not installed")
@pytest.mark.parametrize("script,ok_line", [
    ("verify_endat_build", "EnDat clpru build OK"),
    ("verify_ssi_build", "SSI clpru build OK"),
])
def test_build_script_assembles_the_real_macro(script, ok_line):
    r = run_node(["scripts/%s.js" % script])
    assert r.returncode == 0, r.stdout + r.stderr
    assert ok_line in r.stdout, r.stdout
    assert "E0300" not in r.stdout + r.stderr


@pytest.mark.skipif(not HAVE_CLPRU, reason="clpru not installed")
def test_endat_build_script_goes_red_on_a_block_that_drops_a_pin():
    """Sabotaged macro: an undefined pin symbol left in the macro body. The
    real clpru must reject it with E0300 naming the symbol."""
    r = run_node(["-e", r"""
const { main } = require('./scripts/verify_endat_build');
const os = require('os'), path = require('path');
const ok = main({ dir: path.join(os.tmpdir(), 'endat_red'), log: () => {}, logErr: () => {} },
                ['    clr R30, R30, UNDEFINED_PIN_SYMBOL']);
process.exit(ok ? 0 : 7);
"""])
    assert r.returncode == 7, r.stdout + r.stderr
    assert "E0300" in r.stdout + r.stderr and "UNDEFINED_PIN_SYMBOL" in r.stdout + r.stderr


SAME_LINE_MACRO = ("    .macro RES\n"
                   "slbl: ldi r1, 1\n"
                   "    ldi r2, 2\n"
                   "    .endm\n")


@pytest.mark.parametrize("script", ["verify_ssi_build", "verify_endat_build"])
def test_expanded_macro_site_keeps_same_line_label_in_column_1(script):
    r = run_node(["-e", r"""
const { buildAsmText } = require('./scripts/%s');
const lines = buildAsmText([], %s).split('\n');
console.log(JSON.stringify({lines}));
""" % (script, json.dumps(SAME_LINE_MACRO))])
    assert r.returncode == 0, r.stderr
    lines = json.loads(r.stdout)["lines"]
    assert "slbl: ldi r1, 1" in lines, lines
    assert "    ldi r2, 2" in lines, lines


@pytest.mark.parametrize("script,tag", [("verify_ssi_build", "SSI"), ("verify_endat_build", "EnDat")])
def test_build_failed_line_goes_to_stderr_and_exit_code_is_unchanged(script, tag):
    r = run_node(["-e", r"""
const { main } = require('./scripts/%s');
const ok = main({ dir: 'x', mkdir: () => {}, writeFile: () => {},
                  execSync: () => { throw new Error('clpru rejected'); } });
process.exit(ok ? 0 : 7);
""" % script])
    assert r.returncode == 7, r.stdout + r.stderr
    assert "%s clpru build FAILED" % tag in r.stderr, (r.stdout, r.stderr)
    assert "build FAILED" not in r.stdout, r.stdout
