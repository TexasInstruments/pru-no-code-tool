#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const simDir = path.join(
    __dirname,
    "../.metadata/sysconfig/.meta/pru_blocks/common/simulation"
);
const cache = {};

function loadScript(file) {
    const sandbox = {
        Array,
        JSON,
        Math,
        Uint8Array,
        console,
        eval,
        isNaN,
        parseInt,
        exports: {},
        system: {
            getScript(modulePath) {
                const name = path.basename(modulePath);
                cache[name] ||= loadScript(path.join(simDir, name));
                return cache[name];
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
    return sandbox.exports;
}

const pruCore = loadScript(path.join(simDir, "pru_core.js"));

function run(lines, cycles = 20) {
    const instructions = [];
    const labels = [];
    for (const sourceLine of lines) {
        const line = sourceLine.trim();
        if (line.endsWith(":")) {
            instructions.push("0");
            labels.push(line.slice(0, -1));
        } else {
            instructions.push(line);
            labels.push(0);
        }
    }
    return pruCore.simulatePruInstructions(instructions, labels, cycles).pruState;
}

function verifyConditionalMerge() {
    const program = (left, right) => [
        `ldi R0, ${left}`,
        `ldi R1, ${right}`,
        // PRU QBGT branches when operand 2 is greater than operand 1.
        "qbgt true_branch, R1, R0",
        "add R2, R2, 1",
        "qba conditional_end",
        "true_branch:",
        "add R3, R3, 1",
        "conditional_end:",
        "halt"
    ];

    const taken = run(program(10, 5));
    const fallthrough = run(program(5, 10));
    if (taken.registers[2] !== 0 || taken.registers[3] !== 1) {
        throw new Error("taken path executed more than the true branch");
    }
    if (fallthrough.registers[2] !== 1 || fallthrough.registers[3] !== 0) {
        throw new Error("fall-through path executed more than the false branch");
    }
}

verifyConditionalMerge();
console.log("PASS conditional merge: true and false paths remain exclusive");
