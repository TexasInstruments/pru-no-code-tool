"""Source-level helpers for tests that walk the block library.

Deciding "this module declares getPinUsage" (or getMacro) by a bare substring match would let a
comment or a string literal that merely mentions the name make a non-block look like a block
(common/pru_blocks_static_module.syscfg.js documents and calls getPinUsage). declares() looks only
at code - comments and string/template literals blanked out - and counts the name only where it is
not a member access: a property key (name: ...), method shorthand (name(inst) {...}), shorthand
property ({ name }) or a function declaration. `x.name(...)` and `x.name = ...` are uses, not
declarations.

This is deliberately independent of scripts/pin_usage_blocks.js, which loads the module and checks
moduleStatic.getPinUsage is a function, so the two methods can be compared on the real library.
"""
import re


def code_only(src):
    """src with // and /* */ comments and '...', "...", `...` literals replaced by spaces
    (newlines kept). Regex literals are not modelled; the agreement arm catches a misparse."""
    out, i, n = [], 0, len(src)
    while i < n:
        c, nxt = src[i], src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
        elif c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif c != "`" and src[j] == "\n":
                    break  # unterminated '/" literal: stop at end of line
                j += 1
            j = min(j + 1, n)
        else:
            out.append(c)
            i += 1
            continue
        out.append(re.sub(r"[^\n]", " ", src[i:j]))
        i = j
    return "".join(out)


def declares(src, name):
    """True when `name` appears in code (not a comment or string) other than as a member access."""
    return re.search(r"(?<![.\w$])" + re.escape(name) + r"(?![\w$])", code_only(src)) is not None
