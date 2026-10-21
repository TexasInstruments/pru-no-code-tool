'use strict';
/**
 * SVPWM co-sim harness.
 *
 * Runs the REAL `svpwm_block` macro on the TI JS PRU core and checks its outputs
 * against an independently-derived model. Same strategy as the BiSS-C and SSI
 * co-sims, adapted for a compute block: `svpwm_block` drives no pins, so there is
 * no bus to resolve and no peer node — inputs arrive in registers and the result
 * is read back out of registers.
 *
 * IMPORTANT — why this file exists at all. `scripts/svpwm_reference_vectors.js`
 * was authored against the textbook sector/Ta/Tb/T0 parameterisation. The block
 * does not implement that. It implements min-max (zero-sequence injection)
 * SVPWM: compute the three phase references, subtract the midpoint of their max
 * and min, scale by PERIOD. The two are mathematically equivalent as modulation
 * strategies but are NOT the same numbers, so those vectors cannot be compared to
 * this block's outputs directly. They remain valid as a check on the sector
 * boundaries, which is how they are used here.
 *
 * Usage:  node scripts/svpwm_cosim.js
 * Exit:   0 all checks pass, 1 a check failed, 2 the harness itself failed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { splitLabel } = require('./asm_label');

const ROOT = path.join(__dirname, '..');
const SIM_DIR = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'simulation');
const BLOCK = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'data_handling', 'svpwm_block.syscfg.js');

// pru_core.js is a SysConfig script: it pulls its siblings through the `system`
// global rather than require(), so it has to be run in a sandbox that provides
// system.getScript. Loading it with plain require/new Function fails with
// "system is not defined". Kept self-contained here rather than importing the
// workspace's tools/bus-cosim/ti-cosim.js, so this repo stays standalone.
function loadCore() {
  const cache = {};
  function loadScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
      console, Math, parseInt, isNaN, eval, Uint8Array, Array, JSON, DataView,
      system: {
        getScript: (p) => {
          const base = path.basename(p);
          if (!cache[base]) cache[base] = loadScript(path.join(SIM_DIR, base));
          return cache[base];
        },
      },
      exports: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.exports;
  }
  return loadScript(path.join(SIM_DIR, 'pru_core.js'));
}

function loadBlock() {
  // The module ends with `exports = svpwmModule;` — it REBINDS the parameter
  // rather than mutating it, so an object passed in by the caller never sees the
  // assignment. Return the rebound local instead. (The BiSS-C co-sim gets away
  // with `return bissCModule` only because it hardcodes that module's own
  // internal variable name; reading `exports` back works for any block.)
  const code = fs.readFileSync(BLOCK, 'utf8') + '\nreturn exports;';
  return new Function('exports', code)({});
}

// Q12: 4096 == 1.0
const Q = 4096;

// ---------------------------------------------------------------------------
// Independent model. Derived from the min-max SVPWM definition, NOT read off the
// block's assembly. Uses exact Math.sqrt(3) and exact division, so it does not
// inherit the block's shift-and-add approximation of sqrt(3) — that divergence is
// precisely what we want to be able to measure.
// ---------------------------------------------------------------------------
function modelDuties(alphaQ, betaQ, period, deadtime) {
  const va = alphaQ;
  const vb = (-alphaQ + Math.sqrt(3) * betaQ) / 2;
  const vc = (-alphaQ - Math.sqrt(3) * betaQ) / 2;

  const mx = Math.max(va, vb, vc);
  const mn = Math.min(va, vb, vc);
  const offset = -(mx + mn) / 2;

  // Scale is 2*Q, not Q: a Q12 command of 4096 means the full DC link, and a
  // phase reference spans +/-Vdc/2 about the centre. The firmware does this with
  // `lsr TEMP_REG3, TEMP_REG3, 13` after the MAC — a shift of 13, i.e. /8192 —
  // where a Q12 scale alone would be a shift of 12. Getting this wrong makes the
  // model saturate everywhere and reports ~300-count errors against correct
  // firmware.
  const half = Math.floor(period / 2);
  const raw = [va, vb, vc].map((v) => half + ((v + offset) * period) / (2 * Q));
  const duties = raw.map((d) => Math.min(Math.max(d, deadtime), period - deadtime));

  return { va, vb, vc, offset, raw, duties };
}

// Sector straight from the commanded angle: sector k spans [60(k-1), 60k).
// Deliberately NOT derived from the phase-ordering comparisons the firmware uses
// - reimplementing the block's own decision tree would make this a mirror, not an
// oracle, and it would agree with the firmware even when both are wrong.
function modelSectorFromAngle(deg) {
  const d = ((deg % 360) + 360) % 360;
  return Math.floor(d / 60) + 1;
}

// ---------------------------------------------------------------------------
// Firmware
// ---------------------------------------------------------------------------
const REG = {
  OUT_A: 'R10', OUT_B: 'R11', OUT_C: 'R12', SECTOR: 'R13', SAMPLE: 'R14',
  ALPHA: 'R15', BETA: 'R16',
  TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
};

function buildProgram(block, alphaQ, betaQ, period, deadtime) {
  let macro = block.getMacro('m_svpwm_duty', 'm_svpwm_duty');

  // Order matters: TEMP_REG1..4 must be substituted before the shorter names
  // would ever match, and OUT_A/B/C before ALPHA/BETA for the same reason.
  for (const [name, reg] of Object.entries(REG)) {
    macro = macro.split(name).join(reg);
  }
  macro = macro
    .split('PERIOD').join(String(period))
    .split('DEADTIME').join(String(deadtime));

  const body = macro.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.includes('.macro') && !l.includes('.endm'));

  // Seed the two inputs. The core zeroes all registers and offers no way to
  // inject initial state, so the loads are prepended as real instructions.
  const prologue = [
    `ldi32 ${REG.ALPHA}, ${alphaQ >>> 0}`,
    `ldi32 ${REG.BETA}, ${betaQ >>> 0}`,
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

function runFirmware(core, block, alphaQ, betaQ, period, deadtime) {
  const { instructions, labels } = buildProgram(block, alphaQ, betaQ, period, deadtime);
  // Returns {pruState, r30ValueHistory, r31ValueHistory} — not the state directly.
  const { pruState: st } = core.simulatePruInstructions(instructions, labels, 4000, {}, {});
  const s = (r) => (st.registers[r] | 0);
  return {
    a: s(10), b: s(11), c: s(12), sector: st.registers[13] >>> 0,
    cycles: st.cycles, instrCount: instructions.length,
    unknown: st.unknownInstruction, parseErr: st.errorParsing,
  };
}

// The core's loop is `while (cycles < cycleCount && pc < instructions.length)`,
// and `halt` does not advance pc, so a completed program spins on its halt and
// burns cycles until the cap. `pruState.cycles` is therefore ALWAYS the cap and
// is never a measurement - reporting it as the block's cycle budget is exactly
// the error that made the SSI co-sim claim 5001 cycles for a 609-cycle
// transaction. Measure instead by finding the smallest cap at which the outputs
// have already reached their converged values.
function measureCycles(core, block, alphaQ, betaQ, period, deadtime) {
  const { instructions, labels } = buildProgram(block, alphaQ, betaQ, period, deadtime);
  const at = (cap) => {
    const { pruState: st } = core.simulatePruInstructions(instructions, labels, cap, {}, {});
    return [10, 11, 12, 13].map((r) => st.registers[r] | 0).join(',');
  };
  const settled = at(4000);
  let lo = 1;
  let hi = 4000;
  if (at(hi) !== settled) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid) === settled) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
module.exports = {
  modelDuties, modelSectorFromAngle, buildProgram, runFirmware,
  measureCycles, loadCore, loadBlock, Q,
};

if (require.main === module) {
  let core, block;
  try {
    core = loadCore();
    block = loadBlock();
  } catch (e) {
    console.error(`HARNESS ERROR: ${e.message}`);
    process.exit(2);
  }

  const PERIOD = 1000;
  const DEADTIME = 10;
  const fails = [];

  // Sweep the full electrical revolution at a modulation depth inside the
  // linear range. 24 points at 15 degrees covers every sector and both of each
  // sector's boundaries.
  console.log('=== SVPWM co-sim: firmware vs independent model ===');
  console.log(`PERIOD=${PERIOD} DEADTIME=${DEADTIME}  m=0.8, 24 points over 360 deg\n`);
  console.log('  deg  sector fw/model      duties fw            duties model         maxerr');

  let worstErr = 0;
  let cycles = 0;
  let instrCount = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg * Math.PI) / 180;
    const m = 0.8;
    const alphaQ = Math.round(m * Q * Math.cos(rad));
    const betaQ = Math.round(m * Q * Math.sin(rad));

    const fw = runFirmware(core, block, alphaQ, betaQ, PERIOD, DEADTIME);
    const md = modelDuties(alphaQ, betaQ, PERIOD, DEADTIME);
    instrCount = fw.instrCount;

    if (fw.unknown) fails.push(`deg=${deg}: core hit ${fw.unknown} unknown instruction(s)`);
    if (fw.parseErr) fails.push(`deg=${deg}: core reported a parse error`);

    const err = Math.max(
      Math.abs(fw.a - md.duties[0]),
      Math.abs(fw.b - md.duties[1]),
      Math.abs(fw.c - md.duties[2]),
    );
    worstErr = Math.max(worstErr, err);

    // On an exact sector boundary two phase references are equal, and the
    // firmware's >= comparisons settle the tie toward the lower sector. Both
    // answers are defensible there, so accept either; everywhere else demand an
    // exact match.
    const mdSector = modelSectorFromAngle(deg);
    const onBoundary = deg % 60 === 0;
    const prevSector = ((mdSector + 4) % 6) + 1;
    const sectorOk = onBoundary
      ? (fw.sector === mdSector || fw.sector === prevSector)
      : fw.sector === mdSector;
    if (!sectorOk) {
      fails.push(`deg=${deg}: sector firmware=${fw.sector} model=${mdSector}`);
    }
    // 4 counts of 1000 is 0.4%. The block approximates sqrt(3) as
    // 1+1/2+1/8+1/16+1/32+1/128+1/256 = 1.73046875 (vs 1.7320508, 0.09% low) and
    // truncates on every shift, so an exact match is not the correct expectation.
    if (err > 4) {
      fails.push(`deg=${deg}: duty error ${err} counts exceeds 4 ` +
                 `(fw=[${fw.a},${fw.b},${fw.c}] model=[${md.duties.map((d) => d.toFixed(1))}])`);
    }

    console.log(
      `  ${String(deg).padStart(3)}   ${fw.sector}/${mdSector}      ` +
      `[${String(fw.a).padStart(4)},${String(fw.b).padStart(4)},${String(fw.c).padStart(4)}]   ` +
      `[${md.duties.map((d) => String(Math.round(d)).padStart(4)).join(',')}]   ${err.toFixed(1)}`
    );
  }

  console.log(`\nworst duty error over the revolution: ${worstErr.toFixed(1)} counts of ${PERIOD}`);
  const measured = measureCycles(core, block, Math.round(0.8 * Q), 0, PERIOD, DEADTIME);
  const bound = 180;
  console.log(`measured cycle budget: ${measured} cycles for ${instrCount} instructions ` +
              `(block metadata declares a conservative bound of ${bound})`);
  if (measured === null) {
    fails.push('cycle budget: outputs never settled inside the 4000-cycle cap');
  } else if (measured > bound) {
    fails.push(`cycle budget: measured ${measured} exceeds the declared bound of ${bound}`);
  }

  // --- Negative 1: saturation ------------------------------------------------
  // A commanded vector well outside the inscribed circle must clamp, not wrap.
  // Wrapping shows up as a duty outside [DEADTIME, PERIOD-DEADTIME].
  console.log('\n--- Negative: saturation (m=2.0, far outside the linear range) ---');
  let satViolations = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg * Math.PI) / 180;
    const alphaQ = Math.round(2.0 * Q * Math.cos(rad));
    const betaQ = Math.round(2.0 * Q * Math.sin(rad));
    const fw = runFirmware(core, block, alphaQ, betaQ, PERIOD, DEADTIME);
    for (const [nm, v] of [['A', fw.a], ['B', fw.b], ['C', fw.c]]) {
      if (v < DEADTIME || v > PERIOD - DEADTIME) {
        satViolations++;
        if (satViolations <= 3) {
          console.log(`  deg=${deg} duty${nm}=${v} outside [${DEADTIME}, ${PERIOD - DEADTIME}]`);
        }
      }
    }
  }
  if (satViolations) fails.push(`saturation: ${satViolations} duty value(s) escaped the clamp`);
  else console.log(`  all 72 duties clamped inside [${DEADTIME}, ${PERIOD - DEADTIME}]`);

  // --- Negative 2: dead-time / shoot-through ---------------------------------
  // Complementary pairs are derived from these duties, so a duty of 0 or PERIOD
  // means the high and low device of that leg are commanded on together.
  console.log('\n--- Negative: shoot-through (no duty may reach 0 or PERIOD) ---');
  let stViolations = 0;
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    for (const m of [0.2, 0.8, 1.0, 1.5]) {
      const alphaQ = Math.round(m * Q * Math.cos(rad));
      const betaQ = Math.round(m * Q * Math.sin(rad));
      const fw = runFirmware(core, block, alphaQ, betaQ, PERIOD, DEADTIME);
      for (const v of [fw.a, fw.b, fw.c]) {
        if (v <= 0 || v >= PERIOD) stViolations++;
      }
    }
  }
  if (stViolations) fails.push(`shoot-through: ${stViolations} duty value(s) reached a rail`);
  else console.log('  864 duties across 4 modulation depths, none reached a rail');

  // --- Prove the shoot-through gate can actually go red ----------------------
  // A negative test that has only ever been seen passing is not evidence. Drive
  // the real design constant (dead-time) to zero and require the same scan to
  // report violations. If this ever stops finding them, the scan has stopped
  // checking anything and the green above is worthless.
  console.log('\n--- Gate self-proof: dead-time forced to 0, shoot-through scan must go RED ---');
  let mutantViolations = 0;
  for (let deg = 0; deg < 360; deg += 5) {
    for (const m of [0.2, 0.8, 1.0, 1.5]) {
      const rad = (deg * Math.PI) / 180;
      const fw = runFirmware(core, block,
        Math.round(m * Q * Math.cos(rad)), Math.round(m * Q * Math.sin(rad)), PERIOD, 0);
      for (const v of [fw.a, fw.b, fw.c]) if (v <= 0 || v >= PERIOD) mutantViolations++;
    }
  }
  if (mutantViolations === 0) {
    fails.push('gate self-proof FAILED: with dead-time 0 the shoot-through scan still ' +
               'found nothing, so it cannot detect a rail and its green result means nothing');
  } else {
    console.log(`  dead-time 0 produced ${mutantViolations} rail violations - gate can fail`);
  }

  if (fails.length) {
    console.error(`\nFAIL (${fails.length}):\n  ` + fails.slice(0, 12).join('\n  '));
    process.exit(1);
  }
  console.log('\nPASS: SVPWM co-sim complete');
  process.exit(0);
}
