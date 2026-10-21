"""redo: RTU_PRU XFR2TR ring — closure of the four gaps.

Gap 1: sourceBase/ringBase outside PRU_ICSSG Shared RAM / Data RAM2 (0x00010000-0x0001FFFF)
       and >18-bit truncation (R6[17:0]) were silently aliased. Now refused.
Gap 2: 4KB source-TR ceiling missing. Now enforced, keyed on sourceTrCount*trSize <=4096
       (the SOURCE TR list), not ringEntries (the destination ring, which Table 6-112 allows
       up to 4096 entries in its own right).
Gap 3: no-doorbell / no-hardware-ring-completion undocumented. Now documented.
Gap 4: getCoreType used loose includes("rtu") matching artu/virtual. Now tight rtu_pru.

Beyond the four gaps, the item's own asks that the gap list did not cover are armed too:
the ring-vs-submit TRAP (cross-instance, via scripts/global_runner.js against the
SHIPPED validateXfr2trGlobal), the N-1 tr_rsrc_nums encoder, and the hole in the
left-packed ID list.

Heavy arms live in scripts/sim/test_xfr2tr_bounds.js (real module via vm, not a copy).
This file adds catalogue/capability parity plus a thin node invocation so pytest surfaces it.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node(code):
    return subprocess.run(["node", "-e", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def test_node_arm():
    result = subprocess.run(["node", "scripts/sim/test_xfr2tr_bounds.js"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_xfr2tr_docs_mention_no_doorbell_and_no_completion():
    block = (ROOT / ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2tr_block.syscfg.js").read_text(encoding="utf-8")
    assert "No doorbell" in block, "xfr2tr_block must document No doorbell"
    assert "No hardware ring completion" in block, "xfr2tr_block must document No hardware ring completion"
    # also in the exported longDescription
    long_desc = json.loads(node(
        "const fs=require('fs'),vm=require('vm');"
        "const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2tr_block.syscfg.js','utf8');"
        "const sb={exports:{},console,system:{getScript:()=>({getSelfSysCfgCoreName:()=>'icss_g0_rtu_pru0'})}};"
        "vm.runInNewContext(src,sb,{filename:'xfr2tr'});"
        "console.log(JSON.stringify(sb.exports.longDescription));"
    ))
    assert "No doorbell" in long_desc
    assert "No hardware ring completion" in long_desc


def test_xfr2tr_getcoretype_is_tight():
    """Behavioural, not textual.

    The previous version of this test grepped the source for the literal
    `includes("rtu_pru")`, but the deliberate fix tightens the check
    to `includes("_rtu_pru")` (leading underscore, so "icss_g0_rtu_pru0"
    still matches while a hypothetical "icss_g0_artu_pru0" does not) -- so
    the grepped literal is not a substring of the real source and the test
    failed at its own commit even though the implementation was correct.

    Drive validate() with every real core-name string that occurs in this
    repo's device topology (pru_blocks_am64x/am243x.syscfg.js) and assert
    each is classified correctly, instead of grepping for how it is spelled.
    """
    block_path = ROOT / ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2tr_block.syscfg.js"
    real_rtu = ["icss_g0_rtu_pru0", "icss_g0_rtu_pru1", "icss_g1_rtu_pru0", "icss_g1_rtu_pru1"]
    real_tx = ["icss_g0_tx_pru0", "icss_g0_tx_pru1", "icss_g1_tx_pru0", "icss_g1_tx_pru1"]
    real_pru = ["icss_g0_pru0", "icss_g0_pru1", "icss_g1_pru0", "icss_g1_pru1"]
    names = real_rtu + real_tx + real_pru

    result = json.loads(node(
        "const fs=require('fs'),vm=require('vm');"
        f"const src=fs.readFileSync({json.dumps(str(block_path))},'utf8');"
        f"const names={json.dumps(names)};"
        "const out={};"
        "for(const n of names){"
        "  const sb={exports:{},console,system:{getScript:()=>({getSelfSysCfgCoreName:()=>n})}};"
        "  vm.runInNewContext(src,sb,{filename:'xfr2tr_block.syscfg.js'});"
        "  const errs=[];"
        "  sb.exports.validate({operation:'status'},{logError:(m)=>errs.push(String(m)),logWarning:()=>{}});"
        "  out[n]=errs;"
        "}"
        "console.log(JSON.stringify(out));"
    ))

    for name in real_rtu:
        assert result[name] == [], f"{name} is a real RTU_PRU core and must be accepted, got {result[name]}"
    for name in real_tx + real_pru:
        assert any("RTU_PRU" in e for e in result[name]), \
            f"{name} must be rejected as not RTU_PRU, got {result[name]}"


def test_xfr2tr_caps_still_icssg_only():
    caps = json.loads(node(
        "const c=require('./.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js');"
        "console.log(JSON.stringify(['am64x','am243x','am261x','am263px'].map(s=>c.isWidgetAvailable('xfr2tr',s))));"
    ))
    assert caps == [True, True, False, False]
