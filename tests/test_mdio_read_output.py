"""mdio_master_block read must land the sampled value in its data register and expose it on output1.

a block-built read returned the register's prior content (R4's seed 0x410) for a static 0 and a
static 1 on MDIO (expected 0x0000 / 0xffff), and `scripting.connect(<mdio>, "output1", ...)` failed with
"Unknown object passed to scripting.connect", so the value could not reach a downstream block.

Whole path under test: SysConfig CLI -> generated pru_syscfg.asm -> clpru -> TI pru-simulator, with R31 driven by an
independent model while the firmware runs. The oracle is the simulator's register file at halt (plain Python, never the
asm text): the register named by `dataRegister` and the register the downstream OR block wrote.
"""
import os
import re
import shutil
import struct
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import test_fanout_register_alias as T  # noqa: E402
import elf_cosim  # noqa: E402
from pru_device_models.mdio_phy_model import MdioPhyModel  # noqa: E402

MDC_BIT = 0
MDIO_BIT = 1
DATA_REG = "R4"
SEED = 0x410            # what the harness left in R4 before the read; run() loads it into the data register
WR_VALUE = 0x1234       # known data-register content for the write arm
LIVE = 0x5A5A1234       # a live Load Constant that must survive the read (allocator arm)
MAX_STEPS = 60000

HDR = (T.HEADER +
       'const mdio_master_block = scripting.addModule("/pru_blocks/pru_io_blocks/mdio_master_block", {}, false);\n')


def design(connect_output=True, data_reg=DATA_REG, rw="read", live=False):
    """zero -> MD_R (read PHY 0 reg 3) -> Out_Or(MD_R.output1 | zero). Out_Or is the downstream block.

    live=True adds a Load Constant `Live` consumed by `Keep` (Live | zero) AFTER the read, so a register the allocator
    hands to Live that is also the data register would be overwritten by the read result.
    """
    lines = [
        HDR,
        'const zero = load_constant_block.addInstance(); zero.constant1 = 0; zero.$name = "Zero";',
        'const md = mdio_master_block.addInstance(); md.$name = "MD_R"; md.rw = "%s"; '
        'md.mdcBit = "%d"; md.mdioBit = "%d"; md.phyAddr = "0"; md.regAddr = "3"; md.dataRegister = "%s";'
        % (rw, MDC_BIT, MDIO_BIT, data_reg),
        'const out = bitwise_block.addInstance(); out.opCode = "OR"; out.output1Size = "4"; out.$name = "Out_Or";',
    ]
    if rw == "write":     # no output1 in write mode; the data register is an input of the block
        lines = lines[:3]
        lines += ['scripting.connect(zero, "next", md, "prev");']
        return "\n".join(lines) + "\n"
    if connect_output:
        lines += ['scripting.connect(out, "input1", md, "output1");',
                  'scripting.connect(out, "input2", zero, "output1");']
    if live:
        lines += ['const lv = load_constant_block.addInstance(); lv.constant1 = %d; lv.output1Size = 4; lv.$name = "Live";' % LIVE,
                  'const keep = bitwise_block.addInstance(); keep.opCode = "OR"; keep.output1Size = "4"; keep.$name = "Keep";',
                  'scripting.connect(keep, "input1", lv, "output1");',
                  'scripting.connect(keep, "input2", zero, "output1");',
                  'scripting.connect(lv, "next", zero, "prev");',
                  'scripting.connect(zero, "next", md, "prev");',
                  'scripting.connect(md, "next", out, "prev");',
                  'scripting.connect(out, "next", keep, "prev");']
        return "\n".join(lines) + "\n"
    lines += ['scripting.connect(zero, "next", md, "prev");',
              'scripting.connect(md, "next", out, "prev");']
    return "\n".join(lines) + "\n"


def build(text):
    """Returns (elf, asm). The stages are the ones the product itself uses."""
    work = tempfile.mkdtemp(prefix="case_")
    try:
        with open(os.path.join(work, "design.syscfg"), "w", encoding="utf-8") as f:
            f.write(text)
        T._run([T.SYSCFG_NODE, T.SYSCFG_CLI, "--product", T.PRODUCT_JSON, "--device", "AM243x_ALX_beta",
                "--context", "icss_g0_pru0", "--part", "ALX", "--package", "ALX", "--output", "syscfg",
                "design.syscfg"], work)
        asm_path = os.path.join(work, "syscfg", "pru_syscfg.asm")
        with open(asm_path, encoding="utf-8") as f:
            asm = f.read()
        return T._link(work, T.MAIN_ASM, asm_path), asm
    finally:
        shutil.rmtree(work, ignore_errors=True)


class StaticMdio:
    """R31 with MDIO held at a constant level for the whole run (no PHY): static 0 or static 1."""

    def __init__(self, level):
        self.level = level

    def tick(self, _cycle, _pins):
        return (self.level & 1) << MDIO_BIT


def run(elf, model, seed_reg=int(DATA_REG[1:]), seed=SEED):
    """Closed pin loop on the real ELF, with register seed_reg pre-loaded with `seed`. Returns (halted, regs)."""
    entry = struct.unpack_from("<I", elf, 24)[0]
    with elf_cosim._sim_namespace(T.SIMDIR):
        from simulator import Simulator  # type: ignore
        sim = Simulator(os.path.join(T.SIMDIR, "memory.cfg"))
        assert not sim.load_elf("pru0", elf)
        pru = sim.cores["pru0"]
        pru.pc = entry // 4
        pru.registers.regs[seed_reg] = seed
        for _ in range(MAX_STEPS):
            gpo = 0
            for n, b in enumerate(pru.io_port.get_gpo_pins()):
                if b:
                    gpo |= 1 << n
            pru.io_port.set_gpi_word(model.tick(pru.counters.cycles, gpo) & 0xFFFFF)
            sim.step("pru0", 1)
            if pru.halted:
                break
        return pru.halted, list(sim.registers("pru0"))


def dest_reg(asm, block):
    m = re.search(r";PRU Instruction of %s\s*\n\s*\w+\s+R(\d+)\b" % re.escape(block), asm)
    assert m, "no instruction for %s in generated asm" % block
    return int(m.group(1))


_CACHE = {}


def built(key="default", **kw):
    if key not in _CACHE:
        _CACHE[key] = build(design(**kw))
    return _CACHE[key]


def read_value(model, key="default", seed_reg=int(DATA_REG[1:]), seed=SEED, **kw):
    elf, asm = built(key, **kw)
    halted, regs = run(elf, model, seed_reg, seed)
    assert halted, "firmware did not halt within %d steps" % MAX_STEPS
    return regs, asm


@T.needs_tools
def test_output1_connects_and_generates():
    """scripting.connect(<mdio>, "output1", ...) must work (fails with 'Unknown object' at base)."""
    elf, asm = built()
    assert elf and asm


@T.needs_tools
@pytest.mark.parametrize("level,expected", [(0, 0x0000), (1, 0xFFFF)])
def test_static_level_lands_in_data_register_and_downstream(level, expected):
    regs, asm = read_value(StaticMdio(level))
    data = regs[int(DATA_REG[1:])] & 0xFFFFFFFF
    down = regs[dest_reg(asm, "Out_Or")] & 0xFFFFFFFF
    assert data == expected, "data register %s = %#x, want %#x (seed %#x left behind?)" % (DATA_REG, data, expected, SEED)
    assert down == expected, "downstream OR block = %#x, want %#x" % (down, expected)


@T.needs_tools
def test_mixed_pattern_reaches_data_register_and_downstream():
    model = MdioPhyModel(phy_addr=0, min_half_period_cycles=40, registers={3: 0xA5C3})
    regs, asm = read_value(model)
    assert model.faults() == [], model.faults()
    data = regs[int(DATA_REG[1:])] & 0xFFFFFFFF
    down = regs[dest_reg(asm, "Out_Or")] & 0xFFFFFFFF
    assert data == 0xA5C3, "data register = %#x, want 0xa5c3" % data
    assert down == 0xA5C3, "downstream OR block = %#x, want 0xa5c3" % down


@T.needs_tools
@pytest.mark.parametrize("token", ["R0", "R0.w0"])
def test_data_register_is_reserved_from_the_allocator_in_read_mode(token):
    """dataRegister=R0 (or a sub-register token of it, which the allocator still reserves whole: fullRegister) is where the allocator starts handing out registers. A live Load Constant consumed after the
    read must not be given R0 (the read result is written there); it survives with its value and the read still lands.
    Arms pru_register_allocator.js (read-mode role "w" + fullRegister): reverting it overwrites the constant."""
    model = MdioPhyModel(phy_addr=0, min_half_period_cycles=40, registers={3: 0xA5C3})
    regs, asm = read_value(model, key="r0_live_" + token, seed_reg=0, seed=0, data_reg=token, live=True)
    assert model.faults() == [], model.faults()
    assert dest_reg(asm, "Keep") != 0, "allocator gave the live constant the data register R0"
    assert regs[0] & 0xFFFFFFFF == 0xA5C3, "R0 = %#x, want 0xa5c3" % (regs[0] & 0xFFFFFFFF)
    assert regs[dest_reg(asm, "Keep")] & 0xFFFFFFFF == LIVE, "live constant clobbered by the read result"
    assert regs[dest_reg(asm, "Out_Or")] & 0xFFFFFFFF == 0xA5C3


@T.needs_tools
def test_write_leaves_the_data_register_alone():
    """A write transmits the data register and must not store anything back into it (the read-only `mov WRDATA_REG,RES`
    belongs to the IS_READ branch)."""
    regs, _asm = read_value(StaticMdio(1), key="write", seed_reg=int(DATA_REG[1:]), seed=WR_VALUE, rw="write")
    got = regs[int(DATA_REG[1:])] & 0xFFFFFFFF
    assert got == WR_VALUE, "write changed the data register: %#x, want %#x" % (got, WR_VALUE)
