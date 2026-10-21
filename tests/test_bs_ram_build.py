"""bs_ram_block write/read designs generate correct macro calls and build with the real clpru.

Checks stop at build: TI pru-simulator has no model for broadside device ID 48 (0x30), so running the ELF raises
"XOUT XFR device ID 48 (0x30) is not modelled". That refusal is not asserted here, so a future simulator model for
ID 48 does not turn this file red.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

SYSCONFIG_NODE = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe"))
SYSCONFIG_CLI = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js"))
SCRATCH = ROOT / ".tmp" / "v182"

pytestmark = pytest.mark.skipif(
    not (Path(str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe")).exists() and SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()),
    reason="needs SysConfig 1.28 and clpru",
)

DESIGN = '''// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 --product PRU_NO_CODE_TOOL@01.00.01
const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);
const lcm = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const bsm = scripting.addModule("/pru_blocks/data_handling/bs_ram_block", {}, false);
const lc = lcm.addInstance(); lc.$name = "Payload"; lc.constant1 = 0xA1B2C3D4;
const w = bsm.addInstance(); w.$name = "BS_Write"; w.operation = "write"; w.rowAddress = 7; w.byteCount = 4;
const sn = bsm.addInstance(); sn.$name = "BS_Snoop"; sn.operation = "snoop_write"; sn.rowAddress = 11; sn.byteCount = 32;
const r = bsm.addInstance(); r.$name = "BS_Read"; r.operation = "read"; r.rowAddress = 9; r.byteCount = 12;
const r4 = bsm.addInstance(); r4.$name = "BS_Read4"; r4.operation = "read"; r4.rowAddress = 3; r4.byteCount = 4;
const r32 = bsm.addInstance(); r32.$name = "BS_Read32"; r32.operation = "read"; r32.rowAddress = 5; r32.byteCount = 32;
scripting.connect(lc, "output1", w, "input1");
scripting.connect(lc, "output1", sn, "input1");
scripting.connect(lc, "next", w, "prev");
scripting.connect(w, "next", sn, "prev");
scripting.connect(sn, "next", r, "prev");
scripting.connect(r, "next", r4, "prev");
scripting.connect(r4, "next", r32, "prev");
'''


def _build():
    work = SCRATCH / "w"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    script = work / "d.syscfg"
    script.write_text(DESIGN, encoding="utf-8")
    out = work / "out"
    env = dict(os.environ)
    r = subprocess.run([str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(ROOT / ".metadata" / "product.json"),
                        "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX", "--script", str(script),
                        "--context", "icss_g0_pru0", "--output", str(out)], cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0 and "Generating Code" in r.stdout, r.stdout + r.stderr
    (out / "main.asm").write_text(
        "    .retain\n    .retainrefs\n    .global     main\n    .ref        sysconfig_generated_start\n"
        '    .sect       ".text:main"\nmain:\n    jmp     sysconfig_generated_start\n'
        "    .global sysconfig_generated_end\nsysconfig_generated_end:\n    halt\n", encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    for args in (["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"],
                 ["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd", "--entry_point=main", "-o", "main.out"]):
        c = subprocess.run([elf_cosim.find_clpru()] + args, cwd=out, text=True, capture_output=True)
        assert c.returncode == 0, c.stdout + c.stderr
    return out


def test_write_then_read_design_builds_with_row_and_bytecount_in_the_right_slots():
    out = _build()
    asm = (out / "pru_syscfg.asm").read_text()
    calls = [l.strip() for l in asm.splitlines() if l.strip().startswith("m_bsram_")]
    assert len(calls) == 5, calls
    write, snoop, read, read4, read32 = calls
    # RES, INPUT (the Payload register), ROW 7, BYTECOUNT 4
    assert write.startswith("m_bsram_write ") and write.endswith(", 7 , 4"), write
    assert snoop.startswith("m_bsram_snoop_write ") and snoop.endswith(", 11 , 32"), snoop
    assert "undefined" not in write and "undefined" not in snoop and "undefined" not in read
    # Read is RES, ROW, BYTECOUNT - the XIN length follows the config (12 / 4 / 32), it is no longer a hardcoded 32
    for call, row, nbytes in ((read, 9, 12), (read4, 3, 4), (read32, 5, 32)):
        assert call.startswith("m_bsram_read ") and call.replace(" ", "").endswith(",%d,%d" % (row, nbytes)) and len(call.split(",")) == 3, call
        assert "undefined" not in call
    assert (out / "main.out").stat().st_size > 0
