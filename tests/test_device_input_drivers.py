"""the device-input driver check covers every PRU-driven device model, not only SSI/BiSS-C.

made a second driver of an SSI/BiSS-C encoder's clock pad an error. Every other kind with a PRU-driven input pad
(EnDat CLOCK, sigma-delta CLK, SPI ADC SCLK/MOSI/CS, STEP/DIR/EN, WS2812 DATA, MDIO's MDC, BiSS Line MASTER) was unchecked:
a Device Model endat on clock 0 with a second block clocking GPO0 was clean in SysConfig and CI and failed on the simulator.

THE RULE (device_model_table.js DRIVER_BLOCKS, one explicit list; the matching rule per kind is stated there): per kind, per PRU-driven pad, the block modules that legitimately drive it. A `via` rule matches an INSTANCE to the
device by pin (EnDat: dataRxPin == the device's DATA pin; sigma-delta: the PDM block's dataPin; SPI CS: "CS Signal"; MDIO:
mdioBit) - not by module, because a second instance of the reader module must still count as a foreign driver.
A module wildcard is used only where the pad itself names the instance (WS2812, STEP/DIR) or the bus is shared by design (SPI
SCLK/MOSI; the chip is selected by CS, which is matched exactly). BiSS Line has no block at all, so it is judged by count.

Per kind with a model on the simulator the chain test builds the real clpru ELF and runs TI pru-simulator:
  endat       closed loop (real EnDat model through the RS-485 transceiver). `gmake sim` cannot judge EnDat at all - it
              attaches the model without a transceiver, so even the clean design FAILs with 'unsupported mode command'.
  sigma_delta `gmake sim` (no decoder for the kind: RESULT NOT CHECKED) plus a hand-written oracle for the PDM word.
  bissline    attachable but no block speaks it: nothing to run; GUI/CI verdict only.
  spi_adc, step_dir, ws2812, mdio_phy   pru_device_models models with no `nets`: the simulator REFUSES them. test_untestable_* pins the exact
              message, so the day the simulator gains them this goes red and asks for a sim arm. GUI/CI verdict proven for each.

Every red arm asserts specific text and is paired with a green arm of the same shape; every kind has a mutant (its entry
removed from DRIVER_BLOCKS) that must turn its red test red BY NAME. Chain tests need PRU_SIMULATOR_PATH (they SKIP without it).
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_device_model import (CLI, DESIGN, FW, NODE, ROOT, SIM, example_copy, needs_chain,  # noqa: E402
                                      needs_sysconfig, run_make)
from test_device_input_driver import ci, gui, needs_node, two_ssi_text, write  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

TABLE = Path(".metadata") / "sysconfig" / ".meta" / "pru_blocks" / "common" / "device_model_table.js"
STATIC_PREFIX = "error: /pru_blocks/common/pru_blocks_static_module: "
WARNING_PREFIX = "warning: /pru_blocks/common/pru_blocks_static_module: "
CI_ERROR = "device input driven by a foreign block: "
CI_WARNING = "device input warning: "

HDR = '''/**
 * @cliArgs --device "AM243x_ALX_beta" --package "ALX" --part "ALX" --context "icss_g0_pru0" --product "PRU_NO_CODE_TOOL@01.00.01"
 */
const sim = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");
sim.pruCyclesToSimulate = 60000;
'''


# --------------------------------------------------------------------------------------------------------------------
# design builders
# --------------------------------------------------------------------------------------------------------------------
def mod(var, path):
    return 'const %sM = scripting.addModule("/pru_blocks/%s", {}, false);\nconst %s = %sM.addInstance();\n' % (var, path, var, var)


def lit(v):
    return str(v).lower() if isinstance(v, bool) else str(v) if isinstance(v, (int, float)) else '"%s"' % v


def inst(var, path, name, **kw):
    s = mod(var, path) + '%s.$name = "%s";\n' % (var, name)
    for k, v in kw.items():
        k = k.replace("__", " ")
        v = str(v) if "Signal" in k else v
        s += ('%s["%s"] = %s;\n' if " " in k else '%s.%s = %s;\n') % (var, k, lit(v))
    return s


def chain(names):
    return "".join('scripting.connect(%s, "next", %s, "prev");\n' % (a, b) for a, b in zip(names, names[1:]))


def halt():
    return inst("halt", "program_control/flow_control_block", "Halt", opCode="HALT")


def foreign_spi(name, sclk, sdo, cs, var="fs"):
    """A sequential pru_spi_write fed by a constant: (text, [blocks in control-flow order])."""
    s = inst(var + "_k", "data_handling/load_constant_block", name + "_Payload", constant1=1)
    s += inst(var, "pru_io_blocks/pru_spi_write", name, SCLK__Signal=sclk, SDO__Signal=sdo, CS__Signal=cs, packetSize=8)
    s += 'scripting.connect(%s_k, "output1", %s, "input1");\n' % (var, var)
    return s, [var + "_k", var]


def device(kind, **kw):
    s = mod("dm", "utils/device_model_block") + 'dm.$name = "Dev_Model";\ndm.deviceKind = "%s";\n' % kind
    return s + "".join("dm.%s = %s;\n" % (k, lit(v)) for k, v in kw.items())


def flow(blocks, text, order):
    return HDR + text + halt() + chain(order + ["halt"])


def endat(foreign, order="after"):
    """EnDat initiator (CLOCK 0, TX 1, RX 2, DE 3) and a Device Model endat on its DATA pin 2 / CLOCK pin 0."""
    s = inst("endat", "application_specific/endat_initiator_block", "Endat_Read", clkPin=0, dataTxPin=1, dataRxPin=2, dataEnPin=3)
    c = ["endat"]
    if foreign:
        t, v = foreign_spi("Foreign_SPI", 0, 4, 5)
        s += t
        c = v + c if order == "before" else c + v
    return flow(None, s, c) + device("endat", endat_dataPin=2, endat_clockPin=0, endat_positionBits=23, endat_position=1)


def sigma_delta(foreign):
    """PDM microphone reader (CLK 1, DATA 2) on a Device Model sigma_delta; the foreign SPI write clocks GPO1 BEFORE the read."""
    s = inst("pdm", "pru_io_blocks/pdm_block", "PDM_Read", clkPin="1", dataPin="2", dataRegister="R5")
    c = ["pdm"]
    if foreign:
        t, v = foreign_spi("Foreign_SPI", 1, 4, 5)
        s += t
        c = v + c
    return flow(None, s, c) + device("sigma_delta", sigma_delta_dataPin=2, sigma_delta_clkPin=1, sigma_delta_initialInput=0.3)


def spi_adc(foreign=None):
    """SPI transfer (SCLK 0, MISO 1, MOSI 2, CS 3) on a Device Model spi_adc; foreign in sclk | sdo | cs | None."""
    s = inst("xk", "data_handling/load_constant_block", "Adc_Command", constant1=0)
    s += inst("xfer", "pru_io_blocks/pru_spi_transfer", "Adc_Read", SCLK__Signal=0, SDI__Signal=1, SDO__Signal=2, CS__Signal=3, packetSize=16)
    s += 'scripting.connect(xk, "output1", xfer, "input1");\n'
    c = ["xk", "xfer"]
    if foreign in ("sclk", "sdo"):
        s += inst("fw", "pru_io_blocks/ws2812_block", "Foreign_WS", pinId="0" if foreign == "sclk" else "2")
        c.append("fw")
    elif foreign == "cs":
        t, v = foreign_spi("Foreign_SPI", 6, 3, 7)
        s += t
        c += v
    return flow(None, s, c) + device("spi_adc", spi_adc_sdiPin=1, spi_adc_sclkPin=0, spi_adc_sdoPin=2, spi_adc_csPin=3)


def step_dir(foreign):
    s = inst("stp", "pru_io_blocks/stepper_block", "Axis_Step", stepPin="5", dirPin="6")
    c = ["stp"]
    if foreign:
        t, v = foreign_spi("Foreign_SPI", 5, 8, 9)
        s += t
        c += v
    return flow(None, s, c) + device("step_dir", step_dir_stepPin=5, step_dir_dirPin=6)


def ws2812(foreign):
    s = inst("ws", "pru_io_blocks/ws2812_block", "Led_String", pinId="0")
    c = ["ws"]
    if foreign:
        t, v = foreign_spi("Foreign_SPI", 0, 4, 5)
        s += t
        c += v
    return flow(None, s, c) + device("ws2812", ws2812_dataPin=0)


def mdio_phy(foreign):
    s = inst("mdio", "pru_io_blocks/mdio_master_block", "Mdio_Read", mdcBit="0", mdioBit="1")
    c = ["mdio"]
    if foreign:
        t, v = foreign_spi("Foreign_SPI", 0, 4, 5)
        s += t
        c += v
    return flow(None, s, c) + device("mdio_phy", mdio_phy_mdioPin=1, mdio_phy_mdcPin=0)


def bissline(drivers):
    """BiSS Line master clock on GPO0. No block speaks BiSS Line, so the drivers are hand-built generators."""
    s, c = "", []
    if drivers >= 1:
        s += inst("ws", "pru_io_blocks/ws2812_block", "Hand_Clock_A", pinId="0")
        c.append("ws")
    if drivers >= 2:
        t, v = foreign_spi("Hand_Clock_B", 0, 4, 5)
        s += t
        c += v
    return flow(None, s, c) + device("bissline", bissline_slavePin=1, bissline_masterPin=0)


# kind -> (red builder, green builder, GUI/CI fragments of the red message, severity of the red verdict)
CASES = {
    "endat": (lambda: endat(True), lambda: endat(False), [
        "GPO0 feeds the CLOCK pin of device 'Dev_Model' (endat, read by Endat_Read, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO0",
        "the EnDat device sees that block's output as extra input edges (extra clocks)",
        "Move 'Foreign_SPI' to a free GPO."], "error"),
    "sigma_delta": (lambda: sigma_delta(True), lambda: sigma_delta(False), [
        "GPO1 feeds the CLK pin of device 'Dev_Model' (sigma_delta, read by PDM_Read, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO1",
        "the Sigma-delta device sees that block's output as extra input edges (extra clocks)"], "error"),
    "spi_adc_sclk": (lambda: spi_adc("sclk"), lambda: spi_adc(None), [
        "GPO0 feeds the SCLK pin of device 'Dev_Model' (spi_adc, driven by Adc_Read, Device Model block)",
        "but 'Foreign_WS' (ws2812_block) also drives GPO0", "(extra clocks)"], "error"),
    "spi_adc_mosi": (lambda: spi_adc("sdo"), lambda: spi_adc(None), [
        "GPO2 feeds the MOSI pin (the model calls it sdo_pin) of device 'Dev_Model' (spi_adc, driven by Adc_Read, Device Model block)",
        "but 'Foreign_WS' (ws2812_block) also drives GPO2", "(corrupted data bits)"], "error"),
    "spi_adc_cs": (lambda: spi_adc("cs"), lambda: spi_adc(None), [
        "GPO3 feeds the CS pin of device 'Dev_Model' (spi_adc, driven by Adc_Read, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO3", "(a toggled chip select)"], "error"),
    "step_dir": (lambda: step_dir(True), lambda: step_dir(False), [
        "GPO5 feeds the STEP pin of device 'Dev_Model' (step_dir, driven by Axis_Step, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO5", "(extra steps)"], "error"),
    "ws2812": (lambda: ws2812(True), lambda: ws2812(False), [
        "GPO0 feeds the DATA pin of device 'Dev_Model' (ws2812, driven by Led_String, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO0", "(extra bits)"], "error"),
    "mdio_phy": (lambda: mdio_phy(True), lambda: mdio_phy(False), [
        "GPO0 feeds the MDC pin of device 'Dev_Model' (mdio_phy, read by Mdio_Read, Device Model block)",
        "but 'Foreign_SPI' (pru_spi_write) also drives GPO0",
        "the MDIO device sees that block's output as extra input edges (extra clocks)"], "error"),
    "bissline": (lambda: bissline(2), lambda: bissline(1), [
        "GPO0 feeds the MASTER (clock) pin of device 'Dev_Model' (bissline, Device Model block)",
        "'Hand_Clock_A' (ws2812_block), 'Hand_Clock_B' (pru_spi_write) all drive GPO0",
        "No block in this tool speaks a BiSS Line device"], "warning"),
}
KIND_OF = {"spi_adc_sclk": "spi_adc", "spi_adc_mosi": "spi_adc", "spi_adc_cs": "spi_adc"}


def entry_of(case):
    return KIND_OF.get(case, case)


def message(log, severity, ci_side):
    """The check's message from a GUI or CI log."""
    if ci_side:
        marker = CI_ERROR if severity == "error" else CI_WARNING
        line = next(l for l in log.splitlines() if marker in l)
        return line.split(marker, 1)[1]
    prefix = STATIC_PREFIX if severity == "error" else WARNING_PREFIX
    line = next(l for l in log.splitlines() if l.startswith(prefix) and "GPO" in l)
    return line[len(prefix):]


def assert_has(log, fragments):
    for fragment in fragments:
        assert fragment in log, "missing %r in:\n%s" % (fragment, log)


def clean(log):
    return "error:" not in log.lower() and "warning:" not in log.lower().replace(
        "warning: sysconfig has been updated to use standard ti part numbers", "")


# --------------------------------------------------------------------------------------------------------------------
# red / green per kind: SysConfig CLI generation and scripts/check_pin_collisions.js, same text
# --------------------------------------------------------------------------------------------------------------------
@needs_node
@needs_sysconfig
@pytest.mark.parametrize("case", list(CASES))
def test_red_second_driver_is_named_in_sysconfig_and_in_ci(case, tmp_path):
    red, _, fragments, severity = CASES[case]
    design = write(tmp_path, "red.syscfg", red())
    code, log = gui(design, tmp_path)
    ci_code, ci_log = ci(design)
    assert_has(log, fragments)
    assert_has(ci_log, fragments)
    if severity == "error":
        assert code != 0 and ci_code == 1, (code, log, ci_code, ci_log)
        assert "1 error(s)" in log, log
    else:
        assert code == 0 and ci_code == 0, (code, log, ci_code, ci_log)
        assert "WARNING:" in ci_log, ci_log
    assert message(log, severity, False) == message(ci_log, severity, True)


@needs_node
@needs_sysconfig
@pytest.mark.parametrize("case", list(CASES))
def test_green_legitimate_driver_only_is_clean_in_sysconfig_and_in_ci(case, tmp_path):
    _, green, _, _ = CASES[case]
    design = write(tmp_path, "green.syscfg", green())
    code, log = gui(design, tmp_path)
    assert code == 0 and clean(log), log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "All files passed pin collision check." in ci_log and "WARNING" not in ci_log, ci_log


# --------------------------------------------------------------------------------------------------------------------
# mutants: remove the kind's DRIVER_BLOCKS entry in a patched copy; its red test must fail BY NAME
# --------------------------------------------------------------------------------------------------------------------
def without_entry(tmp_path, kind):
    copy = tmp_path / ("meta_" + uuid.uuid4().hex)
    shutil.copytree(ROOT / ".metadata", copy)
    table = copy / "sysconfig" / ".meta" / "pru_blocks" / "common" / "device_model_table.js"
    text = table.read_bytes().decode("utf-8")
    anchor = "/** The device's pin for `key`"
    assert text.count(anchor) == 1
    patched = text.replace(anchor, 'delete DRIVER_BLOCKS["%s"];\n\n%s' % (kind, anchor)).replace("\r\n", "\n")
    table.write_bytes(patched.encode("utf-8"))
    return copy


@needs_node
@needs_sysconfig
@pytest.mark.parametrize("case", list(CASES))
def test_mutant_without_the_kinds_entry_lets_the_red_design_through_and_the_red_test_fails_by_name(case, tmp_path):
    red, _, fragments, severity = CASES[case]
    meta = without_entry(tmp_path, entry_of(case))
    design = write(tmp_path, "red.syscfg", red())
    code, log = gui(design, tmp_path, metadata=meta)
    assert code == 0, "mutant should generate the red design, got:\n" + log
    with pytest.raises(AssertionError, match=re.escape('missing "%s' % fragments[0][:40])):
        assert_has(log, fragments)
    ci_code, ci_log = ci(design, metadata_root=meta)
    assert ci_code == 0, ci_log
    with pytest.raises(AssertionError, match=re.escape('missing "%s' % fragments[0][:40])):
        assert_has(ci_log, fragments)


# --------------------------------------------------------------------------------------------------------------------
# the matching rule: an INSTANCE is matched to the device by pin, never by module alone
# --------------------------------------------------------------------------------------------------------------------
def second_endat_text():
    """A second EnDat initiator on the device's clock pad, reading a DIFFERENT data pin (RX 6)."""
    text = endat(False)
    t = inst("e2", "application_specific/endat_initiator_block", "Endat_Second", clkPin=0, dataTxPin=7, dataRxPin=6, dataEnPin=8)
    text = text.replace("const haltM", t + "const haltM", 1)
    return text.replace('scripting.connect(endat, "next", halt, "prev");',
                        'scripting.connect(endat, "next", e2, "prev");\nscripting.connect(e2, "next", halt, "prev");')


@needs_node
@needs_sysconfig
def test_a_second_endat_block_pointing_at_another_data_pin_is_foreign_in_sysconfig_and_in_ci(tmp_path):
    design = write(tmp_path, "two_endat.syscfg", second_endat_text())
    fragments = ["GPO0 feeds the CLOCK pin of device 'Dev_Model' (endat, read by Endat_Read, Device Model block)",
                 "but 'Endat_Second' (endat_initiator_block) also drives GPO0", "Move 'Endat_Second' to a free GPO."]
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, fragments)
    ci_code, ci_log = ci(design)
    assert ci_code == 1, ci_log
    assert_has(ci_log, fragments)
    assert message(log, "error", False) == message(ci_log, "error", True)


@needs_node
@needs_sysconfig
def test_sigma_delta_second_pdm_block_on_another_data_pin_is_foreign(tmp_path):
    text = sigma_delta(False)
    text = text.replace("const haltM", inst("pdm2", "pru_io_blocks/pdm_block", "PDM_Second", clkPin="1", dataPin="6", dataRegister="R6") + "const haltM", 1)
    text = text.replace('scripting.connect(pdm, "next", halt, "prev");',
                        'scripting.connect(pdm, "next", pdm2, "prev");\nscripting.connect(pdm2, "next", halt, "prev");')
    design = write(tmp_path, "two_pdm.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, ["read by PDM_Read", "but 'PDM_Second' (pdm_block) also drives GPO1"])
    ci_code, ci_log = ci(design)
    assert ci_code == 1 and "'PDM_Second' (pdm_block) also drives GPO1" in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_mdio_second_master_on_the_clock_pad_with_another_mdio_pin_is_foreign(tmp_path):
    text = mdio_phy(False)
    text = text.replace("const haltM", inst("m2", "pru_io_blocks/mdio_master_block", "Mdio_Second", mdcBit="0", mdioBit="6") + "const haltM", 1)
    text = text.replace('scripting.connect(mdio, "next", halt, "prev");',
                        'scripting.connect(mdio, "next", m2, "prev");\nscripting.connect(m2, "next", halt, "prev");')
    design = write(tmp_path, "two_mdio.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, ["read by Mdio_Read", "but 'Mdio_Second' (mdio_master_block) also drives GPO0"])
    ci_code, ci_log = ci(design)
    assert ci_code == 1 and "'Mdio_Second' (mdio_master_block) also drives GPO0" in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_a_second_spi_chip_sharing_sclk_and_mosi_is_a_shared_bus_and_stays_clean(tmp_path):
    """SPI SCLK/MOSI are shared between chips by design; the chip is selected by CS, which is matched exactly."""
    text = spi_adc(None)
    t = inst("x2", "pru_io_blocks/pru_spi_transfer", "Other_Chip", SCLK__Signal=0, SDI__Signal=8, SDO__Signal=2, CS__Signal=7, packetSize=16)
    t += 'scripting.connect(xk, "output1", x2, "input1");\n'
    text = text.replace("const haltM", t + "const haltM", 1)
    text = text.replace('scripting.connect(xfer, "next", halt, "prev");', 'scripting.connect(xfer, "next", x2, "prev");\nscripting.connect(x2, "next", halt, "prev");')
    design = write(tmp_path, "two_chips.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code == 0 and clean(log), log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "All files passed pin collision check." in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_multi_axis_motion_block_is_a_legitimate_driver_of_step_dir_and_enable(tmp_path):
    s = inst("ax", "pru_io_blocks/multi_axis_motion_block", "Axes", numAxes=1, stepPin0="5", dirPin0="6", enablePin0="7", eStopPin="9")
    text = flow(None, s, ["ax"]) + device("step_dir", step_dir_stepPin=5, step_dir_dirPin=6, step_dir_enPin=7)
    design = write(tmp_path, "axes.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code == 0 and "also drives GPO" not in log and "error:" not in log.lower(), log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "device input" not in ci_log, ci_log


# --------------------------------------------------------------------------------------------------------------------
# no-reader stays a WARNING; hand-off with no device stays clean; one hand-built generator of an unspoken device is clean
# --------------------------------------------------------------------------------------------------------------------
def no_reader_text(kind="endat"):
    """Device Model endat, NO EnDat block, an unrelated SPI write on GPO0 (could be a hand-built clock)."""
    t, c = foreign_spi("Foreign_SPI", 0, 4, 5)
    return flow(None, t, c) + device("endat", endat_dataPin=2, endat_clockPin=0)


@needs_node
@needs_sysconfig
def test_no_reader_in_the_design_is_a_warning_for_endat_in_sysconfig_and_in_ci(tmp_path):
    design = write(tmp_path, "no_reader.syscfg", no_reader_text())
    fragments = ["No reader block was found for device 'Dev_Model' (endat, Device Model block)",
                 "'Foreign_SPI' (pru_spi_write) also drives GPO0"]
    code, log = gui(design, tmp_path)
    assert code == 0 and "error:" not in log.lower(), log
    assert any(l.lower().startswith("warning") for l in log.splitlines() if "No reader block was found" in l), log
    assert_has(log, fragments)
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "All files passed pin collision check." in ci_log and "WARNING:" in ci_log, ci_log
    assert_has(ci_log, fragments)


@needs_node
@needs_sysconfig
def test_sequential_handoff_with_no_device_on_the_pad_stays_clean(tmp_path):
    t, c = foreign_spi("Spi_A", 0, 4, 5, var="fa")
    t2, c2 = foreign_spi("Spi_B", 0, 6, 7, var="fb")
    text = flow(None, t + t2, c + c2)
    design = write(tmp_path, "handoff.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code == 0 and clean(log), log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "device input" not in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_ws2812_device_with_a_single_hand_built_driver_of_an_unspoken_kind_is_clean_for_bissline(tmp_path):
    """BiSS Line has no block: one driver on the MASTER pad is the hand-built generator (green arm of the warning test)."""
    design = write(tmp_path, "one_driver.syscfg", bissline(1))
    code, log = gui(design, tmp_path)
    assert code == 0 and clean(log), log


# --------------------------------------------------------------------------------------------------------------------
# the GPI route (Simulation Settings device fields) reaches the same function, CS pad included (deviceParams JSON)
# --------------------------------------------------------------------------------------------------------------------
def spi_adc_gpi_text(foreign_on_cs):
    s = inst("xk", "data_handling/load_constant_block", "Adc_Command", constant1=0)
    s += inst("xfer", "pru_io_blocks/pru_spi_transfer", "Adc_Read", SCLK__Signal=0, SDI__Signal=1, SDO__Signal=2, CS__Signal=3, packetSize=16)
    s += 'scripting.connect(xk, "output1", xfer, "input1");\n'
    c = ["xk", "xfer"]
    if foreign_on_cs:
        t, v = foreign_spi("Foreign_SPI", 6, 3, 7)
        s += t
        c += v
    text = flow(None, s, c)
    return text.replace("sim.pruCyclesToSimulate = 60000;\n", """sim.pruCyclesToSimulate = 60000;
sim.signalsToDisplayR31 = ["1"];
sim.gpi1_inputMode       = "device";
sim.gpi1_deviceKind      = "spi_adc";
sim.gpi1_deviceClockPin  = 0;
sim.gpi1_deviceIndexPin  = 2;
sim.gpi1_deviceParams    = '{"cs_pin":3}';
""")


@needs_node
@needs_sysconfig
def test_gpi_device_spi_adc_cs_pad_second_driver_is_named_in_sysconfig_and_in_ci(tmp_path):
    """The CS pin travels in gpiN_deviceParams (no GUI slot). spi_adc is not a ported GPI kind, so SysConfig also refuses the
    binding for that reason (an unrelated error); the point here is that the CS pad is read from the JSON and judged."""
    fragments = ["GPO3 feeds the CS pin of device 'GPI1 device' (spi_adc, driven by Adc_Read, Simulation Settings GPI device)",
                 "but 'Foreign_SPI' (pru_spi_write) also drives GPO3"]
    design = write(tmp_path, "gpi_red.syscfg", spi_adc_gpi_text(True))
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, fragments)
    ci_code, ci_log = ci(design)
    assert ci_code == 1, ci_log
    assert_has(ci_log, fragments)
    design = write(tmp_path, "gpi_green.syscfg", spi_adc_gpi_text(False))
    code, log = gui(design, tmp_path)
    assert "also drives GPO" not in log, log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "device input" not in ci_log, ci_log


def sigma_delta_gpi_text(foreign):
    text = sigma_delta(foreign)
    text = text[:text.index("const dmM")]
    return text.replace("sim.pruCyclesToSimulate = 60000;" + chr(10), """sim.pruCyclesToSimulate = 60000;
sim.signalsToDisplayR31 = ["2"];
sim.gpi2_inputMode       = "device";
sim.gpi2_deviceKind      = "sigma_delta";
sim.gpi2_deviceClockPin  = 1;
""")


@needs_node
@needs_sysconfig
def test_gpi_device_sigma_delta_second_driver_is_an_error_in_sysconfig_and_in_ci(tmp_path):
    fragments = ["GPO1 feeds the CLK pin of device 'GPI2 device' (sigma_delta, read by PDM_Read, Simulation Settings GPI device)",
                 "but 'Foreign_SPI' (pru_spi_write) also drives GPO1"]
    design = write(tmp_path, "gpi_sd_red.syscfg", sigma_delta_gpi_text(True))
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, fragments)
    ci_code, ci_log = ci(design)
    assert ci_code == 1, ci_log
    assert_has(ci_log, fragments)
    design = write(tmp_path, "gpi_sd_green.syscfg", sigma_delta_gpi_text(False))
    code, log = gui(design, tmp_path)
    # the GPI route also prints the unrelated 'GUI JS preview only' warning; the check itself must say nothing
    assert code == 0 and "error:" not in log.lower() and "also drives GPO" not in log, log
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "device input" not in ci_log, ci_log


# --------------------------------------------------------------------------------------------------------------------
# two readers of one device, and the reader's own clock on another pad
# --------------------------------------------------------------------------------------------------------------------
TWO_READERS_FRAGMENTS = ["2 blocks (SSI_Encoder_Read, SSI_Second) read device 'Encoder_Model' (ssi, Device Model block)",
                         "Put a Delay longer than the encoder's recovery time between them"]


@needs_node
@needs_sysconfig
def test_two_blocks_reading_one_encoder_is_a_warning_in_sysconfig_and_in_ci(tmp_path):
    """S-A: both blocks are readers (not foreign), so the design stays generable - but the sim FAILs it (next test)."""
    design = write(tmp_path, "two_readers.syscfg", two_ssi_text(1))
    code, log = gui(design, tmp_path)
    assert code == 0 and "error:" not in log.lower(), log
    assert any(l.lower().startswith("warning") and "read device 'Encoder_Model'" in l for l in log.splitlines()), log
    assert_has(log, TWO_READERS_FRAGMENTS)
    ci_code, ci_log = ci(design)
    assert ci_code == 0 and "WARNING:" in ci_log, ci_log
    assert_has(ci_log, TWO_READERS_FRAGMENTS)


@needs_chain
def test_two_readers_design_really_fails_on_the_simulator(tmp_path):
    """Why S-A is a warning at all: back-to-back reads of one SSI encoder FAIL `gmake sim` (extra clocks inside the monoflop)."""
    with example_copy() as path:
        (path / DESIGN).write_text(two_ssi_text(1), encoding="utf-8")
        code, out = run_make(path, "all")
        assert code == 0, out
        code, out = run_make(path, "sim")
        assert "RESULT: FAIL" in out and "clock continued past the end of the 25-bit word" in out, out


@needs_node
@needs_sysconfig
def test_message_says_the_matched_reader_clocks_another_pad(tmp_path):
    """The reader (matched by DATA pin) clocks GPO4; SSI_Second clocks the device's pad GPO0. It is still an error,
    and the message says which block is mis-wired instead of only blaming SSI_Second."""
    text = two_ssi_text(3).replace('ssi_initiator_block1.$name = "SSI_Encoder_Read";',
                                   'ssi_initiator_block1.$name = "SSI_Encoder_Read";\nssi_initiator_block1.clkPin = 4;')
    assert "clkPin = 4" in text
    design = write(tmp_path, "f1.syscfg", text)
    fragments = ["but 'SSI_Second' (ssi_initiator_block) also drives GPO0",
                 "Note: 'SSI_Encoder_Read' is matched to this device but puts its clkPin on GPO4, not on the device's CLK pin (GPO0)",
                 "move 'SSI_Encoder_Read' to GPO0 and leave 'SSI_Second' where it is."]
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_has(log, fragments)
    ci_code, ci_log = ci(design)
    assert ci_code == 1, ci_log
    assert_has(ci_log, fragments)


def patched_metadata(tmp_path, old, new):
    """Copy of .metadata with one line of device_model_table.js replaced (line-ending agnostic)."""
    copy = tmp_path / ("meta_" + uuid.uuid4().hex)
    shutil.copytree(ROOT / ".metadata", copy)
    table = copy / "sysconfig" / ".meta" / "pru_blocks" / "common" / "device_model_table.js"
    text = table.read_bytes().decode("utf-8").replace("\r\n", "\n")
    assert text.count(old) == 1, old
    table.write_bytes(text.replace(old, new).encode("utf-8"))
    return copy


@needs_node
@needs_sysconfig
def test_mutant_without_the_two_readers_warning_fails_the_s_a_test_by_name(tmp_path):
    meta = patched_metadata(tmp_path, "if (rules.frameBased) {", "if (false) {")
    design = write(tmp_path, "two_readers.syscfg", two_ssi_text(1))
    code, log = gui(design, tmp_path, metadata=meta)
    assert code == 0, log
    with pytest.raises(AssertionError, match=re.escape('missing "2 blocks (SSI_Encoder_Read, SSI_Second) read device')):
        assert_has(log, TWO_READERS_FRAGMENTS)


@needs_node
@needs_sysconfig
def test_mutant_without_the_f1_note_fails_the_f1_test_by_name(tmp_path):
    meta = patched_metadata(tmp_path, "const note = (matched.length && !matched.some(function (m) { return m.driven === l.pin; }))",
                            "const note = (false && !matched.some(function (m) { return m.driven === l.pin; }))")
    text = two_ssi_text(3).replace('ssi_initiator_block1.$name = "SSI_Encoder_Read";',
                                   'ssi_initiator_block1.$name = "SSI_Encoder_Read";\nssi_initiator_block1.clkPin = 4;')
    design = write(tmp_path, "f1.syscfg", text)
    code, log = gui(design, tmp_path, metadata=meta)
    assert code != 0 and "but 'SSI_Second' (ssi_initiator_block) also drives GPO0" in log, log
    assert "Note: 'SSI_Encoder_Read' is matched" not in log, log


# --------------------------------------------------------------------------------------------------------------------
# the simulator: build the real clpru ELF of a design and run TI pru-simulator
# --------------------------------------------------------------------------------------------------------------------
def build_elf(tmp_path, text, metadata=None):
    """SysConfig CLI (with `metadata`'s checks if given) + clpru, the way. Returns (elf, syscfg output dir)."""
    work = tmp_path / ("b_" + uuid.uuid4().hex)
    out = work / "out"
    work.mkdir()
    design = work / "d.syscfg"
    design.write_text(text, encoding="utf-8")
    product = (metadata or ROOT / ".metadata") / "product.json"
    env = dict(os.environ)
    res = subprocess.run([str(NODE), str(CLI), "--product", str(product), "--device", "AM243x_ALX_beta", "--context", "icss_g0_pru0",
                          "--part", "ALX", "--package", "ALX", "--output", str(out), str(design)],
                         capture_output=True, text=True, env=env)
    assert res.returncode == 0 and "Generating Code" in res.stdout, res.stdout + res.stderr
    (out / "main.asm").write_text(
        "    .retain\n    .retainrefs\n    .global     main\n    .ref        sysconfig_generated_start\n"
        '    .sect       ".text:main"\nmain:\n    jmp     sysconfig_generated_start\n'
        "    .global sysconfig_generated_end\nsysconfig_generated_end:\n    halt\n", encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    for args in (["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"],
                 ["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd", "--entry_point=main", "-o", "main.out"]):
        res = subprocess.run([elf_cosim.find_clpru()] + args, cwd=out, text=True, capture_output=True)
        assert res.returncode == 0, res.stdout + res.stderr
    return out / "main.out", out


def bound_sim(elf, out):
    """`gmake sim`'s two steps on a built ELF: extract the manifest, run the bound devices. Returns (rc, output)."""
    manifest = out / "pru_device_bindings.json"
    env = dict(os.environ, PRU_SIMULATOR_PATH=str(SIM))
    res = subprocess.run([sys.executable, str(ROOT / "scripts" / "sim" / "extract_device_bindings.py"), str(out / "pru_syscfg.asm"), str(manifest)],
                         capture_output=True, text=True, env=env)
    assert res.returncode == 0, res.stdout + res.stderr
    res = subprocess.run([sys.executable, str(ROOT / "scripts" / "sim" / "run_bound_devices.py"), str(elf), str(manifest)],
                         capture_output=True, text=True, env=env)
    return res.returncode, res.stdout + res.stderr


def register(out, number):
    return int(re.search(r"^\s*R%d: (\d+)" % number, out, re.M).group(1))


def sd_oracle():
    """Hand-written oracle for the PDM word: the sigma-delta model driven by 32 ideal clock pulses, packed MSB first."""
    # The repo has its own pru_io package; the simulator's must be imported in its namespace (as the harness does),
    # or a test that imported the repo's first makes this a ModuleNotFoundError in a full-suite run.
    with elf_cosim._sim_namespace(elf_cosim.find_pru_simulator()):
        from pru_io.sd_modulator_device import SigmaDeltaModulator
        model = SigmaDeltaModulator(clk_pin=1, data_pin=2, initial_input=0.3)
        cycle = 0
        model.tick(cycle, 0)
        for _ in range(32):
            cycle += 49
            model.tick(cycle, 2)
            cycle += 49
            model.tick(cycle, 0)
        return int("".join(str(b) for b in model._bits[:32]), 2)


SD_WORD = 3050760043   # pinned copy of the oracle's value: a drift in the model fails sd_oracle_is_pinned below


@needs_chain
def test_sd_oracle_is_pinned():
    assert sd_oracle() == SD_WORD


@needs_chain
def test_sigma_delta_green_design_sims_the_oracle_word_through_gmake_sim(tmp_path):
    with example_copy() as path:
        (path / DESIGN).write_text(sigma_delta(False), encoding="utf-8")
        code, out = run_make(path, "all")
        assert code == 0, out
        code, out = run_make(path, "sim")
        assert "FAULTS: None" in out and "Events: 32" in out, out
        assert "NOT CHECKED (sigma_delta)" in out, "gmake sim has no decoder for sigma_delta: it must say so, not PASS\n" + out
        assert register(out, 5) == SD_WORD, out


@needs_chain
def test_sigma_delta_red_design_fails_the_oracle_when_the_check_is_removed(tmp_path):
    """The design the check rejects, generated with the kind's entry removed: the foreign SPI write's 8 extra clock edges reach
    the modulator before the PDM read, so R5 is not the oracle word and the model saw 40 clock events instead of 32."""
    elf, out = build_elf(tmp_path, sigma_delta(True), metadata=without_entry(tmp_path, "sigma_delta"))
    rc, text = bound_sim(elf, out)
    assert "Events: 40" in text and register(text, 5) != SD_WORD, text
    assert register(text, 5) == 3605490605, text


ENDAT_RED_FRAGMENT = "clock half period 7 < min 50"


def endat_closed_loop(elf):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import test_endat_framing as e179
    return e179, e179.run(elf, 1)


@needs_chain
def test_endat_green_design_decodes_position_1_with_no_model_faults(tmp_path):
    elf, _ = build_elf(tmp_path, endat(False))
    e179, run = endat_closed_loop(elf)
    e179.assert_decoded(run, 1)
    assert run.halted and run.status == 0 and not run.faults, (run.status, run.faults)


@needs_chain
def test_endat_red_design_gets_model_faults_when_the_check_is_removed(tmp_path):
    """Second SPI block clocking the EnDat CLOCK pad after the read, built with the kind's entry removed: the EnDat model
    reports half-period faults (the failure class). `gmake sim` cannot show this: it FAILs the clean design too."""
    elf, _ = build_elf(tmp_path, endat(True), metadata=without_entry(tmp_path, "endat"))
    _, run = endat_closed_loop(elf)
    assert any(ENDAT_RED_FRAGMENT in f for f in run.faults), (run.status, run.faults)


@needs_chain
def test_endat_red_design_before_the_read_corrupts_the_telegram_when_the_check_is_removed(tmp_path):
    elf, _ = build_elf(tmp_path, endat(True, order="before"), metadata=without_entry(tmp_path, "endat"))
    _, run = endat_closed_loop(elf)
    assert run.status != 0 and run.faults, (run.status, run.faults)


@needs_chain
@pytest.mark.parametrize("kind,build,refused", [
    ("spi_adc", lambda: spi_adc(None), "(pru_device_models.spi_adc.SpiAdc)"),
    ("step_dir", lambda: step_dir(False), "(pru_device_models.step_dir_driver.StepDirDriver)"),
    ("ws2812", lambda: ws2812(False), "(pru_device_models.ws2812_string.Ws2812String)"),
    ("mdio_phy", lambda: mdio_phy(False), "(pru_device_models.mdio_phy_model.MdioPhyModel)")])
def test_untestable_on_the_simulator_kinds_are_refused_with_the_exact_message(tmp_path, kind, build, refused):
    """spi_adc, step_dir, ws2812, mdio_phy use the pru_device_models.device_model contract with no `nets`. The check for them is proven
    in SysConfig/CI only. When this test goes red the simulator gained the kind: add a sim arm."""
    elf, out = build_elf(tmp_path, build())
    rc, text = bound_sim(elf, out)
    assert rc == 2, text
    assert ("REFUSED: device kind '%s' %s uses the pru_device_models.device_model contract with no `nets`; TI pru-simulator's device bus "
            "cannot attach it, so gmake sim does not support this kind yet") % (kind, refused) in text, text
