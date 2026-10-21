"""
SUM32 one's-complement checksum accelerator (ICSSG).

TRM SPRUIM2J 6.4.6.2.6, quoted verbatim:
    "The SUM32 module is a simple hardware accelerator which is used to help generate UDP checksum
    (User Datagram Protocol) for data integrity. The operation takes 2 clock cycles, read pipe is
    another 1 clock cycle. The operation is pipelined. The PRUn or RTU_PRUn core (where n = 0 or 1)
    will not see any hardware backpressure for back to back XOUT 32 Byte operations. The PRU or
    RTU_PRU core can see up to 2 cycle stall if there is no time between the last XOUT and the XIN
    to get the SUM value. The FW must insure you have 3 NOPs or 3 clock cycle delay between the
    last XOUT to the XIN to get the correct SUM value. The XIN operation self clears the SUM."

Table 6-93 (SUM32 XFR ID): XOUT 49 (0x31, PRU) / 38 (0x26, RTU_PRU) for BS RAM + SUM32 snoop;
XOUT 47 (0x2F, PRU) / 39 (0x27, RTU_PRU) for SUM32 only; XIN 02 (0x2h) for both cores.
Table 6-94: R2-R9 write-only (always 32 bytes); R29 sum, read-only, self-clears on read.

redo (this file). The first pass's accumulate macro emitted
`xout 47|49, &R2, 32` without declaring or loading R2-R9, so the allocator treated that window
as free general-purpose pool and any other block's value could land there and get checksummed
instead of the user's data — the block was unusable from the graph. Fixed both halves:
 (a) DATA PATH: accumulate gets an `input1` port carrying a 32-bit DMEM byte address; the macro
     LBBOs the 32-byte block from that address into R2-R9 before the XOUT.
 (b) REGISTER WINDOW: pru_register_allocator reserves bytes 8..39 (R2-R9) whenever any accumulate
     instance exists (XFR2PSI precedent); validateSum32Global in pru_blocks_static_module
     is the safety net that rejects any OTHER block's final allocation still inside that window.
     scripts/sim/test_sum32_regalloc.js exercises both the real allocator and the real
     validateSum32Global directly, including the mutation (reservation deleted) red arm.

Acceptance:
 - block exposes accumulate / read_and_clear operations, and a separate bsRamSnoop option
   (device 49/38 instead of 47/39) because it also writes BS RAM (TRM 6.4.6.2.5)
 - accumulate has an input1 port (DMEM source address); validate() warns when unconnected
 - requiresWidget ['sum32'] gated to ICSSG only (AM261x/AM263Px error, AM64x/AM243x pass)
 - block is registered in topModules_pru (PRU0/PRU1) on am64x/am243x ONLY — never in
   topModules_rtu_tx_pru (shared by RTU_PRU/TX_PRU), because the TRM does not document a
   TX_PRU device ID for SUM32
 - validate() rejects a non-PRU core as defense in depth, and rejects bsRamSnoop combined
   with read_and_clear (the option only applies to accumulate)
 - getMacro's accumulate macros LBBO the DMEM block into R2-R9 BEFORE the XOUT
 - getMacro's read_and_clear macro always emits the mandatory 3-NOP hazard before the XIN
 - every red arm is coupled: deleting the fault site flips the verdict
"""
import json
import os
import pathlib
import subprocess
import tempfile
import textwrap

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "sum32_validate_runner.js"
GATE_RUNNER = REPO_ROOT / "scripts" / "static_module_validate_runner.js"
BLOCK_PATH = REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "data_handling" / "sum32_block.syscfg.js"
CAPS_PATH = REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "common" / "pru_device_caps.js"


def _run_block_validate(overrides, coreName="icss_g0_pru0"):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(overrides, f)
        f.flush()
        path = f.name
    try:
        proc = subprocess.run(
            ["node", str(RUNNER), path, coreName],
            capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
        )
        assert proc.returncode == 0, f"runner failed: {proc.stdout}\n{proc.stderr}"
        result = json.loads(proc.stdout.strip() or "{}")
        return result.get("errors", []), result.get("warnings", []), proc.stdout.strip()
    finally:
        os.unlink(path)


def _run(device, soc, widget="sum32"):
    proc = subprocess.run(
        ["node", str(GATE_RUNNER), device, soc, widget],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"runner failed: {proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.strip() or "[]"), proc.stdout.strip()


def _get_macro(name):
    proc = subprocess.run(["node", "-e", textwrap.dedent(f"""
        const fs=require('fs'), vm=require('vm');
        const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/data_handling/sum32_block.syscfg.js','utf8');
        const sandbox={{exports:{{}}, module:{{exports:{{}}}}, console:{{log(){{}},error(){{}},warn(){{}}}}}};
        sandbox.global=sandbox; vm.createContext(sandbox); vm.runInContext(src,sandbox,{{filename:'sum32',timeout:2000}});
        console.log(sandbox.exports.getMacro('', {name!r}));
    """)], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


# ---------------------------------------------------------------------------
# Block contract
# ---------------------------------------------------------------------------
def test_block_contract_parameters():
    src = BLOCK_PATH.read_text(encoding="utf-8")
    assert "requiresWidget" in src and "sum32" in src
    for field in ["operation", "bsRamSnoop", "accumulate", "read_and_clear", "input1", "SRC_ADDR"]:
        assert field in src, f"missing param/value {field}"
    assert "getMacro" in src and "validate" in src
    assert "ports" in src and "moduleStatic" in src and "templates" in src


def test_soc_catalogs_pru_only_not_rtu_tx():
    for soc_file, expect_present in [
        ("pru_blocks_am64x.syscfg.js", True),
        ("pru_blocks_am243x.syscfg.js", True),
        ("pru_blocks_am261x.syscfg.js", False),
    ]:
        txt = (REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "soc" / soc_file).read_text(encoding="utf-8")
        present = "sum32_block" in txt
        assert present == expect_present, f"{soc_file}: expected sum32_block present={expect_present}, found {present}"

    # ICSSG catalogs: sum32_block must appear exactly once (topModules_pru), and
    # must NOT be inside the topModules_rtu_tx_pru list (shared with TX_PRU,
    # which the TRM does not document a SUM32 device ID for).
    for soc_file in ["pru_blocks_am64x.syscfg.js", "pru_blocks_am243x.syscfg.js"]:
        txt = (REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "soc" / soc_file).read_text(encoding="utf-8")
        assert txt.count("sum32_block") == 1, f"{soc_file}: sum32_block must be registered exactly once"
        rtu_tx_start = txt.index("topModules_rtu_tx_pru")
        assert "sum32_block" not in txt[rtu_tx_start:], (
            f"{soc_file}: sum32_block must not be offered on the RTU_PRU/TX_PRU list — "
            "TX_PRU has no documented SUM32 device ID"
        )


def test_device_caps_sum32_icssg_only():
    src = CAPS_PATH.read_text(encoding="utf-8")
    assert "sum32" in src.lower()
    proc = subprocess.run(["node", "-e", textwrap.dedent("""
        const caps = require('./.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js');
        console.log(JSON.stringify({
            am64x: caps.isWidgetAvailable('sum32','am64x'),
            am243x: caps.isWidgetAvailable('sum32','am243x'),
            am261x: caps.isWidgetAvailable('sum32','am261x'),
            am263px: caps.isWidgetAvailable('sum32','am263px'),
        }));
    """)], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout.strip())
    assert data["am64x"] is True and data["am243x"] is True, f"ICSSG should have sum32: {data}"
    assert data["am261x"] is False and data["am263px"] is False, f"ICSSM should NOT have sum32: {data}"


# ---------------------------------------------------------------------------
# Red arm 1: device capability gating (widget requiresWidget check #2)
# ---------------------------------------------------------------------------
def test_red_arm_am261x_device_gating_is_error():
    errors, _ = _run("AM261x_ZCZ", "am261x", "sum32")
    assert len(errors) >= 1, f"expected error for sum32 on AM261x, got {errors}"
    msg = errors[0]
    assert "sum32" in msg.lower()
    assert "requires widget" in msg.lower()


def test_red_arm_am261x_mutation_flips():
    errors_bad, out_bad = _run("AM261x_ZCZ", "am261x", "sum32")
    errors_good, out_good = _run("AM64x", "am64x", "sum32")
    assert len(errors_bad) == 1 and errors_good == [], f"mutation did not flip: bad={errors_bad} good={errors_good}"
    print(f"[mutation] AM261x gate: `node {GATE_RUNNER} AM261x_ZCZ am261x sum32` -> {out_bad}")
    print(f"[mutation] AM261x gate deletion (AM64x): `node {GATE_RUNNER} AM64x am64x sum32` -> {out_good}")


# ---------------------------------------------------------------------------
# Red arm 2: bsRamSnoop only applies to accumulate
# ---------------------------------------------------------------------------
def test_red_arm_bsramsnoop_with_read_and_clear_is_error():
    errors, _, _ = _run_block_validate({"operation": "read_and_clear", "bsRamSnoop": True})
    assert any("bsRamSnoop" in e or "BS RAM" in e for e in errors), f"expected bsRamSnoop misuse error, got {errors}"
    errors_ok, _, _ = _run_block_validate({"operation": "read_and_clear", "bsRamSnoop": False})
    assert errors_ok == [], f"read_and_clear without snoop should pass, got {errors_ok}"


def test_red_arm_bsramsnoop_mutation_flips():
    errors_bad, _, out_bad = _run_block_validate({"operation": "read_and_clear", "bsRamSnoop": True})
    errors_good, _, out_good = _run_block_validate({"operation": "read_and_clear", "bsRamSnoop": False})
    assert len(errors_bad) >= 1 and errors_good == [], "bsRamSnoop mutation flip failed"
    print(f"[mutation] bsRamSnoop misuse: read_and_clear+bsRamSnoop=true -> {out_bad}")
    print(f"[mutation] bsRamSnoop deletion (bsRamSnoop=false) -> {out_good}")


def test_bsramsnoop_with_accumulate_is_fine():
    errors, _, _ = _run_block_validate({"operation": "accumulate", "bsRamSnoop": True})
    assert errors == [], f"accumulate+snoop should pass, got {errors}"


# ---------------------------------------------------------------------------
# Red arm 3: non-PRU core rejected (defense in depth for the topModules split)
# ---------------------------------------------------------------------------
def test_red_arm_rtu_core_rejected():
    errors, _, _ = _run_block_validate({"operation": "accumulate"}, coreName="icss_g0_rtu_pru0")
    assert any("core" in e.lower() for e in errors), f"RTU_PRU core should error, got {errors}"


def test_red_arm_tx_core_rejected():
    errors, _, _ = _run_block_validate({"operation": "accumulate"}, coreName="icss_g0_tx_pru0")
    assert any("core" in e.lower() for e in errors), f"TX_PRU core should error, got {errors}"


def test_red_arm_core_mutation_flips():
    errors_bad, _, out_bad = _run_block_validate({"operation": "accumulate"}, coreName="icss_g0_rtu_pru0")
    errors_good, _, out_good = _run_block_validate({"operation": "accumulate"}, coreName="icss_g0_pru0")
    assert len(errors_bad) >= 1 and errors_good == [], "core mutation flip failed"
    print(f"[mutation] core: icss_g0_rtu_pru0 -> {out_bad}")
    print(f"[mutation] core deletion (icss_g0_pru0) -> {out_good}")


# ---------------------------------------------------------------------------
# Red arm 4: accumulate input1 (DMEM source address) unconnected is a warning
# ---------------------------------------------------------------------------
def test_red_arm_accumulate_input1_unconnected_warns():
    errors, warnings, _ = _run_block_validate({"operation": "accumulate", "input1": []})
    assert errors == [], f"unconnected input1 must be a warning, not an error, got errors={errors}"
    assert any("input1" in w for w in warnings), f"expected input1 warning, got {warnings}"


def test_red_arm_accumulate_input1_mutation_flips():
    _, warnings_bad, out_bad = _run_block_validate({"operation": "accumulate", "input1": []})
    _, warnings_good, out_good = _run_block_validate({"operation": "accumulate", "input1": [{}]})
    assert any("input1" in w for w in warnings_bad), f"expected input1 warning, got {warnings_bad}"
    assert not any("input1" in w for w in warnings_good), f"connected input1 must not warn, got {warnings_good}"
    print(f"[mutation] input1 unconnected: input1=[] -> {out_bad}")
    print(f"[mutation] input1 deletion (connected, input1=[{{}}]) -> {out_good}")


def test_read_and_clear_never_warns_about_input1():
    # read_and_clear has no input1 port at all; the warning must not fire.
    errors, warnings, _ = _run_block_validate({"operation": "read_and_clear"})
    assert errors == [] and not any("input1" in w for w in warnings), (
        f"read_and_clear must not warn about input1, got errors={errors} warnings={warnings}"
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
def test_happy_path_pru_core():
    for cfg in [
        {"operation": "accumulate", "bsRamSnoop": False, "input1": [{}]},
        {"operation": "accumulate", "bsRamSnoop": True, "input1": [{}]},
        {"operation": "read_and_clear", "bsRamSnoop": False},
    ]:
        errors, warnings, _ = _run_block_validate(cfg, coreName="icss_g0_pru0")
        assert errors == [] and warnings == [], f"happy path should pass cleanly cfg={cfg} got errors={errors} warnings={warnings}"


# ---------------------------------------------------------------------------
# Macro content: correct device IDs, LBBO-before-XOUT, and the 3-NOP hazard
# ---------------------------------------------------------------------------
def _instruction_index(macro, mnemonic):
    """Index of the first LINE whose stripped text starts with mnemonic — comment
    lines legitimately name both LBBO and XOUT, so a bare substring search would
    match the wrong (comment) occurrence."""
    for i, line in enumerate(macro.splitlines()):
        if line.strip().lower().startswith(mnemonic):
            return i
    return -1


def test_accumulate_only_macro_lbbo_then_device_47():
    macro = _get_macro("m_sum32_accumulate_only")
    assert "lbbo" in macro.lower(), f"accumulate must LBBO the DMEM block into R2-R9: {macro}"
    assert "&R2, SRC_ADDR, 0, 32" in macro, f"must LBBO the 32-byte block from SRC_ADDR into R2-R9: {macro}"
    assert "xout" in macro.lower() and "47" in macro
    assert "&R2, 32" in macro, f"must write all 32 bytes from R2-R9: {macro}"
    lbbo_idx, xout_idx = _instruction_index(macro, "lbbo"), _instruction_index(macro, "xout")
    assert lbbo_idx >= 0 and xout_idx > lbbo_idx, f"LBBO must precede XOUT: {macro}"
    assert "SRC_ADDR" in macro.split("\n", 1)[0], f"macro must declare SRC_ADDR formal parameter: {macro}"


def test_accumulate_snoop_macro_lbbo_then_device_49():
    macro = _get_macro("m_sum32_accumulate_snoop")
    assert "lbbo" in macro.lower()
    assert "&R2, SRC_ADDR, 0, 32" in macro
    assert "xout" in macro.lower() and "49" in macro
    assert "&R2, 32" in macro
    lbbo_idx, xout_idx = _instruction_index(macro, "lbbo"), _instruction_index(macro, "xout")
    assert lbbo_idx >= 0 and xout_idx > lbbo_idx, f"LBBO must precede XOUT: {macro}"


def test_accumulate_lbbo_mutation_flips():
    """Regression guard for the first pass: dropping the LBBO must be discriminated."""
    macro = _get_macro("m_sum32_accumulate_only")
    mutated = macro.replace("    lbbo  &R2, SRC_ADDR, 0, 32\n", "")
    assert "&R2, SRC_ADDR, 0, 32" not in mutated
    assert "lbbo" not in mutated.lower(), "mutation must actually remove the LBBO line"


def test_read_clear_macro_device_2_and_hazard():
    macro = _get_macro("m_sum32_read_clear")
    assert "xin" in macro.lower()
    lines = [l.strip() for l in macro.splitlines() if l.strip()]
    xin_idx = next(i for i, l in enumerate(lines) if l.lower().startswith("xin"))
    assert "2, &TEMP_REG2, 4" in lines[xin_idx], f"XIN must target device 2 into R29 (TEMP_REG2): {lines[xin_idx]}"
    # the 3 immediately preceding non-comment lines must all be NOP — the hazard
    # is enforced by the generator, not left to documentation.
    preceding = [l for l in lines[:xin_idx] if not l.startswith(";")][-3:]
    assert preceding == ["nop", "nop", "nop"], f"expected 3 NOPs directly before XIN, got {preceding}"


def test_read_clear_hazard_mutation_flips():
    """Deleting one NOP must be discriminated by the count check above."""
    macro = _get_macro("m_sum32_read_clear")
    mutated = macro.replace("    nop\n    nop\n    nop\n", "    nop\n    nop\n", 1)
    lines = [l.strip() for l in mutated.splitlines() if l.strip()]
    xin_idx = next(i for i, l in enumerate(lines) if l.lower().startswith("xin"))
    preceding = [l for l in lines[:xin_idx] if not l.startswith(";")][-3:]
    assert preceding != ["nop", "nop", "nop"], "mutation (dropping a NOP) must be discriminated by the hazard check"


def test_unsupported_macro_name_throws():
    proc = subprocess.run(["node", "-e", textwrap.dedent("""
        const fs=require('fs'), vm=require('vm');
        const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/data_handling/sum32_block.syscfg.js','utf8');
        const sandbox={exports:{}, module:{exports:{}}, console:{log(){},error(){},warn(){}}};
        sandbox.global=sandbox; vm.createContext(sandbox); vm.runInContext(src,sandbox,{filename:'sum32',timeout:2000});
        try { sandbox.exports.getMacro('', 'm_sum32_bogus'); console.log('NO_THROW'); }
        catch(e) { console.log('THROWN:' + e.message); }
    """)], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().startswith("THROWN:"), f"getMacro must throw for an unknown opcode, got {proc.stdout}"


def test_allocator_style_call_with_src_addr_accepted():
    # accumulate's only operand is SRC_ADDR (the DMEM address, LBBO'd into
    # R2-R9); confirm getMacro accepts an allocator-emitted call like
    # "m_sum32_accumulate_only R20".
    proc = subprocess.run(["node", "-e", textwrap.dedent("""
        const fs=require('fs'), vm=require('vm');
        const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/data_handling/sum32_block.syscfg.js','utf8');
        const sandbox={exports:{}, module:{exports:{}}, console:{log(){},error(){},warn(){}}};
        sandbox.global=sandbox; vm.createContext(sandbox); vm.runInContext(src,sandbox,{filename:'sum32',timeout:2000});
        console.log(sandbox.exports.getMacro('m_sum32_accumulate_only R20', ''));
    """)], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10)
    assert proc.returncode == 0, proc.stderr
    assert "lbbo  &R2, SRC_ADDR, 0, 32" in proc.stdout


def test_allocator_style_call_with_res_accepted():
    proc = subprocess.run(["node", "-e", textwrap.dedent("""
        const fs=require('fs'), vm=require('vm');
        const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/data_handling/sum32_block.syscfg.js','utf8');
        const sandbox={exports:{}, module:{exports:{}}, console:{log(){},error(){},warn(){}}};
        sandbox.global=sandbox; vm.createContext(sandbox); vm.runInContext(src,sandbox,{filename:'sum32',timeout:2000});
        console.log(sandbox.exports.getMacro('m_sum32_read_clear R4', ''));
    """)], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10)
    assert proc.returncode == 0, proc.stderr
    assert "mov   RES, TEMP_REG2" in proc.stdout
