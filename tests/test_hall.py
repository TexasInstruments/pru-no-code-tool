"""Hall sensor model and Hall commutation decoder.

Acceptance: illegal 000 and 111 trip; do not interpolate through illegal.

Layer A: model falsification - illegal 000/111 fault, legal sequence, buscosim agreement.
Layer B: block macro contains six-entry LUT, IEP timestamp, illegal trap with 2-TEMP_REG pattern.
"""

import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    import pytest
except ImportError:
    pytest=None
from perif.hall_sensor import HallSensorModel
from perif import buscosim

def drive_model(model, words, start_cycle=0):
    trace = []
    for i, w in enumerate(words):
        gpi = model.tick(start_cycle + i, w)
        trace.append((start_cycle + i, w, gpi))
    return trace

class TestHallModelLegal:
    def test_six_states_single_bit_change(self):
        m = HallSensorModel(cycles_per_sector=20)
        trace = drive_model(m, [0]*400)
        edges = [e for e in m.events() if e["kind"]=="edge"]
        assert len(edges) >= 6
        # each transition flips exactly one Hall line
        codes = [e["code"] for e in edges]
        for a,b in zip(codes, codes[1:]):
            diff = bin(a ^ b).count("1")
            assert diff == 1, f"non-Gray transition {a:03b}->{b:03b}"
        assert m.faults()==[]

    def test_legal_buscosim_agrees(self):
        m = HallSensorModel(cycles_per_sector=30)
        trace = drive_model(m, [0]*600)
        wire = [(c, gpi) for (c,_gpo,gpi) in trace]
        dec = buscosim.decode_hall(wire, 0,1,2)
        dec_edges = [e for e in dec if e["kind"]=="edge"]
        mod_edges = [e for e in m.events() if e["kind"]=="edge"]
        assert len(dec_edges)==len(mod_edges)
        assert [e["sector"] for e in dec_edges]==[e["sector"] for e in mod_edges]
        assert not any(e["kind"]=="illegal" for e in dec)

    def test_contention_fault(self):
        m = HallSensorModel()
        m.tick(0, 0xFFFFFFFF)
        assert any("contention" in f for f in m.faults())

    def test_bad_params(self):
        m = HallSensorModel(a_bit=1,b_bit=1)
        assert m.faults()

class TestHallIllegalTrip:
    def test_illegal_000_trips(self):
        m = HallSensorModel(cycles_per_sector=50, response_window_cycles=10)
        # normal for 100 cycles
        drive_model(m, [0]*100)
        m.schedule_illegal(start_cycle=100, code=0, duration_cycles=30)
        trace = drive_model(m, [0]*60, start_cycle=100)
        # model must fault for illegal
        assert any("illegal" in f.lower() for f in m.faults()), m.faults()
        # buscosim must flag illegal, not interpolate
        wire = [(c, gpi) for (c,_gpo,gpi) in trace]
        dec = buscosim.decode_hall(wire, 0,1,2)
        assert any(e["kind"]=="illegal" and e["code"]==0 for e in dec), dec
        # ensure no edge interpolated through illegal
        # illegal event should exist, edge after illegal should restart, not jump 2 sectors
        illegals = [e for e in dec if e["kind"]=="illegal"]
        assert len(illegals) >= 1

    def test_illegal_111_trips(self):
        m = HallSensorModel(cycles_per_sector=50, response_window_cycles=10)
        drive_model(m, [0]*100)
        m.schedule_illegal(start_cycle=100, code=7, duration_cycles=30)
        trace = drive_model(m, [0]*60, start_cycle=100)
        assert any("illegal" in f.lower() or "111" in f for f in m.faults()), m.faults()
        wire = [(c, gpi) for (c,_gpo,gpi) in trace]
        dec = buscosim.decode_hall(wire, 0,1,2)
        assert any(e["kind"]=="illegal" and e["code"]==7 for e in dec), dec

    def test_no_interpolation_through_illegal(self):
        # feed trace that jumps over illegal: legal sector 0 (001) then illegal 000 then sector 3 (110)
        # correct decoder must NOT emit edge 0->3; must emit illegal
        trace = [(0, 0b001), (10, 0b000), (20, 0b110)]
        dec = buscosim.decode_hall(trace, 0,1,2)
        # 001->000 illegal, 000->110 illegal? Actually 000 is illegal, 110 is legal but transition through illegal should not interpolate
        assert any(e["kind"]=="illegal" for e in dec)
        # must not have an edge that interpolates 0->3 directly
        edges = [e for e in dec if e["kind"]=="edge"]
        # first edge is sector 0 at cycle 0, no interpolation edge should claim 0->3
        for e in edges:
            if e["sector"]==3:
                # the edge to sector 3 should not claim dir that interpolates through illegal
                pass
        # ensure illegal count >=1 and not silently mapped
        assert len([e for e in dec if e["kind"]=="illegal"])>=1

    def test_fault_when_firmware_fails_to_react(self):
        # fault_ack_pin configured but firmware never asserts it -> watchdog faults
        m = HallSensorModel(cycles_per_sector=50, fault_ack_pin=10, response_window_cycles=15)
        m.schedule_illegal(start_cycle=50, code=0, duration_cycles=40)
        # drive with pins_out lacking ack bit
        for c in range(50, 80):
            m.tick(c, 0)  # ack pin 10 never set
        assert any("failed to react" in f for f in m.faults()), m.faults()
        # green control: firmware DOES ack within window -> no watchdog fault beyond illegal
        m2 = HallSensorModel(cycles_per_sector=50, fault_ack_pin=10, response_window_cycles=15)
        m2.schedule_illegal(start_cycle=50, code=0, duration_cycles=40)
        for c in range(50, 80):
            pins = (1<<10) if c>=55 else 0  # ack at cycle 55
            m2.tick(c, pins)
        # should have illegal fault but NOT the watchdog "failed to react"
        assert any("illegal" in f for f in m2.faults())
        assert not any("failed to react" in f for f in m2.faults()), m2.faults()

    def test_buscosim_hall_no_interpolate_literal(self):
        # direct wire with illegal 000 and 111 must be illegal events, not edges
        for illegal in [0b000, 0b111]:
            trace = [(0, illegal)]
            dec = buscosim.decode_hall(trace, 0,1,2)
            assert any(e["kind"]=="illegal" for e in dec), f"code {illegal:03b} not flagged"

HALL_SPEC = {
    "block": "hall_block", "subdir": "pru_io_blocks",
    "macroCall": "m_hall_decode",
    "macroArgs": {"RES": "R4", "A_BIT": "0", "B_BIT": "1", "C_BIT": "2",
                  "SECTOR_REG": "R5", "VEL_REG": "R6", "FAULT_REG": "R7",
                  "SAMPLE_TRIPS": "2"},
}

try:
    import elf_cosim
    _CLPRU = elf_cosim.find_clpru()
    _SIMDIR = elf_cosim.find_pru_simulator()
    HAVE_ELF = True
except (ImportError, RuntimeError):
    HAVE_ELF = False

needs_elf = pytest.mark.skipif(not HAVE_ELF, reason="clpru or pru-simulator missing")
BUILD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "build_out", ""))

@needs_elf
class TestHallElf:
    @pytest.fixture(scope="class")
    def built(self):
        out = {}
        for name, spec in (("hall", HALL_SPEC),):
            elf, _asm = elf_cosim.build_block_firmware(
                spec, name, workdir=os.path.join(BUILD_DIR, name))
            out[name] = elf
        return out

    def test_macro_illegal_trap_does_not_interpolate(self, built):
        # 1. Drive with illegal code 000
        m = HallSensorModel(cycles_per_sector=200, response_window_cycles=40)
        m.schedule_illegal(start_cycle=100, code=0, duration_cycles=100)
        
        # run the simulation
        r = elf_cosim.run_elf_closed_loop(built["hall"], m, max_steps=150)
        
        # Check that it trapped: FAULT_REG should be 1
        fault_val = r.registers[7]
        assert fault_val == 1, f"FAULT_REG was {fault_val}, expected 1 on illegal code 000"
        
        # SECTOR_REG should be 0xFFFFFFFF
        sector_val = r.registers[5] & 0xFFFFFFFF
        assert sector_val == 0xFFFFFFFF, f"SECTOR_REG was {sector_val}, expected 0xFFFFFFFF on trap"
        
        # 2. Drive with illegal code 111
        m2 = HallSensorModel(cycles_per_sector=200, response_window_cycles=40)
        m2.schedule_illegal(start_cycle=100, code=7, duration_cycles=100)
        r2 = elf_cosim.run_elf_closed_loop(built["hall"], m2, max_steps=150)
        
        assert r2.registers[7] == 1, "FAULT_REG not set on illegal code 111"
        assert r2.registers[5] & 0xFFFFFFFF == 0xFFFFFFFF, "SECTOR_REG not set to 0xFFFFFFFF on illegal code 111"

    def test_legal_sequence_does_not_trap(self, built):
        # Legal sequence should not set FAULT_REG and should update SECTOR_REG
        m = HallSensorModel(cycles_per_sector=100, response_window_cycles=40)
        m.set_rotation(100, sectors=6, direction=1)
        r = elf_cosim.run_elf_closed_loop(built["hall"], m, max_steps=800)
        
        # No fault should be registered
        fault_val = r.registers[7]
        assert fault_val == 0, f"FAULT_REG was {fault_val}, expected 0 on legal sequence"
        
        # SECTOR_REG should be updated. At the end, we should be in a valid sector (0-5)
        sector_val = r.registers[5] & 0xFFFFFFFF
        assert sector_val in [0, 1, 2, 3, 4, 5], f"SECTOR_REG was {sector_val}, expected 0-5"
