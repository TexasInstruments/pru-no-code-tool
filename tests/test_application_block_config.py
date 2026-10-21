"""Configuration checks of the application blocks: BiSS-C field validation, the IPC write's
cycle count, the IPC memory sections, and the SSI timeout that is not implemented.

Each block module is loaded with scripts/dual_oracle_harness.js loadBlockModule (the same loader
the macro tests use) and evaluated with node; no SysConfig installation is needed.
"""
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP = "application_specific"


def node_eval(block, fields, expr):
    script = """const {loadBlockModule}=require('./scripts/dual_oracle_harness');
const m=loadBlockModule(process.argv[1],process.argv[2]);
const i=Object.assign(Object.fromEntries(m.config.map(c=>[c.name,c.default])),JSON.parse(process.argv[3]));
const errors=[];const v={logError:(msg,_inst,field)=>errors.push([msg,field]),logWarning:()=>{},logInfo:()=>{}};
console.log(JSON.stringify(eval(process.argv[4])));"""
    out = subprocess.check_output(["node", "-e", script, block, APP, json.dumps(fields), expr],
                                  cwd=ROOT, text=True)
    return json.loads(out)


def biss_errors(**fields):
    return node_eval("biss_c_initiator_block", fields, "(m.validate?m.validate(i,v):null,errors)")


def test_biss_c_defaults_are_valid():
    assert biss_errors() == []


@pytest.mark.parametrize("bad", [0, 33, 1.5, -1])
def test_biss_c_data_length_outside_one_register_is_an_error(bad):
    assert [e[1] for e in biss_errors(dataLen=bad)] == ["dataLen"]


def test_biss_c_clock_and_data_on_one_pin_is_an_error():
    assert ["clkPin"] == [e[1] for e in biss_errors(clkPin=3, dataPin=3)]


@pytest.mark.parametrize("field", ["clkPin", "dataPin"])
def test_biss_c_pin_outside_the_pru_range_is_an_error(field):
    assert field in [e[1] for e in biss_errors(**{field: 20})]


def macro_cycles(text):
    """Instruction count of a macro body: ldi32 assembles to two instructions, others to one."""
    n = 0
    for line in text.splitlines():
        code = line.split(";", 1)[0].strip()
        if not code or code.startswith(".") or code.endswith(":") or ".macro" in code:
            continue
        n += 2 if re.match(r"ldi32\b", code, re.I) else 1
    return n


def test_ipc_write_cycle_count_matches_its_macro():
    got = node_eval("ipc_shared_mem_block", {},
                    "({macro:m.getMacro('','m_ipc_shmem_write'),"
                    "cycles:m.config.find(c=>c.name==='noOfCycles').getValue(i)})")
    assert got["cycles"] == macro_cycles(got["macro"]) == 4


def test_ipc_memory_sections_are_distinct():
    options = node_eval("ipc_shared_mem_block", {},
                        "m.config.find(c=>c.name==='memorySection').options.map(o=>o.name)")
    assert options == ["PRU_SHARED_RAM", "PRU_DRAM_0"]
    static = (ROOT / ".metadata/sysconfig/.meta/pru_blocks/common/pru_blocks_static_module.syscfg.js").read_text(
        encoding="utf-8")
    assert '"PRU_DRAM_1"' not in static


def test_ssi_timeout_is_not_offered_as_a_working_control():
    got = node_eval("ssi_initiator_block", {},
                    "({hidden:m.config.find(c=>c.name==='timeoutCycles').hidden,"
                    "macro:m.getMacro('m_ssi_read','m_ssi_read'),desc:m.longDescription})")
    assert got["hidden"] is True
    assert "2=timeout" not in got["macro"]
    assert "and timeout" not in got["desc"]
