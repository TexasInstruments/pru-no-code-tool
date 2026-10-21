"""PWM block follow-up checks (S1-S5).

S1/F5  design-level golden for a default pwm design (SysConfig CLI, digest line stripped).
S2     a counted pwm_block hands control on, so a same-pin GPO after it is not a duplicate driver
       (CI script and the SysConfig GUI warning agree); a default pwm_block still is.
S3     a counted pwm_block scales noOfCycles by N, so the generated header is not a false 5 cycles.
S4     the pwm_block longDescription says what the exit code does (compare events disabled).
M1     a counted pwm_block with 0 duty counts never ends, so validate() rejects it (forever mode untouched).
S-1    the golden also pins the generated pru_syscfg.inc (the default macro body).
S-2    the classifier's verification of a counted macro is itself tested on a fixture.
S5     encoder_speed_block / hall_block / quadrature_block stay continuous (no bound added).
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
PRODUCT = ROOT / ".metadata" / "product.json"
CHECK_PIN = ROOT / "scripts" / "check_pin_collisions.js"
GOLDEN = ROOT / "tests" / "golden" / "default_pwm.asm"
GOLDEN_INC = ROOT / "tests" / "golden" / "default_pwm.inc"
PWM_JS = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "pwm_block.syscfg.js"

have_syscfg = SYSCONFIG_NODE.exists() and SYSCONFIG_CLI.exists() and shutil.which("node") is not None
needs_syscfg = pytest.mark.skipif(not have_syscfg, reason="SysConfig CLI and node are required")

HEADER = """/**
 * @cliArgs --device "AM243x_ALV_beta" --package "ALV" --part "ALV" --context "icss_g0_pru0" --product "PRU_NO_CODE_TOOL@01.00.01"
 */
"""
DUP_GPO = re.compile(r"GPO 5 is driven by both 'PWM_A' \(pwm_block\) and 'MARK1' \(pru_gpo_block\)")


def pwm_then_gpo(count):
    """PWM_A (pin 5) -> MARK1 (CLR R30,5 on the SAME pin); `count` None = default continuous pwm."""
    lines = [
        'const mod_pwm = scripting.addModule("/pru_blocks/pru_io_blocks/pwm_block", {}, false);',
        'const mod_gpo = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);',
        'const a = mod_pwm.addInstance(); a.$name = "PWM_A"; a.periodNs = 1000; a.dutyPct = 40; a.pin = "5";'
        + (f" a.periodCount = {count};" if count else ""),
        'const g = mod_gpo.addInstance(); g.$name = "MARK1"; g.constant1 = "R30, 5"; g.opCode = "CLR";',
    ]
    if count:
        lines.append('scripting.connect(a, "next", g, "prev");')
    return HEADER + "\n".join(lines) + "\n"


def generate(tmp_path, text, name="d"):
    syscfg = tmp_path / f"{name}.syscfg"
    syscfg.write_text(text, encoding="utf-8")
    env = os.environ.copy()
    for k in ("local", "roaming"):
        (tmp_path / k).mkdir(exist_ok=True)
    out = tmp_path / f"{name}_out"
    r = subprocess.run([str(SYSCONFIG_NODE), str(SYSCONFIG_CLI), "--product", str(PRODUCT),
                        "--script", str(syscfg), "-o", str(out)],
                       cwd=ROOT, env=env, capture_output=True, text=True)
    return syscfg, out, r.stdout + r.stderr


def pin_check(syscfg):
    return subprocess.run(["node", str(CHECK_PIN), str(syscfg)], cwd=ROOT, capture_output=True, text=True)


# ---- S2 -------------------------------------------------------------------------------------

@needs_syscfg
def test_s2_counted_pwm_then_same_pin_gpo_passes_ci_and_gui(tmp_path):
    syscfg, _out, log = generate(tmp_path, pwm_then_gpo(2))
    assert not re.search(r"[1-9]\d* error", log.lower()), log
    assert not DUP_GPO.search(log), "GUI flags a counted pwm + same-pin GPO as a duplicate driver:\n" + log
    r = pin_check(syscfg)
    assert r.returncode == 0, r.stdout + r.stderr


@needs_syscfg
def test_s2_default_pwm_with_same_pin_gpo_stays_an_error(tmp_path):
    syscfg, _out, log = generate(tmp_path, pwm_then_gpo(None))
    assert DUP_GPO.search(log), log
    r = pin_check(syscfg)
    assert r.returncode != 0 and "duplicate GPO drivers" in r.stdout + r.stderr, r.stdout + r.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
def test_s2_instance_classifier_follows_period_count():
    script = """const c=require('./scripts/block_control_flow');
console.log(JSON.stringify([c.classifyInstance('pwm_block',{}).cls,
  c.classifyInstance('pwm_block',{periodCount:0}).cls,
  c.classifyInstance('pwm_block',{periodCount:3}).cls,
  c.classifyInstance('three_phase_pwm_block',{}).cls,
  c.classifyInstance('hall_block',{periodCount:3}).cls]));"""
    out = subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True)
    assert json.loads(out) == ["continuous", "continuous", "sequential", "sequential", "continuous"]


# ---- S3 -------------------------------------------------------------------------------------

PEAK = re.compile(r"; OVERALL PEAK CYCLES: (\d+) cycles")


def peak_of(out):
    m = PEAK.search((out / "pru_syscfg.asm").read_text(errors="replace"))
    assert m, "no OVERALL PEAK CYCLES header"
    return int(m.group(1))


@needs_syscfg
def test_s3_counted_pwm_header_peak_covers_the_run(tmp_path):
    # periodNs 1000 @ 200 MHz = 200 IEP counts; the simulator measures ~400 cycles per period
    #, so N=2 runs ~800 cycles. The header must not claim a tiny worst case.
    _s, out, log = generate(tmp_path, pwm_then_gpo(2))
    assert peak_of(out) >= 2 * 400, log


@needs_syscfg
@pytest.mark.parametrize("count", [1, 2, 5])
def test_s3_header_peak_bounds_the_run_measured_in_the_ti_simulator(tmp_path, count):
    """The oracle is the real clpru ELF in the TI pru-simulator, not the JS formula."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts" / "sim"))
    import elf_cosim

    class Idle:
        def tick(self, _cycle, _pins):
            return 0

    # periodNs 1000 @ 200 MHz = 200 counts: the same PERIOD_COUNTS/ARGs the block generates.
    spec = dict(block="pwm_block", subdir="pru_io_blocks", macroCall="m_pwm_run_counted",
                macroArgs=dict(RES="R0", PIN="5", PERIOD_COUNTS="200", DUTY_COUNTS="80", ACTIVE_HIGH="1",
                               EN_COMP="0", COMP_PIN="6", DEADBAND_COUNTS="4", PERIOD_COUNT=str(count)),
                postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, f"s3_{count}", str(tmp_path))
    result = elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=6000)
    assert result.halted
    _s, out, _ = generate(tmp_path, pwm_then_gpo(count))
    assert peak_of(out) >= result.cycles, (peak_of(out), result.cycles)


@needs_syscfg
def test_s3_counted_pwm_peak_scales_with_n(tmp_path):
    _s, out2, _ = generate(tmp_path, pwm_then_gpo(2), "n2")
    _s, out5, _ = generate(tmp_path, pwm_then_gpo(5), "n5")
    assert peak_of(out5) > peak_of(out2) > 5


@needs_syscfg
def test_s3_default_pwm_noofcycles_is_unchanged(tmp_path):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('pwm_block','pru_io_blocks');
const i=Object.fromEntries(m.config.map(c=>[c.name,c.default]));
const c=m.config.find(c=>c.name==='noOfCycles');console.log(c.getValue(i));"""
    assert int(subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True)) == 1


# ---- S4 -------------------------------------------------------------------------------------

def test_s4_pwm_doc_does_not_claim_the_iep_is_disabled():
    src = PWM_JS.read_text(encoding="utf-8")
    assert "the IEP is disabled" not in src
    assert "compare events are disabled" in src


def test_s3_three_phase_pwm_doc_does_not_claim_the_iep_is_disabled():
    src = (PWM_JS.parent / "three_phase_pwm_block.syscfg.js").read_text(encoding="utf-8")
    assert "the IEP is disabled" not in src
    assert "compare events are disabled after the last" in src


# ---- S1 / F5 --------------------------------------------------------------------------------

def strip_digest(text):
    return "\n".join(ln for ln in text.replace("\r\n", "\n").split("\n")
                     if not ln.startswith("; PRU_DESIGN_DIGEST"))


DEFAULT_PWM = HEADER + ('const mod_pwm = scripting.addModule("/pru_blocks/pru_io_blocks/pwm_block", {}, false);\n'
                        'const a = mod_pwm.addInstance(); a.$name = "PWM_A"; a.periodNs = 1000; a.dutyPct = 40; a.pin = "5";\n')


@needs_syscfg
def test_s1_default_pwm_design_asm_and_inc_match_golden(tmp_path):
    """Pins the call site (pru_syscfg.asm) AND the default macro body (pru_syscfg.inc).

    Regenerate both goldens, only after reviewing the diff, with (repo root, SysConfig 1.28 CLI;
    the .syscfg is DEFAULT_PWM above, written to d.syscfg):
        node C:/ti/sysconfig_1.28.0/dist/cli.js --product .metadata/product.json --script d.syscfg -o out
        copy out/pru_syscfg.asm tests/golden/default_pwm.asm
        copy out/pru_syscfg.inc tests/golden/default_pwm.inc
    (the volatile "; PRU_DESIGN_DIGEST" line is stripped before comparing, so it may stay in the files).
    """
    _s, out, log = generate(tmp_path, DEFAULT_PWM)
    got = (out / "pru_syscfg.asm").read_text(errors="replace")
    assert "PRU_DESIGN_DIGEST" in got  # the line exists; only its hash is volatile
    assert strip_digest(got) == strip_digest(GOLDEN.read_text(encoding="utf-8")), log
    got_inc = (out / "pru_syscfg.inc").read_text(errors="replace")
    assert GOLDEN_INC.exists(), "inc golden missing"
    assert strip_digest(got_inc) == strip_digest(GOLDEN_INC.read_text(encoding="utf-8")), log


# ---- M1 -------------------------------------------------------------------------------------

def validation_errors(**cfg):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule('pwm_block','pru_io_blocks');
const inst=Object.fromEntries(m.config.map(c=>[c.name,c.default]));
Object.assign(inst, JSON.parse(process.argv[1]));
const errs=[]; m.validate(inst,{logError:(msg,i,f)=>errs.push([msg,f]),logWarning(){},logInfo(){}});
console.log(JSON.stringify(errs));"""
    out = subprocess.check_output(["node", "-e", script, json.dumps(cfg)], cwd=ROOT, text=True)
    return json.loads(out)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
@pytest.mark.parametrize("cfg", [dict(periodNs=1000, dutyPct=0, periodCount=2),
                                 dict(periodNs=5, dutyPct=40, periodCount=1)])
def test_m1_counted_pwm_with_zero_duty_counts_is_rejected_by_name(cfg):
    errs = validation_errors(**cfg)
    assert len(errs) == 1, errs
    msg, field = errs[0]
    assert "duty count" in msg and "dutyPct" in msg and "periodNs" in msg, msg
    assert field == "dutyPct"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
@pytest.mark.parametrize("cfg", [dict(periodNs=1000, dutyPct=0, periodCount=0),
                                 dict(periodNs=5, dutyPct=40, periodCount=0),
                                 dict(periodNs=1000, dutyPct=0.5, periodCount=2)])
def test_m1_same_configs_stay_accepted_in_forever_mode_and_one_count_is_accepted(cfg):
    assert validation_errors(**cfg) == []


@needs_syscfg
@pytest.mark.parametrize("count", [1, 2])
def test_m1_boundary_one_duty_count_halts_within_the_header_budget(tmp_path, count):
    """periodNs 1000 / dutyPct 0.5 -> DUTY_COUNTS = 1, the smallest accepted: it must really end."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts" / "sim"))
    import elf_cosim

    class Idle:
        def tick(self, _cycle, _pins):
            return 0

    spec = dict(block="pwm_block", subdir="pru_io_blocks", macroCall="m_pwm_run_counted",
                macroArgs=dict(RES="R0", PIN="5", PERIOD_COUNTS="200", DUTY_COUNTS="1", ACTIVE_HIGH="1",
                               EN_COMP="0", COMP_PIN="6", DEADBAND_COUNTS="4", PERIOD_COUNT=str(count)),
                postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, f"m1_{count}", str(tmp_path))
    result = elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=6000)
    assert result.halted, "a counted pwm with DUTY_COUNTS 1 must terminate"
    text = pwm_then_gpo(count).replace("a.dutyPct = 40;", "a.dutyPct = 0.5;")
    syscfg, out, log = generate(tmp_path, text)
    assert not re.search(r"[1-9]\d* error", log.lower()), log
    assert result.cycles <= peak_of(out), (result.cycles, peak_of(out))


# ---- S-2 ------------------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
def test_s2_bound_verification_fails_closed_on_a_macro_that_never_returns(tmp_path):
    """A fixture copy of pwm_block whose counted macro loops back unconditionally: a bound config must
    classify as continuous, not sequential, even though its ports() declare a next port."""
    src = PWM_JS.read_text(encoding="utf-8")
    assert "qbne  pw_l?, TEMP_REG2, 0" in src
    fixture = tmp_path / "pwm_never_returns.syscfg.js"
    fixture.write_text(src.replace("qbne  pw_l?, TEMP_REG2, 0", "qba   pw_l?"), encoding="utf-8")
    script = """const c=require('./scripts/block_control_flow');
const f=process.argv[1];
console.log(JSON.stringify([c.classifyInstance('pwm_block',{periodCount:2},f).cls,
  c.classifyInstance('pwm_block',{periodCount:2},f).reason]));"""
    cls, reason = json.loads(subprocess.check_output(["node", "-e", script, str(fixture)], cwd=ROOT, text=True))
    assert cls == "continuous", reason
    assert "unreachable" in reason, reason
    # and the unmutated source of the same fixture shape is sequential (the harness is not just always-continuous)
    ok = tmp_path / "pwm_returns.syscfg.js"
    ok.write_text(src, encoding="utf-8")
    cls_ok = json.loads(subprocess.check_output(
        ["node", "-e", script, str(ok)], cwd=ROOT, text=True))[0]
    assert cls_ok == "sequential"


# ---- S5 -------------------------------------------------------------------------------------
# Decision: encoder_speed_block, hall_block and quadrature_block get NO optional bound. They have no
# output port (numOfOutputPorts 0) and exist to run for the life of the program (sample, publish to
# memory, loop); bounding them is a feature with no use case, not a defect. A bound config would also
# turn them into "sequential" for the pin-collision rule, which is only sound with a verified macro.

@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
def test_s5_unbounded_monitor_blocks_stay_continuous_with_no_optional_bound():
    script = """const c=require('./scripts/block_control_flow');
const ids=['encoder_speed_block','hall_block','quadrature_block'];
console.log(JSON.stringify(ids.map(id=>[c.classify(id).cls,c.boundConfig(id),c.classifyInstance(id,{periodCount:5}).cls])));"""
    got = json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True))
    assert got == [["continuous", None, "continuous"]] * 3
