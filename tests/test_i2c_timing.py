"""real-ELF I2C timing against UM10204 minima at 200 MHz."""
import os
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "sim"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import elf_cosim  # noqa: E402
from i2c_slave_model import I2cSlave  # noqa: E402


class AckingBus:
    """Pull-ups plus a slave that ACKs the address (a NACK now ends the frame early)."""

    def __init__(self, read):
        self.slave = I2cSlave(ack=True, read=bool(read))

    def tick(self, cycle, pins):
        return self.slave.gpi(cycle, pins)


# UM10204 Table 10, nanoseconds, for Standard / Fast / Fast-mode Plus.
MINIMUM_NS = {
    100: dict(low=4700, high=4000, su_sta=4700, hd_sta=4000, su_sto=4000, su_dat=250),
    400: dict(low=1300, high=600, su_sta=600, hd_sta=600, su_sto=600, su_dat=100),
    1000: dict(low=500, high=260, su_sta=260, hd_sta=260, su_sto=260, su_dat=50),
}


def transitions(trace, pin):
    mask = 1 << pin
    out, previous = [], bool(trace[0][1] & mask)
    for cycle, gpo, _ in trace[1:]:
        level = bool(gpo & mask)
        if level != previous:
            out.append((cycle, level))
            previous = level
    return out


def half_trips_from_block(rate_khz):
    """Evaluate the block's exported constant3 accessor (the codegen oracle)."""
    source = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "i2c_block.syscfg.js"
    script = r'''const fs=require("fs"),vm=require("vm");const p=JSON.parse(process.argv[1]);
const sb={Math,parseInt,isNaN,exports:{},system:{getScript:()=>({getSelfSysCfgCoreName:()=>"pru0"})}};
vm.createContext(sb);vm.runInContext(fs.readFileSync(process.argv[2],"utf8"),sb);
console.log(sb.exports.config.find(c=>c.name==="constant3").getValue(p));'''
    value = subprocess.check_output(["node", "-e", script,
                                     json.dumps({"clkHz": 200_000_000, "bitRateKhz": str(rate_khz)}),
                                     str(source)], text=True)
    return int(value.strip())


def assert_i2c_minima(trace, rate_khz, half_trips, is_read):
    """Check one START + 0xA0 address-write + ACK + STOP waveform."""
    minimum = {name: ns // 5 for name, ns in MINIMUM_NS[rate_khz].items()}
    scl, sda = transitions(trace, 0), transitions(trace, 1)
    scl_falls = [cycle for cycle, level in scl if not level]
    scl_rises = [cycle for cycle, level in scl if level]
    sda_falls = [cycle for cycle, level in sda if not level]
    sda_rises = [cycle for cycle, level in sda if level]
    assert len(scl_rises) >= 10 and len(scl_falls) >= 10, (scl, sda)

    # The first SDA fall is START; SCL must already have been high long enough,
    # and START must remain asserted before SCL falls.
    start = sda_falls[0]
    initial_scl_rise = scl_rises[0]
    first_scl_fall = scl_falls[0]
    assert start - initial_scl_rise >= minimum["su_sta"], (
        f"tSU;STA {start - initial_scl_rise} cycles < {minimum['su_sta']}")
    # tHD;STA (sh) and tSU;STO (sp) have 100+ cycles of slack and are guarded by the UM10204 minima only.
    assert first_scl_fall - start >= minimum["hd_sta"], (
        f"tHD;STA {first_scl_fall - start} cycles < {minimum['hd_sta']}")

    lows = [rise - fall for fall, rise in zip(scl_falls, scl_rises[1:])]
    highs = [fall - rise for rise, fall in zip(scl_rises[1:], scl_falls[1:])]
    for measured in lows:
        assert measured >= 2 * half_trips + 2, (
            f"delay phase {measured} cycles is shorter than the encoded loop budget "
            f"{2 * half_trips + 2}; this catches a two-cycle shortening")
    for measured in highs:
        assert measured >= 2 * half_trips + 2, (
            f"delay phase {measured} cycles is shorter than the encoded loop budget "
            f"{2 * half_trips + 2}; this catches a two-cycle shortening")
    for fall, rise in zip(scl_falls, scl_rises[1:]):
        assert rise - fall >= minimum["low"], f"tLOW {rise - fall} cycles < {minimum['low']}"
    for rise, fall in zip(scl_rises[1:], scl_falls[1:]):
        assert fall - rise >= minimum["high"], f"tHIGH {fall - rise} cycles < {minimum['high']}"

    # Every data transition for the address byte precedes its next sampling rise.
    address_rises = scl_rises[1:9]
    bits = []
    for rise in address_rises:
        prior_changes = [cycle for cycle, _ in sda if cycle < rise]
        assert prior_changes and rise - prior_changes[-1] >= minimum["su_dat"], (
            f"tSU;DAT {rise - prior_changes[-1] if prior_changes else 0} cycles < {minimum['su_dat']}")
        bits.append(int(next(level for cycle, level in reversed(sda) if cycle <= rise)))
    assert bits == [1, 0, 1, 0, 0, 0, 0, 0], bits

    # STOP is SDA rising while SCL high, after the required SCL-high setup.
    # The first frame's STOP; a repeat is appended specifically to observe tBUF.
    stop = next(cycle for cycle in sda_rises if cycle > scl_rises[9])
    preceding_scl_rise = max(cycle for cycle in scl_rises if cycle < stop)
    assert stop - preceding_scl_rise >= minimum["su_sto"], (
        f"tSU;STO {stop - preceding_scl_rise} cycles < {minimum['su_sto']}")

    # A second frame starts only after STOP's bus-free period. The loop budget
    # is intentionally above tBUF; at 400 kHz this is the tightest 260-cycle case.
    if len(sda_falls) > 1:
        next_start = next(cycle for cycle in sda_falls if cycle > stop)
        assert next_start - stop >= minimum["low"], (
            f"tBUF {next_start - stop} cycles < {minimum['low']}")


@pytest.mark.parametrize("rate_khz", [100, 400, 1000])
@pytest.mark.parametrize("is_read", [0, 1])
def test_i2c_addr_frame_meets_um10204_minima(rate_khz, is_read):
    half_trips = half_trips_from_block(rate_khz)
    spec = dict(
        block="i2c_block", subdir="pru_io_blocks", macroCall="m_i2c_run",
        macroArgs=dict(RES="R0", SCL_BIT="0", SDA_BIT="1",
                       HALF_TRIPS=str(half_trips), ADDR_BYTE="0xA0",
                       IS_READ=str(is_read), DATA_REG="R7", NACK_REG="R8"),
        macroRepeats=2,
        postlude=["halt"])
    # build_out is an existing writable generated-artifact directory; avoid
    # pytest's inherited temp root, which can be read-only in some checkouts.
    elf, _ = elf_cosim.build_block_firmware(spec, f"i2c_{rate_khz}_{is_read}", str(ROOT / "build_out"))
    result = elf_cosim.run_elf_closed_loop(elf, AckingBus(is_read), max_steps=100_000)
    assert result.halted
    assert_i2c_minima(result.trace, rate_khz, half_trips, is_read)


def no_of_cycles_from_block(rate_khz, rw):
    """Evaluate the block's exported noOfCycles accessor."""
    source = ROOT / ".metadata" / "sysconfig" / ".meta" / "pru_blocks" / "pru_io_blocks" / "i2c_block.syscfg.js"
    script = r'''const fs=require("fs"),vm=require("vm");const p=JSON.parse(process.argv[1]);
const sb={Math,parseInt,isNaN,exports:{},system:{getScript:()=>({getSelfSysCfgCoreName:()=>"pru0"})}};
vm.createContext(sb);vm.runInContext(fs.readFileSync(process.argv[2],"utf8"),sb);
console.log(sb.exports.config.find(c=>c.name==="noOfCycles").getValue(p));'''
    value = subprocess.check_output(["node", "-e", script,
                                     json.dumps({"clkHz": 200_000_000, "bitRateKhz": str(rate_khz), "rw": rw}),
                                     str(source)], text=True)
    return int(value.strip())


@pytest.mark.parametrize("rate_khz", [100, 400, 1000])
@pytest.mark.parametrize("rw,is_read", [("write", 0), ("read", 1)])
def test_i2c_no_of_cycles_within_tolerance_of_measured_frame(rate_khz, rw, is_read):
    half_trips = half_trips_from_block(rate_khz)
    spec = dict(
        block="i2c_block", subdir="pru_io_blocks", macroCall="m_i2c_run",
        macroArgs=dict(RES="R0", SCL_BIT="0", SDA_BIT="1",
                       HALF_TRIPS=str(half_trips), ADDR_BYTE="0xA0",
                       IS_READ=str(is_read), DATA_REG="R7", NACK_REG="R8"),
        postlude=["halt"])
    elf, _ = elf_cosim.build_block_firmware(spec, f"fc_{rate_khz}_{is_read}", str(ROOT / "build_out"))
    result = elf_cosim.run_elf_closed_loop(elf, AckingBus(is_read), max_steps=200_000)
    assert result.halted
    measured_cycles = result.trace[-1][0]
    expected_cycles = no_of_cycles_from_block(rate_khz, rw)

    # Stated tolerance: noOfCycles models the nominal bit intervals (11 for write, 20 for read).
    # It acts as a lower bound within 15% of the real measured frame cycles (measured under-reports
    # by ~1-12% due to loop margin trips and PRU instruction overhead).
    tolerance = 0.15
    assert expected_cycles <= measured_cycles, (
        f"noOfCycles {expected_cycles} exceeds measured {measured_cycles} for {rate_khz} kHz {rw}")
    assert (measured_cycles - expected_cycles) / measured_cycles <= tolerance, (
        f"noOfCycles {expected_cycles} is a lower bound by "
        f"{(measured_cycles - expected_cycles) / measured_cycles:.1%}, exceeding tolerance {tolerance:.0%}")

