"use strict";

// This block is a thin wrapper over the ICSSG's own 2-deep x 32-byte broadside
// FIFO at device ID 0x08 (SPRUIM2J 6.4.11.2.3.7.5, Table 6-134).
//
// Oracle note: the TI pru-simulator has NO device model for ID 0x08 (it is
// not one of the SPAD/MAC/BSWAP banks scripts/simulator.js recognises), so
// this suite does NOT claim simulator-tested behaviour. It proves, statically,
// that (1) every emitted macro assembles with clpru, including through
// allocator-style calls; (2) the emitted text is exactly the four documented
// XFR forms with device ID 8 and the documented register ranges; (3) the
// validator/palette/clobber arms fire and can be mutation-killed.
const assert = require("assert");
const child = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "data_handling", "stitch_fifo_block.syscfg.js");
const allocatorPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "register_allocation", "pru_register_allocator.js");
const staticPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "pru_blocks_static_module.syscfg.js");
const am243xPath = path.join(root, ".metadata", "sysconfig", ".meta", "soc", "pru_blocks_am243x.syscfg.js");
const am64xPath = path.join(root, ".metadata", "sysconfig", ".meta", "soc", "pru_blocks_am64x.syscfg.js");

const source = fs.readFileSync(blockPath, "utf8");
const sandbox = { exports: {}, console };
vm.runInNewContext(source, sandbox, { filename: "stitch_fifo_block.syscfg.js" });
const block = sandbox.exports;

function macro(name) { return block.getMacro("", name); }

// ---------------------------------------------------------------------------
// 1. The emitted contract is the TRM's four broadside forms, device ID 8.
// ---------------------------------------------------------------------------
assert.strictEqual(block.deviceId, 0x08);
assert.ok(macro("m_stitch_push").includes("xout  8, &R2, BYTECOUNT"),
    "push must XOUT device ID 8 from R2 (Table 6-134)");
assert.ok(macro("m_stitch_push").includes("mov   R2, INPUT"),
    "push must stage INPUT into the fixed R2 window before XOUT");
assert.ok(macro("m_stitch_pop").includes("xin   8, &R2, 32"),
    "pop must XIN 32 bytes from device ID 8 into R2:R9 (Table 6-134)");
assert.ok(macro("m_stitch_rewind").includes("xout  8, &R10, 1") && macro("m_stitch_rewind").includes("ldi   R10.b0, 1"),
    "rewind must set R10.b0 bit0 and XOUT device ID 8 (subtract 4 bytes from wr_ptr)");
assert.ok(macro("m_stitch_reset").includes("xout  8, &R10, 1") && macro("m_stitch_reset").includes("ldi   R10.b0, 2"),
    "reset must set R10.b0 bit1 and XOUT device ID 8 (reset rd_ptr and wr_ptr)");
// No mode may fall back to a software byte-lane / shift-chain implementation.
for (const name of ["m_stitch_push", "m_stitch_pop", "m_stitch_rewind", "m_stitch_reset"]) {
    assert.ok(!/\blsl\b|\blsr\b/.test(macro(name)), `${name} must not emit a software shift chain`);
}
assert.doesNotThrow(() => block.getMacro("m_stitch_push R4, R5, 4", ""),
    "static validation must accept allocator-style macro calls");
assert.throws(() => block.getMacro("", "m_stitch_bogus"),
    "unsupported operations must fail loudly, not silently produce an empty macro");

// Options are identifier-safe (no hyphens):.
for (const op of Object.keys(block.modes)) {
    assert.ok(/^[a-z_][a-z0-9_]*$/.test(op), `operation '${op}' must be a valid identifier fragment`);
}

// registerClobbers: push touches only R2 (this block never writes more than
// one register's worth of real INPUT data); pop clobbers the full R2:R9
// window (XIN always fills all 8 registers); rewind/reset clobber R10.
const clob = (op) => JSON.stringify(block.registerClobbers[op]);
assert.strictEqual(clob("push"), JSON.stringify([[2, 1]]));
assert.strictEqual(clob("pop"), JSON.stringify([[2, 8]]));
assert.strictEqual(clob("rewind"), JSON.stringify([[10, 1]]));
assert.strictEqual(clob("reset"), JSON.stringify([[10, 1]]));

// ---------------------------------------------------------------------------
// 2. Real allocator opCode/constant1 wiring (byteCount must reach the macro
//    call as a compile-time constant, not a runtime register).
// ---------------------------------------------------------------------------
const cfg = (name) => block.config.find((entry) => entry.name === name);
assert.strictEqual(cfg("opCode").getValue({ operation: "push" }), "m_stitch_push");
assert.strictEqual(cfg("opCode").getValue({ operation: "pop" }), "m_stitch_pop");
assert.strictEqual(cfg("constant1").getValue({ byteCount: 3 }), 3);
assert.strictEqual(cfg("opCode").default, "m_stitch_push",
    "opCode must have a real default, not an empty string");

const allocatorSource = fs.readFileSync(allocatorPath, "utf8");
function makeStitchInst(name, operation, byteCount) {
    return {
        $name: name, operation, byteCount,
        numOfInputPorts: cfg("numOfInputPorts").default,
        numOfOutputPorts: cfg("numOfOutputPorts").default,
        numOfConstants: cfg("numOfConstants").default,
        output1Size: cfg("output1Size").default,
        noOfCycles: cfg("noOfCycles").getValue({ operation }),
        opCode: cfg("opCode").getValue({ operation }),
        constant1: cfg("constant1").getValue({ byteCount }),
        registerClobbers: cfg("registerClobbers").getValue({ operation }),
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

const pushInst = makeStitchInst("PUSH1", "push", 3);
const loadInst = makeLoadInst("LOAD32", 0xAB);
loadInst.output1 = [{ inst: pushInst }];
pushInst.input1 = [{ inst: loadInst, port: "output1" }];
const allocated = runAllocator({
    "/pru_blocks/data_handling/load_constant_block": { $instances: [loadInst] },
    "/pru_blocks/data_handling/stitch_fifo_block": { $instances: [pushInst] }
}).exports.getPruRegisterAllocationSummary().pruInstructions;
assert.ok(allocated.some((i) => /^m_stitch_push R\d+\s*,\s*R\d+\s*,\s*3/.test(i)),
    `expected the real allocator to call m_stitch_push with constant1=3, got ${JSON.stringify(allocated)}`);

// ---------------------------------------------------------------------------
// 3. validate(): operation enum, core restriction, push byte-count bounds,
//    and unused/unconnected-port warnings.
// ---------------------------------------------------------------------------
function validateErrors(inst, coreOverride) {
    const errs = [], warns = [];
    // getCoreType() resolves `system` as a free variable inside the module's
    // OWN vm context (sandbox), not this process's global - it must be set on
    // the same sandbox object the module was compiled into, and is looked up
    // dynamically at call time rather than captured at parse time.
    const prevSystem = sandbox.system;
    sandbox.system = { getScript: () => ({ getSelfSysCfgCoreName: () => coreOverride || "icss_g0_pru0" }) };
    try {
        block.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: (m) => warns.push(String(m)) });
    } finally {
        sandbox.system = prevSystem;
    }
    return { errs, warns };
}
assert.ok(validateErrors({ operation: "bogus" }).errs.some((e) => /not one of the ICSSG broadside forms/.test(e)),
    "an unknown operation must be refused by name");
assert.ok(validateErrors({ operation: "push", byteCount: 5, input1: [{}] }).errs.some((e) => /Push byte count must be 1-4/.test(e)),
    "byteCount > 4 must be refused (would push uninitialized R3-R9 data)");
assert.ok(validateErrors({ operation: "push", byteCount: 0, input1: [{}] }).errs.some((e) => /Push byte count must be 1-4/.test(e)),
    "byteCount 0 must be refused");
assert.strictEqual(validateErrors({ operation: "push", byteCount: 4, input1: [{}] }, "icss_g0_pru0").errs.length, 0,
    "a valid push on a PRU core must not error");
assert.ok(validateErrors({ operation: "push", byteCount: 4, input1: [] }).warns.some((e) => /not connected/.test(e)),
    "push with no input1 connection must warn");
assert.ok(validateErrors({ operation: "pop", input1: [{}] }).warns.some((e) => /does not consume a dataflow input/.test(e)),
    "pop with input1 connected must warn that it is unused (graph ordering only)");
// Table 6-60: STITCH_FIFO64 is PRU1/0 ONLY - not RTU_PRU, not TX_PRU.
assert.ok(validateErrors({ operation: "pop" }, "icss_g0_rtu_pru0").errs.some((e) => /PRU1\/0 only/.test(e)),
    "RTU_PRU must be rejected");
assert.ok(validateErrors({ operation: "pop" }, "icss_g0_tx_pru0").errs.some((e) => /PRU1\/0 only/.test(e)),
    "TX_PRU must be rejected");
assert.strictEqual(validateErrors({ operation: "pop" }, "icss_g0_pru1").errs.length, 0,
    "PRU1 must be accepted");

// ---------------------------------------------------------------------------
// 4. registered-where-validate-rejects:
//    the block must be in the PRU-only palette, never topModules_rtu_tx_pru.
// ---------------------------------------------------------------------------
for (const socPath of [am243xPath, am64xPath]) {
    const socSource = fs.readFileSync(socPath, "utf8");
    const pruIdx = socSource.indexOf("const topModules_pru");
    const rtuIdx = socSource.indexOf("const topModules_rtu_tx_pru");
    assert.ok(pruIdx >= 0 && rtuIdx > pruIdx, `${socPath} must declare topModules_pru before topModules_rtu_tx_pru`);
    const pruSection = socSource.slice(pruIdx, rtuIdx);
    const rtuSection = socSource.slice(rtuIdx);
    assert.ok(pruSection.includes("/pru_blocks/data_handling/stitch_fifo_block"),
        `${socPath}: stitch_fifo_block must be registered in topModules_pru`);
    assert.ok(!rtuSection.includes("/pru_blocks/data_handling/stitch_fifo_block"),
        `${socPath}: stitch_fifo_block must NOT be registered in topModules_rtu_tx_pru (validate() rejects those cores)`);
}

// ---------------------------------------------------------------------------
// 5. Build-time rejection: a live value inside a fixed window (R2:R9 or R10)
//    across a stitch FIFO op is an ERROR. Runs the real validateStitchFifoGlobal
//    from the real static module - not a copy - so this cannot drift from
//    shipped code. Mirrors validateBswapGlobal red-arm structure.
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
    vm.runInNewContext(staticSource + "\n;globalThis.__validateStitchFifoGlobal = validateStitchFifoGlobal;",
        ctx, { filename: "pru_blocks_static_module.syscfg.js" });
    return ctx.__validateStitchFifoGlobal;
}
function makeAddInst(name) {
    return {
        $name: name, numOfInputPorts: 2, numOfOutputPorts: 1, numOfConstants: 0,
        output1Size: 4, noOfCycles: 1, opCode: "add", input1: [], input2: [], output1: []
    };
}
// A fan-out producer consumed on both sides of the op: six of them keep enough
// values simultaneously live that the allocator places several inside the
// R2-R9 window a pop clobbers.
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
    const stitchOp = makeStitchInst("POPOP", "pop");
    stitchOp.input1 = [{ inst: prev, port: "output1" }];
    prev.output1.push({ inst: stitchOp });

    const post = [];
    const lateLoads = [];
    let fprev = stitchOp;
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
            "/pru_blocks/data_handling/stitch_fifo_block": { $instances: [stitchOp] },
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
const opIndex = liveAcross.summary.pruInstructionInstances.findIndex((i) => i && i.$name === "POPOP");
assert.ok(opIndex > 0 && opIndex < liveAcross.summary.pruInstructions.length - 1,
    `the pop must be scheduled between a producer and a consumer, got ${JSON.stringify(liveAcross.summary.pruInstructions)}`);
// Guard the arm itself: if no live producer actually lands in R2-R9 the check
// below would pass vacuously.
const offenders = acrossDesign.loadNames.filter((n) => {
    const m = /^R(\d+)/.exec(liveAcross.alloc.getBlockRegisterAllocation(n) || "");
    return m && Number(m[1]) >= 2 && Number(m[1]) <= 9;
});
assert.ok(offenders.length > 0,
    "the design must place a live producer inside R2-R9 for this arm to mean anything");
assert.ok(liveAcross.errors.some((e) => /Stitch FIFO 'POPOP'.*live value in R\d+/.test(e)),
    `a live value inside the R2-R9 window across a pop must be a build error, got ${JSON.stringify(liveAcross.errors)}`);

// Fault site deleted: the same graph with nothing live across the op must build clean.
const noneAcross = collectErrors(buildLiveAcrossDesign(false));
assert.ok(!noneAcross.errors.some((e) => e.includes("Stitch FIFO")),
    `no Stitch FIFO error is allowed when nothing is live across the op, got ${JSON.stringify(noneAcross.errors)}`);

// ---------------------------------------------------------------------------
// 6. Assemble every macro getMacro() can emit, for every opCode, with the
//    real compiler - including through allocator-style two/three-operand
//    calls. This is the check own test skipped by stripping
//    .macro/.endm before simulating.
// ---------------------------------------------------------------------------
const clpru = (process.env.SystemDrive || "C:") + "\\ti\\ti-cgt-pru_2.3.3\\bin\\clpru.exe";
if (fs.existsSync(clpru)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
    const cases = [
        ["m_stitch_push", "R4, R5, 4"], ["m_stitch_push", "R4, R4, 1"],
        ["m_stitch_pop", "R20, R21, 32"],
        ["m_stitch_rewind", "R20, R21, 0"],
        ["m_stitch_reset", "R20, R21, 0"]
    ];
    for (const [name, args] of cases) {
        const asm = path.join(dir, `${name}_${args.replace(/[^a-z0-9]/gi, "")}.asm`);
        fs.writeFileSync(asm, [
            "    .asg R28, TEMP_REG1", "    .sect \".text\"", "    .global main", macro(name),
            "main:", `    ${name} ${args}`, "    halt", ""
        ].join("\n"));
        const objOut = asm.replace(/\.asm$/, ".obj");
        const result = child.spawnSync(clpru, ["-v3", "--silicon_version=3", "-c", "-o", objOut, asm], { encoding: "utf8" });
        assert.strictEqual(result.status, 0, `${name} ${args} clpru failed: ${result.stderr || result.stdout}`);
    }
} else {
    console.warn("clpru not installed; assembly arm skipped");
}

console.log("Stitch FIFO broadside tests passed");
