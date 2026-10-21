"""BiSS Line absolute encoder slave - DeviceModel.

BiSS Line extends BiSS C with:
  * Single-wire half-duplex: master and slave share one data line
    (MA/SLO combined or SLO only) with turnaround timing.
  * 8b/10b line coding on the reply payload.
  * Hamming(7,4) FEC on position data nibbles.
  * CDS (Control Data Slave) bit between Start and position data.

Frame layout (slave drives on active clock edges, MSB first):
  [ACK=0] [Start=1] [CDS] [Position MSB..LSB] [nE] [nW] [CRC-6]

CRC-6 polynomial 0x43 (x^6 + x + 1), computed over position + nE + nW.
CRC is inverted before transmission per BiSS spec.

Timing faults (reject wrong firmware):
  - bit period below min_bit_period_cycles
  - overclocked frame (more clocks than bits in frame)
  - CDS not clocked (too few clocks in frame)

Events:
  {kind:frame, cycle, position, cds, error, warning, crc_ok, ...}
"""

from typing import Any, Dict, List, Optional

from core.device_model import DeviceModel


# ----------------------------------------------------------------- CRC-6
def crc6_bissc(bits: List[int]) -> int:
    """CRC-6 per BiSS spec: poly 0x43 (x^6 + x + 1), result inverted."""
    crc = 0
    for b in bits:
        fb = ((crc >> 5) & 1) ^ (b & 1)
        crc = ((crc << 1) & 0x3F)
        if fb:
            crc ^= 0x03
    return crc ^ 0x3F


# ------------------------------------------------------------ 8b/10b LUT
# Simplified 8b/10b: RD- column, sufficient for model encode/decode.
_5B6B_RD_NEG = {
    0:0b100111, 1:0b011101, 2:0b101101, 3:0b110001,
    4:0b110101, 5:0b101001, 6:0b011001, 7:0b111000,
    8:0b111001, 9:0b100101, 10:0b010101, 11:0b110100,
    12:0b001101, 13:0b101100, 14:0b011100, 15:0b010111,
    16:0b011011, 17:0b100011, 18:0b010011, 19:0b110010,
    20:0b001011, 21:0b101010, 22:0b011010, 23:0b111010,
    24:0b110011, 25:0b100110, 26:0b010110, 27:0b110110,
    28:0b001110, 29:0b101110, 30:0b011110, 31:0b101011,
}

_3B4B_RD_NEG = {
    0:0b1011, 1:0b1001, 2:0b0101, 3:0b1100,
    4:0b1101, 5:0b1010, 6:0b0110, 7:0b1110,
}

_8B10B_ENC = {}
_8B10B_DEC = {}

def _init_8b10b():
    for bv in range(256):
        c6 = _5B6B_RD_NEG[bv & 0x1F]
        c4 = _3B4B_RD_NEG[(bv >> 5) & 0x07]
        sym = (c6 << 4) | c4
        _8B10B_ENC[bv] = sym
        _8B10B_DEC[sym] = bv

_init_8b10b()


def encode_8b10b_byte(bv: int) -> int:
    return _8B10B_ENC[bv & 0xFF]


def decode_8b10b_symbol(sym: int) -> Optional[int]:
    return _8B10B_DEC.get(sym & 0x3FF)


# ------------------------------------------------------ Hamming (7,4) FEC
def hamming74_encode(nibble: int) -> int:
    """Encode 4-bit nibble to 7-bit Hamming(7,4) codeword.
    Bit positions 1..7: [p1 p2 d1 p4 d2 d3 d4]"""
    d1 = (nibble >> 3) & 1
    d2 = (nibble >> 2) & 1
    d3 = (nibble >> 1) & 1
    d4 = nibble & 1
    p1 = d1 ^ d2 ^ d4
    p2 = d1 ^ d3 ^ d4
    p4 = d2 ^ d3 ^ d4
    return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p4 << 3) | (d2 << 2) | (d3 << 1) | d4


def hamming74_decode(cw: int) -> tuple:
    """Decode 7-bit Hamming(7,4). Returns (nibble, corrected, error_detected)."""
    p1 = (cw >> 6) & 1; p2 = (cw >> 5) & 1; d1 = (cw >> 4) & 1
    p4 = (cw >> 3) & 1; d2 = (cw >> 2) & 1; d3 = (cw >> 1) & 1; d4 = cw & 1
    s1 = p1 ^ d1 ^ d2 ^ d4
    s2 = p2 ^ d1 ^ d3 ^ d4
    s4 = p4 ^ d2 ^ d3 ^ d4
    syn = (s4 << 2) | (s2 << 1) | s1
    corrected = False
    if syn != 0:
        corrected = True
        cw ^= (1 << (7 - syn))
        d1 = (cw >> 4) & 1; d2 = (cw >> 2) & 1
        d3 = (cw >> 1) & 1; d4 = cw & 1
    return ((d1 << 3) | (d2 << 2) | (d3 << 1) | d4, corrected, syn != 0)


# ============================================================ DeviceModel
class BissLineEncoder(DeviceModel):
    """BiSS Line slave (encoder).

    Clock-driven model following the same tick() contract as SsiEndatEncoder.
    The master drives MA (clock pin); the slave drives SLO (data pin) back.
    In BiSS Line, both directions share one differential pair, so turnaround
    timing is critical.

    Parameters:
      ma_pin: PRU GPO bit driving clock (MA)
      mo_pin: PRU GPO bit where master drives data (MO)
      slo_pin: PRU GPI bit where slave drives data (SLO)
      data_bits: position word width (16/24/32)
      position: encoder position value
      error_flag / warning_flag: status bits (True = asserted)
      cds_value: Control Data Slave bit value (0 or 1)
      min_bit_period_cycles: minimum cycles per full clock period
      line_coding: enable 8b/10b on the reply
      fec_enable: enable Hamming(7,4) on position nibbles
    """

    def __init__(
        self,
        ma_pin: int = 0,
        mo_pin: int = 2,
        slo_pin: int = 1,
        data_bits: int = 32,
        position: int = 0,
        error_flag: bool = False,
        warning_flag: bool = False,
        cds_value: int = 0,
        min_bit_period_cycles: int = 4,
        line_coding: bool = True,
        fec_enable: bool = True,
    ):
        self._faults: List[str] = []
        self._events: List[Dict[str, Any]] = []

        if data_bits not in (16, 24, 32):
            self._faults.append(f"data_bits must be 16, 24, or 32, got {data_bits}")
        if min_bit_period_cycles < 1:
            self._faults.append("min_bit_period_cycles must be >= 1")

        self.ma_pin = ma_pin
        self.mo_pin = mo_pin
        self.slo_pin = slo_pin
        self.data_bits = data_bits
        self.position = position & ((1 << data_bits) - 1)
        self.error_flag = error_flag
        self.warning_flag = warning_flag
        self.cds_value = cds_value & 1
        self.min_bit_period_cycles = min_bit_period_cycles
        self.line_coding = line_coding
        self.fec_enable = fec_enable

        # Build the raw frame
        self._raw_frame_bits = self._build_raw_frame()
        # Apply FEC to position nibbles, keep header/trailer raw
        if self.fec_enable:
            self._coded_bits = self._apply_fec(self._raw_frame_bits)
        else:
            self._coded_bits = list(self._raw_frame_bits)
        # Apply 8b/10b
        if self.line_coding:
            self._wire_bits = self._apply_8b10b(self._coded_bits)
        else:
            self._wire_bits = list(self._coded_bits)

        # Runtime state
        self._last_clk = 0
        self._last_edge_cycle: Optional[int] = None
        self._last_rising_edge_cycle: Optional[int] = None
        self._clocks_in_burst = 0
        self._shift_index = 0
        self._overclock_flagged = False
        self._frame_emitted = False
        self._captured_bits: List[int] = []

    # -------------------------------------------------------- frame build
    def _build_raw_frame(self) -> List[int]:
        bits: List[int] = []
        bits.append(0)  # ACK
        bits.append(1)  # Start
        bits.append(self.cds_value)  # CDS

        # Position MSB first
        pos_bits: List[int] = []
        for i in range(self.data_bits - 1, -1, -1):
            pos_bits.append((self.position >> i) & 1)
        bits.extend(pos_bits)

        # nE, nW (inverted flags)
        ne = 0 if self.error_flag else 1
        nw = 0 if self.warning_flag else 1
        bits.append(ne)
        bits.append(nw)

        # CRC-6 over position + nE + nW
        crc = crc6_bissc(pos_bits + [ne, nw])
        for i in range(5, -1, -1):
            bits.append((crc >> i) & 1)

        return bits

    def _apply_fec(self, bits: List[int]) -> List[int]:
        header = bits[:3]
        pos = bits[3:3 + self.data_bits]
        trailer = bits[3 + self.data_bits:]

        padded = list(pos)
        while len(padded) % 4 != 0:
            padded.insert(0, 0)

        fec_bits: List[int] = []
        for i in range(0, len(padded), 4):
            nib = 0
            for j in range(4):
                nib = (nib << 1) | padded[i + j]
            cw = hamming74_encode(nib)
            for j in range(6, -1, -1):
                fec_bits.append((cw >> j) & 1)

        return header + fec_bits + trailer

    def _apply_8b10b(self, bits: List[int]) -> List[int]:
        padded = list(bits)
        while len(padded) % 8 != 0:
            padded.append(0)

        wire: List[int] = []
        for i in range(0, len(padded), 8):
            bv = 0
            for j in range(8):
                bv = (bv << 1) | padded[i + j]
            sym = encode_8b10b_byte(bv)
            for j in range(9, -1, -1):
                wire.append((sym >> j) & 1)
        return wire

    @property
    def total_wire_bits(self) -> int:
        return len(self._wire_bits)

    # ---------------------------------------------------------------- tick
    def tick(self, cycle: int, pins_out: int) -> int:
        clk = (pins_out >> self.ma_pin) & 1
        mo = (pins_out >> self.mo_pin) & 1

        if clk != self._last_clk:
            if clk == 1:  # rising edge
                if (self._last_rising_edge_cycle is not None
                        and cycle - self._last_rising_edge_cycle < self.min_bit_period_cycles):
                    self._faults.append(
                        f"cycle {cycle}: full bit period "
                        f"{cycle - self._last_rising_edge_cycle} < min {self.min_bit_period_cycles}")
                self._last_rising_edge_cycle = cycle
                self._last_edge_cycle = cycle

                self._clocks_in_burst += 1

                if self._clocks_in_burst > len(self._wire_bits):
                    if not self._overclock_flagged:
                        self._overclock_flagged = True
                        self._faults.append(
                            f"cycle {cycle}: overclocked "
                            f"(>{len(self._wire_bits)} clocks for "
                            f"{len(self._wire_bits)}-bit frame)")
                else:
                    self._shift_index = self._clocks_in_burst
                    driven_val = self._drive()
                    slave_bit = (driven_val >> self.slo_pin) & 1
                    self._captured_bits.append(slave_bit | mo)
            else:
                # falling edge
                self._last_edge_cycle = cycle

        self._last_clk = clk
        return self._drive()

    def _drive(self) -> int:
        if self._shift_index == 0 or self._shift_index > len(self._wire_bits):
            return 1 << self.slo_pin  # idle high
        bit = self._wire_bits[self._shift_index - 1]
        return bit << self.slo_pin

    def flush(self, cycle: int) -> None:
        if self._clocks_in_burst > 0 and not self._frame_emitted:
            self._emit_frame(cycle)

    def _emit_frame(self, cycle: int) -> None:
        self._frame_emitted = True
        
        expected_len = len(self._wire_bits)
        if self._clocks_in_burst != len(self._captured_bits):
            self._faults.append(
                f"cycle {cycle}: clocks_in_burst ({self._clocks_in_burst}) != captured_bits ({len(self._captured_bits)})"
            )
            return
            
        if len(self._captured_bits) != expected_len:
            self._faults.append(
                f"cycle {cycle}: clocked {len(self._captured_bits)} times, expected {expected_len}"
            )
            return

        # Decode from wire
        clocked_wire = self._captured_bits
        
        if self.line_coding:
            decoded_coded_bits = []
            for i in range(0, len(clocked_wire), 10):
                sym = 0
                for j in range(10):
                    sym = (sym << 1) | clocked_wire[i + j]
                bv = decode_8b10b_symbol(sym)
                if bv is None:
                    self._faults.append(f"cycle {cycle}: 8b/10b decode error")
                    return
                for j in range(7, -1, -1):
                    decoded_coded_bits.append((bv >> j) & 1)
            expected_coded_len = len(self._coded_bits)
            decoded_coded_bits = decoded_coded_bits[:expected_coded_len]
        else:
            decoded_coded_bits = list(clocked_wire)

        if self.fec_enable:
            header = decoded_coded_bits[:3]
            fec_bits = decoded_coded_bits[3:-8]
            trailer = decoded_coded_bits[-8:]
            pos_bits = []
            for i in range(0, len(fec_bits), 7):
                cw = 0
                for j in range(7):
                    cw = (cw << 1) | fec_bits[i + j]
                nibble, corrected, err_det = hamming74_decode(cw)
                for j in range(3, -1, -1):
                    pos_bits.append((nibble >> j) & 1)
            pos_bits = pos_bits[-self.data_bits:]
            raw = header + pos_bits + trailer
        else:
            raw = list(decoded_coded_bits)

        pos_bits = raw[3:3 + self.data_bits]
        position = 0
        for b in pos_bits:
            position = (position << 1) | b

        ne = raw[3 + self.data_bits]
        nw = raw[3 + self.data_bits + 1]
        crc_data = raw[3 + self.data_bits + 2:3 + self.data_bits + 8]
        received_crc = 0
        for b in crc_data:
            received_crc = (received_crc << 1) | b
            
        computed_crc = crc6_bissc(pos_bits + [ne, nw])
        crc_ok = (received_crc == computed_crc)

        self._events.append({
            "kind": "frame",
            "cycle": cycle,
            "position": position,
            "cds": raw[2],
            "error": ne == 0,
            "warning": nw == 0,
            "crc_ok": crc_ok,
            "raw_bits": len(raw),
            "wire_bits": len(self._wire_bits),
            "clocks_received": self._clocks_in_burst,
            "line_coded": self.line_coding,
            "fec_applied": self.fec_enable,
        })

    def events(self) -> List[Dict[str, Any]]:
        return self._events

    def faults(self) -> List[str]:
        return self._faults
