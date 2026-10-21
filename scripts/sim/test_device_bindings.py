"""Tests for the device-binding consumer.

This module turns a GUI selection into an attached device model, so its failure
mode is specific and quiet: a binding that is wrong in the right way attaches
nothing, or attaches a model to the wrong pin, and the simulation runs happily
and proves nothing. Every test here is aimed at that outcome rather than at
happy-path plumbing.

Every refusal test is paired with the same binding made legal, so a validator
that rejected everything would fail as loudly as one that accepted everything.

The load-bearing test is `test_the_device_drives_the_primary_pin`. The pin
translation cannot be checked by reading names - `ma_pin` and `slo_pin` look
equally like "the first pin". It is checked against each model's own `nets`,
which declares what the device DRIVES. Reverse a clocked device's mapping and
the encoder waits forever on a clock that never arrives, which looks like a
clean pass. That test is the only thing standing between us and that result.
"""
from __future__ import annotations

import copy
import json
import os
import re

import pytest

from device_bindings import (REGISTRY, BindingError, build_device, driven_pins,
                             load_manifest, _validate_entry)

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_MODULE = os.path.join(HERE, "..", "..", ".metadata", "sysconfig", ".meta",
                             "pru_blocks", "common",
                             "pru_blocks_static_module.syscfg.js")


def entry(**over):
    """A legal ssi binding, overridden per test. Legal by default on purpose."""
    e = {"primaryPin": 1, "kind": "ssi", "clockPin": 0, "indexPin": None,
         "params": {}}
    e.update(over)
    return e


#: Params that only exist to make an observation possible, never to change a
#: mapping. `driven_pins` watches what a model asserts on the wire, and a model
#: shifting out a conversion of 0 asserts nothing - which would read as "drives
#: no pin" and quietly pass a sink check it should fail.
_STIMULUS = {"spi_adc": {"conversion": 0xFFFF, "bits": 16}}


def bound(kind, primaryPin=11):
    """A legal binding for any kind, with every pin the model needs.

    Pins the GUI has no slot for are real pins and are allocated here from 14
    up, so they never collide with the 11/12/13 the direction tests rely on.
    """
    spec = REGISTRY[kind]
    params = dict(_STIMULUS.get(kind, {}))
    for n, key in enumerate(spec.extra_pins):
        params[key] = 14 + n
    return entry(kind=kind, primaryPin=primaryPin,
                 clockPin=12 if spec.clock else None,
                 indexPin=13 if spec.index else None,
                 params=params)


def manifest(bindings, version=1):
    return {"version": version, "pruClkFreqMhz": 200, "cyclesToSimulate": 2000,
            "bindings": copy.deepcopy(bindings)}


def write(tmp_path, obj):
    p = tmp_path / "pru_device_bindings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return str(p)


# ---------------------------------------------------------------------------
# the registry must cover the GUI, or a selector is dead
# ---------------------------------------------------------------------------
def test_every_device_offered_by_the_gui_has_a_model():
    """A kind in the dropdown with no model behind it attaches nothing.

    That is the worst available outcome: the user picks a device, the run goes
    green, and nothing was ever driven. Read the option list out of the
    SysConfig module rather than restating it here, so adding a GUI option
    without a model fails this test.
    """
    source = open(STATIC_MODULE, encoding="utf-8").read()
    start = source.index("name: `gpi${pinNum}_deviceKind`")
    block = source[start:start + 2000]
    options = block[block.index("options: ["):block.index("]", block.index("options: ["))]
    kinds = set(re.findall(r'\{\s*name:\s*"([^"]+)"', options))

    assert kinds, "could not parse the deviceKind options out of the module"
    missing = kinds - set(REGISTRY)
    assert not missing, "GUI offers devices with no model: %s" % sorted(missing)


def test_the_registry_does_not_offer_models_the_gui_cannot_select():
    """The mirror check. A registry entry with no GUI option is unreachable."""
    source = open(STATIC_MODULE, encoding="utf-8").read()
    start = source.index("name: `gpi${pinNum}_deviceKind`")
    block = source[start:start + 2000]
    options = block[block.index("options: ["):block.index("]", block.index("options: ["))]
    kinds = set(re.findall(r'\{\s*name:\s*"([^"]+)"', options))
    assert not set(REGISTRY) - kinds, \
        "registry has unreachable kinds: %s" % sorted(set(REGISTRY) - kinds)


# ---------------------------------------------------------------------------
# the pin mapping - the test that cannot be satisfied by a plausible guess
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("kind", sorted(REGISTRY))
def test_the_device_drives_the_primary_pin(kind):
    """The primary pin is the one the DEVICE drives, for every kind.

    `nets` is each model's own declaration of what it drives. A mapping that
    put the PRU-driven clock in the primary slot would leave the primary pin
    absent from nets - and the device silently waiting on a clock wired to
    nothing.
    """
    spec = REGISTRY[kind]
    if spec.sink:
        pytest.skip("declared sink - see test_a_sink_really_drives_nothing")
    model = build_device(bound(kind, primaryPin=11))
    assert 11 in driven_pins(model), (
        "%s does not drive its primary pin 11 (drives %s) - the primary/clock "
        "mapping for this kind is reversed"
        % (kind, sorted(driven_pins(model))))


@pytest.mark.parametrize("kind", sorted(k for k, s in REGISTRY.items()
                                        if s.clock and not s.device_drives_second))
def test_a_pru_driven_clock_is_not_driven_by_the_device(kind):
    """A clocked slave observes its clock; only the PRU drives it.

    Two exceptions are declared in the registry rather than excluded silently.
    A quadrature encoder drives B and Z as data channels, and an I2C slave may
    stretch SCL on the open-drain net, so both legitimately appear in `nets`.
    Every other device here would be showing a second driver on a push-pull
    clock line, which is contention.
    """
    model = build_device(bound(kind, primaryPin=11))
    assert 12 not in driven_pins(model), \
        "%s drives its clock pin - primary and clock look swapped" % kind


@pytest.mark.parametrize("kind", sorted(k for k, s in REGISTRY.items()
                                        if s.device_drives_second))
def test_a_declared_device_driven_second_pin_really_is_driven(kind):
    """The exceptions above must be real, not a way to silence the test.

    If quadrature or tca9538 stopped driving their second pin the flag would be
    wrong and this fails - so the exemption cannot rot into a blanket skip.
    """
    model = build_device(bound(kind, primaryPin=11))
    assert 12 in driven_pins(model), \
        "%s is flagged device_drives_second but does not drive pin 12" % kind


@pytest.mark.parametrize("kind", sorted(k for k, s in REGISTRY.items() if s.sink))
def test_a_sink_really_drives_nothing(kind):
    """`sink=True` is the claim that no pin of this device is device-driven.

    It is the one declaration that switches the primary-pin invariant off, so
    it is also the obvious place to hide a reversed mapping. Port a model that
    starts driving a line back and this goes red, which forces the registry to
    be re-read rather than letting the exemption rot into a blanket skip.
    """
    model = build_device(bound(kind, primaryPin=11))
    if kind == "step_dir":
        # Reach StepDirDriver's post-edge return. All three device inputs are
        # asserted on its first real STEP transition; its output must still be
        # zero. This must not be a quiet-path test: changing the production
        # post-edge return to ``1 << step_pin`` makes this assertion RED.
        stimulus = ((0, 0), (1, (1 << 11) | (1 << 12) | (1 << 13)))
    elif kind == "ws2812":
        # Drive a real high then falling data edge through Ws2812String's
        # complete pulse path. A WS2812 is an input-only device even while it
        # classifies a pulse (80 cycles is the nominal T0H at 5 ns/cycle).
        stimulus = ((0, 0), (80, 1 << 11), (160, 0))
    else:  # Keep a new sink from inheriting an unexamined quiet-path oracle.
        raise AssertionError("sink %r needs a behavioural stimulus" % kind)
    observed = driven_pins(model, stimulus)
    assert observed == set(), (
        "%s is declared sink=True but drives %s - if it really drives a pin, "
        "that pin belongs in the primary slot and sink must go"
        % (kind, sorted(observed)))


# ---------------------------------------------------------------------------
# refusals, each with a control arm
# ---------------------------------------------------------------------------
def test_an_unknown_device_kind_is_refused():
    with pytest.raises(BindingError, match="unknown device kind"):
        _validate_entry(entry(kind="not_a_device"), {})


def test_a_known_device_kind_is_accepted():
    _validate_entry(entry(kind="ssi"), {})           # control arm


def test_a_clocked_device_without_a_clock_pin_is_refused():
    """The exact shape that produces a silent idle trace."""
    with pytest.raises(BindingError, match="clocked and needs a clock pin"):
        _validate_entry(entry(kind="endat", clockPin=None), {})


def test_a_clocked_device_with_a_clock_pin_is_accepted():
    _validate_entry(entry(kind="endat", clockPin=0), {})   # control arm


def test_a_single_pin_device_given_a_clock_pin_is_refused():
    """Silently dropping it would attach a device the user did not configure."""
    with pytest.raises(BindingError, match="has no clock pin"):
        _validate_entry(entry(kind="uart", clockPin=2), {})


def test_a_single_pin_device_without_a_clock_pin_is_accepted():
    _validate_entry(entry(kind="uart", clockPin=None), {})  # control arm


def test_an_index_pin_on_a_device_without_one_is_refused():
    with pytest.raises(BindingError, match="has no index pin"):
        _validate_entry(entry(kind="ssi", indexPin=4), {})


def test_an_index_pin_on_a_device_that_has_one_is_accepted():
    _validate_entry(entry(kind="quadrature", clockPin=2, indexPin=4), {})


def test_a_device_reusing_its_own_pin_is_refused():
    with pytest.raises(BindingError, match="reuses a pin"):
        _validate_entry(entry(primaryPin=3, clockPin=3), {})


def test_a_device_with_distinct_pins_is_accepted():
    _validate_entry(entry(primaryPin=3, clockPin=4), {})    # control arm


def test_two_devices_claiming_one_pin_are_refused():
    """Two models driving one net is a short, not a configuration."""
    seen = {}
    _validate_entry(entry(kind="ssi", primaryPin=1, clockPin=0), seen)
    with pytest.raises(BindingError, match="claimed by two devices"):
        _validate_entry(entry(kind="endat", primaryPin=5, clockPin=1), seen)


def test_two_devices_on_separate_pins_are_accepted():
    seen = {}
    _validate_entry(entry(kind="ssi", primaryPin=1, clockPin=0), seen)
    _validate_entry(entry(kind="endat", primaryPin=5, clockPin=4), seen)


@pytest.mark.parametrize("bad", [20, -1, 99])
def test_a_pin_outside_the_r31_range_is_refused(bad):
    with pytest.raises(BindingError, match="must be 0-19"):
        _validate_entry(entry(primaryPin=bad), {})


def test_a_pin_inside_the_r31_range_is_accepted():
    _validate_entry(entry(primaryPin=19, clockPin=0), {})   # control arm


def test_a_boolean_is_not_a_pin_number():
    """bool subclasses int, so True would otherwise sail through as pin 1."""
    with pytest.raises(BindingError, match="integer pin number"):
        _validate_entry(entry(primaryPin=True), {})


def test_a_pin_field_naming_a_pin_in_params_is_refused():
    """Two sources of truth for one pin will drift."""
    with pytest.raises(BindingError, match="must not set"):
        _validate_entry(entry(params={"clk_pin": 4}), {})


def test_a_non_pin_parameter_is_accepted():
    _validate_entry(entry(params={"bits": 13}), {})         # control arm


def test_a_parameter_the_model_would_drop_is_refused():
    """The GUI promises unknown keys are reported, not ignored. Kept here."""
    with pytest.raises(BindingError, match="does not accept"):
        build_device(entry(kind="ssi", params={"noSuchParam": 1}))


def test_a_parameter_the_model_accepts_is_passed_through():
    model = build_device(entry(kind="ssi", params={"bits": 17}))
    assert model.bits == 17                                  # control arm


def test_params_as_a_list_is_refused():
    with pytest.raises(BindingError, match="must be an object"):
        _validate_entry(entry(params=[1, 2, 3]), {})


# ---------------------------------------------------------------------------
# manifest-level refusals
# ---------------------------------------------------------------------------
def test_an_absent_manifest_is_refused(tmp_path):
    """Absent is not 'no devices'. Treating it as a pass is the whole trap."""
    with pytest.raises(BindingError, match="no device-binding manifest"):
        load_manifest(str(tmp_path / "nope.json"))


def test_a_present_manifest_is_read(tmp_path):
    path = write(tmp_path, manifest([entry()]))
    assert len(load_manifest(path)["bindings"]) == 1          # control arm


def test_an_unsupported_manifest_version_is_refused(tmp_path):
    path = write(tmp_path, manifest([entry()], version=999))
    with pytest.raises(BindingError, match="not supported"):
        load_manifest(path)


def test_a_manifest_with_no_version_is_refused(tmp_path):
    path = write(tmp_path, {"bindings": []})
    with pytest.raises(BindingError, match="not supported"):
        load_manifest(path)


def test_malformed_json_is_refused(tmp_path):
    p = tmp_path / "pru_device_bindings.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(BindingError, match="could not read manifest"):
        load_manifest(str(p))


def test_bindings_must_be_a_list(tmp_path):
    path = write(tmp_path, {"version": 1, "bindings": {"kind": "ssi"}})
    with pytest.raises(BindingError, match="must be a list"):
        load_manifest(path)


def test_an_empty_manifest_loads_but_is_empty(tmp_path):
    """Loading succeeds; refusing to RUN on empty is the CLI's job, so that
    a project with genuinely no devices can opt in with --allow-empty."""
    path = write(tmp_path, manifest([]))
    assert load_manifest(path)["bindings"] == []


def test_a_bad_binding_anywhere_fails_the_whole_manifest(tmp_path):
    """Not just the first entry - a partial attach is a silent half-run."""
    path = write(tmp_path, manifest([entry(primaryPin=1, clockPin=0),
                                     entry(kind="bogus", primaryPin=5)]))
    with pytest.raises(BindingError, match="unknown device kind"):
        load_manifest(path)


# ---------------------------------------------------------------------------
# pins that have no GUI slot are still pins
# ---------------------------------------------------------------------------
def test_a_pin_with_no_gui_slot_is_still_required():
    """SpiAdc needs four pins and the manifest has three fields.

    CS therefore rides in params. Omitting it is a refusal rather than a
    default: the model would put CS on its own pin 3, the PRU would never
    assert it, no frame would ever open and the ADC would shift out nothing -
    an idle trace indistinguishable from firmware that never ran.
    """
    e = bound("spi_adc")
    del e["params"]["cs_pin"]
    with pytest.raises(BindingError, match="cs_pin"):
        _validate_entry(e, {})
    _validate_entry(bound("spi_adc"), {})      # control: legal with it


def test_a_pin_with_no_gui_slot_is_range_checked():
    e = bound("spi_adc")
    e["params"]["cs_pin"] = 44
    with pytest.raises(BindingError, match="0-19"):
        _validate_entry(e, {})


def test_a_pin_with_no_gui_slot_cannot_collide_with_a_gui_pin():
    """Two drivers on one net is a short whichever field the pin arrived in."""
    e = bound("spi_adc")
    e["params"]["cs_pin"] = 12        # same pin as the clock slot
    with pytest.raises(BindingError, match="reuses a pin"):
        _validate_entry(e, {})


def test_a_pin_with_no_gui_slot_cannot_collide_across_devices():
    seen = {}
    _validate_entry(bound("spi_adc", primaryPin=11), seen)
    other = entry(kind="uart", primaryPin=14, clockPin=None)   # spi_adc's cs_pin
    with pytest.raises(BindingError, match="claimed by two devices"):
        _validate_entry(other, seen)


# ---------------------------------------------------------------------------
# the two checkouts collide, and which model binds first must not matter
# ---------------------------------------------------------------------------
def test_binding_a_local_model_first_does_not_break_the_upstream_ones():
    """`perif` and `core` exist in BOTH this repo and the pru-simulator.

    Resolving one by mutating sys.path and leaving it mutated makes every
    later import depend on binding order. The suite can be green on that by
    luck of alphabetical parametrisation, so the order is pinned here: local
    first, upstream second, the order that exposes a leaked sys.path entry.
    """
    build_device(bound("spi_adc"))
    for kind in ("ssi", "quadrature", "tca9538", "uart"):
        assert driven_pins(build_device(bound(kind))), \
            "%s stopped resolving after a perif model was bound" % kind
