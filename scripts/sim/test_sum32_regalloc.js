"use strict";

// Exercises the production register allocator and the production
// validateSum32Global — not copies — so this test cannot drift from shipped
// code. This is the regression guard for the first pass's defect:
// `accumulate` emitted `xout 47|49, &R2, 32` without ever declaring R2-R9 to
// the allocator, so the allocator treated those bytes as free general-purpose
// pool and could hand them to an unrelated block, which then got checksummed
// instead of the user's data.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const allocatorPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "register_allocation", "pru_register_allocator.js");
const staticPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_blocks_static_module.syscfg.js");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "data_handling", "sum32_block.syscfg.js");

const allocatorSource = fs.readFileSync(allocatorPath, "utf8");
const staticSource = fs.readFileSync(staticPath, "utf8");

// The exact reservation block, extracted from the real file by
// anchor rather than a hand-typed literal, so CRLF/indentation drift can
// never make this test silently exercise the unmutated allocator. Anchored
// on the unique "sumCheck" declaration (start) through the immediately
// following catch line (end) — both anchors are unique substrings of the
// reservation try/catch added for.
const startAnchor = 'const sumCheck = systemModules["/pru_blocks/data_handling/sum32_block"];';
const endAnchor = '} catch(e) { /* capsule unavailable in test stub */ }';
const startAnchorIdx = allocatorSource.indexOf(startAnchor);
assert.ok(startAnchorIdx >= 0, "reservation start anchor not found in pru_register_allocator.js — has it moved or been renamed?");
const tryIdx = allocatorSource.lastIndexOf("try {", startAnchorIdx);
assert.ok(tryIdx >= 0, "no enclosing try { found before the reservation anchor");
const endAnchorIdx = allocatorSource.indexOf(endAnchor, startAnchorIdx);
assert.ok(endAnchorIdx >= 0, "reservation end anchor (catch line) not found after the start anchor");
const RESERVATION_SNIPPET = allocatorSource.slice(tryIdx, endAnchorIdx + endAnchor.length);
assert.ok(RESERVATION_SNIPPET.includes("pruByteArray[b] = 1") && RESERVATION_SNIPPET.includes("hasAccumulate"),
    "extracted RESERVATION_SNIPPET does not look like the reservation block — extraction anchors may be wrong");
const mutatedAllocatorSource = allocatorSource.replace(RESERVATION_SNIPPET, "");
assert.notStrictEqual(mutatedAllocatorSource.length, allocatorSource.length,
    "mutation must actually remove the reservation snippet");

function runAllocator(modules, source) {
    const ctx = { system: { modules }, exports: {}, console, Set, Map, JSON };
    vm.runInNewContext(source, ctx, { filename: "pru_register_allocator.js" });
    ctx.exports.allocatePruRegisters();
    return ctx;
}

function deepStub() {
    const fn = function () { return deepStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
            if (prop === Symbol.iterator || prop === "then" || prop === "length") return undefined;
            return deepStub();
        },
        apply() { return deepStub(); }
    });
}
function loadStaticValidator(modules, allocatorExports) {
    const common = { getSocName: () => "am64x", getSelfSysCfgCoreName: () => "icss_g0_pru0" };
    const ctx = {
        system: {
            modules,
            getScript: (p) => {
                const s = String(p);
                if (s.includes("pru_register_allocator")) return allocatorExports;
                if (s === "/common" || s.endsWith("/common")) return common;
                return deepStub();
            },
            deviceData: { device: "AM243x" }
        },
        exports: {}, console: { log() {}, warn() {}, error() {} },
        Set, Map, JSON, Math, Number, Array, Object, String, RegExp, Error, parseInt, parseFloat, isNaN
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(staticSource + "\n;globalThis.__validateSum32Global = validateSum32Global;",
        ctx, { filename: "pru_blocks_static_module.syscfg.js" });
    return ctx.__validateSum32Global;
}

function makeLoadInst(name, value) {
    return {
        $name: name, numOfInputPorts: 0, numOfOutputPorts: 1, numOfConstants: 1,
        constant1: value, output1Size: 4, noOfCycles: 1, opCode: "LDI32", output1: []
    };
}
function makeSumInst(name) {
    return {
        $name: name, operation: "accumulate", bsRamSnoop: false,
        opCode: "m_sum32_accumulate_only", numOfInputPorts: 0, numOfOutputPorts: 0,
        numOfConstants: 0, outputReg: "None", output1Size: 0, noOfCycles: 12, input1: []
    };
}
// F0 and F1 fill R0/R1 (bytes 0-7); F2 is the arm — the third independent
// unconsumed producer, which the allocator's first-fit scan reaches right
// after R0/R1, i.e. exactly at the start of the R2-R9 window if it is not
// reserved.
function buildDesign() {
    const F0 = makeLoadInst("F0", 1);
    const F1 = makeLoadInst("F1", 2);
    const F2 = makeLoadInst("F2", 3);
    const SUM = makeSumInst("SUM");
    return {
        fillerNames: ["F0", "F1", "F2"],
        modules: {
            "/pru_blocks/data_handling/load_constant_block": { $instances: [F0, F1, F2] },
            "/pru_blocks/data_handling/sum32_block": { $instances: [SUM] }
        }
    };
}
function regNumOf(allocation) {
    const m = /^R(\d+)/.exec(allocation || "");
    return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 1. Real allocator: once a sum32 accumulate instance exists, R2-R9 (bytes
//    8..39) must be untouched by any other block's allocation.
// ---------------------------------------------------------------------------
const real = buildDesign();
const realCtx = runAllocator(real.modules, allocatorSource);
const realAllocations = real.fillerNames.map((n) => realCtx.exports.getBlockRegisterAllocation(n));
const realOffenders = realAllocations.filter((a) => {
    const r = regNumOf(a);
    return r !== null && r >= 2 && r <= 9;
});
assert.strictEqual(realOffenders.length, 0,
    `with the real reservation, no filler may land in R2-R9, got ${JSON.stringify(realAllocations)}`);
// Guard the arm itself: F2 must have been pushed PAST the reserved window
// (R10), not just coincidentally placed elsewhere, or this proves nothing.
assert.strictEqual(regNumOf(realAllocations[2]), 10,
    `F2 must be pushed to R10, just past the reserved R2-R9 window, got ${realAllocations[2]}`);

// ---------------------------------------------------------------------------
// 2. Mutation: same design, reservation snippet stripped from the allocator
//    source. The allocator itself must now place F2 inside R2-R9, proving the
//    reservation (not something else) was responsible for arm 1.
// ---------------------------------------------------------------------------
const mutated = buildDesign();
const mutatedCtx = runAllocator(mutated.modules, mutatedAllocatorSource);
const mutatedAllocations = mutated.fillerNames.map((n) => mutatedCtx.exports.getBlockRegisterAllocation(n));
assert.strictEqual(regNumOf(mutatedAllocations[2]), 2,
    `deleting the reservation must let F2 land at R2 exactly (the old bug), got ${JSON.stringify(mutatedAllocations)}`);

// ---------------------------------------------------------------------------
// 3. validateSum32Global (the REAL function, extracted from the real static
//    module source) is the safety net: it must flag the R2-R9 overlap the
//    mutated allocator produced, naming the offending register, and must NOT
//    flag anything when the real reservation is in effect.
// ---------------------------------------------------------------------------
function collectErrors(design, ctx) {
    const validate = loadStaticValidator(design.modules, ctx.exports);
    const errors = [];
    validate({}, { logError: (m) => errors.push(String(m)), logWarning: () => {}, logInfo: () => {} });
    return errors;
}
const realErrors = collectErrors(real, realCtx);
assert.deepStrictEqual(realErrors, [],
    `real reservation must produce no validateSum32Global errors, got ${JSON.stringify(realErrors)}`);

const mutatedErrors = collectErrors(mutated, mutatedCtx);
assert.ok(mutatedErrors.some((e) => /R2-R9/.test(e)),
    `deleted reservation must be caught by validateSum32Global naming the R2-R9 window, got ${JSON.stringify(mutatedErrors)}`);
assert.ok(mutatedErrors.some((e) => e.includes("'F2'") && e.includes("R2")),
    `validateSum32Global must name the offending instance and register (F2 -> R2), got ${JSON.stringify(mutatedErrors)}`);

console.log("SUM32 register-allocator reservation + validateSum32Global red arm passed " +
    `(real: ${JSON.stringify(realAllocations)}, mutated: ${JSON.stringify(mutatedAllocations)})`);

// ---------------------------------------------------------------------------
// 4. Unconnected input1 (DMEM source address) warning: block.validate()
//    itself, invoked directly — not a copy of its logic.
// ---------------------------------------------------------------------------
const blockSandbox = { exports: {}, console };
vm.runInNewContext(fs.readFileSync(blockPath, "utf8"), blockSandbox, { filename: "sum32_block.syscfg.js" });
const block = blockSandbox.exports;
function validateWarnings(inst) {
    const warnings = [];
    block.validate(inst, { logError: () => {}, logWarning: (m) => warnings.push(String(m)) });
    return warnings;
}
const unconnected = validateWarnings({ operation: "accumulate", bsRamSnoop: false, input1: [] });
assert.ok(unconnected.some((w) => /input1/.test(w)),
    `unconnected input1 on accumulate must warn, got ${JSON.stringify(unconnected)}`);
// Mutation (fault site removed): a connected input1 is the same instance with
// the fault fixed — the warning must disappear.
const connected = validateWarnings({ operation: "accumulate", bsRamSnoop: false, input1: [{}] });
assert.ok(!connected.some((w) => /input1/.test(w)),
    `connected input1 must not warn, got ${JSON.stringify(connected)}`);
// read_and_clear has no input1 port at all; it must never warn about one.
const readClear = validateWarnings({ operation: "read_and_clear", bsRamSnoop: false });
assert.ok(!readClear.some((w) => /input1/.test(w)),
    `read_and_clear must not warn about input1, got ${JSON.stringify(readClear)}`);

console.log("SUM32 unconnected-input1 warning red arm passed");
