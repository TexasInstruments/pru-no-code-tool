"""every example firmware variant of the configured device must build.

The am243x-evm PRU0 designs of eight examples held an unwired block catalogue and failed the
generate-time validator ("Required graph input port 'input1' is unconnected"), yet the suite
stayed green because only the am243x-lp variants were ever built. This sweep closes that gap.

It reads DEVICE from imports.mak, discovers every board folder of that device under
examples/*/firmware/ (am243x -> am243x-evm, am243x-lp, ...) and every <core>_fw that has a
ti-pru-cgt/makefile under each, and builds each one with the real toolchain (SysConfig CLI + clpru through the variant's own makefile). One pytest
case per example/board/core; a failure names all three plus the first error line. Builds run in copies
under a short temp dir (never in the tree, so tracked generated files are not rewritten) and are fanned out
over a thread pool on first use, because 100+ builds one after the other would dominate the suite.

A <core>_fw directory WITHOUT a makefile cannot be built, so it is never silently dropped: it must be
listed in EXPECTED_UNBUILT with a reason, and the discovery test compares the full on-disk set of
(example, board, core) against built + expected-unbuilt, failing by variant name in either direction.

Loud skips only: imports.mak absent, or gmake / clpru absent. Nothing passes silently.

Red arm: one required input left unwired in ONE variant of a temp copy must fail naming that
example/board/core and the validator text.
"""

import atexit
import concurrent.futures
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

import pytest
from pathlib import Path

# Default install location of TI tools, as in imports.mak (TOOLS_PATH).
TI_TOOLS = Path(os.environ.get("TOOLS_PATH", (os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else Path.home() / "ti"))

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "sim")))
import elf_cosim  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMPORTS_MAK = os.path.join(ROOT, "imports.mak")
WORKERS = min(6, os.cpu_count() or 2)


def _find_gmake():
    for cand in (str(TI_TOOLS / "ccs2100" / "ccs" / "utils" / "bin" / "gmake.exe"),
                 shutil.which("gmake"), shutil.which("make")):
        if cand and os.path.isfile(cand):
            return cand
    return None


def _device():
    with open(IMPORTS_MAK, "r", encoding="utf-8") as f:
        m = re.search(r"^\s*DEVICE\s*\??=\s*(\S+)", f.read(), re.M)
    return m.group(1) if m else None


def discover(examples_root, device):
    """(example, board, core) for every <core>_fw with a makefile on any board of `device`."""
    found = []
    for mk in glob.glob(os.path.join(examples_root, "*", "firmware", device + "-*", "*_fw", "ti-pru-cgt", "makefile")):
        fw = os.path.dirname(os.path.dirname(mk))
        core = os.path.basename(fw)
        board = os.path.basename(os.path.dirname(fw))
        example = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(fw))))
        found.append((example, board, core))
    return sorted(found)


# <core>_fw dirs that exist on disk for the device but have no ti-pru-cgt makefile, so the sweep cannot
# build them. Each needs a reason; a new makefile-less core, or a listed one that gains a makefile or
# disappears, fails test_discovery_covers_every_core_of_the_device naming the variant.
EXPECTED_UNBUILT = {}



def on_disk_cores(examples_root, device):
    """(example, board, core) for every <core>_fw directory of `device`, makefile or not."""
    found = []
    for fw in glob.glob(os.path.join(examples_root, "*", "firmware", device + "-*", "*_fw")):
        if os.path.isdir(fw):
            found.append((os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(fw)))),
                          os.path.basename(os.path.dirname(fw)), os.path.basename(fw)))
    return sorted(found)


def coverage_problems(on_disk, built, expected_unbuilt):
    """Human-readable drift lines, each naming the variant; empty when disk == built + expected."""
    on_disk, built, unbuilt = set(on_disk), set(built), set(expected_unbuilt)
    out = []
    out += [f"{'/'.join(v)}: <core>_fw on disk with no makefile and not in EXPECTED_UNBUILT"
            for v in sorted(on_disk - built - unbuilt)]
    out += [f"{'/'.join(v)}: listed in EXPECTED_UNBUILT but it now has a makefile (remove the entry)"
            for v in sorted(unbuilt & built)]
    out += [f"{'/'.join(v)}: listed in EXPECTED_UNBUILT but no longer on disk (remove the entry)"
            for v in sorted(unbuilt - on_disk)]
    out += [f"{'/'.join(v)}: built but not found on disk" for v in sorted(built - on_disk)]
    return out


def _skip_reason():
    if not os.path.isfile(IMPORTS_MAK):
        return "imports.mak absent: no DEVICE to sweep"
    if not _find_gmake():
        return "gmake absent: cannot build variants"
    try:
        elf_cosim.find_clpru()
    except RuntimeError:
        return "clpru absent: cannot build variants"
    if not _device():
        return "imports.mak sets no DEVICE"
    return None


SKIP_REASON = _skip_reason()
DEVICE = None if SKIP_REASON else _device()
VARIANTS = discover(os.path.join(ROOT, "examples"), DEVICE) if DEVICE else []
PARAMS = VARIANTS or [("-", "-", "-")]


def first_error_line(text):
    for line in text.splitlines():
        if re.search(r"\berror\b|\*\*\*", line, re.I) and not re.match(r"\s*\d+ error", line):
            return line.strip()
    lines = text.strip().splitlines()
    return lines[-1] if lines else "(no output)"


def build_variant(examples_root, stage_root, example, board, core):
    """Build one variant in a copy of its example under stage_root; return (rc, first error line)."""
    work = os.path.join(stage_root, example)
    with _stage_lock:
        if not os.path.isdir(work):
            shutil.copytree(os.path.join(examples_root, example), work,
                            ignore=shutil.ignore_patterns("generated", "syscfg"))
    scratch = os.path.join(stage_root, "tmp", f"{example}_{board}_{core}")
    os.makedirs(scratch, exist_ok=True)
    env = dict(os.environ)
    for var in ("TEMP", "TMP"):
        env[var] = scratch
    fw = os.path.join(work, "firmware", board, core, "ti-pru-cgt")
    proc = subprocess.run([_find_gmake(), "PRU_NO_CODE_TOOL_PATH=" + ROOT, "BUILD_MCUPLUS=n",
                           "-C", fw, "-s", "all"],
                          capture_output=True, text=True, timeout=600, env=env)
    out = proc.stdout + proc.stderr
    if proc.returncode == 0 and not glob.glob(os.path.join(fw, "generated", "*.out")):
        return 1, "gmake rc=0 but no linked ELF in generated/"
    return proc.returncode, first_error_line(out) if proc.returncode else ""


def failure_text(example, board, core, line):
    return f"{example}/{board}/{core} failed to build: {line}"


_stage_lock = threading.Lock()
_results_lock = threading.Lock()
_results = {}


def _all_results():
    with _results_lock:
        if not _results:
            # short temp root on purpose: the longest variant output names already sit within ~20
            # characters of the 260-character Windows path limit when staged under the repo
            stage = tempfile.mkdtemp(prefix="n216_")
            atexit.register(shutil.rmtree, stage, ignore_errors=True)
            ex_root = os.path.join(ROOT, "examples")
            with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
                futs = {v: pool.submit(build_variant, ex_root, stage, *v) for v in VARIANTS}
                for v, fut in futs.items():
                    _results[v] = fut.result()
        return _results


def test_discovery_covers_every_core_of_the_device():
    if SKIP_REASON:
        pytest.skip(SKIP_REASON)
    boards = {b for _, b, _ in VARIANTS}
    assert VARIANTS, f"no {DEVICE}-* variants discovered under examples/"
    on_disk = {os.path.basename(p) for p in glob.glob(os.path.join(ROOT, "examples", "*", "firmware", DEVICE + "-*"))
               if os.path.isdir(p)}
    assert boards == on_disk, f"boards with a buildable variant {sorted(boards)} != boards on disk {sorted(on_disk)}"
    problems = coverage_problems(on_disk_cores(os.path.join(ROOT, "examples"), DEVICE), VARIANTS, EXPECTED_UNBUILT)
    assert not problems, "; ".join(problems)
    # empty must be built on every board/core it ships, the case that started assert any(e == "empty" for e, _, _ in VARIANTS)


def test_red_coverage_drift_fails_in_both_directions():
    """Red arm for the discovery test: a makefile-less core that is not listed, and a listed entry that
    gained a makefile or vanished, must each fail naming the variant; the exact tree must pass."""
    disk = [("a", "b1", "c0_fw"), ("a", "b1", "c1_fw")]
    assert coverage_problems(disk, [disk[0]], {disk[1]: "r"}) == []
    new = coverage_problems(disk, [disk[0]], {})
    assert len(new) == 1 and "a/b1/c1_fw" in new[0] and "not in EXPECTED_UNBUILT" in new[0]
    gained = coverage_problems(disk, disk, {disk[1]: "r"})
    assert len(gained) == 1 and "a/b1/c1_fw" in gained[0] and "now has a makefile" in gained[0]
    gone = coverage_problems([disk[0]], [disk[0]], {disk[1]: "r"})
    assert len(gone) == 1 and "a/b1/c1_fw" in gone[0] and "no longer on disk" in gone[0]


@pytest.mark.parametrize("example,board,core", PARAMS, ids=["/".join(p) for p in PARAMS])
def test_variant_builds(example, board, core):
    if SKIP_REASON:
        pytest.skip(SKIP_REASON)
    rc, line = _all_results()[(example, board, core)]
    assert rc == 0, failure_text(example, board, core, line)


def test_red_unwired_input_is_reported_with_its_name(tmp_path):
    """Red arm: a crc_block with an unwired required input injected into ONE variant must fail the
    build naming that example/board/core and the validator's own text."""
    if SKIP_REASON:
        pytest.skip(SKIP_REASON)
    example, board, core = "empty", DEVICE + "-lp", "icss_g0_pru0_fw"
    if (example, board, core) not in VARIANTS:
        pytest.skip(f"{example}/{board}/{core} not shipped; red arm needs one variant to sabotage")
    ex_root = tmp_path / "examples"
    shutil.copytree(os.path.join(ROOT, "examples", example), ex_root / example,
                    ignore=shutil.ignore_patterns("generated", "syscfg"))
    syscfg = ex_root / example / "firmware" / board / core / "example.syscfg"
    src = syscfg.read_text(encoding="utf-8")
    inject = ('\nconst mod_red = scripting.addModule("/pru_blocks/application_specific/crc_block", {}, false);\n'
              'const block_red = mod_red.addInstance();\nblock_red.$name = "Red_Unwired_Crc";\n')
    syscfg.write_text(src + inject, encoding="utf-8")
    rc, line = build_variant(str(ex_root), str(tmp_path / "stage"), example, board, core)
    text = failure_text(example, board, core, line)
    assert rc != 0, "an unwired required input must fail the build, it built"
    assert f"{example}/{board}/{core}" in text
    assert "Required graph input port 'input1' is unconnected" in text, text
