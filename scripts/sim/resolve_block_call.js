/**
 * resolve_block_call.js - resolve ONE block instance the way SysConfig would
 * and print the macro call the generator would emit for it.
 *
 * Usage:
 *   node scripts/sim/resolve_block_call.js <subdir>/<block> '<overrides json>'
 *
 * Prints JSON:
 *   { opCode, noOfCycles, output1Size, macro, constants: [c1, c2, ...],
 *     errors: [{message, field}], warnings: [...], infos: [...] }
 *
 * The instance is built from every config default, then the overrides, then
 * each computed (getValue) field in config order - the same order SysConfig
 * evaluates them. `constants` is constant1..constantN, i.e. the macro call's
 * arguments after RES (pru_register_allocator.js appends them in that order).
 * Nothing here knows any block's timing: it only evaluates the block's own JS.
 */
'use strict';
const { loadBlockModule } = require('../dual_oracle_harness.js');

function main() {
    const [blockPath, overridesJson] = process.argv.slice(2);
    if (!blockPath) {
        console.error("usage: node resolve_block_call.js <subdir>/<block> '<overrides json>'");
        process.exit(2);
    }
    const slash = blockPath.lastIndexOf('/');
    const mod = loadBlockModule(blockPath.slice(slash + 1), blockPath.slice(0, slash));
    const overrides = overridesJson ? JSON.parse(overridesJson) : {};

    const inst = {};
    for (const c of mod.config) {
        if (c.default !== undefined) inst[c.name] = c.default;
    }
    Object.assign(inst, overrides);
    for (const c of mod.config) {
        if (typeof c.getValue === 'function' && !(c.name in overrides)) {
            inst[c.name] = c.getValue(inst);
        }
    }

    const out = { errors: [], warnings: [], infos: [] };
    const report = {
        logError: (m, _i, f) => out.errors.push({ message: String(m), field: f || null }),
        logWarning: (m, _i, f) => out.warnings.push({ message: String(m), field: f || null }),
        logInfo: (m, _i, f) => out.infos.push({ message: String(m), field: f || null }),
    };
    if (typeof mod.validate === 'function') mod.validate(inst, report);

    out.opCode = inst.opCode;
    out.noOfCycles = inst.noOfCycles;
    out.output1Size = inst.output1Size;
    out.description = mod.longDescription || '';
    out.macro = mod.getMacro(inst.opCode, inst.opCode);
    out.constants = [];
    for (let k = 1; k <= (inst.numOfConstants || 0); k++) {
        out.constants.push(inst['constant' + k]);
    }
    process.stdout.write(JSON.stringify(out));
}

main();
