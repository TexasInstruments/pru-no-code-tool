"""SENT CRC nibble must be closed by a falling edge (SAE J2716).

J2716 defines a nibble as the time between falling edges, so after the sync
pulse N nibble periods need N+1 falling edges. The test runs a full frame
(status, data nibbles, CRC) in the simulator, collects R30 falling-edge times
and asserts that count, and that status/data nibble timing is unchanged.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

PIN = 7
CLK_HZ = 200_000_000
# (tickUs, lowTicks, numDataNibbles, data word): the nibble count, the tick
# and the low width all vary so a constant-only closing edge cannot pass.
CASES = [
    (3, 5, 2, 0x4321),
    (5, 4, 3, 0xFA05),
    (3, 7, 6, 0x0F1E2D),
]
# Existing status/data nibble period = (12 + v) ticks + per-nibble code overhead
# (a fixed part plus the 4-cycle multiply loop once per unit of v).
MAX_NIBBLE_OVERHEAD_CYC = 30
PER_VALUE_OVERHEAD_CYC = 6
# The CRC nibble's period ends at the new closing edge, so its overhead is the
# loop-exit code in front of it as well (measured 12..74 cycles).
MAX_CRC_OVERHEAD_CYC = 100
# The closing low is LOW_CYC of delay loop plus the clr/ldi32/lsr/set code.
MAX_LOW_OVERHEAD_CYC = 30


def _block_constants(tick_us, low_ticks, data_nibbles):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('sent_block', 'pru_io_blocks');
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[1]));
console.log(JSON.stringify(Object.fromEntries(m.config.filter(c=>/^constant[0-9]+$/.test(c.name)).map(c=>[c.name,c.getValue?c.getValue(i):c.default]))));"""
    return json.loads(subprocess.check_output(
        ["node", "-e", script, json.dumps({
            "clkHz": CLK_HZ, "tickUs": tick_us, "lowTicks": low_ticks,
            "numDataNibbles": data_nibbles, "signalPin": str(PIN)})],
        cwd=ROOT, text=True))


class DummyPinLoop:
    def tick(self, cycle, _pins):
        return cycle & 0xFFFFF


def _edges(trace):
    rising, falling, prev = [], [], None
    for cycle, gpo, _ in trace:
        level = bool(gpo & (1 << PIN))
        if prev is not None and level != prev:
            (rising if level else falling).append(cycle)
        prev = level
    return rising, falling


@pytest.mark.parametrize("tick_us,low_ticks,data_nibbles,word", CASES)
def test_sent_crc_nibble_has_closing_falling_edge(
        tmp_path, tick_us, low_ticks, data_nibbles, word):
    c = _block_constants(tick_us, low_ticks, data_nibbles)
    tick_cyc, low_cyc = c["constant3"], c["constant6"]
    n = c["constant7"]
    nibbles = [(word >> (4 * k)) & 0xF for k in range(n)]
    spec = dict(
        block="sent_block", subdir="pru_io_blocks", macroCall="m_sent_tx",
        macroArgs=dict(
            RES="R0", PIN=str(PIN), DATA_REG="R9",
            TICK_CYC=str(tick_cyc), SYNC_HIGH_CYC=str(c["constant4"]),
            NIBBLE_BASE_HIGH_CYC=str(c["constant5"]), LOW_CYC=str(low_cyc),
            NIBBLE_COUNT=str(n)),
        prelude=[f"ldi32 R9, 0x{word:X}"], postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "sent_test", str(tmp_path))
    max_steps = (56 + (n + 1) * 20) * tick_cyc * 2
    result = elf_cosim.run_elf_closed_loop(elf, DummyPinLoop(), max_steps=max_steps)
    assert result.halted, f"Firmware did not halt within {max_steps} cycles"

    rising, falling = _edges(result.trace)
    # The sync pulse's high period ends at the first falling edge; every
    # falling edge from there on starts a nibble period.
    assert len(falling) == n + 1, (
        f"{n} nibble periods after sync need {n + 1} falling edges "
        f"(CRC nibble must be closed), got {len(falling)}: {falling}")

    # Every period, the CRC (last) nibble included, is (12 + v) ticks + overhead.
    for k, v in enumerate(nibbles):
        period = falling[k + 1] - falling[k]
        nominal = (12 + v) * tick_cyc
        slack = (MAX_CRC_OVERHEAD_CYC if k == n - 1 else MAX_NIBBLE_OVERHEAD_CYC
                 ) + PER_VALUE_OVERHEAD_CYC * v
        assert nominal <= period <= nominal + slack, (
            f"nibble {k} (value {v}"
            f"{', CRC nibble' if k == n - 1 else ''}) period {period} "
            f"cycles, nominal {nominal}")

    # The closing low lasts lowTicks like every other low pulse ...
    closing_low = rising[-1] - falling[-1]
    assert low_cyc <= closing_low <= low_cyc + MAX_LOW_OVERHEAD_CYC, (
        f"closing low {closing_low} cycles, expected {low_cyc}")
    # ... and the line is released high afterwards (idle level), not left low.
    assert rising[-1] > falling[-1]
    assert result.trace[-1][1] & (1 << PIN), "SENT pin left low after the frame"
