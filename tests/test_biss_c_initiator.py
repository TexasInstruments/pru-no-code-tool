"""biss_c_initiator_block macro on the clpru ELF in TI pru-simulator.

The macro is a shift register: per bit it pulses MA low then high (rising edge k makes the slave present bit k on SLO),
shifts RES left and adds the sampled SLO bit. Its loop is clr, nop, set, lsl, qbbc, [add], sub, qbne, so a bit takes
8 cycles when the sampled bit is 1 and 7 when it is 0: the MA period depends on the data. Both the captured word and
that period are checked here against an edge-driven slave model.

Needs clpru (CGT_TI_PRU_PATH) and a pru-simulator checkout (PRU_SIMULATOR_PATH); skips without them.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_TOOLS = True
except Exception:
    HAVE_TOOLS = False

CLK, DATA = 0, 1


class Slave:
    """Presents bits[k] on SLO after the k-th rising MA edge."""

    def __init__(self, bits):
        self.bits = bits
        self.last = 0
        self.edges = 0
        self.level = 0

    def tick(self, _cycle, pins_out):
        clk = (pins_out >> CLK) & 1
        if clk and not self.last:
            self.level = self.bits[self.edges] if self.edges < len(self.bits) else 0
            self.edges += 1
        self.last = clk
        return self.level << DATA


@pytest.mark.skipif(not HAVE_TOOLS, reason="clpru or pru-simulator missing")
@pytest.mark.parametrize("bits", [[1, 0, 1, 1, 0, 0, 1, 0, 1, 1], [0] * 6 + [1] * 6])
def test_capture_and_data_dependent_bit_period(tmp_path, bits):
    spec = dict(block="biss_c_initiator_block", subdir="application_specific", macroCall="m_biss_c_read",
                macroArgs=dict(RES="R4", CLK=str(CLK), DATA=str(DATA), LEN=str(len(bits))), postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "biss_c", str(tmp_path))
    result = elf_cosim.run_elf_closed_loop(elf, Slave(bits), max_steps=2000)
    assert result.halted
    want = 0
    for b in bits:
        want = (want << 1) | b
    assert result.registers[4] == want, "captured 0x%X, expected 0x%X" % (result.registers[4], want)

    rises = []
    prev = 0
    for cycle, gpo, _ in result.trace:
        clk = (gpo >> CLK) & 1
        if clk and not prev:
            rises.append(cycle)
        prev = clk
    assert len(rises) == len(bits)
    periods = [b - a for a, b in zip(rises, rises[1:])]
    assert periods == [8 if b else 7 for b in bits[:-1]], periods
    assert (result.trace[-1][1] >> CLK) & 1 == 1, "MA must idle high after the frame"
