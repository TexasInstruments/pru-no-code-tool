'use strict';
/**
 * Run the real `iqmath_pid_block` macro against the independent
 * reference model in `scripts/pid_reference_vectors.js`.
 *
 * The ledger cited `testPid()` as this block's evidence. That function never
 * existed, and the block declared `simulator-tested` on the strength of it.
 * This is the harness that earns the rung honestly.
 *
 * The block is stateful: STATE_PTR points at 16 bytes of DMEM laid out as
 * [Integral, Prev_Error, Error, Derivative]. So a single input pair proves
 * nothing - each vector is a SEQUENCE, replayed step by step with the state
 * carried in memory exactly as firmware would.
 *
 * Usage:  node scripts/pid_cosim.js
 * Exit:   0 pass, 1 mismatch, 2 harness failure.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { splitLabel } = require('./asm_label');

const ROOT = path.join(__dirname, '..');
const SIM_DIR = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'simulation');
const BLOCK = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'data_handling', 'iqmath_pid_block.syscfg.js');
const STATE_PTR = 0x100;          // 16 bytes of DMEM0, clear of anything else
const Q = 4096;

function loadCore() {
  const cache = {};
  function ls(p) {
    const sb = {
      console, Math, parseInt, isNaN, eval, Uint8Array, Array, JSON, DataView,
      system: { getScript: (q) => {
        const b = path.basename(q);
        if (!cache[b]) cache[b] = ls(path.join(SIM_DIR, b));
        return cache[b];
      } },
      exports: {},
    };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(p, 'utf8'), sb);
    return sb.exports;
  }
  return ls(path.join(SIM_DIR, 'pru_core.js'));
}

function loadBlock() {
  return new Function('exports', fs.readFileSync(BLOCK, 'utf8') + '\nreturn exports;')({});
}

const REG = {
  TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
  RES: 'R10', SETPOINT: 'R11', FEEDBACK: 'R12',
};

// One macro invocation, with the 16-byte state block seeded from `state` and
// read back afterwards - the firmware's own persistence path, via DMEM.
function step(core, block, { setpoint, feedback, kp, ki, kd, state }) {
  let macro = block.getMacro('m_iqmath_pid', 'm_iqmath_pid');
  for (const k of Object.keys(REG).sort((a, b) => b.length - a.length)) {
    macro = macro.split(k).join(REG[k]);
  }
  macro = macro.split('STATE_PTR').join(String(STATE_PTR))
               .split('KP').join(String(kp))
               .split('KI').join(String(ki))
               .split('KD').join(String(kd));

  const body = macro.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.includes('.macro') && !l.includes('.endm'));

  // Seed inputs and the persistent state block.
  const pro = [
    `ldi32 ${REG.SETPOINT}, ${setpoint >>> 0}`,
    `ldi32 ${REG.FEEDBACK}, ${feedback >>> 0}`,
    `ldi32 R25, ${STATE_PTR}`,
    `ldi32 R24, ${state.integral >>> 0}`, `sbbo &R24, R25, 0, 4`,
    `ldi32 R24, ${state.prevError >>> 0}`, `sbbo &R24, R25, 4, 4`,
  ];

  const instructions = [];
  const labels = [];
  let pending = 0;
  for (const line of [...pro, ...body]) {
    const parts = splitLabel(line); // Accept `label: instr` on one line
    if (!parts) continue;
    if (parts.label) pending = parts.label.replace(/\?/g, '_1');
    if (!parts.rest) continue;
    const ins = parts.rest.replace(/\?/g, '_1');
    if (!ins) continue;
    instructions.push(ins);
    labels.push(pending);
    pending = 0;
  }
  // Read the state block back into registers so it survives the run.
  instructions.push(`ldi32 R25, ${STATE_PTR}`, 'lbbo &R20, R25, 0, 4',
                    'lbbo &R21, R25, 4, 4', 'lbbo &R22, R25, 8, 4',
                    'lbbo &R23, R25, 12, 4', 'halt');
  while (labels.length < instructions.length) labels.push(0);

  const { pruState: st } = core.simulatePruInstructions(instructions, labels, 4000, {}, {});
  const s = (r) => (st.registers[r] | 0);
  return {
    u: s(10),
    state: { integral: s(20), prevError: s(21) },
    error: s(22), derivative: s(23),
    unknown: st.unknownInstruction, parseErr: st.errorParsing,
  };
}

if (require.main === module) {
  let core, block, ref;
  try {
    core = loadCore();
    block = loadBlock();
    ref = require('./pid_reference_vectors.js');
  } catch (e) {
    console.error(`HARNESS ERROR: ${e.message}`);
    process.exit(2);
  }

  const seqs = ref.sequences || (Array.isArray(ref) ? ref : Object.values(ref).find(Array.isArray));
  if (!seqs || !seqs.length) {
    console.error('HARNESS ERROR: no sequences exported by pid_reference_vectors.js');
    process.exit(2);
  }

  console.log('=== iqmath_pid_block co-sim: firmware vs independent model ===');
  console.log(`STATE_PTR=0x${STATE_PTR.toString(16)}  Q12 (${Q} == 1.0)\n`);

  const fails = [];
  let steps = 0;
  for (const seq of seqs) {
    const name = seq.name || '(unnamed)';
    const kp = seq.kp ?? seq.gains?.kp ?? Math.round(1.0 * Q);
    const ki = seq.ki ?? seq.gains?.ki ?? Math.round(0.1 * Q);
    const kd = seq.kd ?? seq.gains?.kd ?? Math.round(0.01 * Q);
    const pts = seq.steps || seq.points || [];
    let state = { integral: 0, prevError: 0 };
    let worst = 0;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const sp = p.setpoint ?? p.sp ?? 0;
      const fb = p.feedback ?? p.fb ?? 0;
      const r = step(core, block, { setpoint: sp, feedback: fb, kp, ki, kd, state });
      steps++;
      if (r.unknown) fails.push(`${name}[${i}]: ${r.unknown} unknown instruction(s)`);
      if (r.parseErr) fails.push(`${name}[${i}]: parse error`);

      // Expected values live in a parallel `expected` array, not inside `steps`.
      const exp = (seq.expected || [])[i] || {};
      const expU = exp.u;
      if (expU !== undefined) {
        const d = Math.abs(r.u - expU);
        worst = Math.max(worst, d);
        // 2 counts of 4096 is 0.05%: the block does three Q12 shift-and-add
        // products and truncates each, so exact equality is not the correct
        // expectation.
        if (d > 2) {
          fails.push(`${name}[${i}]: u firmware=${r.u} model=${expU} (delta ${d}), ` +
                     `sp=${sp} fb=${fb} e fw=${r.error}/model=${exp.e} ` +
                     `integral fw=${r.state.integral}/model=${exp.integral}`);
        }
      }
      if (exp.e !== undefined && r.error !== exp.e) {
        fails.push(`${name}[${i}]: error firmware=${r.error} model=${exp.e}`);
      }
      if (exp.integral !== undefined && r.state.integral !== exp.integral) {
        fails.push(`${name}[${i}]: integral firmware=${r.state.integral} model=${exp.integral}`);
      }
      state = r.state;
    }
    console.log(`  ${name.padEnd(26)} ${String(pts.length).padStart(2)} steps   worst |du| = ${worst}`);
  }

  console.log(`\n${steps} macro invocations across ${seqs.length} sequence(s)`);

  // --- gate self-proof -------------------------------------------------------
  // Everything above passed first time, which on its own proves nothing. Break
  // the state carry - the one thing that makes this a PID rather than a gain
  // stage - and require the comparison to go red. If this ever stops finding a
  // mismatch, the harness has stopped comparing and the green above is void.
  {
    const seq = seqs[0];
    let bad = 0;
    let st2 = { integral: 0, prevError: 0 };
    for (let i = 0; i < seq.steps.length; i++) {
      const p = seq.steps[i];
      const r = step(core, block, {
        setpoint: p.setpoint, feedback: p.feedback,
        kp: seq.kp, ki: seq.ki, kd: seq.kd, state: st2,
      });
      const exp = (seq.expected || [])[i] || {};
      if (exp.u !== undefined && Math.abs(r.u - exp.u) > 2) bad++;
      st2 = { integral: 0, prevError: 0 };   // MUTATION: drop the carried state
    }
    console.log('\n--- Gate self-proof: state carry removed, comparison must go RED ---');
    if (bad === 0) {
      fails.push('gate self-proof FAILED: dropping the integral/prev-error carry produced ' +
                 'no mismatch, so this harness is not testing the block state at all');
    } else {
      console.log(`  ${bad}/${seq.steps.length} steps mismatched - gate can fail`);
    }
  }

  if (fails.length) {
    console.error(`\nFAIL (${fails.length}):\n  ` + fails.slice(0, 10).join('\n  '));
    process.exit(1);
  }
  console.log('\nPASS: PID co-sim complete');
  process.exit(0);
}

module.exports = { step, STATE_PTR };
