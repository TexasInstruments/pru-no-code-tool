/**
 * lut_cycles.js - print the access_look_up_table block's reported
 * noOfCycles for each referenced-table dataType.
 *
 *   node scripts/sim/lut_cycles.js
 *   -> {"byte":5,"ushort":7,"uint":7}
 *
 * Reads the block's own cycle model (the config getValue); it is a DUT
 * driver, not an oracle. tests/test_access_lut_index_scaling.py
 * compares it with the cycles the TI pru-simulator actually spends.
 */
'use strict';
const { loadBlockModule } = require('../dual_oracle_harness.js');

const mod = loadBlockModule('access_look_up_table', 'utils');
const cfg = mod.config.find((c) => c.name === 'noOfCycles');
const out = {};
for (const dataType of ['byte', 'ushort', 'uint']) {
    out[dataType] = cfg.getValue({ lutTable: { $name: 'T', dataType } });
}
process.stdout.write(JSON.stringify(out));
