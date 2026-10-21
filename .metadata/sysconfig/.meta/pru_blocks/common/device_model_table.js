/**
 * Device Model table (part A).
 *
 * One table, three consumers: the Device Model module builds its typed fields
 * from it, the static module merges its instances into the device-binding
 * manifest with it, and the tests read it to prove it still agrees with
 * scripts/sim/device_bindings.py.
 *
 * WHAT A DEVICE MODEL INSTANCE IS
 * An ADDITIONAL source of device bindings next to the GPI device fields in
 * Simulation Settings (decision on, option 1). The GPI fields are
 * untouched and keep working. Both sources feed the same manifest, in the same
 * shape, so scripts/sim/device_bindings.py cannot tell them apart - which is
 * the point: one consumer, one set of safety checks.
 *
 * WHY EVERY PARAMETER IS A REAL FIELD
 * The GPI route takes a JSON string, so a typo in a key, a string where a
 * number belongs, or an out-of-range value is only found when a model refuses
 * it at run time. A typed field is range-checked in the GUI. A key here MUST be
 * a keyword of the Python model constructor; test_device_model.py
 * proves that against the real constructors, so renaming a model parameter
 * breaks a test here instead of producing a model that is not the one asked for.
 *
 * PIN SLOTS
 * `slot` is where the pin travels in the manifest: primaryPin / clockPin /
 * indexPin, or `param:<key>` for a model pin the manifest has no slot for
 * (spi_adc cs_pin). `drives` says who drives the net: true when the DEVICE
 * drives it back at the PRU, false when the PRU drives it and the device only
 * listens. It is NOT guessable from the names and mirrors the table at the top
 * of scripts/sim/device_bindings.py.
 *
 * Pure data and pure functions: no `system`, no I/O, so it loads outside the
 * SysConfig runtime.
 */

const PIN_MAX = 19;   // PRU R30/R31 pin range accepted by scripts/sim/device_bindings.py

// type: int | float | bool | bytes. `omit`: the value that means "not set" -
// the key is then left out of the manifest and the model takes its own default
// (the Python models take None there, which a typed int field cannot say).
const KINDS = {
    quadrature: {
        displayName: "Quadrature encoder (A/B/Z)",
        sink: false,
        pins: [
            { key: "a", label: "A channel", slot: "primaryPin", drives: true },
            { key: "b", label: "B channel", slot: "clockPin", drives: true },
            { key: "z", label: "Z (index) channel", slot: "indexPin", drives: true, optional: true }
        ],
        params: [
            { key: "counts_per_rev", label: "Counts per revolution", type: "int", def: 1024, min: 1 },
            { key: "cycles_per_count", label: "Cycles per count", type: "int", def: 50, min: 1 },
            { key: "forward", label: "Forward direction", type: "bool", def: true }
        ]
    },
    ssi: {
        displayName: "SSI absolute encoder",
        sink: false,
        pins: [
            { key: "data", label: "DATA pin", slot: "primaryPin", drives: true },
            { key: "clk", label: "CLK pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "bits", label: "Frame width (bits)", type: "int", def: 13, min: 1, max: 64 },
            { key: "position", label: "Position", type: "int", def: 0, min: 0, positionBitsKey: "bits" },
            { key: "cycles_per_count", label: "Cycles per count (0 = stationary)", type: "int", def: 0, min: 0, omit: 0 },
            { key: "min_clk_period_cycles", label: "Minimum clock period (cycles)", type: "int", def: 20, min: 1 },
            { key: "monoflop_cycles", label: "Monoflop time (cycles)", type: "int", def: 400, min: 1 },
            { key: "gray", label: "Gray-coded position", type: "bool", def: true }
        ]
    },
    bissc: {
        displayName: "BiSS-C absolute encoder",
        sink: false,
        pins: [
            { key: "slo", label: "SLO pin", slot: "primaryPin", drives: true },
            { key: "ma", label: "MA (clock) pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "position_bits", label: "Position bits", type: "int", def: 24, min: 1, max: 64 },
            { key: "tbusy_clocks", label: "Busy clocks", type: "int", def: 1, min: 0 },
            { key: "min_ma_period_cycles", label: "Minimum MA period (cycles)", type: "int", def: 2, min: 1 },
            { key: "idle_restart_cycles", label: "Idle restart (cycles)", type: "int", def: 40, min: 1 },
            { key: "position", label: "Position", type: "int", def: 0, min: 0, positionBitsKey: "position_bits" }
        ]
    },
    bissline: {
        displayName: "BiSS Line absolute encoder",
        sink: false,
        pins: [
            { key: "slave", label: "SLAVE pin", slot: "primaryPin", drives: true },
            { key: "master", label: "MASTER (clock) pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "cds_bit", label: "CDS bit", type: "int", def: 0, min: 0, max: 1 },
            { key: "fec_enabled", label: "FEC enabled", type: "bool", def: true },
            { key: "bit_period_cycles", label: "Bit period (cycles)", type: "int", def: 16, min: 1 },
            { key: "min_bit_period_cycles", label: "Minimum bit period (cycles)", type: "int", def: 8, min: 1 }
        ]
    },
    endat: {
        displayName: "EnDat 2.2 absolute encoder",
        sink: false,
        pins: [
            { key: "data", label: "DATA pin", slot: "primaryPin", drives: true },
            { key: "clock", label: "CLOCK pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "position_bits", label: "Position bits", type: "int", def: 24, min: 1, max: 64 },
            { key: "position", label: "Position", type: "int", def: 0, min: 0, positionBitsKey: "position_bits" },
            { key: "cycles_per_count", label: "Cycles per count (0 = stationary)", type: "int", def: 0, min: 0, omit: 0 },
            { key: "calc_cycles", label: "Calculation time (cycles)", type: "int", def: 50, min: 0 },
            { key: "lead_in_clocks", label: "Lead-in clocks", type: "int", def: 2, min: 0 },
            { key: "min_half_period_cycles", label: "Minimum half period (cycles)", type: "int", def: 0, min: 0 },
            { key: "recovery_cycles", label: "Recovery time (cycles)", type: "int", def: 0, min: 0 },
            { key: "reset_cycles", label: "Reset time (cycles)", type: "int", def: 2000, min: 0 },
            { key: "error1", label: "Error 1", type: "bool", def: false },
            { key: "error2", label: "Error 2", type: "bool", def: false }
        ]
    },
    tca9538: {
        displayName: "TCA9538 I2C IO expander",
        sink: false,
        pins: [
            { key: "sda", label: "SDA pin", slot: "primaryPin", drives: true },
            // I2C SCL is open-drain: a slave may stretch the clock, so the device drives it too.
            { key: "scl", label: "SCL pin", slot: "clockPin", drives: true }
        ],
        params: [
            { key: "address", label: "7-bit I2C address", type: "int", def: 35, min: 0, max: 127 }
        ]
    },
    uart: {
        displayName: "UART transmitter",
        sink: false,
        pins: [
            { key: "tx", label: "TX pin (device drives)", slot: "primaryPin", drives: true }
        ],
        params: [
            { key: "payload", label: "Payload bytes (comma separated, 0-255; empty = model default)", type: "bytes", def: "", omit: "" },
            { key: "bit_period", label: "Bit period (cycles)", type: "int", def: 50, min: 1 },
            { key: "start_cycle", label: "Start cycle", type: "int", def: 0, min: 0 },
            { key: "idle_gap_bits", label: "Idle gap (bits)", type: "int", def: 2, min: 0 },
            { key: "frames", label: "Frames", type: "int", def: 1, min: 1 }
        ]
    },
    sigma_delta: {
        displayName: "Sigma-delta modulator",
        sink: false,
        pins: [
            { key: "data", label: "DATA pin", slot: "primaryPin", drives: true },
            { key: "clk", label: "CLK pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "min_period", label: "Minimum clock period (cycles)", type: "int", def: 4, min: 1 },
            { key: "saturation_threshold", label: "Saturation threshold", type: "float", def: 10, min: 0 },
            { key: "saturation_persist", label: "Saturation persist (cycles)", type: "int", def: 16, min: 1 },
            { key: "initial_input", label: "Initial input", type: "float", def: 0 }
        ]
    },
    spi_adc: {
        displayName: "SPI ADC (SPI mode 0)",
        sink: false,
        pins: [
            { key: "sdi", label: "MISO pin (device drives; the model calls it sdi_pin)", slot: "primaryPin", drives: true },
            { key: "sclk", label: "SCLK pin", slot: "clockPin", drives: false },
            { key: "sdo", label: "MOSI pin (the model calls it sdo_pin)", slot: "indexPin", drives: false },
            { key: "cs", label: "CS pin", slot: "param:cs_pin", drives: false }
        ],
        params: [
            { key: "bits", label: "Word size (bits)", type: "int", def: 16, min: 1, max: 32 },
            { key: "conversion", label: "Conversion result", type: "int", def: 0, min: 0, positionBitsKey: "bits" },
            { key: "miso_idle", label: "MISO idle level", type: "int", def: 0, min: 0, max: 1 },
            { key: "msb_first", label: "MSB first", type: "bool", def: true }
        ]
    },
    step_dir: {
        displayName: "STEP/DIR stepper driver",
        sink: true,
        pins: [
            { key: "step", label: "STEP pin", slot: "primaryPin", drives: false },
            { key: "dir", label: "DIR pin", slot: "clockPin", drives: false },
            { key: "en", label: "EN pin", slot: "indexPin", drives: false, optional: true }
        ],
        params: [
            { key: "min_pulse_cycles", label: "Minimum STEP pulse (cycles)", type: "int", def: 20, min: 1 },
            { key: "dir_setup_cycles", label: "DIR setup (cycles)", type: "int", def: 10, min: 0 },
            { key: "dir_positive", label: "DIR level for positive steps", type: "int", def: 1, min: 0, max: 1 }
        ]
    },
    ws2812: {
        displayName: "WS2812 addressable LED string",
        sink: true,
        pins: [
            { key: "data", label: "DATA pin", slot: "primaryPin", drives: false }
        ],
        params: [
            { key: "num_leds", label: "LEDs in the string", type: "int", def: 1, min: 1 },
            { key: "ns_per_cycle", label: "ns per PRU cycle", type: "float", def: 5, min: 0.001 },
            { key: "t0h_ns", label: "T0H (ns)", type: "float", def: 400, min: 0 },
            { key: "t0l_ns", label: "T0L (ns)", type: "float", def: 850, min: 0 },
            { key: "t1h_ns", label: "T1H (ns)", type: "float", def: 800, min: 0 },
            { key: "t1l_ns", label: "T1L (ns)", type: "float", def: 450, min: 0 },
            { key: "tol_ns", label: "Timing tolerance (ns)", type: "float", def: 220, min: 0 },
            { key: "reset_ns", label: "Reset time (ns)", type: "float", def: 50000, min: 0 },
            { key: "max_bits", label: "Maximum bits", type: "int", def: 1536, min: 1 }
        ]
    },
    mdio_phy: {
        displayName: "MDIO Clause 22 PHY",
        sink: false,
        pins: [
            { key: "mdio", label: "MDIO pin", slot: "primaryPin", drives: true },
            { key: "mdc", label: "MDC pin", slot: "clockPin", drives: false }
        ],
        params: [
            { key: "phy_addr", label: "PHY address", type: "int", def: 0, min: 0, max: 31 },
            { key: "min_half_period_cycles", label: "Minimum MDC half period (cycles)", type: "int", def: 40, min: 1 },
            { key: "preamble_bits", label: "Preamble bits", type: "int", def: 16, min: 0 },
            { key: "abort_gap_factor", label: "Abort gap factor", type: "int", def: 8, min: 1 }
        ]
    }
};

/** Name of the typed field carrying a pin or a parameter of `kind`. */
function pinField(kind, pin) { return kind + "_" + pin.key + "Pin"; }
function paramField(kind, param) {
    // snake_case model keyword -> camelCase field, prefixed by kind so the
    // names stay unique in one flat config list.
    return kind + "_" + param.key.replace(/_([a-z0-9])/g, function (_m, c) { return c.toUpperCase(); });
}

/** The (field, spec) pairs of a kind, for building and for reading back. */
function pinFields(kind) {
    return KINDS[kind].pins.map(function (p) { return { field: pinField(kind, p), spec: p }; });
}
function paramFields(kind) {
    return KINDS[kind].params.map(function (p) { return { field: paramField(kind, p), spec: p }; });
}

function parseBytes(text) {
    const trimmed = String(text === undefined || text === null ? "" : text).trim();
    if (trimmed === "") return [];
    const out = [];
    for (const part of trimmed.split(",")) {
        const t = part.trim();
        if (!/^(0x[0-9a-fA-F]{1,2}|\d{1,3})$/.test(t)) return null;
        const v = Number(t);
        if (v < 0 || v > 255) return null;
        out.push(v);
    }
    return out;
}

/**
 * Check one instance. Returns [{field, message}] - empty when legal.
 * Pure: pin-conflict checks against OTHER instances and the GPI fields need the
 * rest of the design and live in collectPinClaims / findPinConflicts.
 */
function checkInstance(inst) {
    const errors = [];
    const spec = KINDS[inst.deviceKind];
    if (!spec) {
        return [{ field: "deviceKind", message: "Unknown device kind '" + inst.deviceKind + "'" }];
    }
    const used = {};
    for (const pf of pinFields(inst.deviceKind)) {
        const value = inst[pf.field];
        if (value === -1 && pf.spec.optional) continue;
        if (!Number.isInteger(value) || value < 0 || value > PIN_MAX) {
            errors.push({ field: pf.field, message: pf.spec.label + " must be 0-" + PIN_MAX + (pf.spec.optional ? ", or -1 if unused" : "") + ", got " + value });
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(used, value)) {
            errors.push({ field: pf.field, message: pf.spec.label + " is pin " + value + ", which '" + used[value] + "' already uses. One device cannot put two signals on one pin." });
        } else {
            used[value] = pf.spec.label;
        }
    }
    for (const pf of paramFields(inst.deviceKind)) {
        const p = pf.spec, v = inst[pf.field];
        if (p.type === "bool") continue;
        if (p.type === "bytes") {
            if (parseBytes(v) === null) {
                errors.push({ field: pf.field, message: p.label + " must be comma-separated bytes 0-255, got '" + v + "'" });
            }
            continue;
        }
        if (typeof v !== "number" || !isFinite(v) || (p.type === "int" && !Number.isInteger(v))) {
            errors.push({ field: pf.field, message: p.label + " must be " + (p.type === "int" ? "an integer" : "a number") + ", got " + v });
            continue;
        }
        if (p.min !== undefined && v < p.min || p.max !== undefined && v > p.max) {
            const range = (p.min !== undefined ? p.min : "-inf") + ".." + (p.max !== undefined ? p.max : "inf");
            errors.push({ field: pf.field, message: p.label + " must be in " + range + ", got " + v });
            continue;
        }
        if (p.positionBitsKey) {
            const bitsParam = KINDS[inst.deviceKind].params.filter(function (q) { return q.key === p.positionBitsKey; })[0];
            const bits = inst[paramField(inst.deviceKind, bitsParam)];
            if (Number.isInteger(bits) && bits >= 1 && bits <= 53 && v > Math.pow(2, bits) - 1) {
                errors.push({ field: pf.field, message: p.label + " " + v + " does not fit in " + bits + " bits (max " + (Math.pow(2, bits) - 1) + ")" });
            }
        }
    }
    return errors;
}

/** The pins an instance occupies: [{pin, label}], unused optional pins skipped. */
function claimedPins(inst) {
    const out = [];
    for (const pf of pinFields(inst.deviceKind)) {
        const v = inst[pf.field];
        if (v === -1 && pf.spec.optional) continue;
        if (Number.isInteger(v)) out.push({ pin: v, label: pf.spec.label });
    }
    return out;
}

/**
 * The pin carrying a PRU-driven clock (the kind's clockPin slot when the PRU, not the device,
 * drives it), or null. Two models on one such pin is the "shared clock" case.
 */
function clockPin(inst) {
    for (const pf of pinFields(inst.deviceKind)) {
        if (pf.spec.slot === "clockPin" && pf.spec.drives === false && Number.isInteger(inst[pf.field])) {
            return inst[pf.field];
        }
    }
    return null;
}

/** A manifest binding, in exactly the shape buildDeviceBindings emits for a GPI pin. */
function toBinding(inst) {
    const spec = KINDS[inst.deviceKind];
    const binding = { primaryPin: null, kind: inst.deviceKind, clockPin: null, indexPin: null, params: {} };
    const extraPins = {};
    for (const pf of pinFields(inst.deviceKind)) {
        const v = inst[pf.field];
        const pin = (v === -1 && pf.spec.optional) ? null : v;
        if (pf.spec.slot.indexOf("param:") === 0) {
            extraPins[pf.spec.slot.slice(6)] = pin;
        } else {
            binding[pf.spec.slot] = pin;
        }
    }
    for (const key of Object.keys(extraPins)) {
        if (extraPins[key] !== null) binding.params[key] = extraPins[key];
    }
    for (const pf of paramFields(inst.deviceKind)) {
        const p = pf.spec, v = inst[pf.field];
        if (p.type === "bytes") {
            const bytes = parseBytes(v);
            if (bytes && bytes.length) binding.params[p.key] = bytes;
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(p, "omit") && v === p.omit) continue;
        binding.params[p.key] = v;
    }
    return binding;
}

/*
 * Block registrations. The tables below (READER_BLOCKS, COMPANION_PIN_BLOCKS and the rule lists of
 * DRIVER_BLOCKS) are the only place a block module is tied to a device kind. A block that reads or
 * drives a device is registered here in the same change that adds the block; a kind with no
 * registered block has no entry (READER_BLOCKS, COMPANION_PIN_BLOCKS) or an empty rule list
 * (DRIVER_BLOCKS).
 */

/**
 * Which blocks read a bound device: kind -> [{module, dataPinField}]. Shared by the manifest's
 * reader record (resolveDeviceReaders in the static module) and the Device Model's own display,
 * so the two cannot disagree about which block reads a device.
 */
const READER_BLOCKS = {
};

/**
 * Blocks whose pins give a bound device's companion pins a default: kind -> [{module, matchField,
 * clockField, indexField}]. When an instance of `module` has `matchField` equal to the device's
 * primary pin, an unset (-1) clock / index pin takes that instance's `clockField` / `indexField`
 * (either may be omitted). The first matching instance wins.
 */
const COMPANION_PIN_BLOCKS = {
};

function findReaderInstances(kind, primaryPin, modules) {
    const out = [];
    for (const entry of READER_BLOCKS[kind] || []) {
        const mod = modules ? modules[entry.module] : null;
        for (const inst of (mod && mod.$instances) || []) {
            if (Number(inst[entry.dataPinField]) === primaryPin) {
                out.push({ inst: inst, entry: entry });
            }
        }
    }
    return out;
}

// Slot -> default pin, so a fresh instance of any kind starts on distinct pins.
const SLOT_DEFAULT_PIN = { primaryPin: 1, clockPin: 0, indexPin: 2 };

function defaultPin(pinSpec) {
    if (pinSpec.optional) return -1;
    if (pinSpec.slot === "primaryPin") return SLOT_DEFAULT_PIN.primaryPin;
    if (pinSpec.slot === "clockPin") return SLOT_DEFAULT_PIN.clockPin;
    if (pinSpec.slot === "indexPin") return SLOT_DEFAULT_PIN.indexPin;
    return 3;   // a pin carried in params (spi_adc cs)
}

/**
 * `inst` with every field of its kind that it does not carry set to the field's default - what a .syscfg
 * that leaves a field unset means. SysConfig does this itself; scripts/check_pin_collisions.js (which has
 * no SysConfig runtime) needs it spelled out.
 */
function withDefaults(inst) {
    const out = { deviceKind: inst.deviceKind, $name: inst.$name };
    if (!KINDS[inst.deviceKind]) return out;
    const isSet = function (v) { return typeof v === "number" || typeof v === "string" || typeof v === "boolean"; };
    for (const pf of pinFields(inst.deviceKind)) out[pf.field] = isSet(inst[pf.field]) ? inst[pf.field] : defaultPin(pf.spec);
    for (const pf of paramFields(inst.deviceKind)) out[pf.field] = isSet(inst[pf.field]) ? inst[pf.field] : pf.spec.def;
    return out;
}

/**
 * A GPO pad that feeds an attached device's input (SSI/BiSS-C/EnDat clock, SPI SCLK/MOSI/CS, STEP/DIR/EN,
 * WS2812 DATA, MDIO's MDC, ...) may be driven only by the blocks that legitimately talk to that device. A second block on
 * the pad (a SPI write whose SCLK is the same GPO) makes the device see its output as extra input edges; sequential
 * hand-off of a pad is legal only while NO device listens on it, which is why the duplicate-GPO rule exempts sequential
 * blocks and this one does not. Shared by the GUI validator and scripts/check_pin_collisions.js so the two cannot disagree.
 *
 * DRIVER_BLOCKS is the explicit list. Per kind, per PRU-driven pad (the device-pin `key` of KINDS), the block modules
 * that legitimately drive that pad. A rule is one of
 *   { module, via: [[deviceKey, blockField], ...], padField }  the block is matched to THE DEVICE: every named block field
 *       equals that pin of the device (the device-driven DATA pin for an encoder reader: the pairing the manifest `readers`
 *       record and the Device Model "Read by" field use). A second instance of the module that points at another data pin
 *       is NOT matched and is foreign, which is why a module wildcard is not used. `padField` is
 *       the block field that carries the pad itself; it is read only to say, in the message, that the matched block puts
 *       its pad somewhere other than where the device listens.
 *   { module }  a module wildcard. Used only where the pad itself already identifies the instance (a WS2812 string has one
 *       pin, so any ws2812_block driving it is the string's driver) or where the bus is shared by design (SPI SCLK/MOSI are
 *       shared between chips; the chip is selected by CS, and CS is matched exactly).
 *
 * VERDICT per listened pad: a driver that is matched (or wildcard-legitimate) is never reported. Every other driver is an
 * ERROR when a legitimate driver for the pad exists in the design (a matched block, or a wildcard block on the pad), because
 * the intended driver is identifiable and the other block is a second one. When none exists, a block of one of the pad's
 * rule modules is taken as the intended driver with a wrong pin (a wiring mistake the simulator reports) and is not flagged;
 * any other driver then cannot be told from a hand-built generator, so it is a WARNING (severity "warning"), not an error.
 * A pad whose rule list is empty (no block in this tool speaks the device, e.g. BiSS Line) can only be judged by count:
 * one driver is a hand-built generator and clean, two or more are a WARNING.
 * `frameBased` kinds (encoders that answer one frame at a time) also WARN when two blocks read the same device (
 * S-A): the second frame can start inside the encoder's monoflop/recovery time, which the simulator reports as clocks past
 * the end of the word.
 *
 * devices: [{name, source, kind, matched: {padKey: [{name, driven}]}, listens: [{pin, label, key}]}] - `matched` comes from
 *          matchedDrivers; `listens` are the pins the PRU drives and the device only listens to.
 * drivers: [{iname, block, pin}] - every GPO claim in the design.
 * Returns [{device, pin, other, severity: "error"|"warning", message}].
 */
const PRU_IO = "/pru_blocks/pru_io_blocks/";
const SPI_BLOCKS = [PRU_IO + "pru_spi_transfer", PRU_IO + "pru_spi_read", PRU_IO + "pru_spi_write"];
const DRIVER_BLOCKS = {
    ssi: { noun: "reader", frameBased: true, pads: {
        clk: { what: "extra clocks", rules: [] } } },
    bissc: { noun: "reader", frameBased: true, pads: {
        ma: { what: "extra clocks", rules: [] } } },
    endat: { noun: "reader", frameBased: true, pads: {
        clock: { what: "extra clocks", rules: [] } } },
    sigma_delta: { noun: "reader", pads: {
        clk: { what: "extra clocks", rules: [] } } },
    // No block in this tool speaks BiSS Line: its MASTER clock can only be a hand-built generator.
    bissline: { noun: "driver", name: "BiSS Line", pads: { master: { what: "extra clocks", rules: [] } } },
    spi_adc: { noun: "driver", pads: {
        sclk: { what: "extra clocks", rules: SPI_BLOCKS.map(function (m) { return { module: m }; }) },
        sdo:  { what: "corrupted data bits", rules: [{ module: SPI_BLOCKS[0] }, { module: SPI_BLOCKS[2] }] },
        cs:   { what: "a toggled chip select", rules: SPI_BLOCKS.map(function (m) { return { module: m, via: [["cs", "CS Signal"]], padField: "CS Signal" }; }) } } },
    step_dir: { noun: "driver", pads: {
        step: { what: "extra steps", rules: [] },
        dir:  { what: "a flipped direction", rules: [] },
        en:   { what: "a toggled enable", rules: [] } } },
    ws2812: { noun: "driver", pads: { data: { what: "extra bits", rules: [] } } },
    mdio_phy: { noun: "reader", pads: {
        mdc: { what: "extra clocks", rules: [] } } }
};

/** The device's pin for `key` (a KINDS pin key), from a manifest-shaped binding, or undefined. */
function devicePin(kind, binding, key) {
    for (const p of KINDS[kind].pins) {
        if (p.key !== key) continue;
        return p.slot.indexOf("param:") === 0 ? (binding.params || {})[p.slot.slice(6)] : binding[p.slot];
    }
    return undefined;
}

/**
 * The blocks matched to a device by a `via` rule: {padKey: [{name, driven}]}, `driven` the pad the block's padField names
 * (or null). Pure data lookup in `modules` (system.modules, or the CI's parsed design); the verdict is findDeviceInputConflicts.
 */
function matchedDrivers(kind, binding, modules) {
    const out = {};
    const spec = DRIVER_BLOCKS[kind];
    if (!spec) return out;
    for (const padKey of Object.keys(spec.pads)) {
        out[padKey] = [];
        for (const rule of spec.pads[padKey].rules) {
            if (!rule.via) continue;
            const mod = modules ? modules[rule.module] : null;
            for (const inst of (mod && mod.$instances) || []) {
                if (!rule.via.every(function (v) { return Number(inst[v[1]]) === devicePin(kind, binding, v[0]); })) continue;
                if (out[padKey].some(function (m) { return m.name === inst.$name; })) continue;
                const driven = Number(inst[rule.padField]);
                out[padKey].push({ name: inst.$name, driven: Number.isInteger(driven) ? driven : null });
            }
        }
    }
    return out;
}

function findDeviceInputConflicts(devices, drivers) {
    const out = [];
    const base = function (module) { return module.split("/").pop(); };
    for (const d of devices) {
        const spec = KINDS[d.kind], rules = DRIVER_BLOCKS[d.kind];
        if (!spec || !rules) continue;
        const kindName = rules.name || spec.displayName.replace(/ .*$/, "");
        for (const l of d.listens) {
            const pad = rules.pads[l.key] || { what: "extra input edges", rules: [] };
            const matched = (d.matched && d.matched[l.key]) || [];
            const wild = pad.rules.filter(function (r) { return !r.via; }).map(function (r) { return base(r.module); });
            const ruleModules = pad.rules.map(function (r) { return base(r.module); });
            const onPad = [];
            for (const drv of drivers) {
                if (drv.pin === l.pin && !onPad.some(function (o) { return o.iname === drv.iname; })) onPad.push(drv);
            }
            const legitDrivers = onPad.filter(function (drv) {
                return matched.some(function (m) { return m.name === drv.iname; }) || wild.indexOf(drv.block) !== -1;
            });
            const hasLegit = matched.length > 0 || legitDrivers.length > 0;
            const who = matched.map(function (m) { return m.name; });
            for (const drv of legitDrivers) if (who.indexOf(drv.iname) === -1) who.push(drv.iname);
            const sees = " sees that block's output as extra input edges (" + pad.what + ")";
            if (!pad.rules.length) {
                // Nothing in this tool speaks the device: judge by count. One driver is a hand-built generator.
                if (onPad.length < 2) continue;
                out.push({
                    device: d.name, pin: l.pin, other: onPad.map(function (o) { return o.iname; }).join(", "), severity: "warning",
                    message: "GPO" + l.pin + " feeds the " + l.label + " of device '" + d.name + "' (" + d.kind + ", " + d.source + ") and " +
                        onPad.map(function (o) { return "'" + o.iname + "' (" + o.block + ")"; }).join(", ") + " all drive GPO" + l.pin +
                        ". No block in this tool speaks a " + kindName + " device, so the check cannot tell which one generates its " +
                        l.label + "; the device" + sees + " of any other. Keep one block on that GPO."
                });
                continue;
            }
            for (const drv of onPad) {
                if (legitDrivers.indexOf(drv) !== -1) continue;
                // No legitimate driver: a block of the pad's rule modules is the intended one with a wrong pin; the simulator says so.
                if (!hasLegit && ruleModules.indexOf(drv.block) !== -1) continue;
                const note = (matched.length && !matched.some(function (m) { return m.driven === l.pin; }))
                    ? " Note: '" + matched[0].name + "' is matched to this device but puts its " + (pad.rules[0].padField || "pad") + " on GPO" +
                      matched[0].driven + ", not on the device's " + l.label + " (GPO" + l.pin + "); if that is the mistake, move '" +
                      matched[0].name + "' to GPO" + l.pin + " and leave '" + drv.iname + "' where it is." : "";
                out.push({
                    device: d.name, pin: l.pin, other: drv.iname, severity: hasLegit ? "error" : "warning",
                    message: hasLegit ? ("GPO" + l.pin + " feeds the " + l.label + " of device '" + d.name + "' (" + d.kind + ", " +
                        (rules.noun === "reader" ? "read by " : "driven by ") + who.join(", ") + ", " + d.source + ") but '" + drv.iname +
                        "' (" + drv.block + ") also drives GPO" + l.pin + ": the " + kindName + " device" + sees +
                        ". Move '" + drv.iname + "' to a free GPO." + note) : ("No " + rules.noun + " block was found for device '" + d.name +
                        "' (" + d.kind + ", " + d.source + "), whose " + l.label + " is on GPO" + l.pin + ", but '" + drv.iname + "' (" + drv.block +
                        ") also drives GPO" + l.pin + ". If that block is not generating the device's " + l.label + ", the " + kindName +
                        " device sees its output as extra input edges (" + pad.what + "): move it to a free GPO.")
                });
            }
        }
        if (rules.frameBased) {
            const readers = [];
            for (const padKey of Object.keys(d.matched || {})) {
                for (const m of d.matched[padKey]) if (readers.indexOf(m.name) === -1) readers.push(m.name);
            }
            if (readers.length > 1) {
                out.push({
                    device: d.name, pin: d.listens.length ? d.listens[0].pin : -1, other: readers.slice(1).join(", "), severity: "warning",
                    message: readers.length + " blocks (" + readers.join(", ") + ") read device '" + d.name + "' (" + d.kind + ", " + d.source +
                        "). The " + kindName + " encoder answers one frame at a time: a second read that starts before the first frame's " +
                        "monoflop/recovery time has passed is read as extra clocks of the first (TI pru-simulator reports it as clocks past the end of the word). " +
                        "Put a Delay longer than the encoder's recovery time between them, or read once and reuse the value."
                });
            }
        }
    }
    return out;
}

/** Pins of `kind` the PRU drives, from a manifest-shaped {primaryPin, clockPin, indexPin, params}: [{pin, label, key}]. */
function listenedPins(kind, binding) {
    const out = [];
    if (!KINDS[kind]) return out;
    for (const p of KINDS[kind].pins) {
        const v = p.slot.indexOf("param:") === 0 ? (binding.params || {})[p.slot.slice(6)] : binding[p.slot];
        if (p.drives === false && Number.isInteger(v) && v >= 0) out.push({ pin: v, label: p.label, key: p.key });
    }
    return out;
}

/** The params object of a Simulation Settings GPI device field (JSON text), or {} when it is not an object. */
function paramsOf(text) {
    try {
        const v = JSON.parse(String(text || "{}"));
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch (e) {
        return {};
    }
}

exports = {
    PIN_MAX,
    KINDS,
    READER_BLOCKS,
    COMPANION_PIN_BLOCKS,
    DRIVER_BLOCKS,
    pinField,
    paramField,
    pinFields,
    paramFields,
    parseBytes,
    checkInstance,
    claimedPins,
    clockPin,
    toBinding,
    findReaderInstances,
    findDeviceInputConflicts,
    matchedDrivers,
    paramsOf,
    listenedPins,
    defaultPin,
    withDefaults
};
if (typeof module !== "undefined") {
    module.exports = exports;
}
