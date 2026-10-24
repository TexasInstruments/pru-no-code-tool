"""three_phase_pwm_block serves every edge from an event list sorted once per call.

The real clpru ELF runs in the TI pru-simulator (scripts/sim/elf_cosim.py); every R30 change is
recorded with the IEP count at the instruction after the write. Expected edges come from the
block's documented formulas, never from a previous run:

    high sides on at DEADTIME for duty > 2*DEADTIME (on-time duty - 2*DEADTIME), in the same write
    as the low side of any leg at duty 0;
    high-off(x) at min(duty, PERIOD) - DEADTIME;
    low-on(x) at duty + DEADTIME for 0 < duty < PERIOD - DEADTIME;
    strobe rise at PERIOD/2, fall one poll iteration (W) later;
    all-off at PERIOD.
Edges with the same requested count must change in one R30 write.

Lateness budget, from the instruction listing of the generated macro (cycles = IEP counts):

    W  = 4  one poll iteration: lbco CNT (1 + 2 read stalls) + qbgt
    X  = 5  counter sample to the R30 write taking effect: lbco 3 + qbgt 1 + write 1
    X2 = 8  write to the next write when that edge is already due by the last sample:
            3 decode tests + strobe clr + token shift + time (sub/add) + due test + write
            (strobe: 3 tests + shift + ldi32 (2) + due test + write; it never follows itself)
    DF = 12 the same when the edge is first found due by a fresh read: X2 - 1 + X
An isolated edge is late by at most W + X; the k-th edge of a cluster of single-edge writes by
at most W + X + (k-1)*X2. A write that changes several pins is dispatched through the escape
token (COIN below: W, X, worst write-to-write when due, from the same listing). The rigorous
check is the recursion late_k <= max(W_k + X_k, late_{k-1} + D_k - gap_k), D_k the worst
write-to-write of the class; it is asserted for every write together with the cluster formula.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
import elf_cosim  # noqa: E402

# The macro programs the IEP through c26 and counts in IEP ticks = cycles, so every run maps c26 to the
# simulator's IEP model, as on the device, and runs the IEP at the core clock.
IEP_RUN = dict(constants=elf_cosim.IEP_CONSTANTS, lock_iep_to_core=True)

def _require_iep_model():
    if elf_cosim.simulator_iep_base() != 0x0002E000:
        pytest.skip("pru-simulator checkout has no IEP0 model at 0x0002E000")


W, X, X2, DF = 4, 5, 8, 12
# class -> (W, X, D): poll iteration, counter sample to write, worst write-to-write when the edge
# is due on arrival (a fresh read included). Instruction counts of the generated macro, 1 cycle
# each except lbco 3 and ldi32 2; "decode" is the 3 spine tests + strobe clr + qba to the escape
# tree, then 1 (qbeq end) + 3..6 escape tests.
COIN = {
    "single": (W, X, DF),
    "strobe": (W, X, DF),       # shift + ldi32 + due test instead of clr + shift + time + due test
    "highon": (W, X, None),     # first write of a period, right after the counter restart
    # equal-duty high-offs [+ strobe]: decode 5 + escape 5, then 12 to the due test
    # (clamp test, image, two equal-duty tests + clears, strobe flag, shift, CNT + DEADTIME,
    # due test); poll lbco + add + qbgt (W 5), then sub + write (X 7): D = 22 + 7
    "high_set": (5, 7, 29),
    # equal-duty low-ons [+ strobe]: decode 5 + escape 4 + 12 to the due test + qba + 7: D = 29
    "low_set": (5, 7, 29),
    # low-ons with high-offs two dead-times above: decode 9 + 16 (image, equal-duty and cross
    # tests, key = duty + 2*DEADTIME), then a fresh read (7): D = 32
    "low_cross": (5, 7, 32),
    "clamp1": (W, X, 20),       # decode 5 + 6 + shift + ldi32 + due test, then 5
    "clamp2": (W, 8, 23),       # same, write = image + two clears + mov (X 3 + 1 + 4)
    "clamp3": (W, X, 23),       # decode 5 + 6 + image + three clears + ldi32 + due test, then 5
    "low_clamp": (5, 7, 31),    # decode 5 + 7 + 12, then 7
    "alloff": (W, X, 15),       # decode 5 + qbeq + image + three clears, then lbco CMP status + qbbc + mov
}
# These return through the shared decode copy (qba tp_dec?): one more cycle before the next write.
SHARED_DECODE = {"clamp1", "clamp2", "low_clamp"}
PINS = {0: "AH", 1: "AL", 2: "BH", 3: "BL", 4: "CH", 5: "CL", 6: "S"}
LEGS = "ABC"


class Idle:
    def tick(self, _cycle, _pins):
        return 0


def expected(P, D, duties):
    """[(count, frozenset((pin, level)), class)] for one period, from the documented formulas."""
    ev = {}

    def add(t, pin, lvl):
        ev.setdefault(t, set()).add((pin, lvl))
    lows = []
    for x, d in zip(LEGS, duties):
        if d > 2 * D:
            add(D, x + "H", 1)
            add(min(d, P) - D, x + "H", 0)
        if d == 0:
            add(D, x + "L", 1); lows.append(x)
        elif d < P - D:
            add(d + D, x + "L", 1); lows.append(x)
    add(P // 2, "S", 1)
    out = []
    for t in sorted(ev):
        m = frozenset(ev[t])
        out.append((t, m, classify(t, m, P, D, duties)))
    if lows:
        out.append((P, frozenset((x + "L", 0) for x in lows), "alloff"))
    return out


def classify(t, m, P, D, duties):
    pins = {p for p, _ in m}
    edges = pins - {"S"}
    if t == D and any(lvl for _, lvl in m):
        return "highon"
    highs = {p[0] for p in edges if p[1] == "H"}
    clamped = {x for x in highs if duties[LEGS.index(x)] >= P}
    if len(m) == 1 and not clamped:
        return "strobe" if pins == {"S"} else "single"
    if not any(p[1] == "L" for p in edges):
        if clamped:
            return "clamp%d" % len(clamped)
        return "high_set"
    if clamped:
        return "low_clamp"
    return "low_cross" if highs else "low_set"


def run(tmp_path, P, D, duties, count=None, steps=60000, repeats=None):
    _require_iep_model()
    args = dict(STATE="R4", DUTY_A="R5", DUTY_B="R6", DUTY_C="R7", PERIOD=str(P), DEADTIME=str(D),
                AH="0", AL="1", BH="2", BL="3", CH="4", CL="5", TRIGGER="6")
    call = "m_three_phase_pwm_period"
    if count is not None:
        args["PERIOD_COUNT"] = str(count)
        call = "m_three_phase_pwm_counted"
    spec = dict(block="three_phase_pwm_block", subdir="pru_io_blocks", macroCall=call, macroArgs=args,
                prelude=[f"ldi32 R5, {duties[0]}", f"ldi32 R6, {duties[1]}", f"ldi32 R7, {duties[2]}"],
                postlude=["halt"])
    if repeats:
        spec["macroRepeats"] = repeats
    name = "tp%d_%d_%s_%s_%s" % (P, D, "_".join(map(str, duties)), count, repeats)
    elf, _ = elf_cosim.build_block_firmware(spec, name, str(tmp_path / name))
    writes = []
    prev = [0]

    def watch(_cycle, gpo, _gpi, sim):
        ch = gpo ^ prev[0]
        if ch:
            writes.append((sim.iep.count, frozenset((PINS[b], (gpo >> b) & 1) for b in range(7) if ch >> b & 1)))
        prev[0] = gpo
    result = elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=steps, on_step=watch, **IEP_RUN)
    return result, writes


def edge_table(writes, exp):
    """'pin+@requested->observed' for every expected edge of the first period (first match)."""
    out = []
    for t, m, _ in exp:
        for pin, lvl in sorted(m):
            got = next((c for c, w in writes if (pin, lvl) in w), None)
            out.append(f"{pin}{'+' if lvl else '-'}@{t}->{got}")
    return " ".join(out)


def split_periods(writes, P, D, duties):
    """One list per period: the writes from a high-side write (or, with no high side, the first
    write) up to the all-off write; the strobe-clear writes are returned separately."""
    exp = expected(P, D, duties)
    n = len([w for w in writes if w[1] != frozenset({("S", 0)})])
    per = len(exp)
    assert per and n % per == 0, f"{n} writes for {per} expected writes per period; " + edge_table(writes, exp)
    periods, cur, clears = [], [], []
    for w in writes:
        if w[1] == frozenset({("S", 0)}):
            clears.append((len(periods), w))
            continue
        cur.append(w)
        if len(cur) == per:
            periods.append(cur)
            cur = []
    return periods, clears


def check_period(period, P, D, duties, label):
    exp = expected(P, D, duties)
    got = [m for _, m in period]
    want = [m for _, m, _ in exp]
    assert got == want, f"{label}: writes (order, merging, count) differ\n  got  {got}\n  want {want}"
    # The high-side write at DEADTIME happens every period; with no high side and no duty-0 leg it
    # changes no pin, but the next event is still dispatched after it (bound W + X).
    prev, prev_late, cluster = (D, "highon"), W + X, W + X
    if exp[0][2] == "highon":
        prev = None
    lates = []
    for (cnt, _), (t, m, cls) in zip(period, exp):
        late = cnt - t
        assert late >= 0, f"{label}: {sorted(m)} at {cnt}, requested {t}: early"
        w, x, d = COIN[cls]
        if prev is None:
            rec = cluster = w + x
        else:
            gap = t - prev[0]
            d += prev[1] in SHARED_DECODE
            rec = max(w + x, prev_late + d - gap)
            # Isolated: the previous write cannot delay this one (it ended early enough for this
            # edge's dispatch to finish before it is due). Otherwise the next edge of a cluster.
            step = X2 if cls in ("single", "strobe") else d
            cluster = w + x if prev_late + d - gap <= w + x else cluster + step
        assert late <= rec, f"{label}: {sorted(m)} requested {t} late {late} > recursion bound {rec}"
        assert late <= cluster, f"{label}: {sorted(m)} requested {t} late {late} > cluster bound {cluster}"
        lates.append((t, cls, late))
        prev, prev_late = (t, cls), late
    return lates


CASES = [
    (800, 10, (400, 400, 400)),
    (800, 10, (100, 400, 700)),
    (800, 10, (20, 20, 20)),
    (800, 10, (11, 799, 0)),
    (800, 10, (300, 300, 600)),
    (800, 10, (800, 800, 800)),
    (400, 10, (100, 200, 300)),
    (200, 10, (50, 100, 150)),
    # coincidences of different kinds, one per escape class
    (800, 10, (380, 400, 420)),    # high-off B with low-on A, high-off C with low-on B
    (800, 10, (410, 100, 700)),    # high-off A at the strobe
    (800, 10, (390, 100, 700)),    # low-on A at the strobe
    (800, 10, (780, 800, 300)),    # low-on A at PERIOD - DEADTIME with clamped B
    (800, 10, (900, 800, 300)),    # two clamped legs
    (800, 10, (300, 1600, 400)),   # one clamped leg
    (800, 10, (789, 785, 781)),    # dense cluster just before the boundary
    # Every escape handler exists once per leg (x1 and gh and gl and g7 by the leg that opens the
    # token, x2 by the unclamped leg), so a case arms one leg's copy only. One case per remaining
    # leg: breaking any one copy must make the suite fail.
    (800, 10, (900, 300, 400)),    # one clamped leg: A
    (800, 10, (300, 400, 900)),    # one clamped leg: C
    (800, 10, (300, 900, 800)),    # two clamped legs, A unclamped
    (800, 10, (900, 300, 800)),    # two clamped legs, B unclamped
    (800, 10, (100, 400, 400)),    # equal-duty high-offs and low-ons, set opened by leg B
    (800, 10, (100, 100, 410)),    # equal-duty high-offs, then leg C's high-off at the strobe
    (800, 10, (100, 100, 390)),    # equal-duty low-ons, then leg C's low-on at the strobe
    (800, 10, (100, 780, 800)),    # low-on at PERIOD - DEADTIME with clamped highs: leg B
    (800, 10, (100, 800, 780)),    # the same: leg C
]


@pytest.mark.parametrize("P,D,duties", CASES, ids=lambda v: str(v))
def test_every_edge_position_order_and_count(tmp_path, P, D, duties):
    result, writes = run(tmp_path, P, D, list(duties))
    assert result.halted, "block did not return"
    periods, clears = split_periods(writes, P, D, list(duties))
    assert len(periods) == 1
    check_period(periods[0], P, D, list(duties), f"{P}/{D} {duties}")
    rise = [cnt for cnt, m in periods[0] if ("S", 1) in m]
    assert len(rise) == 1 and len(clears) == 1
    assert clears[0][1][0] - rise[0] == W, f"strobe width {clears[0][1][0] - rise[0]} != one poll iteration {W}"


@pytest.mark.parametrize("P,D,duties", [(400, 10, (100, 200, 300)), (800, 10, (400, 400, 400)),
                                        (800, 10, (11, 799, 0)), (800, 10, (380, 400, 420))], ids=lambda v: str(v))
def test_counted_call_repeats_the_period_edge_for_edge(tmp_path, P, D, duties):
    result, writes = run(tmp_path, P, D, list(duties), count=3)
    assert result.halted
    periods, clears = split_periods(writes, P, D, list(duties))
    assert len(periods) == 3
    # the counter restarts every period, so the counts themselves repeat edge for edge
    assert periods[0] == periods[1] == periods[2], "periods differ"
    for k, p in enumerate(periods):
        check_period(p, P, D, list(duties), f"period {k}")
    widths = {w[0] - [c for c, m in periods[i] if ("S", 1) in m][0] for i, w in clears}
    assert widths == {W}, widths


def test_strobe_width_is_identical_across_cases(tmp_path):
    widths = set()
    for P, D, duties in [(800, 10, (100, 400, 700)), (800, 10, (410, 100, 700)), (200, 10, (50, 100, 150))]:
        _, writes = run(tmp_path, P, D, list(duties))
        rise = [c for c, m in writes if ("S", 1) in m]
        fall = [c for c, m in writes if ("S", 0) in m]
        widths |= {f - r for r, f in zip(rise, fall)}
    assert max(widths) - min(widths) <= 1 and widths == {W}, widths


# ---- delivered dead time ------------------------------------------------------------------------
# The dead time is not a busy-wait, so it exists only as event times: nominally the high-off
# is at duty - DEADTIME and the low-on at duty + DEADTIME, a both-off gap of 2 x DEADTIME. A late
# high-off can bunch with an on-time low-on, and the delivered gap is then shorter. The numbers
# below are OBSERVED minima of the high-off -> low-on gap per leg (IEP counts, first period),
# pinned so the gap cannot shrink silently. They are not a guarantee: whether a guaranteed minimum
# is required is an open design decision. A bigger gap passes; a leg's gap below its pin fails.
GAP_PINS = [
    # high-off C lands at 462 and low-on C at 470 (ideal 434 / 454): 8 counts at DEADTIME 10
    (800, 10, (424, 424, 444), {"A": 29, "B": 29, "C": 8}),
    # legs A and B (duty 4 <= 2 x DEADTIME) have no high side; C: 55 -> 71 at DEADTIME 20
    (400, 20, (4, 4, 44), {"C": 16}),
    # the sparse co-simulation case (scripts/three_phase_pwm_cosim.js): nothing bunches, 2 x DEADTIME
    (400, 10, (300, 200, 100), {"A": 20, "B": 24, "C": 20}),
]


@pytest.mark.parametrize("P,D,duties,pins", GAP_PINS, ids=lambda v: str(v))
def test_high_off_to_low_on_gap_is_pinned_and_never_overlaps(tmp_path, P, D, duties, pins):
    result, writes = run(tmp_path, P, D, list(duties))
    assert result.halted
    state = set()
    for cnt, change in writes:
        state = {pl for pl in state if (pl[0], 1 - pl[1]) not in change} | {pl for pl in change if pl[1]}
        for x in LEGS:
            assert not ({x + "H", x + "L"} <= {pin for pin, _ in state}), f"{x}H and {x}L both on at {cnt}"
    gaps = {}
    for x in LEGS:
        off = next((c for c, w in writes if (x + "H", 0) in w), None)
        on = next((c for c, w in writes if (x + "L", 1) in w), None)
        if off is not None and on is not None:
            gaps[x] = on - off
    assert set(gaps) == set(pins), (gaps, pins)
    for x, pin in pins.items():
        assert gaps[x] >= pin, f"leg {x}: high-off -> low-on gap {gaps[x]} < pinned {pin} (nominal {2 * D})"


def test_back_to_back_single_calls_are_182_cycles_apart(tmp_path):
    """Two m_three_phase_pwm_period calls: each sorts its edges again and re-programs the IEP. The
    longDescription gives the gap from the last all-off edge to the next call's high-side write
    (CPU cycles: the IEP counter is re-programmed between the calls)."""
    args = dict(STATE="R4", DUTY_A="R5", DUTY_B="R6", DUTY_C="R7", PERIOD="400", DEADTIME="10",
                AH="0", AL="1", BH="2", BL="3", CH="4", CL="5", TRIGGER="6")
    spec = dict(block="three_phase_pwm_block", subdir="pru_io_blocks", macroCall="m_three_phase_pwm_period",
                macroArgs=args, macroRepeats=2, postlude=["halt"],
                prelude=["ldi32 R5, 100", "ldi32 R6, 200", "ldi32 R7, 300"])
    _require_iep_model()
    elf, _ = elf_cosim.build_block_firmware(spec, "b2b182", str(tmp_path / "b2b182"))
    edges, prev = [], [0]

    def watch(cycle, gpo, _gpi, _sim):
        if gpo != prev[0]:
            edges.append((cycle, gpo))
        prev[0] = gpo
    result = elf_cosim.run_elf_closed_loop(elf, Idle(), max_steps=60000, on_step=watch, **IEP_RUN)
    assert result.halted
    all_off = [c for c, g in edges if g == 0]
    high_on = [c for c, g in edges if g & 1 and not prev_g_has_ah(edges, c)]
    assert len(all_off) == 2 and len(high_on) == 2, edges
    assert high_on[1] - all_off[0] == 182


def prev_g_has_ah(edges, cycle):
    """True when the pin state just before `cycle` already had AH (bit 0) high."""
    before = [g for c, g in edges if c < cycle]
    return bool(before and before[-1] & 1)


def test_timing_restrictions_are_documented():
    """option 1: the software block's timing limits stay in the longDescription and in
    the generated reference, with the numbers pinned by the tests above."""
    import re
    blocks = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks"
    ref = ROOT / "docs" / "block-reference" / "blocks" / "three_phase_pwm_block"
    for f in (blocks / "three_phase_pwm_block.syscfg.js", ref / "design.md", ref / "user-guide.md"):
        text = re.sub(r"\s+", " ", f.read_text(encoding="utf-8"))
        assert "Timing restrictions:" in text, f.name
        tail = text[text.index("Timing restrictions:"):]
        for needle in ("2 x DEADTIME", "about 8 counts at DEADTIME 10", "about 16 at DEADTIME 20",
                       "not a guaranteed minimum", "up to 8 counts late", "W + X = 9", "12-count budget",
                       "400/400/400", "31 counts late", "no PWM module", ""):
            assert needle in tail, f"{f.name}: {needle}"
