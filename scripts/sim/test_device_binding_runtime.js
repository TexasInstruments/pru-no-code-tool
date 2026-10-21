/**
 * Runtime tests: device models attached to the RUNNING simulation.
 *
 * The config layer (1657e6e) let the user describe a binding; this suite
 * proves the wiring tranche: the JS simulator (pru_core.js) settles a
 * DeviceBus every cycle, so an attached device ANSWERS the firmware rather
 * than replaying a recording. A correct SSI master reads the encoder's
 * position; a master that clocks too fast is REFUSED by the model. That
 * asymmetry — pass when right, fail when wrong — is the entire point of
 * attaching a behavioural model, and both arms are tested.
 *
 * Also proven here:
 *   - the verdict/margin glue (buildDeviceRunResults, measureClockWaveform)
 *     extracted verbatim from the static module, so what is tested is what
 *     ships;
 *   - fail-closed verdicts: a device that never spoke is a FAIL, not a pass;
 *   - no path, build directory or interpreter string appears in any output
 *     the user can see.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SIM_DIR = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                          'pru_blocks', 'common', 'simulation');
const STATIC_MODULE = path.join(SIM_DIR, '..', 'pru_blocks_static_module.syscfg.js');

// -- load the sim scripts exactly as the headless shim does -------------------

const scriptCache = {};
function loadSimScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
        console, Math, JSON, Number, Array, Object, Set, Error, Uint8Array,
        parseInt, isNaN,
        system: {
            getScript: (p) => {
                const basename = path.basename(p);
                if (!scriptCache[basename]) {
                    scriptCache[basename] = loadSimScript(path.join(SIM_DIR, basename));
                }
                return scriptCache[basename];
            }
        },
        exports: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.exports;
}

const pruCore = loadSimScript(path.join(SIM_DIR, 'pru_core.js'));
const busScript = loadSimScript(path.join(SIM_DIR, 'device_bus.js'));
const models = loadSimScript(path.join(SIM_DIR, 'device_models.js'));
const { DeviceBus, MASK_20 } = busScript;

// -- extract the verdict glue verbatim from the static module -----------------
// The functions are self-contained (module-scope references only to each
// other), so they can be evaluated exactly as shipped. Same technique and
// same caveat as test_device_binding_syscfg.js: this proves the LOGIC, not
// SysConfig's rendering.

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}`);
    assert.notStrictEqual(start, -1, `${name} not found in the static module`);
    const rest = source.slice(start);
    const end = rest.indexOf('\n}\n');
    assert.notStrictEqual(end, -1, `could not find the end of ${name}`);
    return rest.slice(0, end + 2);
}

const staticSrc = fs.readFileSync(STATIC_MODULE, 'utf8').replace(/\r\n/g, '\n');
const glue = new Function(
    extractFunction(staticSrc, 'measureClockWaveform') +
    extractFunction(staticSrc, 'buildDeviceRunResults') +
    '; return { measureClockWaveform, buildDeviceRunResults };'
)();

// -- helpers -------------------------------------------------------------------

/** Attach devices the way the static module does: device pins out of the
 *  PRU drive mask, so a correct design records no false contention. */
function attachBus(devices) {
    const bus = new DeviceBus();
    let mask = MASK_20;
    for (const dev of devices) {
        bus.attach(dev);
        for (const pin of Object.keys(dev.nets || {})) {
            mask &= ~(1 << Number(pin));
        }
    }
    bus.setPruDriveMask(mask);
    return bus;
}

function runSim(instructions, labels, cycles, deviceBus) {
    return pruCore.simulatePruInstructions(instructions, labels, cycles, {}, {}, deviceBus);
}

/**
 * A 4-bit SSI master in PRU assembly. CLK is R30 bit 0, DATA is R31 bit 1.
 * Falls, shifts, rises, samples - one instruction per cycle - then issues
 * the trailing edge that ends the word, and halts.
 */
const SSI_MASTER = [
    'ldi  R4, 0',
    'ldi  R5, 4',
    'ldi  R6, 1',
    'set  R30, R30, 0',
    // m_bit:
    'clr  R30, R30, 0',
    'lsl  R4, R4, 1',
    'set  R30, R30, 0',
    'qbbc m_zero, R31, 1',
    'or   R4, R4, R6',
    // m_zero:
    'sub  R5, R5, 1',
    'qbne m_bit, R5, 0',
    // trailing edge: end of word
    'clr  R30, R30, 0',
    'set  R30, R30, 0',
    'halt'
];
const SSI_MASTER_LABELS = SSI_MASTER.map((ins, i) =>
    i === 4 ? 'm_bit' : (i === 9 ? 'm_zero' : 0));

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ---------------------------------------------------------------------------
// Closed loop: the device answers the firmware
// ---------------------------------------------------------------------------

test('a correct SSI master reads the encoder position through the bus', () => {
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 0b1011, gray: false,
        min_clk_period_cycles: 4, monoflop_cycles: 200
    });
    const bus = attachBus([enc]);
    const { pruState } = runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, bus);

    assert.strictEqual(pruState.registers[4], 0b1011,
        `firmware read 0b${pruState.registers[4].toString(2)}, expected 0b1011`);
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
    assert.strictEqual(enc.events().filter(e => e.kind === 'frame').length, 1,
        'the trailing edge must close the frame');
});

test('a master that clocks faster than f_max is refused by the device', () => {
    // Identical firmware, but the model is a faster part's slower sibling:
    // min period 20 cycles while the loop clocks every ~7. On hardware the
    // encoder returns garbage; the model must FAULT instead.
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 0b1011, gray: false,
        min_clk_period_cycles: 20, monoflop_cycles: 400
    });
    const bus = attachBus([enc]);
    runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, bus);
    assert.ok(enc.faults().some(f => /below the encoder's minimum/.test(f)),
        'overclocked firmware must be refused: ' + JSON.stringify(enc.faults()));
});

test('without a device, R31 stays whatever the fixed history says (open loop unchanged)', () => {
    const { pruState } = runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, null);
    // No device: DATA reads 0 throughout, so R4 shifts in zeros.
    assert.strictEqual(pruState.registers[4], 0);
});

test('a device pin driven by the firmware records contention', () => {
    // Firmware wrongly drives the DATA pin (R30 bit 1) while the encoder
    // drives it too. This is the "both ends drive one wire" design error and
    // must be visible, not silently resolved.
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 1, min_clk_period_cycles: 4
    });
    const bus = new DeviceBus();
    bus.attach(enc);                    // NOTE: full drive mask, the misconfiguration
    const badFirmware = ['set R30, R30, 1', 'clr R30, R30, 1', 'halt'];
    runSim(badFirmware, [0, 0, 0], 50, bus);
    assert.ok(bus.faults().some(f => /contention/.test(f)),
        'contention must be recorded: ' + JSON.stringify(bus.faults()));
});

// ---------------------------------------------------------------------------
// Verdict and margin glue (extracted verbatim from the static module)
// ---------------------------------------------------------------------------

test('verdict: clean run with a decoded frame is a PASS with a measured margin', () => {
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 0b1011, gray: false,
        min_clk_period_cycles: 4, monoflop_cycles: 200
    });
    const bus = attachBus([enc]);
    const { r30ValueHistory } = runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, bus);

    const bindings = [{ pinNum: 1, kind: 'ssi', clockPin: 0, indexPin: -1, params: {}, device: enc }];
    const results = glue.buildDeviceRunResults(bus, bindings, r30ValueHistory);
    assert.strictEqual(results.length, 1);
    const r = results[0];
    assert.strictEqual(r.verdict, 'PASS', `${r.summary} | faults: ${JSON.stringify(r.faults)}`);
    assert.ok(r.decode.length >= 1, 'protocol decode must carry the frame');
    assert.ok(r.margin, 'margin must be measured');
    // The loop clocks every ~7 cycles against a limit of 4.
    assert.ok(r.margin.observedMinPeriodCycles >= 4,
        `measured period ${r.margin.observedMinPeriodCycles}`);
    assert.strictEqual(r.margin.slackCycles,
        r.margin.observedMinPeriodCycles - 4);
    assert.ok(/PASS/.test(r.summary) && /margin/.test(r.summary), r.summary);
});

test('verdict: a faulted run is a FAIL naming the violation', () => {
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 3, min_clk_period_cycles: 20, monoflop_cycles: 400
    });
    const bus = attachBus([enc]);
    const { r30ValueHistory } = runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, bus);

    const bindings = [{ pinNum: 1, kind: 'ssi', clockPin: 0, indexPin: -1, params: {}, device: enc }];
    const r = glue.buildDeviceRunResults(bus, bindings, r30ValueHistory)[0];
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(/protocol violation/.test(r.summary), r.summary);
});

test('verdict: a device that never spoke is a FAIL, not a pass', () => {
    // Firmware that never toggles the clock produces an idle trace that
    // reads exactly like firmware that never ran. That must not pass.
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 3, min_clk_period_cycles: 4
    });
    const bus = attachBus([enc]);
    const idleFirmware = ['set R30, R30, 0', 'halt'];
    const { r30ValueHistory } = runSim(idleFirmware, [0, 0], 100, bus);

    const bindings = [{ pinNum: 1, kind: 'ssi', clockPin: 0, indexPin: -1, params: {}, device: enc }];
    const r = glue.buildDeviceRunResults(bus, bindings, r30ValueHistory)[0];
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(/never spoke/.test(r.summary), r.summary);
});

test('verdict: macro blocks report cannot execute macro blocks instead of device never spoke', () => {
    // When macro blocks (m_*) are encountered, the JS preview skips
    // them and explains that macro blocks cannot be executed in the preview,
    // rather than claiming the device never spoke.
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 3, min_clk_period_cycles: 4
    });
    const bus = attachBus([enc]);
    const macroFirmware = ['m_ssi_read R0, 25', 'halt'];
    const { pruState, r30ValueHistory } = runSim(macroFirmware, [0, 0], 100, bus);

    assert.strictEqual(pruState.skippedMacroCount, 1);
    assert.strictEqual(pruState.skippedMacros.length, 1);
    assert.strictEqual(pruState.skippedMacros[0], 'm_ssi_read');

    const bindings = [{ pinNum: 1, kind: 'ssi', clockPin: 0, indexPin: -1, params: {}, device: enc }];
    const r = glue.buildDeviceRunResults(bus, bindings, r30ValueHistory, pruState)[0];
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(/cannot execute macro blocks \(m_ssi_read\)/.test(r.summary), r.summary);
    assert.ok(!/never spoke/.test(r.summary), r.summary);

    // Mutant arm: dropping the skip counter falls back to 'never spoke' and fails the assertion
    const mutantState = Object.assign({}, pruState, { skippedMacroCount: 0 });
    const mutantR = glue.buildDeviceRunResults(bus, bindings, r30ValueHistory, mutantState)[0];
    assert.ok(/never spoke/.test(mutantR.summary), mutantR.summary);
    assert.ok(!/cannot execute macro blocks/.test(mutantR.summary), mutantR.summary);
});

test('margin: the measurement reads the trace, not the configuration', () => {
    // A clock scripted at 10-cycle periods must measure 10 regardless of
    // what any config field claims - lesson.
    const history = new Array(201).fill(1);   // bit 0 high
    for (let start = 20; start < 200; start += 100) {
        for (let c = start; c < start + 5; c++) history[c] = 0;   // 5 low, 5 high
    }
    const m = glue.measureClockWaveform(history, 0);
    assert.strictEqual(m.observedMinPeriod, 100, `measured ${m.observedMinPeriod}`);
});

// ---------------------------------------------------------------------------
// Output hygiene: nothing the user sees may name a path or an interpreter
// ---------------------------------------------------------------------------

test('no path, build directory, or interpreter string appears in device output', () => {
    const enc = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, {
        bits: 4, position: 1, min_clk_period_cycles: 20
    });
    const bus = attachBus([enc]);
    const { r30ValueHistory } = runSim(SSI_MASTER, SSI_MASTER_LABELS, 300, bus);
    const bindings = [{ pinNum: 1, kind: 'ssi', clockPin: 0, indexPin: -1, params: {}, device: enc }];
    const blob = JSON.stringify(glue.buildDeviceRunResults(bus, bindings, r30ValueHistory));
    assert.ok(!/[A-Za-z]:[\\/]/.test(blob), 'absolute path leaked');
    assert.ok(!/\.py\b|python|node\b|build_out|\.metadata/i.test(blob),
        'toolchain detail leaked: ' + blob.slice(0, 200));
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of cases) {
    try {
        fn();
        console.log(`ok   - ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`FAIL - ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`);
    }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
