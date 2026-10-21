"""MDIO Clause 22 master - observed-line PHY model tests.

Layer A - model falsification (runs anywhere):
  Green control arms: a correct STA driver completes a write and a read
  against pru_device_models.mdio_phy_model.MdioPhyModel with no faults.

  Negative mutations (each an independent mutant of the DRIVER, each
  paired with the green control of the same shape so the fault is
  discriminating, not vacuous):
    - bit order      : frame sent LSB-first / data field LSB-first
    - start / opcode : ST=10, OP=00, OP=11
    - PHY address    : frame addressed to another PHY (silence, not fault)
    - REGAD          : write lands in the addressed register only
    - turn-around    : write TA=01; read with master holding MDIO low
    - edge count     : 15 data bits then idle; MDC faster than 2.5 MHz
    - data corruption: one write-data bit flipped on the WIRE - the model
      must store the corrupted value it observed, proving it decodes the
      observed line and not the driver's transmit buffer

Layer B - firmware arm (skips cleanly without clpru/pru-simulator):
  The m_mdio_xfer macro from mdio_master_block.syscfg.js is built with
  clpru and run closed-loop against the model; write then read-back must
  agree, and a wrong-PHYAD expansion must leave the line unanswered.

Note: the model's default preamble floor is the lenient 16 bits, but the block now emits the IEEE 802.3
22.2.4.5.1 32-bit preamble; this suite does not pin the block's preamble length (tests/test_mdio_preamble_mdc.py
counts it from the simulated pin trace).
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from pru_device_models.mdio_phy_model import MdioPhyModel

MDC_BIT = 0
MDIO_BIT = 1


# ===================================================================
# Independent STA driver - the "firmware under test" for Layer A.
# It emits (mdc, mdio) per cycle; the model never sees its intent.
# ===================================================================
class MasterDriver:
    """Emits a Clause 22 transaction as raw pin cycles.

    Mutation switches deliberately break ONE thing each; the green
    control (all switches off) is the paired arm of every red test.
    """

    def __init__(self, phyad=0, regad=0, op="write", wrdata=0x0000,
                 half=50, idle_before=60, idle_after=400,
                 lsb_first=False, data_lsb_first=False,
                 st=0b01, opcode=None,
                 phyad_override=None,
                 ta_write=(1, 0), read_master_holds_low=False,
                 n_data_bits=16, fast_bit_index=None,
                 corrupt_data_bit=None):
        self.phyad = phyad if phyad_override is None else phyad_override
        self.regad = regad
        self.op = op
        self.wrdata = wrdata & 0xFFFF
        self.half = half
        self.idle_before = idle_before
        self.idle_after = idle_after
        self.lsb_first = lsb_first
        self.data_lsb_first = data_lsb_first
        self.st = st
        self.opcode = opcode if opcode is not None else (
            0b10 if op == "read" else 0b01)
        self.ta_write = ta_write
        self.read_master_holds_low = read_master_holds_low
        self.n_data_bits = n_data_bits
        self.fast_bit_index = fast_bit_index
        self.corrupt_data_bit = corrupt_data_bit

    # -- frame construction (driver intent; never handed to the model) --
    def _frame_bits(self):
        def field(value, nbits, lsb):
            bits = [(value >> i) & 1 for i in range(nbits)] if lsb else \
                   [(value >> (nbits - 1 - i)) & 1 for i in range(nbits)]
            return bits

        data = field(self.wrdata, 16, self.data_lsb_first)
        if self.corrupt_data_bit is not None:
            data[self.corrupt_data_bit] ^= 1
        if self.op == "write":
            data = data[:self.n_data_bits]
        else:
            data = [1] * self.n_data_bits  # master released during read data

        bits = ([1] * 16
                + field(self.st, 2, self.lsb_first)
                + field(self.opcode, 2, self.lsb_first)
                + field(self.phyad, 5, self.lsb_first)
                + field(self.regad, 5, self.lsb_first))
        if self.op == "write":
            bits += list(self.ta_write) + data
        else:
            # TA: released (Z) then PHY-driven 0; master stays released
            # through the data phase. The contention mutant drives 0
            # through the whole PHY-owned window instead.
            if self.read_master_holds_low:
                bits += [0, 0] + [0] * 16
            else:
                bits += [1, 1] + [1] * 16
        if self.lsb_first:
            bits = bits[::-1]
        return bits

    def run(self, model):
        """Drive the model; returns the (cycle, pins, gpi) trace."""
        trace = []
        cycle = 0
        pins = (1 << MDIO_BIT)  # idle: MDC low, MDIO high

        for _ in range(self.idle_before):
            gpi = model.tick(cycle, pins)
            trace.append((cycle, pins, gpi))
            cycle += 1

        for i, bit in enumerate(self._frame_bits()):
            half = self.half
            if self.fast_bit_index is not None and i == self.fast_bit_index:
                half = 2  # glitch: far below the 2.5 MHz ceiling
            # MDIO changes while MDC is low, then clock it out
            b = (bit << MDIO_BIT)
            for _ in range(half):
                gpi = model.tick(cycle, (0 << MDC_BIT) | b)
                trace.append((cycle, (0 << MDC_BIT) | b, gpi))
                cycle += 1
            for _ in range(half):
                gpi = model.tick(cycle, (1 << MDC_BIT) | b)
                trace.append((cycle, (1 << MDC_BIT) | b, gpi))
                cycle += 1

        if self.read_master_holds_low:
            # mutant: master keeps driving MDIO low into the read TA/data
            for _ in range(self.idle_after):
                gpi = model.tick(cycle, (0 << MDIO_BIT))
                trace.append((cycle, (0 << MDIO_BIT), gpi))
                cycle += 1
        else:
            for _ in range(self.idle_after):
                gpi = model.tick(cycle, pins)
                trace.append((cycle, pins, gpi))
                cycle += 1

        model.flush(cycle)
        return trace


def _wire(trace):
    """Observed MDIO line level per cycle (model's own gpi word bit)."""
    return [(gpi >> MDIO_BIT) & 1 for (_c, _p, gpi) in trace]


# ===================================================================
# Green control arms
# ===================================================================
class TestControlArms:
    def test_write_transaction_accepted(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.faults() == [], m.faults()
        ev = [e for e in m.events() if e["kind"] == "write"]
        assert len(ev) == 1
        assert ev[0]["phy_addr"] == 0 and ev[0]["reg_addr"] == 3
        assert ev[0]["data"] == 0x1234
        assert m.registers[3] == 0x1234

    def test_read_transaction_returns_register(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={5: 0xB5A5})
        trace = MasterDriver(op="read", regad=5).run(m)
        assert m.faults() == [], m.faults()
        ev = [e for e in m.events() if e["kind"] == "read"]
        assert len(ev) == 1
        # data decoded from the observed line, not from a buffer
        assert ev[0]["data"] == 0xB5A5
        # the master actually saw the PHY's bits on the wire (R31 view)
        w = _wire(trace)
        assert 0 in w and 1 in w

    def test_write_then_readback_roundtrip(self):
        m = MdioPhyModel(phy_addr=2, min_half_period_cycles=40)
        MasterDriver(phyad=2, regad=0, op="write", wrdata=0xABCD).run(m)
        MasterDriver(phyad=2, regad=0, op="read").run(m)
        assert m.faults() == [], m.faults()
        kinds = [e["kind"] for e in m.events()]
        assert kinds == ["write", "read"]
        assert m.events()[1]["data"] == 0xABCD


# ===================================================================
# Negative mutations - each paired against the control above
# ===================================================================
class TestBitOrderMutations:
    def test_lsb_first_frame_rejected(self):
        """Whole frame LSB-first: ST no longer reads 01 on the wire."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234,
                     lsb_first=True).run(m)
        assert any("start" in f or "preamble" in f or "opcode" in f
                   for f in m.faults()), m.faults()
        assert m.events() == []
        assert 3 not in m.registers

    def test_lsb_first_data_observed_as_reversed(self):
        """Header correct, data field LSB-first only.

        The model must store the REVERSED value it actually clocked. A
        model decoding its own transmit buffer would store 0x1234.
        """
        intent = 0x1234
        reversed_intent = int(format(intent, "016b")[::-1], 2)
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=intent,
                     data_lsb_first=True).run(m)
        assert m.faults() == [], m.faults()
        assert m.registers[3] == reversed_intent
        assert reversed_intent != intent

    def test_control_msb_first_stores_intent(self):
        """Paired control: same shape, MSB-first stores the intent."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.registers[3] == 0x1234


class TestStartOpcodeMutations:
    @pytest.mark.parametrize("st", [0b00, 0b10, 0b11])
    def test_bad_start_rejected(self, st):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234, st=st).run(m)
        # a wrong ST desynchronises the frame decoder: it may read out
        # as a bad start directly, or skew the window onto a bad opcode
        assert any("start" in f or "opcode" in f for f in m.faults()), m.faults()
        assert m.events() == []

    @pytest.mark.parametrize("opcode", [0b00, 0b11])
    def test_illegal_opcode_rejected(self, opcode):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234,
                     opcode=opcode).run(m)
        assert any("opcode" in f for f in m.faults()), m.faults()
        assert m.events() == []

    def test_control_start_opcode_accepted(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.faults() == [] and len(m.events()) == 1


class TestAddressMutations:
    def test_wrong_phy_address_is_silence_not_a_fault(self):
        """A frame for PHY 5 is another PHY's business: no event, no
        drive, no fault. The discriminating arm is the control below."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(phyad_override=5, op="write", regad=3,
                     wrdata=0x1234).run(m)
        assert m.faults() == [], m.faults()
        assert m.events() == []
        assert 3 not in m.registers

    def test_unanswered_read_leaves_line_released(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={5: 0xB5A5})
        trace = MasterDriver(phyad_override=5, op="read", regad=5).run(m)
        assert m.faults() == [], m.faults()
        assert m.events() == []
        # after the header, the wire stays released: master reads all 1s
        # (idle_before=60, half=50: the header ends at bit 32)
        w = _wire(trace)
        hdr_end = 60 + 33 * 2 * 50
        assert 0 not in w[hdr_end:], "PHY drove a foreign frame"

    def test_control_correct_phy_address_accepted(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert len(m.events()) == 1 and m.registers[3] == 0x1234

    def test_regad_selects_the_addressed_register_only(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.registers.get(3) == 0x1234
        assert m.registers.get(4) is None  # neighbour untouched


class TestTurnAroundMutations:
    def test_bad_write_ta_rejected(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234,
                     ta_write=(0, 1)).run(m)
        assert any("turn-around" in f for f in m.faults()), m.faults()
        assert m.events() == [] and 3 not in m.registers

    def test_read_master_contention_rejected(self):
        """Master holding MDIO low through the read TA/data window is
        contention with the PHY: the wire is squashed to 0 and the
        fault is recorded even though the PHY did answer."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={5: 0xB5A5})
        MasterDriver(op="read", regad=5,
                     read_master_holds_low=True).run(m)
        assert any("contention" in f for f in m.faults()), m.faults()
        # the PHY's 0xB5A5 never survives on the observed line
        ev = [e for e in m.events() if e["kind"] == "read"]
        assert all(e["data"] == 0x0000 for e in ev)

    def test_control_ta_accepted(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={5: 0xB5A5})
        MasterDriver(op="read", regad=5).run(m)
        assert m.faults() == []
        assert m.events()[0]["data"] == 0xB5A5


class TestEdgeCountMutations:
    def test_short_data_edge_count_aborts(self):
        """15 data bits then idle: the frame is left incomplete."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234,
                     n_data_bits=15, idle_after=2000).run(m)
        assert any("abandoned" in f for f in m.faults()), m.faults()
        assert m.events() == [] and 3 not in m.registers

    def test_mdc_above_2_5_mhz_rejected(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234,
                     fast_bit_index=30).run(m)
        assert any("2.5 MHz" in f for f in m.faults()), m.faults()

    def test_control_edge_count_accepted(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.faults() == [] and m.registers[3] == 0x1234


class TestDataCorruptionMutations:
    def test_corrupted_wire_bit_is_stored_as_observed(self):
        """Flip data bit 7 ON THE WIRE. The model must store the
        corrupted value: 0x1234 ^ (1 << (15 - 7)).

        This is the observed-line proof: a model decoding its own
        transmit buffer would store the uncorrupted 0x1234.
        """
        intent = 0x1234
        corrupted = intent ^ (1 << 8)  # bit index 7 counts from MSB
        assert corrupted != intent
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=intent,
                     corrupt_data_bit=7).run(m)
        assert m.faults() == [], m.faults()
        assert len(m.events()) == 1
        assert m.events()[0]["data"] == corrupted
        assert m.registers[3] == corrupted

    def test_control_uncorrupted_write_stores_intent(self):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1234).run(m)
        assert m.registers[3] == 0x1234

    def test_readback_tracks_a_later_register_change(self):
        """Corrupt the PHY's register between write and read: the read
        event must report the CURRENT register, not a cached frame."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        MasterDriver(op="write", regad=3, wrdata=0x1111).run(m)
        m.registers[3] = 0x2222  # vendor-side change, e.g. a link event
        MasterDriver(op="read", regad=3).run(m)
        assert m.events()[-1]["data"] == 0x2222


class TestConstructorGuards:
    def test_bad_pin_config(self):
        assert MdioPhyModel(mdc_bit=2, mdio_bit=2).faults()

    def test_bad_phy_addr(self):
        assert MdioPhyModel(phy_addr=32).faults()


# ===================================================================
# Layer B - clpru-built firmware arm (skips without the toolchain)
# ===================================================================
MDIO_SPEC = {
    "block": "mdio_master_block", "subdir": "pru_io_blocks",
    "macroCall": "m_mdio_xfer",
    "macroArgs": {"RES": "R4", "MDC_BIT": "0", "MDIO_BIT": "1",
                  "HALF_TRIPS": "50", "PHY_ADDR": "0", "REG_ADDR": "3",
                  "IS_READ": "0", "WRDATA_REG": "R5"},
    "prelude": ["ldi32 R5, 0x8000"],
    "postlude": ["halt"],
}

try:
    import elf_cosim
    _CLPRU = elf_cosim.find_clpru()
    _SIMDIR = elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except (ImportError, RuntimeError):
    HAVE_ELF = False

needs_elf = pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing")
BUILD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "build_out", ""))


@needs_elf
class TestMdioElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, spec in (
            ("mdio_write", MDIO_SPEC),
            ("mdio_read", {**MDIO_SPEC, "macroArgs": {**MDIO_SPEC["macroArgs"],
                                                      "IS_READ": "1"}}),
        ):
            elf, _asm = elf_cosim.build_block_firmware(
                spec, name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_write_macro_commits_register(self, built):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40)
        r = elf_cosim.run_elf_closed_loop(built["mdio_write"], m,
                                          max_steps=60000)
        assert m.faults() == [], m.faults()
        ev = [e for e in m.events() if e["kind"] == "write"]
        assert len(ev) == 1
        assert ev[0]["phy_addr"] == 0 and ev[0]["reg_addr"] == 3
        assert ev[0]["data"] == 0x8000
        assert m.registers[3] == 0x8000

    def test_read_macro_captures_register(self, built):
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={3: 0x0001})
        r = elf_cosim.run_elf_closed_loop(built["mdio_read"], m,
                                          max_steps=60000)
        assert m.faults() == [], m.faults()
        ev = [e for e in m.events() if e["kind"] == "read"]
        assert len(ev) == 1 and ev[0]["data"] == 0x0001
        assert r.registers[4] & 0xFFFF == 0x0001

    def test_wrong_phy_address_macro_is_unanswered(self, built):
        """Negative mutation at the firmware layer: PHYAD=3 expansion
        against a PHY at 0 must produce no event and read back all 1s
        (line released) - not the register, not garbage, not a fault."""
        m = MdioPhyModel(phy_addr=0, min_half_period_cycles=40,
                         registers={3: 0xB5A5})
        spec = {**MDIO_SPEC, "macroArgs": {**MDIO_SPEC["macroArgs"],
                                           "PHY_ADDR": "3", "IS_READ": "1"}}
        elf, _asm = elf_cosim.build_block_firmware(
            spec, "mdio_wrong_phy_read",
            workdir=os.path.join(BUILD_DIR, "mdio_wrong_phy_read"))
        r = elf_cosim.run_elf_closed_loop(elf, m, max_steps=60000)
        assert m.faults() == [], m.faults()
        assert m.events() == []
        assert r.registers[4] & 0xFFFF == 0xFFFF
