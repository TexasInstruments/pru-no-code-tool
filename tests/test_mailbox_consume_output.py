"""a mailbox consume must deliver the slot value to its advertised output1.

the consume macro loads the ring
slot into the typed data register only (`lbco &R10, c24, ...`), while the block
declares output1 (hidden output1Size = 1, constant8 = dataRegister). A
downstream block wired to output1 reads the allocator's RES register, which the
macro never writes, so the add sees 0 instead of the slot value even when
head != tail.

Design under test: mailbox consume macro (RES=R0, DATA_REG=R10, dmem0 ring)
followed by a downstream `ADD R1, R0, R2` (R2 = 1). The ring is seeded in the
prelude (head = tail + 1, one slot holding SLOT), so a value must come out.
Assertions: the consume still writes DATA_REG (keeps read-index and
pinned-register behaviour) AND the advertised output1 register R0 AND
the downstream add result R1 == SLOT + 1.

Harness pattern is tests/test_ws2812_multi_led.py: real clpru ELF via
scripts/sim/elf_cosim.py stepped on the TI pru-simulator; the oracle is the
expected integer, never the asm text.
"""
import os
import re
import shutil
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402
import test_fanout_register_alias as T  # noqa: E402
import test_register_pool_exhaustion as P  # noqa: E402

try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_TOOLS = True
except RuntimeError:
    HAVE_TOOLS = False

needs_tools = pytest.mark.skipif(
    not HAVE_TOOLS, reason="clpru or pru-simulator missing")

MASK = 0xFFFFFFFF


class QuietPins:
    def tick(self, cycle, _pins):
        return 0


@needs_tools
@pytest.mark.parametrize("tail,slot", [(0, 0x12345678), (4, 0xA5C3F011)])
def test_consume_reaches_output1_and_downstream_add(tmp_path, tail, slot):
    head = tail + 1
    slot_off = 8 + tail * 4
    spec = dict(
        block="mailbox_block",
        subdir="pru_io_blocks",
        macroCall="m_mailbox_run",
        macroArgs=dict(
            RES="R0",
            BASE_OFF="0",
            RING_MASK="15",
            LOG2_SLOT="2",
            SLOT_BYTES="4",
            IS_SHARED="0",
            IS_PUBLISH="0",
            SIGNAL_EVENT="0",
            DATA_REG="R10",
        ),
        prelude=[
            "ldi32 R2, 1",
            f"ldi32 R10, {head}",
            "sbco &R10, c24, 0, 4",
            f"ldi32 R10, {tail}",
            "sbco &R10, c24, 4, 4",
            f"ldi32 R10, 0x{slot:08X}",
            f"sbco &R10, c24, {slot_off}, 4",
        ],
        postlude=[
            "ADD R1, R0, R2",
            "halt",
        ],
    )
    elf, _ = elf_cosim.build_block_firmware(spec, "mb_consume", str(tmp_path))
    result = elf_cosim.run_elf_closed_loop(elf, QuietPins(), max_steps=4000)
    assert result.halted, "Firmware did not halt within 4000 steps"
    regs = result.registers
    assert regs[10] == slot, (
        "consume must still write DATA_REG R10: got %#x, want %#x"
        % (regs[10], slot))
    assert regs[0] == slot, (
        "consume must write its advertised output1 register R0: got %#x, "
        "want slot %#x (head=%d tail=%d, so a value must come out)"
        % (regs[0], slot, head, tail))
    assert regs[1] == (slot + 1) & MASK, (
        "downstream ADD did not see the slot value: R1=%#x, want %#x"
        % (regs[1], (slot + 1) & MASK))


# This half deliberately uses a real .syscfg design instead of hand-calling the
# macro above: only the SysConfig allocator observes output1Size.
MAILBOX_MODULE = ('const mailbox_block = scripting.addModule('
                  '"/pru_blocks/pru_io_blocks/mailbox_block", {}, false);\n')
SPLITTER_MODULE = ('const data_splitter = scripting.addModule('
                   '"/pru_blocks/utils/data_splitter", {}, false);\n')

def wide_consume_design(slot_bytes):
    """Consume one wide slot, take its first word through a Data Splitter, add 1, and keep an addend live.

    An output wider than 4 bytes reaches a consumer as two register tokens (first, second), so a 32-bit
    block reads it through utils/data_splitter (lower 32 bits), as for any wide output.
    With an output1 starting at R0, the addend must start immediately after its
    reservation: R4 for 16 bytes and R8 for 32 bytes.  That allocation boundary
    shows independently that the metadata width reached the allocator.
    """
    return "".join([
        T.HEADER, MAILBOX_MODULE, SPLITTER_MODULE,
        'const mb = mailbox_block.addInstance();\n',
        'const k = load_constant_block.addInstance();\n',
        'const lo = data_splitter.addInstance();\n',
        'const add = arithmetic_block.addInstance();\n',
        'mb.$name = "Consume_Wide"; mb.mode = "consume"; mb.slots = 2; '
        'mb.slotBytes = %d; mb.memory = "dmem0"; mb.baseOffset = "0x0000"; mb.dataRegister = "R10";\n' % slot_bytes,
        'k.$name = "Addend_After_Output"; k.constant1 = 1;\n',
        'lo.$name = "Slot_Word0"; lo.splitSelect = "lower";\n',
        'add.$name = "Add_Slot_Word0"; add.opCode = "ADD"; add.output1Size = "4";\n',
        'scripting.connect(lo, "input1", mb, "output1");\n',
        'scripting.connect(add, "input1", lo, "output1");\n',
        'scripting.connect(add, "input2", k, "output1");\n',
        'scripting.connect(mb, "next", k, "prev");\n',
        'scripting.connect(k, "next", lo, "prev");\n',
        'scripting.connect(lo, "next", add, "prev");\n',
    ])


def _wide_product(tmp_path_factory, name, replacement):
    """Return a private product with exactly the requested mailbox metadata mutant."""
    root = tmp_path_factory.mktemp("case_" + name)
    shutil.copytree(ROOT / ".metadata", root / ".metadata")
    block = root / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "mailbox_block.syscfg.js"
    text = block.read_text(encoding="utf-8")
    old = 'getValue: (inst) => inst.mode === "consume" ? (Number(inst.slotBytes) || 4) : 1'
    assert text.count(old) == 1
    block.write_text(text.replace(old, replacement), encoding="utf-8")
    return str(root / ".metadata" / "product.json")


@pytest.fixture(scope="module")
def no_output_size_getvalue_product(tmp_path_factory):
    return _wide_product(tmp_path_factory, "no_output_size_getvalue", "default: 1")


@pytest.fixture(scope="module")
def output_size_hard_coded_to_four_product(tmp_path_factory):
    return _wide_product(tmp_path_factory, "output_size_hard_coded_to_four", "getValue: (inst) => 4")


def build_and_run_wide_consume(slot_bytes, product=None):
    """SysConfig generate -> clpru -> TI simulator; return generated asm and registers."""
    old_product = T.PRODUCT_JSON
    if product:
        T.PRODUCT_JSON = product
    try:
        rc, out, asm, work = P.generate(wide_consume_design(slot_bytes))
    finally:
        T.PRODUCT_JSON = old_product
    try:
        assert rc == 0 and asm, out[-1800:]
        # An output wider than 4 bytes is passed as two register tokens, so the call is the _wide variant.
        call = re.search(r"^\s*m_mailbox_run_wide\s+(R\d+(?:\.[bw]\d)?)\s*,", asm, re.M)
        assert call, "Consume_Wide mailbox call missing from generated code"
        # The output itself begins at R0 and consumes whole contiguous registers;
        # the independent constant is the first allocation after that window.
        assert call.group(1) == "R0", "wide output must be allocated as a whole-register window, got %s" % call.group(1)
        # The addend is a 1-byte constant, so the allocator names it R<n>.b0; the boundary is the register number.
        addend_reg = T.operands(asm, "Addend_After_Output")[0].split(".")[0]
        assert addend_reg == "R%d" % (slot_bytes // 4), (
            "output1Size=%d must reserve R0..R%d; addend got %s"
            % (slot_bytes, slot_bytes // 4 - 1, addend_reg))
        result_reg = T.operands(asm, "Add_Slot_Word0")[0]
        elf = T._link(work, T.MAIN_ASM, os.path.join(work, "syscfg", "pru_syscfg.asm"))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    words = [0x14131211 + i * 0x04040404 for i in range(slot_bytes // 4)]
    entry = struct.unpack_from("<I", elf, 24)[0]
    with elf_cosim._sim_namespace(T.SIMDIR):
        from simulator import Simulator  # type: ignore
        sim = Simulator(os.path.join(T.SIMDIR, "memory.cfg"))
        assert not sim.load_elf("pru0", elf)
        pru = sim.cores["pru0"]
        pru.pc = entry // 4
        sim.memory.write(0, struct.pack("<II", 1, 0) + struct.pack("<%dI" % len(words), *words))
        for _ in range(6000):
            sim.step("pru0", 1)
            if pru.halted:
                break
        regs = [sim.registers("pru0")[i] & MASK for i in range(28)]
    assert pru.halted, "wide consume firmware did not halt"
    result = regs[int(result_reg[1:])]
    assert result == (words[0] + 1) & MASK, (
        "downstream ADD read %#x, want slot word %#x + 1" % (result, words[0]))
    # ADD overwrites its R0 input in place; the remaining words prove lbco wrote
    # the rest of the slot into the allocator-reserved output window.
    assert regs[1:len(words)] == words[1:], [hex(x) for x in regs[:len(words)]]
    return asm, regs


@T.needs_tools
@pytest.mark.parametrize("slot_bytes", [16, 32])
def test_real_syscfg_wide_output_reserves_slot_and_feeds_downstream(slot_bytes):
    build_and_run_wide_consume(slot_bytes)


@T.needs_tools
@pytest.mark.parametrize("product_fixture", ["no_output_size_getvalue_product", "output_size_hard_coded_to_four_product"])
def test_mutants_that_shrink_wide_output1_are_red(request, product_fixture):
    """Both metadata regressions fail before simulation.

    With output1Size shrunk, output1 is a 32-bit port again, so the design cannot connect it to the
    Data Splitter's 64-bit input; if it could, the allocation-boundary oracle would fail.
    """
    product = request.getfixturevalue(product_fixture)
    with pytest.raises(AssertionError, match=r"wide output|output1Size|Cannot connect input64 ports to output32"):
        build_and_run_wide_consume(16, product)
