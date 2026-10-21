#!/usr/bin/env node
'use strict';
/*
 * block_validate_runner.js — reusable block-validator harness
 *
 * Generalizes scripts/static_module_validate_runner.js into a reusable
 * harness that can exercise ANY block declaring validate().
 *
 * That runner covers a single validator (validateDeviceCapabilities in
 * pru_blocks_static_module.syscfg.js). This runner sweeps every block that
 * declares validate() — see --sweep.
 *
 * Usage:
 *   node scripts/block_validate_runner.js <blockPath> '<instJson>'
 *   node scripts/block_validate_runner.js --block <blockPath> --inst '<instJson>'
 *   node scripts/block_validate_runner.js --sweep
 *   node scripts/block_validate_runner.js --report
 *
 * blockPath forms:
 *   pru_io_blocks/spi_adc_sequencer_block
 *   .metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/spi_adc_sequencer_block.syscfg.js
 *   pru_blocks_static_module  (device-capability static module)
 *
 * instJson: JSON object for the block instance. Extra keys are ignored by
 *           validators that don't read them — keep error-case/control arms same-shape:
 *           only the field under test should differ.
 *
 * Output (single-block mode): JSON {errors:[], warnings:[], infos:[]}
 *   Each entry is {message, field} where field may be undefined.
 *
 * Output (--sweep): JSON array of {block, file, hasValidate, errorCount, warningCount}
 * Output (--report): same as --sweep plus {validatorsFound, armedCount} summary
 *                   armed = blocks whose error paths have a committed error-case/control test
 *                   pair (listed in ARMED_BLOCKS below)
 *
 * Exit code 0 on success, 2 on harness error.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BLOCKS_ROOT = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');

// ------------------------------------------------------------------ helpers

function makeStub() {
    const fn = function () { return makeStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
            if (prop === Symbol.iterator) return undefined;
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply() { return makeStub(); }
    });
}

function resolveBlockPath(blockPath) {
    if (!blockPath) return null;
    // Absolute or repo-relative .syscfg.js already
    if (blockPath.endsWith('.syscfg.js') && fs.existsSync(blockPath)) {
        return path.resolve(blockPath);
    }
    if (blockPath.endsWith('.syscfg.js') && fs.existsSync(path.join(ROOT, blockPath))) {
        return path.join(ROOT, blockPath);
    }
    // Try under BLOCKS_ROOT
    const candidates = [
        path.join(BLOCKS_ROOT, blockPath + '.syscfg.js'),
        path.join(BLOCKS_ROOT, blockPath),
        path.join(BLOCKS_ROOT, 'common', blockPath + '.syscfg.js'),
        path.join(ROOT, blockPath),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // Fallback: search by basename
    const base = path.basename(blockPath).replace(/\.syscfg\.js$/, '');
    const found = findAllBlockFiles().find(f => path.basename(f, '.syscfg.js') === base);
    if (found) return found;
    return null;
}

function findAllBlockFiles() {
    const out = [];
    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else if (p.endsWith('.syscfg.js')) out.push(p);
        }
    }
    walk(BLOCKS_ROOT);
    return out.sort();
}

function analyzeValidateSource(src) {
    const hasValidate = /function\s+validate\s*\(|validate\s*:\s*validate|validate\s*\(/.test(src);
    const errorCount = (src.match(/logError/g) || []).length;
    const warningCount = (src.match(/logWarning/g) || []).length;
    // Count distinct error branches — each logError is an error path
    return { hasValidate, errorCount, warningCount };
}

// evaluate a pure shared helper (no `system` dependency) in a bare
// vm and return its `exports`, mirroring what SysConfig's getScript returns.
const _sharedHelperCache = {};
function loadSharedHelper(filePath) {
    if (_sharedHelperCache[filePath]) return _sharedHelperCache[filePath];
    const src = fs.readFileSync(filePath, 'utf8');
    const sandbox = {
        exports: {},
        module: { exports: {} },
        console: { log() {}, error() {}, warn() {} },
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: filePath, timeout: 5000 });
    const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
        : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
        : sandbox.exports;
    _sharedHelperCache[filePath] = mod;
    return mod;
}

function loadBlockModule(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');

    // Mock system sufficient for pure field validators; for validators that
    // inspect system.modules we provide an empty registry so duplicate-name
    // checks see no collisions (the legal control passes).
    const mockSystem = {
        deviceData: { device: 'AM243x_ALV_beta', package: 'ALV' },
        modules: {},
        getOS: () => 'linux', // look_up_table.syscfg.js branches on this at load
        getScript: (p) => {
            if (p.includes('pru_device_caps')) {
                try { return require(path.join(BLOCKS_ROOT, 'common', 'pru_device_caps.js')); } catch (_) { return makeStub(); }
            }
            // reserved-name helper is pure (no `system` use) — load
            // it for real so block validate() calls exercise the real list.
            if (String(p).includes('pru_reserved_names')) {
                try { return loadSharedHelper(path.join(BLOCKS_ROOT, 'common', 'pru_reserved_names.js')); } catch (_) { return makeStub(); }
            }
            if (p === '/common' || p === 'common' || (typeof p === 'string' && p.includes('/common'))) {
                return { getSocName: () => 'am243x', getSelfSysCfgCoreName: () => 'r5fss0-0' };
            }
            return makeStub();
        },
        contexts: {},
        deviceData2: {},
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
    vm.runInContext(src, sandbox, { filename: filePath, timeout: 5000 });
    const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
        : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
        : sandbox.exports;
    return { mod, src, mockSystem };
}

function runValidate(blockPath, inst) {
    const file = resolveBlockPath(blockPath);
    if (!file) {
        console.error(`Block not found: ${blockPath}`);
        process.exit(2);
    }
    const { mod } = loadBlockModule(file);
    // Support both exports.validate and exports being the module directly
    const validate = mod.validate || (mod.exports && mod.exports.validate) || null;
    if (!validate) {
        // Check if it's the static module with validateDeviceCapabilities
        if (mod.validateDeviceCapabilities) {
            console.error(`Block ${blockPath} exposes validateDeviceCapabilities, not validate — use static_module_validate_runner.js or pass --device-cap`);
            process.exit(2);
        }
        console.error(`validate not found in ${file}`);
        process.exit(2);
    }
    const errors = [];
    const warnings = [];
    const infos = [];
    const report = {
        logError: (msg, _inst, field) => errors.push({ message: String(msg), field: field || null }),
        logWarning: (msg, _inst, field) => warnings.push({ message: String(msg), field: field || null }),
        logInfo: (msg, _inst, field) => infos.push({ message: String(msg), field: field || null }),
    };
    // Inject system if validator expects it via closure — already mocked in sandbox,
    // but some validators call system.modules directly via global system.
    // The vm's global system is already set; for Node-side calls we also expose it.
    const prevSystem = global.system;
    // eslint-disable-next-line no-undef
    try { global.system = loadBlockModule(file).mockSystem; } catch (_) {}
    try {
        validate(inst, report);
    } catch (e) {
        // A validator that throws is reported as an error, not as a clean result
        errors.push({ message: `validator threw: ${e.message}`, field: null });
    } finally {
        if (prevSystem !== undefined) global.system = prevSystem;
        else delete global.system;
    }
    return { file, errors, warnings, infos };
}

// ------------------------------------------------------------------ CLI

function printSweep(asReport) {
    const files = findAllBlockFiles();
    const rows = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        const a = analyzeValidateSource(src);
        if (!a.hasValidate) continue;
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        const block = path.basename(file, '.syscfg.js');
        rows.push({
            block,
            file: rel,
            hasValidate: a.hasValidate,
            errorCount: a.errorCount,
            warningCount: a.warningCount,
        });
    }
    if (!asReport) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }
    // For --report we also emit armed summary based on committed test arms
    // Blocks whose validator error paths have a committed error-case/control test pair,
    // mapped to the number of error paths those tests cover. Kept here so the
    // runner can report without importing Python; add a block when its
    // validator test pair is added.
    // Mirrors ARMED_BLOCKS / ARMED_ERROR_PATHS in tests/test_block_validators.py.
    const ARMED_ERROR_PATHS_BY_BLOCK = {
        'spi_adc_sequencer_block': 1, // sample_period
    };
    const ARMED_BLOCKS = Object.keys(ARMED_ERROR_PATHS_BY_BLOCK);
    const validatorsFound = rows.length;
    const armedCount = rows.filter(r => ARMED_BLOCKS.includes(r.block)).length;
    const errorPathsFound = rows.reduce((s, r) => s + r.errorCount, 0);
    const ARMED_ERROR_PATHS = ARMED_BLOCKS.reduce((s, b) => s + ARMED_ERROR_PATHS_BY_BLOCK[b], 0);
    console.log(JSON.stringify({
        validators: rows,
        summary: {
            validatorsFound,
            validatorsArmed: armedCount,
            validatorsUnarmed: validatorsFound - armedCount,
            errorPathsFound,
            errorPathsArmed: ARMED_ERROR_PATHS,
            armedBlocks: ARMED_BLOCKS,
        }
    }, null, 2));
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--sweep')) {
        printSweep(false);
        return;
    }
    if (args.includes('--report')) {
        printSweep(true);
        return;
    }
    // Parse --block / --inst or positional
    let blockPath = null;
    let instJson = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--block' && i + 1 < args.length) blockPath = args[++i];
        else if (args[i] === '--inst' && i + 1 < args.length) instJson = args[++i];
        else if (!blockPath) blockPath = args[i];
        else if (!instJson) instJson = args[i];
    }
    if (!blockPath) {
        console.error('Usage: node scripts/block_validate_runner.js <blockPath> \'<instJson>\'  OR  --sweep  OR  --report');
        console.error('Example: node scripts/block_validate_runner.js utils/delay_block \'{"delayCount":100}\'');
        process.exit(2);
    }
    let inst = {};
    if (instJson) {
        try { inst = JSON.parse(instJson); } catch (e) {
            console.error(`Invalid inst JSON: ${e.message}`);
            process.exit(2);
        }
    } else if (args.includes('--inst-file')) {
        const idx = args.indexOf('--inst-file');
        const fp = args[idx + 1];
        inst = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    const result = runValidate(blockPath, inst);
    // Emit structured errors and exit 0 so the caller can inspect errors vs a clean result
    console.log(JSON.stringify({ file: path.relative(ROOT, result.file).replace(/\\/g, '/'), errors: result.errors, warnings: result.warnings, infos: result.infos }));
}

if (require.main === module) main();

module.exports = { findAllBlockFiles, analyzeValidateSource, loadBlockModule, runValidate, resolveBlockPath };
