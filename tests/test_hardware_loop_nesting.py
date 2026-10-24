"""reject nested PRU hardware LOOP instructions.

The production guard is SysConfig validation.  Its red arm submits an outer
Loop containing Delay(2), asserts the exact diagnostic, and therefore proves
the invalid firmware cannot be generated.  The independent hardware fact is
also exercised with a real clpru ELF on TI's pru-simulator: a nested hardware
LOOP increments the outer-body counter once, not its requested three times.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
PRODUCT = ROOT / ".metadata" / "product.json"
HAVE_SYSCONFIG = SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()

try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except RuntimeError:
    HAVE_ELF = False


def _syscfg_text(delay_count):
    return "\n".join([
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 --product PRU_NO_CODE_TOOL@01.00.01',
        'const loop = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);',
        'const delay = scripting.addModule("/pru_blocks/utils/delay_block", {}, false);',
        'const OUTER_LOOP = loop.addInstance();',
        'const INNER_DELAY = delay.addInstance();',
        'OUTER_LOOP.$name = "OUTER_LOOP";',
        'OUTER_LOOP.loopCount = 3;',
        'INNER_DELAY.$name = "INNER_DELAY";',
        f'INNER_DELAY.delayCount = {delay_count};',
        'OUTER_LOOP.$groupContents = [INNER_DELAY];',
        '',
    ])


def _run_sysconfig(tmp_path, delay_count):
    script = tmp_path / "nested.syscfg"
    script.write_text(_syscfg_text(delay_count), encoding="utf-8")
    env = dict(os.environ)
    return subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0",
         "--output", str(tmp_path / "out")],
        cwd=ROOT, env=env, text=True, capture_output=True)


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_delay_one_inside_loop_is_safe_nop(tmp_path):
    """The guard is precise: Delay(1) is a NOP, not a hardware LOOP."""
    result = _run_sysconfig(tmp_path, 1)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_red_arm_nested_delay_hardware_loop_is_rejected(tmp_path):
    """RED ARM: Delay(2) must fail for the named nesting hazard."""
    result = _run_sysconfig(tmp_path, 2)
    text = result.stdout + result.stderr
    assert result.returncode != 0, "red arm unexpectedly generated nested hardware LOOP firmware"
    assert "PRU hardware LOOP instructions cannot nest: INNER_DELAY emits LOOP inside OUTER_LOOP" in text, text


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_red_arm_nested_fixed_loop_is_rejected(tmp_path):
    """The same capability guard covers every current LOOP emitter, including Loop."""
    script = tmp_path / "nested_loop.syscfg"
    script.write_text(_syscfg_text(1).replace(
        'const delay = scripting.addModule("/pru_blocks/utils/delay_block", {}, false);',
        'const delay = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);').replace(
        'const INNER_DELAY = delay.addInstance();', 'const INNER_LOOP = delay.addInstance();').replace(
        'INNER_DELAY.$name = "INNER_DELAY";', 'INNER_LOOP.$name = "INNER_LOOP";').replace(
        'INNER_DELAY.delayCount = 1;', 'INNER_LOOP.loopCount = 2;').replace(
        'OUTER_LOOP.$groupContents = [INNER_DELAY];', 'OUTER_LOOP.$groupContents = [INNER_LOOP];'), encoding="utf-8")
    env = dict(os.environ)
    result = subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0",
         "--output", str(tmp_path / "out")],
        cwd=ROOT, env=env, text=True, capture_output=True)
    text = result.stdout + result.stderr
    assert result.returncode != 0, "red arm unexpectedly generated nested fixed Loop firmware"
    assert "PRU hardware LOOP instructions cannot nest: INNER_LOOP emits LOOP inside OUTER_LOOP" in text, text


def _run_text(tmp_path, text, name):
    script = tmp_path / f"{name}.syscfg"
    script.write_text(text, encoding="utf-8")
    env = dict(os.environ)
    return subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0",
         "--output", str(tmp_path / "out")],
        cwd=ROOT, env=env, text=True, capture_output=True)


_HEADER = '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 --product PRU_NO_CODE_TOOL@01.00.01\n'
_MODULES = (
    'const loop = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);\n'
    'const delay = scripting.addModule("/pru_blocks/utils/delay_block", {}, false);\n')


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_green_infinite_loop_containing_delay_is_accepted(tmp_path):
    """GREEN ARM: an infinite Loop emits QBA, not LOOP, so Delay(2) inside is legal."""
    result = _run_text(tmp_path, _HEADER + _MODULES + "\n".join([
        'const OUTER = loop.addInstance();',
        'const D = delay.addInstance();',
        'OUTER.$name = "OUTER";',
        'OUTER.infiniteLoop = true;',
        'D.$name = "D";',
        'D.delayCount = 2;',
        'OUTER.$groupContents = [D];', '']), "inf_delay")
    assert result.returncode == 0, result.stdout + result.stderr
    asm = (tmp_path / "out" / "pru_syscfg.asm").read_text()
    assert "QBA" in asm and "m_wait_cycles 2" in asm


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_green_infinite_loop_containing_finite_loop_is_accepted(tmp_path):
    """GREEN ARM: a finite Loop inside an infinite Loop uses the one LOOP context."""
    result = _run_text(tmp_path, _HEADER + _MODULES + "\n".join([
        'const OUTER = loop.addInstance();',
        'const INNER = loop.addInstance();',
        'OUTER.$name = "OUTER";',
        'OUTER.infiniteLoop = true;',
        'INNER.$name = "INNER";',
        'INNER.loopCount = 2;',
        'OUTER.$groupContents = [INNER];', '']), "inf_loop")
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_preinit_delay_is_hoisted_before_the_loop_and_accepted(tmp_path):
    """preInitBlocks run once ahead of LOOP, so a Delay(2) there never nests."""
    text = _syscfg_text(2).replace(
        'OUTER_LOOP.$groupContents = [INNER_DELAY];',
        'OUTER_LOOP.$groupContents = [INNER_DELAY];\nOUTER_LOOP.preInitBlocks = ["INNER_DELAY"];')
    result = _run_text(tmp_path, text, "preinit")
    assert result.returncode == 0, result.stdout + result.stderr
    asm = (tmp_path / "out" / "pru_syscfg.asm").read_text()
    assert "m_wait_cycles 2" in asm and "LOOP endloop_0" in asm
    assert asm.index("m_wait_cycles 2") < asm.index("LOOP endloop_0"), asm


@pytest.mark.skipif(not HAVE_SYSCONFIG, reason="SysConfig CLI missing")
def test_non_preinit_delay_still_rejected_when_another_child_is_preinit(tmp_path):
    """The preInit exemption is per child, not a blanket pass."""
    text = _syscfg_text(2).replace(
        'const INNER_DELAY = delay.addInstance();',
        'const INNER_DELAY = delay.addInstance();\nconst BODY_DELAY = delay.addInstance();\nBODY_DELAY.$name = "BODY_DELAY";\nBODY_DELAY.delayCount = 3;').replace(
        'OUTER_LOOP.$groupContents = [INNER_DELAY];',
        'OUTER_LOOP.$groupContents = [INNER_DELAY, BODY_DELAY];\nOUTER_LOOP.preInitBlocks = ["INNER_DELAY"];')
    result = _run_text(tmp_path, text, "preinit_mixed")
    assert result.returncode != 0
    assert "BODY_DELAY emits LOOP inside OUTER_LOOP" in result.stdout + result.stderr


class _IdlePins:
    def tick(self, _cycle, _pins_out):
        return 0


@pytest.mark.skipif(not HAVE_ELF, reason="clpru or TI pru-simulator missing")
def test_real_pru_elf_red_arm_nested_hardware_loop_runs_outer_body_once(tmp_path):
    """RED ARM on TI pru-simulator: the unguarded instruction sequence is wrong."""
    asm = "\n".join([
        "    .global main", '    .sect ".text"', "main:",
        "    ldi R0.b0, 3", "    ldi R1.b0, 2", "    ldi R2, 0",
        "    loop OUTER_END, R0.b0", "    add R2, R2, 1",
        "    loop INNER_END, R1.b0", "    nop",
        "INNER_END:", "OUTER_END:", "    halt", ""])
    elf = elf_cosim.compile_asm(asm, str(tmp_path), "nested_hardware_loop")
    result = elf_cosim.run_elf_closed_loop(elf, _IdlePins(), max_steps=100)
    assert result.halted, "nested-loop red arm did not halt"
    assert result.registers[2] == 1, (
        "nested PRU hardware LOOP red arm should fall out of the outer loop after "
        f"one iteration, got R2={result.registers[2]}")


_CONTROL_ASM = "\n".join([
    "    .global main", '    .sect ".text"', "main:",
    "    ldi R0.b0, 3", "    ldi R2, 0",
    "    loop END, R0.b0", "    add R2, R2, 1", "    nop",
    "END:", "    halt", ""])


@pytest.mark.skipif(not HAVE_ELF, reason="clpru or TI pru-simulator missing")
def test_real_pru_elf_control_single_loop_runs_outer_body_three_times(tmp_path):
    """CONTROL ARM: the same asm without nesting runs R2==3, so R2==1 above is the nesting."""
    elf = elf_cosim.compile_asm(_CONTROL_ASM, str(tmp_path), "single_hardware_loop")
    result = elf_cosim.run_elf_closed_loop(elf, _IdlePins(), max_steps=100)
    assert result.halted, "single-loop control did not halt"
    assert result.registers[2] == 3, f"single hardware LOOP control should run 3 times, got R2={result.registers[2]}"
