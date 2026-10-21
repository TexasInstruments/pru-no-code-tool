"""part A: the Device Model block - an ADDITIONAL device-binding source next to the GPI device fields.

Pratheesh's decision on (option 1): nothing is migrated, the GPI fields keep working, a pin claimed by both
sources is a SysConfig ERROR naming both. What this file proves, each against the real thing:

  * the table behind the block agrees with scripts/sim/device_bindings.py: same kinds, every parameter a keyword of the
    real model constructor, and a default instance of every kind builds a real model through the real consumer;
  * equivalence: the same design written with GPI fields and with a Device Model block yields a byte-identical manifest
    (ssi, bissc, uart), and the generated firmware differs only in the binding record and the design digest;
  * the refusals, each asserted on its text: pin claimed by both sources, two blocks on one pin, ssi bits 0 and 65,
    a position that does not fit, a bad payload byte - each paired with a legal control arm;
  * the GUI-load gate (scripts/check_syscfg_schema.js): the module loads, and a planted blank name is rejected;
  * the real chain: a design that uses ONLY the Device Model block, gmake all -> gmake sim -> PASS with the decoded
    value equal to the model position, plus the 'Run on TI pru-simulator' wrapper on it, and a red arm that must FAIL.

Without PRU_SIMULATOR_PATH the chain tests SKIP; the skip count is reported with every run.
"""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))

import device_bindings  # noqa: E402
import extract_device_bindings  # noqa: E402
from scripts.sim import gui_run  # noqa: E402

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

META = ROOT / ".metadata" / "sysconfig" / ".meta"
TABLE_JS = META / "pru_blocks" / "common" / "device_model_table.js"
SOURCE = ROOT / "examples" / "ssi_device_model_sim"
FW = Path("firmware/am243x-lp/icss_g0_pru0_fw")
DESIGN = FW / "example.syscfg"
FW_MAKE = FW / "ti-pru-cgt" / "makefile"
VCD = FW / "ti-pru-cgt" / "syscfg" / "ssi_device_model_waveform.vcd"
SIM = Path(os.environ.get("PRU_SIMULATOR_PATH", ""))
NODE = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe"))
CLI = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js"))
GMAKE = Path(str(TI_TOOLS / "ccs2100" / "ccs" / "utils" / "bin" / "gmake.exe"))
CLPRU = Path(str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe"))

HAVE_SYSCONFIG = NODE.exists() and CLI.exists()
HAVE_SIM = SIM.is_dir() and (SIM / "simulator.py").exists()
HAVE_CHAIN = HAVE_SYSCONFIG and GMAKE.exists() and CLPRU.exists() and (ROOT / "imports.mak").exists() and HAVE_SIM

needs_sysconfig = pytest.mark.skipif(not HAVE_SYSCONFIG, reason="needs SysConfig 1.28")
needs_sim = pytest.mark.skipif(not HAVE_SIM, reason="needs PRU_SIMULATOR_PATH (TI pru-simulator checkout)")
needs_chain = pytest.mark.skipif(
    not HAVE_CHAIN, reason="needs gmake, SysConfig 1.28, clpru, imports.mak, and PRU_SIMULATOR_PATH")


# --------------------------------------------------------------------------------------------------------------------
# the table, read through node so the test sees exactly what SysConfig's scripts see
# --------------------------------------------------------------------------------------------------------------------
def node_json(expr):
    """Evaluate a JS expression against the table module with real node and return its JSON."""
    script = ("const t = require(%s); process.stdout.write(JSON.stringify(%s));"
              % (json.dumps(str(TABLE_JS)), expr))
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def table():
    return node_json("t.KINDS")


def default_instance(kind):
    """An instance of `kind` with every field at the module's own defaults, as SysConfig would create it."""
    script = r"""
const t = require(%s);
const kind = %s;
const inst = { deviceKind: kind };
const slotDefault = { primaryPin: 1, clockPin: 0, indexPin: 2 };
for (const pf of t.pinFields(kind)) {
    const p = pf.spec;
    inst[pf.field] = p.optional ? -1 : (slotDefault[p.slot] !== undefined ? slotDefault[p.slot] : 3);
}
for (const pf of t.paramFields(kind)) inst[pf.field] = pf.spec.def;
process.stdout.write(JSON.stringify(inst));
""" % (json.dumps(str(TABLE_JS)), json.dumps(kind))
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def table_call(fn, inst):
    return node_json("t.%s(%s)" % (fn, json.dumps(inst)))


def test_every_kind_the_consumer_can_build_is_in_the_table_and_nothing_else():
    kinds = set(table())
    assert kinds == set(device_bindings.REGISTRY), (
        "Device Model kinds and scripts/sim/device_bindings.py REGISTRY must be the same set; "
        "only in table: %s, only in registry: %s" % (sorted(kinds - set(device_bindings.REGISTRY)),
                                                       sorted(set(device_bindings.REGISTRY) - kinds)))


def test_pin_slots_and_direction_agree_with_the_registry():
    for kind, spec in table().items():
        reg = device_bindings.REGISTRY[kind]
        slots = {p["slot"] for p in spec["pins"]}
        assert "primaryPin" in slots, kind
        assert ("clockPin" in slots) == bool(reg.clock), (kind, "clock slot disagrees with REGISTRY")
        assert ("indexPin" in slots) == (reg.index is not None), (kind, "index slot disagrees with REGISTRY")
        extra = {s[len("param:"):] for s in slots if s.startswith("param:")}
        assert extra == set(reg.extra_pins), (kind, extra, reg.extra_pins)
        assert spec["sink"] == reg.sink, (kind, "sink flag disagrees with REGISTRY")
        primary = next(p for p in spec["pins"] if p["slot"] == "primaryPin")
        # The primary slot is the device-driven pin, except for a sink, which drives nothing.
        assert primary["drives"] == (not reg.sink), (kind, "primary-pin direction")
        if reg.sink:
            assert not any(p["drives"] for p in spec["pins"]), (kind, "a sink must not claim to drive a pin")
        # The PRU-driven clock of a device that does not drive its second pin must not be marked as driven by the device.
        if reg.clock and not reg.sink:
            clock = next(p for p in spec["pins"] if p["slot"] == "clockPin")
            assert clock["drives"] == reg.device_drives_second, (kind, "clock-pin direction")


@needs_sim
@pytest.mark.parametrize("kind", sorted(device_bindings.REGISTRY))
def test_a_default_instance_of_every_kind_builds_a_real_model_through_the_real_consumer(kind):
    """Every table parameter is a real keyword of the real constructor; the defaults are legal; the pins are accepted."""
    inst = default_instance(kind)
    assert table_call("checkInstance", inst) == [], kind
    binding = table_call("toBinding", inst)
    manifest = {"version": 1, "bindings": [binding]}
    path = ROOT / "build_out" / ("default_%s_%s.json" % (kind, uuid.uuid4().hex[:8]))
    path.parent.mkdir(exist_ok=True)
    try:
        path.write_text(json.dumps(manifest), encoding="utf-8")
        loaded = device_bindings.load_manifest(str(path))
        device = device_bindings.build_device(loaded["bindings"][0], str(SIM))
    finally:
        path.unlink(missing_ok=True)
    assert device is not None
    # every emitted parameter reached the model (build_device refuses a keyword the constructor does not take)
    assert set(binding["params"]) <= set(device_bindings.REGISTRY[kind].extra_pins) | set(
        p["key"] for p in table()[kind]["params"])


def test_a_default_binding_has_exactly_the_shape_buildDeviceBindings_emits():
    binding = table_call("toBinding", default_instance("ssi"))
    assert list(binding) == ["primaryPin", "kind", "clockPin", "indexPin", "params"]
    assert binding["primaryPin"] == 1 and binding["clockPin"] == 0 and binding["indexPin"] is None


# --------------------------------------------------------------------------------------------------------------------
# validation, at the table
# --------------------------------------------------------------------------------------------------------------------
def messages(inst):
    return [e["message"] for e in table_call("checkInstance", inst)]


def ssi(**overrides):
    inst = default_instance("ssi")
    inst.update(overrides)
    return inst


def test_ssi_bits_range_is_enforced_at_both_ends_with_a_legal_control():
    assert messages(ssi(ssi_bits=25)) == []
    assert messages(ssi(ssi_bits=1)) == [] and messages(ssi(ssi_bits=64)) == []
    assert messages(ssi(ssi_bits=0)) == ["Frame width (bits) must be in 1..64, got 0"]
    assert messages(ssi(ssi_bits=65)) == ["Frame width (bits) must be in 1..64, got 65"]
    assert any("must be an integer" in m for m in messages(ssi(ssi_bits=12.5)))


def test_position_must_fit_the_frame_and_the_boundary_is_legal():
    assert messages(ssi(ssi_bits=13, ssi_position=8191)) == []
    assert messages(ssi(ssi_bits=13, ssi_position=8192)) == ["Position 8192 does not fit in 13 bits (max 8191)"]
    assert messages(ssi(ssi_position=-1)) == ["Position must be in 0..inf, got -1"]


def test_pin_ranges_and_in_block_reuse_are_refused():
    assert messages(ssi(ssi_clkPin=0, ssi_dataPin=1)) == []
    assert messages(ssi(ssi_clkPin=20)) == ["CLK pin must be 0-19, got 20"]
    assert messages(ssi(ssi_clkPin=-1)) == ["CLK pin must be 0-19, got -1"]
    dup = messages(ssi(ssi_clkPin=1, ssi_dataPin=1))
    assert len(dup) == 1 and "already uses" in dup[0] and "one pin" in dup[0], dup


def test_optional_pin_minus_one_is_unused_and_not_a_pin():
    quad = default_instance("quadrature")
    assert quad["quadrature_zPin"] == -1 and messages(quad) == []
    binding = table_call("toBinding", quad)
    assert binding["indexPin"] is None
    assert table_call("claimedPins", quad) == [{"pin": 1, "label": "A channel"}, {"pin": 0, "label": "B channel"}]


def test_uart_payload_is_bytes_not_a_json_string():
    uart = default_instance("uart")
    assert "payload" not in table_call("toBinding", uart)["params"]
    uart["uart_payload"] = "65, 0x42,67"
    assert table_call("toBinding", uart)["params"]["payload"] == [65, 66, 67]
    for bad in ("256", "65,,66", "abc", "-1", "0x100"):
        uart["uart_payload"] = bad
        assert any("comma-separated bytes 0-255" in m for m in messages(uart)), bad


def test_spi_adc_chip_select_travels_as_a_validated_pin_in_params():
    inst = default_instance("spi_adc")
    binding = table_call("toBinding", inst)
    assert binding["params"]["cs_pin"] == 3 and binding["primaryPin"] == 1
    inst["spi_adc_csPin"] = 1          # shares MISO
    assert any("already uses" in m for m in messages(inst))


# --------------------------------------------------------------------------------------------------------------------
# SysConfig, for real
# --------------------------------------------------------------------------------------------------------------------
HEADER = ('/**\n * @cliArgs --device "AM243x_ALX_beta" --package "ALX" --part "ALX" --context "icss_g0_pru0" '
          '--product "PRU_NO_CODE_TOOL@01.00.01"\n */\n')

HALT = '''
const flowModule = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
const halt = flowModule.addInstance();
halt.$name = "Halt_After_Read";
halt.opCode = "HALT";
'''

SSI_BLOCK = '''
const ssiModule = scripting.addModule("/pru_blocks/application_specific/ssi_initiator_block", {}, false);
const ssi = ssiModule.addInstance();
ssi.$name = "Read_SSI_Position";
ssi.clkPin = 0;
ssi.dataPin = 1;
''' + HALT + '''
scripting.connect(ssi, "next", halt, "prev");
'''

BISSC_BLOCK = '''
const bissModule = scripting.addModule("/pru_blocks/application_specific/biss_c_initiator_block", {}, false);
const biss = bissModule.addInstance();
biss.$name = "Read_BiSSC";
biss.clkPin = 0;
biss.dataPin = 1;
''' + HALT + '''
scripting.connect(biss, "next", halt, "prev");
'''


def gpi_device(pin, kind, clock, params, index=None):
    lines = ['const sim = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");',
             'sim.signalsToDisplayR31 = ["%d"];' % pin,
             'sim.gpi%d_inputMode = "device";' % pin,
             'sim.gpi%d_deviceKind = "%s";' % (pin, kind)]
    if clock is not None:
        lines.append("sim.gpi%d_deviceClockPin = %d;" % (pin, clock))
    if index is not None:
        lines.append("sim.gpi%d_deviceIndexPin = %d;" % (pin, index))
    lines.append("sim.gpi%d_deviceParams = '%s';" % (pin, params))
    return "\n" + "\n".join(lines) + "\n"


def device_model(name, kind, **fields):
    lines = ['const dmModule = scripting.addModule("/pru_blocks/utils/device_model_block", {}, false);',
             'const %s = dmModule.addInstance();' % name,
             '%s.$name = "%s";' % (name, name),
             '%s.deviceKind = "%s";' % (name, kind)]
    for key, value in fields.items():
        lines.append("%s.%s = %s;" % (name, key, json.dumps(value)))
    return "\n" + "\n".join(lines) + "\n"


def second_device_model(name, kind, **fields):
    lines = ['const %s = dmModule.addInstance();' % name,
             '%s.$name = "%s";' % (name, name),
             '%s.deviceKind = "%s";' % (name, kind)]
    for key, value in fields.items():
        lines.append("%s.%s = %s;" % (name, key, json.dumps(value)))
    return "\n" + "\n".join(lines) + "\n"


def generate(text, tmp_path):
    """Run the real SysConfig CLI on a design. Returns (returncode, combined output, output dir)."""
    work = tmp_path / ("gen_" + uuid.uuid4().hex)
    work.mkdir()
    syscfg = work / "example.syscfg"
    syscfg.write_text(HEADER + text, encoding="utf-8")
    out = work / "out"
    out.mkdir()
    res = subprocess.run(
        [str(NODE), str(CLI), "--product", str(ROOT / ".metadata" / "product.json"),
         "--device", "AM243x_ALX_beta", "--context", "icss_g0_pru0", "--part", "ALX",
         "--package", "ALX", "--output", str(out), str(syscfg)],
        capture_output=True, text=True)
    return res.returncode, res.stdout + res.stderr, out


def manifest_bytes(out, tmp_path):
    dest = tmp_path / ("m_" + uuid.uuid4().hex + ".json")
    extract_device_bindings.extract(out / "pru_syscfg.asm", dest)
    return dest.read_bytes()


def generate_ok(text, tmp_path):
    code, log, out = generate(text, tmp_path)
    assert code == 0 and "error:" not in log.lower(), log
    return out


@needs_sysconfig
def test_ssi_via_gpi_fields_and_via_device_model_give_a_byte_identical_manifest(tmp_path):
    gpi = SSI_BLOCK + gpi_device(
        1, "ssi", 0, '{"bits":25,"position":4321,"min_clk_period_cycles":20,"monoflop_cycles":400,"gray":true}')
    dm = SSI_BLOCK + device_model("Encoder", "ssi", ssi_dataPin=1, ssi_clkPin=0, ssi_bits=25, ssi_position=4321)
    a = manifest_bytes(generate_ok(gpi, tmp_path), tmp_path)
    b = manifest_bytes(generate_ok(dm, tmp_path), tmp_path)
    assert a == b, a.decode() + "\n!=\n" + b.decode()
    manifest = json.loads(a)
    assert manifest["bindings"][0]["readers"][0]["block"] == "Read_SSI_Position"
    assert manifest["bindings"][0]["params"]["position"] == 4321


@needs_sysconfig
def test_bissc_via_gpi_fields_and_via_device_model_give_a_byte_identical_manifest(tmp_path):
    gpi = BISSC_BLOCK + gpi_device(
        1, "bissc", 0, '{"position_bits":24,"tbusy_clocks":1,"min_ma_period_cycles":2,"idle_restart_cycles":40,'
                       '"position":1234}')
    dm = BISSC_BLOCK + device_model("Encoder", "bissc", bissc_sloPin=1, bissc_maPin=0, bissc_position=1234)
    a = manifest_bytes(generate_ok(gpi, tmp_path), tmp_path)
    b = manifest_bytes(generate_ok(dm, tmp_path), tmp_path)
    assert a == b, a.decode() + "\n!=\n" + b.decode()
    assert json.loads(a)["bindings"][0]["readers"][0]["block"] == "Read_BiSSC"


@needs_sysconfig
def test_uart_with_a_byte_payload_is_byte_identical_and_the_payload_is_a_list_not_a_string(tmp_path):
    gpi = HALT + gpi_device(
        1, "uart", None, '{"payload":[65,66],"bit_period":50,"start_cycle":0,"idle_gap_bits":2,"frames":1}')
    dm = HALT + device_model("Tx", "uart", uart_txPin=1, uart_payload="65,66")
    a = manifest_bytes(generate_ok(gpi, tmp_path), tmp_path)
    b = manifest_bytes(generate_ok(dm, tmp_path), tmp_path)
    assert a == b, a.decode() + "\n!=\n" + b.decode()
    assert json.loads(b)["bindings"][0]["params"]["payload"] == [65, 66]


@needs_sysconfig
def test_documented_difference_a_gpi_design_may_omit_parameters_the_block_always_states(tmp_path):
    """The one place the two sources differ: GPI params list only what the user typed; the block states every field.

    Same model either way (the extra keys are the model's own defaults), so behaviour cannot differ - proved by building
    both through the real consumer in test_ssi_..._byte_identical and by the real-chain test below.
    """
    gpi = SSI_BLOCK + gpi_device(1, "ssi", 0, '{"bits":25,"position":4321}')
    dm = SSI_BLOCK + device_model("Encoder", "ssi", ssi_dataPin=1, ssi_clkPin=0, ssi_bits=25, ssi_position=4321)
    a = json.loads(manifest_bytes(generate_ok(gpi, tmp_path), tmp_path))
    b = json.loads(manifest_bytes(generate_ok(dm, tmp_path), tmp_path))
    assert a != b
    assert set(a["bindings"][0]["params"]) < set(b["bindings"][0]["params"])
    for key, value in a["bindings"][0]["params"].items():
        assert b["bindings"][0]["params"][key] == value
    extra = set(b["bindings"][0]["params"]) - set(a["bindings"][0]["params"])
    assert extra == {"min_clk_period_cycles", "monoflop_cycles", "gray"}
    a["bindings"][0]["params"] = b["bindings"][0]["params"]
    assert a == b


@needs_sysconfig
def test_a_device_model_changes_only_the_binding_record_and_the_digest_in_the_firmware(tmp_path):
    plain = generate_ok(SSI_BLOCK, tmp_path)
    withdm = generate_ok(SSI_BLOCK + device_model("Encoder", "ssi", ssi_dataPin=1, ssi_clkPin=0), tmp_path)

    def strip(out):
        lines = (out / "pru_syscfg.asm").read_text(encoding="utf-8").splitlines()
        a, b = lines.index("; PRU_DEVICE_BINDINGS_BEGIN"), lines.index("; PRU_DEVICE_BINDINGS_END")
        return [l for l in lines[:a] + lines[b + 1:] if not l.startswith("; PRU_DESIGN_DIGEST")]

    assert strip(plain) == strip(withdm), "a declaration-only block must not change the generated firmware"
    assert (plain / "pru_syscfg.inc").read_bytes() == (withdm / "pru_syscfg.inc").read_bytes()
    assert json.loads(manifest_bytes(plain, tmp_path))["bindings"] == []
    assert len(json.loads(manifest_bytes(withdm, tmp_path))["bindings"]) == 1


@needs_sysconfig
def test_conflict_pin_claimed_by_a_gpi_device_and_a_device_model_names_both(tmp_path):
    design = SSI_BLOCK + gpi_device(1, "ssi", 0, '{"bits":25}') + device_model(
        "Encoder_Model", "ssi", ssi_dataPin=1, ssi_clkPin=5)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert ("Pin 1 is claimed by Device Model 'Encoder_Model' (ssi, DATA pin) and by the Simulation Settings "
            "GPI1 device (ssi, primary pin). A pin cannot have two device sources: remove one of them.") in log, log
    # control arm: the same two sources on disjoint pins are accepted
    ok = SSI_BLOCK + gpi_device(1, "ssi", 0, '{"bits":25}') + device_model(
        "Encoder_Model", "ssi", ssi_dataPin=7, ssi_clkPin=5)
    out = generate_ok(ok, tmp_path)
    kinds = [(b["primaryPin"], b["kind"]) for b in json.loads(manifest_bytes(out, tmp_path))["bindings"]]
    assert kinds == [(1, "ssi"), (7, "ssi")], "both sources feed one manifest, sorted by primary pin"


@needs_sysconfig
def test_conflict_on_a_companion_pin_is_caught_too(tmp_path):
    # The GPI device's CLOCK pin (0) is the Device Model's data pin: a short, not just a shared primary.
    design = SSI_BLOCK + gpi_device(1, "ssi", 0, '{"bits":25}') + device_model(
        "Encoder_Model", "ssi", ssi_dataPin=0, ssi_clkPin=5)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert ("Pin 0 is claimed by Device Model 'Encoder_Model' (ssi, DATA pin) and by the Simulation Settings "
            "GPI1 device (ssi, Clock/B pin).") in log, log


@needs_sysconfig
def test_conflict_between_two_device_models_names_both(tmp_path):
    design = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "uart", uart_txPin=1)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert "Pin 1 is claimed by Device Model 'First_Model' (ssi, DATA pin) and by Device Model 'Second_Model' (uart" in log, log
    assert "Pin 1 is claimed by Device Model 'Second_Model' (uart" in log, log
    ok = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "uart", uart_txPin=2)
    generate_ok(ok, tmp_path)


@needs_sysconfig
@pytest.mark.parametrize("field,value,text", [
    ("ssi_bits", 0, "Frame width (bits) must be in 1..64, got 0"),
    ("ssi_bits", 65, "Frame width (bits) must be in 1..64, got 65"),
    ("ssi_position", 1 << 13, "Position 8192 does not fit in 13 bits (max 8191)"),
    ("ssi_clkPin", 20, "CLK pin must be 0-19, got 20"),
    ("ssi_monoflopCycles", 0, "Monoflop time (cycles) must be in 1..inf, got 0"),
])
def test_typed_parameter_refusals_arrive_through_sysconfig_as_errors_on_the_field(tmp_path, field, value, text):
    fields = {"ssi_dataPin": 1, "ssi_clkPin": 0, "ssi_bits": 13}
    fields[field] = value
    code, log, _ = generate(SSI_BLOCK + device_model("Encoder", "ssi", **fields), tmp_path)
    assert code != 0, log
    assert text in log, log
    # control arm: the neighbouring legal value is accepted
    fields[field] = {"ssi_bits": 64, "ssi_position": 8191, "ssi_clkPin": 19, "ssi_monoflopCycles": 1}[field]
    if field == "ssi_clkPin":
        fields["ssi_dataPin"] = 1
    generate_ok(SSI_BLOCK + device_model("Encoder", "ssi", **fields), tmp_path)


@needs_sysconfig
def test_float_parameters_keep_their_fractions_through_sysconfig_into_the_manifest(tmp_path):
    design = HALT + device_model("SD", "sigma_delta", sigma_delta_dataPin=1, sigma_delta_clkPin=0,
                                 sigma_delta_saturationThreshold=2.5, sigma_delta_initialInput=0.25)
    params = json.loads(manifest_bytes(generate_ok(design, tmp_path), tmp_path))["bindings"][0]["params"]
    assert params == {"min_period": 4, "saturation_threshold": 2.5, "saturation_persist": 16, "initial_input": 0.25}


@needs_sysconfig
def test_a_bad_payload_byte_is_refused_with_its_text(tmp_path):
    code, log, _ = generate(HALT + device_model("Tx", "uart", uart_txPin=1, uart_payload="65,300"), tmp_path)
    assert code != 0 and "must be comma-separated bytes 0-255, got '65,300'" in log, log


@needs_sysconfig
def test_every_kind_generates_clean_through_sysconfig_and_loads_in_the_real_consumer(tmp_path):
    """One design per kind, defaults only: SysConfig accepts it and the real consumer validates the emitted manifest."""
    for kind in sorted(device_bindings.REGISTRY):
        out = generate_ok(HALT + device_model("Model", kind, **_default_fields(kind)), tmp_path)
        path = tmp_path / ("m_%s.json" % kind)
        extract_device_bindings.extract(out / "pru_syscfg.asm", path)
        loaded = device_bindings.load_manifest(str(path))      # raises BindingError on any structural problem
        assert [b["kind"] for b in loaded["bindings"]] == [kind]


def _default_fields(kind):
    """Only the pin fields: every other field keeps the module's own default, which is the point."""
    inst = default_instance(kind)
    return {k: v for k, v in inst.items() if k.endswith("Pin") and k.startswith(kind + "_")}


# --------------------------------------------------------------------------------------------------------------------
# GUI-load gate
# --------------------------------------------------------------------------------------------------------------------
def test_the_product_passes_the_gui_schema_check_with_the_module_registered():
    res = subprocess.run(["node", str(ROOT / "scripts" / "check_syscfg_schema.js")], cwd=ROOT,
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert re.search(r"\b0 rejected", res.stdout), res.stdout
    for soc in ("am243x", "am261x", "am64x"):
        text = (META / "soc" / ("pru_blocks_%s.syscfg.js" % soc)).read_text(encoding="utf-8")
        assert '"/pru_blocks/utils/device_model_block"' in text, soc


def _scratch_meta(tmp_path, mutate):
    scratch = tmp_path / ("meta_" + uuid.uuid4().hex)
    shutil.copytree(META, scratch, ignore=shutil.ignore_patterns("images"))
    target = scratch / "pru_blocks" / "utils" / "device_model_block.syscfg.js"
    target.write_text(mutate(target.read_text(encoding="utf-8")), encoding="utf-8")
    return scratch


def test_a_blank_configurable_name_in_the_module_is_rejected_by_the_gate(tmp_path):
    """Red arm: the failure that stopped the GUI opening the product (queue_empty_block, 2026-10-03)."""
    scratch = _scratch_meta(tmp_path, lambda t: t.replace(
        '{ name: "$topLabel", hidden: true, default: "" },',
        '{ name: "$topLabel", hidden: true, default: "" },\n        { name: "", hidden: true, default: 0 },', 1))
    res = subprocess.run(["node", str(ROOT / "scripts" / "check_syscfg_schema.js"), str(scratch)],
                         capture_output=True, text=True)
    assert res.returncode == 1 and "device_model_block" in res.stdout + res.stderr, res.stdout + res.stderr


def test_a_duplicate_configurable_name_in_the_module_is_rejected_by_the_gate(tmp_path):
    scratch = _scratch_meta(tmp_path, lambda t: t.replace(
        '{ name: "$topLabel", hidden: true, default: "" },',
        '{ name: "$topLabel", hidden: true, default: "" },\n        { name: "opCode", hidden: true, default: 1 },', 1))
    res = subprocess.run(["node", str(ROOT / "scripts" / "check_syscfg_schema.js"), str(scratch)],
                         capture_output=True, text=True)
    assert res.returncode == 1 and "device_model_block" in res.stdout + res.stderr, res.stdout + res.stderr


def test_the_generated_names_are_unique_and_none_is_blank():
    names = []
    for kind, spec in table().items():
        names += [kind + "_" + p["key"] + "Pin" for p in spec["pins"]]
        names += [n for n in node_json("t.paramFields(%s).map(f => f.field)" % json.dumps(kind))]
    assert all(names) and len(names) == len(set(names))


def test_the_manifest_reader_table_and_the_blocks_reader_table_are_the_same():
    """The block's 'Read by' display and resolveDeviceReaders must agree on which module reads which kind."""
    src = (META / "pru_blocks" / "common" / "pru_blocks_static_module.syscfg.js").read_text(encoding="utf-8")
    body = src[src.index("function resolveDeviceReaders"):]
    body = body[:body.index("// Byte ranges")]
    module_names = dict(re.findall(r'(\w+):\s*\[\{ module: "([^"]+)", dataPinField: "dataPin" \}\]', body))
    readers = node_json("t.READER_BLOCKS")
    assert {k: v[0]["module"] for k, v in readers.items()} == module_names


def test_with_no_device_model_the_merged_builder_returns_exactly_the_gpi_builder_output():
    src = (META / "pru_blocks" / "common" / "pru_blocks_static_module.syscfg.js").read_text(encoding="utf-8").replace("\r\n", "\n")

    def extract(name):
        start = src.index("function " + name)
        rest = src[start:]
        return rest[:rest.index("\n}\n") + 2]

    script = ("const t = require(%s);\nconst deviceModelTable = t;\n%s\n%s\n"
              "const inst = {pruClkFreq: 200, pruCyclesToSimulate: 2000, signalsToDisplayR31: ['1','4']};\n"
              "for (let p = 0; p <= 19; p++) { inst['gpi'+p+'_inputMode']='timestamp'; inst['gpi'+p+'_deviceKind']='ssi';"
              " inst['gpi'+p+'_deviceClockPin']=-1; inst['gpi'+p+'_deviceIndexPin']=-1; inst['gpi'+p+'_deviceParams']='{}'; }\n"
              "inst.gpi4_inputMode='device'; inst.gpi4_deviceClockPin=2; inst.gpi4_deviceParams='{\"bits\":13}';\n"
              "const a = JSON.stringify(buildDeviceBindings(inst));\n"
              "process.stdout.write(JSON.stringify([a === JSON.stringify(buildDeviceBindingsWithModels(inst, {})),"
              " a === JSON.stringify(buildDeviceBindingsWithModels(inst, undefined)),"
              " a === JSON.stringify(buildDeviceBindingsWithModels(inst, {'/pru_blocks/utils/device_model_block': {$instances: []}})),"
              " JSON.parse(a).bindings.length]));\n"
              % (json.dumps(str(TABLE_JS)), extract("buildDeviceBindings"), extract("buildDeviceBindingsWithModels")))
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    assert json.loads(res.stdout) == [True, True, True, 1]


# --------------------------------------------------------------------------------------------------------------------
# the real chain: ONLY the Device Model block attaches the device
# --------------------------------------------------------------------------------------------------------------------
@contextlib.contextmanager
def example_copy():
    # Same examples/<name> depth as the source: its makefile includes ../../imports.mak.
    path = ROOT / "examples" / ("_case_" + uuid.uuid4().hex)
    path.mkdir()
    try:
        shutil.copytree(SOURCE, path, dirs_exist_ok=True, ignore=shutil.ignore_patterns("generated", "syscfg"))
        (path / FW / "ti-pru-cgt" / "generated").mkdir(parents=True)
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def run_make(path, target):
    env = dict(os.environ)
    env["PRU_SIMULATOR_PATH"] = str(SIM)
    env["PATH"] = str(GMAKE.parent) + os.pathsep + env.get("PATH", "")
    res = subprocess.run([str(GMAKE), target, "BUILD_MCUPLUS=n", "CAT=type", "MOVE=move"],
                         cwd=path, env=env, capture_output=True, text=True)
    return res.returncode, res.stdout + res.stderr


def edit(path, before, after):
    p = path / DESIGN
    data = p.read_text(encoding="utf-8")
    assert before in data, before
    p.write_text(data.replace(before, after), encoding="utf-8")


def decoded_and_model(out):
    m = re.search(r"Firmware decoded R\d+: (\d+); model position: (\d+)", out)
    assert m, out
    return int(m.group(1)), int(m.group(2))


@pytest.mark.skipif(not (SOURCE / DESIGN).exists(), reason="the ssi_device_model_sim example is not in this repository")
def test_the_example_attaches_its_device_only_through_the_block():
    text = (SOURCE / DESIGN).read_text(encoding="utf-8")
    assert "device_model_block" in text and 'encoder.deviceKind = "ssi"' in text
    # The example now adds Simulation Settings (it holds the Run button), but sets none of its device fields.
    assert "gpi1_" not in text and "_inputMode" not in text, "the example must not use the GPI fields"


@needs_chain
def test_real_chain_gmake_all_then_sim_passes_with_decoded_equal_to_the_model_position():
    with example_copy() as path:
        code, out = run_make(path, "all")
        assert code == 0 and "error:" not in out.lower(), out
        code, out = run_make(path, "sim")
        assert code == 0, out
        assert decoded_and_model(out) == (4321, 4321)
        assert "Attached 1 devices" in out and "FAULTS: None" in out and "RESULT: PASS" in out
        vcd = (path / VCD).read_text(encoding="ascii")
        assert "CLK_R30_0" in vcd and "DATA_R31_1" in vcd and vcd.count("0!") > 5

        # Red arm: moving ONLY the block's position moves the model and the verdict must follow it.
        edit(path, "encoder.ssi_position = 4321;", "encoder.ssi_position = 4322;")
        code, out = run_make(path, "sim")
        assert code == 0, out
        assert decoded_and_model(out) == (4322, 4322)


@needs_chain
def test_red_real_chain_block_and_firmware_disagree_is_fail_not_pass():
    with example_copy() as path:
        # The device streams plain binary while the SSI block decodes gray code.
        edit(path, "encoder.ssi_gray = true;", "encoder.ssi_gray = false;")
        code, out = run_make(path, "all")
        assert code == 0, out
        code, out = run_make(path, "sim")
        assert code != 0, out
        decoded, model = decoded_and_model(out)
        assert model == 4321 and decoded != 4321
        assert "FAIL: firmware decoded position differs from model" in out


def gui_like_env():
    env = dict(os.environ)
    env["PRU_SIMULATOR_PATH"] = str(SIM)
    system = os.environ.get("SystemRoot", os.environ.get("SystemDrive", "C:") + "\\Windows")
    env["PATH"] = os.pathsep.join([system + r"\System32", system])
    return env


def gui_digest(syscfg, tmp_path):
    out = tmp_path / ("dg_" + uuid.uuid4().hex)
    out.mkdir()
    res = subprocess.run(
        [str(NODE), str(CLI), "--product", str(ROOT / ".metadata" / "product.json"),
         "--device", "AM243x_ALX_beta", "--context", "icss_g0_pru0", "--part", "ALX",
         "--package", "ALX", "--output", str(out), str(syscfg)], capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    m = re.search(r"^; PRU_DESIGN_DIGEST (\S+)$", (out / "pru_syscfg.asm").read_text(encoding="utf-8"), re.M)
    assert m
    return m.group(1)


def run_wrapper(path, tmp_path, digest):
    com = tmp_path / ("com_" + uuid.uuid4().hex + ".json")
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "sim" / "gui_run.py"), "--com", str(com), "--digest", digest,
         "--project", str(path / DESIGN)], env=gui_like_env(), capture_output=True, text=True)
    assert com.exists(), proc.stdout + proc.stderr
    return json.loads(com.read_text(encoding="utf-8")), proc


@needs_chain
def test_run_on_ti_pru_simulator_button_path_passes_on_a_device_model_only_design(tmp_path):
    with example_copy() as path:
        digest = gui_digest(path / DESIGN, tmp_path)
        result, proc = run_wrapper(path, tmp_path, digest)
        assert result["verdict"] == "PASS" and result["exitCode"] == 0, result
        assert result["devices"] == [{"kind": "ssi", "pin": 1, "decoded": 4321, "expected": 4321}]
        assert result["designDigest"] == digest


@needs_chain
def test_the_design_digest_covers_the_block_so_an_edit_on_screen_is_a_stale_design(tmp_path):
    with example_copy() as path:
        shown = gui_digest(path / DESIGN, tmp_path)
        edit(path, "encoder.ssi_position = 4321;", "encoder.ssi_position = 4322;")
        assert gui_digest(path / DESIGN, tmp_path) != shown, "the digest ignored a Device Model field"
        result, proc = run_wrapper(path, tmp_path, shown)
        assert result["verdict"] == "REFUSED" and "differs from the saved .syscfg" in result["reason"], result
        assert not list((path / FW / "ti-pru-cgt" / "generated").glob("*.out"))
