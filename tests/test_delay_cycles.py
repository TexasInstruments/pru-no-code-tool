"""Delay block timing verification on TI pru-simulator and doc-consistency.

Verifies:
1. Doc-consistency: Technical Details in delay_block.syscfg.js and block-reference docs
   must state that the block takes exactly count cycles (matching noOfCycles),
   and must not claim "+ 2" cycles overhead.
2. Timing on TI pru-simulator:
   Measures delay for counts 1, 2, 10, 255 (including the largest allowed count):
   a GPO SET, the delay block, a GPO CLR.
   Asserts CLR-SET edge distance == count + 1 cycles.
   The +1 cycle is the SET instruction itself (SET takes 1 cycle, delay takes count cycles,
   so the falling edge at CLR occurs exactly count + 1 cycles after the rising edge at SET).
   The oracle is the documented "count cycles" rule, not the block's cycle model.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

SYSCONFIG_NODE = Path(os.environ.get("SYSCONFIG_NODE", str(TI_TOOLS / "sysconfig_1.28.0" / "nodejs" / "node.exe")))
SYSCONFIG_CLI = Path(os.environ.get("SYSCONFIG_CLI", str(TI_TOOLS / "sysconfig_1.28.0" / "dist" / "cli.js")))
PRODUCT = ROOT / ".metadata" / "product.json"

DELAY_JS = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "utils" / "delay_block.syscfg.js"
DESIGN_MD = ROOT / "docs" / "block-reference" / "blocks" / "delay_block" / "design.md"
USER_GUIDE_MD = ROOT / "docs" / "block-reference" / "blocks" / "delay_block" / "user-guide.md"
UTILS_DELAY_MD = ROOT / "docs" / "utils" / "delay_block.md"

HAVE_TOOLS = (
    SYSCONFIG_NODE.exists()
    and SYSCONFIG_CLI.exists()
    and PRODUCT.exists()
)

try:
    CLPRU = elf_cosim.find_clpru()
    SIM_PATH = elf_cosim.find_pru_simulator()
    HAVE_SIM = True
except RuntimeError:
    CLPRU = None
    SIM_PATH = None
    HAVE_SIM = False

needs_tools = pytest.mark.skipif(
    not (HAVE_TOOLS and HAVE_SIM),
    reason="needs SysConfig 1.28, clpru, and TI pru-simulator (PRU_SIMULATOR_PATH)",
)

FORBIDDEN_DOC_PATTERNS = [
    (re.compile(r"\+\s*2"), r"\+\s*2 (overhead addition like '+ 2' or '+2')"),
    (re.compile(r"\bcount\s*\+\s*2\b", re.IGNORECASE), r"\bcount\s*\+\s*2\b ('count + 2' / 'count+2')"),
    (re.compile(r"\b2\s+cycles?\b.*?overhead", re.IGNORECASE), r"\b2\s+cycles?\b.*?overhead ('2 cycle(s) overhead')"),
    (re.compile(r"overhead.*?\b2\s+cycles?\b", re.IGNORECASE), r"overhead.*?\b2\s+cycles?\b ('overhead ... 2 cycle(s)')"),
    (re.compile(r"\b2\s+overhead\b", re.IGNORECASE), r"\b2\s+overhead\b ('2 overhead')"),
    (re.compile(r"\b2\s+cycles?\s+of\s+loop\b", re.IGNORECASE), r"\b2\s+cycles?\s+of\s+loop\b ('2 cycles of LOOP')"),
]

EXPECTED_TOTAL_CYCLES_PHRASE = "**Total Cycles**: count (the block takes exactly count cycles, matching noOfCycles)"
EXPECTED_MANUAL_DOC_PHRASE = "Total cycles = `delayCount` (the block takes exactly `delayCount` cycles, matching noOfCycles)."



def test_delay_block_doc_consistency():
    """Doc consistency assertion:

    Scans the full long description and documentation across:
    - delay_block.syscfg.js
    - docs/block-reference/blocks/delay_block/design.md
    - docs/block-reference/blocks/delay_block/user-guide.md
    - docs/utils/delay_block.md

    Ensures:
    1. No residual 2-cycle overhead claims survive anywhere in these files
       (checked via regex guards against '+ 2', 'count+2', '2 cycles overhead', etc.).
    2. Strong positive assertions: the total cycles is explicitly stated to be count
       (matching noOfCycles), verified both by exact phrase and negative lookahead regex
       `Total Cycles\\W+count\\b(?!\\s*\\+)`.
    """
    assert DELAY_JS.exists(), f"Missing {DELAY_JS}"

    # 1. Check delay_block.syscfg.js
    js_text = DELAY_JS.read_text(encoding="utf-8")
    for pattern, name in FORBIDDEN_DOC_PATTERNS:
        match = pattern.search(js_text)
        assert match is None, (
            f"delay_block.syscfg.js matches forbidden 2-cycle overhead pattern {name}: {match.group(0)!r}"
        )

    # Positive assertions on delay_block.syscfg.js
    assert EXPECTED_TOTAL_CYCLES_PHRASE in js_text, (
        f"delay_block.syscfg.js missing exact phrase {EXPECTED_TOTAL_CYCLES_PHRASE!r}"
    )
    assert re.search(r"\*\*Total Cycles\*\*:\s*count\b(?!\s*\+)", js_text) is not None, (
        "delay_block.syscfg.js failed Total Cycles regex guard"
    )

    # 2. Check generated block reference docs
    for doc_path in (DESIGN_MD, USER_GUIDE_MD):
        if doc_path.exists():
            doc_text = doc_path.read_text(encoding="utf-8")
            for pattern, name in FORBIDDEN_DOC_PATTERNS:
                match = pattern.search(doc_text)
                assert match is None, (
                    f"{doc_path.name} matches forbidden 2-cycle overhead pattern {name}: {match.group(0)!r}"
                )
            assert EXPECTED_TOTAL_CYCLES_PHRASE in doc_text, (
                f"{doc_path.name} missing exact phrase {EXPECTED_TOTAL_CYCLES_PHRASE!r}"
            )
            assert re.search(r"\*\*Total Cycles\*\*:\s*count\b(?!\s*\+)", doc_text) is not None, (
                f"{doc_path.name} failed Total Cycles regex guard"
            )

    # 3. Check manual utility documentation
    if UTILS_DELAY_MD.exists():
        utils_text = UTILS_DELAY_MD.read_text(encoding="utf-8")
        for pattern, name in FORBIDDEN_DOC_PATTERNS:
            match = pattern.search(utils_text)
            assert match is None, (
                f"{UTILS_DELAY_MD.name} matches forbidden 2-cycle overhead pattern {name}: {match.group(0)!r}"
            )
        assert EXPECTED_MANUAL_DOC_PHRASE in utils_text, (
            f"{UTILS_DELAY_MD.name} missing exact phrase {EXPECTED_MANUAL_DOC_PHRASE!r}"
        )
        assert re.search(r"Total cycles\s*=\s*`delayCount`(?!\s*\+)", utils_text) is not None, (
            f"{UTILS_DELAY_MD.name} failed Total cycles regex guard"
        )


def test_delay_largest_allowed_count():
    """Verify that the largest count allowed by delay_block configuration range is 255."""
    js_text = DELAY_JS.read_text(encoding="utf-8")
    m = re.search(r"range:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]", js_text)
    assert m is not None, "Could not find delayCount range in delay_block.syscfg.js"
    min_count, max_count = int(m.group(1)), int(m.group(2))
    assert min_count == 1
    assert max_count == 255, f"Expected largest allowed count to be 255, got {max_count}"


class _IdlePins:
    """Device model with no active peripheral inputs: tick returns 0 for GPI pins."""
    def tick(self, cycle, pins_out):
        return 0


def _build_and_simulate_delay(tmp_path: Path, delay_val: int) -> int:
    """Build a SysConfig design (GPO SET -> Delay -> GPO CLR), assemble with clpru,

    simulate in TI pru-simulator, and measure the edge distance between CLR and SET.
    """
    case_dir = tmp_path / f"delay_{delay_val}"
    case_dir.mkdir(parents=True, exist_ok=True)
    gen_dir = case_dir / "gen"

    syscfg_content = f"""// @cliArgs --device AM243x_ALX_beta --package ALX --part ALX --context icss_g0_pru0 --product PRU_NO_CODE_TOOL@01.00.01
const pru_blocks_static_module = scripting.addModule("/pru_blocks/common/pru_blocks_static_module");
pru_blocks_static_module.pruClkFreq = 200;

const pru_gpo_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {{}}, false);
const gpo_set = pru_gpo_block.addInstance();
gpo_set.$name = "GPO_Set";
gpo_set.constant1 = "R30, 0";
gpo_set.opCode = "SET";

const delay_block = scripting.addModule("/pru_blocks/utils/delay_block", {{}}, false);
const delay = delay_block.addInstance();
delay.$name = "Delay_Inst";
delay.delayCount = {delay_val};

const gpo_clr = pru_gpo_block.addInstance();
gpo_clr.$name = "GPO_Clr";
gpo_clr.constant1 = "R30, 0";
gpo_clr.opCode = "CLR";

scripting.connect(gpo_set, "next", delay, "prev");
scripting.connect(delay, "next", gpo_clr, "prev");
"""
    script_file = case_dir / "delay.syscfg"
    script_file.write_text(syscfg_content, encoding="utf-8")

    env = dict(
        os.environ,
        PRU_SIM_LIVE_NO_BROWSER="1",
    )

    res = subprocess.run(
        [
            str(SYSCONFIG_NODE),
            str(SYSCONFIG_CLI),
            "--product",
            str(PRODUCT),
            "--device",
            "AM243x_ALX_beta",
            "--package",
            "ALX",
            "--part",
            "ALX",
            "--script",
            str(script_file),
            "--context",
            "icss_g0_pru0",
            "--output",
            str(gen_dir),
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, f"SysConfig failed (rc={res.returncode}):\n{res.stdout}\n{res.stderr}"

    # Main scaffold to jump to generated code and halt
    main_asm = gen_dir / "main.asm"
    main_asm.write_text("""
    .retain
    .retainrefs
    .global main
    .ref sysconfig_generated_start
    .sect ".text:main"
main:
    jmp sysconfig_generated_start
    .global sysconfig_generated_end
sysconfig_generated_end:
    halt
""", encoding="utf-8")

    link_cmd = gen_dir / "link.cmd"
    link_cmd.write_text(elf_cosim.LINKER_CMD, encoding="utf-8")

    out_elf = gen_dir / "firmware.out"
    r1 = subprocess.run(
        [CLPRU, "--silicon_version=4", "-c", "-I.", "pru_syscfg.asm", "main.asm"],
        cwd=gen_dir,
        capture_output=True,
        text=True,
    )
    assert r1.returncode == 0, f"clpru compile failed:\n{r1.stdout}\n{r1.stderr}"

    r2 = subprocess.run(
        [
            CLPRU,
            "--silicon_version=4",
            "-z",
            "pru_syscfg.obj",
            "main.obj",
            "link.cmd",
            "--entry_point=main",
            "-o",
            "firmware.out",
        ],
        cwd=gen_dir,
        capture_output=True,
        text=True,
    )
    assert r2.returncode == 0, f"clpru link failed:\n{r2.stdout}\n{r2.stderr}"

    run = elf_cosim.run_elf_closed_loop(str(out_elf), _IdlePins(), max_steps=delay_val + 500)
    assert run.halted, f"Firmware did not halt for delay {delay_val}"

    # Find rising and falling edge of R30 bit 0
    edges = []
    prev_bit = None
    for cycle, gpo, _ in run.trace:
        bit = gpo & 1
        if prev_bit is not None and bit != prev_bit:
            edges.append((cycle, bit))
        prev_bit = bit

    rising = [c for c, b in edges if b == 1]
    falling = [c for c, b in edges if b == 0]
    assert len(rising) == 1, f"Expected 1 rising edge, found {rising}"
    assert len(falling) == 1, f"Expected 1 falling edge, found {falling}"

    edge_distance = falling[0] - rising[0]
    return edge_distance


@needs_tools
@pytest.mark.parametrize("count", [1, 2, 3, 10, 255])
def test_delay_simulator_edge_distance(tmp_path: Path, count: int):
    """Measures the delay in the TI pru-simulator for counts 1, 2, 3, 10, 255

    (including the largest count 255 the block allows):
    a GPO SET, the delay, a GPO CLR.
    Asserts CLR-SET edge distance == count + 1.
    Note: the +1 is the SET instruction itself (the GPO SET instruction takes 1 cycle,
    followed by exactly count cycles of delay, after which GPO CLR executes).
    The oracle is the documented 'count cycles' rule, not the block's cycle model.
    """
    measured_distance = _build_and_simulate_delay(tmp_path, count)

    # Oracle: documented rule: delay takes exactly count cycles.
    # The +1 is the SET instruction itself.
    expected_distance = count + 1

    assert measured_distance == expected_distance, (
        f"For delay count={count}, CLR-SET edge distance {measured_distance} != {expected_distance} "
        f"(the +1 is the SET instruction itself; block must take exactly count={count} cycles)"
    )
