"""Dual-channel OSSD emitter - DeviceModel.

Drives two normally-high safety channels (CH_A, CH_B) into PRU GPI pins.
Models three behaviours the monitor must distinguish:

* OSSD test pulses - short LOW pulses (typically 100 us to 1 ms, i.e.
  ~20k-200k PRU cycles at 200 MHz). A correct monitor tolerates them
  and keeps the safety output asserted.
* Genuine trips - one or both channels LOW for longer than the OSSD
  maximum. A correct monitor must de-assert / signal fault.
* Channel disagreement - channels at different levels for longer than
  the configured discrepancy window. Within the window (and within the
  OSSD max) is tolerable OSSD staggering; beyond it is a fault.

The model is push-pull: it drives the two pins, the PRU only reads.
``pins_out`` is checked for contention (firmware must not drive these
pins).

Schedule API
------------
Schedule events before or during a run; ``tick`` resolves them
cycle-by-cycle. All times are PRU core cycles (1 cycle = 5 ns at
200 MHz).

Events / faults / oracle
------------------------
``events()`` records injected pulses/trips; ``faults()`` records
construction or electrical errors. ``perif/buscosim.decode_ossd`` is the
independent oracle that re-derives pulse classes from the resolved pin
trace and must agree with this model's classification.

Timing notes
------------
Typical OSSD test-pulse width range quoted by light-curtain and
safety-PLC vendors is 100 us - 1 ms. At 200 MHz that is 20 000 -
200 000 cycles. The model's defaults are scaled for fast simulation
(80 - 400 cycles) so tests do not need 200k-cycle runs, but any
width can be configured; the oracle uses the caller's thresholds, so
the distinction is always explicit. Keep claims tied to the configured
thresholds, not to the nominal 100 us figure.
"""

from typing import Any, Dict, List, Optional, Tuple

from core.device_model import DeviceModel


class DualOssdEmitter(DeviceModel):
    """Dual-channel OSSD source driving two GPI pins.

    Channels idle HIGH. Injected activity drives them LOW.

    Args:
        ch_a_pin, ch_b_pin: GPI bit positions (0..19, distinct).
        ossd_min_cycles: minimum test-pulse width considered OSSD
            (pulses narrower are timing faults). Default 20.
        ossd_max_cycles: maximum test-pulse width still classified as
            OSSD (wider is a genuine trip). Default 400.
        discrepancy_cycles: reference window for the monitor's channel-
            disagreement timer (informational; the model's
            ``decode`` oracle uses the caller's value). Default 500.
    """

    def __init__(
        self,
        ch_a_pin: int = 0,
        ch_b_pin: int = 1,
        ossd_min_cycles: int = 20,
        ossd_max_cycles: int = 400,
        discrepancy_cycles: int = 500,
        pru_gpo_bits: int = 20,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if not (0 <= ch_a_pin < 32 and 0 <= ch_b_pin < 32):
            self._faults.append("pin indices out of range")
        if ch_a_pin == ch_b_pin:
            self._faults.append("ch_a_pin and ch_b_pin must differ")
        if ossd_min_cycles < 1 or ossd_max_cycles < 1:
            self._faults.append("ossd pulse bounds must be >= 1")
        if ossd_min_cycles > ossd_max_cycles:
            self._faults.append("ossd_min_cycles must be <= ossd_max_cycles")
        if discrepancy_cycles < 1:
            self._faults.append("discrepancy_cycles must be >= 1")
        self.ch_a_pin = ch_a_pin
        self.ch_b_pin = ch_b_pin
        self.ossd_min_cycles = ossd_min_cycles
        self.ossd_max_cycles = ossd_max_cycles
        self.discrepancy_cycles = discrepancy_cycles
        self._gpo_mask = (1 << pru_gpo_bits) - 1

        # scheduled intervals: list of (start, end_exclusive, kind, channel)
        # kind: "ossd" (single channel low), "trip" (both low),
        #       "single_low" (one channel low, for discrepancy tests)
        self._schedule: List[Tuple[int, int, str, Optional[int]]] = []
        # runtime: last driven levels for edge detection
        self._prev_a = 1
        self._prev_b = 1
        self._low_since_a: Optional[int] = None
        self._low_since_b: Optional[int] = None

    # ------------------------------------------------------------------ schedule
    def schedule_ossd_pulse(self, channel: str, start: int, width: int) -> None:
        """Schedule a short LOW test pulse on 'A' or 'B'."""
        if channel not in ("A", "B"):
            self._faults.append(f"unknown channel '{channel}'")
            return
        if width < 1:
            self._faults.append("pulse width must be >= 1")
            return
        ch = 0 if channel == "A" else 1
        self._schedule.append((start, start + width, "ossd", ch))
        self._schedule.sort()

    def schedule_trip(self, start: int, duration: int) -> None:
        """Both channels LOW for duration (genuine trip)."""
        if duration < 1:
            self._faults.append("trip duration must be >= 1")
            return
        self._schedule.append((start, start + duration, "trip", None))
        self._schedule.sort()

    def schedule_single_low(self, channel: str, start: int, duration: int) -> None:
        """One channel LOW while the other stays HIGH (disagreement)."""
        if channel not in ("A", "B"):
            self._faults.append(f"unknown channel '{channel}'")
            return
        ch = 0 if channel == "A" else 1
        self._schedule.append((start, start + duration, "single_low", ch))
        self._schedule.sort()

    def clear_schedule(self) -> None:
        self._schedule = []
        self._events = []
        self._prev_a = 1
        self._prev_b = 1
        self._low_since_a = None
        self._low_since_b = None

    # ---------------------------------------------------------------- internal
    def _level_at(self, cycle: int, ch: int) -> int:
        """1 = high, 0 = low."""
        level = 1
        for s, e, kind, c in self._schedule:
            if s <= cycle < e:
                if kind == "trip":
                    return 0
                if kind == "ossd" and c == ch:
                    return 0
                if kind == "single_low" and c == ch:
                    return 0
        return level

    # -------------------------------------------------------------- DeviceModel
    def tick(self, cycle: int, pins_out: int) -> int:
        contention = pins_out & self._gpo_mask & (
            (1 << self.ch_a_pin) | (1 << self.ch_b_pin)
        )
        if contention:
            self._faults.append(
                f"cycle {cycle}: PRU drives OSSD input pins (contention mask 0x{contention:x})"
            )
        a = self._level_at(cycle, 0)
        b = self._level_at(cycle, 1)

        # edge -> event on rising edge (end of low)
        if self._prev_a == 0 and a == 1 and self._low_since_a is not None:
            width = cycle - self._low_since_a
            kind = "ossd_pulse" if width <= self.ossd_max_cycles else "trip"
            if width < self.ossd_min_cycles:
                self._faults.append(
                    f"cycle {cycle}: CH_A pulse {width} < ossd_min {self.ossd_min_cycles}"
                )
            self._events.append(
                {"kind": kind, "cycle": cycle, "channel": "A", "width": width}
            )
            self._low_since_a = None
        if self._prev_b == 0 and b == 1 and self._low_since_b is not None:
            width = cycle - self._low_since_b
            kind = "ossd_pulse" if width <= self.ossd_max_cycles else "trip"
            if width < self.ossd_min_cycles:
                self._faults.append(
                    f"cycle {cycle}: CH_B pulse {width} < ossd_min {self.ossd_min_cycles}"
                )
            self._events.append(
                {"kind": kind, "cycle": cycle, "channel": "B", "width": width}
            )
            self._low_since_b = None

        if self._prev_a == 1 and a == 0:
            self._low_since_a = cycle
        if self._prev_b == 1 and b == 0:
            self._low_since_b = cycle

        # also record trip events where both low together - detect on falling edge of either
        # use simple check: when both just went low together
        if a == 0 and b == 0 and (self._prev_a == 1 or self._prev_b == 1):
            # start of a both-low interval; actual classification on rise
            pass

        self._prev_a = a
        self._prev_b = b

        # drive GPI: high=1, low=0
        word = 0
        if a:
            word |= 1 << self.ch_a_pin
        if b:
            word |= 1 << self.ch_b_pin
        return word

    def flush(self, cycle: int) -> None:
        """Close any open low at end of run."""
        if self._low_since_a is not None:
            width = cycle - self._low_since_a
            kind = "ossd_pulse" if width <= self.ossd_max_cycles else "trip"
            self._events.append(
                {"kind": kind, "cycle": cycle, "channel": "A", "width": width}
            )
            self._low_since_a = None
        if self._low_since_b is not None:
            width = cycle - self._low_since_b
            kind = "ossd_pulse" if width <= self.ossd_max_cycles else "trip"
            self._events.append(
                {"kind": kind, "cycle": cycle, "channel": "B", "width": width}
            )
            self._low_since_b = None

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
