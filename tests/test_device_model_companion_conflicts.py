"""Device Model block-vs-block conflicts on COMPANION pins (clock, index, ...).

the conflict test only used primary pins. The reviewer's mutant - limit the other block's
claim to its primary pin, table.claimedPins(other).slice(0, 1) - left every test green, and
design A ssi data1/clk0 + B ssi data7/clk0 generated silently with two models on one net.

Shared clock: two SSI/BiSS devices on one PRU-driven clock can be legal wiring (one CLK fanned out
to two encoders), but pru_device_bindings.json attaches one model per pin and the firmware would
have to read two data lines on one clock, so it stays an ERROR with a message that says why
(docs/simulation/device-bindings.md). Fan-out is not implemented.
"""
import json

import pytest

from test_device_model import (SSI_BLOCK, device_model, generate, generate_ok, manifest_bytes,
                                      needs_sysconfig, second_device_model)

SHARED_CLOCK = "shared clock between device models is not supported by the simulator yet"


@needs_sysconfig
def test_two_models_sharing_a_clock_pin_is_refused_with_the_shared_clock_text(tmp_path):
    design = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "ssi", ssi_dataPin=7, ssi_clkPin=0)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert ("Pin 0 is claimed by Device Model 'First_Model' (ssi, CLK pin) and by Device Model 'Second_Model' "
            "(ssi, CLK pin)") in log, log
    assert SHARED_CLOCK in log, log
    # and in the other direction (the error is reported on both blocks)
    assert "Pin 0 is claimed by Device Model 'Second_Model' (ssi, CLK pin)" in log, log


@needs_sysconfig
def test_a_clock_pin_against_another_models_data_pin_is_refused_and_is_not_called_a_shared_clock(tmp_path):
    design = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "ssi", ssi_dataPin=0, ssi_clkPin=5)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert ("Pin 0 is claimed by Device Model 'First_Model' (ssi, CLK pin) and by Device Model 'Second_Model' "
            "(ssi, DATA pin)") in log, log
    assert SHARED_CLOCK not in log, log


@needs_sysconfig
def test_a_companion_pin_against_another_models_primary_pin_is_refused(tmp_path):
    # quadrature B channel (companion) of the second model sits on the first model's primary pin
    design = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "quadrature", quadrature_aPin=4, quadrature_bPin=1)
    code, log, _ = generate(design, tmp_path)
    assert code != 0, log
    assert "Pin 1 is claimed by Device Model 'First_Model' (ssi, DATA pin) and by Device Model 'Second_Model' (quadrature" in log, log


@needs_sysconfig
def test_control_two_models_on_disjoint_pins_are_accepted(tmp_path):
    design = SSI_BLOCK + device_model("First_Model", "ssi", ssi_dataPin=1, ssi_clkPin=0) + second_device_model(
        "Second_Model", "ssi", ssi_dataPin=7, ssi_clkPin=6)
    out = generate_ok(design, tmp_path)
    bindings = json.loads(manifest_bytes(out, tmp_path))["bindings"]
    assert sorted((b["primaryPin"], b["clockPin"]) for b in bindings) == [(1, 0), (7, 6)]


def test_device_model_execution_model_agrees_between_docs_and_the_ci_classifier():
    """The block reference and block_control_flow_data.js (GUI validator) must say the same for the Device Model."""
    from pathlib import Path
    import re
    root = Path(__file__).resolve().parents[1]
    data = (root / ".metadata/sysconfig/.meta/pru_blocks/common/block_control_flow_data.js").read_text(encoding="utf-8")
    cls = re.search(r'"device_model_block":\s*"(\w+)"', data).group(1)
    readme = (root / "docs/block-reference/README.md").read_text(encoding="utf-8")
    row = next(l for l in readme.splitlines() if "| `device_model_block` |" in l)
    assert "`%s`" % cls in row, (cls, row)
    assert "(unclassified)" not in row, row
