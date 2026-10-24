"""Controller-mode SPI SCLK pulse widths equal the configured high / low widths, for every mode and bit order.

Each pru_spi_{read,write,transfer} macro variant is expanded with the delay components the block itself computes
(delay_component1 / delay_component2) for an asymmetric 9-cycle high / 6-cycle low setting, compiled with clpru and run
on TI pru-simulator. Every SCLK high and low phase between the first and the last edge of the packet must last exactly
the configured number of cycles: an instruction that sits in the other half of the bit loop than the delay formula
assumes shows up as one half a cycle short and the other a cycle long, even though the bit period is right.

The read variants also clock in a known word from a model peripheral, so moving an instruction between the two halves
cannot change which bit is stored where.
"""
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

try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    _HAVE_SIM = True
except RuntimeError:
    _HAVE_SIM = False
needs_sim = pytest.mark.skipif(not _HAVE_SIM, reason="needs clpru (CGT_TI_PRU_PATH) + TI pru-simulator (PRU_SIMULATOR_PATH)")

SCLK_PIN, SDI_PIN, SDO_PIN, CS_PIN = 0, 1, 2, 3
HIGH, LOW = 9, 6
BITS = 16
WORD = 0xA51C
MODES = ("MODE0", "MODE1", "MODE2", "MODE3")
ORDERS = ("msb", "lsb")
MACRO = {"read": "m_read_packet_spi_%s_%s_gpo_sclk",
         "write": "m_send_packet_spi_%s_%s_gpo_sclk",
         "transfer": "m_transfer_packet_spi_%s_%s_gpo_sclk"}
CASES = [(kind, mode, order) for kind in MACRO for mode in MODES for order in ORDERS]


def _delay_components():
    """{kind: {mode: [delay_component1, delay_component2]}} from the blocks' own getValue at HIGH / LOW, 0 ns data setup."""
    code = r'''
const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const [high, low] = process.argv.slice(1).map(Number);
const out = {};
for (const kind of ['read', 'write', 'transfer']) {
  const mod = loadBlockModule('pru_spi_' + kind, 'pru_io_blocks');
  const cfg = name => mod.config.find(c => c.name === name);
  out[kind] = {};
  for (const mode of ['MODE0', 'MODE1', 'MODE2', 'MODE3']) {
    const inst = {'Device Mode': 'controller', 'SPI Mode': mode, 'Data Setup Time': 0,
                  'sclk high pulse width (in PRU cycles)': high, 'sclk low pulse width (in PRU cycles)': low};
    out[kind][mode] = [cfg('delay_component1').getValue(inst), cfg('delay_component2').getValue(inst)];
  }
}
process.stdout.write(JSON.stringify(out));
'''
    res = subprocess.run(["node", "-e", code, str(HIGH), str(LOW)], cwd=ROOT, text=True, capture_output=True, check=True)
    return json.loads(res.stdout)


def _spec(kind, mode, order, d1, d2):
    args = {"PACKETSIZE": str(BITS), "bitId": "R6.b0", "SCLK_PIN": str(SCLK_PIN),
            "DELAY_COMPEN_1": str(d1), "DELAY_COMPEN_2": str(d2), "CS_PIN": str(CS_PIN),
            "CS_SETUP_TIME": "0", "CS_HOLD_TIME": "0", "DATA_SETUP_TIME": "0"}
    if kind == "read":
        args.update(dataReg="R0.w0", SDI_PIN=str(SDI_PIN))
    elif kind == "write":
        args.update(dataReg="R1.w0", SDO_PIN=str(SDO_PIN))
    else:
        args.update(r_dataReg="R0.w0", s_dataReg="R1.w0", SDI_PIN=str(SDI_PIN), SDO_PIN=str(SDO_PIN))
    return {"block": "pru_spi_" + kind, "subdir": "pru_io_blocks", "macroCall": "",
            "opCode": MACRO[kind] % (mode.lower(), order), "macroArgs": args,
            "prelude": ["set R30, R30, %d" % CS_PIN] + (["set R30, R30, %d" % SCLK_PIN] if mode in ("MODE2", "MODE3") else [])
                       + ["ldi R1, 0x5AC3"],
            "postlude": ["halt"]}


class Peripheral:
    """Drives WORD on SDI, changing the bit on each shifting edge (CPHA 0: before the first edge and on every
    second-of-pair edge; CPHA 1: on every first-of-pair edge), in the configured bit order."""

    def __init__(self, mode, order):
        self.cpha = mode in ("MODE1", "MODE3")
        self.idle = 1 if mode in ("MODE2", "MODE3") else 0
        bits = [(WORD >> i) & 1 for i in range(BITS)]
        self.bits = bits if order == "lsb" else bits[::-1]
        self.prev, self.edges, self.out = self.idle, 0, None

    def tick(self, cycle, gpo):
        cs = (gpo >> CS_PIN) & 1
        sclk = (gpo >> SCLK_PIN) & 1
        if cs:
            self.prev, self.edges, self.out = self.idle, 0, None
            return 0
        if sclk != self.prev:
            self.edges += 1
            self.prev = sclk
            if self.cpha and self.edges % 2 == 1:
                self.out = self.bits[min(self.edges // 2, BITS - 1)]
            elif not self.cpha and self.edges % 2 == 0:
                self.out = self.bits[min(self.edges // 2, BITS - 1)]
        if self.out is None and not self.cpha:
            self.out = self.bits[0]
        return (self.out or 0) << SDI_PIN


def _phases(trace):
    """[(level, cycles)] for every SCLK phase between the first and the last SCLK edge while CS is asserted."""
    edges, prev = [], None
    for cycle, gpo, _gpi in trace:
        if (gpo >> CS_PIN) & 1:
            prev = None
            continue
        bit = (gpo >> SCLK_PIN) & 1
        if prev is not None and bit != prev:
            edges.append((cycle, bit))
        prev = bit
    return [(lvl, nxt - cyc) for (cyc, lvl), (nxt, _) in zip(edges, edges[1:])]


@pytest.fixture(scope="module")
def delays():
    return _delay_components()


@needs_sim
@pytest.mark.parametrize("kind,mode,order", CASES)
def test_sclk_high_and_low_widths_match_the_configuration(delays, kind, mode, order):
    d1, d2 = delays[kind][mode]
    name = "duty_%s_%s_%s" % (kind, mode.lower(), order)
    elf, _ = elf_cosim.build_block_firmware(_spec(kind, mode, order, d1, d2), name, str(ROOT / "build_out" / "spi_sclk_duty"))
    run = elf_cosim.run_elf_closed_loop(elf, Peripheral(mode, order), max_steps=4000)
    assert run.halted, "firmware did not halt"
    phases = _phases(run.trace)
    assert len(phases) == 2 * BITS - 1, "expected %d SCLK phases inside the packet, got %d" % (2 * BITS - 1, len(phases))
    want = {1: HIGH, 0: LOW}
    wrong = [(i, lvl, n) for i, (lvl, n) in enumerate(phases) if n != want[lvl]]
    assert not wrong, "%s %s %s: SCLK phases (index, level, cycles) off the configured %d high / %d low: %s" % (
        kind, mode, order, HIGH, LOW, wrong[:6])
    if kind != "write":
        assert run.registers[0] & 0xFFFF == WORD, "%s %s %s read 0x%04x, peripheral sent 0x%04x" % (
            kind, mode, order, run.registers[0] & 0xFFFF, WORD)
