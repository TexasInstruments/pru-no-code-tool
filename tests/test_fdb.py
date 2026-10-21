"""FDB Generic RAM + compare, 16 KB table + arbitrated IPC.

Heavy lifting lives in scripts/sim/test_fdb.js (real module, real
allocator, real simulator, mutation-coupled red arms). This file adds
catalogue/capability guardrails plus a thin invocation so `pytest` surfaces
the same results. Same shape as tests/test_xfr2tr_ring.py.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def node(code):
    return subprocess.run(["node","-e",code], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()

def test_fdb_capability_is_icssg_only():
    caps = json.loads(node(
        "const c=require('./.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js');"
        "console.log(JSON.stringify(['am64x','am243x','am261x','am263px'].map(s=>c.isWidgetAvailable('fdb_gp',s))));"
    ))
    assert caps == [True, True, False, False], f"fdb_gp must be ICSSG-only (PRU0/1), got {caps}"

def test_fdb_catalogued_only_on_pru_tree_of_icssg_socs():
    for soc in ("am64x","am243x"):
        txt = (ROOT / f".metadata/sysconfig/.meta/soc/pru_blocks_{soc}.syscfg.js").read_text(encoding="utf-8")
        assert "fdb_gp_ram_block" in txt, f"{soc} must catalogue fdb_gp_ram_block"
        pru = txt[txt.index("const topModules_pru"):txt.index("const topModules_rtu_tx_pru")]
        assert "fdb_gp_ram_block" in pru, f"{soc}'s plain-PRU catalog must carry fdb_gp_ram_block (PRU0/1 only)"
        rtu = txt[txt.index("const topModules_rtu_tx_pru"):]
        assert "fdb_gp_ram_block" not in rtu, f"{soc}'s RTU/TX catalog must NOT carry fdb_gp_ram_block"
    # am261x is ICSSM - must not offer fdb
    txt = (ROOT / ".metadata/sysconfig/.meta/soc/pru_blocks_am261x.syscfg.js").read_text(encoding="utf-8")
    assert "fdb_gp_ram_block" not in txt, "am261x (ICSSM) must NOT catalogue fdb_gp_ram_block"

def test_fdb_device_ids_match():
    ids = json.loads(node(
        "const fs=require('fs'),vm=require('vm');"
        "const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/fdb_gp_ram_block.syscfg.js','utf8');"
        "const sb={exports:{},console,system:{getScript:()=>({getSelfSysCfgCoreName:()=>'icss_g0_pru0'})}};"
        "vm.runInNewContext(src,sb,{filename:'fdb'});"
        "console.log(JSON.stringify(sb.exports.deviceIds));"
    ))
    assert ids == {"dataAddr": 30, "pattern": 31, "compareResult": 35}

def test_fdb_docs_state_limits():
    long_desc = node(
        "const fs=require('fs'),vm=require('vm');"
        "const src=fs.readFileSync('.metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/fdb_gp_ram_block.syscfg.js','utf8');"
        "const sb={exports:{},console,system:{getScript:()=>({getSelfSysCfgCoreName:()=>'icss_g0_pru0'})}};"
        "vm.runInNewContext(src,sb,{filename:'fdb'});"
        "console.log(sb.exports.longDescription);"
    )
    assert "NOT a search" in long_desc
    assert "CURRENTLY ADDRESSED ROW" in long_desc
    assert "NO cycle advantage" in long_desc

def test_fdb_node_arm():
    result = subprocess.run(["node","scripts/sim/test_fdb.js"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
