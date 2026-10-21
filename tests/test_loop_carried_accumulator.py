"""loop-carried accumulator (option 3, phase 1).

Repeat-add computes x*N by adding x to an accumulator N times in a counted
loop. At base c5f20509 the ADD reads the loop-invariant preInit register
(0) on every pass, so out_buf holds x instead of N*x,
and the result cannot be stored after the loop because rejects any
consumer outside the loop reading a block inside it.

Option 3 (docs/loop-carried-data.md, section 4.3) fixes this with:
  * loop_block.accumulators: an explicit {preInit, update} binding, so the
    allocator coalesces the ALU block's destination with its preInit
    register (ADD writes back in place, 0 extra cycles per iteration);
  * loop_block.exportedBlocks: blocks whose final-iteration output may be
    read from outside the loop (exemption), so the store sits AFTER
    the loop instead of inside it.

Design under test (built from tools/pru-llm-corpus/scripts/family_designs.py
b_repeat_add, with the write moved after the loop):

    mv_x (x_buf) --rd_x--> acc(ADD) --\
    k_acc(0, preInit) ---------------> acc   } Loop_0 x N   --> wr(out_buf)
    rd_x --next--> Loop_0 --next--> wr

Oracle: the VALUE in out_buf after the real clpru ELF runs on the TI
pru-simulator (never the asm text). Expected N*x mod 2^(8n).

Red at base: the design is rejected at validation (container
boundary error for acc -> wr, plus the unknown exportedBlocks /
accumulators fields), so the value assertion cannot pass.
Green after: out_buf == N*x for N=3 and N=10, x in (1, 7).
"""

import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import test_fanout_register_alias as T  # noqa: E402

elf_cosim = T.elf_cosim

HDR = (T.HEADER +
       'const memory_variable_block = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);\n'
       'const memory_access_block = scripting.addModule("/pru_blocks/utils/memory_access_block", {}, false);\n'
       'const flow_control_block = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);\n'
       'const loop_block = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);\n')

def design_repeat_add(nbytes, count):
    """Option-3 repeat-add: k_acc is preInit, acc is bound to it, wr is outside."""
    w = str(nbytes)
    L = [HDR,
         'const mv_x = memory_variable_block.addInstance(); mv_x.$name = "mv_x";',
         'mv_x.labelName = "x_buf"; mv_x.sizeInBytes = 4; mv_x.memoryLocation = "dmem";',
         'const mv_out = memory_variable_block.addInstance(); mv_out.$name = "mv_out";',
         'mv_out.labelName = "out_buf"; mv_out.sizeInBytes = 4; mv_out.memoryLocation = "dmem";',
         'const rd_x = memory_access_block.addInstance(); rd_x.$name = "rd_x";',
         'rd_x.operationMode = "read"; rd_x.memVar = mv_x; rd_x.offsetValue = 0; rd_x.dataSize = %s;' % w,
         'const k_acc = load_constant_block.addInstance(); k_acc.$name = "k_acc";',
         'k_acc.constant1 = 0; k_acc.outputWidth = "%s";' % w,
         'const acc = arithmetic_block.addInstance(); acc.$name = "acc";',
         'acc.opCode = "ADD"; acc.output1Size = "%s";' % w,
         'const wr = memory_access_block.addInstance(); wr.$name = "wr";',
         'wr.operationMode = "write"; wr.memVar = mv_out; wr.offsetValue = 0; wr.dataSize = %s;' % w,
         'const lp = loop_block.addInstance(); lp.$name = "Loop_0"; lp.loopCount = %d;' % count,
         'lp.$groupContents = [k_acc, acc];',
         'lp.preInitBlocks = ["k_acc"];',
         'lp.exportedBlocks = ["acc"];',
         'lp.accumulators = \'[{"preInit": "k_acc", "update": "acc"}]\';',
         'scripting.connect(acc, "input1", k_acc, "output1");',
         'scripting.connect(acc, "input2", rd_x, "output1");',
         'scripting.connect(wr, "input1", acc, "output1");',
         'scripting.connect(rd_x, "next", lp, "prev");',
         'scripting.connect(lp, "next", wr, "prev");']
    return "\n".join(L) + "\n"


def design_undeclared_export(nbytes=2, count=3):
    """Same shape but WITHOUT exportedBlocks/accumulators: must stay rejected (opt-in only)."""
    text = design_repeat_add(nbytes, count)
    lines = [l for l in text.splitlines()
             if "exportedBlocks" not in l and "accumulators" not in l]
    return "\n".join(lines) + "\n"


def design_second_preinit_reader():
    """A binding is invalid when another loop body block also reads preInit."""
    text = design_repeat_add(2, 3)
    text = text.replace(
        'const wr = memory_access_block.addInstance(); wr.$name = "wr";',
        'const chk = arithmetic_block.addInstance(); chk.$name = "chk";\n'
        'chk.opCode = "ADD"; chk.output1Size = "2";\n'
        'const wr = memory_access_block.addInstance(); wr.$name = "wr";')
    text = text.replace('lp.$groupContents = [k_acc, acc];', 'lp.$groupContents = [k_acc, acc, chk];')
    text = text.replace('scripting.connect(wr, "input1", acc, "output1");',
                        'scripting.connect(chk, "input1", k_acc, "output1");\n'
                        'scripting.connect(chk, "input2", rd_x, "output1");\n'
                        'scripting.connect(wr, "input1", acc, "output1");')
    return text


def design_size_mismatch():
    """A binding must use exactly the same output width as its preInit."""
    text = design_repeat_add(2, 3)
    return text.replace('acc.opCode = "ADD"; acc.output1Size = "2";',
                        'acc.opCode = "ADD"; acc.output1Size = "4";').replace(
                            'wr.operationMode = "write"; wr.memVar = mv_out; wr.offsetValue = 0; wr.dataSize = 2;',
                            'wr.operationMode = "write"; wr.memVar = mv_out; wr.offsetValue = 0; wr.dataSize = 4;')


def design_nonexported_preinit_consumer():
    """Exporting acc must not exempt unrelated k_acc from."""
    return design_repeat_add(2, 3).replace('scripting.connect(wr, "input1", acc, "output1");',
                                            'scripting.connect(wr, "input1", k_acc, "output1");')


def design_preloop_export_consumer():
    """An exported value is only valid after its loop in control flow."""
    return design_repeat_add(2, 3).replace(
        'scripting.connect(rd_x, "next", lp, "prev");\n'
        'scripting.connect(lp, "next", wr, "prev");',
        'scripting.connect(rd_x, "next", wr, "prev");\n'
        'scripting.connect(wr, "next", lp, "prev");')


def _udmem_addrs(asm, map_text):
    """Buffer addresses from build products: the .udmem section origin comes
    from the linker map, per-buffer offsets from the asm's .usect reservations
    in declaration order (linker allocates them sequentially). The buffers are
    not .global, so they never appear in the map's symbol tables."""
    m = re.search(r"^\s*\.udmem\s+\d+\s+([0-9A-Fa-f]+)\s+[0-9A-Fa-f]+", map_text, re.MULTILINE)
    assert m, ".udmem section missing from link map"
    base = int(m.group(1), 16)
    addrs, off = {}, 0
    for line in asm.splitlines():
        u = re.match(r"^(\S+)\s+\.usect\s+\"\.udmem\",\s*(\d+),\s*(\d+)", line)
        if u:
            name, size, align = u.group(1), int(u.group(2)), int(u.group(3))
            if align > 1:
                off = (off + align - 1) // align * align
            addrs[name] = base + off
            off += size
    return addrs


def _build(text):
    """SysConfig CLI -> clpru -> link with a map. Returns (elf_bytes, asm_text, buf_addrs)."""
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
        cgt = os.path.dirname(os.path.dirname(T.CLPRU))
        cflags = ["-v4", "-O2", "--include_path=" + os.path.join(cgt, "include"), "-DPRU0", "-DSLICE0", "-DSOC_AM243X"]
        cflags.append("--include_path=" + os.path.dirname(asm_path))
        T._run([T.CLPRU] + cflags + ["--output_file=main.obj", T.MAIN_ASM], work)
        T._run([T.CLPRU] + cflags + ["--output_file=pru_syscfg.obj", asm_path], work)
        T._run([T.CLPRU, "-v4", "-O2", "-z", "main.obj", "pru_syscfg.obj", T.LINKER_CMD,
                "--warn_sections", "--reread_libs", "--ram_model",
                "--entry_point=main", "--disable_auto_rts", "-o", "fw.out", "-m", "fw.map"], work)
        with open(os.path.join(work, "fw.out"), "rb") as f:
            elf = f.read()
        with open(os.path.join(work, "fw.map"), encoding="utf-8", errors="replace") as f:
            map_text = f.read()
        return elf, asm, _udmem_addrs(asm, map_text)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_repeat_add(nbytes, count, x, steps=6000):
    """Build the design, preload x_buf with x, run to halt, return (out_value, asm)."""
    elf, asm, addrs = _build(design_repeat_add(nbytes, count))
    assert "x_buf" in addrs and "out_buf" in addrs, "buffers missing from link map: %s" % sorted(addrs)
    entry = struct.unpack_from("<I", elf, 24)[0]
    with elf_cosim._sim_namespace(T.SIMDIR):
        from simulator import Simulator  # type: ignore
        sim = Simulator(os.path.join(T.SIMDIR, "memory.cfg"))
        assert not sim.load_elf("pru0", elf)
        sim.memory.write(addrs["x_buf"], x.to_bytes(nbytes, "little"))
        pru = sim.cores["pru0"]
        pru.pc = entry // 4
        halted = False
        for _ in range(steps):
            sim.step("pru0", 1)
            if pru.halted:
                halted = True
                break
        assert halted, "repeat-add firmware did not halt within %d steps" % steps
        out, _ = sim.memory.read(addrs["out_buf"], nbytes)
    return int.from_bytes(bytes(out), "little"), asm


def loop_body_instructions(asm):
    """Instruction lines between the LOOP line and its endloop label."""
    lines = asm.splitlines()
    start = next(i for i, l in enumerate(lines) if re.match(r"\s*LOOP\s+endloop_", l))
    end = next(i for i, l in enumerate(lines) if re.match(r"endloop_\d+:", l))
    body = []
    for l in lines[start + 1:end]:
        s = l.split(";")[0].strip()
        if s:
            body.append(s)
    return body


@T.needs_tools
@pytest.mark.parametrize("nbytes,count", [(2, 3), (4, 10)])
@pytest.mark.parametrize("x", [1, 7])
def test_repeat_add_returns_N_times_x(nbytes, count, x):
    got, asm = run_repeat_add(nbytes, count, x)
    want = (count * x) & ((1 << (8 * nbytes)) - 1)
    assert got == want, "repeat-add N=%d x=%d (n=%d): out_buf holds 0x%x, want 0x%x (N*x)" % (
        count, x, nbytes, got, want)


@T.needs_tools
def test_loop_body_is_a_single_in_place_add():
    """Phase-1 cost target: 0 cycles of per-iteration overhead (no MOV/LDI/SBBO in the body)."""
    _, asm = run_repeat_add(2, 3, 1)
    body = loop_body_instructions(asm)
    assert len(body) == 1 and body[0].startswith("ADD"), \
        "loop body must be exactly one in-place ADD, emitted: %s" % body


def test_export_without_declaration_is_still_rejected():
    """the exemption is opt-in: wr outside with no exportedBlocks must fail."""
    with pytest.raises(RuntimeError) as exc:
        _build(design_undeclared_export())
    msg = str(exc.value)
    assert "is outside container 'Loop_0'" in msg
    assert "attempts to read 'acc' which is inside it" in msg


def test_accumulator_binding_rejects_second_preinit_reader_loudly():
    with pytest.raises(RuntimeError) as exc:
        _build(design_second_preinit_reader())
    msg = str(exc.value)
    assert "Accumulator binding error" in msg
    assert "preInit value has another consumer" in msg
    assert "Out of registers" not in msg


def test_accumulator_binding_rejects_size_mismatch_loudly():
    with pytest.raises(RuntimeError) as exc:
        _build(design_size_mismatch())
    msg = str(exc.value)
    assert "Accumulator binding error" in msg
    assert "preInit register is 2 byte(s) but the update needs 4" in msg
    assert "Out of registers" not in msg


def test_exporting_acc_does_not_exempt_nonexported_preinit():
    with pytest.raises(RuntimeError) as exc:
        _build(design_nonexported_preinit_consumer())
    msg = str(exc.value)
    assert "attempts to read 'k_acc' which is inside it" in msg
    assert "is outside container 'Loop_0'" in msg


def test_exported_result_must_be_consumed_downstream_of_loop():
    with pytest.raises(RuntimeError) as exc:
        _build(design_preloop_export_consumer())
    msg = str(exc.value)
    assert "Invalid exported result" in msg
    assert "may only be consumed downstream" in msg
