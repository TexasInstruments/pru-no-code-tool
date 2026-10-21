"""Quadrature encoder with index (Z) - DeviceModel.

Simulates an incremental rotary/linear encoder driving A, B and Z lines into
PRU GPI pins. The PRU only reads; ``pins_out`` is still checked so firmware
that wrongly drives the encoder lines is flagged as a bus-contention fault.

Motion is scripted as a list of ``(cycles_per_count, n_counts, direction)``
segments; a count is one x4 quadrature count (one state transition). The Z
(index) output pulses once per ``cpr`` counts of absolute shaft position.

Events (``events()``):
    {"kind": "edge", "cycle", "state", "count", "dir"}
    {"kind": "index", "cycle"}
Faults (``faults()``):
    - invalid construction parameters
    - PRU driving the encoder pins (contention)
    - segment requesting faster edges than the tick granularity allows
"""

from typing import Any, Dict, List, Tuple

from core.device_model import DeviceModel

# x4 state table: state = 2*A + B. Forward (CW) order 0,1,3,2,0...
_FWD = {0: 1, 1: 3, 3: 2, 2: 0}
_REV = {v: k for k, v in _FWD.items()}


class QuadratureIndexEncoder(DeviceModel):
    def __init__(
        self,
        a_bit: int = 0,
        b_bit: int = 1,
        z_bit: int = 2,
        cpr: int = 1024,
        index_width_cycles: int = 40,
        pru_gpo_bits: int = 20,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if not (0 <= a_bit < 32 and 0 <= b_bit < 32 and 0 <= z_bit < 32):
            self._faults.append("pin indices out of range")
        if len({a_bit, b_bit, z_bit}) != 3:
            self._faults.append("a_bit, b_bit and z_bit must be distinct")
        if cpr <= 0:
            self._faults.append("cpr must be positive")
        if index_width_cycles <= 0:
            self._faults.append("index_width_cycles must be positive")
        self.a_bit, self.b_bit, self.z_bit = a_bit, b_bit, z_bit
        self.cpr = cpr
        self.index_width_cycles = index_width_cycles
        self._gpo_mask = (1 << pru_gpo_bits) - 1

        # motion state
        self._segments: List[Tuple[int, int, int]] = []
        self._seg_idx = 0
        self._seg_counts_done = 0
        self._cycles_to_next_edge = 0
        self._state = 0            # 2A+B
        self.count = 0             # signed x4 count, absolute
        self._z_high_until = -1    # cycle at which Z deasserts
        self._done = False

    # ------------------------------------------------------------------ API
    def set_motion(self, segments: List[Tuple[int, int, int]]) -> None:
        """segments: list of (cycles_per_count, n_counts, direction +1/-1)."""
        for cpc, n, d in segments:
            if cpc < 4:
                self._faults.append(
                    f"segment cycles_per_count={cpc} too fast for tick granularity")
            if n <= 0 or d not in (+1, -1):
                self._faults.append("segment must have n_counts>0 and direction +/-1")
        self._segments = list(segments)
        self._seg_idx = 0
        self._seg_counts_done = 0
        if segments:
            self._cycles_to_next_edge = segments[0][0]

    # -------------------------------------------------------------- DeviceModel
    def tick(self, cycle: int, pins_out: int) -> int:
        contention = pins_out & self._gpo_mask & (
            (1 << self.a_bit) | (1 << self.b_bit) | (1 << self.z_bit))
        if contention:
            self._faults.append(
                f"cycle {cycle}: PRU drives encoder pins (contention mask 0x{contention:x})")

        if not self._done and self._segments:
            self._cycles_to_next_edge -= 1
            if self._cycles_to_next_edge <= 0:
                cpc, n, d = self._segments[self._seg_idx]
                prev = self._state
                self._state = _FWD[prev] if d > 0 else _REV[prev]
                self.count += d
                self._events.append({
                    "kind": "edge", "cycle": cycle, "state": self._state,
                    "count": self.count, "dir": d,
                })
                if self.count % self.cpr == 0 and self.count != 0:
                    self._z_high_until = cycle + self.index_width_cycles
                    self._events.append({"kind": "index", "cycle": cycle})
                self._seg_counts_done += 1
                if self._seg_counts_done >= n:
                    self._seg_idx += 1
                    self._seg_counts_done = 0
                    if self._seg_idx >= len(self._segments):
                        self._done = True
                    else:
                        cpc = self._segments[self._seg_idx][0]
                self._cycles_to_next_edge += cpc

        a = (self._state >> 1) & 1
        b = self._state & 1
        z = 1 if cycle <= self._z_high_until else 0
        return (a << self.a_bit) | (b << self.b_bit) | (z << self.z_bit)

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
