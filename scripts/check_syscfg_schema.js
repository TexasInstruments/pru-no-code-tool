#!/usr/bin/env node
/*
 * check_syscfg_schema.js - fail the build on block definitions the SysConfig GUI rejects.
 *
 *     node scripts/check_syscfg_schema.js [<.meta root>]
 *
 * The CLI build only loads the modules a design uses, and the headless
 * tests call getValue() directly, so neither runs SysConfig's configurable schema
 * check. Two defects reached the development branch that way and were found only by
 * opening the GUI (2026-10-03):
 *
 *   - queue_empty_block declared two hidden fields as name: "" -> the GUI refuses
 *     the whole product: "Duplicate configurable definition: ''".
 *   - six blocks declared registerClobbers with default: [] and no options ->
 *     "Configurable ... is of an unknown schema type", the block cannot render.
 *
 * This loads every pru_blocks module the way SysConfig does (system.getScript
 * resolved against the .meta root) and rejects:
 *   - a module that fails to load,
 *   - a config entry with no name, or a name repeated within one module,
 *   - an array/object default on a configurable with no `options` (SysConfig
 *     accepts an array only for multi-select). `$`-prefixed SysConfig built-ins
 *     such as `$size` are exempt.
 *
 * Exit 0 clean, 1 on any finding.
 */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.resolve(process.argv[2] ||
    path.join(__dirname, "..", ".metadata", "sysconfig", ".meta"));

function stub() {
    const f = function () { return stub(); };
    return new Proxy(f, {
        get(_t, p) {
            if (p === Symbol.toPrimitive || p === "toString") return () => "";
            if (p === "length") return 0;
            return stub();
        },
        apply() { return stub(); },
    });
}

const cache = {};
// SysConfig resolves getScript("/common") to common.js or common.syscfg.js.
function resolve(rel) {
    const base = path.join(ROOT, rel.replace(/^\//, ""));
    for (const f of rel.endsWith(".js") ? [base] : [base + ".js", base + ".syscfg.js"]) {
        if (fs.existsSync(f)) return f;
    }
    return null;
}

function load(rel) {
    const f = resolve(rel);
    if (!f) return { exports: stub(), error: null };   // not in this product (e.g. an SDK script)
    if (cache[f]) return cache[f];
    const mod = { exports: {} };
    const system = new Proxy({}, {
        get(_t, p) {
            if (p === "getScript") return (r) => { try { return load(r).exports; } catch (e) { return stub(); } };
            if (p === "deviceData") return { deviceId: "AM243x_ALX_beta", device: "AM243x_ALX_beta", package: "ALX" };
            if (p === "context") return "icss_g0_pru0";
            if (p === "compiler") return "ti-pru-cgt";
            if (p === "modules") return {};
            return stub();
        },
    });
    const sb = { system, exports: mod.exports, module: mod, require: () => stub(),
                 console: { log() {}, warn() {}, error() {} } };
    sb.global = sb;
    vm.createContext(sb);
    let error = null;
    try {
        vm.runInContext(fs.readFileSync(f, "utf8"), sb, { filename: f, timeout: 5000 });
    } catch (e) { error = e.message; }
    const exp = (mod.exports && Object.keys(mod.exports).length) ? mod.exports : sb.exports;
    cache[f] = { exports: exp, error };
    return cache[f];
}

function walk(list, where, seen, out) {
    if (list === undefined) return;
    if (!Array.isArray(list)) { out.push(`${where}: config is not an array`); return; }
    list.forEach((c, i) => {
        if (!c || typeof c !== "object") { out.push(`${where}[${i}]: non-object entry`); return; }
        // A group: {displayName, config: [...]} with no name of its own.
        if (Array.isArray(c.config) && c.name === undefined) {
            walk(c.config, `${where}>group(${c.displayName || "?"})`, seen, out);
            return;
        }
        const n = c.name;
        if (typeof n !== "string" || n === "") {
            out.push(`${where}[${i}]: missing name (name=${JSON.stringify(n)}, displayName=${JSON.stringify(c.displayName)})`);
        } else if (seen.has(n)) {
            out.push(`${where}[${i}]: duplicate name ${JSON.stringify(n)}`);
        }
        seen.add(n);
        const d = c.default;
        const hasOptions = Array.isArray(c.options) || typeof c.options === "function";
        if (!String(n).startsWith("$") && d !== null && typeof d === "object" && !hasOptions) {
            out.push(`${where}[${i}]: ${JSON.stringify(n)} has an ${Array.isArray(d) ? "array" : "object"} default and no options (SysConfig: unknown schema type)`);
        }
        // SysConfig 1.28 throws inside addInstance() on each of these,
        // and the GUI only says the instance could not be added.
        if (Array.isArray(c.options)) {
            const prim = c.options.filter((o) => o === null || typeof o !== "object");
            if (prim.length) {
                out.push(`${where}[${i}]: ${JSON.stringify(n)} has primitive options ${JSON.stringify(prim.slice(0, 3))} (SysConfig wants {name: ...} objects)`);
            } else if (d !== undefined && !Array.isArray(d) && !c.options.some((o) => o.name === d)) {
                out.push(`${where}[${i}]: ${JSON.stringify(n)} default ${JSON.stringify(d)} is not one of its option names`);
            }
        }
        for (const k of ["min", "max"]) {
            if (k in c) out.push(`${where}[${i}]: ${JSON.stringify(n)} uses unsupported field ${JSON.stringify(k)} (range-check in validate() instead)`);
        }
        if (Array.isArray(c.config)) walk(c.config, `${where}>${n}`, seen, out);
    });
}

const files = [];
(function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else if (e.name.endsWith(".syscfg.js")) files.push(p);
    }
})(path.join(ROOT, "pru_blocks"));

let bad = 0;
for (const f of files.sort()) {
    const rel = "/" + path.relative(ROOT, f).split(path.sep).join("/").replace(/\.js$/, "");
    const { exports: m, error } = load(rel);
    const out = [];
    if (error) out.push(`does not load: ${error}`);
    if (m) {
        walk(m.config, "config", new Set(), out);
        if (m.moduleStatic) walk(m.moduleStatic.config, "moduleStatic.config", new Set(), out);
    }
    if (out.length) {
        bad++;
        console.log(`FAIL ${rel}`);
        out.forEach((s) => console.log(`     ${s}`));
    }
}
console.log(`${files.length} modules checked, ${bad} rejected`);
if (files.length === 0) { console.log("no modules found - refusing to pass"); process.exit(1); }
process.exit(bad ? 1 : 0);
