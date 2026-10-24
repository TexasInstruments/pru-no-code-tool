"use strict";

// Exercises the production module, not a copied byte-order
// implementation. Every arm below runs the macro text the block actually emits.
//
// Oracle note: the XIN 160/161/162 device model in scripts/simulator.js and this
// block were both written from SPRUIM2J 6.4.6.2.7 / Table 6-95. The simulator arm
// therefore proves the block emits what the TRM describes and that the emitted
// operands are wired to the dataflow value; it is NOT an independent oracle.
const assert = require("assert");
const child = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Simulator } = require(path.join(__dirname, "..", "simulator"));

const root = path.resolve(__dirname, "..", "..");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "data_handling", "bswap_block.syscfg.js");
const allocatorPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "register_allocation", "pru_register_allocator.js");
const staticPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_blocks_static_module.syscfg.js");

const source = fs.readFileSync(blockPath, "utf8");
const sandbox = { exports: {}, console };
vm.runInNewContext(source, sandbox, { filename: "bswap_block.syscfg.js" });
const block = sandbox.exports;

function macro(name) { return block.getMacro("", name); }

// Expand a macro definition into executable instructions with the given operand
// substitution. Comment lines are dropped; nothing else is rewritten, so a
// defect in the emitted body reaches the simulator unaltered.
function macroBody(macroText, subs) {
    return macroText.split(/\r?\n/)
        .filter((line) => !line.includes(".macro") && !line.includes(".endm"))
        .filter((line) => !/^\s*;/.test(line))
        .filter((line) => line.trim().length > 0)
        .map((line) => Object.keys(subs).reduce((out, key) => out.split(key).join(subs[key]), line));
}
function runInSimulator(setup, bodyLines, steps) {
    const sim = new Simulator();
    sim.loadInstructions([...setup, ...bodyLines, "HALT"]);
    sim.stepPaced(steps || 60);
    assert.ok(!sim.state.errorParsing, `parse error: ${JSON.stringify(sim.state.errorParsing)}`);
    return sim;
}

const sample = 0x11223344;

// ---------------------------------------------------------------------------
// 1. The emitted contract is the TRM's, not a software byte-lane chain.
//    Table 6-95 device IDs and the spans each function is defined over.
// ---------------------------------------------------------------------------
assert.strictEqual(block.deviceIds.word_swap, 0xA0);
assert.strictEqual(block.deviceIds.swap_4_8, 0xA1);
assert.strictEqual(block.deviceIds.swap_4_16, 0xA2);
assert.ok(macro("m_bswap_word_swap").includes("xin   160, &RES, 4"),
    "0xA0 must swap the block's own register in place (6.4.6.2.7.1: any of R0-R29)");
// "must start at R2.b0 and cannot exceed R9" -> 8 registers -> 32 bytes.
assert.ok(macro("m_bswap_swap_4_8").includes("xin   161, &R2, 32"));
// "must start at R2.b0 and cannot exceed R17" -> 16 registers -> 64 bytes.
assert.ok(macro("m_bswap_swap_4_16").includes("xin   162, &R2, 64"));
// No mode may fall back to an open-coded byte-lane chain of software MOVs.
for (const name of ["m_bswap_word_swap", "m_bswap_swap_4_8", "m_bswap_swap_4_16"]) {
    assert.ok(!/\.b\d/.test(macro(name)), `${name} must not emit software byte-lane MOVs`);
}
// 0xA0 has no fixed window and must not reserve registers it does not need.
const clob = (m) => JSON.stringify(block.registerClobbers[m]);
assert.strictEqual(clob("word_swap"), "[]");
assert.strictEqual(clob("swap_4_8"), JSON.stringify([[2, 4], [6, 4]]));
assert.strictEqual(clob("swap_4_16"), JSON.stringify([[2, 4], [6, 4], [10, 4], [14, 4]]));
assert.strictEqual(block.cycleBasis.word_swap.peakCycles, 2);
assert.doesNotThrow(() => block.getMacro("m_bswap_word_swap R4, R5", ""),
    "static validation must accept allocator-style macro calls");
assert.throws(() => block.getMacro("", "m_bswap_word_rotate_left"),
    "removed modes must fail loudly, not alias onto word_swap");

// ---------------------------------------------------------------------------
// 2. Behaviour: the repository Simulator executes the production macro body.
// ---------------------------------------------------------------------------
// 2a. Aliased form, which is what the allocator emits (RES === INPUT).
let sim = runInSimulator([`LDI32 R5, ${sample}`],
    macroBody(macro("m_bswap_word_swap"), { RES: "R5", INPUT: "R5" }));
assert.strictEqual(sim.state.registers[5] >>> 0, 0x44332211,
    "0xA0 must byte-reverse the dataflow value in place");

// 2b. Non-aliased form: the value must reach the output register, and the
//     source must be the block's input rather than a fixed staging register.
sim = runInSimulator([`LDI32 R5, ${sample}`, "LDI32 R2, 0", "LDI32 R4, 0"],
    macroBody(macro("m_bswap_word_swap"), { RES: "R4", INPUT: "R5" }));
assert.strictEqual(sim.state.registers[4] >>> 0, 0x44332211,
    "0xA0 must swap the value taken from INPUT, not whatever happens to be in R2");

// 2c. 4_8 exchanges R2-R5 with R6-R9 (6.4.6.2.7.2).
sim = runInSimulator([
    "LDI32 R2, 2", "LDI32 R3, 3", "LDI32 R4, 4", "LDI32 R5, 5",
    "LDI32 R6, 6", "LDI32 R7, 7", "LDI32 R8, 8", "LDI32 R9, 9"
], macroBody(macro("m_bswap_swap_4_8"), { RES: "R20", INPUT: "R20" }), 80);
assert.deepStrictEqual(
    [2, 3, 4, 5, 6, 7, 8, 9].map((r) => sim.state.registers[r] >>> 0),
    [6, 7, 8, 9, 2, 3, 4, 5], "0xA1 must exchange R2-R5 with R6-R9");
assert.strictEqual(sim.state.registers[20] >>> 0, 6, "0xA1 must publish R2 as the block output");

// 2d. 4_16 exchanges R2-R5 with R14-R17 and R6-R9 with R10-R13 (6.4.6.2.7.3).
sim = runInSimulator(
    Array.from({ length: 16 }, (_, i) => `LDI32 R${i + 2}, ${i + 2}`),
    macroBody(macro("m_bswap_swap_4_16"), { RES: "R20", INPUT: "R20" }), 120);
assert.deepStrictEqual(
    Array.from({ length: 16 }, (_, i) => sim.state.registers[i + 2] >>> 0),
    [14, 15, 16, 17, 10, 11, 12, 13, 6, 7, 8, 9, 2, 3, 4, 5],
    "0xA2 must exchange R2-R5 with R14-R17 and R6-R9 with R10-R13");

// ---------------------------------------------------------------------------
// 3. Red arms. Each mutates the real emitted body at one fault site and the
//    assertion must stop holding.
// ---------------------------------------------------------------------------
// 3a. Wrong device ID.
let broken = macroBody(macro("m_bswap_word_swap").replace("xin   160", "xin   161"), { RES: "R5", INPUT: "R5" });
assert.notStrictEqual(runInSimulator([`LDI32 R5, ${sample}`], broken).state.registers[5] >>> 0, 0x44332211,
    "device-ID mutation must be discriminated");

// 3b. Dropping the MOV that moves the dataflow value into the swapped register.
//     Without it the XIN would swap a register the input was never written to.
broken = macroBody(macro("m_bswap_word_swap"), { RES: "R4", INPUT: "R5" }).filter((l) => !/^\s*mov/i.test(l));
assert.notStrictEqual(
    runInSimulator([`LDI32 R5, ${sample}`, "LDI32 R4, 0"], broken).state.registers[4] >>> 0, 0x44332211,
    "removing the dataflow MOV must be discriminated");

// 3c. Swapping a fixed staging register instead of the block's own register.
broken = macroBody(macro("m_bswap_word_swap").replace("&RES", "&R2"), { RES: "R4", INPUT: "R5" });
assert.notStrictEqual(
    runInSimulator([`LDI32 R5, ${sample}`, "LDI32 R2, 0", "LDI32 R4, 0"], broken).state.registers[4] >>> 0, 0x44332211,
    "an XIN aimed at a register the input was never written to must be discriminated");

// 3d. The fixed-window functions must start at R2.b0 (6.4.6.2.7.2/.3).
broken = macroBody(macro("m_bswap_swap_4_8").replace("&R2", "&R3"), { RES: "R20", INPUT: "R20" });
sim = new Simulator();
sim.loadInstructions(["LDI32 R2, 2", ...broken, "HALT"]);
sim.stepPaced(60);
assert.ok(sim.state.unknownInstruction, "a 4_8 XIN not starting at R2.b0 must be rejected by the device model");

// ---------------------------------------------------------------------------
// 4. Real production allocator at its direct SysConfig boundary. Only blocks
//    that are one native ALU instruction may take the register of an input
//    they consume last (IN_PLACE_SAFE_OPCODES in the allocator); an m_* macro
//    such as BSWAP gets a fresh destination, so RES !== INPUT here. The in-place
//    RES === INPUT form is still covered by arm 2a above.
// ---------------------------------------------------------------------------
const allocatorSource = fs.readFileSync(allocatorPath, "utf8");
const cfg = (name) => block.config.find((entry) => entry.name === name);
function makeBswapInst(name, mode) {
    return {
        $name: name, mode,
        numOfInputPorts: cfg("numOfInputPorts").default,
        numOfOutputPorts: cfg("numOfOutputPorts").default,
        numOfConstants: cfg("numOfConstants").default,
        output1Size: cfg("output1Size").default,
        noOfCycles: cfg("noOfCycles").getValue({ mode }),
        // Production getValue, not a hand-written string: a mismatch between the
        // opcode the allocator emits and the macro the block defines is a build
        // break, so the test must not paper over it.
        opCode: cfg("opCode").getValue({ mode }),
        registerClobbers: cfg("registerClobbers").getValue({ mode }),
        input1: [], output1: []
    };
}
function makeLoadInst(name, value) {
    return {
        $name: name, numOfInputPorts: 0, numOfOutputPorts: 1, numOfConstants: 1,
        constant1: value, output1Size: 4, noOfCycles: 1, opCode: "LDI32", output1: []
    };
}
function runAllocator(modules) {
    const ctx = { system: { modules }, exports: {}, console, Set, Map, JSON };
    vm.runInNewContext(allocatorSource, ctx, { filename: "pru_register_allocator.js" });
    ctx.exports.allocatePruRegisters();
    return ctx;
}

const bswapInst = makeBswapInst("BSWAP", "word_swap");
const loadInst = makeLoadInst("LOAD32", sample);
loadInst.output1 = [{ inst: bswapInst, port: "input1" }];
bswapInst.input1 = [{ inst: loadInst, port: "output1" }];
const allocated = runAllocator({
    "/pru_blocks/data_handling/load_constant_block": { $instances: [loadInst] },
    "/pru_blocks/data_handling/bswap_block": { $instances: [bswapInst] }
}).exports.getPruRegisterAllocationSummary().pruInstructions;
assert.deepStrictEqual(Array.from(allocated), ["LDI32 R0, 287454020", "m_bswap_word_swap R1, R0"],
    `expected the allocator to read the LOAD32 register and write a fresh destination, got ${JSON.stringify(allocated)}`);
// The allocator's own call, run end to end.
sim = runInSimulator([`LDI32 R0, ${sample}`, "LDI32 R1, 0"],
    macroBody(macro("m_bswap_word_swap"), { RES: "R1", INPUT: "R0" }));
assert.strictEqual(sim.state.registers[1] >>> 0, 0x44332211,
    "the allocator's R0 -> R1 call must byte-reverse the input into the output");
assert.strictEqual(sim.state.registers[0] >>> 0, sample,
    "a non-aliased BSWAP must leave its input register unchanged");
// 0xA0 must not steal R2-R17 from the design.
// registerClobbers is a JSON string: SysConfig's GUI rejects an array-valued configurable.
assert.strictEqual(typeof cfg("registerClobbers").getValue({ mode: "word_swap" }), "string",
    "registerClobbers must stay a JSON string or the SysConfig GUI cannot render the block");
assert.deepStrictEqual(JSON.parse(cfg("registerClobbers").getValue({ mode: "word_swap" })), [],
    "0xA0 has no fixed window and must reserve nothing");

// ---------------------------------------------------------------------------
// 5. Build-time rejection: a live value inside a 4_8/4_16 window across the
//    swap is an ERROR. The real validateBswapGlobal from the real static module
//    is executed here -- not a copy -- so the test cannot drift from shipped code.
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
    vm.runInNewContext(staticSource + "\n;globalThis.__bswapValidateGlobal = validateBswapGlobal;",
        ctx, { filename: "pru_blocks_static_module.syscfg.js" });
    return ctx.__bswapValidateGlobal;
}

function makeAddInst(name) {
    return {
        $name: name, numOfInputPorts: 2, numOfOutputPorts: 1, numOfConstants: 0,
        output1Size: 4, noOfCycles: 1, opCode: "add", input1: [], input2: [], output1: []
    };
}
// A fan-out producer consumed on both sides of the swap is what "live across"
// means to the allocator: six of them keep enough values simultaneously live
// that the allocator places several inside the R2-R9 window 4_8 exchanges.
// With consumesAcross=false the post-swap chain reads only values created after
// the swap, which is the same graph with the fault site removed.
function buildLiveAcrossDesign(consumesAcross) {
    const N = 6;
    const loads = Array.from({ length: N }, (_, i) => makeLoadInst("P" + i, i + 1));
    const pre = [];
    let prev = loads[0];
    for (let i = 1; i < N; i++) {
        const a = makeAddInst("PRE" + i);
        pre.push(a);
        a.input1 = [{ inst: prev, port: "output1" }];
        a.input2 = [{ inst: loads[i] }];
        prev.output1.push({ inst: a });
        loads[i].output1.push({ inst: a });
        prev = a;
    }
    const swap = makeBswapInst("SWAP", "swap_4_8");
    swap.input1 = [{ inst: prev, port: "output1" }];
    prev.output1.push({ inst: swap });

    const post = [];
    const lateLoads = [];
    let fprev = swap;
    for (let i = 0; i < N; i++) {
        const f = makeAddInst("POST" + i);
        post.push(f);
        let second;
        if (consumesAcross) {
            second = loads[i];
        } else {
            second = makeLoadInst("LATE" + i, 100 + i);
            lateLoads.push(second);
        }
        f.input1 = [{ inst: fprev, port: "output1" }];
        f.input2 = [{ inst: second, port: "output1" }];
        (fprev.output1 = fprev.output1 || []).push({ inst: f });
        second.output1.push({ inst: f });
        fprev = f;
    }
    return {
        loadNames: loads.map((l) => l.$name),
        modules: {
            "/pru_blocks/data_handling/load_constant_block": { $instances: loads.concat(lateLoads) },
            "/pru_blocks/data_handling/bswap_block": { $instances: [swap] },
            "/pru_blocks/data_handling/arithmetic_block": { $instances: pre.concat(post) }
        }
    };
}

function collectErrors(design) {
    const ctx = runAllocator(design.modules);
    const validate = loadStaticValidator(design.modules, ctx.exports);
    const errors = [];
    validate({}, { logError: (m) => errors.push(String(m)), logWarning: () => {}, logInfo: () => {} });
    return { errors, summary: ctx.exports.getPruRegisterAllocationSummary(), alloc: ctx.exports };
}

const acrossDesign = buildLiveAcrossDesign(true);
const liveAcross = collectErrors(acrossDesign);
const swapIndex = liveAcross.summary.pruInstructionInstances.findIndex((i) => i && i.$name === "SWAP");
assert.ok(swapIndex > 0 && swapIndex < liveAcross.summary.pruInstructions.length - 1,
    `the 4_8 swap must be scheduled between a producer and a consumer, got ${JSON.stringify(liveAcross.summary.pruInstructions)}`);
// Guard the arm itself: if no live producer actually lands in R2-R9 the check
// below would pass vacuously.
const offenders = acrossDesign.loadNames.filter((n) => {
    const m = /^R(\d+)/.exec(liveAcross.alloc.getBlockRegisterAllocation(n) || "");
    return m && Number(m[1]) >= 2 && Number(m[1]) <= 9;
});
assert.ok(offenders.length > 0,
    "the design must place a live producer inside R2-R9 for this arm to mean anything");
assert.ok(liveAcross.errors.some((e) => /BSWAP 'SWAP'.*live value in R\d+/.test(e)),
    `a live value inside the 4_8 window across the swap must be a build error, got ${JSON.stringify(liveAcross.errors)}`);

// Fault site deleted: the same graph with nothing live across the swap must build.
const noneAcross = collectErrors(buildLiveAcrossDesign(false));
assert.ok(!noneAcross.errors.some((e) => e.includes("BSWAP")),
    `no BSWAP error is allowed when nothing is live across the swap, got ${JSON.stringify(noneAcross.errors)}`);

// 0xA0 declares no window, so it can never raise this error.
assert.strictEqual(clob("word_swap"), "[]");

// ---------------------------------------------------------------------------
// 6. Mode validation is reachable: removed modes are refused, not remapped.
// ---------------------------------------------------------------------------
function validateErrors(inst) {
    const errs = [];
    block.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: () => {} });
    return errs;
}
assert.ok(validateErrors({ mode: "rotate_left" }).some((e) => /no rotate function/.test(e)),
    "rotate_left was never an ICSSG BSWAP function and must be refused by name");
assert.ok(validateErrors({ mode: "swap" }).some((e) => /Use 'word_swap'/.test(e)),
    "the former 'swap' mode must be refused with the replacement named");
assert.ok(validateErrors({ mode: "word_swap", byteWidth: "halfword" }).some((e) => /byteWidth/.test(e)),
    "a leftover Width setting must be refused rather than silently ignored");
assert.strictEqual(validateErrors({ mode: "word_swap", input1: [{}] }).length, 0);
// At 16-bit width swap and rotate are the same permutation, so the halfword
// modes are collapsed rather than shipped as three identical aliases.
assert.ok(/collapsed rather than aliased/.test(block.halfwordEquivalenceNote));

// ---------------------------------------------------------------------------
// 7. Assemble the emitted macros when TI CGT is installed.
// ---------------------------------------------------------------------------
const clpru = (process.env.SystemDrive || "C:") + "\\ti\\ti-cgt-pru_2.3.3\\bin\\clpru.exe";
if (fs.existsSync(clpru)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bswap-"));
    const cases = [
        ["m_bswap_word_swap", "R4, R5"], ["m_bswap_word_swap", "R4, R4"],
        ["m_bswap_swap_4_8", "R20, R21"], ["m_bswap_swap_4_16", "R20, R21"]
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

console.log("BSWAP broadside tests passed");
