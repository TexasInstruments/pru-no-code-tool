#!/usr/bin/env node
'use strict';
/*
 * Test runner: exercises validateDeviceCapabilities from the real
 * pru_blocks_static_module.syscfg.js against a mocked SysConfig runtime.
 *
 * Usage:
 *   node scripts/static_module_validate_runner.js <device> <soc> <widget>
 * Example:
 *   node scripts/static_module_validate_runner.js AM261x_ZCZ am261x bswap
 *   node scripts/static_module_validate_runner.js AM243x_ALV_beta am243x bswap
 *
 * Degradation modes (prove the gate fails closed / errors visibly):
 *   --no-soc          common.getSocName() returns null (SoC missing)
 *   --common-throws   system.getScript("/common") throws
 *   --no-caps         system.getScript(pru_device_caps) throws (table unloadable)
 *   --widget-throws   caps.isWidgetAvailable() throws for the tested widget
 *
 * Prints JSON array of error messages on stdout.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODES = ['--no-soc', '--common-throws', '--no-caps', '--widget-throws'];
const modeArgs = process.argv.slice(2).filter(a => MODES.includes(a));
const posArgs = process.argv.slice(2).filter(a => !MODES.includes(a));
const mode = modeArgs[0] || null;

const device = posArgs[0] || 'AM261x_ZCZ';
const soc = posArgs[1] || 'am261x';
const widget = posArgs[2] || 'bswap';

const ROOT = path.join(__dirname, '..');
const CAPS_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_device_caps.js');
const STATIC_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_blocks_static_module.syscfg.js');

let caps;
try {
  caps = require(CAPS_PATH);
} catch (e) {
  console.error('Failed to load caps: ' + e.message);
  process.exit(2);
}

let errors = [];
const report = {
  logError: (msg) => errors.push(String(msg)),
  logWarning: () => {},
  logInfo: () => {},
};

const mockCommon = {
  getSocName: () => (mode === '--no-soc' ? null : soc),
  getSelfSysCfgCoreName: () => 'r5fss0-0',
};

// proxy stub for unrelated system.getScript calls (register allocator etc.)
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

// The static module calls system.getScript("/common") during load (e.g.
// getPruNumberFromContext at line ~2056). Arm the --common-throws failure only
// AFTER the module has loaded so the degradation hits the validator's own
// failure path instead of blowing up module initialization.
let vmLoaded = false;

const mockSystem = {
  deviceData: { device: device, package: 'ZCZ' },
  modules: {
    '/pru_blocks/test/fake_block': {
      displayName: 'Fake Block',
      requiresWidget: [widget],
      $instances: [{ $name: 'FAKE_0' }],
    },
  },
  getScript: (p) => {
    if (p.includes('pru_device_caps')) {
      if (mode === '--no-caps') throw new Error('pru_device_caps.js not found (simulated unloadable capability table)');
      if (mode === '--widget-throws') {
        return Object.assign({}, caps, {
          isWidgetAvailable: () => { throw new Error('capability lookup exploded (simulated)'); },
        });
      }
      return caps;
    }
    if (p === '/common' || p === 'common') {
      if (mode === '--common-throws' && vmLoaded) throw new Error('/common unavailable (simulated)');
      return mockCommon;
    }
    if (p.includes('/common')) {
      // simulation scripts under /pru_blocks/common/ are unrelated to SoC lookup
      return mockCommon;
    }
    return makeStub();
  },
  contexts: {},
  deviceData2: {},
};

const src = fs.readFileSync(STATIC_PATH, 'utf8');

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
  vm.runInContext(src, sandbox, { filename: STATIC_PATH, timeout: 5000 });
} catch (e) {
  console.error('VM load failed: ' + e.stack);
  process.exit(2);
}
vmLoaded = true;
const mod = sandbox.exports;
if (!mod.validateDeviceCapabilities) {
  console.error('validateDeviceCapabilities not found in exports');
  process.exit(2);
}
// call validator with dummy inst
mod.validateDeviceCapabilities({}, report);
console.log(JSON.stringify(errors));
