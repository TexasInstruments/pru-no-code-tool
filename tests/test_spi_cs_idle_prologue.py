"""pru_spi_{read,write,transfer} checks, each measured on a real SysConfig + gmake + clpru build.

  1. Controller-mode CS is driven to its idle (high) level once, in the generated prologue: with no PRU GPO block the first transaction now
     has an assertion edge (TI pru-simulator pin trace; red arm = the same build with the prologue emission removed). Peripheral mode
     never drives CS. The documented fixed overhead is unchanged by it.
  2. The fixed CS-assert -> first-SCLK and last-SCLK -> CS-release overhead and the 256-cycle cap quoted in the block docs equal what
     the TI pru-simulator measures and what the validator enforces.
  3. A design whose SPI blocks overflow the 12 KB PRU IRAM gets a validation WARNING naming the estimate, and the estimate is an upper
     bound (within 5%) of the .text the linker actually produces, in controller mode and in peripheral mode (CS Filter Cycles,
     transfer only; pins peripheral read / write at within 10%).
"""
import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO, "scripts", "sim"))

import elf_cosim

TEMPLATE = os.path.join(REPO, "examples", "empty", "firmware")
BUILD_ROOT = os.path.join(REPO, "build_out", "")
DOCS = os.path.join(REPO, "docs", "input-output", "serial-protocol-emulation", "pru_spi_%s_block.md")
SCLK_PIN, CS_PIN, SDO_PIN, SDI_PIN = 4, 5, 3, 2
KINDS = ("read", "write", "transfer")
MODES = ("MODE0", "MODE1", "MODE2", "MODE3")
SECTION = "### CS Idle Level, Fixed Timing Overhead and Program Memory"
RELEASE_NOTE = "**Release note.**"


def _find_gmake():
    env = os.environ.get("GMAKE")
    if env and os.path.exists(env):
        return env
    hits = sorted(glob.glob("C:/ti/ccs*/ccs/utils/bin/gmake.exe"))
    return hits[-1] if hits else (shutil.which("gmake") or shutil.which("make"))


GMAKE = _find_gmake()
try:
    elf_cosim.find_clpru()
    elf_cosim.find_pru_simulator()
    _HAVE_SIM = True
except RuntimeError:
    _HAVE_SIM = False
_HAVE_BUILD = (GMAKE is not None and os.path.exists(os.path.join(REPO, "imports.mak"))
               and os.path.isdir(os.environ.get("SYSCFG_PATH", "C:/ti/sysconfig_1.28.0")))
needs_build = pytest.mark.skipif(not (_HAVE_SIM and _HAVE_BUILD),
                                 reason="needs clpru + TI pru-simulator + gmake + SysConfig 1.28 + repo-root imports.mak")


def syscfg(kind, n=1, mode="controller", spimode="MODE0", bits=16, setup=10, hold=10, dsetup=0, high=7, low=7, cs_idle=True, filt=None):
    """A chain: Load Constant -> [PRU GPO SET R30,cs] -> n SPI blocks of one kind, all on the same pins (one shared CS)."""
    s = ['const st = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");', "st.pruClkFreq = 200;",
         'const lc = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);',
         'const lc1 = lc.addInstance(); lc1.$name = "Data_Word"; lc1.constant1 = 0xA5A5;',
         'const sp = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_%s", {}, false);' % kind]
    prev = "lc1"
    if cs_idle:
        s += ['const gp = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);',
              'const g1 = gp.addInstance(); g1.$name = "CS_Idle_High"; g1.constant1 = "R30, %d"; g1.opCode = "SET";' % CS_PIN,
              'scripting.connect(lc1, "next", g1, "prev");']
        prev = "g1"
    pins = {"SCLK": SCLK_PIN, "CS": CS_PIN, "SDO": SDO_PIN, "SDI": SDI_PIN}
    for i in range(n):
        v = "s%d" % i
        s.append('const %s = sp.addInstance(); %s.$name = "SPI_%d"; %s["Device Mode"] = "%s"; %s.packetSize = %d; %s["SPI Mode"] = "%s";'
                 % (v, v, i, v, mode, v, bits, v, spimode))
        for name, pin in pins.items():
            if (kind == "read" and name == "SDO") or (kind == "write" and name == "SDI"):
                continue
            s.append('%s["%s Signal"] = "%d";' % (v, name, pin))
        if filt is not None:
            s.append('%s["CS Filter Cycles"] = %d;' % (v, filt))
        s.append('%s["CS Setup Time"] = %d; %s["CS Hold Time"] = %d; %s["Data Setup Time"] = %d;' % (v, setup, v, hold, v, dsetup))
        s.append('%s["sclk high pulse width (in PRU cycles)"] = %d; %s["sclk low pulse width (in PRU cycles)"] = %d;' % (v, high, v, low))
        if kind != "read":
            s.append('scripting.connect(%s, "input1", lc1, "output1");' % v)
        s.append('scripting.connect(%s, "next", %s, "prev");' % (prev, v))
        prev = v
    return "\n".join(s) + "\n"


def build(name, text, tool=REPO):
    """SysConfig + gmake + clpru. Returns (CompletedProcess, [.out paths]). `tool` is the PRU_NO_CODE_TOOL_PATH (a scratch copy for sabotage arms)."""
    work = os.path.join(BUILD_ROOT, name)
    shutil.rmtree(work, ignore_errors=True)
    fw = os.path.join(work, "firmware")
    proj = os.path.join(fw, "am243x-evm", "icss_g0_pru0_fw")
    os.makedirs(os.path.dirname(proj), exist_ok=True)
    shutil.copy(os.path.join(TEMPLATE, "main.asm"), os.path.join(fw, "main.asm"))
    shutil.copytree(os.path.join(TEMPLATE, "am243x-evm", "icss_g0_pru0_fw"), proj, ignore=shutil.ignore_patterns("generated", "syscfg"))
    with open(os.path.join(proj, "example.syscfg"), "w", encoding="utf-8", newline="") as f:
        f.write(text)
    cgt = os.path.join(proj, "ti-pru-cgt")
    env = dict(os.environ, PATH=os.path.dirname(GMAKE) + os.pathsep + os.environ.get("PATH", ""))
    res = subprocess.run([GMAKE, "-s", "all", "PRU_NO_CODE_TOOL_PATH=" + tool.replace(os.sep, "/"),
                          "MCU_HEX_PATH=" + os.path.join(work, "hex.h").replace(os.sep, "/")],
                         cwd=cgt, env=env, capture_output=True, text=True)
    gen = os.path.join(cgt, "generated")
    outs = [os.path.join(gen, f) for f in os.listdir(gen) if f.endswith(".out")] if os.path.isdir(gen) else []
    return res, outs


def text_bytes(out):
    """Bytes of every .text* section of an ELF .out."""
    d = open(out, "rb").read()
    assert d[:4] == b"\x7fELF"
    shoff = struct.unpack_from("<I", d, 0x20)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", d, 0x2E)
    secs = [struct.unpack_from("<IIIIIIIIII", d, shoff + i * shentsize) for i in range(shnum)]
    names = secs[shstrndx][4]
    total = 0
    for sec in secs:
        name = d[names + sec[0]:d.index(b"\0", names + sec[0])].decode()
        if name == ".text" or name.startswith(".text:"):
            total += sec[5]
    return total


class Idle:  # no peripheral: the blocks only drive pins and sample 0
    def tick(self, cycle, gpo):
        return 0


def trace_of(name, text, tool=REPO):
    res, outs = build(name, text, tool)
    assert res.returncode == 0 and outs, "build failed for %s -\n%s\n%s" % (name, res.stdout[-2000:], res.stderr[-1000:])
    run = elf_cosim.run_elf_closed_loop(outs[0], Idle(), max_steps=20000)
    assert run.halted, "firmware did not halt within the cycle budget"
    return run.trace


def edges(trace, pin):
    out, prev = [], None
    for cycle, gpo, _gpi in trace:
        bit = (gpo >> pin) & 1
        if prev is not None and bit != prev:
            out.append((cycle, bit))
        prev = bit
    return out


def gaps(trace, bits):
    cs, sclk = edges(trace, CS_PIN), edges(trace, SCLK_PIN)
    fall = [c for c, lvl in cs if lvl == 0]
    rise = [c for c, lvl in cs if lvl == 1]
    assert len(fall) == 1 and rise, "expected one CS assertion and a release, got CS edges %s" % cs
    during = [c for c, _ in sclk if fall[0] < c < rise[-1]]
    assert len(during) >= 2 * bits - 1, "expected the %d SCLK pulses between CS assert and release, got %d edges" % (bits, len(during))
    return during[0] - fall[0], rise[-1] - during[-1]


# ---- 1. CS is driven to its idle level once at program start -----------------------------------------------------------------------

def generated_asm(name):
    hits = glob.glob(os.path.join(BUILD_ROOT, name, "**", "*.asm"), recursive=True)
    gen = [h for h in hits if "sysconfig_generated_start:" in open(h, encoding="utf-8", errors="replace").read()]
    assert len(gen) == 1, "expected one generated asm with sysconfig_generated_start, got %s" % hits
    return open(gen[0], encoding="utf-8", errors="replace").read()


def prologue(asm):
    """The lines between sysconfig_generated_start: and the first block's label / instruction comment."""
    return asm.split("sysconfig_generated_start:", 1)[1].split(";PRU Instruction of", 1)[0]


def sabotaged_tool(name):
    """A scratch PRU_NO_CODE_TOOL_PATH whose SPI CS idle prologue emits nothing (the pre-behaviour)."""
    root = os.path.join(BUILD_ROOT, name)
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    shutil.copytree(os.path.join(REPO, ".metadata"), os.path.join(root, ".metadata"))
    for f in ("imports.mak", "pru_rules.mak"):
        shutil.copy(os.path.join(REPO, f), os.path.join(root, f))
    js = os.path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_blocks_static_module.syscfg.js")
    text = open(js, encoding="utf-8", newline="").read()
    marker = "function getSpiCsIdleSetup(modules) {"
    assert marker in text
    open(js, "w", encoding="utf-8", newline="").write(text.replace(marker, marker + " return \"\";", 1))
    return root


@needs_build
@pytest.mark.parametrize("kind", KINDS)
def test_cs_is_driven_idle_at_startup_with_no_gpo_block(kind):
    trace = trace_of("idle_" + kind, syscfg(kind, cs_idle=False))
    cs = edges(trace, CS_PIN)
    # no PRU GPO block anywhere: rise (idle level, in the prologue), fall (assertion), rise (release)
    assert [lvl for _, lvl in cs] == [1, 0, 1], "CS must rise at startup, fall at assertion, rise at release; got %s" % cs
    assert cs[0][0] <= 4, "the idle-level rise belongs to the program prologue, got cycle %d" % cs[0][0]
    assert "set     r30, r30, %d" % CS_PIN in prologue(generated_asm("idle_" + kind))


@needs_build
@pytest.mark.parametrize("kind", KINDS)
def test_without_the_prologue_emission_the_assertion_edge_is_missing(kind):
    tool = sabotaged_tool("sabotage_tool_" + kind)
    trace = trace_of("sabotaged_" + kind, syscfg(kind, cs_idle=False), tool)
    cs = edges(trace, CS_PIN)
    assert [lvl for _, lvl in cs] == [1], "sabotaged build must show only the release rise, got %s" % cs
    assert "set     r30" not in prologue(generated_asm("sabotaged_" + kind))


@needs_build
def test_peripheral_blocks_do_not_drive_cs_and_a_shared_cs_pin_is_set_once():
    build("idle_periph", syscfg("write", mode="peripheral", cs_idle=False))
    assert "set     r30" not in prologue(generated_asm("idle_periph"))
    build("idle_three", syscfg("write", n=3, cs_idle=False))
    assert prologue(generated_asm("idle_three")).count("set     r30, r30, %d" % CS_PIN) == 1


@needs_build
def test_the_incremental_spi_example_now_asserts_cs_on_its_first_transaction():
    example = os.path.join(REPO, "examples", "incremental_spi", "firmware", "am243x-lp", "icss_g0_pru0_fw", "example.syscfg")
    res, outs = build("incspi", open(example, encoding="utf-8").read())
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    assert "set     r30, r30, 5" in prologue(generated_asm("incspi"))


@pytest.mark.parametrize("kind", KINDS)
def test_docs_describe_the_idle_prologue_and_not_the_old_workaround(kind):
    text = open(DOCS % kind, encoding="utf-8").read()
    assert "driven to its idle (HIGH) level once per entry into the generated code: at program start and at every group start" in text
    assert "runt" not in text and "once-per-design init hook" not in text
    assert "3,288 bytes measured" in text and "2.8 KB" not in text


# ---- 2. fixed overhead + cap documented, and true ---------------------------------------------------------------------------------

def _documented_overhead(kind):
    text = open(DOCS % kind, encoding="utf-8").read()
    section = text.split(SECTION, 1)[1].split("\n###", 1)[0]
    table = {}
    for modes, setup, hold in re.findall(r"^\| ((?:MODE\d(?:, )?)+|any \(MODE0-3\)) \| \+(\d+) \| \+(\d+) \|", section, re.M):
        for m in (MODES if modes.startswith("any") else modes.split(", ")):
            table[m] = (int(setup), int(hold))
    return table


@pytest.mark.parametrize("kind", KINDS)
def test_docs_publish_the_overhead_table_for_every_mode(kind):
    assert sorted(_documented_overhead(kind)) == sorted(MODES)


@needs_build
@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("spimode", MODES)
def test_documented_fixed_overhead_is_what_the_simulator_measures(kind, spimode):
    want = _documented_overhead(kind)[spimode]
    got = gaps(trace_of("ov_%s_%s" % (kind, spimode), syscfg(kind, spimode=spimode, setup=0, hold=0)), 16)
    assert got == want, "%s %s: measured (setup, hold) overhead %s, docs say %s" % (kind, spimode, got, want)


@needs_build
@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("bits", [8, 32])
def test_overhead_does_not_depend_on_the_packet_size(kind, bits):
    got = gaps(trace_of("ovbits_%s_%d" % (kind, bits), syscfg(kind, spimode="MODE0", bits=bits, setup=0, hold=0)), bits)
    assert got == _documented_overhead(kind)["MODE0"]


@needs_build
def test_the_256_cycle_cap_is_enforced_as_documented():
    res, outs = build("cap_ok", syscfg("write", setup=1280, hold=1280))      # 256 cycles at 200 MHz: allowed
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    res, outs = build("cap_over", syscfg("write", setup=1300, hold=0))       # 260 cycles
    assert res.returncode != 0 and not outs
    assert "CS Setup Time of 1300 ns is 260 PRU cycles" in res.stdout + res.stderr
    assert "the limit is 256 PRU cycles" in res.stdout + res.stderr


def test_docs_release_note_states_the_default_cycles_the_blocks_now_emit():
    # defaults of the three blocks (ns): read 35/10, write 10/10, transfer 35/10; at 200 MHz ceil(ns * 0.2)
    for kind, (setup_ns, hold_ns) in {"read": (35, 10), "write": (10, 10), "transfer": (35, 10)}.items():
        text = open(DOCS % kind, encoding="utf-8").read()
        assert RELEASE_NOTE in text
        note = text.split(RELEASE_NOTE, 1)[1].split("\n\n", 1)[0]
        assert "%d ns setup, %d ns hold" % (setup_ns, hold_ns) in note
        want = "now emit %d and %d cycles instead of %d and %d" % (-(-setup_ns // 5), -(-hold_ns // 5), setup_ns, hold_ns)
        assert want in note, "%s: release note should say '%s', has: %s" % (kind, want, note)


# ---- 3. IRAM budget ---------------------------------------------------------------------------------------------------------------

MAXED = dict(setup=1280, hold=1280, dsetup=100, high=100, low=100)       # CS times at the 256-cycle cap, widest data / pulse delays
WARN = re.compile(r"The (\d+) SPI block\(s\) in this design need an estimated (\d+) bytes of program memory \(IRAM\), over the 12288 bytes")


@needs_build
def test_overflowing_design_warns_and_the_estimate_bounds_the_linked_text():
    res, outs = build("iram_six", syscfg("transfer", n=6, **MAXED))
    out = res.stdout + res.stderr
    m = WARN.search(out)
    assert m, "no IRAM budget warning for six maxed SPI blocks:\n" + out[-2500:]
    assert m.group(1) == "6"
    estimate = int(m.group(2))
    # the linker is the final word: the same design does not fit, and says how large .text is
    assert not outs and "program will not fit into available memory" in out, out[-2500:]
    actual = int(re.search(r'section "\.text" size 0x([0-9a-f]+)', out).group(1), 16)
    assert actual > 12 * 1024
    assert actual <= estimate <= actual * 1.05, "estimate %d must be an upper bound of the linked .text %d and within 5%%" % (estimate, actual)


@needs_build
def test_fitting_design_does_not_warn_and_the_estimate_still_bounds_text():
    res, outs = build("iram_two", syscfg("transfer", n=2, **MAXED))
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    assert not WARN.search(res.stdout + res.stderr)
    # the same per-block bound, read from the warning of a design that does overflow: the estimate is linear in the block count
    six = WARN.search(build("iram_six_b", syscfg("transfer", n=6, **MAXED))[0].stdout)
    assert six
    assert text_bytes(outs[0]) <= int(six.group(2)) / 3 <= text_bytes(outs[0]) * 1.05


def estimate_of(inst):
    """estimateIramBytes of the shipped pru_spi_timing.js for one instance (a plain dict of the SysConfig settings), run under node."""
    js = os.path.join(REPO, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_spi_timing.js")
    script = ("const vm=require('vm'),fs=require('fs');const ctx={system:{modules:{}},exports:{}};vm.createContext(ctx);"
              "vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),ctx);"
              "console.log(ctx.exports.estimateIramBytes(JSON.parse(process.argv[2])));")
    out = subprocess.run(["node", "-e", script, js, json.dumps(inst)], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


MAXED_BLOCK_TEXT = 3288      # bytes of .text one maxed controller block links to (the docs quote this number)


@needs_build
@pytest.mark.parametrize("kind", KINDS)
def test_one_maxed_block_links_to_the_documented_text_size(kind):
    res, outs = build("iram_one_" + kind, syscfg(kind, n=1, **MAXED))
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    # the whole design is the block plus a Load Constant and a PRU GPO: a few words over the block's own 3288 B
    assert MAXED_BLOCK_TEXT <= text_bytes(outs[0]) <= MAXED_BLOCK_TEXT + 16, text_bytes(outs[0])


@needs_build
@pytest.mark.parametrize("filt", [100, 255])
def test_peripheral_estimate_bounds_the_linked_text(filt):
    # the CS glitch filter unrolls `.loop CS_FILTER_CYCLES` at two sites: each filter cycle is 8 bytes of .text per peripheral block
    res, outs = build("iram_periph_%d" % filt, syscfg("transfer", n=3, mode="peripheral", filt=filt))
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    actual = text_bytes(outs[0])
    estimate = 3 * estimate_of({"Device Mode": "peripheral", "CS Filter Cycles": filt})
    assert actual <= estimate <= actual * 1.05, "estimate %d must bound the linked .text %d within 5%%" % (estimate, actual)


@needs_build
def test_six_peripheral_blocks_at_the_widest_filter_warn():
    res, outs = build("iram_periph_six", syscfg("transfer", n=6, mode="peripheral", filt=255))
    out = res.stdout + res.stderr
    m = WARN.search(out)
    assert m, "no IRAM budget warning for six peripheral blocks at CS Filter Cycles 255:" + out[-2500:]
    estimate = int(m.group(2))
    actual = int(re.search(r'section "\.text" size 0x([0-9a-f]+)', out).group(1), 16)
    assert not outs and actual > 12 * 1024
    assert actual <= estimate <= actual * 1.05, "estimate %d must bound the linked .text %d within 5%%" % (estimate, actual)


@needs_build
def test_few_peripheral_blocks_at_a_small_filter_do_not_warn():
    res, outs = build("iram_periph_small", syscfg("transfer", n=6, mode="peripheral", filt=10))
    assert res.returncode == 0 and outs, (res.stdout + res.stderr)[-1500:]
    assert not WARN.search(res.stdout + res.stderr)
