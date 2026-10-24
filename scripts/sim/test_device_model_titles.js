/**
 * Display names of the Device Model block's typed fields.
 *
 * The block builds one field per pin and parameter of every device kind from
 * device_model_table.js, so their display names come from the table rather
 * than from literal strings in the block. SysConfig's metadata sanity tests
 * check every display name against the tool's UI convention: at most 36
 * characters, and every word capitalized - first letter upper case or a digit,
 * the rest all lower case or all upper case (an acronym) - except "to",
 * "from", "for", "of", "by" and "in". A word in parentheses, or one that
 * contains "-" or "&", is accepted as it is.
 *
 * This test applies the same rule to every field the table produces, so a new
 * kind or parameter whose label does not convert is caught here.
 */
'use strict';

const path = require('path');
const assert = require('assert');

global.system = { getScript: () => ({}) };
const table = require(path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                                'pru_blocks', 'common', 'device_model_table.js'));

const LOWER_WORDS = ['to', 'from', 'for', 'of', 'by', 'in'];
const WORD = /(\b([A-Z0-9])([A-Z0-9&._-]+s?|[a-z0-9&._-]+)?)|\(.*\)|[&-]/;
const MAX_LENGTH = 36;

function problems(name) {
    const out = [];
    if (name.length > MAX_LENGTH) out.push(`longer than ${MAX_LENGTH} characters`);
    const bad = name.split(' ').filter(w => !(WORD.test(w) || LOWER_WORDS.includes(w)));
    if (bad.length) out.push(`not capitalized: ${bad.join(', ')}`);
    return out;
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('the rule rejects sentence-case and over-long names', () => {
    assert.deepStrictEqual(problems('DATA Pin'), []);
    assert.deepStrictEqual(problems('Cycles Per Count (0=Stationary)'), []);
    assert.ok(problems('Cycles per count').length);
    assert.ok(problems('Payload Bytes (Comma Separated, 0-255; Empty Default)').length);
});

test('every pin and parameter field has a conforming display name', () => {
    const failures = [];
    for (const kind of Object.keys(table.KINDS)) {
        for (const pf of table.pinFields(kind).concat(table.paramFields(kind))) {
            const name = table.displayTitle(pf.spec);
            const p = problems(name);
            if (p.length) failures.push(`${pf.field} "${name}": ${p.join('; ')}`);
        }
    }
    assert.deepStrictEqual(failures, []);
});

test('a title, when given, replaces the converted label', () => {
    assert.strictEqual(table.displayTitle({ label: 'MISO pin (device drives)', title: 'MISO Pin' }), 'MISO Pin');
    assert.strictEqual(table.displayTitle({ label: 'Bit period (cycles)' }), 'Bit Period (cycles)');
    assert.strictEqual(table.displayTitle({ label: 'DIR level for positive steps' }), 'DIR Level for Positive Steps');
});

let failed = 0;
for (const [name, fn] of cases) {
    try {
        fn();
        console.log(`ok   - ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`FAIL - ${name}\n       ${e.message}`);
    }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
