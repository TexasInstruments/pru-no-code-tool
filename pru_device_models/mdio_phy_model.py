"""MDIO Clause 22 Ethernet PHY - DeviceModel.

A compact observed-line PHY model for the IEEE 802.3 Clause 22 (MII)
management interface. The STA/master drives MDC (clock, <= 2.5 MHz) and
MDIO during preamble/header/write-data; the PHY drives MDIO during the
read turn-around and read data.

The model decodes ONLY what is on the wires. Each tick it observes
(mdc, mdio_master_drive) on the PRU GPO word, reconstructs the shared
line as a wired-AND (dominant 0, pull-up 1), and samples that observed
line on every rising MDC edge - exactly what a real PHY sees. There is
no transmit-buffer shortcut: the frame recorded in events() and the
value written into the register file are re-derived from the sampled
line bits, so a corrupted wire bit produces a corrupted result (which
the tests exploit as a positive proof of observed-line decoding).

Clause 22 wire contract (the ONLY contract this model enforces):
  preamble  >= preamble_bits clocked 1 bits (default 16, a lenient floor; idle-high MDIO counts, as on wire).
            IEEE 802.3 22.2.4.5.1 specifies 32; a conforming MDIO master emits 32. The default stays 16 so
            existing 16-bit drivers keep passing; pass preamble_bits=32 for a strict check.
  ST        01, MSB first
  OP        01 = write, 10 = read (00/11 illegal)
  PHYAD     5 bits, MSB first
  REGAD     5 bits, MSB first
  TA        read: master releases (1) then PHY drives 0;
            write: master drives 10
  DATA      16 bits, MSB first

Vendor behaviour (TI ICSS MDIO doorbell/pre-trigger register layout,
software API sequencing) is deliberately NOT modelled here: the model covers
the IEEE 802.3 Clause 22 frame on the wire only.

Faults (reject wrong firmware):
  - MDC rising edges closer than 2*min_half_period_cycles (> 2.5 MHz
    at the reference 200 MHz PRU clock with the default 40)
  - preamble shorter than preamble_bits when ST is attempted
  - ST != 01
  - OP == 00 or 11
  - write turn-around != 10
  - master drives MDIO low during the read turn-around/data window
    (contention with the PHY)
  - frame abandoned mid-field (edge count short / clocking stops)

Events:
  {"kind":"read"/"write", "cycle", "phy_addr", "reg_addr", "data"}
Only frames addressed to this PHY's phy_addr produce events or drive
the line; frames to other addresses are clocked through silently, and
an unanswered read leaves MDIO released (1) on the wire.
"""

from typing import Any, Dict, List, Optional

from pru_device_models.device_model import DeviceModel

_ST = 0b01
_OP_WRITE = 0b01
_OP_READ = 0b10
_HDR_BITS = 14  # ST(2) + OP(2) + PHYAD(5) + REGAD(5)
_DATA_BITS = 16


class MdioPhyModel(DeviceModel):
    """Clause 22 PHY management slave, decoding the observed line."""

    def __init__(
        self,
        phy_addr: int = 0,
        mdc_bit: int = 0,
        mdio_bit: int = 1,
        min_half_period_cycles: int = 40,   # 200 MHz / 2.5 MHz / 2
        preamble_bits: int = 16,            # lenient floor; the standard specifies 32
        registers: Optional[Dict[int, int]] = None,
        abort_gap_factor: int = 8,
        **kwargs,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []

        if not (0 <= phy_addr < 32):
            self._faults.append(f"phy_addr {phy_addr} out of 5-bit range")
        if mdc_bit == mdio_bit:
            self._faults.append("mdc_bit and mdio_bit must differ")
        if min_half_period_cycles < 1:
            self._faults.append("min_half_period_cycles must be >= 1")
        if not (1 <= preamble_bits <= 32):
            self._faults.append("preamble_bits must be 1..32")

        self.phy_addr = phy_addr & 0x1F
        self.mdc_bit = mdc_bit
        self.mdio_bit = mdio_bit
        self.min_half_period_cycles = min_half_period_cycles
        self.preamble_bits = preamble_bits
        self.abort_gap_cycles = abort_gap_factor * 2 * min_half_period_cycles
        self.registers: Dict[int, int] = dict(registers or {})

        # observed-line decode state
        self._prev_mdc = 1          # line idle level before first tick
        self._phase = "PRE"         # PRE -> HDR -> TA -> DATA -> PRE
        self._pre_ones = 0
        self._hdr_bits: List[int] = []
        self._op = 0
        self._frame_phy = 0
        self._frame_reg = 0
        self._mine = False
        self._ta_bits: List[int] = []
        self._data_bits: List[int] = []
        self._last_rise: Optional[int] = None

        # PHY MDIO drive (1 = released / pull-up)
        self._phy_cur = 1
        self._phy_queue: List[int] = []

        # every (cycle, mdc, observed mdio line) sampled - exposed for
        # tests that must assert on the wire, never on driver intent
        self.line_trace: List[Dict[str, int]] = []

    # ---------------------------------------------------------------- helpers
    def _fault(self, cycle: int, msg: str) -> None:
        self._faults.append(f"cycle {cycle}: {msg}")

    def _reset_frame(self) -> None:
        self._phase = "PRE"
        self._pre_ones = 0
        self._hdr_bits = []
        self._ta_bits = []
        self._data_bits = []
        self._mine = False
        self._phy_queue = []
        self._phy_cur = 1
        self._last_rise = None

    # ------------------------------------------------------------ DeviceModel
    def tick(self, cycle: int, pins_out: int) -> int:
        mdc = (pins_out >> self.mdc_bit) & 1
        master = (pins_out >> self.mdio_bit) & 1

        # shared MDIO line: dominant-0 wired-AND of master and PHY drives
        line = master & self._phy_cur
        self.line_trace.append(
            {"cycle": cycle, "mdc": mdc, "mdio": line, "master": master,
             "phy": self._phy_cur})

        # falling edge: PHY prepares the bit the master will sample next
        if self._prev_mdc == 1 and mdc == 0:
            if self._phy_queue:
                self._phy_cur = self._phy_queue.pop(0)

        # rising edge: master-side sample of the observed line
        if self._prev_mdc == 0 and mdc == 1:
            self._prev_mdc = mdc
            self._on_rising_edge(cycle, line)
        else:
            self._prev_mdc = mdc

        # frame abandoned: clocking stopped mid-field (short edge count)
        if (self._phase != "PRE" and self._last_rise is not None
                and cycle - self._last_rise > self.abort_gap_cycles):
            got = _HDR_BITS if self._phase == "HDR" else (
                len(self._ta_bits) if self._phase == "TA" else len(self._data_bits))
            self._fault(cycle, f"frame abandoned in {self._phase} after "
                               f"{got} bits (MDC edge count short)")
            self._reset_frame()

        return self._phy_cur << self.mdio_bit

    # ------------------------------------------------------------- decode FSM
    def _on_rising_edge(self, cycle: int, bit: int) -> None:
        if (self._last_rise is not None
                and cycle - self._last_rise < 2 * self.min_half_period_cycles):
            self._fault(cycle, "MDC above 2.5 MHz limit "
                        f"(rising edges {cycle - self._last_rise} cycles apart, "
                        f"minimum {2 * self.min_half_period_cycles})")
        self._last_rise = cycle

        if self._phase == "PRE":
            if bit == 1:
                self._pre_ones += 1
            else:
                if self._pre_ones >= self.preamble_bits:
                    self._phase = "HDR"
                    self._hdr_bits = [0]   # this 0 is ST bit 1
                else:
                    self._fault(cycle, f"preamble shorter than "
                                f"{self.preamble_bits} bits "
                                f"(saw {self._pre_ones})")
                    self._reset_frame()
            return

        if self._phase == "HDR":
            self._hdr_bits.append(bit)
            if len(self._hdr_bits) < _HDR_BITS:
                return
            st = (self._hdr_bits[0] << 1) | self._hdr_bits[1]
            op = (self._hdr_bits[2] << 1) | self._hdr_bits[3]
            self._op = op
            self._frame_phy = 0
            for b in self._hdr_bits[4:9]:
                self._frame_phy = (self._frame_phy << 1) | b
            self._frame_reg = 0
            for b in self._hdr_bits[9:14]:
                self._frame_reg = (self._frame_reg << 1) | b
            self._mine = self._frame_phy == self.phy_addr

            if st != _ST:
                self._fault(cycle, f"bad Clause 22 start ST={st:02b} "
                            "(expected 01)")
                self._reset_frame()
                return
            if op not in (_OP_READ, _OP_WRITE):
                self._fault(cycle, f"bad opcode OP={op:02b} "
                            "(00 and 11 are illegal)")
                self._reset_frame()
                return

            # arm the PHY drive for a read addressed to us:
            # TA bit 2 = 0, then register data MSB first
            if self._mine and op == _OP_READ:
                value = self.registers.get(self._frame_reg, 0) & 0xFFFF
                # first entry is TA bit 1 (PHY released); the drive begins
                # with TA bit 2 = 0, popped on the falling edge before it
                self._phy_queue = [1, 0] + [
                    (value >> (15 - i)) & 1 for i in range(_DATA_BITS)]

            self._phase = "TA"
            return

        if self._phase == "TA":
            self._ta_bits.append(bit)
            # during a read addressed to us the master must be off the wire
            if (self._mine and self._op == _OP_READ
                    and self.line_trace[-1]["master"] == 0):
                self._fault(cycle, "master drives MDIO during read "
                            "turn-around/data (contention with PHY)")
            if len(self._ta_bits) < 2:
                return
            ta = (self._ta_bits[0] << 1) | self._ta_bits[1]
            if self._mine and self._op == _OP_WRITE and ta != 0b10:
                self._fault(cycle, f"write turn-around TA={ta:02b} "
                            "(expected 10)")
                self._reset_frame()
                return
            self._phase = "DATA"
            return

        if self._phase == "DATA":
            self._data_bits.append(bit)
            if (self._mine and self._op == _OP_READ
                    and self.line_trace[-1]["master"] == 0):
                self._fault(cycle, "master drives MDIO during read data "
                            "(contention with PHY)")
            if len(self._data_bits) < _DATA_BITS:
                return
            data = 0
            for b in self._data_bits:
                data = (data << 1) | b
            if self._mine:
                kind = "write" if self._op == _OP_WRITE else "read"
                self._events.append({
                    "kind": kind, "cycle": cycle,
                    "phy_addr": self._frame_phy, "reg_addr": self._frame_reg,
                    "data": data,
                })
                if self._op == _OP_WRITE:
                    self.registers[self._frame_reg] = data
            self._reset_frame()
            return

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults

    def flush(self, cycle: int) -> None:
        """End of stimulus: any frame still open was left incomplete."""
        if self._phase != "PRE":
            self._fault(cycle, f"stimulus ended mid-frame in {self._phase}")
            self._reset_frame()
