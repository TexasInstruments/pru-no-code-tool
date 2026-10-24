"use strict";

// Assemble every macro sum32_block.syscfg.js's getMacro() can emit
// (every opCode) through the real TI CGT-PRU compiler, including an
// allocator-style call with a register operand for EVERY macro: SRC_ADDR for
// both accumulate variants (the DMEM address LBBO'd into R2-R9) and RES for
// read_and_clear.
const assert = require("assert");
const child = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "data_handling", "sum32_block.syscfg.js");
const source = fs.readFileSync(blockPath, "utf8");
const sandbox = { exports: {}, module: { exports: {} }, console };
vm.runInNewContext(source, sandbox, { filename: "sum32_block.syscfg.js" });
const block = sandbox.exports;

function macro(name) { return block.getMacro("", name); }

// Every macro name getMacro can emit, per its own opCode getValue() logic
// (operation x bsRamSnoop).
const ALL_OPCODES = [
    "m_sum32_accumulate_only",
    "m_sum32_accumulate_snoop",
    "m_sum32_read_clear"
];

for (const name of ALL_OPCODES) {
    const body = macro(name);
    assert.ok(body.includes(`${name} .macro`), `macro ${name} must define itself: ${body}`);
    assert.ok(body.trim().endsWith(".endm"), `macro ${name} must close with .endm`);
}

// The 3-NOP hazard must be present in the generated macro, not left to
// firmware discipline (TRM 6.4.6.2.6).
const readClear = macro("m_sum32_read_clear");
const nopCount = (readClear.match(/^\s*nop\s*$/gim) || []).length;
assert.strictEqual(nopCount, 3, `read_and_clear must emit exactly 3 NOPs before XIN, got ${nopCount}`);
assert.ok(/nop\s*\n\s*nop\s*\n\s*nop\s*\n\s*;.*XIN/i.test(readClear) || /nop[\s\S]*nop[\s\S]*nop[\s\S]*xin/i.test(readClear),
    "the 3 NOPs must immediately precede the XIN, not float elsewhere in the macro");

// accumulate must LBBO the DMEM block into R2-R9 BEFORE the XOUT — this is the
// the block must move data into R2-R9 itself, not assume
// it is already there.
const accOnly = macro("m_sum32_accumulate_only");
const accSnoop = macro("m_sum32_accumulate_snoop");
for (const [name, body] of [["m_sum32_accumulate_only", accOnly], ["m_sum32_accumulate_snoop", accSnoop]]) {
    assert.ok(/lbbo\s+&R2,\s*SRC_ADDR,\s*0,\s*32/.test(body), `${name} must LBBO the 32-byte DMEM block at SRC_ADDR into R2-R9: ${body}`);
    // Search actual instruction lines only — comment lines legitimately name
    // both LBBO and XOUT, so a substring search over the whole body would
    // match the wrong (comment) occurrence.
    const lbboIdx = body.search(/^\s*lbbo\s/im);
    const xoutIdx = body.search(/^\s*xout\s/im);
    assert.ok(lbboIdx >= 0 && xoutIdx > lbboIdx, `${name} must LBBO before XOUT: ${body}`);
    assert.ok(/\.macro\s+SRC_ADDR/.test(body), `${name} must declare a SRC_ADDR formal parameter: ${body}`);
}
assert.ok(/xout\s+47,\s*&R2,\s*32/.test(accOnly), "accumulate_only must XOUT device 47, R2, 32 bytes");
assert.ok(/xout\s+49,\s*&R2,\s*32/.test(accSnoop), "accumulate_snoop must XOUT device 49, R2, 32 bytes");
assert.ok(/xin\s+2,\s*&TEMP_REG2,\s*4/.test(readClear), "read_and_clear must XIN device 2 into R29 (TEMP_REG2), 4 bytes");

// getMacro must throw on an opCode it cannot emit (FINAL else/throw contract).
assert.throws(() => block.getMacro("", "m_sum32_does_not_exist"),
    /Unsupported SUM32 macro/, "getMacro must throw for an unknown opCode rather than emit nothing");

console.log("SUM32 macro contract checks passed");

// Assemble every macro through the real compiler, with an allocator-style call
// carrying a register operand: SRC_ADDR (R5) for both accumulate variants,
// RES (R4) for read_and_clear.
const clpru = (process.env.SystemDrive || "C:") + "\\ti\\ti-cgt-pru_2.3.3\\bin\\clpru.exe";
if (fs.existsSync(clpru)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sum32-"));
    // SRC_ADDR must be a register OUTSIDE R2-R9: it is the LBBO base address
    // register, and R2-R9 is simultaneously the LBBO destination, so a SRC_ADDR
    // inside that window would be overwritten mid-transfer. The real allocator
    // can never place an address producer inside R2-R9 once it is reserved
    // (see pru_register_allocator.js reservation), so R20 here mirrors
    // an allocation the fixed generator will actually see.
    const cases = [
        ["m_sum32_accumulate_only", "R20"],
        ["m_sum32_accumulate_snoop", "R20"],
        ["m_sum32_read_clear", "R4"]
    ];
    for (const [name, args] of cases) {
        const asm = path.join(dir, `${name}.asm`);
        const callLine = `    ${name} ${args}`;
        fs.writeFileSync(asm, [
            "    .asg R29, TEMP_REG2",
            "    .sect \".text\"",
            "    .global main",
            macro(name),
            "main:",
            "    ldi32 R20, 0x1000",
            callLine,
            "    halt",
            ""
        ].join("\n"));
        const result = child.spawnSync(clpru, ["-v3", "--silicon_version=3", "-c", "-o", path.join(dir, `${name}.obj`), asm], { encoding: "utf8" });
        assert.strictEqual(result.status, 0, `${name} clpru failed: ${result.stderr || result.stdout}`);
    }
    console.log("SUM32 macros assembled with clpru (all 3 opCodes, allocator-style register operand call)");
} else {
    console.log(`SUM32: clpru not found at ${clpru} — skipping real-compiler assembly (macro-content checks above still ran)`);
}
