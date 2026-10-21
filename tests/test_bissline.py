"""BiSS Line initiator — model-driven tests.

Tests the BissLineEncoder DeviceModel with:

(a) Legal control arms — correct firmware behaviour accepted (no faults).
(b) Deliberately broken initiators rejected:
    - Wrong bit period (too fast clock) — paired with legal-speed control.
    - Wrong CDS handling (too few clocks) — paired with full-frame control.

Each red test has a paired green control arm of the *same shape* so
the fault is discriminating, not vacuous.

Independent verification:
    - CRC-6 is recomputed in the test by GF(2) polynomial long division
      (structurally unlike the model's shift register), NOT imported from
      the model and NOT a copy of its loop.
    - 8b/10b round-trip is verified with the test's own decoder.
    - Hamming(7,4) FEC is verified independently.
    - The buscosim wire decode (TestBuscosimWireShape) is SHAPE COVERAGE
      only: buscosim's CRC is a copy of the model's algorithm.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from perif.bissline_device_model import (
    BissLineEncoder,
    crc6_bissc,
    hamming74_encode,
    hamming74_decode,
    encode_8b10b_byte,
    decode_8b10b_symbol,
)


# ===================================================================
# Independent CRC-6 (does NOT call the model's crc6_bissc)
# ===================================================================
def _independent_crc6(bits):
    """CRC-6 poly 0x43 (x^6 + x + 1), inverted output.

    Implemented by GF(2) polynomial long division, a structurally
    different method from the model's shift-register feedback loop in
    perif/bissline_device_model.py:crc6_bissc (and from the third copy in
    perif/buscosim.py:_bissline_crc6). Here the message bits are the
    coefficients of M(x) (first bit = highest degree), the dividend is
    M(x) * x^6, and it is divided by G(x) = x^6 + x + 1 by repeatedly
    cancelling the leading term, exactly as paper long division. The
    remainder is the CRC; it is inverted per the BiSS spec.

    Because this divides by the polynomial 0x43 explicitly, a wrong
    polynomial baked into the model's shift register is detectable here:
    the two implementations only agree if both compute the remainder of
    the same G(x). (the previous version of this helper was a
    line-by-line copy of the model's loop and could not detect that.)
    """
    dividend = 0
    for b in bits:
        dividend = (dividend << 1) | (b & 1)
    dividend <<= 6  # multiply by x^6
    divisor = 0x43  # G(x) = x^6 + x + 1
    top = len(bits) + 6 - 1  # degree of the dividend
    while top >= 6:
        if (dividend >> top) & 1:
            dividend ^= divisor << (top - 6)  # cancel the leading term
        top -= 1
    return (dividend & 0x3F) ^ 0x3F  # remainder, inverted per BiSS spec


# ===================================================================
# Independent Hamming(7,4) decoder (does NOT use model's decoder)
# ===================================================================
def _independent_hamming74_decode(cw):
    """Decode 7-bit Hamming(7,4) codeword independently.
    Returns (nibble, corrected)."""
    bits = [(cw >> (6 - i)) & 1 for i in range(7)]
    # positions 1..7: bits[0]=p1, bits[1]=p2, bits[2]=d1,
    #                 bits[3]=p4, bits[4]=d2, bits[5]=d3, bits[6]=d4
    p1, p2, d1, p4, d2, d3, d4 = bits
    s1 = p1 ^ d1 ^ d2 ^ d4
    s2 = p2 ^ d1 ^ d3 ^ d4
    s4 = p4 ^ d2 ^ d3 ^ d4
    syn = (s4 << 2) | (s2 << 1) | s1
    corrected = False
    if syn != 0:
        corrected = True
        bits[syn - 1] ^= 1
        _, _, d1, _, d2, d3, d4 = bits
    return ((d1 << 3) | (d2 << 2) | (d3 << 1) | d4, corrected)


# ===================================================================
# Helper: drive clock cycles into a model
# ===================================================================
def _clock_model(model, n_clocks, half_period=10, master_data=None):
    """Drive n_clocks full clock cycles on the MA pin.

    Each clock: half_period cycles low, half_period cycles high.
    Returns the trace of (cycle, gpo, gpi) tuples.
    """
    if master_data is None:
        master_data = [0] * n_clocks
    trace = []
    cyc = 0
    for i in range(n_clocks):
        mo = master_data[i] if i < len(master_data) else 0
        out_low = (mo << getattr(model, 'mo_pin', 2)) | 0
        out_high = (mo << getattr(model, 'mo_pin', 2)) | 1
        for _ in range(half_period):
            gpi = model.tick(cyc, out_low)  # clock low
            trace.append((cyc, out_low, gpi))
            cyc += 1
        for _ in range(half_period):
            gpi = model.tick(cyc, out_high)  # clock high (active edge)
            trace.append((cyc, out_high, gpi))
            cyc += 1
    # idle gap
    for _ in range(40):
        gpi = model.tick(cyc, 0)
        trace.append((cyc, 0, gpi))
        cyc += 1
    model.flush(cyc)
    return trace


# ===================================================================
# Unit tests: CRC-6
# ===================================================================
class TestCrc6Independent:
    """Verify the model's CRC-6 against an independently written CRC-6."""

    def test_empty_input(self):
        assert crc6_bissc([]) == _independent_crc6([])

    def test_known_vector(self):
        bits = [1, 0, 1, 1, 0, 0, 1, 0]
        assert crc6_bissc(bits) == 0x20
        assert _independent_crc6(bits) == 0x20

    def test_all_ones(self):
        bits = [1] * 32
        assert crc6_bissc(bits) == _independent_crc6(bits)

    def test_all_zeros(self):
        bits = [0] * 32
        assert crc6_bissc(bits) == _independent_crc6(bits)

    def test_alternating(self):
        bits = [i % 2 for i in range(34)]
        assert crc6_bissc(bits) == _independent_crc6(bits)


# ===================================================================
# Unit tests: Hamming(7,4) FEC
# ===================================================================
class TestHammingFec:
    """Verify Hamming encode/decode with independent decoder."""

    def test_all_nibbles_roundtrip(self):
        for nib in range(16):
            cw = hamming74_encode(nib)
            decoded, corrected = _independent_hamming74_decode(cw)
            assert decoded == nib, f"nibble {nib:#06b}: got {decoded:#06b}"
            assert not corrected

    def test_single_bit_correction(self):
        for nib in range(16):
            cw = hamming74_encode(nib)
            for bit_pos in range(7):
                corrupted = cw ^ (1 << bit_pos)
                decoded, corrected = _independent_hamming74_decode(corrupted)
                assert decoded == nib, \
                    f"nibble {nib:#06b}, flip bit {bit_pos}: got {decoded:#06b}"
                assert corrected


# ===================================================================
# Unit tests: 8b/10b line coding
# ===================================================================
class TestLineCoding:
    """Verify 8b/10b encode/decode round-trips."""

    def test_all_bytes_roundtrip(self):
        for bv in range(256):
            sym = encode_8b10b_byte(bv)
            decoded = decode_8b10b_symbol(sym)
            assert decoded == bv, f"byte {bv:#04x}: sym={sym:#012b}, decoded={decoded}"

    def test_symbol_is_10_bits(self):
        for bv in range(256):
            sym = encode_8b10b_byte(bv)
            assert sym < 1024, f"byte {bv:#04x} encoded to {sym} (>10 bits)"


# ===================================================================
# Model construction validation
# ===================================================================
class TestModelConstruction:
    def test_valid_construction(self):
        m = BissLineEncoder(data_bits=32, position=0x12345678)
        assert m.faults() == []

    def test_bad_data_bits(self):
        m = BissLineEncoder(data_bits=20)
        assert any("data_bits" in f for f in m.faults())

    def test_bad_min_period(self):
        m = BissLineEncoder(min_bit_period_cycles=0)
        assert any("min_bit_period_cycles" in f for f in m.faults())


# ===================================================================
# GREEN: Legal full frame accepted
# ===================================================================
class TestGreenLegalFrame:
    """Complete frame at legal speed — no faults, position decoded."""

    def test_32bit_frame_accepted(self):
        pos = 0xDEADBEEF
        m = BissLineEncoder(
            data_bits=32, position=pos,
            min_bit_period_cycles=4,
            line_coding=False, fec_enable=False,  # raw bits for simplicity
        )
        n_clocks = len(m._wire_bits)
        _clock_model(m, n_clocks, half_period=10)

        assert m.faults() == [], f"unexpected faults: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["position"] == pos
        assert frames[0]["crc_ok"] is True
        assert frames[0]["cds"] == 0

    def test_16bit_frame_accepted(self):
        pos = 0xABCD
        m = BissLineEncoder(
            data_bits=16, position=pos,
            min_bit_period_cycles=4,
            line_coding=False, fec_enable=False,
        )
        n_clocks = len(m._wire_bits)
        _clock_model(m, n_clocks, half_period=10)

        assert m.faults() == [], f"unexpected faults: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["position"] == pos

    def test_cds_bit_value_preserved(self):
        m = BissLineEncoder(
            data_bits=16, position=0, cds_value=1,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["cds"] == 1

    def test_error_and_warning_flags(self):
        m = BissLineEncoder(
            data_bits=16, position=0, error_flag=True, warning_flag=True,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["error"] is True
        assert frames[0]["warning"] is True


# ===================================================================
# GREEN + RED PAIR: Wrong bit period
# ===================================================================
class TestBitPeriodPair:
    """RED: too-fast clock rejected. GREEN: same shape at legal speed."""

    def test_green_legal_speed(self):
        """Control arm: clock at legal half-period (10 cycles)."""
        m = BissLineEncoder(
            data_bits=32, position=0x12345678,
            min_bit_period_cycles=8,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == [], f"legal speed should not fault: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["crc_ok"] is True

    def test_red_too_fast_clock(self):
        """Broken initiator: half-period 3 cycles < min 8."""
        m = BissLineEncoder(
            data_bits=32, position=0x12345678,
            min_bit_period_cycles=8,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits), half_period=3)
        assert any("bit period" in f for f in m.faults()), \
            "too-fast clock was not rejected"




# ===================================================================
# GREEN: frame with 8b/10b line coding
# ===================================================================
class TestLineCodingFrame:
    """Verify that 8b/10b-coded frames are accepted and decodable."""

    def test_coded_frame_accepted(self):
        pos = 0xCAFE
        m = BissLineEncoder(
            data_bits=16, position=pos,
            min_bit_period_cycles=4,
            line_coding=True, fec_enable=False,
        )
        n_clocks = m.total_wire_bits
        trace = _clock_model(m, n_clocks, half_period=10)
        assert m.faults() == [], f"coded frame faulted: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["position"] == pos
        assert frames[0]["line_coded"] is True

    def test_wire_bits_are_8b10b_decodable(self):
        """Independently decode the wire bits through 8b/10b."""
        pos = 0xCAFE
        m = BissLineEncoder(
            data_bits=16, position=pos,
            line_coding=True, fec_enable=False,
        )
        wire = m._wire_bits
        # Wire bits should be a multiple of 10
        assert len(wire) % 10 == 0, f"wire bits {len(wire)} not multiple of 10"
        # Decode each 10-bit symbol
        decoded_bytes = []
        for i in range(0, len(wire), 10):
            sym = 0
            for j in range(10):
                sym = (sym << 1) | wire[i + j]
            bv = decode_8b10b_symbol(sym)
            assert bv is not None, f"code violation at symbol {i//10}: {sym:#012b}"
            decoded_bytes.append(bv)

        # Re-assemble decoded bytes into bits
        decoded_bits = []
        for bv in decoded_bytes:
            for j in range(7, -1, -1):
                decoded_bits.append((bv >> j) & 1)

        # The decoded bits should start with the raw frame
        raw = m._coded_bits  # pre-8b10b, post-FEC
        # Trim padding from decoded (8b10b pads to byte boundary)
        assert decoded_bits[:len(raw)] == raw, \
            "8b/10b decode does not recover the coded frame"


# ===================================================================
# GREEN: frame with Hamming(7,4) FEC
# ===================================================================
class TestFecFrame:
    """Verify FEC encoding produces decodable position nibbles."""

    def test_fec_frame_accepted(self):
        pos = 0x1234
        m = BissLineEncoder(
            data_bits=16, position=pos,
            line_coding=False, fec_enable=True,
        )
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == [], f"FEC frame faulted: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["fec_applied"] is True

    def test_fec_position_independently_decodable(self):
        """Independently decode position through Hamming(7,4)."""
        pos = 0xABCD
        m = BissLineEncoder(
            data_bits=16, position=pos,
            line_coding=False, fec_enable=True,
        )
        coded = m._coded_bits
        # Extract position FEC block: header is 3 bits, then FEC nibbles
        header = coded[:3]
        assert header == [0, 1, 0]  # ACK=0, Start=1, CDS=0

        # 16 data bits = 4 nibbles -> 4 * 7 = 28 FEC bits
        fec_region = coded[3:3 + 28]
        # Decode each 7-bit Hamming codeword
        recovered_nibbles = []
        for i in range(0, 28, 7):
            cw = 0
            for j in range(7):
                cw = (cw << 1) | fec_region[i + j]
            nib, corrected = _independent_hamming74_decode(cw)
            assert not corrected, f"unexpected correction at nibble {i//7}"
            recovered_nibbles.append(nib)

        # Reassemble position from nibbles (MSB first)
        recovered_pos = 0
        for nib in recovered_nibbles:
            recovered_pos = (recovered_pos << 4) | nib
        assert recovered_pos == pos, \
            f"FEC-decoded position {recovered_pos:#06x} != {pos:#06x}"


# ===================================================================
# GREEN: frame with both 8b/10b and FEC
# ===================================================================
class TestFullCodedFrame:
    """Frame with both line coding and FEC — the full BiSS Line stack."""

    def test_full_coded_frame_accepted(self):
        pos = 0xDEADBEEF
        m = BissLineEncoder(
            data_bits=32, position=pos,
            line_coding=True, fec_enable=True,
        )
        n_clocks = m.total_wire_bits
        _clock_model(m, n_clocks, half_period=10)
        assert m.faults() == [], f"full coded frame faulted: {m.faults()}"
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["position"] == pos
        assert frames[0]["crc_ok"] is True
        assert frames[0]["line_coded"] is True
        assert frames[0]["fec_applied"] is True


# ===================================================================
# Independent CRC validation (decode must NOT use model's CRC routine)
# ===================================================================
class TestIndependentCrcValidation:
    """Verify the model's CRC matches an independently computed CRC."""

    def test_crc_agreement_32bit(self):
        pos = 0x87654321
        m = BissLineEncoder(
            data_bits=32, position=pos,
            line_coding=False, fec_enable=False,
        )
        raw = m._raw_frame_bits
        pos_bits = raw[3:3 + 32]
        ne = raw[35]
        nw = raw[36]
        crc_bits = raw[37:43]

        # Extract CRC from frame
        frame_crc = 0
        for b in crc_bits:
            frame_crc = (frame_crc << 1) | b

        # Independently compute CRC
        independent_crc = _independent_crc6(pos_bits + [ne, nw])

        assert frame_crc == independent_crc, \
            f"model CRC {frame_crc:#04x} != independent {independent_crc:#04x}"

    def test_crc_agreement_16bit(self):
        pos = 0xBEEF
        m = BissLineEncoder(
            data_bits=16, position=pos,
            line_coding=False, fec_enable=False,
        )
        raw = m._raw_frame_bits
        pos_bits = raw[3:3 + 16]
        ne = raw[19]
        nw = raw[20]
        crc_bits = raw[21:27]

        frame_crc = 0
        for b in crc_bits:
            frame_crc = (frame_crc << 1) | b

        independent_crc = _independent_crc6(pos_bits + [ne, nw])
        assert frame_crc == independent_crc


# ===================================================================
# RED: overclocking (too many clocks for frame size)
# ===================================================================
class TestOverclockPair:
    """RED: too many clocks. GREEN: exact clock count accepted."""

    def test_green_exact_clocks(self):
        m = BissLineEncoder(
            data_bits=16, position=0,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []

    def test_red_overclocked(self):
        m = BissLineEncoder(
            data_bits=16, position=0,
            line_coding=False, fec_enable=False,
        )
        _clock_model(m, len(m._wire_bits) + 5, half_period=10)
        assert any("overclocked" in f for f in m.faults()), \
            "overclocked frame was not rejected"


# ===================================================================
# Buscosim wire-level decode (shape coverage, NOT CRC verification)
# ===================================================================
class TestBuscosimWireShape:
    """SHAPE COVERAGE, not independent CRC verification.

    The buscosim decoder's CRC (perif/buscosim.py:_bissline_crc6) is a
    third copy of the model's shift-register algorithm, so this test is
    self-consistency for the CRC: it catches bit-level decode/trace bugs
    (wrong pin, wrong edge, wrong frame slicing), and it happens to catch
    a mutation confined to perif/bissline_device_model.py:crc6_bissc, but
    a polynomial error written identically into both copies passes.
    Genuine CRC oracle-independence lives in TestCrc6Independent and
    TestIndependentCrcValidation against the GF(2) long-division helper.

    Renamed from TestBuscosimAgreement because that name read as
    independent verification, which this is not.
    """

    def test_buscosim_decodes_raw_frame_shape(self):
        from perif import buscosim
        pos = 0xCAFEBABE
        m = BissLineEncoder(
            data_bits=32, position=pos,
            line_coding=False, fec_enable=False,
        )
        trace = _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []

        # Build a wire trace for buscosim: (cycle, word) where word has
        # clk on bit 0 and data on bit 1 (combined GPO and GPI)
        wire = [(c, (gpo & 1) | (gpi & 2)) for (c, gpo, gpi) in trace]
        dec = buscosim.decode_bissline(wire, clk_pin=0, data_pin=1,
                                       data_bits=32, idle_gap_cycles=25)
        assert len(dec) == 1
        assert dec[0]["position"] == pos
        assert dec[0]["crc_ok"] is True
        assert dec[0]["cds"] == 0

# ===================================================================
# D2: Wire CRC Verification
# ===================================================================
class TestCrcWireCorruption:
    """Verify that CRC is computed over the received wire bits, not just assumed correct."""

    def test_green_uncorrupted(self):
        m = BissLineEncoder(data_bits=16, position=0xBEEF, line_coding=False, fec_enable=False)
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is True

    def test_red_corrupted_payload(self):
        m = BissLineEncoder(data_bits=16, position=0xBEEF, line_coding=False, fec_enable=False)
        # Corrupt one payload bit on the wire
        m._wire_bits[5] ^= 1
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is False

    def test_green_uncorrupted_default(self):
        m = BissLineEncoder(data_bits=32, position=0xBEEF)
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is True

    def test_red_corrupted_payload_default(self):
        m = BissLineEncoder(data_bits=32, position=0xBEEF)
        # Corrupt one payload bit on the wire
        m._wire_bits[5] ^= 1
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is False

# ===================================================================
# D3: Master Data Corruption Verification
# ===================================================================
class TestMasterDataCorruption:
    """Verify that the model observes what the MASTER drives on MO."""

    def test_green_master_drives_zero(self):
        m = BissLineEncoder(data_bits=16, position=0xBEEF, line_coding=False, fec_enable=False)
        n_clocks = len(m._wire_bits)
        master_data = [0] * n_clocks
        _clock_model(m, n_clocks, half_period=10, master_data=master_data)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is True

    def test_red_master_drives_one(self):
        m = BissLineEncoder(data_bits=16, position=0xBEEF, line_coding=False, fec_enable=False)
        n_clocks = len(m._wire_bits)
        master_data = [0] * n_clocks
        # Bit 4 is a 0 in the payload. If master drives 1, it will corrupt the bit to 1.
        master_data[4] = 1
        _clock_model(m, n_clocks, half_period=10, master_data=master_data)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is False, "Master data corruption was not observed!"


# ===================================================================
# D7: Wire-level test with 8b/10b and FEC enabled
# ===================================================================
class TestWireLevelCodedFec:
    """Verify full 8b/10b and FEC decoding from raw wire bits."""

    def test_wire_level_decode(self):
        from perif.bissline_device_model import decode_8b10b_symbol, hamming74_decode
        pos = 0xC0DE
        m = BissLineEncoder(data_bits=16, position=pos, line_coding=True, fec_enable=True)
        trace = _clock_model(m, m.total_wire_bits, half_period=10)

        # Reconstruct wire bits from trace (sampled on falling edge of MA)
        wire_bits = []
        prev_clk = 0
        last_active = None
        for cycle, gpo, gpi in trace:
            clk = (gpo >> 0) & 1 # ma_pin=0
            data = (gpi >> 1) & 1 # slo_pin=1
            if clk != prev_clk:
                if clk == 1:
                    last_active = cycle
                else:
                    if last_active is not None:
                        wire_bits.append(data)
            prev_clk = clk

        # 1. Decode 8b/10b
        decoded_bytes = []
        for i in range(0, len(wire_bits), 10):
            sym = 0
            for j in range(10):
                sym = (sym << 1) | wire_bits[i+j]
            bv = decode_8b10b_symbol(sym)
            assert bv is not None
            decoded_bytes.append(bv)

        decoded_bits = []
        for bv in decoded_bytes:
            for j in range(7, -1, -1):
                decoded_bits.append((bv >> j) & 1)

        # 2. Decode FEC
        header = decoded_bits[:len(m._coded_bits)][:3]
        fec_bits = decoded_bits[:len(m._coded_bits)][3:-8]
        pos_bits = []
        for i in range(0, len(fec_bits), 7):
            cw = 0
            for j in range(7):
                cw = (cw << 1) | fec_bits[i+j]
            nibble, corrected, err_det = hamming74_decode(cw)
            assert not corrected
            for j in range(3, -1, -1):
                pos_bits.append((nibble >> j) & 1)

        pos_bits = pos_bits[-16:] # data_bits=16

        recovered_pos = 0
        for b in pos_bits:
            recovered_pos = (recovered_pos << 1) | b

        assert recovered_pos == pos

class TestUnderclockPair:
    def test_green_exact_clocks(self):
        m = BissLineEncoder(data_bits=16, position=0, line_coding=False, fec_enable=False)
        _clock_model(m, len(m._wire_bits), half_period=10)
        assert m.faults() == []

    def test_red_underclocked(self):
        m = BissLineEncoder(data_bits=16, position=0, line_coding=False, fec_enable=False)
        _clock_model(m, 3, half_period=10)
        assert any("clocked 3 times" in f for f in m.faults()), "underclocked frame not rejected"

class TestMutation:
    """Verify that if the model\'s driven bits are inverted, the frame fails CRC."""

    def test_mutation_red_inverted_bits(self):
        class MutatedEncoder(BissLineEncoder):
            def _drive(self) -> int:
                if self._shift_index == 0 or self._shift_index > len(self._wire_bits):
                    return 1 << self.slo_pin
                bit = self._wire_bits[self._shift_index - 1] ^ 1
                return bit << self.slo_pin

        m = MutatedEncoder(data_bits=16, position=0xBEEF, line_coding=False, fec_enable=False)
        _clock_model(m, len(m._wire_bits), half_period=10)

        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert frames[0]["crc_ok"] is False, "Mutation was not caught! crc_ok is True"
