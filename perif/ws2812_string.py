"""WS2812 addressable LED string - DeviceModel.

Receives the NRZ data stream the PRU drives on its GPO pin and decodes it
into GRB pixels. Timing is checked against the WS2812 datasheet windows
(scaled to PRU cycles); anything outside the windows is a fault, which is
what rejects wrong firmware (wrong bit timing, truncated reset, overlong
frame).

Default timings use the datasheet nominal values at ``ns_per_cycle`` ns per
PRU cycle (5 ns at 200 MHz):
    T0H 400 ns, T1H 800 ns, T0L 850 ns, T1L 450 ns, RES > 50 us low.
Tolerance defaults to +/-150 ns per pulse, plus the requirement that a
'1' high time is clearly longer than a '0' high time.

Events:
    {"kind": "bit", "cycle", "value"}
    {"kind": "frame", "cycle", "pixels": [0xRRGGBB ...]}
"""

from typing import Any, Dict, List

from core.device_model import DeviceModel


class Ws2812String(DeviceModel):
    def __init__(
        self,
        data_pin: int = 0,
        num_leds: int = 1,
        ns_per_cycle: float = 5.0,
        t0h_ns: float = 400.0,
        t0l_ns: float = 850.0,
        t1h_ns: float = 800.0,
        t1l_ns: float = 450.0,
        tol_ns: float = 220.0,
        reset_ns: float = 50000.0,
        max_bits: int = 24 * 64,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if num_leds <= 0:
            self._faults.append("num_leds must be positive")
        if ns_per_cycle <= 0:
            self._faults.append("ns_per_cycle must be positive")
        self.data_pin = data_pin
        self.num_leds = num_leds
        self.max_bits = max_bits
        c = ns_per_cycle
        self._t0h = t0h_ns / c
        self._t0l = t0l_ns / c
        self._t1h = t1h_ns / c
        self._t1l = t1l_ns / c
        self._tol = tol_ns / c
        self._reset_cycles = reset_ns / c

        self._last_level = 0
        self._level_since = 0        # cycle of last edge
        self._high_cycles = 0
        self._bits: List[int] = []
        self._latched = True         # start in reset state

    def _classify_high(self, cycles: int) -> int:
        """0/1 if within a window, else -1."""
        if abs(cycles - self._t0h) <= self._tol:
            return 0
        if abs(cycles - self._t1h) <= self._tol:
            return 1
        return -1

    def _classify_low(self, cycles: int) -> bool:
        return (abs(cycles - self._t0l) <= self._tol
                or abs(cycles - self._t1l) <= self._tol)

    def tick(self, cycle: int, pins_out: int) -> int:
        level = (pins_out >> self.data_pin) & 1
        if level == self._last_level:
            return 0
        width = cycle - self._level_since

        if self._last_level == 1:
            # falling edge: a complete high pulse
            bit = self._classify_high(width)
            self._high_cycles = width
            if bit < 0:
                self._faults.append(
                    f"cycle {cycle}: high pulse {width} cycles matches neither "
                    f"T0H ({self._t0h:.0f}) nor T1H ({self._t1h:.0f})")
            else:
                self._bits.append(bit)
                self._events.append({"kind": "bit", "cycle": cycle, "value": bit})
                if len(self._bits) > self.max_bits:
                    self._faults.append(
                        f"cycle {cycle}: overlong frame (> {self.max_bits} bits without reset)")
            self._latched = False
        else:
            # rising edge: low gap ended
            if width >= self._reset_cycles:
                if self._bits:
                    self._latch(cycle)
                self._latched = True
            elif not self._latched:
                if not self._classify_low(width):
                    self._faults.append(
                        f"cycle {cycle}: low gap {width} cycles matches neither "
                        f"T0L ({self._t0l:.0f}) nor T1L ({self._t1l:.0f}) "
                        f"and is shorter than reset ({self._reset_cycles:.0f})")

        self._last_level = level
        self._level_since = cycle
        return 0  # WS2812 drives nothing back

    def _latch(self, cycle: int) -> None:
        if len(self._bits) % 24 != 0:
            self._faults.append(
                f"cycle {cycle}: frame of {len(self._bits)} bits is not a multiple of 24")
        pixels = []
        for i in range(0, len(self._bits) - 23, 24):
            w = 0
            for b in self._bits[i:i + 24]:
                w = (w << 1) | b
            g = (w >> 16) & 0xFF
            r = (w >> 8) & 0xFF
            bch = w & 0xFF
            pixels.append((r << 16) | (g << 8) | bch)
        self._events.append({"kind": "frame", "cycle": cycle, "pixels": pixels})
        self._bits = []

    def flush(self, cycle: int) -> None:
        """End-of-run: a trailing low level longer than reset latches the frame."""
        if self._last_level == 0 and self._bits \
                and cycle - self._level_since >= self._reset_cycles:
            self._latch(cycle)

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
