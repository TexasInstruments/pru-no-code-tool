"""Every shipped PRU linker command file places the Memory Variable block's sections.

The Memory Variable block reserves its buffers with `.usect ".udmem"` (data RAM)
and `.usect ".usmem"` (shared RAM). A linker command file without a rule for a
section lets clpru put it in the first memory that fits, which is instruction
RAM directly after .text, so a "shared memory" variable silently lands where no
other core can reach it. Each file must place .udmem in the same data RAM as
its .bss and .usmem in PRU_SHAREDMEM.
"""

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _linker_files():
    out = subprocess.run(["git", "ls-files", "*linker.cmd"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return sorted(out.split())


def _placement(text, section):
    m = re.search(r"^\s*%s\s*>\s*(\w+)\s*,\s*PAGE\s*(\d+)" % re.escape(section), text, re.M)
    return m.groups() if m else None


def test_linker_files_are_found():
    assert len(_linker_files()) > 0


@pytest.mark.parametrize("path", _linker_files())
def test_memory_variable_sections_are_placed(path):
    text = (ROOT / path).read_text(encoding="utf-8")
    bss = _placement(text, ".bss")
    assert bss, "%s has no .bss rule" % path
    assert _placement(text, ".udmem") == bss, "%s: .udmem must go where .bss goes (%s, PAGE %s)" % (path, *bss)
    assert re.search(r"^\s*PRU_SHAREDMEM\s*:", text, re.M), "%s does not declare PRU_SHAREDMEM" % path
    assert _placement(text, ".usmem") == ("PRU_SHAREDMEM", "2"), "%s: .usmem must go to PRU_SHAREDMEM, PAGE 2" % path
