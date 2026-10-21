"""SSI / EnDat absolute encoder - DeviceModel.

Two protocols behind one pin pair (CLK driven by the PRU initiator, DATA
returned by the encoder):

* ``protocol="ssi"`` - classic SSI frame, MSB first, total_width data clocks
  plus one end-of-frame clock (n+1 pulses, per the vendor datasheets). The
  first active (falling for CPOL=1) edge latches; each return-to-idle edge
  presents a data bit.  The active edge after the LSB starts the monoflop and
  drives DATA low; DATA is released high again once ``mono_cycles`` have
  elapsed after that edge (checked every step, as in the vendor model).
  Like real encoders and TI pru-simulator's SsiEncoder, the model
  latches on the first active edge and shifts on each return-to-idle edge, so
  a master that samples during the active pulse reads the previous bit and a
  frame missing its F(n+1) terminator is rejected.  It still does not model
  analogue setup/hold at the sampling instant; edge placement is checked by the
  pru-simulator SsiEncoder (gmake sim / scripts/sim/run_bound_devices.py).

* ``protocol="endat"`` - not supported. A framing of start bit 0, F1/F2
  always and CRC x^5+x^3+1 preset 0 does not match the EnDat 2.2 specification.
  EnDat is modelled only by TI pru-simulator's EnDat encoder model, framed
  against HEIDENHAIN ID 383942 and the CRC of TI's EnDat driver. Asking for
  protocol="endat" here raises ValueError naming it.

Timing faults (this is what rejects wrong firmware):
    - clock half period below ``min_half_period_cycles``
    - more clock pulses in a frame than the frame can carry (n data + 1 end)
    - new frame started before the monoflop / recovery time elapsed

Events:
    {"kind": "frame", "cycle", "raw", "st", "mt", "parity_ok", "error_flag"}
"""

from typing import Any, Dict, List, Optional


MISSING_SSI_TERMINATOR = "missing SSI terminator pulse"

from pru_device_models.device_model import DeviceModel


def _gray(n: int) -> int:
    return n ^ (n >> 1)


def _degray(g: int) -> int:
    n = 0
    while g:
        n ^= g
        g >>= 1
    return n


class SsiEndatEncoder(DeviceModel):
    def __init__(
        self,
        protocol: str = "ssi",
        clk_pin: int = 0,
        data_pin: int = 1,
        cpol: int = 0,
        total_width: int = 25,
        st_bits: int = 13,
        mt_bits: int = 12,
        parity_enable: bool = True,
        parity_type: int = 0,          # 0 = even, 1 = odd
        error_bit_enable: bool = True,
        gray_code: bool = False,
        st_value: int = 0,
        mt_value: int = 0,
        error_flag: bool = False,
        force_bad_parity: bool = False,
        min_half_period_cycles: int = 4,
        mono_cycles: int = 30,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []
        if protocol == "endat":
            raise ValueError(
                "EnDat is retired from this model: use pru-simulator's "
                "pru_io.endat_encoder.EndatEncoder, the one cited EnDat model")
        if protocol not in ("ssi",):
            self._faults.append(f"unknown protocol '{protocol}'")
        if cpol not in (0, 1):
            self._faults.append("cpol must be 0 or 1")
        if protocol == "ssi" and st_bits + mt_bits > total_width:
            self._faults.append(
                f"payload ({st_bits}+{mt_bits}) wider than total_width ({total_width})")
        if min_half_period_cycles < 1:
            self._faults.append("min_half_period_cycles must be >= 1")
        self.protocol = protocol
        self.clk_pin = clk_pin
        self.data_pin = data_pin
        self.cpol = cpol
        self.total_width = total_width
        self.st_bits = st_bits
        self.mt_bits = mt_bits
        self.parity_enable = parity_enable
        self.parity_type = parity_type
        self.error_bit_enable = error_bit_enable
        self.gray_code = gray_code
        self.st_value = st_value
        self.mt_value = mt_value
        self.error_flag = error_flag
        self.force_bad_parity = force_bad_parity
        self.min_half_period_cycles = min_half_period_cycles
        self.mono_cycles = mono_cycles

        # runtime state
        # The first observed level is pre-run history, not a clock edge.  In
        # particular R30 resets low before firmware establishes the SSI idle
        # level; treating that as F1 would shift the whole word by one pulse.
        self._last_clk: Optional[int] = None
        self._last_edge_cycle: Optional[int] = None
        self._last_active_cycle: Optional[int] = None
        self._last_frame_end: Optional[int] = None
        self._clocks_in_burst = 0
        self._frame_bits: List[int] = []
        self._overclock_flagged = False
        self._ssi_data = 1
        self._ssi_release_cycle: Optional[int] = None   # F(n+1) cycle
        self._frame = self._build_ssi_frame() if protocol == "ssi" else 0

    # ------------------------------------------------------------- SSI frame
    def _build_ssi_frame(self) -> int:
        """Frame layout (MSB first): [MT | ST | error? | parity?], masked to
        total_width. Gray applies to the whole ST+MT payload word; parity is even parity of
        all frame bits above the parity bit (parity_type 1 inverts)."""
        st = self.st_value & ((1 << self.st_bits) - 1)
        mt = self.mt_value & ((1 << self.mt_bits) - 1)
        payload = (mt << self.st_bits) | st
        if self.gray_code:
            payload = _gray(payload) & ((1 << (self.st_bits + self.mt_bits)) - 1)
        extras = (1 if self.error_bit_enable else 0) + (1 if self.parity_enable else 0)
        frame = payload << extras
        if self.error_bit_enable:
            frame |= (0 if self.error_flag else 1) << (1 if self.parity_enable else 0)
        if self.parity_enable:
            p = 0
            upper = frame >> 1
            for _ in range(self.total_width - 1):
                p ^= upper & 1
                upper >>= 1
            if self.parity_type == 1:
                p ^= 1
            if self.force_bad_parity:
                p ^= 1
            frame |= p
        if self.total_width >= 32:
            frame &= 0xFFFFFFFF
        else:
            frame &= (1 << self.total_width) - 1
        return frame

    # ------------------------------------------------------------------ tick
    def tick(self, cycle: int, pins_out: int) -> int:
        clk = (pins_out >> self.clk_pin) & 1
        active = 1 - self.cpol

        # Monoflop expiry is time-based, not edge-based (vendor
        # pru_io/ssi_encoder.py:190-194): release DATA high on any step.
        if (self.protocol == "ssi" and self._ssi_release_cycle is not None
                and cycle - self._ssi_release_cycle >= self.mono_cycles):
            self._ssi_data = 1
            self._ssi_release_cycle = None

        if self._last_clk is None:
            self._last_clk = clk
            return self._drive()

        if clk != self._last_clk:
            if (clk == active and self._last_edge_cycle is not None
                    and cycle - self._last_edge_cycle < self.min_half_period_cycles):
                self._faults.append(
                    f"cycle {cycle}: clock half period "
                    f"{cycle - self._last_edge_cycle} < min {self.min_half_period_cycles}")
            self._last_edge_cycle = cycle
            if clk == active:
                self._ssi_clock(cycle)
            else:
                self._ssi_shift()
        self._last_clk = clk
        return self._drive()

    def _drive(self) -> int:
        return self._ssi_data << self.data_pin

    # ------------------------------------------------------------------- SSI
    def _ssi_clock(self, cycle: int) -> None:
        # A burst is a run of clocks whose gaps never exceed mono_cycles
        # (physically: the monoflop time is several clock periods, so any
        # gap longer than mono_cycles ends the frame).
        if (self._last_active_cycle is None
                or cycle - self._last_active_cycle > self.mono_cycles):
            self._finalize_ssi_burst()
            if (self._last_frame_end is not None
                    and cycle - self._last_frame_end < self.mono_cycles):
                self._faults.append(
                    f"cycle {cycle}: new frame before monoflop time elapsed")
            self._clocks_in_burst = 0
            self._frame_bits = []
            self._overclock_flagged = False
            self._ssi_data = 1
            self._ssi_release_cycle = None
        self._last_active_cycle = cycle
        self._clocks_in_burst += 1
        if self._clocks_in_burst == self.total_width + 1:
            # Vendor model parity: F1 latches, R1..Rn shift the n data bits,
            # and F(n+1) drives DATA low for the monoflop.  See
            # pru_io/ssi_encoder.py:217-231 in PRU_SIMULATOR_PATH.
            self._ssi_data = 0
            self._ssi_release_cycle = cycle
            self._emit_ssi_frame(cycle)
            return
        if self._clocks_in_burst > self.total_width + 1:
            if not self._overclock_flagged:
                self._overclock_flagged = True
                self._faults.append(
                    f"cycle {cycle}: frame overclocked (> {self.total_width} data "
                    f"clocks + 1 end-of-frame clock)")
            return

    def _ssi_shift(self) -> None:
        """Present the next bit on the return-to-idle edge (R1..Rn)."""
        if 1 <= self._clocks_in_burst <= self.total_width:
            bit = (self._frame >> (self.total_width - self._clocks_in_burst)) & 1
            self._frame_bits.append(bit)
            self._ssi_data = bit

    def _finalize_ssi_burst(self) -> None:
        """Reject a data word that did not receive its F(n+1) terminator."""
        if self._clocks_in_burst == self.total_width:
            self._faults.append(
                f"{MISSING_SSI_TERMINATOR} after {self.total_width} data pulses")
        elif 0 < self._clocks_in_burst < self.total_width:
            self._faults.append(
                f"incomplete SSI frame: saw {self._clocks_in_burst - 1} of "
                f"{self.total_width} data pulses")

    def _emit_ssi_frame(self, cycle: int) -> None:
        raw = 0
        for b in self._frame_bits:
            raw = (raw << 1) | b
        pos_bits = raw
        parity_ok = None
        error_flag = None
        if self.parity_enable:
            parity_bit = pos_bits & 1
            p = 0
            upper = pos_bits >> 1
            for _ in range(self.total_width - 1):
                p ^= upper & 1
                upper >>= 1
            if self.parity_type == 1:
                p ^= 1
            parity_ok = (parity_bit == p)
            pos_bits >>= 1
        if self.error_bit_enable:
            error_flag = not (pos_bits & 1)
            pos_bits >>= 1
        st = pos_bits & ((1 << self.st_bits) - 1)
        mt = (pos_bits >> self.st_bits) & ((1 << self.mt_bits) - 1)
        if self.gray_code:
            payload = _degray(pos_bits & ((1 << (self.st_bits + self.mt_bits)) - 1))
            st = payload & ((1 << self.st_bits) - 1)
            mt = (payload >> self.st_bits) & ((1 << self.mt_bits) - 1)
        self._events.append({
            "kind": "frame", "cycle": cycle, "raw": raw, "st": st, "mt": mt,
            "parity_ok": parity_ok, "error_flag": error_flag,
        })
        self._last_frame_end = cycle

    def flush(self, cycle: int) -> None:
        """Finalize an unterminated SSI burst at end of run."""
        if self.protocol == "ssi":
            self._finalize_ssi_burst()

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
