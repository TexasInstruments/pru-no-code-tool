"""run_elf_closed_loop(constants=...) overrides constant-table entries before the run.

Firmware that programs the IEP through c26 relies on c26 being the ICSS IEP0 register block (0x0002E000), as on the
device. The check writes CMP0 (IEP offset 0x78) through c26 and reads it back by absolute address: with
elf_cosim.IEP_CONSTANTS the word must land in the simulator's IEP model.

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
    HAVE_CLPRU = True
except RuntimeError:
    HAVE_CLPRU = False

ASM = """
    .global main
    .sect ".text:main"
main:
    ldi32   r1, 0x12345678
    sbco    &r1, c26, 0x78, 4
    ldi32   r3, 0x0002E078
    lbbo    &r4, r3, 0, 4
    halt
"""


class Idle:
    def tick(self, _cycle, _pins):
        return 0


@pytest.mark.skipif(not HAVE_CLPRU, reason="clpru not found (CGT_TI_PRU_PATH)")
def test_iep_constants_route_c26_writes_to_the_iep_model(tmp_path):
    if elf_cosim.simulator_iep_base() != 0x0002E000:
        pytest.skip("pru-simulator checkout has no IEP0 model at 0x0002E000")
    elf = elf_cosim.compile_asm(ASM, str(tmp_path), "c26_iep")
    result = elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=50, constants=elf_cosim.IEP_CONSTANTS)
    assert result.halted
    assert result.registers[4] == 0x12345678, "IEP CMP0 read back 0x%08X" % result.registers[4]
