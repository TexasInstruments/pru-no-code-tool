"""Load Constant gets an optional output width (auto / 1 / 2 / 4 bytes).

Load Constant sized its output only from the value, so a design needing independent 32-bit constants silently had
two small ones packed into one register (red arm: 30 coefficients 0x1000..0x101D came out as
LDI Rn.w0 / Rn.w2 with no warning). outputWidth = "4" now reserves a whole register; the default "auto" is
unchanged, so existing designs generate byte-identical output.

Checked with SysConfig CLI generation, and with the real clpru ELF on TI pru-simulator.
"""
import os
import re
import shutil
import struct
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import test_fanout_register_alias as T  # noqa: E402
import test_register_pool_exhaustion as P  # noqa: E402


def constants_syscfg(values, width=None, extra=""):
    """Independent Load Constants C0..Cn, chained in execution order; `width` None leaves the option unset."""
    L = [T.HEADER]
    for i, v in enumerate(values):
        L.append('const c%d = load_constant_block.addInstance(); c%d.constant1 = %d; c%d.$name = "C%d";%s'
                 % (i, i, v, i, i, ' c%d.outputWidth = "%s";' % (i, width) if width else ""))
    L.append(extra)
    seq = ["c%d" % i for i in range(len(values))]
    L += ['scripting.connect(%s, "next", %s, "prev");' % (a, b) for a, b in zip(seq, seq[1:])]
    return "\n".join(L) + "\n"


def ldi_lines(asm):
    return [ln.strip() for ln in asm.splitlines() if ln.strip().startswith("LDI")]


def gen(text):
    rc, out, asm, work = P.generate(text)
    shutil.rmtree(work, ignore_errors=True)
    return rc, out, asm


REPRESENTATIVE = [0, 0x55, 0xFF, 0x100, 0x1234, 0xFFFF, 0x10000, 0x123456, 0xDEADBEEF]


@T.needs_tools
def test_default_auto_output_is_unchanged_for_representative_values():
    """No outputWidth set and outputWidth = "auto" are the same design, and the output is the pre-packing."""
    rc, out, plain = gen(constants_syscfg(REPRESENTATIVE))
    assert rc == 0, out[-600:]
    rc, out, auto = gen(constants_syscfg(REPRESENTATIVE, "auto"))
    assert rc == 0, out[-600:]
    assert ldi_lines(auto) == ldi_lines(plain)
    # recorded on e272b120, before the option existed
    assert ldi_lines(plain) == [
        "LDI R0.b0, 0", "LDI R0.b1, 85", "LDI R0.b2, 255", "LDI R1.w0, 256", "LDI R1.w2, 4660",
        "LDI R2.w0, 65535", "LDI32 R3, 65536", "LDI32 R4, 1193046", "LDI32 R5, 3735928559"]


def digest(asm):
    return re.search(r"PRU_DESIGN_DIGEST (\w+)", asm).group(1)


@T.needs_tools
def test_default_auto_keeps_the_design_digest_and_a_chosen_width_changes_it():
    """The digest in the asm header snapshots every config; "auto" must not enter it, an explicit width must."""
    rc, out, plain = gen(constants_syscfg(REPRESENTATIVE))
    assert rc == 0, out[-600:]
    assert digest(plain) == "c3c4dc2bddb07fca"  # recorded on e272b120, before the option existed
    rc, out, wide = gen(constants_syscfg(REPRESENTATIVE, "4"))
    assert rc == 0, out[-600:]
    assert digest(wide) != digest(plain), "a design that picks a width is a different design to the TI-run staleness check"


@T.needs_tools
def test_explicit_width_4_gives_each_small_constant_its_own_register():
    values = [0x1000 + i for i in range(6)]
    rc, out, auto = gen(constants_syscfg(values))
    assert rc == 0, out[-600:]
    assert any(re.search(r"\.[bw]\d", ln) for ln in ldi_lines(auto)), "auto must still pack: " + str(ldi_lines(auto))
    rc, out, wide = gen(constants_syscfg(values, "4"))
    assert rc == 0, out[-600:]
    lines = ldi_lines(wide)
    assert lines == ["LDI R%d, %d" % (i, v) for i, v in enumerate(values)], lines


@T.needs_tools
def test_explicit_widths_1_and_2_reserve_that_many_bytes():
    rc, out, asm = gen(constants_syscfg([1, 2, 3, 4], "2"))
    assert rc == 0, out[-600:]
    assert ldi_lines(asm) == ["LDI R0.w0, 1", "LDI R0.w2, 2", "LDI R1.w0, 3", "LDI R1.w2, 4"], ldi_lines(asm)
    rc, out, asm = gen(constants_syscfg([1, 2, 3, 4, 5], "1"))
    assert rc == 0, out[-600:]
    assert ldi_lines(asm)[:5] == ["LDI R0.b0, 1", "LDI R0.b1, 2", "LDI R0.b2, 3", "LDI R0.b3, 4", "LDI R1.b0, 5"]


@T.needs_tools
def test_width_smaller_than_the_value_is_a_sysconfig_error():
    rc, out, _asm = gen(constants_syscfg([0x1234], "1"))
    assert rc != 0, "a 2-byte constant with Output Width 1 must not generate:\n" + out[-600:]
    assert "Constant 4660 needs 2 byte(s) but Output Width is 1 byte(s)" in out, out[-800:]


@T.needs_tools
def test_thirty_explicit_4_byte_constants_hit_the_register_budget_with_a_named_error():
    """the red arm: 30 coefficients 0x1000..0x101D as independent 32-bit values."""
    values = [0x1000 + i for i in range(30)]
    rc, out, _asm = gen(constants_syscfg(values, "4"))
    assert rc != 0, "30 full-register constants cannot fit 28 registers:\n" + out[-600:]
    errs = re.findall(r"Out of registers: block '(\w+)' needs 4 byte\(s\) for its result but only 0 of the 112 "
                      r"allocatable bytes \(R0-R27, 28 registers; R28/R29 are reserved\) are free", out)
    assert errs == ["C28", "C29"], "got %s, output: %s" % (errs, out[-1200:])
    # the same 30 values with the default stay silently packed: that is the gap this option closes
    rc, out, asm = gen(constants_syscfg(values))
    assert rc == 0 and "Out of registers" not in out


@T.needs_tools
def test_elf_two_small_wide_constants_are_independent_registers_on_ti_simulator():
    """Real clpru ELF: two 16-bit-valued 4-byte constants added; each in its own register, sum correct."""
    a, b = 0x1234, 0x0FF1
    text = T.HEADER + "\n".join([
        'const ca = load_constant_block.addInstance(); ca.$name = "CA"; ca.constant1 = %d; ca.outputWidth = "4";' % a,
        'const cb = load_constant_block.addInstance(); cb.$name = "CB"; cb.constant1 = %d; cb.outputWidth = "4";' % b,
        'const s = arithmetic_block.addInstance(); s.$name = "S"; s.opCode = "ADD"; s.output1Size = "4";',
        'scripting.connect(s, "input1", ca, "output1");',
        'scripting.connect(s, "input2", cb, "output1");',
        'scripting.connect(ca, "next", cb, "prev");',
        'scripting.connect(cb, "next", s, "prev");']) + "\n"
    elf, asm, reg = T.build_design(text, "S")
    da, _ = T.operands(asm, "CA")
    db, _ = T.operands(asm, "CB")
    assert da != db and "." not in da and "." not in db, (da, db)
    halted, got = T.run_elf(elf, reg, max_steps=500)
    assert halted
    assert got == (a + b) & T.MASK, "R%d = 0x%X want 0x%X" % (reg, got, a + b)


def run_elf_dirty(elf, reg, max_steps=500):
    """Like T.run_elf, but R0-R27 start as 0xFFFFFFFF, so a partial (.w0) write would leave the upper half set."""
    entry = struct.unpack_from("<I", elf, 24)[0]
    with T.elf_cosim._sim_namespace(T.SIMDIR):
        from simulator import Simulator  # type: ignore
        sim = Simulator(os.path.join(T.SIMDIR, "memory.cfg"))
        assert not sim.load_elf("pru0", elf)
        pru = sim.cores["pru0"]
        pru.pc = entry // 4
        for i in range(28):
            pru.registers.write_full(i, 0xFFFFFFFF)
        for _ in range(max_steps):
            sim.step("pru0", 1)
            if pru.halted:
                break
        return pru.halted, sim.registers("pru0")[reg]


@T.needs_tools
def test_elf_wide_constant_zero_extends_into_the_whole_register():
    """Full-register LDI must clear the upper 16 bits. Registers are preloaded with 1s so this cannot pass on a clean
    start: a width-2 (.w0) write would leave 0xFFFF in the upper half and the shift would return it."""
    text = T.HEADER + "\n".join([
        'const ca = load_constant_block.addInstance(); ca.$name = "CA"; ca.constant1 = 0xFFFF; ca.outputWidth = "4";',
        'const sh = load_constant_block.addInstance(); sh.$name = "SH"; sh.constant1 = 16; sh.outputWidth = "4";',
        'const r = bitwise_block.addInstance(); r.$name = "R"; r.opCode = "LSR"; r.output1Size = "4";',
        'scripting.connect(r, "input1", ca, "output1");',
        'scripting.connect(r, "input2", sh, "output1");',
        'scripting.connect(ca, "next", sh, "prev");',
        'scripting.connect(sh, "next", r, "prev");']) + "\n"
    elf, asm, reg = T.build_design(text, "R")
    da, _ = T.operands(asm, "CA")
    assert "." not in da, "CA must be a whole-register write, got " + da
    halted, got = run_elf_dirty(elf, reg)
    assert halted and got == 0, "R%d = 0x%X (upper half of CA must be 0)" % (reg, got)
