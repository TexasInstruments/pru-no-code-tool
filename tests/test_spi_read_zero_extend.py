"""SPI read results replace stale bits without stealing a neighbour byte."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402
from perif.spi_adc import SpiAdc  # noqa: E402


SCLK_PIN, SDI_PIN, CS_PIN = 0, 1, 3
PRELOAD = 0xA5A5A5FF
DEVICE_WORD = 0x00A5A55A
SIZES = [1, 8, 16, *range(17, 25), 32]
READ_VARIANTS = [
    name
    for mode in range(4) for order in ("msb", "lsb")
    for name in ("m_read_packet_spi_mode%d_%s_gpo_sclk" % (mode, order),
                 "m_read_packet_spi_mode%d_slave_%s_gpi_sclk" % (mode, order))
]
TRANSFER_VARIANTS = [name.replace("m_read_packet_spi_", "m_transfer_packet_spi_")
                     for name in READ_VARIANTS]


def _module_probe(block, variants, sizes=SIZES):
    """Ask the real block module for every generated body and output allocation."""
    code = r'''
const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const [block, variants, sizes] = process.argv.slice(1).map(JSON.parse);
const mod=loadBlockModule(block, 'pru_io_blocks');
const size=mod.config.find(c => c.name === 'output1Size');
function reg(n) { return n <= 8 ? 'R0.b0' : n <= 16 ? 'R0.w0' : 'R0'; }
const out=[];
for (const name of variants) for (const n of sizes) {
  const slave=name.includes('_slave_');
  const args=slave ? [reg(n), 'R2', String(n), 'R6', '0', '1', '2', '3', '1'] :
    (block === 'pru_spi_transfer' ? [reg(n), 'R2', String(n), 'R6', '0', '1', '2', '1', '1', '3', '0', '0', '0'] :
     [reg(n), String(n), 'R6', '0', '1', '1', '1', '3', '0', '0', '0']);
  out.push({name, n, bytes:size.getValue({packetSize:n}), body:mod.getMacro([name, ...args].join(', '), name)});
}
process.stdout.write(JSON.stringify(out));
'''
    result = subprocess.run(
        ["node", "-e", code, json.dumps(block), json.dumps(variants), json.dumps(sizes)],
        cwd=ROOT, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def test_all_spi_read_variants_clear_exactly_their_allocator_owned_result():
    """All 16 macro branches cover 1, 8, 16, 17..24, and 32-bit outputs."""
    seen = _module_probe("pru_spi_read", READ_VARIANTS)
    assert len(seen) == len(READ_VARIANTS) * len(SIZES)
    for item in seen:
        expected_bytes = 1 if item["n"] <= 8 else 2 if item["n"] <= 16 else 4
        expected_reg = "R0.b0" if expected_bytes == 1 else "R0.w0" if expected_bytes == 2 else "R0"
        assert item["bytes"] == expected_bytes, item
        assert item["body"].count("ldi     %s, 0" % expected_reg) == 1, item["name"]
        loop = "READ_BIT_LOOP?:" if "READ_BIT_LOOP?:" in item["body"] else "SEND_BIT_LOOP?:"
        assert item["body"].index("ldi     %s, 0" % expected_reg) < item["body"].index(loop)


def test_spi_transfer_has_the_same_read_result_initialization_for_every_variant():
    """Full-duplex transfer has its own receive register and must not retain stale high bits."""
    seen = _module_probe("pru_spi_transfer", TRANSFER_VARIANTS)
    assert len(seen) == len(TRANSFER_VARIANTS) * len(SIZES)
    for item in seen:
        expected_bytes = 1 if item["n"] <= 8 else 2 if item["n"] <= 16 else 4
        expected_reg = "R0.b0" if expected_bytes == 1 else "R0.w0" if expected_bytes == 2 else "R0"
        assert item["bytes"] == expected_bytes, item
        assert item["body"].count("ldi     %s, 0" % expected_reg) == 1, item["name"]
        loop = "READ_BIT_LOOP?:" if "READ_BIT_LOOP?:" in item["body"] else "SEND_BIT_LOOP?:"
        assert item["body"].index("ldi     %s, 0" % expected_reg) < item["body"].index(loop)


def test_read_initialization_guard_throws_when_no_read_loop_insert_point_exists():
    code = r'''
const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const mod=loadBlockModule('pru_spi_read', 'pru_io_blocks');
try { mod._testInsertReadResultInitialization('ldi R6, 8\\nNO_READ_LOOP:', 'R0', 'm_read_packet_spi_mode0_msb_gpo_sclk'); }
catch (e) { process.stdout.write(e.message); process.exit(0); }
process.exit(1);
'''
    result = subprocess.run(["node", "-e", code], cwd=ROOT, text=True, capture_output=True)
    assert result.returncode == 0
    assert "could not find READ_BIT_LOOP initialization point" in result.stdout


def spi_read_spec(packet_size):
    return {
        "block": "pru_spi_read", "subdir": "pru_io_blocks",
        "macroCall": "", "opCode": "m_read_packet_spi_mode0_msb_gpo_sclk",
        "macroArgs": {
            "dataReg": "R0", "PACKETSIZE": str(packet_size), "bitId": "R6",
            "SCLK_PIN": str(SCLK_PIN), "SDI_PIN": str(SDI_PIN),
            "DELAY_COMPEN_1": "1", "DELAY_COMPEN_2": "1", "CS_PIN": str(CS_PIN),
            "CS_SETUP_TIME": "0", "CS_HOLD_TIME": "0", "DATA_SETUP_TIME": "0",
        },
        # Model the natural register reuse seen in the regression: the destination
        # contains a prior word before the shorter SPI read starts.
        "prelude": ["set R30, R30, 3", "ldi32 R0, 0x%08X" % PRELOAD],
        "postlude": ["halt"],
    }


@pytest.mark.parametrize("packet_size", SIZES)
def test_spi_read_clears_destination_bits_above_packet_size(packet_size):
    elf, _ = elf_cosim.build_block_firmware(
        spi_read_spec(packet_size), "spi_read_%d" % packet_size,
        str(ROOT / "build_out"))
    device = SpiAdc(sclk_pin=SCLK_PIN, sdi_pin=SDI_PIN, sdo_pin=2,
                    cs_pin=CS_PIN, bits=packet_size, conversion=DEVICE_WORD,
                    msb_first=True)
    result = elf_cosim.run_elf_closed_loop(
        elf, device, max_steps=2000)

    assert result.halted, "SPI read firmware did not halt"
    mask = (1 << packet_size) - 1
    received = result.registers[0] & 0xFFFFFFFF
    assert received & ~mask == 0, (
        "SPI read left stale bits above its %d-bit packet: 0x%08x" %
        (packet_size, received))
    assert received == DEVICE_WORD & mask
    assert device.faults() == []
