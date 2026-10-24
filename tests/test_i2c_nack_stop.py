"""i2c_block issues STOP and exits early on an address NACK.

Runs the real clpru ELF in the TI pru-simulator against a simulated open-drain
I2C slave (ACK or NACK on the address byte) and checks the R30 pin trace plus
the NACK flag register. The ACK case is the unchanged-behaviour control.
"""
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import elf_cosim  # noqa: E402
from i2c_slave_model import I2cSlave  # noqa: E402

BLOCK = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "i2c_block.syscfg.js"
HAS_NACK_REG = re.search(r"\.macro [^`]*\bNACK_REG\b", BLOCK.read_text(encoding="utf-8")) is not None
NACK_REG = "R8"
UNTYPED = "TEMP_REG1"  # what the block passes while nackRegister is empty (the default): the flag lands in the scratch register
SCL, SDA = 0, 1
READ_BYTE = 0xA5


class SlaveBus:
    def __init__(self, slave):
        self.slave = slave

    def tick(self, cycle, pins):
        return self.slave.gpi(cycle, pins)


def transitions(trace, pin):
    mask = 1 << pin
    out, previous = [], bool(trace[0][1] & mask)
    for cycle, gpo, _ in trace[1:]:
        level = bool(gpo & mask)
        if level != previous:
            out.append((cycle, level))
            previous = level
    return out


def run_frame(rw, ack, typed=True):
    from_node = dict(
        block="i2c_block", subdir="pru_io_blocks", macroCall="m_i2c_run",
        macroArgs=dict(RES="R0", SCL_BIT=str(SCL), SDA_BIT=str(SDA), HALF_TRIPS="105",
                       ADDR_BYTE="0xA1" if rw == "read" else "0xA0",
                       IS_READ="1" if rw == "read" else "0", DATA_REG="R7"),
        postlude=["halt"])
    from_node["macroArgs"]["NACK_REG"] = NACK_REG if typed else UNTYPED
    from_node["prelude"] = [f"ldi32 {NACK_REG}, 0xFFFFFFFF", "ldi32 R7, 0x5A5A5A5A"]
    name = f"nack290_{rw}_{'ack' if ack else 'nack'}{'' if typed else '_untyped'}"
    elf, _ = elf_cosim.build_block_firmware(from_node, name, str(ROOT / "build_out"))
    result = elf_cosim.run_elf_closed_loop(elf, SlaveBus(I2cSlave(ack, rw == "read", SCL, SDA, READ_BYTE)), max_steps=200_000)
    assert result.halted
    return result


def edges(result):
    scl, sda = transitions(result.trace, SCL), transitions(result.trace, SDA)
    return ([c for c, lv in scl if lv], [c for c, lv in scl if not lv],
            [c for c, lv in sda if lv], [c for c, lv in sda if not lv])


@pytest.mark.parametrize("typed", [True, False], ids=["typed", "untyped"])
@pytest.mark.parametrize("rw", ["write", "read"])
def test_address_nack_issues_stop_after_ninth_clock_and_ends_frame(rw, typed):
    result = run_frame(rw, ack=False, typed=typed)
    scl_rises, scl_falls, sda_rises, sda_falls = edges(result)
    # scl_rises[0] is the idle release, scl_rises[1:10] are the 9 clocks, then STOP's SCL rise.
    # scl_falls[0] is tHD;STA, scl_falls[1:10] close the 9 clocks.
    assert len(scl_falls) == 10, (
        f"{len(scl_falls)} SCL falls: expected START + 9 clocks and no data-phase clocks; falls={scl_falls}")
    assert len(scl_rises) == 11, f"{len(scl_rises)} SCL rises: expected idle + 9 clocks + STOP setup; rises={scl_rises}"
    ninth_fall = scl_falls[9]
    stop_scl_rise = scl_rises[10]
    assert stop_scl_rise > ninth_fall
    stop = [c for c in sda_rises if c > ninth_fall]
    assert len(stop) == 1, f"expected exactly one SDA rise (STOP) after the 9th clock, got {stop}"
    assert stop[0] > stop_scl_rise, "STOP must be SDA rising while SCL is high"
    # SDA is driven low between the 9th clock and STOP (no data-phase release for the NACK clocking).
    assert not [c for c in sda_falls if c > stop[0]], "SDA moves after STOP"
    # The frame ends right after STOP: halt follows within a few instructions.
    assert result.trace[-1][0] - stop[0] < 20, (
        f"frame ends {result.trace[-1][0] - stop[0]} cycles after STOP")
    assert result.trace[-1][1] & (1 << SCL) and result.trace[-1][1] & (1 << SDA), "bus idle (both high) at frame end"
    if rw == "read":
        assert result.registers[7] == 0x5A5A5A5A, hex(result.registers[7])  # no data was received


@pytest.mark.parametrize("rw", ["write", "read"])
def test_address_nack_sets_flag(rw):
    assert HAS_NACK_REG, "i2c_block has no NACK flag register: a downstream block cannot test the address NACK"
    result = run_frame(rw, ack=False)
    assert result.registers[8] == 1, f"NACK flag {result.registers[8]:#x}, expected 1"


@pytest.mark.parametrize("rw", ["write", "read"])
def test_untyped_nack_register_writes_no_flag(rw):
    """Default design (nackRegister empty): the STOP/early exit still happen (trace test above), but no register is written."""
    result = run_frame(rw, ack=False, typed=False)
    assert result.registers[8] == 0xFFFFFFFF, f"R8 changed to {result.registers[8]:#x}: the untyped block must not write a flag"


@pytest.mark.parametrize("rw", ["write", "read"])
def test_untyped_ack_frame_is_unchanged(rw):
    result = run_frame(rw, ack=True, typed=False)
    assert result.registers[8] == 0xFFFFFFFF
    if rw == "read":
        assert result.registers[7] & 0xFF == READ_BYTE, hex(result.registers[7])


@pytest.mark.parametrize("rw", ["write", "read"])
def test_address_ack_unchanged(rw):
    result = run_frame(rw, ack=True)
    scl_rises, scl_falls, sda_rises, sda_falls = edges(result)
    clocks = 9 if rw == "write" else 18
    assert len(scl_falls) == 1 + clocks, (len(scl_falls), scl_falls)
    assert len(scl_rises) == 1 + clocks + 1, (len(scl_rises), scl_rises)
    assert result.trace[-1][1] & (1 << SCL) and result.trace[-1][1] & (1 << SDA)
    if HAS_NACK_REG:
        assert result.registers[8] == 0, f"ACK must clear the flag, got {result.registers[8]:#x}"
    if rw == "read":
        assert result.registers[7] & 0xFF == READ_BYTE, hex(result.registers[7])
