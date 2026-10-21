"""pwm_block and three_phase_pwm_block run for N periods and fall through.

Timing is judged by the TI pru-simulator running the real clpru ELF (scripts/sim/elf_cosim.py),
not by the no-code JS simulator, which shares the generator's assumptions. The expected
numbers are not formulas: they are measured from the block's own existing mode in the same
simulator (pwm_block m_pwm_run, which loops forever; three_phase_pwm_block's single
m_three_phase_pwm_period call, and two of them back to back).
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

COUNT_ARG = re.compile(r"PERIOD_COUNT(?![A-Z_])")  # the macro argument, not PERIOD_COUNTS
PWM = ("pwm_block", "pru_io_blocks")
TPP = ("three_phase_pwm_block", "pru_io_blocks")


class Idle:
    def tick(self, _cycle, _pins):
        return 0


def node_eval(block, subdir, fields, expr):
    """Evaluate `expr` (JS, with `m` the block module and `i` an instance) in the repo's sandbox."""
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule(process.argv[1],process.argv[2]);
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[3]));
const get=n=>{const c=m.config.find(c=>c.name===n);return c.getValue?c.getValue(i):c.default;};
const errors=[];const v={logError:(msg,_inst,field)=>errors.push([msg,field])};
console.log(JSON.stringify(eval(process.argv[4])));"""
    return json.loads(subprocess.check_output(
        ["node", "-e", script, block, subdir, json.dumps(fields), expr], cwd=ROOT, text=True))


def validation_errors(block_subdir, **fields):
    block, subdir = block_subdir
    return node_eval(block, subdir, fields, "(m.validate(i,v),errors)")


# ---- config surface -------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [-1, 2 ** 31, 1.5])
@pytest.mark.parametrize("target", [PWM, TPP], ids=["pwm", "three_phase"])
def test_period_count_out_of_range_is_a_named_error(target, bad):
    errors = validation_errors(target, periodCount=bad)
    assert ["periodCount must be 0..2147483647", "periodCount"] in errors


@pytest.mark.parametrize("ok", [0, 1, 5, 2 ** 31 - 1])
@pytest.mark.parametrize("target", [PWM, TPP], ids=["pwm", "three_phase"])
def test_period_count_in_range_is_accepted(target, ok):
    assert not [e for e in validation_errors(target, periodCount=ok) if e[1] == "periodCount"]


def test_pwm_period_count_selects_counted_macro_and_next_port():
    forever = node_eval(*PWM, {}, "[get('opCode'),get('numOfConstants'),m.ports(i).map(p=>p.name)]")
    counted = node_eval(*PWM, {"periodCount": 3},
                        "[get('opCode'),get('numOfConstants'),get('constant8'),m.ports(i).map(p=>p.name)]")
    assert forever == ["m_pwm_run", 7, ["prev"]]
    assert counted == ["m_pwm_run_counted", 8, 3, ["prev", "next"]]


def test_three_phase_period_count_selects_counted_macro():
    default = node_eval(*TPP, {}, "[get('opCode'),get('numOfConstants'),get('noOfCycles')]")
    counted = node_eval(*TPP, {"periodCount": 3},
                        "[get('opCode'),get('numOfConstants'),get('constant10'),get('noOfCycles')]")
    assert default == ["m_three_phase_pwm_period", 9, 1260]
    assert counted == ["m_three_phase_pwm_counted", 10, 3, 3 * 1260]


# ---- default mode is unchanged --------------------------------------------------------------

def macro_text(block_subdir, opcode):
    block, subdir = block_subdir
    return node_eval(block, subdir, {}, f"m.getMacro('{opcode}','{opcode}')")


# sha256 of each block's default (single-call) macro text. Adding the counted mode must leave
# the default macro byte-identical; regenerate a hash only after reviewing the macro diff.
DEFAULT_MACRO_SHA = {
    "m_pwm_run": "352b0ebf4edc3d23b3807bca022e9ee131361ed847c7e83f3a9503bb7e6294e8",
    "m_three_phase_pwm_period": "8b78541b20dab6f562f2d900c5c6bff766efdc37466c6ff0b1c74510fc3aa16c",
}


@pytest.mark.parametrize("target,opcode", [(PWM, "m_pwm_run"), (TPP, "m_three_phase_pwm_period")])
def test_default_macro_text_is_byte_identical_to_base(target, opcode):
    got = hashlib.sha256(macro_text(target, opcode).encode()).hexdigest()
    assert got == DEFAULT_MACRO_SHA[opcode]
    assert not COUNT_ARG.search(macro_text(target, opcode))


@pytest.mark.parametrize("target,call,expect", [
    (PWM, "m_pwm_run_counted R10, 3, 200, 80, 1, 0, 4, 4, 5", "m_pwm_run_counted"),
    (TPP, "m_three_phase_pwm_counted R4, R5, R6, R7, 400, 10, 0, 1, 2, 3, 4, 5, 6, 3", "m_three_phase_pwm_counted"),
    (PWM, "m_pwm_run R10, 3, 200, 80, 1, 0, 4, 4", "m_pwm_run"),
    (TPP, "m_three_phase_pwm_period R4, R5, R6, R7, 400, 10, 0, 1, 2, 3, 4, 5, 6", "m_three_phase_pwm_period"),
])
def test_generator_call_path_picks_the_variant_from_the_call_text(target, call, expect):
    """pru_blocks_static_module calls getMacro(call, "") - the call text alone must pick the macro."""
    block, subdir = target
    text = node_eval(block, subdir, {}, f"m.getMacro({json.dumps(call)}, '')")
    assert bool(COUNT_ARG.search(text)) == ("counted" in expect)


# ---- real-ELF timing in the TI pru-simulator ------------------------------------------------

def edges(result, pins):
    """[(cycle, pin_name, level)] for every change on the named pins of the GPO word."""
    out = []
    previous = 0
    for cycle, gpo, _ in result.trace:
        for name, bit in pins.items():
            if (gpo ^ previous) >> bit & 1:
                out.append((cycle, name, (gpo >> bit) & 1))
        previous = gpo
    return out


def run_asm(tmp_path, spec, name, steps):
    # Both PWM blocks program the IEP through c26; the run maps c26 to the IEP as on the device,
    # whatever the checkout's constants_am243x.cfg says. The counted and the reference runs are
    # compared cycle for cycle, so the IEP runs at the core clock: with an independent IEP clock
    # (200 MHz IEP, 250 MHz PRU) an edge that waits on a compare event moves by the IEP-to-core
    # phase at which its period starts (4 cycles on one three-phase edge), which is a property
    # of the clocking, not of the counted mode.
    if elf_cosim.simulator_iep_base() != 0x0002E000:
        pytest.skip("pru-simulator checkout has no IEP0 model at 0x0002E000")
    elf, _ = elf_cosim.build_block_firmware(spec, name, str(tmp_path))
    return elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=steps, constants=elf_cosim.IEP_CONSTANTS,
                                         lock_iep_to_core=True)


PWM_PINS = {"PWM": 3, "COMP": 4}


def pwm_run(tmp_path, opcode, comp, count=None, steps=6000):
    args = dict(RES="R0", PIN="3", PERIOD_COUNTS="200", DUTY_COUNTS="80", ACTIVE_HIGH="1",
                EN_COMP=str(comp), COMP_PIN="4", DEADBAND_COUNTS="4")
    if count is not None:
        args["PERIOD_COUNT"] = str(count)
    spec = dict(block=PWM[0], subdir=PWM[1], macroCall=opcode, macroArgs=args, postlude=["halt"])
    result = run_asm(tmp_path, spec, f"{opcode}_{comp}_{count}", steps)
    return result, edges(result, PWM_PINS)


def rel(evs, origin):
    return [(c - origin, n, lvl) for c, n, lvl in evs]


@pytest.mark.parametrize("comp", [0, 1])
@pytest.mark.parametrize("count", [1, 2, 5])
def test_pwm_counted_periods_match_forever_mode_and_fall_through(tmp_path, count, comp):
    forever_result, forever = pwm_run(tmp_path, "m_pwm_run", comp)
    assert not forever_result.halted, "m_pwm_run must still loop forever"
    result, counted = pwm_run(tmp_path, "m_pwm_run_counted", comp, count)
    assert result.halted, "counted block did not fall through to the next instruction"

    rises = [e for e in counted if e[1] == "PWM" and e[2] == 1]
    falls = [e for e in counted if e[1] == "PWM" and e[2] == 0]
    assert len(rises) == count and len(falls) == count

    # Same edges, same cycles, relative to the first rising edge: the whole run, so the
    # first period, the middle ones and the LAST period are all checked, comp pin included.
    f_rises = [e for e in forever if e[1] == "PWM" and e[2] == 1]
    n_edges = len(counted)
    assert rel(counted, rises[0][0]) == rel(forever[:n_edges], f_rises[0][0])

    # Per-period numbers, asserted explicitly so a failure names the period.
    f_falls = [e for e in forever if e[1] == "PWM" and e[2] == 0]
    for k in range(count):
        assert falls[k][0] - rises[k][0] == f_falls[k][0] - f_rises[k][0], f"high time, period {k}"
        if k:
            assert rises[k][0] - rises[k - 1][0] == f_rises[k][0] - f_rises[k - 1][0], f"period {k}"

    # Exit overhead sits after the last period boundary: the instant forever mode would have
    # raised the pin for period N+1. Documented as 4 cycles in pwm_block's longDescription.
    # The first instruction of a period is the complementary pin's clr when enabled, one cycle
    # before the main pin's rising edge, so the loop head is `comp` cycles ahead of the edge.
    loop_head = rises[0][0] - comp + (f_rises[count][0] - f_rises[0][0])
    assert result.cycles - loop_head == 4


@pytest.mark.parametrize("steps", [3000])
def test_pwm_counted_stops_driving_after_n_periods(tmp_path, steps):
    """Run on past the end: no sixth rising edge may ever appear."""
    spec = dict(block=PWM[0], subdir=PWM[1], macroCall="m_pwm_run_counted",
                macroArgs=dict(RES="R0", PIN="3", PERIOD_COUNTS="200", DUTY_COUNTS="80", ACTIVE_HIGH="1",
                               EN_COMP="0", COMP_PIN="4", DEADBAND_COUNTS="4", PERIOD_COUNT="2"),
                postlude=["nop"] * 2000)
    result = run_asm(tmp_path, spec, "pwm_tail", 3500)
    assert len([e for e in edges(result, PWM_PINS) if e[2] == 1]) == 2


TP_PINS = dict(AH=0, AL=1, BH=2, BL=3, CH=4, CL=5, TRIGGER=6)
TP_ARGS = dict(STATE="R4", DUTY_A="R5", DUTY_B="R6", DUTY_C="R7", PERIOD="400", DEADTIME="10",
               AH="0", AL="1", BH="2", BL="3", CH="4", CL="5", TRIGGER="6")
TP_PRELUDE = ["ldi32 R5, 100", "ldi32 R6, 200", "ldi32 R7, 300"]


def tp_spec(opcode, count=None):
    args = dict(TP_ARGS)
    if count is not None:
        args["PERIOD_COUNT"] = str(count)
    return dict(block=TPP[0], subdir=TPP[1], macroCall=opcode, macroArgs=args,
                prelude=TP_PRELUDE, postlude=["halt"])


def tp_periods(evs):
    """Split the edge list into periods at each AH rising edge."""
    starts = [i for i, e in enumerate(evs) if e[1] == "AH" and e[2] == 1]
    return [evs[a:b] for a, b in zip(starts, starts[1:] + [len(evs)])]


@pytest.mark.parametrize("count", [1, 3])
def test_three_phase_counted_periods_match_single_period_call(tmp_path, count):
    ref = run_asm(tmp_path, tp_spec("m_three_phase_pwm_period"), "tp_ref", 3000)
    assert ref.halted
    ref_evs = edges(ref, TP_PINS)
    ref_period = rel(ref_evs, ref_evs[0][0])
    assert len(ref_period) == 14

    result = run_asm(tmp_path, tp_spec("m_three_phase_pwm_counted", count), f"tp_{count}", 6000)
    assert result.halted, "counted block did not fall through to the next instruction"
    periods = tp_periods(edges(result, TP_PINS))
    assert len(periods) == count
    for k, period in enumerate(periods):
        # every phase edge (both sides of every leg and the sample strobe) at the same offset
        # from its period's first edge as in one m_three_phase_pwm_period call: first, middle, last.
        assert rel(period, period[0][0]) == ref_period, f"period {k}"
    # Exit path: the block returns 2 cycles after the last all-off edge, versus the single
    # call's 10; the extra 2 are the period decrement and its branch.
    last_edge = edges(result, TP_PINS)[-1][0]
    ref_gap = ref.cycles - ref_evs[-1][0]
    assert result.cycles - last_edge == ref_gap + 2


def test_three_phase_period_gap_is_measured_and_shorter_than_recall(tmp_path):
    """Gap between periods: counted keeps the IEP configured, so it is shorter than two calls."""
    result = run_asm(tmp_path, tp_spec("m_three_phase_pwm_counted", 3), "tp_gap", 6000)
    evs = edges(result, TP_PINS)
    periods = tp_periods(evs)
    gaps = [b[0][0] - a[-1][0] for a, b in zip(periods, periods[1:])]
    assert gaps == [32, 32]
