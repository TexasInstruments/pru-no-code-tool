"""macro expanders accept `label: instr` on one line.

The TI PRU assembler (clpru) accepts a label followed by an instruction on the
same line (e.g. `pb_ws?: sub r1, r1, 1`). The JS expanders used to treat a line
as a label only when the whole trimmed line ended with ':', so such a line was
misread as an instruction string and the label was never defined in the
expander's `labels` array (a later `qbne pb_ws?, ...` had no resolved target).

What these tests prove: splitLabel splits same-line and bare labels correctly,
and emit_all_blocks' expand() records the same-line label in `labels` and
resolves the branch target to it. They do NOT claim a classifier change:
block_control_flow already accepted `label: instr` before, so a
synthetic same-line macro grades SEQUENTIAL both before and after.
"""
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _node_cwd():
    # Sandboxed checkouts may report an extended-length (\\?\) cwd, whose
    # drive-relative form node's module resolver rejects (EISDIR lstat 'C:').
    # The plain drive path works in every checkout; elsewhere this is a no-op.
    return ROOT.replace("\\\\?\\", "")


def run_node(source, *args):
    return subprocess.run(["node", "-e", source, *args], cwd=_node_cwd(), text=True,
                          capture_output=True, check=False)


NODE_SPLIT = r"""
const { splitLabel } = require('./scripts/asm_label');
const cases = [
  'pb_ws?: sub r1, r1, 1',
  'lbl:',
  '  x_1: qbne x_1, r1, 0 ; comment: with colon',
  'ldi r1, 1 ; note: x',
  '.if A:B',
  '; full line comment: ignored',
  '',
  'a?:',
];
console.log(JSON.stringify(cases.map((c) => splitLabel(c))));
"""


def test_helper_splits_same_line_and_bare_labels():
    result = run_node(NODE_SPLIT)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    assert got[0] == {"label": "pb_ws?", "rest": "sub r1, r1, 1"}, got[0]
    assert got[1] == {"label": "lbl", "rest": ""}, got[1]
    assert got[2] == {"label": "x_1", "rest": "qbne x_1, r1, 0"}, got[2]
    assert got[6] is None, got[6]
    assert got[7] == {"label": "a?", "rest": ""}, got[7]


def test_helper_leaves_non_label_colons_alone():
    result = run_node(NODE_SPLIT)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    # ':' inside an operand comment is not a label; the code before ';' stands.
    assert got[3] == {"label": None, "rest": "ldi r1, 1"}, got[3]
    # directive guard `.if A:B` is not a label either.
    assert got[4] == {"label": None, "rest": ".if A:B"}, got[4]
    # comment-only lines carry no code at all.
    assert got[5] is None, got[5]


NODE_EXPAND = r"""
const { expand } = require('./scripts/emit_all_blocks');
const macro = [
  'm_test .macro RES',
  '    ldi r1, 2',
  'pb_ws?: sub r1, r1, 1',
  '    qbne pb_ws?, r1, 0',
  '    halt',
  '    .endm',
].join('\n');
const x = expand(macro);
// Same target lookup block_control_flow.reachEnd performs: every branch target
// must be defined by labels/aliases/trailing (re-implemented inline here; this
// does not run the classifier).
const defs = new Set(x.trailingAliases.concat([x.trailingLabel].filter(Boolean)));
x.aliases.forEach((a) => a.forEach((l) => defs.add(l)));
x.labels.forEach((l) => { if (l) defs.add(l); });
// TI branch syntax is LABEL-first: the target is the first operand.
const branchTargets = x.instructions
  .filter((i) => /^(qba|qbne|qbeq|qbgt|qblt|qbge|qble|qbbs|qbbc)\b/i.test(i))
  .map((i) => i.split(',').map((s) => s.trim())[0].split(/\s+/).pop());
console.log(JSON.stringify({
  instructions: x.instructions,
  labels: x.labels,
  aliases: x.aliases,
  unresolved: branchTargets.filter((t) => !defs.has(t)),
}));
"""


def test_emit_all_blocks_resolves_same_line_branch_target():
    """A synthetic macro using a same-line label as a branch target expands with
    the label defined at that instruction in the expander's `labels` array
    (the defect fixed: it was 0 there) and no unresolved branch target by an
    inline target lookup. It does not exercise the classifier."""
    result = run_node(NODE_EXPAND)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    assert got["instructions"] == [
        "ldi r1, 2", "sub r1, r1, 1", "qbne pb_ws_1, r1, 0", "halt"], got
    assert got["labels"] == [0, "pb_ws_1", 0, 0], got
    assert got["aliases"][1] == ["pb_ws_1"], got
    assert got["unresolved"] == [], got


NODE_STACKED = r"""
const { expand } = require('./scripts/emit_all_blocks');
const macro = [
  'm_test .macro RES',
  'a?:',
  'b?: sub r1, r1, 1',
  '    qbne b?, r1, 0',
  '    halt',
  '    .endm',
].join('\n');
const x = expand(macro);
console.log(JSON.stringify({ labels: x.labels, aliases: x.aliases,
                             instructions: x.instructions }));
"""


def test_stacked_labels_over_same_line_instruction_keep_working():
    result = run_node(NODE_STACKED)
    assert result.returncode == 0, result.stderr
    got = json.loads(result.stdout)
    assert got["instructions"] == ["sub r1, r1, 1", "qbne b_1, r1, 0", "halt"], got
    # last label wins for the JS core; every stacked name stays defined.
    assert got["labels"][0] == "b_1", got
    assert got["aliases"][0] == ["a_1", "b_1"], got
