const pruRegisterAllocator = system.getScript("/pru_blocks/common/register_allocation/pru_register_allocator.js");
const pruDMEM0 = system.getScript("/pru_blocks/common/simulation/pru_dmem0.js");
const pruSMEM = system.getScript("/pru_blocks/common/simulation/pru_smem.js");
const pruSimulator =  system.getScript("/pru_blocks/common/simulation/pru_core.js");
const deviceBusScript = system.getScript("/pru_blocks/common/simulation/device_bus.js");
const deviceModelsScript = system.getScript("/pru_blocks/common/simulation/device_models.js");
// Kinds, typed fields and manifest conversion of the Device Model block
const deviceModelTable = system.getScript("/pru_blocks/common/device_model_table.js");
// Launcher glue for the "Run on TI pru-simulator" button
const tiRun = system.getScript("/pru_blocks/common/pru_ti_run.js");
// Single-source device capability table (TRM SPRUIM2J §6.4.1.1 / SPRUJB6 §7.3.1.1)
let pruDeviceCaps = null;
try {
    pruDeviceCaps = system.getScript("/pru_blocks/common/pru_device_caps.js");
} catch (e) {
    try { pruDeviceCaps = system.getScript("/pru_blocks/common/pru_device_caps"); } catch (e2) { /* capsule unavailable in test stub */ }
}
const simulationData = {cycleCount : [], r30Bits : [], r31Bits : [], deviceResults : []};

// ============================================================================
// R31 Simulation Input Functions
// ============================================================================
/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
	let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
	if(result==0)return "PRU0";
    return "PRU1";
}
/**
 * Helper function to validate timestamp input for a specific GPI pin
 */
function validateTimestampInput(inst, report, pinNum) {
    const cyclesField = `gpi${pinNum}_inputCycles`;
    const valuesField = `gpi${pinNum}_inputValues`;

    let inputCycles, inputValues;
    try {
        inputCycles = JSON.parse(inst[cyclesField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Cycles format. Use JSON array syntax like [100, 105, 110]`, inst, cyclesField);
        return false;
    }

    try {
        inputValues = JSON.parse(inst[valuesField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Values format. Use JSON array syntax like [1, 0, 1]`, inst, valuesField);
        return false;
    }

    if (!Array.isArray(inputCycles)) {
        report.logError(`GPI${pinNum} Cycles must be an array. Example: [100, 105, 110]`, inst, cyclesField);
        return false;
    }

    if (!Array.isArray(inputValues)) {
        report.logError(`GPI${pinNum} Values must be an array. Example: [1, 0, 1]`, inst, valuesField);
        return false;
    }

    if (inputCycles.length !== inputValues.length) {
        report.logError(
            `GPI${pinNum} Cycles (${inputCycles.length} elements) and GPI${pinNum} Values (${inputValues.length} elements) must have the same length`,
            inst,
            cyclesField
        );
        return false;
    }

    // Validate that all cycles are positive integers (minimum 1, since cycle 0 is not displayed)
    for (let i = 0; i < inputCycles.length; i++) {
        if (!Number.isInteger(inputCycles[i]) || inputCycles[i] < 1) {
            report.logError(`GPI${pinNum} Cycles must contain positive integers (minimum 1). Invalid value at index ${i}: ${inputCycles[i]}`, inst, cyclesField);
            return false;
        }
    }

    // Validate that cycles are in ascending order
    for (let i = 1; i < inputCycles.length; i++) {
        if (inputCycles[i] <= inputCycles[i-1]) {
            report.logError(`GPI${pinNum} Cycles must be in strictly ascending order. Found ${inputCycles[i-1]} followed by ${inputCycles[i]} at index ${i}`, inst, cyclesField);
            return false;
        }
    }

    // Validate that all values are 0 or 1
    for (let i = 0; i < inputValues.length; i++) {
        if (inputValues[i] !== 0 && inputValues[i] !== 1) {
            report.logError(`GPI${pinNum} Values must be 0 or 1. Invalid value at index ${i}: ${inputValues[i]}`, inst, valuesField);
            return false;
        }
    }

    return true;
}

/**
 * Helper function to validate pattern input for a specific GPI pin
 */
function validatePatternInput(inst, report, pinNum) {
    const patternField = `gpi${pinNum}_bitPattern`;
    const startCycleField = `gpi${pinNum}_patternStartCycle`;
    const repeatCountField = `gpi${pinNum}_patternRepeatCount`;

    let bitPattern;
    try {
        bitPattern = JSON.parse(inst[patternField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Pattern format. Use JSON array syntax like [0, 1, 1, 0]`, inst, patternField);
        return false;
    }

    if (!Array.isArray(bitPattern)) {
        report.logError(`GPI${pinNum} Pattern must be an array. Example: [0, 1, 1, 0]`, inst, patternField);
        return false;
    }

    if (bitPattern.length === 0) {
        report.logError(`GPI${pinNum} Pattern cannot be empty`, inst, patternField);
        return false;
    }

    // Validate that all pattern values are 0 or 1
    for (let i = 0; i < bitPattern.length; i++) {
        if (bitPattern[i] !== 0 && bitPattern[i] !== 1) {
            report.logError(`GPI${pinNum} Pattern values must be 0 or 1. Invalid value at index ${i}: ${bitPattern[i]}`, inst, patternField);
            return false;
        }
    }

    // Validate start cycle (minimum 1, since cycle 0 is not displayed)
    if (!Number.isInteger(inst[startCycleField]) || inst[startCycleField] < 1) {
        report.logError(`GPI${pinNum} Pattern Start Cycle must be a positive integer (minimum 1)`, inst, startCycleField);
        return false;
    }

    // Validate pattern repeat count
    if (!Number.isInteger(inst[repeatCountField]) || inst[repeatCountField] < 1) {
        report.logError(`GPI${pinNum} Pattern Repeat Count must be a positive integer (minimum 1)`, inst, repeatCountField);
        return false;
    }

    return true;
}

/**
 * Helper function to validate device-mode input for a specific GPI pin.
 *
 * Device mode is the one input mode where the user is not authoring the
 * waveform, so the failure it must guard against is different: a device
 * configured onto the wrong pins, or with a parameter the model will silently
 * drop. Both produce a simulation that runs happily and proves nothing, which
 * is exactly the outcome attaching a real model is supposed to prevent.
 */
function validateDeviceInput(inst, report, pinNum) {
    const kindField = `gpi${pinNum}_deviceKind`;
    const clockField = `gpi${pinNum}_deviceClockPin`;
    const indexField = `gpi${pinNum}_deviceIndexPin`;
    const paramsField = `gpi${pinNum}_deviceParams`;

    const clockPin = inst[clockField];
    const indexPin = inst[indexField];

    for (const [field, value, label] of [[clockField, clockPin, "Clock/B"],
                                         [indexField, indexPin, "Index/Z"]]) {
        if (value !== -1 && (!Number.isInteger(value) || value < 0 || value > 19)) {
            report.logError(`GPI${pinNum} Device ${label} Pin must be 0-19, or -1 if unused`, inst, field);
            return false;
        }
        if (value === pinNum) {
            report.logError(`GPI${pinNum} Device ${label} Pin cannot be the same pin as the device's primary pin (${pinNum})`, inst, field);
            return false;
        }
    }

    if (clockPin === -1 && indexPin !== -1) {
        report.logError(`GPI${pinNum} Device Index/Z Pin is set but Clock/B Pin is not. A device cannot have a third pin without a second.`, inst, indexField);
        return false;
    }

    if (clockPin !== -1 && clockPin === indexPin) {
        report.logError(`GPI${pinNum} Device Clock/B and Index/Z cannot be the same pin (${clockPin})`, inst, indexField);
        return false;
    }

    // Devices that cannot work on a single pin. Caught here rather than at run
    // time, because a clocked slave with no clock produces an idle trace that
    // looks like a firmware that never ran.
    const MULTI_PIN = ["ssi", "bissc", "bissline", "endat", "tca9538", "sigma_delta"];
    if (MULTI_PIN.indexOf(inst[kindField]) !== -1 && clockPin === -1) {
        report.logError(`Device "${inst[kindField]}" is a clocked device and needs a Clock pin. Set GPI${pinNum} Device Clock/B Pin.`, inst, clockField);
        return false;
    }

    let params;
    try {
        params = JSON.parse(inst[paramsField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Device Parameters. Use JSON object syntax like {"bits": 13}`, inst, paramsField);
        return false;
    }

    if (params === null || typeof params !== "object" || Array.isArray(params)) {
        report.logError(`GPI${pinNum} Device Parameters must be a JSON object. Example: {"bits": 13}`, inst, paramsField);
        return false;
    }

    // Pin assignments belong in the pin fields above. Accepting them here too
    // would give two sources of truth for the same fact, and they would drift.
    for (const reserved of ["clk_pin", "data_pin", "a_pin", "b_pin", "z_pin", "pin"]) {
        if (Object.prototype.hasOwnProperty.call(params, reserved)) {
            report.logError(`GPI${pinNum} Device Parameters must not set "${reserved}" - pins come from the pin fields above`, inst, paramsField);
            return false;
        }
    }

    return true;
}

/**
 * Default a device binding's companion pins from the bound block's own pin
 * configuration.
 *
 * The per-pin idiom makes the user name companions by hand, but the design
 * already says where the device lives: an SSI initiator block carries clkPin
 * and dataPin, a quadrature block carries aBit/bBit/zBit. When the block is
 * present and its data/A pin is the binding's primary pin, the companions
 * default from the block. Anything the user set explicitly always wins -
 * a default that overrode an explicit choice would be a second source of
 * truth.
 *
 * Returns {clockPin, indexPin}: the EFFECTIVE companion pins for pinNum.
 */
function devicePinDefaults(inst, pinNum, kind) {
    let clockPin = inst[`gpi${pinNum}_deviceClockPin`];
    let indexPin = inst[`gpi${pinNum}_deviceIndexPin`];

    if (typeof system === "undefined" || !system.modules) {
        return { clockPin, indexPin };
    }

    const firstPinOf = (moduleName, pinFields, matchField) => {
        const mod = system.modules[moduleName];
        if (!mod || !mod.$instances) return null;
        for (const blockInst of mod.$instances) {
            if (Number(blockInst[matchField]) === pinNum) {
                return pinFields.map(f => Number(blockInst[f]));
            }
        }
        return null;
    };

    // Registered companion-pin sources (device_model_table.js COMPANION_PIN_BLOCKS).
    for (const entry of deviceModelTable.COMPANION_PIN_BLOCKS[kind] || []) {
        const pins = firstPinOf(entry.module, [entry.clockField, entry.indexField], entry.matchField);
        if (!pins) continue;
        if (entry.clockField && clockPin === -1 && Number.isInteger(pins[0]) && pins[0] >= 0) {
            clockPin = pins[0];
        }
        if (entry.indexField && indexPin === -1 && Number.isInteger(pins[1]) && pins[1] >= 0) {
            indexPin = pins[1];
        }
        break;
    }

    return { clockPin, indexPin };
}

/**
 * Validate R31 simulation input configuration
 */
function validateR31SimulationInput(inst, report) {
    // Get the list of selected pins from signalsToDisplayR31
    const selectedPins = inst.signalsToDisplayR31 || [];

    // Validate each selected pin
    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        const inputModeField = `gpi${pinNum}_inputMode`;
        const inputMode = inst[inputModeField];

        if (inputMode === "timestamp") {
            if (!validateTimestampInput(inst, report, pinNum)) {
                return false;
            }
        } else if (inputMode === "pattern") {
            if (!validatePatternInput(inst, report, pinNum)) {
                return false;
            }
        } else if (inputMode === "device") {
            // Validate against the EFFECTIVE pins (user fields, defaulted
            // from the bound block's own pin config where left unset), so a
            // clocked device whose clock comes from the block is not refused
            // for a field the design already answers.
            const kind = inst[`gpi${pinNum}_deviceKind`];
            const defaults = devicePinDefaults(inst, pinNum, kind);
            const effectiveInst = Object.assign({}, inst, {
                [`gpi${pinNum}_deviceClockPin`]: defaults.clockPin,
                [`gpi${pinNum}_deviceIndexPin`]: defaults.indexPin
            });
            if (!validateDeviceInput(effectiveInst, report, pinNum)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Collect every device-mode binding from the static module config.
 *
 * Returns { bindings, errors }. Each binding is { pinNum, kind, clockPin,
 * indexPin, params } with companions already defaulted from the bound
 * block's pin config (devicePinDefaults). Each error is { message, pinNum,
 * field } - a binding that cannot be constructed is a CONFIG error, never a
 * silently skipped device: an attached device that quietly did nothing
 * would produce a run that proves nothing while looking like a pass.
 */
function collectDeviceBindings(inst) {
    const bindings = [];
    const errors = [];
    const selectedPins = inst.signalsToDisplayR31 || [];

    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        if (inst[`gpi${pinNum}_inputMode`] !== "device") {
            continue;
        }

        const kindField = `gpi${pinNum}_deviceKind`;
        const paramsField = `gpi${pinNum}_deviceParams`;
        const kind = inst[kindField];
        const defaults = devicePinDefaults(inst, pinNum, kind);

        let params;
        try {
            params = JSON.parse(inst[paramsField]);
        } catch (e) {
            // Already refused by validateDeviceInput; do not double-report.
            continue;
        }
        if (params === null || typeof params !== "object" || Array.isArray(params)) {
            continue;
        }

        try {
            const device = deviceModelsScript.createDeviceModel(kind, {
                primary: pinNum,
                clock: defaults.clockPin,
                index: defaults.indexPin
            }, params);
            bindings.push({
                pinNum,
                kind,
                clockPin: defaults.clockPin,
                indexPin: defaults.indexPin,
                params,
                device
            });
        } catch (e) {
            // Factory refusals (unknown kind, kind not yet ported to the
            // in-tool simulator, unknown or reserved parameter keys,
            // out-of-range constructor values) are config errors. The field
            // is named so the error lands on the control that caused it.
            const isKindProblem = /unknown device kind|not available in the in-tool/.test(e.message);
            errors.push({
                message: `GPI${pinNum} attached device: ${e.message}`,
                pinNum,
                field: isKindProblem ? kindField : paramsField
            });
        }
    }

    return { bindings, errors };
}

/**
 * Measure the clock the firmware actually produced, from the R30 trace.
 *
 * Returns { observedMinPeriod, observedMinHigh, observedMinLow } in cycles,
 * or nulls when the clock never toggled. This is a MEASUREMENT on the
 * waveform, not a restatement of the block's configured timing - the two
 * differ exactly when the firmware is wrong, which is when the number
 * matters. (A margin read from the config instead of the trace would be a
 * formula standing in for a measurement.)
 */
function measureClockWaveform(r30ValueHistory, clkPin) {
    const bit = 1 << clkPin;
    let prev = null;
    let lastChange = null;
    const periods = [];
    const pulses = [];
    let lastFall = null;

    for (let cycle = 1; cycle < r30ValueHistory.length; cycle++) {
        const level = (r30ValueHistory[cycle] & bit) ? 1 : 0;
        if (prev === null) {
            prev = level;
            lastChange = 1;
            if (level === 0) lastFall = 1;
            continue;
        }
        if (level !== prev) {
            pulses.push(cycle - lastChange);
            if (level === 0) {           // falling edge
                if (lastFall !== null) {
                    periods.push(cycle - lastFall);
                }
                lastFall = cycle;
            }
            lastChange = cycle;
            prev = level;
        }
    }

    const min = (arr) => arr.length ? Math.min.apply(null, arr) : null;
    return {
        observedMinPeriod: min(periods),
        observedMinPulse: min(pulses),
        edges: periods.length + 1
    };
}

/**
 * Build the per-device run result: protocol decode, faults, verdict, margin.
 *
 * Verdict rules are fail-closed:
 *   PASS  the device observed no protocol violation AND at least one
 *         protocol event was decoded. An attached device that never spoke
 *         proves nothing - that run is a FAIL, not a pass.
 *   FAIL  any fault, or silence.
 *
 * The margin is the measured slack on the device's tightest timing limit:
 * for a clocked slave, the observed minimum clock period minus the model's
 * minimum. Reported in cycles, measured from the R30 trace.
 */
function buildDeviceRunResults(bus, bindings, r30ValueHistory, pruState) {
    const results = [];
    const skippedMacros = (pruState && pruState.skippedMacroCount > 0 && pruState.skippedMacros && pruState.skippedMacros.length > 0)
        ? pruState.skippedMacros
        : [];
    for (const binding of bindings) {
        const device = binding.device;
        const events = device.events ? device.events() : [];
        const faults = device.faults ? device.faults() : [];

        let margin = null;
        if (binding.clockPin !== -1 && device.minClkPeriodCycles !== undefined) {
            const measured = measureClockWaveform(r30ValueHistory, binding.clockPin);
            if (measured.observedMinPeriod !== null) {
                margin = {
                    observedMinPeriodCycles: measured.observedMinPeriod,
                    requiredMinPeriodCycles: device.minClkPeriodCycles,
                    slackCycles: measured.observedMinPeriod - device.minClkPeriodCycles
                };
            }
        }

        const verdict = (faults.length === 0 && events.length > 0) ? "PASS" : "FAIL";
        let summary;
        if (verdict === "PASS") {
            summary = `PASS - ${events.length} protocol event(s) decoded` +
                (margin ? `, clock margin ${margin.slackCycles} cycle(s) ` +
                 `(measured min period ${margin.observedMinPeriodCycles}, ` +
                 `device limit ${margin.requiredMinPeriodCycles})` : "");
        } else {
            const reasons = [];
            if (events.length === 0) {
                // When the JS preview skipped one or more macro calls, explain
                // that macro blocks cannot be executed in the preview instead of falsely
                // claiming that the device was silent.
                if (skippedMacros.length > 0) {
                    reasons.push(`the GUI preview cannot execute macro blocks (${skippedMacros.join(", ")}); ` +
                                 `use Run on TI pru-simulator / gmake sim`);
                } else {
                    reasons.push("no protocol activity decoded - the device never spoke, " +
                                 "so this run proves nothing");
                }
            }
            if (faults.length > 0) {
                reasons.push(`${faults.length} protocol violation(s), first: ${faults[0]}`);
            }
            summary = `FAIL - ${reasons.join("; ")}`;
        }

        results.push({
            device: device.name,
            kind: binding.kind,
            pins: { primary: binding.pinNum, clock: binding.clockPin, index: binding.indexPin },
            decode: events,
            faults,
            verdict,
            margin,
            summary
        });
    }
    return results;
}

/**
 * Generate history for a single GPI pin
 */
function generatePinHistory(inst, pinNum) {
    const inputModeField = `gpi${pinNum}_inputMode`;
    const inputMode = inst[inputModeField];
    const pinHistory = {};

    // Device mode drives this pin from a behavioural model at run time, so it
    // has no statically authored history. Returning {} explicitly matters: the
    // fall-through below is TIMESTAMP mode, and a device pin landing there
    // reads empty inputCycles/inputValues and yields a flat idle pin - which
    // looks exactly like a firmware that never ran. Fail visibly as nothing
    // rather than invisibly as zero.
    if (inputMode === "device") {
        return {};
    }

    if (inputMode === "pattern") {
        // Pattern mode
        const patternField = `gpi${pinNum}_bitPattern`;
        const startCycleField = `gpi${pinNum}_patternStartCycle`;
        const repeatCountField = `gpi${pinNum}_patternRepeatCount`;

        let bitPattern;
        try {
            bitPattern = JSON.parse(inst[patternField]);
        } catch(e) {
            // Invalid JSON - return empty history, validation will show error
            return {};
        }

        if (!Array.isArray(bitPattern) || bitPattern.length === 0) {
            return {};
        }

        const startCycle = inst[startCycleField];
        const repeatCount = inst[repeatCountField];

        let currentCycle = startCycle;

        // Repeat pattern for the specified number of times
        for (let repeat = 0; repeat < repeatCount; repeat++) {
            for (let i = 0; i < bitPattern.length; i++) {
                pinHistory[currentCycle] = bitPattern[i];
                currentCycle++;
            }
        }
    } else {
        // Timestamp mode
        const cyclesField = `gpi${pinNum}_inputCycles`;
        const valuesField = `gpi${pinNum}_inputValues`;
        const repeatLastBitField = `gpi${pinNum}_repeatLastBit`;

        let inputCycles, inputValues;
        try {
            inputCycles = JSON.parse(inst[cyclesField]);
            inputValues = JSON.parse(inst[valuesField]);
        } catch(e) {
            // Invalid JSON - return empty history, validation will show error
            return {};
        }

        if (!Array.isArray(inputCycles) || !Array.isArray(inputValues) || inputCycles.length === 0) {
            return {};
        }

        const repeatLastBit = inst[repeatLastBitField];

        // Build history from timestamps
        for (let i = 0; i < inputCycles.length; i++) {
            const cycle = inputCycles[i];
            const value = inputValues[i];
            pinHistory[cycle] = value;
        }

        // Fill in intermediate cycles and handle repeat last bit
        const maxCycle = inputCycles[inputCycles.length - 1];
        let lastValue = 0;

        for (let cycle = 0; cycle <= maxCycle; cycle++) {
            if (pinHistory[cycle] !== undefined) {
                lastValue = pinHistory[cycle];
            } else {
                pinHistory[cycle] = lastValue;
            }
        }

        // Handle repeat last bit for cycles beyond the last timestamp
        if (repeatLastBit) {
            const finalValue = inputValues[inputValues.length - 1];
            const globalSimulationCycles = inst.pruCyclesToSimulate || 2000;
            // Extend to the global simulation length
            for (let cycle = maxCycle + 1; cycle <= globalSimulationCycles; cycle++) {
                pinHistory[cycle] = finalValue;
            }
        }
    }

    return pinHistory;
}

/**
 * Build the device-binding manifest for the generated output.
 *
 * WHY THIS IS A FILE AND NOT A GUI FEATURE
 * The Python device models on TI pru-simulator are the reference; the SysConfig GUI can only execute JavaScript and must never
 * become the authority. So the binding the user configures here is EMITTED,
 * and the build runs the real model against it. This function produces that
 * emission and nothing else - it does not simulate.
 *
 * The pin fields in the GUI are generic on purpose (primary / clock-B /
 * index-Z) because one selector has to cover eight different devices. The
 * translation from those generic names to each model's own argument names is
 * deliberately NOT done here: it lives in scripts/sim/device_bindings.py,
 * next to the models it must agree with, so a model that renames a pin breaks
 * a Python test rather than silently producing an idle trace. What is emitted
 * here is the user's intent in the GUI's own vocabulary.
 *
 * Pure: takes the static instance, returns an object. No I/O, no globals, so
 * it can be tested outside the SysConfig runtime - which matters, because
 * SysConfig cannot be loaded outside its own runtime.
 */
function buildDeviceBindings(inst) {
    const selectedPins = inst.signalsToDisplayR31 || [];
    const bindings = [];

    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        if (inst[`gpi${pinNum}_inputMode`] !== "device") {
            continue;
        }

        // Validation has already run by the time templates are expanded, so a
        // malformed params string cannot reach here through the GUI. Guard
        // anyway and emit null rather than crashing the whole generation: a
        // template that throws takes every other generated file down with it.
        let params = null;
        try {
            params = JSON.parse(inst[`gpi${pinNum}_deviceParams`]);
        } catch (e) {
            params = null;
        }

        const clockPin = inst[`gpi${pinNum}_deviceClockPin`];
        const indexPin = inst[`gpi${pinNum}_deviceIndexPin`];

        bindings.push({
            primaryPin: pinNum,
            kind: inst[`gpi${pinNum}_deviceKind`],
            // -1 is the GUI's "unused"; null carries that across JSON without
            // the consumer having to know the sentinel.
            clockPin: (clockPin === -1 || clockPin === undefined) ? null : clockPin,
            indexPin: (indexPin === -1 || indexPin === undefined) ? null : indexPin,
            params: (params === null || typeof params !== "object" || Array.isArray(params)) ? {} : params
        });
    }

    // Sorted so the manifest is stable across GUI selection order. An emitted
    // file that reorders itself between runs shows up as a spurious diff.
    bindings.sort(function (a, b) { return a.primaryPin - b.primaryPin; });

    return {
        // Bumped when the SHAPE changes, so the Python consumer can refuse a
        // manifest it does not understand instead of half-reading it.
        version: 1,
        pruClkFreqMhz: inst.pruClkFreq,
        cyclesToSimulate: inst.pruCyclesToSimulate,
        bindings: bindings
    };
}

/**
 * The pins every GPI device binding occupies, for the Device Model block's
 * conflict check. Returns [{pinNum, kind, pins: [{pin, label}]}].
 * Uses the EFFECTIVE companion pins (devicePinDefaults), the same pins the
 * device would really be wired to, not just the raw fields.
 * BuildDeviceBindings emits the RAW fields (an unset companion pin is null in the
 * manifest); this check claims the effective pin on purpose - the device is wired there either
 * way, so a Device Model on that pin is a real short even though the manifest omits it.
 */
function collectGpiDeviceClaims(inst) {
    const claims = [];
    for (const pinNumStr of inst.signalsToDisplayR31 || []) {
        const pinNum = parseInt(pinNumStr);
        if (inst[`gpi${pinNum}_inputMode`] !== "device") {
            continue;
        }
        const kind = inst[`gpi${pinNum}_deviceKind`];
        const eff = devicePinDefaults(inst, pinNum, kind);
        const pins = [{ pin: pinNum, label: "primary pin" }];
        if (eff.clockPin !== -1 && eff.clockPin !== undefined) pins.push({ pin: eff.clockPin, label: "Clock/B pin" });
        if (eff.indexPin !== -1 && eff.indexPin !== undefined) pins.push({ pin: eff.indexPin, label: "Index/Z pin" });
        claims.push({ pinNum, kind, pins });
    }
    return claims;
}

/**
 * The device-binding manifest from BOTH sources: the GPI device
 * fields (buildDeviceBindings, unchanged) plus every Device Model block
 * instance. Same shape either way, so the consumer cannot tell them apart.
 * With no Device Model instance this returns exactly buildDeviceBindings(inst).
 */
function buildDeviceBindingsWithModels(inst, modules) {
    const manifest = buildDeviceBindings(inst);
    const dm = modules ? modules["/pru_blocks/utils/device_model_block"] : null;
    let added = false;
    for (const mi of (dm && dm.$instances) || []) {
        if (!deviceModelTable.KINDS[mi.deviceKind]) {
            continue;
        }
        manifest.bindings.push(deviceModelTable.toBinding(mi));
        added = true;
    }
    if (added) {
        manifest.bindings.sort(function (a, b) { return a.primaryPin - b.primaryPin; });
    }
    return manifest;
}

/**
 * Record, on each binding, which block reads the bound device and which
 * register the allocator gave that block's result.
 *
 * WHY: `gmake sim` compares the firmware's decoded value with the device
 * model. The register holding that value is not a property of the block - the
 * allocator chooses it per design (a value live across the read pushes a BiSS
 * read from R0 to R1). A checker that assumed a fixed register reported a
 * false FAIL on correct GUI firmware. The allocator's own answer is the only
 * source of truth, so it is emitted here, next to the binding it belongs to.
 *
 * A reader is an instance of a block known to decode the device kind whose
 * DATA pin is the binding's primary (device-driven) pin. For each reader:
 *   resultRegister  the allocator's notation for output1 ("R1", "R0.w0"),
 *                   or null if the block got no output register
 *   laterWriters    blocks emitted AFTER the reader whose allocated register
 *                   overlaps it; the value left at HALT is then not the read
 *
 * Kinds absent from the table get no `readers` key: the runner has no
 * decoder for them and says NOT CHECKED. A kind in the table with no matching
 * block gets `readers: []`, which the runner reports instead of guessing.
 *
 * Pure: the module map and the allocator are passed in, so the function can be
 * evaluated outside the SysConfig runtime (by node tests).
 *
 * @param manifest   buildDeviceBindings() output; annotated in place and returned
 * @param modules    system.modules
 * @param allocation { registerOf(name) -> allocator notation or "-",
 *                     order: instance names in emitted-instruction order }
 */
function resolveDeviceReaders(manifest, modules, allocation) {
    const READER_BLOCKS = deviceModelTable.READER_BLOCKS;
    // Byte ranges [start, end) a notation such as "R1", "R0.b2", "R3.w1" covers.
    function byteRanges(notation) {
        const ranges = [];
        const re = /R(\d+)(?:\.(b|w)(\d))?/g;
        let m;
        while ((m = re.exec(String(notation))) !== null) {
            const base = Number(m[1]) * 4;
            if (m[2] === "b") {
                ranges.push([base + Number(m[3]), base + Number(m[3]) + 1]);
            } else if (m[2] === "w") {
                ranges.push([base + Number(m[3]), base + Number(m[3]) + 2]);
            } else {
                ranges.push([base, base + 4]);
            }
        }
        return ranges;
    }
    function overlaps(a, b) {
        return a.some(function (x) {
            return b.some(function (y) { return x[0] < y[1] && y[0] < x[1]; });
        });
    }

    const order = (allocation && allocation.order) || [];
    for (const binding of manifest.bindings || []) {
        const table = READER_BLOCKS[binding.kind];
        if (!table) {
            continue;
        }
        const readers = [];
        for (const entry of table) {
            const mod = modules ? modules[entry.module] : null;
            for (const inst of (mod && mod.$instances) || []) {
                if (Number(inst[entry.dataPinField]) !== binding.primaryPin) {
                    continue;
                }
                const notation = allocation.registerOf(inst.$name);
                const own = (notation && notation !== "-") ? notation.split(",")[0].trim() : null;
                const laterWriters = [];
                const at = order.lastIndexOf(inst.$name);
                if (own && at !== -1) {
                    const mine = byteRanges(own);
                    for (const other of order.slice(at + 1)) {
                        if (other === inst.$name || laterWriters.indexOf(other) !== -1) {
                            continue;
                        }
                        const theirs = allocation.registerOf(other);
                        if (theirs && theirs !== "-" && overlaps(mine, byteRanges(theirs))) {
                            laterWriters.push(other);
                        }
                    }
                }
                readers.push({ block: inst.$name, module: entry.module,
                               resultRegister: own, laterWriters: laterWriters });
            }
        }
        readers.sort(function (a, b) { return a.block < b.block ? -1 : a.block > b.block ? 1 : 0; });
        binding.readers = readers;
    }
    return manifest;
}

/**
 * Main function to generate R31 history by combining all enabled GPI pins
 */
function generateR31HistoryFromStaticModule(inst) {
    const r31History = {};
    const selectedPins = inst.signalsToDisplayR31 || [];

    // Generate history for each selected pin
    const pinHistories = [];
    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        pinHistories.push({
            pinNum: pinNum,
            history: generatePinHistory(inst, pinNum)
        });
    }

    // Find the maximum cycle across all pins
    let maxCycle = 0;
    for (const pinData of pinHistories) {
        const cycles = Object.keys(pinData.history).map(Number);
        if (cycles.length > 0) {
            maxCycle = Math.max(maxCycle, ...cycles);
        }
    }

    // Combine all pin histories into R31 values
    for (let cycle = 0; cycle <= maxCycle; cycle++) {
        let r31Value = 0;

        for (const pinData of pinHistories) {
            if (pinData.history[cycle] === 1) {
                r31Value |= (1 << pinData.pinNum);
            }
        }

        r31History[cycle] = r31Value;
    }

    return r31History;
}

// onChange handler for the R31 signals selection
function onSignalsToDisplayR31Change(inst, ui) {
    if (!ui) return;

    const selectedPins = inst.signalsToDisplayR31 || [];

    // Show/hide configuration for each pin based on selection
    for (let pinNum = 0; pinNum <= 19; pinNum++) {
        const isSelected = selectedPins.includes(String(pinNum));
        const inputMode = inst[`gpi${pinNum}_inputMode`];
        const isTimestamp = (inputMode === "timestamp");
        const isPattern = (inputMode === "pattern");
        const isDevice = (inputMode === "device");

        // Show/hide separator
        if (ui[`gpi${pinNum}_separator`]) {
            ui[`gpi${pinNum}_separator`].hidden = !isSelected;
        }

        // Show/hide input mode selector
        if (ui[`gpi${pinNum}_inputMode`]) {
            ui[`gpi${pinNum}_inputMode`].hidden = !isSelected;
        }

        // Show/hide timestamp fields
        if (ui[`gpi${pinNum}_inputCycles`]) {
            ui[`gpi${pinNum}_inputCycles`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_inputValues`]) {
            ui[`gpi${pinNum}_inputValues`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_repeatLastBit`]) {
            ui[`gpi${pinNum}_repeatLastBit`].hidden = !(isSelected && isTimestamp);
        }

        // Show/hide pattern fields
        if (ui[`gpi${pinNum}_bitPattern`]) {
            ui[`gpi${pinNum}_bitPattern`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternStartCycle`]) {
            ui[`gpi${pinNum}_patternStartCycle`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternRepeatCount`]) {
            ui[`gpi${pinNum}_patternRepeatCount`].hidden = !(isSelected && isPattern);
        }

        // Show/hide device fields
        if (ui[`gpi${pinNum}_deviceKind`]) {
            ui[`gpi${pinNum}_deviceKind`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceClockPin`]) {
            ui[`gpi${pinNum}_deviceClockPin`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceIndexPin`]) {
            ui[`gpi${pinNum}_deviceIndexPin`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceParams`]) {
            ui[`gpi${pinNum}_deviceParams`].hidden = !(isSelected && isDevice);
        }
    }
}

// Helper function to generate onChange handler for input mode selector
function createInputModeOnChange(pinNum) {
    return function(inst, ui) {
        if (!ui) return;

        const selectedPins = inst.signalsToDisplayR31 || [];
        const isSelected = selectedPins.includes(String(pinNum));
        const inputMode = inst[`gpi${pinNum}_inputMode`];
        const isTimestamp = (inputMode === "timestamp");
        const isPattern = (inputMode === "pattern");
        const isDevice = (inputMode === "device");

        // Show/hide timestamp fields
        if (ui[`gpi${pinNum}_inputCycles`]) {
            ui[`gpi${pinNum}_inputCycles`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_inputValues`]) {
            ui[`gpi${pinNum}_inputValues`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_repeatLastBit`]) {
            ui[`gpi${pinNum}_repeatLastBit`].hidden = !(isSelected && isTimestamp);
        }

        // Show/hide pattern fields
        if (ui[`gpi${pinNum}_bitPattern`]) {
            ui[`gpi${pinNum}_bitPattern`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternStartCycle`]) {
            ui[`gpi${pinNum}_patternStartCycle`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternRepeatCount`]) {
            ui[`gpi${pinNum}_patternRepeatCount`].hidden = !(isSelected && isPattern);
        }

        // Show/hide device fields
        if (ui[`gpi${pinNum}_deviceKind`]) {
            ui[`gpi${pinNum}_deviceKind`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceClockPin`]) {
            ui[`gpi${pinNum}_deviceClockPin`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceIndexPin`]) {
            ui[`gpi${pinNum}_deviceIndexPin`].hidden = !(isSelected && isDevice);
        }
        if (ui[`gpi${pinNum}_deviceParams`]) {
            ui[`gpi${pinNum}_deviceParams`].hidden = !(isSelected && isDevice);
        }
    };
}

/**
 * Generate configuration fields for R31 simulation input (for pins 0-19)
 */
function generateR31SimulationInputConfigs() {
    const configs = [];

    // Generate configuration fields for GPI pins 0-19 (hidden by default)
    for (let pinNum = 0; pinNum <= 19; pinNum++) {
        // Add a separator/header before each pin's configuration
        configs.push({
            name: `gpi${pinNum}_separator`,
            displayName: `━━━━━━━━━━ ${getPruNumberFromContext()}_GPI_${pinNum} Input Configuration ━━━━━━━━━━`,
            longDescription: `Configure simulation input data for GPI${pinNum} (R31 register bit ${pinNum})`,
            default: "",
            hidden: true,
            readOnly: true
        });

        // Input mode selector
        configs.push({
            name: `gpi${pinNum}_inputMode`,
            displayName: `GPI${pinNum} Input Mode`,
            description: "Choose between timestamp-based or pattern-based input",
            default: "timestamp",
            hidden: true,
            options: [
                { name: "timestamp", displayName: "Timestamp Mode" },
                { name: "pattern", displayName: "Pattern Mode" },
                { name: "device", displayName: "Attached Device Model" }
            ],
            onChange: createInputModeOnChange(pinNum)
        });

        // Device mode fields.
        //
        // Timestamp and Pattern mode both make the user hand-author the
        // waveform they expect a device to produce - which means the test
        // encodes what they BELIEVE the device does. If that belief is wrong,
        // the firmware passes against a fiction. Device mode replaces the
        // hand-authored bits with a behavioural model that also REJECTS
        // illegal traffic, so a wrong firmware fails instead of being
        // faithfully replayed against.
        configs.push({
            name: `gpi${pinNum}_deviceKind`,
            displayName: `GPI${pinNum} Device`,
            description: "Behavioural device model driving this pin",
            longDescription: `Attaches a simulated device to GPI${pinNum}. Unlike ` +
                `Timestamp and Pattern mode, the waveform is produced by a model ` +
                `of the real part rather than transcribed by hand, and the model ` +
                `reports protocol violations it observes.`,
            default: "quadrature",
            hidden: true,
            options: [
                { name: "quadrature", displayName: "Quadrature encoder (A/B/Z)" },
                { name: "ssi", displayName: "SSI absolute encoder" },
                { name: "bissc", displayName: "BiSS-C absolute encoder" },
                { name: "bissline", displayName: "BiSS Line absolute encoder" },
                { name: "endat", displayName: "EnDat 2.2 absolute encoder" },
                { name: "tca9538", displayName: "TCA9538 I2C IO expander" },
                { name: "uart", displayName: "UART transmitter" },
                { name: "sigma_delta", displayName: "Sigma-delta modulator" },
                { name: "spi_adc", displayName: "SPI ADC (ADS8688-class SPI mode 0)" },
                { name: "step_dir", displayName: "STEP/DIR stepper driver" },
                { name: "ws2812", displayName: "WS2812 addressable LED string" },
                { name: "mdio_phy", displayName: "MDIO Clause 22 PHY" }
            ]
        });

        // A device spans more than one pin, and SysConfig's per-pin config
        // cannot express that on its own. The pin selected above is the
        // device's PRIMARY pin (data/A); the companions are named here.
        //
        // This is deliberately the minimal shape that fits the existing
        // per-pin idiom. The fuller SysConfig answer is an instance-array
        // module, one instance per attached device, which is how TI models
        // multi-pin peripherals elsewhere. That is a larger change to the
        // static module's data flow and is not made here.
        configs.push({
            name: `gpi${pinNum}_deviceClockPin`,
            displayName: `GPI${pinNum} Device Clock/B Pin`,
            description: "Second pin: clock for clocked devices, B channel for quadrature. -1 if unused.",
            default: -1,
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_deviceIndexPin`,
            displayName: `GPI${pinNum} Device Index/Z Pin`,
            description: "Third pin: index/Z for incremental encoders. -1 if unused.",
            default: -1,
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_deviceParams`,
            displayName: `GPI${pinNum} Device Parameters`,
            description: 'JSON passed to the model constructor. Example: {"bits": 13, "position": 1024}',
            longDescription: "Model-specific configuration. Left empty, the model's " +
                "own defaults apply. Unknown keys are reported rather than ignored, " +
                "because a silently dropped parameter produces a model that is not " +
                "the one the user asked for.",
            default: "{}",
            hidden: true
        });

        // Timestamp mode fields
        configs.push({
            name: `gpi${pinNum}_inputCycles`,
            displayName: `GPI${pinNum} Input Cycles`,
            description: "PRU cycle numbers when bit value changes (minimum 1). Example: [100, 105, 110]",
            default: "[1]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_inputValues`,
            displayName: `GPI${pinNum} Input Values`,
            description: "Bit values (0 or 1) at each timestamp. Example: [1, 0, 1]",
            default: "[0]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_repeatLastBit`,
            displayName: `GPI${pinNum} Repeat Last Bit`,
            description: "Continue repeating the last bit value for all subsequent cycles",
            default: false,
            hidden: true
        });

        // Pattern mode fields
        configs.push({
            name: `gpi${pinNum}_bitPattern`,
            displayName: `GPI${pinNum} Bit Pattern`,
            description: "Bit pattern to repeat. Example: [0, 1, 1, 0]",
            default: "[1, 0]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_patternStartCycle`,
            displayName: `GPI${pinNum} Pattern Start Cycle`,
            description: "PRU cycle number where pattern starts (minimum 1)",
            default: 1,
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_patternRepeatCount`,
            displayName: `GPI${pinNum} Pattern Repeat Count`,
            description: "Number of times to repeat the pattern",
            default: 10,
            hidden: true
        });
    }

    return configs;
}

/**
 * Expands loop directives in the given macroBody.
 *
 * @param {string} macroBody - The macroBody to expand loop directives in.
 * @return {string} The macroBody with loop directives expanded.
 */
function expandLoopDirectives(macroBody) {
    // Split the macroBody into lines and trim each line
    const lines = macroBody.split('\n').map(line => line.trim());
    const result = [];
    
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        
        // Check if this line contains a .loop directive
        const loopMatch = line.match(/\.loop\s+(\d+)/);
        if (loopMatch) {
            const loopCount = parseInt(loopMatch[1], 10);
            const loopBodyLines = [];
            
            // Collect all lines until we find .endloop
            let j = i + 1;
            while (j < lines.length && !lines[j].includes('.endloop')) {
                loopBodyLines.push(lines[j]);
                j++;
            }
            
            // Skip the .loop line, loop body, and .endloop line
            i = j + 1;
            
            // Add the loop body repeated loopCount times
            for (let k = 0; k < loopCount; k++) {
                result.push(...loopBodyLines);
            }
        } else {
            // Regular line, just add it
            result.push(line);
            i++;
        }
    }
    
    return result.join('\n');
}

/**
 * Expands macros in the given PRU instructions.
 *
 * @param {Array} pruInstructionsWithMacros - Array of PRU instructions with macros.
 * @param {Array} pruInstructionsLabelWithMacros - Array of labels corresponding to the PRU instructions.
 * @return {Object} Object containing the expanded PRU instructions and their labels.
 */
function expandMacros(pruInstructionsWithMacros, pruInstructionsLabelWithMacros)
{
    let pruInstructionModules = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructionModules;
    let pruInstructions = [];
    let pruInstructionsLabels = [];
    let macroCount = 0;
    
    for(let i = 0; i < pruInstructionModules.length; i++)
    {
        // First check if the module exists and has a getMacro function
        let macroBody = (system.modules[pruInstructionModules[i]] && 
                         typeof system.modules[pruInstructionModules[i]].getMacro === 'function') ? 
                        system.modules[pruInstructionModules[i]].getMacro(pruInstructionsWithMacros[i], "") : 
                        undefined;
        
        if(macroBody) {
            // Expand the loop directives in the macro body
            macroBody = expandLoopDirectives(macroBody);
            // If there is macro body, call seperateInstructionsAndLabels
            let macroDefinition = seperateInstructionsAndLabels(macroCount, 
                                                    macroBody);   
		    // Handle case when label is added before macro in auto generated code and first instruction in macro
			pruInstructions.push(0);
			pruInstructionsLabels.push(pruInstructionsLabelWithMacros[i]);
            pruInstructions = pruInstructions.concat(macroDefinition.macroInstructions);
            pruInstructionsLabels = pruInstructionsLabels.concat(macroDefinition.macroInstructionsLabels);            
            //increment macro count
            macroCount++;
        }
        else {
            // No macro definition, use instruction as is (expanding multi-line instructions if present)
            if (typeof pruInstructionsWithMacros[i] === "string" && pruInstructionsWithMacros[i].includes("\n")) {
                let lines = pruInstructionsWithMacros[i].split("\n").map(l => l.trim()).filter(l => l && !l.startsWith(";"));
                pruInstructions.push(0);
                pruInstructionsLabels.push(pruInstructionsLabelWithMacros[i]);
                for (let line of lines) {
                    pruInstructions.push(line);
                    pruInstructionsLabels.push(0);
                }
            } else {
                pruInstructions.push(pruInstructionsWithMacros[i]);
                pruInstructionsLabels.push(pruInstructionsLabelWithMacros[i]);
            }
        }
    }

    return {pruInstructions, pruInstructionsLabels}
}

/**
 * Replaces temporary register placeholders with their actual register numbers
 * @param {Array} instructions - Array of PRU instructions that may contain TEMP_REG placeholders
 * @return {Array} Array of instructions with TEMP_REG placeholders replaced
 */
function replaceTemporaryRegisters(instructions) {
    return instructions.map(instruction => {
        // Skip if instruction is not a string (could be 0 or other values)
        if (typeof instruction !== 'string') {
            return instruction;
        }
        
        // Replace TEMP_REG1 with R28, TEMP_REG2 with R29, TEMP_REG3 with R26, TEMP_REG4 with R27
        return instruction
            .replace(/TEMP_REG1(\.\w+)?/g, 'R28$1')
            .replace(/TEMP_REG2(\.\w+)?/g, 'R29$1')
            .replace(/TEMP_REG3(\.\w+)?/g, 'R26$1')
            .replace(/TEMP_REG4(\.\w+)?/g, 'R27$1');
    });
}

/**
 * Retrieves the macro definition for a given instance.
 *
 * @param {number} macroCount - The macro count (? will be replaced with this value).
 * @param {string} macroBody - The macro body.
 * @return {Object} An object containing the macro instructions and their labels.
 */
function seperateInstructionsAndLabels(macroCount, macroBody)
{
    // If macroBody wasn't provided, try to get it from the module
    if (!macroBody) {
        return undefined;
    }
    
    const macroInstructions = [];
    const macroInstructionsLabels = [];
    
    // Split the macro body into lines
    const lines = macroBody.trim().split('\n');
    
    // Process the macro body (assuming only either label or instruction can be present in one line)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip empty lines and comments
        if (!line || line.startsWith(';')) {
            continue;
        }
    
        // Case 1: Line with both label and instruction
        if (line.includes(':') && line.split(':')[1].trim()) {
            const parts = line.split(':');
            const label = parts[0].trim().replace(/\?/g, macroCount);
            let instruction = parts[1].trim().replace(/\?/g, macroCount);
            
            macroInstructions.push(instruction);
            macroInstructionsLabels.push(label);
        }
        // Case 2: Line with only a label
        else if (line.includes(':')) {
            const label = line.split(':')[0].trim().replace(/\?/g, macroCount);
            
            macroInstructions.push(0);
            macroInstructionsLabels.push(label);
        }
        // Case 3: Line with only an instruction
        else {
            const instruction = line.replace(/\?/g, macroCount);
            
            macroInstructions.push(instruction);
            macroInstructionsLabels.push(0);
        }
    }
    
    return {
        macroInstructions,
        macroInstructionsLabels
    };
}


function getDataSectionContents()
{
    let dataSectionContents = [];
    let systemModules = system.modules;

    for (let module_name in systemModules) {
        let module = systemModules[module_name];
        if (module) {
            for (let iterator1 = 0; iterator1 < module.$instances.length; iterator1++) {
                let instance = module.$instances[iterator1];
                if (instance["lutName"] && (instance["lutName"]!="")) {
                    // Check if module has required functions
                    if (typeof module.getDataSize === 'function' &&
                        typeof module.getLookUptable === 'function') {

                        // Get memory location choice from config (dmem or smem), default to dmem if not specified
                        let memoryLocationChoice = instance["lutMemoryLocation"] || "dmem";

                        dataSectionContents.push({
                            symbolName: instance["lutName"],
                            symbolDataType: module.getDataSize(instance),
                            symbolData: module.getLookUptable(instance),
                            section: memoryLocationChoice  // Memory location: dmem or smem
                        });
                    }
                }
            }
        }
    }

    return dataSectionContents;
}

/**
 * Gets all .usect directives from Memory Reserve blocks
 * @returns {Array} Array of .usect directive strings
 */
function getUsectLinkerDirectives()
{
    let usectDirectives = new Set();
    let systemModules = system.modules;

    // Look for Memory Reserve module
    const memReserveModule = systemModules["/pru_blocks/utils/memory_variable_block"];
    if (memReserveModule && memReserveModule.$instances) {
        for (let instance of memReserveModule.$instances) {
            if (instance["labelName"] && instance["labelName"] !== "") {
                // Call the module's getUsectDirective function if available
                if (typeof memReserveModule.getUsectDirective === 'function') {
                    usectDirectives.add(memReserveModule.getUsectDirective(instance));
                } else {
                    // Fallback: construct directive directly (always 4-byte aligned)
                    const labelName = instance.labelName;
                    const sizeInBytes = instance.sizeInBytes;
                    const sectionName = instance.sectionName ;

                    usectDirectives.add(`${labelName}\t.usect "${sectionName}", ${sizeInBytes}, 1`);
                }
            }
        }
    }

    return Array.from(usectDirectives);
}

/**
 * Generate assembly code for initialized data sections (.initdmem and .initsmem)
 * Returns formatted assembly with section directives and data definitions
 * @returns {string} Assembly code for initialized data sections
 */
function getInitSectDirectives() {
    let assembly = "";

    const dataSectionContents = getDataSectionContents();
    if (!dataSectionContents || dataSectionContents.length === 0) {
        return assembly;
    }

    // Separate DMEM and SMEM data
    const dmemData = dataSectionContents.filter(item => item.section === "dmem" || !item.section);
    const smemData = dataSectionContents.filter(item => item.section === "smem");

    // Generate DMEM section (.initdmem) for initialized data
    if (dmemData.length > 0) {
        assembly += '    .sect       ".initdmem"\n';
        for (let item of dmemData) {
            assembly += `${item.symbolName} ${item.symbolDataType} ${item.symbolData}\n`;
        }
    }

    // Generate SMEM section (.initsmem) for initialized data
    if (smemData.length > 0) {
        assembly += '    .sect       ".initsmem"\n';
        for (let item of smemData) {
            assembly += `${item.symbolName} ${item.symbolDataType} ${item.symbolData}\n`;
        }
    }

    return assembly;
}

// ============================================================================
// constant-table pointer c28 (PRU shared RAM)
// ============================================================================
// c28 is only partially fixed: TRM SPRUIM2J Table 6-65 (PRU_ICSSG)
// gives c28 = 00nn_nn00h with nnnn = CTPPR0.C28_POINTER[15:0]. CTPPR0 sits at
// offset 28h of the core's own PRU_CTRL block and resets to 0
// (SPRUIM2J 14.3.6.1.1), so until firmware writes it every LBCO/SBCO through
// c28 hits local 0x00000000 -- the core's own data RAM -- not shared RAM.
// The design-wide fix lives here, once, rather than in each block: one write
// at every entry point into the generated code serves all c28 users and costs
// the per-call blocks that use c28 nothing.

// PRU_CTRL base of each SysConfig core context (core-local addresses).
// SPRUIM2J Table 6-65 entry 11 and the CTPPR0 instance table; SPRUJB6 confirms only the c28 pointer formula and the local control bases;
// the AM261x CTPPR0 offset 0x28 / reset 0 is INFERRED from the shared PRU-ICSS IP, not
// documented in SPRUJB6.
const PRU_CTRL_BASE_BY_CORE = [
    [/tx_pru(\d)$/,  n => 0x25000 + 0x800 * n],
    [/rtu_pru(\d)$/, n => 0x23000 + 0x800 * n],
    [/pru(\d)$/,     n => 0x22000 + 0x2000 * n],
];
const PRU_CTRL_CTPPR0 = 0x28;
const SHARED_RAM_LOCAL = 0x00010000;           // PRU-local view of shared RAM

function pruCtrlBase(coreName) {
    for (const [re, base] of PRU_CTRL_BASE_BY_CORE) {
        const m = (coreName || "").match(re);
        if (m) return base(parseInt(m[1]));
    }
    return null;
}

/** True when any instantiated block's macro addresses memory through c28. */
function designUsesC28(modules) {
    for (const moduleName in modules) {
        const module = modules[moduleName];
        if (!module || typeof module.getMacro !== "function" || !module.$instances) continue;
        for (const inst of module.$instances) {
            if (!inst || !inst.opCode) continue;
            if (/\bc28\b/i.test(module.getMacro("", inst.opCode))) return true;
        }
    }
    return false;
}

/**
 * Assembly that programs CTPPR0 so c28 = shared RAM (0x00010000). Empty when
 * no block in the design uses c28. Clobbers TEMP_REG1/TEMP_REG2 only.
 * C29_POINTER is written 0, its reset value; nothing in the library uses c29.
 */
function getCtppr0Setup(coreName, modules) {
    if (!designUsesC28(modules || system.modules)) return "";
    if (coreName === undefined) coreName = system.getScript("/common").getSelfSysCfgCoreName();
    const base = pruCtrlBase(coreName);
    if (base === null) {
        throw new Error(`No PRU_CTRL base known for core context '${coreName}'; ` +
                        "cannot program CTPPR0 for c28");
    }
    const ptr = SHARED_RAM_LOCAL >> 8;
    const hex = v => "0x" + v.toString(16).toUpperCase();
    return [
        `    ; c28 = CTPPR0.C28_POINTER << 8 and CTPPR0 resets to 0 (TRM SPRUIM2J`,
        `    ; Table 6-65, 14.3.6.1.1). Point c28 at shared RAM ${hex(SHARED_RAM_LOCAL)} for ${coreName}.`,
        `    ldi     TEMP_REG1, ${hex(ptr)}`,
        `    ldi32   TEMP_REG2, ${hex(base + PRU_CTRL_CTPPR0)}`,
        `    sbbo    &TEMP_REG1, TEMP_REG2, 0, 4`,
    ].join("\n");
}

// the pru_spi_* blocks' controller mode asserts CS with `clr r30, r30, <cs>` and releases it with `set`, but R30 resets to 0, so
// with nothing driving the pin high first the first transaction has no assertion edge. The prologue drives each distinct controller CS
// pin to its idle (inactive, high) level once; a peripheral block samples CS on R31 and must not drive it.
const SPI_MODULE_PATHS = [
    "/pru_blocks/pru_io_blocks/pru_spi_read",
    "/pru_blocks/pru_io_blocks/pru_spi_write",
    "/pru_blocks/pru_io_blocks/pru_spi_transfer",
];

/** Sorted distinct CS pin numbers (R30 bits) of every controller-mode pru_spi_* instance. */
function spiControllerCsPins(modules) {
    const pins = new Set();
    for (const path of SPI_MODULE_PATHS) {
        const module = (modules || system.modules)[path];
        if (!module || !module.$instances) continue;
        for (const inst of module.$instances) {
            if (inst && inst["Device Mode"] !== "peripheral") pins.add(Number(inst["CS Signal"]));
        }
    }
    return Array.from(pins).filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

function getSpiCsIdleSetup(modules) {
    const pins = spiControllerCsPins(modules);
    if (pins.length === 0) return "";
    return [`    ; drive each SPI controller CS pin to its idle (high) level once; R30 resets to 0, which would hide the first assertion edge.`]
        .concat(pins.map(n => `    set     r30, r30, ${n}`)).join("\n");
}

/**
 * Everything emitted by pru_syscfg.asm.xdt right after sysconfig_generated_start and every group start label: the CTPPR0
 * write (only when a block uses c28) and the CS idle level of the SPI controller blocks. Empty when neither applies.
 */
function getConstantTableSetup(coreName, modules) {
    return [getCtppr0Setup(coreName, modules), getSpiCsIdleSetup(modules)].filter(Boolean).join("\n");
}

// Instructions the CTPPR0 write costs at each entry (ldi + ldi32 (2) + sbbo). Counted
// as 4 cycles; a store to the PRU_CTRL peripheral may stall longer on silicon.
const CTPPR0_SETUP_CYCLES = 4;

/** Cycles of the SPI CS idle part of the prologue: one `set r30` per distinct controller CS pin. */
function getSpiCsIdleSetupCycles(modules) {
    return spiControllerCsPins(modules).length;
}

/** Cycles getConstantTableSetup() adds to every entry into generated code: CTPPR0 write (c28 users) + one `set r30` per SPI CS pin. */
function getConstantTableSetupCycles(modules) {
    return (designUsesC28(modules || system.modules) ? CTPPR0_SETUP_CYCLES : 0) + getSpiCsIdleSetupCycles(modules);
}

function prepareR30DataForPlotting(r30ValueHistory) {
    // Clear existing data
    simulationData.cycleCount = [];
    simulationData.r30Bits = [];

    // Get maxCycles from the length of r30ValueHistory
    const maxCycles = r30ValueHistory.length - 1;

    // Create cycle count array with pattern [1, 1.99999, 2, 2.99999, 3, ...] (skip cycle 0)
    for (let i = 1; i <= maxCycles; i++) {
        simulationData.cycleCount.push(i);
        simulationData.cycleCount.push(i + 0.99999); // Add the value just before the next integer
    }

    // Initialize r30Bits array with empty arrays for each bit (0-20)
    for (let bit = 0; bit <= 20; bit++) {
        simulationData.r30Bits[bit] = [];
    }

    // For each cycle, extract each bit value from r30ValueHistory and duplicate for the stepped pattern
    // Start from index 1 to skip cycle 0
    for (let i = 1; i <= maxCycles; i++) {
        const value = r30ValueHistory[i] || 0;

        for (let bit = 0; bit <= 20; bit++) {
            // Extract bit value using bitwise AND and shift
            const bitValue = (value & (1 << bit)) ? 1 : 0;

            // Add the same bit value twice - once for the integer and once for the x.99999
            simulationData.r30Bits[bit].push(bitValue);
            simulationData.r30Bits[bit].push(bitValue);
        }
    }
}

function prepareR31DataForPlotting(r31ValueHistory) {
    // Clear existing R31 data
    simulationData.r31Bits = [];

    // Get maxCycles from the length of r31ValueHistory
    const maxCycles = r31ValueHistory.length - 1;

    // Initialize r31Bits array with empty arrays for each bit (0-20)
    for (let bit = 0; bit <= 20; bit++) {
        simulationData.r31Bits[bit] = [];
    }

    // For each cycle, extract each bit value from r31ValueHistory and duplicate for the stepped pattern
    // Start from index 1 to skip cycle 0
    for (let i = 1; i <= maxCycles; i++) {
        const value = r31ValueHistory[i] || 0;

        for (let bit = 0; bit <= 20; bit++) {
            // Extract bit value using bitwise AND and shift
            const bitValue = (value & (1 << bit)) ? 1 : 0;

            // Add the same bit value twice - once for the integer and once for the x.99999
            simulationData.r31Bits[bit].push(bitValue);
            simulationData.r31Bits[bit].push(bitValue);
        }
    }
}

/**
 * Collects R31 history from the static module's simulation input configuration
 * @returns {Object} Combined R31 history map (cycle -> R31 value)
 */
function collectR31History() {
    // Get the static module instance
    const staticModule = system.modules["/pru_blocks/common/pru_blocks_static_module"];
    if (staticModule && staticModule.$static) {
        return generateR31HistoryFromStaticModule(staticModule.$static);
    }
    return {};
}

/**
 * register-pool exhaustion is an error naming the block and the budget; the instruction would otherwise be missing from the asm.
 * Runs BEFORE the generic "-1" gate in the validate pass so loop-counter and group-return failures (which leave "-1" in the
 * instructions) are named too. Returns the number of recorded failures reported.
 */
function reportRegisterExhaustion(inst, report) {
    for (const f of pruRegisterAllocator.getAllocationFailures()) {
        let failedInst = null;
        for (let moduleName in system.modules) {
            const mod = system.modules[moduleName];
            if (mod && mod.$instances) failedInst = mod.$instances.find(i => i.$name === f.block) || failedInst;
        }
        const message = f.contractFailure
            ? "Accumulator binding error: block '" + f.block + "' cannot honor " + f.what + "."
            : "Out of registers: block '" + f.block + "' needs " + f.bytes + " byte(s) for " + f.what +
            " but only " + f.freeBytes + " of the " + f.budgetBytes + " allocatable bytes (R0-R" + (f.budgetRegisters - 1) +
            ", " + f.budgetRegisters + " registers; R28/R29 are reserved) are free, so its instruction cannot be generated. " +
            (f.pinnedBytes > 0 ? f.pinnedBytes + " byte(s) of the pool are pinned by registers typed into block fields (" +
                f.pinnedBy.join(", ") + ") and are not available to the allocator. " : "") +
            "Reduce the number of values alive at once, or store intermediate results to memory.";
        report.logError(message, failedInst || inst);
    }
    return pruRegisterAllocator.getAllocationFailures().length;
}

/**
 * registers typed into block fields. Reports (a) a typed value that is not a usable register window (ERROR),
 * (b) two fields that name overlapping registers - an ERROR when the user typed at least one of them, a WARNING when both
 * still hold their default value (a saved design with two blocks left on defaults used to generate; it must not suddenly fail),
 * (c) a hand-off reader that runs before its writer outside any common loop (WARNING). Returns the number of ERRORS.
 */
function reportPinnedRegisterConflicts(inst, report) {
    const regName = (p) => p.token + " (" + p.bytes + " byte" + (p.bytes === 1 ? "" : "s") + ")";
    const instanceNamed = (name) => {
        let target = null;
        for (let moduleName in system.modules) {
            const mod = system.modules[moduleName];
            if (mod && mod.$instances) target = mod.$instances.find(i => i.$name === name) || target;
        }
        return target || inst;
    };
    let errors = 0;
    for (const p of pruRegisterAllocator.getPinnedRegisterProblems()) {
        report.logError("Invalid register: " + p.block + "." + p.field + " = '" + p.token + "' " + p.why + ".", instanceNamed(p.block));
        errors++;
    }
    for (const c of pruRegisterAllocator.getPinnedRegisterConflicts()) {
        const text = "Register conflict: " + c.second.block + "." + c.second.field + " = " + regName(c.second) +
            " overlaps " + c.first.block + "." + c.first.field + " = " + regName(c.first) +
            ". Both blocks use these registers directly, so one result would overwrite the other. Give each block its own registers";
        if (c.harmful) {
            report.logError(text + ": " + c.first.block + " runs first and " + c.second.block + " overwrites " + regName(c.first) +
                " before any block reads it, so " + c.first.block + "'s value is lost (" + (c.first.atDefault && c.second.atDefault ? "both fields are still at their default value; " : "") +
                "type a different register into " + c.second.block + "." + c.second.field + " or " + c.first.block + "." + c.first.field + ").", instanceNamed(c.second.block));
            errors++;
        } else if (c.first.atDefault && c.second.atDefault) {
            const free = pruRegisterAllocator.suggestFreeRegister(c.second.bytes);
            report.logWarning(text + " (both fields are still at their default value: type a different register into " + c.second.block + "." +
                c.second.field + " or " + c.first.block + "." + c.first.field + (free ? " - " + free + " is not used by any block" : "") +
                " - to remove this warning).", instanceNamed(c.second.block));
        } else {
            report.logError(text + ".", instanceNamed(c.second.block));
            errors++;
        }
    }
    for (const o of pruRegisterAllocator.getPinnedHandOffOrderWarnings()) {
        report.logWarning("Register hand-off order: " + o.reader.block + "." + o.reader.field + " = " + o.reader.token + " uses the register that " +
            o.writer.block + "." + o.writer.field + " = " + o.writer.token + " fills, but " + o.reader.block + " runs BEFORE " + o.writer.block +
            " and no loop contains both, so it reads the register before the value arrives. Connect " + o.writer.block + " first, or put both in one loop (inside one loop the reader sees the previous iteration's value: the first iteration reads the uninitialised register and the last value is never read).",
            instanceNamed(o.reader.block));
    }
    return errors;
}

/**
 * Validate PRU instructions for undefined symbols, arity mismatches, and unconnected ports.
 * Runs right after register allocation.
 */
function validatePruInstructions(inst, report) {
    let definedSymbols = new Set();
    let usects = getUsectLinkerDirectives();
    usects.forEach(u => {
        let parts = u.split('\t');
        if (parts.length > 0) definedSymbols.add(parts[0].trim());
    });

    let dataSects = getDataSectionContents();
    dataSects.forEach(d => {
        if (d.symbolName) definedSymbols.add(d.symbolName.trim());
    });

    let pruInstructionsWithMacros = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructions;
    let pruInstructionModules = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructionModules;
    let pruInstructionInstances = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructionInstances;

    // 1. Scan all blocks for graph connection issues and symbol usages
    for (let moduleName in system.modules) {
        let mod = system.modules[moduleName];
        if (!mod || !mod.$instances) continue;
        for (let b_inst of mod.$instances) {
            // A. Undefined symbol checks
            if (b_inst.symbolName && !definedSymbols.has(b_inst.symbolName)) {
                report.logError("Undefined memory symbol referenced: " + b_inst.symbolName, b_inst, "symbolName");
            }
            if (b_inst.variableName && !definedSymbols.has(b_inst.variableName)) {
                report.logError("Undefined shared-memory variable referenced: " + b_inst.variableName, b_inst, "variableName");
            }

            // B. Required ports unconnected
            if (b_inst.numOfInputPorts > 0) {
                for (let i = 1; i <= b_inst.numOfInputPorts; i++) {
                    let portName = "input" + i;
                    if (!b_inst[portName] || b_inst[portName].length === 0 || !b_inst[portName][0].inst) {
                        report.logError("Required graph input port '" + portName + "' is unconnected", b_inst);
                    }
                }
            }

            // C. Invalid graph link targets
            if (b_inst.numOfInputPorts > 0) {
                for (let i = 1; i <= b_inst.numOfInputPorts; i++) {
                    let portName = "input" + i;
                    if (b_inst[portName] && b_inst[portName].length > 0 && b_inst[portName][0].inst) {
                        let sourceInst = b_inst[portName][0].inst;
                        if (sourceInst.numOfOutputPorts === 0 || sourceInst.numOfOutputPorts === undefined) {
                            report.logError("Invalid connection: source block '" + sourceInst.$name + "' does not produce an output for '" + portName + "'", b_inst);
                        }
                    }
                }
            }
        }
    }

    // 1b. A consumer wired to an output port that owns no register is refused; the allocator never reroutes it to output1
    for (const c of pruRegisterAllocator.getUnroutedConnections()) {
        let consumerInst = null;
        for (let moduleName in system.modules) {
            const mod = system.modules[moduleName];
            if (mod && mod.$instances) consumerInst = mod.$instances.find(i => i.$name === c.consumer) || consumerInst;
        }
        report.logError("Invalid connection: block '" + c.source + "' port '" + c.sourcePort + "' has no register of its own, so '" +
            c.consumer + "." + c.inputPort + "' cannot read it (the block's macro writes only output1 here)", consumerInst || inst);
    }

    // 1c. Loop contents consumed outside loop/group
    for (const v of pruRegisterAllocator.getLoopBoundaryViolations()) {
        let consumerInst = null;
        let loopInst = null;
        for (let moduleName in system.modules) {
            const mod = system.modules[moduleName];
            if (mod && mod.$instances) {
                if (v.consumer !== "generator") {
                    consumerInst = consumerInst || mod.$instances.find(i => i.$name === v.consumer);
                }
                loopInst = loopInst || mod.$instances.find(i => i.$name === v.container);
            }
        }
        if (v.consumer === "generator") {
            report.logError("Invalid container contents: group '" + v.producer + "' cannot be placed inside container '" +
                v.container + "'. Group blocks cannot be nested inside loops or other groups.", loopInst || inst);
        } else {
            // a loop may explicitly export a block's final-iteration output (loop_block.exportedBlocks).
            // A consumer outside such a loop reading an exported block is the supported post-loop store, not a
            // boundary violation. Anything not exported is still rejected below.
            const isDownstream = (start, target) => {
                const seen = new Set();
                const walk = (node) => {
                    if (!node || seen.has(node)) return false;
                    seen.add(node);
                    if (node.$name === target) return true;
                    return [].concat(node.next || [], node.T || [], node.F || []).some(c => walk(c && c.inst));
                };
                return walk(start);
            };
            if (loopInst && Array.isArray(loopInst.exportedBlocks) && loopInst.exportedBlocks.includes(v.producer) &&
                isDownstream(loopInst, v.consumer)) {
                continue;
            }
            if (loopInst && Array.isArray(loopInst.exportedBlocks) && loopInst.exportedBlocks.includes(v.producer)) {
                report.logError("Invalid exported result: consumer '" + v.consumer + "' reads exported block '" +
                    v.producer + "' before or outside the downstream control flow of loop '" + v.container +
                    "'. Exported blocks may only be consumed downstream of their loop.", consumerInst || inst);
                continue;
            }
            report.logError("Invalid connection: consumer '" + v.consumer + "' is outside container '" + v.container +
                "' but attempts to read '" + v.producer + "' which is inside it (via port '" + v.port + "'). Container contents cannot be consumed from the outside.", consumerInst || inst);
            if (loopInst) {
                report.logError("Invalid container: contains '" + v.producer + "' which is consumed from the outside by '" +
                    v.consumer + "'. Container contents cannot be consumed from the outside.", loopInst);
            }
        }
    }

    // 2. Macro arity mismatch
    for (let i = 0; i < pruInstructionsWithMacros.length; i++) {
        let call = pruInstructionsWithMacros[i];
        let moduleName = pruInstructionModules[i];
        let b_inst = pruInstructionInstances[i];

        if (!call || call === 0 || call === "0" || !moduleName || !b_inst) continue;
        let mod = system.modules[moduleName];

        if (mod && typeof mod.getMacro === 'function') {
            let callArgsStr = call.substring(call.indexOf(' ') + 1).trim();
            let callArgs = callArgsStr ? callArgsStr.split(',').map(s=>s.trim()).filter(s=>s!=="") : [];
            let callArity = callArgs.length;

            if (callArgs.some(arg => arg === "undefined")) {
                report.logError("Macro call contains 'undefined' argument. Call: " + call, b_inst);
            }


            // The arity check needs the macro DEFINITION, not the inline expansion.
            // Blocks switch on an empty first argument to emit the `.macro` line
            // (see uart_tx getMacroSingleShot, uart_rx getMacro), so calling with
            // the call string returns a body that has no signature in it at all.
            let opCode = call.trim().split(/\s+/)[0];
            let defBody = mod.getMacro("", opCode);
            // Definition bodies may be preceded by guarded .set/.asg prologues
            // (uart_rx prepends the ICSS_CFG block), so find the signature line
            // rather than assuming it is line 1.
            let defLine = defBody ? (defBody.split('\n').find(l => l.includes('.macro')) || "") : "";

            if (defLine) {
                let defArgsStr = defLine.substring(defLine.indexOf('.macro') + 6).trim();
                let defArgs = defArgsStr ? defArgsStr.split(',').map(s=>s.trim()).filter(s=>s!=="") : [];
                let defArity = defArgs.length;

                if (callArity !== defArity) {
                    report.logError("Macro arity mismatch: generated call has " + callArity + " args but definition expects " + defArity + ". Call: " + call, b_inst);
                }
            }
        }
    }
}

/**
 * GUI pin warnings: shared GPO/GPI physical pads, duplicate GPO drivers,
 * malformed getPinUsage results, and unavailable device/core pad data.
 *
 * A two-way (bidirectional) pad shared by blocks of DIFFERENT modules (e.g. two blocks of different
 * modules reading and driving the same two-way pad) makes the generated firmware contend on that pad.
 * This validator emits a report.logWarning (not logError, so code generation still succeeds) so the
 * user sees the conflict in the SysConfig GUI.
 *
 * Rules and exemptions:
 *   - claims come from each block's moduleStatic pin usage query (inst);
 *   - exempt (no warning):
 *       (a) the same instance's own open-drain pair;
 *       (b) different instances of the SAME block module that classify SEQUENTIAL (sourced from
 *           the generated common/block_control_flow_data.js table).
 *   - only pads that are actually shared between GPO and GPI on the device count (derived from
 *     SysConfig device data).
 *
 * Warning text names both blocks (instance names) and the pad.
 * Device scope: the design's own device and PRU core (system.deviceData and the core name).
 */
// SysConfig core name -> pad signal prefix:
// icss_g<N>_[rtu_|tx_]pru<K> -> PRG<N>_PRU<K> (ICSSG), icss_m<N>_pru<K> -> PR<N>_PRU<K> (ICSSM).
function padPrefixForCore(coreName) {
    const m = /^icss_([gm])(\d)(?:_(?:rtu|tx))?_pru(\d)$/.exec(coreName || '');
    return m ? (m[1] === 'g' ? 'PRG' : 'PR') + m[2] + '_PRU' + m[3] : null;
}

function getDevicePadSharing(deviceData, coreName) {
    if (!deviceData) return null;
    const prefix = padPrefixForCore(coreName);
    if (!prefix) return null;
    const sharedIndices = new Set();

    // 1. SysConfig runtime interface pins (ICSSG devices)
    const ifaceName = /^PRG(\d)_/.test(prefix) ? 'PRU_ICSSG' + prefix[3] + '_PRU' : null;
    if (ifaceName && deviceData.interfaces && deviceData.interfaces[ifaceName] && deviceData.interfaces[ifaceName].interfacePins) {
        const ifacePins = deviceData.interfaces[ifaceName].interfacePins;
        for (let i = 0; i < 20; i++) {
            const gpoName = `${prefix}_GPO${i}`;
            const gpiName = `${prefix}_GPI${i}`;
            const gpoPin = ifacePins[`GPO${i}`];
            if (!gpoPin || !gpoPin.pinMappings) continue;
            for (const pm of gpoPin.pinMappings) {
                if (pm.name !== gpoName) continue;
                for (const dp of (pm.pinMappings || [])) {
                    if (dp && dp.mux && Array.isArray(dp.mux.muxSetting)) {
                        const signals = dp.mux.muxSetting.map(s => s.peripheralPin && s.peripheralPin.name);
                        if (signals.includes(gpoName) && signals.includes(gpiName)) {
                            sharedIndices.add(i);
                        }
                    }
                }
            }
        }
        return sharedIndices;
    }

    // 1b. SysConfig runtime interface pins (ICSSM devices): interface PRU-ICSS<N> holds one two-way
    // PR<N>_PRU<K>_GPIO<i> interface pin per pad that exists; GPO i and GPI i share it.
    const icssmIface = /^PR(\d)_/.test(prefix) ? 'PRU-ICSS' + prefix[2] : null;
    if (icssmIface && deviceData.interfaces && deviceData.interfaces[icssmIface] && deviceData.interfaces[icssmIface].interfacePins) {
        const ifacePins = deviceData.interfaces[icssmIface].interfacePins;
        for (let i = 0; i < 20; i++) {
            const pin = ifacePins[`${prefix}_GPIO${i}`];
            if (pin && pin.pinMappings && pin.pinMappings.length) sharedIndices.add(i);
        }
        return sharedIndices;
    }

    // 2. Raw JSON device data structure (ICSSM devices, stubs and test harnesses). ICSSG pads carry a
    // PRGx_PRUy_GPOn + PRGx_PRUy_GPIn pair; ICSSM pads carry one two-way PRx_PRUy_GPIOn signal.
    const infos = deviceData.pinCommonInfos || {};
    for (const info of Object.values(infos)) {
        if (!info || !info.pinModeInfo) continue;
        const sigs = new Set(info.pinModeInfo.map(m => m.signalName));
        for (let i = 0; i < 20; i++) {
            if ((sigs.has(`${prefix}_GPO${i}`) && sigs.has(`${prefix}_GPI${i}`)) || sigs.has(`${prefix}_GPIO${i}`)) {
                sharedIndices.add(i);
            }
        }
    }
    return sharedIndices;
}

let bcfData = null;
function isSequentialBlock(blockName, instCfg) {
    if (!bcfData && typeof system !== 'undefined' && typeof system.getScript === 'function') {
        try {
            bcfData = system.getScript("/pru_blocks/common/block_control_flow_data.js");
        } catch (e) {
            bcfData = null;
        }
    }
    if (bcfData && bcfData.blockControlFlow && bcfData.blockControlFlow[blockName] !== undefined) {
        if (bcfData.blockControlFlow[blockName] === 'sequential') return true;
        // continuous by default, sequential once the block's bound config is > 0 (e.g. a period count).
        const bound = bcfData.blockControlFlowBound && bcfData.blockControlFlowBound[blockName];
        return !!(bound && instCfg && Number.isInteger(Number(instCfg[bound])) && Number(instCfg[bound]) > 0);
    }
    return false; // Fail closed if undecided or unknown
}

// The attached devices (Device Model blocks and Simulation Settings GPI device fields) whose
// PRU-driven input pads another block also drives. The decision is deviceModelTable.findDeviceInputConflicts,
// shared with the command-line pin-collision check.
function reportDeviceInputDrivers(inst, gpoBits, report) {
    const modules = system.modules;
    const devices = [];
    const dm = modules["/pru_blocks/utils/device_model_block"];
    for (const mi of (dm && dm.$instances) || []) {
        if (!deviceModelTable.KINDS[mi.deviceKind]) continue;
        const b = deviceModelTable.toBinding(mi);
        devices.push({
            name: mi.$name, source: "Device Model block", kind: mi.deviceKind,
            matched: deviceModelTable.matchedDrivers(mi.deviceKind, b, modules),
            listens: deviceModelTable.listenedPins(mi.deviceKind, b)
        });
    }
    const slotOfLabel = { "primary pin": "primaryPin", "Clock/B pin": "clockPin", "Index/Z pin": "indexPin" };
    for (const claim of collectGpiDeviceClaims(inst)) {
        const b = { params: deviceModelTable.paramsOf(inst[`gpi${claim.pinNum}_deviceParams`]) };
        for (const p of claim.pins) b[slotOfLabel[p.label]] = p.pin;
        devices.push({
            name: `GPI${claim.pinNum} device`, source: "Simulation Settings GPI device", kind: claim.kind,
            matched: deviceModelTable.matchedDrivers(claim.kind, b, modules),
            listens: deviceModelTable.listenedPins(claim.kind, b)
        });
    }
    for (const c of deviceModelTable.findDeviceInputConflicts(devices, gpoBits)) {
        if (c.severity === "warning") report.logWarning(c.message, inst); else report.logError(c.message, inst);
    }
}

function validateBidiPinCollisionsGlobal(inst, report) {
    try {
        // GUI pin warnings: shared GPO/GPI physical pads, duplicate GPO drivers
        //, malformed pin-usage results, and unavailable device/core pad data.
        // The GPO/GPI shared-pad rule needs device pad data; the duplicate-GPO rule and the
        // 'could not evaluate' diagnostics do not.
        const padSharing = getDevicePadSharing(system.deviceData, system.getScript("/common").getSelfSysCfgCoreName());
        const sharedIndices = padSharing || new Set();

        const claims = [];
        for (const modName in system.modules) {
            const mod = system.modules[modName];
            if (!mod || !mod.$instances || mod.$instances.length === 0) continue;
            for (let idx = 0; idx < mod.$instances.length; idx++) {
                const bi = mod.$instances[idx];
                const moduleStatic = (bi.$module && bi.$module.moduleStatic) || mod.moduleStatic;
                if (!moduleStatic || typeof moduleStatic.getPinUsage !== 'function') continue;
                const iname = typeof bi.$name === 'string' ? bi.$name : `#${idx}`;
                let pins = [];
                try {
                    pins = moduleStatic.getPinUsage(bi);
                } catch (e) {
                    const reason = (e && e.message) ? e.message : String(e);
                    report.logWarning(
                        `Pin-sharing check could not evaluate block '${iname}' (${modName}): ${reason}`,
                        inst
                    );
                    continue;
                }
                const block = modName.split('/').pop();
                if (!Array.isArray(pins)) {
                    // A non-array result cannot be checked; report it rather than skip it silently.
                    report.logWarning(
                        `Pin-sharing check could not evaluate block '${iname}' (${modName}): its pin-usage function did not return an array, so its pins are not checked for sharing.`,
                        inst
                    );
                    continue;
                }
                for (const p of pins) {
                    if (!p || (p.dir !== "GPO" && p.dir !== "GPI")) {
                        report.logWarning(
                            `Pin-sharing check could not evaluate block '${iname}' (${modName}): its pin-usage function returned an entry without a GPO/GPI dir, so that entry is not checked for sharing.`,
                            inst
                        );
                        continue;
                    }
                    const pin = parseInt(p.pin);
                    if (isNaN(pin)) {
                        report.logWarning(
                            `Pin-sharing check could not evaluate block '${iname}' (${modName}): unparseable ${p.dir} pin "${String(p.pin)}", so that pin is not checked for sharing.`,
                            inst
                        );
                        continue;
                    }
                    claims.push({
                        inst: bi,
                        block: block,
                        iname: iname,
                        dir: p.dir,
                        pin: pin,
                        bidi: p.bidi === true,
                        cfg: bi
                    });
                }
            }
        }

        if (claims.length === 0) return;

        const gpoBits = claims.filter(c => c.dir === "GPO");
        const gpiBits = claims.filter(c => c.dir === "GPI");
        const warnedPairs = new Set();

        if (padSharing === null && gpoBits.length && gpiBits.length) {
            report.logWarning(
                "GPO/GPI pad sharing could not be checked for this device/core: no pad data is available, so shared GPO/GPI pads are not detected.",
                inst
            );
        }

        if (padSharing !== null) {
            for (const o of gpoBits) {
                for (const i of gpiBits) {
                    if (o.pin !== i.pin || !sharedIndices.has(o.pin)) continue;
                    if (o.inst === i.inst && o.bidi && i.bidi) continue; // (a) same instance AND both bidi
                    if (o.inst !== i.inst && o.bidi && i.bidi && o.block === i.block && isSequentialBlock(o.block)) continue; // (b) different instances, both bidi, same block module, module classifies sequential

                    const keyA = (o.inst && o.inst.$name) || o.iname;
                    const keyB = (i.inst && i.inst.$name) || i.iname;
                    const pairKey = o.inst === i.inst
                        ? `self:${keyA}:${o.pin}`
                        : (keyA < keyB ? `${keyA}:${keyB}:${o.pin}` : `${keyB}:${keyA}:${o.pin}`);
                    if (warnedPairs.has(pairKey)) continue;
                    warnedPairs.add(pairKey);

                    report.logWarning(
                        `Pad ${o.pin} is driven (GPO) by '${o.iname}' (${o.block}) and read (GPI) by '${i.iname}' (${i.block}); the generated firmware will contend on this pad.`,
                        inst
                    );
                }
            }
        }

        // two different instances drive one GPO index and at least one block is CONTINUOUS
        // (fail closed: a block missing from the control-flow table counts as continuous).
        for (let x = 0; x < gpoBits.length; x++) {
            for (let y = x + 1; y < gpoBits.length; y++) {
                const a = gpoBits[x], b = gpoBits[y];
                if (a.pin !== b.pin || a.inst === b.inst) continue;
                const cont = [a, b]
                    .filter((c) => !isSequentialBlock(c.block, c.cfg))
                    .map((c) => c.block)
                    .filter((blk, k, arr) => arr.indexOf(blk) === k);
                if (!cont.length) continue;
                report.logWarning(
                    `GPO ${a.pin} is driven by both '${a.iname}' (${a.block}) and '${b.iname}' (${b.block}); continuous: ${cont.join(', ')}; the drivers will overwrite each other on this pin (duplicate GPO drivers).`,
                    inst
                );
            }
        }
        // A GPO that feeds an attached device's input may be driven only by that device's reader.
        reportDeviceInputDrivers(inst, gpoBits, report);
    } catch (e) {
        const reason = (e && e.message) ? e.message : String(e);
        report.logWarning(
            `Pin-sharing check could not evaluate the design: ${reason}`,
            inst
        );
    }
}

// device-capability gating for hardware-widget blocks
// every failure path in this gate fails CLOSED or errors VISIBLY.
// No degradation (missing caps script, missing SoC, unknown SoC, capability
// lookup exception) may silently skip validation and leave the build clean.
function validateDeviceCapabilities(inst, report) {
    // Only gate when at least one module actually declares widget requirements,
    // so widget-free designs stay clean.
    let widgetModules = [];
    for (let moduleName in system.modules) {
        let mod = system.modules[moduleName];
        if (!mod || !mod.requiresWidget) continue;
        widgetModules.push([moduleName, mod]);
    }
    if (widgetModules.length === 0) return;

    // Failure path 1: capability table itself failed to load -> refuse to pass.
    if (!pruDeviceCaps) {
        report.logError(
            "Device capability table (pru_device_caps.js) could not be loaded - cannot verify hardware-widget requirements. Failing closed.",
            inst
        );
        return;
    }

    // Failure path 2: /common getScript failure -> visible error, not a silent return.
    let socName = null;
    let commonFailure = null;
    try {
        const common = system.getScript("/common");
        if (common && typeof common.getSocName === "function") {
            socName = common.getSocName();
        }
    } catch (e) {
        commonFailure = String(e && e.message || e);
    }
    if (commonFailure) {
        report.logError(
            `Cannot load common module to determine SoC (${commonFailure}) - cannot verify hardware-widget requirements. Failing closed.`,
            inst
        );
        return;
    }

    // Failure path 3: SoC missing entirely -> visible error.
    if (!socName) {
        report.logError(
            "SoC name could not be determined - cannot verify hardware-widget requirements. Failing closed.",
            inst
        );
        return;
    }

    let deviceName = socName;
    try {
        if (system.deviceData && system.deviceData.device) {
            deviceName = system.deviceData.device;
        }
    } catch (e) { /* use socName */ }

    // Failure path 4: SoC not in the capability table -> visible error, never a
    // silent default capability set.
    let socKnown = false;
    try {
        socKnown = (typeof pruDeviceCaps.isKnownSoc === "function")
            ? !!pruDeviceCaps.isKnownSoc(socName)
            : Object.keys(pruDeviceCaps.DEVICE_CAPS || {}).some(function (k) { return k === String(socName).toLowerCase(); });
    } catch (e) { socKnown = false; }
    if (!socKnown) {
        report.logError(
            `SoC '${socName}' (device '${deviceName}') is not in the device capability table - cannot verify hardware-widget requirements. Failing closed.`,
            inst
        );
        return;
    }

    for (let [moduleName, mod] of widgetModules) {
        let raw = mod.requiresWidget;
        let widgets = Array.isArray(raw) ? raw : [raw];
        for (let w of widgets) {
            if (!w) continue;
            let available = false;
            let widgetFailure = null;
            try {
                available = pruDeviceCaps.isWidgetAvailable(w, socName);
            } catch (e) {
                // Failure path 5: capability lookup threw -> treat widget as
                // UNAVAILABLE and say so, instead of assuming available.
                widgetFailure = String(e && e.message || e);
            }
            if (widgetFailure) {
                let instances = (mod.$instances && mod.$instances.length) ? mod.$instances : [inst];
                for (let bInst of instances) {
                    report.logError(
                        `Widget availability check for '${w}' threw an exception (${widgetFailure}) - treating as unavailable on device '${deviceName}' (SoC '${socName}'). Failing closed.`,
                        bInst
                    );
                }
            } else if (!available) {
                let instances = (mod.$instances && mod.$instances.length) ? mod.$instances : [inst];
                for (let bInst of instances) {
                    report.logError(
                        `Block '${mod.displayName || moduleName}' requires widget '${w}' which is not available on device '${deviceName}' (SoC '${socName}')`,
                        bInst
                    );
                }
            }
        }
    }
}


/**
 * Detects cycles in the control flow and data flow graph (prev/next/T/F and input/output ports).
 * Uses DFS with three-color marking: 0=unvisited, 1=in-stack, 2=done.
 * @returns {string|null} Error message if a cycle is found, null otherwise
 */
function detectControlFlowCycle() {
    const systemModules = system.modules;
    const color = {};  // instanceName -> 0 (unvisited) | 1 (in stack) | 2 (done)
    const parent = {}; // instanceName -> instanceName (for path reconstruction)
    // const debugPaths = []; // Track all edges traversed for debugging

    // Collect all instances that participate in control flow or data flow
    const allInstances = {};
    for (const moduleName in systemModules) {
        const module = systemModules[moduleName];
        if (!module) continue;
        for (const instance of module.$instances) {
            if (!instance.$name) continue;
            // Include instances with control flow ports (next/prev/T/F) or data flow ports (input/output)
            if (instance.next !== undefined || instance.prev !== undefined ||
                instance.input1 !== undefined || instance.input2 !== undefined ||
                instance.output1 !== undefined) {
                allInstances[instance.$name] = instance;
                color[instance.$name] = 0;
            }
        }
    }

    // Iterative DFS using explicit stack to avoid call stack overflow
    // Each stack entry is {instance, expanded} where expanded=false means
    // we are entering the node, expanded=true means we are leaving it
    for (const startName in allInstances) {
        if (color[startName] !== 0) continue;

        const stack = [{ instance: allInstances[startName], expanded: false }];

        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const name = top.instance.$name;

            if (!top.expanded) {
                // First visit — mark as in-stack
                top.expanded = true;
                color[name] = 1;

                // Collect all outgoing edges: control flow (next, T, F) and data flow (output consumers)
                const outgoing = [];
                const nextInst = top.instance.next?.[0]?.inst;
                if (nextInst) {
                    outgoing.push(nextInst);
                }
                const trueInst = top.instance.T?.[0]?.inst;
                if (trueInst) {
                    outgoing.push(trueInst);
                }
                const falseInst = top.instance.F?.[0]?.inst;
                if (falseInst) {
                    outgoing.push(falseInst);
                }
                const output1Inst = top.instance.output1?.[0]?.inst;
                if (output1Inst) {
                    const size = top.instance.output1.length
                    for (var i = 0; i < size; ++i) {
                        const output1Inst_all = top.instance.output1?.[i]?.inst;
                        outgoing.push(output1Inst_all);
                    }
                }
                for (const neighbor of outgoing) {
                    if (!neighbor.$name) continue;
                    const neighborName = neighbor.$name;
                    if (color[neighborName] === 1) {
                        // Back edge — cycle found, reconstruct path
                        let path = [neighborName];
                        let cur = name;
                        while (cur && cur !== neighborName) {
                            path.unshift(cur);
                            cur = parent[cur];
                        }
                        path.unshift(neighborName);
                        return `Cycle detected in block connections: ${path.join(" → ")}. Remove the looping connection to fix this.`;
                    }
                    if (color[neighborName] === 0) {
                        parent[neighborName] = name;
                        stack.push({ instance: neighbor, expanded: false });
                    }
                }
            } else {
                // Second visit — leaving the node, mark as done
                color[name] = 2;
                stack.pop();
            }
        }
    }

    return null;
}

function validate(inst, report)
{
	// Check for cycles in the control flow graph before anything else
	const cycleError = detectControlFlowCycle();
	if (cycleError) {
		report.logError(cycleError, inst);
		return;
	}

	// Device-capability gate (must name both widget and device, ERROR not warning)
	validateDeviceCapabilities(inst, report);

	// Validate R31 simulation input configuration
	validateR31SimulationInput(inst, report);

	// Check for UART blocks and warn about unsupported simulation
	const uartModule = system.modules["/pru_blocks/pru_io_blocks/uart_config"];
	const hasUartBlock = (uartModule && uartModule.$instances && uartModule.$instances.length > 0)

	if (hasUartBlock) {
		report.logWarning(
			"UART blocks detected in configuration. Note: Three-channel peripheral interface simulation is not currently supported. " +
			"UART TX/RX blocks will not be simulated in the waveform viewer. The blocks will function correctly on hardware.",
			inst
		);
	}

	//allocating pru registers for all blocks at system level
	pruRegisterAllocator.allocatePruRegisters();
	// GUI warning for cross-module bidirectional pad sharing
	validateBidiPinCollisionsGlobal(inst, report);
	//validating register allocation
	let pruInstructionsWithMacros = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructions;
	let pruInstructionsLabelWithMacros = pruRegisterAllocator.getPruRegisterAllocationSummary().labels;

	let hasRegisterError = pruInstructionsWithMacros.some(instruction =>
		instruction.includes("-1")
	);

	// named, budgeted errors first; the generic message stays as the fallback for any unrecorded -1
	const recordedExhaustion = reportRegisterExhaustion(inst, report);
	// user-typed registers that overlap each other
	reportPinnedRegisterConflicts(inst, report);

	if (hasRegisterError) {
		if (recordedExhaustion === 0) report.logError("Out of PRU registers, reduce number of PRU blocks added", inst);
	} else {
	    // --- Generate-time validation pass ---
	    validatePruInstructions(inst, report);

        /*prepare instructions and init dmem0 for simulation*/
		// If UART blocks are present, skip simulation and return zeros
		if (hasUartBlock) {
			const cyclesToSimulate = inst["pruCyclesToSimulate"];
			const r30ValueHistory = new Array(cyclesToSimulate).fill(0);
			const r31ValueHistory = new Array(cyclesToSimulate).fill(0);
			const pruState = {
				registers: new Array(32).fill(0)
			};

			prepareR30DataForPlotting(r30ValueHistory);
			prepareR31DataForPlotting(r31ValueHistory);

			return {pruState, r30ValueHistory, r31ValueHistory};
		}

		/*add instructions to simulate the PRU Instructions by expanding macros*/
		let {pruInstructions, pruInstructionsLabels } = expandMacros(pruInstructionsWithMacros, pruInstructionsLabelWithMacros);
        // Replace TEMP_REG references with actual register numbers
        pruInstructions = replaceTemporaryRegisters(pruInstructions);
        // Reset DMEM0 simulation memory
        pruDMEM0.resetDMEM0();
        // Clear DMEM0 symbol table before adding new symbols
        pruDMEM0.clearSymbolTable();

        // Reset SMEM simulation memory
        pruSMEM.resetSMEM();
        // Clear SMEM symbol table before adding new symbols
        pruSMEM.clearSymbolTable();

        // Get all data section contents
        const allDataSectionContents = getDataSectionContents();

        // Separate DMEM and SMEM data based on section field
        const dmemData = allDataSectionContents.filter(item => item.section === "dmem" || !item.section);
        const smemData = allDataSectionContents.filter(item => item.section === "smem");

        // Add DMEM data section contents starting at 0x00000000
        // Returns next available address after all data
        let nextDmemAddress = pruDMEM0.addDataSectionContents(dmemData, 0x00000000);

        // Add SMEM data section contents starting at 0x00010000 (64KB offset)
        // Returns next available address after all data
        let nextSmemAddress = pruSMEM.addDataSectionContents(smemData, 0x00010000);

        // Add Memory Variable block symbols to symbol table
        const memReserveModule = system.modules["/pru_blocks/utils/memory_variable_block"];
        if (memReserveModule && memReserveModule.$instances) {
            for (let instance of memReserveModule.$instances) {
                const labelName = instance.labelName;
                const sizeInBytes = instance.sizeInBytes;
                const memoryLocation = instance.memoryLocation;

                if (labelName && sizeInBytes) {
                    if (memoryLocation === "dmem") {
                        // Add to DMEM symbol table at next available address
                        pruDMEM0.addSymbol(labelName, nextDmemAddress, sizeInBytes);
                        nextDmemAddress += sizeInBytes;  // Move to next available address
                    } else if (memoryLocation === "smem") {
                        // Add to SMEM symbol table at next available address
                        pruSMEM.addSymbol(labelName, nextSmemAddress, sizeInBytes);
                        nextSmemAddress += sizeInBytes;  // Move to next available address
                    }
                }
            }
        }

        // Replace instruction symbol references with actual memory addresses
        // First replace DMEM symbols
        pruInstructions = pruDMEM0.replaceSymbolReferences(pruInstructions);
        // Then replace SMEM symbols
        pruInstructions = pruSMEM.replaceSymbolReferences(pruInstructions);
        const r31HistoryMap = collectR31History();

        // Attached Device Model mode: close the loop. Timestamp and
        // Pattern mode play a pre-authored history; a device model ANSWERS
        // the firmware, and rejects traffic the real part would reject. The
        // user configures a device and presses Run - the bus, the models and
        // the margin measurement all happen here, in JavaScript, inside the
        // tool; no path, no build directory, no external invocation is ever
        // shown.
        const { bindings, errors: bindingErrors } = collectDeviceBindings(inst);
        let deviceBus = null;
        if (bindings.length > 0) {
            deviceBus = new deviceBusScript.DeviceBus();
            for (const binding of bindings) {
                deviceBus.attach(binding.device);
            }
            // Pins a device drives are INPUTS from the PRU's side. Leaving
            // them in the PRU drive mask would record contention on every
            // cycle - a false fault on a correct design, which is worse than
            // no check at all because it teaches the user to ignore faults.
            let pruDriveMask = deviceBusScript.MASK_20;
            for (const binding of bindings) {
                for (const pin of Object.keys(binding.device.nets || {})) {
                    pruDriveMask &= ~(1 << Number(pin));
                }
            }
            deviceBus.setPruDriveMask(pruDriveMask);
        }
        for (const err of bindingErrors) {
            report.logError(err.message, inst, err.field);
        }

        let {pruState, r30ValueHistory, r31ValueHistory} = pruSimulator.simulatePruInstructions(pruInstructions, pruInstructionsLabels, inst["pruCyclesToSimulate"], r31HistoryMap, {}, deviceBus);

        if (deviceBus) {
            const results = buildDeviceRunResults(deviceBus, bindings, r30ValueHistory, pruState);
            simulationData.deviceResults = results;
            for (const result of results) {
                // A FAIL here is a simulation RESULT, not a config error: the
                // run happened, the device refused the firmware, and the
                // user must see that verdict. A warning carries it without
                // blocking code generation; the full decode and faults are
                // on simulationData.deviceResults.
                // Labelled as the in-GUI JavaScript preview. The CLI
                // build prints this same warning, and next to a `gmake sim`
                // run on TI pru-simulator an unlabelled "FAIL" reads as the
                // simulator result. Only `gmake sim` runs the real ELF. The preview's own
                // PASS/FAIL word is dropped from the message for that reason;
                // the full verdict stays on simulationData.deviceResults.
                const previewDetail = result.summary.replace(/^(PASS|FAIL) - /, "");
                // Once a TI pru-simulator run exists for THIS design,
                // its verdict replaces the preview banner. A stale one never does.
                const realBanner = tiRunBanner(inst);
                if (realBanner) {
                    report.logWarning(realBanner, inst);
                    continue;
                }
                report.logWarning(`GUI JS preview only - gmake sim gives the TI pru-simulator result. ` +
                    `Preview of attached device "${result.device}" on GPI${result.pins.primary}: ${previewDetail}`, inst);
            }
        } else {
            simulationData.deviceResults = [];
        }

        prepareR30DataForPlotting(r30ValueHistory);
        prepareR31DataForPlotting(r31ValueHistory);
        // return pruState, r30ValueHistory, and r31ValueHistory
        return {pruState, r30ValueHistory, r31ValueHistory}
	}
}

/**
 * The banner for a real TI pru-simulator verdict on the design now
 * shown, or null (keep the JS preview banner). The result is the JSON the
 * wrapper wrote to $comFile; see pru_ti_run.js for the fail-closed rules.
 */
function tiRunBanner(inst) {
    if (!inst.tiRunResult) {
        return null;
    }
    return tiRun.bannerLine(tiRun.parseResult(inst.tiRunResult), tiRun.designDigest(system.modules, system));
}

function tiRunSummary(inst) {
    if (!inst.tiRunResult) {
        return "No TI pru-simulator run yet. Save the design, then press Run on TI pru-simulator.";
    }
    return tiRun.describe(tiRun.parseResult(inst.tiRunResult), tiRun.designDigest(system.modules, system)).text;
}

function getAIContext() {
    return getLongDescription();
}

function getLongDescription() {
    return `
## Simulation Settings

### Purpose
Configure the PRU simulation environment including PRU clock frequency, cycle count, output signal display, and input signal simulation for testing PRU blocks without hardware.

### How It Works
1. **Set Clock Frequency**: Configure PRU clock frequency (must match your R5F/A53 PRUICSS configuration)
2. **Set Simulation Duration**: Configure the number of PRU cycles to simulate
3. **Select Output Signals**: Choose which R30 (GPO) pins to display in the waveform viewer
4. **Configure Input Signals**: Select R31 (GPI) pins and define their input patterns for simulation
5. **Run Simulation**: The simulator executes PRU instructions and generates waveforms

### ⚠️ UART Block Simulation Limitation

**UART TX/RX blocks are not currently supported for simulation.** UART blocks use the three-channel peripheral interface which is not yet implemented in the simulator. When a UART block is present in your configuration:
- The simulator will display zero values for all signals
- No PRU instruction simulation will occur
- The waveform viewer will show flat lines at zero
- **UART blocks will function correctly on hardware** - this limitation only affects simulation

If you need to test UART communication, you must use actual hardware. All other PRU blocks (SPI, I2C, PWM, etc.) are fully supported in simulation.

### Configuration Parameters

**PRU Clock Frequency**: The PRU core clock frequency used by your hardware configuration. This setting is critical for:
- **Timing Calculations**: Converts nanosecond timing values to PRU cycles (e.g., CS Setup Time in SPI blocks)
- **Accurate Simulation**: Ensures simulated timing matches real hardware behavior
- **Frequency Display**: Shows correct calculated SPI clock frequencies

**⚠️ IMPORTANT**: This frequency MUST match the "Core Clk" setting in your R5F or A53 PRUICSS driver configuration:
1. Open your R5F/A53 SysConfig file
2. Navigate to: **TI Drivers & Middleware → PRUICSS**
3. Find the **"Core Clk"** parameter
4. Set the **same frequency** here in Simulation Settings

**Common Frequencies**:
- **200 MHz** (5 ns/cycle) - Default
- **225 MHz** (4.44 ns/cycle)
- **250 MHz** (4 ns/cycle)
- **300 MHz** (3.33 ns/cycle)
- **333.333 MHz** (3 ns/cycle) - Common for AM64x/AM243x

Mismatched frequencies will cause timing-sensitive operations (SPI, ADC) to fail on hardware even if simulation works correctly.

**Number Of PRU Cycles To Simulate**: Total PRU clock cycles to execute during simulation. Increase this value for longer transactions or multiple SPI packets.

**Select R30 (Output) Signals**: Choose which GPO pins (R30 register bits) to display in the simulation waveform. These show the actual output generated by your PRU blocks (e.g., SCLK, SDO, CS signals).

**Select R31 (Input) Signals**: Choose which GPI pins (R31 register bits) to simulate and display. When you select a pin, additional configuration options appear below to define the input data pattern.

### Input Simulation Configuration

For each selected GPI pin, you can configure the input data using one of two modes:

#### Timestamp Mode
Define input changes at specific PRU cycle numbers:
- **Input Cycles**: JSON array of PRU cycle numbers when the bit value changes. Example: \`[100, 107, 114, 121]\`
- **Input Values**: JSON array of bit values (0 or 1) at each timestamp. Example: \`[1, 0, 1, 0]\`
- **Repeat Last Bit**: When enabled, the last bit value continues for all subsequent cycles

**Example - Simulating SPI SDI data (0xA5 = 10100101):**
\`\`\`
Input Cycles: [100, 107, 114, 121, 128, 135, 142, 149]
Input Values: [1, 0, 1, 0, 0, 1, 0, 1]
\`\`\`
This sends bit values at each clock edge (assuming 7-cycle clock period starting at cycle 100).

#### Pattern Mode
Define a repeating bit pattern:
- **Bit Pattern**: JSON array of bits to repeat. Example: \`[0, 1, 1, 0, 1, 0, 0, 1]\`
- **Pattern Start Cycle**: PRU cycle number where the pattern begins
- **Pattern Repeat Count**: Number of times to repeat the pattern

**Example - Simulating a clock signal:**
\`\`\`
Bit Pattern: [0, 0, 0, 1, 1, 1]
Pattern Start Cycle: 50
Pattern Repeat Count: 10
\`\`\`
This creates a clock with 3 cycles LOW, 3 cycles HIGH, repeating 10 times (60 total cycles) starting at cycle 50.

### Usage Tips

**For SPI Read blocks:**
- Configure the SDI (Serial Data In) pin with the data you want to receive
- Time the bit transitions to align with the SCLK edges based on the SPI mode
- For MODE1 (sample on falling edge): set data just before each falling edge

**Calculating Timing:**
- Timing calculations depend on your configured PRU Clock Frequency
- Example at 333.333 MHz: 1 cycle = 3ns
- Example at 200 MHz: 1 cycle = 5ns
- For SPI with SCLK high=7, low=7: bit period = 14 cycles = 42ns @ 333MHz or 70ns @ 200MHz
- First SCLK edge typically occurs after CS setup time + initial cycles

**Debugging:**
- Start with a simple pattern and verify the waveform
- Use the waveform viewer to check signal alignment
- Ensure input transitions occur at the correct sample points for your SPI mode

### Terminology
- **R30**: PRU output register - bits control GPO pins
- **R31**: PRU input register - bits reflect GPI pin states
- **GPO**: General Purpose Output - output pins controlled by PRU
- **GPI**: General Purpose Input - input pins read by PRU
- **Timestamp Mode**: Define signal changes at specific cycle numbers
- **Pattern Mode**: Define a repeating bit sequence
`;
}

exports  = {
	//static module which allocates registers to all modules,
	//this module is not visible to user but error is thrown when it is out of registers
	displayName: "Simulation Settings",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
	moduleStatic: {
        // The GUI may use this direct template. SysConfig 1.28 CLI does not
        // execute moduleStatic.templates, so its always-run assembly template
        // embeds the same buildDeviceBindings output for extraction by make.
        templates: {
            "/pru_blocks/common/pru_device_bindings.json.xdt": "/pru_device_bindings.json"
        },
        validate,
        config: [
            {
                name: "pruClkFreq",
                displayName: "PRU Clock Frequency",
                description: "PRU core clock frequency (must match PRUICSS Core Clk setting in R5F/A53 SysConfig)",
                longDescription: `
### PRU Clock Frequency Configuration

This setting defines the PRU core clock frequency and is used for:
1. Converting timing values from nanoseconds to PRU cycles (e.g., CS Setup Time in SPI blocks)
2. Accurate simulation timing calculations
3. Displaying calculated SPI clock frequencies

**Important:** This value MUST match the "Core Clk" setting in your R5F or A53 PRUICSS driver configuration in SysConfig.

**To find your Core Clk setting:**
1. Open your R5F/A53 SysConfig file
2. Navigate to: TI Drivers & Middleware → PRUICSS
3. Look for "Core Clk" parameter
4. Set the same frequency here

**Common Configurations:**
- AM64x/AM243x: Typically 333.333 MHz or 200 MHz
- AM62x: Check your device-specific configuration

If the frequencies don't match, timing-sensitive operations (SPI, ADC) may not work correctly on hardware.
`,
                default: 200,
                options: [
                    { name: 200, displayName: "200 MHz" },
                    { name: 225, displayName: "225 MHz" },
                    { name: 250, displayName: "250 MHz" },
                    { name: 300, displayName: "300 MHz" },
                    { name: 333.333, displayName: "333.333 MHz" }
                ]
            },
            {
                name: "pruCyclesToSimulate",
                displayName: "Pru Cycles Simulated",
                description: "Total number of PRU clock cycles to execute during simulation",
                default: 2000,
            },
            {
                name: "tiRunButton",
                displayName: "Real Simulation",
                description: "Generate, build with clpru and run this design on TI pru-simulator against the attached device models (the same path as gmake sim). Save the design first: it runs the saved .syscfg.",
                buttonText: "Run on TI pru-simulator",
                nonSerializable: true,
                onLaunch: (inst) => tiRun.launchSpec(system, inst, tiRun.designDigest(system.modules, system)),
                onComplete: (inst, _ui, result) => {
                    inst.tiRunResult = (result && typeof result.data === "string") ? result.data : "";
                }
            },
            {
                name: "tiRunLiveView",
                displayName: "Open live web view after the run",
                description: "After the run, open TI pru-simulator's dashboard in your browser on the ELF the button just built, with the bound devices attached. It does not change the result, and it is not started when the run was refused or the build failed. The view shows the simulator, not hardware.",
                default: false,
                onChange: (inst, ui) => {
                    ui.tiRunLivePort.hidden = !inst.tiRunLiveView;
                }
            },
            {
                name: "tiRunLivePort",
                displayName: "Live web view port",
                description: "Local port for the live web view (127.0.0.1 only). A view from an earlier Run is replaced; a port held by anything else is reported, not taken.",
                default: 8765,
                hidden: true
            },
            {
                name: "tiRunSummary",
                displayName: "TI pru-simulator Result",
                description: "Verdict from the last Run on TI pru-simulator. Taken from the run's exit code only; NOT CHECKED is never a pass; a result for an earlier design is shown as STALE.",
                default: "",
                readOnly: true,
                multiline: true,
                nonSerializable: true,
                getValue: (inst) => tiRunSummary(inst)
            },
            {
                name: "tiRunResult",
                displayName: "",
                default: "",
                hidden: true,
                nonSerializable: true
            },
            {
                name: "tiRunProject",
                displayName: "TI Run Project (optional)",
                description: "Path to the saved example.syscfg (or its folder). Leave empty to use the open file; set it when the GUI does not report the file path.",
                default: ""
            },
            {
                name: "tiRunRepoRoot",
                displayName: "TI Run Tool Root (optional)",
                description: "Folder holding scripts/sim/gui_run.py. Leave empty to find it from the PRU No-Code Tool product.",
                default: ""
            },
            {
                name: "signalsToDisplay",
                displayName : "Select Output Signals To Display",
                description: "Choose which GPO output pins to display in the simulation waveform viewer",
                default: ["0", "1", "2"],
                options: Array.from({ length: 20 }, (_, i) => ({
                    name : `${i}`,
                    displayName: `${getPruNumberFromContext()}_GPO_${i}`
                }))
            },
            {
                name: "signalsToDisplayR31",
                displayName : "Select Input Signals To Display",
                description: "Select GPI pins to simulate input data. Configuration options appear below for each selected pin.",
                longDescription: `
### Input Signal Simulation

Select which GPI pins you want to simulate input data for. When you select a pin:
1. Configuration fields appear below for that pin
2. Choose between **Timestamp Mode** or **Pattern Mode**
3. Define the input data that will be injected into R31 during simulation

This allows you to test PRU blocks that read from input pins (like SPI Read's SDI pin) without actual hardware.

**Timestamp Mode**: Specify exact cycle numbers and corresponding bit values
**Pattern Mode**: Define a repeating bit pattern with start cycle and repeat count
`,
                default: [],
                minSelections: 0,
                options: Array.from({ length: 20 }, (_, i) => ({
                    name : `${i}`,
                    displayName: `${getPruNumberFromContext()}_GPI_${i}`
                })),
                onChange: onSignalsToDisplayR31Change
            },
            // Add R31 simulation input configuration fields
            ...generateR31SimulationInputConfigs(),
        ],
	},
    getDataSectionContents,
    getInitSectDirectives,
    getUsectLinkerDirectives,
    getConstantTableSetup,
    getConstantTableSetupCycles,
    getSpiCsIdleSetupCycles,
    pruCtrlBase,
    simulationData,
    buildDeviceBindings,
    buildDeviceBindingsWithModels,
    collectGpiDeviceClaims,
    resolveDeviceReaders,
    validateDeviceCapabilities,
    pruDeviceCaps,
    validateBidiPinCollisionsGlobal
};
