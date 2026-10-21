"""RTU_PRU XFR2TR ring accelerator (SPRUIM2J 6.4.6.3.3, Table 6-112).

The heavy lifting (macro/allocator/simulator/validator arms, capacity/hold/drain
second-engine coverage, mutation arms) lives in scripts/sim/test_xfr2tr_ring.js,
which runs against the real production module -- not a copy. This file adds the
catalogue/capability guardrails plus a thin, independent invocation of the node
arm so a `pytest` run surfaces the same results.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAPS = ROOT / ".metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js"
BLOCK = ROOT / ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2tr_block.syscfg.js"


def node(code):
    return subprocess.run(["node", "-e", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def test_xfr2tr_capability_is_rtu_pru_only_icssg():
    caps = json.loads(node(
        "const c=require('./.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js');"
        "console.log(JSON.stringify(['am64x','am243x','am261x','am263px'].map(s=>c.isWidgetAvailable('xfr2tr',s))));"
    ))
    assert caps == [True, True, False, False], f"xfr2tr must be ICSSG-only (RTU_PRU cores), got {caps}"


def test_xfr2tr_catalogued_only_on_rtu_tx_pru_tree_of_icssg_socs():
    for soc in ("am64x", "am243x"):
        txt = (ROOT / f".metadata/sysconfig/.meta/soc/pru_blocks_{soc}.syscfg.js").read_text(encoding="utf-8")
        assert "xfr2tr_block" in txt, f"{soc} must catalogue xfr2tr_block"
        plain_pru = txt[txt.index("const topModules_pru"):txt.index("const topModules_rtu_tx_pru")]
        assert "xfr2tr_block" not in plain_pru, f"{soc}'s plain-PRU catalog must not carry xfr2tr_block (RTU_PRU only)"
    for soc in ("am261x",):  # ICSSM palette in this repository
        txt = (ROOT / f".metadata/sysconfig/.meta/soc/pru_blocks_{soc}.syscfg.js").read_text(encoding="utf-8")
        assert "xfr2tr_block" not in txt, f"{soc} (ICSSM, no RTU_PRU) must not catalogue xfr2tr_block"


def test_xfr2tr_device_ids_match_table_6_112():
    ids = json.loads(node(
        "const fs=require('fs'),vm=require('vm');"
        "const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2tr_block.syscfg.js','utf8');"
        "const sandbox={exports:{},console,system:{getScript:()=>({getSelfSysCfgCoreName:()=>'icss_g0_rtu_pru0'})}};"
        "vm.runInNewContext(src,sandbox,{filename:'xfr2tr_block'});"
        "console.log(JSON.stringify(sandbox.exports.deviceIds));"
    ))
    assert ids == {"sourceConfig": 0x70, "ringConfigStatus": 0x71, "submit": 0x72}


def test_xfr2tr_node_arm():
    result = subprocess.run(["node", "scripts/sim/test_xfr2tr_ring.js"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
