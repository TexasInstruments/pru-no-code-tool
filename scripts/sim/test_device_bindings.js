/**
 * The device-binding manifest emitted from Simulation Settings.
 *
 * Same constraint as test_device_binding_syscfg.js: SysConfig config objects
 * cannot be loaded outside the SysConfig runtime, so `buildDeviceBindings` is
 * extracted from the module source and evaluated against plain objects. That
 * proves the MANIFEST CONTENT, not that SysConfig writes the file - the
 * template registration is checked by opening the tool.
 *
 * The tests that matter are the ones a lazy implementation gets wrong: a pin
 * that is not in device mode must not appear, the GUI's -1 sentinel must not
 * leak into the manifest as a pin number, and the output must be stable
 * regardless of the order the user selected pins in.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                      'pru_blocks', 'common', 'pru_blocks_static_module.syscfg.js');

function loadBuilder() {
    // This repo's sources are CRLF; matching on a bare newline-brace finds nothing.
    const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function buildDeviceBindings');
    assert.notStrictEqual(start, -1, 'buildDeviceBindings not found in the module');
    const rest = source.slice(start);
    const end = rest.indexOf('\n}\n');
    assert.notStrictEqual(end, -1, 'could not find the end of buildDeviceBindings');
    const body = rest.slice(0, end + 2);
    // eslint-disable-next-line no-new-func
    return new Function(body + '; return buildDeviceBindings;')();
}

const buildDeviceBindings = loadBuilder();

// A static instance with every pin defaulted, then overridden per test. Built
// fresh each time so one test cannot leak state into the next.
function inst(overrides) {
    const o = { pruClkFreq: 200, pruCyclesToSimulate: 2000, signalsToDisplayR31: [] };
    for (let p = 0; p <= 19; p++) {
        o['gpi' + p + '_inputMode'] = 'timestamp';
        o['gpi' + p + '_deviceKind'] = 'quadrature';
        o['gpi' + p + '_deviceClockPin'] = -1;
        o['gpi' + p + '_deviceIndexPin'] = -1;
        o['gpi' + p + '_deviceParams'] = '{}';
    }
    return Object.assign(o, overrides || {});
}

function device(pin, kind, clockPin, indexPin, params) {
    const o = {};
    o['gpi' + pin + '_inputMode'] = 'device';
    o['gpi' + pin + '_deviceKind'] = kind;
    o['gpi' + pin + '_deviceClockPin'] = clockPin === undefined ? -1 : clockPin;
    o['gpi' + pin + '_deviceIndexPin'] = indexPin === undefined ? -1 : indexPin;
    o['gpi' + pin + '_deviceParams'] = params === undefined ? '{}' : params;
    return o;
}

const tests = {};

tests['a manifest is produced even with nothing attached'] = function () {
    // The empty manifest has to be a real, well-formed manifest. A consumer
    // that cannot tell "no devices" from "generation never ran" will treat a
    // missing file as a pass.
    const m = buildDeviceBindings(inst());
    assert.strictEqual(m.version, 1);
    assert.deepStrictEqual(m.bindings, []);
    assert.strictEqual(m.pruClkFreqMhz, 200);
    assert.strictEqual(m.cyclesToSimulate, 2000);
};

tests['only pins actually in device mode are emitted'] = function () {
    // Pin 3 is selected and carries device configuration but is left in
    // timestamp mode. Emitting it would attach a model the user did not ask for.
    const o = inst(Object.assign({ signalsToDisplayR31: ['3', '5'] },
                                 device(5, 'ssi', 6)));
    o.gpi3_deviceKind = 'endat';       // configured, but mode is timestamp
    const m = buildDeviceBindings(o);
    assert.strictEqual(m.bindings.length, 1);
    assert.strictEqual(m.bindings[0].primaryPin, 5);
    assert.strictEqual(m.bindings[0].kind, 'ssi');
};

tests['a pin not selected at all is not emitted'] = function () {
    // Device fields survive in the .syscfg after a pin is deselected. That is
    // stale configuration, not an attachment.
    const o = inst(Object.assign({ signalsToDisplayR31: [] }, device(2, 'ssi', 3)));
    assert.deepStrictEqual(buildDeviceBindings(o).bindings, []);
};

tests['the -1 unused sentinel becomes null, not a pin number'] = function () {
    // The one that bites: -1 arriving in the consumer as an integer pin index
    // attaches a model to a pin that does not exist, or wraps to pin 19 under
    // a mask. null is unambiguous across the JSON boundary.
    const o = inst(Object.assign({ signalsToDisplayR31: ['0'] },
                                 device(0, 'quadrature', 1)));
    const b = buildDeviceBindings(o).bindings[0];
    assert.strictEqual(b.clockPin, 1);
    assert.strictEqual(b.indexPin, null);
    assert.notStrictEqual(b.indexPin, -1);
};

tests['all three pins carry through when set'] = function () {
    const o = inst(Object.assign({ signalsToDisplayR31: ['4'] },
                                 device(4, 'quadrature', 5, 6)));
    const b = buildDeviceBindings(o).bindings[0];
    assert.strictEqual(b.primaryPin, 4);
    assert.strictEqual(b.clockPin, 5);
    assert.strictEqual(b.indexPin, 6);
};

tests['parameters are parsed into an object, not passed as a string'] = function () {
    const o = inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                 device(1, 'ssi', 2, -1, '{"bits": 13, "position": 1024}')));
    const b = buildDeviceBindings(o).bindings[0];
    assert.deepStrictEqual(b.params, { bits: 13, position: 1024 });
};

tests['malformed parameters degrade to empty instead of killing generation'] = function () {
    // Validation blocks this through the GUI. If it ever arrives anyway, a
    // template that throws takes every other generated file down with it - the
    // user would lose pru_syscfg.inc over a typo in a JSON box.
    const o = inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                 device(1, 'ssi', 2, -1, '{not json')));
    assert.deepStrictEqual(buildDeviceBindings(o).bindings[0].params, {});
};

tests['a JSON array of parameters is rejected, not spread'] = function () {
    const o = inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                 device(1, 'ssi', 2, -1, '[1,2,3]')));
    assert.deepStrictEqual(buildDeviceBindings(o).bindings[0].params, {});
};

tests['the manifest is stable regardless of pin selection order'] = function () {
    // An emitted file that reorders itself between runs shows as a spurious
    // diff.
    const base = Object.assign({}, device(7, 'ssi', 8), device(2, 'endat', 3));
    const a = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['7', '2'] }, base)));
    const b = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['2', '7'] }, base)));
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.bindings.map(function (x) { return x.primaryPin; }), [2, 7]);
};

tests['several devices are all emitted'] = function () {
    const o = inst(Object.assign({ signalsToDisplayR31: ['0', '4', '9'] },
                                 device(0, 'quadrature', 1, 2),
                                 device(4, 'ssi', 5),
                                 device(9, 'uart')));
    const m = buildDeviceBindings(o);
    assert.strictEqual(m.bindings.length, 3);
    assert.deepStrictEqual(m.bindings.map(function (b) { return b.kind; }),
                           ['quadrature', 'ssi', 'uart']);
};

// ------------------------------------------------------------------
// resolveDeviceReaders: the register gmake sim compares comes from the
// allocator, per design, never from a per-kind constant.
function loadResolver() {
    const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function resolveDeviceReaders');
    assert.notStrictEqual(start, -1, 'resolveDeviceReaders not found in the module');
    const rest = source.slice(start);
    const end = rest.indexOf('\n}\n');
    // The function reads the reader table through the module-level deviceModelTable (common/device_model_table.js).
    const deviceModelTable = require(path.join(path.dirname(SRC), 'device_model_table.js'));
    // eslint-disable-next-line no-new-func
    return new Function('deviceModelTable', rest.slice(0, end + 2) + '; return resolveDeviceReaders;')(deviceModelTable);
}
const resolveDeviceReaders = loadResolver();
const BISS = '/pru_blocks/application_specific/biss_c_initiator_block';
const SSI = '/pru_blocks/application_specific/ssi_initiator_block';

function alloc(map, order) {
    return { registerOf: function (n) { return map[n] || '-'; }, order: order };
}

tests['the reader carries the allocator register, not a default'] = function () {
    const m = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                                     device(1, 'bissc', 0))));
    const modules = {};
    modules[BISS] = { $instances: [{ $name: 'Read', dataPin: 1 }] };
    resolveDeviceReaders(m, modules, alloc({ Load: 'R0.b0', Read: 'R1' }, ['Load', 'Read', 'Cond']));
    assert.deepStrictEqual(m.bindings[0].readers,
        [{ block: 'Read', module: BISS, resultRegister: 'R1', laterWriters: [] }]);
};

tests['a block on another pin is not a reader; no reader is an empty list'] = function () {
    const m = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['2'] },
                                                     device(2, 'ssi', 0))));
    const modules = {};
    modules[SSI] = { $instances: [{ $name: 'Read', dataPin: 1 }] };
    resolveDeviceReaders(m, modules, alloc({ Read: 'R0' }, ['Read']));
    assert.deepStrictEqual(m.bindings[0].readers, []);
};

tests['a kind with no decoder gets no reader record at all'] = function () {
    const m = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                                     device(1, 'quadrature', 2))));
    resolveDeviceReaders(m, {}, alloc({}, []));
    assert.strictEqual('readers' in m.bindings[0], false);
};

tests['a later block reusing the result register is recorded; an earlier one is not'] = function () {
    const m = buildDeviceBindings(inst(Object.assign({ signalsToDisplayR31: ['1'] },
                                                     device(1, 'bissc', 0))));
    const modules = {};
    modules[BISS] = { $instances: [{ $name: 'Read', dataPin: 1 }] };
    resolveDeviceReaders(m, modules, alloc(
        { Early: 'R1', Read: 'R1', Other: 'R2', Scale: 'R1.w2', Loop: 'R3, R1.b0 (loop)' },
        ['Early', 'Read', 'Other', 'Scale', 'Loop']));
    assert.deepStrictEqual(m.bindings[0].readers[0].laterWriters, ['Scale', 'Loop']);
};

let failed = 0;
for (const name of Object.keys(tests)) {
    try {
        tests[name]();
        console.log('  ok   ' + name);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + name + '\n       ' + e.message);
    }
}
console.log('\n' + (Object.keys(tests).length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
