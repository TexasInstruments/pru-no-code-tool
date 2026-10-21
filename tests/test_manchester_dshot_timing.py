"""Manchester half-bits and DShot bit periods must be the nominal number of PRU cycles.

A delay count tuned to the nominal period, with 4-12 more instruction cycles spent around it
(set/clr, ldi32, lsr, branches), makes every bit run long - and by a different amount on each
branch path, so the period depends on the data.

Measured on the real clpru ELF on the TI pru-simulator. Each case resolves the block the way
SysConfig does (scripts/sim/resolve_block_call.js evaluates the block's own config defaults,
getValue constants and validate), assembles the block's macro verbatim behind the same `.asg`
TEMP_REG lines pru_syscfg.asm.xdt emits, calls it with the generated argument order (RES, then
constant1..N), and runs it to `halt`. An edge is the cycle of an instruction whose destination is
R30, read from the simulator's own decoded instruction at the PC; the pin level comes from the
GPO trace. The end of the frame is the cycle the `halt` placed right after the macro executes,
i.e. the cycle the next block would start.

The oracle is the nominal period from the rate and nothing else: Fraction(clkHz, rate). It does
not use the block's cycle model, its delay constants or the repo's JS simulator.

  * Manchester: a fixed-clock receiver starts at the first edge and samples the line at the
    centre of every nominal half-bit; it must recover the byte. Every edge k (and the frame end,
    k = 16) must lie within half a cycle of k * H, H = clkHz / (2 * rate): exactly k * H whenever
    H is a whole number of cycles.
  * DShot: a bit is 1 when its high time exceeds 50% of the nominal period; the 16 bits must
    carry the configured throttle and telemetry flag with a valid (v ^ v>>4 ^ v>>8) & 0xF CRC.
    Every rising edge i (and the frame end, i = 16) must lie within half a cycle of i * P,
    P = clkHz / rate, and every high time within half a cycle of 3/4 P (a 1) or 3/8 P (a 0).
    Half a cycle is the rounding rule: an edge cannot be closer to a fractional nominal than the
    nearest whole cycle, and no edge drifts further, so the frame error never accumulates.

Run as a script (`python tests/test_manchester_dshot_timing.py`) to print the measured
half-bit / bit periods of every case instead of asserting.
"""
import bisect
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
MAX_STEPS = 80_000
HALF = Fraction(1, 2)

MANCHESTER_RATES = [500_000, 1_000_000, 2_500_000]
MANCHESTER_BYTES = [0x00, 0xFF, 0x55, 0xA5]
DSHOT_RATES = {"dshot150": 150_000, "dshot300": 300_000, "dshot600": 600_000, "dshot1200": 1_200_000}
DSHOT_COMMANDS = [(0, False), (1000, True), (1365, False), (2047, True)]


def _why_not():
    try:
        elf_cosim.find_clpru()
        elf_cosim.find_pru_simulator()
    except RuntimeError as exc:
        return str(exc)
    return None


_WHY_NOT = _why_not()
needs_sim = pytest.mark.skipif(_WHY_NOT is not None, reason=_WHY_NOT or "")


# ---------------------------------------------------------------------------
# Build + run (the device under test is whatever the block JS in this tree emits).
# ---------------------------------------------------------------------------

def resolve(block, overrides):
    """The block's own resolution of one instance: macro text, constants, validation."""
    res = subprocess.run(["node", RESOLVER, block, json.dumps(overrides)],
                         capture_output=True, text=True, cwd=ROOT)
    assert res.returncode == 0, f"resolve_block_call failed:\n{res.stdout}\n{res.stderr}"
    return json.loads(res.stdout)


def program(resolved, prelude):
    """Assembly for one macro call, laid out like the generated pru_syscfg.asm/.inc."""
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
        *[f"    {line}" for line in prelude],
        f"    {resolved['opCode']} R4, " + ", ".join(str(c) for c in resolved["constants"]),
        "    halt",
        "",
    ])


class _IdleLine:
    def tick(self, _cycle, _pins_out):
        return 0


def run(asm, workdir, name, pin):
    """Run to halt; return (edges, end) with edges = [(write_cycle, level_after)] on *pin*."""
    os.makedirs(workdir, exist_ok=True)
    elf = elf_cosim.compile_asm(asm, workdir, name)
    writes, halts = [], []

    def on_step(cycle, _gpo, _gpi, sim):
        pru = sim.cores["pru0"]
        ins = pru.instructions[pru.pc]
        if ins.opcode == "HALT":
            halts.append(cycle)
        elif ins.operands and type(ins.operands[0]).__name__ == "Register" \
                and ins.operands[0].index == 30:
            writes.append(cycle)

    result = elf_cosim.run_elf_closed_loop(elf, _IdleLine(), max_steps=MAX_STEPS, on_step=on_step)
    assert result.halted and halts, f"{name}: did not reach halt in {MAX_STEPS} steps"
    cycles = [c for c, _g, _i in result.trace]
    levels = [(g >> pin) & 1 for _c, g, _i in result.trace]

    def level_at(t):
        return levels[bisect.bisect_right(cycles, t) - 1]

    # A write at cycle c is on the pin from cycle c + 1.
    edges = [(c, level_at(c + 1)) for c in writes]
    return edges, halts[0], level_at


# ---------------------------------------------------------------------------
# Oracles: nominal period from the rate only.
# ---------------------------------------------------------------------------

def check_grid(name, offsets, nominal):
    """Every offsets[k] (cycles from the first edge) must be within half a cycle of k * nominal."""
    bad = [(k, off, float(k * nominal)) for k, off in enumerate(offsets)
           if abs(off - k * nominal) > HALF]
    assert not bad, (
        f"{name}: edges off the nominal grid of {float(nominal):.3f} cycles "
        f"(k, measured offset, nominal offset): {bad[:6]}; intervals "
        f"{[b - a for a, b in zip(offsets, offsets[1:])]}")


def decode_manchester(name, edges, end, level_at, half, thomas):
    """Fixed-clock receiver: sample at nominal half-bit centres from the first edge."""
    assert len(edges) == 16, f"{name}: {len(edges)} R30 writes, a byte is 16 half-bits"
    t0 = edges[0][0] + 1
    byte = 0
    for i in range(8):
        first = level_at(int(t0 + (2 * i + HALF) * half))
        second = level_at(int(t0 + (2 * i + 1 + HALF) * half))
        if first == second:
            raise ValueError(f"{name}: bit {i} has no mid-bit transition at the sampled centres")
        one = (first, second) == ((1, 0) if thomas else (0, 1))
        byte = (byte << 1) | int(one)
    return byte


def decode_dshot(name, edges, period):
    assert len(edges) == 32, f"{name}: {len(edges)} R30 writes, a frame is 16 rise/fall pairs"
    levels = [lv for _c, lv in edges]
    assert levels == [1, 0] * 16, f"{name}: edges do not alternate rise/fall: {levels}"
    rises = [c for c, lv in edges if lv]
    falls = [c for c, lv in edges if not lv]
    highs = [f - r for r, f in zip(rises, falls)]
    bits = [int(h > period / 2) for h in highs]
    frame = 0
    for b in bits:
        frame = (frame << 1) | b
    value = frame >> 4
    crc_ok = ((value ^ (value >> 4) ^ (value >> 8)) & 0xF) == (frame & 0xF)
    return {"frame": frame, "throttle": value >> 1, "telemetry": bool(value & 1), "crc_ok": crc_ok,
            "bits": bits, "highs": highs, "rises": rises}


# ---------------------------------------------------------------------------
# Measurements
# ---------------------------------------------------------------------------

def measure_manchester(tmp, rate, byte, convention="ieee", pin=13):
    resolved = resolve("pru_io_blocks/manchester_block",
                       {"bitRateHz": rate, "convention": convention, "signalPin": str(pin),
                        "dataRegister": "R5.b0", "clkHz": CLK_HZ})
    assert not resolved["errors"], resolved["errors"]
    name = f"manchester_{convention}_{rate}_{byte:02x}"
    edges, end, level_at = run(program(resolved, [f"ldi R5, 0x{byte:02X}"]),
                               os.path.join(str(tmp), name), name, pin)
    return name, edges, end, level_at


def measure_dshot(tmp, variant, throttle, telemetry, pin=9):
    resolved = resolve("pru_io_blocks/dshot_block",
                       {"variant": variant, "throttle": throttle, "telemetry": telemetry,
                        "signalPin": str(pin), "clkHz": CLK_HZ})
    assert not resolved["errors"], resolved["errors"]
    name = f"dshot_{variant}_{throttle}_{int(telemetry)}"
    edges, end, _ = run(program(resolved, []), os.path.join(str(tmp), name), name, pin)
    return name, edges, end


def assert_manchester(tmp, rate, byte, convention="ieee"):
    half = Fraction(CLK_HZ, 2 * rate)
    name, edges, end, level_at = measure_manchester(tmp, rate, byte, convention)
    decoded = decode_manchester(name, edges, end, level_at, half, convention == "thomas")
    assert decoded == byte, f"{name}: fixed-clock receiver decoded 0x{decoded:02X}"
    t0 = edges[0][0]
    check_grid(name, [c - t0 for c, _ in edges] + [end - t0], half)


def assert_dshot(tmp, variant, throttle, telemetry):
    period = Fraction(CLK_HZ, DSHOT_RATES[variant])
    name, edges, end = measure_dshot(tmp, variant, throttle, telemetry)
    d = decode_dshot(name, edges, period)
    assert d["crc_ok"], f"{name}: CRC mismatch in decoded frame 0x{d['frame']:04X}"
    assert (d["throttle"], d["telemetry"]) == (throttle, telemetry), (
        f"{name}: decoded throttle {d['throttle']} telemetry {d['telemetry']}")
    t0 = d["rises"][0]
    check_grid(name, [r - t0 for r in d["rises"]] + [end - t0], period)
    for i, (bit, high) in enumerate(zip(d["bits"], d["highs"])):
        nominal = period * (Fraction(3, 4) if bit else Fraction(3, 8))
        assert abs(high - nominal) <= HALF, (
            f"{name}: bit {i} ({bit}) high {high} cycles, nominal {float(nominal):.3f}")


# ---------------------------------------------------------------------------
# 1. The judges themselves (run anywhere): green on an exact synthetic line,
#    red on the bug's shape (every half-bit / bit a few cycles long).
# ---------------------------------------------------------------------------

def _synthetic_manchester(byte, half, extra=0):
    edges, t = [], 10
    for i in range(8):
        one = (byte >> (7 - i)) & 1
        for level in ((0, 1) if one else (1, 0)):
            edges.append((t, level))
            t += half + extra
    trace = [(0, 0)] + [(c + 1, lv) for c, lv in edges]

    def level_at(x):
        cs = [c for c, _ in trace]
        return trace[bisect.bisect_right(cs, x) - 1][1]
    return edges, t, level_at


def test_manchester_judge_green_and_red():
    edges, end, level_at = _synthetic_manchester(0xA5, 40)
    assert decode_manchester("synthetic", edges, end, level_at, Fraction(40), False) == 0xA5
    check_grid("synthetic", [c - edges[0][0] for c, _ in edges] + [end - edges[0][0]], Fraction(40))
    edges, end, level_at = _synthetic_manchester(0xA5, 40, extra=4)
    with pytest.raises(AssertionError, match="off the nominal grid"):
        check_grid("slow", [c - edges[0][0] for c, _ in edges] + [end - edges[0][0]], Fraction(40))
    with pytest.raises((ValueError, AssertionError)):
        assert decode_manchester("slow", edges, end, level_at, Fraction(40), False) == 0xA5


def test_dshot_judge_green_and_red():
    period = Fraction(CLK_HZ, 600_000)
    value = (1000 << 1) | 1
    word = (value << 4) | ((value ^ (value >> 4) ^ (value >> 8)) & 0xF)
    edges = []
    for i in range(16):
        rise = int(i * period + HALF)
        bit = (word >> (15 - i)) & 1
        edges += [(rise, 1), (rise + int(period * (Fraction(3, 4) if bit else Fraction(3, 8)) + HALF), 0)]
    d = decode_dshot("synthetic", edges, period)
    assert d["crc_ok"] and d["throttle"] == 1000 and d["telemetry"]
    check_grid("synthetic", [r - d["rises"][0] for r in d["rises"]], period)
    stretched = [(c + 11 * (k // 2), lv) for k, (c, lv) in enumerate(edges)]  # +11 cycles a bit
    d = decode_dshot("stretched", stretched, period)
    with pytest.raises(AssertionError, match="off the nominal grid"):
        check_grid("stretched", [r - d["rises"][0] for r in d["rises"]], period)


# ---------------------------------------------------------------------------
# 2. The real ELF on the TI pru-simulator.
# ---------------------------------------------------------------------------

@needs_sim
@pytest.mark.parametrize("rate", MANCHESTER_RATES)
@pytest.mark.parametrize("byte", MANCHESTER_BYTES)
def test_manchester_half_bits_are_nominal(tmp_path, rate, byte):
    assert_manchester(tmp_path, rate, byte)


@needs_sim
def test_manchester_thomas_convention(tmp_path):
    assert_manchester(tmp_path, 1_000_000, 0xA5, "thomas")


@needs_sim
@pytest.mark.parametrize("rate", [3_000_000, 8_000_000])
def test_manchester_fractional_and_fastest_rate(tmp_path, rate):
    """3 Mbit/s: H = 33.33 cycles (fractional, edges must stay within half a cycle of k*H).
    8 Mbit/s: H = 12.5 cycles, the fastest rate the block accepts at 200 MHz."""
    assert_manchester(tmp_path, rate, 0xA5)


@needs_sim
@pytest.mark.parametrize("variant", list(DSHOT_RATES))
@pytest.mark.parametrize("throttle,telemetry", DSHOT_COMMANDS)
def test_dshot_bit_periods_are_nominal(tmp_path, variant, throttle, telemetry):
    assert_dshot(tmp_path, variant, throttle, telemetry)


# ---------------------------------------------------------------------------
# 3. Validation: a rate whose fixed overhead does not fit must be rejected.
# ---------------------------------------------------------------------------

def test_manchester_rejects_rate_overhead_does_not_fit():
    r = resolve("pru_io_blocks/manchester_block", {"bitRateHz": 10_000_000, "clkHz": CLK_HZ})
    assert any("overhead" in e["message"] and e["field"] == "bitRateHz" for e in r["errors"]), r


def test_manchester_accepts_fastest_rate_that_fits():
    r = resolve("pru_io_blocks/manchester_block", {"bitRateHz": 8_000_000, "clkHz": CLK_HZ})
    assert not r["errors"], r["errors"]


def test_dshot_rejects_variant_overhead_does_not_fit():
    r = resolve("pru_io_blocks/dshot_block", {"variant": "dshot1200", "clkHz": 20_000_000})
    assert any("overhead" in e["message"] for e in r["errors"]), r


def test_dshot_all_variants_fit_at_200mhz():
    for variant in DSHOT_RATES:
        r = resolve("pru_io_blocks/dshot_block", {"variant": variant, "clkHz": CLK_HZ})
        assert not r["errors"], (variant, r["errors"])


# ---------------------------------------------------------------------------
# Script mode: print what was measured (used for the report).
# ---------------------------------------------------------------------------

def _main():
    import tempfile
    tmp = tempfile.mkdtemp(prefix="case_")
    print("Manchester (IEEE) half-bit lengths, cycles (nominal = clk / 2 / rate)")
    for rate in MANCHESTER_RATES + [3_000_000, 8_000_000]:
        for byte in MANCHESTER_BYTES:
            name, edges, end, level_at = measure_manchester(tmp, rate, byte)
            marks = [c for c, _ in edges] + [end]
            halves = [b - a for a, b in zip(marks, marks[1:])]
            half = Fraction(CLK_HZ, 2 * rate)
            try:
                dec = f"0x{decode_manchester(name, edges, end, level_at, half, False):02X}"
            except (ValueError, AssertionError) as exc:
                dec = f"FAIL ({exc})"
            print(f"  {rate:>9} 0x{byte:02X}: nominal {float(half):.3f} halves {sorted(set(halves))} "
                  f"byte {end - marks[0]} vs {float(16 * half):.2f}  decoded {dec}")
    print("DShot bit periods, cycles (nominal = clk / rate)")
    for variant, rate in DSHOT_RATES.items():
        for throttle, telemetry in DSHOT_COMMANDS:
            name, edges, end = measure_dshot(tmp, variant, throttle, telemetry)
            rises = [c for c, lv in edges if lv]
            falls = [c for c, lv in edges if not lv]
            marks = rises + [end]
            periods = [b - a for a, b in zip(marks, marks[1:])]
            highs = sorted(set(f - r for r, f in zip(rises, falls)))
            period = Fraction(CLK_HZ, rate)
            print(f"  {variant:>9} thr {throttle:4} tlm {int(telemetry)}: nominal {float(period):.3f} "
                  f"periods {sorted(set(periods))} highs {highs} frame {end - rises[0]} "
                  f"vs {float(16 * period):.2f}")


if __name__ == "__main__":
    _main()
