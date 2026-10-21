#!/usr/bin/env python3
"""gpi_stimulus_runner.py — run PRU firmware under a cycle-keyed GPI waveform.

This runner attaches the waveform to the simulation through the DeviceBus
(``io_port.attach_device(WaveformPlayer(...))``) instead of poking
``set_gpi_word`` / ``io_port.gpi`` past the bus. Writing GPI directly would mean:

  * no contention resolution — a stimulus shorted against a device model
    (or against PRU-driven pins) looked identical to a clean one;
  * no ``events()`` — the applied points could not be diffed against the
    independent bus-cosim decoder like every other device's;
  * step-indexed application, because the injection site saw instruction
    counts, not ``counters.cycles`` — under any multi-cycle instruction a
    different experiment than the one intended.

CONTRACT
--------
Exactly one JSON object on stdout, always. Exit codes:

    0  ran to HALT with no faults
    1  ran, but faults were recorded (device, bus/contention, exhaustion,
       or core faults) or the run hit --max-cycles without halting
    2  setup failure (unparsable stimulus, no simulator, asm parse errors);
       the JSON object carries "ok": false and "errors"

The payload's ``devices`` object carries the same ``{events, faults}`` the
in-process DeviceBus exposes, so a subprocess consumer reaches the same
verdict an in-process one would.

USAGE
-----
    python3 tools/gpi_stimulus_runner.py \
        --asm firmware.asm \
        --stimulus waveform.json  # or '-' for stdin
        [--simulator PATH] [--max-cycles N]
        [--pins 3,5] [--trace-r31]

The stimulus JSON is accepted in BOTH emitter shapes: the wrapped
``{"gpi_word_by_cycle": {"0": 8, ...}}`` form and the bare
``{"0": 8, ...}`` map. Keys are PRU CYCLES (the cycle counter value at bus
settle), not instruction indexes. HOLD semantics apply; running past the
last entry raises a waveform-exhausted fault, which lands in
``devices.faults`` and flips the exit code.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import sys

MASK_20 = (1 << 20) - 1

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SIMULATOR_CANDIDATES = (
    os.environ.get("PRU_SIMULATOR_PATH"),
    os.path.join(ROOT, "external", "pru-simulator"),
    os.path.join(ROOT, "..", "pru-simulator"),
    os.path.join(ROOT, "..", "pru-simulator-upstream"),
    os.path.join(ROOT, os.pardir, os.pardir, "tools", "pru-simulator-upstream"),
    "/opt/pru-simulator",
)


def locate_simulator(explicit=None):
    """Find the TI pru-simulator checkout (a directory holding simulator.py)."""
    import glob
    tried = []
    ancestors = glob.glob(os.path.join(ROOT, os.pardir, os.pardir, "*",
                                       "tools", "pru-simulator-upstream"))
    for cand in filter(None, (explicit, *SIMULATOR_CANDIDATES, *ancestors)):
        cand = os.path.abspath(cand)
        tried.append(cand)
        if os.path.isfile(os.path.join(cand, "simulator.py")):
            return cand
    raise RuntimeError(
        "no pru-simulator checkout found (looked for simulator.py in:\n  "
        + "\n  ".join(tried) + ")")


def load_waveform_player_module():
    """Load pru_io/waveform_player.py from THIS repo.

    Deliberately by path: inside the runner the name ``pru_io`` may already
    be bound to the simulator checkout's package (the bus we need comes from
    there), so a plain ``import pru_io.waveform_player`` could resolve to the
    wrong tree. The module itself picks whichever DeviceModel base is
    importable; the bus never isinstance-checks, so the wire contract is
    what matters.
    """
    path = os.path.join(ROOT, "pru_io", "waveform_player.py")
    spec = importlib.util.spec_from_file_location("waveform_player", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FaultCapture(logging.Handler):
    """The core logs LBBO/SBBO-against-unmapped faults and HALTS; a run that
    printed faults must not be laundered into a clean one."""

    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.faults = []

    def emit(self, record):
        self.faults.append(record.getMessage())


def run(args) -> int:
    out = {}
    def emit(code):
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return code

    # -- stimulus (fail closed on anything we cannot read exactly) --------
    try:
        raw = sys.stdin.read() if args.stimulus == "-" else \
            open(args.stimulus, "r", encoding="utf-8").read()
        stimulus = json.loads(raw)
    except (OSError, ValueError) as exc:
        out.update({"ok": False, "errors": [f"stimulus: {exc}"]})
        return emit(2)

    try:
        sim_root = locate_simulator(args.simulator)
    except RuntimeError as exc:
        out.update({"ok": False, "errors": [str(exc)]})
        return emit(2)

    pins = None
    if args.pins:
        try:
            pins = [int(p) for p in args.pins.split(",")]
        except ValueError:
            out.update({"ok": False, "errors": [f"--pins: {args.pins!r}"]})
            return emit(2)

    try:
        asm = open(args.asm, "r", encoding="utf-8").read()
    except OSError as exc:
        out.update({"ok": False, "errors": [f"asm: {exc}"]})
        return emit(2)

    # -- import order matters: simulator first so its core/pru_io bind, ---
    # -- then the player by path (see load_waveform_player_module) --------
    sys.path.insert(0, sim_root)
    from simulator import Simulator  # noqa: E402
    from pru_io.device_model import DeviceBus  # noqa: F401,E402  (same tree as the core)
    wp = load_waveform_player_module()

    try:
        player = wp.WaveformPlayer(stimulus, pins=pins)
    except ValueError as exc:
        out.update({"ok": False, "errors": [f"stimulus: {exc}"]})
        return emit(2)

    sim = Simulator(config_path="nonexistent.cfg")
    errs = sim.load("pru0", asm)
    if errs:
        out.update({"ok": False, "parse": False, "errors": errs[:10]})
        return emit(2)

    core = sim.cores["pru0"]

    # Attach through the bus — never past it. IOPort.tick_devices writes
    # only device-driven pins back into GPI, and the narrowed PRU drive mask
    # keeps the (input) stimulus pins from contending with the core's own
    # R30 output word.
    bus: DeviceBus = core.io_port.device_bus
    bus.attach(player)
    bus.set_pru_drive_mask(MASK_20 & ~player.drive_mask)

    capture = _FaultCapture()
    core_logger = logging.getLogger(type(core).__module__)
    core_logger.addHandler(capture)

    r31 = []
    steps = 0
    try:
        while not core.halted and steps < args.max_cycles:
            core.step()
            steps += 1
            if args.trace_r31:
                r31.append(core.io_port.read_r31() & MASK_20)
    except Exception as exc:  # noqa: BLE001 - the class and message ARE the result
        out.update({"ok": False, "halted": core.halted, "steps": steps,
                    "cycles": core.counters.cycles,
                    "errors": [f"{type(exc).__name__}: {exc}"[:200]],
                    "devices": {"events": bus.events(), "faults": bus.faults()}})
        return emit(1)
    finally:
        core_logger.removeHandler(capture)

    device_faults = bus.faults()
    all_faults = list(capture.faults) + device_faults
    clean = core.halted and not all_faults
    out.update({
        "ok": clean,
        "parse": True,
        "halted": core.halted,
        "steps": steps,
        "cycles": core.counters.cycles,
        "stimulus": {
            "shape": player.shape,
            "points": len(player._points),
            "last_cycle": player._points[-1][0],
            "pins": player.pins,
        },
        "exhausted": player.exhausted,
        "faults": all_faults[:50],
        "devices": {"events": bus.events(), "faults": device_faults[:50]},
    })
    if args.trace_r31:
        out["r31"] = r31
    return emit(0 if clean else 1)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Run PRU assembly under a cycle-keyed GPI waveform "
                    "attached through the DeviceBus.")
    ap.add_argument("--asm", required=True, help="PRU assembly source file")
    ap.add_argument("--stimulus", required=True,
                    help="JSON waveform file ('-' for stdin); wrapped "
                         '{"gpi_word_by_cycle": {...}} or bare {cycle: word}')
    ap.add_argument("--simulator", default=None,
                    help="path to the TI pru-simulator checkout "
                         "(default: PRU_SIMULATOR_PATH, then candidates)")
    ap.add_argument("--max-cycles", type=int, default=100000)
    ap.add_argument("--pins", default=None,
                    help="comma-separated driven pin list (default: every "
                         "bit the waveform asserts)")
    ap.add_argument("--trace-r31", action="store_true",
                    help="include the per-step resolved R31 word in the payload")
    args = ap.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
