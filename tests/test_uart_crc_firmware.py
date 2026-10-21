"""examples/uart_crc/firmware/main.asm must read the registers the generated code really uses.

main.asm runs after the generated code and reads block results straight from registers the register
allocator chose. For am243x-lp and am261x-lp, pru0 and pru1, this test generates the example's own
example.syscfg with SysConfig, links it with the example's main.asm and runs the clpru ELF on TI
pru-simulator:
  * The SMEM base address in main.asm (not mapped in the simulator) becomes a DMEM address, and on pru1
    the UART RX macro, which waits for a frame on a pin nothing drives here, is replaced by
    `LDI R0, <frame>`: R0 is the register that macro delivers its frame in.
  * pru1, frame 0xC041 (data 0x41, CRC 0xC0 = CRC-8 poly 0x07 of 0x41): SMEM[2] == 0x01 (match),
    SMEM[0] == SMEM[1] == 0xC0, SMEM[3] == 0x41.
  * pru1, frame 0x1141 (data 0x41, wrong CRC 0x11): SMEM[2] == 0xFF (mismatch), SMEM[0] == 0xC0,
    SMEM[1] == 0x11.
  * pru0: SMEM[4] == the TX data byte 0xAA (its CRC is 0x5F).
Expected values come from a plain-Python CRC-8, never from the asm.
Skips when SysConfig, clpru or the pru-simulator checkout (PRU_SIMULATOR_PATH) is missing.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EX = os.path.join(REPO_ROOT, "examples", "uart_crc", "firmware")
MAIN_ASM = os.path.join(EX, "main.asm")
PRODUCT_JSON = os.path.join(REPO_ROOT, ".metadata", "product.json")
SMEM_STUB = 0x1800  # DMEM address that stands in for the real SMEM base

TI_DIR = os.path.join(os.environ.get("SystemDrive", "C:") + os.sep, "ti")
SYSCFG_DIR = os.environ.get("SYSCFG_PATH", os.path.join(TI_DIR, "sysconfig_1.28.0"))
SYSCFG_NODE = os.path.join(SYSCFG_DIR, "nodejs", "node.exe" if os.name == "nt" else "node")
SYSCFG_CLI = os.path.join(SYSCFG_DIR, "dist", "cli.js")
CGT_DIR = os.environ.get("CGT_TI_PRU_PATH") or os.environ.get("PRU_CGT_PATH") or os.path.join(TI_DIR, "ti-cgt-pru_2.3.3")
CLPRU = os.path.join(CGT_DIR, "bin", "clpru.exe" if os.name == "nt" else "clpru")
SIMDIR = os.environ.get("PRU_SIMULATOR_PATH", "")

HAVE_TOOLS = all(os.path.exists(p) for p in (SYSCFG_NODE, SYSCFG_CLI, CLPRU)) and \
    os.path.isfile(os.path.join(SIMDIR, "simulator.py"))
needs_tools = pytest.mark.skipif(not HAVE_TOOLS, reason="SysConfig, clpru or TI pru-simulator (PRU_SIMULATOR_PATH) missing")

CORES = [
    # id, firmware dir, SysConfig --device/--part/--package/--context, -D flags, SMEM base in main.asm
    ("am243x-pru0", "am243x-lp/icss_g0_pru0_fw", ("AM243x_ALX_beta", "ALX", "ALX", "icss_g0_pru0"), "PRU0", "SOC_AM243X", "0x30010000"),
    ("am243x-pru1", "am243x-lp/icss_g0_pru1_fw", ("AM243x_ALX_beta", "ALX", "ALX", "icss_g0_pru1"), "PRU1", "SOC_AM243X", "0x30010000"),
    ("am261x-pru0", "am261x-lp/icss_m1_pru0_fw", ("AM261x_ZFG", "AM2612", "ZFG", "icss_m1_pru0"), "PRU0", "SOC_AM261X", "0x48010000"),
    ("am261x-pru1", "am261x-lp/icss_m1_pru1_fw", ("AM261x_ZFG", "AM2612", "ZFG", "icss_m1_pru1"), "PRU1", "SOC_AM261X", "0x48010000"),
]
PRU0_CORES = [c for c in CORES if c[3] == "PRU0"]
PRU1_CORES = [c for c in CORES if c[3] == "PRU1"]
RX_MACRO = re.compile(r"^\s*m_uart_rx\S*.*$", re.M)


def crc8(data, poly=0x07):
    """CRC-8 (MSB first, init 0): the CRC the example's lookup table implements."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def test_reference_crc_matches_the_documented_frames():
    assert crc8([0x41]) == 0xC0
    assert crc8([0x41]) != 0x11
    assert crc8([0xAA]) == 0x5F


def _run(cmd, cwd):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    assert proc.returncode == 0, "%s failed:\n%s\n%s" % (cmd[0], proc.stdout[-2000:], proc.stderr[-2000:])


def build_and_run(core, patch_frame=None):
    _id, fw, (device, part, package, context), pru, soc, smem = core
    work = tempfile.mkdtemp(prefix="uart_crc_")
    try:
        _run([SYSCFG_NODE, SYSCFG_CLI, "--product", PRODUCT_JSON, "--device", device, "--context", context,
              "--part", part, "--package", package, "--output", "syscfg", os.path.join(EX, fw, "example.syscfg")], work)
        asm_path = os.path.join(work, "syscfg", "pru_syscfg.asm")
        with open(asm_path, encoding="utf-8") as f:
            asm = f.read()
        if patch_frame is not None:
            asm, n = RX_MACRO.subn("    LDI R0, %d" % patch_frame, asm)
            assert n == 1, "the pru1 design must contain exactly one UART RX macro"
            with open(asm_path, "w", encoding="utf-8") as f:
                f.write(asm)
        with open(MAIN_ASM, encoding="utf-8") as f:
            main = f.read()
        assert smem in main, "main.asm no longer loads the SMEM base %s" % smem
        main_path = os.path.join(work, "main_dmem.asm")
        with open(main_path, "w", encoding="utf-8") as f:
            f.write(main.replace(smem, "0x%X" % SMEM_STUB))
        cflags = ["-v4", "-O2", "--include_path=" + os.path.join(CGT_DIR, "include"), "-D" + pru, "-DSLICE0", "-D" + soc,
                  "--include_path=" + os.path.dirname(asm_path)]
        _run([CLPRU] + cflags + ["--output_file=main.obj", main_path], work)
        _run([CLPRU] + cflags + ["--output_file=pru_syscfg.obj", asm_path], work)
        _run([CLPRU, "-v4", "-O2", "-z", "main.obj", "pru_syscfg.obj", os.path.join(EX, fw, "ti-pru-cgt", "linker.cmd"),
              "--warn_sections", "--reread_libs", "--ram_model", "--entry_point=main", "--disable_auto_rts",
              "-o", "fw.out"], work)
        with open(os.path.join(work, "fw.out"), "rb") as f:
            elf = f.read()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    entry = struct.unpack_from("<I", elf, 24)[0]
    saved_path, saved_mods = list(sys.path), dict(sys.modules)
    sys.path.insert(0, SIMDIR)
    try:
        from simulator import Simulator  # type: ignore
        from core.elf_loader import load_elf  # type: ignore
        sim = Simulator(os.path.join(SIMDIR, "memory.cfg"))
        assert not sim.load_elf("pru0", elf)
        pru_core = sim.cores["pru0"]
        # The CRC lookup table is in .initdmem: write every initialised section, not only .data.
        for addr, blob in load_elf(elf).data_sections:
            pru_core.memory.write(addr, blob)
        pru_core.pc = entry // 4
        for _ in range(20000):
            sim.step("pru0", 1)
            if pru_core.halted:
                break
        assert pru_core.halted, "firmware did not halt"
        return list(sim.memory_read(SMEM_STUB, 8))
    finally:
        sys.path[:] = saved_path
        for name in [m for m in sys.modules if m not in saved_mods]:
            del sys.modules[name]


@needs_tools
@pytest.mark.parametrize("core", PRU1_CORES, ids=[c[0] for c in PRU1_CORES])
def test_pru1_good_crc_frame_reports_match(core):
    smem = build_and_run(core, patch_frame=0xC041)
    assert smem[0] == crc8([0x41]), "SMEM[0] (computed CRC) = 0x%02X, want 0x%02X" % (smem[0], crc8([0x41]))
    assert smem[1] == 0xC0, "SMEM[1] (received CRC) = 0x%02X, want 0xC0" % smem[1]
    assert smem[2] == 0x01, "SMEM[2] = 0x%02X: a frame with the right CRC must report match (0x01)" % smem[2]
    assert smem[3] == 0x41, "SMEM[3] (received data) = 0x%02X, want 0x41" % smem[3]


@needs_tools
@pytest.mark.parametrize("core", PRU1_CORES, ids=[c[0] for c in PRU1_CORES])
def test_pru1_bad_crc_frame_reports_mismatch(core):
    smem = build_and_run(core, patch_frame=0x1141)
    assert smem[0] == crc8([0x41]), "SMEM[0] (computed CRC) = 0x%02X, want 0x%02X" % (smem[0], crc8([0x41]))
    assert smem[1] == 0x11, "SMEM[1] (received CRC) = 0x%02X, want 0x11" % smem[1]
    assert smem[2] == 0xFF, "SMEM[2] = 0x%02X: a frame with a wrong CRC must report mismatch (0xFF)" % smem[2]
    assert smem[3] == 0x41, "SMEM[3] (received data) = 0x%02X, want 0x41" % smem[3]


@needs_tools
@pytest.mark.parametrize("core", PRU0_CORES, ids=[c[0] for c in PRU0_CORES])
def test_pru0_stores_the_tx_data_byte(core):
    smem = build_and_run(core)
    assert smem[4] == 0xAA, "SMEM[4] = 0x%02X: pru0 must store the TX data byte 0xAA (the CRC is 0x%02X)" % (
        smem[4], crc8([0xAA]))
