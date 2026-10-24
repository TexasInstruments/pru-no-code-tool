"""pin the `i.bidi` conjunct of the cross-instance exemption in check_pin_collisions.js.

Deleting `i.bidi &&` from rule (b) (scripts/check_pin_collisions.js, the o.inst !== i.inst branch) is
only visible to a design with the SAME block module on DIFFERENT instances, a bidi GPO against a NON-bidi
GPI on one pad. The non-bidi-GPI case in tests/test_pin_rules_fail_closed.py
(test_red_bidi_pad_shared_with_a_non_bidi_gpi_fails) uses a different module, so the
`o.block === i.block` conjunct already rejects it there.

No shipped block can produce that shape (a module's getPinUsage claims the same pad either as an
open-drain bidi pair or not, uniformly), so this builds a synthetic sequential block whose
getPinUsage is mode-dependent: instance A claims a bidi GPO/GPI pair on pad 9, instance B of the
SAME module claims a plain NON-bidi GPI on pad 9. Rule (b) must NOT exempt the pair: one side is
not open-drain, so the checker must fail with the collision text.
"""
import glob
import json
import os
import shutil
import subprocess

import pytest
from pathlib import Path

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOCKS_REL = os.path.join(".metadata", "sysconfig", ".meta", "pru_blocks")

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

needs_sysconfig = pytest.mark.skipif(
    not glob.glob(str(TI_TOOLS / "sysconfig_*" / "dist" / "deviceData" / "AM243x_ALV_beta" / "AM243x_ALV_beta.json"))
    or shutil.which("node") is None,
    reason="SysConfig AM243x_ALV_beta device data (<SystemDrive>/ti/sysconfig_*) or node not installed; "
           "the pin check cannot run here - this is a SKIP, not a pass"
)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8", newline="") as f:
        f.write(text)


def _tool_root(tmp_path):
    root = tmp_path / "root"
    shutil.copytree(os.path.join(ROOT, "scripts"), str(root / "scripts"),
                    ignore=shutil.ignore_patterns("fixtures", "sim"))
    shutil.copytree(os.path.join(ROOT, ".metadata", "sysconfig", ".meta"),
                    str(root / ".metadata" / "sysconfig" / ".meta"))
    return str(root)


# Synthetic block: one module, per-instance claim shape. mode "bidi" (default) claims an
# open-drain GPO/GPI pair on inst.pin; mode "gpi" claims a plain non-bidi GPI on inst.pin.
# The macro body falls off the end, so the module classifies SEQUENTIAL (rule (b) requires it).
SYNTH = r'''"use strict";
const mod = {
    displayName: "synthetic", defaultInstanceName: "SYN_",
    config: [
        { name: "pin", default: "9" },
        { name: "mode", default: "bidi" },
        { name: "opCode", default: "m_synth", hidden: true },
    ],
    ports: (inst) => [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }],
    moduleStatic: {
        getPinUsage: (inst) => inst.mode === "gpi"
            ? [{ pin: inst.pin, dir: "GPI" }]
            : [{ pin: inst.pin, dir: "GPO", bidi: true }, { pin: inst.pin, dir: "GPI", bidi: true }],
    },
    getMacro(m, opCode) {
        return [
            `m_synth .macro`,
            `    set r30, r30, 9`,
            `    clr r30, r30, 9`,
            `    .endm`,
        ].join("\n");
    },
};
exports = mod;
'''

HDR = ('/**\n * @cliArgs --device "AM243x_ALV_beta" --package "ALV" --part "ALV" --context "icss_g0_pru0"'
       ' --product "PRU_NO_CODE_TOOL@01.00.01"\n */\n'
       'const A=(n)=>scripting.addModule("/pru_blocks/pru_io_blocks/"+n).addInstance();\n')


def _synth_root(tmp_path):
    root = _tool_root(tmp_path)
    _write(os.path.join(root, BLOCKS_REL, "pru_io_blocks", "synth.syscfg.js"), SYNTH)
    return root


def _classify(root):
    res = subprocess.run(["node", os.path.join(root, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    return {r["id"]: r for r in json.loads(res.stdout)}["synth"]


@needs_node
def test_synth_block_is_decided_sequential(tmp_path):
    """Rule (b) only exempts SEQUENTIAL modules; pin that precondition so a classifier change that
    turns the synthetic block continuous cannot silently weaken this red arm into another rule."""
    row = _classify(_synth_root(tmp_path))
    assert row["cls"] == "sequential" and row["decided"] is True, row


@needs_sysconfig
def test_red_same_module_bidi_gpo_vs_non_bidi_gpi_on_one_pad_fails(tmp_path):
    """the arm: two instances of ONE sequential block module on pad 9, instance A's entry a
    bidi GPO, instance B's a NON-bidi GPI. Rule (b) needs bidi on BOTH entries; with `i.bidi`
    deleted the pair is wrongly exempted and this test fails."""
    root = _synth_root(tmp_path)
    fx = os.path.join(root, "same_module_nonbidi_gpi.syscfg")
    _write(fx, HDR + "\n".join([
        'const a=A("synth"); a.$name="BIDI_A"; a.pin="9";',
        'const b=A("synth"); b.$name="GPI_B"; b.pin="9"; b.mode="gpi";',
        "",
    ]))
    res = subprocess.run(["node", os.path.join(root, "scripts", "check_pin_collisions.js"), fx],
                         capture_output=True, text=True)
    assert res.returncode == 1, res.stdout + res.stderr
    assert "same_module_nonbidi_gpi.syscfg: has colliding GPO/GPI indices: 9" in res.stderr
    assert "synth.GPO vs synth.GPI on 9" in res.stderr


@needs_sysconfig
def test_green_two_bidi_instances_of_the_same_synth_module_share_the_pad(tmp_path):
    """Both instances bidi, same sequential module: rule (b) as written must still exempt the pair
    (this is the behaviour), so the red arm above cannot be passing for the wrong reason -
    e.g. the checker rejecting any two instances of the synthetic module outright."""
    root = _synth_root(tmp_path)
    fx = os.path.join(root, "same_module_both_bidi.syscfg")
    _write(fx, HDR + "\n".join([
        'const a=A("synth"); a.$name="BIDI_A"; a.pin="9";',
        'const c=A("synth"); c.$name="BIDI_C"; c.pin="9";',
        "",
    ]))
    res = subprocess.run(["node", os.path.join(root, "scripts", "check_pin_collisions.js"), fx],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "EVALUATED: 1 of 1" in res.stdout
