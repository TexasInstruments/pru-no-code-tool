"""harden the duplicate-GPO rule added.

  1. block_control_flow.js is FAIL-CLOSED over an allow-list of straight-line PRU instructions:
     slp, an unknown mnemonic, an unexpanded macro call, a halt on one path, and a getMacro that
     throws for some candidate configuration are all UNDECIDED (treated continuous), and an
     always-true self-compare is a decided spin. Each arm asserts classification AND reason.
  2. The cross-instance bidi exemption in check_pin_collisions.js is pinned on both conjuncts.
  3. the baseline may only shrink: surviving entries are a subset of the set.
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
BASELINE = os.path.join(ROOT, "scripts", "pin_collision_baseline.json")
REFERENCE = os.path.join(ROOT, "scripts", "fixtures", "baseline_reference.json")

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

needs_sysconfig = pytest.mark.skipif(
    not glob.glob(str(TI_TOOLS / "sysconfig_*" / "dist" / "deviceData" / "AM243x_ALV_beta" / "AM243x_ALV_beta.json"))
    or shutil.which("node") is None,
    reason="SysConfig AM243x_ALV_beta device data (<SystemDrive>/ti/sysconfig_*) or node not installed; "
           "the pin check cannot run here - this is a SKIP, not a pass")


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


SYNTH = r'''"use strict";
const mod = {
    displayName: "synthetic", defaultInstanceName: "SYN_",
    config: [
        { name: "pin", default: "9" },
        { name: "opCode", default: "m_synth", hidden: true },
    ],
    ports: (inst) => [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }],
    moduleStatic: { getPinUsage: (inst) => @PINS@ },
    getMacro(m, opCode) {
        @PRE@
        return [
            `m_synth .macro`,
            `@BODY@`,
            `    .endm`,
        ].join("\n");
    },
};
exports = mod;
'''

GPO_ONLY = '[{ pin: inst.pin, dir: "GPO" }]'
BIDI = '[{ pin: inst.pin, dir: "GPO", bidi: true }, { pin: inst.pin, dir: "GPI", bidi: true }]'
GPI_ONLY = '[{ pin: inst.pin, dir: "GPI" }]'
# Body lines are joined with a literal backslash-n inside a JS template string.
SPIN_BODY = "top?:\\n    set r30, r30, 9\\n    clr r30, r30, 9\\n    qba top?"
RETURN_BODY = "    set r30, r30, 9\\n    clr r30, r30, 9"


def _synth_root(tmp_path, body, pins=GPO_ONLY, pre=""):
    root = _tool_root(tmp_path)
    src = SYNTH.replace("@PINS@", pins).replace("@PRE@", pre).replace("@BODY@", body)
    _write(os.path.join(root, BLOCKS_REL, "pru_io_blocks", "synth.syscfg.js"), src)
    return root


def _classify(root):
    res = subprocess.run(["node", os.path.join(root, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    return {r["id"]: r for r in json.loads(res.stdout)}["synth"]


# ----------------------------------------------- 1. classifier: allow-list, fail closed
# The classifier calls getMacro("", name) first and getMacro(name, name) second; the throw arm
# fails only the second call, so a first-call-only (partial stream) verdict would say sequential.
THROW_ON_SECOND = 'if (m !== "") throw new Error("config not supported");'


@needs_node
@pytest.mark.parametrize("body,pre,reason_part", [
    ("    set r30, r30, 9\\n    slp 0", "", "slp: halts the PRU"),
    ("    set r30, r30, 9\\n    frobnicate r1, r2", "", 'unknown mnemonic "frobnicate"'),
    ("    set r30, r30, 9\\n    m_other r1", "", 'unexpanded macro call "m_other"'),
    ("    qbbc done?, r31, 3\\n    halt\\ndone?:\\n    clr r30, r30, 9", "",
     "halt reachable on 1 path(s) while another path reaches the end"),
    ("    set r30, r30, 9", THROW_ON_SECOND, 'getMacro("m_synth", m_synth) threw'),
], ids=["slp", "unknown-mnemonic", "unexpanded-macro", "halt-on-one-path", "partial-getMacro-throw"])
def test_red_unproven_flow_is_undecided_and_counts_continuous(tmp_path, body, pre, reason_part):
    row = _classify(_synth_root(tmp_path, body, pre=pre))
    assert row["cls"] == "continuous" and row["decided"] is False, row
    assert reason_part in row["reason"], row["reason"]


@needs_node
def test_red_always_true_self_spin_is_decided_continuous(tmp_path):
    row = _classify(_synth_root(tmp_path, "    set r30, r30, 9\\ns?:\\n    qbeq s?, r1, r1"))
    assert row["cls"] == "continuous" and row["decided"] is True, row
    assert "macro end unreachable" in row["reason"], row["reason"]


@needs_node
def test_poll_loop_with_external_exit_still_returns(tmp_path):
    """A poll loop on R31 yields control once the pin changes, so it is sequential
    (unlike PWM, which never yields)."""
    row = _classify(_synth_root(tmp_path, "    set r30, r30, 9\\np?:\\n    qbbc p?, r31, 3"))
    assert row["cls"] == "sequential" and row["decided"] is True, row


@needs_node
def test_known_no_code_directives_and_label_prefix_stay_decided(tmp_path):
    row = _classify(_synth_root(tmp_path, "X .set 5\\n    .asg c4, ICSS\\nlbl?: set r30, r30, 9"))
    assert row["cls"] == "sequential" and row["decided"] is True, row


@needs_node
def test_real_block_table_after_allow_list():
    """Of the real getPinUsage blocks exactly two are undecided: can_classic_decoder_block (jmp,
    before too) and multi_axis_motion_block (its E-stop path halts). Anything else moving
    to undecided is a finding, not a reason to widen the allow-list."""
    res = subprocess.run(["node", os.path.join(ROOT, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    rows = {r["id"]: r for r in json.loads(res.stdout)}
    assert sorted(k for k, r in rows.items() if not r["decided"]) == [
        "can_classic_decoder_block", "multi_axis_motion_block"]
    assert "halt reachable on 1 path(s)" in rows["multi_axis_motion_block"]["reason"]
    assert "jmp" in rows["can_classic_decoder_block"]["reason"]


# ----------------------------------------------- 2. cross-instance bidi exemption
HDR = ('/**\n * @cliArgs --device "AM243x_ALV_beta" --package "ALV" --part "ALV" --context "icss_g0_pru0"'
       ' --product "PRU_NO_CODE_TOOL@01.00.01"\n */\n'
       'const A=(n)=>scripting.addModule("/pru_blocks/pru_io_blocks/"+n).addInstance();\n')
ONEWIRE9 = 'const w=A("onewire_block"); w.$name="OW"; w.dataPin="9";\n'
I2C_SDA9 = 'const c=A("i2c_block"); c.$name="BUS"; c.sclBit="10"; c.sdaBit="9";\n'
SYN9 = 'const s=A("synth"); s.$name="SYN"; s.pin="9";\n'


def _check_fixture(root, name, text):
    fx = os.path.join(root, name)
    _write(fx, HDR + text)
    return subprocess.run(["node", os.path.join(root, "scripts", "check_pin_collisions.js"), fx],
                          capture_output=True, text=True)


@needs_sysconfig
def test_red_bidi_pad_shared_between_sequential_and_continuous_block_fails(tmp_path):
    root = _synth_root(tmp_path, SPIN_BODY, pins=BIDI)
    assert _classify(root)["cls"] == "continuous"
    res = _check_fixture(root, "bidi_cont.syscfg", ONEWIRE9 + SYN9)
    assert res.returncode == 1, res.stdout + res.stderr
    assert "bidi_cont.syscfg: has colliding GPO/GPI indices: 9" in res.stderr
    assert "onewire_block.GPO vs synth.GPI on 9" in res.stderr
    assert "synth.GPO vs onewire_block.GPI on 9" in res.stderr


@needs_sysconfig
def test_red_bidi_pad_shared_with_a_non_bidi_gpi_fails(tmp_path):
    root = _synth_root(tmp_path, RETURN_BODY, pins=GPI_ONLY)
    assert _classify(root)["cls"] == "sequential"
    res = _check_fixture(root, "bidi_vs_gpi.syscfg", ONEWIRE9 + SYN9)
    assert res.returncode == 1, res.stdout + res.stderr
    assert "bidi_vs_gpi.syscfg: has colliding GPO/GPI indices: 9" in res.stderr
    assert "onewire_block.GPO vs synth.GPI on 9" in res.stderr


@needs_sysconfig
def test_red_two_different_bidi_protocols_on_one_pad_fail(tmp_path):
    """(Pratheesh 2026-10-05): a two-way pad shared by different protocols fails. This
    flips the arm that pinned the old behaviour (onewire dataPin 9 + i2c sdaBit 9 passed)."""
    res = _check_fixture(_tool_root(tmp_path), "two_protocols.syscfg", ONEWIRE9 + I2C_SDA9)
    assert res.returncode == 1, res.stdout + res.stderr
    assert "two_protocols.syscfg: has colliding GPO/GPI indices: 9" in res.stderr
    assert "onewire_block.GPO vs i2c_block.GPI on 9" in res.stderr
    assert "i2c_block.GPO vs onewire_block.GPI on 9" in res.stderr
    assert "duplicate GPO drivers" not in res.stderr      # the GPO-vs-GPO rule is not what fires


@needs_sysconfig
def test_green_two_instances_of_one_sequential_bidi_protocol_share_a_pad(tmp_path):
    ow2 = 'const v=A("onewire_block"); v.$name="OW2"; v.dataPin="9";\n'
    res = _check_fixture(_tool_root(tmp_path), "one_protocol.syscfg", ONEWIRE9 + ow2)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "EVALUATED: 1 of 1" in res.stdout


@needs_sysconfig
def test_red_same_module_bidi_pad_with_a_continuous_block_still_fails(tmp_path):
    """No shipped bidi block is continuous, so a synthetic one: two instances of the same bidi
    module that spins forever. Same protocol is not enough; the sequential conjunct must hold."""
    root = _synth_root(tmp_path, SPIN_BODY, pins=BIDI)
    assert _classify(root)["cls"] == "continuous"
    two = SYN9 + 'const t=A("synth"); t.$name="SYN2"; t.pin="9";\n'
    res = _check_fixture(root, "same_module_cont.syscfg", two)
    assert res.returncode == 1, res.stdout + res.stderr
    assert "same_module_cont.syscfg: has colliding GPO/GPI indices: 9" in res.stderr
    assert "synth.GPO vs synth.GPI on 9" in res.stderr


# ----------------------------------------------- 3. baseline may only shrink (subset check)
def _baseline_violations(base, ref):
    out = []
    for k, v in base.items():
        if k not in ref:
            out.append(f"new baseline entry not in the set: {k}")
        elif len(v["errors"]) > ref[k]:
            out.append(f"baseline entry grew: {k} ({ref[k]} -> {len(v['errors'])} findings)")
    return out


def _load():
    return (json.load(open(BASELINE, encoding="utf8")), json.load(open(REFERENCE, encoding="utf8")))


def test_baseline_entries_are_a_subset_of_the_set_and_never_grow():
    base, ref = _load()
    assert _baseline_violations(base, ref) == []


def test_red_swapping_a_baseline_entry_for_a_new_one_of_equal_count_is_caught():
    base, ref = _load()
    victim = sorted(base)[0]
    swapped = {k: v for k, v in base.items() if k != victim}
    swapped["examples/brand_new/example.syscfg"] = base[victim]      # same finding count
    assert len(swapped) == len(base)
    assert _baseline_violations(swapped, ref) == [
        "new baseline entry not in the set: examples/brand_new/example.syscfg"]


def test_red_a_baseline_entry_gaining_findings_is_caught():
    base, ref = _load()
    victim = sorted(base)[0]
    grown = json.loads(json.dumps(base))
    grown[victim]["errors"] = grown[victim]["errors"] + ["    one more"]
    assert _baseline_violations(grown, ref) == [
        f"baseline entry grew: {victim} ({ref[victim]} -> {ref[victim] + 1} findings)"]
