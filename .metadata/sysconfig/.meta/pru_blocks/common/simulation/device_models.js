/**
 * device_models.js - device models attachable to Simulation Settings pins.
 *
 * JavaScript ports of the DeviceModel implementations in the TI pru-simulator
 * checkout (pru_io/quadrature_encoder.py, pru_io/ssi_encoder.py; built under
 * and). The ports are line-by-line faithful in behaviour, and
 * scripts/sim/test_device_model_crosscheck.js drives the JS and Python models
 * with the same stimulus and diffs drives, events and faults, so a drift
 * between the two is a red test rather than an assumption. If you change
 * behaviour here, change the Python model too, in the same commit series.
 *
 * WHY THESE TWO FIRST
 * The SysConfig dropdown (pru_blocks_static_module.syscfg.js) lists every
 * kind the Python DeviceModel contract covers. Only the two ported here are
 * selectable in the in-tool (JavaScript) simulator today; the factory refuses
 * the rest VISIBLY instead of substituting something unproven. A device mode
 * that quietly runs the wrong model is exactly the "polished seam over an
 * unproven oracle" failure this item was sequenced to avoid.
 *
 * FAULTS ARE THE POINT
 * A device model that can only produce plausible waveforms is decoration. Its
 * value is faults(): what it saw that the protocol forbids. Every model here
 * ships a test that drives it with deliberately broken firmware and requires
 * a fault (scripts/sim/test_device_models.js).
 */

const deviceBus = system.getScript("/pru_blocks/common/simulation/device_bus.js");
const PUSH_PULL = deviceBus.PUSH_PULL;
const OPEN_DRAIN = deviceBus.OPEN_DRAIN;

// ---------------------------------------------------------------------------
// Quadrature encoder (port of pru_io/quadrature_encoder.py)
// ---------------------------------------------------------------------------
//
// A rotating incremental encoder on three push-pull outputs: A, B and
// (optionally) Z/index. A and B are the standard 2-bit Gray code, so exactly
// one of them changes per count. Z pulses high for one count at the zero
// position, once per revolution.
//
// An encoder is a signal SOURCE: no protocol comes back at it, so it cannot
// observe the firmware doing anything illegal. What it checks is its own
// output - if a corrupt position ever makes A and B change together, that is
// impossible on real hardware and is a fault, not a waveform.
//
// What the self-check CANNOT catch (same caveat as the Python original):
// firmware that samples slower than the shaft turns loses counts. Skipping 2
// states flips both bits at once and is caught; skipping 3 states is
// indistinguishable from turning one state BACKWARDS and is not. Do not let
// any decoder built against this model claim it detects lost counts from A/B
// alone.

// Gray-coded (A, B) by position within the 4-state cycle.
const QUAD_PHASES = [[0, 0], [1, 0], [1, 1], [0, 1]];

class QuadratureEncoder {
    constructor(opts) {
        opts = opts || {};
        const aPin = opts.aPin !== undefined ? opts.aPin : 0;
        const bPin = opts.bPin !== undefined ? opts.bPin : 1;
        const zPin = opts.zPin !== undefined ? opts.zPin : 2;
        const countsPerRev = opts.countsPerRev !== undefined ? opts.countsPerRev : 1024;
        const cyclesPerCount = opts.cyclesPerCount !== undefined ? opts.cyclesPerCount : 50;
        const forward = opts.forward !== undefined ? !!opts.forward : true;

        if (!Number.isInteger(cyclesPerCount) || cyclesPerCount < 1) {
            throw new Error("cycles_per_count must be >= 1 - a count cannot take less than one core cycle");
        }
        if (!Number.isInteger(countsPerRev) || countsPerRev < 1) {
            throw new Error("counts_per_rev must be >= 1");
        }

        this.name = opts.name || "quadrature";
        this.timeDriven = true;
        this.aPin = aPin;
        this.bPin = bPin;
        this.zPin = zPin;
        this.countsPerRev = countsPerRev;
        this.cyclesPerCount = cyclesPerCount;
        this.forward = forward;

        this.nets = {};
        this.nets[aPin] = PUSH_PULL;
        this.nets[bPin] = PUSH_PULL;
        if (zPin !== null && zPin !== undefined && zPin !== -1) {
            this.nets[zPin] = PUSH_PULL;
        } else {
            this.zPin = null;
        }

        this.position = 0;
        this._lastAdvance = 0;
        this._events = [];
        this._faults = [];
        this._started = false;
    }

    _indexLevel() {
        return ((this.position % this.countsPerRev) + this.countsPerRev) % this.countsPerRev === 0 ? 1 : 0;
    }

    _stepOne(cycle) {
        const phaseIndex = ((p) => ((p % 4) + 4) % 4);
        const prev = QUAD_PHASES[phaseIndex(this.position)];
        this.position += this.forward ? 1 : -1;
        const now = QUAD_PHASES[phaseIndex(this.position)];

        const changed = (prev[0] !== now[0] ? 1 : 0) + (prev[1] !== now[1] ? 1 : 0);
        if (changed !== 1) {
            this._faults.push(
                `cycle ${cycle}: A and B changed together (${prev} -> ${now}) - not a valid quadrature transition`);
        }

        if (((this.position % this.countsPerRev) + this.countsPerRev) % this.countsPerRev === 0) {
            this._events.push({ cycle: cycle, kind: "index", position: this.position });
        }
    }

    tick(cycle, bus) {
        if (!this._started) {
            this._lastAdvance = cycle;
            this._started = true;
        }

        // Advance by however many counts have elapsed - a loop, not a single
        // step: if we are ticked less often than once per count, skipping the
        // intermediate states would silently fabricate a legal waveform for an
        // illegal rate. Stepping through them makes the A/B jump visible to
        // the self-check above.
        while (cycle - this._lastAdvance >= this.cyclesPerCount) {
            this._lastAdvance += this.cyclesPerCount;
            this._stepOne(cycle);
        }

        const phase = QUAD_PHASES[((this.position % 4) + 4) % 4];
        let mask = (1 << this.aPin) | (1 << this.bPin);
        let values = (phase[0] << this.aPin) | (phase[1] << this.bPin);
        if (this.zPin !== null) {
            mask |= 1 << this.zPin;
            values |= this._indexLevel() << this.zPin;
        }
        return [mask, values];
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() {
        this.position = 0;
        this._lastAdvance = 0;
        this._started = false;
        this._events = [];
        this._faults = [];
    }

    getState() {
        const phase = QUAD_PHASES[((this.position % 4) + 4) % 4];
        return {
            name: this.name,
            position: this.position,
            revolutions: Math.floor(this.position / this.countsPerRev),
            a: phase[0], b: phase[1], z: this._indexLevel(),
            faults: this._faults.length
        };
    }
}

// ---------------------------------------------------------------------------
// SSI absolute encoder (port of pru_io/ssi_encoder.py)
// ---------------------------------------------------------------------------
//
// Idle is CLK high, DATA high. The master pulls CLK low; on that first
// falling edge the slave latches its current position and puts the MSB on
// DATA. Each subsequent falling edge shifts the next bit out; the master
// samples on the rising edges. After the n data bits, one further falling
// edge drives DATA low, and it stays low for the monoflop time - that low is
// how the master knows the word has ended.
//
// WHAT IT REJECTS (the reason it is an oracle and not a waveform generator):
//   * clocks faster than min_clk_period_cycles - a real encoder has an f_max
//     and silently returns garbage above it, the worst possible failure;
//   * stalls mid-word longer than the monoflop time - on hardware the
//     transfer aborts and the next edge reads as a fresh frame, so stalling
//     firmware gets a plausible but WRONG position rather than an error;
//   * keeps clocking past the end of the word.
//
// WHAT IT CANNOT CHECK: where the master sampled. The slave sees only CLK;
// where the master latched DATA is invisible to it. The cross-check decoder
// samples on rising edges and shares nothing with this model.

function toGray(value) {
    return value ^ (value >> 1);
}

function fromGray(value, bits) {
    let out = 0;
    for (let shift = bits - 1; shift >= 0; shift--) {
        out |= (((value >> shift) & 1) ^ ((out >> (shift + 1)) & 1)) << shift;
    }
    return out >>> 0;
}

class SsiEncoder {
    constructor(opts) {
        opts = opts || {};
        const clkPin = opts.clkPin !== undefined ? opts.clkPin : 0;
        const dataPin = opts.dataPin !== undefined ? opts.dataPin : 1;
        const bits = opts.bits !== undefined ? opts.bits : 13;
        const position = opts.position !== undefined ? opts.position : 0;
        const cyclesPerCount = opts.cyclesPerCount !== undefined ? opts.cyclesPerCount : null;
        const minClkPeriodCycles = opts.minClkPeriodCycles !== undefined ? opts.minClkPeriodCycles : 20;
        const monoflopCycles = opts.monoflopCycles !== undefined ? opts.monoflopCycles : 400;
        const gray = opts.gray !== undefined ? !!opts.gray : true;

        if (!Number.isInteger(bits) || bits < 1) {
            throw new Error("bits must be >= 1");
        }
        if (!Number.isInteger(minClkPeriodCycles) || minClkPeriodCycles < 1) {
            throw new Error("min_clk_period_cycles must be >= 1");
        }
        if (!Number.isInteger(monoflopCycles) || monoflopCycles < 1) {
            throw new Error("monoflop_cycles must be >= 1");
        }
        if (cyclesPerCount !== null && (!Number.isInteger(cyclesPerCount) || cyclesPerCount < 1)) {
            throw new Error("cycles_per_count must be >= 1 or null (stationary)");
        }

        this.name = opts.name || "ssi";
        this.timeDriven = true;
        this.clkPin = clkPin;
        this.dataPin = dataPin;
        this.bits = bits;
        this.position = position;
        this.cyclesPerCount = cyclesPerCount;
        this.minClkPeriodCycles = minClkPeriodCycles;
        this.monoflopCycles = monoflopCycles;
        this.gray = gray;

        // Only DATA is driven. CLK is deliberately absent from nets: the
        // device observes it and must never contend with the master on it.
        this.nets = {};
        this.nets[dataPin] = PUSH_PULL;

        this._resetState();
    }

    _resetState() {
        this._prevClk = 1;          // idle high
        this._bitIndex = 0;         // 0 = idle, 1..bits = data, bits+1 = trailing low
        this._latched = 0;
        this._data = 1;
        this._lastFall = null;
        this._advanceBase = null;
        this._events = [];
        this._faults = [];
    }

    _advancePosition(cycle) {
        if (this.cyclesPerCount === null) return;
        if (this._advanceBase === null) this._advanceBase = cycle;
        while (cycle - this._advanceBase >= this.cyclesPerCount) {
            this._advanceBase += this.cyclesPerCount;
            this.position += 1;
        }
    }

    _fallingEdge(cycle) {
        if (this._lastFall !== null && this._bitIndex) {
            const period = cycle - this._lastFall;
            if (period < this.minClkPeriodCycles) {
                this._faults.push(
                    `cycle ${cycle}: clock period ${period} cycles is below the encoder's ` +
                    `minimum of ${this.minClkPeriodCycles} - a real encoder returns garbage ` +
                    `here rather than an error`);
            }
        }
        this._lastFall = cycle;

        if (this._bitIndex === 0) {
            // First edge of a frame: latch the position NOW. Everything after
            // this reads the snapshot, so the shaft turning mid-word cannot
            // tear the value - the whole point of a latched protocol.
            const raw = this.position & ((1 << this.bits) - 1);
            this._latched = (this.gray ? toGray(raw) : raw) >>> 0;
            this._bitIndex = 1;
            this._data = (this._latched >> (this.bits - 1)) & 1;
        } else if (this._bitIndex < this.bits) {
            this._bitIndex += 1;
            this._data = (this._latched >> (this.bits - this._bitIndex)) & 1;
        } else if (this._bitIndex === this.bits) {
            this._bitIndex = this.bits + 1;
            this._data = 0;           // trailing low for the monoflop
            this._events.push({ cycle: cycle, kind: "frame",
                                position: this.position, sent: this._latched, bits: this.bits });
        } else {
            this._faults.push(
                `cycle ${cycle}: clock continued past the end of the ${this.bits}-bit word ` +
                `while DATA was still in its monoflop low`);
        }
    }

    _abort(cycle) {
        this._bitIndex = 0;
        this._data = 1;
        this._lastFall = null;
        this._events.push({ cycle: cycle, kind: "abort" });
    }

    tick(cycle, bus) {
        this._advancePosition(cycle);

        const clk = (bus >> this.clkPin) & 1;

        if (clk === 0 && this._prevClk === 1) {
            this._fallingEdge(cycle);
        } else if (this._bitIndex && this._lastFall !== null) {
            // Mid-word stall. Checked only while a transfer is in flight; an
            // idle bus between frames is not a stall, it is idle.
            if (cycle - this._lastFall > this.monoflopCycles) {
                this._faults.push(
                    `cycle ${cycle}: transfer stalled ${cycle - this._lastFall} cycles after ` +
                    `bit ${this._bitIndex} of ${this.bits} (monoflop is ${this.monoflopCycles}) ` +
                    `- on hardware this aborts the word and the next edge reads as a new frame`);
                this._abort(cycle);
            }
        }

        this._prevClk = clk;

        if (this._bitIndex === this.bits + 1 && this._lastFall !== null &&
                cycle - this._lastFall >= this.monoflopCycles) {
            // Monoflop expired: release DATA high, ready for the next frame.
            this._bitIndex = 0;
            this._data = 1;
        }

        return [1 << this.dataPin, this._data << this.dataPin];
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() { this._resetState(); }

    getState() {
        return { name: this.name, position: this.position,
                 bit: this._bitIndex, faults: this._faults.length };
    }
}

// ---------------------------------------------------------------------------
// Hall sensor (port of perif/hall_sensor.py)
// ---------------------------------------------------------------------------
//
// Three push-pull Hall outputs (A,B,C) = 6 60-degree sectors. Code
// (A<<2|B<<1|C) lawful 001,011,010,110,100,101 -> sectors 0..5; 000/111 illegal.
// The model drives the six legal codes while rotating and can inject 000/111.
// An illegal code emits an "illegal" event and a fault; a watchdog fault
// fires when firmware fails to react (assert fault_ack_pin) within the window.

const HALL_CODES = [1, 3, 2, 6, 4, 5];
const HALL_LUT = {1:0, 3:1, 2:2, 6:3, 4:4, 5:5};

class HallSensor {
    constructor(opts) {
        opts = opts || {};
        const aPin = opts.aPin !== undefined ? opts.aPin : 0;
        const bPin = opts.bPin !== undefined ? opts.bPin : 1;
        const cPin = opts.cPin !== undefined ? opts.cPin : 2;
        const cyclesPerSector = opts.cyclesPerSector !== undefined ? opts.cyclesPerSector : 60;
        const direction = opts.direction !== undefined ? opts.direction : 1;
        const faultAckPin = opts.faultAckPin !== undefined ? opts.faultAckPin : null;
        const responseWindow = opts.responseWindowCycles !== undefined ? opts.responseWindowCycles : 32;

        if (!Number.isInteger(cyclesPerSector) || cyclesPerSector < 4) {
            throw new Error("cycles_per_sector must be >= 4");
        }
        if (direction !== 1 && direction !== -1) throw new Error("direction must be +1 or -1");

        this.name = opts.name || "hall";
        this.timeDriven = true;
        this.aPin = aPin; this.bPin = bPin; this.cPin = cPin;
        this.cyclesPerSector = cyclesPerSector;
        this.direction = direction;
        this.faultAckPin = faultAckPin;
        this.responseWindow = responseWindow;

        this.nets = {};
        this.nets[aPin] = PUSH_PULL;
        this.nets[bPin] = PUSH_PULL;
        this.nets[cPin] = PUSH_PULL;

        this._sectorIdx = 0;
        this._code = HALL_CODES[0];
        this._cyclesToNext = cyclesPerSector;
        this.position = 0;

        this._illegalCode = null;
        this._illegalUntil = -1;
        this._illegalStart = null;
        this._watchdogDeadline = null;
        this._ackSeen = false;

        this._events = [];
        this._faults = [];
        this._started = false;
        this._lastAdvance = 0;
    }

    scheduleIllegal(startCycle, code, duration) {
        if (code !== 0 && code !== 7) throw new Error("illegal code must be 0 or 7");
        this._illegalCode = code;
        this._illegalStart = startCycle;
        this._illegalUntil = startCycle + duration;
        this._watchdogDeadline = startCycle + this.responseWindow;
        this._ackSeen = false;
    }

    injectIllegal(code, duration) {
        if (code !== 0 && code !== 7) throw new Error("illegal code must be 0 or 7");
        // schedule on next tick
        this._pendingIllegal = {code, duration};
    }

    tick(cycle, bus) {
        if (!this._started) { this._lastAdvance = cycle; this._started = true; }
        if (this._pendingIllegal && this._illegalStart === null) {
            this._illegalCode = this._pendingIllegal.code;
            this._illegalStart = cycle;
            this._illegalUntil = cycle + this._pendingIllegal.duration;
            this._watchdogDeadline = cycle + this.responseWindow;
            this._ackSeen = false;
            delete this._pendingIllegal;
        }
        if (this._watchdogDeadline !== null) {
            if (this.faultAckPin !== null && this.faultAckPin !== -1) {
                const ack = (bus >> this.faultAckPin) & 1;
                if (ack === 1) this._ackSeen = true;
            }
            if (cycle >= this._watchdogDeadline && !this._ackSeen) {
                this._faults.push(`cycle ${cycle}: firmware failed to react to illegal Hall code ${this._illegalCode} within ${this.responseWindow} cycles`);
                this._watchdogDeadline = null;
            } else if (this._ackSeen) {
                this._watchdogDeadline = null;
            }
        }
        let code;
        if (this._illegalCode !== null && this._illegalStart !== null && cycle < this._illegalUntil) {
            code = this._illegalCode;
            if (cycle === this._illegalStart) {
                this._events.push({cycle, kind:"illegal", code});
                this._faults.push(`cycle ${cycle}: illegal Hall code ${code.toString(2).padStart(3,"0")} (000/111)`);
            }
        } else {
            if (this._illegalCode !== null && cycle >= this._illegalUntil) {
                this._illegalCode = null; this._illegalStart = null; this._illegalUntil = -1;
            }
            // advance
            while (cycle - this._lastAdvance >= this.cyclesPerSector) {
                this._lastAdvance += this.cyclesPerSector;
                if (this.direction === 1) this._sectorIdx = (this._sectorIdx + 1) % 6;
                else this._sectorIdx = (this._sectorIdx - 1 + 6) % 6;
                this._code = HALL_CODES[this._sectorIdx];
                this.position += this.direction;
                const sector = HALL_LUT[this._code];
                this._events.push({cycle, kind:"edge", code:this._code, sector, dir:this.direction});
            }
            code = this._code;
        }
        const a = (code >> 2) & 1, b = (code >> 1) & 1, c = code & 1;
        const mask = (1<<this.aPin)|(1<<this.bPin)|(1<<this.cPin);
        const values = (a<<this.aPin)|(b<<this.bPin)|(c<<this.cPin);
        return [mask, values];
    }
    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }
    reset() {
        this._sectorIdx=0; this._code=HALL_CODES[0]; this._cyclesToNext=this.cyclesPerSector;
        this.position=0; this._lastAdvance=0; this._started=false;
        this._events=[]; this._faults=[];
        this._illegalCode=null; this._illegalStart=null; this._illegalUntil=-1; this._watchdogDeadline=null;
    }
    getState() { return {name:this.name, position:this.position, code:this._code, faults:this._faults.length}; }
}

// Dual-channel OSSD emitter (port of perif/ossd_emitter.py)
// ---------------------------------------------------------------------------
//
// Two normally-high safety channels (A, B). The firmware only reads; the
// model drives. Schedule API mirrors the Python class so JS and Python
// traces can be cross-checked. Classification oracle is perif/buscosim.py
// decode_ossd and must agree with events().

class DualOssdEmitter {
    constructor(opts) {
        opts = opts || {};
        const chAPin = opts.chAPin !== undefined ? opts.chAPin : 0;
        const chBPin = opts.chBPin !== undefined ? opts.chBPin : 1;
        const ossdMin = opts.ossdMinCycles !== undefined ? opts.ossdMinCycles : 20;
        const ossdMax = opts.ossdMaxCycles !== undefined ? opts.ossdMaxCycles : 400;
        const disc = opts.discrepancyCycles !== undefined ? opts.discrepancyCycles : 500;

        if (!Number.isInteger(chAPin) || !Number.isInteger(chBPin)) {
            throw new Error("ch_a_pin and ch_b_pin must be integers");
        }
        if (chAPin === chBPin) {
            throw new Error("ch_a_pin and ch_b_pin must differ");
        }
        if (ossdMin < 1 || ossdMax < 1) {
            throw new Error("ossd pulse bounds must be >= 1");
        }
        if (ossdMin > ossdMax) {
            throw new Error("ossdMin must be <= ossdMax");
        }

        this.name = opts.name || "ossd";
        this.timeDriven = true;
        this.chAPin = chAPin;
        this.chBPin = chBPin;
        this.ossdMinCycles = ossdMin;
        this.ossdMaxCycles = ossdMax;
        this.discrepancyCycles = disc;

        this.nets = {};
        this.nets[chAPin] = PUSH_PULL;
        this.nets[chBPin] = PUSH_PULL;

        this._schedule = []; // [start, end, kind, ch]
        this._events = [];
        this._faults = [];
        this._prevA = 1;
        this._prevB = 1;
        this._lowSinceA = null;
        this._lowSinceB = null;
    }

    scheduleOssdPulse(channel, start, width) {
        if (channel !== "A" && channel !== "B") throw new Error("channel must be A or B");
        const ch = channel === "A" ? 0 : 1;
        this._schedule.push([start, start + width, "ossd", ch]);
        this._schedule.sort((a,b)=>a[0]-b[0]);
    }
    scheduleTrip(start, duration) {
        this._schedule.push([start, start + duration, "trip", null]);
        this._schedule.sort((a,b)=>a[0]-b[0]);
    }
    scheduleSingleLow(channel, start, duration) {
        if (channel !== "A" && channel !== "B") throw new Error("channel must be A or B");
        const ch = channel === "A" ? 0 : 1;
        this._schedule.push([start, start + duration, "single_low", ch]);
        this._schedule.sort((a,b)=>a[0]-b[0]);
    }
    clearSchedule() {
        this._schedule = [];
        this._events = [];
        this._prevA = 1; this._prevB = 1;
        this._lowSinceA = null; this._lowSinceB = null;
    }

    _levelAt(cycle, ch) {
        for (const [s,e,kind,c] of this._schedule) {
            if (s <= cycle && cycle < e) {
                if (kind === "trip") return 0;
                if (kind === "ossd" && c === ch) return 0;
                if (kind === "single_low" && c === ch) return 0;
            }
        }
        return 1;
    }

    tick(cycle, bus) {
        const a = this._levelAt(cycle, 0);
        const b = this._levelAt(cycle, 1);

        if (this._prevA === 0 && a === 1 && this._lowSinceA !== null) {
            const w = cycle - this._lowSinceA;
            const kind = w <= this.ossdMaxCycles ? "ossd_pulse" : "trip";
            if (w < this.ossdMinCycles) this._faults.push(`cycle ${cycle}: CH_A pulse ${w} < ossd_min`);
            this._events.push({ cycle, kind, channel: "A", width: w });
            this._lowSinceA = null;
        }
        if (this._prevB === 0 && b === 1 && this._lowSinceB !== null) {
            const w = cycle - this._lowSinceB;
            const kind = w <= this.ossdMaxCycles ? "ossd_pulse" : "trip";
            if (w < this.ossdMinCycles) this._faults.push(`cycle ${cycle}: CH_B pulse ${w} < ossd_min`);
            this._events.push({ cycle, kind, channel: "B", width: w });
            this._lowSinceB = null;
        }
        if (this._prevA === 1 && a === 0) this._lowSinceA = cycle;
        if (this._prevB === 1 && b === 0) this._lowSinceB = cycle;

        this._prevA = a; this._prevB = b;

        let mask = (1 << this.chAPin) | (1 << this.chBPin);
        let values = (a << this.chAPin) | (b << this.chBPin);
        return [mask, values];
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }
    reset() {
        this._events = []; this._faults = [];
        this._prevA = 1; this._prevB = 1;
        this._lowSinceA = null; this._lowSinceB = null;
        this._schedule = [];
    }
    getState() {
        return { name: this.name, a: this._prevA, b: this._prevB, faults: this._faults.length };
    }
}

// ---------------------------------------------------------------------------
// Factory and catalog
// ---------------------------------------------------------------------------

/**
 * Kinds the SysConfig dropdown advertises (must match the options in
 * pru_blocks_static_module.syscfg.js). `ported: true` means the in-tool
 * JavaScript simulator can actually run it; the rest are refused visibly by
 * createDeviceModel below.
 */

const IDLE = 1;

class UartTransmitter {
    constructor(opts) {
        opts = opts || {};
        const pin = opts.pin !== undefined ? opts.pin : 0;
        const payload = opts.payload || [];
        const bitPeriod = opts.bitPeriod !== undefined ? opts.bitPeriod : 50;
        const startCycle = opts.startCycle !== undefined ? opts.startCycle : 0;
        const idleGapBits = opts.idleGapBits !== undefined ? opts.idleGapBits : 2;
        const frames = opts.frames !== undefined ? opts.frames : 1;

        if (bitPeriod < 1) throw new Error("bit_period must be >= 1 cycle");
        if (frames < 1) throw new Error("frames must be >= 1");
        for (const byte of payload) {
            if (byte < 0 || byte > 255) throw new Error(`payload byte ${byte} is not 8-bit`);
        }

        this.name = opts.name || "uart_tx";
        this.timeDriven = true;
        this.pin = pin;
        this.payload = payload.slice();
        this.bitPeriod = bitPeriod;
        this.startCycle = startCycle;
        this.idleGapBits = idleGapBits;
        this.frames = frames;

        this.nets = {};
        this.nets[pin] = PUSH_PULL;

        this._events = [];
        this._build();
    }

    _build() {
        this._timeline = [];
        this._stopIndices = [];
        let cycle = this.startCycle;

        for (let frame = 0; frame < this.frames; frame++) {
            for (const byte of this.payload) {
                this._timeline.push([cycle, 0]);
                cycle += this.bitPeriod;
                for (let bit = 0; bit < 8; bit++) {
                    this._timeline.push([cycle, (byte >> bit) & 1]);
                    cycle += this.bitPeriod;
                }
                this._timeline.push([cycle, 1]);
                this._stopIndices.push(this._timeline.length - 1);
                this._events.push({ cycle: cycle, kind: "byte_sent", value: byte });
                cycle += this.bitPeriod;
            }
            if (frame < this.frames - 1) {
                this._timeline.push([cycle, IDLE]);
                cycle += this.bitPeriod * this.idleGapBits;
            }
        }
        this._endCycle = cycle;
    }

    corruptStopBit(byteIndex) {
        if (byteIndex < 0 || byteIndex >= this._stopIndices.length) {
            throw new Error(`byte_index ${byteIndex} out of range (0-${this._stopIndices.length - 1})`);
        }
        const idx = this._stopIndices[byteIndex];
        this._timeline[idx] = [this._timeline[idx][0], 0];
    }

    levelAt(cycle) {
        if (cycle < this.startCycle || cycle >= this._endCycle) return IDLE;
        let level = IDLE;
        for (const [at, value] of this._timeline) {
            if (at > cycle) break;
            level = value;
        }
        return level;
    }

    tick(cycle, bus) {
        return [1 << this.pin, this.levelAt(cycle) << this.pin];
    }

    events() { return this._events.slice(); }
    faults() { return []; }

    reset() {
        this._events = [];
        this._build();
    }

    getState() {
        return { name: this.name, bytes: this._stopIndices.length, end_cycle: this._endCycle };
    }
}

class UartMonitor {
    constructor(opts) {
        opts = opts || {};
        const pin = opts.pin !== undefined ? opts.pin : 0;
        const bitPeriod = opts.bitPeriod !== undefined ? opts.bitPeriod : 50;

        if (bitPeriod < 2) throw new Error("bit_period must be >= 2 cycles - mid-bit sampling needs a midpoint distinct from the edge");
        this.name = opts.name || "uart_monitor";
        this.timeDriven = true;
        this.pin = pin;
        this.bitPeriod = bitPeriod;
        this.nets = {};

        this._resetState();
    }

    _resetState() {
        this._prev = IDLE;
        this._frameStart = null;
        this._bits = [];
        this._nextSample = 0;
        this._lowSince = null;
        this._events = [];
        this._faults = [];
    }

    tick(cycle, bus) {
        const level = (bus >> this.pin) & 1;

        if (this._frameStart === null) {
            if (this._prev === IDLE && level === 0) {
                this._frameStart = cycle;
                this._bits = [];
                this._nextSample = cycle + Math.floor(this.bitPeriod / 2);
            }
        } else {
            if (cycle === this._nextSample) {
                if (this._bits.length === 0 && level !== 0) {
                    this._events.push({ cycle: cycle, kind: "glitch" });
                    this._frameStart = null;
                } else {
                    this._bits.push(level);
                    this._nextSample += this.bitPeriod;
                    if (this._bits.length === 10) {
                        this._complete(cycle);
                    }
                }
            }
        }

        this._trackBreak(cycle, level);
        this._prev = level;
        return [0, 0];
    }

    _complete(cycle) {
        const stop = this._bits[9];
        let value = 0;
        for (let i = 0; i < 8; i++) {
            value |= (this._bits[i + 1] << i);
        }

        if (stop !== 1) {
            let hex = value.toString(16).toUpperCase();
            if (hex.length === 1) hex = "0" + hex;
            this._faults.push(
                `cycle ${cycle}: framing error on 0x${hex} - stop bit ` +
                `sampled low. The transmitter's bit period disagrees with the ` +
                `receiver's ${this.bitPeriod} cycles, or the line was released late`
            );
        } else {
            this._events.push({ cycle: cycle, kind: "byte", value: value });
        }

        this._frameStart = null;
        this._bits = [];
    }

    _trackBreak(cycle, level) {
        if (level === 0) {
            if (this._lowSince === null) {
                this._lowSince = cycle;
            } else if (cycle - this._lowSince > 10 * this.bitPeriod) {
                this._faults.push(
                    `cycle ${cycle}: line held low for ` +
                    `${cycle - this._lowSince} cycles - longer than a whole ` +
                    `frame, so this is a break or a pin never released`
                );
                this._lowSince = cycle;
            }
        } else {
            this._lowSince = null;
        }
    }

    received() {
        return this._events.filter(e => e.kind === "byte").map(e => e.value);
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() {
        this._resetState();
    }

    getState() {
        return { name: this.name, bytes: this.received().length, faults: this._faults.length };
    }
}


class SigmaDeltaModulator {
    constructor(opts) {
        opts = opts || {};
        const clkPin = opts.clkPin !== undefined ? opts.clkPin : 0;
        const dataPin = opts.dataPin !== undefined ? opts.dataPin : 1;
        const minPeriod = opts.minPeriod !== undefined ? opts.minPeriod : 4;
        const saturationThreshold = opts.saturationThreshold !== undefined ? opts.saturationThreshold : 10.0;
        const saturationPersist = opts.saturationPersist !== undefined ? opts.saturationPersist : 16;
        const initialInput = opts.initialInput !== undefined ? opts.initialInput : 0.0;

        if (clkPin === dataPin) throw new Error("clk_pin and data_pin must differ");
        if (clkPin < 0 || clkPin >= 20 || dataPin < 0 || dataPin >= 20) throw new Error("pin indices must be in [0, 20)");
        if (minPeriod < 1) throw new Error("min_period must be >= 1");
        if (saturationThreshold <= 0) throw new Error("saturation_threshold must be > 0");
        if (saturationPersist < 1) throw new Error("saturation_persist must be >= 1");

        this.name = opts.name || "sigma_delta_modulator";
        this.timeDriven = false;
        this.clkPin = clkPin;
        this.dataPin = dataPin;
        this.minPeriod = minPeriod;
        this.saturationThreshold = saturationThreshold;
        this.saturationPersist = saturationPersist;

        this.nets = {};
        this.nets[dataPin] = PUSH_PULL;

        this._input = Number(initialInput);
        this.reset();
    }

    setInput(value) {
        this._input = Number(value);
    }

    onesDensity(window) {
        if (window <= 0) throw new Error("window must be > 0");
        if (this._bits.length === 0) return 0.0;
        const n = Math.min(window, this._bits.length);
        let sum = 0;
        for (let i = this._bits.length - n; i < this._bits.length; i++) {
            sum += this._bits[i];
        }
        return sum / n;
    }

    tick(cycle, bus) {
        const clk = (bus >> this.clkPin) & 1;

        if (!this._initialised) {
            this._prevClk = clk;
            this._initialised = true;
            return this._drive();
        }

        const rising = clk === 1 && this._prevClk === 0;
        this._prevClk = clk;

        if (rising) {
            if (this._lastRisingCycle !== null) {
                const period = cycle - this._lastRisingCycle;
                if (period < this.minPeriod) {
                    if (!this._periodFaultReported) {
                        this._faults.push(`clock period violation: ${period} cycles between rising edges at cycle ${this._lastRisingCycle} and ${cycle} < min_period ${this.minPeriod} (reported once; further fast edges suppressed until the clock returns to a legal period)`);
                        this._periodFaultReported = true;
                    }
                } else {
                    this._periodFaultReported = false;
                }
            }
            this._lastRisingCycle = cycle;

            let feedback = 0.0;
            if (this._hasLastBit) {
                feedback = this._lastBit === 1 ? 1.0 : -1.0;
            }

            if (!this._hasLastBit) {
                this._acc1 += this._input;
                this._acc2 += this._acc1;
            } else {
                this._acc1 += this._input - feedback;
                this._acc2 += this._acc1 - feedback;
            }

            const bit = this._acc2 >= 0.0 ? 1 : 0;
            this._lastBit = bit;
            this._hasLastBit = true;

            this._bits.push(bit);
            this._bitCycles.push(cycle);
            this._events.push({ cycle: cycle, kind: "bit", bit: bit, input: this._input });

            if (Math.abs(this._acc1) > this.saturationThreshold || Math.abs(this._acc2) > this.saturationThreshold) {
                this._saturationCounter += 1;
            } else {
                this._saturationCounter = 0;
                this._saturated = false;
                this._saturationFaultReported = false;
            }

            if (this._saturationCounter >= this.saturationPersist) {
                this._saturated = true;
                if (!this._saturationFaultReported) {
                    this._faults.push(`integrator saturation: |acc1|=${Math.abs(this._acc1).toFixed(2)} |acc2|=${Math.abs(this._acc2).toFixed(2)} exceeded ${this.saturationThreshold} for ${this._saturationCounter} consecutive rising edges (threshold ${this.saturationPersist}) at cycle ${cycle}`);
                    this._saturationFaultReported = true;
                }
            }
        }

        return this._drive();
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() {
        this._acc1 = 0.0;
        this._acc2 = 0.0;
        this._prevClk = 0;
        this._lastBit = 0;
        this._hasLastBit = false;
        this._lastRisingCycle = null;
        this._saturationCounter = 0;
        this._saturated = false;
        this._bits = [];
        this._bitCycles = [];
        this._events = [];
        this._faults = [];
        this._periodFaultReported = false;
        this._saturationFaultReported = false;
        this._initialised = false;
    }

    _drive() {
        const mask = 1 << this.dataPin;
        if (!this._hasLastBit) {
            return [mask, 0];
        }
        const values = (this._lastBit << this.dataPin) & mask;
        return [mask, values];
    }
}


class TCA9538Device {
    constructor(address = 0x23) {
        this.address = address & 0x7F;
        this.outputReg = 0xFF;
        this.polarityReg = 0x00;
        this.configReg = 0xFF;

        this.state = "IDLE";
        this.sawStart = false;
        this.lastTransaction = null;

        this._prevScl = true;
        this._prevSda = true;
        this._prevSdaMaster = true;
        this._shift = 0;
        this._bitCount = 0;
        this._regPtr = null;
        this._match = false;
    }

    step(scl, sdaMaster) {
        const slaveLow = this._slaveDrivesLow();
        const busSda = sdaMaster && !slaveLow;

        const prevScl = this._prevScl;
        const prevSdaMaster = this._prevSdaMaster;

        if (prevScl && scl && prevSdaMaster && !sdaMaster) {
            this._onStart();
        } else if (scl && (!prevSdaMaster) && sdaMaster) {
            this._onStop();
        } else if ((!prevScl) && scl) {
            this._onSclRising(busSda);
        }

        this._prevScl = scl;
        this._prevSda = busSda;
        this._prevSdaMaster = sdaMaster;
        return busSda;
    }

    _slaveDrivesLow() {
        if (this.state === "ACK_ADDR") return this._match;
        if (this.state === "ACK_REG" || this.state === "ACK_DATA") return true;
        return false;
    }

    _onStart() {
        this.sawStart = true;
        this.state = "ADDR";
        this._shift = 0;
        this._bitCount = 0;
        this._match = false;
    }

    _onStop() {
        this.state = "IDLE";
        this._shift = 0;
        this._bitCount = 0;
    }

    _onSclRising(busSda) {
        if (this.state === "ADDR" || this.state === "REGPTR" || this.state === "DATA") {
            this._shift = ((this._shift << 1) | (busSda ? 1 : 0)) & 0xFF;
            this._bitCount += 1;
            if (this._bitCount === 8) {
                this._bitCount = 0;
                this._completeByte();
            }
        } else if (this.state === "ACK_ADDR") {
            if (this._match) {
                this.state = "REGPTR";
            } else {
                this.lastTransaction = {
                    address: this._shift >> 1, reg: null,
                    data: null, ack: false
                };
                this.state = "IDLE";
            }
            this._shift = 0;
        } else if (this.state === "ACK_REG") {
            this.state = "DATA";
            this._shift = 0;
        } else if (this.state === "ACK_DATA") {
            this.state = "DONE";
        } else if (this.state === "DONE") {
            this.state = "IDLE";
        }
    }

    _completeByte() {
        if (this.state === "ADDR") {
            const addr = this._shift >> 1;
            const rwWrite = (this._shift & 1) === 0;
            this._match = (addr === this.address) && rwWrite;
            this.state = "ACK_ADDR";
        } else if (this.state === "REGPTR") {
            this._regPtr = this._shift;
            this.state = "ACK_REG";
        } else if (this.state === "DATA") {
            if (this._regPtr === 0x01) {
                this.outputReg = this._shift;
            } else if (this._regPtr === 0x02) {
                this.polarityReg = this._shift;
            } else if (this._regPtr === 0x03) {
                this.configReg = this._shift;
            }
            this.lastTransaction = {
                address: this.address, reg: this._regPtr,
                data: this._shift, ack: true
            };
            this.state = "ACK_DATA";
        }
    }
}

class TCA9538Model {
    constructor(opts) {
        opts = opts || {};
        const address = opts.address !== undefined ? opts.address : 0x23;
        const sclPin = opts.sclPin !== undefined ? opts.sclPin : 0;
        const sdaPin = opts.sdaPin !== undefined ? opts.sdaPin : 1;

        this.name = opts.name || "tca9538";
        this.timeDriven = true;
        this.address = address;
        this.sclPin = sclPin;
        this.sdaPin = sdaPin;

        this.nets = {};
        this.nets[sclPin] = OPEN_DRAIN;
        this.nets[sdaPin] = OPEN_DRAIN;

        this.device = new TCA9538Device(address);
        this.address = this.device.address;

        this._events = [];
        this._faults = [];
        this._prevScl = null;
        this._prevSda = null;
        this._drivingLow = false;
        this._cycle = 0;
    }

    tick(cycle, bus) {
        this._cycle = cycle;
        const scl = (bus >> this.sclPin) & 1;
        const sda = (bus >> this.sdaPin) & 1;

        this._checkFaults(cycle, scl, sda);
        this._recordEvents(cycle, scl, sda);

        const sdaMaster = this._drivingLow ? 1 : sda;

        const busSda = this.device.step(scl === 1, sdaMaster === 1);
        this._drivingLow = (!busSda) && (sdaMaster === 1);
        this._prevScl = scl;
        this._prevSda = sda;

        if (this._drivingLow) {
            return [(1 << this.sdaPin), 0];
        }
        return [0, 0];
    }

    _recordEvents(cycle, scl, sda) {
        if (this._prevScl === null) return;
        if (scl === 1 && this._prevSda === 1 && sda === 0) {
            this._events.push({ cycle: cycle, kind: "start" });
        } else if (scl === 1 && this._prevSda === 0 && sda === 1) {
            this._events.push({ cycle: cycle, kind: "stop" });
        }
    }

    _checkFaults(cycle, scl, sda) {
        if (this._prevScl === null) return;
        if (scl === 1 && this._prevScl === 1 && sda !== this._prevSda) {
            if (this.device.state !== "IDLE") {
                this._faults.push(`cycle ${cycle}: SDA changed while SCL high mid-transfer (state=${this.device.state}) - START/STOP inside a byte`);
            }
        }
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() {
        this.device = new TCA9538Device(this.address);
        this._events = [];
        this._faults = [];
        this._prevScl = null;
        this._prevSda = null;
        this._drivingLow = false;
        this._cycle = 0;
    }

    getState() {
        return { name: this.name, address: this.address, faults: this._faults.length };
    }
}


function crc6(bits, seedOnes = false, invert = true) {
    let ff = [seedOnes ? 1 : 0, seedOnes ? 1 : 0, seedOnes ? 1 : 0, seedOnes ? 1 : 0, seedOnes ? 1 : 0, seedOnes ? 1 : 0];
    for (const bit of bits) {
        const ex = ff[5] ^ (bit & 1);
        ff[5] = ff[4];
        ff[4] = ff[3];
        ff[3] = ff[2];
        ff[2] = ff[1];
        ff[1] = ff[0] ^ ex;
        ff[0] = ex;
    }
    let value = 0;
    for (let stage = 5; stage >= 0; stage--) {
        value = (value << 1) | ff[stage];
    }
    return invert ? ((~value) & 0x3F) : value;
}

class BissCEncoder {
    constructor(opts) {
        opts = opts || {};
        this.positionBits = opts.positionBits !== undefined ? opts.positionBits : 24;
        this.cdsBit = (opts.cdsBit !== undefined ? opts.cdsBit : 0) & 1;
        this.invertCrc = opts.invertCrc !== undefined ? opts.invertCrc : true;
        this.ackClocks = Math.max(1, opts.ackClocks !== undefined ? opts.ackClocks : 1);

        if (this.positionBits < 1 || this.positionBits > 32) throw new Error("position_bits must be 1..32");

        this.position = 0;
        this.error = 1;
        this.warning = 1;
        this.forceBadCrc = false;

        this._bits = [];
        this.reset();
    }

    buildFrame() {
        const pos = this.position & ((1 << this.positionBits) - 1);
        const payload = [];
        for (let i = this.positionBits - 1; i >= 0; i--) {
            payload.push((pos >> i) & 1);
        }
        payload.push(this.error & 1);
        payload.push(this.warning & 1);

        let crc = crc6(payload, false, this.invertCrc);
        if (this.forceBadCrc) {
            crc ^= 0x01;
        }
        const crcBits = [];
        for (let i = 5; i >= 0; i--) {
            crcBits.push((crc >> i) & 1);
        }

        const frame = [];
        for (let i = 0; i < this.ackClocks; i++) frame.push(0); // Ack
        frame.push(1); // Start
        frame.push(this.cdsBit); // CDS
        for (const b of payload) frame.push(b);
        for (const b of crcBits) frame.push(b);
        return frame;
    }

    reset() {
        this._bits = this.buildFrame();
    }
}

class BissCModel {
    constructor(opts) {
        opts = opts || {};
        const maPin = opts.maPin !== undefined ? opts.maPin : 0;
        const sloPin = opts.sloPin !== undefined ? opts.sloPin : 1;
        const positionBits = opts.positionBits !== undefined ? opts.positionBits : 24;
        const tbusyClocks = opts.tbusyClocks !== undefined ? opts.tbusyClocks : 1;
        const minMaPeriodCycles = opts.minMaPeriodCycles !== undefined ? opts.minMaPeriodCycles : 2;
        const idleRestartCycles = opts.idleRestartCycles !== undefined ? opts.idleRestartCycles : 40;

        this.name = opts.name || "bissc";
        this.timeDriven = true;
        this.maPin = maPin;
        this.sloPin = sloPin;
        this.tbusyClocks = Math.max(0, tbusyClocks);
        this.minMaPeriodCycles = minMaPeriodCycles;
        this.idleRestartCycles = idleRestartCycles;

        this.nets = {};
        this.nets[sloPin] = PUSH_PULL;

        this.encoder = new BissCEncoder({
            positionBits: positionBits,
            cdsBit: opts.cdsBit,
            invertCrc: opts.invertCrc,
            ackClocks: opts.ackClocks
        });
        // A GUI-attached device is configured only through its
        // parameters, so the position has to be one (it was always 0).
        if (opts.position !== undefined) {
            this.encoder.position = opts.position;
            this.encoder.reset();
        }

        this._events = [];
        this._faults = [];
        this._prevMa = null;
        this._edges = 0;
        this._lastEdgeCycle = null;
        this._level = 1;
        this._frameDone = false;
    }

    get _bits() {
        return this.encoder._bits;
    }

    tick(cycle, bus) {
        const ma = (bus >> this.maPin) & 1;

        if (this._prevMa !== null && ma === 1 && this._prevMa === 0) {
            this._onRisingEdge(cycle);
        }
        this._prevMa = ma;

        return [(1 << this.sloPin), (this._level << this.sloPin)];
    }

    _onRisingEdge(cycle) {
        const prev = this._lastEdgeCycle;
        if (prev !== null) {
            const gap = cycle - prev;
            if (gap < this.minMaPeriodCycles) {
                this._faults.push(`cycle ${cycle}: MA period ${gap} cycles is below the slave minimum of ${this.minMaPeriodCycles}`);
            }
            if (gap >= this.idleRestartCycles) {
                if (!this._frameDone && this._edges > this.tbusyClocks) {
                    this._faults.push(`cycle ${cycle}: MA stalled ${gap} cycles after ${this._edges - this.tbusyClocks} of ${this._bits.length} frame bits - transaction abandoned mid-frame`);
                }
                this._restart();
            }
        }
        this._lastEdgeCycle = cycle;

        this._edges += 1;
        const idx = this._edges - 1 - this.tbusyClocks;
        if (idx < 0) {
            this._level = 1;
        } else if (idx < this._bits.length) {
            this._level = this._bits[idx];
            if (idx === this._bits.length - 1) {
                this._frameDone = true;
                this._emitFrame(cycle);
            }
        } else {
            this._level = 1;
        }
    }

    _restart() {
        this.encoder.reset();
        this._edges = 0;
        this._frameDone = false;
        this._level = 1;
    }

    _emitFrame(cycle) {
        this._events.push({
            cycle: cycle,
            kind: "frame",
            position: this.encoder.position & ((1 << this.encoder.positionBits) - 1),
            error: this.encoder.error & 1,
            warning: this.encoder.warning & 1,
            bits: this._bits.length
        });
    }

    events() { return this._events.slice(); }
    faults() { return this._faults.slice(); }

    reset() {
        this.encoder.reset();
        this._events = [];
        this._faults = [];
        this._prevMa = null;
        this._edges = 0;
        this._lastEdgeCycle = null;
        this._level = 1;
        this._frameDone = false;
    }

    getState() {
        return {
            name: this.name,
            position: this.encoder.position,
            frame_bits: this._bits.length,
            edges: this._edges,
            slo: this._level,
            faults: this._faults.length
        };
    }
}

const DEVICE_MODEL_KINDS = [
    { kind: "quadrature",  displayName: "Quadrature encoder (A/B/Z)",   ported: true,
      clockLabel: "B channel", multiPin: false },
    { kind: "ssi",         displayName: "SSI absolute encoder",         ported: true,
      clockLabel: "clock", multiPin: true },
    { kind: "hall",        displayName: "Hall sensor (3-phase)",        ported: true,
      clockLabel: "B", multiPin: true },
    { kind: "ossd",        displayName: "Dual-channel OSSD safety input", ported: true,
      clockLabel: "CH_B", multiPin: true },
    { kind: "bissc",       displayName: "BiSS-C absolute encoder",      ported: true,
      clockLabel: "clock", multiPin: true },
    // audit of `ported: false` for bissline: INTENTIONAL STAGED
    // PORT, not a binding gap. Evidence: (1) scripts/sim/test_device_models.js
    // ("a kind not yet ported to the in-tool simulator is refused, not
    // faked") REQUIRES createDeviceModel("bissline") to throw, so this
    // flag is load-bearing; flipping it without a faithful JS port breaks
    // that contract and falls through to the internal-error branch below.
    // (2) the Python behavioural model in
    // perif/bissline_device_model.py is not this JS registry's implementation;
    // the external simulator currently resolves a materially different model
    // from tools/pru-simulator-upstream. (3) bissc and endat - which also have
    // Python models - are staged identically; porting here means a full JS
    // class + PARAM_WHITELIST entry + factory branch + crosscheck against
    // the Python model, per the file header. Do not flip this flag without
    // those.
    { kind: "bissline",    displayName: "BiSS Line absolute encoder",   ported: false,
      clockLabel: "clock", multiPin: true },
    { kind: "endat",       displayName: "EnDat 2.2 absolute encoder",   ported: false,
      clockLabel: "clock", multiPin: true },
    { kind: "tca9538",     displayName: "TCA9538 I2C IO expander",      ported: true,
      clockLabel: "clock", multiPin: true },
    { kind: "uart",        displayName: "UART transmitter",             ported: true,
      clockLabel: "clock", multiPin: false },
    { kind: "uart_monitor",displayName: "UART monitor",                 ported: true,
      clockLabel: "clock", multiPin: false },
    { kind: "sigma_delta", displayName: "Sigma-delta modulator",        ported: true,
      clockLabel: "clock", multiPin: true },
    { kind: "spi_adc",     displayName: "SPI ADC (ADS8688-class SPI mode 0)", ported: false,
      clockLabel: "clock", multiPin: true },
    { kind: "step_dir",    displayName: "STEP/DIR stepper driver",      ported: false,
      clockLabel: "dir", multiPin: true },
    { kind: "ws2812",      displayName: "WS2812 addressable LED string", ported: false,
      clockLabel: null, multiPin: false },
    // Perif/mdio_phy_model.py MdioPhyModel decodes the observed MDC/MDIO
    // line. offers it in the GUI device-kind dropdown and binds it through
    // scripts/sim/device_bindings.py; `ported: false` still holds and is still
    // load-bearing - it means the IN-TOOL JS simulator refuses this kind rather
    // than faking it, exactly as for bissline and endat above.
    { kind: "mdio_phy",    displayName: "MDIO Clause 22 PHY",           ported: false,
      clockLabel: "mdc", multiPin: true }
];

function getDeviceModelKind(kind) {
    for (const k of DEVICE_MODEL_KINDS) {
        if (k.kind === kind) return k;
    }
    return null;
}

// Per-kind parameter whitelists. An unknown key is an ERROR, not an ignored
// value - a silently dropped parameter produces a model that is not the one
// the user asked for, which is exactly the failure device mode exists to
// prevent. Pin keys are rejected for the same reason: pins come from the pin
// fields, one source of truth.
const PARAM_WHITELIST = {
    quadrature: ["counts_per_rev", "cycles_per_count", "forward"],
    uart: ["payload", "bit_period", "start_cycle", "idle_gap_bits", "frames"],
    uart_monitor: ["bit_period"],
    sigma_delta: ["min_period", "saturation_threshold", "saturation_persist", "initial_input"],
    tca9538: ["address"],
    bissc: ["position_bits", "position", "tbusy_clocks", "min_ma_period_cycles", "idle_restart_cycles", "cds_bit", "invert_crc", "ack_clocks"],
    ssi: ["bits", "position", "cycles_per_count", "min_clk_period_cycles",
          "monoflop_cycles", "gray"],
    hall: ["cycles_per_sector", "direction", "fault_ack_pin", "response_window_cycles"],
    ossd: ["ossd_min_cycles", "ossd_max_cycles", "discrepancy_cycles"]
};

const RESERVED_PIN_KEYS = ["clk_pin", "data_pin", "a_pin", "b_pin", "z_pin", "pin"];

/**
 * Build a device model from a Simulation Settings device-mode binding.
 *
 * pins:   { primary, clock, index } - the selected GPI pin is the PRIMARY
 *         (data/A); companions come from the Clock/B and Index/Z fields,
 *         already defaulted from the bound block's pin config by the caller.
 * params: the parsed Device Parameters JSON object.
 *
 * Throws on anything that would otherwise be silently ignored: unknown kind,
 * kind not yet ported to the in-tool simulator, unknown or reserved parameter
 * keys, or constructor-range violations. Device mode is the one input mode
 * where the user does not author the waveform, so every refusal here is a
 * would-have-been-silent wrong answer caught early.
 */
function createDeviceModel(kind, pins, params) {
    const entry = getDeviceModelKind(kind);
    if (!entry) {
        throw new Error(`unknown device kind "${kind}" - expected one of: ` +
            DEVICE_MODEL_KINDS.map(k => k.kind).join(", "));
    }
    if (!entry.ported) {
        throw new Error(
            `device kind "${kind}" (${entry.displayName}) is not available in the in-tool ` +
            `simulator yet. The behavioural model exists only in the external oracle ` +
            `checkout today; rather than substitute an unproven stand-in, this binding ` +
            `is refused. Ported kinds: ` +
            DEVICE_MODEL_KINDS.filter(k => k.ported).map(k => k.kind).join(", "));
    }

    params = params || {};
    const whitelist = PARAM_WHITELIST[kind];
    for (const key of Object.keys(params)) {
        if (RESERVED_PIN_KEYS.indexOf(key) !== -1) {
            throw new Error(`parameters must not set "${key}" - pins come from the pin fields`);
        }
        if (whitelist.indexOf(key) === -1) {
            throw new Error(`unknown ${kind} parameter "${key}". Known parameters: ` +
                whitelist.join(", "));
        }
    }
    if (kind === "uart") {
        return new UartTransmitter({
            pin: pins.primary,
            payload: params.payload,
            bitPeriod: params.bit_period,
            startCycle: params.start_cycle,
            idleGapBits: params.idle_gap_bits,
            frames: params.frames,
            name: kind
        });
    }
    if (kind === "uart_monitor") {
        return new UartMonitor({
            pin: pins.primary,
            bitPeriod: params.bit_period,
            name: kind
        });
    }
    if (kind === "sigma_delta") {
        return new SigmaDeltaModulator({
            clkPin: pins.clock,
            dataPin: pins.primary,
            minPeriod: params.min_period,
            saturationThreshold: params.saturation_threshold,
            saturationPersist: params.saturation_persist,
            initialInput: params.initial_input,
            name: kind
        });
    }
    if (kind === "tca9538") {
        return new TCA9538Model({
            sclPin: pins.clock,
            sdaPin: pins.primary,
            address: params.address,
            name: kind
        });
    }
    if (kind === "bissc") {
        return new BissCModel({
            maPin: pins.clock,
            sloPin: pins.primary,
            positionBits: params.position_bits,
            tbusyClocks: params.tbusy_clocks,
            minMaPeriodCycles: params.min_ma_period_cycles,
            idleRestartCycles: params.idle_restart_cycles,
            cdsBit: params.cds_bit,
            invertCrc: params.invert_crc,
            ackClocks: params.ack_clocks,
            position: params.position,
            name: kind
        });
    }
    if (kind === "quadrature") {
        return new QuadratureEncoder({
            aPin: pins.primary,
            bPin: pins.clock,
            zPin: (pins.index === undefined || pins.index === -1) ? null : pins.index,
            countsPerRev: params.counts_per_rev,
            cyclesPerCount: params.cycles_per_count,
            forward: params.forward,
            name: kind
        });
    }
    if (kind === "ssi") {
        if (pins.clock === undefined || pins.clock === null || pins.clock === -1) {
            throw new Error("SSI is a clocked device and needs a Clock pin");
        }
        return new SsiEncoder({
            clkPin: pins.clock,
            dataPin: pins.primary,
            bits: params.bits,
            position: params.position,
            cyclesPerCount: (params.cycles_per_count === undefined ? null : params.cycles_per_count),
            minClkPeriodCycles: params.min_clk_period_cycles,
            monoflopCycles: params.monoflop_cycles,
            gray: params.gray,
            name: kind
        });
    }
    if (kind === "hall") {
        if (pins.clock === undefined || pins.clock === null || pins.clock === -1) {
            throw new Error("Hall sensor needs Clock/B pin for second Hall line");
        }
        const cPin = (pins.index === undefined || pins.index === -1) ? null : pins.index;
        if (cPin === null) throw new Error("Hall sensor needs Index/Z pin for third Hall line");
        return new HallSensor({
            aPin: pins.primary,
            bPin: pins.clock,
            cPin: cPin,
            cyclesPerSector: params.cycles_per_sector,
            direction: params.direction,
            faultAckPin: params.fault_ack_pin,
            responseWindowCycles: params.response_window_cycles,
            name: kind
        });
    }
    if (kind === "ossd") {
        if (pins.clock === undefined || pins.clock === null || pins.clock === -1) {
            throw new Error("OSSD is a dual-channel device and needs both pins: primary=CH_A, clock=CH_B");
        }
        return new DualOssdEmitter({
            chAPin: pins.primary,
            chBPin: pins.clock,
            ossdMinCycles: params.ossd_min_cycles,
            ossdMaxCycles: params.ossd_max_cycles,
            discrepancyCycles: params.discrepancy_cycles,
            name: kind
        });
    }
    // Unreachable given the ported check above, but a fallthrough that
    // silently returned a model would be the worst line in the file.
    throw new Error(`internal error: no constructor for ported kind "${kind}"`);
}

exports = {
    QuadratureEncoder,
    UartTransmitter,
    UartMonitor,
    SigmaDeltaModulator,
    TCA9538Model,
    TCA9538Device,
    BissCModel,
    crc6,
    SsiEncoder,
    HallSensor,
    DualOssdEmitter,
    DEVICE_MODEL_KINDS,
    getDeviceModelKind,
    createDeviceModel,
    toGray,
    fromGray
};
