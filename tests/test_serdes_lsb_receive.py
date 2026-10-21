"""serdes_block LSB-first receive path must reconstruct the sent word.

The LSB-first receive branch of m_serdes_run must place each sampled bit in a
field wide enough to hold it. A form such as
    lsl TEMP_REG2.b1, TEMP_REG2.b1, 31
shifts an 8-bit field left by 31; the field keeps only the low 8 bits, so the
shifted value is always 0, the following
    or DATA_REG, DATA_REG, TEMP_REG2.b1
adds nothing, and every LSB-first word reads as 0x0 (on TI pru-simulator, for
device-sent 0xFF, 0x01 and 0x80). LSB-first transmit and MSB-first receive
are correct and must not change.

Oracle (written in this test from the definition, not from the macro):
  * LSB-first: received word = sum(bit_i << i), bit_i = i-th DIN sample.
  * MSB-first: received word = sum(bit_i << (width-1-i)).
The DIN sample log is recorded by the closed-loop device model, so the
expected value is derived from the driven samples, not from the sent word.

Coverage: widths 8, 12, 16 x orders LSB/MSB x patterns 0x00, all-ones,
0x01, MSB-only and one irregular pattern.

The device half needs clpru and the TI pru-simulator checkout. It is gated
on PRU_SIMULATOR_PATH (and clpru): when PRU_SIMULATOR_PATH is unset or does
not point at a checkout, the device tests SKIP with a reason instead of
passing. The static half runs anywhere: it parses the committed block
source and asserts the LSB receive branch does not shift an 8-bit field
by more than 7 and that both receive branches cost the same number of
instructions per bit (so the bit period does not change with bit order).
"""

import os
import re

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BLOCK_SRC = os.path.join(
    REPO_ROOT, ".metadata", "sysconfig", ".meta", "pru_blocks",
    "pru_io_blocks", "serdes_block.syscfg.js")

WIDTHS = (8, 12, 16)
ORDERS = ("LSB", "MSB")
IRREGULAR = {8: 0xA5, 12: 0xA5A, 16: 0xA5A5}


def patterns_for(width):
    all_ones = (1 << width) - 1
    return [
        ("zero", 0x00),
        ("all_ones", all_ones),
        ("lsb_only", 0x01),
        ("msb_only", 1 << (width - 1)),
        ("irregular", IRREGULAR[width] & all_ones),
    ]


def lsb_expected(samples):
    """Definition oracle, LSB-first: word = sum(bit_i << i)."""
    return sum((b & 1) << i for i, b in enumerate(samples))


def msb_expected(samples, width):
    """Definition oracle, MSB-first: word = sum(bit_i << (width-1-i))."""
    return sum((b & 1) << (width - 1 - i) for i, b in enumerate(samples))


# ---------------------------------------------------------------- static half

def _receive_branches():
    """Split the DIN-receive `.if IS_MSB == 1` block into (msb, lsb) line lists.

    The macro has several IS_MSB conditionals (TX extract, RX accumulate, TX
    shift, tail align). The receive one is the conditional that follows the
    DIN sample (`R31, DIN_BIT`); parsing the committed source keeps this
    check runnable anywhere (no node, no simulator).
    """
    with open(BLOCK_SRC, encoding="utf-8") as f:
        text = f.read()
    lines = text.splitlines()

    def norm(l):
        return l.strip().replace("`", "").strip().rstrip(",").strip()

    sample_idx = next(i for i, l in enumerate(lines) if "R31, DIN_BIT" in l)
    if_idx = next(i for i in range(sample_idx, len(lines))
                  if re.search(r"\.if\s+IS_MSB\s*==\s*1", norm(lines[i])))
    else_idx = next(i for i in range(if_idx, len(lines))
                    if norm(lines[i]).startswith(".else"))
    endif_idx = next(i for i in range(else_idx, len(lines))
                     if norm(lines[i]).startswith(".endif"))

    def instrs(lo, hi):
        out = []
        for l in lines[lo:hi]:
            s = norm(l)
            if not s or s.startswith(".") or s.endswith("?:") or s.endswith(":"):
                continue
            out.append(s)
        return out

    return instrs(if_idx + 1, else_idx), instrs(else_idx + 1, endif_idx)


def _shift_amount(line):
    """Immediate third operand of an lsl/lsr line, or None if not immediate."""
    m = re.match(r"(?:lsl|lsr)\s+(\S+)\s*,\s*(\S+)\s*,\s*(\S+)", line.strip())
    if not m:
        return None
    try:
        return int(m.group(3), 0)
    except ValueError:
        return None


def _dest_is_narrow(line):
    m = re.match(r"(?:lsl|lsr)\s+(\S+)", line.strip())
    return bool(m and re.search(r"\.b[0-3]\b", m.group(1)))


def test_lsb_receive_shifts_no_8bit_field_by_more_than_7():
    _msb, lsb = _receive_branches()
    assert lsb, "LSB receive branch not found in serdes_block source"
    bad = [(l, _shift_amount(l)) for l in lsb
           if _dest_is_narrow(l) and _shift_amount(l) is not None
           and _shift_amount(l) > 7]
    assert bad == [], \
        "LSB receive shifts an 8-bit field by >7 (always 0): %s" % (bad,)


def test_receive_branches_cost_the_same_per_bit():
    msb, lsb = _receive_branches()
    assert msb and lsb, "receive branches not found in serdes_block source"
    assert len(msb) == len(lsb), \
        "per-bit instruction count differs by order (MSB %d vs LSB %d): %s vs %s" \
        % (len(msb), len(lsb), msb, lsb)


def test_lsb_receive_shifts_data_right_and_sets_the_top_bit():
    _msb, lsb = _receive_branches()
    assert any(re.match(r"lsr\s+DATA_REG\s*,\s*DATA_REG\s*,\s*1\b", l) for l in lsb), \
        "LSB branch must shift DATA_REG right by 1: %s" % (lsb,)
    assert any(re.match(r"or\s+DATA_REG", l) for l in lsb), \
        "LSB branch must OR the sampled bit into DATA_REG: %s" % (lsb,)


def test_msb_receive_is_still_shift_left_and_or():
    msb, _lsb = _receive_branches()
    assert any(re.match(r"lsl\s+DATA_REG\s*,\s*DATA_REG\s*,\s*1\b", l) for l in msb), \
        "MSB branch must still shift DATA_REG left by 1: %s" % (msb,)
    assert any(re.match(r"or\s+DATA_REG\s*,\s*DATA_REG\s*,", l) for l in msb), \
        "MSB branch must still OR the sampled bit into DATA_REG: %s" % (msb,)


# ---------------------------------------------------------------- device half

def _simulator_dir():
    d = os.environ.get("PRU_SIMULATOR_PATH", "")
    if d and os.path.isfile(os.path.join(d, "simulator.py")):
        return d
    return None


def _needs_device():
    try:
        import elf_cosim  # noqa: F401
        elf_cosim.find_clpru()
    except (ImportError, RuntimeError) as exc:
        return pytest.mark.skip(
            reason="needs clpru for the device half (%s); set CGT_TI_PRU_PATH" % exc)
    if _simulator_dir() is None:
        return pytest.mark.skip(
            reason="needs the TI pru-simulator for the device half and "
                   "PRU_SIMULATOR_PATH is unset (or not a checkout); "
                   "set PRU_SIMULATOR_PATH to a pru-simulator checkout")
    return pytest.mark.skipif(False, reason="")


needs_device = _needs_device()

# CLK period oracle. renamed the macro's PRE_CYCLES/POST_CYCLES to the delay-loop formals below. The firmware is
# built with the args for a bitCycles = 26 design (the 26-cycle period this test ran at before, PRE = POST = 2),
# derived by hand from the block's documented cost (Technical Details): CLK low = 13 = 9 fixed + ldi + 1 trip (2) + 1 nop,
# CLK high = 13 = 6 fixed + ldi + 3 trips (6). Every rise-to-rise CLK interval must be BIT_CYCLES for both bit orders, so a
# receive-branch change that keeps the instruction count but not the cycle count goes red here, not only in a static count.
BIT_CYCLES = 26
LOW_TRIPS, LOW_PAD, HIGH_TRIPS, HIGH_PAD = 1, 1, 3, 0


class _DinDriver:
    """Drive one DIN bit per CLK rising edge, recording the driven samples."""

    def __init__(self, word, width, order, clk_bit=1, din_bit=2):
        if order == "LSB":
            self.bits = [(word >> i) & 1 for i in range(width)]
        else:
            self.bits = [(word >> (width - 1 - i)) & 1 for i in range(width)]
        self.clk_bit = clk_bit
        self.din_bit = din_bit
        self.prev_clk = 0
        self.samples = []
        self.rises = []

    def tick(self, cycle, gpo):
        clk = (gpo >> self.clk_bit) & 1
        if clk and not self.prev_clk:
            self.rises.append(cycle)
        if clk and not self.prev_clk and len(self.samples) < len(self.bits):
            self.samples.append(self.bits[len(self.samples)])
        self.prev_clk = clk
        level = self.samples[-1] if self.samples else 0
        return level << self.din_bit


_FW_CACHE = {}


def _firmware(width, order):
    import elf_cosim
    key = (width, order)
    if key not in _FW_CACHE:
        workdir = os.path.join(REPO_ROOT, "build_out", "",
                               "w%d_%s" % (width, order.lower()))
        os.makedirs(workdir, exist_ok=True)
        spec = {
            "block": "serdes_block",
            "subdir": "pru_io_blocks",
            "macroCall": "m_serdes_run",
            "macroArgs": {
                "RES": "R4",
                "WIDTH": str(width),
                "IS_MSB": "1" if order == "MSB" else "0",
                "ALIGN": str(32 - width),
                "DOUT_BIT": "0",
                "CLK_BIT": "1",
                "DIN_BIT": "2",
                "LOW_TRIPS": str(LOW_TRIPS),
                "LOW_PAD": str(LOW_PAD),
                "HIGH_TRIPS": str(HIGH_TRIPS),
                "HIGH_PAD": str(HIGH_PAD),
                "DEMO_WORD": "0xA5",
                "DATA_REG": "R1",
            },
            "postlude": ["halt"],
        }
        elf_path, _asm_path = elf_cosim.build_block_firmware(
            spec, "serdes_%d_%s" % (width, order.lower()), workdir)
        _FW_CACHE[key] = elf_path
    return _FW_CACHE[key]


_CASES = [(w, o, n, v) for w in WIDTHS for o in ORDERS
           for (n, v) in patterns_for(w)]


@needs_device
@pytest.mark.parametrize("width,order,pname,want_word",
                         _CASES,
                         ids=["w%d_%s_%s" % (w, o.lower(), n) for (w, o, n, _v) in _CASES])
def test_device_receives_sent_word(width, order, pname, want_word):
    import elf_cosim
    elf_path = _firmware(width, order)
    model = _DinDriver(want_word, width, order)
    run = elf_cosim.run_elf_closed_loop(elf_path, model, max_steps=20000)
    assert run.halted, "firmware did not halt (width %d %s %s)" % (width, order, pname)
    assert len(model.samples) == width, \
        "expected %d DIN samples, drove %d" % (width, len(model.samples))
    if order == "LSB":
        want = lsb_expected(model.samples)
    else:
        want = msb_expected(model.samples, width)
    periods = [b - a for a, b in zip(model.rises, model.rises[1:])]
    assert len(model.rises) == width and set(periods) == {BIT_CYCLES},         "width %d %s pattern %s: %d CLK rises, rise-to-rise periods %s, want all %d"         % (width, order, pname, len(model.rises), periods, BIT_CYCLES)
    got = run.registers[1] & 0xFFFFFFFF
    assert got == want, \
        "width %d %s pattern %s (0x%X): got 0x%X, want 0x%X from samples %s" \
        % (width, order, pname, want_word, got, want, model.samples)
