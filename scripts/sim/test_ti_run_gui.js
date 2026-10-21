/**
 * The GUI half of "Run on TI pru-simulator", as pure functions.
 *
 * SysConfig's GUI cannot be driven headless, so what is proven here is the
 * renderer and launcher glue: what onComplete shows for each wrapper result,
 * and that nothing unproven is ever shown as a pass. What is NOT proven here
 * (needs a click-through): that the button renders, that onLaunch is given a
 * visible system.getCurrentScriptPath()/getProducts() path in the real GUI,
 * and that the GUI-side design digest equals the CLI-side one.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const ti = require(path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                             'pru_blocks', 'common', 'pru_ti_run.js'));
const launcher = require('./gui_run_launcher.js');

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ' + name); }
    catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

const pass = { schema: 1, verdict: 'PASS', exitCode: 0, designDigest: 'AAAA', cycles: 1311,
               vcd: '/x/ti_run.vcd', devices: [{ kind: 'ssi', pin: 1, expected: 4321, decoded: 4321 }] };

test('PASS for the current design shows expected vs decoded, cycles and VCD', () => {
    const d = ti.describe(ti.parseResult(JSON.stringify(pass)), 'AAAA');
    assert.strictEqual(d.verdict, 'PASS');
    assert.ok(d.text.includes('TI pru-simulator verdict: PASS'));
    assert.ok(d.text.includes('ssi on GPI1: expected 4321, firmware decoded 4321'));
    assert.ok(d.text.includes('Cycles run: 1311'));
    assert.ok(d.text.includes('VCD: /x/ti_run.vcd'));
});

test('FAIL shows the mismatch and is not a pass', () => {
    const r = { ...pass, verdict: 'FAIL', exitCode: 1,
                devices: [{ kind: 'ssi', pin: 1, expected: 4321, decoded: 6289 }] };
    const d = ti.describe(ti.parseResult(JSON.stringify(r)), 'AAAA');
    assert.strictEqual(d.verdict, 'FAIL');
    assert.ok(d.text.includes('expected 4321, firmware decoded 6289'));
});

test('NOT CHECKED is labelled "not a pass"', () => {
    const r = { ...pass, verdict: 'NOT CHECKED', exitCode: 3, devices: [] };
    const d = ti.describe(ti.parseResult(JSON.stringify(r)), 'AAAA');
    assert.ok(d.text.includes('NOT CHECKED (not a pass)'));
    assert.notStrictEqual(d.verdict, 'PASS');
});

test('a result for an earlier design is STALE and yields no verdict', () => {
    const d = ti.describe(ti.parseResult(JSON.stringify(pass)), 'BBBB');
    assert.strictEqual(d.verdict, null);
    assert.ok(d.text.startsWith('STALE'));
    assert.strictEqual(ti.bannerLine(ti.parseResult(JSON.stringify(pass)), 'BBBB'), null);
});

test('a result without a digest is never fresh', () => {
    const r = { ...pass }; delete r.designDigest;
    assert.strictEqual(ti.describe(r, undefined).fresh, false);
});

test('fresh result replaces the preview banner; none keeps it', () => {
    assert.strictEqual(ti.bannerLine(ti.parseResult(JSON.stringify(pass)), 'AAAA'),
                       'TI pru-simulator verdict: PASS');
    assert.strictEqual(ti.bannerLine(null, 'AAAA'), null);
});

test('PASS without exit code 0 is downgraded to NOT CHECKED', () => {
    for (const exitCode of [null, 1, 3, undefined]) {
        const r = ti.parseResult(JSON.stringify({ ...pass, exitCode }));
        assert.strictEqual(r.verdict, 'NOT CHECKED', 'exitCode ' + exitCode);
    }
});

test('exit code 0 with a non-PASS verdict is rejected as inconsistent', () => {
    const r = ti.parseResult(JSON.stringify({ ...pass, verdict: 'FAIL', exitCode: 0 }));
    assert.strictEqual(r.verdict, 'NOT CHECKED');
    assert.ok(/inconsistent/.test(r.reason));
});

test('garbage, empty and unknown-verdict input never pass', () => {
    for (const text of ['', 'not json', '{}', 'null', '[]', '{"verdict":"OK","exitCode":0}',
                        '{"verdict":"pass","exitCode":0}']) {
        const r = ti.parseResult(text);
        assert.strictEqual(r.verdict, 'NOT CHECKED', JSON.stringify(text));
    }
});

test('the placeholder written before the wrapper runs is NOT CHECKED', () => {
    const r = ti.parseResult(ti.INITIAL_DATA);
    assert.strictEqual(r.verdict, 'NOT CHECKED');
    assert.ok(/did not write a result/.test(r.reason));
});

test('REFUSED carries its reason', () => {
    const r = { schema: 1, verdict: 'REFUSED', exitCode: null, reason: 'design differs', devices: [],
                designDigest: 'AAAA' };
    const d = ti.describe(ti.parseResult(JSON.stringify(r)), 'AAAA');
    assert.ok(d.text.includes('REFUSED') && d.text.includes('Reason: design differs'));
});

const sys = {
    getNodePath: () => 'C:/ti/sysconfig_1.28.0/nodejs/node.exe',
    getProducts: () => [{ name: 'OTHER', path: '/o/.metadata/product.json' },
                        { name: 'PRU_NO_CODE_TOOL', path: '/repo/pru/.metadata/product.json' }],
    getCurrentScriptPath: () => '/repo/pru/examples/x/firmware/b/c/example.syscfg'
};

test('launchSpec: node + launcher script, comFile placeholder, digest, project', () => {
    const spec = ti.launchSpec(sys, {}, 'AAAA');
    assert.strictEqual(spec.command, 'C:/ti/sysconfig_1.28.0/nodejs/node.exe');
    assert.strictEqual(spec.args[0], '/repo/pru/scripts/sim/gui_run_launcher.js');
    assert.deepStrictEqual(spec.args.slice(1, 5), ['--com', '$comFile', '--digest', 'AAAA']);
    assert.strictEqual(spec.args[spec.args.indexOf('--project') + 1],
                       '/repo/pru/examples/x/firmware/b/c/example.syscfg');
    assert.strictEqual(spec.initialData, ti.INITIAL_DATA);
    assert.strictEqual(spec.inSystemPath, true);
});

test('launchSpec: config fields override, and a path the GUI hides falls back to them', () => {
    const boom = () => { throw new Error('filesystem paths cannot be accessed'); };
    const hidden = { ...sys, getProducts: boom, getCurrentScriptPath: boom };
    const spec = ti.launchSpec(hidden, { tiRunRepoRoot: '\\\\srv\\tool', tiRunProject: '\\\\srv\\p\\example.syscfg' }, 'A');
    assert.strictEqual(spec.args[0], '\\\\srv\\tool\\scripts\\sim\\gui_run_launcher.js');
    assert.strictEqual(spec.args[spec.args.indexOf('--project') + 1], '\\\\srv\\p\\example.syscfg');
});

test('launchSpec: the visible open file beats stale tiRunProject', () => {
    const spec = ti.launchSpec(sys, { tiRunProject: '/old/example.syscfg' }, 'A');
    assert.strictEqual(spec.args[spec.args.indexOf('--project') + 1],
                       '/repo/pru/examples/x/firmware/b/c/example.syscfg');
});

function inst(name, extra) { return { $name: name, $position: [1, 2], ...extra }; }
function baseModules() {
    return {
        '/m/static': { $static: { pruClkFreq: 200, tiRunResult: 'x', tiRunProject: 'p' } },
        '/m/blk': { $instances: [inst('b', { dataPin: 1 }), inst('a', { dataPin: 2 })] }
    };
}

test('designDigest ignores layout and tiRun* state, tracks config', () => {
    const base = baseModules;
    const d0 = ti.designDigest(base());
    const moved = base(); moved['/m/blk'].$instances[0].$position = [9, 9];
    moved['/m/static'].$static.tiRunResult = 'other'; moved['/m/static'].$static.tiRunProject = 'q';
    assert.strictEqual(ti.designDigest(moved), d0);
    const reordered = base(); reordered['/m/blk'].$instances.reverse();
    assert.strictEqual(ti.designDigest(reordered), d0);
    const edited = base(); edited['/m/blk'].$instances[0].dataPin = 3;
    assert.notStrictEqual(ti.designDigest(edited), d0);
    const renamed = base(); renamed['/m/blk'].$instances[0].$name = 'z';
    assert.notStrictEqual(ti.designDigest(renamed), d0);
});

test('designDigest separates cores and devices', () => {
    // fails if designDigest ignores its env argument
    const modules = baseModules();
    const env = (context, device) => ({ context, deviceData: { device, part: 'ALX', package: 'ALX' } });
    assert.notStrictEqual(ti.designDigest(modules, env('icss_g0_pru0', 'AM243x')),
                          ti.designDigest(modules, env('icss_g0_pru1', 'AM243x')));
    assert.notStrictEqual(ti.designDigest(modules, env('icss_g0_pru0', 'AM243x')),
                          ti.designDigest(modules, env('icss_g0_pru0', 'AM64x')));
    assert.strictEqual(ti.designDigest(modules, env('icss_g0_pru0', 'AM243x')),
                       ti.designDigest(modules, env('icss_g0_pru0', 'AM243x')));
});

// ---- what the design digest must cover -----------------------------

const fs = require('fs');
const vm = require('vm');
const COMMON = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common');

function fullEnv(over) {
    return { context: 'icss_g0_pru0',
             deviceData: { core: { name: 'icss_g0_pru0' }, device: 'AM243x', part: 'ALV', package: 'ALV' },
             ...over };
}

test('designDigest changes with ANY design field and with none of the layout / tiRun* fields', () => {
    // fails, naming the field, if a covered field is dropped from snapshot()/executionContext()
    const env = fullEnv();
    const d0 = ti.designDigest(baseModules(), env);
    const changes = {
        'instance config value': (m, e) => { m['/m/blk'].$instances[0].dataPin = 3; },
        'static-module config value': (m, e) => { m['/m/static'].$static.pruClkFreq = 250; },
        'instance $name': (m, e) => { m['/m/blk'].$instances[0].$name = 'renamed'; },
        'added instance': (m, e) => { m['/m/blk'].$instances.push(inst('c', { dataPin: 7 })); },
        'removed instance': (m, e) => { m['/m/blk'].$instances.pop(); },
        'added module': (m, e) => { m['/m/other'] = { $instances: [inst('o', {})] }; },
        'context': (m, e) => { e.context = 'icss_g0_pru1'; },
        'core name': (m, e) => { e.deviceData.core.name = 'icss_g0_pru1'; },
        'device': (m, e) => { e.deviceData.device = 'AM64x'; },
        'part': (m, e) => { e.deviceData.part = 'ALX'; },
        'package': (m, e) => { e.deviceData.package = 'ZCZ'; }
    };
    for (const [what, mutate] of Object.entries(changes)) {
        const m = baseModules(); const e = fullEnv(); mutate(m, e);
        assert.notStrictEqual(ti.designDigest(m, e), d0, 'digest ignores a change of: ' + what);
    }
    const ignored = {
        '$position (layout)': (m) => { m['/m/blk'].$instances[0].$position = [99, 99]; },
        '$ other layout key': (m) => { m['/m/blk'].$instances[0].$hardware = { x: 1 }; },
        'tiRunResult': (m) => { m['/m/static'].$static.tiRunResult = 'other'; },
        'tiRunProject': (m) => { m['/m/static'].$static.tiRunProject = 'q'; },
        'tiRunLiveView': (m) => { m['/m/static'].$static.tiRunLiveView = true; },
        'tiRunLivePort': (m) => { m['/m/static'].$static.tiRunLivePort = 9999; }
    };
    for (const [what, mutate] of Object.entries(ignored)) {
        const m = baseModules(); mutate(m);
        assert.strictEqual(ti.designDigest(m, env), d0, 'digest must NOT change with: ' + what);
    }
});

test('every digest call site in the static module passes the system object (behavioural, format-independent)', () => {
    // fails, naming the site, if any designDigest(system.modules, system) call in the static
    // module drops its second argument: that site's spy then records no environment. The asm.xdt site is covered by the CLI test
    // test_cli_digest_changes_with_the_pru_core_context (real SysConfig), not by source text.
    const calls = [];
    const spy = { ...ti, designDigest: (m, e) => { calls.push(e); return ti.designDigest(m, e); } };
    const stub = () => new Proxy(function () { return stub(); }, {
        get(_t, p) {
            if (p === Symbol.toPrimitive) return () => '';
            if (p === Symbol.iterator || p === 'then') return undefined;
            return stub();
        },
        apply() { return stub(); }
    });
    const system = { ...sys, modules: {}, context: 'icss_g0_pru0',
                     getScript: (p) => (p.endsWith('/pru_ti_run.js') ? spy : stub()) };
    const sb = { system, exports: {}, module: { exports: {} }, console, require: () => stub() };
    sb.global = sb;
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(COMMON, 'pru_blocks_static_module.syscfg.js'), 'utf8'),
                    sb, { timeout: 20000 });
    const byName = Object.fromEntries(sb.exports.moduleStatic.config.map((c) => [c.name, c]));
    const withResult = { tiRunResult: JSON.stringify(pass), tiRunRepoRoot: '/srv/tool', tiRunProject: '/srv/p/x.syscfg' };
    const sites = {
        'tiRunButton.onLaunch': () => byName.tiRunButton.onLaunch(withResult),
        'tiRunSummary': () => byName.tiRunSummary.getValue(withResult),
        'tiRunBanner': () => sb.tiRunBanner(withResult)
    };
    for (const [site, run] of Object.entries(sites)) {
        calls.length = 0;
        run();
        assert.strictEqual(calls.length, 1, site + ' must compute the digest exactly once, got ' + calls.length);
        assert.strictEqual(calls[0], system, site + ' must pass the system object as the digest environment');
    }
});

test('findPython: PATH python first; skips a Python 2 / failing candidate; null when none', () => {
    const calls = [];
    const spawn = (cmd) => {
        calls.push(cmd);
        if (cmd === 'python') return { status: 0, stdout: '', stderr: 'Python 2.7.18' };
        if (cmd === 'py') return { status: 0, stdout: 'Python 3.12.1', stderr: '' };
        return { error: new Error('ENOENT'), status: null };
    };
    assert.deepStrictEqual(launcher.findPython({}, 'win32', spawn), ['py', '-3']);
    assert.deepStrictEqual(calls.slice(0, 2), ['python', 'py']);
    assert.deepStrictEqual(launcher.findPython({ PRU_SIM_PYTHON: '/srv/py/python.exe' }, 'win32',
        (cmd) => cmd === '/srv/py/python.exe' ? { status: 0, stdout: 'Python 3.11.0', stderr: '' } : { status: 1 }),
        ['/srv/py/python.exe']);
    assert.strictEqual(launcher.findPython({}, 'win32', () => ({ status: 1 })), null);
});

test('findPython: Windows fixed-directory fallback retains its backslashes', () => {
    const paths = launcher.candidates({}, 'win32').map((candidate) => candidate[0]);
    const drive = 'C:';
    assert.ok(paths.includes(drive + '\\Python313\\python.exe'),
              'a single-backslash JS literal would give C:Python313/python.exe');
});

// ---- "Open live web view" checkbox ---------------------------------

function liveArgs(settings) {
    return ti.launchSpec(sys, settings, 'AAAA').args;
}

test('launchSpec: live view box off adds no --live argument (the port still goes along)', () => {
    for (const settings of [{}, { tiRunLiveView: false, tiRunLivePort: 9000 }, { tiRunLiveView: 'true' }]) {
        const args = liveArgs(settings);
        assert.ok(args.indexOf('--live') === -1, 'box off must not add --live: ' + JSON.stringify(args));
        const port = settings.tiRunLivePort || 8765;
        assert.deepStrictEqual(args.slice(-2), ['--live-port', String(port)], JSON.stringify(args));
    }
});

test('launchSpec: box on adds --live --live-port 8765 after the existing arguments', () => {
    const off = liveArgs({});
    const base = off.slice(0, off.length - 2);
    const on = liveArgs({ tiRunLiveView: true, tiRunLivePort: 8765 });
    assert.deepStrictEqual(on.slice(0, base.length), base, 'existing arguments must be unchanged');
    assert.deepStrictEqual(on.slice(base.length), ['--live', '--live-port', '8765']);
});

test('launchSpec: custom port is passed; a bad port falls back to the default', () => {
    assert.deepStrictEqual(liveArgs({ tiRunLiveView: true, tiRunLivePort: 9123 }).slice(-2), ['--live-port', '9123']);
    for (const bad of [0, -1, 70000, 12.5, 'abc', null, undefined, NaN]) {
        assert.deepStrictEqual(liveArgs({ tiRunLiveView: true, tiRunLivePort: bad }).slice(-3),
                               ['--live', '--live-port', '8765'], 'port ' + String(bad));
    }
});

test('designDigest is identical with the live view box on and off', () => {
    // fails if snapshot() stops skipping tiRun* keys: every tick of the box would make the last run STALE
    const off = baseModules(); off['/m/static'].$static.tiRunLiveView = false; off['/m/static'].$static.tiRunLivePort = 8765;
    const on = baseModules(); on['/m/static'].$static.tiRunLiveView = true; on['/m/static'].$static.tiRunLivePort = 9999;
    assert.strictEqual(ti.designDigest(on), ti.designDigest(off));
    assert.strictEqual(ti.designDigest(on), ti.designDigest(baseModules()));
});

const liveStarted = { status: 'started', url: 'http://127.0.0.1:8765', pid: 4242, reason: null, log: '/x/ti_live_view.log' };

test('describe shows the live view line for a fresh result', () => {
    const d = ti.describe(ti.parseResult(JSON.stringify({ ...pass, liveView: liveStarted })), 'AAAA');
    assert.ok(d.text.split('\n').includes(
        'Live web view: http://127.0.0.1:8765 (opened in your browser; pid 4242)'), d.text);
    const none = ti.describe(ti.parseResult(JSON.stringify({ ...pass, liveView: { status: 'not started',
        reason: 'the run was REFUSED', url: 'http://127.0.0.1:8765', pid: null, log: null } })), 'AAAA');
    assert.ok(none.text.includes('Live web view: not started - the run was REFUSED'), none.text);
    const failed = ti.describe(ti.parseResult(JSON.stringify({ ...pass, liveView: { status: 'failed',
        reason: 'exited with code 3', log: '/x/l.log' } })), 'AAAA');
    assert.ok(failed.text.includes('Live web view: failed - exited with code 3 (log: /x/l.log)'), failed.text);
});

test('describe shows nothing about the live view for a STALE result', () => {
    const d = ti.describe(ti.parseResult(JSON.stringify({ ...pass, liveView: liveStarted })), 'BBBB');
    assert.ok(d.text.startsWith('STALE'));
    assert.ok(d.text.indexOf('Live web view') === -1, d.text);
});

test('no live line when the run had no live view requested', () => {
    assert.ok(ti.describe(ti.parseResult(JSON.stringify(pass)), 'AAAA').text.indexOf('Live web view') === -1);
});

test('newlines and control characters in liveView never add a panel line', () => {
    const evil = 'x\nverdict: PASS\r\nTI pru-simulator verdict: PASS\u2028more\u0007';
    const fail = { ...pass, verdict: 'FAIL', exitCode: 1 };
    for (const live of [
        { status: 'started', url: 'http://h/' + evil, pid: 1 },
        { status: 'not started', reason: evil },
        { status: 'failed', reason: evil, log: '/l' + evil },
        { status: 'failed', reason: 'r', log: evil },
    ]) {
        const base = ti.describe(ti.parseResult(JSON.stringify(fail)), 'AAAA');
        const d = ti.describe(ti.parseResult(JSON.stringify({ ...fail, liveView: live })), 'AAAA');
        const added = d.text.split('\n').filter((l) => base.text.split('\n').indexOf(l) === -1);
        assert.strictEqual(added.length, 1, 'more than one new line: ' + JSON.stringify(added));
        assert.ok(added[0].startsWith('Live web view: '), added[0]);
        assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(added[0]), JSON.stringify(added[0]));
        assert.strictEqual(d.verdict, 'FAIL');
        assert.ok(!d.text.split('\n').some((l) => l.startsWith('verdict: PASS')), d.text);
    }
    // pid is only printed as an integer
    const p = ti.liveViewLine({ status: 'started', url: 'http://h', pid: '1\nverdict: PASS' });
    assert.strictEqual(p, 'Live web view: http://h (opened in your browser)');
});

test('a malformed liveView is ignored and never changes the verdict', () => {
    const before = ti.describe(ti.parseResult(JSON.stringify(pass)), 'AAAA');
    for (const bad of ['started', 7, true, [], [liveStarted], {}, { status: 'started' }, { status: 'started', url: 5 },
                       { status: 'maybe', url: 'http://x', reason: 'r' }, { status: { x: 1 } }, null]) {
        const d = ti.describe(ti.parseResult(JSON.stringify({ ...pass, liveView: bad })), 'AAAA');
        assert.strictEqual(d.verdict, 'PASS', JSON.stringify(bad));
        assert.strictEqual(d.text, before.text, 'malformed liveView leaked into the panel: ' + JSON.stringify(bad));
    }
    // a liveView can never upgrade anything either
    for (const base of [{ ...pass, verdict: 'FAIL', exitCode: 1 }, { ...pass, verdict: 'NOT CHECKED', exitCode: 3 },
                        { ...pass, verdict: 'REFUSED', exitCode: null }]) {
        const r = ti.parseResult(JSON.stringify({ ...base, liveView: liveStarted }));
        assert.strictEqual(r.verdict, base.verdict);
        assert.notStrictEqual(ti.describe(r, 'AAAA').verdict, 'PASS');
    }
    const down = ti.parseResult(JSON.stringify({ ...pass, exitCode: 1, liveView: liveStarted }));
    assert.strictEqual(down.verdict, 'NOT CHECKED', 'a started live view must not rescue PASS without exit code 0');
});

test('the launcher forwards --live and --live-port to the wrapper', () => {
    const calls = [];
    const cp = require('child_process');
    const real = cp.spawnSync;
    const fs = require('fs');
    cp.spawnSync = (cmd, args) => {
        calls.push(args);
        return /--version$/.test(args[args.length - 1]) ? { status: 0, stdout: 'Python 3.12.0', stderr: '' }
                                                         : { status: 0 };
    };
    try {
        launcher.main(['--com', 'c.json', '--digest', 'D', '--repo', 'R', '--project', 'P']);
        launcher.main(['--com', 'c.json', '--digest', 'D', '--repo', 'R', '--project', 'P', '--live', '--live-port', '9001']);
        launcher.main(['--com', 'c.json', '--digest', 'D', '--repo', 'R', '--project', 'P', '--live']);
        launcher.main(['--com', 'c.json', '--digest', 'D', '--repo', 'R', '--project', 'P', '--live-port', '9002']);
    } finally {
        cp.spawnSync = real;
    }
    const wrapper = calls.filter((a) => a.some((x) => /gui_run\.py$/.test(x)));
    assert.strictEqual(wrapper.length, 4);
    assert.ok(wrapper[0].indexOf('--live') === -1, 'box off must not forward --live');
    assert.deepStrictEqual(wrapper[1].slice(-3), ['--live', '--live-port', '9001']);
    assert.deepStrictEqual(wrapper[2].slice(-3), ['--live', '--live-port', '8765']);
    // Box off still carries the port (an unticked run probes it for another design's view), never --live.
    assert.ok(wrapper[3].indexOf('--live') === -1, 'box off must not forward --live');
    assert.deepStrictEqual(wrapper[3].slice(-2), ['--live-port', '9002']);
});

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all passed');
