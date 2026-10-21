"""i3c_sdr_initiator_block declares the pru_blocks_static_module dependency, so a design containing only it emits.

Before the fix the block's moduleStatic had no `modules` entry, so a design whose only block was i3c_sdr_initiator_block
generated a pru_syscfg.asm with no macro call (the macro definition lives in pru_syscfg.inc, which only the static module
generates) and the firmware contained no I3C code.  scripts/check_syscfg_arity.js carried the block in
STANDALONE_UNREACHABLE as a known gap.

Production path: .syscfg (no explicit static-module addModule) -> real SysConfig CLI -> pru_syscfg.asm -> clpru -> ELF.
Red arms: (a) the moduleStatic.modules entry removed -> the generated asm has no m_i3c_entdaa call (asserted by text);
(b) the STANDALONE_UNREACHABLE row put back -> check_syscfg_arity.js reports STALE naming the block.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "sim"))

SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
BLOCK = "i3c_sdr_initiator_block"
BLOCK_REL = Path("sysconfig/.meta/pru_blocks/pru_io_blocks/%s.syscfg.js" % BLOCK)
SWEEP = ROOT / "scripts" / "check_syscfg_arity.js"

try:
    import elf_cosim
    elf_cosim.find_clpru()
    HAVE_CLPRU = True
except (RuntimeError, ImportError):
    HAVE_CLPRU = False
HAVE_SYSCFG = SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()

need_syscfg = pytest.mark.skipif(not HAVE_SYSCFG, reason="SysConfig CLI missing")
need_clpru = pytest.mark.skipif(not (HAVE_CLPRU and HAVE_SYSCFG), reason="clpru or SysConfig CLI missing")


def generate(work, metadata=None):
    """Standalone design: only the block's default instance, no explicit static-module addModule."""
    metadata = metadata or ROOT / ".metadata"
    work.mkdir(parents=True, exist_ok=True)
    script = work / "i3c.syscfg"
    script.write_text("\n".join([
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01',
        'const i3c = scripting.addModule("/pru_blocks/pru_io_blocks/%s", {}, false);' % BLOCK,
        'const inst = i3c.addInstance();',
        'inst.$name = "BLOCK_0";', ""]), encoding="utf-8")
    out = work / "out"
    env = dict(os.environ)
    r = subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(metadata / "product.json"), "--device",
         "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX", "--script", str(script), "--context", "icss_g0_pru0",
         "--output", str(out)], cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0 and "Generating Code" in r.stdout, "SysConfig failed:\n%s\n%s" % (r.stdout, r.stderr)
    return out


CALL_RE = re.compile(r"^[ \t]*m_i3c_entdaa[ \t]+(.*?)[ \t]*$", re.M)


def assert_emitted(out):
    asm = (out / "pru_syscfg.asm").read_text(encoding="utf-8", errors="replace")
    calls = CALL_RE.findall(asm)
    assert len(calls) == 1, "standalone i3c design emitted no m_i3c_entdaa call (found %r) in pru_syscfg.asm" % calls
    return calls[0]


MAIN_ASM = """\
    .retain
    .retainrefs
    .global     main
    .ref        sysconfig_generated_start
    .sect       ".text:main"
main:
    jmp     sysconfig_generated_start
    .global sysconfig_generated_end
sysconfig_generated_end:
    halt
"""


def _clpru(args, cwd):
    r = subprocess.run([elf_cosim.find_clpru()] + args, cwd=cwd, text=True, capture_output=True)
    text = r.stdout + r.stderr
    assert r.returncode == 0, "clpru %s failed:\n%s" % (" ".join(args), text)


def build(out):
    (out / "main.asm").write_text(MAIN_ASM, encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    _clpru(["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"], out)
    _clpru(["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd", "--entry_point=main", "-o", "main.out"], out)
    return out / "main.out"


@need_syscfg
def test_standalone_design_emits_the_macro_call(tmp_path):
    out = generate(tmp_path)
    call = assert_emitted(out)
    assert call.split(",")[0].strip().startswith("R"), call
    inc = (out / "pru_syscfg.inc").read_text(encoding="utf-8", errors="replace")
    assert re.search(r"^m_i3c_entdaa\s+\.macro\s+RES,\s*SCL_BIT,\s*SDA_BIT,\s*DA_VAL,\s*PID_REG\s*$", inc, re.M), inc[:400]


@need_clpru
def test_standalone_design_assembles_and_links(tmp_path):
    out = generate(tmp_path)
    assert_emitted(out)
    elf = build(out)
    assert elf.exists() and elf.stat().st_size > 0


def _mutated_metadata(tmp_path):
    shutil.copytree(ROOT / ".metadata", tmp_path / ".metadata")
    return tmp_path / ".metadata"


@need_syscfg
def test_red_arm_missing_moduleStatic_modules_emits_nothing(tmp_path):
    """The dependency removed: the generated asm has no m_i3c_entdaa call and the test names that."""
    meta = _mutated_metadata(tmp_path)
    f = meta / BLOCK_REL
    s = f.read_text(encoding="utf-8")
    t = re.sub(r"\n?\s*modules: function\(inst\) \{.*?\n\s*\},\n", "\n", s, count=1, flags=re.S)
    assert t != s and "modules:" not in t, "mutation did not apply"
    f.write_text(t, encoding="utf-8")
    out = generate(tmp_path / "work", metadata=meta)
    with pytest.raises(AssertionError, match=r"standalone i3c design emitted no m_i3c_entdaa call"):
        assert_emitted(out)


@need_syscfg
def test_sweep_has_no_standalone_gap_for_i3c():
    r = subprocess.run(["node", str(SWEEP), str(ROOT / ".metadata" / "sysconfig" / ".meta"), "--list"],
                       cwd=ROOT, text=True, capture_output=True)
    text = r.stdout + r.stderr
    assert r.returncode == 0, text
    assert "KNOWN-STANDALONE-UNREACHABLE /pru_blocks/pru_io_blocks/i3c_sdr_initiator_block" not in text, text
    assert "reached /pru_blocks/pru_io_blocks/i3c_sdr_initiator_block" in text, text


@need_syscfg
def test_red_arm_standalone_row_restored_is_stale(tmp_path):
    """The row put back in STANDALONE_UNREACHABLE: the block emits standalone now, so the sweep reports STALE naming it."""
    sweep = tmp_path / "check_syscfg_arity.js"
    s = SWEEP.read_text(encoding="utf-8")
    t = s.replace("const STANDALONE_UNREACHABLE = {\n", 'const STANDALONE_UNREACHABLE = {\n    "/pru_blocks/pru_io_blocks/%s": "restored",\n' % BLOCK, 1)
    assert t != s, "mutation did not apply"
    sweep.write_text(t, encoding="utf-8")
    r = subprocess.run(["node", str(sweep), str(ROOT / ".metadata" / "sysconfig" / ".meta")], cwd=ROOT, text=True, capture_output=True)
    text = r.stdout + r.stderr
    assert r.returncode == 1, text
    assert re.search(r"STALE /pru_blocks/pru_io_blocks/%s: listed in STANDALONE_UNREACHABLE" % BLOCK, text), text
