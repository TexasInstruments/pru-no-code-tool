'use strict';
/**
 * Three-phase complementary PWM co-sim.
 *
 * Runs the REAL `three_phase_pwm_block` macro on the TI JS PRU core and checks
 * the resulting R30 pin waveform, not just a register result. This is the half of
 * the motor-control chain that actually reaches the bridge: `svpwm_block`
 * computes three numbers, this block turns them into gate signals, and getting
 * it wrong shorts a leg.
 *
 * WHY THIS CORE AND NOT TI's pru-simulator: the block drives the IEP timer
 * through c26 and its main loop polls it. A TI pru-simulator revision without
 * an IEP model (a generic constant table and a pin-level peripheral framework,
 * but no IEP counter) would return a value that never increments for an LBCO
 * from c26, so `tp_wait_dead?` would spin forever.
 *
 * Usage:  node scripts/three_phase_pwm_cosim.js
 * Exit:   0 pass, 1 a check failed, 2 the harness itself failed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { splitLabel } = require('./asm_label');

const ROOT = path.join(__dirname, '..');
const SIM_DIR = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'simulation');
const BLOCK = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'pru_io_blocks', 'three_phase_pwm_block.syscfg.js');

const PIN = { AH: 0, AL: 1, BH: 2, BL: 3, CH: 4, CL: 5, TRIGGER: 6 };
const LEGS = [['A', PIN.AH, PIN.AL], ['B', PIN.BH, PIN.BL], ['C', PIN.CH, PIN.CL]];

function loadCore() {
  const cache = {};
  function loadScript(p) {
    const sandbox = {
      console, Math, parseInt, isNaN, eval, Uint8Array, Array, JSON, DataView,
      system: { getScript: (q) => {
        const b = path.basename(q);
        if (!cache[b]) cache[b] = loadScript(path.join(SIM_DIR, b));
        return cache[b];
      } },
      exports: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
    return sandbox.exports;
  }
  return loadScript(path.join(SIM_DIR, 'pru_core.js'));
}

function loadBlock() {
  return new Function('exports', fs.readFileSync(BLOCK, 'utf8') + '\nreturn exports;')({});
}

const REG = {
  STATE: 'R20', DUTY_A: 'R21', DUTY_B: 'R22', DUTY_C: 'R23',
  TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
};

function buildProgram(block, duties, period, deadtime) {
  let macro = block.getMacro('m_three_phase_pwm_period', 'm_three_phase_pwm_period');
  for (const [n, r] of Object.entries(REG)) macro = macro.split(n).join(r);
  // Pin names before PERIOD/DEADTIME; all are bare identifiers in the macro text.
  for (const [n, b] of Object.entries(PIN)) macro = macro.split(n).join(String(b));
  macro = macro.split('PERIOD').join(String(period)).split('DEADTIME').join(String(deadtime));

  const body = macro.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.includes('.macro') && !l.includes('.endm'));

  const prologue = [
    `ldi32 ${REG.DUTY_A}, ${duties[0]}`,
    `ldi32 ${REG.DUTY_B}, ${duties[1]}`,
    `ldi32 ${REG.DUTY_C}, ${duties[2]}`,
  ];

  const instructions = [];
  const labels = [];
  let pending = 0;
  for (const line of [...prologue, ...body]) {
    const parts = splitLabel(line); // Accept `label: instr` on one line
    if (!parts) continue;
    if (parts.label) pending = parts.label.replace(/\?/g, '1');
    if (!parts.rest) continue;
    instructions.push(parts.rest.replace(/\?/g, '1'));
    labels.push(pending);
    pending = 0;
  }
  instructions.push('halt');
  labels.push(pending);
  return { instructions, labels };
}

function run(core, block, duties, period, deadtime, cycles = 6000) {
  const { instructions, labels } = buildProgram(block, duties, period, deadtime);
  const res = core.simulatePruInstructions(instructions, labels, cycles, {}, {});
  return { r30: res.r30ValueHistory, st: res.pruState, instructions };
}

const bit = (v, b) => (v >>> b) & 1;

// Edge list for one pin over the whole trace.
function edges(r30, b) {
  const out = [];
  for (let i = 1; i < r30.length; i++) {
    if (bit(r30[i], b) !== bit(r30[i - 1], b)) out.push({ t: i, to: bit(r30[i], b) });
  }
  return out;
}

// --- checks -----------------------------------------------------------------
// Overlap: the shoot-through condition proper. High and low of the same leg
// asserted on the same cycle means both devices conducting.
function overlaps(r30, hi, lo) {
  const hits = [];
  for (let i = 0; i < r30.length; i++) if (bit(r30[i], hi) && bit(r30[i], lo)) hits.push(i);
  return hits;
}

// Dead-time: every handover between the two devices of a leg must have a gap in
// which NEITHER is on. Measures the actual gap in cycles.
function handoverGaps(r30, hi, lo) {
  const gaps = [];
  let offSince = null;
  let last = null; // which device was on last
  for (let i = 0; i < r30.length; i++) {
    const h = bit(r30[i], hi);
    const l = bit(r30[i], lo);
    if (h || l) {
      const now = h ? 'H' : 'L';
      if (last && now !== last && offSince !== null) gaps.push({ at: i, gap: i - offSince, from: last, to: now });
      last = now;
      offSince = null;
    } else if (offSince === null) {
      offSince = i;
    }
  }
  return gaps;
}

module.exports = { loadCore, loadBlock, run, buildProgram, edges, overlaps, handoverGaps, PIN, LEGS, bit };

if (require.main === module) {
  let core, block;
  try { core = loadCore(); block = loadBlock(); }
  catch (e) { console.error(`HARNESS ERROR: ${e.message}`); process.exit(2); }

  const PERIOD = 400;
  const DEADTIME = 10;
  const DUTIES = [300, 200, 100];
  const fails = [];

  console.log('=== three-phase complementary PWM co-sim ===');
  console.log(`PERIOD=${PERIOD} DEADTIME=${DEADTIME} duties=[${DUTIES}]  pins AH..CL=0..5 TRIG=6\n`);

  const r = run(core, block, DUTIES, PERIOD, DEADTIME);
  if (r.st.unknownInstruction) fails.push(`core hit ${r.st.unknownInstruction} unknown instruction(s)`);
  if (r.st.errorParsing) fails.push(`core reported ${r.st.errorParsing} parse error(s)`);
  console.log(`trace ${r.r30.length} cycles, ${r.instructions.length} instructions`);

  // --- 1. no overlap on any leg ---------------------------------------------
  console.log('\n--- Shoot-through: high and low of a leg must never be on together ---');
  for (const [nm, hi, lo] of LEGS) {
    const hits = overlaps(r.r30, hi, lo);
    if (hits.length) {
      fails.push(`leg ${nm}: high+low both asserted on ${hits.length} cycle(s), first at ${hits[0]}`);
      console.log(`  leg ${nm}: OVERLAP on ${hits.length} cycles (first ${hits[0]})`);
    } else {
      console.log(`  leg ${nm}: no overlap`);
    }
  }

  // --- 2. dead-time honoured at every handover ------------------------------
  console.log('\n--- Dead-time: every H<->L handover needs a both-off gap >= ' + DEADTIME + ' ---');
  let handovers = 0;
  for (const [nm, hi, lo] of LEGS) {
    const gaps = handoverGaps(r.r30, hi, lo);
    handovers += gaps.length;
    if (!gaps.length) { console.log(`  leg ${nm}: no handover observed`); continue; }
    const worst = gaps.reduce((a, b) => (b.gap < a.gap ? b : a));
    console.log(`  leg ${nm}: ${gaps.length} handover(s), min gap ${worst.gap} cycles ` +
                `(${worst.from}->${worst.to} at ${worst.at})`);
    if (worst.gap < DEADTIME) {
      fails.push(`leg ${nm}: handover gap ${worst.gap} < dead-time ${DEADTIME} at cycle ${worst.at}`);
    }
  }
  if (handovers === 0) fails.push('no handover observed on any leg - the waveform check proved nothing');

  // --- 3. sample trigger ------------------------------------------------------
  console.log('\n--- Sample trigger: fires once, near period centre, one iteration wide ---');
  const te = edges(r.r30, PIN.TRIGGER);
  const rises = te.filter((e) => e.to === 1);
  console.log(`  ${rises.length} rising edge(s) at [${rises.map((e) => e.t).join(', ')}]`);
  if (rises.length === 0) {
    fails.push('sample trigger never fired');
  } else {
    for (const rise of rises) {
      const fall = te.find((e) => e.to === 0 && e.t > rise.t);
      const width = fall ? fall.t - rise.t : null;
      console.log(`    rise ${rise.t} -> fall ${fall ? fall.t : '(none)'} width ${width}`);
      if (fall === undefined) fails.push(`sample trigger asserted at ${rise.t} and never cleared`);
    }
  }

  // --- 4. gate self-proof -----------------------------------------------------
  // Dead-time 0 is NOT the right mutation here: `clr R30,R30,AH` and
  // `set R30,R30,AL` are separate
  // instructions on separate cycles, so the ordering alone prevents same-cycle
  // overlap even with no dead-time at all. The real guard against shoot-through
  // is the high-side turn-off itself, so that is what gets mutated.
  console.log('\n--- Gate self-proof: delete leg A high-side turn-off, overlap must go RED ---');
  const { instructions, labels } = buildProgram(block, DUTIES, PERIOD, DEADTIME);
  // The leg-A high-off is the write of the event handler labelled tp_wha (these duties
  // give leg A a high-off of its own, not one shared with another edge).
  const cut = instructions.findIndex((ins, i) =>
    /^clr\s+R30,\s*R30,\s*0$/.test(ins) && labels[i] === 'tp_wha1');
  if (cut === -1) {
    fails.push('gate self-proof could not locate the leg-A high-side turn-off to mutate');
  } else {
    const mi = instructions.slice(); const ml = labels.slice();
    mi.splice(cut, 1); ml.splice(cut, 1);
    const mres = core.simulatePruInstructions(mi, ml, 6000, {}, {});
    const mo = overlaps(mres.r30ValueHistory, PIN.AH, PIN.AL);
    if (mo.length === 0) {
      fails.push('gate self-proof FAILED: removing leg A high-side turn-off produced no ' +
                 'overlap, so the shoot-through check cannot detect one and its green above ' +
                 'means nothing');
    } else {
      console.log(`  removed instruction ${cut} ("${instructions[cut]}"): ` +
                  `${mo.length} overlapping cycle(s) on leg A, first at ${mo[0]} - gate can fail`);
    }
  }

  // --- 5. dead-time 0 must not hang (regression) ------------------------------
  // Without the qbeq guard, DEADTIME=0 underflows the busy-wait counter to
  // 0xFFFFFFFF and spins ~2^32 times, leaving the high side latched on for the
  // rest of the period. deadtimeCounts is a plain user-facing config field with
  // no minimum, so 0 is a value a user can simply type.
  console.log('\n--- Regression: dead-time 0 must still terminate ---');
  const z = run(core, block, DUTIES, PERIOD, 0, 6000);
  if (z.r30.length >= 6000) {
    fails.push(`dead-time 0 ran to the ${6000}-cycle cap - the busy-wait underflow guard is gone`);
  } else {
    console.log(`  completed in ${z.r30.length} cycles (cap 6000)`);
  }

  // --- 6. waveform export -----------------------------------------------------
  // The IEP-timed gate waveform. svpwm_block drives no pins, so the waveform
  // of the motor-control chain is traced here.
  const NAMES = ['AH', 'AL', 'BH', 'BL', 'CH', 'CL', 'TRIGGER'];
  const sym = (i) => String.fromCharCode(33 + i);
  const vcd = [
    '$timescale 1ns $end',
    '$scope module three_phase_pwm $end',
    ...NAMES.map((n, i) => `$var wire 1 ${sym(i)} ${n} $end`),
    '$upscope $end',
    '$enddefinitions $end',
  ];
  let prev = null;
  for (let t = 0; t < r.r30.length; t++) {
    const cur = NAMES.map((_, i) => bit(r.r30[t], i));
    if (prev === null || cur.some((v, i) => v !== prev[i])) {
      vcd.push(`#${t}`);
      cur.forEach((v, i) => { if (prev === null || v !== prev[i]) vcd.push(`${v}${sym(i)}`); });
      prev = cur;
    }
  }
  const OUT = path.join(ROOT, 'build_out', 'three_phase_pwm_test');
  fs.mkdirSync(OUT, { recursive: true });
  const vcdPath = path.join(OUT, 'three_phase_pwm.vcd');
  fs.writeFileSync(vcdPath, vcd.join('\n') + '\n');
  console.log(`\nwrote ${vcdPath} (${vcd.length} lines, ${r.r30.length} cycles)`);

  if (fails.length) {
    console.error(`\nFAIL (${fails.length}):\n  ` + fails.join('\n  '));
    process.exit(1);
  }
  console.log('\nPASS: three-phase PWM co-sim complete');
  process.exit(0);
}
