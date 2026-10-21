"""BiSS-C and EnDat blocks must hand the clock back at its idle level.

Both protocols idle the clock HIGH.  m_biss_c_read ended every bit on `clr`, and
m_endat_read idled and stopped its clock LOW, so a frame left the line off idle:
the next transaction then starts with a phantom edge (the SSI block idles
correctly; the models ignore an off-idle level only on the first sample).  The
decode never noticed, because the decode does not look at the clock after the
last bit.

Checked with the real clpru ELF on the TI pru-simulator.

  * BiSS-C runs through `gmake sim` (the user-facing path) with ODD positions,
    against pru_io.bissc_device_model.BissCModel.  The runner prints the clock
    level it found at the end of the run; the decoded value must equal the
    model position.
  * EnDat is NOT bindable through gmake sim (the SysConfig front door refuses
    kind "endat", ported:false), so the block is built from a one-block design
    with the real SysConfig CLI + clpru and run closed-loop against
    pru_io.endat_encoder.EndatEncoder.  Only the clock idle level is asserted
    here; the end-to-end EnDat decode is (tests/test_endat_framing.py).

Red arms rebuild the same flow from a scratch tool root whose block macro has
been put back to the pre-body.
"""
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

GMAKE = Path(str(TI_TOOLS / "ccs2100" / "ccs" / "utils" / "bin" / "gmake.exe"))
SIM = Path(os.environ.get("PRU_SIMULATOR_PATH", ""))
SYSCONFIG_NODE = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe"))
SYSCONFIG_CLI = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js"))
SOURCE = ROOT / "examples" / "ssi_encoder_sim"
DESIGN = Path("firmware/am243x-lp/icss_g0_pru0_fw/example.syscfg")
SCRATCH = ROOT / ".tmp" / "clock_idle"
BLOCKS = Path(".metadata/sysconfig/.meta/pru_blocks/application_specific")

pytestmark = pytest.mark.skipif(
    not (GMAKE.exists() and SIM.is_dir() and (SIM / "simulator.py").exists()
         and Path(str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe")).exists()
         and SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()
         and (ROOT / "imports.mak").exists()),
    reason="needs gmake, SysConfig 1.28, clpru, imports.mak, and PRU_SIMULATOR_PATH",
)

# --- clock-order variants: the current macro body and the high-then-low order re-applied as a mutant (red arms) ---

BISS_NEW = """\
`m_biss_c_loop?:`,
            `    ; MA idles HIGH between frames: pulse it low, then back high.`,
            `    ; Ending each bit on clr would leave MA low after the frame, and the`,
            `    ; encoder would see the next transaction start from the wrong level.`,
            `    ; Set MA clock pin low`,
            `    clr   R30, R30, CLK               ; (clkPin: MA clock output bit)`,
            `    ; Wait half-period (not simulated accurately)`,
            `    nop`,
            `    ; Set MA clock pin high: rising edge k, slave presents bit k after it`,
            `    set   R30, R30, CLK`,
"""
BISS_OLD = """\
`m_biss_c_loop?:`,
            `    ; Set MA clock pin high`,
            `    set   R30, R30, CLK               ; (clkPin: MA clock output bit)`,
            `    ; Wait half-period (not simulated accurately)`,
            `    nop`,
            `    ; Set MA clock pin low`,
            `    clr   R30, R30, CLK`,
"""


def _scratch_root(name, block_file=None, edit=None):
    """Copy of the tool root (small: .metadata, scripts, pru_device_models and
    the two .mak files) with one block source edited."""
    root = SCRATCH / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for d in (".metadata", "scripts", "pru_device_models"):
        src = ROOT / d
        if src.is_dir():
            shutil.copytree(src, root / d, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
    for f in ("imports.mak", "pru_rules.mak"):
        shutil.copy(ROOT / f, root / f)
    if block_file is not None:
        p = root / BLOCKS / block_file
        text = p.read_bytes().decode("utf-8").replace("\r\n", "\n")
        p.write_bytes(edit(text).encode("utf-8"))
    return root


def _swap(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


def _old_biss(text):
    return _swap(text, BISS_NEW, BISS_OLD)


def _old_endat(text):
    """Pre-every set/clr of CLK_PIN swapped back (clock idles low)."""
    text = re.sub(r"(set|clr)(   R30, R30, CLK_PIN)",
                  lambda m: ("clr" if m.group(1) == "set" else "set") + m.group(2), text)
    return _swap(text, "; clock idles HIGH (EnDat); each bit is a low pulse, so the frame ends high",
                 "; clock idle low")


# --- BiSS-C through gmake sim ------------------------------------------------------------


def _biss_design(position):
    text = (SOURCE / DESIGN).read_text(encoding="utf-8")
    text = text.replace("ssi_initiator_block", "biss_c_initiator_block")
    text = _swap(text, "ssi.dataPin = 1;", "ssi.dataPin = 1;\nssi.dataLen = 32;")
    text = _swap(text, 'sim.gpi1_deviceKind = "ssi";', 'sim.gpi1_deviceKind = "bissc";')
    return re.sub(r"sim\.gpi1_deviceParams = .*",
                  "sim.gpi1_deviceParams = '{\"position_bits\":21,\"position\":%d,\"tbusy_clocks\":0}';" % position,
                  text)


def run_gmake_sim(root, position):
    if not SOURCE.is_dir():
        pytest.skip("needs the examples/ssi_encoder_sim example project")
    path = root / "examples" / ("_case_" + uuid.uuid4().hex[:8])
    try:
        shutil.copytree(SOURCE, path, ignore=shutil.ignore_patterns(
            "generated", "syscfg"))
        (path / DESIGN).write_text(_biss_design(position), encoding="utf-8")
        (path / "firmware/am243x-lp/icss_g0_pru0_fw/ti-pru-cgt/generated").mkdir(parents=True)
        env = dict(os.environ, PRU_SIMULATOR_PATH=str(SIM),
                   PATH=str(GMAKE.parent) + os.pathsep + os.environ.get("PATH", ""))
        env.pop("PRU_NO_CODE_TOOL_PATH", None)
        out = ""
        for target in ("all", "sim"):
            r = subprocess.run([str(GMAKE), target, "BUILD_MCUPLUS=n", "CAT=type", "MOVE=move"],
                               cwd=path, env=env, capture_output=True, text=True)
            out = r.stdout + r.stderr
            assert r.returncode == 0, out
        return out
    finally:
        shutil.rmtree(path, ignore_errors=True)


def clock_level(out):
    m = re.search(r"Clock R30\.\d+ level at end of run: (\d)", out)
    assert m, out
    return int(m.group(1))


def decoded(out):
    m = re.search(r"Firmware decoded R\d+: (\d+); model position: (\d+)", out)
    assert m, out
    return int(m.group(1)), int(m.group(2))


def assert_idle_high_and_decoded(out, position):
    assert "FAULTS: None" in out, out
    assert decoded(out) == (position, position), out
    assert clock_level(out) == 1, f"BiSS-C MA left at {clock_level(out)}, idle is HIGH:\n{out}"


@pytest.mark.parametrize("position", [1, 1234567])
def test_biss_c_odd_position_decodes_and_leaves_ma_idle_high(position):
    assert position & 1, "the point is an LSB-set position"
    out = run_gmake_sim(ROOT, position)
    assert_idle_high_and_decoded(out, position)
    assert "RESULT: PASS" in out


def test_red_arm_old_biss_c_macro_leaves_ma_low():
    """Same flow, pre-fix macro: still decodes (so the decode could never see it),
    but the clock is left LOW and the idle assertion fails for that reason."""
    root = _scratch_root("biss_old", "biss_c_initiator_block.syscfg.js", _old_biss)
    out = run_gmake_sim(root, 1234567)
    assert decoded(out) == (1234567, 1234567), out
    with pytest.raises(AssertionError, match=r"MA left at 0, idle is HIGH"):
        assert_idle_high_and_decoded(out, 1234567)


# --- EnDat: real ELF, closed loop on the EnDat model -------------------------------------


def _generate_and_build(root, work):
    work.mkdir(parents=True, exist_ok=True)
    script = work / "endat.syscfg"
    script.write_text(
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01\n'
        'const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);\n'
        'const m = scripting.addModule("/pru_blocks/application_specific/endat_initiator_block", {}, false);\n'
        'const inst = m.addInstance();\ninst.$name = "BLOCK_0";\n', encoding="utf-8")
    out = work / "out"
    env = dict(os.environ)
    r = subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(root / ".metadata" / "product.json"),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0", "--output", str(out)],
        cwd=root, env=env, text=True, capture_output=True)
    assert r.returncode == 0 and "Generating Code" in r.stdout, r.stdout + r.stderr
    (out / "main.asm").write_text(
        "    .retain\n    .retainrefs\n    .global     main\n    .ref        sysconfig_generated_start\n"
        '    .sect       ".text:main"\nmain:\n    jmp     sysconfig_generated_start\n'
        "    .global sysconfig_generated_end\nsysconfig_generated_end:\n    halt\n", encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    for args in (["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"],
                 ["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd",
                  "--entry_point=main", "-o", "main.out"]):
        r = subprocess.run([elf_cosim.find_clpru()] + args, cwd=out, text=True, capture_output=True)
        assert r.returncode == 0, r.stdout + r.stderr
    return out / "main.out"


class _EndatOnTransceiver:
    """EndatEncoder behind the RS-422 transceiver the block assumes: the block
    drives CLOCK on R30.0 and DATA_TX on R30.1 and reads DATA_RX on R31.2, while
    the model has one bidirectional DATA pin.  Records the CLOCK level it saw."""

    def __init__(self, position):
        with elf_cosim._sim_namespace(elf_cosim.find_pru_simulator()):
            from pru_io.endat_encoder import EndatEncoder
        self.model = EndatEncoder(0, 1, position_bits=21, position=position, calc_cycles=50)
        self.clk = None

    def tick(self, cycle, gpo):
        self.clk = gpo & 1
        mask, value = self.model.tick(cycle, gpo & 0b11)
        released = 1 if not (mask & 0b10) else (value >> 1) & 1
        return released << 2


def run_endat(root, name, position=1234567):
    elf = _generate_and_build(root, SCRATCH / ("w_" + name))
    dev = _EndatOnTransceiver(position)
    result = elf_cosim.run_elf_closed_loop(str(elf), dev, max_steps=60000)
    assert result.halted, "EnDat firmware did not halt"
    return dev


def assert_endat_clock_idle_high(dev):
    assert dev.clk == 1, f"EnDat CLOCK left at {dev.clk}, idle is HIGH"


def test_endat_leaves_clock_idle_high_after_the_frame():
    dev = run_endat(ROOT, "endat_new")
    assert_endat_clock_idle_high(dev)


def test_endat_model_reacts_to_the_block_clock():
    """Control for the arm above: the block really clocks the model (a clock that
    never moved would also 'idle high')."""
    dev = run_endat(ROOT, "endat_ctl")
    assert dev.model.faults() or dev.model.events(), "the EnDat model never saw a command edge"


def test_red_arm_old_endat_macro_leaves_clock_low():
    root = _scratch_root("endat_old", "endat_initiator_block.syscfg.js", _old_endat)
    dev = run_endat(root, "endat_old")
    with pytest.raises(AssertionError, match=r"EnDat CLOCK left at 0, idle is HIGH"):
        assert_endat_clock_idle_high(dev)


# --- EnDat: no runt clock pulse, judged by the EnDat model --------------------------------
#
# The reference EnDat model is pru_device_models/ssi_endat_encoder.py; the
# half-period rule now comes from the one EnDat model, pru-simulator's
# pru_io.endat_encoder (min_half_period_cycles).


class _LocalEndatOnTransceiver:
    """EnDat model judging only the CLOCK (R30.0) half periods. Like the
    model's default seeding, the first CLOCK sample (R30 resets LOW) is a level,
    not an edge, so only the block's own edges are measured."""

    def __init__(self):
        with elf_cosim._sim_namespace(elf_cosim.find_pru_simulator()):
            from pru_io.endat_encoder import EndatEncoder
        self.model = EndatEncoder(clock_pin=0, data_pin=1, min_half_period_cycles=10)

    def tick(self, cycle, gpo):
        self.model.tick(cycle, gpo & 0b1)
        return 1 << 2


def endat_half_period_faults(root, name):
    elf = _generate_and_build(root, SCRATCH / ("w_" + name))
    dev = _LocalEndatOnTransceiver()
    result = elf_cosim.run_elf_closed_loop(str(elf), dev, max_steps=60000)
    assert result.halted, "EnDat firmware did not halt"
    return [f for f in dev.model.faults() if "half period" in f]


def assert_no_half_period_fault(faults):
    assert not faults, f"EnDat clock half-period fault(s): {faults}"


def test_endat_clock_has_no_runt_pulse_on_the_local_model():
    assert_no_half_period_fault(endat_half_period_faults(ROOT, "endat_runt_new"))


def test_red_arm_runt_macro_faults_the_local_model():
    """8fe7ada's macro: set CLK at entry, clr it a few cycles later (3 then; 5 since
    added the DE clr/set between them - still a runt)."""
    def runt(text):
        lines = ["            `    ldi   TEMP_REG4.w0, HALF_PERIOD   ; hold the idle-high level one half period so the first low pulse is not a runt`,",
                 "            `m_endat_idle?:`,",
                 "            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,",
                 "            `    qbne  m_endat_idle?, TEMP_REG4.w0, 0`,"]
        old = "\n".join(lines) + "\n"
        return _swap(text, old, "")
    root = _scratch_root("endat_runt", "endat_initiator_block.syscfg.js", runt)
    faults = endat_half_period_faults(root, "endat_runt")
    with pytest.raises(AssertionError, match=r"clock half period 5 < min 10"):
        assert_no_half_period_fault(faults)
