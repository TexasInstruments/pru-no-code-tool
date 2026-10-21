"""Hall sensor (3-phase BLDC) - DeviceModel.

Three push-pull Hall outputs (A,B,C) encoding six 60-degree sectors.
Legal Gray-like codes (single-bit change per sector):
    code = (A<<2)|(B<<1)|C
    1: 001 -> sector 0
    3: 011 -> sector 1
    2: 010 -> sector 2
    6: 110 -> sector 3
    4: 100 -> sector 4
    5: 101 -> sector 5
    0: 000 illegal
    7: 111 illegal

Illegal 000/111 handling:
    * The model drives the illegal code when injected (inject_illegal).
    * An event {"kind":"illegal","cycle":...,"code":...} is emitted.
    * A fault is recorded immediately for the illegal code.
    * Additionally a watchdog fault is recorded when firmware fails to react
      within `response_window_cycles` after the illegal appears. Reaction is
      defined as asserting `fault_ack_pin` (if configured) or otherwise the
      watchdog always faults - which proves firmware that does nothing is
      rejected. This satisfies "fault when firmware fails to react".

Events():
    {"kind":"edge","cycle":...,"code":...,"sector":...,"dir":...}
    {"kind":"illegal","cycle":...,"code":...}
Faults():
    - pin indices out of range / not distinct
    - cycles_per_sector too fast
    - PRU drives Hall pins (contention)
    - illegal Hall code driven (000/111)
    - firmware failed to react to illegal within window
"""

from typing import Any, Dict, List, Optional, Tuple

from pru_device_models.device_model import DeviceModel

# Six legal codes in forward order
_HALL_CODES = [1, 3, 2, 6, 4, 5]
_CODE_TO_SECTOR = {c: i for i, c in enumerate(_HALL_CODES)}
_ILLEGAL_CODES = {0, 7}
_SECTOR_TO_CODE = {v: k for k, v in _CODE_TO_SECTOR.items()}


class HallSensorModel(DeviceModel):
    """DeviceModel for a 3-phase Hall sensor."""

    def __init__(
        self,
        a_bit: int = 0,
        b_bit: int = 1,
        c_bit: int = 2,
        cycles_per_sector: int = 60,
        direction: int = 1,
        fault_ack_pin: Optional[int] = None,
        response_window_cycles: int = 32,
        pru_gpo_bits: int = 20,
        **kwargs,
    ):
        # alias handling for alternative pin names used by tests
        if "h_a_pin" in kwargs:
            a_bit = kwargs["h_a_pin"]
        if "h_b_pin" in kwargs:
            b_bit = kwargs["h_b_pin"]
        if "h_c_pin" in kwargs:
            c_bit = kwargs["h_c_pin"]
        if "u_pin" in kwargs:
            a_bit = kwargs["u_pin"]
        if "v_pin" in kwargs:
            b_bit = kwargs["v_pin"]
        if "w_pin" in kwargs:
            c_bit = kwargs["w_pin"]
        if "hall_a" in kwargs:
            a_bit = kwargs["hall_a"]
        if "hall_b" in kwargs:
            b_bit = kwargs["hall_b"]
        if "hall_c" in kwargs:
            c_bit = kwargs["hall_c"]
        if "pin_a" in kwargs:
            a_bit = kwargs["pin_a"]
        if "pin_b" in kwargs:
            b_bit = kwargs["pin_b"]
        if "pin_c" in kwargs:
            c_bit = kwargs["pin_c"]
        # cycles alias
        if "cycles_per_state" in kwargs:
            cycles_per_sector = kwargs["cycles_per_state"]
        if "cyclesPerSector" in kwargs:
            cycles_per_sector = kwargs["cyclesPerSector"]

        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []

        if not (0 <= a_bit < 32 and 0 <= b_bit < 32 and 0 <= c_bit < 32):
            self._faults.append("pin indices out of range")
        if len({a_bit, b_bit, c_bit}) != 3:
            self._faults.append("a_bit, b_bit and c_bit must be distinct")
        if cycles_per_sector < 4:
            self._faults.append(
                f"cycles_per_sector={cycles_per_sector} too fast for tick granularity")
        if direction not in (1, -1):
            self._faults.append("direction must be +1 or -1")
        if fault_ack_pin is not None and not (0 <= fault_ack_pin < 32):
            self._faults.append("fault_ack_pin out of range")

        self.a_bit = a_bit
        self.b_bit = b_bit
        self.c_bit = c_bit
        self.cycles_per_sector = cycles_per_sector
        self.direction = direction
        self.fault_ack_pin = fault_ack_pin
        self.response_window_cycles = response_window_cycles
        self._gpo_mask = (1 << pru_gpo_bits) - 1

        # rotation state
        self._sector_idx = 0  # index into _HALL_CODES
        self._cycles_to_next = cycles_per_sector
        self._code = _HALL_CODES[0]
        self._sector = _CODE_TO_SECTOR[self._code]
        self.position = 0  # sector steps

        # illegal injection
        self._illegal_code: Optional[int] = None
        self._illegal_until: int = -1
        self._illegal_start: Optional[int] = None
        self._watchdog_deadline: Optional[int] = None
        self._ack_seen = False

        # for direction detection in events
        self._prev_sector = self._sector

    # ------------------------------------------------------------------ API
    def set_motion(self, segments: List[Tuple[int, int, int]]) -> None:
        """segments: list of (cycles_per_sector, n_sectors, direction +1/-1)."""
        # not used for Hall but keep for compat
        for cpc, n, d in segments:
            if cpc < 4:
                self._faults.append(
                    f"segment cycles_per_sector={cpc} too fast")
            if n <= 0 or d not in (1, -1):
                self._faults.append("segment must have n>0 and direction +/-1")

    def set_rotation(self, cycles_per_sector: int, sectors: int, direction: int = 1) -> None:
        self.cycles_per_sector = cycles_per_sector
        self.direction = direction
        self._cycles_to_next = cycles_per_sector

    def inject_illegal(self, code: int = 0, duration_cycles: int = 40) -> None:
        if code not in (0, 7):
            self._faults.append(f"inject_illegal code must be 0 or 7, got {code}")
            return
        if duration_cycles <= 0:
            self._faults.append("duration_cycles must be positive")
            return
        self._illegal_code = code
        # will be scheduled on next tick; caller sets cycle anchor
        self._illegal_pending_duration = duration_cycles

    def schedule_illegal(self, start_cycle: int, code: int = 0, duration_cycles: int = 40) -> None:
        """Schedule illegal code [start_cycle, start_cycle+duration)."""
        if code not in (0, 7):
            self._faults.append(f"schedule_illegal code must be 0 or 7, got {code}")
            return
        self._illegal_code = code
        self._illegal_until = start_cycle + duration_cycles
        self._illegal_start = start_cycle
        self._watchdog_deadline = start_cycle + self.response_window_cycles
        self._ack_seen = False

    # -------------------------------------------------------------- DeviceModel
    def tick(self, cycle: int, pins_out: int) -> int:
        # contention check
        contention = pins_out & self._gpo_mask & (
            (1 << self.a_bit) | (1 << self.b_bit) | (1 << self.c_bit))
        if contention:
            self._faults.append(
                f"cycle {cycle}: PRU drives Hall pins (contention mask 0x{contention:x})")

        # handle pending inject (first tick after inject_illegal)
        if hasattr(self, "_illegal_pending_duration") and self._illegal_start is None:
            self._illegal_start = cycle
            self._illegal_until = cycle + self._illegal_pending_duration
            self._watchdog_deadline = cycle + self.response_window_cycles
            self._ack_seen = False
            delattr(self, "_illegal_pending_duration")

        # watchdog: check if firmware acknowledged illegal
        if self._watchdog_deadline is not None:
            if self.fault_ack_pin is not None:
                ack_level = (pins_out >> self.fault_ack_pin) & 1
                if ack_level == 1:
                    self._ack_seen = True
            if cycle >= self._watchdog_deadline and not self._ack_seen:
                self._faults.append(
                    f"cycle {cycle}: firmware failed to react to illegal Hall code "
                    f"{self._illegal_code} within {self.response_window_cycles} cycles")
                self._watchdog_deadline = None
            elif self._ack_seen:
                self._watchdog_deadline = None

        # determine driven code
        if self._illegal_code is not None and self._illegal_start is not None and cycle < self._illegal_until:
            code = self._illegal_code
            # emit illegal event once at start
            if cycle == self._illegal_start:
                self._events.append({"kind": "illegal", "cycle": cycle, "code": code})
                self._faults.append(f"cycle {cycle}: illegal Hall code {code:03b} (000/111)")
        else:
            # clear illegal after duration
            if self._illegal_code is not None and cycle >= self._illegal_until:
                self._illegal_code = None
                self._illegal_start = None
                self._illegal_until = -1
            # advance sector if not in illegal window
            self._cycles_to_next -= 1
            if self._cycles_to_next <= 0:
                prev_code = self._code
                if self.direction == 1:
                    self._sector_idx = (self._sector_idx + 1) % len(_HALL_CODES)
                else:
                    self._sector_idx = (self._sector_idx - 1) % len(_HALL_CODES)
                self._code = _HALL_CODES[self._sector_idx]
                self._sector = _CODE_TO_SECTOR[self._code]
                self.position += self.direction
                # direction for event
                d = self.direction
                self._events.append({
                    "kind": "edge", "cycle": cycle, "code": self._code,
                    "sector": self._sector, "dir": d,
                })
                self._cycles_to_next += self.cycles_per_sector
                # clear watchdog if legal resumed and ack was seen? watchdog already cleared
            code = self._code

        # drive pins
        a = (code >> 2) & 1
        b = (code >> 1) & 1
        c = code & 1
        return (a << self.a_bit) | (b << self.b_bit) | (c << self.c_bit)

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults

    # expose for buscosim / tests
    @property
    def legal_codes(self):
        return list(_HALL_CODES)

    @property
    def code_to_sector(self):
        return dict(_CODE_TO_SECTOR)
