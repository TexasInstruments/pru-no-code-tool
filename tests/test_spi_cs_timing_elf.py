"""pru_spi_write CS setup / hold, built through SysConfig + gmake + clpru and run on TI pru-simulator.

The block's "CS Setup Time" / "CS Hold Time" are nanoseconds (minimums) and the macro takes PRU cycles. This test builds a
minimal controller-mode pru_spi_write design at several (ns, PRU clock) settings, runs the real ELF and measures, in the
simulator's GPO pin trace, the cycles from CS assertion to the first SCLK edge and from the last SCLK edge to CS release.

R30 resets to 0, so CS is already low when the block's first clr runs and no assertion edge would show; a PRU GPO block sets CS high
first, as a real transaction starts from CS idle high.

Expected, written independently of the generator: the measured gap is the design's fixed instruction overhead (measured from a
0 ns / 0 ns build, where the macro emits no delay) plus exactly ceil(ns * MHz / 1000) cycles (a delay of N is N nops, 1 cycle each),
and never less than the configured minimum at that clock.
"""
import glob
import math
import os
import shutil
import subprocess
import sys
from fractions import Fraction

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO, "scripts", "sim"))

import elf_cosim

TEMPLATE = os.path.join(REPO, "examples", "empty", "firmware")
BUILD_ROOT = os.path.join(REPO, "build_out", "")
CS_PIN, SCLK_PIN, SDO_PIN = 5, 4, 3
PACKET_BITS = 16


def _find_gmake():
    env = os.environ.get("GMAKE")
    if env and os.path.exists(env):
        return env
    hits = sorted(glob.glob("C:/ti/ccs*/ccs/utils/bin/gmake.exe"))
    return hits[-1] if hits else (shutil.which("gmake") or shutil.which("make"))


GMAKE = _find_gmake()
try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    _HAVE_SIM = True
except RuntimeError:
    _HAVE_SIM = False
_HAVE_BUILD = (GMAKE is not None and os.path.exists(os.path.join(REPO, "imports.mak"))
               and os.path.isdir(os.environ.get("SYSCFG_PATH", "C:/ti/sysconfig_1.28.0")))
needs_build = pytest.mark.skipif(not (_HAVE_SIM and _HAVE_BUILD),
                                 reason="needs clpru + TI pru-simulator + gmake + SysConfig 1.28 + repo-root imports.mak")

SYSCFG = """\
const pru_blocks_static_module = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");
pru_blocks_static_module.pruClkFreq = %(mhz)s;
const load_constant_block  = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const load_constant_block1 = load_constant_block.addInstance();
const pru_gpo_block        = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);
const pru_gpo_block1       = pru_gpo_block.addInstance();
const pru_spi_write        = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_write", {}, false);
const pru_spi_write1       = pru_spi_write.addInstance();
load_constant_block1.$name     = "Data_Word";
load_constant_block1.constant1 = 0xA5A5;
pru_gpo_block1.$name           = "CS_Idle_High";
pru_gpo_block1.constant1       = "R30, %(cs)d";
pru_gpo_block1.opCode          = "SET";
pru_spi_write1.$name           = "SPI_Write_0";
pru_spi_write1["Device Mode"]  = "controller";
pru_spi_write1.packetSize      = %(bits)d;
pru_spi_write1["SDO Signal"]   = "%(sdo)d";
pru_spi_write1["SCLK Signal"]  = "%(sclk)d";
pru_spi_write1["CS Signal"]    = "%(cs)d";
pru_spi_write1["CS Setup Time"] = %(setup)d;
pru_spi_write1["CS Hold Time"]  = %(hold)d;
scripting.connect(pru_spi_write1, "input1", load_constant_block1, "output1");
scripting.connect(load_constant_block1, "next", pru_gpo_block1, "prev");
scripting.connect(pru_gpo_block1, "next", pru_spi_write1, "prev");
"""


def build_and_run(name, setup_ns, hold_ns, mhz):
    work = os.path.join(BUILD_ROOT, name)
    shutil.rmtree(work, ignore_errors=True)
    fw = os.path.join(work, "firmware")
    proj = os.path.join(fw, "am243x-evm", "icss_g0_pru0_fw")
    os.makedirs(os.path.dirname(proj), exist_ok=True)
    shutil.copy(os.path.join(TEMPLATE, "main.asm"), os.path.join(fw, "main.asm"))
    shutil.copytree(os.path.join(TEMPLATE, "am243x-evm", "icss_g0_pru0_fw"), proj, ignore=shutil.ignore_patterns("generated", "syscfg"))
    with open(os.path.join(proj, "example.syscfg"), "w", encoding="utf-8", newline="") as f:
        f.write(SYSCFG % dict(mhz=mhz, bits=PACKET_BITS, sdo=SDO_PIN, sclk=SCLK_PIN, cs=CS_PIN, setup=setup_ns, hold=hold_ns))
    cgt = os.path.join(proj, "ti-pru-cgt")
    env = dict(os.environ, PATH=os.path.dirname(GMAKE) + os.pathsep + os.environ.get("PATH", ""))
    res = subprocess.run([GMAKE, "-s", "all", "PRU_NO_CODE_TOOL_PATH=" + REPO.replace(os.sep, "/"),
                          "MCU_HEX_PATH=" + os.path.join(work, "hex.h").replace(os.sep, "/")],
                         cwd=cgt, env=env, capture_output=True, text=True)
    gen = os.path.join(cgt, "generated")
    outs = [os.path.join(gen, f) for f in os.listdir(gen) if f.endswith(".out")] if os.path.isdir(gen) else []
    if res.returncode != 0 or not outs:
        raise RuntimeError("gmake -s all failed for %s (rc=%s):\n%s\n%s" % (name, res.returncode, res.stdout[-2500:], res.stderr[-1500:]))

    class Idle:  # no peripheral: the write block only drives pins
        def tick(self, cycle, gpo):
            return 0

    run = elf_cosim.run_elf_closed_loop(outs[0], Idle(), max_steps=20000)
    assert run.halted, "firmware did not halt within the cycle budget"
    return _gaps(run.trace)


def _edges(trace, pin):
    """[(cycle, level)] for every change of one GPO bit."""
    out, prev = [], None
    for cycle, gpo, _gpi in trace:
        bit = (gpo >> pin) & 1
        if prev is not None and bit != prev:
            out.append((cycle, bit))
        prev = bit
    return out


def _gaps(trace):
    """(setup, hold) in cycles: CS assertion (falls) -> first SCLK edge, last SCLK edge -> CS release (rises)."""
    cs, sclk = _edges(trace, CS_PIN), _edges(trace, SCLK_PIN)
    fall = [c for c, lvl in cs if lvl == 0]
    rise = [c for c, lvl in cs if lvl == 1]
    assert len(fall) == 1 and rise, "expected one CS assertion and a release in the trace, got CS edges %s" % cs
    cs_assert, cs_release = fall[0], rise[-1]
    during = [c for c, _ in sclk if cs_assert < c < cs_release]
    assert len(during) >= 2 * PACKET_BITS - 1, "expected the %d SCLK pulses between CS assert and release, got %d edges" % (PACKET_BITS, len(during))
    return during[0] - cs_assert, cs_release - during[-1]


def need(ns, mhz):
    """Minimum cycles for a minimum time of ns at mhz: ceil(ns * f / 1000), exact fractions (333.333 option = 1000/3 MHz)."""
    return math.ceil(Fraction(ns) * _mhz(mhz) / 1000)


def _mhz(mhz):
    return Fraction(1000, 3) if abs(mhz - 333.333) < 1e-3 else Fraction(mhz)


@pytest.fixture(scope="module")
def overhead():
    return build_and_run("zero", 0, 0, 200)


@needs_build
@pytest.mark.parametrize("name,setup_ns,hold_ns,mhz", [
    ("200mhz_100_60", 100, 60, 200),            # 20 and 12 cycles; the raw-ns bug would give 100 and 60
    ("333mhz_100_60", 100, 60, 333.333),        # 34 (33.33 rounded up) and 20
    ("250mhz_37_21", 37, 21, 250),              # 10 (9.25 rounded up) and 6 (5.25 rounded up)
])
def test_cs_setup_and_hold_meet_the_configured_minimum_at_the_clock(overhead, name, setup_ns, hold_ns, mhz):
    got_setup, got_hold = build_and_run(name, setup_ns, hold_ns, mhz)
    want_setup, want_hold = need(setup_ns, mhz), need(hold_ns, mhz)
    # a delay of N is N nops, one cycle each, on top of the fixed gap the zero-delay build shows
    assert got_setup == overhead[0] + want_setup, "CS assert -> first SCLK edge: %d cycles, want %d fixed + %d" % (got_setup, overhead[0], want_setup)
    assert got_hold == overhead[1] + want_hold, "last SCLK edge -> CS release: %d cycles, want %d fixed + %d" % (got_hold, overhead[1], want_hold)
    # and, as minimums, in real time at that clock: cycles * (1000 / MHz) ns >= the configured ns
    assert Fraction(got_setup) * 1000 / _mhz(mhz) >= setup_ns
    assert Fraction(got_hold) * 1000 / _mhz(mhz) >= hold_ns


@needs_build
def test_zero_ns_emits_no_delay_and_the_assembler_accepts_it(overhead):
    # the zero build above assembled (`.loop 0` is accepted and emits nothing) and ran; its gaps are the fixed instruction overhead only,
    # far below the 200 cycles a 1 us delay would add at 200 MHz
    assert 1 <= overhead[0] <= 16 and 1 <= overhead[1] <= 16, overhead
