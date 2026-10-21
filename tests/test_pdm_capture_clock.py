"""pdm_block must hand the captured word to output1 and clock at the configured rate.

Two bugs, both found by running block-built routines on the TI pru-simulator:

  (a) the macro shifts the samples into its own data register (dataRegister, R5 by default); if
      the allocated output1 (RES) is not written, a downstream block reads whatever the register
      held before - `00040000` for both static levels;
  (b) loading the clock half-period as round(clkHz / (2 * clkRate)) loop passes of a 2-cycle loop
      with ~10 more instructions around it makes the clock run 11-20 % slow (109 / 108 cycles
      against 97.66 at 2.048 MHz, 77 against 64 at 3.125 MHz): loop overhead not subtracted
      from the delay count.

Measured on the real clpru ELF on the TI pru-simulator. Each case resolves the block the way
SysConfig does (scripts/sim/resolve_block_call.js), assembles the block's macro verbatim behind
the same `.asg` TEMP_REG lines pru_syscfg.asm.xdt emits, calls it with the generated argument
order (RES, then constant1..N) and runs it to `halt`. The line model drives the data pin
from the PRU's own clock output: after the k-th rising edge of the clock pin the data pin shows
bit k-1 of a pattern (MSB first) and holds it until the next rising edge, so a correct
capture - on either sample edge - returns the pattern. A downstream block is modelled by
`mov R10, R4` after the macro: R4 is the output1 register and is preloaded with a poison value,
so a macro that does not write output1 leaves the poison in R10.

The clock oracle is the nominal period from the rate and nothing else: clkHz / clkRate. It
does not use the block's cycle model or its delay constants. Every rising-edge-to-rising-edge
period must be within one cycle of it (and each high time within one cycle of half of it), and
the documented cycle count of the block must equal the cycles the macro really takes.
"""
import json
import os
import subprocess
import sys
from fractions import Fraction

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "sim"))
import elf_cosim  # noqa: E402

RESOLVER = os.path.join(ROOT, "scripts", "sim", "resolve_block_call.js")
CLK_HZ = 200_000_000
MAX_STEPS = 20_000
CLK_PIN, DATA_PIN = 11, 12
POISON = 0xDEADBEEF
PATTERN = 0x9E3779B1
PRELUDE_CYCLES = 2     # ldi32 R4, POISON
POSTLUDE_CYCLES = 1    # mov R10, R4 (the downstream block reading output1)


def _why_not():
    try:
        elf_cosim.find_clpru()
        elf_cosim.find_pru_simulator()
    except RuntimeError as exc:
        return str(exc)
    return None


_WHY_NOT = _why_not()
needs_sim = pytest.mark.skipif(_WHY_NOT is not None, reason=_WHY_NOT or "")


def resolve(overrides):
    res = subprocess.run(["node", RESOLVER, "pru_io_blocks/pdm_block", json.dumps(overrides)],
                         capture_output=True, text=True, cwd=ROOT)
    assert res.returncode == 0, f"resolve_block_call failed:\n{res.stdout}\n{res.stderr}"
    return json.loads(res.stdout)


def program(resolved):
    return "\n".join([
        "    .asg R28, TEMP_REG1",
        "    .asg R29, TEMP_REG2",
        "    .asg R26, TEMP_REG3",
        "    .asg R27, TEMP_REG4",
        resolved["macro"],
        "",
        "    .text",
        "    .global main",
        "main:",
        f"    ldi32 R4, 0x{POISON:08X}",
        f"    {resolved['opCode']} R4, " + ", ".join(str(c) for c in resolved["constants"]),
        "    mov   R10, R4",
        "    halt",
        "",
    ])


class MicLine:
    """Data pin = bit (k-1) of `pattern` (MSB first) after the k-th rising edge of the clock pin;
    a constant level when `pattern` is 0 or 1 and `static` is set."""

    def __init__(self, pattern=None, static=None, num_bits=32):
        self.pattern, self.static, self.num_bits = pattern, static, num_bits
        self.edges, self.prev = 0, 0

    def tick(self, _cycle, pins_out):
        clk = (pins_out >> CLK_PIN) & 1
        if clk and not self.prev:
            self.edges += 1
        self.prev = clk
        if self.static is not None:
            bit = self.static
        elif 1 <= self.edges <= self.num_bits:
            bit = (self.pattern >> (self.num_bits - self.edges)) & 1
        else:
            bit = 0
        return bit << DATA_PIN


def run(asm, workdir, name, line):
    os.makedirs(workdir, exist_ok=True)
    elf = elf_cosim.compile_asm(asm, workdir, name)
    halts = []

    def on_step(cycle, _gpo, _gpi, sim):
        pru = sim.cores["pru0"]
        if pru.instructions[pru.pc].opcode == "HALT":
            halts.append(cycle)

    result = elf_cosim.run_elf_closed_loop(elf, line, max_steps=MAX_STEPS, on_step=on_step)
    assert result.halted and halts, f"{name}: did not reach halt in {MAX_STEPS} steps"
    rises, falls, prev = [], [], 0
    for cycle, gpo, _gpi in result.trace:
        level = (gpo >> CLK_PIN) & 1
        if level and not prev:
            rises.append(cycle)
        elif prev and not level:
            falls.append(cycle)
        prev = level
    return {"rises": rises, "falls": falls, "halt": halts[0], "regs": result.registers}


def capture(tmp, name, rate, line, **cfg):
    overrides = {"clkRateHz": rate, "clkPin": str(CLK_PIN), "dataPin": str(DATA_PIN),
                 "clkHz": CLK_HZ, "dataRegister": "R5"}
    overrides.update(cfg)
    resolved = resolve(overrides)
    assert not resolved["errors"], resolved["errors"]
    out = run(program(resolved), os.path.join(str(tmp), name), name, line)
    out["resolved"] = resolved
    return out


def check_clock(name, rises, falls, rate, num_bits):
    """Every period / high time within one cycle of the nominal one, derived from the rate only."""
    period = Fraction(CLK_HZ, rate)
    assert len(rises) == num_bits, f"{name}: {len(rises)} clock pulses, want {num_bits}"
    periods = [b - a for a, b in zip(rises, rises[1:])]
    bad = [p for p in periods if abs(p - period) > 1]
    assert not bad, (f"{name}: clock period must be within 1 cycle of {float(period):.2f} "
                     f"(clkHz / clkRate); measured periods {sorted(set(periods))}")
    highs = [f - r for r, f in zip(rises, falls)]
    bad = [h for h in highs if abs(h - period / 2) > 1]
    assert not bad, f"{name}: high time must be within 1 cycle of {float(period / 2):.2f}; measured {sorted(set(highs))}"


# ---------------------------------------------------------------------------
# 1. The judge itself (runs anywhere): exact line green, the bug's shape red.
# ---------------------------------------------------------------------------

def test_clock_judge_green_and_red():
    rate = 2_048_000
    rises = [10 + 98 * k for k in range(32)]
    falls = [r + 49 for r in rises]
    check_clock("synthetic", rises, falls, rate, 32)
    slow = [10 + 109 * k for k in range(32)]
    with pytest.raises(AssertionError, match="clock period"):
        check_clock("slow", slow, [r + 54 for r in slow], rate, 32)


# ---------------------------------------------------------------------------
# 2. The real ELF on the TI pru-simulator.
# ---------------------------------------------------------------------------

@needs_sim
@pytest.mark.parametrize("level,expected", [(1, 0xFFFFFFFF), (0, 0x00000000)])
def test_static_levels_reach_downstream_through_output1(tmp_path, level, expected):
    """(a) R4 is output1 (poisoned beforehand); R10 is what the downstream block read from it."""
    out = capture(tmp_path, f"static{level}", 2_048_000, MicLine(static=level))
    got = out["regs"][10]
    assert got == expected, (f"static {level} on the PDM data pin: downstream read output1 = 0x{got:08X}, "
                             f"want 0x{expected:08X} (R4 = 0x{out['regs'][4]:08X}, "
                             f"dataRegister R5 = 0x{out['regs'][5]:08X})")


@needs_sim
@pytest.mark.parametrize("channel", ["mono", "stereoLeft", "stereoRight"])
def test_pattern_word_reaches_downstream_msb_first(tmp_path, channel):
    out = capture(tmp_path, f"pattern_{channel}", 2_048_000, MicLine(pattern=PATTERN), channel=channel)
    got = out["regs"][10]
    assert got == PATTERN, f"{channel}: downstream read 0x{got:08X}, want 0x{PATTERN:08X}"


@needs_sim
def test_narrow_word_is_right_aligned_in_output1(tmp_path):
    out = capture(tmp_path, "static1_16", 2_048_000, MicLine(static=1), numBits=16)
    assert out["regs"][10] == 0x0000FFFF, f"16-bit word: downstream read 0x{out['regs'][10]:08X}"


@needs_sim
@pytest.mark.parametrize("rate", [2_048_000, 3_125_000])
@pytest.mark.parametrize("channel", ["mono", "stereoRight"])
def test_clock_period_is_nominal(tmp_path, rate, channel):
    """(b) 2.048 MHz -> 97.66 cycles, 3.125 MHz -> 64 cycles; the base ran 109/108 and 77."""
    out = capture(tmp_path, f"clk_{rate}_{channel}", rate, MicLine(pattern=PATTERN), channel=channel)
    check_clock(f"{channel}@{rate}", out["rises"], out["falls"], rate, 32)


@needs_sim
@pytest.mark.parametrize("rate", [2_048_000, 3_125_000])
def test_documented_cycle_count_is_what_the_macro_takes(tmp_path, rate):
    out = capture(tmp_path, f"cycles_{rate}", rate, MicLine(pattern=PATTERN))
    took = out["halt"] - PRELUDE_CYCLES - POSTLUDE_CYCLES
    assert out["resolved"]["noOfCycles"] == took, (
        f"documented noOfCycles {out['resolved']['noOfCycles']} but the macro ran {took} cycles at {rate} Hz")


@needs_sim
@pytest.mark.parametrize("channel", ["mono", "stereoRight"])
@pytest.mark.parametrize("rate,period", [
    (2_048_000, 98),      # 97.66 rounds up (a floor would give 97)
    (3_125_000, 64),
    (2_020_202, 99),      # odd period: high 49, low 50 -> only the low half carries a pad
    (1_980_198, 101),     # odd period: high 50, low 51 -> only the high half carries a pad (mono)
])
def test_clock_period_and_duty_are_exact(tmp_path, rate, period, channel):
    """The documented rule: period = round(clkHz / clkRate), high for floor(period / 2) cycles, the rest low.
    Exact, not +-1: a swapped pad flag or a floored period moves one half by a cycle."""
    out = capture(tmp_path, f"exact_{rate}_{channel}", rate, MicLine(pattern=PATTERN), channel=channel)
    rises, falls = out["rises"], out["falls"]
    assert {b - a for a, b in zip(rises, rises[1:])} == {period}, (rises[:4], period)
    assert {f - r for r, f in zip(rises, falls)} == {period // 2}, (rises[:2], falls[:2], period // 2)


# ---------------------------------------------------------------------------
# 3. Validation: a rate whose fixed overhead does not fit must be rejected.
# ---------------------------------------------------------------------------

def test_rejects_rate_whose_overhead_does_not_fit():
    r = resolve({"clkRateHz": 20_000_000, "clkHz": CLK_HZ})
    assert any(e["field"] == "clkRateHz" for e in r["errors"]), r


@pytest.mark.parametrize("num_bits", [0, 33, 1.5, -1])
def test_rejects_num_bits_outside_one_to_32(num_bits):
    r = resolve({"numBits": num_bits})
    assert any(e["field"] == "numBits" for e in r["errors"]), (num_bits, r["errors"])


@pytest.mark.parametrize("num_bits", [1, 16, 32])
def test_accepts_num_bits_in_range(num_bits):
    r = resolve({"numBits": num_bits})
    assert not any(e["field"] == "numBits" for e in r["errors"]), (num_bits, r["errors"])


def test_output1_is_reserved_as_a_full_word():
    """The macro writes all 32 bits of the captured word to RES; the allocator must reserve 4 bytes for it
    (the macro tests above place R4 by hand, so only this pins the reservation)."""
    assert resolve({})["output1Size"] == 4


@pytest.mark.parametrize("channel,floor_period", [("mono", 18), ("stereoLeft", 18), ("stereoRight", 21)])
def test_fastest_clock_matches_the_documented_floor(channel, floor_period):
    """The longDescription says how fast the clock may go; the validator must agree to the cycle."""
    def errs(period):
        return resolve({"channel": channel, "clkHz": period * 1_000_000, "clkRateHz": 1_000_000})["errors"]
    assert not errs(floor_period), (channel, floor_period, errs(floor_period))
    assert any(e["field"] == "clkRateHz" for e in errs(floor_period - 1)), (channel, floor_period - 1)
    text = resolve({})["description"]
    assert f"clkHz / {floor_period}" in text, f"longDescription must state the {channel} floor clkHz / {floor_period}"


def test_accepts_the_documented_rates():
    for rate in (1_024_000, 2_048_000, 3_125_000):
        r = resolve({"clkRateHz": rate, "clkHz": CLK_HZ})
        assert not r["errors"], (rate, r["errors"])
