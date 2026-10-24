#!/usr/bin/env node
"use strict";
/*
 * Committed harness for the XFR2TR CROSS-INSTANCE validator.
 *
 * Why this file exists
 * --------------------
 * The main XFR2TR trap -- "submitting N IDs into a ring declared with
 * tr_rsrc_nums below N-1 is a build error" -- cannot be reached through the
 * per-instance `validate()` that `scripts/block_validate_runner.js` drives,
 * because ringEntries lives on a `configure` instance and submitCount lives
 * on a different `submit` instance. The check therefore lives in
 * `validateXfr2trGlobal` inside
 * `.metadata/sysconfig/.meta/pru_blocks/common/pru_blocks_static_module.syscfg.js`,
 * and without this runner nothing in the repository invokes it: dead-coding the
 * entire guard would leave the other suites passing.
 *
 * This runner loads the SHIPPED static module and calls the SHIPPED
 * `validateXfr2trGlobal`. It does not re-implement the rule. That distinction
 * matters: `scripts/static_runner.js` re-implements its equivalent
 * XFR2PSI logic inline, so a mutation of the real validator leaves its arms
 * green -- the exact failure this file is written to avoid.
 *
 * Instances are built from the block's OWN declared config defaults, so a
 * default that drifts shows up here rather than being pinned twice.
 *
 * Usage
 * -----
 *   node scripts/global_runner.js '<json>'
 *      <json> = [{"$name":"CFG","operation":"configure","ringEntries":1},
 *                {"$name":"SUB","operation":"submit","submitCount":8}]
 *      prints {"globalErrors":[...],"instanceErrors":{"CFG":[...],"SUB":[...]}}
 *
 * Or require() it: { loadBlock, instFromConfig, globalErrors, instanceErrors,
 *                    allErrors, constantValue }.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const BLOCK_PATH = path.join(ROOT, ".metadata", "sysconfig", ".meta", "pru_blocks",
    "pru_io_blocks", "xfr2tr_block.syscfg.js");
const STATIC_PATH = path.join(ROOT, ".metadata", "sysconfig", ".meta", "pru_blocks",
    "common", "pru_blocks_static_module.syscfg.js");

const DEFAULT_CORE = "icss_g0_rtu_pru0";

function loadBlock(coreName) {
    const source = fs.readFileSync(BLOCK_PATH, "utf8");
    const sandbox = {
        exports: {},
        console: { log() {}, warn() {}, error() {} },
        system: { getScript: () => ({ getSelfSysCfgCoreName: () => coreName || DEFAULT_CORE }) },
    };
    vm.runInNewContext(source, sandbox, { filename: "xfr2tr_block.syscfg.js" });
    return sandbox.exports;
}

// The static module reaches for allocator/SoC services this check never uses.
// A permissive stub lets the module load without faking the validator itself:
// the guard under test runs BEFORE the `try {}` that touches the allocator, so
// nothing it depends on is stubbed away.
function deepStub() {
    const fn = function () { return deepStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
            if (prop === Symbol.iterator || prop === "then" || prop === "length") return undefined;
            return deepStub();
        },
        apply() { return deepStub(); },
    });
}

function loadGlobalValidator(instances, coreName) {
    const staticSource = fs.readFileSync(STATIC_PATH, "utf8");
    const common = {
        getSocName: () => "am64x",
        getSelfSysCfgCoreName: () => coreName || DEFAULT_CORE,
    };
    const ctx = {
        system: {
            modules: { "/pru_blocks/pru_io_blocks/xfr2tr_block": { $instances: instances } },
            getScript: (p) => {
                const s = String(p);
                if (s.includes("pru_register_allocator")) return deepStub();
                if (s === "/common" || s.endsWith("/common")) return common;
                return deepStub();
            },
            deviceData: { device: "AM243x", package: "ZCZ" },
        },
        exports: {},
        module: { exports: {} },
        console: { log() {}, warn() {}, error() {} },
        require: () => deepStub(),
        Set, Map, JSON, Math, Number, Array, Object, String, RegExp, Error,
        parseInt, parseFloat, isNaN, Boolean, Symbol, Proxy,
    };
    ctx.globalThis = ctx;
    ctx.global = ctx;
    vm.runInNewContext(
        staticSource + "\n;globalThis.__xfr2trGlobal = validateXfr2trGlobal;",
        ctx, { filename: "pru_blocks_static_module.syscfg.js" });
    if (typeof ctx.__xfr2trGlobal !== "function") {
        throw new Error("validateXfr2trGlobal not found in the shipped static module");
    }
    return ctx.__xfr2trGlobal;
}

/** Build an instance from the block's own declared config defaults. */
function instFromConfig(name, operation, overrides) {
    const block = loadBlock();
    const inst = { $name: name, operation: operation };
    for (const c of block.config) {
        if (c.name === "operation") continue;
        if (!("default" in c)) continue;
        inst[c.name] = c.default;
    }
    return Object.assign(inst, overrides || {});
}

/** Errors raised by the SHIPPED validateXfr2trGlobal for this instance set. */
function globalErrors(instances, coreName) {
    const validate = loadGlobalValidator(instances, coreName);
    const errs = [];
    validate({}, { logError: (m) => errs.push(String(m)), logWarning: () => {}, logInfo: () => {} });
    return errs;
}

/** Errors raised by the block's own per-instance validate(). */
function instanceErrors(inst, coreName) {
    const block = loadBlock(coreName);
    const errs = [];
    block.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: () => {} });
    return errs;
}

function allErrors(instances, coreName) {
    const out = { globalErrors: globalErrors(instances, coreName), instanceErrors: {} };
    for (const inst of instances) {
        out.instanceErrors[inst.$name] = instanceErrors(inst, coreName);
    }
    return out;
}

/** Read a hidden getValue-backed config (e.g. constant4 = tr_rsrc_nums). */
function constantValue(name, inst, coreName) {
    const block = loadBlock(coreName);
    const cfg = block.config.find((c) => c.name === name);
    if (!cfg) throw new Error("no config named " + name);
    return typeof cfg.getValue === "function" ? cfg.getValue(inst) : cfg.default;
}

module.exports = {
    loadBlock, instFromConfig, globalErrors, instanceErrors, allErrors, constantValue,
    BLOCK_PATH, STATIC_PATH,
};

if (require.main === module) {
    const arg = process.argv[2];
    if (!arg) {
        console.error("Usage: node scripts/global_runner.js '<json instance array>'");
        process.exit(2);
    }
    const spec = JSON.parse(arg);
    const instances = spec.map((s) => instFromConfig(s.$name, s.operation || "configure", s));
    console.log(JSON.stringify(allErrors(instances, spec.coreName)));
}
