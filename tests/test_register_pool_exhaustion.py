"""running out of registers is a SysConfig validation ERROR, never a silently missing instruction.

Without this check, a 24-stage running sum A_k = A_(k-1) + C_k generated with rc 0 and emitted only 22 of its
24 ADDs: pushInstruction returned -1 when getFreeByteOffset failed and every caller ignored it, so the block's
instruction disappeared and the build stayed clean - wrong firmware with no warning.

The allocator records each request it could not place (getAllocationFailures) and validatePruInstructions
(pru_blocks_static_module.syscfg.js) reports each one with logError, naming the block and the register budget.

Checks: a design with more live values than the pool holds must FAIL generation with the specific message (the
allocator releases values after their last consumer, so the design here is wider than the 24-stage sum); the 16-stage design must still generate
with all 16 ADDs and run correctly as the real clpru ELF on TI pru-simulator against a plain-Python sum.
`assert_every_block_emitted` is a reusable static helper: every block that should emit an instruction appears in the asm.
Do not use 40+ stages here: chain40 takes >400 s in SysConfig (a separate time cliff).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import test_fanout_register_alias as T  # noqa: E402

STAGES_OK = 16
STAGES_TOO_MANY = 24


def constant(k):
    return 1000 * k + 7


def expected_sum(n):
    """Independent oracle in plain Python: 1 + the n stage constants, mod 2**32."""
    return (1 + sum(constant(k) for k in range(1, n + 1))) & T.MASK


def chain_syscfg(n):
    """C0, then n stages of (constant C_k, ADD A_k = A_(k-1) + C_k); returns (text, [emitting blocks], last block)."""
    L = [T.HEADER, 'const c0 = load_constant_block.addInstance(); c0.constant1 = 1; c0.$name = "C0";']
    seq, prev, blocks = ["c0"], "c0", ["C0"]
    for k in range(1, n + 1):
        L += ['const c%d = load_constant_block.addInstance(); c%d.constant1 = %d; c%d.$name = "C%d";'
              % (k, k, constant(k), k, k),
              'const a%d = arithmetic_block.addInstance(); a%d.opCode = "ADD"; a%d.output1Size = "4"; a%d.$name = "A%d";'
              % (k, k, k, k, k),
              'scripting.connect(a%d, "input1", %s, "output1");' % (k, prev),
              'scripting.connect(a%d, "input2", c%d, "output1");' % (k, k)]
        seq += ["c%d" % k, "a%d" % k]
        prev = "a%d" % k
        blocks += ["C%d" % k, "A%d" % k]
    L += ['scripting.connect(%s, "next", %s, "prev");' % (a, b) for a, b in zip(seq, seq[1:])]
    return "\n".join(L) + "\n", blocks, "A%d" % n


def generate(text):
    """SysConfig CLI only. Returns (returncode, stdout+stderr, asm text or None, workdir); caller removes workdir."""
    work = tempfile.mkdtemp(prefix="case_")
    with open(os.path.join(work, "design.syscfg"), "w", encoding="utf-8") as f:
        f.write(text)
    res = subprocess.run([T.SYSCFG_NODE, T.SYSCFG_CLI, "--product", T.PRODUCT_JSON, "--device", "AM243x_ALX_beta",
                          "--context", "icss_g0_pru0", "--part", "ALX", "--package", "ALX",
                          "--output", "syscfg", "design.syscfg"], cwd=work, capture_output=True, text=True,
                         timeout=600)
    asm_path = os.path.join(work, "syscfg", "pru_syscfg.asm")
    asm = None
    if os.path.exists(asm_path):
        with open(asm_path, encoding="utf-8") as f:
            asm = f.read()
    return res.returncode, res.stdout + res.stderr, asm, work


def emitted_blocks(asm):
    """Names of the blocks that have an instruction line in the generated asm, in order."""
    return re.findall(r";PRU Instruction of (\S+)\s*\n\s*\S", asm)


def assert_every_block_emitted(asm, expected_blocks):
    """Static check usable by any test: every block that should emit an instruction appears in the asm exactly once."""
    got = emitted_blocks(asm)
    missing = [b for b in expected_blocks if b not in got]
    dup = sorted({b for b in got if got.count(b) > 1 and b in expected_blocks})
    assert not missing, "%d of %d blocks emitted no instruction (silently dropped): %s" % (
        len(missing), len(expected_blocks), ", ".join(missing))
    assert not dup, "blocks emitted more than once: %s" % ", ".join(dup)


def test_helper_flags_a_dropped_block():
    """No tools needed: the helper must see a block that is absent from the asm."""
    asm = ";PRU Instruction of A1\n    ADD R0, R1, R2\n;PRU Instruction of A3\n    ADD R0, R1, R2\n"
    assert emitted_blocks(asm) == ["A1", "A3"]
    assert_every_block_emitted(asm, ["A1", "A3"])
    with pytest.raises(AssertionError, match=r"1 of 3 blocks emitted no instruction.*A2"):
        assert_every_block_emitted(asm, ["A1", "A2", "A3"])


@T.needs_tools
def test_too_many_live_values_fails_generation_naming_the_block():
    """More live values than the pool holds: generation must FAIL with an Out of registers error naming each block.

    A 24-stage running sum does not exhaust the pool (the allocator releases a value after its last
    consumer), so the exhausting design is 28 independent 4-byte constants - the whole 112-byte pool, all alive - plus
    two more 4-byte constants that cannot be placed."""
    extra = ('const x1 = load_constant_block.addInstance(); x1.$name = "X1"; x1.constant1 = 0x20000001;\n'
             'const x2 = load_constant_block.addInstance(); x2.$name = "X2"; x2.constant1 = 0x20000002;\n'
             'scripting.connect(x1, "next", x2, "prev");')
    text = full_pool_syscfg(extra, chain_to="x1")
    rc, out, _asm, work = generate(text)
    shutil.rmtree(work, ignore_errors=True)
    assert rc != 0, "generation must FAIL when the register pool is exhausted, got rc 0:\n" + out[-600:]
    errs = re.findall(r"Out of registers: block '(\w+)' needs (\d+) byte\(s\) for (its result) but only (\d+) of the "
                      r"(\d+) allocatable bytes \(R0-R27, 28 registers; R28/R29 are reserved\) are free", out)
    assert errs, "expected the Out of registers error, got:\n" + out[-1200:]
    want = [("X1", "4", "its result", "0", "112"), ("X2", "4", "its result", "0", "112")]
    assert errs == want, "failing blocks/byte counts differ:\n got  %s\n want %s" % (errs, want)
    assert "Out of registers: block 'X2' needs 4 byte(s)" in out, "the last block (X2) cannot be placed and must be named"


@T.needs_tools
def test_twenty_four_stage_running_sum_no_longer_exhausts_the_pool():
    """turned the old exhausting design (24-stage running sum) into one that generates with all 24 ADDs."""
    text, blocks, _last = chain_syscfg(STAGES_TOO_MANY)
    rc, out, asm, work = generate(text)
    shutil.rmtree(work, ignore_errors=True)
    assert rc == 0, "24-stage running sum must generate now:\n" + out[-800:]
    assert_every_block_emitted(asm, blocks)


@T.needs_tools
def test_sixteen_stage_chain_keeps_every_instruction_and_runs_correctly():
    """16 stages fit: all 33 blocks emit, and the real ELF on TI pru-simulator computes the Python sum."""
    text, blocks, last = chain_syscfg(STAGES_OK)
    rc, out, asm, work = generate(text)
    try:
        assert rc == 0, "16-stage design must still generate:\n" + out[-800:]
        assert_every_block_emitted(asm, blocks)
        assert len([b for b in blocks if b.startswith("A")]) == STAGES_OK
        m = re.search(r";PRU Instruction of %s\s*\n\s*\w+\s+R(\d+)\b" % last, asm)
        assert m, "no instruction for %s" % last
        elf = T._link(work, T.MAIN_ASM, os.path.join(work, "syscfg", "pru_syscfg.asm"))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    halted, got = T.run_elf(elf, int(m.group(1)), max_steps=4000)
    assert halted
    assert got == expected_sum(STAGES_OK), "R%s = 0x%08X, want 0x%08X" % (m.group(1), got, expected_sum(STAGES_OK))


# ---------------------------------------------------------------- every recording site is armed
# The node driver runs the SHIPPED allocator on hand-built instances, so each recording site is reached directly.
NODE = shutil.which("node") or T.SYSCONFIG_NODE
ALLOC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".metadata", "sysconfig", ".meta",
                     "pru_blocks", "common", "register_allocation", "pru_register_allocator.js")

DRIVER = r"""
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const ALLOC = process.argv[2], CASE = process.argv[3];
const modules = {};
const sb = { system: { modules }, exports: {}, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(ALLOC, "utf8"), sb, { filename: "pru_register_allocator.js" });
const alloc = sb.exports;
const ldi = (n, i) => ({ $name: n + i, opCode: "LDI", numOfInputPorts: 0, numOfConstants: 1, constant1: i, noOfCycles: 1, output1Size: "4" });
const fill = (k) => { const a = []; for (let i = 0; i < k; i++) a.push(ldi("K", i)); return a; };  // 4 bytes each, no output1 = end blocks
const run = (insts) => { modules["/f"] = { $instances: insts }; alloc.allocatePruRegisters(); return JSON.parse(JSON.stringify(alloc.getAllocationFailures())); };
const brief = (f) => f.map(x => x.block + "|" + x.what + "|" + x.bytes + "|" + x.freeBytes);
if (CASE === "dedupe") {
  // F is revisited by each of its two consumers; it fails every time but must be recorded once
  const F = ldi("F", 0);
  const mk = (n) => ({ $name: n, opCode: "ADD", numOfInputPorts: 1, numOfConstants: 0, noOfCycles: 1, output1Size: "4", input1: [{ inst: F, port: "output1" }] });
  const G1 = mk("G1"), G2 = mk("G2");
  F.output1 = [{ inst: G1, port: "input1" }, { inst: G2, port: "input1" }];
  assert.deepStrictEqual(brief(run(fill(28).concat([F, G1, G2]))),
    ["F0|its result|4|0", "G1|its result|4|0", "G2|its result|4|0"]);
} else if (CASE === "reset") {
  // SysConfig re-evaluates after every edit: a big design, then the same module state with a small one
  assert.strictEqual(run(fill(30)).length, 2, "big design must record its two failures");
  assert.deepStrictEqual(run(fill(3)), [], "a smaller design evaluated next must start with NO failures (stale list)");
} else if (CASE === "extra-output") {
  // 26 constants leave 8 bytes: the macro's output1 and output2 fit, output3 does not
  const sv = { $name: "SV", opCode: "SVPWM", multiOutputMacroArgs: true, numOfOutputPorts: 5, numOfInputPorts: 0, numOfConstants: 0,
               noOfCycles: 1, output1Size: "4", output2Size: "4", output3Size: "4", output4Size: "4", output5Size: "4", output1: [] };
  assert.deepStrictEqual(brief(run(fill(26).concat([sv]))), ["SV|result output3|4|0"]);
} else if (CASE === "loop-counter") {
  const lp = { $name: "LP", $groupContents: [], infiniteLoop: false, loopCount: 3, loopCountRegSize: 1, numOfInputPorts: 0, noOfCycles: 1 };
  assert.deepStrictEqual(brief(run(fill(28).concat([lp]))), ["LP|its loop counter|1|0"]);
} else if (CASE === "group-return") {
  const gr = { $name: "GR", $groupContents: [], numOfInputPorts: 0, noOfCycles: 1 };
  assert.deepStrictEqual(brief(run(fill(28).concat([gr]))), ["GR|the group return address|2|0"]);
} else { throw new Error("unknown case " + CASE); }
console.log("DRIVER OK " + CASE);
"""


def _node_case(tmp_path, case):
    if not (NODE and os.path.exists(NODE)):
        pytest.fail("FATAL: node not found (PATH has no node and %s missing); this test needs it and must not skip"
                    % T.SYSCONFIG_NODE)
    driver = tmp_path / ("driver_%s.js" % case)
    driver.write_text(DRIVER, encoding="utf-8")
    path = str(driver)
    if path.startswith("\\\\?\\"):
        path = path[4:]
    res = subprocess.run([NODE, path, ALLOC, case], capture_output=True, text=True, timeout=120)
    assert res.returncode == 0 and ("DRIVER OK " + case) in res.stdout, \
        "node driver case %r failed:\n%s\n%s" % (case, res.stdout, res.stderr)


def test_revisited_failing_block_is_recorded_once(tmp_path):
    _node_case(tmp_path, "dedupe")


def test_failures_do_not_survive_into_the_next_evaluation(tmp_path):
    _node_case(tmp_path, "reset")


def test_multi_output_macro_running_out_on_an_extra_output_is_recorded(tmp_path):
    _node_case(tmp_path, "extra-output")


def test_loop_counter_failure_is_recorded(tmp_path):
    _node_case(tmp_path, "loop-counter")


def test_group_return_address_failure_is_recorded(tmp_path):
    _node_case(tmp_path, "group-return")


# ---------------------------------------------------------------- loop / group reach the named error
def full_pool_syscfg(extra, chain_to=None):
    """28 independent 4-byte constants fill the 112-byte pool; `extra` is the block that then cannot be placed."""
    L = [T.HEADER,
         'const loop_block = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);',
         'const group_block = scripting.addModule("/pru_blocks/program_control/group_block", {}, false);']
    for k in range(28):
        L.append('const c%d = load_constant_block.addInstance(); c%d.constant1 = %d; c%d.$name = "K%d";'
                 % (k, k, 0x10000000 + k, k, k))
    L.append(extra)
    if chain_to:
        seq = ["c%d" % k for k in range(28)] + [chain_to]
        L += ['scripting.connect(%s, "next", %s, "prev");' % (a, b) for a, b in zip(seq, seq[1:])]
    return "\n".join(L) + "\n"


def _expect_named_error(text, block, what, nbytes):
    rc, out, _asm, work = generate(text)
    shutil.rmtree(work, ignore_errors=True)
    assert rc != 0, "generation must FAIL, got rc 0:\n" + out[-600:]
    want = ("Out of registers: block '%s' needs %d byte(s) for %s but only 0 of the 112 allocatable bytes "
            "(R0-R27, 28 registers; R28/R29 are reserved) are free" % (block, nbytes, what))
    assert want in out, "expected the named, budgeted error:\n  %s\ngot:\n%s" % (want, out[-1200:])
    assert "reduce number of PRU blocks added" not in out, "the generic message must not replace it:\n" + out[-800:]


@T.needs_tools
def test_loop_counter_exhaustion_names_the_loop_block():
    text = full_pool_syscfg('const lp = loop_block.addInstance(); lp.$name = "LP"; lp.infiniteLoop = false; '
                            'lp.loopCount = 3; lp.$groupContents = [];', chain_to="lp")
    _expect_named_error(text, "LP", "its loop counter", 1)


@T.needs_tools
def test_group_return_address_exhaustion_names_the_group_block():
    text = full_pool_syscfg('const gp = group_block.addInstance(); gp.$name = "GP"; gp.groupName = "GP"; '
                            'gp.$groupContents = [];')
    _expect_named_error(text, "GP", "the group return address", 2)
