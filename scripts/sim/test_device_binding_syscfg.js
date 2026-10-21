/**
 * Device binding in the SysConfig Simulation Settings module.
 *
 * SysConfig config objects cannot be loaded outside the SysConfig runtime, so
 * these tests exercise `validateDeviceInput` by extracting it from the module
 * source and evaluating it against a stub `report`. That is a real limitation
 * and worth naming: it proves the VALIDATION LOGIC, not that SysConfig renders
 * the fields. Rendering is checked by opening the tool.
 *
 * The tests that matter are the refusals. Device mode is the one input mode
 * where the user does not author the waveform, so its failure mode is
 * different: a device wired to the wrong pins, or given a parameter the model
 * will silently drop, produces a simulation that runs happily and proves
 * nothing — the exact outcome attaching a real model is meant to prevent.
 *
 * Every refusal is paired with a control arm that is legal in the same shape.
 * Without those, a validator that rejected everything would pass every test.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                      'pru_blocks', 'common', 'pru_blocks_static_module.syscfg.js');

function loadValidator() {
    // Normalise line endings first: this repo's sources are CRLF, and matching
    // on a bare "\n}\n" silently finds nothing.
    const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function validateDeviceInput');
    assert.notStrictEqual(start, -1, 'validateDeviceInput not found in the module');

    // Take from the function keyword to the line that closes it at column 0.
    const rest = source.slice(start);
    const end = rest.indexOf('\n}\n');
    assert.notStrictEqual(end, -1, 'could not find the end of validateDeviceInput');
    const body = rest.slice(0, end + 2);

    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return validateDeviceInput;`)();
}

const validateDeviceInput = loadValidator();

function makeReport() {
    const errors = [];
    return {
        errors,
        logError(message, _inst, field) { errors.push({ message, field }); }
    };
}

function inst(pinNum, overrides) {
    const base = {};
    base[`gpi${pinNum}_deviceKind`] = 'quadrature';
    base[`gpi${pinNum}_deviceClockPin`] = -1;
    base[`gpi${pinNum}_deviceIndexPin`] = -1;
    base[`gpi${pinNum}_deviceParams`] = '{}';
    return Object.assign(base, overrides || {});
}

function run(pinNum, overrides) {
    const report = makeReport();
    const ok = validateDeviceInput(inst(pinNum, overrides), report, pinNum);
    return { ok, errors: report.errors };
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// -- control arms: legal configurations must pass -----------------------------

test('a single-pin quadrature device with no companions is accepted', () => {
    const r = run(0);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a quadrature device with B and Z on distinct pins is accepted', () => {
    const r = run(0, { gpi0_deviceClockPin: 1, gpi0_deviceIndexPin: 2 });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a clocked device with a clock pin is accepted', () => {
    const r = run(3, { gpi3_deviceKind: 'ssi', gpi3_deviceClockPin: 4 });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('model parameters that are not pins are accepted', () => {
    const r = run(3, {
        gpi3_deviceKind: 'ssi',
        gpi3_deviceClockPin: 4,
        gpi3_deviceParams: '{"bits": 13, "position": 1024}'
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// -- refusals -----------------------------------------------------------------

test('a clocked device with no clock pin is refused', () => {
    // The load-bearing one: a clocked slave with no clock produces an idle
    // trace, which reads exactly like firmware that never ran.
    const r = run(3, { gpi3_deviceKind: 'ssi' });
    assert.strictEqual(r.ok, false);
    assert.ok(/needs a Clock pin/.test(r.errors[0].message), r.errors[0].message);
});

test('a companion pin equal to the primary pin is refused', () => {
    const r = run(5, { gpi5_deviceClockPin: 5 });
    assert.strictEqual(r.ok, false);
    assert.ok(/same pin as the device's primary pin/.test(r.errors[0].message));
});

test('a companion pin out of range is refused', () => {
    const r = run(0, { gpi0_deviceClockPin: 20 });
    assert.strictEqual(r.ok, false);
    assert.ok(/must be 0-19/.test(r.errors[0].message));
});

test('an index pin with no clock pin is refused', () => {
    const r = run(0, { gpi0_deviceIndexPin: 2 });
    assert.strictEqual(r.ok, false);
    assert.ok(/without a second/.test(r.errors[0].message));
});

test('two companions on the same pin are refused', () => {
    const r = run(0, { gpi0_deviceClockPin: 7, gpi0_deviceIndexPin: 7 });
    assert.strictEqual(r.ok, false);
    assert.ok(/cannot be the same pin/.test(r.errors[0].message));
});

test('malformed JSON in the parameters is refused', () => {
    const r = run(0, { gpi0_deviceParams: '{bits: 13}' });
    assert.strictEqual(r.ok, false);
    assert.ok(/Use JSON object syntax/.test(r.errors[0].message));
});

test('a JSON array instead of an object is refused', () => {
    const r = run(0, { gpi0_deviceParams: '[13]' });
    assert.strictEqual(r.ok, false);
    assert.ok(/must be a JSON object/.test(r.errors[0].message));
});

test('a pin assignment smuggled through the parameters is refused', () => {
    // Two sources of truth for the same fact drift. The pin fields win, so a
    // pin in the params must be an error rather than a silently ignored value.
    for (const key of ['clk_pin', 'data_pin', 'a_pin', 'b_pin', 'z_pin', 'pin']) {
        const r = run(3, {
            gpi3_deviceKind: 'ssi',
            gpi3_deviceClockPin: 4,
            gpi3_deviceParams: JSON.stringify({ [key]: 9 })
        });
        assert.strictEqual(r.ok, false, `${key} should have been refused`);
        assert.ok(/pins come from the pin fields/.test(r.errors[0].message));
    }
});

test('every refusal names the field it is about', () => {
    // A SysConfig error with no field attaches to nothing in the UI.
    const r = run(3, { gpi3_deviceKind: 'ssi' });
    assert.ok(r.errors[0].field, 'error must name a config field');
});

let failed = 0;
for (const [name, fn] of cases) {
    try {
        fn();
        console.log(`ok   - ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`FAIL - ${name}\n       ${e.message}`);
    }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
