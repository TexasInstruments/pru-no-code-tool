#!/usr/bin/env node
'use strict';
/*
 * SUM32 block validator runner (committed script — called by tests by path).
 * Loads the real sum32_block.syscfg.js validate() against a mocked SysConfig runtime.
 *
 * Usage:
 *   node scripts/sum32_validate_runner.js <json-config-path> [coreName]
 *   json-config-path: path to JSON file containing instance overrides (partial).
 *   coreName: e.g. icss_g0_pru0, icss_g0_rtu_pru0, icss_g0_tx_pru0 (default icss_g0_pru0)
 *
 * Prints JSON {"errors": [...], "warnings": [...]} on stdout.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const configPath = process.argv[2];
const coreName = process.argv[3] || 'icss_g0_pru0';

if (!configPath) {
    console.error('Usage: node scripts/sum32_validate_runner.js <json-config-path> [coreName]');
    process.exit(2);
}
let overrides = {};
try {
    overrides = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('Failed to read config JSON: ' + e.message);
    process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const BLOCK_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'data_handling', 'sum32_block.syscfg.js');

const src = fs.readFileSync(BLOCK_PATH, 'utf8');

const mockCommon = {
    getSelfSysCfgCoreName: () => coreName,
};
function makeStub() {
    const fn = function () { return makeStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
            if (prop === Symbol.iterator) return undefined;
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply() { return makeStub(); },
    });
}
const mockSystem = {
    modules: {},
    getScript: (p) => {
        if (p === '/common' || p === 'common' || p.includes('/common')) return mockCommon;
        return makeStub();
    },
};

const sandbox = {
    system: mockSystem,
    exports: {},
    module: { exports: {} },
    console: { log() {}, error() {}, warn() {} },
    require: () => makeStub(),
};
sandbox.global = sandbox;
vm.createContext(sandbox);
try {
    vm.runInContext(src, sandbox, { filename: BLOCK_PATH, timeout: 5000 });
} catch (e) {
    console.error('VM load failed: ' + e.stack);
    process.exit(2);
}
const mod = sandbox.exports;
if (!mod.validate) {
    console.error('validate not found');
    process.exit(2);
}

const base = {
    $name: 'SUM32_0',
    operation: 'accumulate',
    bsRamSnoop: false,
    input1: [{}],
};
const inst = Object.assign({}, base, overrides);
const errors = [];
const warnings = [];
const report = {
    logError: (msg) => errors.push(String(msg)),
    logWarning: (msg) => warnings.push(String(msg)),
    logInfo: () => {},
};
try {
    mod.validate(inst, report);
} catch (e) {
    errors.push('validate threw: ' + e.message);
}
console.log(JSON.stringify({ errors, warnings }));
