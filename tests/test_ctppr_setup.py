"""generated code programs CTPPR0 so c28 reaches PRU shared RAM.

c28 = 00nn_nn00h with nnnn = CTPPR0.C28_POINTER[15:0]; CTPPR0 is at offset 28h of
the core's own PRU_CTRL block and resets to 0 (TRM SPRUIM2J Table 6-65 and
14.3.6.1.1). For AM261x (ICSSM) the CTPPR0 offset 0x28 / reset 0 is INFERRED from the
shared PRU-ICSS IP and SPRUIM2J; SPRUJB6 documents only the c28 pointer formula and the local
control bases, not the register. getConstantTableSetup() in the static
module emits the write; this file drives it with REAL block modules through
scripts/ct_setup_runner.js. The end-to-end proof that the write matters
(samples land in shared RAM, and land at DMEM 0x0 without it) is
tests/test_logic_analyzer.py::test_ctppr0_setup_removed_red.
"""
import json
import pathlib
import re
import subprocess

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "ct_setup_runner.js"

LA = "utils/logic_analyzer_block"
MAILBOX = "pru_io_blocks/mailbox_block"
GATEWAY = "application_specific/industrial_serial_gateway_block"
PWM = "pru_io_blocks/pwm_block"
CAPTURE = "pru_io_blocks/capture_block"


def setup(core, *blocks):
    proc = subprocess.run(["node", str(RUNNER), core, *blocks], capture_output=True,
                          text=True, cwd=str(REPO_ROOT), timeout=20)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(proc.stdout.strip())


def ctppr0_write(text):
    """(C28_POINTER value, CTPPR0 address) from the emitted three instructions."""
    m = re.search(r"ldi\s+TEMP_REG1,\s*(0x[0-9A-Fa-f]+)\s*\n\s*ldi32\s+TEMP_REG2,\s*(0x[0-9A-Fa-f]+)"
                  r"\s*\n\s*sbbo\s+&TEMP_REG1,\s*TEMP_REG2,\s*0,\s*4", text)
    assert m, "no CTPPR0 write in:\n" + text
    return int(m.group(1), 16), int(m.group(2), 16)


# PRU_CTRL bases: SPRUIM2J Table 6-65 entry 11 + CTPPR0 instance table (3002_x028h).
@pytest.mark.parametrize("core,ctppr0", [
    ("icss_g0_pru0", 0x22028), ("icss_g0_pru1", 0x24028),
    ("icss_g0_rtu_pru0", 0x23028), ("icss_g0_rtu_pru1", 0x23828),
    ("icss_g0_tx_pru0", 0x25028), ("icss_g0_tx_pru1", 0x25828),
    ("icss_m0_pru0", 0x22028), ("icss_m1_pru1", 0x24028),   # ICSSM: SPRUJB6 local bases; CTPPR0 +0x28 inferred
])
def test_setup_targets_this_cores_ctppr0(core, ctppr0):
    out = setup(core, LA)
    assert out["error"] is None
    ptr, addr = ctppr0_write(out["setup"])
    assert ptr << 8 == 0x00010000, "c28 must point at shared RAM 0x00010000"
    assert addr == ctppr0


@pytest.mark.parametrize("block", [LA, MAILBOX, GATEWAY])
def test_every_c28_block_triggers_the_setup(block):
    assert setup("icss_g0_pru0", block)["setup"], "%s uses c28 but no CTPPR0 write emitted" % block


@pytest.mark.parametrize("block", [PWM, CAPTURE])
def test_design_without_c28_gets_no_setup(block):
    assert setup("icss_g0_pru0", block)["setup"] == ""


def test_unknown_core_is_an_error_not_a_guess():
    out = setup("r5fss0-0", LA)
    assert out["error"] and "No PRU_CTRL base" in out["error"]


# ------------------------------------------- block harness (emit_block_asm.js)
import struct  # noqa: E402
import sys  # noqa: E402

sys.path.insert(0, str(REPO_ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

LA_SPEC = dict(block="logic_analyzer_block", subdir="utils", macroCall="", opCode="m_logic_analyzer_block",
               macroArgs=dict(RES="R0.b1", periodCycles="7", bufferSize="16",
                              triggerPin="0", triggerSlope="0"), postlude=["halt"])


def test_block_harness_emits_the_same_ctppr0_write(tmp_path):
    """emit_block_asm.js mirrors getConstantTableSetup for icss_g0_pru0."""
    asm = elf_cosim.expand_block_asm(LA_SPEC, str(tmp_path))
    harness = re.search(r"ldi\s+R28,\s*(0x[0-9A-Fa-f]+)\s*\n\s*ldi32\s+R29,\s*(0x[0-9A-Fa-f]+)"
                        r"\s*\n\s*sbbo\s+&R28,\s*R29,\s*0,\s*4", asm)
    assert harness, asm
    assert (int(harness.group(1), 16), int(harness.group(2), 16)) == \
        ctppr0_write(setup("icss_g0_pru0", LA)["setup"])
    no = elf_cosim.expand_block_asm(dict(LA_SPEC, programCtppr0=False), str(tmp_path))
    assert "0x22028" not in no


def _la_words(tmp_path, program):
    try:
        elf_cosim.find_clpru()
        elf_cosim.find_pru_simulator()
    except RuntimeError as e:
        pytest.skip(str(e))
    elf, _ = elf_cosim.build_block_firmware(dict(LA_SPEC, programCtppr0=program),
                                            "la_%d" % program, str(tmp_path))
    holder = {}
    res = elf_cosim.run_elf_closed_loop(elf, type("Z", (), {"tick": lambda s, c, p: c & 0xFFFFF})(),
                                        max_steps=2000,
                                        on_step=lambda c, g, i, sim: holder.setdefault("sim", sim))
    assert res.halted
    sim = holder["sim"]
    if not hasattr(sim, "pru_ctrl"):
        pytest.skip("pru-simulator hard-codes c28 (no PRU_CTRL model)")
    rd = lambda a: list(struct.unpack("<16I", sim.memory_read(a, 64)))
    return rd(0x10000), rd(0x0)


def test_block_harness_without_ctppr0_writes_dmem(tmp_path):
    """Red arm for the harness: no CTPPR0 write -> samples at DMEM 0x0, shared RAM empty."""
    shared, dmem = _la_words(tmp_path, program=False)
    assert shared == [0] * 16, "samples reached shared RAM without CTPPR0 being programmed"
    assert len(set(b - a for a, b in zip(dmem, dmem[1:]))) == 1 and dmem[0] != 0, dmem


def test_block_harness_with_ctppr0_writes_shared_ram(tmp_path):
    shared, _ = _la_words(tmp_path, program=True)
    assert len(set(b - a for a, b in zip(shared, shared[1:]))) == 1 and shared[0] != 0, shared
