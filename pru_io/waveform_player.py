"""WaveformPlayer — cycle-keyed R31 stimulus as a DeviceModel.

WHY
---
Injecting GPI stimulus by writing ``io_port.gpi`` (or ``set_gpi_word``)
bypasses the device bus entirely: nothing resolves the injected word against
what the PRU or another device drives on those pins, so a stimulus that
shorts against a device model looks identical to one that does not, and the
applied points never appear in ``events()`` to be diffed against the
bus-cosim decoder. This module is that missing stimulus device.

CYCLES, NOT STEPS
-----------------
The map is keyed by PRU CYCLE — the value ``counters.cycles`` has when the
bus settles — not by instruction index. Under any multi-cycle instruction
(SBBO with stalls, loops, delayed branches) ``cycles`` advances more than
one per step, so a step-indexed and a cycle-indexed waveform are different
experiments. Keying by step silently turns a multi-cycle run into a
time-shifted one; keying by cycle is what the hardware would see. The core
settles the bus at ``counters.cycles`` (pru_core.py, post-instruction
settle), so a player attached through ``DeviceBus`` is cycle-keyed by
construction.

HOLD SEMANTICS
--------------
A value applies from its cycle until the next entry replaces it. If a tick
crosses several entries in one call (a multi-cycle instruction advanced the
clock past them), every crossed entry is applied in order and each is
recorded as an event.

EXHAUSTION IS A FAULT
---------------------
Running past the last entry — the waveform exhausted before the program
halted — raises a real fault, not a payload flag. Stimulus beyond the end of
the waveform is unspecified; a run that keeps executing on held inputs looks
green while proving nothing, so it must not be ignorable. The last value is
still HELD on the pins (that is what pull-ups and latches do), but the fault
stands.

WIRE CONTRACT
-------------
Implements the TI pru-simulator ``DeviceBus`` device contract: ``tick``
returns ``(drive_mask, drive_values)``, ``nets`` declares the driven pins
(push-pull: a stimulus source colliding with another driver is contention,
which the bus records as a fault rather than silently resolving), and
``time_driven = True`` because the player advances with the clock, not with
pin activity.

Accepts both emitter shapes: the wrapped ``{"gpi_word_by_cycle": {...}}``
form and the bare ``{cycle: value}`` map. Keys may be ints or numeric
strings (JSON objects arrive string-keyed).
"""

from typing import Any, Dict, List, Optional, Tuple

MASK_20 = (1 << 20) - 1
PUSH_PULL = "push_pull"

try:  # this repo's ABC
    from core.device_model import DeviceModel  # type: ignore
except ImportError:  # pragma: no cover - loaded inside the TI pru-simulator
    from pru_io.device_model import DeviceModel  # type: ignore


class WaveformPlayer(DeviceModel):
    #: advances with the clock, not with pin activity
    time_driven = True

    def __init__(self, stimulus: Optional[Dict[Any, int]] = None, *,
                 pins: Optional[List[int]] = None,
                 gpi_word_by_cycle: Optional[Dict[Any, int]] = None,
                 name: str = "waveform_player"):
        if stimulus is not None and gpi_word_by_cycle is not None:
            raise ValueError("pass either stimulus= or gpi_word_by_cycle=, not both")
        data = stimulus if stimulus is not None else gpi_word_by_cycle
        if data is None:
            data = {}
        if isinstance(data, dict) and set(data.keys()) == {"gpi_word_by_cycle"}:
            self.shape = "wrapped"
            data = data["gpi_word_by_cycle"]
        else:
            self.shape = "bare"
        if not isinstance(data, dict) or not data:
            raise ValueError(
                "waveform must be a non-empty {cycle: word} map or "
                '{"gpi_word_by_cycle": {...}}')

        points: List[Tuple[int, int]] = []
        for k, v in data.items():
            try:
                cyc = int(k)
            except (TypeError, ValueError):
                raise ValueError(f"waveform key {k!r} is not a cycle number") from None
            if cyc < 0:
                raise ValueError(f"waveform cycle {cyc} is negative")
            try:
                word = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"waveform value at cycle {cyc} is not an integer") from None
            points.append((cyc, word & MASK_20))
        points.sort()
        self._points = points

        if pins is not None:
            for p in pins:
                if p < 0 or p > 19:
                    raise ValueError(f"pin {p} out of range 0..19")
            driven = sorted(set(pins))
        else:
            # every bit any word asserts; a bit the waveform never sets is
            # never driven (it stays with whatever else owns it)
            driven = sorted({b for _, w in points for b in range(20) if w & (1 << b)})
            if not driven:
                raise ValueError(
                    "waveform asserts no bits and no pins= given; "
                    "such a player drives nothing")
        self.pins: List[int] = driven
        self.nets: Dict[int, str] = {p: PUSH_PULL for p in driven}
        self.drive_mask = sum(1 << p for p in driven)
        self.name = name

        self._events: List[Dict[str, Any]] = []
        self._faults: List[str] = []
        self._idx = 0
        self._current: Optional[int] = None
        self._exhausted = False

    # -- DeviceBus wire contract -------------------------------------------

    def tick(self, cycle: int, bus: int) -> Tuple[int, int]:
        """Advance to *cycle*. Returns (drive_mask, drive_values).

        HOLD: the newest entry at or before *cycle* applies. Entries the
        clock crossed since the last tick are applied (and recorded) in
        order, so a multi-cycle instruction cannot swallow a point.
        """
        while self._idx < len(self._points) and self._points[self._idx][0] <= cycle:
            cyc, word = self._points[self._idx]
            self._current = word
            self._idx += 1
            self._events.append({"kind": "gpi_word", "cycle": cyc, "value": word})
        if self._points and cycle > self._points[-1][0] and not self._exhausted:
            self._exhausted = True
            self._faults.append(
                f"cycle {cycle}: waveform exhausted before halt "
                f"(last entry at cycle {self._points[-1][0]}; "
                f"holding its value — inputs past this point are unspecified)")
        if self._current is None:
            return 0, 0
        return self.drive_mask, self._current

    def events(self) -> List[Dict[str, Any]]:
        return list(self._events)

    def faults(self) -> List[str]:
        return list(self._faults)

    @property
    def exhausted(self) -> bool:
        return self._exhausted

    # -- codebase convention: reset / snapshot / restore / get_state --------

    def reset(self) -> None:
        self._events.clear()
        self._faults.clear()
        self._idx = 0
        self._current = None
        self._exhausted = False

    def snapshot(self) -> dict:
        return {"idx": self._idx, "current": self._current,
                "exhausted": self._exhausted}

    def restore(self, snap: dict) -> None:
        self._idx = snap["idx"]
        self._current = snap["current"]
        self._exhausted = snap["exhausted"]

    def get_state(self) -> dict:
        return {"name": self.name, "pins": list(self.pins),
                "points": len(self._points),
                "applied": self._idx,
                "exhausted": self._exhausted,
                "faults": len(self._faults)}
