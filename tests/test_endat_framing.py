"""EnDat decodes end to end - real clpru ELF against the cited model.

The macro and the pru-simulator EnDat model were both rewritten to one framing,
every point cited to HEIDENHAIN "EnDat 2.2" Technical Information ID 383942 and
to TI's shipping EnDat driver (docs/endat-crc-provenance.md has the table).

Evidence is the real clpru ELF on TI pru-simulator. EnDat is ported:false in the
SysConfig sim front door, so `gmake sim` cannot bind it; as in the block
is generated from a one-block design with the real SysConfig CLI, built with
clpru, and run closed-loop against pru-simulator's pru_io.endat_encoder through
pru_io.rs485_transceiver (CLOCK R30.0, TX R30.1, DE R30.3, RX R31.2 - the TI
endat_out / endat_out_en / endat_in split).

Each framing point the macro changed has a red arm: a scratch tool root whose
block has that one point put back, which must fail with the stated text.
"""
import inspect
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

SIM = Path(os.environ.get("PRU_SIMULATOR_PATH", ""))
SYSCONFIG_NODE = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe"))
SYSCONFIG_CLI = Path(str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js"))
SCRATCH = ROOT / ".tmp" / "v179"
BLOCK = Path(".metadata/sysconfig/.meta/pru_blocks/application_specific/endat_initiator_block.syscfg.js")

pytestmark = pytest.mark.skipif(
    not (SIM.is_dir() and (SIM / "simulator.py").exists()
         and Path(str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe")).exists()
         and SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists()),
    reason="needs SysConfig 1.28, clpru, and PRU_SIMULATOR_PATH",
)

CLK, TX, RX, DE = 0, 1, 2, 3
POSITIONS = [1, 3, 8346161, 0x400001]     # odd, and 0x400001 has the 23-bit MSB set
STATUS_NAMES = {0: "CRC error", 1: "no start bit", 2: "F1 error 1", 3: "error 2"}


# --- build ----------------------------------------------------------------------------


def _scratch_root(name, edit=None):
    """Copy of the tool root with the EnDat block source edited."""
    root = SCRATCH / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for d in (".metadata", "scripts", "perif", "core", "pru_io"):
        if (ROOT / d).is_dir():
            shutil.copytree(ROOT / d, root / d, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
    if edit is not None:
        p = root / BLOCK
        p.write_bytes(edit(p.read_bytes().decode("utf-8").replace("\r\n", "\n")).encode("utf-8"))
    return root


def _swap(text, old, new, count=1):
    assert text.count(old) == count, (old, text.count(old))
    return text.replace(old, new)


def _sysconfig(root, work, script, out):
    env = dict(os.environ)
    return subprocess.run(
        [str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(root / ".metadata" / "product.json"),
         "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
         "--script", str(script), "--context", "icss_g0_pru0", "--output", str(out)],
        cwd=root, env=env, text=True, capture_output=True)


_BUILT = {}


def build(root, name, settings=""):
    """SysConfig CLI + clpru for a one-block EnDat design; returns the ELF path."""
    key = (str(root), name, settings)
    if key in _BUILT:
        return _BUILT[key]
    work = SCRATCH / ("w_" + name)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    script = work / "endat.syscfg"
    script.write_text(
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01\n'
        'const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);\n'
        'const m = scripting.addModule("/pru_blocks/application_specific/endat_initiator_block", {}, false);\n'
        'const inst = m.addInstance();\ninst.$name = "BLOCK_0";\n' + settings, encoding="utf-8")
    out = work / "out"
    r = _sysconfig(root, work, script, out)
    assert r.returncode == 0 and "Generating Code" in r.stdout, r.stdout + r.stderr
    (out / "main.asm").write_text(
        "    .retain\n    .retainrefs\n    .global     main\n    .ref        sysconfig_generated_start\n"
        '    .sect       ".text:main"\nmain:\n    jmp     sysconfig_generated_start\n'
        "    .global sysconfig_generated_end\nsysconfig_generated_end:\n    halt\n", encoding="utf-8")
    (out / "link.cmd").write_text(elf_cosim.LINKER_CMD, encoding="utf-8")
    for args in (["--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"],
                 ["--silicon_version=4", "-z", "pru_syscfg.obj", "main.obj", "link.cmd",
                  "--entry_point=main", "-o", "main.out"]):
        r = subprocess.run([elf_cosim.find_clpru()] + args, cwd=out, text=True, capture_output=True)
        assert r.returncode == 0, r.stdout + r.stderr
    _BUILT[key] = out / "main.out"
    return _BUILT[key]


# --- closed loop ----------------------------------------------------------------------


class _DirectAdapter:
    """Pre-simulators have no RS-485 transceiver: this is adapter (TX straight onto the model's DATA pin, its drive onto RX). Kept
    only so this same file can be run against base sim 5822615 for the red
    evidence; with a current simulator it is never used."""

    def __init__(self, model):
        self.model = model

    def tick(self, cycle, gpo):
        mask, value = self.model.tick(cycle, gpo & 0b11)
        return (1 if not (mask & 0b10) else (value >> 1) & 1) << RX

    def faults(self):
        return list(self.model.faults())

    def events(self):
        return list(self.model.events())


@dataclass
class Run:
    res: int
    status: int
    halted: bool
    cycles: int = 0
    faults: list = field(default_factory=list)
    events: list = field(default_factory=list)


def run(elf, position, position_bits=23, **model_kw):
    with elf_cosim._sim_namespace(elf_cosim.find_pru_simulator()):
        from pru_io.endat_encoder import EndatEncoder
        kw = dict(position_bits=position_bits, position=position, calc_cycles=1000,
                  min_half_period_cycles=50, recovery_cycles=2000)
        kw.update(model_kw)
        accepted = inspect.signature(EndatEncoder).parameters
        model = EndatEncoder(clock_pin=CLK, data_pin=1,
                             **{k: v for k, v in kw.items() if k in accepted})
        try:
            from pru_io.rs485_transceiver import Rs485Transceiver
            dev = Rs485Transceiver(model, line_pin=1, tx_pin=TX, de_pin=DE, rx_pin=RX,
                                   passthrough=(CLK,))
        except ImportError:
            dev = _DirectAdapter(model)
    return _run_dev(elf, dev)


def _run_dev(elf, dev):
    result = elf_cosim.run_elf_closed_loop(str(elf), dev, max_steps=60000)
    return Run(res=result.registers[0], status=result.registers[29] & 0xFF,
               halted=result.halted, cycles=result.cycles, faults=dev.faults(),
               events=dev.events())


def decode(res, total_bits=30, error_bits=1, position_bits=23):
    """RES (MSB = start bit) -> position. The position is LSB first on the wire
    (H p.8), so P_i sits at bit total_bits-2-error_bits-i."""
    top = total_bits - 2 - error_bits
    return sum(((res >> (top - i)) & 1) << i for i in range(position_bits))


def assert_decoded(r, position, total_bits=30, error_bits=1):
    problems = []
    if not r.halted:
        problems.append("firmware did not halt")
    if r.status:
        names = ", ".join(STATUS_NAMES[b] for b in range(4) if r.status >> b & 1)
        problems.append(f"firmware status {r.status:#x} ({names})")
    if r.faults:
        problems.append(f"model faults {r.faults}")
    got = decode(r.res, total_bits, error_bits)
    if got != position:
        problems.append(f"decoded {got} != {position} (RES {r.res:#010x})")
    assert not problems, "EnDat decode failed: " + "; ".join(problems)


# --- green ------------------------------------------------------------------------------


@pytest.mark.parametrize("position", POSITIONS)
def test_endat_decodes_odd_positions_through_the_real_elf(position):
    assert position & 1
    r = run(build(ROOT, "green"), position)
    assert_decoded(r, position)
    assert r.res >> 29 == 1, "start bit is RES bit 29"
    cmds = [e["cmd"] for e in r.events if e["kind"] == "mode_command"]
    assert cmds == [0b000111], r.events


@pytest.mark.parametrize("position", [1, 8346161])
def test_endat22_position_command_decodes_with_f2(position):
    elf = build(ROOT, "green22", "inst.modeCommand = 56;\ninst.totalBits = 31;\n")
    r = run(elf, position)
    assert_decoded(r, position, total_bits=31, error_bits=2)
    assert [e["cmd"] for e in r.events if e["kind"] == "mode_command"] == [0b111000]


def test_error_flags_reach_the_status_byte():
    """Control for the status bits the decode arms rely on: error 1 sets bit2,
    error 2 (sent inverted) sets bit3, and the CRC still passes."""
    elf = build(ROOT, "green22", "inst.modeCommand = 56;\ninst.totalBits = 31;\n")
    r = run(elf, 3, error1=True, error2=True)
    assert r.status == 0b1100, hex(r.status)
    assert decode(r.res, 31, 2) == 3


# --- red: one framing point put back at a time ------------------------------------------

TX_BIT = "`    qbbc  m_endat_tx0?, TEMP_REG3, 5`,"
TX_SHIFT = "`    lsl   TEMP_REG3, TEMP_REG3, 1`,"
CRC_XOR = "xor   TEMP_REG1, TEMP_REG1, 0x0B"
CRC_INIT = "`    ldi   TEMP_REG1, 0x1F                    ; crc accumulator, all ones`,"
HUNT = "`    qbbs  m_endat_sbok?, R31, DATA_RX_PIN  ; sample at the rising edge`,"
DE_OFF = "`    clr   R30, R30, DATA_TX_PIN`,\n            `    clr   R30, R30, DATA_EN_PIN`,\n            `    ldi   TEMP_REG4.w0, TRT_CYCLES`,"

RED = {
    # bit order: mode command LSB first (the pre-macro)
    "lsb_first_command": lambda t: _swap(_swap(t, TX_BIT, TX_BIT.replace(", 5`", ", 0`")),
                                         TX_SHIFT, TX_SHIFT.replace("lsl", "lsr")),
    # CRC polynomial x^5+x^3+1 (the pre-macro)
    "crc_poly_x5_x3_1": lambda t: _swap(t, CRC_XOR, "xor   TEMP_REG1, TEMP_REG1, 0x09", count=2),
    # CRC preset 0 (the pre-macro)
    "crc_init_zero": lambda t: _swap(t, CRC_INIT, CRC_INIT.replace("0x1F", "0   ")),
    # start bit 0 instead of 1
    "start_bit_zero": lambda t: _swap(t, HUNT, HUNT.replace("qbbs", "qbbc")),
    # no start-bit hunt: take the first post-command clock as the start bit (the
    # fixed-alignment assumption behind the pre- 3/4-bit RES offset)
    "no_start_bit_hunt": lambda t: _swap(t, HUNT, "`    qba   m_endat_sbok?`,"),
    # never release the line after the mode command
    "de_held": lambda t: _swap(t, DE_OFF, DE_OFF.replace(
        "`    clr   R30, R30, DATA_EN_PIN`,\n            ", "")),
}


def red_run(name, position=1):
    elf = build(_scratch_root(name, RED[name]), name)
    return run(elf, position)


def test_red_lsb_first_command_is_read_as_the_endat22_command():
    r = red_run("lsb_first_command")
    assert [e["cmd"] for e in r.events if e["kind"] == "mode_command"] == [0b111000], r.events
    with pytest.raises(AssertionError, match=r"firmware status 0x1 \(CRC error\).*decoded \d+ != 1"):
        assert_decoded(r, 1)


@pytest.mark.parametrize("name", ["crc_poly_x5_x3_1", "crc_init_zero"])
def test_red_wrong_crc_rejects_a_correct_frame(name):
    """Position and model are fine - only the firmware's CRC is wrong."""
    r = red_run(name)
    assert decode(r.res) == 1 and r.faults == []
    with pytest.raises(AssertionError, match=r"^EnDat decode failed: firmware status 0x1 \(CRC error\)\n"):
        assert_decoded(r, 1)


def test_red_start_bit_zero_misaligns_the_frame():
    r = red_run("start_bit_zero")
    with pytest.raises(AssertionError, match=r"firmware status 0x\d \(CRC error.*decoded \d+ != 1"):
        assert_decoded(r, 1)


def test_red_no_start_bit_hunt_reads_tcal_as_data():
    r = red_run("no_start_bit_hunt")
    with pytest.raises(AssertionError, match=r"firmware status 0x1 \(CRC error\); model faults "
                       r".*transfer abandoned in phase reply.*decoded 640 != 1"):
        assert_decoded(r, 1)


def test_red_de_held_contends_with_the_encoder():
    r = red_run("de_held")
    with pytest.raises(AssertionError, match=r"RS-485 contention - PRU DE=1 while the device drives the line"):
        assert_decoded(r, 1)


def test_red_wrong_lead_in_misframes_the_command():
    """t1Clocks=3 instead of the 2T lead-in (H p.8)."""
    r = run(build(ROOT, "lead3", "inst.t1Clocks = 3;\n"), 1)
    with pytest.raises(AssertionError,
                       match=r"firmware status 0x2 \(no start bit\).*mode command redundancy error"):
        assert_decoded(r, 1)


def test_red_clock_faster_than_2mhz_faults_the_model():
    r = run(build(ROOT, "hp20", "inst.halfPeriodCycles = 20;\n"), 1)
    with pytest.raises(AssertionError, match=r"clock half period \d+ < min 50"):
        assert_decoded(r, 1)


# --- recovery time ------------------------------------------------------------------------

TM_CYCLES = 2000      # 10 us at 200 MHz, the low end of tm (H p.8)


def assert_waits_recovery(r):
    done = [e["cycle"] for e in r.events if e["kind"] == "reply_done"]
    assert len(done) == 1, r.events
    gap = r.cycles - done[0]
    assert gap >= TM_CYCLES, f"firmware returned {gap} cycles after the CRC, < tm {TM_CYCLES}"


def test_firmware_holds_the_clock_high_for_the_recovery_time():
    """The block may not start another transfer inside tm: it holds CLOCK high
    for trecCycles before returning (the model faults a falling edge inside tm)."""
    assert_waits_recovery(run(build(ROOT, "green"), 1))


def test_red_short_trec_returns_inside_the_recovery_time():
    r = run(build(ROOT, "trec500", "inst.trecCycles = 500;\n"), 1)
    with pytest.raises(AssertionError, match=r"firmware returned \d+ cycles after the CRC, < tm 2000"):
        assert_waits_recovery(r)


# --- start-bit hunt: dead and stuck lines ---------------------------------------------------


class _FixedLine:
    """Stand-in for an absent / faulty encoder: RX is a constant level."""

    def __init__(self, level):
        self.level = level

    def tick(self, cycle, gpo):
        return self.level << RX

    def faults(self):
        return []

    def events(self):
        return []


def test_dead_line_reports_no_start_bit_within_the_timeout():
    """An all-zero line never shows a start bit: the hunt gives up after
    timeoutCycles clocks with status bit1 only, RES 0, and the block halts."""
    r = _run_dev(build(ROOT, "green"), _FixedLine(0))
    assert r.halted
    assert r.status == 0b0010, f"dead line: status {r.status:#x}, expected 0x2 (no start bit)"
    assert r.res == 0


def test_stuck_high_line_reads_as_crc_and_f1_not_no_start_bit():
    """A line stuck HIGH (what an absent encoder behind a fail-safe RS-485
    transceiver looks like) is an immediate start bit followed by all ones:
    CRC error + F1, NOT bit1."""
    r = _run_dev(build(ROOT, "green"), _FixedLine(1))
    assert r.halted
    assert r.status == 0b0101, f"stuck-high line: status {r.status:#x}, expected 0x5 (CRC error + F1)"
    assert r.res == 0x3FFFFFFF
    assert not r.status & 0b0010


def test_red_without_the_timeout_branch_a_dead_line_is_not_reported():
    """Arming proof for the dead-line arm: delete the timeout exit from the macro
    and the same arm must now fail (status is no longer 0x2)."""
    elf = build(_scratch_root("no_timeout", lambda t: _swap(t, NO_START, "")), "no_timeout")
    r = _run_dev(elf, _FixedLine(0))
    with pytest.raises(AssertionError, match="dead line: status"):
        assert r.halted and r.status == 0b0010, f"dead line: status {r.status:#x}, expected 0x2 (no start bit)"


NO_START = ("`    or    TEMP_REG2.b0, TEMP_REG2.b0, 2  ; no start bit: framing error, the checks are skipped`,\n"
            "            `    qba   m_endat_stop?`,\n")


# --- pin collisions are rejected by validate() ----------------------------------------------


def _validate(name, settings):
    work = SCRATCH / ("v_" + name)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    script = work / "endat.syscfg"
    script.write_text(
        '// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 '
        '--product PRU_NO_CODE_TOOL@01.00.01\n'
        'const common = scripting.addModule("/pru_blocks/common/pru_blocks_static_module", {}, false);\n'
        'const m = scripting.addModule("/pru_blocks/application_specific/endat_initiator_block", {}, false);\n'
        'const inst = m.addInstance();\ninst.$name = "BLOCK_0";\n' + settings, encoding="utf-8")
    r = _sysconfig(ROOT, work, script, work / "out")
    return r.returncode, r.stdout + r.stderr


COLLISION = "clkPin, dataTxPin, dataEnPin and dataRxPin must all differ"


@pytest.mark.parametrize("name,settings", [
    ("tx_eq_rx", "inst.dataTxPin = 2;\ninst.dataRxPin = 2;\n"),
    ("de_eq_rx", "inst.dataEnPin = 2;\n"),
    ("de_eq_tx", "inst.dataEnPin = 1;\n"),
    ("de_eq_clk", "inst.dataEnPin = 0;\n"),
])
def test_red_pin_collisions_are_rejected(name, settings):
    code, out = _validate(name, settings)
    assert code != 0 and COLLISION in out, out


def test_distinct_pins_pass_validation():
    code, out = _validate("distinct", "inst.dataEnPin = 5;\n")
    assert code == 0 and COLLISION not in out, out
