"""SPI ADC (ADS8688-class, SPI mode 0) - DeviceModel.

The PRU is the controller (drives SCLK / SDO=MOSI / CS); the ADC is the
peripheral and drives SDI=MISO. Mode 0: clock idles low; the controller
sets MOSI while the clock is low and samples MISO on the rising edge; the
peripheral samples MOSI on the rising edge and advances MISO on the falling
edge. The ADC presents its MSB from the moment CS asserts.

``conversion`` is the value the ADC shifts out, MSB first, ``bits`` wide.
The ADC also records the MOSI command word it received.

Faults (what rejects wrong firmware):
    - SCLK edge while CS is deasserted (CS high, never asserted)
    - SCLK edge with no CS assertion edge since reset (CS never raised
    past its reset level, so no frame ever opened)
    - frame with other than ``bits`` clocks when CS releases
    - more than ``bits`` clocks in a frame
    - CS re-asserted mid-frame
    (CS low at reset is the reset level, not an assertion edge: a controller
    that clocks straight out of reset-low faults with "no CS assertion edge
    since reset", not "CS deasserted" - CS is physically LOW at that point.)

Events:
    {"kind": "transaction", "cycle", "miso", "mosi", "bits"}
"""

from typing import Any, Dict, List

from pru_device_models.device_model import DeviceModel


class SpiAdc(DeviceModel):
    def __init__(
        self,
        sclk_pin: int = 0,
        sdi_pin: int = 1,      # PRU reads this (ADC MISO)
        sdo_pin: int = 2,      # PRU drives this (ADC MOSI)
        cs_pin: int = 3,
        bits: int = 16,
        conversion: int = 0,
        miso_idle: int = 0,
        msb_first: bool = True,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if len({sclk_pin, sdi_pin, sdo_pin, cs_pin}) != 4:
            self._faults.append("sclk/sdi/sdo/cs pins must be distinct")
        if not (1 <= bits <= 32):
            self._faults.append("bits must be 1..32")
        self.sclk_pin = sclk_pin
        self.sdi_pin = sdi_pin
        self.sdo_pin = sdo_pin
        self.cs_pin = cs_pin
        self.bits = bits
        self.conversion = conversion & ((1 << bits) - 1)
        self.miso_idle = miso_idle
        self.msb_first = msb_first

        self._last_sclk = 0
        self._last_cs = 1
        self._primed = False    # first tick = reset level, not an edge
        self._in_frame = False
        self._clk_count = 0     # rising edges seen in this frame
        self._bit_ptr = 0       # MISO bit index currently driven
        self._mosi = 0

    def _miso(self) -> int:
        if not self._in_frame or self._bit_ptr >= self.bits:
            return self.miso_idle
        if self.msb_first:
            return (self.conversion >> (self.bits - 1 - self._bit_ptr)) & 1
        return (self.conversion >> self._bit_ptr) & 1

    def tick(self, cycle: int, pins_out: int) -> int:
        sclk = (pins_out >> self.sclk_pin) & 1
        cs = (pins_out >> self.cs_pin) & 1
        mosi = (pins_out >> self.sdo_pin) & 1

        if not self._primed:
            # The level seen on the first tick is the reset state (PRU R30
            # resets to 0), not a CS edge: a CS low from reset is not a frame
            # assertion. Only a later genuine fall opens a frame.
            self._primed = True
            self._last_cs = cs

        if cs != self._last_cs:
            self._last_cs = cs
            if cs == 0:
                if self._in_frame:
                    self._faults.append(f"cycle {cycle}: CS re-asserted mid-frame")
                self._in_frame = True
                self._clk_count = 0
                self._bit_ptr = 0
                self._mosi = 0
            else:
                if self._in_frame:
                    if self._clk_count != self.bits:
                        self._faults.append(
                            f"cycle {cycle}: frame released after {self._clk_count} "
                            f"clocks, expected {self.bits}")
                    else:
                        self._events.append({
                            "kind": "transaction", "cycle": cycle,
                            "miso": self.conversion, "mosi": self._mosi,
                            "bits": self.bits,
                        })
                    self._in_frame = False

        if sclk != self._last_sclk:
            self._last_sclk = sclk
            if not self._in_frame:
                if cs == 0:
                    # CS never raised past its reset level: no assertion edge
                    # was ever seen, and CS is physically LOW here.
                    self._faults.append(f"cycle {cycle}: SCLK edge with no CS assertion edge since reset")
                else:
                    self._faults.append(f"cycle {cycle}: SCLK edge while CS deasserted")
            elif sclk == 1:
                # rising edge: sample MOSI (controller samples MISO here too,
                # so MISO must NOT move on this edge)
                if self.msb_first:
                    self._mosi = ((self._mosi << 1) | mosi) & 0xFFFFFFFF
                else:
                    self._mosi |= mosi << self._clk_count
                self._clk_count += 1
                if self._clk_count > self.bits:
                    self._faults.append(
                        f"cycle {cycle}: more than {self.bits} clocks in frame")
            else:
                # falling edge: advance MISO to the next bit
                if self._clk_count > 0 and self._bit_ptr < self.bits:
                    self._bit_ptr += 1

        return self._miso() << self.sdi_pin

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
