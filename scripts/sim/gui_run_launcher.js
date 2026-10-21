#!/usr/bin/env node
/**
 * What SysConfig's launcher actually starts for the "Run on TI
 * pru-simulator" button. SysConfig runs `node <this file> --com $comFile ...`
 * with its own node.exe (system.getNodePath()), because that is the one
 * interpreter the GUI process is certain to have. The GUI's PATH is not a
 * shell's, so `python` may not resolve; this finds one and hands over to
 * scripts/sim/gui_run.py. If none is found it still writes a REFUSED result to
 * $comFile - a launched process that dies silently would leave only the
 * "wrapper did not write a result" placeholder.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

function candidates(env, platform) {
    const list = [];
    if (env.PRU_SIM_PYTHON) list.push([env.PRU_SIM_PYTHON]);
    if (platform === 'win32') {
        // per-user python.org installs are found by the py launcher
        list.push(['python'], ['py', '-3']);
        const drive = env.SystemDrive || 'C:';
        for (const base of [drive + '\\Python313', drive + '\\Python312', drive + '\\Python311', drive + '\\Python310']) {
            list.push([path.win32.join(base, 'python.exe')]);
        }
    } else {
        list.push(['python3'], ['python']);
    }
    return list;
}

/** First candidate that runs `--version` as Python 3, as [cmd, ...prefixArgs]. */
function findPython(env, platform, spawn) {
    spawn = spawn || childProcess.spawnSync;
    for (const candidate of candidates(env || process.env, platform || process.platform)) {
        const probe = spawn(candidate[0], candidate.slice(1).concat(['--version']),
                            { encoding: 'utf8', env: env || process.env });
        const text = String((probe && (probe.stdout || '')) + (probe && (probe.stderr || '')));
        if (probe && !probe.error && probe.status === 0 && /Python 3\./.test(text)) {
            return candidate;
        }
    }
    return null;
}

function argValue(argv, name) {
    const at = argv.indexOf(name);
    return at === -1 ? '' : argv[at + 1] || '';
}

function writeRefused(com, reason, digest) {
    if (!com) return;
    fs.writeFileSync(com, JSON.stringify({
        schema: 1, verdict: 'REFUSED', exitCode: null, reason: reason, devices: [],
        cycles: null, vcd: null, designDigest: digest || null
    }, null, 2));
}

function main(argv) {
    const com = argValue(argv, '--com');
    const digest = argValue(argv, '--digest');
    const repo = argValue(argv, '--repo') || path.resolve(__dirname, '..', '..');
    const python = findPython();
    if (!python) {
        writeRefused(com, 'python 3 not found from the GUI process; set PRU_SIM_PYTHON to its full path', digest);
        return 1;
    }
    const wrapper = path.join(repo, 'scripts', 'sim', 'gui_run.py');
    const forward = ['--com', com, '--digest', digest, '--project', argValue(argv, '--project')];
    // The port is always forwarded (an unticked run probes it for another design's view);
    // only --live is conditional.
    const livePort = argValue(argv, '--live-port');
    if (argv.indexOf('--live') !== -1) forward.push('--live');
    if (livePort || argv.indexOf('--live') !== -1) forward.push('--live-port', livePort || '8765');
    const result = childProcess.spawnSync(python[0], python.slice(1).concat([wrapper], forward),
                                          { stdio: 'inherit', env: process.env });
    if (result.error) {
        writeRefused(com, 'could not start the wrapper: ' + result.error.message, digest);
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

module.exports = { findPython, candidates, main };
if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
