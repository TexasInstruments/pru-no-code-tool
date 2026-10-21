'use strict';
/**
 * Emit every block's generated macro as standalone .asm, for cross-checking on
 * TI's pru-simulator.
 *
 * The dual-oracle work so far covered three timing blocks. This widens it to the
 * whole library so the second oracle sees every macro the tool can generate.
 *
 * Operand handling: each macro declares its operands on the `.macro` line. Names
 * that look like registers get R10.. ; names that look like numbers/flags get a
 * plausible literal. That is enough to make the macro ASSEMBLE and EXECUTE,
 * which is what this sweep tests. It is NOT a functional test - a block whose
 * operands are guessed can run and still compute nonsense. Divergence in
 * behaviour is out of scope here; the question is whether the second oracle can
 * run our firmware at all.
 *
 * Usage:  node scripts/emit_all_blocks.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharedHarness = require('./dual_oracle_harness');
const { splitLabel } = require('./asm_label');

const ROOT = path.join(__dirname, '..');
// PRU_BLOCKS_META redirects the block tree the loader enumerates (tests run the sweep against a
// planted copy of .metadata without touching the real one).
const META = process.env.PRU_BLOCKS_META
  ? path.resolve(process.env.PRU_BLOCKS_META)
  : path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');
const SIM_DIR = path.join(META, 'common', 'simulation');
// EMIT_ALL_BLOCKS_OUT redirects the written .asm tree (tests read the files the CLI writes).
const OUT = process.env.EMIT_ALL_BLOCKS_OUT || path.join(ROOT, 'build_out', 'all_blocks');

// Operands that are clearly numeric/configuration rather than registers.
const LITERAL = {
  PERIOD: 200, PERIOD_COUNTS: 200, DUTY: 80, DUTY_COUNTS: 80, DEADTIME: 10,
  DEADTIME_COUNTS: 10, DEADBAND_COUNTS: 4, TOTAL_WIDTH: 25, ST_BITS: 13,
  MT_BITS: 12, TOTAL_BITS: 30, dataBits: 8,
  ST_SHIFT: 19, MT_SHIFT: 20, CLK_PIN: 0, DATA_PIN: 1, PIN: 0,
  COMP_PIN: 1, TRIGGER: 6, AH: 0, AL: 1, BH: 2, BL: 3, CH: 4, CL: 5,
  A_BIT: 0, B_BIT: 1, IS_IEP: 1, CPOL: 0, HALF_PERIOD: 4, MONO_CYCLES: 8,
  PARITY_EN: 1, PARITY_TYPE: 0, ERR_EN: 1, GRAY_EN: 1, TIMEOUT_CYCLES: 50,
  ACTIVE_HIGH: 1, EN_COMP: 0, TRIG_SRC: 0, MEASURE_TYPE: 0, STATE_PTR: 0x100,
  KP: 4096, KI: 410, KD: 41, BIT_CYCLES: 16, NUM_BITS: 8, ADDR: 0x50,
  BAUD_CYCLES: 16, POLARITY: 0, EDGE: 0, WIDTH: 8, COUNT: 4, DELAY: 10,
  THRESHOLD: 100, MASK: 0xFF, SHIFT: 1, VALUE: 1, OFFSET: 0, INDEX: 0,
  SIZE: 4, LEN: 4, CHANNEL: 0, SLOT: 0, MODE: 0, ENABLE: 1, INVERT: 0,
  // Operands tested by `.if` guards. Every value below is the block's DEFAULT configuration,
  // so an emitted row describes the default firmware. The macro operand name is
  // not always the config name: constantN = getValue(config), shown after each group.
  //   scheduler_block task1..4 = task1_id..task4_id defaults 0, 1, 255, 255
  //   trigger_router_block route1..4 = 255 (unused sentinel)
  //   multi_axis_motion_block NUM_AXES 2, pulseWidthCycles 10 -> PULSE_K 4, PULSE_NOPS 0
  //   pdm_block SAMPLE_HIGH = constant7 getValue (channel mono -> 1)
  //   TX_BYTES/RX_BYTES 4/4 and FEAT_EN 1 are the defaults of application blocks that test these operands
  task1: 0, task2: 1, task3: 255, task4: 255, route1: 255, route2: 255, route3: 255, route4: 255,
  NUM_AXES: 2, PULSE_K: 4, PULSE_NOPS: 0, TX_BYTES: 4, RX_BYTES: 4,
  SAMPLE_HIGH: 1, FEAT_EN: 1,
};

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

// Pure helper scripts a block's getValue reads through system.getScript(), loaded for real (not
// stubbed) so the option evaluates to what SysConfig computes: pru_spi_read/transfer/
// write turn "CS Setup Time" into cycles with spiTiming.csDelayCycles.
const REAL_HELPERS = {
  'pru_spi_timing.js': path.join(META, 'common', 'pru_spi_timing.js'),
  // The Device Model block builds its typed fields from this table at load time.
  'device_model_table.js': path.join(META, 'common', 'device_model_table.js'),
  // Emitting blocks validate $name/derived symbols through this list.
  'pru_reserved_names.js': path.join(META, 'common', 'pru_reserved_names.js'),
};

function loadHelper(file) {
  const sb = { Math, Number, Object, Array, JSON, system: { modules: {} }, exports: {} };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sb);
  return sb.exports;
}

// `system.modules` is the design's other modules, keyed by path; a module absent from the design is
// undefined. The sandbox models a design that holds ONLY the block under evaluation, so every
// lookup is undefined and the block's own fallback applies (e.g. pruClkFreq 200 MHz, the static
// module's default, when "Simulation Settings" is not in `modules`).
function loadBlock(file) {
  const helpers = {};
  const sb = {
    console, Math, parseInt, parseFloat, isNaN, Number, String, Array, Object,
    JSON, RegExp, Boolean, Error, Date,
    system: {
      getScript: (q) => {
        const real = REAL_HELPERS[path.basename(String(q))];
        if (real) return helpers[real] || (helpers[real] = loadHelper(real));
        return {
          getSelfSysCfgCoreName: () => 'pru0',
          getSelfSysCfgCoreNames: () => ['pru0'],
          getSocName: () => 'am243x',
        };
      },
      modules: {},
      deviceData: { part: 'AM243x', device: 'AM243x' },
      devices: {}, getProducts: () => [], getReference: () => null,
    },
    exports: {},
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;globalThis.__blk = exports;', sb);
  return sb.__blk ?? sb.exports;
}

function allBlocks() {
  const out = [];
  for (const cat of fs.readdirSync(META)) {
    const dir = path.join(META, cat);
    if (!fs.statSync(dir).isDirectory() || cat === 'common') continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.syscfg.js')) out.push({ cat, id: f.replace('.syscfg.js', ''), file: path.join(dir, f) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function substituteValues(text, values) {
  let out = text;
  for (const [k, v] of Object.entries(values)) out = out.replace(new RegExp('\\b' + k + '\\b', 'g'), v);
  return out;
}

function expand(macro, conditionEvaluator = sharedHarness.evalConditionDetailed, literal = LITERAL) {
  // operand list from the .macro line
  const mm = macro.match(/^\s*\S+\s+\.macro\s+(.*)$/m);
  const operands = mm ? mm[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const subs = { TEMP_REG1: 'R28', TEMP_REG2: 'R29', TEMP_REG3: 'R26', TEMP_REG4: 'R27' };
  let reg = 10;
  const literalOperands = [];
  for (const o of operands) {
    if (subs[o]) continue;
    if (Object.prototype.hasOwnProperty.call(literal, o)) { subs[o] = String(literal[o]); literalOperands.push(o); }
    else if (reg <= 24) subs[o] = 'R' + reg++;
    else subs[o] = '0';
  }
  let m = macro;
  for (const k of Object.keys(subs).sort((a, b) => b.length - a.length)) m = m.split(k).join(subs[k]);

  const instructions = [], labels = [];
  // Keep only directive control-flow bookkeeping here.  Condition semantics
  // belong exclusively to dual_oracle_harness.evalCondition.
  const stack = [{ active: true, taken: true, parent: true }];
  // Symbols the expansion itself defines (`X .set v`, `.asg v, X`): the emitted
  // file is standalone, so `.if !$isdefed("X")` guards around them are true.
  // Numeric `.set` values also substitute into later conditions (`.if NUM_AXES >= 2`).
  // `.set/.equ` symbols satisfy both `$isdefed("X")` and `$defined(X)`; `.asg` names only
  // `$defined` (clpru 2.3.3 probe, see dual_oracle_harness.evalConditionDetailed).
  const defined = { symbols: new Set(), substitutions: new Set() };
  const values = {};
  // A condition the shared evaluator cannot decide reads false, but is recorded so the
  // branch never vanishes silently.
  const undecidable = [];
  const decide = (c) => {
    const r = conditionEvaluator(c, values, defined);
    if (typeof r === 'boolean') return r;   // injected legacy evaluators (red arms)
    if (!r.decided) undecidable.push(c.trim());
    return r.value;
  };
  let pending = 0;
  // Every label stacked on one address (`a?:` directly above `b?:`). `labels` keeps the last
  // for the JS core, which takes one name per instruction; `aliases` has the rest so the
  // emitted file still defines every branch target.
  let pendingAll = [];
  const aliases = [];
  for (const raw of m.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.includes('.macro') || line.includes('.endm')) continue;
    if (line.startsWith('.if ')) {
      const c = line.replace(/^\.if\s*/, '').trim();
      const parentActive = stack[stack.length - 1].active;
      const isTrue = decide(c);
      stack.push({ active: parentActive && isTrue, taken: isTrue, parent: parentActive });
      continue;
    }
    if (line.startsWith('.elseif')) {
      const top = stack[stack.length - 1];
      const isTrue = !top.taken && decide(line.substring(7));
      top.active = top.parent && isTrue;
      top.taken = top.taken || isTrue;
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
    // `label: instr` on one line defines the label at that instruction;
    // `label:` alone stacks onto the next instruction via pending/pendingAll.
    const parts = splitLabel(line);
    if (!parts) continue;
    if (parts.label) { pending = parts.label.replace(/\?/g, '_1'); pendingAll.push(pending); }
    if (!parts.rest) continue;
    let ins = parts.rest.replace(/\?/g, '_1');
    if (!ins) continue;
    const def = ins.match(/^(\S+)\s+\.(?:set|equ)\s+(.*)$/i);
    if (def) {
      defined.symbols.add(def[1]);
      // `X .set X+5` is an assembler error (E0300, clpru 2.3.3), but an expression over known
      // values is still folded; anything else drops the value rather than keeping a stale one.
      const v = sharedHarness.evalNumericExpression(substituteValues(def[2].trim(), values));
      if (v !== null) values[def[1]] = String(v); else delete values[def[1]];
    }
    const asg = ins.match(/^\.asg\s+[^,]+,\s*(\S+)/i);
    if (asg) defined.substitutions.add(asg[1]);
    instructions.push(ins); labels.push(pending); aliases.push(pendingAll); pending = 0; pendingAll = [];
  }
  // A label on the last line of the macro (`ma_done?:` before `.endm`) has no instruction to
  // attach to; the caller hangs it on the closing halt so branches to it still resolve.
  return { instructions, labels, operands, undecidable, trailingLabel: pending, aliases, trailingAliases: pendingAll, literalOperands };
}

// Per-block operand bindings. LITERAL is ONE table shared by every block, so a block
// whose defaults differ from it was emitted with another block's numbers (endat_initiator:
// MT_BITS 12 vs its default 10 made `ldi R27.b0, (30 - 13 - 12 - 6)` = -1). The register
// allocator builds a block's macro call as [outputs][inputs][constant1..constantN] (see
// pru_register_allocator.js), so the LAST numOfConstants formals are that block's constants, in
// order (a macro may declare one result formal where the block has several output ports:
// iqmath_park_clarke), and each constant's value is its getValue(instance) or its `default`. Only a numeric
// value is bound; a block whose formal count does not match that layout, or whose constant is
// not a number (a register, a packed string), keeps the global table for that formal.
function literalOf(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && /^\s*(-?\d+|0x[0-9a-f]+)\s*$/i.test(v)) return v.trim();
  return null;
}

// Evaluate a block's options the way SysConfig does: an option that has a getValue is
// DERIVED, and any other option's getValue that reads it sees that derived value, not its
// `default` (spi_adc_sequencer constant9 = sample_period - inst.noOfCycles must read
// noOfCycles' getValue 485, not its default 1). Each option is a lazy memoised getter on the
// instance, so evaluation happens in dependency order whatever the declaration order. An option
// whose getValue throws, or that is part of a dependency cycle, is UNRESOLVED: reading it throws
// in every dependent, so a value that rests on a guess is never produced; the reason is kept
// in the result. `overrides` are user-set values (the SysConfig `inst[k] = v` assignments).
function evaluateOptions(cfg, overrides = {}) {
  const values = {};
  const unresolved = {};
  const state = {};     // name -> 'busy' | 'done' | 'failed'
  const stack = [];
  const inst = {};
  for (const c of cfg) {
    if (Object.prototype.hasOwnProperty.call(inst, c.name)) continue;
    Object.defineProperty(inst, c.name, {
      enumerable: true,
      get() {
        if (Object.prototype.hasOwnProperty.call(overrides, c.name)) return overrides[c.name];
        if (typeof c.getValue !== 'function') return c.default;
        if (state[c.name] === 'done') return values[c.name];
        const unresolvedRead = (name) => Object.assign(new Error('unresolved option ' + name), { option: name });
        if (state[c.name] === 'failed') throw unresolvedRead(c.name);
        if (state[c.name] === 'busy') {
          // every option on the loop is unresolved, and the loop is each one's reason
          const loop = stack.slice(stack.indexOf(c.name));
          const cyc = loop.concat(c.name).join(' -> ');
          for (const n of loop) { state[n] = 'failed'; unresolved[n] = 'dependency cycle: ' + cyc; }
          throw unresolvedRead(c.name);
        }
        state[c.name] = 'busy'; stack.push(c.name);
        try {
          const v = c.getValue(inst);
          if (state[c.name] === 'failed') throw unresolvedRead(c.name);
          values[c.name] = v; state[c.name] = 'done';
          return v;
        } catch (e) {
          if (state[c.name] !== 'failed') {
            state[c.name] = 'failed';
            unresolved[c.name] = e.option ? `depends on ${e.option} (${unresolved[e.option]})` : 'getValue threw: ' + e.message.slice(0, 80);
          }
          throw unresolvedRead(c.name);
        } finally { stack.pop(); }
      },
    });
  }
  // Force every derived option so `unresolved` is complete, not just what a caller reads.
  for (const c of cfg) { try { void inst[c.name]; } catch (e) { /* recorded in `unresolved` */ } }
  return { inst, unresolved };
}

// A constant can PACK several macro operands into one comma-separated string (pru_spi_read/
// transfer/write: constant1 = "8, TEMP_REG1.b0, 5, 6, ..." is the 2nd.. operands of the call). Its
// tokens then occupy that many consecutive formals. Returns the tokens, or null for a plain value.
function packedTokens(v) {
  if (typeof v !== 'string' || !v.includes(',')) return null;
  return v.split(',').map((t) => t.trim());
}

// A packed token can name a scratch register field (`TEMP_REG1.b0`, the pru_spi bit counter). The
// call passes it as that field, so a full register in its place changes the macro's arithmetic
// (`sub R12, R12, 1` / `qbne ..., 0xFF` only terminates on a BYTE counter). Same registers as the
// expander's TEMP_REGn substitutions.
const TEMP_REGS = { 1: 'R28', 2: 'R29', 3: 'R26', 4: 'R27' };
function packedOperand(tok) {
  const lit = literalOf(tok);
  if (lit !== null) return lit;
  const m = /^TEMP_REG([1-4])(\.[bw][0-3])?$/.exec(tok);
  return m ? TEMP_REGS[m[1]] + (m[2] || '') : null;
}

function blockBindings(mod, macro) {
  const mm = macro.match(/^\s*\S+\s+\.macro\s+(.*)$/m);
  const formals = mm ? mm[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  const cfg = Array.isArray(mod.config) ? mod.config : [];
  const { inst, unresolved } = evaluateOptions(cfg);
  const has = (n) => cfg.some((x) => x.name === n);
  const val = (n) => { try { return inst[n]; } catch (e) { return undefined; } };
  const nc = Number(val('numOfConstants')) || 0;
  const bound = {};
  // A formal named exactly like a config option (uart_tx `channel`, `dataBits`) carries that
  // option's evaluated value even when the macro is not laid out [outputs][inputs][constants].
  const byName = {};
  for (const f of formals) {
    if (!has(f) || /^constant\d+$/.test(f)) continue;
    const lit = literalOf(val(f));
    if (lit !== null) byName[f] = lit;
  }
  // Every option that could not be evaluated, with its reason: the row says so whether or not a
  // macro operand rests on it (a throwing getValue is never silent).
  const unresolvedNote = { ...unresolved };
  // The operands each constant spans: 1, or its token count when it is packed.
  const span = [];
  for (let i = 1; i <= nc; i++) {
    const t = has('constant' + i) ? packedTokens(val('constant' + i)) : null;
    span.push(t ? t.length : 1);
  }
  const lead = formals.length - span.reduce((a, b) => a + b, 0);
  const nIn = Number(val('numOfInputPorts')) || 0;
  const nOut = Number(val('numOfOutputPorts')) || 0;
  if (!nc || ![1, nOut].some((o) => lead === o + nIn)) {
    return { bound: byName, byName: Object.keys(byName), unresolved: unresolvedNote,
      layout: nc ? 'formals do not follow [outputs][inputs][constants]' : 'no constants' };
  }
  Object.assign(bound, byName);
  const positional = new Set();
  let at = lead;
  for (let i = 1; i <= nc; i++) {
    const width = span[i - 1];
    if (has('constant' + i)) {
      const v = val('constant' + i);
      const toks = packedTokens(v);
      for (let k = 0; k < width; k++) {
        const lit = toks ? packedOperand(toks[k]) : literalOf(v);
        if (lit !== null) { bound[formals[at + k]] = lit; positional.add(formals[at + k]); }
      }
    }
    at += width;
  }
  return { bound, byName: Object.keys(byName).filter((k) => !positional.has(k)), unresolved: unresolvedNote, layout: 'ok' };
}

// Expand a loaded block's default macro with its own defaults bound (the production path for
// the CLI and the tests). `literal` is the global fallback table. A key the caller
// changed in `literal` (value differs from LITERAL, or key removed) is the caller's decision
// and beats the block default, so red arms can still steer one operand.
function expandWithBlockDefaults(mod, macro, literal = LITERAL, evaluator = sharedHarness.evalConditionDetailed) {
  const { bound, byName, layout, unresolved } = blockBindings(mod, macro);
  const eff = { ...literal };
  const fromBlock = {};
  for (const [k, v] of Object.entries(bound)) {
    if (literal[k] !== LITERAL[k]) continue;
    eff[k] = v; fromBlock[k] = v;
  }
  const r = expand(macro, evaluator, eff);
  const blockNames = r.literalOperands.filter((o) => Object.prototype.hasOwnProperty.call(fromBlock, o));
  r.bindings = {
    layout,
    unresolved: unresolved || {},
    block: Object.fromEntries(blockNames.map((o) => [o, fromBlock[o]])),
    byName: blockNames.filter((o) => byName.includes(o)),
    global: r.literalOperands.filter((o) => !blockNames.includes(o)),
  };
  return r;
}

// Human-readable note: which operand values are the block's own defaults and which fell back to the
// global LITERAL table. Empty when the macro binds no literal operand at all.
function bindingDisclosure(bindings) {
  const parts = [];
  const names = Object.keys(bindings.block);
  if (names.length) parts.push('block defaults ' + names.map((k) => `${k} = ${bindings.block[k]}${bindings.byName.includes(k) ? ' (by config name)' : ''}`).join(', '));
  if (bindings.global.length) {
    parts.push('global fallback ' + bindings.global.join(', ') +
      (bindings.layout === 'ok' || bindings.layout === 'no constants' ? '' : ` (${bindings.layout})`));
  }
  const un = Object.entries(bindings.unresolved || {});
  if (un.length) parts.push('not derivable, left on the fallback: ' + un.map(([k, why]) => `${k} (${why})`).join(', '));
  return parts.length ? 'binding: ' + parts.join('; ') : '';
}

// The macro the SysConfig generator really emits for a block's default instance. The generated
// firmware calls `getMacro("", instance["opCode"])` (common/pru_syscfg.inc.xdt), so the macro is
// named by the instance's evaluated opCode, NOT by `m_<id>` (onewire_block's default instance
// calls m_onewire_reset_standard; m_onewire_block is a legacy readByte-style macro with other
// formals). `m_<id>` is only the fallback for a block with no opCode, an opCode that cannot be
// evaluated, or one whose macro is empty; `source` says which one was used so the fallback is
// never silent.
function defaultMacro(mod, id) {
  if (typeof mod.getMacro !== 'function') return { name: null, macro: null, source: 'no getMacro' };
  const cfg = Array.isArray(mod.config) ? mod.config : [];
  let source = 'no opCode option, m_<id> fallback';
  if (cfg.some((c) => c.name === 'opCode')) {
    let op;
    try { op = evaluateOptions(cfg).inst.opCode; } catch (e) { op = undefined; }
    if (typeof op === 'string' && op.trim()) {
      let macro;
      try { macro = mod.getMacro('', op); } catch (e) { macro = undefined; }
      if (typeof macro === 'string' && macro.trim()) return { name: op, macro, source: 'default opCode' };
      source = `default opCode ${op} gives no macro, m_<id> fallback`;
    } else source = 'default opCode not evaluable, m_<id> fallback';
  }
  const name = 'm_' + id;
  return { name, macro: mod.getMacro('', name), source };
}

// The block's control-flow kind, recorded in the manifest. Kind comes from
// scripts/block_control_flow.js (continuous = no next port / never returns; sequential = hands
// control back). A block the classifier cannot decide is recorded as sequential, so a run that
// does not halt is visible as such (fail closed).
function blockKind(id) {
  const cf = require('./block_control_flow').classify(id);
  const continuous = cf.cls === 'continuous' && cf.decided;
  return {
    kind: continuous ? 'continuous' : 'sequential',
    kindBasis: cf.decided ? cf.reason : `${cf.reason} -- undecided, treated as sequential`,
  };
}

// Expand one block's default macro by id (tests and the CLI share this path).
function expandBlock(id, literal = LITERAL) {
  const b = allBlocks().find((x) => x.id === id);
  const mod = loadBlock(b.file);
  return expandWithBlockDefaults(mod, defaultMacro(mod, id).macro, literal);
}

module.exports = { expand, expandBlock, expandWithBlockDefaults, defaultMacro, blockKind, blockBindings, evaluateOptions, bindingDisclosure, allBlocks, loadBlock, LITERAL };

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const core = loadCore();
  const manifest = [];
  let emitted = 0, skipped = 0;

  for (const b of allBlocks()) {
    let rec = { id: b.id, cat: b.cat };
    let mod;
    try { mod = loadBlock(b.file); }
    catch (e) { rec.skip = 'load: ' + e.message.slice(0, 70); skipped++; manifest.push(rec); continue; }
    if (typeof mod.getMacro !== 'function') { rec.skip = 'no getMacro'; skipped++; manifest.push(rec); continue; }

    let macro, macroName, macroSource;
    // Match the production XDT path: an empty call asks the block for its
    // parameterised macro definition, named by the instance's opCode (// defaultMacro). Passing only the opcode selects the inline-expansion path in
    // several blocks, but supplies none of the operands that path requires; the
    // resulting undefined symbols are a harness artefact, not generated firmware.
    try { ({ macro, name: macroName, source: macroSource } = defaultMacro(mod, b.id)); }
    catch (e) { rec.skip = 'getMacro: ' + e.message.slice(0, 70); skipped++; manifest.push(rec); continue; }
    if (typeof macro !== 'string' || !macro.trim()) { rec.skip = 'empty macro'; skipped++; manifest.push(rec); continue; }

    const { instructions, labels, operands, undecidable, trailingLabel, aliases, trailingAliases, bindings } = expandWithBlockDefaults(mod, macro);
    if (undecidable.length) rec.undecidable = undecidable;
    if (!instructions.length) { rec.skip = 'no instructions after expansion'; skipped++; manifest.push(rec); continue; }
    instructions.push('halt'); labels.push(trailingLabel); aliases.push(trailingAliases);

    const lines = [];
    for (let i = 0; i < instructions.length; i++) {
      for (const l of aliases[i]) lines.push(l + ':');
      lines.push('    ' + instructions[i]);
    }
    fs.writeFileSync(path.join(OUT, b.id + '.asm'), lines.join('\n') + '\n');

    // JS-core reference run
    let js = { ok: false };
    try {
      const r = core.simulatePruInstructions(instructions, labels, 3000, {}, {});
      js = { ok: true, unknown: r.pruState.unknownInstruction, parseErr: r.pruState.errorParsing };
    } catch (e) { js = { ok: false, error: e.message.slice(0, 80) }; }

    const policy = blockKind(b.id);
    rec = { ...rec, operands: operands.length, instructions: instructions.length, bindings, js,
      macro: macroName, macroSource, kind: policy.kind, kindBasis: policy.kindBasis };
    manifest.push(rec);
    emitted++;
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`emitted ${emitted} block(s), skipped ${skipped} -> ${OUT}`);
  for (const m of manifest.filter((x) => x.skip)) console.log(`  SKIP ${m.id}: ${m.skip}`);
  const undec = manifest.filter((m) => m.undecidable);
  console.log(`undecidable guards: ${undec.reduce((n, m) => n + m.undecidable.length, 0)} in ${undec.length} block(s)`);
  for (const m of undec) console.log(`  UNDECIDABLE ${m.id}: ${[...new Set(m.undecidable)].join(' | ')}`);
  const jsbad = manifest.filter((m) => m.js && (m.js.unknown || m.js.parseErr || !m.js.ok));
  console.log(`JS-core issues: ${jsbad.length}`);
  for (const m of jsbad) console.log(`  ${m.id}: ${JSON.stringify(m.js)}`);
}
