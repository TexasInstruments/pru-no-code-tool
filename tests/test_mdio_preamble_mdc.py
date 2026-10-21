"""mdio_master_block must send the IEEE 802.3 22.2.4.5.1 32-bit preamble and its validator must enforce the
MDC timing minimums (22.2.2.11: high and low >= 160 ns, period >= 400 ns).

the block emitted 16 preamble 1s, and halfTrips=10
passed validation while giving 22-cycle MDC phases (110 ns at 200 MHz).

Oracles are measured, not re-derived from the macro text: the real m_mdio_xfer macro is built with clpru and run on the
TI pru-simulator; the preamble length is counted from the simulated MDIO pin level at each MDC rising edge, and the MDC
phase / period cycle costs are read off the same trace. The validator is then driven through the committed
block_validate_runner.js harness and must reject exactly the halfTrips values whose MEASURED timing is below the limit.
"""
import json
import math
import os
import pathlib
import subprocess

import pytest

import elf_cosim

try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except (ImportError, RuntimeError):
    HAVE_ELF = False

needs_elf = pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing")

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "block_validate_runner.js"
BUILD_DIR = REPO_ROOT / "build_out" / ""

MDC_BIT = 0
MDIO_BIT = 1
MAX_STEPS = 200000
MIN_PHASE_NS = 160.0     # IEEE 802.3 22.2.2.11: MDC high >= 160 ns and low >= 160 ns
MIN_PERIOD_NS = 400.0    # IEEE 802.3 22.2.2.11: MDC period >= 400 ns
PREAMBLE_BITS = 32       # IEEE 802.3 22.2.4.5.1
PRELUDE_STEPS = 2        # the 32-bit ldi32 in _spec()'s prelude assembles to 2 simulated steps


class _Idle:
    """No PHY: MDIO released high, so a read samples 1s. Only the master's pins are of interest."""

    def tick(self, _cycle, _pins):
        return 1 << MDIO_BIT


def _spec(trips, is_read):
    return {
        "block": "mdio_master_block", "subdir": "pru_io_blocks", "macroCall": "m_mdio_xfer",
        "macroArgs": {"RES": "R4", "MDC_BIT": str(MDC_BIT), "MDIO_BIT": str(MDIO_BIT), "HALF_TRIPS": str(trips),
                      "PHY_ADDR": "0", "REG_ADDR": "3", "IS_READ": str(is_read), "WRDATA_REG": "R5"},
        "prelude": ["ldi32 R5, 0x8000"], "postlude": ["halt"],
    }


_TRACES = {}


def trace(trips, is_read=0):
    """(cycle, gpo, gpi) per simulated step of the real macro, plus the halt step count."""
    key = (trips, is_read)
    if key not in _TRACES:
        name = "mdio_t%d_r%d" % key
        elf, _asm = elf_cosim.build_block_firmware(_spec(*key), name, workdir=str(BUILD_DIR / name))
        res = elf_cosim.run_elf_closed_loop(elf, _Idle(), max_steps=MAX_STEPS)
        assert res.halted, "firmware did not halt within %d steps (trips=%d)" % (MAX_STEPS, trips)
        _TRACES[key] = res
    return _TRACES[key]


def edges(res):
    """MDC edge list [(cycle, 'r'|'f', mdio_level_at_edge)] from the gpo word stream."""
    out, prev = [], None
    for cycle, gpo, _gpi in res.trace:
        mdc = (gpo >> MDC_BIT) & 1
        if prev is not None and mdc != prev:
            out.append((cycle, "r" if mdc else "f", (gpo >> MDIO_BIT) & 1))
        prev = mdc
    return out


def leading_ones(res):
    """Clocked 1 bits seen on MDIO at MDC rising edges before the first 0 (the start-of-frame's first bit)."""
    n = 0
    for _cycle, kind, mdio in edges(res):
        if kind != "r":
            continue
        if mdio == 0:
            return n
        n += 1
    raise AssertionError("no 0 bit ever clocked")


def min_timing(res):
    """(min high phase, min low phase, min rising-edge period) in PRU cycles over the whole transaction."""
    ev = edges(res)
    hi = [b[0] - a[0] for a, b in zip(ev, ev[1:]) if a[1] == "r" and b[1] == "f"]
    lo = [b[0] - a[0] for a, b in zip(ev, ev[1:]) if a[1] == "f" and b[1] == "r"]
    rises = [e[0] for e in ev if e[1] == "r"]
    per = [b - a for a, b in zip(rises, rises[1:])]
    return min(hi), min(lo), min(per)


def validate(trips, clk_hz, is_read=0):
    inst = {"mdcBit": "0", "mdioBit": "1", "phyAddr": "0", "regAddr": "0", "rw": "read" if is_read else "write",
            "halfTrips": trips, "clkHz": clk_hz}
    proc = subprocess.run(["node", str(RUNNER), "mdio_master_block", json.dumps(inst)],
                          capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=20)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return [e for e in json.loads(proc.stdout.strip())["errors"] if e.get("field") == "halfTrips"]


# ----------------------------------------------------------------------------------------------- preamble
@needs_elf
@pytest.mark.parametrize("is_read", [0, 1])
def test_preamble_is_32_clocked_ones(is_read):
    """Count the 1s clocked on MDIO before the start-of-frame's 0. IEEE 802.3 22.2.4.5.1: 32 contiguous ones."""
    n = leading_ones(trace(20, is_read))
    assert n == PREAMBLE_BITS, "preamble is %d clocked 1 bits, IEEE 802.3 22.2.4.5.1 requires %d" % (n, PREAMBLE_BITS)


# --------------------------------------------------------------------------------- measured MDC timing
@needs_elf
@pytest.mark.parametrize("is_read", [0, 1])
def test_measured_phase_cost_is_linear_in_halftrips(is_read):
    """The validator derives its cycle model from these numbers: each trip adds a fixed cost to every phase, so the
    model is slope*trips + offset. Measure it at three trip counts and require exact linearity."""
    pts = {t: min_timing(trace(t, is_read)) for t in (20, 30, 40)}
    for i in range(3):          # hi phase, lo phase, period
        d1 = pts[30][i] - pts[20][i]
        d2 = pts[40][i] - pts[30][i]
        assert d1 == d2 and d1 > 0, "non-linear MDC timing component %d: %s" % (i, pts)


# ------------------------------------------------------------------------------------- validator threshold
def _needed_trips(clk_hz, is_read=0):
    """Smallest halfTrips whose MEASURED high, low and period meet the IEEE minimums at clk_hz, in the given mode."""
    ns = 1e9 / clk_hz
    for t in range(1, 200):
        if t not in (20, 30, 40):
            # extrapolate from the measured linear model (verified exact by the linearity test)
            a, b = min_timing(trace(20, is_read)), min_timing(trace(30, is_read))
            hi, lo, per = (a[i] + (b[i] - a[i]) * (t - 20) / 10.0 for i in range(3))
        else:
            hi, lo, per = min_timing(trace(t, is_read))
        if hi * ns >= MIN_PHASE_NS and lo * ns >= MIN_PHASE_NS and per * ns >= MIN_PERIOD_NS:
            return t
    raise AssertionError("no halfTrips meets the limit")


# Low clocks (50..87 MHz) are where the 160 ns phase terms, not the 400 ns period term, set the minimum; the fast clocks
# are where the period term does. Odd/non-round values keep a constant that is only right by coincidence honest.
CLOCKS_HZ = [50e6, 62.5e6, 75e6, 80e6, 87.5e6, 100e6, 125e6, 150e6, 175e6, 200e6, 225e6, 250e6, 300e6, 333e6]


@needs_elf
@pytest.mark.parametrize("is_read", [0, 1])
@pytest.mark.parametrize("clk_hz", CLOCKS_HZ)
def test_validator_rejects_just_below_the_measured_minimum_and_accepts_at_it(clk_hz, is_read):
    need = _needed_trips(clk_hz, is_read)
    if clk_hz >= 200e6:
        assert need > 10, "sanity: the halfTrips=10 case must be below the minimum (need=%d)" % need
    assert need >= 2, "need-1 must be a meaningful probe (need=%d)" % need
    below, at = validate(need - 1, clk_hz, is_read), validate(need, clk_hz, is_read)
    assert below, "%s halfTrips=%d is below the 160 ns / 400 ns MDC minimum at %g Hz but passed validation" % (
        "read" if is_read else "write", need - 1, clk_hz)
    assert not at, "%s halfTrips=%d meets the MDC minimum at %g Hz but was rejected: %s" % (
        "read" if is_read else "write", need, clk_hz, at)


@needs_elf
def test_halftrips_10_is_rejected_at_200mhz_and_default_is_accepted():
    assert validate(10, 200000000), "halfTrips=10 gives sub-160 ns MDC phases at 200 MHz and must be rejected"
    assert not validate(50, 200000000), "the default halfTrips=50 must stay legal at 200 MHz"


# ----------------------------------------------------------------------------------- noOfCycles (allocator peak)
def _no_of_cycles(rw, trips):
    js = ("const r=require('./scripts/block_validate_runner.js');"
          "const m=r.loadBlockModule(r.resolveBlockPath('mdio_master_block')).mod;"
          "const i=%s;console.log(m.config.find(c=>c.name==='noOfCycles').getValue(i));"
          % json.dumps({"rw": rw, "halfTrips": trips}))
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=20)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return int(proc.stdout.strip())


@needs_elf
@pytest.mark.parametrize("rw,is_read", [("write", 0), ("read", 1)])
@pytest.mark.parametrize("trips", [1, 5, 20, 50, 100])
def test_no_of_cycles_tracks_the_measured_run_length(rw, is_read, trips):
    """noOfCycles feeds the allocator's peak-cycle figure; it was a flat 1 while the 32-bit frame costs ~13.5k cycles."""
    measured = trace(trips, is_read).cycles
    got = _no_of_cycles(rw, trips)
    # Exact: the formula counts the macro body; the simulated run also executes the 2 prelude ldi32 steps (ldi32 R5, 0x8000).
    assert got == measured - PRELUDE_STEPS, "noOfCycles=%d but the simulated run is %d cycles (%d prelude)" % (
        got, measured, PRELUDE_STEPS)
