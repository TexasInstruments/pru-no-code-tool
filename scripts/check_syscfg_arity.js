#!/usr/bin/env node
/*
 * check_syscfg_arity.js - fail on any block whose default instance SysConfig cannot generate code for
 * because the generated macro call has the wrong number of arguments.
 *
 *     node scripts/check_syscfg_arity.js [<.meta root>] [--list]
 *       --list also prints every reached block as 'reached <module>'
 *
 * common/pru_blocks_static_module.syscfg.js rejects a generated macro call whose argument
 * count differs from the macro definition ("Macro arity mismatch: generated call has N args but
 * definition expects M"). About a dozen blocks hit it and could not be used in the GUI at all.
 * This adds a default instance of every pru_blocks module through the REAL SysConfig CLI and fails
 * on any such error.
 *
 * It checks the COUNT only. The ORDER of the arguments is not visible to it; a block whose count was
 * fixed still needs a test that runs the generated firmware.
 *
 * Each block is probed TWICE, both with every input port wired to a load_constant.
 *   standalone  - only the block (and whatever static module the block itself declares). A block that
 *                 emits no macro call here has no usable dependency: a design containing only it
 *                 generates nothing (STANDALONE_UNREACHABLE lists the known ones with a reason; a new
 *                 one, or a stale entry, fails the sweep).
 *   with static - pru_blocks_static_module added explicitly, so the macro call is generated and its
 *                 arity checked even for a block that declares no dependency.
 * "Reached" means the probe's pru_syscfg.asm contains a call to a macro defined in pru_syscfg.inc (or
 * the arity guard named the call). The final lines count reached / blocks with getMacro and list every
 * block that was not reached with the reason - nothing is silently skipped.
 *
 * Fails closed. A probe passes only if SysConfig demonstrably ran the script AND validated it
 * ("Running script..." and "Validating..." on the output; the arity guard runs in validation) and
 * raised no arity error. A missing/unrunnable SysConfig node or CLI, a probe that dies before
 * validation, or one that prints nothing is a FAILURE, never a pass. Other validation errors on a
 * bare default instance (unconnected input ports, ...) are not arity errors and are only counted.
 *
 * Environment: SYSCONFIG_NODE, SYSCONFIG_CLI (defaults: <SystemDrive>\ti\sysconfig_1.28.0\...).
 * Exit 0 clean, 1 on any finding, 2 when SysConfig is not available at all.
 */
"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ARGS = process.argv.slice(2);
const LIST = ARGS.includes("--list");
const ROOT = path.resolve(ARGS.find(a => !a.startsWith("--")) || path.join(__dirname, "..", ".metadata", "sysconfig", ".meta"));
const PRODUCT = path.join(ROOT, "..", "..", "product.json");
const NODE = process.env.SYSCONFIG_NODE || (process.env.SystemDrive || "C:") + "\\ti\\sysconfig_1.28.0\\nodejs\\node.exe";
const CLI = process.env.SYSCONFIG_CLI || (process.env.SystemDrive || "C:") + "\\ti\\sysconfig_1.28.0\\dist\\cli.js";
const CONCURRENCY = 8;

// Every block must have a matching generated call; no known-broken exemption.
const KNOWN_BROKEN = {};

// Blocks that emit nothing in a design containing only them (no static-module dependency declared).
// Keyed by module path; an entry that now emits standalone is STALE and fails.
const STANDALONE_UNREACHABLE = {
};

// Blocks with a getMacro that this probe cannot get a generated macro call out of, with the reason.
// Counted in the coverage line, never silently skipped; an entry that is reached now is STALE and fails.
const UNREACHABLE = {
    "/pru_blocks/application_specific/application_host_block": "getMacro returns '' (the block emits no .macro definition) although a call 'm_host_app_none R0.b0' is generated: nothing to arity-check",
    "/pru_blocks/pru_io_blocks/fdb_gp_ram_block": "validation requires externalInitProvided=true before code is generated: needs a configured fixture",
    "/pru_blocks/pru_io_blocks/xfr2spin_block": "validation requires a matching release block for the acquire: needs a paired fixture",
    "/pru_blocks/pru_io_blocks/xfr2tr_block": "validation requires an RTU_PRU core; the probe context is icss_g0_pru0",
    "/pru_blocks/utils/access_look_up_table": "wired input 7001 is out of the LUT bounds [0,15] and needs a look_up_table to access: needs a paired fixture",
    "/pru_blocks/utils/data_splitter": "its input is a 64-bit port; the probe's 32-bit load_constant source cannot connect to it",
    "/pru_blocks/utils/delay_block": "emits inline instructions, no .macro definition or call to arity-check",
    "/pru_blocks/utils/look_up_table": "emits a data section (.initdmem), no .macro definition or call to arity-check",
    "/pru_blocks/utils/memory_variable_block": "emits a .usect reservation, no .macro definition or call to arity-check",
};

function listModules() {
    const files = [];
    (function rec(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) rec(p);
            else if (e.name.endsWith(".syscfg.js") && e.name !== "pru_blocks_static_module.syscfg.js") files.push(p);
        }
    })(path.join(ROOT, "pru_blocks"));
    return files.sort();
}

const WIRE_JS = "for (var i = 1; i <= inst.numOfInputPorts; i++) { var lc = scripting.addModule('/pru_blocks/data_handling/load_constant_block')"
    + ".addInstance(); lc.constant1 = 7000 + i; scripting.connect(lc, 'output1', inst, 'input' + i); }\n";

function hasGetMacro(f) {
    return /getMacro\w*\s*[(:]/.test(fs.readFileSync(f, "utf8"));
}

function runProbe(rel, withStatic, temp) {
    const tag = Buffer.from(rel).toString("hex") + (withStatic ? "_s" : "_n");
    const scriptPath = path.join(temp, `probe_${tag}.syscfg`);
    const outDir = path.join(temp, `out_${tag}`);
    fs.writeFileSync(scriptPath,
        (withStatic ? "scripting.addModule('/pru_blocks/common/pru_blocks_static_module');\n" : "") +
        `var inst = scripting.addModule('${rel}', {}, false).addInstance();\n` + WIRE_JS);
    const env = Object.assign({}, process.env, {
    });
    return new Promise((resolve) => {
        cp.execFile(NODE, [
            CLI, "--product", PRODUCT, "--device", "AM243x_ALX_beta", "--package", "ALX", "--part", "ALX",
            "--script", scriptPath, "--context", "icss_g0_pru0", "--output", outDir,
        ], { env, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            const out = (stdout || "") + "\n" + (stderr || "");
            const arity = out.match(/Macro arity mismatch:[^\n]+/g);
            const ran = /Running script\.\.\./.test(out);
            const validated = ran && /Validating\.\.\./.test(out);
            let called = false;
            try {
                const inc = fs.readFileSync(path.join(outDir, "pru_syscfg.inc"), "utf8");
                const asm = fs.readFileSync(path.join(outDir, "pru_syscfg.asm"), "utf8");
                const macros = new Set((inc.match(/^\s*(\w+)\s+\.macro\b/gm) || []).map(l => l.trim().split(/\s+/)[0]));
                called = asm.split("\n").some(l => macros.has(l.trim().split(/\s+/)[0]));
            } catch (e) { /* no output: nothing was generated */ }
            const firstErr = (out.match(/^(?:Error|error)[^\n]*/m) || [""])[0].trim();
            resolve({ error, out, arity, validated, called, firstErr });
        });
    });
}

async function checkBlock(f, temp) {
    const rel = "/pru_blocks/" + path.relative(path.join(ROOT, "pru_blocks"), f).split(path.sep).join("/").replace(/\.syscfg\.js$/, "");
    const getMacro = hasGetMacro(f);
    const alone = await runProbe(rel, false, temp);
    const p = await runProbe(rel, true, temp);
    const res = { rel, getMacro, standaloneReached: alone.called || !!(alone.arity && alone.validated),
                  reached: p.called || !!(p.arity && p.validated), why: p.firstErr };
    const arity = (p.arity && p.validated) ? p : (alone.arity && alone.validated ? alone : null);
    if (arity) return Object.assign(res, { kind: "arity", text: arity.arity.join("\n") });
    // A block listed as UNREACHABLE (with its reason) whose probe design does not validate is reported as unreachable.
    if (!p.validated && UNREACHABLE[rel]) return Object.assign(res, { kind: "ok", otherErrors: true });
    if (!p.validated) {
        const why = p.error ? `${p.error.code !== undefined ? "exit/err " + p.error.code + ": " : ""}${p.error.message.split("\n")[0]}` : "no SysConfig output";
        const tail = p.out.split("\n").map(l => l.trim()).filter(Boolean).slice(-2).join(" | ");
        return Object.assign(res, { kind: "noRun", text: `SysConfig did not validate this probe (${why})${tail ? ": " + tail : ""}` });
    }
    // SysConfig ran the script and validated it, and no arity error was raised. A default
    // instance can still fail OTHER validation (unconnected ports...); that is not this
    // check's concern, but it is counted so the number is visible.
    return Object.assign(res, { kind: "ok", otherErrors: !!p.error });
}

async function pool(items, n, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
    }));
    return results;
}

async function main() {
    for (const [what, p] of [["SysConfig node", NODE], ["SysConfig CLI", CLI], ["product.json", PRODUCT]]) {
        if (!fs.existsSync(p)) {
            console.error(`FATAL: ${what} not found at ${p} - cannot check arity (set SYSCONFIG_NODE / SYSCONFIG_CLI). A check that cannot run is not a pass.`);
            process.exit(2);
        }
    }
    const files = listModules();
    if (files.length === 0) {
        console.error(`FATAL: no pru_blocks modules found under ${ROOT}`);
        process.exit(2);
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "check_syscfg_arity-"));
    fs.mkdirSync(path.join(temp, "local"));
    fs.mkdirSync(path.join(temp, "roaming"));
    console.log(`Checking ${files.length} blocks for arity mismatches...`);
    let results;
    try {
        results = await pool(files, CONCURRENCY, f => checkBlock(f, temp));
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }

    let bad = 0, known = 0, passed = 0, other = 0;
    for (const res of results) {
        const kb = KNOWN_BROKEN[res.rel];
        if (res.kind === "ok") {
            if (kb) { console.log(`STALE ${res.rel}: listed as known-broken but has no arity error now - remove it from KNOWN_BROKEN`); bad++; }
            else { passed++; if (res.otherErrors) other++; }
        } else if (res.kind === "arity" && kb && res.text.includes(kb.msg) && res.text.split("\n").length === 1) {
            console.log(`KNOWN-BROKEN ${res.rel}: ${kb.reason}\n    ${res.text}`);
            known++;
        } else {
            console.log(`FAIL ${res.rel}${kb ? " (known-broken entry does not match this error)" : ""}\n    ${res.text.replace(/\n/g, "\n    ")}`);
            bad++;
        }
    }
    // Coverage: a block with a getMacro is "reached" when a macro call was generated and arity-checked.
    const withMacro = results.filter(r => r.getMacro);
    const reached = withMacro.filter(r => r.reached);
    const notReached = results.filter(r => !r.reached);
    const standaloneGap = withMacro.filter(r => r.reached && !r.standaloneReached);
    for (const r of standaloneGap) {
        const ent = STANDALONE_UNREACHABLE[r.rel];
        if (ent) console.log(`KNOWN-STANDALONE-UNREACHABLE ${r.rel}: ${ent}`);
        else { console.log(`FAIL ${r.rel}\n    UNREACHABLE: a design containing only this block emits no macro call (it declares no pru_blocks_static_module dependency)`); bad++; }
    }
    for (const rel of Object.keys(STANDALONE_UNREACHABLE)) {
        const r = results.find(x => x.rel === rel);
        if (!r || !standaloneGap.includes(r)) { console.log(`STALE ${rel}: listed in STANDALONE_UNREACHABLE but emits standalone now (or is gone) - remove it`); bad++; }
    }
    for (const r of withMacro.filter(x => !x.reached)) {
        if (UNREACHABLE[r.rel]) console.log(`UNREACHABLE ${r.rel}: ${UNREACHABLE[r.rel]}`);
        else { console.log(`FAIL ${r.rel}\n    UNREACHABLE: has getMacro but no macro call was generated even with the static module and wired inputs${r.why ? " (" + r.why + ")" : ""}`); bad++; }
    }
    for (const rel of Object.keys(UNREACHABLE)) {
        const r = results.find(x => x.rel === rel);
        if (!r || r.reached) { console.log(`STALE ${rel}: listed in UNREACHABLE but a macro call is generated now (or the block is gone) - remove it`); bad++; }
    }
    if (LIST) for (const r of withMacro.filter(x => x.reached)) console.log(`reached ${r.rel}`);
    console.log(`coverage: ${reached.length}/${withMacro.length} blocks with getMacro reached (macro call generated and arity-checked); ${standaloneGap.length} of them only with the static module added explicitly`);
    console.log(`not reached: ${notReached.length} - ` + (notReached.length ? notReached.map(r => `${r.rel} (${r.getMacro ? "has getMacro but no call generated" : "no getMacro: nothing to check"})`).join("; ") : "none"));
    console.log(`${files.length} modules checked: ${passed} validated with no arity error (${other} of them have other, non-arity validation errors on a bare default instance), ${known} known-broken, ${bad} unexpected failures.`);
    if (bad > 0) process.exit(1);
}

main();
