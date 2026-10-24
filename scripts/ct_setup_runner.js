#!/usr/bin/env node
'use strict';
/*
 * test runner: calls getConstantTableSetup from the real
 * pru_blocks_static_module.syscfg.js with a design made of REAL block modules
 * (their own getMacro), for one SysConfig core context.
 *
 * Usage:
 *   node scripts/ct_setup_runner.js <coreName> <blockPath>[:<opCode>] ...
 * blockPath is relative to .metadata/sysconfig/.meta/pru_blocks, e.g.
 *   utils/logic_analyzer_block
 * Prints JSON {setup: <string>, error: <string|null>} on stdout.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BLOCKS = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');
const STATIC_PATH = path.join(BLOCKS, 'common', 'pru_blocks_static_module.syscfg.js');

const coreName = process.argv[2];
const blockArgs = process.argv.slice(3);

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

const mockCommon = { getSocName: () => 'am243x', getSelfSysCfgCoreName: () => coreName };
const mockSystem = {
  deviceData: { device: 'AM243x_ALX_beta', package: 'ALX' },
  modules: {},
  getScript: (p) => (p === '/common' || p === 'common' ? mockCommon : makeStub()),
};

function load(file) {
  const sandbox = {
    system: mockSystem, exports: {}, module: { exports: {} },
    console: { log() {}, error() {}, warn() {} }, require: () => makeStub(),
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 5000 });
  return sandbox.exports;
}

for (const arg of blockArgs) {
  const [rel, opCodeArg] = arg.split(':');
  const mod = load(path.join(BLOCKS, rel + '.syscfg.js'));
  const opDefault = (mod.config || []).find(c => c.name === 'opCode');
  const opCode = opCodeArg || (opDefault && opDefault.default) || rel;
  mod.$instances = [{ $name: path.basename(rel) + '_0', opCode }];
  mockSystem.modules['/pru_blocks/' + rel] = mod;
}

const stat = load(STATIC_PATH);
let out = { setup: '', error: null };
try {
  out.setup = stat.getConstantTableSetup(coreName, mockSystem.modules);
} catch (e) {
  out.error = String(e.message || e);
}
console.log(JSON.stringify(out));
