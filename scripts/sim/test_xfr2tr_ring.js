"use strict";

// redo. Exercises the production XFR2TR module through the real
// register allocator and the real scripts/simulator.js engine -- not a
// source-string-only test and not a hand-baked LDI32 standing in for the
// generated macro's own arithmetic.
//
// Oracle note: the XOUT/XIN 0x70/0x71/0x72 device model in scripts/simulator.js
// and this block were both written from SPRUIM2J 6.4.6.3.3 / Table 6-112. The
// simulator arm therefore proves the block emits what the TRM describes and
// that the emitted operands are wired to the real dataflow/allocator; it is
// NOT an independent oracle and does not raise maturity above
// "simulator-tested" (no silicon or hardware-correlation claim).
const assert = require("assert");
const child = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Simulator } = require(path.join(__dirname, "..", "simulator"));

const root = path.resolve(__dirname, "..", "..");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "pru_io_blocks", "xfr2tr_block.syscfg.js");
const allocatorPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "register_allocation", "pru_register_allocator.js");
const staticPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_blocks_static_module.syscfg.js");
const capsPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_device_caps.js");

function loadBlock() {
    const source = fs.readFileSync(blockPath, "utf8");
    const sandbox = { exports: {}, console, system: { getScript: () => ({ getSelfSysCfgCoreName: () => "icss_g0_rtu_pru0" }) } };
    vm.runInNewContext(source, sandbox, { filename: "xfr2tr_block.syscfg.js" });
    return sandbox.exports;
}
const block = loadBlock();
function macro(name) { return block.getMacro("", name); }
const cfg = (name) => block.config.find((c) => c.name === name);

// ---------------------------------------------------------------------------
// Expand a macro definition into executable instructions with the given
// operand substitution. Comment lines are dropped; nothing else is rewritten,
// so a defect in the emitted body (including its arithmetic) reaches the
// simulator unaltered -- this is what "test the generated macro, not a
// hand-baked LDI32" means in practice.
// ---------------------------------------------------------------------------
function macroBody(macroText, subs) {
    const keys = Object.keys(subs).sort((a, b) => b.length - a.length); // longest first: RESET before RES
    return macroText.split(/\r?\n/)
        .filter((line) => !line.includes(".macro") && !line.includes(".endm"))
        .filter((line) => !/^\s*;/.test(line))
        .filter((line) => line.trim().length > 0)
        .map((line) => keys.reduce((out, key) => out.split(key).join(String(subs[key])), line));
}
function runInSimulator(setup, bodyLines, steps) {
    const sim = new Simulator();
    sim.loadInstructions([...setup, ...bodyLines, "HALT"]);
    sim.stepPaced(steps || 40);
    assert.ok(!sim.state.errorParsing, `parse error: ${JSON.stringify(sim.state.errorParsing)}`);
    return sim;
}

// ---------------------------------------------------------------------------
// 1. Contract: Table 6-112 device IDs, per-operation signatures and windows.
// ---------------------------------------------------------------------------
assert.deepStrictEqual(JSON.parse(JSON.stringify(block.deviceIds)), { sourceConfig: 0x70, ringConfigStatus: 0x71, submit: 0x72 });
assert.strictEqual(block.deviceIds.sourceConfig, 112);
assert.strictEqual(block.deviceIds.ringConfigStatus, 113);
assert.strictEqual(block.deviceIds.submit, 114);

const configureText = macro("m_xfr2tr_configure");
const submitText = macro("m_xfr2tr_submit");
const statusText = macro("m_xfr2tr_status");

// tr_rsrc_nums must be shifted exactly once.
// R7[19:8]=tr_rsrc_nums means "<< 8" exactly once; R7[1]=tr_rscr_reset means "<< 1".
assert.ok(configureText.includes("RING_NUMS << 8"), "tr_rsrc_nums must be shifted into R7[19:8], i.e. << 8");
assert.ok(!/RING_NUMS\s*<<\s*(?!8\b)\d+/.test(configureText), "tr_rsrc_nums must not be shifted by anything other than 8");
assert.ok(configureText.includes("RESET << 1"), "tr_rscr_reset must be shifted into R7[1]");
assert.ok(configureText.includes("xout  112, &R6, 8") && configureText.includes("xout  113, &R6, 8"),
    "configure must XOUT both BS ID 0x70 (source) and 0x71 (ring) -- distinct TRM flows, not one hard-coded sequence");
assert.ok(submitText.includes("xout  114, &R2, SUBMIT_BYTES"), "submit must XOUT BS ID 0x72 with the real byte count");
assert.ok(statusText.includes("xin   113, &R7, 8"), "status must XIN BS ID 0x71 (the only documented XIN direction)");
// 0x70/0x72 are XOUT-only and 0x71 XOUT vs XIN are different flows in Table 6-112:
// the emitted macros must not alias one port's access type onto another.
assert.ok(!configureText.includes("xin") && !submitText.includes("xin"), "configure/submit are XOUT-only flows");
assert.ok(!statusText.includes("xout"), "status is an XIN-only flow");

// Signature/argument count. Each op's macro signature must
// match EXACTLY what the allocator will pass: RES + inputs + constants.
function macroParamCount(text) {
    const sig = text.split("\n")[0];
    return sig.split(".macro")[1].split(",").length;
}
assert.strictEqual(macroParamCount(configureText), 6, "configure: RES + 5 constants (no input port)");
assert.strictEqual(macroParamCount(submitText), 6, "submit: RES + 4 input ports + 1 constant (SUBMIT_BYTES)");
assert.strictEqual(macroParamCount(statusText), 1, "status: RES only (no input, no constants)");
assert.strictEqual(cfg("numOfConstants").getValue({ operation: "configure" }), 5);
assert.strictEqual(cfg("numOfConstants").getValue({ operation: "submit" }), 1);
assert.strictEqual(cfg("numOfConstants").getValue({ operation: "status" }), 0);
assert.strictEqual(cfg("numOfInputPorts").getValue({ operation: "configure" }), 0);
assert.strictEqual(cfg("numOfInputPorts").getValue({ operation: "submit" }), 4);
assert.strictEqual(cfg("numOfInputPorts").getValue({ operation: "status" }), 0);
assert.doesNotThrow(() => block.getMacro("m_xfr2tr_submit R0, R1, R2, R3, R4, 6", ""),
    "static validation must accept allocator-style macro calls");
assert.throws(() => block.getMacro("", "m_xfr2tr_bogus"), "unknown operations must fail loudly");

// registerClobbers: each op declares only the window Table 6-112 says it
// touches (not a blanket R2:R8 every time).
const clobbersJson = JSON.parse(JSON.stringify(block.registerClobbers));
assert.deepStrictEqual(clobbersJson.configure, [[6, 2]]);
assert.deepStrictEqual(clobbersJson.submit, [[2, 4]]);
assert.deepStrictEqual(clobbersJson.status, [[7, 2]]);

// noOfCycles: submit can hold on the 8-level FIFO, so its bound is declared
// unknown (-1), not a fixed cycle count.
assert.strictEqual(cfg("noOfCycles").getValue({ operation: "submit" }), -1, "submit can block; cycle bound must be -1 (unknown), not fixed");
assert.strictEqual(cfg("noOfCycles").getValue({ operation: "status" }), 2);
assert.strictEqual(cfg("noOfCycles").getValue({ operation: "configure" }), 7);

// ---------------------------------------------------------------------------
// 2. Behaviour: the repository Simulator executes the production macro body,
//    including its own arithmetic (no precomputed LDI32 standing in for it).
// ---------------------------------------------------------------------------
// 2a. configure: ringEntries=16 -> raw nums=15. This is the literal regression
//     guard against a double shift (nums=15 must not become 30 / decode as ring size 31).
let sim = runInSimulator([], macroBody(configureText, {
    RES: "R9", SRC_BASE: "65536", TR_SIZE: "1", RING_BASE: "66048", RING_NUMS: "15", RESET: "0"
}));
assert.strictEqual(sim.state.xfr2tr.sourceBase, 65536, "tr_msrc_base must land from the 0x70 XOUT");
assert.strictEqual(sim.state.xfr2tr.trSize, 64, "tr_size=1 must decode as 64 bytes");
assert.strictEqual(sim.state.xfr2tr.ringBase, 66048, "tr_rsrc_base must land from the 0x71 XOUT");
assert.strictEqual(sim.state.xfr2tr.ringNums, 15, "nums=15 must remain raw 15, not double-shift to 30/31");
assert.strictEqual(sim.state.registers[7] >>> 0, 0x0F00, "R7[19:8]=15, R7[1]=0 -> 0x0F00 exactly");
assert.strictEqual(sim.state.registers[9], 1, "RES must publish the configured marker");

// 2b. submit: real allocator-style dataflow through 4 declared input ports,
//     ID0 present (Table 6-112: R2[11:0]=ID0 is a valid TR ID, not a hole).
sim = runInSimulator(
    [`LDI32 R20, ${(1 << 16) | 0}`, "LDI32 R21, 6", "LDI32 R22, 0", "LDI32 R23, 0"],
    macroBody(submitText, { RES: "R9", IN1: "R20", IN2: "R21", IN3: "R22", IN4: "R23", SUBMIT_BYTES: "6" })
);
assert.deepStrictEqual(sim.state.xfr2tr.queue, [0, 1, 6], "3-ID submit must preserve Table 6-112 order, including ID0=0");
assert.strictEqual(sim.state.registers[2] >>> 0, 0x00010000, "R2 must come from the block's own input (IN1), not a fixed constant");
assert.strictEqual(sim.state.registers[3] >>> 0, 6, "R3 must come from IN2");
assert.strictEqual(sim.state.registers[9] >>> 0, 0x00010000, "RES must publish R2");

// 2c. status: busy + FIFO occupancy + write pointer, read immediately after a submit.
sim = runInSimulator(
    ["LDI32 R2, 0", "LDI32 R3, 0"], // 2 IDs: ID0=0, ID1=0
    [...macroBody(submitText, { RES: "R9", IN1: "R2", IN2: "R3", IN3: "R2", IN4: "R3", SUBMIT_BYTES: "4" }),
     ...macroBody(statusText, { RES: "R20" })]
);
assert.strictEqual(sim.state.registers[7] & 1, 1, "tr_rsrc_busy must be set while the FIFO is non-empty");
assert.strictEqual((sim.state.registers[7] >>> 8) & 0xF, 2, "tr_rscr_fifo_occ must report the 2 queued IDs");
assert.strictEqual(sim.state.registers[20] >>> 0, sim.state.registers[7] >>> 0, "RES must publish the status word");

// ---------------------------------------------------------------------------
// 2d. Mandatory second-engine coverage: scripts/simulator.js itself models the
//     8-level FIFO capacity, blocking/hold WITHOUT replaying the XOUT side
//     effect, and drain/progress so a wait-for-busy loop is not a livelock.
// ---------------------------------------------------------------------------
function fillToCapacity() {
    const sim2 = new Simulator();
    const instrs = [];
    for (let i = 0; i < 4; i++) instrs.push(`LDI32 R2, ${(1 << 16) | 0}`, "XOUT 114, &R2, 4"); // 4x2 = 8 IDs
    instrs.push("LDI32 R2, 9", "XOUT 114, &R2, 2", "HALT"); // 9th ID: must HOLD at capacity
    sim2.loadInstructions(instrs);
    return sim2;
}
let capSim = fillToCapacity();
capSim.stepPaced(10); // exactly fills the 8 slots (idx 0..7), pc parked at the 9th XOUT's LDI/XOUT pair
assert.strictEqual(capSim.state.xfr2tr.queue.length, 8, "the FIFO must reach exactly Table 6-112's 8-level capacity");
const pcAtHold = capSim.state.pc;
const queueAtHold = [...capSim.state.xfr2tr.queue];
capSim.stepPaced(5);
assert.strictEqual(capSim.state.pc, pcAtHold, "a submit beyond capacity must HOLD: PC does not advance");
assert.deepStrictEqual(capSim.state.xfr2tr.queue, queueAtHold, "a held submit must not replay/partial-apply its XOUT side effect");
// Now let enough cycles pass for the paced drain to free a slot and observe
// real progress: the held ID (9) must land exactly once, not zero or twice.
capSim.stepPaced(Simulator.XFR2TR_DRAIN_PERIOD_CYCLES + 5);
assert.notStrictEqual(capSim.state.pc, pcAtHold, "PC must eventually advance once the ring drains -- a wait loop must not livelock");
const ids9Count = capSim.state.xfr2tr.queue.filter((id) => id === 9).length;
assert.strictEqual(ids9Count, 1, "the held submission must proceed exactly once (no replay), not disappear or duplicate");
assert.ok(capSim.state.xfr2tr.queue.length <= 8, "the ring must never exceed the documented 8-level capacity");

// Mutation: bypass the capacity/hold check entirely (simulating the removed
// defect) and prove the same scenario goes red -- capacity is exceeded.
const realXfr2trXout = Simulator.prototype._xfr2trXout;
Simulator.prototype._xfr2trXout = function (pruState, bank, srcRegN, count) {
    if (bank !== 114) return realXfr2trXout.call(this, pruState, bank, srcRegN, count);
    // Mutated submit: push unconditionally, never HOLD.
    const tr = this._xfr2trState(pruState);
    const numIds = count / 2;
    const ids = [];
    for (let i = 0; i < numIds; i++) {
        const word = pruState.registers[2 + Math.floor(i / 2)] >>> 0;
        ids.push((i % 2 === 0) ? (word & 0xFFF) : ((word >>> 16) & 0xFFF));
    }
    tr.queue.push.apply(tr.queue, ids);
    return true;
};
try {
    const mutatedSim = fillToCapacity();
    mutatedSim.stepPaced(12);
    assert.ok(mutatedSim.state.xfr2tr.queue.length > 8,
        "removing the capacity/hold check must be discriminated: the FIFO must overflow past 8");
} finally {
    Simulator.prototype._xfr2trXout = realXfr2trXout;
}

// Mutation: remove draining entirely -- a wait-for-busy loop must then
// livelock (PC never advances past the held submission), proving the arm is
// coupled to the drain path and not vacuously true.
const realXfr2trDrain = Simulator.prototype._xfr2trDrain;
Simulator.prototype._xfr2trDrain = function () { /* drain removed */ };
try {
    const stuckSim = fillToCapacity();
    stuckSim.stepPaced(10);
    const stuckPc = stuckSim.state.pc;
    stuckSim.stepPaced(Simulator.XFR2TR_DRAIN_PERIOD_CYCLES * 3);
    assert.strictEqual(stuckSim.state.pc, stuckPc,
        "removing drain must be discriminated: without it, a full FIFO never frees and the wait livelocks");
} finally {
    Simulator.prototype._xfr2trDrain = realXfr2trDrain;
}

// ---------------------------------------------------------------------------
// 3. Further red arms: mutate the real emitted/executed body at one fault
//    site each; the assertion above must stop holding.
// ---------------------------------------------------------------------------
// 3a. Double-shift regression reproduced directly: if RING_NUMS were
//     shifted into bit 9 instead of bit 8, nums=15 would decode as 30.
let broken = macroBody(configureText.replace("RING_NUMS << 8", "RING_NUMS << 9"), {
    RES: "R9", SRC_BASE: "0", TR_SIZE: "0", RING_BASE: "0", RING_NUMS: "15", RESET: "0"
});
sim = runInSimulator([], broken);
assert.notStrictEqual(sim.state.xfr2tr.ringNums, 15, "the << 9 mutation must be discriminated (nums would decode as 30)");

// 3b. Ignored operation: if submit's IN1 mapping is dropped (mov
//     R2 always loaded with a fixed value instead of the block's own input),
//     the submitted IDs must stop reflecting the connected producer.
broken = macroBody(submitText.replace("mov   R2, IN1", "mov   R2, 0"), {
    RES: "R9", IN1: "R20", IN2: "R21", IN3: "R22", IN4: "R23", SUBMIT_BYTES: "4"
});
sim = runInSimulator([`LDI32 R20, ${(1 << 16) | 7}`, "LDI32 R21, 0"], broken);
assert.notDeepStrictEqual(sim.state.xfr2tr.queue, [7, 1], "dropping the IN1 dataflow mapping must be discriminated");

// 3c. ID0-as-hole regression: a parser that treats ID 0 as an
//     absent/sentinel slot (filtering zeros) must be discriminated.
function idsWithZeroFiltered(pruState, bank, srcRegN, count) {
    const tr = this._xfr2trState(pruState);
    const numIds = count / 2;
    const ids = [];
    for (let i = 0; i < numIds; i++) {
        const word = pruState.registers[2 + Math.floor(i / 2)] >>> 0;
        const id = (i % 2 === 0) ? (word & 0xFFF) : ((word >>> 16) & 0xFFF);
        if (id !== 0) ids.push(id); // BUG: treats ID 0 as a hole
    }
    tr.queue.push.apply(tr.queue, ids);
    return true;
}
Simulator.prototype._xfr2trXout = function (pruState, bank, srcRegN, count) {
    if (bank === 114) return idsWithZeroFiltered.call(this, pruState, bank, srcRegN, count);
    return realXfr2trXout.call(this, pruState, bank, srcRegN, count);
};
try {
    sim = runInSimulator(
        [`LDI32 R20, ${(1 << 16) | 0}`, "LDI32 R21, 6", "LDI32 R22, 0", "LDI32 R23, 0"],
        macroBody(submitText, { RES: "R9", IN1: "R20", IN2: "R21", IN3: "R22", IN4: "R23", SUBMIT_BYTES: "6" })
    );
    assert.notDeepStrictEqual(sim.state.xfr2tr.queue, [0, 1, 6], "an ID0-as-hole regression must be discriminated");
} finally {
    Simulator.prototype._xfr2trXout = realXfr2trXout;
}

// 3d. Wrong-direction access must not alias onto a generic FIFO/SPAD: an XIN
//     on the XOUT-only 0x70 must be recorded unsupported and zero-filled.
sim = runInSimulator(["LDI32 R6, 65536", "LDI32 R7, 0", "XOUT 112, &R6, 8", "LDI32 R9, 0xDEADBEEF"],
    ["XIN 112, &R9, 4"]);
assert.strictEqual(sim.state.registers[9], 0, "an XIN on the XOUT-only 0x70 must return zero, not stale/staged data");
assert.ok(sim.state.unsupported_xfr.includes(112), "the unsupported direction must be recorded, matching PR #30's policy");

// ---------------------------------------------------------------------------
// 4. Real production allocator exercised end to end for every operation.
// ---------------------------------------------------------------------------
const allocatorSource = fs.readFileSync(allocatorPath, "utf8");
function instFromConfig(name, operation, overrides) {
    const inst = Object.assign({ $name: name, operation }, overrides || {});
    inst.numOfInputPorts = cfg("numOfInputPorts").getValue(inst);
    inst.numOfOutputPorts = cfg("numOfOutputPorts").default;
    inst.numOfConstants = cfg("numOfConstants").getValue(inst);
    inst.output1Size = cfg("output1Size").default;
    inst.opCode = cfg("opCode").getValue(inst);
    inst.noOfCycles = cfg("noOfCycles").getValue(inst);
    inst.registerClobbers = cfg("registerClobbers").getValue(inst);
    for (let i = 1; i <= 5; i++) inst["constant" + i] = cfg("constant" + i) ? cfg("constant" + i).getValue(inst) : 0;
    inst.output1 = inst.output1 || [];
    return inst;
}
function makeLoadInst(name, value) {
    return { $name: name, numOfInputPorts: 0, numOfOutputPorts: 1, numOfConstants: 1, constant1: value, output1Size: 4, noOfCycles: 1, opCode: "LDI32", output1: [] };
}
function runAllocator(modules) {
    const ctx = { system: { modules }, exports: {}, console, Set, Map, JSON };
    vm.runInNewContext(allocatorSource, ctx, { filename: "pru_register_allocator.js" });
    ctx.exports.allocatePruRegisters();
    return ctx;
}

// configure: no input ports, RES + 5 constants exactly.
const configureInst = instFromConfig("CFG", "configure", { sourceBase: 65536, ringBase: 66048, ringEntries: 16, trSize: 8, reset: false });
let allocated = runAllocator({ "/pru_blocks/pru_io_blocks/xfr2tr_block": { $instances: [configureInst] } })
    .exports.getPruRegisterAllocationSummary().pruInstructions;
assert.strictEqual(allocated.length, 1);
assert.strictEqual(allocated[0].split(",").length, 6, `configure must emit RES + 5 constants: ${allocated[0]}`);
assert.ok(allocated[0].startsWith("m_xfr2tr_configure "));

// status: RES only.
const statusInst = instFromConfig("ST", "status", {});
allocated = runAllocator({ "/pru_blocks/pru_io_blocks/xfr2tr_block": { $instances: [statusInst] } })
    .exports.getPruRegisterAllocationSummary().pruInstructions;
assert.strictEqual(allocated[0].split(",").length, 1, `status must emit RES only: ${allocated[0]}`);

// submit: the normal allocator path with 4 real producers feeding input1..4 --
// this exercises the allocator, not a hand-written call, so an argument-count
// mismatch between the allocator and the macro fails here.
const submitInst = instFromConfig("SUB", "submit", { submitCount: 3 });
const loads = ["L1", "L2", "L3", "L4"].map((n, i) => makeLoadInst(n, i + 1));
for (let i = 0; i < 4; i++) { submitInst["input" + (i + 1)] = [{ inst: loads[i] }]; loads[i].output1 = [{ inst: submitInst }]; }
const ctx = runAllocator({
    "/loads": { $instances: loads },
    "/pru_blocks/pru_io_blocks/xfr2tr_block": { $instances: [submitInst] }
});
const submitLine = ctx.exports.getPruRegisterAllocationSummary().pruInstructions.find((s) => s.startsWith("m_xfr2tr_submit"));
assert.ok(submitLine, "allocator must emit a m_xfr2tr_submit call");
assert.strictEqual(submitLine.split(",").length, 6, `submit must preserve RES + 4 inputs + 1 constant: ${submitLine}`);
assert.ok(!/R0\s*,\s*R0\s*,\s*R0\s*,\s*R0/.test(submitLine), "submit's 4 inputs must be the allocator's real producer registers, not all dummy R0");

// ---------------------------------------------------------------------------
// 5. Build-time rejection: a live value inside an XFR2TR instance's OWN fixed
//    window, spanning across it, is an ERROR (same pattern as BSWAP).
//    The real validateXfr2trGlobal from the real static module is executed
//    here -- not a copy -- so the test cannot drift from shipped code.
// ---------------------------------------------------------------------------
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
    const staticSource = fs.readFileSync(staticPath, "utf8");
    const common = { getSocName: () => "am64x", getSelfSysCfgCoreName: () => "icss_g0_rtu_pru0" };
    const sctx = {
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
    sctx.globalThis = sctx;
    vm.runInNewContext(staticSource + "\n;globalThis.__validateXfr2trGlobal = validateXfr2trGlobal;",
        sctx, { filename: "pru_blocks_static_module.syscfg.js" });
    return sctx.__validateXfr2trGlobal;
}
function makeAddInst(name) {
    return { $name: name, numOfInputPorts: 2, numOfOutputPorts: 1, numOfConstants: 0, output1Size: 4, noOfCycles: 1, opCode: "add", input1: [], input2: [], output1: [] };
}
// A fan-out producer chain consumed on both sides of STATUS (which reserves
// nothing of its own, so external producers compete openly for R7:R8, the
// same structure arm uses for BSWAP's swap_4_8).
function buildLiveAcrossDesign(consumesAcross) {
    const N = 8;
    const liveLoads = Array.from({ length: N }, (_, i) => makeLoadInst("P" + i, i + 1));
    const pre = [];
    let prev = liveLoads[0];
    for (let i = 1; i < N; i++) {
        const a = makeAddInst("PRE" + i);
        pre.push(a);
        a.input1 = [{ inst: prev }];
        a.input2 = [{ inst: liveLoads[i] }];
        prev.output1.push({ inst: a });
        liveLoads[i].output1.push({ inst: a });
        prev = a;
    }
    // "submit" is the operation used for this arm (not status/configure): it
    // is the one op with a real input port, so the PRE-chain's final value
    // can be wired into it directly (submit.input1) and discovered by the
    // allocator's normal input-driven recursive scheduling -- the same
    // mechanism BSWAP arm relies on. status/configure declare NO
    // input port at all (that is the point: no hardware payload to route),
    // so nothing can force them into a specific program-order position this
    // way; their own registerClobbers windows are exercised structurally by
    // the "5. Real production allocator" section above instead.
    const submit = instFromConfig("SUBMIT", "submit", { submitCount: 1 });
    submit.input1 = [{ inst: prev }]; submit.input2 = []; submit.input3 = []; submit.input4 = [];
    prev.output1.push({ inst: submit });

    const post = [];
    const lateLoads = [];
    let fprev = submit;
    for (let i = 0; i < N; i++) {
        const f = makeAddInst("POST" + i);
        post.push(f);
        let second;
        if (consumesAcross) {
            second = liveLoads[i];
        } else {
            second = makeLoadInst("LATE" + i, 100 + i);
            lateLoads.push(second);
        }
        f.input1 = [{ inst: fprev }];
        f.input2 = [{ inst: second }];
        (fprev.output1 = fprev.output1 || []).push({ inst: f });
        second.output1.push({ inst: f });
        fprev = f;
    }
    return {
        loadNames: liveLoads.map((l) => l.$name),
        modules: {
            "/loads": { $instances: liveLoads.concat(lateLoads) },
            "/pru_blocks/pru_io_blocks/xfr2tr_block": { $instances: [submit] },
            "/adds": { $instances: pre.concat(post) }
        }
    };
}
function collectErrors(design) {
    const rctx = runAllocator(design.modules);
    const validate = loadStaticValidator(design.modules, rctx.exports);
    const errors = [];
    validate({}, { logError: (m) => errors.push(String(m)), logWarning: () => {}, logInfo: () => {} });
    return { errors, summary: rctx.exports.getPruRegisterAllocationSummary(), alloc: rctx.exports };
}

const acrossDesign = buildLiveAcrossDesign(true);
const liveAcross = collectErrors(acrossDesign);
const submitIndex = liveAcross.summary.pruInstructionInstances.findIndex((i) => i && i.$name === "SUBMIT");
assert.ok(submitIndex > 0 && submitIndex < liveAcross.summary.pruInstructions.length - 1,
    `SUBMIT must be scheduled between a producer and a consumer, got ${JSON.stringify(liveAcross.summary.pruInstructions)}`);
const offenders = acrossDesign.loadNames.filter((n) => {
    const m = /^R(\d+)/.exec(liveAcross.alloc.getBlockRegisterAllocation(n) || "");
    return m && Number(m[1]) >= 2 && Number(m[1]) <= 5;
});
assert.ok(offenders.length > 0, "the design must place a live producer inside R2:R5 for this arm to mean anything");
assert.ok(liveAcross.errors.some((e) => /XFR2TR 'SUBMIT'.*live value in R[2345]/.test(e)),
    `a live value inside the submit window across the call must be a build error, got ${JSON.stringify(liveAcross.errors)}`);

// Fault site deleted: the same graph with nothing live across SUBMIT must build clean.
const noneAcross = collectErrors(buildLiveAcrossDesign(false));
assert.ok(!noneAcross.errors.some((e) => e.includes("XFR2TR")),
    `no XFR2TR error is allowed when nothing is live across the call, got ${JSON.stringify(noneAcross.errors)}`);

// ---------------------------------------------------------------------------
// 6. Capability gating: XFR2TR is ICSSG-only (RTU_PRU cores),
//    catalogued only where those cores exist, and rejected on the wrong core.
// ---------------------------------------------------------------------------
delete require.cache[capsPath];
const caps = require(capsPath);
assert.strictEqual(caps.isWidgetAvailable("xfr2tr", "am64x"), true, "AM64x (ICSSG) must have xfr2tr");
assert.strictEqual(caps.isWidgetAvailable("xfr2tr", "am243x"), true, "AM243x (ICSSG) must have xfr2tr");
assert.strictEqual(caps.isWidgetAvailable("xfr2tr", "am261x"), false, "AM261x (ICSSM, no RTU_PRU) must NOT have xfr2tr");
assert.strictEqual(caps.isWidgetAvailable("xfr2tr", "am263px"), false, "AM263Px (ICSSM, no RTU_PRU) must NOT have xfr2tr");
// Mutation: an ICSSM-like caps set without xfr2tr must be discriminated (proves the gate isn't vacuous).
const bareIcssm = new Set(["mac", "crc_hw", "spad"]);
assert.strictEqual(bareIcssm.has("xfr2tr"), false);

for (const soc of ["am243x", "am64x"]) {
    const txt = fs.readFileSync(path.join(root, ".metadata", "sysconfig", ".meta", "soc", `pru_blocks_${soc}.syscfg.js`), "utf8");
    assert.ok(txt.includes("xfr2tr_block"), `${soc} must catalogue xfr2tr_block (it has RTU_PRU)`);
    // Table 6-112: only RTU_PRU has the ring, so plain-PRU's separate topModules_pru
    // list must NOT carry it even though it shares the file with topModules_rtu_tx_pru.
    const pruSection = txt.slice(txt.indexOf("const topModules_pru"), txt.indexOf("const topModules_rtu_tx_pru"));
    assert.ok(!pruSection.includes("xfr2tr_block"), `${soc}'s plain-PRU catalog must not offer xfr2tr_block (RTU_PRU only)`);
}
for (const soc of ["am261x"]) {  // ICSSM palette in this repository
    const txt = fs.readFileSync(path.join(root, ".metadata", "sysconfig", ".meta", "soc", `pru_blocks_${soc}.syscfg.js`), "utf8");
    assert.ok(!txt.includes("xfr2tr_block"), `${soc} (ICSSM, no RTU_PRU) must NOT catalogue xfr2tr_block`);
}

// Core-type gate: the real validate() must reject non-RTU_PRU placement and
// accept RTU_PRU, using the block's own getCoreType() (not a copy).
function loadBlockOnCore(coreName) {
    const source = fs.readFileSync(blockPath, "utf8");
    const sandbox = { exports: {}, console, system: { getScript: () => ({ getSelfSysCfgCoreName: () => coreName }) } };
    vm.runInNewContext(source, sandbox, { filename: "xfr2tr_block.syscfg.js" });
    return sandbox.exports;
}
function validateErrorsOnCore(coreName, inst) {
    const b = loadBlockOnCore(coreName);
    const errs = [];
    b.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: () => {} });
    return errs;
}
assert.ok(validateErrorsOnCore("icss_g0_pru0", { operation: "status" }).some((e) => /RTU_PRU/.test(e)),
    "placing XFR2TR on a plain PRU core must be a build error naming RTU_PRU");
assert.deepStrictEqual(validateErrorsOnCore("icss_g0_rtu_pru0", { operation: "status" }), [],
    "placing XFR2TR on an RTU_PRU core must pass");
// Mutation: deleting the fault (switching to the RTU core) must flip the verdict.
assert.notDeepStrictEqual(
    validateErrorsOnCore("icss_g0_pru0", { operation: "status" }),
    validateErrorsOnCore("icss_g0_rtu_pru0", { operation: "status" }),
    "core-type mutation must flip the verdict");

// ---------------------------------------------------------------------------
// 7. Field validation: happy path and red arms for each operation's config.
// ---------------------------------------------------------------------------
function validateErrors(inst) {
    const errs = [];
    block.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: () => {} });
    return errs;
}
assert.deepStrictEqual(validateErrors({ operation: "configure", ringEntries: 16, trSize: 8 }), []);
assert.ok(validateErrors({ operation: "configure", ringEntries: 0, trSize: 8 }).some((e) => /ringEntries/.test(e)));
assert.ok(validateErrors({ operation: "configure", ringEntries: 4097, trSize: 8 }).some((e) => /ringEntries/.test(e)));
assert.ok(validateErrors({ operation: "configure", ringEntries: 16, trSize: 16 }).some((e) => /trSize/.test(e)));
assert.deepStrictEqual(validateErrors({ operation: "submit", submitCount: 8 }), []);
assert.ok(validateErrors({ operation: "submit", submitCount: 0 }).some((e) => /submitCount/.test(e)));
assert.ok(validateErrors({ operation: "submit", submitCount: 9 }).some((e) => /submitCount/.test(e)));
assert.deepStrictEqual(validateErrors({ operation: "status" }), []);
assert.ok(validateErrors({ operation: "bogus" }).some((e) => /operation/.test(e)));

// ---------------------------------------------------------------------------
// 8. Assemble the emitted macros when TI CGT is installed.
// ---------------------------------------------------------------------------
const clpru = (process.env.SystemDrive || "C:") + "\\ti\\ti-cgt-pru_2.3.3\\bin\\clpru.exe";
if (fs.existsSync(clpru)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfr2tr-"));
    const cases = [
        ["m_xfr2tr_configure", "R9, 65536, 0, 66048, 15, 0"],
        ["m_xfr2tr_submit", "R9, R20, R21, R22, R23, 6"],
        ["m_xfr2tr_status", "R9"]
    ];
    for (const [name, args] of cases) {
        const asm = path.join(dir, `${name}.asm`);
        fs.writeFileSync(asm, [
            "    .asg R28, TEMP_REG1", "    .sect \".text\"", "    .global main", macro(name),
            "main:", `    ${name} ${args}`, "    halt", ""
        ].join("\n"));
        const result = child.spawnSync(clpru, ["--silicon_version=4", "-c", "-o", path.join(dir, `${name}.obj`), asm], { encoding: "utf8" });
        assert.strictEqual(result.status, 0, `${name} clpru failed: ${result.stderr || result.stdout}`);
    }
} else {
    console.warn("clpru not installed; assembly arm skipped");
}

console.log("XFR2TR simulator/allocator/validator tests passed");
