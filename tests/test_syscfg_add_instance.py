"""Exercise each block's real SysConfig 1.28 addInstance path when available."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile

import pytest


ROOT = Path(__file__).resolve().parents[1]
SYS_CONFIG = Path(os.environ.get("SYSCONFIG_CLI", r"C:\ti\sysconfig_1.28.0\dist\cli.js"))
NODE = Path(os.environ.get("SYSCONFIG_NODE", r"C:\ti\sysconfig_1.28.0\nodejs\node.exe"))
PRODUCT = ROOT / ".metadata" / "product.json"
DEVICE = "AM243x_ALX_beta"
PACKAGE = "ALX"
CONTEXT = "icss_g0_pru0"


def _available() -> bool:
    return NODE.is_file() and SYS_CONFIG.is_file()


pytestmark = pytest.mark.skipif(not _available(), reason="SysConfig 1.28 CLI is not installed")


def _modules() -> list[str]:
    base = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks"
    return [
        "/" + p.relative_to(base.parent).as_posix().removesuffix(".syscfg.js")
        for p in sorted(base.rglob("*.syscfg.js"))
        if p.name != "pru_blocks_static_module.syscfg.js"
    ]


def _run(module_path: str) -> subprocess.CompletedProcess[str]:
    temp = Path(tempfile.mkdtemp(prefix="syscfg-add-instance-"))
    script = temp / "probe.syscfg"
    script.write_text(
        "// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX "
        "--context icss_g0_pru0 --product PRU_NO_CODE_TOOL@01.00.01\n"
        f'scripting.addModule("{module_path}", {{}}, false).addInstance();\n',
        encoding="utf-8",
    )
    env = os.environ.copy()
    local = temp / "local"
    roaming = temp / "roaming"
    local.mkdir(exist_ok=True)
    roaming.mkdir(exist_ok=True)
    env["LOCALAPPDATA"] = str(local)
    env["APPDATA"] = str(roaming)
    return subprocess.run(
        [str(NODE), str(SYS_CONFIG), "--product", str(PRODUCT), "--device", DEVICE,
         "--package", PACKAGE, "--part", PACKAGE, "--script", str(script),
         "--context", CONTEXT, "--output", str(temp / "out")],
        cwd=ROOT, env=env, text=True, capture_output=True, timeout=60,
    )


def _assert_instantiated(module_path: str, result: subprocess.CompletedProcess[str]) -> None:
    output = result.stdout + result.stderr
    assert "Running script..." in output, f"SysConfig did not run {module_path}:\n{output}"
    assert "Exception occurred calling addInstance()" not in output, (
        f"SysConfig failed to instantiate {module_path}:\n{output}"
    )
    assert "Exception occurred calling scripting.addModule()" not in output, (
        f"SysConfig rejected module path {module_path}:\n{output}"
    )


def test_every_block_module_adds_an_instance() -> None:
    modules = _modules()
    assert modules, "no pru_blocks modules discovered"
    for module_path in modules:
        _assert_instantiated(module_path, _run(module_path))


def test_red_arm_rejects_a_deliberately_invalid_module_path() -> None:
    """Prove the add-instance assertion goes red when a design names no module."""
    result = _run("/pru_blocks/this_module_does_not_exist")
    output = result.stdout + result.stderr
    assert "Exception occurred calling scripting.addModule()" in output
    # Same oracle used by the all-module test must reject this deliberately bad design.
    with pytest.raises(AssertionError, match="rejected module path"):
        _assert_instantiated("/pru_blocks/this_module_does_not_exist", result)
