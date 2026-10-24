/**
 * crc_dut.js - device-under-test driver for the CRC block macro
 *.  It is NOT an oracle: it only runs what the block emits.
 *
 * Modes (JSON spec on argv[2], JSON result on stdout):
 *   {"mode":"table", "opCode":"m_calculate_crc16", "crcPolynomial":33024}
 *       -> prints the block's emitted lookup table as {"lut":[...]}
 *   {"mode":"run", "opCode":"m_calculate_crc16", "crcPolynomial":33024,
 *    "init":0, "bytes":[255,255]}
 *       -> loads the emitted LUT into DMEM0, then chains the emitted macro
 *          (getMacro("", opCode)) over the bytes on the headless
 *          pru_core.js instruction simulator and prints {"result":<crc>}
 *
 * Used by tests/test_crc_lut_index_scaling.py, whose oracle is an
 * independent bit-serial CRC written in the test itself.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SIM_DIR = path.join(ROOT, '.metadata/sysconfig/.meta/pru_blocks/common/simulation');

const scriptCache = {};

function loadScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf-8');
    const sandbox = {
        console: console, Math: Math, parseInt: parseInt, isNaN: isNaN,
        eval: eval, Uint8Array: Uint8Array, Array: Array, JSON: JSON,
        system: {
            getScript: (p) => {
                const basename = path.basename(p);
                if (!scriptCache[basename]) {
                    scriptCache[basename] = loadScript(path.join(SIM_DIR, basename));
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

// Universal non-throwing proxy so module top-level system.* calls never crash.
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

function loadBlockModule(blockName, blockSubdir) {
    const file = path.join(ROOT, `.metadata/sysconfig/.meta/pru_blocks/${blockSubdir}/${blockName}.syscfg.js`);
    const src = fs.readFileSync(file, 'utf-8');
    const sandbox = {
        system: makeStub(),
        exports: {},
        module: { exports: {} },
        require: () => makeStub(),
        console: { log() {}, error() {}, warn() {} },
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: file, timeout: 5000 });
    return sandbox.exports;
}

function expandMacro(macroStr, argsMap) {
    const lines = macroStr.split('\n');
    let header = -1, params = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('.macro')) {
            header = i;
            params = lines[i].split('.macro')[1].split(',').map(p => p.trim());
            break;
        }
    }
    if (header === -1) throw new Error('no .macro definition');
    const mapping = {};
    params.forEach((p, i) => {
        if (argsMap[p] !== undefined) mapping[p] = argsMap[p];
        else if (argsMap[i] !== undefined) mapping[p] = argsMap[i];
    });
    const regs = { TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27' };
    const out = [];
    for (let i = header + 1; ; i++) {
        const t = lines[i] === undefined ? '' : lines[i].trim();
        if (t === '' || t.startsWith(';')) { if (lines[i] === undefined) break; continue; }
        if (t.startsWith('.endm')) break;
        let pl = lines[i];
        for (const [p, v] of Object.entries(mapping)) {
            pl = pl.replace(new RegExp('\\b' + p + '\\b', 'g'), v);
        }
        for (const [t2, r] of Object.entries(regs)) {
            if (mapping[t2] === undefined) {
                pl = pl.replace(new RegExp('\\b' + t2 + '\\b', 'g'), r);
            }
        }
        out.push(pl.replace(/\?/g, '_1'));
    }
    return out;
}

function lutValues(mod, spec) {
    const inst = { crcPolynomial: spec.crcPolynomial, opCode: spec.opCode, crcType: spec.opCode };
    return mod.getLookUptable(inst).split(',').map(s => parseInt(s.trim(), 10));
}

const LUT_BASE = 0x200;   // DMEM0 address used by the "run" mode
const RESULT_REG = 10;    // macro crcResult = R10
const INIT_REG = 4;       // macro crcInit  = R4
const DATA_REG = 5;       // macro dataByte = R5

function main() {
    const spec = JSON.parse(process.argv[2]);
    const mod = loadBlockModule('crc_block', 'application_specific');
    const values = lutValues(mod, spec);
    const entryBytes = spec.opCode === 'm_calculate_crc32' ? 4 : spec.opCode === 'm_calculate_crc16' ? 2 : 1;

    if (spec.mode === 'table') {
        process.stdout.write(JSON.stringify({ lut: values }));
        return;
    }
    if (spec.mode !== 'run') throw new Error('unknown mode ' + spec.mode);

    const pruCore = loadScript(path.join(SIM_DIR, 'pru_core.js'));
    const pruDMEM0 = scriptCache['pru_dmem0.js'];

    // Load the block's emitted table little-endian at entry-byte stride:
    // exactly the memory layout the generated firmware places in .initdmem.
    const bytes = new Uint8Array(values.length * entryBytes);
    values.forEach((v, i) => {
        for (let b = 0; b < entryBytes; b++) {
            bytes[i * entryBytes + b] = (v >>> (8 * b)) & 0xFF;
        }
    });
    pruDMEM0.writeDMEM0(LUT_BASE, bytes);

    const macro = mod.getMacro('', spec.opCode);
    const instructions = [];
    const labels = [];
    let crc = spec.init >>> 0;
    instructions.push(`ldi32 R${INIT_REG}, ${crc >>> 0}`);
    for (const byte of spec.bytes) {
        instructions.push(`ldi32 R${DATA_REG}, ${byte}`);
        for (const line of expandMacro(macro, {
            crcResult: `R${RESULT_REG}`, crcInit: `R${INIT_REG}`,
            dataByte: `R${DATA_REG}`, lutAddress: String(LUT_BASE),
        })) {
            instructions.push(line);
        }
        instructions.push(`mov R${INIT_REG}, R${RESULT_REG}`);
    }
    instructions.push('halt');
    instructions.forEach(() => labels.push(0));

    const res = pruCore.simulatePruInstructions(instructions, labels, 64 * instructions.length, {}, {});
    // Open-loop (no device bus) runs end with pc past the last instruction
    // rather than pruState.halted set.
    if (!(res.pruState.halted || res.pruState.pc >= instructions.length - 1)) {
        throw new Error('did not halt: ' + JSON.stringify({
            pc: res.pruState.pc, unknown: res.pruState.unknownInstruction,
            parseErrors: res.pruState.errorParsing, n: instructions.length,
            regs: res.pruState.registers.slice(0, 12),
        }));
    }
    const width = entryBytes * 8;
    const mask = width === 32 ? 0xFFFFFFFF : (1 << width) - 1;
    if (spec.debug) {
        console.error(JSON.stringify({ instructions, regs: res.pruState.registers.map(r => r >>> 0) }));
    }
    process.stdout.write(JSON.stringify({
        result: (res.pruState.registers[RESULT_REG] & mask) >>> 0,
        unknownInstruction: res.pruState.unknownInstruction,
        errorParsing: res.pruState.errorParsing,
    }));
}

main();
