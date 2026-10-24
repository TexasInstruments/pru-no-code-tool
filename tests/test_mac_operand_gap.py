"""MAC operand write-to-access gap check.

On LP-AM261 the MAC broadside interface was observed not to see an operand written in the instruction
immediately before XIN 0 or XOUT 0. This is a bench observation; no TRM statement or measurement log for it
is part of this repository, so the rule below is a conservative constraint, not a documented one.
The last write to R28 (TEMP_REG1) or R29 (TEMP_REG2) must be at least ONE
instruction before XIN 0 / XOUT 0 (e.g. an independent instruction or a NOP).

This test validates the generated assembly of every MAC-using block in its default
configuration and across every configuration axis that changes MAC emission.
"""

import json
import os
import re
import subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]

REGISTER_ALIASES = {"TEMP_REG1": 28, "TEMP_REG2": 29}
TARGET_OPERAND_WRITES = {
    "mov", "ldi", "ldi32", "add", "adc", "sub", "subc", "rsb", "rsc",
    "lsl", "lsr", "and", "or", "xor", "not", "set", "clr", "zero", "fill",
    "xchg", "sxin", "lmbd", "min", "max", "scan", "mvi", "mvib", "mviw", "mvid",
}
RANGE_WRITES = {"lbbo", "lbco", "xin", "sxin", "zero", "fill"}


def register_number(token: str) -> int | None:
    """Return the base register number of an assembly register token."""
    token = token.strip().lstrip("&").split(".", 1)[0].upper()
    if token in REGISTER_ALIASES:
        return REGISTER_ALIASES[token]
    match = re.fullmatch(r"R(\d+)", token)
    return int(match.group(1)) if match else None


def byte_count(token: str) -> int | None:
    """Parse an immediate transfer size; unknown symbolic sizes are conservative writes."""
    try:
        return int(token.strip(), 0)
    except ValueError:
        return None

def instruction_writes_r28_r29(instr: str) -> bool:
    """Return True if the instruction writes to R28 (TEMP_REG1) or R29 (TEMP_REG2)."""
    line = instr.split(";", 1)[0].strip()
    if not line:
        return False
    parts = line.split(None, 1)
    if not parts:
        return False
    mnemonic = parts[0].lower()
    if len(parts) < 2:
        return False
    operands = [op.strip() for op in parts[1].split(",")]
    if not operands or mnemonic not in TARGET_OPERAND_WRITES | RANGE_WRITES:
        return False
    # XIN/SXIN's register window is operand 2; all other destination forms use
    # operand 1.  A byte window is modeled rather than matching only its first
    # register: `lbbo &R27,...,8` writes R27 and R28.
    dst_index = 1 if mnemonic in {"xin", "sxin"} else 0
    if len(operands) <= dst_index:
        return False
    dst = register_number(operands[dst_index])
    if dst is None:
        return False
    if mnemonic in RANGE_WRITES:
        size_index = 1 if mnemonic in {"zero", "fill"} else 3
        size = byte_count(operands[size_index]) if len(operands) > size_index else None
        # An unknown count may cover the MAC operands, so do not let it hide a
        # hazard.  All generated MAC blocks use literal counts.
        if size is None:
            return dst <= 29
        return dst * 4 < 120 and (dst * 4 + size) > 112
    if mnemonic == "xchg":
        return any(register_number(op) in (28, 29) for op in operands[:2])
    return dst in (28, 29)


def is_mac_access(instr: str) -> bool:
    """Return True if the instruction is a MAC broadside access (XIN 0 or XOUT 0)."""
    line = instr.split(";", 1)[0].strip()
    if not line:
        return False
    parts = line.split(None, 1)
    if not parts or parts[0].lower() not in ("xin", "xout") or len(parts) < 2:
        return False
    device = parts[1].split(",")[0].strip()
    try:
        return int(device.strip("()"), 0) == 0
    except ValueError:
        return False


def filter_executable_instructions(lines: list[str]) -> list[tuple[int, str]]:
    """Filter assembly lines down to executable instructions, returning (original_line_num, instr)."""
    exec_instrs = []
    for line_num, line in enumerate(lines, 1):
        clean = line.split(";", 1)[0].strip()
        if not clean:
            continue
        if ":" in clean:
            after_colon = clean.split(":", 1)[1].strip()
            if not after_colon:
                continue
            clean = after_colon
        parts = clean.split(None, 1)
        if not parts:
            continue
        mnemonic = parts[0].lower()
        if mnemonic.startswith("."):
            continue
        if len(parts) > 1 and parts[1].startswith(".set"):
            continue
        exec_instrs.append((line_num, clean))
    return exec_instrs


def find_mac_gap_violations(lines: list[str]) -> list[str]:
    """Check instructions for MAC operand gap rule violations.

    The last write to R28 or R29 must be at least ONE instruction before XIN/XOUT 0.
    Therefore, the instruction immediately preceding any XIN/XOUT 0 cannot be a write to R28 or R29.
    """
    exec_instrs = filter_executable_instructions(lines)
    violations = []

    for idx, (line_num, instr) in enumerate(exec_instrs):
        if is_mac_access(instr):
            if idx > 0:
                prev_line_num, prev_instr = exec_instrs[idx - 1]
                if instruction_writes_r28_r29(prev_instr):
                    violations.append(
                        f"Line {line_num}: MAC access '{instr}' is immediately preceded by "
                        f"operand write '{prev_instr}' (line {prev_line_num}) "
                        f"(requires at least 1 instruction gap)"
                    )
    return violations

def expand_block_asm(block_id: str, literal_overrides: dict = None) -> list[str]:
    """Expand block using emit_all_blocks.js and return list of instruction strings."""
    overrides_json = json.dumps(literal_overrides or {})
    cmd = [
        "node", "-e",
        f"""
        const {{ expandBlock, LITERAL }} = require('./scripts/emit_all_blocks');
        const overrides = {overrides_json};
        const res = expandBlock('{block_id}', {{ ...LITERAL, ...overrides }});
        console.log(JSON.stringify(res.instructions));
        """
    ]
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def mac_device_zero_blocks() -> set[str]:
    """Discover every template whose default macro emits a device-zero transfer."""
    command = """
const e=require('./scripts/emit_all_blocks');
const found=[];
for (const b of e.allBlocks()) {
  try {
    const m=e.loadBlock(b.file);
    if (typeof m.getMacro !== 'function') continue;
    const d=e.defaultMacro(m,b.id);
    if (/\\b(?:xin|xout)\\s*\\(?0+\\)?\\s*,/i.test(d.macro)) found.push(b.id);
  } catch (_) { /* non-emitting/default-unloadable blocks are not MAC templates */ }
}
console.log(JSON.stringify(found));
"""
    proc = subprocess.run(["node", "-e", command], cwd=str(ROOT), capture_output=True, text=True, check=True)
    return set(json.loads(proc.stdout))


def test_mac_gap_every_device_zero_template_and_park_axes():
    """Sweep templates instead of maintaining a hand-picked MAC block list."""
    blocks = mac_device_zero_blocks()
    known_mac_blocks = {"iqmath_pid_block", "iqmath_park_clarke_block", "mac_hw_block", "svpwm_block"}
    assert known_mac_blocks <= blocks, f"MAC sweep became vacuous or missed known blocks: {blocks}"

    variants = [(block_id, None) for block_id in sorted(blocks)]
    # transformType is the only configuration axis that changes a device-zero
    # MAC sequence; check both emitted branches in addition to its default.
    if "iqmath_park_clarke_block" in blocks:
        variants.append(("iqmath_park_clarke_block", {"IS_FORWARD": 0}))

    violations = {}
    for block_id, overrides in variants:
        found = find_mac_gap_violations(expand_block_asm(block_id, overrides))
        if found:
            suffix = " inverse" if overrides else ""
            violations[block_id + suffix] = found
    assert not violations, f"MAC operand gap violations: {violations}"
