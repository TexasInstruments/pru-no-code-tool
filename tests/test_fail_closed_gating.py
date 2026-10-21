"""
The device-capability gate must fail CLOSED or error VISIBLY on every failure path.

Failure paths covered (each must report an error instead of silently skipping
validation and leaving the build clean):
  failure path                              fail-open behaviour this test rejects
  1. getScript("/common") failure          -> silent return
  2. missing SoC (getSocName() -> null)     -> silent return
  3. isWidgetAvailable() exception          -> available = true
  4. null pruDeviceCaps (caps unloadable)   -> silent return
  5. unknown SoC                            -> default ICSSM caps

Drives the REAL validator in
.metadata/sysconfig/.meta/pru_blocks/common/pru_blocks_static_module.syscfg.js
and the REAL capability table at
.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js
via scripts/static_module_validate_runner.js.

If any fail-closed branch is changed to fail open, the corresponding test below
fails, because the runner then reports an empty error list ("clean build") for
that degraded mode.
"""
import json
import pathlib
import subprocess

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "static_module_validate_runner.js"
NODE = "node"


def run_validator(device, soc, widget, mode=None):
    cmd = [NODE, str(RUNNER), device, soc, widget]
    if mode:
        cmd.append(mode)
    proc = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"runner failed: {proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.strip() or "[]")


def test_failure_path_getscript_common_errors_visibly():
    """Path 1: system.getScript('/common') throws -> ERROR, not a silent skip."""
    errors = run_validator("AM261x_ZCZ", "am261x", "mac", mode="--common-throws")
    assert len(errors) == 1, "getScript('/common') failure silently skipped gating"
    msg = " ".join(errors).lower()
    assert "common" in msg and ("fail" in msg or "cannot" in msg)


def test_failure_path_missing_soc_errors_visibly():
    """Path 2: getSocName() returns null -> ERROR naming the missing SoC."""
    errors = run_validator("AM261x_ZCZ", "am261x", "mac", mode="--no-soc")
    assert len(errors) == 1, "missing SoC silently skipped gating"
    msg = " ".join(errors).lower()
    assert "soc" in msg and ("could not be determined" in msg or "cannot" in msg)


def test_failure_path_widget_exception_fails_closed():
    """Path 3: isWidgetAvailable() throws -> widget treated UNAVAILABLE with a visible ERROR."""
    errors = run_validator("AM263x_beta", "am263x", "mac", mode="--widget-throws")
    assert len(errors) == 1, "isWidgetAvailable exception silently treated widget as available"
    msg = " ".join(errors).lower()
    assert "mac" in msg and "unavailable" in msg


def test_failure_path_null_caps_errors_visibly():
    """Path 4: capability table unloadable (null pruDeviceCaps) -> ERROR; build is NOT clean."""
    errors = run_validator("AM243x_ALV_beta", "am243x", "mac", mode="--no-caps")
    assert len(errors) == 1, "null pruDeviceCaps silently skipped gating"
    msg = " ".join(errors).lower()
    assert "capability table" in msg or "pru_device_caps" in msg


def test_failure_path_unknown_soc_errors_visibly():
    """Path 5: SoC not in the capability table -> ERROR naming the SoC; no silent default caps."""
    errors = run_validator("AM9999_fake", "am9999", "mac")
    assert len(errors) == 1, "unknown SoC silently inherited a default capability set"
    msg = " ".join(errors).lower()
    assert "am9999" in msg
    assert "capability table" in msg or "not in" in msg


def test_known_soc_positive_control_stays_clean():
    """Control: a known SoC with the widget present must still produce NO errors."""
    errors = run_validator("AM243x_ALV_beta", "am243x", "mac")
    assert errors == [], f"known-good configuration must stay clean, got {errors}"


def test_caps_module_unknown_soc_has_no_widgets():
    """Unit-level: getCapsForSoc for unknown/missing SoC returns an EMPTY set (fail closed),
    never a default capability set."""
    caps_path = REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "common" / "pru_device_caps.js"
    assert caps_path.exists()
    proc = subprocess.run(
        [NODE, "-e",
         f"const c = require({json.dumps(str(caps_path))});"
         "const unk = c.getCapsForSoc('am9999');"
         "const nul = c.getCapsForSoc(null);"
         "if (unk.size !== 0 || nul.size !== 0) {"
         "  console.error('FAIL size unk=' + unk.size + ' null=' + nul.size); process.exit(1); }"
         "if (c.isKnownSoc('am9999') !== false || c.isKnownSoc('am64x') !== true) {"
         "  console.error('FAIL isKnownSoc'); process.exit(1); }"
         "console.log('ok');"],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"caps module fail-closed check failed: {proc.stdout}\n{proc.stderr}"


def test_validator_fail_closed_source_guards():
    """Lint only; the behavioural tests above are the real check.

    These are whitespace-literal substring checks. Re-introducing the exact
    fail-open as `catch (e) {
    available = true;
}` passes them both while
    the behavioural arms above correctly go red. Kept as cheap lint; the
    check that the gate fails closed is the five run_validator arms.
    """
    src = (REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "common"
           / "pru_blocks_static_module.syscfg.js").read_text(encoding="utf-8")
    assert "available = true; }" not in src, "isWidgetAvailable exception must fail CLOSED, not available=true"
    gating = src.split("function validateDeviceCapabilities")[1].split("\n}\n")[0]
    assert "Failing closed." in gating, "visible fail-closed error messages must be present"
