"""Stepper period follows the configured maximum speed.

The generated delay is deliberately shorter than the requested period by the
macro's fixed non-delay instructions.  This integration test measures the
actual R30 STEP rising edges from a real clpru ELF in the headless simulator.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402


def _stepper_constants(clk_hz, max_speed_sps):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('stepper_block', 'pru_io_blocks');
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[1]));
console.log(JSON.stringify(Object.fromEntries(m.config.filter(c=>/^constant[0-9]+$/.test(c.name)).map(c=>[c.name,c.getValue?c.getValue(i):c.default]))));"""
    return json.loads(subprocess.check_output(
        ["node", "-e", script, json.dumps({
            "clkHz": clk_hz, "maxSpeedSps": max_speed_sps,
        })], cwd=ROOT, text=True))


class _IdlePins:
    def tick(self, _cycle, _pins):
        return 0


def _step_periods(trace, pin=5):
    mask = 1 << pin
    rises = []
    previous = False
    for cycle, gpo, _gpi in trace:
        level = bool(gpo & mask)
        if level and not previous:
            rises.append(cycle)
        previous = level
    return [later - earlier for earlier, later in zip(rises, rises[1:])]


# Requested period P in PRU cycles.  clkHz = P * 1000 at 1000 steps/s makes
# round(clkHz / maxSpeedSps) exactly P.  Every P mod 4 class, the minimum (17),
# a 200 ksps period (1000), the 2000..2007 / 4003 points and a large P.
PERIODS = [17, 18, 19, 20, 23, 27, 31, 1000, 2000, 2001, 2002, 2003, 2007, 4003, 20001]


def _exact_period(requested):
    """Window derived from the code: the macro delay is 2*floor(H/2) + 2*floor((M-H)/2)
    with M = P - 13 and H = 2*floor(M/4), i.e. M rounded down to even."""
    m = requested - 13
    h = 2 * (m // 4)
    return 13 + 2 * (h // 2) + 2 * ((m - h) // 2)


@pytest.mark.parametrize("requested", PERIODS)
def test_stepper_period_matches_configured_speed(requested):
    """Period == P when P is odd and P - 1 when P is even (window -1..0), exactly."""
    constants = _stepper_constants(requested * 1000, 1000)
    spec = dict(
        block="stepper_block",
        subdir="pru_io_blocks",
        macroCall="m_stepper_run",
        macroArgs=dict(
            RES="R0", STEP_PIN="5", DIR_PIN="6", STEPS="4",
            MIN_DELAY_CYCLES=str(constants["constant4"]),
            PULSE_HIGH_CYCLES=str(constants["constant5"]),
        ),
        postlude=["halt"],
    )
    workdir = ROOT / "build_out" / "stepper_timing" / str(requested)
    elf, _ = elf_cosim.build_block_firmware(spec, "stepper_timing", str(workdir))
    result = elf_cosim.run_elf_closed_loop(elf, _IdlePins(), max_steps=200_000)
    assert result.halted, "Stepper firmware did not halt"

    expected = requested if requested % 2 else requested - 1
    assert _exact_period(requested) == expected
    periods = _step_periods(result.trace)
    assert periods == [expected] * 3, (
        f"P={requested}: step periods {periods}, expected {expected} "
        f"(residual {expected - requested})")
