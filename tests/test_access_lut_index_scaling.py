"""access_look_up_table must scale the index by the entry size.

The generated read of a ushort/uint table was `LBBO &res, TEMP_REG1, <index>, 2|4`:
the index register was used as a raw byte offset, so index 1 of a ushort table
returned bytes 1-2 of the table, not entry 1 (the crc block's table read had the
same issue).  Byte tables were correct.

The oracle is the table written in this test (distinct, non-repeating bytes) -
independent of the block.  The firmware under test is the block's own emitted
macro (getMacro) assembled by clpru and run on the TI pru-simulator, with the
table placed in .data (PRU0 DMEM).  Without a pru-simulator checkout
(PRU_SIMULATOR_PATH) or clpru the simulator tests are reported as SKIPPED with
the reason (see conftest.py).
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "sim"))
import elf_cosim  # noqa: E402

CYCLES_JS = os.path.join(ROOT, "scripts", "sim", "lut_cycles.js")

N = 8
# entry values with no repeated/aligned byte pattern, so a byte-offset read of
# entry i (bytes i..i+size-1) can never coincide with the right answer.
TABLES = {
    "byte": (".byte", 1, [0x11, 0x2E, 0x73, 0xC4, 0x95, 0xA6, 0x58, 0xF9]),
    "ushort": (".ushort", 2, [0x1D2E, 0xF898, 0x73C4, 0x95A6, 0x5B7A, 0xE0D1, 0x3C49, 0xA8F2]),
    "uint": (".uint", 4, [0x1D2E3F40, 0xEFA88F0E, 0x73C4D5E6, 0x95A6B7C8,
                          0x5B7A9CBD, 0xE0D1C2B3, 0x3C49586A, 0xA8F2D613]),
}
assert all(len(v[2]) == N for v in TABLES.values())


class _Idle:
    def tick(self, _cycle, _gpo):
        return 0


def _build_and_run(data_type, index, with_macro=True):
    directive, size, values = TABLES[data_type]
    spec = {
        "block": "access_look_up_table", "subdir": "utils",
        "macroCall": "", "opCode": "m_lookup_table",
        "macroArgs": {"result": "R10", "index": "R4",
                      "lutAddress": "lut", "byteSize": str(size)},
        "prelude": ["ldi R10, 0", "ldi R4, %d" % index],
        "postlude": ["halt"],
    }
    with tempfile.TemporaryDirectory(prefix="case_") as wd:
        asm = elf_cosim.expand_block_asm(spec, wd)
        if not with_macro:
            # same program minus the macro body: the cycle baseline
            keep = [l for l in asm.splitlines()
                    if l.strip().lower().startswith(("ldi ", ".text", ".global", "main:",
                                                     "halt", ".end", ";"))]
            asm = "\n".join(keep) + "\n"
        lut_asm = ('\n\t.sect ".data"\nlut\t%s %s\n'
                   % (directive, ", ".join(str(v) for v in values)))
        asm = asm.replace("    .end", lut_asm + "    .end")
        elf = elf_cosim.compile_asm(asm, wd, "lut")
        res = elf_cosim.run_elf_closed_loop(elf, _Idle(), max_steps=200)
    assert res.halted, "PRU did not halt"
    return res


def _read(data_type, index):
    _d, size, _v = TABLES[data_type]
    res = _build_and_run(data_type, index)
    return res.registers[10] & ((1 << (8 * size)) - 1)


@pytest.mark.parametrize("data_type,index", [
    ("ushort", 0), ("ushort", 1), ("ushort", N - 1), ("uint", 0), ("uint", 1), ("uint", N - 1),
    ("byte", 0), ("byte", 1), ("byte", N - 1),
])
def test_access_lut_reads_entry_at_index(data_type, index):
    _d, _size, values = TABLES[data_type]
    got = _read(data_type, index)
    assert got == values[index], (
        "%s table index %d: expected %#x got %#x" % (data_type, index, values[index], got))


def test_cycle_model_matches_simulator_cycles():
    model = json.loads(subprocess.run(
        ["node", CYCLES_JS], capture_output=True, text=True, timeout=60,
        check=True).stdout)
    for data_type in ("byte", "ushort", "uint"):
        spent = (_build_and_run(data_type, 1).cycles
                 - _build_and_run(data_type, 1, with_macro=False).cycles)
        assert model[data_type] == spent, (data_type, model, spent)
