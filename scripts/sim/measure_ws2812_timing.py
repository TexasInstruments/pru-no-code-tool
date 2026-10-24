"""measure WS2812 T0H/T0L/T1H/T1L and the LED-to-LED gap in cycles.

Runs m_ws2812_tx on the TI pru-simulator and reports, from the R30 trace,
the high and low time of every bit (cycles) and the low time that follows the
last bit of one LED (the inter-LED gap) versus a mid-LED bit of the same value.
Usage: python scripts/sim/measure_ws2812_timing.py [num_leds] [color_hex]
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

JS = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('ws2812_block', 'pru_io_blocks');
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[1]));
console.log(JSON.stringify(Object.fromEntries(m.config.filter(c=>/^constant[0-9]+$/.test(c.name)).map(c=>[c.name,c.getValue?c.getValue(i):c.default]))));"""


class _Loop:
    def tick(self, cycle, _pins):
        return cycle & 0xFFFFF


def measure(num_leds, color, pin=5, clk_hz=200_000_000):
    c = json.loads(subprocess.check_output(
        ["node", "-e", JS, json.dumps({"clkHz": clk_hz, "numLeds": num_leds})], cwd=ROOT, text=True))
    spec = dict(block="ws2812_block", subdir="pru_io_blocks", macroCall="m_ws2812_tx",
                macroArgs=dict(RES="R0", PIN=str(pin), DATA_REG="R4", NUM_LEDS=str(num_leds),
                               T0H_CYC=str(c["constant4"]), T0L_CYC=str(c["constant5"]),
                               T1H_CYC=str(c["constant6"]), T1L_CYC=str(c["constant7"]),
                               TRESET_CYC=str(c["constant8"])),
                prelude=[f"ldi32 R4, 0x{color:06X}"], postlude=["halt"])
    with tempfile.TemporaryDirectory() as d:
        elf, _ = elf_cosim.build_block_firmware(spec, "ws_meas", d)
        r = elf_cosim.run_elf_closed_loop(elf, _Loop(), max_steps=25000 + num_leds * 8000)
    edges, prev = [], None
    for cyc, gpo, _ in r.trace:
        lvl = bool(gpo & (1 << pin))
        if lvl != prev:
            edges.append((cyc, lvl))
            prev = lvl
    bits = []  # (high, low_after or None)
    for k in range(len(edges) - 1):
        if edges[k][1] and not edges[k + 1][1]:
            nxt = edges[k + 2][0] - edges[k + 1][0] if k + 2 < len(edges) else None
            bits.append((edges[k + 1][0] - edges[k][0], nxt))
    return bits


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    color = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0xA5C3F0
    bits = measure(n, color)
    print(f"bits seen: {len(bits)}")
    table = {}
    for idx, (hi, lo) in enumerate(bits):
        kind = "LED-last" if idx % 24 == 23 else "mid"
        table.setdefault((("1" if hi > 120 else "0"), kind), set()).add((hi, lo))
    for k in sorted(table):
        print(f"bit {k[0]} [{k[1]}]: (high,low) cycles = {sorted(table[k], key=str)}")


if __name__ == "__main__":
    main()
