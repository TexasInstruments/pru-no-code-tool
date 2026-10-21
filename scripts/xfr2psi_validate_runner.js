#!/usr/bin/env node
'use strict';
/*
 * XFR2PSI block validator runner (committed script — called by tests by path).
 * Loads the real xfr2psi_block.syscfg.js validate() against a mocked SysConfig runtime.
 *
 * Usage:
 *   node scripts/xfr2psi_validate_runner.js <json-config-path> [coreName] [soc]
 *   json-config-path: path to JSON file containing instance overrides (partial).
 *   coreName: e.g. icss_g0_pru0, icss_g0_rtu_pru0 (default icss_g0_pru0)
 *   soc: e.g. am64x, am261x (default am64x)
 *
 * Prints JSON array of error messages on stdout.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const configPath = process.argv[2];
const coreName = process.argv[3] || 'icss_g0_pru0';
const soc = process.argv[4] || 'am64x';

if (!configPath) {
    console.error('Usage: node scripts/xfr2psi_validate_runner.js <json-config-path> [coreName] [soc]');
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
const BLOCK_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'pru_io_blocks', 'xfr2psi_block.syscfg.js');

let src = fs.readFileSync(BLOCK_PATH, 'utf8');

// Mock system
const mockCommon = {
    getSocName: () => soc,
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
    deviceData: { device: soc.toUpperCase() + '_TEST', package: 'ZCZ' },
    modules: {},
    getScript: (p) => {
        if (p === '/common' || p === 'common' || p.includes('/common')) return mockCommon;
        return makeStub();
    },
    contexts: {},
};

// Load block via vm
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

// Build instance with defaults matching block config
const base = {
    $name: 'XFR2PSI_0',
    operation: 'send',
    threadId: 0,
    direction: 'tx',
    useSharedPair: false,
    rtuPruPsiShareEn: false,
    txSop: false,
    txEop: false,
    txSol: false,
    txEol: false,
    txLastw: false,
    txDrop: false,
    txPktError: 0,
    txDataType: 0,
    dataWidth: 64,
    xinByteEnableMask: '0xFF',
    checkReady: true,
    consumeRxBytes: true,
    noOfCycles: 3,
};
const inst = Object.assign({}, base, overrides);
// Allow overrides to set noOfCycles via function marker string
if (overrides._noOfCyclesFixed !== undefined) {
    inst.noOfCycles = overrides._noOfCyclesFixed;
}
const errors = [];
const report = {
    logError: (msg) => errors.push(String(msg)),
    logWarning: () => {},
    logInfo: () => {},
};
try {
    mod.validate(inst, report);
} catch (e) {
    errors.push('validate threw: ' + e.message);
}
console.log(JSON.stringify(errors));
