"""a SysConfig-GENERATED SSI initiator must decode an SSI encoder model.

The production path is: .syscfg design -> real SysConfig CLI -> pru_syscfg.asm
-> clpru -> ELF -> TI pru-simulator.  The SSI block's macro takes 14 positional
arguments, so SysConfig has to pass the block's config fields in the macro's
order.  The right COUNT in the wrong ORDER binds TOTAL_WIDTH to 0 (a 256-iteration
loop that never halts), and a test that looks for the frame in ANY of 32 registers
cannot tell.  This test:

  * reads the RES register out of the generated ``m_ssi_read`` call (never
    hard-coded), decodes ST/MT from that register and compares them with the
    model's position;
  * asserts the generated call's positional constants against the macro's
    parameter names;
  * carries red arms: two constants swapped in the generated call, and a model
    holding a different position, must each be reported as a decode mismatch.

Checked with the TI pru-simulator running the clpru-built ELF; the JS simulator
is not used.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))

SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
PRODUCT = ROOT / ".metadata" / "product.json"

# Macro parameter order of m_ssi_read (ssi_initiator_block.syscfg.js getMacro).
MACRO_PARAMS = ["RES", "TOTAL_WIDTH", "ST_BITS", "MT_BITS", "CLK_PIN", "DATA_PIN", "CPOL",
                "HALF_PERIOD", "MONO_CYCLES", "PARITY_EN", "PARITY_TYPE", "ERR_EN",
                "GRAY_EN", "TIMEOUT_CYCLES"]

try:
    import elf_cosim
    from pru_device_models.ssi_endat_encoder import SsiEndatEncoder
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except (RuntimeError, ImportError):
    HAVE_ELF = False

HAVE_SYSCFG = SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()

pytestmark = [
    pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing"),
    pytest.mark.skipif(not HAVE_SYSCFG, reason="SysConfig CLI missing"),
]

# One design per case: the instance fields set in the .syscfg, and the matching
# encoder-model parameters.  Block defaults apply where a field is not set.
CASES = {
    # The shape the GUI demo uses: block defaults except grayCode off.
    "defaults_gray_off": dict(
        inst=dict(grayCode=False),
        model=dict(clk_pin=0, data_pin=1, cpol=1, total_width=25, st_bits=13, mt_bits=12,
                   parity_enable=False, error_bit_enable=False, gray_code=False,
                   min_half_period_cycles=4, mono_cycles=60),
        extras=0, faults=[]),
    # Pure block defaults: idle-high clock and Gray code on (the macro took
    # GRAY_EN and ignored it, so a Gray encoder at defaults read back Gray).
    "defaults": dict(
        inst=dict(),
        model=dict(clk_pin=0, data_pin=1, cpol=1, total_width=25, st_bits=13, mt_bits=12,
                   parity_enable=False, error_bit_enable=False, gray_code=True,
                   min_half_period_cycles=4, mono_cycles=60),
        extras=0, faults=[]),
    # clockPolarity 0 = every clock level inverted (an inverting line driver).  Only this
    # local model speaks inverted; the pru-simulator SsiEncoder is idle-high only.
    "cpol0_inverted_line": dict(
        inst=dict(clockPolarity=0, grayCode=False),
        model=dict(clk_pin=0, data_pin=1, cpol=0, total_width=25, st_bits=13, mt_bits=12,
                   parity_enable=False, error_bit_enable=False, gray_code=False,
                   min_half_period_cycles=4, mono_cycles=60),
        extras=0, faults=[]),
    # Every field moved off its default, including clockPolarity and both pins.
    "all_fields_moved": dict(
        inst=dict(totalWidth=27, singleTurnBits=13, multiTurnBits=12, clkPin=3, dataPin=5,
                  clockPolarity=1, halfPeriodCycles=6, monoTimeCycles=70, parityEnable=True,
                  parityType=1, errorBitEnable=True, grayCode=False, timeoutCycles=90),
        model=dict(clk_pin=3, data_pin=5, cpol=1, total_width=27, st_bits=13, mt_bits=12,
                   parity_enable=True, parity_type=1, error_bit_enable=True, gray_code=False,
                   min_half_period_cycles=4, mono_cycles=80),
        extras=2,
        # pinned "cycle 6: clock half period 2 < min 4" here (the macro dropped
        # the clock 2 cycles after raising it to idle).  holds idle for a half
        # period before the first pulse, so no fault is expected any more.
        faults=[]),
}
# ST is odd: an LSB-dropping read must not pass by luck.
ST, MT = 0x1235 & 0x1FFF, 0x2A

BLOCK_DEFAULTS = dict(totalWidth=25, singleTurnBits=13, multiTurnBits=12, clkPin=0, dataPin=1,
                      clockPolarity=1, halfPeriodCycles=10, monoTimeCycles=20,
                      parityEnable=False, parityType=0, errorBitEnable=False, grayCode=True,
                      timeoutCycles=100)
# config field -> macro parameter, in the macro's positional order
FIELD_ORDER = ["totalWidth", "singleTurnBits", "multiTurnBits", "clkPin", "dataPin",
               "clockPolarity", "halfPeriodCycles", "monoTimeCycles", "parityEnable",
               "parityType", "errorBitEnable", "grayCode", "timeoutCycles"]


def _syscfg_text(inst, block="ssi_initiator_block"):
    lines = [
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01',
        'const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);',
        'const ssi = scripting.addModule("/pru_blocks/application_specific/%s", {}, false);' % block,
        'const inst = ssi.addInstance();',
    ]
    for k, v in inst.items():
        lines.append("inst.%s = %s;" % (k, str(v).lower() if isinstance(v, bool) else v))
    lines.append('inst.$name = "BLOCK_0";')
    return "\n".join(lines) + "\n"


def generate(work, inst, block="ssi_initiator_block"):
    """Run the real SysConfig CLI on a one-block design; return the output dir."""
    work.mkdir(parents=True, exist_ok=True)
    script = work / "ssi.syscfg"
    script.write_text(_syscfg_text(inst, block), encoding="utf-8")
    out = work / "out"
    env = dict(os.environ)
    r = subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0", "--output", str(out)],
        cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0 and "Generating Code" in r.stdout, \
        "SysConfig failed:\n%s\n%s" % (r.stdout, r.stderr)
    assert "Macro arity mismatch" not in r.stdout + r.stderr, r.stdout + r.stderr
    return out


CALL_RE = re.compile(r"^[ \t]*m_ssi_read[ \t]+(.*?)[ \t]*$", re.M)


def parse_call(out):
    """(RES register index, [constants as strings]) from the generated m_ssi_read call."""
    asm = (out / "pru_syscfg.asm").read_text(encoding="utf-8", errors="replace")
    calls = CALL_RE.findall(asm)
    assert len(calls) == 1, "expected one m_ssi_read call, found %r" % calls
    args = [a.strip() for a in calls[0].split(";")[0].split(",")]
    assert len(args) == len(MACRO_PARAMS), \
        "m_ssi_read call has %d args, macro has %d: %s" % (len(args), len(MACRO_PARAMS), calls[0])
    m = re.fullmatch(r"R(\d+)", args[0])
    assert m, "RES argument %r is not a whole 32-bit register" % args[0]
    return int(m.group(1)), args[1:]


def rewrite_call(out, new_consts):
    asm_path = out / "pru_syscfg.asm"
    asm = asm_path.read_text(encoding="utf-8", errors="replace")
    res = parse_call(out)[0]
    new = "    m_ssi_read R%d, %s" % (res, " , ".join(str(c) for c in new_consts))
    asm_path.write_text(CALL_RE.sub(lambda _m: new, asm, count=1), encoding="utf-8")


def _clpru(args, cwd):
    r = subprocess.run([elf_cosim.find_clpru()] + args, cwd=cwd, text=True, capture_output=True)
    text = r.stdout + r.stderr
    assert r.returncode == 0, "clpru %s failed:\n%s" % (" ".join(args), text)
    # -c (compile only) and an explicit entry point: neither step may warn.
    assert "warning" not in text.lower(), "clpru %s warned:\n%s" % (" ".join(args), text)
    return text


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


def build(out):
    (out / "main.asm").write_text(MAIN_ASM, encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    _clpru(["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"], out)
    _clpru(["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd",
            "--entry_point=main", "-o", "main.out"], out)
    return out / "main.out"


def run_elf(elf, model_kw, st=ST, mt=MT):
    m = SsiEndatEncoder(protocol="ssi", st_value=st, mt_value=mt, **model_kw)
    # R30 is low out of reset.  The model assumes the clock pin starts at idle, so for
    # an idle-high clock (cpol=1) it would count the reset level as a leading active
    # edge before the firmware has driven the pin to idle.  Tell it the true start level.
    m._last_clk = 0
    r = elf_cosim.run_elf_closed_loop(str(elf), m, max_steps=20000)
    m.flush(r.cycles)
    return r, m


def decode_mismatch(r, res_reg, case, st=ST, mt=MT):
    """None if the RES register decodes to the model position, else the mismatch text."""
    mm = case["model"]
    res = r.registers[res_reg] & 0xFFFFFFFF
    payload = res >> case["extras"]
    got_st = payload & ((1 << mm["st_bits"]) - 1)
    got_mt = (payload >> mm["st_bits"]) & ((1 << mm["mt_bits"]) - 1)
    if (got_st, got_mt) == (st, mt) and r.halted:
        return None
    return ("SSI decode mismatch: RES=R%d=0x%08x halted=%s decoded ST=0x%x MT=0x%x "
            "!= model ST=0x%x MT=0x%x" % (res_reg, res, r.halted, got_st, got_mt, st, mt))


def expected_consts(case):
    """Positional constants the macro must receive, from the instance fields."""
    d = dict(BLOCK_DEFAULTS)
    d.update(case["inst"])
    return [str(int(d[k])) for k in FIELD_ORDER]


@pytest.fixture(scope="module", params=sorted(CASES))
def built(request, tmp_path_factory):
    case = CASES[request.param]
    out = generate(tmp_path_factory.mktemp("ssi_" + request.param), case["inst"])
    return case, out, build(out)


def test_generated_call_passes_config_in_macro_order(built):
    case, out, _ = built
    _, consts = parse_call(out)
    want = expected_consts(case)
    bad = [(p, got, w) for p, got, w in zip(MACRO_PARAMS[1:], consts, want) if got != w]
    assert not bad, "constant order/value mismatch (param, got, want): %r" % bad


def test_generated_firmware_decodes_the_model_position(built):
    case, out, elf = built
    res_reg, _ = parse_call(out)
    r, m = run_elf(elf, case["model"])
    text = decode_mismatch(r, res_reg, case)
    assert text is None, text
    assert m.faults() == case["faults"], m.faults()
    mm = case["model"]
    if mm["parity_enable"] or mm["error_bit_enable"]:
        # TEMP_REG2.b0 (R29) is the macro's status byte: 0 = parity and error bit ok.
        assert r.registers[29] & 0xFF == 0, "macro status byte 0x%x" % (r.registers[29] & 0xFF)


@pytest.mark.parametrize("swap", [("TOTAL_WIDTH", "HALF_PERIOD"), ("CLK_PIN", "DATA_PIN")])
def test_red_arm_two_constants_swapped(built, tmp_path, swap):
    """Swap two constants in the generated call: arity unchanged, order wrong."""
    case, out, _ = built
    bad = tmp_path / "bad"
    shutil.copytree(out, bad)
    res_reg, consts = parse_call(bad)
    i, j = (MACRO_PARAMS[1:].index(n) for n in swap)
    consts[i], consts[j] = consts[j], consts[i]
    rewrite_call(bad, consts)
    r, _ = run_elf(build(bad), case["model"])
    text = decode_mismatch(r, res_reg, case)
    assert text is not None and text.startswith("SSI decode mismatch"), \
        "swapping %s went undetected" % (swap,)


def test_red_arm_model_position_changed(built):
    """Firmware decoded against a model that holds a different ST must read as a mismatch."""
    case, out, elf = built
    res_reg, _ = parse_call(out)
    r, _ = run_elf(elf, case["model"])
    assert decode_mismatch(r, res_reg, case) is None
    text = decode_mismatch(r, res_reg, case, st=ST ^ 0x1)    # model st_value changed
    assert text is not None and text.startswith("SSI decode mismatch") and         "model ST=0x%x" % (ST ^ 0x1) in text, text


def test_red_arm_gray_decode_removed(tmp_path):
    """Strip the macro's Gray->binary step: a Gray-coded encoder must then mismatch."""
    case = CASES["defaults"]
    assert case["model"]["gray_code"]
    out = generate(tmp_path / "gen", case["inst"])
    r, _ = run_elf(build(out), case["model"])
    assert decode_mismatch(r, parse_call(out)[0], case) is None   # control: intact macro
    bad = tmp_path / "bad"
    shutil.copytree(out, bad)
    inc = bad / "pru_syscfg.inc"
    text = inc.read_text(encoding="utf-8", errors="replace")
    stripped, n = re.subn(r"\n[ \t]*\.if GRAY_EN == 1\n.*?\n[ \t]*\.endif", "", text,
                          count=1, flags=re.S)
    assert n == 1, "Gray block not found in the generated macro"
    inc.write_text(stripped, encoding="utf-8")
    res_reg, _ = parse_call(bad)
    r, _ = run_elf(build(bad), case["model"])
    text = decode_mismatch(r, res_reg, case)
    assert text is not None and text.startswith("SSI decode mismatch"), \
        "removing the Gray decode went undetected"


# --- EnDat: the other block with a long positional macro call ------------------------------
# Static only: the order of the generated call against the macro's parameter list, using a
# DISTINCT value per field so any transposition shows.  No closed-loop EnDat decode is claimed.
ENDAT_MACRO = ["MODE_CMD", "TOTAL_BITS", "ST_BITS", "MT_BITS", "CLK_PIN", "DATA_TX_PIN",
               "DATA_RX_PIN", "HALF_PERIOD", "T1_CLOCKS", "TRT_CYCLES", "TREC_CYCLES",
               "TIMEOUT_CYCLES", "DATA_EN_PIN"]
# ModeCommand is a position command (7 or 56) and 56 carries F2, so
# totalBits = 1 + 2 + ST + MT + 5; DATA_EN_PIN (the transceiver DE) was appended.
ENDAT_FIELDS = [("modeCommand", 56), ("totalBits", 29), ("singleTurnBits", 13),
                ("multiTurnBits", 8), ("clkPin", 3), ("dataTxPin", 4), ("dataRxPin", 6),
                ("halfPeriodCycles", 26), ("t1Clocks", 3), ("trtCycles", 21),
                ("trecCycles", 1001), ("timeoutCycles", 102), ("dataEnPin", 9)]


def test_endat_generated_call_passes_config_in_macro_order(tmp_path):
    out = generate(tmp_path, dict(ENDAT_FIELDS), block="endat_initiator_block")
    asm = (out / "pru_syscfg.asm").read_text(encoding="utf-8", errors="replace")
    calls = re.findall(r"^[ 	]*m_endat_read[ 	]+(.*?)[ 	]*$", asm, re.M)
    assert len(calls) == 1, calls
    args = [a.strip() for a in calls[0].split(",")]
    assert len(args) == len(ENDAT_MACRO) + 1, calls[0]
    assert re.fullmatch(r"R\d+", args[0]), args[0]
    got = list(zip(ENDAT_MACRO, args[1:]))
    want = [(m, str(v)) for m, (_, v) in zip(ENDAT_MACRO, ENDAT_FIELDS)]
    assert got == want, "EnDat constant order mismatch: %r" % [
        (g, w) for g, w in zip(got, want) if g != w]
