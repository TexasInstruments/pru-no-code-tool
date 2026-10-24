#!/usr/bin/env node
'use strict';
/*
 * crc_oracle.js — minimal crc_block design emitter.
 *
 * Prints a complete minimal assembly file whose data line is EXACTLY what the
 * tool generates for a CRC8 block instance: `<lutName> <getDataSize()>
 * <getLookUptable()>` (the `${symbolName} ${symbolDataType} ${symbolData}`
 * format of getInitSectDirectives in pru_blocks_static_module.syscfg.js),
 * with lutName/getDataSize/getLookUptable evaluated from the REAL
 * crc_block.syscfg.js for a documented CRC8 configuration
 * (opCode m_calculate_crc8, polynomial 0x07). The oracle is the assembler:
 * callers run clpru on this output; a reserved instance name fails with
 * [E0300] "<name> is a reserved identifier".
 *
 * Usage: node scripts/crc_oracle.js <instanceName>
 *        node scripts/crc_oracle.js --label <name>
 *           emits <name> as a code label (`<name>:` in .text — the shape of
 *           the conditional/group derived branch labels) instead of the
 *           default crc data-symbol emission.
 *        node scripts/crc_oracle.js --list-reserved
 *           prints the helper's RESERVED_ASM_NAMES as JSON (single source of
 *           truth for the committed test's expected list).
 * Exit code 0 on success, 2 on harness error.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CRC_FILE = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks',
    'application_specific', 'crc_block.syscfg.js');

function loadCrcModule() {
    const src = fs.readFileSync(CRC_FILE, 'utf8');
    const stub = function () { return stub; };
    const mockSystem = {
        deviceData: {},
        modules: {},
        getScript: () => stub,
    };
    const sandbox = {
        system: mockSystem,
        exports: {},
        module: { exports: {} },
        console: { log() {}, error() {}, warn() {} },
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: CRC_FILE, timeout: 5000 });
    const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
        : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
        : sandbox.exports;
    return mod;
}

function loadReservedHelper() {
    const file = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks',
        'common', 'pru_reserved_names.js');
    const src = fs.readFileSync(file, 'utf8');
    const sandbox = { exports: {}, module: { exports: {} }, console: { log() {}, error() {}, warn() {} } };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: file, timeout: 5000 });
    return (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports : sandbox.module.exports;
}

function main() {
    let name = process.argv[2];
    let labelMode = false;
    if (name === '--label') {
        labelMode = true;
        name = process.argv[3];
    }
    if (name === '--list-reserved') {
        const helper = loadReservedHelper();
        process.stdout.write(JSON.stringify(helper.RESERVED_ASM_NAMES));
        return;
    }
    if (!name) {
        console.error('Usage: node scripts/crc_oracle.js [--label] <instanceName>');
        process.exit(2);
    }
    if (labelMode) {
        const lines = [
            '; oracle: code-label emission for "' + name + '"',
            '    .sect ".text"',
            '    .global probe_entry',
            'probe_entry:',
            '    halt',
            name + ':',
            '    halt',
            '',
        ];
        process.stdout.write(lines.join('\n'));
        return;
    }
    const crc = loadCrcModule();
    if (typeof crc.getDataSize !== 'function' || typeof crc.getLookUptable !== 'function') {
        console.error('crc_block does not expose getDataSize/getLookUptable');
        process.exit(2);
    }
    // Documented CRC8 configuration (see the block's "How to Configure"):
    // opCode m_calculate_crc8 with polynomial 0x07.
    const inst = { $name: name, opCode: 'm_calculate_crc8', crcPolynomial: 0x07 };
    const directive = crc.getDataSize(inst);
    const table = crc.getLookUptable(inst);
    const lines = [
        '; oracle: minimal crc_block (CRC8) LUT emission for instance "' + name + '"',
        '    .sect ".initdmem"',
        name + ' ' + directive + ' ' + table,
        '    .sect ".text"',
        '    .global probe_entry',
        'probe_entry:',
        '    halt',
        '',
    ];
    process.stdout.write(lines.join('\n'));
}

if (require.main === module) main();

module.exports = { loadCrcModule };
