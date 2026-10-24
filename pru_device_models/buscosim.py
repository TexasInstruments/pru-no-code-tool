"""Independent bus-cosim decoders -.

These decode *resolved pin traces* (cycle, pin word) into protocol events.
They share no code or state with the DeviceModel implementations in this
package: they are the second, independent implementation whose event stream
must agree with each model's ``events()`` for a run to be accepted.

Trace format: iterable of ``(cycle:int, word:int)`` samples, one per
observation point, monotonically increasing in cycle. ``word`` carries all
pins; the decoder is told which bit positions to look at.
"""

from typing import Any, Dict, Iterable, List, Tuple

Trace = Iterable[Tuple[int, int]]


# ---------------------------------------------------------------- quadrature
_FWD = {0: 1, 1: 3, 3: 2, 2: 0}
_REV = {v: k for k, v in _FWD.items()}


def decode_quadrature(trace: Trace, a_bit: int, b_bit: int, z_bit: int) -> List[Dict[str, Any]]:
    """Decode A/B/Z into edge counts and index pulses.

    Events: edge {"kind","cycle","state","count","dir"}, index {"kind","cycle"},
    illegal {"kind":"illegal","cycle","from","to"} for non-unit transitions.
    """
    events: List[Dict[str, Any]] = []
    prev_state = None
    prev_z = 0
    count = 0
    for cycle, word in trace:
        a = (word >> a_bit) & 1
        b = (word >> b_bit) & 1
        z = (word >> z_bit) & 1
        state = 2 * a + b
        if prev_state is None:
            prev_state = state
        elif state != prev_state:
            if _FWD[prev_state] == state:
                count += 1
                events.append({"kind": "edge", "cycle": cycle, "state": state,
                               "count": count, "dir": 1})
            elif _REV[prev_state] == state:
                count -= 1
                events.append({"kind": "edge", "cycle": cycle, "state": state,
                               "count": count, "dir": -1})
            else:
                events.append({"kind": "illegal", "cycle": cycle,
                               "from": prev_state, "to": state})
            prev_state = state
        if z == 1 and prev_z == 0:
            events.append({"kind": "index", "cycle": cycle})
        prev_z = z
    return events


# ----------------------------------------------------------------------- SSI
def decode_ssi(trace: Trace, clk_pin: int, data_pin: int, *, cpol: int,
               expected_bits: int, idle_gap_cycles: int = 8) -> List[Dict[str, Any]]:
    """Decode SSI frames the way a datasheet receiver does.

    The first active (normally falling) edge latches.  DATA is sampled on each
    following return-to-idle edge, including R1/MSB; F(n+1) is the terminator
    and is not a data sample.  Consequently ``expected_bits`` is required (as
    is ``cpol``, keyword-only: omitting either raises ``TypeError``): without
    it F(n+1) cannot be told from data and a correct 8-bit frame would decode
    as 9 bits.  It distinguishes a valid n+1-pulse word from an n-pulse word
    missing its terminator, reported as ``missing SSI terminator pulse``.

    Frame boundaries are idle gaps longer than ``idle_gap_cycles`` between
    active edges. Events: {"kind":"frame","cycle","raw","bits"}; the decoder
    reports the bits it saw, or a "fault" event when the pulse count is not
    ``expected_bits`` + 1.
    """
    active = 1 - cpol
    events: List[Dict[str, Any]] = []
    # The first trace value is the PRU reset/setup level, not necessarily the
    # protocol idle level.  Seed history from it so a reset-low observation
    # cannot manufacture an F1 latch for an idle-high SSI transfer.
    prev_clk: int | None = None
    bits: List[int] = []
    last_active_cycle = None
    pulse_count = 0

    def finish(cycle: int) -> None:
        nonlocal bits, pulse_count, last_active_cycle
        if not pulse_count:
            return
        if pulse_count == expected_bits:
            events.append({"kind": "fault", "cycle": cycle,
                           "fault": "missing SSI terminator pulse: expected "
                                    f"{expected_bits} data pulses + 1 terminator pulse, "
                                    f"saw {pulse_count} pulses"})
        elif pulse_count != expected_bits + 1:
            events.append({"kind": "fault", "cycle": cycle,
                           "fault": f"incomplete SSI frame: expected {expected_bits} data "
                                    f"pulses + 1 terminator pulse, saw {pulse_count} pulses"})
        elif bits:
            events.append(_ssi_frame_event(bits, last_active_cycle))
        bits = []
        pulse_count = 0
        last_active_cycle = None

    for cycle, word in trace:
        clk = (word >> clk_pin) & 1
        data = (word >> data_pin) & 1
        if prev_clk is None:
            prev_clk = clk
            continue
        if clk != prev_clk and clk == active:
            if (last_active_cycle is not None
                    and cycle - last_active_cycle > idle_gap_cycles):
                finish(last_active_cycle)
            pulse_count += 1
            last_active_cycle = cycle
        elif clk != prev_clk and clk == cpol:
            # R1..Rn are the datasheet data edges.  Do not sample the return
            # from F(n+1), whose DATA is the monoflop-low indication.
            if 0 < pulse_count <= expected_bits:
                bits.append(data)
        prev_clk = clk
    finish(last_active_cycle)
    return events


def _ssi_frame_event(bits: List[int], cycle: int) -> Dict[str, Any]:
    raw = 0
    for b in bits:
        raw = (raw << 1) | b
    return {"kind": "frame", "cycle": cycle, "raw": raw, "bits": len(bits)}


# --------------------------------------------------------------------- WS2812
def decode_ws2812(trace: Trace, data_pin: int, t0h: float, t1h: float,
                  tol: float, reset_cycles: float) -> List[Dict[str, Any]]:
    """Decode a WS2812 NRZ stream into pixels (0xRRGGBB from GRB wire order).

    Events: {"kind":"frame","cycle","pixels":[...]},
    {"kind":"timing_error","cycle","width"} for pulses in neither window.
    All times in cycles.
    """
    events: List[Dict[str, Any]] = []
    bits: List[int] = []
    prev = 0
    since = 0
    for cycle, word in trace:
        level = (word >> data_pin) & 1
        if level == prev:
            continue
        width = cycle - since
        if prev == 1:
            if abs(width - t0h) <= tol:
                bits.append(0)
            elif abs(width - t1h) <= tol:
                bits.append(1)
            else:
                events.append({"kind": "timing_error", "cycle": cycle, "width": width})
        else:
            if width >= reset_cycles and bits:
                events.append({"kind": "frame", "cycle": cycle,
                               "pixels": _ws2812_pixels(bits)})
                bits = []
        prev = level
        since = cycle
    if bits:
        events.append({"kind": "frame", "cycle": since, "pixels": _ws2812_pixels(bits)})
    return events


def _ws2812_pixels(bits: List[int]) -> List[int]:
    pixels = []
    for i in range(0, len(bits) - 23, 24):
        w = 0
        for b in bits[i:i + 24]:
            w = (w << 1) | b
        g = (w >> 16) & 0xFF
        r = (w >> 8) & 0xFF
        bch = w & 0xFF
        pixels.append((r << 16) | (g << 8) | bch)
    return pixels


# ----------------------------------------------------------------------- SPI
def decode_spi_mode0(trace: Trace, sclk_pin: int, sdi_pin: int, sdo_pin: int,
                     cs_pin: int, msb_first: bool = True) -> List[Dict[str, Any]]:
    """Decode SPI mode-0 transactions. MISO is SDI (peripheral->PRU), MOSI SDO.

    Events: {"kind":"transaction","cycle","miso","mosi","bits"} and
    {"kind":"framing_error","cycle","detail"}.
    """
    events: List[Dict[str, Any]] = []
    prev_sclk, prev_cs = 0, 1
    primed = False
    in_frame = False
    miso = mosi = nbits = 0
    for cycle, word in trace:
        sclk = (word >> sclk_pin) & 1
        cs = (word >> cs_pin) & 1
        if not primed:      # the first sample is the reset level, not a CS edge
            primed = True
            prev_cs = cs
        if cs != prev_cs:
            if cs == 0:
                in_frame = True
                miso = mosi = nbits = 0
            else:
                if in_frame:
                    events.append({"kind": "transaction", "cycle": cycle,
                                   "miso": miso, "mosi": mosi, "bits": nbits})
                in_frame = False
            prev_cs = cs
        if sclk != prev_sclk:
            if not in_frame:
                events.append({"kind": "framing_error", "cycle": cycle,
                               "detail": "sclk outside CS"})
            elif sclk == 1:
                if msb_first:
                    miso = ((miso << 1) | ((word >> sdi_pin) & 1)) & 0xFFFFFFFFFF
                    mosi = ((mosi << 1) | ((word >> sdo_pin) & 1)) & 0xFFFFFFFFFF
                else:
                    miso |= ((word >> sdi_pin) & 1) << nbits
                    mosi |= ((word >> sdo_pin) & 1) << nbits
                nbits += 1
        prev_sclk = sclk
    return events


# ---------------------------------------------------------------------- Hall
_HALL_LUT = {1: 0, 3: 1, 2: 2, 6: 3, 4: 4, 5: 5}

def decode_hall(trace: Trace, a_bit: int, b_bit: int, c_bit: int) -> List[Dict[str, Any]]:
    """Decode 3-phase Hall into sector edges and illegal codes.

    Code = (A<<2)|(B<<1)|C. Six codes are legal via _HALL_LUT, 0 and 7 are
    illegal. Events: {"kind":"edge","cycle","code","sector","dir"},
    {"kind":"illegal","cycle","code"}.

    The decoder does NOT interpolate through illegal states: an illegal
    code emits only an illegal event, never an edge.
    """
    events: List[Dict[str, Any]] = []
    prev_sector = None
    prev_code = None
    for cycle, word in trace:
        a = (word >> a_bit) & 1
        b = (word >> b_bit) & 1
        c = (word >> c_bit) & 1
        code = (a << 2) | (b << 1) | c
        if code in (0, 7):
            events.append({"kind": "illegal", "cycle": cycle, "code": code})
            prev_code = code
            continue
        sector = _HALL_LUT.get(code)
        if sector is None:
            events.append({"kind": "illegal", "cycle": cycle, "code": code})
            prev_code = code
            continue
        if prev_code is not None and code == prev_code:
            continue
        if prev_sector is None:
            prev_sector = sector
            prev_code = code
            continue
        # direction from sector delta modulo 6
        diff = (sector - prev_sector) % 6
        if diff == 1:
            d = 1
        elif diff == 5:
            d = -1
        else:
            # non-adjacent jump without illegal in between -> interpolate would be wrong
            events.append({"kind": "illegal", "cycle": cycle,
                           "code": code, "detail": f"non-adjacent {prev_sector}->{sector}"})
            prev_sector = sector
            prev_code = code
            continue
        events.append({"kind": "edge", "cycle": cycle, "code": code,
                       "sector": sector, "dir": d})
        prev_sector = sector
        prev_code = code
    return events


# ------------------------------------------------------------------ OSSD dual-channel
def decode_ossd(
    trace: Trace,
    ch_a_pin: int,
    ch_b_pin: int,
    ossd_max_cycles: int,
    discrepancy_cycles: int,
) -> List[Dict[str, Any]]:
    """Independent oracle for dual-channel OSSD.

    Decodes a resolved pin trace into pulse and disagreement events.

    Classification:
        - LOW pulse width <= ossd_max_cycles  -> {"kind":"ossd_pulse"}
        - LOW pulse width  > ossd_max_cycles  -> {"kind":"trip"}
        - channels differ for > discrepancy_cycles -> {"kind":"discrepancy_fault"}

    LOW width is measured from falling edge to next rising edge on each
    channel independently; at end-of-trace any open LOW is closed at the
    last cycle.

    Disagreement detection: contiguous interval where (a != b). One
    event per interval that exceeds the window; intervals within the
    window still emit ossd_pulse events but no discrepancy_fault.

    Trace format: iterable of (cycle, word) with monotonic cycle.
    """
    events: List[Dict[str, Any]] = []
    if not trace:
        return events
    trace_list = list(trace)
    # per-channel: track LOW start
    prev_a = (trace_list[0][1] >> ch_a_pin) & 1
    prev_b = (trace_list[0][1] >> ch_b_pin) & 1
    low_since_a = None
    low_since_b = None
    if prev_a == 0:
        low_since_a = trace_list[0][0]
    if prev_b == 0:
        low_since_b = trace_list[0][0]
    # disagreement window tracking
    disagree_since: int | None = None
    last_cycle = trace_list[0][0]

    def _close_low(channel: str, since: int, end_cycle: int):
        width = end_cycle - since
        kind = "ossd_pulse" if width <= ossd_max_cycles else "trip"
        events.append({"kind": kind, "cycle": end_cycle, "channel": channel, "width": width})

    for cycle, word in trace_list[1:]:
        a = (word >> ch_a_pin) & 1
        b = (word >> ch_b_pin) & 1
        # per-channel pulse closure on rising edge
        if prev_a == 0 and a == 1 and low_since_a is not None:
            _close_low("A", low_since_a, cycle)
            low_since_a = None
        if prev_b == 0 and b == 1 and low_since_b is not None:
            _close_low("B", low_since_b, cycle)
            low_since_b = None
        if prev_a == 1 and a == 0:
            low_since_a = cycle
        if prev_b == 1 and b == 0:
            low_since_b = cycle
        # disagreement interval
        disagree = (a != b)
        if disagree and disagree_since is None:
            disagree_since = cycle
        elif not disagree and disagree_since is not None:
            dur = cycle - disagree_since
            if dur > discrepancy_cycles:
                events.append({"kind": "discrepancy_fault", "cycle": cycle, "duration": dur})
            disagree_since = None
        prev_a, prev_b = a, b
        last_cycle = cycle

    # close open lows at end
    if low_since_a is not None:
        _close_low("A", low_since_a, last_cycle)
    if low_since_b is not None:
        _close_low("B", low_since_b, last_cycle)
    if disagree_since is not None:
        dur = last_cycle - disagree_since
        if dur > discrepancy_cycles:
            events.append({"kind": "discrepancy_fault", "cycle": last_cycle, "duration": dur})
    return events


# ------------------------------------------------------------------ STEP/DIR
def decode_step_dir(trace: Trace, step_pin: int, dir_pin: int,
                    min_pulse_cycles: int = 0) -> List[Dict[str, Any]]:
    """Decode STEP/DIR into position steps and timing violations.

    Events: {"kind":"step","cycle","position","dir"} and
    {"kind":"timing_error","cycle","width"} for narrow high pulses.
    """
    events: List[Dict[str, Any]] = []
    prev_step = 0
    since = 0
    position = 0
    for cycle, word in trace:
        step = (word >> step_pin) & 1
        d = (word >> dir_pin) & 1
        if step == prev_step:
            continue
        width = cycle - since
        if step == 1:
            direction = 1 if d == 1 else -1
            position += direction
            events.append({"kind": "step", "cycle": cycle,
                           "position": position, "dir": direction})
        else:
            if min_pulse_cycles and width < min_pulse_cycles:
                events.append({"kind": "timing_error", "cycle": cycle,
                               "width": width})
        prev_step = step
        since = cycle
    return events


# ---------------------------------------------------------------- BiSS Line
def decode_bissline(trace, clk_pin, data_pin, data_bits,
                    idle_gap_cycles=8):
    """Decode BiSS Line frames by sampling DATA on the falling clock edge.

    Returns list of events: {"kind":"frame","cycle","raw","bits"} and
    {"kind":"crc_error","cycle"} when CRC-6 does not match.

    CRC-6 is computed independently (poly 0x43, inverted) over the
    position + nE + nW bits. Header (ACK, Start, CDS) is excluded.
    """
    events = []
    prev_clk = 0
    bits = []
    last_active_cycle = None
    for cycle, word in trace:
        clk = (word >> clk_pin) & 1
        data = (word >> data_pin) & 1
        if clk != prev_clk:
            if clk == 1:
                if (bits and last_active_cycle is not None
                        and cycle - last_active_cycle > idle_gap_cycles):
                    events.append(_bissline_frame_event(bits, last_active_cycle, data_bits))
                    bits = []
                last_active_cycle = cycle
            else:
                if last_active_cycle is not None:
                    bits.append(data)
        prev_clk = clk
    if bits:
        events.append(_bissline_frame_event(bits, last_active_cycle, data_bits))
    return events


def _bissline_crc6(bits):
    """Decoder-local CRC-6 copy for wire-shape checks, not an independent oracle."""
    crc = 0
    for b in bits:
        fb = ((crc >> 5) & 1) ^ (b & 1)
        crc = ((crc << 1) & 0x3F)
        if fb:
            crc ^= 0x03
    return crc ^ 0x3F


def _bissline_frame_event(bits, cycle, data_bits):
    raw = 0
    for b in bits:
        raw = (raw << 1) | b
    ev = {"kind": "frame", "cycle": cycle, "raw": raw, "bits": len(bits)}
    # Try to decode if enough bits: ACK(1) + Start(1) + CDS(1) + pos + nE(1) + nW(1) + CRC(6)
    expected = 3 + data_bits + 2 + 6
    if len(bits) >= expected:
        pos_bits = bits[3:3 + data_bits]
        ne = bits[3 + data_bits]
        nw = bits[3 + data_bits + 1]
        crc_bits = bits[3 + data_bits + 2:3 + data_bits + 8]
        received_crc = 0
        for b in crc_bits:
            received_crc = (received_crc << 1) | b
        computed = _bissline_crc6(pos_bits + [ne, nw])
        position = 0
        for b in pos_bits:
            position = (position << 1) | b
        ev["position"] = position
        ev["cds"] = bits[2]
        ev["crc_ok"] = (received_crc == computed)
        ev["error"] = ne == 0
        ev["warning"] = nw == 0
    return ev
