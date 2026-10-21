"""elf_cosim.py - closed-loop co-simulation: real clpru ELF <-> DeviceModel.

Pipeline:
    1. expand a NoCodePRU block macro via scripts/sim/emit_block_asm.js (Node)
    2. assemble+link with clpru into a real COFF .out ELF
    3. load the ELF into the TI pru-simulator (Python, tools/pru-simulator-upstream)
    4. step instruction-by-instruction; each step the DeviceModel sees the PRU
       GPO word (pins_out) and drives the GPI word the PRU samples next
    5. return the per-step resolved trace so an independent bus-cosim decoder
       (pru_device_models/buscosim.py) can re-derive the protocol events

Nothing here judges protocol correctness - that is the tests' job.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

#: PRU constant-table entry 26 is the ICSS IEP0 register block (0x0002E000) on
#: AM64x/AM243x. A pru-simulator checkout whose config/constants_am243x.cfg maps
#: c26 elsewhere still places its IEP model at 0x0002E000, so firmware that
#: programs the IEP through c26 passes this to run_elf_closed_loop(constants=...).
IEP_CONSTANTS = {26: 0x0002E000}

CLPRU_CANDIDATES = [
    str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru.exe"),
    str(TI_TOOLS / "ti-cgt-pru_2.3.3" / "bin" / "clpru"),
    "/opt/ti/ti-cgt-pru_2.3.3/bin/clpru",
]

LINKER_CMD = """\
MEMORY {
    PAGE 0: PRU_IMEM  : org = 0x00000000 len = 0x00004000
    PAGE 1: PRU0_DMEM : org = 0x00000000 len = 0x00002000
}
SECTIONS {
    .text > PRU_IMEM, PAGE 0
    .data > PRU0_DMEM, PAGE 1
    .bss  > PRU0_DMEM, PAGE 1
}
"""


def find_clpru() -> str:
    env = os.environ.get("CGT_TI_PRU_PATH")
    if env:
        cand = os.path.join(env, "bin", "clpru.exe")
        if os.path.exists(cand):
            return cand
        cand = os.path.join(env, "bin", "clpru")
        if os.path.exists(cand):
            return cand
    for cand in CLPRU_CANDIDATES:
        if os.path.exists(cand):
            return cand
    raise RuntimeError("clpru not found; set CGT_TI_PRU_PATH")


def _is_simulator_checkout(path: str) -> bool:
    """A directory counts as a TI pru-simulator checkout only when it holds simulator.py;
    a directory that merely has the expected name is skipped."""
    return os.path.isfile(os.path.join(path, "simulator.py"))


def simulator_iep_base() -> Optional[int]:
    """Base address of the checkout's IEP0 register model, or None if it has none."""
    sim_dir = find_pru_simulator()
    with _sim_namespace(sim_dir):
        from simulator import Simulator  # type: ignore

        sim = Simulator(os.path.join(sim_dir, "memory.cfg"))
        for region in getattr(sim.memory, "regions", []):
            if getattr(region, "name", "") == "ICSS_IEP":
                return region.base_addr
    return None


class SimulatorNotFound(RuntimeError):
    """TI pru-simulator checkout not found. Tests treat it as a skip (see conftest.py)."""


def find_pru_simulator() -> str:
    """Locate the TI pru-simulator checkout: PRU_SIMULATOR_PATH, else a
    tools/pru-simulator-upstream directory in this checkout or any parent
    directory (so worktrees at any depth resolve). Only a directory that
    contains simulator.py counts."""
    tried = []
    env = os.environ.get("PRU_SIMULATOR_PATH")
    if env:
        tried.append(env)
        if _is_simulator_checkout(env):
            return env
    d = REPO_ROOT
    while True:
        cand = os.path.join(d, "tools", "pru-simulator-upstream")
        tried.append(cand)
        if _is_simulator_checkout(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    raise SimulatorNotFound(
        "no pru-simulator checkout found (set PRU_SIMULATOR_PATH); "
        "looked for simulator.py in: " + " | ".join(tried))


def expand_block_asm(spec: Dict[str, Any], workdir: str) -> str:
    """Run the Node emitter and return the expanded assembly text."""
    spec_path = os.path.join(workdir, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f)
    emitter = os.path.join(REPO_ROOT, "scripts", "sim", "emit_block_asm.js")
    res = subprocess.run(["node", emitter, spec_path], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"emit_block_asm failed: {res.stderr}\n{res.stdout}")
    return res.stdout


def compile_asm(asm_text: str, workdir: str, name: str) -> str:
    asm_path = os.path.join(workdir, f"{name}.asm")
    cmd_path = os.path.join(workdir, f"{name}.cmd")
    out_path = os.path.join(workdir, f"{name}.out")
    with open(asm_path, "w", encoding="utf-8") as f:
        f.write(asm_text)
    with open(cmd_path, "w", encoding="utf-8") as f:
        f.write(LINKER_CMD)
    clpru = find_clpru()
    res = subprocess.run(
        # --obj_directory: without it clpru drops <name>.obj in the CALLER's
        # cwd, which for pytest is the repo root.
        [clpru, "-v3", "-O2", f"--obj_directory={workdir}", asm_path,
         "-z", cmd_path, "-o", out_path, "--entry_point=main"],
        capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(
            f"clpru failed (rc={res.returncode}):\n{res.stdout}\n{res.stderr}")
    return out_path


@dataclass
class CosimResult:
    trace: List[Tuple[int, int, int]] = field(default_factory=list)
    # (cycle, gpo_word, gpi_word) per step, gpo as driven by the PRU *before*
    # the step, gpi as applied by the model for that step.
    registers: List[int] = field(default_factory=list)
    cycles: int = 0
    halted: bool = False
    steps: int = 0


def run_elf_closed_loop(
    elf_path: str,
    model,
    max_steps: int = 20000,
    core: str = "pru0",
    on_step=None,
    constants: Optional[Dict[int, int]] = None,
) -> CosimResult:
    """Run a real ELF against a DeviceModel in a closed pin loop.

    ``model`` implements the DeviceModel interface:
    tick(cycle, pins_out) -> pins_in (GPI word).
    ``on_step`` (optional) is called each step with (cycle, gpo, gpi, sim) so
    tests can inject extra stimuli (e.g. an EnDat mode command).
    ``constants`` (optional) overrides constant-table entries {index: address}
    before the run, for firmware that relies on an entry the simulator's
    config maps differently from the device (see IEP_CONSTANTS).
    """
    sim_dir = find_pru_simulator()
    # Run the whole loop with the simulator's packages first on sys.path, so its
    # absolute imports (incl. lazy ones inside methods) resolve to the checkout
    # even if another copy of a same-named package was imported earlier.
    with _sim_namespace(sim_dir):
        from simulator import Simulator  # type: ignore

        sim = Simulator(os.path.join(sim_dir, "memory.cfg"))
        errors = sim.load_elf(core, open(elf_path, "rb").read())
        if errors:
            raise RuntimeError(f"ELF load errors: {errors}")
        pru = sim.cores[core]
        for index, address in (constants or {}).items():
            pru.constant_table.set(index, address)

        result = CosimResult()
        result = _loop(sim, pru, core, model, max_steps, on_step)
    return result


@contextlib.contextmanager
def _sim_namespace(sim_dir: str):
    # Bind the checkout's top-level packages (core/, perif/, pru_io/, ...) for
    # the duration and restore sys.modules afterwards.
    colliding = [
        d for d in os.listdir(sim_dir)
        if os.path.isfile(os.path.join(sim_dir, d, "__init__.py"))
        or os.path.isfile(os.path.join(sim_dir, d + ".py"))
    ]
    tops = set(colliding) | {"core", "simulator", "tools"}
    saved = {k: sys.modules.pop(k) for k in list(sys.modules)
             if k.split(".")[0] in tops}
    saved_path = list(sys.path)
    sys.path.insert(0, sim_dir)
    try:
        yield
    finally:
        for k in [k for k in list(sys.modules) if k.split(".")[0] in tops]:
            del sys.modules[k]
        sys.modules.update(saved)
        sys.path[:] = saved_path


def _loop(sim, pru, core, model, max_steps, on_step) -> CosimResult:
    result = CosimResult()
    for step in range(max_steps):
        gpo_pins = pru.io_port.get_gpo_pins()
        gpo_word = 0
        for n, b in enumerate(gpo_pins):
            if b:
                gpo_word |= (1 << n)
        cycle = pru.counters.cycles
        gpi_word = model.tick(cycle, gpo_word) & 0xFFFFF
        if on_step is not None:
            on_step(cycle, gpo_word, gpi_word, sim)
        pru.io_port.set_gpi_word(gpi_word)
        result.trace.append((cycle, gpo_word, gpi_word))
        sim.step(core, 1)
        if pru.halted:
            result.halted = True
            break
    result.steps = step + 1 if max_steps else 0
    result.cycles = pru.counters.cycles
    result.registers = list(sim.registers(core))
    return result


def build_block_firmware(spec: Dict[str, Any], name: str,
                         workdir: Optional[str] = None) -> Tuple[str, str]:
    """Expand + compile a block macro; returns (elf_path, asm_path)."""
    if workdir is None:
        workdir = tempfile.mkdtemp(prefix=f"{name}_")
    os.makedirs(workdir, exist_ok=True)
    asm_text = expand_block_asm(spec, workdir)
    elf_path = compile_asm(asm_text, workdir, name)
    return elf_path, os.path.join(workdir, f"{name}.asm")
