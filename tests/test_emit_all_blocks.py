"""emit_all_blocks must use the shared macro-condition evaluator."""
import json
import os
import subprocess


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURE = "scripts/fixtures/parenthesized_if_fixture.asm"


def run_node(source, *args):
    return subprocess.run(["node", "-e", source, *args], cwd=ROOT, text=True,
                          capture_output=True, check=False)


NODE_COUNTS = r"""
const fs = require('fs');
const { expand } = require('./scripts/emit_all_blocks');
const macro = fs.readFileSync(process.argv[1], 'utf8');
// This is the former emitter evaluator: it only split on == and did neither
// comment stripping nor parenthesis handling.  It is deliberately injected
// only into this red arm, never used by production code.
const legacy = c => {
  if (c.includes('==')) {
    const [a, b] = c.split('==').map(x => x.trim());
    return a === b;
  }
  return c !== '0' && c !== '';
};
const shared = expand(macro);
const bypassed = expand(macro, legacy);
console.log(JSON.stringify({ shared: shared.instructions.length,
                             bypassed: bypassed.instructions.length,
                             instructions: shared.instructions }));
"""


def test_red_arm_parenthesized_if_with_comment_has_exact_shared_and_legacy_counts():
    """Bypassing the shared evaluator must make this fixture demonstrably red."""
    result = run_node(NODE_COUNTS, FIXTURE)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    assert got == {"shared": 1, "bypassed": 0, "instructions": ["ldi R10, 1"]}

    # An evaluator without this handling must fail for the named reason,
    # rather than merely with a non-zero exit code.
    red = run_node(NODE_COUNTS + r"""
const assert = require('assert');
assert.strictEqual(bypassed.instructions.length, 1,
  'evaluator without paren handling lost the parenthesized .if instruction');
""", FIXTURE)
    assert red.returncode != 0
    assert "evaluator without paren handling lost the parenthesized .if instruction" in red.stderr


def test_shared_evaluator_accepts_html_escaped_ordering_operator():
    result = run_node(r"""
const h = require('./scripts/dual_oracle_harness');
console.log(JSON.stringify(h.evalCondition('(task &lt; 32) ; HTML escaped', {task: '10'})));
""")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) is True


NODE_ISDEFED = r"""
const { expand } = require('./scripts/emit_all_blocks');
const macro = [
  'm .macro A',
  '    .if !$isdefed("SYM_X")',
  'SYM_X   .set    3',
  '    .endif',
  '    .if SYM_X >= 2',
  '    ldi R10, SYM_X',
  '    .endif',
  '    .if !$isdefed("SYM_X")',
  '    ldi R11, 9',
  '    .endif',
  '    .endm',
].join('\n');
const h = require('./scripts/dual_oracle_harness');
// Routing emit through evalCondition without a symbol set makes every
// `!$isdefed` guard false, so the `.set` vanishes and UART/Modbus macros fault on an
// unmapped SBCO. Passing no symbol set reproduces that.
const noSymbols = (c, m) => h.evalCondition(c, m);
console.log(JSON.stringify({ shared: expand(macro).instructions,
                             noSymbols: expand(macro, noSymbols).instructions }));
"""


def test_isdefed_guard_defines_symbol_and_numeric_set_feeds_later_condition():
    result = run_node(NODE_ISDEFED)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    # guard true on first sight -> `.set` kept; value 3 satisfies `>= 2`; the second
    # `!$isdefed` is now false because the expansion defined SYM_X.
    assert got["shared"] == ["SYM_X   .set    3", "ldi R10, SYM_X"]
    # red arm: without the symbol set the definition is dropped and nothing assembles
    assert got["noSymbols"] == []


# 104 under the global operand table (IS_FORWARD unbound, `R15 == 1` guessed false); 99 with
# the block's own default (transformType Forward -> IS_FORWARD = 1),.
EXPECT_IQMATH_INSTRUCTIONS = 99


# ---------------------------------------------------------------------------
# guard forms the shared evaluator must decide, not drop.
# ---------------------------------------------------------------------------

def node_json(source):
    result = run_node(source)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_defined_and_single_equals_guards_are_decided():
    got = node_json(r"""
const h = require('./scripts/dual_oracle_harness');
const sets = { symbols: new Set(['SET_SYM']), substitutions: new Set(['ASG_SYM']) };
const d = (c) => h.evalConditionDetailed(c, {}, sets);
console.log(JSON.stringify({
  notDefinedUndef: d('!$defined(SINE_LUT_DEFINED)'),
  definedSet: d('$defined(SET_SYM)'),
  definedAsg: d('$defined(ASG_SYM)'),
  isdefedAsg: d('$isdefed("ASG_SYM")'),
  isdefedSet: d('$isdefed("SET_SYM")'),
  unquotedIsdefed: d('$isdefed(SET_SYM)'),
  noSet: h.evalConditionDetailed('!$defined(X)', {}),
  eq1: d('1 = 0'), eq2: d('0 = 0'), arith: d('(8 + 1) < 32'),
}));
""")
    assert got["notDefinedUndef"] == {"value": True, "decided": True}
    assert got["definedSet"] == {"value": True, "decided": True}
    # TI assembler (clpru 2.3.3 probe): .asg names are $defined but NOT $isdefed
    assert got["definedAsg"] == {"value": True, "decided": True}
    assert got["isdefedAsg"] == {"value": False, "decided": True}
    assert got["isdefedSet"] == {"value": True, "decided": True}
    # unquoted $isdefed(X) is assembler error E0301: never silently decided
    assert got["unquotedIsdefed"] == {"value": False, "decided": False}
    assert got["noSet"] == {"value": False, "decided": False}
    assert got["eq1"] == {"value": False, "decided": True}
    assert got["eq2"] == {"value": True, "decided": True}
    assert got["arith"] == {"value": True, "decided": True}


def test_iqmath_park_clarke_keeps_its_only_sine_lut():
    """Expansion keeps the `.if !$defined(SINE_LUT_DEFINED)` branch and its LUT, which
    `ldi32 R29, sine_lut` references; pruning that branch would delete the only sine_lut."""
    got = node_json(r"""
const { expandBlock } = require('./scripts/emit_all_blocks');
const r = expandBlock('iqmath_park_clarke_block');
console.log(JSON.stringify({ luts: r.labels.filter(l => l === 'sine_lut').length,
  refs: r.instructions.filter(i => /ldi32\s+R29,\s*sine_lut/.test(i)).length,
  n: r.instructions.length, setLines: r.instructions.filter(i => /^SINE_LUT_DEFINED\s+\.set/.test(i)).length }));
""")
    assert got["luts"] == 1, got
    assert got["refs"] >= 1, got
    assert got["setLines"] == 1, got
    assert got["n"] == EXPECT_IQMATH_INSTRUCTIONS, got


def test_pdm_block_emits_exactly_one_sample_variant():
    """cf9af21 left SAMPLE_HIGH unbound and `=` unknown: both variants vanished (16)."""
    got = node_json(r"""
const { expandBlock, LITERAL } = require('./scripts/emit_all_blocks');
const pick = (v) => expandBlock('pdm_block', { ...LITERAL, SAMPLE_HIGH: v }).instructions
  .map((ins, k, all) => /^lsr\s+\S+,\s*R31/.test(ins) ? ins + (all.slice(0, k).some(j => /^clr\s+R30/.test(j)) ? ' @low' : ' @high') : null)
  .filter(Boolean);
console.log(JSON.stringify({ high: pick(1), low: pick(0),
  n: expandBlock('pdm_block').instructions.length }));
""")
    # DATA_PIN is the block default 12 (the global table said 1),
    # The sample is branch-free (lsr R31, and, or) and sits before the clr (high) or after it (low)
    assert got["high"] == ["lsr   R28, R31, 12 @high"], got
    assert got["low"] == ["lsr   R28, R31, 12 @low"], got
    assert got["n"] == 17, got


WHOLE_LIBRARY = r"""
const e = require('./scripts/emit_all_blocks');
const REG = /^(R\d+(\.\w+)?|c\d+)$/i;
const bad = {};
for (const b of e.allBlocks()) {
  let r;
  try { const m = e.loadBlock(b.file).getMacro('', 'm_' + b.id); if (typeof m !== 'string' || !m.trim()) continue; r = e.expandWithBlockDefaults(e.loadBlock(b.file), m); }
  catch (x) { continue; }
  if (!r.instructions.length) continue;
  const defs = new Set(r.trailingAliases);
  r.aliases.forEach(a => a.forEach(l => defs.add(l)));
  for (const i of r.instructions) {
    const d = i.match(/^(\S+)\s+\.(?:set|equ)\b/i); if (d) defs.add(d[1]);
    const a = i.match(/^\.asg\s+[^,]+,\s*(\S+)/i); if (a) defs.add(a[1]);
  }
  const refs = new Set();
  for (const i of r.instructions) {
    const m = i.match(/^(ldi32|ldi|jal|qba|qbeq|qbne|qbgt|qblt|qbge|qble|qbbs|qbbc)\s+(.*)$/i);
    if (!m) continue;
    const ops = m[2].split(',').map(x => x.trim());
    const c = /^(ldi|jal)/i.test(m[1]) ? ops[1] : ops[0];
    if (c && /^[A-Za-z_]\w*$/.test(c) && !REG.test(c)) refs.add(c);
  }
  const und = [...refs].filter(x => !defs.has(x)).sort();
  if (und.length) bad[b.id] = und;
}
console.log(JSON.stringify(bad));
"""


def test_every_emitted_label_operand_is_defined_in_its_own_expansion():
    """Whole-library check (catches a deleted lookup-table label or dropped stacked/trailing
    labels): every ldi32/ldi/jal/qb* symbol operand must be a label or .set/.equ/.asg symbol
    of the same expansion."""
    bad = node_json(WHOLE_LIBRARY)
    # scheduler_block jumps into user task bodies it does not own (`jal task_N_start`);
    # those are external by design, nothing else may be.
    assert bad == {"scheduler_block": ["task_0_start", "task_1_start"]}, bad


def test_undecidable_guards_are_visible_and_pinned():
    """A guard the shared evaluator cannot decide is reported, never silently pruned.
    The pinned list is the remaining undecidable set: unbound register operands (R13 != 1 ...)."""
    got = node_json(r"""
const e = require('./scripts/emit_all_blocks');
const out = {};
for (const b of e.allBlocks()) {
  let r;
  try { const m = e.loadBlock(b.file).getMacro('', 'm_' + b.id); if (typeof m !== 'string' || !m.trim()) continue; r = e.expandWithBlockDefaults(e.loadBlock(b.file), m); }
  catch (x) { continue; }
  if (r.instructions.length && r.undecidable.length) out[b.id] = [...new Set(r.undecidable)].sort();
}
console.log(JSON.stringify(out));
""")
    with open(os.path.join(ROOT, "scripts/fixtures/undecidable_guards.json"), encoding="utf-8") as fh:
        assert got == json.load(fh)
    # an undecided guard must be flagged by the evaluator, not just read false
    flagged = node_json(r"""
const { expand } = require('./scripts/emit_all_blocks');
const r = expand(['m .macro A', '    .if (MYSTERY & 1)', '    ldi R10, 1', '    .endif', '    .endm'].join('\n'));
console.log(JSON.stringify({ n: r.instructions.length, und: r.undecidable }));
""")
    assert flagged == {"n": 0, "und": ["(MYSTERY & 1)"]}


# (block, LITERAL key) pairs: each key steers a guard in that block. Removing the key must
# leave a guard undecidable, so renaming/removing a LITERAL entry cannot stay green.
GUARD_KEYS = [
    ("scheduler_block", "task1"), ("scheduler_block", "task2"), ("scheduler_block", "task3"),
    ("scheduler_block", "task4"),
    ("trigger_router_block", "route1"), ("trigger_router_block", "route2"),
    ("trigger_router_block", "route3"), ("trigger_router_block", "route4"),
    ("multi_axis_motion_block", "NUM_AXES"), ("multi_axis_motion_block", "PULSE_K"),
    ("multi_axis_motion_block", "PULSE_NOPS"),
    ("iolink_master_block", "TX_BYTES"), ("iolink_master_block", "RX_BYTES"),
    ("pdm_block", "SAMPLE_HIGH"),
]


def test_literal_guard_bindings_are_armed():
    got = node_json(r"""
const { expandBlock, LITERAL } = require('./scripts/emit_all_blocks');
const pairs = PAIRS_JSON;
const out = [];
for (const [block, key] of pairs) {
  const { [key]: _drop, ...rest } = LITERAL;
  const withKey = expandBlock(block).undecidable.length;
  const without = expandBlock(block, rest).undecidable.length;
  out.push({ block, key, hasKey: Object.prototype.hasOwnProperty.call(LITERAL, key), withKey, without });
}
console.log(JSON.stringify(out));
""".replace("PAIRS_JSON", json.dumps(GUARD_KEYS)))
    for row in got:
        assert row["hasKey"], row
        assert row["without"] > row["withKey"], row


def test_literal_bindings_are_block_defaults():
    got = node_json(r"""
const { LITERAL } = require('./scripts/emit_all_blocks');
const keys = ['task1','task2','task3','task4','route1','route2','route3','route4','NUM_AXES',
  'PULSE_K','PULSE_NOPS','TX_BYTES','RX_BYTES','SAMPLE_HIGH','FEAT_EN'];
console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, LITERAL[k]]))));
""")
    assert got == {"task1": 0, "task2": 1, "task3": 255, "task4": 255,
                   "route1": 255, "route2": 255, "route3": 255, "route4": 255,
                   "NUM_AXES": 2, "PULSE_K": 4, "PULSE_NOPS": 0, "TX_BYTES": 4,
                   "RX_BYTES": 4, "SAMPLE_HIGH": 1, "FEAT_EN": 1}


def test_stale_set_value_is_not_kept():
    got = node_json(r"""
const { expand } = require('./scripts/emit_all_blocks');
const macro = ['m .macro A', 'X .set 3', 'X .set X+5', '    .if X >= 8', '    ldi R10, 1', '    .endif',
  'Y .set SOMETHING', '    .if Y >= 1', '    ldi R11, 1', '    .endif', '    .endm'].join('\n');
const r = expand(macro);
console.log(JSON.stringify({ ins: r.instructions, und: r.undecidable }));
""")
    assert got["ins"] == ["X .set 3", "X .set X+5", "ldi R10, 1", "Y .set SOMETHING"]
    assert got["und"] == ["Y >= 1"]


def test_timing_block_dual_oracle_uses_shared_evaluator_and_fails_loudly():
    got = node_json(r"""
const t = require('./scripts/timing_block_dual_oracle');
const ok = t.expand(['m .macro A', '    .if (2 + 1) < 5', '    ldi R10, 1', '    .elseif 1', '    ldi R10, 2', '    .endif', '    .endm'].join('\n'), {});
let err = '';
try { t.expand(['m .macro A', '    .if MYSTERY >= 1', '    ldi R10, 1', '    .endif', '    .endm'].join('\n'), {}); } catch (e) { err = e.message; }
const counts = t.CASES.map(c => t.expand(t.loadBlock(c.rel).getMacro(c.opCode, c.opCode), c.subs).instructions.length);
console.log(JSON.stringify({ ok: ok.instructions, err, counts }));
""")
    assert got["ok"] == ["ldi R10, 1"]
    assert "undecidable .if condition: MYSTERY >= 1" in got["err"]
    assert got["counts"] == [25, 40, 4]
