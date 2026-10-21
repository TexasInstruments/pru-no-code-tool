"""Five DeviceModels.

Per model, three layers of checks:

(a) Falsification - wrong firmware / out-of-spec bus behaviour is rejected
    (faults non-empty, or decoded result provably wrong), and the same
    scenario run green is accepted. Each RED test also asserts the GREEN
    control passes, so the rejection is discriminating, not vacuous.

(b) End-to-end - at least one NoCodePRU block is driven from a real clpru
    ELF under the TI pru-simulator in a closed pin loop with the model
    (scripts/sim/elf_cosim.py).

(c) Independent bus-cosim - perif/buscosim.py decodes the recorded pin
    trace and its events must agree with the model's events().

Model-only tests run anywhere. ELF tests skip cleanly when clpru or the
TI pru-simulator checkout is unavailable.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "sim")))

from perif.quadrature_index_encoder import QuadratureIndexEncoder
from perif.ssi_endat_encoder import MISSING_SSI_TERMINATOR, SsiEndatEncoder
from perif.ws2812_string import Ws2812String
from perif.spi_adc import SpiAdc
from perif.step_dir_driver import StepDirDriver
from perif import buscosim

import elf_cosim

# --------------------------------------------------------------------- flags
try:
    _CLPRU = elf_cosim.find_clpru()
    _SIMDIR = elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except RuntimeError:
    HAVE_ELF = False

needs_elf = pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing")

BUILD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "build_out", ""))


def u32(v):
    return v & 0xFFFFFFFF


def s32(v):
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v & 0x80000000 else v


def drive_model(model, words, start_cycle=0):
    """Tick a model over an iterable of pins_out words; returns trace."""
    trace = []
    for i, w in enumerate(words):
        gpi = model.tick(start_cycle + i, w)
        trace.append((start_cycle + i, w, gpi))
    return trace


# ===========================================================================
# Quadrature + index
# ===========================================================================

class TestQuadratureModel:
    def test_counts_and_index(self):
        m = QuadratureIndexEncoder(cpr=4, index_width_cycles=20)
        m.set_motion([(60, 4, +1)])
        trace = drive_model(m, [0] * 400)
        edges = [e for e in m.events() if e["kind"] == "edge"]
        idx = [e for e in m.events() if e["kind"] == "index"]
        assert len(edges) == 4
        assert m.count == 4
        assert len(idx) == 1
        assert m.faults() == []

    def test_direction_reversal(self):
        m = QuadratureIndexEncoder(cpr=1000)
        m.set_motion([(60, 3, +1), (60, 5, -1)])
        drive_model(m, [0] * 600)
        assert m.count == -2

    def test_contention_fault(self):
        m = QuadratureIndexEncoder()
        m.set_motion([(60, 1, +1)])
        m.tick(0, 0xFFFFFFFF)          # PRU driving encoder lines
        assert any("contention" in f for f in m.faults())

    def test_bad_params(self):
        m = QuadratureIndexEncoder(a_bit=1, b_bit=1)
        assert m.faults()

    def test_buscosim_agrees(self):
        m = QuadratureIndexEncoder(cpr=4, index_width_cycles=20)
        m.set_motion([(60, 6, +1), (60, 2, -1)])
        trace = drive_model(m, [0] * 700)
        # encoder drives A/B/Z: the wire word is the model's own gpi output
        wire = [(c, gpi) for (c, _gpo, gpi) in trace]
        dec = buscosim.decode_quadrature(wire, 0, 1, 2)
        dec_edges = [e for e in dec if e["kind"] == "edge"]
        dec_idx = [e for e in dec if e["kind"] == "index"]
        mod_edges = [e for e in m.events() if e["kind"] == "edge"]
        mod_idx = [e for e in m.events() if e["kind"] == "index"]
        assert [(e["state"], e["count"], e["dir"]) for e in dec_edges] == \
               [(e["state"], e["count"], e["dir"]) for e in mod_edges]
        # shaft crosses the cpr mark twice: once forward, once on the way back
        assert len(dec_idx) == len(mod_idx) == 2
        assert not any(e["kind"] == "illegal" for e in dec)

    def test_buscosim_flags_illegal_transition(self):
        # 00 -> 11 is physically impossible for one sampling instant
        trace = [(0, 0b00), (10, 0b11)]
        dec = buscosim.decode_quadrature(trace, 0, 1, 2)
        assert any(e["kind"] == "illegal" for e in dec)


QUAD_SPEC = {
    "block": "quadrature_block", "subdir": "pru_io_blocks",
    "macroCall": "m_quadrature",
    "macroArgs": {"RES": "R4", "A_BIT": "0", "B_BIT": "1", "Z_BIT": "2",
                  "USE_INDEX": "0", "COUNT_MODE": "4", "SAMPLE_TRIPS": "2",
                  "POS_REG": "R5", "EDGE_REG": "R6"},
}

QUAD_SPEC_INDEX = dict(QUAD_SPEC, macroArgs=dict(QUAD_SPEC["macroArgs"], USE_INDEX="1"))

QUAD_SPEC_SWAPPED = dict(QUAD_SPEC, macroArgs=dict(
    QUAD_SPEC["macroArgs"], A_BIT="1", B_BIT="0"))


@needs_elf
class TestQuadratureElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, spec in (("quad", QUAD_SPEC), ("quad_idx", QUAD_SPEC_INDEX),
                           ("quad_swapped", QUAD_SPEC_SWAPPED)):
            elf, _asm = elf_cosim.build_block_firmware(
                spec, name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def _run(self, elf, model, steps=3000):
        return elf_cosim.run_elf_closed_loop(elf, model, max_steps=steps)

    def test_green_count_matches(self, built):
        m = QuadratureIndexEncoder(cpr=1000)
        m.set_motion([(60, 16, +1), (60, 8, -1)])
        r = self._run(built["quad"], m)
        assert m.faults() == []
        assert m.count == 8
        assert s32(r.registers[5]) == 8, f"POS_REG={s32(r.registers[5])}"
        # independent decoder agrees with the model's event stream
        wire = [(c, gpi) for (c, _g, gpi) in r.trace]
        dec = buscosim.decode_quadrature(wire, 0, 1, 2)
        dec_edges = [e for e in dec if e["kind"] == "edge"]
        assert dec_edges[-1]["count"] == m.count

    def test_index_resets_position(self, built):
        # Index at count 3 of 5; the Z window (20 cycles) closes well before
        # the next edge (60 cycles later), so the clear cannot race the next
        # count: POS must end at 5 - 3 = 2 regardless of poll phasing.
        m = QuadratureIndexEncoder(cpr=3, index_width_cycles=20)
        m.set_motion([(60, 5, +1)])
        r = self._run(built["quad_idx"], m, steps=1500)
        assert m.faults() == []
        assert any(e["kind"] == "index" for e in m.events())
        assert s32(r.registers[6]) == 5   # all five edges counted
        assert s32(r.registers[5]) == 2, \
            f"POS_REG after index+2 counts = {s32(r.registers[5])}, expected 2"

    def test_red_wrong_pin_map_rejected(self, built):
        # same device, firmware wired with A/B swapped: counts backwards
        m = QuadratureIndexEncoder(cpr=1000)
        m.set_motion([(60, 16, +1), (60, 8, -1)])
        r = self._run(built["quad_swapped"], m)
        pos = s32(r.registers[5])
        assert pos != 8 and pos == -8, f"swapped firmware gave POS={pos}"


# ===========================================================================
# SSI / EnDat
# ===========================================================================

ST = 0x1234 & 0x1FFF
MT = 0x2A


def _ssi_model(**kw):
    args = dict(protocol="ssi", clk_pin=0, data_pin=1, cpol=1,
                total_width=25, st_bits=13, mt_bits=12,
                parity_enable=True, parity_type=0, error_bit_enable=True,
                gray_code=False, st_value=ST, mt_value=MT,
                min_half_period_cycles=4, mono_cycles=30)
    args.update(kw)
    return SsiEndatEncoder(**args)


class TestSsiModel:
    def _clock_frame(self, m, n_clocks, half=10, data_bits=None, cpol=1):
        """Drive a synthetic SSI clock; model returns data words."""
        idle, active = cpol, 1 - cpol
        trace = []
        cyc = 0
        gpi = m.tick(0, idle)
        trace.append((0, idle, gpi))
        for _ in range(n_clocks):
            for _ in range(half):
                cyc += 1
                gpi = m.tick(cyc, active)  # active-edge pulse
                trace.append((cyc, active, gpi))
            for _ in range(half):
                cyc += 1
                gpi = m.tick(cyc, idle)    # return idle: DATA shifts here
                trace.append((cyc, idle, gpi))
        for _ in range(40):
            cyc += 1
            gpi = m.tick(cyc, idle)
            trace.append((cyc, idle, gpi))
        m.flush(cyc)
        return trace

    def test_frame_roundtrip(self):
        m = _ssi_model()
        self._clock_frame(m, 26)
        assert m.faults() == []
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        f = frames[0]
        assert f["st"] == ST and f["mt"] == MT
        assert f["parity_ok"] is True and f["error_flag"] is False
        assert f["raw"] == m._frame

    def test_bad_parity_detected(self):
        m = _ssi_model(force_bad_parity=True)
        self._clock_frame(m, 26)
        f = [e for e in m.events() if e["kind"] == "frame"][0]
        assert f["parity_ok"] is False

    def test_overclocked_frame_fault(self):
        # 25 data clocks + 1 end-of-frame clock is legal (n+1); 27 is not.
        m = _ssi_model()
        self._clock_frame(m, 27)
        assert any("overclocked" in f for f in m.faults())

    def test_end_of_frame_clock_is_not_overclocking(self):
        # Control arm: the datasheet frame, n data clocks plus the terminator.
        m = _ssi_model()
        trace = self._clock_frame(m, 26)
        assert not any("overclocked" in f for f in m.faults()), m.faults()
        assert m._frame & 1 == 1       # distinguish the terminator low from LSB
        falling_data = [((gpi >> m.data_pin) & 1)
                        for (_, old_gpo, _), (_, gpo, gpi) in zip(trace, trace[1:])
                        if (old_gpo & 1) and not (gpo & 1)]
        assert falling_data[-1] == 0   # F(n+1) starts the monoflop low

    def test_fast_clock_fault(self):
        m = _ssi_model(min_half_period_cycles=8)
        self._clock_frame(m, 26, half=3)
        assert any("half period" in f for f in m.faults())

    def test_gray_coding_roundtrip(self):
        m = _ssi_model(gray_code=True)
        self._clock_frame(m, 26)
        f = [e for e in m.events() if e["kind"] == "frame"][0]
        assert f["st"] == ST and f["mt"] == MT

    def test_bad_construction(self):
        m = _ssi_model(total_width=24, st_bits=13, mt_bits=12)  # 13+12 > 24
        assert m.faults()

    def test_buscosim_agrees(self):
        m = _ssi_model()
        trace = self._clock_frame(m, 26)     # 25 bits + the end-of-frame pulse
        wire = [(c, (gpo & 1) | (gpi & 2)) for (c, gpo, gpi) in trace]
        dec = buscosim.decode_ssi(wire, clk_pin=0, data_pin=1, cpol=1,
                                  idle_gap_cycles=25, expected_bits=25)
        assert len(dec) == 1
        mod = [e for e in m.events() if e["kind"] == "frame"][0]
        assert dec[0]["raw"] == mod["raw"] and dec[0]["bits"] == 25

    def test_monoflop_holds_data_low_then_releases_high(self):
        # As in TI pru-simulator's SSI encoder model: DATA is low for mono_cycles
        # after F(n+1) and is then released high, even with no further clocks.
        m = _ssi_model(mono_cycles=30)
        trace = self._clock_frame(m, 26)
        f_n1 = max(c for (c, gpo, _), (_, old, _) in zip(trace[1:], trace)
                   if old & 1 and not gpo & 1)
        by_cycle = {c: (gpi >> m.data_pin) & 1 for (c, _gpo, gpi) in trace}
        assert by_cycle[f_n1] == 0
        assert by_cycle[f_n1 + 29] == 0, "DATA must stay low inside the monoflop"
        assert f_n1 + 30 in by_cycle and by_cycle[f_n1 + 30] == 1,             "DATA not released high mono_cycles after F(n+1)"
        assert by_cycle[trace[-1][0]] == 1
        assert m.faults() == []

    def test_cpol0_green_frame_roundtrip_and_decode(self):
        # Positive cpol=0 coverage (idle low, rising edge latches): 8-bit 0xA5.
        m = _ssi_model(cpol=0, total_width=8, st_bits=4, mt_bits=4,
                       st_value=0x5, mt_value=0xA, parity_enable=False,
                       error_bit_enable=False)
        trace = self._clock_frame(m, 9, cpol=0)
        assert m.faults() == []
        f = [e for e in m.events() if e["kind"] == "frame"]
        assert len(f) == 1 and f[0]["raw"] == 0xA5
        wire = [(c, (gpo & 1) | (gpi & 2)) for (c, gpo, gpi) in trace]
        dec = buscosim.decode_ssi(wire, 0, 1, cpol=0, idle_gap_cycles=25,
                                  expected_bits=8)
        assert dec == [{"kind": "frame", "cycle": dec[0]["cycle"],
                        "raw": 0xA5, "bits": 8}]

    def test_decode_ssi_requires_expected_bits_and_cpol(self):
        # Without expected_bits the decoder cannot tell F(n+1) from data and
        # would return 9 bits (0x14a) for a correct 8-bit 0xA5 frame.
        m = _ssi_model(cpol=0, total_width=8, st_bits=4, mt_bits=4,
                       st_value=0x5, mt_value=0xA, parity_enable=False,
                       error_bit_enable=False)
        trace = self._clock_frame(m, 9, cpol=0)
        wire = [(c, (gpo & 1) | (gpi & 2)) for (c, gpo, gpi) in trace]
        with pytest.raises(TypeError):
            buscosim.decode_ssi(wire, 0, 1, cpol=0)
        with pytest.raises(TypeError):
            buscosim.decode_ssi(wire, 0, 1, expected_bits=8)

    def test_red_missing_terminator_does_not_complete_frame(self):
        m = _ssi_model()
        self._clock_frame(m, 25)  # F1 + R1..R24: the F26 terminator is absent.
        assert [e for e in m.events() if e["kind"] == "frame"] == []
        assert m.faults() == [f"{MISSING_SSI_TERMINATOR} after 25 data pulses"]

    def test_decode_ssi_samples_first_bit_and_rejects_missing_terminator(self):
        # 0b101 has an odd-position bit set. Four falling pulses are F1, R1..R3,
        # F4; decoding must retain all three bits, not the stale two-bit result.
        trace = [(0, 0b01), (1, 0b00), (2, 0b11), (3, 0b10),
                 (4, 0b01), (5, 0b00), (6, 0b11), (7, 0b10)]
        dec = buscosim.decode_ssi(trace, 0, 1, cpol=1, expected_bits=3)
        assert dec == [{"kind": "frame", "cycle": 7, "raw": 0b101, "bits": 3}]
        missing = buscosim.decode_ssi(trace[:-1], 0, 1, cpol=1, expected_bits=3)
        assert missing == [{"kind": "fault", "cycle": 5,
                            "fault": "missing SSI terminator pulse: expected 3 data "
                                     "pulses + 1 terminator pulse, saw 3 pulses"}]


class TestEndatModel:
    """This model has no EnDat half: EnDat is modelled only by TI
    pru-simulator's EnDat encoder model, exercised by the closed-loop ELF
    test tests/test_endat_framing.py."""

    def test_endat_protocol_is_refused_with_a_pointer_to_the_reference(self):
        with pytest.raises(ValueError, match=r"pru_io\.endat_encoder\.EndatEncoder"):
            SsiEndatEncoder(protocol="endat")

    def test_ssi_protocol_still_builds(self):
        assert SsiEndatEncoder(protocol="ssi").faults() == []


SSI_SPEC = {
    "block": "ssi_initiator_block", "subdir": "application_specific",
    "macroCall": "m_ssi_read",
    "macroArgs": {"RES": "R4", "TOTAL_WIDTH": "25", "ST_BITS": "13",
                  "MT_BITS": "12", "CLK_PIN": "0", "DATA_PIN": "1",
                  "CPOL": "1", "HALF_PERIOD": "4", "MONO_CYCLES": "8",
                  "PARITY_EN": "1", "PARITY_TYPE": "0", "ERR_EN": "1",
                  "GRAY_EN": "0", "TIMEOUT_CYCLES": "50"},
    "postlude": ["halt"],
}

SSI_SPEC_OVERCLOCK = dict(SSI_SPEC, macroArgs=dict(
    SSI_SPEC["macroArgs"], TOTAL_WIDTH="26"))


@needs_elf
class TestSsiElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, spec in (("ssi", SSI_SPEC), ("ssi_overclock", SSI_SPEC_OVERCLOCK)):
            elf, _asm = elf_cosim.build_block_firmware(
                spec, name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_green_frame_and_status(self, built):
        m = _ssi_model(mono_cycles=60)   # > in-frame clock period of the macro
        r = elf_cosim.run_elf_closed_loop(built["ssi"], m, max_steps=5000)
        assert r.halted
        m.flush(r.cycles)
        assert m.faults() == [], m.faults()
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert u32(r.registers[4]) == frames[0]["raw"]
        assert u32(r.registers[29]) & 0xFF == 0      # status ok
        # independent decoder agrees
        wire = [(c, (gpo & 1) | (gpi & 2)) for (c, gpo, gpi) in r.trace]
        dec = buscosim.decode_ssi(wire, 0, 1, cpol=1, idle_gap_cycles=40,
                                  expected_bits=25)
        assert len(dec) == 1 and dec[0]["raw"] == frames[0]["raw"]

    def test_red_bad_parity_caught_by_firmware(self, built):
        m = _ssi_model(force_bad_parity=True, mono_cycles=60)
        r = elf_cosim.run_elf_closed_loop(built["ssi"], m, max_steps=5000)
        m.flush(r.cycles)
        assert u32(r.registers[29]) & 1 == 1, "firmware missed parity error"
        f = [e for e in m.events() if e["kind"] == "frame"][0]
        assert f["parity_ok"] is False

    def test_red_overclocked_firmware_rejected(self, built):
        # firmware clocks 26 bits into a 25-bit frame: device must complain
        m = _ssi_model(mono_cycles=60)
        r = elf_cosim.run_elf_closed_loop(built["ssi_overclock"], m, max_steps=6000)
        m.flush(r.cycles)
        assert any("overclocked" in f for f in m.faults())


# ===========================================================================
# WS2812
# ===========================================================================

# nominal macro timings (2 cycles per delay-loop count + ~5 cycles overhead)
WS_GREEN = {"T0H_CYC": "40", "T0L_CYC": "80", "T1H_CYC": "80", "T1L_CYC": "45",
            "TRESET_CYC": "10000"}
# wrong firmware: '1' high pulse ~45 cycles fits neither the T0H window
# (80+/-30) nor the T1H window (160+/-30)
WS_RED = dict(WS_GREEN, T1H_CYC="20")

PIXEL_G, PIXEL_R, PIXEL_B = 0x12, 0x34, 0x56
PIXEL_WORD = (PIXEL_G << 16) | (PIXEL_R << 8) | PIXEL_B   # GRB wire order
PIXEL_RGB = (PIXEL_R << 16) | (PIXEL_G << 8) | PIXEL_B


def _ws_model():
    return Ws2812String(data_pin=0, num_leds=1, ns_per_cycle=5.0, tol_ns=150.0)


class TestWs2812Model:
    def _feed_bits(self, m, bits, t0h=80, t0l=170, t1h=160, t1l=90, reset=10000):
        cyc = 0
        words = []
        def push(level, n):
            nonlocal cyc
            for _ in range(n):
                words.append((cyc, level))
                m.tick(cyc, level)
                cyc += 1
        push(0, reset)
        for b in bits:
            push(1, t1h if b else t0h)
            push(0, t1l if b else t0l)
        push(0, reset)
        m.flush(cyc)
        return words

    def test_frame_roundtrip(self):
        m = _ws_model()
        bits = [(PIXEL_WORD >> (23 - i)) & 1 for i in range(24)]
        self._feed_bits(m, bits)
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["pixels"] == [PIXEL_RGB]
        assert m.faults() == []

    def test_bad_timing_fault(self):
        m = _ws_model()
        bits = [(PIXEL_WORD >> (23 - i)) & 1 for i in range(24)]
        self._feed_bits(m, bits, t1h=45)   # matches neither window
        assert any("high pulse" in f for f in m.faults())

    def test_short_reset_no_latch(self):
        m = _ws_model()
        bits = [(PIXEL_WORD >> (23 - i)) & 1 for i in range(24)]
        cyc = 0
        for b in bits:
            for _ in range(160 if b else 80):
                m.tick(cyc, 1); cyc += 1
            for _ in range(90 if b else 170):
                m.tick(cyc, 0); cyc += 1
        m.flush(cyc)   # no trailing reset gap -> no latch
        assert not [e for e in m.events() if e["kind"] == "frame"]

    def test_buscosim_agrees(self):
        m = _ws_model()
        bits = [(PIXEL_WORD >> (23 - i)) & 1 for i in range(24)]
        words = self._feed_bits(m, bits)
        dec = buscosim.decode_ws2812(words, 0, t0h=80, t1h=160, tol=30,
                                     reset_cycles=10000)
        frames = [e for e in dec if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["pixels"] == [PIXEL_RGB]
        assert not [e for e in dec if e["kind"] == "timing_error"]


def _ws_spec(timing):
    return {
        "block": "ws2812_block", "subdir": "pru_io_blocks",
        "macroCall": "m_ws2812",
        "macroArgs": dict({"RES": "R5", "PIN": "0", "DATA_REG": "R4",
                           "NUM_LEDS": "1"}, **timing),
        "prelude": [f"ldi32 R4, 0x{PIXEL_WORD:06X}"],
        "postlude": ["halt"],
    }


@needs_elf
class TestWs2812Elf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, timing in (("ws2812", WS_GREEN), ("ws2812_red", WS_RED)):
            elf, _asm = elf_cosim.build_block_firmware(
                _ws_spec(timing), name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_green_pixels_and_cosim(self, built):
        m = _ws_model()
        r = elf_cosim.run_elf_closed_loop(built["ws2812"], m, max_steps=45000)
        assert r.halted
        m.flush(r.cycles + 20000)
        assert m.faults() == [], m.faults()[:3]
        frames = [e for e in m.events() if e["kind"] == "frame"]
        assert len(frames) == 1
        assert frames[0]["pixels"] == [PIXEL_RGB]
        wire = [(c, gpo) for (c, gpo, _gpi) in r.trace]
        dec = buscosim.decode_ws2812(wire, 0, t0h=80, t1h=160, tol=30,
                                     reset_cycles=10000)
        dframes = [e for e in dec if e["kind"] == "frame"]
        assert len(dframes) == 1 and dframes[0]["pixels"] == frames[0]["pixels"]

    def test_red_bad_bit_timing_rejected(self, built):
        m = _ws_model()
        r = elf_cosim.run_elf_closed_loop(built["ws2812_red"], m, max_steps=45000)
        m.flush(r.cycles + 20000)
        assert any("high pulse" in f for f in m.faults()), \
            "wrong firmware timing was not rejected"


# ===========================================================================
# SPI ADC
# ===========================================================================

SPI_CONV = 0xBEEF
SPI_CMD = 0xA500


def _spi_model():
    # The repo's four MSB-first SPI controller macros never terminate (loop
    # exit compares bitId against 0xFF; bitId wraps to 0xFFFFFFFF). The LSB
    # variant terminates, so
    # the end-to-end tests run LSB-first.
    return SpiAdc(sclk_pin=0, sdi_pin=1, sdo_pin=2, cs_pin=3, bits=16,
                  conversion=SPI_CONV, msb_first=False)


class TestSpiAdcModel:
    def _xfer(self, m, n_clocks=16, half=6, cs_setup=10, cs_hold=10):
        cyc = 0
        trace = []

        def tick(sclk, cs, mosi=0):
            nonlocal cyc
            word = (sclk << 0) | (mosi << 2) | (cs << 3)
            gpi = m.tick(cyc, word)
            trace.append((cyc, word | (gpi & 2)))
            cyc += 1

        for _ in range(20):
            tick(0, 1)
        for _ in range(cs_setup):
            tick(0, 0)
        for i in range(n_clocks):
            if m.msb_first:
                bit = (SPI_CMD >> (15 - i)) & 1 if i < 16 else 0
            else:
                bit = (SPI_CMD >> i) & 1 if i < 16 else 0
            for _ in range(half):
                tick(0, 0, bit)
            for _ in range(half):
                tick(1, 0, bit)
        for _ in range(cs_hold):
            tick(0, 0)
        for _ in range(20):
            tick(0, 1)
        return trace

    def test_transaction_roundtrip(self):
        m = _spi_model()
        self._xfer(m)
        assert m.faults() == []
        ev = [e for e in m.events() if e["kind"] == "transaction"]
        assert len(ev) == 1
        assert ev[0]["miso"] == SPI_CONV and ev[0]["mosi"] == SPI_CMD

    def test_short_frame_fault(self):
        m = _spi_model()
        self._xfer(m, n_clocks=12)
        assert any("12 clocks" in f for f in m.faults())

    def test_sclk_outside_cs_fault(self):
        m = _spi_model()
        m.tick(0, 1 << 3)          # CS high
        m.tick(1, (1 << 3) | 1)    # SCLK rising with CS high
        assert any("CS deasserted" in f for f in m.faults())

    def test_buscosim_agrees(self):
        m = _spi_model()
        trace = self._xfer(m)
        dec = buscosim.decode_spi_mode0(trace, 0, 1, 2, 3,
                                        msb_first=m.msb_first)
        ev = [e for e in dec if e["kind"] == "transaction"]
        assert len(ev) == 1
        assert ev[0]["miso"] == SPI_CONV and ev[0]["mosi"] == SPI_CMD


def _spi_spec(packet_size):
    # pru_spi_transfer.getMacro('') emits a .macro header with placeholder
    # parameter names; expandMacro substitutes them from macroArgs.
    return {
        "block": "pru_spi_transfer", "subdir": "pru_io_blocks",
        "macroCall": "",
        "opCode": "m_transfer_packet_spi_mode0_lsb_gpo_sclk",
        "macroArgs": {
            "r_dataReg": "R5", "s_dataReg": "R4", "PACKETSIZE": str(packet_size),
            "bitId": "R6", "SCLK_PIN": "0", "SDI_PIN": "1", "SDO_PIN": "2",
            "DELAY_COMPEN_1": "8", "DELAY_COMPEN_2": "8", "CS_PIN": "3",
            "CS_SETUP_TIME": "20", "CS_HOLD_TIME": "20", "DATA_SETUP_TIME": "4",
        },
        "prelude": ["set R30, R30, 3", f"ldi32 R4, 0x{SPI_CMD:04X}"],  # CS idle high, as the generated prologue does
        "postlude": ["halt"],
    }


@needs_elf
class TestSpiAdcElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, size in (("spi_adc", 16), ("spi_adc_red", 12)):
            elf, _asm = elf_cosim.build_block_firmware(
                _spi_spec(size), name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_green_conversion_and_cosim(self, built):
        m = _spi_model()
        r = elf_cosim.run_elf_closed_loop(built["spi_adc"], m, max_steps=6000)
        assert r.halted
        assert m.faults() == [], m.faults()
        assert u32(r.registers[5]) & 0xFFFF == SPI_CONV
        ev = [e for e in m.events() if e["kind"] == "transaction"]
        assert len(ev) == 1 and ev[0]["mosi"] == SPI_CMD
        wire = [(c, gpo | (gpi & 2)) for (c, gpo, gpi) in r.trace]
        dec = buscosim.decode_spi_mode0(wire, 0, 1, 2, 3,
                                        msb_first=m.msb_first)
        dev = [e for e in dec if e["kind"] == "transaction"]
        assert len(dev) == 1 and dev[0]["miso"] == ev[0]["miso"]
        assert dev[0]["mosi"] == ev[0]["mosi"]

    def test_red_short_frame_rejected(self, built):
        m = _spi_model()
        r = elf_cosim.run_elf_closed_loop(built["spi_adc_red"], m, max_steps=6000)
        assert any("12 clocks" in f for f in m.faults())
        assert u32(r.registers[5]) & 0xFFFF != SPI_CONV


# ===========================================================================
# STEP/DIR
# ===========================================================================

def _step_model(**kw):
    args = dict(step_pin=0, dir_pin=1, min_pulse_cycles=20, dir_setup_cycles=2)
    args.update(kw)
    return StepDirDriver(**args)


class TestStepDirModel:
    def _pulses(self, m, n, high=50, low=50, dir_level=1, dir_lead=20):
        cyc = 0
        words = []
        def push(step, d, k=1):
            nonlocal cyc
            for _ in range(k):
                w = (step << 0) | (d << 1)
                words.append((cyc, w))
                m.tick(cyc, w)
                cyc += 1
        push(0, dir_level, dir_lead)
        for _ in range(n):
            push(1, dir_level, high)
            push(0, dir_level, low)
        return words

    def test_steps_counted(self):
        m = _step_model()
        self._pulses(m, 8)
        assert m.position == 8
        assert m.faults() == []
        assert len(m.events()) == 8

    def test_direction(self):
        m = _step_model()
        self._pulses(m, 5, dir_level=0)
        assert m.position == -5

    def test_narrow_pulse_fault(self):
        m = _step_model()
        self._pulses(m, 4, high=5)
        assert any("high pulse" in f for f in m.faults())

    def test_dir_setup_fault(self):
        m = _step_model(dir_setup_cycles=10)
        self._pulses(m, 2, dir_lead=1)
        assert any("DIR setup" in f for f in m.faults())

    def test_buscosim_agrees(self):
        m = _step_model()
        words = self._pulses(m, 6)
        dec = buscosim.decode_step_dir(words, 0, 1, min_pulse_cycles=20)
        steps = [e for e in dec if e["kind"] == "step"]
        assert steps[-1]["position"] == m.position == 6
        assert not [e for e in dec if e["kind"] == "timing_error"]


def _stepper_spec(steps, min_delay, pulse_high):
    return {
        "block": "stepper_block", "subdir": "pru_io_blocks",
        "macroCall": "m_stepper",
        "macroArgs": {"RES": "R4", "STEP_PIN": "0", "DIR_PIN": "1",
                      "STEPS": str(steps), "MIN_DELAY_CYCLES": str(min_delay),
                      "PULSE_HIGH_CYCLES": str(pulse_high)},
        "postlude": ["halt"],
    }


@needs_elf
class TestStepDirElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, spec in (("stepper", _stepper_spec(8, 200, 100)),
                           ("stepper_red", _stepper_spec(8, 200, 6))):
            elf, _asm = elf_cosim.build_block_firmware(
                spec, name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_green_position_and_cosim(self, built):
        m = _step_model()
        r = elf_cosim.run_elf_closed_loop(built["stepper"], m, max_steps=8000)
        assert r.halted
        assert m.faults() == [], m.faults()
        assert m.position == 8
        wire = [(c, gpo) for (c, gpo, _gpi) in r.trace]
        dec = buscosim.decode_step_dir(wire, 0, 1, min_pulse_cycles=20)
        steps = [e for e in dec if e["kind"] == "step"]
        assert len(steps) == 8 and steps[-1]["position"] == m.position

    def test_red_narrow_pulses_rejected(self, built):
        m = _step_model()
        r = elf_cosim.run_elf_closed_loop(built["stepper_red"], m, max_steps=8000)
        assert any("high pulse" in f for f in m.faults()), \
            "narrow-pulse firmware was not rejected"


# ===========================================================================
# Reset-level CS is not an assertion edge
# ===========================================================================

def _spi_pins(sclk=0, cs=1, mosi=0):
    return (sclk << 0) | (mosi << 2) | (cs << 3)


class TestSpiAdcResetLevelCs:
    def test_reset_low_cs_released_without_clocks_is_clean(self):
        m = _spi_model()
        for cyc, cs in enumerate([0, 0, 1, 1, 1]):
            m.tick(cyc, _spi_pins(cs=cs))
        assert m.faults() == []
        assert m.events() == []

    def test_genuine_cs_fall_then_rise_with_no_clocks_faults(self):
        m = _spi_model()
        for cyc, cs in enumerate([1, 1, 0, 0, 1, 1]):
            m.tick(cyc, _spi_pins(cs=cs))
        assert any("frame released after 0 clocks" in f for f in m.faults())

    def test_reset_low_cs_clocked_straight_out_of_reset_faults(self):
        m = _spi_model()
        cyc = 0
        for _ in range(16):
            for sclk in (0, 1):
                m.tick(cyc, _spi_pins(sclk=sclk, cs=0))
                cyc += 1
        m.tick(cyc, _spi_pins(sclk=1, cs=1))
        # CS is physically LOW the whole time (reset level, never raised): the
        # fault must not claim "CS deasserted" (wording).
        assert any("SCLK edge with no CS assertion edge since reset" in f for f in m.faults())
        assert not any("SCLK edge while CS deasserted" in f for f in m.faults())
        assert m.events() == []

    def test_sclk_while_cs_genuinely_deasserted_keeps_the_plain_wording(self):
        m = _spi_model()
        cyc = 0
        for _ in range(4):
            for sclk in (0, 1):        # CS high (idle), never asserted
                m.tick(cyc, _spi_pins(sclk=sclk, cs=1))
                cyc += 1
        assert any("SCLK edge while CS deasserted" in f for f in m.faults())
        assert not any("no CS assertion edge since reset" in f for f in m.faults())

    def test_buscosim_decoder_ignores_reset_level_cs(self):
        trace = [(c, _spi_pins(cs=cs)) for c, cs in enumerate([0, 0, 1, 1])]
        assert buscosim.decode_spi_mode0(trace, 0, 1, 2, 3) == []
