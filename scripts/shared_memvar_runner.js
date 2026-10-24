"use strict";

/**
 * Runner: Memory Access blocks that share one auto-created memVar.
 *
 * Loads the REAL memory_access_block.syscfg.js and runs its validate() over
 * designs built from a shared / separate / symbolSelect'd memVar, emitting
 * JSON on stdout:  { cases: { <case>: { warnings, errors } }, guidance }.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const blockFile = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "utils", "memory_access_block.syscfg.js");

const memVars = {
    shared: { labelName: "out_buf", sizeInBytes: 64, memoryLocation: "dmem" },
    inBuf: { labelName: "in_buf", sizeInBytes: 64, memoryLocation: "dmem" },
    outBuf: { labelName: "out_buf", sizeInBytes: 64, memoryLocation: "dmem" }
};
const accessInstances = [];
const sandbox = {
    exports: {}, module: { exports: {} }, console,
    system: { modules: {
        "/pru_blocks/utils/memory_variable_block": { $instances: Object.values(memVars) },
        "/pru_blocks/utils/memory_access_block": { $instances: accessInstances }
    } },
    JSON, Math, Number, String, Array, Object, RegExp, parseInt, parseFloat, isNaN
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(blockFile, "utf8"), sandbox, { filename: path.basename(blockFile) });
const block = sandbox.exports;

function access(name, mode, memVar, symbolSelect) {
    return { $name: name, operationMode: mode, memVar, symbolSelect: symbolSelect || "",
        offsetValue: 0, dataSize: 4, input1: mode === "write" ? [{}] : [] };
}

function run(insts) {
    accessInstances.length = 0;
    insts.forEach(i => accessInstances.push(i));
    const out = {};
    for (const inst of insts) {
        const warnings = [], errors = [];
        block.validate(inst, {
            logError: m => errors.push(String(m)),
            logWarning: m => warnings.push(String(m)),
            logInfo: () => {}
        });
        out[inst.$name] = { warnings, errors };
    }
    return out;
}

const cases = {
    // the rename hazard: rd.memVar.labelName = in_buf; wr.memVar.labelName = out_buf on ONE object
    sharedMemVar: run([access("rd", "read", memVars.shared), access("wr", "write", memVars.shared)]),
    // the guided pattern: explicit instances assigned by reference
    separateMemVars: run([access("rd", "read", memVars.inBuf), access("wr", "write", memVars.outBuf)]),
    // both blocks pick the same named symbol deliberately: no rename hazard
    symbolSelected: run([access("rd", "read", memVars.shared, "out_buf"), access("wr", "write", memVars.shared, "out_buf")]),
    // a single block alone
    single: run([access("rd", "read", memVars.shared)])
};

process.stdout.write(JSON.stringify({ cases, guidance: block.longDescription }));
