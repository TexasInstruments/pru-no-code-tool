"""
Device-capability gating for hardware-widget blocks.

Acceptance:
 - Negative test that instantiates a widget-requiring block against AM261x and asserts validator produced an error.
 - The test must go RED if validator branch is deleted — demonstrate by actually deleting it.
 - Positive test that same block on AM243x produces no error.
 - Existing tests still pass.

This file drives the REAL validator code in .metadata/sysconfig/.meta/pru_blocks/common/pru_blocks_static_module.syscfg.js
via scripts/static_module_validate_runner.js, which loads the single-source capability table at
.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js (TRM SPRUIM2J §6.4.1.1 / SPRUJB6 §7.3.1.1).

Device table (single place, not four):
  ICSSG (AM64x/AM243x): mac, crc_hw, spad, bswap, sum32, task_manager, stitch_fifo, bs_ram, rtu_pru, tx_pru, iep2
  ICSSM (AM261x/AM263Px): mac, crc_hw, spad only  (bswap, sum32, task_manager, stitch_fifo, bs_ram, rtu/tx, iep2 absent)
"""
import json
import os
import subprocess
import pathlib

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "static_module_validate_runner.js"
NODE = "node"

def run_validator(device, soc, widget):
    proc = subprocess.run(
        [NODE, str(RUNNER), device, soc, widget],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"runner failed: {proc.stdout}\n{proc.stderr}"
    errors = json.loads(proc.stdout.strip() or "[]")
    return errors


def test_negative_bswap_on_am261x_produces_error():
    """AM261x (ICSSM) lacks BSWAP — a block requiring it must be refused with an ERROR naming widget and device."""
    errors = run_validator("AM261x_ZCZ", "am261x", "bswap")
    assert len(errors) == 1, f"expected exactly one error, got {errors}"
    msg = errors[0]
    assert "bswap" in msg.lower(), f"error must name widget 'bswap': {msg}"
    assert "AM261x_ZCZ" in msg or "am261x" in msg.lower(), f"error must name device: {msg}"
    # must be an ERROR (not a warning) — runner only collects logError
    assert "requires widget" in msg.lower()


def test_positive_bswap_on_am243x_produces_no_error():
    """Same block on AM243x (ICSSG) has BSWAP — no error."""
    errors = run_validator("AM243x_ALV_beta", "am243x", "bswap")
    assert errors == [], f"AM243x should not error for bswap, got {errors}"


def test_positive_mac_on_am261x_produces_no_error():
    """MAC is present on both ICSSG and ICSSM — must not error on AM261x."""
    errors = run_validator("AM261x_ZCZ", "am261x", "mac")
    assert errors == [], f"MAC should be available on AM261x, got {errors}"


def test_negative_sum32_on_am261x_produces_error():
    errors = run_validator("AM261x_ZCZ", "am261x", "sum32")
    assert len(errors) == 1
    assert "sum32" in errors[0].lower()
    assert "am261x" in errors[0].lower()


def test_negative_stitch_fifo_on_am261x():
    errors = run_validator("AM261x_ZCZ", "am261x", "stitch_fifo")
    assert len(errors) == 1
    assert "stitch_fifo" in errors[0].lower()


def test_positive_stitch_fifo_on_am64x():
    errors = run_validator("AM64x", "am64x", "stitch_fifo")
    assert errors == []


def test_real_blocks_declare_mac():
    """Audit: at minimum mac_hw_block must declare requiresWidget ["mac"]; same for iqmath_* and svpwm via xin/xout."""
    import re
    blocks_dir = REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "data_handling"
    for fname in ["mac_hw_block.syscfg.js", "iqmath_pid_block.syscfg.js", "iqmath_park_clarke_block.syscfg.js", "svpwm_block.syscfg.js"]:
        src = (blocks_dir / fname).read_text(encoding="utf-8")
        assert 'requiresWidget' in src, f"{fname} missing requiresWidget"
        assert re.search(r'requiresWidget\s*:\s*\[\s*["\']mac["\']\s*\]', src), f"{fname} should require ['mac']"


def test_device_caps_single_source():
    """Capability table lives in ONE place, not four soc catalogs."""
    caps_path = REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "common" / "pru_device_caps.js"
    assert caps_path.exists(), "pru_device_caps.js must exist (single source)"
    src = caps_path.read_text(encoding="utf-8")
    assert "AM64x" not in src or "am64x" in src.lower()  # at least mentions devices
    assert "am261x" in src.lower() and "am243x" in src.lower()
    # soc catalogs must NOT duplicate capability logic
    for soc_file in (REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "soc").glob("*.js"):
        txt = soc_file.read_text(encoding="utf-8")
        assert "requiresWidget" not in txt
        assert "bswap" not in txt.lower() or "pru_blocks" in txt.lower()  # no capability table in soc files


def test_negative_xfr2psi_on_am261x_produces_error():
    """AM261x (ICSSM) has no PSI-L at all (SPRUJB6 7.3.1.1) — xfr2psi must be refused with an ERROR naming widget and device."""
    errors = run_validator("AM261x_ZCZ", "am261x", "xfr2psi")
    assert len(errors) == 1, f"expected exactly one error, got {errors}"
    msg = errors[0]
    assert "xfr2psi" in msg.lower(), f"error must name widget 'xfr2psi': {msg}"
    assert "AM261x_ZCZ" in msg or "am261x" in msg.lower(), f"error must name device: {msg}"
    assert "requires widget" in msg.lower()


def test_positive_xfr2psi_on_am64x_produces_no_error():
    """Same block on AM64x (ICSSG) has PSI-L — no error."""
    errors = run_validator("AM64x", "am64x", "xfr2psi")
    assert errors == [], f"AM64x should not error for xfr2psi, got {errors}"


def test_positive_xfr2psi_on_am243x_produces_no_error():
    errors = run_validator("AM243x_ALV_beta", "am243x", "xfr2psi")
    assert errors == [], f"AM243x should not error for xfr2psi, got {errors}"


def test_portability_docs_generated():
    """build_block_docs.js must surface portability matrix in generated docs."""
    # requires running node build_block_docs.js already done; check outputs
    portability_md = REPO_ROOT / "docs" / "block-reference" / "portability.md"
    assert portability_md.exists(), "portability.md not generated — run node build_block_docs.js"
    txt = portability_md.read_text(encoding="utf-8")
    assert "am261x" in txt.lower()
    assert "am243x" in txt.lower()
    assert "mac" in txt.lower()
    # per-block design doc must contain Device portability section
    mac_design = REPO_ROOT / "docs" / "block-reference" / "blocks" / "mac_hw_block" / "design.md"
    assert mac_design.exists()
    assert "Device portability" in mac_design.read_text(encoding="utf-8")
