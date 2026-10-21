"""iep_block and scheduler_block reach the IEP through c26 on TI pru-simulator.

A simulator constant table that maps c26 to shared RAM makes any IEP-using block talk to
RAM, and a self-written compare-status bit satisfies its wait. With c26 = IEP (TRM SPRUIM2J
Table 6-65) the block runs against a real counter/compare model. The IEP register map
(SPRUIM2J 14.3.6.1.25) requires:
  * iep_block used the AM335x offsets CMP_CFG/CMP_STATUS/CMP0 = 0x40/0x44/0x48 (on the
    ICSSG those are IEP_CAPR4_REG0/REG1 and IEP_CAPR5_REG0) instead of 0x70/0x74/0x78,
    and its oneshot wrote CMP_CFG=0x01 (CMP0_RST_CNT_EN) rather than CMP_EN[0] = 0x02;
  * scheduler_block read the counter at 0x0C (IEP_SLOW_COMPEN_REG) instead of 0x10
    (IEP_COUNT_REG0).
Each arm is a real clpru ELF run on the TI pru-simulator.
"""
import os
import re
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "scripts", "sim"))

try:
    import elf_cosim
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except Exception:
    HAVE_ELF = False
needs_elf = pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing")

BUILD_DIR = os.path.join(REPO_ROOT, "build_out", "")
BLOCKS = os.path.join(REPO_ROOT, ".metadata", "sysconfig", ".meta", "pru_blocks")


class NoPins:
    def tick(self, cycle, gpo):
        return 0


def iep_spec(func, counts):
    return {"block": "iep_block", "subdir": "utils",
            "macroCall": "", "opCode": "m_iep_block",
            "macroArgs": {"RES": "R4", "func": str(func), "counts": str(counts),
                          "cmpIndex": "0", "autoReset": "1"},
            "postlude": ["halt"]}


def run(spec, name, max_steps=2000):
    elf, _ = elf_cosim.build_block_firmware(spec, name, workdir=os.path.join(BUILD_DIR, name))
    seen = {}

    def on_step(cycle, gpo, gpi, sim):
        seen["iep"] = (sim.iep.count, sim.iep.cmp_cfg, sim.iep.compare[0], sim.iep.global_cfg)
        seen["shared0"] = int.from_bytes(sim.memory_read(0x00010000, 4), "little")

    res = elf_cosim.run_elf_closed_loop(elf, NoPins(), max_steps=max_steps, on_step=on_step)
    return res, seen


@needs_elf
@pytest.mark.parametrize("func,cfg", [(0, 0x03), (1, 0x02)], ids=["periodic", "oneshot"])
def test_iep_block_runs_on_real_iep(func, cfg):
    res, seen = run(iep_spec(func, 40), f"iep_f{func}")
    assert res.halted, "iep_block never saw CMP0 fire: its compare registers are not where the IEP has them"
    count, cmp_cfg, cmp0, glob = seen["iep"]
    assert glob == 0x11, f"IEP_GLOBAL_CFG = {glob:#x}"
    assert cmp0 == 40, f"IEP_CMP0_REG0 = {cmp0}, expected 40"
    assert cmp_cfg == cfg, f"IEP_CMP_CFG = {cmp_cfg:#x}, expected {cfg:#x}"
    assert seen["shared0"] == 0, "IEP access leaked into shared RAM"


def test_iep_block_offsets_match_trm_map():
    src = open(os.path.join(BLOCKS, "utils", "iep_block.syscfg.js")).read()
    got = dict(re.findall(r"\.asg (0x[0-9a-fA-F]+), (IEP_\w+)", src)[i][::-1] for i in range(3))
    assert got == {"IEP_GLOBAL_CFG": "0x00", "IEP_CMP_CFG": "0x70", "IEP_CMP_STATUS": "0x74"}, got
    assert re.search(r"\.asg 0x78, IEP_CMP0\b", src)


def run_scheduler(start_count, steps=3000, name=None):
    spec = {"block": "scheduler_block", "subdir": "program_control",
            "macroCall": "", "opCode": "m_scheduler",
            "macroArgs": {"RES": "R4", "task1": "0", "task2": "255", "task3": "255", "task4": "255"},
            "prelude": ["ldi32 R1, 0x11", "sbco &R1, c26, 0x00, 4",
                        f"ldi32 R1, {start_count}", "sbco &R1, c26, 0x10, 4"],
            "postlude": ["task_0_start:", "add R20, R20, 1", "jmp R29.w0"]}
    name = name or f"sched_{start_count}"
    elf, _ = elf_cosim.build_block_firmware(spec, name, workdir=os.path.join(BUILD_DIR, name))
    return elf_cosim.run_elf_closed_loop(elf, NoPins(), max_steps=steps).registers[20]


@needs_elf
def test_scheduler_dispatches_when_period_elapsed():
    """The task body counts dispatches in R20. IEP_COUNT_REG0 starts 10 below TASK_0_PERIOD
    (200000), so the first dispatch is due within ~10 cycles and the second 200000 later:
    exactly one in 3000 steps. At offset 0x0C the macro read IEP_SLOW_COMPEN_REG (always 0)
    and never saw the period elapse."""
    n = run_scheduler(199990)
    assert n == 1, f"task 0 dispatched {n} times in 3000 steps, expected exactly 1"


@needs_elf
def test_scheduler_does_not_dispatch_before_period():
    """Counter at 0, period 200000: nothing is due in 3000 steps. The macro compared with
    the operands of QBLT swapped (skip when delta > period), so it dispatched on EVERY
    loop (about 15 times here) and never honoured the period."""
    n = run_scheduler(0)
    assert n == 0, f"task 0 dispatched {n} times before its 200000-count period elapsed"


@pytest.mark.parametrize("path", [
    ("pru_io_blocks", "hall_block"),
    ("pru_io_blocks", "encoder_speed_block"),
])
def test_iep_counter_reads_use_count_reg0(path):
    """Every `lbco ..., c26, <off>` that timestamps with the IEP counter must read
    IEP_COUNT_REG0 (0x10). Offset 0x08 is IEP_COMPEN_REG (SPRUIM2J 14.3.6.1.25), a register
    that is 0 unless firmware programs a compensation value."""
    src = open(os.path.join(BLOCKS, path[0], path[1] + ".syscfg.js")).read()
    offs = re.findall(r"lbco\s+&TEMP_REG\d,\s*c26,\s*(0x[0-9a-fA-F]+)", src)
    ts = [o for o in offs if int(o, 16) in (0x08, 0x0C, 0x10)]
    assert ts and all(int(o, 16) == 0x10 for o in ts), f"{path[1]}: counter read offsets {ts}"


def run_scheduler_all(counter, enabled=True, steps=3000, name=None):
    """All four tasks emitted (task ids 0..3 -> task_N_start), one R20..R23 counter each.
    Periods are the macro's 200000/400000/600000/800000. enabled=False writes
    IEP_GLOBAL_CFG=0, which freezes the counter, so delta is the same on every loop
    and a tick with delta == period is guaranteed rather than hoped for."""
    spec = {"block": "scheduler_block", "subdir": "program_control",
            "macroCall": "", "opCode": "m_scheduler",
            "macroArgs": {"RES": "R4", "task1": "0", "task2": "1", "task3": "2", "task4": "3"},
            "prelude": [f"ldi32 R1, {0x11 if enabled else 0}", "sbco &R1, c26, 0x00, 4",
                        f"ldi32 R1, {counter}", "sbco &R1, c26, 0x10, 4"],
            "postlude": [line for k in range(4) for line in
                         (f"task_{k}_start:", f"add R{20 + k}, R{20 + k}, 1", "jmp R29.w0")]}
    name = name or f"sched_all_{counter}_{int(enabled)}"
    elf, _ = elf_cosim.build_block_firmware(spec, name, workdir=os.path.join(BUILD_DIR, name))
    regs = elf_cosim.run_elf_closed_loop(elf, NoPins(), max_steps=steps).registers
    return tuple(regs[20:24])


PERIODS = (200000, 400000, 600000, 800000)


@needs_elf
@pytest.mark.parametrize("counter,expected", [
    (PERIODS[0] - 1, (0, 0, 0, 0)),
    (PERIODS[0], (1, 0, 0, 0)),
    (PERIODS[1], (1, 1, 0, 0)),
    (PERIODS[2], (1, 1, 1, 0)),
    (PERIODS[3], (1, 1, 1, 1)),
], ids=["below_all", "eq_task0", "eq_task1", "eq_task2", "eq_task3"])
def test_scheduler_frozen_counter_pins_every_task_and_the_boundary(counter, expected):
    """Counter frozen at C, last_k = 0, so delta_k = C on every loop. Task k must dispatch
    exactly once iff C >= period_k: C == period_k is the boundary (QBGT dispatches at
    equality, QBGE would not), and C below a period must not dispatch that task (QBLT, the
    swapped operand order, would dispatch it on every loop). One arm per task so a revert of
    any single skip_task_N is red."""
    got = run_scheduler_all(counter, enabled=False)
    assert got == expected, f"dispatch counts (task0..3) {got}, expected {expected} at counter {counter}"


@needs_elf
def test_scheduler_running_counter_dispatches_each_task_once_in_window():
    """Free-running counter starting just below the 4th period: tasks 0-2 are overdue at
    once, task 3 becomes due ~10 cycles in; every task dispatches exactly once in 3000 steps."""
    got = run_scheduler_all(PERIODS[3] - 10)
    assert got == (1, 1, 1, 1), f"dispatch counts (task0..3) {got}, expected one each"
