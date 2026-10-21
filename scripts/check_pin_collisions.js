#!/usr/bin/env node
/*
 * check_pin_collisions.js - Verify that a design does not drive/read the same PRU pin twice.
 *
 * Usage: node check_pin_collisions.js [file.syscfg | dir]   (default: examples/)
 * Env:   PRU_SYSCONFIG_ROOT  directory holding sysconfig_*  (default <SystemDrive>/ti)
 * Flags: --baseline FILE  known-findings list;  --emit-baseline  print current findings as JSON;
 *        --defaults-report  JSON of the claims every getPinUsage block yields at config defaults
 *        (no device data needed; backs the behavioural guard test)
 *
 * Reports, per .syscfg file:
 *   - a GPO and a GPI claim on the same index when the device pad is shared between
 *     them (derived from the installed SysConfig device data, not a hand table).
 *     A two-way pad is exempt in exactly two cases, both needing bidi:true on both entries:
 *     (a) the same instance (a block's own open-drain pair: i2c SDA, 1-wire data);
 *     (b) different instances of the SAME block module that classify SEQUENTIAL (one bus pin,
 *         transactions one after another, e.g. four 1-wire transfers on one data pin).
 *     A two-way pad shared by DIFFERENT block modules (onewire + i2c) always fails; a continuous block never shares; anything unknown is a different protocol;
 *   - two different blocks driving the same GPO index when at least one of them is continuous
 *     (never returns control; derived by block_control_flow.js, fail-closed). Sequential
 *     blocks may share a pin;
 *   - malformed pin usage (including non-array results), unparseable pins, and blocks whose getPinUsage throws.
 *
 * Pins come from each block's moduleStatic.getPinUsage(inst); a block that touches
 * R30/R31 should declare getPinUsage (--defaults-report lists what each block claims).
 *
 * Exit codes: 0 = every file evaluated and clean; 1 = a collision/error was found;
 * 2 = cannot run (SysConfig device data missing) - this script never exits 0
 * without having checked anything.
 *
 * Pad sharing is read from the design's own device (@cliArgs --device) and PRU core (--context), e.g.
 * AM243x -> PRG0_PRU0_GPO/GPI pairs, AM261x -> PR0_PRU0_GPIO (one two-way signal). A design whose device or
 * core cannot be resolved is a FAILURE ("could not evaluate"), never judged with another device's pads.
 * SCOPE LIMITS (not modelled): RTU/TX slices are judged on the PRU pad list of the same slice number (the
 * device data has no RTU/TX pad signals), an index with no pad on the device is not flagged, and pins are
 * pooled per FILE, not per core.
 * That is correct for per-core example.syscfg files; it is NOT a cross-core check.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classify, classifyInstance } = require('./block_control_flow');

const ROOT = path.join(__dirname, '..');
const EXAMPLES_DIR = path.join(ROOT, 'examples');
// Tests (and downstream integrations) may point this at a product scratch copy to
// check the exact block sources being evaluated.  Designs stay rooted at ROOT.
const METADATA_ROOT = process.env.PRU_NOCODE_METADATA_ROOT || path.join(ROOT, '.metadata');

function findDeviceDataRoot() {
    const parent = process.env.PRU_SYSCONFIG_ROOT || ((process.env.SystemDrive || "C:") + "/ti");
    if (!fs.existsSync(parent)) return null;
    let highest = null;
    for (const d of fs.readdirSync(parent)) {
        if (!d.startsWith('sysconfig_')) continue;
        const p = path.join(parent, d, 'dist', 'deviceData');
        if (fs.existsSync(p) && (!highest || d > highest.dir)) highest = { dir: d, path: p };
    }
    return highest ? highest.path : null;
}

// A design states its device and PRU core in its header: @cliArgs --device "AM261x_ZFG" ... --context "icss_m0_pru0"
// (the v2 line, @v2CliArgs, uses marketing device names that have no deviceData directory).
function parseDesignTarget(source) {
    const m = /@cliArgs(.*)/.exec(source);
    if (!m) return { device: null, context: null };
    const dev = /--device\s+"([^"]+)"/.exec(m[1]);
    const ctx = /--context\s+"([^"]+)"/.exec(m[1]);
    return { device: dev ? dev[1] : null, context: ctx ? ctx[1] : null };
}

// SysConfig context -> pad signal prefix. ICSSG (AM64x/AM243x) contexts icss_g<N>_[rtu_|tx_]pru<K> use PRG<N>_PRU<K>;
// ICSSM (AM261x/AM263x) contexts icss_m<N>_pru<K> use PR<N>_PRU<K>. The RTU and TX slices have no pad signals of
// their own in the device data, so they are judged against the PRU core of the same slice number.
function corePrefix(context) {
    const m = /^icss_([gm])(\d)(?:_(?:rtu|tx))?_pru(\d)$/.exec(context || '');
    return m ? `${m[1] === 'g' ? 'PRG' : 'PR'}${m[2]}_PRU${m[3]}` : null;
}

const deviceCache = new Map();
function loadDeviceData(deviceRoot, device) {
    if (deviceCache.has(device)) return deviceCache.get(device);
    const f = path.join(deviceRoot, device, device + '.json');
    const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    deviceCache.set(device, data);
    return data;
}

// Indices n for which GPO n and GPI n of the core land on one pad. Two encodings exist in the device data:
// ICSSG pads carry separate PRGx_PRUy_GPOn and PRGx_PRUy_GPIn signals; ICSSM pads carry one PRx_PRUy_GPIOn
// signal (inherently two-way). Returns null when the device has no pad for the core at all.
function getPadSharing(deviceData, prefix) {
    const infos = deviceData.pinCommonInfos || {};
    const shared = new Set();
    let anyPad = false;
    for (const info of Object.values(infos)) {
        if (!info || !info.pinModeInfo) continue;
        const sigs = new Set(info.pinModeInfo.map(m => m.signalName));
        for (let i = 0; i < 20; i++) {
            const gpo = `${prefix}_GPO${i}`, gpi = `${prefix}_GPI${i}`, gpio = `${prefix}_GPIO${i}`;
            if (sigs.has(gpo) || sigs.has(gpi) || sigs.has(gpio)) anyPad = true;
            if ((sigs.has(gpo) && sigs.has(gpi)) || sigs.has(gpio)) shared.add(i);
        }
    }
    return anyPad ? shared : null;
}

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

const problems = [];   // load/getPinUsage failures: reported and counted as failures
// The design as the static module's collectGpiDeviceClaims sees it (system.modules), and the
// Simulation Settings module's own export + the settings the .syscfg assigned to it.
let designModules = {};
let staticState = null;

function loadSyscfg(f, source) {
    let instances = [];
    problems.length = 0;
    designModules = {};
    staticState = null;
    const handles = {};
    const scripting = {
        addModule: (name) => {
            if (handles[name]) return handles[name];
            const modulePath = path.join(METADATA_ROOT, 'sysconfig', '.meta', name + '.syscfg.js');
            let moduleStatic = {};
            let configDefaults = {};
            const isStatic = name === '/pru_blocks/common/pru_blocks_static_module';
            let moduleExports = null;

            if (fs.existsSync(modulePath)) {
                try {
                    const content = fs.readFileSync(modulePath, 'utf8');
                    const sb = {
                        system: new Proxy({}, {
                            get(_t, p) {
                                if (p === "getScript") return () => stub();
                                if (p === "deviceData") return { deviceId: "AM243x_ALX_beta", device: "AM243x_ALX_beta", package: "ALX" };
                                if (p === "context") return "icss_g0_pru0";
                                if (p === "compiler") return "ti-pru-cgt";
                                if (p === "modules") return isStatic ? designModules : {};
                                return stub();
                            }
                        }),
                        exports: {},
                        module: { exports: {} },
                        require: () => stub(),
                        console: { log() {}, warn() {}, error() {} }
                    };
                    sb.global = sb;
                    vm.createContext(sb);
                    vm.runInContext(content, sb);
                    const exp = (sb.module.exports && Object.keys(sb.module.exports).length) ? sb.module.exports : sb.exports;
                    if (exp && exp.moduleStatic) {
                        moduleStatic = exp.moduleStatic;
                    }
                    moduleExports = exp;
                    // Properties a .syscfg leaves unset take the block's config default (as in SysConfig).
                    if (exp && Array.isArray(exp.config)) {
                        for (const c of exp.config) {
                            if (c && c.name && c.default !== undefined && typeof c.getValue !== 'function') {
                                configDefaults[c.name] = c.default;
                            }
                        }
                    }
                } catch (e) {
                    problems.push(`block module ${name} failed to load: ${e && e.message}`);
                }
            }

            const handle = {
                addInstance: () => {
                    const inst = Object.assign({ $module: { $name: name, moduleStatic: moduleStatic } }, configDefaults);
                    instances.push(inst);
                    (designModules[name] = designModules[name] || { $instances: [] }).$instances.push(inst);

                    return new Proxy(inst, {
                        get(target, prop) {
                            if (prop in target) return target[prop];
                            target[prop] = stub();
                            return target[prop];
                        },
                        set(target, prop, value) {
                            target[prop] = value;
                            return true;
                        }
                    });
                }
            };
            handles[name] = handle;
            if (isStatic) staticState = { exp: moduleExports, handle };
            return handle;
        },
        connect: () => {}
    };
    const context = { scripting, system: { modules: {} }, console: { log: ()=>{}, warn: ()=>{} } };
    vm.createContext(context);
    try {
        vm.runInContext(source !== undefined ? source : fs.readFileSync(f, 'utf8'), context);
    } catch (e) {
        console.error("Error evaluating", f, ":", e && e.message);
        return null;
    }
    return instances;
}

function extractClaims(insts) {
    const claims = [];
    insts.forEach((inst, idx) => {
        const moduleStatic = inst.$module.moduleStatic;
        const name = inst.$module.$name;
        if (!moduleStatic || typeof moduleStatic.getPinUsage !== 'function') return;
        let pins = [];
        try {
            pins = moduleStatic.getPinUsage(inst);
        } catch (e) {
            problems.push(`${name}.getPinUsage threw: ${e && e.message}`);
            return;
        }
        if (!Array.isArray(pins)) {
            problems.push(`${name}.getPinUsage returned a non-array`);
            return;
        }
        for (const p of pins) {
            if (!p || (p.dir !== "GPO" && p.dir !== "GPI")) {
                problems.push(`${name}: getPinUsage returned an entry without a GPO/GPI dir`);
                continue;
            }
            const pin = parseInt(p.pin);
            if (isNaN(pin)) {
                problems.push(`${name}: unparseable ${p.dir} pin "${String(p.pin)}"`);
                continue;
            }
            claims.push({ inst: idx, block: name.split('/').pop(), iname: typeof inst.$name === 'string' ? inst.$name : `#${idx}`, dir: p.dir, pin, bidi: p.bidi === true, cfg: inst });
        }
    });
    return claims;
}

// A GPO that feeds an attached device's input may be driven only by that device's reader. The
// verdict is deviceModelTable.findDeviceInputConflicts - the same function the GUI validator calls -
// fed from the same two sources: Device Model block instances and the Simulation Settings GPI device
// fields (read through the static module's own collectGpiDeviceClaims, so the effective companion pins agree).
function deviceInputConflicts(gpoBits) {
    const table = require(path.join(METADATA_ROOT, 'sysconfig', '.meta', 'pru_blocks', 'common', 'device_model_table.js'));
    const devices = [];
    const dm = designModules['/pru_blocks/utils/device_model_block'];
    for (const raw of (dm && dm.$instances) || []) {
        if (!table.KINDS[raw.deviceKind]) continue;
        const mi = table.withDefaults(raw);
        const b = table.toBinding(mi);
        devices.push({
            name: mi.$name, source: 'Device Model block', kind: mi.deviceKind,
            matched: table.matchedDrivers(mi.deviceKind, b, designModules),
            listens: table.listenedPins(mi.deviceKind, b)
        });
    }
    if (staticState && staticState.exp && typeof staticState.exp.collectGpiDeviceClaims === 'function') {
        const settings = {};
        const cfg = staticState.exp.moduleStatic && staticState.exp.moduleStatic.config;
        for (const c of Array.isArray(cfg) ? cfg : []) {
            if (c && c.name && c.default !== undefined && typeof c.getValue !== 'function') settings[c.name] = c.default;
        }
        for (const k of Object.keys(staticState.handle)) {
            if (typeof staticState.handle[k] !== 'function') settings[k] = staticState.handle[k];
        }
        const slotOfLabel = { 'primary pin': 'primaryPin', 'Clock/B pin': 'clockPin', 'Index/Z pin': 'indexPin' };
        for (const claim of staticState.exp.collectGpiDeviceClaims(settings)) {
            const b = { params: table.paramsOf(settings[`gpi${claim.pinNum}_deviceParams`]) };
            for (const p of claim.pins) b[slotOfLabel[p.label]] = p.pin;
            devices.push({
                name: `GPI${claim.pinNum} device`, source: 'Simulation Settings GPI device', kind: claim.kind,
                matched: table.matchedDrivers(claim.kind, b, designModules),
                listens: table.listenedPins(claim.kind, b)
            });
        }
    }
    return table.findDeviceInputConflicts(devices, gpoBits);
}

function checkSyscfg(file, deviceRoot) {
    const source = fs.readFileSync(file, 'utf8');
    const insts = loadSyscfg(file, source);
    const result = { evaluated: false, errors: [], warnings: [] };
    if (insts === null) {
        result.errors.push('syscfg failed to evaluate');
        return result;
    }
    result.evaluated = true;
    const hasPru = insts.some(i => i.$module.$name.includes('pru_blocks'));
    if (!hasPru) return result;

    const claims = extractClaims(insts);
    for (const pr of problems) result.errors.push(pr);

    const gpoBits = claims.filter(c => c.dir === "GPO");
    const gpiBits = claims.filter(c => c.dir === "GPI");

    // Pad sharing comes from the design's OWN device and core, never from a default device. A design whose
    // device or core cannot be resolved is reported (a failure), not judged against another part's pads.
    let sharedIndices = new Set();
    let unresolvable = false;
    if (gpoBits.length && gpiBits.length) {
        const t = parseDesignTarget(source);
        const prefix = corePrefix(t.context);
        const data = t.device ? loadDeviceData(deviceRoot, t.device) : null;
        const why = !t.device ? 'no @cliArgs --device in the header'
            : !data ? `no SysConfig device data for "${t.device}"`
            : !prefix ? `unrecognised --context "${t.context}"` : null;
        const idx = why ? null : getPadSharing(data, prefix);
        if (why || !idx) {
            result.errors.push(`could not evaluate on device ${t.device || '?'} core ${t.context || '?'}: ` +
                (why || `device data has no ${prefix} GPO/GPI pads`) + ' (GPO/GPI pad sharing NOT checked)');
            unresolvable = true;
        } else {
            sharedIndices = idx;
            result.judgedOn = `${t.device}/${prefix}`;
        }
    }
    const overlaps = new Set();
    const detail = [];
    if (!unresolvable) {
        for (const o of gpoBits) {
            for (const i of gpiBits) {
                if (o.pin !== i.pin || !sharedIndices.has(o.pin)) continue;
                if (o.inst === i.inst && o.bidi && i.bidi) continue; // a block's own open-drain pair
                // One open-drain bus pin used by several instances of ONE protocol that run one after
                // another (four 1-wire transactions on one data pin): both entries bidi, same block
                // module, and that module SEQUENTIAL. Same module => same verdict, so one classify
                // call covers both. Different modules (onewire + i2c) are different protocols: fail.
                if (o.inst !== i.inst && o.bidi && i.bidi && o.block === i.block &&
                    classify(o.block).cls === 'sequential') continue;
                overlaps.add(o.pin);
                detail.push(`${o.block}.GPO vs ${i.block}.GPI on ${o.pin}`);
            }
        }
    }
    // Two different blocks on one GPO index collide only when at least one of them is CONTINUOUS
    // (never hands control to the next block, e.g. PWM). Blocks that run one after another may
    // share an output pin. The verdict comes from scripts/block_control_flow.js and fails closed:
    // a block it cannot positively show to return control counts as continuous.
    const dups = new Set();
    for (let x = 0; x < gpoBits.length; x++) {
        for (let y = x + 1; y < gpoBits.length; y++) {
            if (gpoBits[x].pin === gpoBits[y].pin && gpoBits[x].inst !== gpoBits[y].inst) {
                // Classified per instance, so a block with a bound config set (a counted PWM) is sequential.
                const cont = [gpoBits[x], gpoBits[y]]
                    .filter((c) => classifyInstance(c.block, c.cfg).cls === 'continuous')
                    .map((c) => c.block)
                    .filter((b, k, a) => a.indexOf(b) === k);
                if (!cont.length) continue;
                dups.add(gpoBits[x].pin);
                detail.push(`${gpoBits[x].block} "${gpoBits[x].iname}" and ${gpoBits[y].block} "${gpoBits[y].iname}" both drive GPO ${gpoBits[x].pin} (continuous: ${cont.join(', ')})`);
            }
        }
    }
    // Drivers of a pad an attached device listens on (not exempted by SEQUENTIAL hand-off).
    for (const c of deviceInputConflicts(gpoBits)) {
        if (c.severity === 'warning') result.warnings.push(`device input warning: ${c.message}`);
        else result.errors.push(`device input driven by a foreign block: ${c.message}`);
    }
    if (overlaps.size) result.errors.push(`has colliding GPO/GPI indices: ${[...overlaps].join(', ')}`);
    if (dups.size) result.errors.push(`has duplicate GPO drivers on indices: ${[...dups].join(', ')}`);
    for (const d of detail) result.errors.push(`    ${d}`);
    return result;
}

function getSyscfgFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getSyscfgFiles(fullPath));
        } else if (file.endsWith('.syscfg') && !path.relative(ROOT, fullPath).includes('mcuplus')) {
            results.push(fullPath);
        }
    }
    return results;
}

function relPath(file) {
    return path.relative(ROOT, file).split(path.sep).join('/');
}

// --defaults-report: instantiate every block that declares getPinUsage at its config defaults
// (exactly as the loader does for a .syscfg that sets nothing) and print the claims as JSON.
// Needs no SysConfig device data.
function defaultsReport() {
    const blocksRoot = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');
    const report = {};
    // Blocks whose loaded moduleStatic.getPinUsage is a function - not a text match, so a comment
    // that mentions the name cannot enrol a non-block. A candidate that fails to load is
    // reported with problems, so it fails the guard instead of vanishing.
    const { blocks, errors } = require('./pin_usage_blocks').pinUsageBlocks(blocksRoot);
    for (const e of errors) report[e.rel] = { claims: null, problems: [`failed to load: ${e.error}`] };
    for (const { rel } of blocks) {
        const mod = '/pru_blocks/' + rel.replace('.syscfg.js', '');
        const insts = loadSyscfg(null, `scripting.addModule("${mod}").addInstance();`);
        const claims = insts ? extractClaims(insts).map(c => ({ dir: c.dir, pin: c.pin, bidi: c.bidi })) : null;
        report[rel] = { claims, problems: problems.slice() };
    }
    console.log(JSON.stringify(report));
}

function run() {
    if (process.argv.includes('--defaults-report')) { defaultsReport(); process.exit(0); }
    const deviceRoot = findDeviceDataRoot();
    if (!deviceRoot) {
        console.error("ERROR: SysConfig deviceData directory not found under " +
            (process.env.PRU_SYSCONFIG_ROOT || ((process.env.SystemDrive || "C:") + "/ti")) + " - cannot check pin collisions (nothing was checked)");
        process.exit(2);
    }
    console.log(`Using SysConfig device data: ${deviceRoot} (per design device/core)`);

    let syscfgFiles = [];
    const args = process.argv.slice(2);
    const baselineIdx = args.indexOf('--baseline');
    const baseline = baselineIdx >= 0 ? JSON.parse(fs.readFileSync(args.splice(baselineIdx, 2)[1], 'utf8')) : null;
    const emitIdx = args.indexOf('--emit-baseline');
    const emit = emitIdx >= 0;
    if (emit) args.splice(emitIdx, 1);
    const target = args[0];
    if (target) {
        if (fs.statSync(target).isDirectory()) {
            syscfgFiles = getSyscfgFiles(target);
        } else {
            syscfgFiles = [target];
        }
    } else {
        syscfgFiles = getSyscfgFiles(EXAMPLES_DIR);
    }

    // A baseline lists files with KNOWN findings (path -> {reason, errors}). A known file does
    // not fail the run while its findings are exactly as recorded; any change to them, or an
    // entry that no longer fails (stale), is a failure so the list cannot silently rot.
    let failed = 0, known = 0, evaluated = 0;
    const seen = new Set();
    const found = {};
    const judged = {};   // device/core pad lists used -> files with GPO+GPI claims judged on them
    for (const file of syscfgFiles) {
        const rel = relPath(file);
        const r = checkSyscfg(file, deviceRoot);
        for (const w of r.warnings) console.log(`WARNING: ${rel}: ${w}`);
        if (r.judgedOn) judged[r.judgedOn] = (judged[r.judgedOn] || 0) + 1;
        if (r.evaluated) evaluated++;
        if (r.errors.length === 0) continue;
        found[rel] = { reason: "TODO", errors: r.errors };
        const entry = baseline && baseline[rel];
        if (entry) {
            seen.add(rel);
            if (JSON.stringify(entry.errors) === JSON.stringify(r.errors)) { known++; continue; }
            console.error(`FAIL: ${rel}: findings differ from the baseline entry`);
        }
        for (const e of r.errors) console.error(e.startsWith('    ') ? e : `FAIL: ${rel}: ${e}`);
        failed++;
    }
    if (baseline) {
        for (const rel of Object.keys(baseline)) {
            if (!seen.has(rel) && syscfgFiles.some(f => relPath(f) === rel)) {
                console.error(`FAIL: ${rel}: stale baseline entry (file no longer has findings)`);
                failed++;
            }
        }
    }
    if (emit) console.log("BASELINE-JSON " + JSON.stringify(found));

    console.log(`JUDGED ON (files with GPO+GPI claims, by device/core pad data): ${JSON.stringify(judged)}`);
    console.log(`EVALUATED: ${evaluated} of ${syscfgFiles.length} files (${known} with known baselined findings; files that do not evaluate are not checked)`);
    if (syscfgFiles.length === 0) {
        console.error("ERROR: no .syscfg files found to check");
        process.exit(2);
    }
    if (failed > 0) {
        console.error(`${failed} files failed pin collision check.`);
        process.exit(1);
    } else {
        console.log("All files passed pin collision check.");
        process.exit(0);
    }
}

run();
