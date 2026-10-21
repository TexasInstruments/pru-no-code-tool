"""SysConfig validation ERROR for clpru reserved instance names.

Problem: SysConfig accepted an instance name the assembler rejects — a
crc_block named ``c0`` emits ``c0 .byte ...`` and clpru fails with
[E0300] c0 is a reserved identifier. Fix: every block that emits its
instance name (or a name derived from it) as an asm label or symbol rejects
reserved names in validate(), through ONE shared helper
(.metadata/sysconfig/.meta/pru_blocks/common/pru_reserved_names.js).

Oracle = the assembler. Case rules are the assembler's own (each probed
with clpru as a data symbol AND as a code label): register names r*/c* are
case-insensitive (R0 fails); mnemonics fail exact-lowercase (add) and
exact-ALL-UPPERCASE (ADD) but mixed-case (Add, Ldi32) ASSEMBLES and is
accepted; byte lanes fail lowercase only (b0 fails, B0 assembles and is
accepted). The brief's oracle says names that assemble are not reserved.

Derived emissions (conditional `<name>_TRUE/_FALSE`, group
`<groupName>_start`, pid `<name>_pid_state`) assemble even for a reserved
base, so only the DERIVED symbol is checked — a reserved base is accepted
there. Bare emissions (crc, look_up_table, modbus lutName,
memory_variable labelName, ipc variableName) reject every reserved name.

Test 1 (oracle = the assembler): for every reserved name in the committed
list, emit a minimal crc_block design with the committed oracle script
(scripts/crc_oracle.js — drives the REAL crc_block getDataSize /
getLookUptable) and assemble it with the real clpru. Every one must fail
with E0300; any name that assembles is NOT reserved and stays out of the
list (red results kept red, asserted assembling below).

Test 2: validation rejects each reserved name with a clear message on every
bare-emission block, accepts reserved bases on derived-emission blocks
(whose generated symbols assemble), accepts mixed-case/uppercase-lane
names that assemble, and still accepts ordinary names including
near-misses (r32, c32, rx, cc0, my_r0).

Completeness guard: SWEEP_EXTRA holds suspected-but-assembling identifiers.
The sweep asserts each one still assembles and stays out of RESERVED; a
future suspect that FAILS to assemble reddens the sweep until it is moved
into the mnemonic list (with count/docs updated).

All Node/clpru invocations go through committed scripts by path — no inline
heredocs. clpru-dependent tests skip cleanly when the toolchain is absent.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "block_validate_runner.js"
ORACLE = ROOT / "scripts" / "crc_oracle.js"
NODE = "node"

# ---------------------------------------------------------------- committed list
# Canonical lowercase; matching follows clpru's own case rules (see helper
# header): registers any case, mnemonics exact-lower/ALL-UPPER only, byte
# lanes exact-lower only.
# 32 R + 32 C + 4 byte lanes + 52 mnemonics = 120.
_MNEMONICS = (
    "add adc sub suc rsb rsc and or xor not min max clr set "
    "lsl lsr lmbd mov ldi ldi32 lbbo sbbo lbco sbco zero fill "
    "mvib mviw mvid jmp jal qbgt qbge qblt qble qbeq qbne qba qbbc qbbs "
    "loop halt slp wbc wbs xin xout xchg sxin sxout sxchg nop"
).split()
RESERVED = (
    ["r%d" % i for i in range(32)]
    + ["c%d" % i for i in range(32)]
    + ["b0", "b1", "b2", "b3"]
    + _MNEMONICS
)
UPPER_MNEMONICS = [m.upper() for m in _MNEMONICS]

# Assemble, so NOT reserved — but rejected by the old case-insensitive
# matcher. Locked here as accepted-by-validation (oracle-correct).
MIXED_CASE_ACCEPTED = (
    "Add Max Min Set Zero Fill Loop Not Or Mov Halt Ldi32 Qba "
    "B0 B1 B2 B3"
).split()

# Probed but NOT reserved (they assemble): locked in below so the list
# cannot silently re-absorb them.
EXCLUDED_ASSEMBLES = (
    "scan broad idle mull mul b4 b5 b6 b7 w0 w1 w2 w3 "
    "byte ushort uint usect bss data text sect global ref retain "
    "macro endm asg if else elseif endif main call ret sp pc "
    "r32 c32 rx cc0 my_r0 ordinary buffer encoder_data temp_reg1"
).split()

# Completeness-guard pool: suspected-but-assembling identifiers. Each must
# keep assembling and stay OUT of RESERVED; triage rule: if one ever fails
# with E0300, move it into _MNEMONICS (and update count + docs).
SWEEP_EXTRA = (
    "div mod push pop trap sleep wait ld st ldm stm bset bclr movib wbc0 "
    "struct endstruct float double long short char int string align field "
    "retainrefs def end transpose eval endloop break copy emsg message entry "
    "exit fp lr creg ctpreg sysconfig_generated_start"
).split()

# Derived symbols actually emitted for reserved bases — all assemble.
DERIVED_ASSEMBLES = (
    "c0_TRUE c0_FALSE add_TRUE mvib_TRUE "
    "c0_start C0_start ADD_pid_state c0_pid_state"
).split()

NEAR_MISS = ["r32", "c32", "rx", "cc0", "my_r0", "ordinary"]


def _find_clpru():
    cands = []
    env = os.environ.get("CGT_TI_PRU_PATH")
    if env:
        cands += [Path(env) / "bin" / "clpru", Path(env) / "bin" / "clpru.exe"]
    cands += [
        Path(str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe")),
        Path("/opt/ti/ti-cgt-pru_2.3.3/bin/clpru"),
        Path.home() / "ti" / "ti-cgt-pru-linux" / "bin" / "clpru",
    ]
    for cand in cands:
        if cand.exists():
            return str(cand)
    return None


CLPRU = _find_clpru()
needs_clpru = pytest.mark.skipif(CLPRU is None, reason="needs clpru assembler")


def _oracle_asm(name):
    """Full minimal crc_block asm for instance <name> via committed script."""
    proc = subprocess.run(
        [NODE, str(ORACLE), name],
        capture_output=True, text=True, cwd=str(ROOT), timeout=30,
    )
    assert proc.returncode == 0, "oracle failed for %r: %s" % (name, proc.stderr)
    return proc.stdout


def _oracle_label(name):
    """Code-label emission for <name> via committed script (--label mode)."""
    proc = subprocess.run(
        [NODE, str(ORACLE), "--label", name],
        capture_output=True, text=True, cwd=str(ROOT), timeout=30,
    )
    assert proc.returncode == 0, "label oracle failed for %r: %s" % (name, proc.stderr)
    return proc.stdout


def _assemble(asm_text, workdir):
    workdir.mkdir(parents=True, exist_ok=True)
    src = workdir / "t.asm"
    src.write_text(asm_text, encoding="utf-8")
    for obj in ("t.obj",):
        try:
            (workdir / obj).unlink()
        except OSError:
            pass
    proc = subprocess.run(
        [CLPRU, "--silicon_version=4", "-c", "t.asm"],
        capture_output=True, text=True, cwd=str(workdir), timeout=60,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _run_validate(block, inst):
    proc = subprocess.run(
        [NODE, str(RUNNER), block, json.dumps(inst)],
        capture_output=True, text=True, cwd=str(ROOT), timeout=30,
    )
    assert proc.returncode == 0, "runner failed for %s: %s%s" % (block, proc.stdout, proc.stderr)
    return json.loads(proc.stdout.strip())


# ------------------------------------------------- list integrity (no clpru needed)

def test_helper_list_matches_committed_list():
    """The helper file is the single source of truth; the test list must equal it."""
    proc = subprocess.run(
        [NODE, str(ORACLE), "--list-reserved"],
        capture_output=True, text=True, cwd=str(ROOT), timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip()) == RESERVED


def test_reserved_count_is_120():
    assert len(RESERVED) == 120, len(RESERVED)
    assert len(_MNEMONICS) == 52, len(_MNEMONICS)


def test_covered_block_sources_call_shared_helper():
    """Source-presence guard: bare emitters call the bare check, derived
    emitters call the derived check; deleting either call re-reddens Test 2."""
    bare = {
        "crc_block": ("application_specific/crc_block.syscfg.js", "validateInstanceName"),
        "look_up_table": ("utils/look_up_table.syscfg.js", "validateInstanceName"),
        "modbus_rtu_framer": ("application_specific/modbus_rtu_framer.syscfg.js", "validateInstanceName"),
        "memory_variable_block": ("utils/memory_variable_block.syscfg.js", "validateSymbolField"),
        "ipc_shared_mem_block": ("application_specific/ipc_shared_mem_block.syscfg.js", "validateSymbolField"),
    }
    derived = {
        "conditional_block": ("program_control/conditional_block.syscfg.js", "validateDerivedSymbol"),
        "group_block": ("program_control/group_block.syscfg.js", "validateDerivedSymbol"),
        "iqmath_pid_block": ("data_handling/iqmath_pid_block.syscfg.js", "validateDerivedSymbol"),
    }
    base = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks"
    for block, (rel, func) in dict(bare, **derived).items():
        src = (base / rel).read_text(encoding="utf-8")
        assert "pru_reserved_names.js" in src, block
        assert func in src, "%s must call %s" % (block, func)


def test_sweep_pool_disjoint():
    """Guard hygiene: triaged names live in exactly one pool."""
    assert not set(SWEEP_EXTRA) & set(RESERVED), set(SWEEP_EXTRA) & set(RESERVED)
    assert not set(SWEEP_EXTRA) & set(EXCLUDED_ASSEMBLES)
    assert not set(MIXED_CASE_ACCEPTED) & set(RESERVED)
    assert len(SWEEP_EXTRA) == len(set(SWEEP_EXTRA)), "duplicate sweep entry"


# ------------------------------------------------- Test 1: oracle = the assembler

@needs_clpru
@pytest.mark.parametrize("name", RESERVED)
def test_oracle_each_reserved_name_fails_to_assemble(name, tmp_path):
    """Every listed name must actually fail; a name that assembles is removed."""
    rc, out = _assemble(_oracle_asm(name), tmp_path / "w")
    assert rc != 0, "assembled but listed reserved: %r" % name
    assert "E0300" in out, "no E0300 for %r: %s" % (name, out[:200])
    assert name in out, "error does not name %r: %s" % (name, out[:200])


@needs_clpru
@pytest.mark.parametrize("name", ["R0", "R5", "R31", "C0", "C5", "C31"])
def test_oracle_register_names_case_insensitive(name, tmp_path):
    """clpru is case-insensitive for register names: uppercase fails too."""
    rc, out = _assemble(_oracle_asm(name), tmp_path / "w")
    assert rc != 0 and "E0300" in out, "%r assembled: %s" % (name, out[:200])


@needs_clpru
@pytest.mark.parametrize("name", UPPER_MNEMONICS)
def test_oracle_uppercase_mnemonics_fail(name, tmp_path):
    """Mnemonics are reserved ALL-UPPERCASE too (all 52 probed)."""
    rc, out = _assemble(_oracle_asm(name), tmp_path / "w")
    assert rc != 0, "assembled but reserved uppercase: %r" % name
    assert "E0300" in out, "no E0300 for %r: %s" % (name, out[:200])
    assert name in out, "error does not name %r: %s" % (name, out[:200])


@needs_clpru
@pytest.mark.parametrize("name", MIXED_CASE_ACCEPTED)
def test_oracle_mixed_case_assembles(name, tmp_path):
    """Mixed-case mnemonic-like names and uppercase lanes ASSEMBLE in both
    emission forms, so validation must accept them (oracle-correct)."""
    for emit in (_oracle_asm, _oracle_label):
        rc, out = _assemble(emit(name), tmp_path / "w")
        assert rc == 0, "%r fails but assembles-per-oracle: %s" % (name, out[:200])


@needs_clpru
@pytest.mark.parametrize("name", EXCLUDED_ASSEMBLES)
def test_oracle_excluded_names_assemble(name, tmp_path):
    """Names that assemble are NOT reserved and stay out of the list."""
    rc, out = _assemble(_oracle_asm(name), tmp_path / "w")
    assert rc == 0, "%r fails but is excluded: %s" % (name, out[:300])


@needs_clpru
@pytest.mark.parametrize("name", SWEEP_EXTRA)
def test_sweep_extra_candidates_assemble_and_unlisted(name, tmp_path):
    """Completeness guard: each suspect still assembles and stays out of
    RESERVED. If one ever fails with E0300, move it into _MNEMONICS (and
    update the count test + docs) instead of weakening this assertion."""
    rc, out = _assemble(_oracle_asm(name), tmp_path / "w")
    assert rc == 0, "suspect %r now fails: triage into RESERVED: %s" % (name, out[:300])
    assert name not in RESERVED, "suspect %r assembled yet listed" % name


@needs_clpru
@pytest.mark.parametrize("name", DERIVED_ASSEMBLES)
def test_oracle_derived_symbols_assemble(name, tmp_path):
    """Suffix-derived symbols assemble in both emission forms even for a
    reserved base — the generated symbol is not the raw reserved name."""
    for emit in (_oracle_asm, _oracle_label):
        rc, out = _assemble(emit(name), tmp_path / "w")
        assert rc == 0, "derived %r fails: %s" % (name, out[:300])


# ------------------------------------------------- Test 2: validation

# Blocks emitting the BARE name as a label/symbol: reject every reserved name.
BARE_BLOCKS = [
    "crc_block",
    "look_up_table",
    "modbus_rtu_framer",
    "memory_variable_block",
    "ipc_shared_mem_block",
]

# Blocks emitting only DERIVED symbols: a reserved base is accepted because
# the generated symbol assembles (locked by test_oracle_derived_symbols_assemble).
DERIVED_BLOCKS = [
    "conditional_block",
    "group_block",
    "iqmath_pid_block",
]

COVERED_BLOCKS = BARE_BLOCKS + DERIVED_BLOCKS


def _base_inst(block, name):
    if block == "crc_block":
        return {"$name": name, "input1": [], "input2": [],
                "crc_intialization": "zeros", "crcType": "m_calculate_crc8",
                "crcPolynomial": 7}
    if block == "look_up_table":
        return {"$name": name, "tableSize": 16, "tableData": "1, 2, 3",
                "dataType": "byte"}
    if block == "modbus_rtu_framer":
        return {"$name": name, "baudRate": 9600, "slaveAddress": 1,
                "bufferSymbol": "modbus_rx_frame_buf", "pruClockMhz": 200,
                "oversampleSize": 7, "clockSource": 1}
    if block == "conditional_block":
        return {"$name": name, "numOfInputPorts": 2, "input1": [], "input2": [],
                "T": ["t"], "F": ["f"]}  # Unconnected T/F is a validate error
    if block == "group_block":
        return {"$name": "G0", "groupName": name}
    if block == "iqmath_pid_block":
        return {"$name": name}
    if block == "memory_variable_block":
        return {"$name": "M0", "labelName": name, "sizeInBytes": 64,
                "alignment": 4}
    if block == "ipc_shared_mem_block":
        return {"$name": "I0", "variableName": name}
    raise AssertionError(block)


def _reserved_errors(data):
    return [e for e in data["errors"] if "reserved" in e["message"].lower()]


@pytest.mark.parametrize("block", BARE_BLOCKS)
@pytest.mark.parametrize("name", RESERVED)
def test_validation_rejects_each_reserved_name(block, name):
    """Test 2 (red at base): every reserved name is a validation ERROR on
    bare emitters."""
    data = _run_validate(block, _base_inst(block, name))
    errs = _reserved_errors(data)
    assert errs, "%s accepted reserved name %r: %s" % (block, name, data)
    assert any(name in e["message"] for e in errs), \
        "%s error does not name %r: %s" % (block, name, errs)


@pytest.mark.parametrize("block", BARE_BLOCKS)
@pytest.mark.parametrize("name", UPPER_MNEMONICS)
def test_validation_rejects_uppercase_mnemonics(block, name):
    """ALL-UPPERCASE mnemonics fail in clpru, so bare emitters reject them."""
    data = _run_validate(block, _base_inst(block, name))
    assert _reserved_errors(data), "%s accepted %r: %s" % (block, name, data)


@pytest.mark.parametrize("block", DERIVED_BLOCKS)
@pytest.mark.parametrize("name", RESERVED)
def test_validation_accepts_reserved_base_for_derived_emitters(block, name):
    """Derived emitters check the generated symbol, not the raw base: every
    reserved base is accepted because its derived symbols assemble."""
    data = _run_validate(block, _base_inst(block, name))
    assert _reserved_errors(data) == [], "%s over-rejects %r: %s" % (block, name, data)


@pytest.mark.parametrize("block", BARE_BLOCKS)
@pytest.mark.parametrize("name", MIXED_CASE_ACCEPTED)
def test_validation_accepts_mixed_case_that_assembles(block, name):
    """Names that assemble are not reserved: accepted on bare emitters."""
    data = _run_validate(block, _base_inst(block, name))
    assert _reserved_errors(data) == [], "%s rejects assembling %r: %s" % (block, name, data)


@pytest.mark.parametrize("block", COVERED_BLOCKS)
@pytest.mark.parametrize("name", NEAR_MISS + ["My_CRC", "buffer", "encoder_data"])
def test_validation_accepts_ordinary_and_near_miss_names(block, name):
    """Near-misses (r32, c32, rx, cc0, my_r0) and ordinary names stay legal."""
    data = _run_validate(block, _base_inst(block, name))
    assert _reserved_errors(data) == [], "%s rejects %r: %s" % (block, name, data)
    assert data["errors"] == [], "%s errors on %r: %s" % (block, name, data)
