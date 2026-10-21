"""Cycle timing from clpru ELFs run by the TI pru-simulator."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402


def constants(block, subdir, fields):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule(process.argv[1],process.argv[2]);
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[3]));
console.log(JSON.stringify(Object.fromEntries(m.config.filter(c=>/^constant[0-9]+$/.test(c.name)).map(c=>[c.name,c.getValue?c.getValue(i):c.default]))));"""
    return json.loads(subprocess.check_output(
        ["node", "-e", script, block, subdir, json.dumps(fields)], cwd=ROOT, text=True))


class CycleWord:
    def tick(self, cycle, _pins):
        return cycle & 0xFFFFF


def samples(tmp_path, clk_hz, naive=False):
    c = constants("logic_analyzer_block", "utils", {"clkHz": clk_hz, "sampleRateHz": 10_000_000})
    count = round(clk_hz / 10_000_000) if naive else int(c["constant1"])
    spec = dict(block="logic_analyzer_block", subdir="utils", macroCall="", opCode="m_logic_analyzer_block",
                macroArgs=dict(RES="R0.b1", periodCycles=str(count), bufferSize="16",
                               triggerPin="0", triggerSlope="0"), postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "logic", str(tmp_path))
    holder = {}

    def on_step(_cycle, _gpo, _gpi, sim):
        holder["sim"] = sim

    result = elf_cosim.run_elf_closed_loop(elf, CycleWord(), max_steps=1000, on_step=on_step)
    assert result.halted
    import struct
    words = struct.unpack("<16I", holder["sim"].memory_read(0x10000, 64))
    return [b - a for a, b in zip(words, words[1:])]


def assert_rate_period(periods, clk_hz):
    target = clk_hz / 10_000_000
    assert len(set(periods)) == 1
    measured = periods[0]
    assert abs(measured - target) <= 1, (
        f"logic_analyzer sample period {measured} cycles exceeds configured "
        f"{target:g} cycles at {clk_hz} Hz")


@pytest.mark.parametrize("clk_hz", [100_000_000, 200_000_000])
def test_logic_analyzer_realised_period(tmp_path, clk_hz):
    assert_rate_period(samples(tmp_path, clk_hz), clk_hz)


def test_naive_period_formula_is_rejected(tmp_path):
    with pytest.raises(AssertionError, match=r"logic_analyzer sample period 47 cycles exceeds configured 20 cycles"):
        assert_rate_period(samples(tmp_path, 200_000_000, naive=True), 200_000_000)


@pytest.mark.parametrize("clk_hz", [100_000_000, 200_000_000])
def test_ws2812_reference_pulses(tmp_path, clk_hz):
    c = constants("ws2812_block", "pru_io_blocks", {"clkHz": clk_hz, "numLeds": 1})
    spec = dict(block="ws2812_block", subdir="pru_io_blocks", macroCall="m_ws2812_tx",
                macroArgs=dict(RES="R0", PIN="5", DATA_REG="R4", NUM_LEDS="1",
                               T0H_CYC=str(c["constant4"]), T0L_CYC=str(c["constant5"]),
                               T1H_CYC=str(c["constant6"]), T1L_CYC=str(c["constant7"]),
                               TRESET_CYC=str(c["constant8"])),
                prelude=["ldi R4, 0"], postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "ws", str(tmp_path))
    result = elf_cosim.run_elf_closed_loop(elf, CycleWord(), max_steps=40000)
    assert result.halted
    edges = [(cycle, bool(gpo & (1 << 5))) for cycle, gpo, _ in result.trace]
    edges = [(cycle, level) for i, (cycle, level) in enumerate(edges)
             if i == 0 or level != edges[i - 1][1]]
    highs = [b[0] - a[0] for a, b in zip(edges, edges[1:]) if a[1]]
    assert len(highs) == 24
    assert set(highs) == {41 if clk_hz == 100_000_000 else 81}
    target = 400 * clk_hz / 1e9
    assert all(abs(width - target) <= 1 for width in highs), (highs, target)


def pin_edges(elf, pin=0, max_steps=20000):
    result = elf_cosim.run_elf_closed_loop(elf, CycleWord(), max_steps=max_steps)
    assert result.halted
    trace = [(cycle, bool(gpo & (1 << pin))) for cycle, gpo, _ in result.trace]
    return result, [(cycle, level) for i, (cycle, level) in enumerate(trace)
                    if i == 0 or level != trace[i - 1][1]]


def test_ssi_loop_trip_contract_and_monoflop(tmp_path):
    # HALF_PERIOD and MONO_CYCLES are documented iteration counts, not cycles.
    spec = dict(block="ssi_initiator_block", subdir="application_specific",
                macroCall="m_ssi_read", macroArgs=dict(
                    RES="R4", TOTAL_WIDTH="8", ST_BITS="4", MT_BITS="4",
                    CLK_PIN="0", DATA_PIN="1", CPOL="1", HALF_PERIOD="10",
                    MONO_CYCLES="20", PARITY_EN="0", PARITY_TYPE="0",
                    ERR_EN="0", GRAY_EN="0", TIMEOUT_CYCLES="100"),
                postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "ssi", str(tmp_path))
    result, edges = pin_edges(elf)
    falling = [cycle for cycle, high in edges if not high and cycle > 0]
    assert len(falling) == 9  # n+1 end-of-frame pulse
    assert set(b - a for a, b in zip(falling, falling[1:])) <= {48, 49}
    assert result.cycles - edges[-1][0] == 42  # 2*MONO_CYCLES + halt overhead


def test_biss_has_no_config_derived_delay_loop(tmp_path):
    # clockFreq is unused by this staged logical slice; it promises no 5 MHz timing.
    spec = dict(block="biss_c_initiator_block", subdir="application_specific",
                macroCall="m_biss_c_read", macroArgs=dict(RES="R4", CLK="0", DATA="1", LEN="8"),
                postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "biss", str(tmp_path))
    _, edges = pin_edges(elf)
    rising = [cycle for cycle, high in edges if high]
    assert [b - a for a, b in zip(rising, rising[1:])] == [8] * 7


def test_endat_half_period_is_documented_loop_trips(tmp_path):
    spec = dict(block="endat_initiator_block", subdir="application_specific",
                macroCall="m_endat_read", macroArgs=dict(
                    RES="R4", MODE_CMD="7", TOTAL_BITS="30", ST_BITS="13", MT_BITS="10",
                    CLK_PIN="0", DATA_TX_PIN="1", DATA_RX_PIN="2", HALF_PERIOD="25",
                    T1_CLOCKS="2", TRT_CYCLES="20", TREC_CYCLES="1000",
                    TIMEOUT_CYCLES="100", DATA_EN_PIN="3"), postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, "endat", str(tmp_path))
    _, edges = pin_edges(elf)
    # The clock idles HIGH and each bit is a low pulse. Every half period,
    # including the first one after the idle-entry rise, must be a full HALF_PERIOD
    # delay loop (2 cycles per trip), never a runt.
    half_periods = [b[0] - a[0] for a, b in zip(edges[1:], edges[2:])]
    assert len(half_periods) > 10
    assert min(half_periods) >= 2 * 25, f"EnDat clock runt: half periods {half_periods[:6]}"
    assert half_periods[0] >= 2 * 25  # the first pulse after idle entry, the one that was a 3-cycle runt
