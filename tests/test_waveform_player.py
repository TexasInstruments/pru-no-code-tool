"""WaveformPlayer — cycle-keyed GPI stimulus as a DeviceModel.

Three required layers:

1. Unit: HOLD semantics and exhaustion-before-halt fault (runs anywhere,
   stdlib only, no simulator checkout needed — the player's tick is driven
   directly).
2. Contention: a player and a second push-pull device on the same pin MUST
   produce a contention fault through the real DeviceBus, not a silent
   takeover. Includes the sabotage control: with contention recording
   disabled, the SAME scenario records no fault — proving the main test's
   pass depends on the check and fails if the check is removed.
3. The full existing suite stays green (this file adds to it).

The bus tests need the TI pru-simulator checkout (the DeviceBus lives
there); they skip cleanly when it is absent, same as the ELF layer.
"""

import importlib.util
import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from pru_device_models.waveform_player import WaveformPlayer  # noqa: E402

MASK_20 = (1 << 20) - 1
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

_SIM_CANDIDATES = (
    os.environ.get("PRU_SIMULATOR_PATH"),
    os.path.join(ROOT, "external", "pru-simulator"),
    os.path.join(ROOT, "..", "pru-simulator"),
    os.path.join(ROOT, "..", "pru-simulator-upstream"),
    # a checkout two levels up, beside tools/
    os.path.join(ROOT, os.pardir, os.pardir, "tools", "pru-simulator-upstream"),
    "/opt/pru-simulator",
)


def _locate_simulator():
    # Same search order as tools/gpi_stimulus_runner.locate_simulator, including
    # the ancestor glob: without it the default clone layout (the checkout sits
    # two levels up beside tools/) does not resolve, and every bus test below
    # silently "skips" on a machine that does have the simulator.
    import glob
    ancestors = glob.glob(os.path.join(ROOT, os.pardir, os.pardir, "*",
                                       "tools", "pru-simulator-upstream"))
    for cand in filter(None, (*_SIM_CANDIDATES, *ancestors)):
        cand = os.path.abspath(cand)
        if os.path.isfile(os.path.join(cand, "simulator.py")):
            return cand
    return None


def _load_upstream_device_model():
    """Load the real DeviceBus from the simulator checkout, by path.

    By path, so the checkout's ``pru_io`` package is not bound in this
    process; the upstream module has no intra-package imports, so loading it
    standalone is safe.
    """
    sim = _locate_simulator()
    if sim is None:
        return None, None
    path = os.path.join(sim, "pru_io", "device_model.py")
    if not os.path.isfile(path):
        return None, None
    spec = importlib.util.spec_from_file_location("upstream_device_model", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, sim


_DM, _SIM = _load_upstream_device_model()
needs_bus = pytest.mark.skipif(_DM is None, reason="pru-simulator checkout not found")


# ---------------------------------------------------------------------------
# 1. Unit: HOLD semantics, cycle keying, exhaustion
# ---------------------------------------------------------------------------

def test_hold_semantics_value_applies_until_replaced():
    p = WaveformPlayer({0: 0x00005, 10: 0x0000A})
    # cycle 0..9 -> 0x5 ; 10 onward -> 0xA (HOLD)
    # default pins = every bit any word asserts: 0x5 | 0xA -> mask 0xF
    assert p.tick(0, MASK_20) == (0xF, 0x5)
    assert p.tick(5, MASK_20) == (0xF, 0x5)   # no new entry: still holding
    assert p.tick(9, MASK_20) == (0xF, 0x5)
    assert p.tick(10, MASK_20) == (0xF, 0xA)
    assert p.faults() == []                    # never ran past the last entry


def test_hold_before_first_entry_drives_nothing():
    p = WaveformPlayer({4: 0x8})
    assert p.tick(0, MASK_20) == (0, 0)
    assert p.tick(3, MASK_20) == (0, 0)
    assert p.tick(4, MASK_20)[1] == 0x8


def test_cycle_keyed_multi_entry_crossing_records_every_point():
    # A multi-cycle instruction advances cycles >1 per tick: entries crossed
    # in one tick are applied in order and each is recorded as an event.
    p = WaveformPlayer({1: 0x1, 2: 0x2, 7: 0x4})
    p.tick(0, MASK_20)
    p.tick(3, MASK_20)  # crossed entries at cycles 1 AND 2
    ev = [e["cycle"] for e in p.events()]
    assert ev == [1, 2]
    assert p.tick(3, MASK_20)[1] == 0x2         # entry 7 not yet reached


def test_exhaustion_before_halt_is_a_real_fault():
    p = WaveformPlayer({0: 0x1, 2: 0x2})
    p.tick(0, MASK_20)
    p.tick(2, MASK_20)
    assert p.faults() == []
    p.tick(3, MASK_20)  # waveform ran out, program has not halted
    assert p.exhausted
    faults = p.faults()
    assert len(faults) == 1 and "exhausted" in faults[0]
    # the fault must survive repeated ticks (flagged once, but stays listed)
    p.tick(4, MASK_20)
    assert len(p.faults()) == 1


def test_both_input_shapes_accepted():
    wrapped = WaveformPlayer({"gpi_word_by_cycle": {"0": 1, "5": 2}})
    bare = WaveformPlayer({"0": 1, "5": 2})
    assert wrapped.shape == "wrapped" and bare.shape == "bare"
    assert wrapped.tick(0, 0)[1] == bare.tick(0, 0)[1] == 1
    assert wrapped.tick(5, 0)[1] == bare.tick(5, 0)[1] == 2


def test_malformed_stimulus_refused():
    with pytest.raises(ValueError):
        WaveformPlayer({})
    with pytest.raises(ValueError):
        WaveformPlayer({"soon": 1})
    with pytest.raises(ValueError):
        WaveformPlayer({0: "high"})


def test_reset_clears_faults_events_and_position():
    p = WaveformPlayer({0: 1})
    p.tick(5, MASK_20)
    assert p.faults() and p.events()
    p.reset()
    assert p.faults() == [] and p.events() == [] and not p.exhausted


# ---------------------------------------------------------------------------
# 2. Contention through the real DeviceBus
# ---------------------------------------------------------------------------

def _stub_push_pull(pin, value):
    """Build the push-pull stub lazily.

    Deliberately NOT a module-level ``class _StubPushPull(_DM.DeviceModel)``:
    the base-class expression is evaluated at import, so with no simulator
    checkout ``_DM`` is None and the AttributeError takes down collection of
    this whole file -- including the stdlib-only unit tests above, which have
    no simulator dependency at all. A skipif marker cannot save a class
    statement; it is applied after the statement has already run.
    """
    class _StubPushPull(_DM.DeviceModel):
        name = "stub_push_pull"

        def __init__(self, pin, value):
            self.nets = {pin: _DM.PUSH_PULL}
            self.pin = pin
            self.value = value

        def tick(self, cycle, bus):
            return (1 << self.pin), (self.value << self.pin)

    return _StubPushPull(pin, value)


@needs_bus
def test_player_vs_device_same_pin_is_contention_not_takeover():
    DeviceBus = _DM.DeviceBus
    player = WaveformPlayer({0: 1 << 3}, pins=[3])   # drives pin 3 HIGH from cycle 0
    stub = _stub_push_pull(3, 0)                       # drives pin 3 LOW
    bus = DeviceBus()
    bus.attach(player)
    bus.attach(stub)
    bus.set_pru_drive_mask(MASK_20 & ~(1 << 3))      # pin 3 is an input to the PRU

    word = None
    for cycle in range(3):
        word = bus.settle(cycle, 0)

    contentions = [f for f in bus.faults() if "contention" in f]
    assert contentions, (
        "player and device drove opposite levels on pin 3 with no fault: "
        "the bus silently picked a winner")


@needs_bus
def test_sabotage_control_scenario_is_capable_of_silence():
    """If the contention check is removed, test_player_vs_device_same_pin...
    fails. This control proves the discrimination: with contention recording
    disabled (check 'removed'), the SAME scenario records NO fault — so the
    main test passes only because the check exists.
    """
    class NoContentionBus(_DM.DeviceBus):
        def _resolve(self, cycle, gpo, drives, record_contention):
            return super()._resolve(cycle, gpo, drives, False)

    player = WaveformPlayer({0: 1 << 3}, pins=[3])
    stub = _stub_push_pull(3, 0)
    bus = NoContentionBus()
    bus.attach(player)
    bus.attach(stub)
    bus.set_pru_drive_mask(MASK_20 & ~(1 << 3))
    for cycle in range(3):
        bus.settle(cycle, 0)
    assert [f for f in bus.faults() if "contention" in f] == [], (
        "sabotaged bus still faults; the control no longer proves the "
        "main test depends on the contention check")


# ---------------------------------------------------------------------------
# 3. Runner: subprocess path carries the in-process verdict
# ---------------------------------------------------------------------------

@needs_bus
def test_runner_subprocess_reports_devices_and_verdict(tmp_path):
    asm = tmp_path / "fw.asm"
    asm.write_text("LDI r0, 10\nHALT\n")
    stim = tmp_path / "wave.json"
    stim.write_text(json.dumps({"gpi_word_by_cycle": {"0": 5, "1": 7}}))

    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "gpi_stimulus_runner.py"),
         "--asm", str(asm), "--stimulus", str(stim), "--simulator", _SIM,
         "--max-cycles", "200"],
        capture_output=True, text=True)
    payload = json.loads(proc.stdout)  # exactly one JSON object on stdout
    assert payload["ok"] is True
    assert payload["halted"] is True
    assert payload["stimulus"]["shape"] == "wrapped"
    assert payload["stimulus"]["points"] == 2
    assert payload["devices"]["events"] == [
        {"kind": "gpi_word", "cycle": 0, "value": 5, "device": "waveform_player"},
        {"kind": "gpi_word", "cycle": 1, "value": 7, "device": "waveform_player"},
    ]
    assert payload["devices"]["faults"] == []
    assert proc.returncode == 0


@needs_bus
def test_runner_subprocess_exhaustion_flips_verdict(tmp_path):
    asm = tmp_path / "fw.asm"
    asm.write_text("LDI r0, 10\nHALT\n")
    stim = tmp_path / "wave.json"
    stim.write_text(json.dumps({"0": 5}))  # exhausted immediately

    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "gpi_stimulus_runner.py"),
         "--asm", str(asm), "--stimulus", str(stim), "--simulator", _SIM,
         "--max-cycles", "200"],
        capture_output=True, text=True)
    payload = json.loads(proc.stdout)
    assert payload["ok"] is False
    assert payload["exhausted"] is True
    assert any("exhausted" in f for f in payload["devices"]["faults"])
    assert proc.returncode == 1
