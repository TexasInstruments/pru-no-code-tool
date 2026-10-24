"""the CTPPR0 write is emitted after every GROUP `_start:` label too.

pru_syscfg.asm.xdt emits the CTPPR0 = 0x0100 write after sysconfig_generated_start
AND after each group `<name>_start:` label (main.asm may CALL a group directly and
never pass through sysconfig_generated_start). The other tests only reach
the first entry point; without this test, deleting the group emission would leave
every other test green.

Fixture: examples/gray_encoder_4_bit with a shared-memory *publish* mailbox added
inside its group, and a main.asm that CALLs gray_encoder_start directly (so
sysconfig_generated_start is never executed and only the group write can program
c28). The mailbox publishes one word through c28; it must land in shared RAM
(PRU-local 0x10000) and not in the core's own DMEM at 0x0.

CTPPR0 citation: c28 = 00nn_nn00h, nnnn = CTPPR0.C28_POINTER (SPRUIM2J Table 6-65).
The AM261x (ICSSM) CTPPR0 offset 0x28 / reset 0 is INFERRED from the shared PRU-ICSS
IP; SPRUJB6 does not document the register.
"""
import os
import re
import shutil
import struct
import subprocess
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, "scripts", "sim"))

import elf_cosim  # noqa: E402

EXAMPLE_DIR = os.path.join(REPO_ROOT, "examples", "gray_encoder_4_bit")
CORE_SUBDIR = os.path.join("firmware", "am243x-lp", "icss_g0_pru0_fw")
ELF_NAME = "generated/gray_encoder_4_bit_am243x-lp_icss_g0_pru0_fw.out"

GMAKE = shutil.which("gmake") or "C:/ti/ccs2100/ccs/utils/bin/gmake.exe"
try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_SIM = True
except RuntimeError:
    HAVE_SIM = False
HAVE_BUILD = os.path.exists(GMAKE) and os.path.exists(os.path.join(REPO_ROOT, "imports.mak"))
needs_toolchain = pytest.mark.skipif(
    not (HAVE_SIM and HAVE_BUILD),
    reason="needs clpru, TI pru-simulator (PRU_SIMULATOR_PATH), gmake and a repo-root imports.mak")

PAYLOAD = 0xA5A5F00D
PAYLOAD_REG = "R20"
DMEM_WORDS = 512                 # 2 KB of own DMEM searched for the payload
SLOT0 = 8                        # publish: head 0 -> BASE_OFF + 8 (mailbox_block)

MAIN_BODY = """main:
    zero    &r0, 120
    ldi32   %s, 0x%08X
    CALL    gray_encoder_start      ; enters the group directly, not via sysconfig_generated_start
    halt
""" % (PAYLOAD_REG, PAYLOAD)

# The 3-instruction write must follow the label with only comments in between.
GROUP_ENTRY = re.compile(
    r"gray_encoder_start:[ \t]*\r?\n(?:[ \t]*;[^\n]*\n)*"
    r"[ \t]*ldi[ \t]+TEMP_REG1,[ \t]*0x100[ \t]*\r?\n"
    r"[ \t]*ldi32[ \t]+TEMP_REG2,[ \t]*0x22028[ \t]*\r?\n"
    r"[ \t]*sbbo[ \t]+&TEMP_REG1,[ \t]*TEMP_REG2,[ \t]*0,[ \t]*4")
# The template's comment starts "; c28 = CTPPR0..." (case is not significant).
CT_SETUP = re.compile(r"[ \t]*; C28 = CTPPR0.*?sbbo[^\n]*\n", re.S | re.I)


def _group_with_mailbox(text):
    def sub(pat, repl, flags=0):
        out, n = re.subn(pat, lambda m: repl(m), text_holder[0], count=1, flags=flags)
        assert n == 1, "example.syscfg no longer matches %r" % pat
        text_holder[0] = out
    text_holder = [text]
    sub(r"(const access_look_up_table1 = [^\n]*\n)", lambda m: m.group(1) +
        'const mailbox_block  = scripting.addModule("/pru_blocks/pru_io_blocks/mailbox_block", {}, false);\n'
        "const mailbox_block1 = mailbox_block.addInstance();\n")
    sub(r"(group_block1\.\$name )", lambda m:
        'mailbox_block1.$name        = "shared_mailbox";\n'
        'mailbox_block1.mode         = "publish";\n'
        'mailbox_block1.memory       = "shared";\n'
        'mailbox_block1.baseOffset   = "0x0000";\n'
        "mailbox_block1.slots        = 2;\n"
        "mailbox_block1.slotBytes    = 4;\n"
        'mailbox_block1.dataRegister = "%s";\n\n' % PAYLOAD_REG + m.group(1))
    sub(r"group_block1\.\$groupContents = \[[^\]]*\];", lambda m:
        "group_block1.$groupContents = [load_constant_block1, access_look_up_table1, mailbox_block1];")
    sub(r'(scripting\.connect\(load_constant_block1, "next", access_look_up_table1, "prev"\);)',
        lambda m: m.group(1) +
        '\nscripting.connect(access_look_up_table1, "next", mailbox_block1, "prev");')
    return text_holder[0]


def build_group_design(root, name):
    """Copy the example, add the mailbox to the group, replace main.asm, build."""
    dst = os.path.join(str(root), name, "gray_encoder_4_bit")
    shutil.copytree(EXAMPLE_DIR, dst, ignore=lambda p, names: [
        n for n in names if n in ("generated", "syscfg", "mcuplus")])
    syscfg = os.path.join(dst, CORE_SUBDIR, "example.syscfg")
    with open(syscfg, "r", newline="") as f:
        text = f.read()
    with open(syscfg, "w", newline="") as f:
        f.write(_group_with_mailbox(text))
    main_asm = os.path.join(dst, "firmware", "main.asm")
    with open(main_asm, "r", newline="") as f:
        main = f.read()
    head, sep, _ = main.partition("\nmain:")        # keep .include / .global / .ref
    assert sep, "main.asm no longer has a main: label"
    with open(main_asm, "w", newline="") as f:
        f.write(head + "\n" + MAIN_BODY)
    make_dir = os.path.join(dst, CORE_SUBDIR, "ti-pru-cgt")
    subprocess.check_call([GMAKE, "-s", "all", "PRU_NO_CODE_TOOL_PATH=" + REPO_ROOT],
                          cwd=make_dir, stdout=subprocess.DEVNULL)
    elf = os.path.join(make_dir, ELF_NAME)
    assert os.path.exists(elf)
    return elf, os.path.join(make_dir, "syscfg", "pru_syscfg.asm")


def run(elf):
    holder = {}
    res = elf_cosim.run_elf_closed_loop(
        elf, type("Z", (), {"tick": lambda s, c, p: 0})(), max_steps=2000,
        on_step=lambda c, g, i, sim: holder.setdefault("sim", sim))
    sim = holder["sim"]
    rd = lambda a, n: struct.unpack("<%dI" % n, sim.memory_read(a, 4 * n))
    return res, rd(0x10000, 4), rd(0x0, DMEM_WORDS), hasattr(sim, "pru_ctrl")


PEAK = re.compile(r"; OVERALL PEAK CYCLES: (\d+) cycles[^\n]*")
STOCK_PEAK = 7           # stock gray_encoder_4_bit: load_constant + LUT, no c28 user
MAILBOX_CYCLES = 21      # the shared publish mailbox added by this fixture (noOfCycles; 21 since)
SETUP_CYCLES = 4         # ldi + ldi32 (2) + sbbo


@pytest.fixture(scope="module")
def green(tmp_path_factory):
    root = tmp_path_factory.mktemp("rp")
    elf, asm = build_group_design(root, "green")
    with open(asm, "r", newline="") as f:
        text = f.read().replace("\r\n", "\n")
    return root, elf, asm, text


@needs_toolchain
def test_group_start_label_is_followed_by_the_ctppr0_write(green):
    _root, _elf, _asm, text = green
    assert GROUP_ENTRY.search(text), "no CTPPR0 write directly after gray_encoder_start:"
    assert len(CT_SETUP.findall(text)) == 2, "expect one write at sysconfig_generated_start and one per group"
    assert re.search(r"sysconfig_generated_start:\n(?:[ \t]*;[^\n]*\n)*[ \t]*ldi[ \t]+TEMP_REG1,[ \t]*0x100", text)


@needs_toolchain
def test_group_entry_c28_access_lands_in_shared_ram(green):
    _root, elf, _asm, _text = green
    res, shared, dmem, models = run(elf)
    assert res.halted
    if not models:
        pytest.skip("pru-simulator hard-codes c28 (no PRU_CTRL model)")
    assert shared[SLOT0 // 4] == PAYLOAD, [hex(w) for w in shared]
    assert shared[0] == 1, "mailbox head must advance to 1 in shared RAM"
    assert PAYLOAD not in dmem, "payload also reached own DMEM"


@needs_toolchain
def test_group_ctppr0_write_removed_red(green):
    """Strip ONLY the write after gray_encoder_start:, rebuild, and the publish lands in DMEM."""
    root, green_elf, _asm, _text = green
    elf, asm = build_group_design(root, "no_group_write")
    with open(asm, "r", newline="") as f:
        text = f.read().replace("\r\n", "\n")
    m = GROUP_ENTRY.search(text)
    assert m, "group write not generated"
    cut = text[m.start():]
    stripped_tail, n = CT_SETUP.subn("", cut, count=1)
    assert n == 1
    with open(asm, "w", newline="") as f:
        f.write(text[:m.start()] + stripped_tail)
    os.remove(elf)
    make_dir = os.path.dirname(os.path.dirname(elf))
    subprocess.check_call([GMAKE, "-s", "all", "SYSCFG_NODE=echo", "PRU_NO_CODE_TOOL_PATH=" + REPO_ROOT],
                          cwd=make_dir, stdout=subprocess.DEVNULL)
    with open(asm, "r", newline="") as f:
        assert not GROUP_ENTRY.search(f.read().replace("\r\n", "\n")), "rebuild regenerated the asm"
    with open(green_elf, "rb") as a, open(elf, "rb") as b:
        assert a.read() != b.read(), "stripping the group write did not change the ELF"
    res, shared, dmem, models = run(elf)
    if not models:
        pytest.skip("pru-simulator hard-codes c28 (no PRU_CTRL model)")
    assert res.halted
    assert shared[SLOT0 // 4] != PAYLOAD and shared[0] == 0, [hex(w) for w in shared]
    # Without CTPPR0 c28 is own DMEM 0x0, where the LUT sits: the mailbox head is read from
    # LUT bytes, so the slot is wherever that points -- search the whole 2 KB for the payload.
    assert PAYLOAD in dmem, "publish did not land in own DMEM"


@needs_toolchain
def test_peak_cycles_header_includes_the_setup_in_a_c28_design(green):
    """Pre-fix header read STOCK_PEAK + MAILBOX_CYCLES (8): it ignored the CTPPR0 write."""
    _root, _elf, _asm, text = green
    m = PEAK.search(text)
    assert m, "no OVERALL PEAK CYCLES header"
    assert int(m.group(1)) == STOCK_PEAK + MAILBOX_CYCLES + SETUP_CYCLES, m.group(0)
    assert "includes 4 cycles of CTPPR0 setup" in m.group(0)


@needs_toolchain
def test_peak_cycles_header_unchanged_without_c28(tmp_path):
    dst = os.path.join(str(tmp_path), "stock")
    shutil.copytree(EXAMPLE_DIR, dst, ignore=lambda p, names: [
        n for n in names if n in ("generated", "syscfg", "mcuplus")])
    make_dir = os.path.join(dst, CORE_SUBDIR, "ti-pru-cgt")
    subprocess.check_call([GMAKE, "-s", "all", "PRU_NO_CODE_TOOL_PATH=" + REPO_ROOT],
                          cwd=make_dir, stdout=subprocess.DEVNULL)
    with open(os.path.join(make_dir, "syscfg", "pru_syscfg.asm"), "r") as f:
        text = f.read()
    assert "CTPPR0" not in text
    m = PEAK.search(text)
    assert m and int(m.group(1)) == STOCK_PEAK and "CTPPR0" not in m.group(0), m and m.group(0)
