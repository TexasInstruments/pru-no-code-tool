""" / The three node scripts that sat outside the suite
registry and rotted, plus the label-column follow-ups from r2.

scripts/verify_endat_build.js (stale: added the DATA_EN_PIN
macro parameter), scripts/verify_ssi_build.js (same shape) and
scripts/test_timestamped_sensor_gateway.js (stale: read the IEP counter at
0x0C = IEP_SLOW_COMPEN_REG, always 0; fixed the blocks to 0x10) are
run here as real processes. They need clpru (and, for the gateway, the TI
pru-simulator), so they SKIP when the toolchain is absent, like the other
toolchain-gated suites; with PRU_SIMULATOR_PATH set they are enforced.

the production `expanded.split('\n').map(formatAsmLine)` site in the
two build scripts is driven through buildAsmText's macroOverride with a
same-line-label macro body, and the `clpru build FAILED` line must be on
stderr.
"""
import json
import os
import subprocess

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CLPRU = "C:/ti/ti-cgt-pru_2.3.3/bin/clpru.exe"
HAVE_CLPRU = os.path.exists(CLPRU)
HAVE_SIM = bool(os.environ.get("PRU_SIMULATOR_PATH")) and os.path.isdir(os.environ["PRU_SIMULATOR_PATH"])


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


@pytest.mark.skipif(not (HAVE_CLPRU and HAVE_SIM), reason="clpru or PRU_SIMULATOR_PATH missing")
def test_timestamped_sensor_gateway_script_passes():
    r = run_node(["scripts/test_timestamped_sensor_gateway.js"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "13 PASSED, 0 FAILED" in r.stdout, r.stdout


@pytest.mark.skipif(not HAVE_CLPRU, reason="clpru not installed")
def test_endat_build_script_goes_red_on_a_block_that_drops_a_pin():
    """Sabotaged macro: DATA_EN_PIN left unsubstituted, as when the script
    went stale. The real clpru must reject it with E0300 / DATA_EN_PIN."""
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
