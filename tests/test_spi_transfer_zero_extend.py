"""The pru_spi_transfer / pru_spi_read result clear lives INSIDE the macro.

Prefixing the clear to the whole getMacro() result is wrong: in the header form SysConfig emits (getMacro("", opCode),
which begins with the `name .macro ...` line) it puts `ldi r_dataReg, 0` ABOVE the .macro line, and clpru fails with
E0003 on every design using pru_spi_transfer. These tests cover the header form, a real
SysConfig -> clpru link, and the simulator (zero-extension AND the transmitted bits).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
sys.path.insert(0, str(ROOT / "tests"))
import elf_cosim  # noqa: E402
from perif.spi_adc import SpiAdc  # noqa: E402
import test_fanout_register_alias as T  # noqa: E402
from test_spi_read_zero_extend import (  # noqa: E402
    READ_VARIANTS, TRANSFER_VARIANTS, PRELOAD)

SCLK_PIN, SDI_PIN, SDO_PIN, CS_PIN = 0, 1, 2, 3
TX_WORD = 0xC35A96E1
RX_WORD = 0x7B3D5E92


def _header_bodies(block, variants):
    """getMacro("", name): the form SysConfig emits into pru_syscfg.inc (starts with the .macro line)."""
    code = r'''
const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const [block, variants] = process.argv.slice(1).map(JSON.parse);
const mod=loadBlockModule(block, 'pru_io_blocks');
process.stdout.write(JSON.stringify(variants.map(v => ({name: v, body: mod.getMacro('', v)}))));
'''
    result = subprocess.run(["node", "-e", code, json.dumps(block), json.dumps(variants)],
                            cwd=ROOT, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


@pytest.mark.parametrize("name", TRANSFER_VARIANTS)
def test_transfer_header_form_clears_inside_the_macro(name):
    body = _header_bodies("pru_spi_transfer", [name])[0]["body"]
    lines = body.splitlines()
    assert lines[0].startswith(name) and ".macro" in lines[0], "nothing may precede the .macro line: %r" % lines[0]
    clear = [i for i, l in enumerate(lines) if l.strip() == "ldi     r_dataReg, 0".strip()]
    assert len(clear) == 1, body
    assert "Parameters:" in lines[1] and lines[clear[0] - 1].lstrip().startswith(";"),         "clear must follow the parameter comment block directly"
    assert clear[0] < min(i for i, l in enumerate(lines) if l[:1].isalpha() and l.rstrip().endswith(":") and i > 0), \
        "clear must precede every label and loop"
    assert body.rstrip().endswith(".endm")


@pytest.mark.parametrize("name", READ_VARIANTS)
def test_read_header_form_clears_inside_the_macro(name):
    body = _header_bodies("pru_spi_read", [name])[0]["body"]
    lines = body.splitlines()
    assert lines[0].startswith(name) and ".macro" in lines[0]
    assert sum(1 for l in lines if l.strip() == "ldi     dataReg, 0") == 1


def test_read_prefix_probe_does_not_throw_but_a_real_variant_without_an_insert_point_does():
    """The block control-flow classifier probes getMacro("", "m_read_packet_spi_"); that must stay quiet."""
    code = r'''
const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const mod=loadBlockModule('pru_spi_read', 'pru_io_blocks');
mod.getMacro('', 'm_read_packet_spi_');
mod.getMacro('', 'm_read_packet_spi_unknown_variant');
let threw = false;
try { mod._testInsertReadResultInitialization('ldi R6, 8\nNO_READ_LOOP:', 'R0', 'm_read_packet_spi_mode0_msb_gpo_sclk'); }
catch (e) { threw = true; }
process.exit(threw ? 0 : 1);
'''
    result = subprocess.run(["node", "-e", code], cwd=ROOT, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr


needs_tools = pytest.mark.skipif(not T.HAVE_TOOLS, reason="clpru, SysConfig 1.28 CLI or pru-simulator missing")


@needs_tools
def test_transfer_design_generates_and_links_through_sysconfig_and_clpru():
    """Red at eb71f49c: a stray `ldi r_dataReg, 0` above `.macro` made clpru fail with E0003."""
    text = T.HEADER + (
        'const pru_spi_transfer = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_transfer", {}, false);\n'
        'const c = load_constant_block.addInstance(); c.constant1 = 0x5A; c.$name = "TX_Word";\n'
        'const spi = pru_spi_transfer.addInstance(); spi.$name = "SPI_XFER"; spi.packetSize = 24;\n'
        'scripting.connect(spi, "input1", c, "output1");\n')
    work = tempfile.mkdtemp(prefix="fer_")
    try:
        with open(os.path.join(work, "design.syscfg"), "w", encoding="utf-8") as f:
            f.write(text)
        T._run([T.SYSCFG_NODE, T.SYSCFG_CLI, "--product", T.PRODUCT_JSON, "--device", "AM243x_ALX_beta",
                "--context", "icss_g0_pru0", "--part", "ALX", "--package", "ALX", "--output", "syscfg",
                "design.syscfg"], work)
        inc = Path(work, "syscfg", "pru_syscfg.inc").read_text(encoding="utf-8")
        macro_at = inc.index("m_transfer_packet_spi_")
        line_start = inc.rfind("\n", 0, macro_at) + 1
        assert "r_dataReg, 0" not in inc[:line_start], "clear emitted above the .macro line"
        assert "ldi     r_dataReg, 0" in inc[line_start:], "clear missing from the macro"
        elf = T._link(work, T.MAIN_ASM, os.path.join(work, "syscfg", "pru_syscfg.asm"))
        assert elf[:4] == b"\x7fELF"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def transfer_spec(packet_size, reg, variant="m_transfer_packet_spi_mode0_lsb_gpo_sclk"):
    return {
        "block": "pru_spi_transfer", "subdir": "pru_io_blocks",
        "macroCall": "", "opCode": variant,
        "macroArgs": {
            "r_dataReg": reg, "s_dataReg": "R4", "PACKETSIZE": str(packet_size),
            "bitId": "R6", "SCLK_PIN": str(SCLK_PIN), "SDI_PIN": str(SDI_PIN), "SDO_PIN": str(SDO_PIN),
            "DELAY_COMPEN_1": "1", "DELAY_COMPEN_2": "1", "CS_PIN": str(CS_PIN),
            "CS_SETUP_TIME": "0", "CS_HOLD_TIME": "0", "DATA_SETUP_TIME": "0",
        },
        "prelude": ["set R30, R30, 3", "ldi32 R4, 0x%08X" % TX_WORD, "ldi32 R5, 0x%08X" % PRELOAD],
        "postlude": ["halt"],
    }


# (packet size, destination token, bits the destination owns). The allocator hands out R5.b0 / R5.w0 / R5.
TRANSFER_CASES = [(4, "R5.b0", 8), (8, "R5.b0", 8), (12, "R5.w0", 16), (16, "R5.w0", 16),
                  (20, "R5", 32), (24, "R5", 32), (32, "R5", 32)]


@pytest.mark.parametrize("packet_size,reg,owned", TRANSFER_CASES)
def test_transfer_zero_extends_and_still_transmits_the_right_bits(packet_size, reg, owned):
    elf, _ = elf_cosim.build_block_firmware(
        transfer_spec(packet_size, reg), "xfer_%d" % packet_size, str(ROOT / "build_out"))
    mask = (1 << packet_size) - 1
    device = SpiAdc(sclk_pin=SCLK_PIN, sdi_pin=SDI_PIN, sdo_pin=SDO_PIN, cs_pin=CS_PIN,
                    bits=packet_size, conversion=RX_WORD & mask, msb_first=False)
    result = elf_cosim.run_elf_closed_loop(elf, device, max_steps=4000)
    assert result.halted
    received = result.registers[5] & ((1 << owned) - 1)
    assert received & ~mask == 0, "stale bits above %d bits: 0x%08x" % (packet_size, received)
    assert received == RX_WORD & mask
    assert result.registers[4] & 0xFFFFFFFF == TX_WORD, "transmit register was modified"
    transactions = [e for e in device.events() if e["kind"] == "transaction"]
    assert len(transactions) == 1 and transactions[0]["mosi"] == TX_WORD & mask, transactions
    assert device.faults() == []


@pytest.mark.parametrize("variant", [v for v in TRANSFER_VARIANTS if "lsb" in v and "slave" not in v])
def test_transfer_clear_costs_exactly_one_cycle_on_the_master_variants(variant):
    """Same expanded asm with and without the clear. The cycle model's `1 -> 2` rests on this."""
    workdir = tempfile.mkdtemp(prefix="yc_")
    try:
        asm = elf_cosim.expand_block_asm(transfer_spec(24, "R5", variant), workdir)
        cleared = [l for l in asm.splitlines() if l.strip() == "ldi     R5, 0"]
        assert len(cleared) == 1, cleared
        cycles = {}
        for label, text in (("with", asm), ("without", asm.replace(cleared[0] + "\n", "", 1))):
            elf = elf_cosim.compile_asm(text, workdir, "cyc_" + label)
            device = SpiAdc(sclk_pin=SCLK_PIN, sdi_pin=SDI_PIN, sdo_pin=SDO_PIN, cs_pin=CS_PIN,
                            bits=24, conversion=RX_WORD & 0xFFFFFF, msb_first=False)
            res = elf_cosim.run_elf_closed_loop(elf, device, max_steps=4000)
            assert res.halted
            cycles[label] = res.cycles
        assert cycles["with"] - cycles["without"] == 1, cycles
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
