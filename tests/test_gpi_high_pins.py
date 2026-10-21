"""pru_gpi must read every R31 pin, not just pins 0-7.

the block emits ``AND <out>, R31, 1 << pin``. The PRU ALU
immediate holds 0-255, so any pin >= 8 does not assemble
(``[E0003] Invalid instruction``) and 12 of the 20 R31 pins are unusable
as block inputs.

Evidence is the block's own SysConfig generation assembled with the real
clpru and run on TI pru-simulator: for pins 0, 7, 8, 13 and 19 the
generated firmware must assemble, and with R31 bit N set the block's
output register must read exactly (1 << N), with it clear exactly 0
(neighbour pins undisturbed).
"""
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import test_fanout_register_alias as T  # noqa: E402

sys.path.insert(0, os.path.join(T.REPO_ROOT, "scripts", "sim"))
import elf_cosim  # noqa: E402
import re

# PRODUCT_JSON exists only for sandboxed runs whose OS user cannot list
# the ancestors of the checkout (SysConfig 1.28 walks up from the product
# path and dies on EPERM). Default is the in-tree product, exactly as elsewhere.
PRODUCT_JSON = os.environ.get("PRODUCT_JSON", T.PRODUCT_JSON)

PINS = (0, 7, 8, 13, 19)

GPI_HEADER = ('/**\n * @cliArgs --device "AM243x_ALX_beta" --part "ALX" --package "ALX" --context "icss_g0_pru0"'
              ' --product "PRU_NO_CODE_TOOL@01.00.01"\n */\n'
              'const pru_blocks_static_module = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");\n'
              'const pru_gpi_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpi_block", {}, false);\n')


def design_syscfg():
    """One GPI block per pin under test, chained in execution order."""
    L = [GPI_HEADER]
    for pin in PINS:
        L.append('const g%d = pru_gpi_block.addInstance(); g%d.$name = "GPI_%d"; '
                 'g%d.constant1 = "R31, 1 << %d";' % (pin, pin, pin, pin, pin))
    seq = ["g%d" % p for p in PINS]
    L += ['scripting.connect(%s, "next", %s, "prev");' % (a, b) for a, b in zip(seq, seq[1:])]
    return "\n".join(L) + "\n"


def block_lines(asm, block):
    """Emitted instruction lines for one block (the comment names the block)."""
    m = re.search(r";PRU Instruction of %s\s*\n((?:(?!\s*;).*\n)+)" % re.escape(block), asm)
    assert m, "no instruction for %s in generated asm" % block
    return [ln.strip() for ln in m.group(1).splitlines()
            if ln.strip() and not ln.strip().endswith(":")]


def output_reg(asm, block):
    """Register number holding the block's result: destination of its last line."""
    dest = block_lines(asm, block)[-1].split(",")[0].split()[-1]
    m = re.match(r"R(\d+)", dest)
    assert m, "cannot read destination register from %r" % dest
    return int(m.group(1))


def _plain(p):
    """Strip the extended-length prefix the sandbox puts on cwd-derived paths.

    clpru (E1000) cannot open such paths; node-based tools tolerate them.
    A no-op where the prefix is absent, so behaviour elsewhere is unchanged.
    """
    return p[4:] if p.startswith("\\\\?\\") else p


def _link(work, main_asm, syscfg_asm):
    """Assemble + link exactly like T._link, but with clpru-readable paths."""
    cgt = os.path.dirname(os.path.dirname(T.CLPRU))
    cflags = ["-v4", "-O2", "--include_path=" + os.path.join(cgt, "include"),
              "-DPRU0", "-DSLICE0", "-DSOC_AM243X"]
    if syscfg_asm:
        cflags.append("--include_path=" + os.path.dirname(syscfg_asm))
    T._run([T.CLPRU] + cflags + ["--output_file=main.obj", _plain(main_asm)], work)
    objs = ["main.obj"]
    if syscfg_asm:
        T._run([T.CLPRU] + cflags + ["--output_file=pru_syscfg.obj", _plain(syscfg_asm)], work)
        objs.append("pru_syscfg.obj")
    T._run([T.CLPRU, "-v4", "-O2", "-z"] + objs + [_plain(T.LINKER_CMD), "--warn_sections", "--reread_libs",
                                                  "--ram_model", "--entry_point=main", "--disable_auto_rts",
                                                  "-o", "fw.out"], work)
    with open(os.path.join(work, "fw.out"), "rb") as f:
        return f.read()


_BUILT = {}


def built(tmp_path):
    """SysConfig CLI -> clpru -> link, once per session. Returns (elf_path, asm)."""
    if "elf" not in _BUILT:
        work = tempfile.mkdtemp(prefix="case_")
        with open(os.path.join(work, "design.syscfg"), "w", encoding="utf-8") as f:
            f.write(design_syscfg())
        res = subprocess.run(
            [T.SYSCFG_NODE, T.SYSCFG_CLI, "--product", PRODUCT_JSON, "--device", "AM243x_ALX_beta",
             "--context", "icss_g0_pru0", "--part", "ALX", "--package", "ALX",
             "--output", "syscfg", "design.syscfg"],
            cwd=work, capture_output=True, text=True, timeout=600)
        assert res.returncode == 0, "SysConfig generation failed:\n%s\n%s" % (res.stdout, res.stderr)
        asm_path = os.path.join(work, "syscfg", "pru_syscfg.asm")
        with open(asm_path, encoding="utf-8") as f:
            _BUILT["asm"] = f.read()
        try:
            try:
                elf = _link(work, T.MAIN_ASM, asm_path)
            except RuntimeError as e:
                pytest.fail("clpru must assemble the GPI design for pins %s -\n%s" % (PINS, e))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        elf_path = os.path.join(str(tmp_path), "gpi_pins.out")
        with open(elf_path, "wb") as f:
            f.write(elf)
        _BUILT["elf"] = elf_path
    return _BUILT["elf"], _BUILT["asm"]


class FixedGpi:
    """DeviceModel holding R31 at one fixed word for the whole run."""

    def __init__(self, word):
        self.word = word

    def tick(self, _cycle, _pins):
        return self.word


def read_regs(elf_path, gpi_word, regs, dirty=True):
    """Run the ELF with R31 fixed. ``dirty`` preloads the result registers with
    0xFFFFFFFF before the first step, as a reused register would be on silicon:
    the block must clear its whole destination itself (a zero-initialised
    simulator register would hide a missing or partial clear)."""
    def preload(cycle, _gpo, _gpi, sim):
        if cycle == 0:
            for r in regs:
                sim.cores["pru0"].registers.regs[r] = 0xFFFFFFFF

    result = elf_cosim.run_elf_closed_loop(elf_path, FixedGpi(gpi_word), max_steps=2000,
                                           on_step=preload if dirty else None)
    assert result.halted, "GPI firmware did not halt (R31 = 0x%05X)" % gpi_word
    return {r: result.registers[r] & 0xFFFFFFFF for r in regs}


@T.needs_tools
def test_all_five_pins_assemble(tmp_path):
    """SysConfig generation plus clpru assembly must succeed for pins 0, 7, 8, 13 and 19."""
    elf_path, asm = built(tmp_path)
    for pin in PINS:
        assert block_lines(asm, "GPI_%d" % pin), "GPI_%d emitted nothing" % pin


@T.needs_tools
def test_each_pin_reads_its_r31_bit(tmp_path):
    """Only the driven bit appears, at full mask value, in that pin's register."""
    elf_path, asm = built(tmp_path)
    regs = {pin: output_reg(asm, "GPI_%d" % pin) for pin in PINS}
    assert read_regs(elf_path, 0x00000, set(regs.values())) == {r: 0 for r in regs.values()}
    for pin in PINS:
        got = read_regs(elf_path, 1 << pin, set(regs.values()))
        for other in PINS:
            want = (1 << pin) if other == pin else 0
            assert got[regs[other]] == want, (
                "R31 = 0x%05X: GPI_%d (R%d) reads 0x%08X, want 0x%08X"
                % (1 << pin, other, regs[other], got[regs[other]], want))


@T.needs_tools
def test_cycle_count_is_documented_and_modelled(tmp_path):
    """Emitted instructions per block, the peak-cycles model and the docs must agree."""
    _elf_path, asm = built(tmp_path)
    for pin in PINS:
        assert len(block_lines(asm, "GPI_%d" % pin)) == 3, \
            "GPI_%d must emit 3 single-cycle instructions, got: %s" % (pin, block_lines(asm, "GPI_%d" % pin))
    m = re.search(r"; OVERALL PEAK CYCLES: (\d+) cycles", asm)
    assert m and int(m.group(1)) == 3 * len(PINS) + 1, \
        "peak-cycles model must charge 3 cycles per GPI block (plus 1 for halt):\n%s" % asm[:2000]
    src = open(os.path.join(T.REPO_ROOT, ".metadata", "sysconfig", ".meta",
                            "pru_blocks", "pru_io_blocks", "pru_gpi_block.syscfg.js"),
               encoding="utf-8").read()
    src = re.sub(r"\s+", " ", src)
    assert "3 PRU cycles" in src, "block description must document the 3-cycle read"
    assert "1 PRU cycle" not in src, "stale single-cycle claim left in the block description"
