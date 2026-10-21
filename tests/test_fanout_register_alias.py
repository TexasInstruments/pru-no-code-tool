"""the register allocator must not free a value that still has a data consumer.

A 5-stage gray-to-binary cascade (g ^= g >> 1, 2, 4, 8, 16) built from Bitwise blocks "combined the value with
itself". Generated asm before the allocator fix:

    LDI32 R0, 1515870810        ; G0
    LSR   R0, R0 , R1.b0        ; Shr_1  - destination R0 == G0, G0 is gone
    XOR   R3, R0 , R0           ; Xor_1  - both operands are now (G0 >> 1): result is always 0

Cause (pru_register_allocator.js pushInstruction): output1ArrayLength is meant to be the number of DATA consumers
of a block, and the register is released when it reaches 0, but pushInstruction decremented it on EVERY visit,
including the walk back along the control-flow `prev` chain. G0 was visited once via Shift_1.prev (not a
consumer), so its count reached 0 when its FIRST data consumer (Shr_1) was processed and the register was released
before Shr_1's own destination was allocated - Shr_1 got R0 and Xor_1 then read the clobbered value. It stays latent
whenever the freed bytes are too small / not adjacent for the consumer's destination, which is why a 2-byte constant
feeding a 4-byte shift did not show it.

Fix: a release additionally requires dataConsumersRemaining == 0 (exact count of unread data connections), so the
allocator can only release LESS than before. The same over-decrement also makes single-consumer chains leak
registers (count goes negative); tests of single-consumer chains sample each value at the macro that produced it,
so they do not depend on dead values never being reused, and those chains release correctly.

The tests step the real clpru ELF on TI pru-simulator against an independent Python oracle. The harness is
itself shown able to see the bug (test_harness_detects_aliased_asm): hand-written aliased asm gives 0.
Tests skip cleanly when clpru, the SysConfig 1.28 CLI or the pru-simulator checkout is missing.
"""

import concurrent.futures
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "scripts", "sim"))

import elf_cosim  # noqa: E402

FW = os.path.join(REPO_ROOT, "examples", "ssi_encoder_sim", "firmware")
MAIN_ASM = os.path.join(FW, "main.asm")
LINKER_CMD = os.path.join(REPO_ROOT, "examples", "gray_encoder_4_bit", "firmware", "am243x-lp",
                          "icss_g0_pru0_fw", "ti-pru-cgt", "linker.cmd")
PRODUCT_JSON = os.path.join(REPO_ROOT, ".metadata", "product.json")

SYSCFG_DIR = os.environ.get("SYSCFG_PATH", "C:/ti/sysconfig_1.28.0")
SYSCFG_NODE = os.path.join(SYSCFG_DIR, "nodejs", "node.exe" if os.name == "nt" else "node")
if not os.path.exists(SYSCFG_NODE):
    SYSCFG_NODE = os.path.join(SYSCFG_DIR, "nodejs", "node")
SYSCFG_CLI = os.path.join(SYSCFG_DIR, "dist", "cli.js")

try:
    CLPRU = elf_cosim.find_clpru()
    SIMDIR = elf_cosim.find_pru_simulator()
    HAVE_TOOLS = os.path.exists(SYSCFG_CLI) and os.path.exists(SYSCFG_NODE)
except RuntimeError:
    HAVE_TOOLS = False
# The ELF arms link against the ssi_encoder_sim main.asm and the gray_encoder_4_bit linker command file.
HAVE_EXAMPLES = os.path.exists(MAIN_ASM) and os.path.exists(LINKER_CMD)
HAVE_TOOLS = HAVE_TOOLS and HAVE_EXAMPLES

needs_tools = pytest.mark.skipif(
    not HAVE_TOOLS, reason="clpru, SysConfig 1.28 CLI, pru-simulator or the ssi_encoder_sim / gray_encoder_4_bit example sources missing")

MASK = 0xFFFFFFFF
VALUE = 0x5A5A5A5A
SHIFTS = (1, 2, 4, 8, 16)

HEADER = ('/**\n * @cliArgs --device "AM243x_ALX_beta" --part "ALX" --package "ALX" --context "icss_g0_pru0"'
          ' --product "PRU_NO_CODE_TOOL@01.00.01"\n */\n'
          'const pru_blocks_static_module = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");\n'
          'const bitwise_block = scripting.addModule("/pru_blocks/data_handling/bitwise_block", {}, false);\n'
          'const arithmetic_block = scripting.addModule("/pru_blocks/data_handling/arithmetic_block", {}, false);\n'
          'const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);\n')


# ---------------------------------------------------------------- independent oracles
def gray_decode(g, shifts=SHIFTS):
    """Gray -> binary by the textbook cascade; no code shared with the design under test."""
    for s in shifts:
        g ^= g >> s
    return g & MASK


def gray_decode_by_prefix_xor(g):
    """Second, structurally different oracle: binary bit i = XOR of gray bits i..31."""
    out, acc = 0, 0
    for bit in range(31, -1, -1):
        acc ^= (g >> bit) & 1
        out |= acc << bit
    return out


OPS = {  # name -> (module, SysConfig opCode, python reference of op(G, G >> 1))
    "XOR": ("bitwise_block", "XOR", lambda g, s: g ^ s),
    "AND": ("bitwise_block", "AND", lambda g, s: g & s),
    "OR": ("bitwise_block", "OR", lambda g, s: g | s),
    "ADD": ("arithmetic_block", "ADD", lambda g, s: (g + s) & MASK),
    "SUB": ("arithmetic_block", "SUB", lambda g, s: (g - s) & MASK),
}


# ---------------------------------------------------------------------- designs
def cascade_syscfg(value=VALUE, shifts=SHIFTS):
    """The cascade design with NO memory copies: stage k = G_k = G_{k-1} ^ (G_{k-1} >> s_k)."""
    n = len(shifts)
    L = [HEADER, "const g0 = load_constant_block.addInstance();"]
    for i in range(n):
        L += ["const sh%d = load_constant_block.addInstance();" % i,
              "const shr%d = bitwise_block.addInstance();" % i,
              "const xor%d = bitwise_block.addInstance();" % i]
    L.append('g0.constant1 = %d; g0.$name = "G0";' % value)
    for i, s in enumerate(shifts):
        L += ['sh%d.constant1 = %d; sh%d.$name = "Shift_%d";' % (i, s, i, s),
              'shr%d.opCode = "LSR"; shr%d.output1Size = "4"; shr%d.$name = "Shr_%d";' % (i, i, i, s),
              'xor%d.opCode = "XOR"; xor%d.output1Size = "4"; xor%d.$name = "Xor_%d";' % (i, i, i, s)]
    prev = "g0"
    for i in range(n):
        L += ['scripting.connect(shr%d, "input1", %s, "output1");' % (i, prev),
              'scripting.connect(shr%d, "input2", sh%d, "output1");' % (i, i),
              'scripting.connect(xor%d, "input1", %s, "output1");' % (i, prev),
              'scripting.connect(xor%d, "input2", shr%d, "output1");' % (i, i)]
        prev = "xor%d" % i
    seq = ["g0"] + ["sh%d" % i for i in range(n)]
    for i in range(n):
        seq += ["shr%d" % i, "xor%d" % i]
    L += ['scripting.connect(%s, "next", %s, "prev");' % (a, b) for a, b in zip(seq, seq[1:])]
    return "\n".join(L) + "\n", "Xor_%d" % shifts[-1]


def fanout_syscfg(op, value=VALUE):
    """G feeds a shift (G >> 1) and also the second block directly: out = op(G, G >> 1)."""
    module, opcode, _ = OPS[op]
    size = 'output1Size = "4"'
    return ("".join([
        HEADER,
        "const g0 = load_constant_block.addInstance();\n",
        "const sh = load_constant_block.addInstance();\n",
        "const shr = bitwise_block.addInstance();\n",
        "const comb = %s.addInstance();\n" % module,
        'g0.constant1 = %d; g0.$name = "G0";\n' % value,
        'sh.constant1 = 1; sh.$name = "Shift_1";\n',
        'shr.opCode = "LSR"; shr.%s; shr.$name = "Shr_1";\n' % size,
        'comb.opCode = "%s"; comb.%s; comb.$name = "Combine";\n' % (opcode, size),
        'scripting.connect(shr, "input1", g0, "output1");\n',
        'scripting.connect(shr, "input2", sh, "output1");\n',
        'scripting.connect(comb, "input1", g0, "output1");\n',
        'scripting.connect(comb, "input2", shr, "output1");\n',
        'scripting.connect(g0, "next", sh, "prev");\n',
        'scripting.connect(sh, "next", shr, "prev");\n',
        'scripting.connect(shr, "next", comb, "prev");\n',
    ]), "Combine")


def triple_use_syscfg(value=VALUE):
    """G is read by THREE blocks: out = (G ^ (G >> 1)) + G. The last read must still see G."""
    return ("".join([
        HEADER,
        "const g0 = load_constant_block.addInstance();\n",
        "const sh = load_constant_block.addInstance();\n",
        "const shr = bitwise_block.addInstance();\n",
        "const x = bitwise_block.addInstance();\n",
        "const add = arithmetic_block.addInstance();\n",
        'g0.constant1 = %d; g0.$name = "G0";\n' % value,
        'sh.constant1 = 1; sh.$name = "Shift_1";\n',
        'shr.opCode = "LSR"; shr.output1Size = "4"; shr.$name = "Shr_1";\n',
        'x.opCode = "XOR"; x.output1Size = "4"; x.$name = "Xor_1";\n',
        'add.opCode = "ADD"; add.output1Size = "4"; add.$name = "Add_G";\n',
        'scripting.connect(shr, "input1", g0, "output1");\n',
        'scripting.connect(shr, "input2", sh, "output1");\n',
        'scripting.connect(x, "input1", g0, "output1");\n',
        'scripting.connect(x, "input2", shr, "output1");\n',
        'scripting.connect(add, "input1", x, "output1");\n',
        'scripting.connect(add, "input2", g0, "output1");\n',
        'scripting.connect(g0, "next", sh, "prev");\n',
        'scripting.connect(sh, "next", shr, "prev");\n',
        'scripting.connect(shr, "next", x, "prev");\n',
        'scripting.connect(x, "next", add, "prev");\n',
    ]), "Add_G")


# ------------------------------------------------------------------------ build
def _run(cmd, cwd):
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError("command failed (rc=%d): %s\n%s\n%s" % (res.returncode, cmd, res.stdout, res.stderr))
    return res


def _link(work, main_asm, syscfg_asm):
    cgt = os.path.dirname(os.path.dirname(CLPRU))
    cflags = ["-v4", "-O2", "--include_path=" + os.path.join(cgt, "include"), "-DPRU0", "-DSLICE0", "-DSOC_AM243X"]
    if syscfg_asm:
        cflags.append("--include_path=" + os.path.dirname(syscfg_asm))
    _run([CLPRU] + cflags + ["--output_file=main.obj", main_asm], work)
    objs = ["main.obj"]
    if syscfg_asm:
        _run([CLPRU] + cflags + ["--output_file=pru_syscfg.obj", syscfg_asm], work)
        objs.append("pru_syscfg.obj")
    _run([CLPRU, "-v4", "-O2", "-z"] + objs + [LINKER_CMD, "--warn_sections", "--reread_libs", "--ram_model",
                                                "--entry_point=main", "--disable_auto_rts", "-o", "fw.out"], work)
    with open(os.path.join(work, "fw.out"), "rb") as f:
        return f.read()


def build_design(text, result_block):
    """SysConfig CLI -> clpru -> link. Returns (elf, asm_text, result_register_number)."""
    work = tempfile.mkdtemp(prefix="case_")
    try:
        with open(os.path.join(work, "design.syscfg"), "w", encoding="utf-8") as f:
            f.write(text)
        _run([SYSCFG_NODE, SYSCFG_CLI, "--product", PRODUCT_JSON, "--device", "AM243x_ALX_beta",
              "--context", "icss_g0_pru0", "--part", "ALX", "--package", "ALX",
              "--output", "syscfg", "design.syscfg"], work)
        asm_path = os.path.join(work, "syscfg", "pru_syscfg.asm")
        with open(asm_path, encoding="utf-8") as f:
            asm = f.read()
        m = re.search(r";PRU Instruction of %s\s*\n\s*\w+\s+R(\d+)\b" % re.escape(result_block), asm)
        assert m, "no instruction for %s in generated asm" % result_block
        return _link(work, MAIN_ASM, asm_path), asm, int(m.group(1))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_elf(elf, reg, max_steps=2000):
    """Step the real ELF on TI pru-simulator; return (halted, R<reg>)."""
    entry = struct.unpack_from("<I", elf, 24)[0]
    with elf_cosim._sim_namespace(SIMDIR):
        from simulator import Simulator  # type: ignore
        sim = Simulator(os.path.join(SIMDIR, "memory.cfg"))
        errors = sim.load_elf("pru0", elf)
        assert not errors, errors
        pru = sim.cores["pru0"]
        pru.pc = entry // 4
        for _ in range(max_steps):
            sim.step("pru0", 1)
            if pru.halted:
                break
        return pru.halted, sim.registers("pru0")[reg]


def operands(asm, block):
    """(dest, [source operands]) of the instruction a block emitted, from the generated asm."""
    m = re.search(r";PRU Instruction of %s\s*\n\s*(\w+)\s+([^\n]+)" % re.escape(block), asm)
    assert m, block
    parts = [p.strip() for p in m.group(2).split(",")]
    return parts[0], parts[1:]


_CACHE = {}


def cached(key, make):
    if key not in _CACHE:
        _CACHE[key] = build_design(*make())
    return _CACHE[key]


# ------------------------------------------------------------------------ tests
def test_oracles_agree_with_each_other():
    """Two structurally different oracles for the gray decode (no tools needed)."""
    for g in (0, 1, VALUE, MASK, 0x80000000, 0x12345678):
        assert gray_decode(g) == gray_decode_by_prefix_xor(g)
    assert gray_decode(VALUE) != 0, "the test value must not decode to 0, or an all-zero result would pass"


@needs_tools
def test_gray_cascade_runs_correctly_without_memory_copies():
    """The 5-stage cascade wired directly, with NO Memory Access copies."""
    elf, asm, reg = cached("cascade", lambda: cascade_syscfg())
    halted, got = run_elf(elf, reg)
    assert halted
    assert got == gray_decode(VALUE) == gray_decode_by_prefix_xor(VALUE), \
        "R%d = 0x%08X, want 0x%08X" % (reg, got, gray_decode(VALUE))


@needs_tools
def test_no_stage_xors_a_value_with_itself():
    """Static form of the bug: an XOR/AND/OR/SUB whose two source operands are the same register."""
    _elf, asm, _reg = cached("cascade", lambda: cascade_syscfg())
    for i, s in enumerate(SHIFTS):
        dest, srcs = operands(asm, "Xor_%d" % s)
        assert srcs[0] != srcs[1], "Xor_%d reads %s twice (dest %s)" % (s, srcs[0], dest)
        sdest, ssrcs = operands(asm, "Shr_%d" % s)
        assert sdest != srcs[0], "Shr_%d destination %s clobbers Xor_%d's input1" % (s, sdest, s)


@needs_tools
@pytest.mark.parametrize("op", sorted(OPS))
def test_value_feeding_shift_and_second_block_survives(op):
    """One 32-bit value feeds a LSR and a second two-input block; the second must still read the original."""
    elf, asm, reg = cached(("fan", op), lambda: fanout_syscfg(op))
    halted, got = run_elf(elf, reg)
    want = OPS[op][2](VALUE, VALUE >> 1)
    assert halted
    assert got == want, "%s: R%d = 0x%08X, want 0x%08X" % (op, reg, got, want)
    assert want not in (0, VALUE), "oracle value must differ from the aliased result"


@needs_tools
def test_value_with_three_consumers_survives_to_the_last_read():
    """G is read three times (LSR, XOR, ADD); the register may only be released after the third."""
    elf, asm, reg = cached("triple", lambda: triple_use_syscfg())
    halted, got = run_elf(elf, reg)
    want = ((VALUE ^ (VALUE >> 1)) + VALUE) & MASK
    assert halted
    assert got == want, "R%d = 0x%08X, want 0x%08X" % (reg, got, want)


@needs_tools
def test_harness_detects_aliased_asm():
    """Red arm for the HARNESS: the exact defective instruction pair, hand-assembled, gives 0 not G ^ (G>>1)."""
    work = tempfile.mkdtemp(prefix="red_")
    try:
        src = ("    .global main\n    .sect \".text:main\"\nmain:\n"
               "    LDI32 R0, %d\n    LDI R1.b0, 1\n"
               "    LSR R0, R0 , R1.b0\n    XOR R3, R0 , R0\n    halt\n" % VALUE)
        path = os.path.join(work, "main.asm")
        with open(path, "w") as f:
            f.write(src)
        elf = _link(work, path, None)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    halted, got = run_elf(elf, 3)
    assert halted
    assert got == 0, "aliased asm must XOR a value with itself and give 0, got 0x%08X" % got
    assert got != VALUE ^ (VALUE >> 1)
