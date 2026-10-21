"""block-module detection must look at declarations, not at a bare 'getPinUsage' substring.

The pin-rule guards (test ZERO_CLAIM_AT_DEFAULTS via check_pin_collisions.js --defaults-report,
test classifier coverage via block_control_flow.js) must not enrol a .syscfg.js just because its
text contains the token: the GUI validator (common/pru_blocks_static_module.syscfg.js) mentions and
calls getPinUsage in plain text and must not be treated as a block.

Two independent detectors, which must agree on the real library:
  * scripts/pin_usage_blocks.js  - loads the module; moduleStatic.getPinUsage is a function.
  * tests/js_source.declares     - code-only (comments/strings blanked), non-member occurrence.
"""
import json
import os
import shutil
import subprocess

import pytest

from js_source import code_only, declares

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOCKS_REL = os.path.join(".metadata", "sysconfig", ".meta", "pru_blocks")
BLOCKS_DIR = os.path.join(ROOT, BLOCKS_REL)
STATIC_REL = "common/pru_blocks_static_module.syscfg.js"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


# ------------------------------------------------------------------ the Python detector, unit arms
@pytest.mark.parametrize("src", [
    "// returns malformed getPinUsage results\nconst x = 1;",
    "/* getPinUsage(inst) {\n   return []; } */\nconst x = 1;",
    'const msg = "getPinUsage: function";',
    "const msg = 'getPinUsage(inst) {';",
    "const msg = `getPinUsage: ${1}`;",
    "pins = moduleStatic.getPinUsage(bi);",
    "if (typeof ms.getPinUsage !== 'function') return;",
    "ms.getPinUsage = function () { throw new Error('x'); };",
    "const myGetPinUsageWrapper = 1; const getPinUsageX = 2;",
])
def test_mentions_and_member_uses_are_not_declarations(src):
    assert not declares(src, "getPinUsage"), src


@pytest.mark.parametrize("src", [
    "moduleStatic: { getPinUsage: function(inst) { return []; } }",
    "moduleStatic: { getPinUsage: (inst) => [] }",
    "moduleStatic: { getPinUsage(inst) { return []; } }",
    "function getPinUsage(inst) { return []; }\nconst moduleStatic = { getPinUsage };",
    "// mentions getPinUsage first\nmoduleStatic: { getPinUsage: (i) => [] }",
])
def test_declaration_forms_are_detected(src):
    assert declares(src, "getPinUsage"), src


def test_code_only_keeps_line_structure():
    src = "a // c1\n/* c2\nc3 */ b 'x\\'y' \"z\" `t\nu`\n"
    out = code_only(src)
    assert out.count("\n") == src.count("\n") and len(out) == len(src)
    assert "c1" not in out and "c3" not in out and "x" not in out and "u" not in out
    assert "a" in out and "b" in out


# ------------------------------------------------------------------ the real library
def _js_blocks(root=ROOT):
    res = subprocess.run(["node", os.path.join(root, "scripts", "pin_usage_blocks.js"), "--json",
                          os.path.join(root, BLOCKS_REL)], capture_output=True, text=True)
    return res, (json.loads(res.stdout) if res.stdout.strip() else None)


def _py_blocks(blocks_dir=BLOCKS_DIR):
    out = set()
    for d, _, files in os.walk(blocks_dir):
        for f in files:
            if f.endswith(".syscfg.js"):
                p = os.path.join(d, f)
                with open(p, encoding="utf8") as fh:
                    if declares(fh.read(), "getPinUsage"):
                        out.add(os.path.relpath(p, blocks_dir).replace(os.sep, "/"))
    return out


@needs_node
def test_static_module_mentions_getPinUsage_and_is_not_a_block():
    """The hazard is live on this tree (the static module's text contains the token, in a comment
    and in the GUI validator's call) and both detectors still leave it out."""
    with open(os.path.join(BLOCKS_DIR, STATIC_REL), encoding="utf8") as f:
        text = f.read()
    assert "malformed getPinUsage results" in text
    assert "moduleStatic.getPinUsage(bi)" in text
    res, js = _js_blocks()
    assert res.returncode == 0 and js["errors"] == [], res.stdout + res.stderr
    assert STATIC_REL not in js["blocks"]
    assert STATIC_REL not in _py_blocks()


@needs_node
def test_two_detectors_agree_on_the_real_library():
    res, js = _js_blocks()
    assert res.returncode == 0, res.stdout + res.stderr
    py = _py_blocks()
    assert len(py) >= 35, len(py)
    assert set(js["blocks"]) == py, sorted(set(js["blocks"]) ^ py)


@needs_node
def test_defaults_report_and_classifier_skip_the_static_module():
    rep = subprocess.run(["node", os.path.join(ROOT, "scripts", "check_pin_collisions.js"), "--defaults-report"],
                         capture_output=True, text=True)
    assert rep.returncode == 0, rep.stdout + rep.stderr
    assert STATIC_REL not in json.loads(rep.stdout)
    cls = subprocess.run(["node", os.path.join(ROOT, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    assert cls.returncode == 0, cls.stdout + cls.stderr
    assert "pru_blocks_static_module" not in {r["id"] for r in json.loads(cls.stdout)}


# ------------------------------------------------------------------ synthetic modules in a scratch tool root
MENTION_ONLY = r'''"use strict";
// synthetic: talks about getPinUsage but declares none.
const mod = {
    displayName: "mention only", defaultInstanceName: "MENTION_",
    config: [{ name: "note", default: "see getPinUsage: (inst) => []" }],
    ports: (inst) => [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }],
    moduleStatic: { describe: () => "getPinUsage(inst) is not here" },
};
exports = mod;
'''

DECLARING = r'''"use strict";
const mod = {
    displayName: "declaring", defaultInstanceName: "DECL_",
    config: [{ name: "pin", default: "4" }, { name: "opCode", default: "m_decl", hidden: true }],
    ports: (inst) => [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }],
    moduleStatic: { getPinUsage(inst) { return [{ pin: inst.pin, dir: "GPO" }]; } },
    getMacro(m, opCode) { return ["m_decl .macro", "    set r30, r30, 4", "    .endm"].join("\n"); },
};
exports = mod;
'''

BROKEN = '''"use strict";
// mentions getPinUsage, then fails to load
throw new Error("load failure");
'''


def _tool_root(tmp_path, files):
    root = tmp_path / "root"
    shutil.copytree(os.path.join(ROOT, "scripts"), str(root / "scripts"),
                    ignore=shutil.ignore_patterns("fixtures", "sim"))
    shutil.copytree(os.path.join(ROOT, ".metadata", "sysconfig", ".meta"),
                    str(root / ".metadata" / "sysconfig" / ".meta"))
    for name, text in files.items():
        p = root / BLOCKS_REL / "pru_io_blocks" / (name + ".syscfg.js")
        p.write_text(text, encoding="utf8", newline="")
    return str(root)


@needs_node
def test_comment_only_module_is_not_enrolled_and_a_declaring_one_is(tmp_path):
    """Red/green pair in one tree: the mention-only module contains the token (a plain substring
    rule enrols it) but no declaration; the declaring module is the positive control."""
    root = _tool_root(tmp_path, {"mention": MENTION_ONLY, "decl": DECLARING})
    assert "getPinUsage" in MENTION_ONLY
    mention, decl = "pru_io_blocks/mention.syscfg.js", "pru_io_blocks/decl.syscfg.js"

    res, js = _js_blocks(root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert decl in js["blocks"] and mention not in js["blocks"], js

    py = _py_blocks(os.path.join(root, BLOCKS_REL))
    assert decl in py and mention not in py

    rep = subprocess.run(["node", os.path.join(root, "scripts", "check_pin_collisions.js"), "--defaults-report"],
                         capture_output=True, text=True)
    assert rep.returncode == 0, rep.stdout + rep.stderr
    report = json.loads(rep.stdout)
    assert mention not in report
    assert report[decl] == {"claims": [{"dir": "GPO", "pin": 4, "bidi": False}], "problems": []}, report[decl]

    cls = subprocess.run(["node", os.path.join(root, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    assert cls.returncode == 0, cls.stdout + cls.stderr
    ids = {r["id"] for r in json.loads(cls.stdout)}
    assert "decl" in ids and "mention" not in ids


@needs_node
def test_candidate_that_fails_to_load_fails_closed(tmp_path):
    """A module that mentions the token but cannot be loaded is an error, never silently dropped."""
    root = _tool_root(tmp_path, {"broken": BROKEN})
    broken = "pru_io_blocks/broken.syscfg.js"
    res, js = _js_blocks(root)
    assert res.returncode == 1, res.stdout + res.stderr
    assert [e["rel"] for e in js["errors"]] == [broken] and "load failure" in js["errors"][0]["error"]

    rep = subprocess.run(["node", os.path.join(root, "scripts", "check_pin_collisions.js"), "--defaults-report"],
                         capture_output=True, text=True)
    report = json.loads(rep.stdout)
    assert report[broken]["claims"] is None and "load failure" in report[broken]["problems"][0]

    cls = subprocess.run(["node", os.path.join(root, "scripts", "block_control_flow.js"), "--json"],
                         capture_output=True, text=True)
    assert cls.returncode == 1 and "broken" in cls.stderr, cls.stdout + cls.stderr
