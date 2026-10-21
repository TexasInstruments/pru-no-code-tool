/**
 * The "Run on TI pru-simulator" button, GUI side.
 *
 * The GUI can only execute JavaScript, and its JS simulator is only a
 * preview. This script is the glue that lets the Simulation Settings panel
 * LAUNCH the real chain (scripts/sim/gui_run_launcher.js -> gui_run.py: generate,
 * clpru build, scripts/sim/run_bound_devices.py) and SHOW what it returned.
 * It decides nothing: the verdict is the exit code of run_bound_devices.py,
 * carried through the wrapper's JSON. Everything here is pure so it can be run
 * under node (scripts/sim/test_ti_run_gui.js) - SysConfig cannot be.
 *
 * Fail-closed rules, all enforced in parseResult/describe:
 *   - unreadable, missing or unknown verdict      -> NOT CHECKED
 *   - PASS without exitCode 0                     -> NOT CHECKED
 *   - a result for a different design than shown  -> STALE, never a verdict
 */

const VERDICTS = ["PASS", "FAIL", "REFUSED", "NOT CHECKED"];
const DEFAULT_LIVE_PORT = 8765;

// Written to $comFile before the wrapper starts. If the wrapper never runs or
// dies without writing, onComplete reads this back - which must not look like a
// pass.
const INITIAL_DATA = JSON.stringify({
    schema: 1,
    verdict: "NOT CHECKED",
    exitCode: null,
    reason: "the TI pru-simulator wrapper did not write a result"
});

function fnv1a(text, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

function snapshot(obj) {
    const out = {};
    for (const key of Object.keys(obj).sort()) {
        // $position and friends are layout, not design. tiRun* is this
        // feature's own result state; including it would make every run stale.
        if ((key.charAt(0) === "$" && key !== "$name") || key.indexOf("tiRun") === 0) {
            continue;
        }
        const value = obj[key];
        if (typeof value === "function" || value === undefined) {
            continue;
        }
        // Load Constant's outputWidth at its default "auto" is not part of the digest, so a design that does
        // not use the option keeps the digest (and the pru_syscfg.asm header) it had before the option existed.
        if (key === "outputWidth" && value === "auto") {
            continue;
        }
        out[key] = value;
    }
    return out;
}

/**
 * A digest of the design as the GUI holds it: every module's static config and
 * every instance's config, minus layout. The CLI embeds the same digest in the
 * generated pru_syscfg.asm, so the wrapper can tell whether the design on disk
 * (which it regenerates and builds) is the design the user is looking at.
 */
function executionContext(env) {
    // system.context is the SysConfig context name (icss_g0_pru0 / icss_g0_pru1);
    // system.getScript() is NOT a "current script" accessor, it takes a module path.
    const data = (env && env.deviceData) || {};
    return {
        context: (env && env.context) || "",
        core: (data.core && data.core.name) || "",
        device: data.device || "",
        part: data.part || "",
        package: data.package || ""
    };
}

function designDigest(modules, env) {
    const record = [];
    for (const name of Object.keys(modules || {}).sort()) {
        const mod = modules[name];
        if (!mod) {
            continue;
        }
        const entry = { module: name };
        if (mod.$static) {
            entry.static = snapshot(mod.$static);
        }
        const instances = (mod.$instances || []).map(snapshot);
        instances.sort(function (a, b) { return a.$name < b.$name ? -1 : a.$name > b.$name ? 1 : 0; });
        if (instances.length) {
            entry.instances = instances;
        }
        if (entry.static || entry.instances) {
            record.push(entry);
        }
    }
    // Do not digest makefiles/imports/block sources: the GUI cannot snapshot
    // those files, and pretending it can would reject every click.  They remain
    // governed by the per-project lock and the generator/build exit guards.
    const text = JSON.stringify({ design: record, execution: executionContext(env) });
    return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x9747b28c);
}

function dirName(p) {
    return String(p).replace(/[\\/][^\\/]*$/, "");
}

/**
 * What onLaunch returns. `env` is the SysConfig `system` object (or a stub).
 *
 * Project: the open .syscfg (system.getCurrentScriptPath(), which SysConfig
 * only exposes while a launcher is being built), else the "TI run project"
 * config field. Repo root: the PRU_NO_CODE_TOOL product's product.json sits in
 * <root>/.metadata, else the "TI run repo root" field. The interpreter is
 * resolved by the launcher, not here: the GUI process's PATH is not a shell's.
 */
function launchSpec(env, settings, digest) {
    settings = settings || {};
    let repoRoot = settings.tiRunRepoRoot || "";
    if (!repoRoot) {
        try {
            for (const product of env.getProducts()) {
                if (product && product.name === "PRU_NO_CODE_TOOL" && product.path) {
                    repoRoot = dirName(dirName(product.path));
                }
            }
        } catch (e) { /* path not visible: fall through to the explicit field */ }
    }
    let project = "";
    try {
        // The open file is authoritative.  A copied .syscfg must not inherit a
        // stale tiRunProject path from its source design.
        project = env.getCurrentScriptPath() || "";
    } catch (e) { /* fall through to explicit setting */ }
    if (!project) {
        try {
            project = settings.tiRunProject || "";
        } catch (e) { /* leave empty */ }
    }
    const sep = repoRoot.indexOf("\\") !== -1 ? "\\" : "/";
    const args = [
        repoRoot + sep + "scripts" + sep + "sim" + sep + "gui_run_launcher.js",
        "--com", "$comFile",
        "--digest", digest,
        "--repo", repoRoot,
        "--project", project
    ];
    // TiRunLiveView / tiRunLivePort are tiRun* so the digest ignores
    // them; they only add arguments, they never change what is judged.
    // The port goes along even when the box is unticked, so a run that
    // did not ask for a view can still say a different design's view is serving there.
    const port = Number(settings.tiRunLivePort);
    const livePort = String(Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_LIVE_PORT);
    if (settings.tiRunLiveView === true) {
        args.push("--live");
    }
    args.push("--live-port", livePort);
    return {
        command: env.getNodePath(),
        args: args,
        initialData: INITIAL_DATA,
        inSystemPath: true
    };
}

function notChecked(reason) {
    return { schema: 1, verdict: "NOT CHECKED", exitCode: null, reason: reason, devices: [] };
}

/** Parse $comFile content. Never throws, never upgrades a bad input to PASS. */
function parseResult(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return notChecked("the wrapper result was not valid JSON");
    }
    if (!data || typeof data !== "object" || VERDICTS.indexOf(data.verdict) === -1) {
        return notChecked("the wrapper result carried no recognised verdict");
    }
    if (data.verdict === "PASS" && data.exitCode !== 0) {
        return notChecked("a PASS verdict without run_bound_devices.py exit code 0 is not accepted");
    }
    if (data.verdict !== "PASS" && data.exitCode === 0) {
        return notChecked("exit code 0 with verdict " + data.verdict + " is inconsistent");
    }
    if (!Array.isArray(data.devices)) {
        data.devices = [];
    }
    return data;
}

/**
 * One panel line for the optional live web view. Display only - it is
 * never read by the verdict logic, and anything malformed is simply not shown.
 */
function oneLine(text) {
    // Newlines and other control characters would add fake lines (e.g. a
    // "verdict: PASS") to the panel; fold them to single spaces.
    return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

function liveViewLine(live) {
    if (!live || typeof live !== "object" || Array.isArray(live)) {
        return null;
    }
    if (live.status === "started" && typeof live.url === "string" && oneLine(live.url)) {
        return "Live web view: " + oneLine(live.url) + " (opened in your browser" +
               (Number.isInteger(live.pid) ? "; pid " + live.pid : "") + ")";
    }
    if (live.status === "other design") {
        const why = typeof live.reason === "string" && oneLine(live.reason) ? oneLine(live.reason) : "no reason recorded";
        return "Live web view: " + why;
    }
    if (live.status === "not started" || live.status === "failed") {
        const why = typeof live.reason === "string" && oneLine(live.reason) ? oneLine(live.reason) : "no reason recorded";
        return "Live web view: " + live.status + " - " + why +
               (live.status === "failed" && typeof live.log === "string" && oneLine(live.log) ? " (log: " + oneLine(live.log) + ")" : "");
    }
    return null;
}

/**
 * The text the panel shows. `fresh` is false when the result was produced for
 * a different design than the one now on screen; then it is shown as STALE and
 * `verdict` is null so no caller can treat it as current.
 */
function describe(result, currentDigest) {
    if (!result) {
        return { fresh: false, verdict: null, text: "" };
    }
    const fresh = !!result.designDigest && result.designDigest === currentDigest;
    const lines = [];
    if (!fresh) {
        lines.push("STALE - this TI pru-simulator run was for an earlier design (was " +
                   result.verdict + "); run it again");
    } else {
        lines.push("TI pru-simulator verdict: " + result.verdict +
                   (result.verdict === "NOT CHECKED" ? " (not a pass)" : ""));
    }
    if (result.reason) {
        lines.push("Reason: " + result.reason);
    }
    for (const device of result.devices || []) {
        const where = device.pin === undefined ? "" : " on GPI" + device.pin;
        if (device.expected !== undefined && device.decoded !== undefined) {
            lines.push(device.kind + where + ": expected " + device.expected +
                       ", firmware decoded " + device.decoded);
        } else {
            lines.push(device.kind + where + ": " + (device.note || "no decoded value"));
        }
    }
    if (result.cycles !== undefined && result.cycles !== null) {
        lines.push("Cycles run: " + result.cycles);
    }
    if (result.vcd) {
        lines.push("VCD: " + result.vcd);
    }
    const live = fresh ? liveViewLine(result.liveView) : null;
    if (live) {
        lines.push(live);
    }
    return { fresh: fresh, verdict: fresh ? result.verdict : null, text: lines.join("\n") };
}

/**
 * The line that replaces the "GUI JS preview only" banner once a real verdict
 * for THIS design exists. Null when there is none, so the preview banner stays.
 */
function bannerLine(result, currentDigest) {
    const d = describe(result, currentDigest);
    if (!d.fresh) {
        return null;
    }
    return d.text.split("\n")[0] + (result.reason ? " - " + result.reason : "");
}

const api = { VERDICTS, DEFAULT_LIVE_PORT, liveViewLine, INITIAL_DATA, designDigest, executionContext, launchSpec, parseResult, describe, bannerLine };
if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
} else {
    exports = api;
}
