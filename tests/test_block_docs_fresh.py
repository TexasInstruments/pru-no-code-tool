"""docs/block-reference is exactly what build_block_docs.js generates.

The generator runs into a scratch directory (DOCS_OUT), and the result must match the committed tree
file for file: no stale page, no page the generator would add, no page it would change. Every relative
link in the generated pages must resolve inside the generated set, so the committed reference has no
dead links.
"""
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs" / "block-reference"
LINK = re.compile(r"\]\(([^)#\s]+)(?:#[^)]*)?\)")


def _files(base):
    return {p.relative_to(base).as_posix(): p for p in base.rglob("*") if p.is_file()}


def _text(p):
    return p.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _generate(tmp_path):
    out = tmp_path / "block-reference"
    env = dict(os.environ, DOCS_OUT=str(out))
    r = subprocess.run(["node", "build_block_docs.js"], cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return out


def test_committed_block_reference_matches_a_fresh_generation(tmp_path):
    out = _generate(tmp_path)
    fresh, committed = _files(out), _files(DOCS)
    assert sorted(set(fresh) - set(committed)) == [], "generated but not committed"
    assert sorted(set(committed) - set(fresh)) == [], "committed but no longer generated"
    stale = [rel for rel in fresh if _text(fresh[rel]) != _text(committed[rel])]
    assert stale == [], "stale pages (re-run node build_block_docs.js): %s" % stale[:10]


def test_generated_pages_have_no_dead_relative_links(tmp_path):
    out = _generate(tmp_path)
    dead = []
    for rel, p in _files(out).items():
        for target in LINK.findall(_text(p)):
            if re.match(r"[a-z]+:", target):
                continue
            inside = (p.parent / target).resolve()
            if out.resolve() in inside.parents:
                ok = inside.exists()          # a page of the generated set
            else:                             # a repository file, seen from the committed location
                ok = ((DOCS / rel).parent / target).resolve().exists()
            if not ok:
                dead.append("%s -> %s" % (rel, target))
    assert dead == [], dead[:10]


def test_generated_pages_have_no_trailing_whitespace(tmp_path):
    out = _generate(tmp_path)
    bad = ["%s:%d" % (rel, n) for rel, p in _files(out).items()
           for n, line in enumerate(_text(p).split("\n"), 1) if line != line.rstrip(" \t")]
    assert bad == [], bad[:10]
