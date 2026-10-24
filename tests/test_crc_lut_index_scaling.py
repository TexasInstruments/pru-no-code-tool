"""crc_block CRC-16/CRC-32 table indexing must be byte-scaled.

The CRC-16/CRC-32 macros used the raw table index (0-255, TEMP_REG2.b0) as
the LBBO byte offset, but the LUT entries are 2/4 bytes wide, so any non-zero
index read the wrong bytes (observed on the TI pru-simulator: CRC-16 poly
0x8005 init 0 over ff ff gave 0x8004 instead of 0x800D, etc.).

The oracle in this test is the bit-serial CRC written below from the
polynomial-division definition (crc_bit_serial).  It is deliberately
independent of the block's lookup table (crc_block.syscfg.js
getLookUptable), the block's JS model and the repo's JS simulator CRC.

Arms:
  * catalogue: the oracle reproduces the published check values of
    CRC-16/XMODEM, CRC-16/BUYPASS (0x8005 init 0, no reflection) and
    CRC-32/MPEG-2 - runs everywhere, no toolchain.
  * static: the emitted macro text scales the index (zero-extend, shift,
    ADD into the base) and zeroes the LBBO offset register, while CRC-8
    (1-byte entries) keeps its direct index - runs everywhere.
  * headless: the real emitted macro + emitted LUT run on the repo's
    instruction simulator (scripts/sim/crc_dut.js, DUT only) must
    match the oracle on vectors whose table index is non-zero at EVERY
    step - runs wherever node exists.
  * ti_sim: same vectors on the real clpru-assembled macro running on the
    TI pru-simulator - SKIPs with a reason when the simulator
    (PRU_SIMULATOR_PATH / tools/pru-simulator-upstream) or clpru
    (CGT_TI_PRU_PATH) is unavailable; it must never silently pass.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "sim"))

BLOCK_JS = os.path.join(
    ROOT, ".metadata/sysconfig/.meta/pru_blocks/application_specific/crc_block.syscfg.js")
DUT_JS = os.path.join(ROOT, "scripts", "sim", "crc_dut.js")


# ---------------------------------------------------------------------------
# oracle: bit-serial CRC from the definition (NOT the block's table/model)
# ---------------------------------------------------------------------------

def crc_bit_serial(data, poly, width, init):
    """MSB-first polynomial division, written from the definition:
    crc = remainder of (init * x^n + data) * x^width divided by the
    generator, i.e. XOR the (width-8)-shifted byte into the top of the
    register, then 8 times: shift left, XOR the generator when the bit
    shifted out was 1.  No reflection, no xorout - exactly what the block
    documents."""
    top = 1 << (width - 1)
    mask = (1 << width) - 1
    crc = init & mask
    for byte in data:
        crc ^= (byte & 0xFF) << (width - 8)
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & mask if crc & top else (crc << 1) & mask
    return crc


def every_table_index_nonzero(data, poly, width, init):
    """True when (crc >> (width-8)) ^ byte is non-zero at every step, i.e.
    the run actually exercises the scaled-offset path."""
    crc = init & ((1 << width) - 1)
    for byte in data:
        if (((crc >> (width - 8)) ^ byte) & 0xFF) == 0:
            return False
        crc = crc_bit_serial([byte], poly, width, crc)
    return True


# name -> (opCode, poly, width, init)
CONFIGS = {
    "xmodem": ("m_calculate_crc16", 0x1021, 16, 0x0000),
    "buypass_8005": ("m_calculate_crc16", 0x8005, 16, 0x0000),
    "ccitt_false": ("m_calculate_crc16", 0x1021, 16, 0xFFFF),
    "crc32_mpeg2": ("m_calculate_crc32", 0x04C11DB7, 32, 0xFFFFFFFF),
    "crc32_zero_init": ("m_calculate_crc32", 0x04C11DB7, 32, 0x00000000),
}

# every input here has a non-zero table index on EVERY step (asserted below)
VECTORS = [
    ("xmodem", b"123456789", 0x31C3),                    # CRC-16/XMODEM check
    ("buypass_8005", b"123456789", 0xFEE8),              # CRC-16/BUYPASS check
    ("crc32_mpeg2", b"123456789", 0x0376E6E7),           # CRC-32/MPEG-2 check
    ("buypass_8005", bytes([0xFF, 0xFF]), 0x800D),       # TI-sim observation
    ("buypass_8005", bytes([0x31, 0x32]), 0xA6AC),       # TI-sim observation
    ("ccitt_false", b"1234", 0x5349),                    # TI-sim observation
    ("crc32_zero_init", bytes([0xFF, 0xFF]), 0xFF48647D),        # TI-sim obs.
    ("crc32_mpeg2", b"1234", 0xA695C4AA),                # TI-sim observation
]


# ---------------------------------------------------------------------------
# arm 1: the oracle reproduces the catalogue check values
# ---------------------------------------------------------------------------

def test_oracle_matches_catalogue_check_values():
    # Williams' catalogue (rev 2021-06-28): CRC-16/XMODEM, CRC-16/BUYPASS,
    # CRC-32/MPEG-2 - all MSB-first, no reflection, no xorout.
    for cfg, data, check in VECTORS:
        _op, poly, width, init = CONFIGS[cfg]
        assert crc_bit_serial(data, poly, width, init) == check, (cfg, data)


def test_vectors_hit_a_nonzero_table_index_on_every_step():
    for cfg, data, _check in VECTORS:
        _op, poly, width, init = CONFIGS[cfg]
        assert every_table_index_nonzero(data, poly, width, init), (cfg, data)


# ---------------------------------------------------------------------------
# arm 2: static check of the emitted macro text
# ---------------------------------------------------------------------------

def _macro_body(src, name):
    m = re.search(r'startsWith\("%s"\)\)\s*\{\s*//.*?macroBody \+= `(.*?)`;' % name,
                  src, re.DOTALL)
    if m is None:  # fall back without the explanatory comment
        m = re.search(r'startsWith\("%s"\)\)\s*\{\s*macroBody \+= `(.*?)`;' % name,
                      src, re.DOTALL)
    assert m, "macro body for %s not found" % name
    return m.group(1)


def test_crc16_and_crc32_macros_scale_the_lut_index():
    src = open(BLOCK_JS, encoding="utf-8").read()
    for name, shift in (("m_calculate_crc16", 1), ("m_calculate_crc32", 2)):
        body = _macro_body(src, name)
        # index is zero-extended then scaled by the entry width ...
        assert re.search(r"AND\s+TEMP_REG2, TEMP_REG2, 0xFF", body), name
        assert re.search(r"LSL\s+TEMP_REG2, TEMP_REG2, %d" % shift, body), name
        # ... added into the LBBO base (a scaled CRC-32 offset, up to 1020,
        # does not fit in a .b0 operand) ...
        assert re.search(r"ADD\s+TEMP_REG1, TEMP_REG1, TEMP_REG2", body), name
        # ... and the offset register is zeroed so the LBBO adds offset 0.
        assert re.search(r"LDI\s+TEMP_REG2, 0\s*\n\s*LBBO\s+&\$\{crcResult\}, "
                         r"TEMP_REG1, TEMP_REG2\.b0, %d" % (shift * 2), body), name


def test_crc8_macro_is_unchanged_direct_index():
    # 1-byte entries: the raw index IS the byte offset; no scaling allowed.
    src = open(BLOCK_JS, encoding="utf-8").read()
    body = _macro_body(src, "m_calculate_crc8")
    assert "LBBO    &${crcResult}, TEMP_REG1, TEMP_REG2.b0, 1" in body
    assert "ADD" not in body and "LSL" not in body


def test_reported_cycle_counts_cover_the_scaling_instructions():
    # LDI32(2) + LSR + XOR + AND + LSL + ADD + LDI + LBBO(3) + LSL + XOR = 13
    src = open(BLOCK_JS, encoding="utf-8").read()
    tail = src[src.index('name: "noOfCycles"'):]
    for mode, want in (("m_calculate_crc8", 6), ("m_calculate_crc16", 13),
                       ("m_calculate_crc32", 13)):
        m = re.search(r'if\(inst\["opCode"\] == "%s"\)\s*\{\s*return (\d+)\s*\}'
                      % mode, tail)
        assert m, mode
        assert int(m.group(1)) == want, (mode, m.group(1))


# ---------------------------------------------------------------------------
# arm 3: run the emitted macro + emitted LUT on the repo headless simulator
# (DUT only - the expected values come from crc_bit_serial above)
# ---------------------------------------------------------------------------

def _run_dut(op_code, poly, init, data):
    spec = {"mode": "run", "opCode": op_code, "crcPolynomial": poly,
            "init": init, "bytes": list(data)}
    r = subprocess.run(["node", DUT_JS, json.dumps(spec)],
                       capture_output=True, text=True, timeout=120, check=True)
    out = json.loads(r.stdout)
    assert out["unknownInstruction"] == 0 and out["errorParsing"] == 0, out
    return out["result"]


HAVE_NODE = subprocess.run(["node", "--version"], capture_output=True).returncode == 0


@pytest.mark.skipif(not HAVE_NODE,
                    reason="node not available to run the headless DUT driver")
@pytest.mark.parametrize("cfg,data,expected", VECTORS)
def test_headless_macro_matches_bit_serial_oracle(cfg, data, expected):
    op_code, poly, width, init = CONFIGS[cfg]
    assert _run_dut(op_code, poly, init, data) == expected
    # and the oracle agrees with itself for the same config (belt and braces)
    assert crc_bit_serial(data, poly, width, init) == expected


def test_emitted_table_little_endian_at_entry_stride():
    """The table emitter must store entries little-endian at 2/4-byte stride
    for LBBO of 2/4 bytes to read them back (task 2)."""
    r = subprocess.run(
        ["node", DUT_JS, json.dumps({"mode": "table", "opCode": "m_calculate_crc32",
                                     "crcPolynomial": 0x04C11DB7})],
        capture_output=True, text=True, timeout=120, check=True)
    lut = json.loads(r.stdout)["lut"]
    assert len(lut) == 256
    assert (lut[1] & 0xFFFFFFFF) == 0x04C11DB7        # entry 1 = poly (x^32)
    assert (lut[0] & 0xFFFFFFFF) == 0


# ---------------------------------------------------------------------------
# arm 4: real clpru ELF on the TI pru-simulator (skips without toolchain)
# ---------------------------------------------------------------------------

try:
    import elf_cosim
    _SIM = elf_cosim.find_pru_simulator()
    _CLPRU = True
    try:
        elf_cosim.find_clpru()
    except RuntimeError:
        _CLPRU = False
except RuntimeError:
    _SIM = None
    _CLPRU = False
    import elf_cosim  # noqa: F401  (still importable)

needs_ti = pytest.mark.skipif(
    _SIM is None or not _CLPRU,
    reason="TI pru-simulator (set PRU_SIMULATOR_PATH) and/or clpru "
           "(set CGT_TI_PRU_PATH) unavailable - cannot run the assembled macro")


class _Idle:
    def tick(self, _cycle, _gpo):
        return 0


def _ti_run_byte(op_code, poly, init, byte, width):
    """Assemble the block's emitted macro + emitted LUT into one real ELF
    (table in .data -> PRU0 DMEM), run one byte on the TI simulator."""
    spec = {
        "block": "crc_block", "subdir": "application_specific",
        "macroCall": "", "opCode": op_code,
        "macroArgs": {"crcResult": "R10", "crcInit": "R4",
                      "dataByte": "R5", "lutAddress": "lut"},
        "prelude": ["ldi32 R4, %d" % (init & 0xFFFFFFFF),
                    "ldi32 R5, %d" % byte],
        "postlude": ["halt"],
    }
    with tempfile.TemporaryDirectory(prefix="case_") as wd:
        asm = elf_cosim.expand_block_asm(spec, wd)
        # append the block's own emitted table so the firmware under test
        # carries exactly the LUT the tool generates
        r = subprocess.run(
            ["node", DUT_JS, json.dumps({"mode": "table", "opCode": op_code,
                                         "crcPolynomial": poly})],
            capture_output=True, text=True, timeout=120, check=True)
        values = [v & 0xFFFFFFFF for v in json.loads(r.stdout)["lut"]]
        directive = ".ushort" if width == 16 else ".uint"
        lut_asm = ('\n\t.sect ".data"\nlut\t%s %s\n'
                   % (directive, ", ".join(str(v) for v in values)))
        asm = asm.replace("    .end", lut_asm + "    .end")
        elf = elf_cosim.compile_asm(asm, wd, "crc")
        res = elf_cosim.run_elf_closed_loop(elf, _Idle(), max_steps=200)
    assert res.halted, "PRU did not halt"
    return res.registers[10] & ((1 << width) - 1)


@needs_ti
@pytest.mark.parametrize("cfg,data,expected", VECTORS)
def test_ti_simulator_macro_matches_bit_serial_oracle(cfg, data, expected):
    op_code, poly, width, init = CONFIGS[cfg]
    crc = init
    for byte in data:                       # chain byte-by-byte like the design
        crc = _ti_run_byte(op_code, poly, crc, byte, width)
    assert crc == expected
    assert crc_bit_serial(data, poly, width, init) == expected
