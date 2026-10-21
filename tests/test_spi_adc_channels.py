"""a SysConfig-GENERATED 2-channel SPI ADC sequencer keeps one full-width result per channel.

50cb1b4 fixed the macro arity by collapsing RES0..RESn into one RES.  Both channels then wrote
the same register and the 16-bit frame landed in a 1-byte output.  This test runs the real path
(.syscfg -> SysConfig CLI -> pru_syscfg.asm -> clpru -> ELF -> TI pru-simulator) against an ADC
model that returns a DIFFERENT 16-bit word per conversion, reads the result registers out of the
generated call, and asserts they are distinct and carry the full 16 bits.  Red arms: the call
rewritten so both channels share one register (the 50cb1b4 behaviour) and a model holding a
different word must each be reported.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))

SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
PRODUCT = ROOT / ".metadata" / "product.json"

try:
    import elf_cosim
    from perif.spi_adc import SpiAdc
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except (RuntimeError, ImportError):
    HAVE_ELF = False

pytestmark = [
    pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing"),
    pytest.mark.skipif(not (SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()),
                       reason="SysConfig CLI missing"),
]

WORDS = [0xBEEF, 0xCAFE]          # high byte non-zero: a 1-byte result cannot hold either
CALL_RE = re.compile(r"^[ \t]*m_spi_adc_seq_2_none[ \t]+(.*?)[ \t]*$", re.M)
MAIN_ASM = """\
    .retain
    .retainrefs
    .global     main
    .ref        sysconfig_generated_start
    .sect       ".text:main"
main:
    jmp     sysconfig_generated_start
    .global sysconfig_generated_end
sysconfig_generated_end:
    halt
"""


class PerFrameAdc(SpiAdc):
    """SpiAdc whose conversion word changes with every CS assertion."""

    def __init__(self, words, **kw):
        super().__init__(conversion=words[0], **kw)
        self._words = list(words)
        self._frame = -1

    def tick(self, cycle, pins_out):
        cs = (pins_out >> self.cs_pin) & 1
        # the first tick is the reset level, not a CS assertion edge
        if self._primed and cs == 0 and self._last_cs == 1:
            self._frame += 1
            self.conversion = self._words[min(self._frame, len(self._words) - 1)]
        return super().tick(cycle, pins_out)


def generate(work):
    work.mkdir(parents=True, exist_ok=True)
    script = work / "spi.syscfg"
    script.write_text(
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01\n'
        'const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);\n'
        'const spi = scripting.addModule("/pru_blocks/pru_io_blocks/spi_adc_sequencer_block", {}, false);\n'
        'const inst = spi.addInstance();\n'
        'inst.channel_sequence = "0x1234, 0x5678";\ninst.t_conv = 20;\ninst.sample_period = 2000;\n'
        'inst.$name = "BLOCK_0";\n', encoding="utf-8")
    out = work / "out"
    env = dict(os.environ)
    r = subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0", "--output", str(out)],
        cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0 and "Generating Code" in r.stdout, r.stdout + r.stderr
    assert "Macro arity mismatch" not in r.stdout + r.stderr, r.stdout + r.stderr
    return out


def parse_call(out):
    """(result register indices, constants) of the generated 2-channel call: 2 results + 9 constants."""
    asm = (out / "pru_syscfg.asm").read_text(encoding="utf-8", errors="replace")
    calls = CALL_RE.findall(asm)
    assert len(calls) == 1, "expected one m_spi_adc_seq_2_none call, found %r" % calls
    args = [a.strip() for a in calls[0].split(";")[0].split(",")]
    assert len(args) == 11, "call has %d args, macro (RES0,RES1 + 9) has 11: %s" % (len(args), calls[0])
    regs = []
    for a in args[:2]:
        m = re.fullmatch(r"R(\d+)", a)
        assert m, "result argument %r is not a whole 32-bit register" % a
        regs.append(int(m.group(1)))
    return regs, args[2:]


def build(out):
    def clpru(args):
        r = subprocess.run([elf_cosim.find_clpru()] + args, cwd=out, text=True, capture_output=True)
        text = r.stdout + r.stderr
        assert r.returncode == 0 and "warning" not in text.lower(), text
    (out / "main.asm").write_text(MAIN_ASM, encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    clpru(["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"])
    clpru(["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd",
           "--entry_point=main", "-o", "main.out"])
    return out / "main.out"


def run(elf):
    m = PerFrameAdc(WORDS, sclk_pin=0, sdi_pin=1, sdo_pin=2, cs_pin=3, bits=16, msb_first=True)
    r = elf_cosim.run_elf_closed_loop(str(elf), m, max_steps=20000)
    return r, m


def result_mismatch(r, regs, words=WORDS):
    """None if each channel's register holds its own full 16-bit word, else the mismatch text."""
    got = [r.registers[i] & 0xFFFFFFFF for i in regs]
    if r.halted and got == words and len(set(regs)) == len(regs):
        return None
    return "SPI result mismatch: regs=%r got=%s want=%s halted=%s" % (
        regs, ["0x%x" % g for g in got], ["0x%x" % w for w in words], r.halted)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = generate(tmp_path_factory.mktemp("spi2"))
    return out, build(out)


def test_two_channel_results_are_distinct_and_full_width(built):
    out, elf = built
    regs, _ = parse_call(out)
    assert len(set(regs)) == 2, "channels share a result register: %r" % regs
    r, m = run(elf)
    assert m.faults() == [], m.faults()
    assert [e["mosi"] for e in m.events() if e["kind"] == "transaction"] == [0x1234, 0x5678]
    text = result_mismatch(r, regs)
    assert text is None, text


def test_red_arm_shared_result_register_is_reported(built, tmp_path):
    """Both channels pointed at one register (the 50cb1b4 behaviour): overwrite must be reported."""
    out, _ = built
    bad = tmp_path / "bad"
    shutil.copytree(out, bad)
    regs, consts = parse_call(bad)
    asm_path = bad / "pru_syscfg.asm"
    asm = asm_path.read_text(encoding="utf-8", errors="replace")
    new = "    m_spi_adc_seq_2_none R%d, R%d, %s" % (regs[0], regs[0], " , ".join(consts))
    asm_path.write_text(CALL_RE.sub(lambda _m: new, asm, count=1), encoding="utf-8")
    r, _ = run(build(bad))
    text = result_mismatch(r, [regs[0], regs[0]])
    assert text is not None and text.startswith("SPI result mismatch") and \
        "want=['0xbeef', '0xcafe']" in text, text
    assert r.registers[regs[0]] & 0xFFFFFFFF == WORDS[1], "second channel must have overwritten the first"


def test_red_arm_one_byte_result_is_reported(built):
    """A result truncated to one byte (output1Size = 1) must not satisfy the full-width check."""
    out, elf = built
    regs, _ = parse_call(out)
    r, _ = run(elf)
    r.registers[regs[0]] = r.registers[regs[0]] & 0xFF
    text = result_mismatch(r, regs)
    assert text is not None and text.startswith("SPI result mismatch") and "got=['0xef'" in text, text
