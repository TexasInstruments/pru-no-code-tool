"""a second block driving the GPO that clocks an attached device model is an ERROR.

Example: SSI Initiator CLK on R30.0, a Device Model SSI encoder listening on pin 0, and a SPI write whose SCLK is
also GPO 0, connected after the SSI read. Without this rule the design generates and builds cleanly, and `gmake sim`
fails with encoder faults (clock period 14 cycles below the encoder's minimum of 20; clock continued past the end of
the 25-bit word).

The duplicate-GPO rule alone does not flag it: it exempts two blocks that are both SEQUENTIAL
(pru_blocks_static_module.syscfg.js validateBidiPinCollisionsGlobal, `if (!cont.length) continue;`; the same line in
scripts/check_pin_collisions.js checkSyscfg). SSI read and SPI write are both sequential, so sharing GPO0 is a
hand-off while nothing listens on the pad; an attached device listens on it.

THE RULE: a GPO that feeds an input pin of an attached device (Device Model block, or a Simulation Settings GPI device)
may be driven only by that device's reader. The reader is the block READER_BLOCKS names for the kind whose data pin is
the device's primary pin (the pairing the manifest `readers` record and the Device Model "Read by" field use). When a
reader exists every other driver of the pad - another SSI block with a different data pin included - is an ERROR. With
no reader at all a block of the reader module is taken as the intended (mis-wired) reader and a foreign block is only a
WARNING. The other kinds (EnDat, sigma-delta, SPI ADC, STEP/DIR, WS2812, MDIO, BiSS Line) are checked in
tests/test_device_input_drivers.py. The GUI and the command-line pin check call one function,
device_model_table.js findDeviceInputConflicts, so they agree by construction; these tests also compare their text.

Every error case asserts specific text. Chain tests need PRU_SIMULATOR_PATH and are reported as SKIPPED without it.
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
from test_device_model import (CLI, DESIGN, FW, NODE, ROOT, SIM, VCD, example_copy, needs_chain,  # noqa: E402
                                      needs_sysconfig, run_make)

FIXTURE = ROOT / "scripts" / "fixtures" / "ssi_clock_pin" / "red_ssi_clock_shared_with_spi.syscfg"
CHECKER = ROOT / "scripts" / "check_pin_collisions.js"
STATIC_PREFIX = "error: /pru_blocks/common/pru_blocks_static_module: "
DEVICE_MODEL_LINES = re.compile(r"^.*device_model_block1?\b.*\n", re.M)

# The error for the red design, as reported for the SSI encoder.
RED_FRAGMENTS = [
    "GPO0 feeds the CLK pin of device 'Encoder_Model' (ssi, read by SSI_Encoder_Read, Device Model block)",
    "but 'PRU0_SPI_Write_0' (pru_spi_write) also drives GPO0",
    "the SSI device sees that block's output as extra input edges (extra clocks)",
    "Move 'PRU0_SPI_Write_0' to a free GPO.",
]
GPI_RED_FRAGMENTS = [
    "GPO0 feeds the CLK pin of device 'GPI1 device' (ssi, read by SSI_Encoder_Read, Simulation Settings GPI device)",
    "but 'PRU0_SPI_Write_0' (pru_spi_write) also drives GPO0",
]

needs_node = pytest.mark.skipif(not (NODE.exists() and CLI.exists()), reason="needs SysConfig 1.28")


def red_text():
    return FIXTURE.read_text(encoding="utf-8")


def green_text():
    """The red design with the SPI SCLK moved to the free GPO 4."""
    text = red_text().replace('pru_spi_write1["SDO Signal"] = "2";',
                              'pru_spi_write1["SCLK Signal"] = "4";\npru_spi_write1["SDO Signal"] = "2";')
    assert 'SCLK Signal"] = "4"' in text
    return text.replace('["0","2","3"]', '["0","2","3","4"]')


def gpi_text():
    """The red design with the encoder attached through Simulation Settings GPI1 instead of a Device Model block."""
    text = DEVICE_MODEL_LINES.sub("", red_text())
    assert "device_model_block" not in text
    marker = 'pru_blocks_static_module.signalsToDisplay = ["0","2","3"];'
    assert marker in text
    return text.replace(marker, marker + """
pru_blocks_static_module.signalsToDisplayR31 = ["1"];
pru_blocks_static_module.gpi1_inputMode       = "device";
pru_blocks_static_module.gpi1_deviceKind      = "ssi";
pru_blocks_static_module.gpi1_deviceClockPin  = 0;
pru_blocks_static_module.gpi1_deviceParams    = '{"bits":25,"position":4321}';""")


def handoff_text():
    """Same two blocks on GPO0 and NO device attached: sequential hand-off, legal as before."""
    text = DEVICE_MODEL_LINES.sub("", red_text())
    assert "device_model" not in text
    return text


def two_ssi_text(second_data_pin):
    """SSI_Encoder_Read (CLK 0, DATA 1) then SSI_Second (CLK 0, DATA second_data_pin) on the Device Model's pads."""
    text = red_text().replace("\r\n", "\n")
    text = re.sub(r"^.*pru_spi_write.*\n", "", text, flags=re.M)
    text = re.sub(r"^.*scripting\.connect.*\n", "", text, flags=re.M)
    text = text.replace('const ssi_initiator_block1     = ssi_initiator_block.addInstance();',
                        'const ssi_initiator_block1     = ssi_initiator_block.addInstance();\n'
                        'const ssi_initiator_block2     = ssi_initiator_block.addInstance();')
    text = text.replace('ssi_initiator_block1.$name = "SSI_Encoder_Read";',
                        'ssi_initiator_block1.$name = "SSI_Encoder_Read";\nssi_initiator_block2.$name = "SSI_Second";\n'
                        'ssi_initiator_block2.dataPin = %d;' % second_data_pin)
    text = text.replace('ssi_initiator_block1.$position = [0,0];',
                        'scripting.connect(ssi_initiator_block1, "next", ssi_initiator_block2, "prev");\n'
                        'ssi_initiator_block1.$position = [0,0];\nssi_initiator_block2.$position = [120,0];')
    text = text.replace('["0","2","3"]', '["0"]')
    assert "SSI_Second" in text and "pru_spi_write" not in text
    return text


def no_reader_text():
    """Simulation Settings GPI1 ssi device, NO SSI block, an unrelated SPI write on GPO0 (could be a hand-built clock)."""
    text = re.sub(r"^.*ssi_initiator_block.*\n", "", gpi_text(), flags=re.M)
    text = re.sub(r"^.*scripting\.connect.*\n", "", text, flags=re.M)
    text = text.replace('const pru_spi_write            = ',
                        'const load_constant_block1     = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false).addInstance();\n'
                        'const pru_spi_write            = ')
    text = text.replace('pru_spi_write1.$name         =', 'load_constant_block1.$name = "Payload";\npru_spi_write1.$name         =')
    text = text.replace('pru_blocks_static_module.signalsToDisplay =', 'scripting.connect(load_constant_block1, "output1", pru_spi_write1, "input1");\n'
                        'scripting.connect(load_constant_block1, "next", pru_spi_write1, "prev");\npru_blocks_static_module.signalsToDisplay =', 1)
    assert "ssi_initiator" not in text and "pru_spi_write1" in text
    return text


SECOND_SSI_FRAGMENTS = [
    "GPO0 feeds the CLK pin of device 'Encoder_Model' (ssi, read by SSI_Encoder_Read, Device Model block)",
    "but 'SSI_Second' (ssi_initiator_block) also drives GPO0",
    "Move 'SSI_Second' to a free GPO.",
]
NO_READER_FRAGMENTS = [
    "No reader block was found for device 'GPI1 device' (ssi, Simulation Settings GPI device)",
    "'PRU0_SPI_Write_0' (pru_spi_write) also drives GPO0",
]


def write(tmp_path, name, text):
    d = tmp_path / ("d_" + uuid.uuid4().hex)
    d.mkdir()
    p = d / name
    p.write_text(text, encoding="utf-8")
    return p


def gui(design, tmp_path, metadata=None):
    """SysConfig CLI generation. Returns (rc, output)."""
    out = tmp_path / ("out_" + uuid.uuid4().hex)
    out.mkdir()
    product = (metadata or ROOT / ".metadata") / "product.json"
    res = subprocess.run(
        [str(NODE), str(CLI), "--product", str(product), "--device", "AM243x_ALX_beta", "--context", "icss_g0_pru0",
         "--part", "ALX", "--package", "ALX", "--output", str(out), str(design)],
        capture_output=True, text=True)
    return res.returncode, res.stdout + res.stderr


def ci(design, metadata_root=None):
    env = dict(os.environ)
    if metadata_root:
        env["PRU_NOCODE_METADATA_ROOT"] = str(metadata_root)
    res = subprocess.run(["node", str(CHECKER), str(design)], capture_output=True, text=True, env=env)
    return res.returncode, res.stdout + res.stderr


def assert_red(log, fragments):
    for fragment in fragments:
        assert fragment in log, "missing %r in:\n%s" % (fragment, log)


def gui_message(log):
    line = next(l for l in log.splitlines() if l.startswith(STATIC_PREFIX) and "also drives GPO" in l)
    return line[len(STATIC_PREFIX):]


def ci_message(log):
    line = next(l for l in log.splitlines() if "device input driven by a foreign block: " in l)
    return line.split("device input driven by a foreign block: ", 1)[1]


# --------------------------------------------------------------------------------------------------------------------
# red arms: GUI error and CI failure, same text
# --------------------------------------------------------------------------------------------------------------------
@needs_node
@needs_sysconfig
def test_red_device_model_block_second_driver_is_an_error_in_sysconfig_and_in_ci(tmp_path):
    design = write(tmp_path, "red.syscfg", red_text())
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_red(log, RED_FRAGMENTS)
    assert "1 error(s)" in log, log
    code, ci_log = ci(design)
    assert code == 1, ci_log
    assert_red(ci_log, RED_FRAGMENTS)
    assert gui_message(log) == ci_message(ci_log), (gui_message(log), ci_message(ci_log))


@needs_node
@needs_sysconfig
def test_red_simulation_settings_gpi_device_second_driver_is_an_error_in_sysconfig_and_in_ci(tmp_path):
    design = write(tmp_path, "red_gpi.syscfg", gpi_text())
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_red(log, GPI_RED_FRAGMENTS)
    code, ci_log = ci(design)
    assert code == 1, ci_log
    assert_red(ci_log, GPI_RED_FRAGMENTS)
    assert gui_message(log) == ci_message(ci_log), (gui_message(log), ci_message(ci_log))


# --------------------------------------------------------------------------------------------------------------------
# green / control arms
# --------------------------------------------------------------------------------------------------------------------
@needs_node
@needs_sysconfig
def test_green_sclk_on_a_free_gpo_is_clean_in_sysconfig_and_in_ci(tmp_path):
    design = write(tmp_path, "green.syscfg", green_text())
    code, log = gui(design, tmp_path)
    assert code == 0 and "error:" not in log.lower() and "warning:" not in log.lower(), log
    code, ci_log = ci(design)
    assert code == 0 and "All files passed pin collision check." in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_sequential_handoff_of_one_gpo_with_no_device_attached_stays_allowed(tmp_path):
    design = write(tmp_path, "handoff.syscfg", handoff_text())
    code, log = gui(design, tmp_path)
    assert code == 0 and "error:" not in log.lower() and "warning:" not in log.lower(), log
    code, ci_log = ci(design)
    assert code == 0 and "All files passed pin collision check." in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_a_reader_block_with_a_mismatched_data_pin_is_not_a_foreign_driver(tmp_path):
    """red arm points the SSI block at the wrong DATA pin on purpose (the simulator then reports a decode
    mismatch). That block still clocks the device; it is a wiring mistake for the simulator, not a second driver."""
    text = green_text().replace("ssi_initiator_block1.$name", "ssi_initiator_block1.dataPin = 5;\nssi_initiator_block1.$name")
    assert "dataPin = 5" in text
    design = write(tmp_path, "wrong_data_pin.syscfg", text)
    code, log = gui(design, tmp_path)
    assert code == 0 and "also drives GPO" not in log, log
    code, ci_log = ci(design)
    assert code == 0, ci_log


@needs_node
@needs_sysconfig
def test_a_second_ssi_block_with_another_data_pin_on_the_devices_clock_is_an_error_in_sysconfig_and_in_ci(tmp_path):
    """Exempting every block of the reader's module would let SSI_Second clock the device (the simulator FAILs with
    'clock continued past the end of the 25-bit word') while SysConfig and CI stayed clean. Both must report an error."""
    design = write(tmp_path, "two_ssi.syscfg", two_ssi_text(3))
    code, log = gui(design, tmp_path)
    assert code != 0, log
    assert_red(log, SECOND_SSI_FRAGMENTS)
    code, ci_log = ci(design)
    assert code == 1, ci_log
    assert_red(ci_log, SECOND_SSI_FRAGMENTS)
    assert gui_message(log) == ci_message(ci_log), (gui_message(log), ci_message(ci_log))


@needs_node
@needs_sysconfig
def test_two_ssi_blocks_that_both_read_the_device_are_both_readers_and_stay_clean(tmp_path):
    design = write(tmp_path, "two_readers.syscfg", two_ssi_text(1))
    code, log = gui(design, tmp_path)
    assert code == 0 and "also drives GPO" not in log and "error:" not in log.lower(), log
    code, ci_log = ci(design)
    assert code == 0 and "All files passed pin collision check." in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_no_reader_in_the_design_downgrades_a_second_driver_to_a_warning_in_sysconfig_and_in_ci(tmp_path):
    """Without a reader block the check cannot tell a foreign driver from a hand-built clock generator: warn, still generate."""
    design = write(tmp_path, "no_reader.syscfg", no_reader_text())
    code, log = gui(design, tmp_path)
    assert code == 0 and "error:" not in log.lower(), log
    assert any(l.lower().startswith("warning") for l in log.splitlines() if "No reader block was found" in l), log
    assert_red(log, NO_READER_FRAGMENTS)
    code, ci_log = ci(design)
    assert code == 0 and "All files passed pin collision check." in ci_log, ci_log
    assert_red(ci_log, NO_READER_FRAGMENTS)
    assert "WARNING:" in ci_log, ci_log


@needs_node
@needs_sysconfig
def test_two_spi_blocks_sharing_the_spi_adc_sclk_are_a_shared_bus_and_stay_clean(tmp_path):
    """widened the check to spi_adc (tests/test_device_input_drivers.py). SPI SCLK is shared between chips by
    design - the chip is selected by CS, which is matched exactly - so two SPI blocks on the pad a Device Model spi_adc
    listens on stay clean. (pinned this as a 'known gap'; it is now the stated rule.)"""
    text = green_text()
    text = DEVICE_MODEL_LINES.sub("", text)
    text += '''
const pru_spi_write2 = pru_spi_write.addInstance();
pru_spi_write2.$name = "PRU0_SPI_Write_2";
pru_spi_write2["SDO Signal"] = "5";
pru_spi_write2["CS Signal"]  = "6";
pru_spi_write2["SCLK Signal"] = "4";
const dmModule = scripting.addModule("/pru_blocks/utils/device_model_block", {}, false);
const adc = dmModule.addInstance();
adc.$name = "Adc_Model";
adc.deviceKind = "spi_adc";
adc.spi_adcSclkPin = 4;
adc.spi_adcSdoPin = 5;
adc.spi_adcCsPin = 6;
adc.spi_adcSdiPin = 7;
'''
    design = write(tmp_path, "gap.syscfg", text)
    code, log = gui(design, tmp_path)
    assert "also drives GPO" not in log, log
    code, ci_log = ci(design)
    assert "device input driven by a foreign block" not in ci_log, ci_log


# --------------------------------------------------------------------------------------------------------------------
# mutation: neuter the check in a patched copy; the red test must fail for the named reason
# --------------------------------------------------------------------------------------------------------------------
def neutered_metadata(tmp_path):
    copy = tmp_path / ("meta_" + uuid.uuid4().hex)
    shutil.copytree(ROOT / ".metadata", copy)
    table = copy / "sysconfig" / ".meta" / "pru_blocks" / "common" / "device_model_table.js"
    text = table.read_bytes().decode("utf-8")
    patched, n = re.subn(r"(function findDeviceInputConflicts\(devices, drivers\) \{)(\r?\n)", r"\1\2    return [];\2", text, count=1)
    assert n == 1
    table.write_bytes(patched.encode("utf-8"))
    return copy


@needs_node
@needs_sysconfig
def test_mutant_with_the_check_neutered_lets_the_red_design_through_and_the_red_test_fails_by_name(tmp_path):
    meta = neutered_metadata(tmp_path)
    design = write(tmp_path, "red.syscfg", red_text())
    code, log = gui(design, tmp_path, metadata=meta)
    assert code == 0, "mutant should generate the red design silently, got:\n" + log
    with pytest.raises(AssertionError, match=re.escape("missing \"GPO0 feeds the CLK pin of device 'Encoder_Model'")):
        assert_red(log, RED_FRAGMENTS)
    code, ci_log = ci(design, metadata_root=meta)
    assert code == 0, ci_log
    with pytest.raises(AssertionError, match=re.escape("missing \"GPO0 feeds the CLK pin of device 'Encoder_Model'")):
        assert_red(ci_log, RED_FRAGMENTS)


def module_wide_exemption_metadata(tmp_path):
    """d17d0a8d behaviour: every block of the reader's module is exempt, matching or not."""
    copy = tmp_path / ("meta_" + uuid.uuid4().hex)
    shutil.copytree(ROOT / ".metadata", copy)
    table = copy / "sysconfig" / ".meta" / "pru_blocks" / "common" / "device_model_table.js"
    text = table.read_bytes().decode("utf-8")
    old = "if (!hasLegit && ruleModules.indexOf(drv.block) !== -1) continue;"
    assert old in text
    table.write_bytes(text.replace(old, "if (ruleModules.indexOf(drv.block) !== -1) continue;").encode("utf-8"))
    return copy


@needs_node
@needs_sysconfig
def test_mutant_with_the_module_wide_reader_exemption_lets_the_second_ssi_block_through_and_the_test_fails_by_name(tmp_path):
    meta = module_wide_exemption_metadata(tmp_path)
    design = write(tmp_path, "two_ssi.syscfg", two_ssi_text(3))
    code, log = gui(design, tmp_path, metadata=meta)
    assert code == 0, "mutant should generate the two-SSI design silently, got:\n" + log
    with pytest.raises(AssertionError, match=re.escape("missing \"GPO0 feeds the CLK pin of device 'Encoder_Model'")):
        assert_red(log, SECOND_SSI_FRAGMENTS)
    code, ci_log = ci(design, metadata_root=meta)
    assert code == 0, ci_log
    with pytest.raises(AssertionError, match=re.escape("missing \"GPO0 feeds the CLK pin of device 'Encoder_Model'")):
        assert_red(ci_log, SECOND_SSI_FRAGMENTS)


# --------------------------------------------------------------------------------------------------------------------
# the real chain: the green design builds with the real clpru and runs on TI pru-simulator
# --------------------------------------------------------------------------------------------------------------------
GPO_TRACE = r"""
import sys, json
sys.path.insert(0, sys.argv[1])
from scripts.sim import run_bound_devices as rbd
from scripts.sim.elf_cosim import find_pru_simulator, _sim_namespace
elf, manifest_path = sys.argv[2], sys.argv[3]
manifest = json.load(open(manifest_path))
sim_dir = find_pru_simulator()
import os
with _sim_namespace(sim_dir):
    from simulator import Simulator
    from tools.headless_runner import _validate_linked_elf
    sim = Simulator(os.path.join(sim_dir, "memory.cfg"))
    core = rbd.normalize_core(manifest.get("core"))
    data = open(elf, "rb").read()
    entry = _validate_linked_elf(data)
    assert not sim.load_elf(core, data)
    pru = sim.cores[core]
    pru.pc = entry
    attached = rbd.attach_bound_devices(pru, manifest, sim_dir)
    last = pru.io_port.gpo
    edges = {}
    first = {}
    for cycle in range(2000):
        sim.step(core, 1)
        now = pru.io_port.gpo
        for bit in range(20):
            if (now ^ last) >> bit & 1:
                edges[bit] = edges.get(bit, 0) + 1
                first.setdefault(bit, cycle)
        last = now
        if pru.halted:
            break
print(json.dumps({"edges": edges, "first": first}))
"""


@needs_chain
def test_green_design_builds_and_sims_pass_with_ssi_decoding_4321_and_spi_driving_gpo4(tmp_path):
    with example_copy() as path:
        (path / DESIGN).write_text(green_text(), encoding="utf-8")
        code, out = run_make(path, "all")
        assert code == 0, out
        code, out = run_make(path, "sim")
        assert code == 0, out
        assert "RESULT: PASS" in out and "FAULTS: None" in out, out
        assert re.search(r"Firmware decoded R\d+: 4321; model position: 4321", out), out
        # SPI SCLK on GPO4: 25 clocks = 50 edges, while the SSI clock on GPO0 keeps its own 25 clocks
        syscfg = path / FW / "ti-pru-cgt" / "syscfg"
        elf = next((path / FW / "ti-pru-cgt" / "generated").glob("*.out"))
        res = subprocess.run([sys.executable, "-c", GPO_TRACE, str(ROOT), str(elf), str(syscfg / "pru_device_bindings.json")],
                             capture_output=True, text=True, env=dict(os.environ, PRU_SIMULATOR_PATH=str(SIM)))
        assert res.returncode == 0, res.stderr
        import json
        trace = json.loads(res.stdout.strip().splitlines()[-1])
        edges = {int(k): v for k, v in trace["edges"].items()}
        assert edges.get(4, 0) >= 50, trace      # SPI SCLK on the free GPO
        assert edges.get(0, 0) >= 48, trace      # SSI CLK untouched by the SPI block
        assert edges.get(2, 0) > 0 and edges.get(3, 0) > 0, trace   # MOSI and CS
