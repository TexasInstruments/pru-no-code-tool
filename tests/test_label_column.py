"""asm formatters keep labels in column 1 (bare or same-line).

The JS macro expanders accept `label: instr` on one line; the asm FORMATTERS
that turn expanded lines back into an .asm file must not decide indentation
with `endsWith(':')`, or a same-line `label: instr` line is emitted indented --
and clpru rejects ANY indented label (E0003 'Invalid instruction'), even a
bare one.

What these tests prove: scripts/sim/emit_block_asm.js (and the shared
formatAsmLine in scripts/dual_oracle_harness.js that executeDualOracle uses)
emits a line carrying a
label with the label in column 1, and plain instructions indented. The
clpru arm assembles the emitted file when clpru is reachable; otherwise it
skips loudly (never a fake green).
"""
import json
import os
import re
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

sys.path.insert(0, os.path.join(ROOT, "scripts", "sim"))
import elf_cosim  # noqa: E402


def _node_cwd():
    # Sandboxed checkouts may report an extended-length (\\?\) cwd, whose
    # drive-relative form node's module resolver rejects (EISDIR lstat 'C:').
    # The plain drive path works in every checkout; elsewhere this is a no-op.
    return ROOT.replace("\\\\?\\", "")


def run_node(source, *args):
    return subprocess.run(["node", "-e", source, *args], cwd=_node_cwd(), text=True,
                          capture_output=True, check=False)


# Proven harness spec (tests/test_ctppr_setup.py): expands without
# clpru. The prelude carries the synthetic same-line + bare labels straight
# through emit_block_asm's formatter, so no special block macro is needed.
LABEL_SPEC = dict(block="logic_analyzer_block", subdir="utils", macroCall="",
                  opCode="m_logic_analyzer_block",
                  macroArgs=dict(RES="R0.b1", periodCycles="7", bufferSize="16",
                                 triggerPin="0", triggerSlope="0"),
                  prelude=["pb_ws?: sub r1, r1, 1", "bare_lbl:"],
                  postlude=["halt"])


def test_emit_block_asm_keeps_labels_in_column_1(tmp_path):
    asm = elf_cosim.expand_block_asm(LABEL_SPEC, str(tmp_path))
    lines = asm.split("\n")
    assert "pb_ws?: sub r1, r1, 1" in lines, asm
    assert "bare_lbl:" in lines, asm
    indented = [l for l in lines if re.match(r"^[ \t]+(pb_ws\?|bare_lbl):", l)]
    assert indented == [], asm
    assert "    halt" in lines, asm


NODE_FMT = r"""
const { formatAsmLine } = require('./scripts/dual_oracle_harness');
console.log(JSON.stringify([
  'pb_ws?: sub r1, r1, 1',
  'bare_lbl:',
  'ldi r1, 1',
  'x_1: qbne x_1, r1, 0 ; comment: with colon',
].map(formatAsmLine)));
"""


def test_dual_oracle_formatter_keeps_labels_in_column_1():
    """The formatter executeDualOracle (and the sensor-gateway script) uses,
    reached here via its dual_oracle_harness export."""
    result = run_node(NODE_FMT)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    assert got == ["pb_ws?: sub r1, r1, 1", "bare_lbl:", "    ldi r1, 1",
                   "x_1: qbne x_1, r1, 0 ; comment: with colon"], got


def test_emitted_file_assembles_under_clpru(tmp_path):
    try:
        elf_cosim.find_clpru()
    except RuntimeError as e:
        pytest.skip("clpru not reachable from this environment: %s" % e)
    asm = elf_cosim.expand_block_asm(LABEL_SPEC, str(tmp_path))
    out = elf_cosim.compile_asm(asm, str(tmp_path), "labels")
    assert os.path.exists(out)
