#!/usr/bin/env node
/**
 * Enumerate every `.if` / `.elseif` in every block macro the dual-oracle
 * harness can expand, and check the harness's evaluation of each against an independent
 * one (the JS engine evaluating the same substituted expression).
 *
 * Each block's macro is built with its config defaults. A condition falls in one class:
 *   param    - after substituting the macro's own parameters it is a pure numeric
 *              expression; the harness result is compared with JS's.
 *   symbol   - it names assembler symbols (.set/.asg), which the harness has no table
 *              for; not decidable here (reported, not claimed).
 *   defined  - `$isdefed(...)` / `$defined(...)` guard; not decidable here.
 *
 * Usage: node scripts/enumerate_harness_conditions.js [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./dual_oracle_harness');

const ROOT = path.join(__dirname, '..', '.metadata', 'sysconfig', '.meta', 'pru_blocks');

// Numeric option values for blocks whose config defaults are strings or placeholders. Each
// entry is one scenario; a block with several scenarios is evaluated under all of them.
const SCENARIOS = {
    'program_control/event_block': [0, 1, 2].map(mode => ({ mode, inputEventBit: 3, outputEvent: 20, clearAfterWait: 1 }))
        .concat([{ mode: 0, inputEventBit: 3, outputEvent: 20, clearAfterWait: 0 }]),
    'utils/iep_block': [[0, 1], [0, 0], [1, 0], [2, 0]].map(([func, autoReset]) => ({ func, autoReset, counts: 40, cmpIndex: 0 })),
    'utils/logic_analyzer_block': [1, 2, 0].map(triggerSlope => ({ triggerSlope, periodCycles: 20, bufferSize: 64, triggerPin: 3 })),
    'program_control/scheduler_block': [{ task1: 0, task2: 1, task3: 31, task4: 255 }, { task1: 10, task2: 11, task3: 40, task4: 12 }],
    'data_handling/trigger_router_block': [{ route1: 30, route2: 31, route3: 5, route4: 255 }, { route1: 31, route2: 30, route3: 40, route4: 7 }],
};

function enumerate() {
    const rows = [];
    for (const dir of fs.readdirSync(ROOT).sort()) {
        const full = path.join(ROOT, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const file of fs.readdirSync(full).sort()) {
            if (!file.endsWith('.syscfg.js')) continue;
            const block = file.replace('.syscfg.js', '');
            let mod, text;
            try { mod = h.loadBlockModule(block, dir); text = mod.getMacro('', 'm_' + block); } catch (e) { continue; }
            const lines = text.split('\n');
            const hdr = lines.find(l => l.includes('.macro'));
            const params = hdr ? hdr.split('.macro')[1].split(',').map(p => p.trim()) : [];
            const defaults = Object.fromEntries((mod.config || []).map(c => [c.name, c.default]));
            const scenarios = (SCENARIOS[`${dir}/${block}`] || [{}]).map(sc => {
                const mapping = {};
                for (const p of params) {
                    if (sc[p] !== undefined) mapping[p] = String(sc[p]);
                    else if (defaults[p] !== undefined) mapping[p] = String(defaults[p]);
                }
                return { args: sc, mapping };
            });
            lines.forEach((l, i) => {
                const t = l.trim();
                if (!/^\.(if|elseif)\b/.test(t)) return;
                const kind = t.startsWith('.elseif') ? '.elseif' : '.if';
                const raw = t.slice(kind.length);
                const cond = h.stripAsmComment(raw).trim();
                const row = { block: `${dir}/${block}`, line: i + 1, text: t, kind, cond };
                const subst = sc => {
                    let r = cond;
                    for (const [k, v] of Object.entries(sc.mapping)) r = r.replace(new RegExp('\\b' + k + '\\b', 'g'), v);
                    return r;
                };
                if (/\$(isdefed|defined)/.test(cond)) {
                    row.cls = 'defined';
                } else if (scenarios.some(sc => /[A-Za-z_]/.test(subst(sc)))) {
                    row.cls = 'symbol';
                } else {
                    row.cls = 'param';
                    row.results = scenarios.map(sc => ({
                        args: sc.args,
                        harness: h.evalCondition(raw, sc.mapping),
                        expected: !!Function('"use strict"; return (' + subst(sc) + ');')(),
                    }));
                }
                rows.push(row);
            });
        }
    }
    return rows;
}

if (require.main === module) {
    const rows = enumerate();
    if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
    else for (const r of rows) {
        const res = r.cls === 'param'
            ? r.results.map(x => `${x.harness}${x.harness === x.expected ? '' : '!=js:' + x.expected}`).join('/') + (r.results.every(x => x.harness === x.expected) ? ' OK' : ' MISMATCH')
            : '(not decidable here)';
        console.log(`${r.cls.padEnd(7)} ${r.block}:${r.line}  ${r.text}  -> ${res}`);
    }
}
module.exports = { enumerate };
