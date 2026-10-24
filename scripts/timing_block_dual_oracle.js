'use strict';
/**
 * Dual-oracle the IEP timing blocks.
 *
 * Emits each block's generated macro as standalone .asm plus a JS-core R30
 * trace, so the same firmware can be replayed on TI's pru-simulator and the two
 * pin waveforms compared.
 *
 * The JS PRU core ships inside this tool, so it is not an independent oracle for
 * its own blocks. pru-simulator is, in a revision that models the IEP timer.
 *
 * KNOWN SYSTEMATIC OFFSET - do not read it as a block defect: the JS core
 * executes LDI32 in one cycle, but on silicon LDI32 assembles to two LDI, which
 * is what pru-simulator's parser does. Expect pru-simulator edges to sit later
 * by roughly the number of ldi32 executed to that point.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharedHarness = require('./dual_oracle_harness');
const { splitLabel } = require('./asm_label');

const ROOT = path.join(__dirname, '..');
const SIM_DIR = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'simulation');
const META = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');
const OUT = path.join(ROOT, 'build_out', 'dual_oracle');

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

// Some block modules touch the SysConfig `system` global at module scope (for
// device/part lookups), so they need a sandbox rather than a bare Function -
// svpwm_block and three_phase_pwm_block happen not to, which is why the earlier
// co-sims got away without one. The stub returns permissive defaults; only
// getMacro output is used here.
function loadBlock(rel) {
  const p = path.join(META, rel);
  const sb = {
    console, Math, parseInt, parseFloat, isNaN, Number, String, Array, Object,
    JSON, RegExp, Boolean, Error,
    system: {
      // Blocks call system.getScript("/common").getSelfSysCfgCoreName() at
      // module scope to work out which PRU they are on. Answer "pru0".
      getScript: () => ({
        getSelfSysCfgCoreName: () => 'pru0',
        getSelfSysCfgCoreNames: () => ['pru0'],
        getSocName: () => 'am243x',
      }),
      deviceData: { part: 'AM243x', device: 'AM243x' },
      devices: {},
      getProducts: () => [],
      getReference: () => null,
    },
    exports: {},
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(p, 'utf8') + '\n;globalThis.__blk = exports;', sb);
  return sb.__blk ?? sb.exports;
}

// Expand a macro: substitute operands, resolve .if/.else/.endif, split labels.
function expand(macro, subs) {
  let m = macro;
  // Longest names first so TEMP_REG1 is not clipped by TEMP_REG, etc.
  for (const k of Object.keys(subs).sort((a, b) => b.length - a.length)) {
    m = m.split(k).join(String(subs[k]));
  }

  const instructions = [];
  const labels = [];
  // Condition semantics belong to the shared evaluator: the old private one
  // knew only `==` and "non-empty is true". Operands are already substituted into the text,
  // so an undecidable condition here is a harness bug and fails loudly.
  const decide = (c) => {
    const r = sharedHarness.evalConditionDetailed(c, {});
    if (!r.decided) throw new Error('timing_block_dual_oracle: undecidable .if condition: ' + c);
    return r.value;
  };
  const stack = [{ active: true, taken: true, parent: true }];
  let pending = 0;

  for (const raw of m.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.includes('.macro') || line.includes('.endm')) continue;

    if (line.startsWith('.if')) {
      const parentActive = stack[stack.length - 1].active;
      const t = decide(line.replace(/^\.if\s*/, ''));
      stack.push({ active: parentActive && t, taken: t, parent: parentActive });
      continue;
    }
    if (line.startsWith('.elseif')) {
      const top = stack[stack.length - 1];
      const t = !top.taken && decide(line.substring(7));
      top.active = top.parent && t;
      top.taken = top.taken || t;
      continue;
    }
    if (line.startsWith('.else')) {
      const top = stack[stack.length - 1];
      top.active = top.parent && !top.taken;
      top.taken = true;
      continue;
    }
    if (line.startsWith('.endif')) { stack.pop(); continue; }
    if (!stack[stack.length - 1].active) continue;

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
  return { instructions, labels };
}

// --- input stimulus ----------------------------------------------------------
// R31 history maps, {cycle: value}, fed to BOTH arms so an input block is
// actually driven. Without these an input block reads a constant zero, computes
// nothing, and agrees with the other oracle because neither observed anything.

// Quadrature A/B in the 4-state Gray sequence, `period` cycles per state.
// Deliberately a real sequence and not a square wave: an encoder decoder that
// ignored the phase relationship would still see edges on a square wave.
function quadrature(aBit, bBit, period, cycles) {
  const seq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const map = {};
  for (let c = 0; c < cycles; c++) {
    const [a, b] = seq[Math.floor(c / period) % 4];
    map[c] = (a << aBit) | (b << bBit);
  }
  return map;
}

// A single pin pulsing with a fixed period, for edge-timestamping blocks.
function pulses(bit, period, cycles) {
  const map = {};
  for (let c = 0; c < cycles; c++) {
    map[c] = (Math.floor(c / period) % 2) << bit;
  }
  return map;
}

// --- the blocks under test --------------------------------------------------
// Register choices avoid R30/R31 and the TEMP_REGs the macros use internally.
const CASES = [
  {
    name: 'pwm_block',
    rel: 'pru_io_blocks/pwm_block.syscfg.js',
    opCode: 'm_pwm',
    subs: {
      TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
      PERIOD_COUNTS: '200', DUTY_COUNTS: '80', ACTIVE_HIGH: '1',
      EN_COMP: '0', COMP_PIN: '1', DEADBAND_COUNTS: '4',
      RES: 'R10', PIN: '0',
    },
    pins: { PWM: 0 },
    cycles: 3000,
  },
  {
    name: 'encoder_speed_block',
    rel: 'pru_io_blocks/encoder_speed_block.syscfg.js',
    opCode: 'm_encoder_speed',
    subs: {
      TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
      A_BIT: '0', B_BIT: '1', IS_IEP: '1',
      POS_REG: 'R10', VEL_REG: 'R11', DIR_REG: 'R12', RES: 'R13',
    },
    pins: {},
    // An INPUT block: it reads R31 and writes result registers, and drives no
    // pin at all. Comparing R30 edges therefore compares nothing, which is how
    // this case sat green while proving nothing. It needs stimulus on
    // R31 and a comparison of what it actually produces.
    r31: quadrature(0, 1, 40, 3000),
    resultRegs: { pos: 10, vel: 11, dir: 12 },
    cycles: 3000,
  },
  {
    name: 'capture_block',
    rel: 'pru_io_blocks/capture_block.syscfg.js',
    opCode: 'm_capture',
    subs: {
      TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27',
      // TRIG_SRC 1 = GPIO, not 0 = IEP. With TRIG_SRC 0 the macro polls the
      // IEP capture-valid bit (c26+0x1C bit 0) and reads CAPR0. Nothing in
      // this harness ever raises an IEP capture event - that needs a
      // capture_event() call from a device model or the runner - so the
      // block spun forever and DATA_REG stayed 0 on BOTH arms. That is why
      // this case read as vacuous: it was not under-stimulated, it was
      // waiting on an event the harness cannot produce.
      //
      // MEASURE_TYPE 0 on the GPIO path measures high-pulse width off R31,
      // which the r31 stimulus below actually drives. Exercising the IEP
      // capture path needs harness support that does not exist yet.
      TRIG_SRC: '1', MEASURE_TYPE: '0', PIN: '0', DATA_REG: 'R10', RES: 'R11',
    },
    pins: {},
    // Also an input block - it timestamps an edge on PIN and writes DATA_REG.
    // Same reason as encoder_speed_block above.
    r31: pulses(0, 120, 3000),
    resultRegs: { data: 10 },
    cycles: 3000,
  },
];

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const core = loadCore();
  const manifest = [];

  for (const c of CASES) {
    let block;
    try {
      block = loadBlock(c.rel);
    } catch (e) {
      console.log(`${c.name}: LOAD FAILED - ${e.message}`);
      continue;
    }
    const macro = block.getMacro(c.opCode, c.opCode);
    const { instructions, labels } = expand(macro, c.subs);
    instructions.push('halt');
    labels.push(0);

    // .asm for pru-simulator
    const lines = [];
    for (let i = 0; i < instructions.length; i++) {
      if (labels[i] !== 0) lines.push(labels[i] + ':');
      lines.push('    ' + instructions[i]);
    }
    fs.writeFileSync(path.join(OUT, `${c.name}.asm`), lines.join('\n') + '\n');

    // JS-core reference trace
    const r31 = c.r31 || {};
    const res = core.simulatePruInstructions(instructions, labels, c.cycles, r31, {});
    const r30 = res.r30ValueHistory;
    fs.writeFileSync(path.join(OUT, `${c.name}.js_r30.json`), JSON.stringify(r30));

    // The stimulus goes to the other arm too, or the two oracles are not
    // running the same experiment and any comparison between them is void.
    if (c.r31) {
      fs.writeFileSync(path.join(OUT, `${c.name}.r31.json`), JSON.stringify(r31));
    }
    // What an INPUT block actually produces. Pin edges are the wrong output to
    // compare for these; their answer lives in registers.
    if (c.resultRegs) {
      const regs = {};
      for (const [k, idx] of Object.entries(c.resultRegs)) {
        regs[k] = res.pruState.registers[idx] >>> 0;
      }
      fs.writeFileSync(path.join(OUT, `${c.name}.js_regs.json`), JSON.stringify(regs));
    }

    const ldi32 = instructions.filter((i) => /^ldi32/i.test(i)).length;
    const halted = res.pruState.pc >= instructions.length - 1;
    console.log(`${c.name.padEnd(22)} ${String(instructions.length).padStart(4)} instr ` +
                `(${String(ldi32).padStart(2)} ldi32)  js trace ${r30.length} cycles  ` +
                `unknownInstr=${res.pruState.unknownInstruction} parseErr=${res.pruState.errorParsing}`);
    manifest.push({ name: c.name, instructions: instructions.length, ldi32,
                    cycles: c.cycles, pins: c.pins,
                    hasR31: Boolean(c.r31), resultRegs: c.resultRegs || null });
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${manifest.length} case(s) to ${OUT}`);
}

module.exports = { expand, loadCore, loadBlock, CASES };
