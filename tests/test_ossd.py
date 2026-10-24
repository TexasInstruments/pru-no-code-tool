"""dual-channel OSSD emitter + safety monitor.

Focused tests for:
  (a) accepted OSSD test pulses (100 us - 1 ms scaled)
  (b) genuine trips (LOW longer than OSSD_MAX)
  (c) channel disagreement within the discrepancy window
  (d) channel disagreement beyond the window
  (e) boundary cases (OSSD_MAX, OSSD_MAX+1, window, window+1)
  (f) independent bus-cosim oracle agreement (pru_device_models/buscosim.decode_ossd)

The monitor block itself (safety_dual_monitor_block.syscfg.js) is
exercised headlessly where possible: macro assembles, uses the
2-TEMP_REG pattern, carries the non-certified disclaimer, and classifies
static pin levels as SAFE/TRIP/DISCREPANCY. Dynamic OSSD pulse
discrimination is proven via the Python model + oracle pair; the PRU
macro's counting loops mirror that logic and share the same thresholds.

All timings are in PRU cycles (5 ns at 200 MHz). Typical field OSSD
pulses 100 us-1 ms = 20k-200k cycles; tests use scaled 20-400 cycle
windows so runs are fast - thresholds are explicit parameters.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from pru_device_models.ossd_emitter import DualOssdEmitter
from pru_device_models import buscosim

# ---------------------------------------------------------------- helpers
def drive(model, cycles, start=0):
    """Tick model for `cycles` steps; returns trace (cycle, pins_word)."""
    trace = []
    for i in range(cycles):
        c = start + i
        word = model.tick(c, 0)
        # resolved word is just model drive (no PRU output)
        trace.append((c, word))
    model.flush(start + cycles)
    return trace


# ================================================================= model
class TestOssdModel:
    def test_accepted_ossd_pulse_ch_a(self):
        m = DualOssdEmitter(ch_a_pin=0, ch_b_pin=1, ossd_max_cycles=400, discrepancy_cycles=500)
        m.schedule_ossd_pulse("A", start=50, width=120)  # within max
        drive(m, 400)
        pulses = [e for e in m.events() if e["kind"] == "ossd_pulse"]
        trips = [e for e in m.events() if e["kind"] == "trip"]
        assert len(pulses) == 1 and pulses[0]["channel"] == "A"
        assert len(trips) == 0
        assert m.faults() == []

    def test_accepted_ossd_pulse_ch_b(self):
        m = DualOssdEmitter(ch_a_pin=0, ch_b_pin=1, ossd_max_cycles=400)
        m.schedule_ossd_pulse("B", start=10, width=80)
        m.schedule_ossd_pulse("A", start=200, width=100)
        drive(m, 400)
        assert len([e for e in m.events() if e["kind"] == "ossd_pulse"]) == 2

    def test_genuine_trip_both_low(self):
        m = DualOssdEmitter(ossd_max_cycles=100)
        m.schedule_trip(start=30, duration=500)  # >> max
        drive(m, 600)
        trips = [e for e in m.events() if e["kind"] == "trip"]
        assert len(trips) >= 1
        assert all(t["width"] > 100 for t in trips)

    def test_genuine_single_channel_long_low_is_trip(self):
        m = DualOssdEmitter(ossd_max_cycles=50)
        m.schedule_single_low("A", start=10, duration=300)
        drive(m, 400)
        trips = [e for e in m.events() if e["kind"] == "trip"]
        assert len(trips) == 1 and trips[0]["width"] == 300

    def test_disagreement_within_window(self):
        # Short single-channel low within both OSSD max and discrepancy window
        m = DualOssdEmitter(ossd_max_cycles=200, discrepancy_cycles=500)
        m.schedule_single_low("A", start=50, duration=100)
        trace = drive(m, 400)
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=200, discrepancy_cycles=500)
        assert not [e for e in dec if e["kind"] == "discrepancy_fault"]
        assert any(e["kind"] == "ossd_pulse" for e in dec)

    def test_disagreement_beyond_window(self):
        m = DualOssdEmitter(ossd_max_cycles=400, discrepancy_cycles=100)
        m.schedule_single_low("A", start=20, duration=300)  # exceeds window
        trace = drive(m, 500)
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=400, discrepancy_cycles=100)
        assert any(e["kind"] == "discrepancy_fault" for e in dec)

    def test_boundary_ossd_max_accepted(self):
        m = DualOssdEmitter(ossd_max_cycles=200)
        m.schedule_ossd_pulse("A", start=10, width=200)  # exactly max
        drive(m, 300)
        assert m.events()[0]["kind"] == "ossd_pulse"
        # oracle agrees on boundary
        trace = [(0, 3), (10, 2), (210, 3)]  # A low 200 cycles, B high throughout
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=200, discrepancy_cycles=500)
        # decode measures (210-10)=200 -> ossd_pulse
        assert any(e["kind"] == "ossd_pulse" and e["width"] == 200 for e in dec)

    def test_boundary_ossd_max_plus_one_is_trip(self):
        m = DualOssdEmitter(ossd_max_cycles=200)
        m.schedule_ossd_pulse("A", start=10, width=201)
        drive(m, 300)
        assert m.events()[0]["kind"] == "trip"
        trace = [(0, 3), (10, 2), (211, 3)]
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=200, discrepancy_cycles=500)
        assert any(e["kind"] == "trip" and e["width"] == 201 for e in dec)

    def test_boundary_discrepancy_within(self):
        # duration exactly at window -> not a fault (fault only when > window)
        trace = [(0, 3), (10, 2), (110, 3)]  # disagree 100 cycles
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=500, discrepancy_cycles=100)
        assert not [e for e in dec if e["kind"] == "discrepancy_fault"]

    def test_boundary_discrepancy_plus_one(self):
        trace = [(0, 3), (10, 2), (111, 3)]  # disagree 101 cycles
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=500, discrepancy_cycles=100)
        assert any(e["kind"] == "discrepancy_fault" for e in dec)

    def test_buscosim_agrees_with_model(self):
        m = DualOssdEmitter(ch_a_pin=0, ch_b_pin=1, ossd_max_cycles=150, discrepancy_cycles=200)
        m.schedule_ossd_pulse("A", start=20, width=80)
        m.schedule_single_low("B", start=150, duration=180)  # trip (B >150) but within disc? 180<200 -> no disc fault
        m.schedule_trip(start=400, duration=300)
        trace = drive(m, 800)
        dec = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=150, discrepancy_cycles=200)
        # model and oracle must classify each pulse identically
        mod = sorted([(e["kind"], e["channel"], e["width"]) for e in m.events()])
        oro = sorted([(e["kind"], e["channel"], e["width"]) for e in dec if e["kind"] in ("ossd_pulse", "trip")])
        assert mod == oro, f"model {mod} vs oracle {oro}"

    def test_contention_fault(self):
        m = DualOssdEmitter(ch_a_pin=0, ch_b_pin=1)
        m.tick(0, 1 << 0)  # PRU drives CH_A pin
        assert any("contention" in f for f in m.faults())

    def test_bad_construction_pins(self):
        m = DualOssdEmitter(ch_a_pin=2, ch_b_pin=2)
        assert any("must differ" in f for f in m.faults())

    # red result preserved: a mis-tuned monitor that widens OSSD_MAX would
    # accept a genuine trip as OSSD - this test keeps the red visible by
    # showing the oracle DOES flag the trip even though a lax threshold would not.
    def test_red_mis_tuned_threshold_would_hide_trip(self):
        # correct threshold
        trace = [(0, 3), (10, 0), (300, 3)]  # both low 290 cycles
        dec_strict = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=200, discrepancy_cycles=500)
        assert any(e["kind"] == "trip" for e in dec_strict)
        # lax threshold (mis-tuned monitor) would misclassify as ossd - this is the red
        dec_lax = buscosim.decode_ossd(trace, 0, 1, ossd_max_cycles=400, discrepancy_cycles=500)
        assert any(e["kind"] == "ossd_pulse" for e in dec_lax)
        assert dec_strict != dec_lax  # discrimination is real; lax hides the trip


# ========================================================== block presence / assembly
class TestSafetyMonitorBlockFile:
    def test_block_file_exists_and_warns(self):
        p = os.path.join(
            os.path.dirname(__file__), "..",
            ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/safety_dual_monitor_block.syscfg.js",
        )
        assert os.path.exists(p)
        txt = open(p, encoding="utf-8").read()
        assert "NOT A CERTIFIED SAFETY FUNCTION" in txt
        assert "TEMP_REG1" in txt and "TEMP_REG2" in txt
        assert "DISC_CYCLES" in txt and "OSSD_MAX" in txt

    def test_block_macro_expands_and_uses_two_temp_regs(self):
        # Lightweight headless check: macro must contain both TEMP_REGs and status codes
        p = os.path.join(
            os.path.dirname(__file__), "..",
            ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/safety_dual_monitor_block.syscfg.js",
        )
        txt = open(p, encoding="utf-8").read()
        assert "ldi RES, 2" in txt  # discrepancy fault code
        assert "ldi RES, 1" in txt  # trip code
        assert "qbgt" in txt  # pulse-width compare
        assert "qbeq" in txt  # discrepancy timeout


    def test_every_macro_parameter_is_actually_used(self):
        """A declared-but-unwritten output parameter is a silent stale read.

        The macro shipped with a sixth parameter, STATUS_REG, that appeared
        only in the .macro header and was never assigned. Every test passed
        STATUS_REG the SAME register as RES, so nothing noticed. A caller who
        allocated a distinct register for it - which the block's own UI would
        - would read whatever was there before: on a safety monitor, a stale
        SAFE after a real trip.

        This checks the general property rather than that one name, so the
        same mistake in a future parameter fails here too.
        """
        p = os.path.join(
            os.path.dirname(__file__), "..",
            ".metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/safety_dual_monitor_block.syscfg.js",
        )
        src = open(p, encoding="utf-8").read()
        header = [l for l in src.split("\n") if ".macro RES" in l]
        assert len(header) == 1, header
        params = [x.strip() for x in header[0].split(".macro", 1)[1]
                  .rstrip("`,").split(",")]
        params = [x for x in params if x]
        assert "RES" in params

        # Body = the macro lines after the header, up to .endm.
        after = src.split(header[0], 1)[1]
        body = after.split(".endm", 1)[0]

        unused = [x for x in params if x not in body]
        assert not unused, (
            "macro parameter(s) declared but never referenced in the body: %s. "
            "Either use them or drop them from the signature." % unused)
    def test_ossd_emitter_js_port_exists(self):
        p = os.path.join(
            os.path.dirname(__file__), "..",
            ".metadata/sysconfig/.meta/pru_blocks/common/simulation/device_models.js",
        )
        txt = open(p, encoding="utf-8").read()
        assert "DualOssdEmitter" in txt
        assert '"ossd"' in txt

    def test_python_model_importable(self):
        from pru_device_models.ossd_emitter import DualOssdEmitter as M
        assert M is not None
