"""sample the register file where a generated-asm macro has just produced its value.

The allocator releases a block's registers after its last consumer, so a test that reads the register file at HALT sees
whatever later blocks left there. A value is only meaningful at the instruction that produced it. This module turns
"the line of pru_syscfg.asm that invokes macro M" into an ELF instruction address (clpru assembler listing + linker map)
and records the register file the first time the core is about to execute that address, which is the state right after
the macro finished.

Build the firmware with ``DFLAGS=--asm_listing --list_directory=<generated dir>`` (see ``LISTING_DFLAGS``) so
``pru_syscfg.lst`` sits next to the map. The register values come from the real clpru ELF running on TI pru-simulator.
"""

import os
import re

LISTING_NAME = "pru_syscfg.lst"
ENTRY_LABEL = "sysconfig_generated_start"
# A top-level listing row: "<source line> <8 hex byte offset> [<opcode hex>] <source text>". Macro-expansion rows start
# with a nesting digit in column 0 and wide padding, so the single space after the line number excludes them.
_ROW = re.compile(r"^\s*(\d+) ([0-9a-f]{8})(?: +[0-9A-F]{14})?\s*(.*)$")


def listing_dflags(generated_dir):
    """gmake DFLAGS that make clpru write pru_syscfg.lst into the firmware's generated directory."""
    return "DFLAGS=--asm_listing --list_directory=" + str(generated_dir).replace("\\", "/")


def parse_listing(listing_text):
    """Top-level rows of the assembler listing as [(source_line, byte_offset, text)] in file order."""
    rows = []
    for raw in listing_text.splitlines():
        m = _ROW.match(raw)
        if m:
            rows.append((int(m.group(1)), int(m.group(2), 16), m.group(3).strip()))
    return rows


def entry_pc(map_text):
    """Instruction index (word address) of sysconfig_generated_start in the linked image, from the linker map."""
    m = re.search(r"^\s*\d+\s+([0-9A-Fa-f]{8})\s+" + ENTRY_LABEL + r"\s*$", map_text, re.M)
    assert m, f"{ENTRY_LABEL} missing from the linker map"
    return int(m.group(1), 16) // 4


def macro_end_pcs(listing_text, map_text, macro_names):
    """{macro_name: pc of the instruction that runs right after that macro's expansion}.

    The macro is looked up by its mnemonic at the start of a top-level listing row and must be invoked exactly once.
    The core is about to execute the returned pc exactly when the macro (and so the value it produces) is complete.
    """
    rows = parse_listing(listing_text)
    label = [off for _, off, text in rows if text.startswith(ENTRY_LABEL + ":")]
    assert label, f"{ENTRY_LABEL}: missing from the assembler listing"
    base = entry_pc(map_text) - label[0] // 4
    out = {}
    for name in macro_names:
        hits = [i for i, (_, _, text) in enumerate(rows) if re.match(re.escape(name) + r"\b", text)]
        assert len(hits) == 1, f"{name} must appear exactly once in the listing, found {len(hits)}"
        off = rows[hits[0]][1]
        nxt = [o for _, o, _ in rows[hits[0] + 1:] if o > off]
        assert nxt, f"no instruction follows {name} in the listing"
        out[name] = base + nxt[0] // 4
    return out


def listing_and_map(generated_dir, map_name):
    with open(os.path.join(generated_dir, LISTING_NAME), encoding="utf-8", errors="replace") as f:
        listing = f.read()
    with open(os.path.join(generated_dir, map_name), encoding="utf-8", errors="replace") as f:
        mapped = f.read()
    return listing, mapped


class RegisterProbe:
    """Hook for the simulator step loop: copies the register file the first time each watched pc is about to execute."""

    def __init__(self, core, pcs):
        self.core = core
        self.watch = {pc: name for name, pc in pcs.items()}
        assert len(self.watch) == len(pcs), "two probes share one pc"
        self.at = {}

    def __call__(self, sim):
        pc = sim.cores[self.core].pc
        name = self.watch.get(pc)
        if name is not None and name not in self.at:
            self.at[name] = [r & 0xFFFFFFFF for r in sim.registers(self.core)]
