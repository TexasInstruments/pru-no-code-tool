""".usmem / .udmem placement, checked on the real linker map.

check_map_placement() parses a clpru linker .map and asserts that `.usmem`
lies inside PRU_SHAREDMEM and `.udmem` lies inside the same DMEM region the
linker.cmd gives `.bss`. The green arm builds an example with the shipped
linker.cmd and runs the checker; the red arm builds the SAME example with the
`.usmem`/`.udmem` rules stripped from its linker.cmd and runs the SAME
checker, asserting the specific failure text.

Static, no ELF run: this reads the linker map only.
"""
import os
import shutil
import subprocess
import sys
import re

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "sim")))

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EMPTY_EXAMPLE = os.path.join(REPO, "examples", "empty")
FW_REL = os.path.join("firmware", "am243x-lp", "icss_g0_pru0_fw")

def _toolchain():
    gmake = shutil.which("gmake") or shutil.which("make")
    if gmake is None:
        return None, "gmake/make not on PATH"
    if not os.path.isfile(os.path.join(REPO, "imports.mak")):
        return None, "imports.mak not configured"
    try:
        import elf_cosim
        elf_cosim.find_clpru()
    except RuntimeError as exc:
        return None, str(exc)
    return gmake, None

_GMAKE, _WHY_NOT = _toolchain()
needs_tools = pytest.mark.skipif(_GMAKE is None, reason=_WHY_NOT or "")

SYSCFG = """
const memoryModule = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);
const mem_smem = memoryModule.addInstance();
mem_smem.$name = "my_shared_var";
mem_smem.labelName = "shared_buf";
mem_smem.memoryLocation = "smem";

const mem_dmem = memoryModule.addInstance();
mem_dmem.$name = "my_local_var";
mem_dmem.labelName = "local_buf";
mem_dmem.memoryLocation = "dmem";

const pidModule = scripting.addModule("/pru_blocks/data_handling/iqmath_pid_block", {}, false);
const pid = pidModule.addInstance();
pid.$name = "my_pid";
const constMod = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const c1 = constMod.addInstance();
c1.$name = "dummy_c1";
const c2 = constMod.addInstance();
c2.$name = "dummy_c2";

scripting.connect(c1, "next", c2, "prev");
scripting.connect(c2, "next", pid, "prev");
scripting.connect(c1, "output1", pid, "input1");
scripting.connect(c2, "output1", pid, "input2");
"""


_HEX = r"([0-9a-fA-F]+)"


def _map_region(map_text, name):
    m = re.search(rf"^\s*{name}\s+{_HEX}\s+{_HEX}", map_text, re.MULTILINE)
    assert m, f"memory region {name} not found in map file"
    return int(m.group(1), 16), int(m.group(2), 16)


def _map_section_addr(map_text, name):
    m = re.search(rf"^{re.escape(name)}\s+\d+\s+{_HEX}\s+{_HEX}", map_text, re.MULTILINE)
    assert m, f"section {name} not found in map file"
    return int(m.group(1), 16)


def check_map_placement(map_text, linker_text):
    """Assert .usmem is in PRU_SHAREDMEM and .udmem is in .bss's DMEM region.

    The DMEM region name is taken from the `.bss > <region>` rule of
    linker_text; the region bounds and section addresses come from map_text.
    Raises AssertionError with a specific message on any violation.
    """
    shared_org, shared_len = _map_region(map_text, "PRU_SHAREDMEM")
    usmem = _map_section_addr(map_text, ".usmem")
    if usmem < shared_org:
        raise AssertionError(
            f".usmem placed at 0x{usmem:x}, before PRU_SHAREDMEM (0x{shared_org:x})")
    if usmem >= shared_org + shared_len:
        raise AssertionError(
            f".usmem placed at 0x{usmem:x}, after PRU_SHAREDMEM end (0x{shared_org + shared_len:x})")

    bss = re.search(r"^\s*\.bss\s*>\s*(\w+)", linker_text, re.MULTILINE)
    assert bss, ".bss rule not found in linker.cmd"
    region = bss.group(1)
    dmem_org, dmem_len = _map_region(map_text, region)
    udmem = _map_section_addr(map_text, ".udmem")
    if udmem < dmem_org:
        raise AssertionError(
            f".udmem placed at 0x{udmem:x}, before {region} (0x{dmem_org:x})")
    if udmem >= dmem_org + dmem_len:
        raise AssertionError(
            f".udmem placed at 0x{udmem:x}, after {region} end (0x{dmem_org + dmem_len:x})")


def _build_example(tmp_path, strip_rules):
    """Copy the empty example, add smem/dmem variables, force .usmem/.udmem
    into the link, optionally strip their rules from linker.cmd, build.
    Returns (map_text, linker_text)."""
    shutil.copytree(EMPTY_EXAMPLE, tmp_path / "ex", ignore=shutil.ignore_patterns("generated", "syscfg"))
    fw_dir = tmp_path / "ex" / FW_REL
    (fw_dir / "example.syscfg").write_text(SYSCFG)

    main_asm = tmp_path / "ex" / "firmware" / "main.asm"
    main_asm.write_text(main_asm.read_text() + (
        "\n    .global dummy_u\n    .global dummy_s\n"
        "    .sect \".text:main\"\n"
        "    LDI32 R0, dummy_u\n    LDI32 R0, dummy_s\n"
        "dummy_u .usect \".udmem\", 4, 4\n"
        "dummy_s .usect \".usmem\", 4, 4\n"))

    build_dir = fw_dir / "ti-pru-cgt"
    linker = build_dir / "linker.cmd"
    if strip_rules:
        text = linker.read_text()
        text = re.sub(r"^[ \t]*\.(usmem|udmem)\b.*\n", "", text, flags=re.MULTILINE)
        assert ".usmem" not in text and ".udmem" not in text
        linker.write_text(text)
    hex_path = tmp_path / "pru0_load_bin.h"
    res = subprocess.run(
        [_GMAKE, "-s", "all", f"MCU_HEX_PATH={hex_path.as_posix()}", f"PRU_NO_CODE_TOOL_PATH={REPO.replace(os.sep, '/')}"],
        cwd=str(build_dir), capture_output=True, text=True)
    assert res.returncode == 0, f"gmake failed: {res.stdout}\n{res.stderr}"
    map_file = next(build_dir.rglob("*.map"))
    return map_file.read_text(), linker.read_text()


@needs_tools
def test_memory_placement_map_file(tmp_path):
    map_text, linker_text = _build_example(tmp_path, strip_rules=False)
    check_map_placement(map_text, linker_text)


@needs_tools
def test_memory_placement_red_arm(tmp_path):
    """Same example, same checker, linker rules stripped: must fail for the
    stated reason (.usmem falls back into instruction memory)."""
    map_text, linker_text = _build_example(tmp_path, strip_rules=True)
    with pytest.raises(AssertionError, match=r"\.usmem placed at 0x[0-9a-f]+, before PRU_SHAREDMEM \(0x10000\)"):
        check_map_placement(map_text, linker_text)


_SYNTH_LINKER = "SECTIONS {\n\t.bss\t>  PRU0_DMEM_0, PAGE 1\n}\n"
_SYNTH_MAP = (
    "PRU0_DMEM_0           00000000   00001000  00000000\n"
    "PRU_SHAREDMEM         00010000   00010000  00000000\n"
    ".usmem    0    {usmem}    00000004     UNINITIALIZED\n"
    ".udmem    0    {udmem}    00000004     UNINITIALIZED\n")


def test_check_map_placement_synthetic():
    """No build: the checker accepts a good map and names each violation."""
    check_map_placement(_SYNTH_MAP.format(usmem="00010000", udmem="00000000"), _SYNTH_LINKER)
    with pytest.raises(AssertionError, match=r"\.udmem placed at 0x1000, after PRU0_DMEM_0 end \(0x1000\)"):
        check_map_placement(_SYNTH_MAP.format(usmem="00010000", udmem="00001000"), _SYNTH_LINKER)
    with pytest.raises(AssertionError, match=r"\.usmem placed at 0x20000, after PRU_SHAREDMEM end"):
        check_map_placement(_SYNTH_MAP.format(usmem="00020000", udmem="00000000"), _SYNTH_LINKER)
