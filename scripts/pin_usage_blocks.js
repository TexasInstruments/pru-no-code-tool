'use strict';
/**
 * pin_usage_blocks.js - which block modules DECLARE moduleStatic.getPinUsage.
 *
 * The pin-collision report (check_pin_collisions.js --defaults-report) and the control-flow
 * classifier (block_control_flow.js) pick their blocks with this module rather than a bare text
 * match on the token 'getPinUsage': a comment or string that merely mentions the word (the GUI
 * validator in common/pru_blocks_static_module.syscfg.js calls the function and documents it)
 * would make a non-block look like a block. A module is a pin-usage block here only when it loads and its exported
 * moduleStatic.getPinUsage is a function - the same test both tools apply to an instance.
 *
 * The token match survives only as a prefilter: a module whose text never contains the token
 * cannot declare the function by that name, so it is not loaded. FAIL CLOSED: a module that
 * mentions the token but cannot be loaded is reported as an error, never silently dropped.
 *
 * CLI: node scripts/pin_usage_blocks.js [--json] [blocksRoot]
 *   prints the declaring modules (paths relative to blocksRoot); exit 1 if any candidate failed to load.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_ROOT = path.join(__dirname, '..', '.metadata', 'sysconfig', '.meta', 'pru_blocks');
const TOKEN = 'getPinUsage';

function stub() {
    const f = function () { return stub(); };
    return new Proxy(f, {
        get(_t, p) {
            if (p === Symbol.toPrimitive || p === 'toString') return () => '';
            if (p === 'length') return 0;
            return stub();
        },
        apply() { return stub(); },
    });
}

// Load a block module in a permissive sandbox (unknown system calls return stubs) and return its exports.
function loadModule(file) {
    const sb = {
        system: new Proxy({}, {
            get(_t, p) {
                if (p === 'getScript') return () => stub();
                if (p === 'deviceData') return { deviceId: 'AM243x_ALX_beta', device: 'AM243x_ALX_beta', package: 'ALX' };
                if (p === 'context') return 'icss_g0_pru0';
                if (p === 'compiler') return 'ti-pru-cgt';
                if (p === 'modules') return {};
                return stub();
            },
        }),
        exports: {},
        module: { exports: {} },
        require: () => stub(),
        console: { log() {}, warn() {}, error() {} },
    };
    sb.global = sb;
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sb);
    return (sb.module.exports && Object.keys(sb.module.exports).length) ? sb.module.exports : sb.exports;
}

function declaresPinUsage(file) {
    const exp = loadModule(file);
    return !!(exp && exp.moduleStatic && typeof exp.moduleStatic.getPinUsage === 'function');
}

// -> { blocks: [{ rel, file }], errors: [{ rel, error }] }, sorted by rel.
function pinUsageBlocks(blocksRoot = DEFAULT_ROOT) {
    const blocks = [], errors = [];
    const walk = (d) => {
        for (const f of fs.readdirSync(d).sort()) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (!f.endsWith('.syscfg.js') || !fs.readFileSync(p, 'utf8').includes(TOKEN)) continue;
            const rel = path.relative(blocksRoot, p).split(path.sep).join('/');
            let yes;
            try { yes = declaresPinUsage(p); }
            catch (e) { errors.push({ rel, error: String(e && e.message) }); continue; }
            if (yes) blocks.push({ rel, file: p });
        }
    };
    walk(blocksRoot);
    return { blocks, errors };
}

module.exports = { pinUsageBlocks, declaresPinUsage, loadModule, DEFAULT_ROOT };

if (require.main === module) {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const root = args.find((a) => a !== '--json') || DEFAULT_ROOT;
    const { blocks, errors } = pinUsageBlocks(root);
    if (json) console.log(JSON.stringify({ blocks: blocks.map((b) => b.rel), errors }));
    else {
        for (const b of blocks) console.log(b.rel);
        for (const e of errors) console.error(`ERROR: ${e.rel} mentions ${TOKEN} but failed to load: ${e.error}`);
    }
    process.exit(errors.length ? 1 : 0);
}
