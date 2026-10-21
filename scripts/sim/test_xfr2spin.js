'use strict';
// SPDX-License-Identifier: BSD-3-Clause
//
// ICSSG hardware spinlock (XFR2SPIN, SPRUIM2J Table 6-60 device 0x90;
// 6.4.6.2.9 / 6.4.6.2.9.1 Table 6-98).
//
// Every macro under test is fetched through block.getMacro("", opCode) -- the
// SAME call pru_syscfg.inc.xdt makes -- and then executed. There is no
// test-only macro path in the block and none is constructed here.
//
// Whether a GENERATED firmware (not just this in-process call) carries the
// spinlock access needs the real TI SysConfig CLI and clpru over complete
// designs; that end-to-end check is not part of this file. This file covers behaviour the generator cannot show: the ownership
// bit, and mutual exclusion between two cores.
//
// Oracle note: the 0x90 device model in scripts/simulator.js and this block
// were both written from SPRUIM2J Table 6-98. The simulator arm therefore
// proves the emitted code does what the TRM describes and that the operands
// are wired to the real dataflow; it is NOT an independent oracle and makes no
// silicon claim. Maturity stays "assembles".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Simulator } = require(path.join(__dirname, '..', 'simulator'));

const root = path.resolve(__dirname, '..', '..');
const blockPath = path.join(root, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'pru_io_blocks', 'xfr2spin_block.syscfg.js');
const capsPath = path.join(root, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_device_caps.js');

function loadBlock(coreName) {
    const source = fs.readFileSync(blockPath, 'utf8');
    const sandbox = {
        exports: {}, console,
        system: { getScript: () => ({ getSelfSysCfgCoreName: () => coreName || 'icss_g0_pru0' }) }
    };
    vm.runInNewContext(source, sandbox, { filename: 'xfr2spin_block.syscfg.js' });
    return sandbox.exports;
}
const block = loadBlock();
// THE production entry point. First argument empty, exactly as the .xdt passes it.
const macro = (name) => block.getMacro('', name);
const cfg = (name) => block.config.find((c) => c.name === name);

// `label?` is the TI assembler's macro-local label marker: clpru rewrites it to
// a unique name per expansion (verified in a real listing from this repo, where
// `xs_spin?` became `xs_spin$1$`). The simulator's label map has no notion of
// that marker, so do here exactly what the assembler does - give it one
// concrete name. Only the label spelling changes; no instruction is altered.
function expandMacroLocalLabels(line, tag) {
    return line.replace(/\?/g, `$${tag}$`);
}

function macroBody(macroText, subs, tag) {
    const keys = Object.keys(subs).sort((a, b) => b.length - a.length);
    return macroText.split(/\r?\n/)
        .filter((line) => !line.includes('.macro') && !line.includes('.endm'))
        .filter((line) => !/^\s*;/.test(line))
        .filter((line) => line.trim().length > 0)
        .map((line) => keys.reduce((out, key) => out.split(key).join(String(subs[key])), line))
        .map((line) => expandMacroLocalLabels(line, tag === undefined ? 1 : tag));
}

let checks = 0;
function check(label, fn) { fn(); checks++; void label; }

// ---------------------------------------------------------------------------
// 1. Contract: device id and the DIRECTION of each access.
//
// Direction is the whole point. On 0x90 an XOUT is the flag CLEAR, so an
// acquire built out of XOUT would drop the lock it is taking. These assertions
// pin the mapping to Table 6-98's INT_SPIN_ID rows.
// ---------------------------------------------------------------------------
check('device id', () => {
    assert.strictEqual(block.deviceId, 0x90);
    assert.strictEqual(block.deviceId, 144);
    assert.strictEqual(block.numFlags, 64);
    assert.strictEqual(block.nopsAfterXout, 8);
});

const acquireText = macro('m_xfr2spin_acquire');
const tryText = macro('m_xfr2spin_try_acquire');
const releaseText = macro('m_xfr2spin_release');

check('acquire is an XIN, never an XOUT', () => {
    assert.ok(/xin\s+144,\s*&R1\.b3,\s*1/.test(acquireText), 'acquire must XIN device 144');
    assert.ok(!/xout/.test(acquireText),
        'acquire must NOT emit an XOUT: XOUT 0x90 is "Flag clear" (Table 6-98) and would release the lock');
    assert.ok(/xin\s+144,\s*&R1\.b3,\s*1/.test(tryText));
    assert.ok(!/xout/.test(tryText), 'try_acquire must not emit an XOUT either');
});

check('release is the XOUT, and carries the 8 NOPs', () => {
    assert.ok(/xout\s+144,\s*&R1\.b0,\s*1/.test(releaseText), 'release must XOUT device 144');
    assert.ok(!/xin/.test(releaseText), 'release must not XIN');
    const nops = releaseText.split(/\r?\n/).filter((l) => l.trim() === 'nop').length;
    assert.strictEqual(nops, 8, `release must emit exactly 8 NOPs, got ${nops}`);
    // They must come AFTER the XOUT to separate it from a following XIN.
    const lines = releaseText.split(/\r?\n/);
    const xoutAt = lines.findIndex((l) => /xout/.test(l));
    const firstNop = lines.findIndex((l) => l.trim() === 'nop');
    assert.ok(xoutAt !== -1 && firstNop > xoutAt, 'the 8 NOPs must follow the XOUT, not precede it');
});

check('selector is written with a plain LDI to R1.b0, not XOUT-ed', () => {
    for (const [name, text] of [['acquire', acquireText], ['try_acquire', tryText], ['release', releaseText]]) {
        assert.ok(/ldi\s+R1\.b0,\s*LOCK_ID/.test(text), `${name} must load the flag selector into R1.b0`);
    }
});

// ---------------------------------------------------------------------------
// 2. The production path is not empty.
//
// A macro that returns only .macro/.endm on the ("", opCode) path compiles
// happily with clpru but contains no spinlock access. Assert real instructions.
// ---------------------------------------------------------------------------
check('production getMacro("", opCode) returns a real body', () => {
    for (const [name, text] of [['acquire', acquireText], ['try_acquire', tryText], ['release', releaseText]]) {
        const body = text.split(/\r?\n/)
            .filter((l) => !l.includes('.macro') && !l.includes('.endm'))
            .filter((l) => !/^\s*;/.test(l))
            .filter((l) => l.trim().length > 0);
        assert.ok(body.length >= 3, `${name} body is effectively empty (${body.length} lines)`);
        assert.ok(body.some((l) => /xin|xout/.test(l)), `${name} contains no broadside access at all`);
    }
    // And the two call shapes must agree: whatever static validation passes in
    // as a full allocator call must yield the same text as the .xdt's form.
    assert.strictEqual(block.getMacro('m_xfr2spin_acquire R4, 7', undefined), acquireText);
    assert.strictEqual(block.getMacro('', 'm_xfr2spin_acquire'), acquireText);
});

// ---------------------------------------------------------------------------
// 3. Ownership is the BIT R1.b3[0], not the byte R1.b3.
//
// Requirement (b): set unrelated bits in R1.b3 and the result must still be
// boolean. The simulator writes only bit 24; the macro's AND mask is what keeps
// the published value 0/1.
// ---------------------------------------------------------------------------
check('ownership stays boolean when other R1.b3 bits are set', () => {
    for (const dirty of [0x00000000, 0xFE000000, 0xAA000000, 0x7E000000]) {
        Simulator.resetSpinlocks();
        const sim = new Simulator({ id: 'PRU0' });
        // Seed R1 with the dirty upper byte AND the flag selector, then run the
        // real macro body.
        const body = macroBody(tryText, { RES: 'R10', LOCK_ID: '7' });
        sim.loadInstructions([`LDI32 R1, ${(dirty | 7) >>> 0}`, ...body, 'HALT']);
        sim.stepPaced(40);
        assert.ok(!sim.state.errorParsing, `parse error: ${JSON.stringify(sim.state.errorParsing)}`);
        const res = sim.state.registers[10] >>> 0;
        assert.ok(res === 0 || res === 1,
            `ownership must be boolean, got 0x${res.toString(16)} with R1.b3 seeded 0x${dirty.toString(16)}`);
        // Free flag -> must have WON, and the win must be 1 not 0x7f.
        assert.strictEqual(res, 1, `a free flag must be won (dirty=0x${dirty.toString(16)})`);
    }
});

check('a lost arbitration publishes exactly 0 even with dirty bits', () => {
    Simulator.resetSpinlocks();
    const holder = new Simulator({ id: 'PRU0' });
    holder.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    holder.stepPaced(40);
    assert.strictEqual(holder.state.registers[10] >>> 0, 1, 'first core must win');

    const loser = new Simulator({ id: 'PRU1' });
    loser.loadInstructions([`LDI32 R1, ${(0xFF000000 | 7) >>> 0}`,
        ...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    loser.stepPaced(40);
    assert.strictEqual(loser.state.registers[10] >>> 0, 0,
        'second core must lose, and must publish 0 rather than leftover R1.b3 bits');
});

// ---------------------------------------------------------------------------
// 4. Mutual exclusion: a second core must BLOCK while the lock is held.
//
// If both cores fall through their spin loops, the model is per-core state
// pretending to be a lock.
// ---------------------------------------------------------------------------
function runAcquireLoop(id, flag, cycles) {
    const sim = new Simulator({ id });
    sim.loadInstructions([...macroBody(acquireText, { RES: 'R10', LOCK_ID: String(flag) }), 'HALT']);
    sim.stepPaced(cycles);
    return sim;
}

check('second core blocks in its spin loop while the first holds the flag', () => {
    Simulator.resetSpinlocks();

    const a = runAcquireLoop('PRU0', 7, 60);
    assert.strictEqual(a.state.registers[10] >>> 0, 1, 'PRU0 must acquire the free flag');
    assert.strictEqual(Simulator.spinlockOwner(7), 'PRU0', 'PRU0 must hold flag 7');

    // Same subsystem, same flag, lock already held.
    const b = runAcquireLoop('PRU1', 7, 200);
    assert.strictEqual(Simulator.spinlockOwner(7), 'PRU0', 'PRU0 must STILL hold flag 7');
    assert.notStrictEqual(b.state.registers[10] >>> 0, 1,
        'PRU1 must NOT report ownership while PRU0 holds the flag');
    assert.ok(b.state.spinlock && b.state.spinlock.losses > 1,
        `PRU1 must lose arbitration repeatedly (spun), got ${JSON.stringify(b.state.spinlock)}`);
    assert.ok(b.state.spinlock.wins === 0, 'PRU1 must never win while PRU0 holds it');

});

check('a different subsystem does NOT contend (one copy per PRU_ICSSG)', () => {
    Simulator.resetSpinlocks();
    const g0 = new Simulator({ id: 'PRU0', subsystem: 'icssg0' });
    g0.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    g0.stepPaced(40);
    assert.strictEqual(g0.state.registers[10] >>> 0, 1);

    const g1 = new Simulator({ id: 'PRU0', subsystem: 'icssg1' });
    g1.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    g1.stepPaced(40);
    assert.strictEqual(g1.state.registers[10] >>> 0, 1,
        'flag 7 of ICSSG1 is a different flag from flag 7 of ICSSG0');
});

check('different flags do not alias', () => {
    Simulator.resetSpinlocks();
    const a = new Simulator({ id: 'PRU0' });
    a.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    a.stepPaced(40);
    const b = new Simulator({ id: 'PRU1' });
    b.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '8' }), 'HALT']);
    b.stepPaced(40);
    assert.strictEqual(a.state.registers[10] >>> 0, 1);
    assert.strictEqual(b.state.registers[10] >>> 0, 1, 'flag 8 must be independent of flag 7');
});

// ---------------------------------------------------------------------------
// 5. Release actually frees the flag, and the blocked core then proceeds.
// ---------------------------------------------------------------------------
check('release frees the flag and unblocks the waiter', () => {
    Simulator.resetSpinlocks();
    const a = new Simulator({ id: 'PRU0' });
    a.loadInstructions([
        ...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }),
        ...macroBody(releaseText, { LOCK_ID: '7' }),
        'HALT'
    ]);
    a.stepPaced(60);
    assert.strictEqual(a.state.registers[10] >>> 0, 1, 'PRU0 acquires');
    assert.strictEqual(Simulator.spinlockOwner(7), null, 'release must clear the flag');

    const b = runAcquireLoop('PRU1', 7, 60);
    assert.strictEqual(b.state.registers[10] >>> 0, 1, 'PRU1 must acquire once the flag is free');
    assert.strictEqual(Simulator.spinlockOwner(7), 'PRU1');
});

check('release by a non-owner is modelled as clearing the flag (the hazard)', () => {
    Simulator.resetSpinlocks();
    const a = new Simulator({ id: 'PRU0' });
    a.loadInstructions([...macroBody(tryText, { RES: 'R10', LOCK_ID: '7' }), 'HALT']);
    a.stepPaced(40);
    assert.strictEqual(Simulator.spinlockOwner(7), 'PRU0');

    // Table 6-98 describes own_req_clr as clearing the selected flag, with no
    // owner check. Model it, so the hazard the validator rejects is real.
    const b = new Simulator({ id: 'PRU1' });
    b.loadInstructions([...macroBody(releaseText, { LOCK_ID: '7' }), 'HALT']);
    b.stepPaced(40);
    assert.strictEqual(Simulator.spinlockOwner(7), null,
        'a foreign release clears the flag - this is why an unmatched release is a build error');
    assert.ok(b.state.spinlockForeignReleases && b.state.spinlockForeignReleases.length === 1,
        'the foreign release must be recorded');
});

// ---------------------------------------------------------------------------
// 6. Block metadata / capability wiring.
// ---------------------------------------------------------------------------
check('capability gate: ICSSG only', () => {
    const caps = require(capsPath);
    assert.deepStrictEqual(
        ['am64x', 'am243x', 'am261x', 'am263px'].map((s) => caps.isWidgetAvailable('xfr2spin', s)),
        [true, true, false, false], 'xfr2spin must be ICSSG-only');
    // block is loaded via vm.runInNewContext (loadBlock, above): its array
    // literal is an Array from that sandbox's own realm. Node's
    // deepStrictEqual treats a same-content cross-realm array as merely
    // "same structure", not reference-equal, and refuses it - spread it into
    // a plain array of THIS realm first, which changes nothing about what is
    // being asserted.
    assert.deepStrictEqual([...block.requiresWidget], ['xfr2spin']);
    // fail-closed: an unknown SoC must report the widget missing.
    assert.deepStrictEqual(caps.getMissingWidgets(['xfr2spin'], 'no_such_soc'), ['xfr2spin']);
    assert.deepStrictEqual(caps.getMissingWidgets(['xfr2spin'], undefined), ['xfr2spin']);
});

check('opCode/cycle/port configuration follows the operation', () => {
    const opCfg = cfg('opCode');
    assert.strictEqual(opCfg.getValue({ operation: 'acquire' }), 'm_xfr2spin_acquire');
    assert.strictEqual(opCfg.getValue({ operation: 'try_acquire' }), 'm_xfr2spin_try_acquire');
    assert.strictEqual(opCfg.getValue({ operation: 'release' }), 'm_xfr2spin_release');

    // A blocking acquire must NOT advertise a finite cycle budget: -1 is what
    // the allocator turns into INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN.
    const cycles = cfg('noOfCycles');
    assert.strictEqual(cycles.getValue({ operation: 'acquire' }), -1,
        'a spin whose length another core controls must not report a number');
    assert.strictEqual(cycles.getValue({ operation: 'try_acquire' }), 3);
    assert.strictEqual(cycles.getValue({ operation: 'release' }), 2 + 8);

    // Release publishes no value.
    assert.strictEqual(cfg('outputReg').getValue({ operation: 'release' }), 'None');
    assert.strictEqual(cfg('numOfOutputPorts').getValue({ operation: 'release' }), 0);
    assert.strictEqual(cfg('numOfOutputPorts').getValue({ operation: 'acquire' }), 1);
    assert.strictEqual(block.ports({ operation: 'release' }).some((p) => p.name === 'output1'), false);
    assert.strictEqual(block.ports({ operation: 'acquire' }).some((p) => p.name === 'output1'), true);
});

check('lock id is bounded to the 64 real flags', () => {
    const errs = [];
    const report = { logError: (m, i, f) => errs.push(String(f)), logWarning: () => {}, logInfo: () => {} };
    for (const bad of [-1, 64, 100, 1.5, 'x', undefined]) {
        errs.length = 0;
        block.validate({ operation: 'try_acquire', lockId: bad }, report);
        assert.ok(errs.includes('lockId'), `lockId ${String(bad)} must be rejected`);
    }
    for (const good of [0, 7, 63]) {
        errs.length = 0;
        block.validate({ operation: 'try_acquire', lockId: good }, report);
        assert.ok(!errs.includes('lockId'), `lockId ${good} must be accepted`);
    }
});

check('an unknown macro name is refused rather than silently aliased', () => {
    assert.throws(() => block.getMacro('', 'm_xfr2spin_lock'), /Unsupported XFR2SPIN macro/);
    assert.throws(() => block.getMacro('', ''), /Unsupported XFR2SPIN macro/);
});

check('the TRM ambiguity is recorded, not hidden', () => {
    assert.ok(block.knownTrmAmbiguity && /UNVERIFIED/.test(block.knownTrmAmbiguity.status));
    assert.strictEqual(block.nopEvidence.status, 'conservative-carryover');
    assert.ok(!block.nopEvidence.printedAgainst.some((s) => /0x90/.test(s)),
        'the 8-NOP note must not be claimed as printed against the 0x90 rows');
});

console.log(`XFR2SPIN: ${checks} checks passed`);
