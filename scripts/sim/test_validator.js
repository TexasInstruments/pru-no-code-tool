'use strict';
// SPDX-License-Identifier: BSD-3-Clause
//
// ValidateXfr2spinGlobal (pru_blocks_static_module.syscfg.js), in
// process, on the REAL function extracted from the real static module - not
// a copy - so this test cannot drift from what ships. Complements
// scripts/sysconfig_arm.sh, which drives the real SysConfig CLI end to
// end but needs a local TI toolchain; this file has no such dependency and
// is what runs in a sandbox that does not have one.
//
// The task this validator exists for: flag a multi-core shared-memory write
// that has no lock held around it. Every check below is a red arm - it
// asserts the FAIL side and the PASS side of the same fixture, built by one
// mutation, so a validator that always returns clean (the defect the first
// rejected attempt shipped) cannot pass this file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const staticPath = path.join(root, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_blocks_static_module.syscfg.js');

function deepStub() {
    const fn = function () { return deepStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
            if (prop === Symbol.iterator || prop === 'then' || prop === 'length') return undefined;
            return deepStub();
        },
        apply() { return deepStub(); }
    });
}

// No allocator summary is supplied: getPruRegisterAllocationSummary() throws,
// so validateXfr2spinGlobal's `haveOrder` is false and arms 2/5/6 (placement,
// R1 liveness - which need program order) are skipped by design, exactly as
// the function does under "reduced test stubs" (its own comment). Arms 1, 3
// and 4 - pairing, dangling acquire, and "is this cross-core write actually
// protected" - need no order and are exercised in full below.
function loadValidator(modules) {
    const staticSource = fs.readFileSync(staticPath, 'utf8');
    const common = { getSocName: () => 'am64x', getSelfSysCfgCoreName: () => 'icss_g0_pru0' };
    const sctx = {
        system: {
            modules,
            getScript: (p) => {
                const s = String(p);
                if (s.includes('pru_register_allocator')) {
                    return { getPruRegisterAllocationSummary: () => { throw new Error('no allocator in this stub'); } };
                }
                if (s === '/common' || s.endsWith('/common')) return common;
                return deepStub();
            },
            deviceData: { device: 'AM243x' }
        },
        exports: {}, console: { log() {}, warn() {}, error() {} },
        Set, Map, JSON, Math, Number, Array, Object, String, RegExp, Error, parseInt, parseFloat, isNaN
    };
    sctx.globalThis = sctx;
    vm.runInNewContext(staticSource + '\n;globalThis.__validateXfr2spinGlobal = validateXfr2spinGlobal;',
        sctx, { filename: 'pru_blocks_static_module.syscfg.js' });
    return sctx.__validateXfr2spinGlobal;
}

function report() {
    const errors = [];
    return { errors, logError: (m) => errors.push(String(m)), logWarning: () => {}, logInfo: () => {} };
}

function spinInst(name, operation, lockId, protectsVariable) {
    return { $name: name, operation, lockId, protectsVariable };
}
function ipcInst(name, variableName, crossCoreWriters) {
    return { $name: name, variableName, crossCoreWriters };
}

let checks = 0;
function check(label, fn) { fn(); checks++; void label; }

// ---------------------------------------------------------------------------
// Arm 4, RED then GREEN: the exact case the item asks for - a shared-memory
// write flagged as multi-core, with and without a lock held around it.
// ---------------------------------------------------------------------------
check('unlocked cross-core write is flagged (RED: broken input)', () => {
    const modules = {
        '/pru_blocks/pru_io_blocks/xfr2spin_block': { $instances: [] },
        '/pru_blocks/application_specific/ipc_shared_mem_block': {
            $instances: [ipcInst('shared_write', 'encoder_data', true)]
        }
    };
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.ok(rep.errors.some((e) => /no XFR2SPIN acquire\/release pair names it/.test(e)),
        `expected the unlocked-crosscore error, got ${JSON.stringify(rep.errors)}`);
});

check('the SAME write, now locked, is clean (GREEN: fixed input)', () => {
    const modules = {
        '/pru_blocks/pru_io_blocks/xfr2spin_block': {
            $instances: [
                spinInst('lock_acquire', 'acquire', 7, 'encoder_data'),
                spinInst('lock_release', 'release', 7, 'encoder_data')
            ]
        },
        '/pru_blocks/application_specific/ipc_shared_mem_block': {
            $instances: [ipcInst('shared_write', 'encoder_data', true)]
        }
    };
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.deepStrictEqual(rep.errors, [], `a matched lock around the write must be clean, got ${JSON.stringify(rep.errors)}`);
});

// ---------------------------------------------------------------------------
// Mutation red arm on the SAME fixture: start from the clean/locked design
// above and mutate exactly one field at a time. Each mutation must turn the
// validator's verdict from clean back to an error - proving the guard is
// live, not a validator that always returns [] regardless of input (the
// shape of the first rejected attempt, which passed a design with
// two unprotected writes and a dangling release on an unrelated lock id).
// ---------------------------------------------------------------------------
function lockedDesign() {
    return {
        '/pru_blocks/pru_io_blocks/xfr2spin_block': {
            $instances: [
                spinInst('lock_acquire', 'acquire', 7, 'encoder_data'),
                spinInst('lock_release', 'release', 7, 'encoder_data')
            ]
        },
        '/pru_blocks/application_specific/ipc_shared_mem_block': {
            $instances: [ipcInst('shared_write', 'encoder_data', true)]
        }
    };
}

check('mutation: delete the release -> dangling acquire is caught', () => {
    const modules = lockedDesign();
    modules['/pru_blocks/pru_io_blocks/xfr2spin_block'].$instances =
        modules['/pru_blocks/pru_io_blocks/xfr2spin_block'].$instances.filter((i) => i.$name !== 'lock_release');
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.ok(rep.errors.some((e) => /nothing in this design releases it/.test(e)),
        `expected the dangling-acquire error, got ${JSON.stringify(rep.errors)}`);
});

check('mutation: release names a different lock id -> mismatch is caught', () => {
    const modules = lockedDesign();
    const rel = modules['/pru_blocks/pru_io_blocks/xfr2spin_block'].$instances.find((i) => i.$name === 'lock_release');
    rel.lockId = 3;
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.ok(rep.errors.some((e) => /which no acquire in this design takes/.test(e)),
        `expected the lock-id-mismatch error, got ${JSON.stringify(rep.errors)}`);
});

check('mutation: guard protects a DIFFERENT variable -> the write reads as unlocked again', () => {
    const modules = lockedDesign();
    for (const s of modules['/pru_blocks/pru_io_blocks/xfr2spin_block'].$instances) s.protectsVariable = 'other_variable';
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.ok(rep.errors.some((e) => /no XFR2SPIN acquire\/release pair names it/.test(e)),
        `a lock that protects a different variable must not clear this write, got ${JSON.stringify(rep.errors)}`);
});

check('mutation: two guards disagree on lock id -> flagged even though both exist', () => {
    const modules = lockedDesign();
    modules['/pru_blocks/pru_io_blocks/xfr2spin_block'].$instances.push(
        spinInst('lock_acquire_2', 'acquire', 9, 'encoder_data'),
        spinInst('lock_release_2', 'release', 9, 'encoder_data')
    );
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.ok(rep.errors.some((e) => /guarded by more than one lock id/.test(e)),
        `expected the multi-lock-id error, got ${JSON.stringify(rep.errors)}`);
});

check('single-writer region (crossCoreWriters false) needs no lock at all', () => {
    const modules = {
        '/pru_blocks/pru_io_blocks/xfr2spin_block': { $instances: [] },
        '/pru_blocks/application_specific/ipc_shared_mem_block': {
            $instances: [ipcInst('solo_write', 'private_data', false)]
        }
    };
    const validate = loadValidator(modules);
    const rep = report();
    validate({}, rep);
    assert.deepStrictEqual(rep.errors, [], `an unclaimed single-writer region must not require a lock, got ${JSON.stringify(rep.errors)}`);
});

console.log(`validateXfr2spinGlobal: ${checks} checks passed`);
