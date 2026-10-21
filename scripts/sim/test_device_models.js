/**
 * Unit tests for the in-tool device models and bus.
 *
 * The models in .metadata/.../simulation/device_models.js are JavaScript
 * ports of the Python DeviceModel implementations in the TI pru-simulator
 * checkout. These tests prove the PORTS behave: legal traffic is answered,
 * illegal traffic is refused. The cross-check that the two languages still
 * agree is scripts/sim/test_device_model_crosscheck.js — this file proves
 * behaviour, that one proves identity.
 *
 * The tests that matter are the refusals: a model that cannot reject broken
 * firmware is a waveform generator, not an oracle. Every fault arm is paired
 * with a control arm that is legal in the same shape, so a model that
 * faulted everything — or nothing — would fail here either way.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SIM_DIR = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                          'pru_blocks', 'common', 'simulation');

const scriptCache = {};
function loadSimScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
        console, Math, JSON, Number, Array, Object, Set, Error,
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

const busScript = loadSimScript(path.join(SIM_DIR, 'device_bus.js'));
const models = loadSimScript(path.join(SIM_DIR, 'device_models.js'));
const { DeviceBus, MASK_20 } = busScript;

/**
 * Drive a device on a bus with a scripted PRU output. gpoScript is
 * [[cycle, gpo], ...]; between entries the gpo holds. The PRU drives only
 * the pins in driveMask; the device's own pins are excluded, as the static
 * module does for real bindings.
 */
function runOnBus(device, gpoScript, totalCycles, driveMask) {
    const bus = new DeviceBus();
    bus.attach(device);
    let mask = driveMask !== undefined ? driveMask : MASK_20;
    for (const pin of Object.keys(device.nets || {})) {
        mask &= ~(1 << Number(pin));
    }
    bus.setPruDriveMask(mask);

    const r31Trace = [];
    let gpo = MASK_20; // idle high
    let scriptIdx = 0;
    for (let cycle = 1; cycle <= totalCycles; cycle++) {
        while (scriptIdx < gpoScript.length && gpoScript[scriptIdx][0] <= cycle) {
            gpo = gpoScript[scriptIdx][1];
            scriptIdx++;
        }
        r31Trace[cycle] = bus.settle(cycle, gpo);
    }
    return { bus, r31Trace };
}

/** Build the gpo script for one SSI frame: `bits` clocks at `period` cycles. */
function ssiClockScript(clkPin, clockCount, period, startCycle) {
    const bit = 1 << clkPin;
    const script = [];
    let cycle = startCycle;
    let level = MASK_20;               // idle high
    for (let i = 0; i < clockCount; i++) {
        level &= ~bit;                 // fall
        script.push([cycle, level]);
        cycle += Math.floor(period / 2);
        level |= bit;                  // rise
        script.push([cycle, level]);
        cycle += Math.ceil(period / 2);
    }
    return script;
}

/**
 * Independent SSI decoder: samples DATA on RISING clock edges, shares no
 * code with the model. Returns the decoded word, or null if no frame ran.
 */
function decodeSsi(r31Trace, clkPin, dataPin, bits) {
    let prevClk = 1;
    let word = 0;
    let sampled = 0;
    for (let cycle = 1; cycle < r31Trace.length; cycle++) {
        const clk = (r31Trace[cycle] >> clkPin) & 1;
        if (clk === 1 && prevClk === 0 && sampled < bits) {
            word = (word << 1) | ((r31Trace[cycle] >> dataPin) & 1);
            sampled++;
        }
        prevClk = clk;
    }
    return sampled === bits ? word >>> 0 : null;
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ---------------------------------------------------------------------------
// Quadrature encoder
// ---------------------------------------------------------------------------

test('quadrature: forward rotation walks the legal Gray sequence', () => {
    const enc = new models.QuadratureEncoder({ aPin: 0, bPin: 1, zPin: 2,
                                               countsPerRev: 8, cyclesPerCount: 10 });
    const { r31Trace } = runOnBus(enc, [], 95);
    const seen = [];
    for (let c = 1; c < r31Trace.length; c++) {
        const ab = r31Trace[c] & 0x3;
        if (seen.length === 0 || seen[seen.length - 1] !== ab) seen.push(ab);
    }
    // ab packs A on bit 0, B on bit 1, so the forward table (A,B) =
    // (0,0) -> (1,0) -> (1,1) -> (0,1) reads 0 -> 1 -> 3 -> 2.
    const table = [0b00, 0b01, 0b11, 0b10];
    for (let i = 1; i < seen.length; i++) {
        const prevIdx = table.indexOf(seen[i - 1]);
        assert.strictEqual(seen[i], table[(prevIdx + 1) % 4],
            `illegal A/B transition at step ${i}: ${seen[i - 1]} -> ${seen[i]}`);
    }
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
    assert.ok(seen.length >= 8, `expected at least 8 transitions, saw ${seen.length}`);
});

test('quadrature: reverse rotation walks the table backwards', () => {
    const enc = new models.QuadratureEncoder({ aPin: 0, bPin: 1, zPin: -1,
                                               countsPerRev: 8, cyclesPerCount: 10,
                                               forward: false });
    const { r31Trace } = runOnBus(enc, [], 55);
    const seen = [];
    for (let c = 1; c < r31Trace.length; c++) {
        const ab = r31Trace[c] & 0x3;
        if (seen.length === 0 || seen[seen.length - 1] !== ab) seen.push(ab);
    }
    const table = [0b00, 0b10, 0b11, 0b01];   // reverse order
    for (let i = 1; i < seen.length; i++) {
        const prevIdx = table.indexOf(seen[i - 1]);
        assert.strictEqual(seen[i], table[(prevIdx + 1) % 4],
            `illegal reverse transition at step ${i}`);
    }
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
});

test('quadrature: index pulses once per revolution', () => {
    const enc = new models.QuadratureEncoder({ aPin: 0, bPin: 1, zPin: 2,
                                               countsPerRev: 4, cyclesPerCount: 10 });
    const { r31Trace } = runOnBus(enc, [], 100);
    const indexEvents = enc.events().filter(e => e.kind === 'index');
    // 10 counts at counts_per_rev=4 crosses position 4 and 8.
    assert.ok(indexEvents.length >= 2, `expected >=2 index events, saw ${indexEvents.length}`);
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
    // Z is high exactly at the zero position.
    const zHighCycles = r31Trace.filter(v => ((v >> 2) & 1) === 1).length;
    assert.ok(zHighCycles > 0 && zHighCycles < 100, 'Z must pulse, not stick');
});

test('quadrature: position advances one count per cycles_per_count', () => {
    const enc = new models.QuadratureEncoder({ aPin: 0, bPin: 1, zPin: -1,
                                               countsPerRev: 1024, cyclesPerCount: 7 });
    // The first tick starts the clock, so count k begins at cycle 1 + k*7.
    runOnBus(enc, [], 71);
    assert.strictEqual(enc.position, 10, `position ${enc.position} after 71 cycles at 7 cyc/count`);
});

// ---------------------------------------------------------------------------
// SSI encoder
// ---------------------------------------------------------------------------

test('ssi: a correctly clocked frame decodes to the encoder position (gray)', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13,
                                        position: 0x1234 & 0x1FFF, minClkPeriodCycles: 10,
                                        monoflopCycles: 100, gray: true });
    const script = ssiClockScript(0, 14, 30, 10);   // 13 bits + 1 trailing edge
    const { bus, r31Trace } = runOnBus(enc, script, 10 + 14 * 30 + 50);
    const decoded = decodeSsi(r31Trace, 0, 1, 13);
    assert.notStrictEqual(decoded, null, 'no frame decoded');
    assert.strictEqual(decoded, models.toGray(0x1234 & 0x1FFF), 'decoded word mismatch');
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
    const frames = enc.events().filter(e => e.kind === 'frame');
    assert.strictEqual(frames.length, 1, 'expected exactly one frame event');
    assert.strictEqual(bus.faults().length, 0, JSON.stringify(bus.faults()));
});

test('ssi: a correctly clocked frame decodes to the position (binary)', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13,
                                        position: 2000, minClkPeriodCycles: 10,
                                        monoflopCycles: 100, gray: false });
    const script = ssiClockScript(0, 14, 30, 10);
    const { r31Trace } = runOnBus(enc, script, 10 + 14 * 30 + 50);
    const decoded = decodeSsi(r31Trace, 0, 1, 13);
    assert.strictEqual(decoded, 2000, 'binary decode mismatch');
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
});

test('ssi: clocking faster than f_max is a fault, not garbage', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13,
                                        position: 42, minClkPeriodCycles: 20,
                                        monoflopCycles: 400 });
    const script = ssiClockScript(0, 14, 6, 10);   // period 6 < minimum 20
    runOnBus(enc, script, 10 + 14 * 6 + 50);
    assert.ok(enc.faults().some(f => /below the encoder's minimum/.test(f)),
        'overclocking must fault: ' + JSON.stringify(enc.faults()));
});

test('ssi: a mid-word stall aborts the transfer and faults', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13,
                                        position: 42, minClkPeriodCycles: 10,
                                        monoflopCycles: 50 });
    // Two falling edges, then silence longer than the monoflop.
    const script = [
        [10, MASK_20 & ~1], [20, MASK_20],
        [30, MASK_20 & ~1], [40, MASK_20]
    ];
    runOnBus(enc, script, 40 + 120);
    assert.ok(enc.faults().some(f => /stalled/.test(f)),
        'stall must fault: ' + JSON.stringify(enc.faults()));
    assert.ok(enc.events().some(e => e.kind === 'abort'), 'stall must abort the word');
});

test('ssi: clocking past the end of the word is a fault', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 4,
                                        position: 9, minClkPeriodCycles: 10,
                                        monoflopCycles: 1000 });
    const script = ssiClockScript(0, 4 + 3, 30, 10);  // two edges too many
    runOnBus(enc, script, 10 + 7 * 30 + 20);
    assert.ok(enc.faults().some(f => /continued past the end/.test(f)),
        'overrun must fault: ' + JSON.stringify(enc.faults()));
});

test('ssi: a frame started after the monoflop is a fresh frame, not a fault', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 4,
                                        position: 9, minClkPeriodCycles: 10,
                                        monoflopCycles: 60 });
    const frame1 = ssiClockScript(0, 5, 30, 10);
    const frame2 = ssiClockScript(0, 5, 30, 10 + 5 * 30 + 200);
    runOnBus(enc, frame1.concat(frame2), 10 + 10 * 30 + 400);
    assert.strictEqual(enc.faults().length, 0, JSON.stringify(enc.faults()));
    assert.strictEqual(enc.events().filter(e => e.kind === 'frame').length, 2);
});

// ---------------------------------------------------------------------------
// Bus semantics
// ---------------------------------------------------------------------------

test('bus: push-pull contention between PRU and device is recorded, not resolved', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13, position: 1 });
    // PRU drives pin 1 (the device's DATA pin) LOW while the device drives it HIGH.
    const bus = new DeviceBus();
    bus.attach(enc);
    bus.setPruDriveMask(MASK_20);           // wrongly includes the device pin
    bus.settle(1, MASK_20 & ~(1 << 1));
    assert.ok(bus.faults().some(f => /contention/.test(f)), JSON.stringify(bus.faults()));
});

test('bus: excluding the device pins from the drive mask produces no false contention', () => {
    const enc = new models.SsiEncoder({ clkPin: 0, dataPin: 1, bits: 13, position: 1 });
    const { bus } = runOnBus(enc, ssiClockScript(0, 14, 30, 10), 500);
    assert.strictEqual(bus.contentions.length, 0, JSON.stringify(bus.contentions));
});

// ---------------------------------------------------------------------------
// Factory refusals — invalid devices must fail visibly
// ---------------------------------------------------------------------------

test('factory: an unknown kind is refused', () => {
    assert.throws(() => models.createDeviceModel('nonsense', { primary: 1 }, {}),
        /unknown device kind/);
});

test('factory: a kind not yet ported to the in-tool simulator is refused, not faked', () => {
    // The dropdown lists the full device catalogue; the in-tool simulator
    // only runs ported kinds. Refusing visibly beats substituting an
    // unproven stand-in - that substitution is the failure this item exists
    // to prevent.
    // Derived from the catalogue, not restated here. A hardcoded list goes stale
    // the moment a kind is ported: on 2026-09-09 this test still demanded that
    // bissc refuse, three commits after ported it, and the assertion
    // stopped at the first entry so the other four stale names were invisible.
    const unported = models.DEVICE_MODEL_KINDS.filter(k => !k.ported).map(k => k.kind);
    assert.ok(unported.length > 0,
        'catalogue lists no unported kind - this test would assert nothing');
    for (const kind of unported) {
        assert.throws(() => models.createDeviceModel(kind, { primary: 1, clock: 0 }, {}),
            /not available in the in-tool simulator/, `${kind} must refuse visibly`);
    }
    // The mirror: every kind the catalogue calls ported must NOT raise that error,
    // so a model that refused everything would fail here.
    for (const k of models.DEVICE_MODEL_KINDS.filter(k => k.ported)) {
        let err = null;
        try { models.createDeviceModel(k.kind, { primary: 1, clock: 0 }, {}); }
        catch (e) { err = e; }
        assert.ok(!err || !/not available in the in-tool simulator/.test(err.message),
            `${k.kind} is catalogued as ported but the factory refuses it as unported`);
    }
});

test('factory: unknown parameters are refused', () => {
    assert.throws(() => models.createDeviceModel('ssi', { primary: 1, clock: 0 },
                                                 { bits: 13, widjets: 2 }),
        /unknown ssi parameter "widjets"/);
});

test('factory: a bissc position parameter reaches the encoder frame', () => {
    // Red arm: before the key was refused ("unknown bissc parameter"), so
    // a GUI-attached BiSS-C encoder could only ever hold position 0.
    const m = models.createDeviceModel('bissc', { primary: 1, clock: 0 },
                                       { position_bits: 21, position: 1234567 });
    assert.strictEqual(m.encoder.position, 1234567);
    const bits = m.encoder._bits;
    const payload = bits.slice(bits.length - 6 - 2 - 21, bits.length - 6 - 2);
    assert.strictEqual(parseInt(payload.join(''), 2), 1234567);
    const zero = models.createDeviceModel('bissc', { primary: 1, clock: 0 }, {});
    assert.strictEqual(zero.encoder.position, 0, 'default stays 0');
});

test('factory: pins smuggled through parameters are refused', () => {
    assert.throws(() => models.createDeviceModel('ssi', { primary: 1, clock: 0 },
                                                 { clk_pin: 3 }),
        /pins come from the pin fields/);
});

test('factory: out-of-range constructor values are refused', () => {
    assert.throws(() => models.createDeviceModel('ssi', { primary: 1, clock: 0 },
                                                 { bits: 0 }), /bits must be >= 1/);
    assert.throws(() => models.createDeviceModel('quadrature', { primary: 0, clock: 1 },
                                                 { cycles_per_count: 0 }),
        /cycles_per_count must be >= 1/);
});

test('factory: a clocked device with no clock pin is refused', () => {
    assert.throws(() => models.createDeviceModel('ssi', { primary: 1, clock: -1 }, {}),
        /needs a Clock pin/);
});

test('factory: legal bindings construct', () => {
    const ssi = models.createDeviceModel('ssi', { primary: 1, clock: 0 }, { bits: 13 });
    assert.strictEqual(ssi.bits, 13);
    const quad = models.createDeviceModel('quadrature', { primary: 0, clock: 1, index: 2 },
                                          { counts_per_rev: 100 });
    assert.strictEqual(quad.countsPerRev, 100);
});

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
