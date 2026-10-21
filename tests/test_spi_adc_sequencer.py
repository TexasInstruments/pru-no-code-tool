import os
import sys
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "sim")))

from perif.spi_adc import SpiAdc
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

def _spi_seq_spec(bug_inject="none"):
    return {
        "block": "spi_adc_sequencer_block", "subdir": "pru_io_blocks",
        "macroCall": "m_spi_adc_seq",
        "opCode": f"m_spi_adc_seq_2_{bug_inject}",
        "macroArgs": {
            "RES0": "R4", "RES1": "R5",
            "CS_PIN": "3", "SCLK_PIN": "0", "MOSI_PIN": "2", "MISO_PIN": "1",
            "T_CONV": "20", "BITS": "16",
            "CMD0": "0x1234", "CMD1": "0x5678",
            "PAD_CYCLES": "100" # arbitrary, the block calculates its own cycle count inside but wait, the macro args replace literal parameters in PRU assembly!
        },
        "config": {
            "bits_per_frame": "16",
            "t_conv": "20",
            "sample_period": "2000",
            "channel_sequence": "0x1234, 0x5678",
            "cs_pin": "3",
            "sclk_pin": "0",
            "mosi_pin": "2",
            "miso_pin": "1",
            "base_data_reg": "R4",
            "bug_inject": bug_inject
        },
        "prelude": ["set R30, R30, 3"],  # CS idle high, as the generated prologue does
        "postlude": ["halt"],
    }

@needs_elf
class TestSpiAdcSequencerElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, bug in (("seq_green", "none"), ("seq_red_a", "clocks_while_cs_deasserted"), ("seq_red_b", "wrong_clock_count")):
            elf, _asm = elf_cosim.build_block_firmware(
                _spi_seq_spec(bug), name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_green_sequence_valid(self, built):
        m = SpiAdc(sclk_pin=0, sdi_pin=1, sdo_pin=2, cs_pin=3, bits=16,
                   conversion=0xBEEF, msb_first=True)
        r = elf_cosim.run_elf_closed_loop(built["seq_green"], m, max_steps=4000)
        assert r.halted
        assert m.faults() == [], f"Green arm failed with faults: {m.faults()}"
        ev = [e for e in m.events() if e["kind"] == "transaction"]
        assert len(ev) == 2, f"Expected 2 transactions, got {len(ev)}"
        assert ev[0]["mosi"] == 0x1234
        assert ev[1]["mosi"] == 0x5678
        assert u32(r.registers[4]) & 0xFFFF == 0xBEEF
        assert u32(r.registers[5]) & 0xFFFF == 0xBEEF

    def test_red_arm_a_clocks_while_cs_deasserted(self, built):
        m = SpiAdc(sclk_pin=0, sdi_pin=1, sdo_pin=2, cs_pin=3, bits=16,
                   conversion=0xBEEF, msb_first=True)
        r = elf_cosim.run_elf_closed_loop(built["seq_red_a"], m, max_steps=4000)
        faults = m.faults()
        assert any("SCLK edge while CS deasserted" in f for f in faults), "Red arm A failed to catch clocks while CS deasserted"

    def test_red_arm_b_wrong_clock_count(self, built):
        m = SpiAdc(sclk_pin=0, sdi_pin=1, sdo_pin=2, cs_pin=3, bits=16,
                   conversion=0xBEEF, msb_first=True)
        r = elf_cosim.run_elf_closed_loop(built["seq_red_b"], m, max_steps=4000)
        faults = m.faults()
        assert any("more than 16 clocks in frame" in f for f in faults), "Red arm B failed to catch wrong clock count"

