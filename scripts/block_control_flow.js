'use strict';
/**
 * block_control_flow.js - does a block hand control back to the next block, or run forever?
 *
 * Used by check_pin_collisions.js to narrow the duplicate-GPO rule: two different
 * blocks driving one GPO index are a collision only when at least one of them is CONTINUOUS
 * (never returns, e.g. PWM). Blocks that run one after another may share an output pin.
 *
 * FAIL CLOSED. A block is SEQUENTIAL only when BOTH facts are positively established from the
 * block's own source:
 *   1. metadata  - its ports(inst) declares a "next" port (control flow can leave it), and
 *   2. code      - the macro it generates at its config defaults has a control-flow path from
 *                  entry that falls off the end of the macro (reachability over the expanded
 *                  instructions; the same expander and .if evaluator as emit_all_blocks).
 * Everything else is CONTINUOUS: no next port, end of macro unreachable (unconditional back
 * edge, always-true self-compare), or anything the classifier cannot decide (load failure,
 * getMacro throwing for ANY candidate configuration, undecidable .if, computed jump,
 * unresolved branch target, jal/call, slp, a mnemonic outside the straight-line allow-list, an
 * unexpanded macro call, an unmodelled directive, a path that halts while another reaches the
 * end, no instructions). `reason` says which and names the mnemonic.
 *
 * "Returns" means the end of the macro is reachable and NO path halts. A poll loop with a
 * conditional exit (qbbc/qbbs on R31, qbne on a counter) counts as returning: a poll loop yields
 * control once its external condition arrives, unlike PWM which never does. An always-true
 * self-compare (qbeq L, r1, r1) is the degenerate unconditional spin and is CONTINUOUS.
 * Reachability is not a termination proof. Classification is at the block's config DEFAULTS
 * only.
 *
 * No hand list of block names: the verdict is derived per block from its .syscfg.js.
 */
const emit = require('./emit_all_blocks');

const COND = new Set(['qbeq', 'qbne', 'qblt', 'qbgt', 'qble', 'qbge', 'qbbs', 'qbbc']);

function defaultInst(blk, cfg) {
  const inst = {};
  for (const c of blk.config || []) if (c && c.name && c.default !== undefined) inst[c.name] = c.default;
  return Object.assign(inst, cfg || {});
}

function parsePorts(blk, cfg) {
  if (typeof blk.ports !== 'function') return null;
  const inst = defaultInst(blk, cfg);
  const ports = blk.ports(inst);
  return Array.isArray(ports) ? ports : null;
}

// STRAIGHT-LINE allow-list: PRU instructions that always fall through to the next instruction.
// Source: the PRU instruction set as documented in the TI "PRU Assembly Instruction User Guide"
// (SPRUIJ2) and the clpru 2.3.3 assembler (arithmetic/logic, data movement, scratch-pad/register
// transfer, and the wait-for-bit forms wbs/wbc, which block like a poll loop and then fall
// through). Branch/flow forms the CFG models explicitly (qba, qb*) are handled separately.
// Anything NOT here and not modelled below makes the block UNDECIDED (fail closed).
const STRAIGHT = new Set([
  'add', 'adc', 'sub', 'suc', 'rsb', 'rsc', 'lsl', 'lsr', 'and', 'or', 'xor', 'not', 'min', 'max',
  'clr', 'set', 'lmbd', 'scan', 'zero', 'fill', 'nop',
  'ldi', 'ldi32', 'mov', 'movi', 'mvib', 'mviw', 'mvid',
  'lbbo', 'sbbo', 'lbco', 'sbco',
  'xin', 'xout', 'xchg', 'sxin', 'sxout', 'sxchg',
  'wbs', 'wbc',
]);

// Assembler directives that emit NO instruction (symbol bookkeeping) plus the .loop/.endloop
// repeat pair. clpru .loop N / .endloop only replicates the enclosed straight-line text, so
// modelling the body once preserves whether the end is reachable. Every other directive
// (.word, .sect, .break, .macro call-throughs, ...) stays UNDECIDED.
const NOCODE = new Set(['.asg', '.unasg', '.set', '.equ', '.eval', '.def', '.ref', '.global', '.loop', '.endloop']);

// Walk one expanded instruction stream. Returns {end:true/false} or {undecided:reason}.
// Verdict: end is true only when control can fall off the end; `halt` terminates a path (it is
// not an escape), `slp`, an unknown mnemonic, a macro call or a code-emitting directive is
// UNDECIDED. A path that halts therefore contributes nothing to "end reachable", and the
// caller requires the end to be reachable (see classifyBlock); a block whose paths split
// between halt and end is reported undecided, not sequential ("all paths return").
function reachEnd(x) {
  const ins = x.instructions;
  if (!ins.length) return { undecided: 'no instructions after expansion' };
  const at = new Map();
  x.aliases.forEach((al, i) => al.forEach((l) => at.set(l, i)));
  x.labels.forEach((l, i) => { if (l) at.set(l, i); });
  x.trailingAliases.forEach((l) => at.set(l, ins.length));
  if (x.trailingLabel) at.set(String(x.trailingLabel).replace(/\?/g, '_1'), ins.length);
  const END = ins.length;
  // `label: instr` on one line stays a single "instruction" in the expander's output (clpru
  // treats `;` as a comment, so nothing after it exists). Register the label and classify the
  // instruction behind it.
  const body = ins.map((t, i) => {
    // Same charset as scripts/asm_label.js splitLabel, so a
    // `label: instr` line that reaches this classifier directly still registers.
    const lm = t.match(/^([A-Za-z0-9_?$]+):\s*(.*)$/);
    if (!lm) return t;
    at.set(lm[1], i);
    return lm[2];
  });
  const seen = new Set();
  const stack = [0];
  let end = false;
  let halts = 0;
  while (stack.length) {
    const i = stack.pop();
    if (i === END) { end = true; continue; }
    if (seen.has(i)) continue;
    seen.add(i);
    const m = body[i].match(/^(\S+)\s*(.*)$/);
    const op = m[1].toLowerCase();
    const args = m[2].split(',').map((s) => s.trim());
    if (op === 'qba') {
      if (!at.has(args[0])) return { undecided: `qba to unresolved target "${args[0]}"` };
      stack.push(at.get(args[0]));
    } else if (COND.has(op)) {
      const t = at.has(args[args.length - 1]) ? at.get(args[args.length - 1]) : at.get(args[0]);
      if (t === undefined) return { undecided: `${op} to unresolved target` };
      // Identical operands decide the compare statically (`qbeq L, r1, r1` is always taken):
      // an always-true self-loop is an unconditional spin, never a poll. A data-dependent
      // compare (including qbbs/qbbc on r31) can go either way, so it keeps both edges.
      if (args.length === 3 && args[1] === args[2] && op !== 'qbbs' && op !== 'qbbc') {
        if (op === 'qbeq' || op === 'qbge' || op === 'qble') stack.push(t);
        else stack.push(i + 1);
      } else stack.push(t, i + 1);
    } else if (op === 'jmp' || op === 'jal' || op === 'call' || op === 'ret') {
      return { undecided: `${op}: computed/call flow not modelled` };
    } else if (op === 'halt') {
      halts++;       // terminal: control never reaches the next block along this path
    } else if (STRAIGHT.has(op) || NOCODE.has(op) || /^\.(set|equ)/i.test(args[0].split(/\s+/)[0] || '')) {
      // `SYM .set v` / `SYM .equ v`: the expander keeps the whole line as one "instruction"
      // whose mnemonic is the symbol; it defines a symbol and emits no code.
      stack.push(i + 1);
    } else if (op === 'slp') {
      return { undecided: 'slp: halts the PRU until an event, not modelled as returning' };
    } else {
      const kind = op.startsWith('.') ? 'directive' : (/^m_/.test(op) ? 'unexpanded macro call' : 'unknown mnemonic');
      return { undecided: `${kind} "${m[1]}" [${JSON.stringify(body[i])}] is not in the straight-line allow-list` };
    }
  }
  if (halts && end) return { undecided: `halt reachable on ${halts} path(s) while another path reaches the end (not all paths return)` };
  return { end, n: ins.length };
}

// Every expansion of a macro over all resolutions of the .if guards the shared evaluator cannot
// decide (operands bound to registers). Sequential must hold on EVERY resolution.
const MAX_RESOLUTIONS = 1024;
function expandAllResolutions(macro, blk) {
  const real = require('./dual_oracle_harness').evalConditionDetailed;
  const out = [];
  const queue = [[]];
  let runs = 0;
  while (queue.length) {
    if (++runs > 4 * MAX_RESOLUTIONS || out.length > MAX_RESOLUTIONS) return null;
    const prefix = queue.pop();
    let k = 0;
    const ev = (c, v, d) => {
      const r = real(c, v, d);
      if (r.decided) return r;
      const val = k < prefix.length ? prefix[k] : false;
      k++;
      return { decided: true, value: val };
    };
    const x = emit.expandWithBlockDefaults(blk, macro, emit.LITERAL, ev);   // guards on the block's own defaults
    if (k > prefix.length) { queue.push(prefix.concat([true]), prefix.concat([false])); continue; }
    out.push(x);
  }
  return out;
}

// Macro names a block can generate: every m_* string literal in its source plus m_<id>.
function macroCandidates(file, id, src) {
  const names = new Set(['m_' + id]);
  for (const m of src.matchAll(/["'`](m_[A-Za-z0-9_]+)["'`]/g)) names.add(m[1]);
  return [...names];
}

// Macro names for one configured instance. A block whose opCode is a function of its
// config (a PWM period count > 0 selects the counted macro) names the macro it will emit.
function instanceMacroNames(blk, cfg) {
  const opc = (blk.config || []).find((c) => c && c.name === 'opCode');
  if (!cfg || !opc || typeof opc.getValue !== 'function') return null;
  const v = opc.getValue(defaultInst(blk, cfg));
  return typeof v === 'string' && /^m_/.test(v) ? [v] : null;
}

// classifyBlock(id) is the verdict at the config DEFAULTS. classifyBlock(id, cfg) overlays `cfg`
// on those defaults for ports() and for the macro the instance selects.
// `file` (optional) points at a block source outside the repo, so the verification can be tested on a
// fixture whose macro never returns.
function findBlock(id, file) {
  return file ? { id, file } : emit.allBlocks().find((x) => x.id === id);
}

function classifyBlock(id, cfg, file) {
  const fs = require('fs');
  const b = findBlock(id, file);
  if (!b) return { cls: 'continuous', decided: false, reason: 'no such block file (undecided)' };
  let blk;
  try { blk = emit.loadBlock(b.file); }
  catch (e) { return { cls: 'continuous', decided: false, reason: 'block failed to load: ' + e.message.slice(0, 60) }; }
  let ports;
  try { ports = parsePorts(blk, cfg); }
  catch (e) { return { cls: 'continuous', decided: false, reason: 'ports() threw: ' + e.message.slice(0, 60) }; }
  if (!ports) return { cls: 'continuous', decided: false, reason: 'no ports() metadata (undecided)' };
  if (!ports.some((p) => p && p.name === 'next')) {
    return { cls: 'continuous', decided: true, reason: 'metadata: ports() declares no "next" port' };
  }
  if (typeof blk.getMacro !== 'function') {
    // No macro: the block emits one PRU instruction per opCode option (e.g. SET / CLR / AND).
    const opc = (blk.config || []).find((c) => c && c.name === 'opCode');
    const names = new Set();
    if (opc && typeof opc.default === 'string') names.add(opc.default);
    for (const o of (opc && opc.options) || []) if (o && o.name) names.add(String(o.name));
    if (!names.size) return { cls: 'continuous', decided: false, reason: 'no getMacro and no opCode (undecided)' };
    const bad = [...names].filter((n) => !STRAIGHT.has(n.toLowerCase()));
    if (bad.length) return { cls: 'continuous', decided: false, reason: 'opCode not in the straight-line allow-list: ' + bad.join(',') + ' (undecided)' };
    return { cls: 'sequential', decided: true, reason: `next port declared; no macro, straight-line opCode(s) ${[...names].join('/')}` };
  }
  const src = fs.readFileSync(b.file, 'utf8');
  const streams = [];
  for (const name of instanceMacroNames(blk, cfg) || macroCandidates(b.file, id, src)) {
    for (const arg of ['', name]) {
      let macro;
      try { macro = blk.getMacro(arg, name); }
      catch (e) { return { cls: 'continuous', decided: false, reason: `getMacro(${JSON.stringify(arg)}, ${name}) threw: ${String(e.message).slice(0, 60)} (undecided)` }; }
      if (typeof macro !== 'string' || !macro.trim()) continue;
      // emit_all_blocks.expand reads operands with `\.macro\s+(.*)`, which on a zero-operand macro
      // swallows the NEXT line (a label or instruction). Give such a header a dummy operand.
      macro = macro.replace(/(\.macro)[ \t]*\r?\n/g, '$1 NOARG\n');
      const xs = expandAllResolutions(macro, blk);
      if (xs === null) return { cls: 'continuous', decided: false, reason: `too many undecidable .if resolutions in ${name}` };
      for (const x of xs) if (x.instructions.length) streams.push({ name, x });
    }
  }
  if (!streams.length) return { cls: 'continuous', decided: false, reason: 'getMacro yields no instructions (undecided)' };
  let total = 0;
  for (const s of streams) {
    const r = reachEnd(s.x);
    if (r.undecided) return { cls: 'continuous', decided: false, reason: `${s.name}: ${r.undecided} (undecided)` };
    if (!r.end) return { cls: 'continuous', decided: true, reason: `next port declared but ${s.name} macro end unreachable (unconditional loop/halt)` };
    total++;
  }
  return { cls: 'sequential', decided: true, reason: `next port declared; macro end reachable in all ${total} expansion(s)` };
}

// id for a pin-usage block name as the checker sees it (module basename).
const cache = new Map();
function classify(id) {
  if (!cache.has(id)) cache.set(id, classifyBlock(id));
  return cache.get(id);
}

// The config a block gains a "next" port from (a PWM period count; 0 = run forever), or null.
// Derived from ports() itself, not a hand list: the first numeric-default-0 config that, set to 1,
// adds a "next" port the defaults lack.
function boundConfig(id, file) {
  const b = findBlock(id, file);
  if (!b) return null;
  let blk;
  try { blk = emit.loadBlock(b.file); } catch (e) { return null; }
  let base;
  try { base = parsePorts(blk, {}); } catch (e) { return null; }
  if (!base || base.some((p) => p && p.name === 'next')) return null;
  for (const c of blk.config || []) {
    if (!c || !c.name || c.default !== 0) continue;
    let ports;
    try { ports = parsePorts(blk, { [c.name]: 1 }); } catch (e) { continue; }
    if (ports && ports.some((p) => p && p.name === 'next')) return c.name;
  }
  return null;
}

// Per-instance verdict. `inst` is any object carrying the block's config values (a
// SysConfig instance, or a plain {periodCount: 2}). Sequential only when the default verdict is
// sequential, or the block has a bound config set > 0 AND the instance's own ports() and
// selected macro positively return control. Anything else is the default verdict (fail closed).
const instCache = new Map();
function classifyInstance(id, inst, file) {
  const base = file ? classifyBlock(id, undefined, file) : classify(id);
  if (base.cls === 'sequential') return base;
  const key = file ? `${file}|${id}` : id;
  if (!instCache.has(key)) instCache.set(key, boundConfig(id, file));
  const bound = instCache.get(key);
  if (!bound || !inst) return base;
  const n = Number(inst[bound]);
  if (!Number.isInteger(n) || n <= 0) return base;
  const ck = `${key}:${bound}>0`;
  if (!instCache.has(ck)) instCache.set(ck, classifyBlock(id, { [bound]: n }, file));
  return instCache.get(ck);
}

module.exports = { classify, classifyBlock, classifyInstance, boundConfig };

if (require.main === module) {
  const path = require('path');
  // Pin-usage blocks by their loaded moduleStatic.getPinUsage, not a text match.
  const { blocks, errors } = require('./pin_usage_blocks').pinUsageBlocks(
    process.env.PRU_BLOCKS_META ? path.resolve(process.env.PRU_BLOCKS_META) : undefined);
  for (const e of errors) { console.error(`ERROR: ${e.rel} mentions getPinUsage but failed to load: ${e.error}`); }
  if (errors.length) process.exit(1);
  const declaring = new Set(blocks.map((b) => path.resolve(b.file)));
  const rows = emit.allBlocks().filter((b) => declaring.has(path.resolve(b.file)))
    .map((b) => ({ id: b.id, ...classifyBlock(b.id) }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else for (const r of rows) console.log(`${r.cls.padEnd(10)} ${r.decided ? 'decided  ' : 'UNDECIDED'} ${r.id}: ${r.reason}`);
}
