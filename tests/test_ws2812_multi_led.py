"""WS2812 multi-LED transmission test.

Verifies that for N = 1, 2, 8 and colors 0xFFFFFF, 0x000000, 0xA5C3F0,
all N LEDs receive the 24-bit color in GRB order.
The test oracle decodes the R30 waveform using WS2812 datasheet thresholds
(0 vs 1 by high time) and asserts that N x 24 bits all equal the color.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402


def _get_block_constants(clk_hz, num_leds):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('ws2812_block', 'pru_io_blocks');
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[1]));
console.log(JSON.stringify(Object.fromEntries(m.config.filter(c=>/^constant[0-9]+$/.test(c.name)).map(c=>[c.name,c.getValue?c.getValue(i):c.default]))));"""
    return json.loads(subprocess.check_output(
        ["node", "-e", script, json.dumps({"clkHz": clk_hz, "numLeds": num_leds})],
        cwd=ROOT, text=True))


class DummyPinLoop:
    def tick(self, cycle, _pins):
        return cycle & 0xFFFFF


MAX_INTER_LED_GAP_NS = 5000.0


def decode_ws2812_pixels(trace, pin=5, clk_hz=200_000_000):
    """Decode WS2812 waveform on the given pin according to datasheet thresholds.

    Datasheet timing specification (WS2812B):
    - T0H: 400 ns +/- 150 ns (250 ns to 550 ns)
    - T1H: 800 ns +/- 150 ns (650 ns to 950 ns)
    - T0L: 850 ns +/- 150 ns (700 ns to 1000 ns)
    - T1L: 450 ns +/- 150 ns (300 ns to 600 ns)
    - Inter-LED gap (low after a LED's last bit) obeys the same T0L/T1L
      window and must stay <= 5 us (reset is >= 50 us)
    - Decision threshold between 0 and 1: 600 ns (midpoint of [550, 650] ns)

    Each pixel consists of 24 bits transmitted MSB-first in GRB order.
    """
    ns_per_cycle = 1e9 / clk_hz
    pin_mask = 1 << pin

    transitions = []
    prev_level = None
    for cycle, gpo, _ in trace:
        level = bool(gpo & pin_mask)
        if level != prev_level:
            transitions.append((cycle, level))
            prev_level = level

    bits = []
    for i in range(len(transitions) - 1):
        cycle_curr, level_curr = transitions[i]
        cycle_next, level_next = transitions[i + 1]
        if level_curr and not level_next:
            high_ns = (cycle_next - cycle_curr) * ns_per_cycle
            if high_ns < 600.0:
                assert 250.0 <= high_ns <= 550.0, f"T0H {high_ns} ns violates datasheet [250, 550] ns"
                bit = 0
            else:
                assert 650.0 <= high_ns <= 950.0, f"T1H {high_ns} ns violates datasheet [650, 950] ns"
                bit = 1
            bits.append(bit)
            # Low time after this bit, up to the next rising edge. The last
            # bit of a LED is followed by the inter-LED gap, so this bounds
            # the gap as well. The final bit has no next rising edge (reset).
            if i + 2 < len(transitions):
                low_ns = (transitions[i + 2][0] - cycle_next) * ns_per_cycle
                lo, hi = (700.0, 1000.0) if bit == 0 else (300.0, 600.0)
                assert lo <= low_ns <= hi, (
                    f"T{bit}L {low_ns} ns violates datasheet [{lo}, {hi}] ns "
                    f"(bit {len(bits) - 1})")
                if len(bits) % 24 == 0:
                    assert low_ns <= MAX_INTER_LED_GAP_NS, (
                        f"inter-LED gap {low_ns} ns exceeds {MAX_INTER_LED_GAP_NS} ns")

    assert len(bits) % 24 == 0, f"Decoded {len(bits)} bits, not a multiple of 24"
    num_leds = len(bits) // 24
    pixels = []
    for i in range(num_leds):
        led_bits = bits[i * 24 : (i + 1) * 24]
        val = 0
        for b in led_bits:
            val = (val << 1) | b
        pixels.append(val)
    return pixels


@pytest.mark.parametrize("num_leds", [1, 2, 8])
@pytest.mark.parametrize("color", [0xFFFFFF, 0x000000, 0xA5C3F0])
def test_ws2812_multi_led_color(tmp_path, num_leds, color):
    clk_hz = 200_000_000
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
    elf, _ = elf_cosim.build_block_firmware(spec, "ws_test", str(tmp_path))
    # Reset pulse takes 12000 cycles, each LED takes ~6000 cycles (24 * 250 cycles)
    max_steps = 25000 + num_leds * 8000
    result = elf_cosim.run_elf_closed_loop(elf, DummyPinLoop(), max_steps=max_steps)
    assert result.halted, f"Firmware did not halt within {max_steps} cycles"

    pixels = decode_ws2812_pixels(result.trace, pin=5, clk_hz=clk_hz)
    assert len(pixels) == num_leds, f"Expected {num_leds} LEDs, got {len(pixels)}"
    expected = [color] * num_leds
    assert pixels == expected, f"Pixels mismatch: got {[hex(p) for p in pixels]}, expected {[hex(e) for e in expected]}"
