"""the pwm_block text must not claim cycle-exact periods .

The counted/continuous macro polls the IEP with a 4-cycle loop, so edges land 0..3 cycles after
their compare event. 'same high and low cycle counts' is only allowed next to the jitter qualifier.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCKS = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks"
REF = ROOT / "docs" / "block-reference" / "blocks"
FILES = [
    BLOCKS / "pwm_block.syscfg.js",
    BLOCKS / "three_phase_pwm_block.syscfg.js",
    REF / "pwm_block" / "design.md",
    REF / "pwm_block" / "user-guide.md",
    REF / "three_phase_pwm_block" / "design.md",
    REF / "three_phase_pwm_block" / "user-guide.md",
]


def test_no_unqualified_same_high_and_low_cycle_counts():
    for f in FILES:
        text = re.sub(r"\s+", " ", f.read_text(encoding="utf-8"))
        if "same high and low cycle counts" in text:
            assert "0..3 cycles" in text, f"{f.name} claims equal cycle counts without the jitter qualifier"


def test_pwm_doc_states_the_jitter_windows_and_preconditions():
    src = re.sub(r"\s+", " ", FILES[0].read_text(encoding="utf-8"))
    for needle in ("0..3 cycles", "P +/-3", "P+7..P+10", "D-8..D-2", "D-9..D-3",
                   "exactly 1 cycle", "at least 11", "at least 10", "not verified on silicon"):
        assert needle in src, needle
    assert "Deadband (ns) is accepted but not yet inserted" in src
