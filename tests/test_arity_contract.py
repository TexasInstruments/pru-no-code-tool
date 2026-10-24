"""every pru_blocks default instance must pass the real SysConfig arity guard."""
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_syscfg_arity.js"


def test_every_block_matches_its_generated_macro_definition():
    result = subprocess.run(["node", str(CHECKER)], cwd=ROOT, env=os.environ.copy(),
                            capture_output=True, text=True)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    summary = next((line for line in result.stdout.splitlines() if "modules checked:" in line), "")
    assert summary and int(summary.split()[0]) >= 76, output
    assert "0 known-broken, 0 unexpected failures" in output, output


def test_missing_sysconfig_is_a_failure(tmp_path):
    env = os.environ.copy()
    env["SYSCONFIG_CLI"] = str(tmp_path / "absent-cli.js")
    result = subprocess.run(["node", str(CHECKER)], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FATAL: SysConfig CLI not found at" in result.stderr, result.stderr
    assert "modules checked" not in result.stdout, result.stdout
