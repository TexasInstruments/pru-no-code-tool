
/*
 * build_block_docs.js — block-reference documentation generator for the TI
 * PRU No-Code Tool (.syscfg.js modules).
 *
 * For every block module it derives two markdown documents from the block's REAL
 * exported metadata (config schema, ports, validate() rules, getMacro() asm
 * template), plus an index and a portability matrix, so the docs never drift from
 * the modules:
 *
 *   docs/block-reference/blocks/<id>/design.md       — purpose, schema, asm shape, caveats
 *   docs/block-reference/blocks/<id>/user-guide.md   — what it does + param reference
 *   docs/block-reference/README.md                   — index table (grouped by category)
 *   docs/block-reference/portability.md              — block x SoC widget matrix
 *
 * The output is deterministic (no dates, sorted order), so regenerating an
 * up-to-date tree changes nothing; tests/test_block_docs_fresh.py checks that.
 *
 * Each .syscfg.js module references the SysConfig runtime (system.getScript, etc.)
 * at load time, so we execute it in a vm sandbox with a permissive `system` stub
 * and capture `exports`. Plain Node, no dependencies. Run: node build_block_docs.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const META = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks');
// DOCS_OUT lets tests/test_block_docs_fresh.py generate into a scratch dir instead of the tracked docs.
const OUT = process.env.DOCS_OUT ? path.resolve(process.env.DOCS_OUT) : path.join(ROOT, 'docs', 'block-reference');
// Single-source device capability table for portability matrix
let DEVICE_CAPS = null;
try {
  DEVICE_CAPS = require(path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_device_caps.js'));
} catch (e) { DEVICE_CAPS = null; }

const CATEGORY_LABELS = {
  pru_io_blocks: 'I/O & Protocol',
  data_handling: 'Data Handling',
  program_control: 'Program Control',
  application_specific: 'Application-Specific',
  utils: 'Utilities',
};

// ---- discovery -----------------------------------------------------------

function findBlocks(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...findBlocks(full)); continue; }
    if (!entry.name.endsWith('.syscfg.js')) continue;
    if (entry.name === 'pru_blocks_static_module.syscfg.js') continue; // infra, not a block
    const category = path.basename(path.dirname(full));
    if (category === 'common') continue;
    out.push({ file: full, id: entry.name.replace(/\.syscfg\.js$/, ''), category });
  }
  return out;
}

// ---- sandbox load --------------------------------------------------------

// Universal non-throwing proxy so module top-level system.* calls never crash.
function makeStub() {
  const fn = function () { return makeStub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'then') return undefined;
      return makeStub();
    },
    apply() { return makeStub(); },
  });
}

function loadModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = {
    system: makeStub(),
    exports: {},
    module: { exports: {} },
    require: () => makeStub(),
    console: { log() {}, error() {}, warn() {} },
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file, timeout: 5000 });
  // SysConfig modules assign `exports = obj`; some use module.exports.
  const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
    : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
    : sandbox.exports;
  return { mod, src };
}

// ---- metadata extraction -------------------------------------------------

function cfgGet(config, name) {
  const c = (config || []).find((x) => x && x.name === name);
  return c ? c.default : undefined;
}

function visibleParams(config) {
  return (config || []).filter((c) => c && !c.hidden && typeof c.name === 'string' && !c.name.startsWith('$'));
}

function optionsOf(c) {
  if (!c.options) return '—';
  if (!Array.isArray(c.options)) return '—';
  const names = c.options.map((o) => (typeof o === 'string' ? o : (o && (o.name ?? o.displayName)))).filter((x) => x != null);
  return names.length ? names.map((n) => `\`${n}\``).join(', ') : '—';
}

function portsOf(mod) {
  try {
    if (typeof mod.ports !== 'function') return null;
    const stubInst = new Proxy({}, { get: () => makeStub() });
    const p = mod.ports(stubInst);
    if (!Array.isArray(p)) return null;
    return p.map((x) => ({ name: x.name, type: x.type }));
  } catch { return null; }
}

const STRUCTURAL_EMISSION = {
  application_host_block: 'host-code template; intentionally emits no PRU instruction',
  group_block: 'structural container; shared register allocator emits its labelled child body',
  loop_block: 'structural container; shared register allocator emits LOOP/QBA around its child body',
  label: 'marker block; contributes a label through graph metadata, not a PRU instruction',
  device_model_block: 'declaration block; emits no PRU instruction, contributes a binding to pru_device_bindings.json',
};

function macroOf(mod, id) {
  if (STRUCTURAL_EMISSION[id]) {
    return { ok: true, body: '', reason: STRUCTURAL_EMISSION[id], kind: 'structural' };
  }

  const opCode = (typeof cfgGet(mod.config, 'opCode') === 'string') ? cfgGet(mod.config, 'opCode') : '';

  // Most simple blocks are deliberately emitted as an inline opcode by
  // pru_register_allocator.js. Requiring every module to export getMacro()
  // falsely classified these working blocks as silent.
  if (typeof mod.getMacro !== 'function') {
    if (opCode) return { ok: true, body: '', reason: `inline opcode \`${opCode}\` emitted by the shared generator`, kind: 'inline' };
    return { ok: false, body: '', reason: 'no getMacro(), inline opcode, or structural emission contract', kind: 'unknown' };
  }

  // getMacro('', opCode) is the definition-generation contract used by macro
  // blocks. It is especially important for UART RX, whose ordinary call needs
  // eight arguments and cannot be reconstructed from the opcode alone.
  for (const args of [['', opCode], [opCode, opCode], [opCode], []]) {
    try {
      const body = mod.getMacro(...args);
      if (typeof body === 'string' && body.trim()) return { ok: true, body, reason: 'getMacro() definition emitted', kind: 'macro' };
    } catch { /* try next signature */ }
  }
  return { ok: false, body: '', reason: 'getMacro() threw or returned empty', kind: 'macro' };
}

function validationRulesOf(src) {
  const rules = [];
  const re = /logError\(\s*([`'"])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src))) rules.push(m[2].replace(/\$\{[^}]+\}/g, '<value>').replace(/\s+/g, ' ').trim());
  return [...new Set(rules)];
}

function todoVerifyOf(src, macroBody) {
  const lines = (src + '\n' + macroBody).split('\n')
    .filter((l) => /\b(VERIFY|TODO|FIXME)\b/.test(l))
    .map((l) => l.replace(/^[\s;*/]+/, '').replace(/`/g, '').trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

// Device Model emits no firmware and declares no ports(), so the port heuristic below left it
// '(unclassified)' while the CI classifier (block_control_flow_data.js, which feeds the GUI validator)
// says 'continuous' ("no next port"). The docs state the classifier's answer for this block;
// tests/test_device_model_companion_conflicts.py fails if the two ever disagree. Not read from
// scripts/block_control_flow.js here because tests/test runs this generator from a scratch copy
// that has no scripts/. Widening this to other blocks would re-label 20 of them: a separate decision.
const CLASSIFIER_EXECUTION = { device_model_block: 'continuous' };

function inferExecution(ports, mod, id) {
  if (Object.prototype.hasOwnProperty.call(CLASSIFIER_EXECUTION, id)) return CLASSIFIER_EXECUTION[id];
  const hasNext = ports && ports.some((p) => p.type === 'IO_NEXT');
  const hasPrev = ports && ports.some((p) => p.type === 'IO_PREV');
  const nOut = Number(cfgGet(mod.config, 'numOfOutputPorts'));
  const blob = `${mod.description || ''} ${mod.longDescription || ''}`.toLowerCase();
  if (blob.includes('continuous') || (hasPrev && !hasNext && nOut === 0)) return 'continuous';
  if (hasNext || hasPrev) return 'oneshot';
  return '(unclassified)';
}

// ---- emit ----------------------------------------------------------------

function fence(lang, body) { return '```' + lang + '\n' + String(body).replace(/\s+$/, '') + '\n```'; }
function write(rel, body) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body.replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n');
}

function paramTable(params) {
  if (!params.length) return '_(no user-visible parameters)_';
  const head = '| Parameter | Display name | Default | Options |\n|---|---|---|---|';
  const rows = params.map((c) => {
    const def = (c.default && typeof c.default === 'object') ? JSON.stringify(c.default) : String(c.default);
    return `| \`${c.name}\` | ${c.displayName || '—'} | \`${def}\` | ${optionsOf(c)} |`;
  });
  return [head, ...rows].join('\n');
}

function portTable(ports) {
  if (!ports || !ports.length) return '_(no ports declared)_';
  const head = '| Port | Type |\n|---|---|';
  const rows = ports.map((p) => `| \`${p.name}\` | \`${p.type}\` |`);
  return [head, ...rows].join('\n');
}

function buildBlockDocs(meta) {
  const { mod, src } = loadModule(meta.file);
  const id = meta.id;
  const display = (mod && mod.displayName) || id;
  const desc = (mod && mod.description) || '';
  // Module descriptions link images relative to docs/ (../.metadata/...); the pages here sit
  // three directories deeper (docs/block-reference/blocks/<id>/).
  const longDesc = ((mod && mod.longDescription) || '').replace(/\]\(\.\.\/\.metadata\//g, '](../../../../.metadata/');
  const params = visibleParams(mod.config);
  const ports = portsOf(mod);
  const macro = macroOf(mod, id);
  const rules = validationRulesOf(src);
  const todos = todoVerifyOf(src, macro.body);
  const exec = inferExecution(ports, mod, id);
  const opCode = cfgGet(mod.config, 'opCode');
  const cycles = cfgGet(mod.config, 'noOfCycles');
  const nIn = ports ? ports.filter((p) => /^input/.test(p.type)).length : (Number(cfgGet(mod.config, 'numOfInputPorts')) || 0);
  const nOut = ports ? ports.filter((p) => /^output/.test(p.type)).length : (Number(cfgGet(mod.config, 'numOfOutputPorts')) || 0);
  const catLabel = CATEGORY_LABELS[meta.category] || meta.category;
  const rel = `blocks/${id}`;
  // Declarative capability
  const requiresWidget = (mod && mod.requiresWidget) ? (Array.isArray(mod.requiresWidget) ? mod.requiresWidget : [mod.requiresWidget]).filter(Boolean) : [];
  let portabilityRows = '';
  let portabilitySummary = '';
  if (DEVICE_CAPS) {
    const missingByDevice = {};
    const supported = [];
    const unsupported = [];
    for (const dev of DEVICE_CAPS.ALL_DEVICES) {
      const missing = DEVICE_CAPS.getMissingWidgets(requiresWidget, dev);
      missingByDevice[dev] = missing;
      if (missing.length === 0) supported.push(dev);
      else unsupported.push(dev + ' (missing ' + missing.join(', ') + ')');
    }
    portabilityRows = DEVICE_CAPS.ALL_DEVICES.map(function (dev) {
      const miss = missingByDevice[dev];
      return '| `' + dev + '` | ' + (miss.length ? '❌ ' + miss.join(', ') : '✅') + ' |';
    }).join('\n');
    portabilitySummary = requiresWidget.length ? '`' + requiresWidget.join('`, `') + '`' : '_(none)_';
  } else {
    portabilitySummary = requiresWidget.length ? '`' + requiresWidget.join('`, `') + '`' : '_(none)_';
    portabilityRows = '| _(caps unavailable)_ |  |';
  }

  // design.md
  let mermaidDiagram = '```mermaid\nflowchart LR\n';
  mermaidDiagram += '  classDef config fill:#f9f6e5,stroke:#b1a457,stroke-width:1px,color:#333;\n';
  mermaidDiagram += '  classDef core fill:#e1f5fe,stroke:#0277bd,stroke-width:2px,color:#000;\n';
  mermaidDiagram += `  CORE(("${display}\\n[${exec}]")):::core\n`;
  if (params && params.length) {
    mermaidDiagram += params.map((c, i) => `  CFG${i}["${c.displayName || c.name}"]:::config -.-> CORE`).join('\n') + '\n';
  }
  mermaidDiagram += '```\n';

  write(`${rel}/design.md`, `# ${display} (\`${id}\`) — Design Document

> Generated by \`build_block_docs.js\` from \`.metadata/sysconfig/.meta/pru_blocks/${meta.category}/${id}.syscfg.js\`. Do not edit by hand; re-run \`node build_block_docs.js\`.

## Purpose

${longDesc || desc || '_(no description in module)_'}

## Block Diagram

${mermaidDiagram}

## Classification

- **Block id:** \`${id}\`
- **Category:** ${catLabel}
- **Execution model (inferred):** \`${exec}\`
- **Macro / opcode:** ${opCode ? '`' + opCode + '`' : '_(none)_'}
- **Data ports:** ${nIn} in / ${nOut} out${cycles != null ? ` · **Cycles:** \`${cycles}\`` : ''}

## Parameter schema

${paramTable(params)}

## Ports

${portTable(ports)}

## Validation rules

${rules.length ? rules.map((r) => `- ${r}`).join('\n') : '- _(no explicit validate() rules)_'}

## Generated macro (\`.xdt\` equivalent)

${macro.ok && macro.body ? fence('asm', macro.body) : '_(' + macro.reason + ')_'}

## Device portability

> **Source of truth:** \`.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js\` (TRM SPRUIM2J §6.4.1.1 / SPRUJB6 §7.3.1.1). Regenerated by \`node build_block_docs.js\` — do not edit by hand.

- **Required widget(s):** ${portabilitySummary}
- **Validator:** \`pru_blocks_static_module\` raises a SysConfig **ERROR** naming both widget and device when a required widget is absent.

| Device (SoC) | Supported |
|---|---|
${portabilityRows}

## Outstanding TODO / VERIFY items

${todos.length ? todos.map((t) => `- ⚠️ ${t}`).join('\n') : '- None flagged in source.'}
`);

  // user-guide.md
  write(`${rel}/user-guide.md`, `# ${display} (\`${id}\`) — User Guide

> Generated by \`build_block_docs.js\`.

## What it does

${desc || display}

${longDesc && longDesc !== desc ? longDesc + '\n' : ''}
## Parameters

${paramTable(params)}

## Ports

${portTable(ports)}

## How to use

1. In SysConfig (PRU No-Code), add a **${display}** block to your PRU core's flow.
2. Set the parameters above; wire \`prev\`/\`next\` to sequence it, and any \`input\`/\`output\` data ports to neighbouring blocks.
3. Generate — the block emits its \`${opCode || 'macro'}\` invocation into the PRU assembly.

## Notes

- Invalid configurations are rejected by SysConfig with the validation messages listed in the [design doc](./design.md).
- Timing constants are in PRU clock cycles; confirm any \`TODO\`/\`VERIFY\` lines against your SoC TRM before flashing.
`);

  return { id, display, category: meta.category, catLabel, exec, cycles, nIn, nOut, todos: todos.length, rules: rules.length, ok: !!(mod && mod.displayName) && Array.isArray(mod.config) && mod.config.length > 0, macroOk: macro.ok, requiresWidget: requiresWidget };
}

function buildIndex(results) {
  const byCat = {};
  for (const r of results) (byCat[r.category] ||= []).push(r);
  let sections = '';
  const order = ['pru_io_blocks', 'data_handling', 'program_control', 'application_specific', 'utils'];
  const cats = [...new Set([...order, ...Object.keys(byCat)])].filter((c) => byCat[c]);
  for (const cat of cats) {
    const rows = byCat[cat].sort((a, b) => a.id.localeCompare(b.id)).map((b) => {
      const widgets = (b.requiresWidget && b.requiresWidget.length) ? '`' + b.requiresWidget.join('`, `') + '`' : '—';
      return `| [${b.display}](blocks/${b.id}/design.md) | \`${b.id}\` | \`${b.exec}\` | ${b.nIn}/${b.nOut} | ${b.cycles != null ? '`' + b.cycles + '`' : '—'} | ${widgets} | ${b.todos ? '⚠️ ' + b.todos : '—'} | [design](blocks/${b.id}/design.md) · [guide](blocks/${b.id}/user-guide.md) |`;
    }).join('\n');
    sections += `\n### ${CATEGORY_LABELS[cat] || cat} (${byCat[cat].length})\n\n| Block | id | Execution | Ports (in/out) | Cycles | Widgets | TODO/VERIFY | Docs |\n|---|---|---|---|---|---|---|---|\n${rows}\n`;
  }
  const totalTodo = results.reduce((a, b) => a + b.todos, 0);
  const macroFail = results.filter((r) => !r.macroOk);
  // portability matrix (cross-block view)
  if (DEVICE_CAPS) {
    const devices = DEVICE_CAPS.ALL_DEVICES;
    const head = '| Block | ' + devices.map(function (d) { return '`' + d + '`'; }).join(' | ') + ' | Widgets |';
    const sep = '|---' + devices.map(function () { return '|---'; }).join('') + '|---|';
    const matRows = results.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).map(function (b) {
      const cells = devices.map(function (dev) {
        const miss = DEVICE_CAPS.getMissingWidgets(b.requiresWidget || [], dev);
        return miss.length ? '❌ ' + miss.join(', ') : '✅';
      }).join(' | ');
      const w = (b.requiresWidget && b.requiresWidget.length) ? '`' + b.requiresWidget.join('`, `') + '`' : '—';
      return '| [`' + b.id + '`](blocks/' + b.id + '/design.md) | ' + cells + ' | ' + w + ' |';
    }).join('\n');
    const portabilitySection = '\n## Portability matrix\n\n> Derived from `' + '.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js' + '` (TRM SPRUIM2J §6.4.1.1 / SPRUJB6 §7.3.1.1). Columns are SoCs, cells are ✅ supported or ❌ missing widget. Full per-block matrix lives in each [design doc](./blocks/mac_hw_block/design.md) “Device portability” section.\n\n' + head + '\n' + sep + '\n' + matRows + '\n\nWidgets legend: `mac` = MAC unit (XIN/XOUT device 0), `crc_hw` = CRC16/32, `bswap` = byte-swap, `sum32` = SUM32, `stitch_fifo` = Broadside Stitch FIFO, `task_manager`, `bs_ram`, `rtu_pru`/`tx_pru`, `iep2` = second IEP.\n\nValidator: `pru_blocks_static_module` raises SysConfig **ERROR** naming both widget and device when an instantiated block requires a missing widget.\n';
    // emit standalone portability doc
    write('portability.md', '# Block Portability Matrix\n\n> Generated by `build_block_docs.js` from `.metadata/sysconfig/.meta/pru_blocks/common/pru_device_caps.js`. Do not edit by hand.\n\n' + portabilitySection);
    // attach to index sections for README
    // store for README insertion
    var _portabilityForReadme = portabilitySection;
    // stash on function for later (closure trick)
    buildIndex._portability = _portabilityForReadme;
  }
  const portabilityForReadme = (buildIndex._portability || '');
  write('README.md', `# PRU No-Code Tool — Block Reference

> Generated by \`build_block_docs.js\`. Every block has a design doc and a
> user guide, both derived from the live \`.syscfg.js\` module metadata.
> Regenerate with \`node build_block_docs.js\`.
>
> This is the exhaustive per-block reference. For conceptual guides and getting-started
> material, see the hand-written docs under [\`../\`](../).

## Blocks (${results.length})
${sections}
Total outstanding \`TODO\`/\`VERIFY\` items across all blocks: **${totalTodo}**.
${macroFail.length ? `\nBlocks with no recognised emission contract: ${macroFail.map((r) => '`' + r.id + '`').join(', ')}.\n` : ''}
${portabilityForReadme}

## Document types

- **design.md** — purpose, parameter schema, ports, validation rules, generated macro, TODO/VERIFY caveats.
- **user-guide.md** — what it does, parameter/port reference, how to use in SysConfig.

## Caveats

- Execution model and port counts are inferred from module metadata (\`ports()\`, \`numOf*Ports\`); cross-check against the block source for edge cases.
- \`TODO\`/\`VERIFY\`-tagged macro lines (e.g. deadband insertion, FOC math) still need checking against the AM243x/AM261x/AM263Px/AM64x PRU-ICSS TRM and \`clpru\` assembly before production use.
`);
  return { totalTodo, macroFail };
}

// ---- run -----------------------------------------------------------------

function main() {
  const blocks = findBlocks(META);
  const results = [];
  for (const b of blocks) {
    try { results.push(buildBlockDocs(b)); }
    catch (e) { console.error(`  FAIL ${b.id}: ${e.message.split('\n')[0]}`); }
  }
  const { totalTodo, macroFail } = buildIndex(results);
  console.log(`block-docs: ${results.length}/${blocks.length} blocks × 2 docs + index + portability -> ${path.relative(ROOT, OUT) || OUT}`);
  console.log(`block-docs: ${totalTodo} TODO/VERIFY items; ${results.length - macroFail.length}/${results.length} macros emit cleanly.`);
  if (macroFail.length) console.log(`block-docs: macro did not emit for: ${macroFail.map((r) => r.id).join(', ')}`);
}

main();
