"""STEP/DIR stepper driver input stage - DeviceModel.

Receives STEP/DIR pulses from the PRU (e.g. a stepper block) and
tracks shaft position in whole steps. This is the driver-input model: it
checks the timing contract a real driver (DRV8825-class) imposes, which is
what rejects wrong firmware.

Faults:
    - STEP high or low pulse narrower than ``min_pulse_cycles``
    - DIR changed within ``dir_setup_cycles`` before a STEP rising edge
    - STEP activity while the driver is disabled (EN low), if en_pin is set

Events:
    {"kind": "step", "cycle", "position", "dir"}
"""

from typing import Any, Dict, List, Optional

from core.device_model import DeviceModel


class StepDirDriver(DeviceModel):
    def __init__(
        self,
        step_pin: int = 0,
        dir_pin: int = 1,
        en_pin: Optional[int] = None,
        min_pulse_cycles: int = 20,
        dir_setup_cycles: int = 10,
        dir_positive: int = 1,       # DIR level meaning +1 step
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if step_pin == dir_pin:
            self._faults.append("step_pin and dir_pin must differ")
        if min_pulse_cycles < 1:
            self._faults.append("min_pulse_cycles must be >= 1")
        if dir_positive not in (0, 1):
            self._faults.append("dir_positive must be 0 or 1")
        self.step_pin = step_pin
        self.dir_pin = dir_pin
        self.en_pin = en_pin
        self.min_pulse_cycles = min_pulse_cycles
        self.dir_setup_cycles = dir_setup_cycles
        self.dir_positive = dir_positive

        self.position = 0
        self._last_step = 0
        self._step_since = 0
        self._seen_first_low = False
        self._last_dir = -1
        self._dir_since = 0

    def tick(self, cycle: int, pins_out: int) -> int:
        step = (pins_out >> self.step_pin) & 1
        d = (pins_out >> self.dir_pin) & 1
        en = (pins_out >> self.en_pin) & 1 if self.en_pin is not None else 1

        if d != self._last_dir:
            self._last_dir = d
            self._dir_since = cycle

        if step == self._last_step:
            return 0

        width = cycle - self._step_since
        if step == 1:
            # rising edge of STEP: one micro-step is taken here
            if self._seen_first_low and width < self.min_pulse_cycles:
                self._faults.append(
                    f"cycle {cycle}: STEP low pulse {width} < min {self.min_pulse_cycles}")
            if self.en_pin is not None and en == 0:
                self._faults.append(f"cycle {cycle}: STEP while driver disabled")
            if cycle - self._dir_since < self.dir_setup_cycles:
                self._faults.append(
                    f"cycle {cycle}: DIR setup {cycle - self._dir_since} "
                    f"< min {self.dir_setup_cycles}")
            direction = 1 if d == self.dir_positive else -1
            self.position += direction
            self._events.append({
                "kind": "step", "cycle": cycle,
                "position": self.position, "dir": direction,
            })
        else:
            # falling edge: completed high pulse
            if width < self.min_pulse_cycles:
                self._faults.append(
                    f"cycle {cycle}: STEP high pulse {width} < min {self.min_pulse_cycles}")
            self._seen_first_low = True

        self._last_step = step
        self._step_since = cycle
        return 0  # open-loop driver: nothing to feed back

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
