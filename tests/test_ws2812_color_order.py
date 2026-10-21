"""WS2812 color order and GRB wire transmission test.

Verifies:
1. ws2812_block does not declare a no-op 'colorOrder' configurable.
2. The block's description documents that the 24-bit color register is sent
   bit 23 first in GRB packing.
3. An independent simulator-backed test confirms that on the wire, the register
   is sent bit 23 first in GRB packing (e.g. 0x00FF00 sends Green=0x00 then
   Red=0xFF then Blue=0x00; 0xFF0000 sends Green=0xFF then Red=0x00 then Blue=0x00).
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402
from test_ws2812_multi_led import decode_ws2812_pixels, _get_block_constants, DummyPinLoop  # noqa: E402


def test_ws2812_color_order_removed_from_config():
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('ws2812_block', 'pru_io_blocks');
const cfgNames = m.config.map(c => c.name);
console.log(JSON.stringify({cfgNames, longDescription: m.longDescription}));"""
    data = json.loads(subprocess.check_output(
        ["node", "-e", script],
        cwd=ROOT, text=True))
    assert "colorOrder" not in data["cfgNames"], "colorOrder option should be removed from ws2812_block"
    assert "bit 23 first in GRB packing" in data["longDescription"], (
        f"longDescription must document GRB packing, got: {data['longDescription']}"
    )


@pytest.mark.parametrize("color, expected_first_byte, expected_second_byte, expected_third_byte", [
    (0x00FF00, 0x00, 0xFF, 0x00),  # RGB red in GRB packing: Green=0, Red=0xFF, Blue=0
    (0xFF0000, 0xFF, 0x00, 0x00),  # RGB green in GRB packing: Green=0xFF, Red=0, Blue=0
    (0x0000FF, 0x00, 0x00, 0xFF),  # RGB blue in GRB packing: Green=0, Red=0, Blue=0xFF
])
def test_ws2812_grb_wire_order_simulator(tmp_path, color, expected_first_byte, expected_second_byte, expected_third_byte):
    clk_hz = 200_000_000
    num_leds = 1
    c = _get_block_constants(clk_hz, num_leds)
    spec = dict(
        block="ws2812_block",
        subdir="pru_io_blocks",
        macroCall="m_ws2812_tx",
        macroArgs=dict(
            RES="R0",
            PIN="5",
            DATA_REG="R4",
            NUM_LEDS=str(num_leds),
            T0H_CYC=str(c["constant4"]),
            T0L_CYC=str(c["constant5"]),
            T1H_CYC=str(c["constant6"]),
            T1L_CYC=str(c["constant7"]),
            TRESET_CYC=str(c["constant8"]),
        ),
        prelude=[f"ldi32 R4, 0x{color:06X}"],
        postlude=["halt"],
    )
    elf, _ = elf_cosim.build_block_firmware(spec, "ws_color_test", str(tmp_path))
    max_steps = 35000
    result = elf_cosim.run_elf_closed_loop(elf, DummyPinLoop(), max_steps=max_steps)
    assert result.halted, f"Firmware did not halt within {max_steps} cycles"

    pixels = decode_ws2812_pixels(result.trace, pin=5, clk_hz=clk_hz)
    assert len(pixels) == 1
    val = pixels[0]
    byte1 = (val >> 16) & 0xFF
    byte2 = (val >> 8) & 0xFF
    byte3 = val & 0xFF
    assert byte1 == expected_first_byte, f"First byte on wire mismatch: {byte1:#04x} != {expected_first_byte:#04x}"
    assert byte2 == expected_second_byte, f"Second byte on wire mismatch: {byte2:#04x} != {expected_second_byte:#04x}"
    assert byte3 == expected_third_byte, f"Third byte on wire mismatch: {byte3:#04x} != {expected_third_byte:#04x}"
