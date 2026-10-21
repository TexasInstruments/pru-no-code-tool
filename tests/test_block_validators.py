"""
Generalize validator runner into reusable block-validator harness.

Sweeps every block declaring validate(), gives each error path a red arm and
same-shape legal control arm. Starter: sample_period.

Harness: scripts/block_validate_runner.js — generalizes
         scripts/static_module_validate_runner.js which was scoped to
         validateDeviceCapabilities in
         .metadata/sysconfig/.meta/pru_blocks/common/pru_blocks_static_module.syscfg.js:1

Block under test starter:
  .metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/spi_adc_sequencer_block.syscfg.js:23
    function validate(inst, validation) { ... sample_period < noOfCycles ... }
    cited at :35-36 for the error path under arms below.

Validator inventory:
  runner --sweep enumerates every .syscfg.js with hasValidate (58 blocks)
  runner --report adds armed summary (validatorsFound vs validatorsArmed,
           errorPathsFound vs errorPathsArmed)

Armed set (committed red/control pairs):
  - spi_adc_sequencer_block :: sample_period — 1 of 3 error paths in that block
  Remaining 227-1 error paths are inventoried as unarmed and reported, not hidden.

Red results stay red: each red arm asserts logError with the validator's
exact message and field; each legal control asserts no errors with an
otherwise identical inst (same shape, only the field under test differs).
If the validator branch is deleted, the red arm goes green and the test
fails — proved by the source-presence guard in test_validator_source_has_sample_period_check.

All validator invocations go through the committed harness by path:
  node scripts/block_validate_runner.js <block> '<instJson>'
No inline heredoc composition.
"""

import json
import pathlib
import subprocess
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "scripts" / "block_validate_runner.js"
NODE = "node"

# ---------------------------------------------------------------- helpers

def run_block_validate(block, inst):
    """Call committed harness by path — no inline heredoc."""
    proc = subprocess.run(
        [NODE, str(RUNNER), block, json.dumps(inst)],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"runner failed for {block}: {proc.stdout}\n{proc.stderr}"
    data = json.loads(proc.stdout.strip())
    return data

def run_sweep_report():
    proc = subprocess.run(
        [NODE, str(RUNNER), "--report"],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=10
    )
    assert proc.returncode == 0, f"--report failed: {proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.strip())

def spi_adc_no_of_cycles(bits_per_frame, t_conv, channel_sequence):
    seq = [x.strip() for x in channel_sequence.split(",") if x.strip() != ""]
    # Mirrors .metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/spi_adc_sequencer_block.syscfg.js:91-98
    # getValue: actual += 13 + t_conv + (17 * bits)
    total = 0
    for _ in seq:
        total += 13 + t_conv + (17 * bits_per_frame)
    return total

def base_spi_adc_inst(**overrides):
    """Legal base inst — same shape for every arm, only sample_period varies."""
    bits = 16
    t_conv = 200
    ch_seq = "0xA500, 0xB600"
    no = spi_adc_no_of_cycles(bits, t_conv, ch_seq)
    inst = {
        "cs_pin": "3",
        "sclk_pin": "0",
        "mosi_pin": "2",
        "miso_pin": "1",
        "spi_mode": "MODE0",
        "bits_per_frame": bits,
        "t_conv": t_conv,
        "sample_period": 5000,
        "channel_sequence": ch_seq,
        "noOfCycles": no,
    }
    inst.update(overrides)
    return inst

# ---------------------------------------------------------------- inventory / reporting

ARMED_BLOCKS = ["spi_adc_sequencer_block"]
ARMED_ERROR_PATHS = 1  # sample_period only; other 2 paths in same block not yet armed

def test_sweep_reports_validators_found_vs_armed():
    """Report coverage: validators found vs armed, error paths found vs armed."""
    report = run_sweep_report()
    summary = report["summary"]
    validators = report["validators"]
    # Total blocks declaring validate() — sweep is authoritative
    assert summary["validatorsFound"] == len(validators)
    # FLOORS, not exact totals. These were the counts when landed
    # (58 validators / 227 logError sites). An exact equality here breaks on
    # every new block that declares validate() - xfr2psi_block made it
    # 59 within the hour and turned this suite red for no defect. What is worth
    # catching is the sweep seeing FEWER validators than it used to, which means
    # the harness stopped recognising a block, so the floor is the assertion and
    # growth is expected.
    assert summary["validatorsFound"] >= 58, f"sweep regressed: expected at least 58 blocks with validate(), got {summary['validatorsFound']}"
    assert summary["errorPathsFound"] >= 227, f"sweep regressed: expected at least 227 logError sites, got {summary['errorPathsFound']}"
    # Armed tracking — starter is sample_period
    assert summary["validatorsArmed"] == len(ARMED_BLOCKS)
    assert summary["errorPathsArmed"] == ARMED_ERROR_PATHS
    # Print report for human inspection (keep red results red — unarmed is not hidden)
    print(f"\n validators found: {summary['validatorsFound']}, armed: {summary['validatorsArmed']}, unarmed: {summary['validatorsUnarmed']}")
    print(f" error paths found: {summary['errorPathsFound']}, armed: {summary['errorPathsArmed']}, unarmed: {summary['errorPathsFound'] - summary['errorPathsArmed']}")
    print(f" armed blocks: {summary['armedBlocks']}")
    # Ensure sweep is not silently passing when nothing is armed
    assert summary["validatorsArmed"] >= 1

def test_sweep_lists_spi_adc_sequencer_with_four_error_paths():
    report = run_sweep_report()
    spi = [r for r in report["validators"] if r["block"] == "spi_adc_sequencer_block"]
    assert len(spi) == 1
    assert spi[0]["errorCount"] == 4, f"spi_adc_sequencer should have 4 logError paths (channel_sequence, spi_mode, distinct pins, sample_period): {spi[0]}"
    # The sweep reports counts only; pin the new rule's text in the source, and trip it in the red arm below.
    assert "channel_sequence must contain 1..25 integer MOSI words" in (REPO_ROOT / spi[0]["file"]).read_text(encoding="utf-8")
    assert spi[0]["file"] == ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/spi_adc_sequencer_block.syscfg.js"

# ---------------------------------------------------------------- sample_period validator — red vs legal control

def test_negative_sample_period_too_small_is_red():
    """Red arm: sample_period < noOfCycles must be refused with logError on sample_period."""
    inst = base_spi_adc_inst(sample_period=500)  # 500 < 970
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    assert len(data["errors"]) == 1, f"expected exactly one error for sample_period too small, got {data['errors']} warnings={data['warnings']}"
    msg = data["errors"][0]["message"]
    field = data["errors"][0]["field"]
    assert "sample_period" in field.lower() or "sample_period" in msg.lower(), f"error must name sample_period: {msg} field={field}"
    assert "970" in msg or "cycles" in msg.lower(), f"error must mention cycle count: {msg}"
    # Keep red red: the message cites the computed noOfCycles vs sample_period
    assert "500" in msg, f"error must echo the bad sample_period value: {msg}"

def test_positive_sample_period_fits_is_green_control():
    """Legal control: same shape as red, but sample_period >= noOfCycles — no error."""
    inst = base_spi_adc_inst(sample_period=5000)  # 5000 >= 970, same shape as red arm above
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    assert data["errors"] == [], f"legal control should have no errors, got {data['errors']}"

def test_boundary_sample_period_exactly_no_of_cycles_is_green():
    """Boundary: sample_period == noOfCycles is legal (validate uses <, not <=) per :35."""
    no = base_spi_adc_inst()["noOfCycles"]
    inst = base_spi_adc_inst(sample_period=no)
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    assert data["errors"] == [], f"boundary exact fit should be green, got {data['errors']}"

def test_boundary_sample_period_one_below_is_red():
    """Boundary: sample_period == noOfCycles - 1 is red."""
    no = base_spi_adc_inst()["noOfCycles"]
    inst = base_spi_adc_inst(sample_period=no - 1)
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    assert len(data["errors"]) == 1
    assert data["errors"][0]["field"] == "sample_period"

def test_validator_source_has_sample_period_check():
    """Guard: the validator branch must exist in source — if deleted, red arm would falsely go green."""
    src = (REPO_ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "spi_adc_sequencer_block.syscfg.js").read_text(encoding="utf-8")
    assert 'sample_period' in src
    assert 'noOfCycles' in src
    # The exact branch at :35 — deleting it would make this test red, proving the red arm is not vacuous
    assert re.search(r'if\s*\(\s*inst\.sample_period\s*<\s*noOfCycles\s*\)', src), "sample_period < noOfCycles branch not found — validator may have been deleted"
    assert 'Cannot fit sequence in period' in src

def test_harness_is_general_not_hardcoded_to_sample_period():
    """Prove harness is reusable: exercise a different block's error path via same runner."""
    # bswap_block has byteWidth/mode checks at .metadata/sysconfig/.meta/pru_blocks/data_handling/bswap_block.syscfg.js:20-23
    # Same harness, different block — demonstrates generalization from from pathlib import Path as _P
    # Red: illegal width
    data_red = run_block_validate("data_handling/bswap_block", {"byteWidth": "bogus", "mode": "swap", "input1": [{"inst": {}}]})
    assert len(data_red["errors"]) >= 1, f"bswap illegal width should error: {data_red}"
    # Green control: same shape, legal width
    data_green = run_block_validate("data_handling/bswap_block", {"byteWidth": "halfword", "mode": "swap", "input1": [{"inst": {}}]})
    # The green control should have no byteWidth/mode errors (may still have width error if we pass bad data, but we pass good)
    assert not any("width" in e["message"].lower() for e in data_green["errors"]), f"bswap legal control should not error on width: {data_green['errors']}"


# ---------------------------------------------------------------- channel_sequence validator — red vs legal control

CHANNEL_SEQ_RULE = "channel_sequence must contain 1..25 integer MOSI words"

def test_channel_sequence_26_words_is_red():
    """Red arm: 26 words exceeds the 32 numbered constants (6 fixed + N commands + PAD) and must be refused."""
    seq = ", ".join(["0x1234"] * 26)
    inst = base_spi_adc_inst(channel_sequence=seq, sample_period=500000)
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    msgs = [e["message"] for e in data["errors"]]
    assert CHANNEL_SEQ_RULE in msgs, f"26 words must trip the channel_sequence rule, got {data['errors']}"
    assert [e["field"] for e in data["errors"] if e["message"] == CHANNEL_SEQ_RULE] == ["channel_sequence"]

def test_channel_sequence_25_words_is_green_control():
    """Legal control: 25 words (the maximum) raises no channel_sequence error."""
    seq = ", ".join(["0x1234"] * 25)
    inst = base_spi_adc_inst(channel_sequence=seq, sample_period=500000)
    data = run_block_validate("pru_io_blocks/spi_adc_sequencer_block", inst)
    assert CHANNEL_SEQ_RULE not in [e["message"] for e in data["errors"]], data["errors"]
