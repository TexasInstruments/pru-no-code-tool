#!/usr/bin/env node
/**
 * run_headless_json.js - Machine-readable JSON batch runner for PRU simulation (G5)
 *
 * Runs a PRU firmware simulation and outputs results as structured JSON.
 * Designed for headless/CI use where callers want to inspect register state,
 * memory, and signal traces programmatically.
 *
 * Usage:
 *   node scripts/run_headless_json.js [--instructions ...] [--cycles N] [--watchpoint ...] [--vcd file]
 *
 * Input modes:
 *   --instructions <file>     Read PRU assembly instructions from file (.asm/.txt)
 *   --inline <instr>          Single instruction string (repeatable)
 *   --elf <file>              Load a TI .out/.elf binary for symbol context
 *
 * Simulation options:
 *   --cycles <N>              Max cycle budget (default: 1000)
 *   --watchpoint halt         Stop on HALT instruction
 *   --watchpoint pc=<addr>    Stop when PC reaches address
 *   --watchpoint reg=<N>=<V>  Stop when register N equals value V
 *   --watchpoint mem=<A>=<V>  Stop when memory at address A equals value V
 *   --r31 <cycle>=<val>       Inject R31 value at specific cycle (repeatable)
 *
 * Output options:
 *   --vcd <file>              Write VCD trace to file
 *   --out <file>              Write result JSON to file (default: stdout)
 *   --pretty                  Pretty-print JSON output
 *   --no-signal               Omit large signal histories from JSON output
 *   --dump-memory <file>      Dump DMEM0 state to file
 *
 * Exit codes:
 *   0 - All OK (watchpoint may or may not have triggered)
 *   1 - Error during setup
 *   2 - Watchpoint "halt" NOT triggered (useful for CI pass/fail)
 *
 * Output JSON structure:
 * {
 *   "simulator": "PRU Simulator",
 *   "version": "1.0.0",
 *   "status": "ok" | "watchpoint_hit" | "cycle_limit" | "error",
 *   "cycles": <number>,
 *   "pc": <number>,
 *   "registers": [r0...r31],
 *   "watchpoint": { type, ... } | null,
 *   "firmware": { symbols, entryPoint, sections } | null,
 *   "signal_trace": { r30: [...], r31: [...] } | null,
 *   "error": "..." | null
 * }
 */

const fs = require('fs');
const path = require('path');
const simulator = require('./simulator');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    instructions: null,
    inline: [],
    elf: null,
    cycles: 1000,
    watchpoints: [],
    r31Map: {},
    vcd: null,
    out: null,
    pretty: false,
    noSignal: false,
    dumpMemory: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--instructions':
        opts.instructions = args[++i];
        break;
      case '--inline':
        opts.inline.push(args[++i]);
        break;
      case '--elf':
        opts.elf = args[++i];
        break;
      case '--cycles':
        opts.cycles = parseInt(args[++i], 10);
        break;
      case '--watchpoint': {
        const wp = args[++i];
        if (wp === 'halt') {
          opts.watchpoints.push({ type: 'halt' });
        } else if (wp.startsWith('pc=')) {
          opts.watchpoints.push({ type: 'pc', address: parseInt(wp.substring(3), 0) });
        } else if (wp.startsWith('reg=')) {
          const m = wp.substring(4).match(/^(\d+)=(\d+)$/);
          if (m) opts.watchpoints.push({ type: 'register', register: parseInt(m[1], 10), value: parseInt(m[2], 0) });
        } else if (wp.startsWith('mem=')) {
          const m = wp.substring(4).match(/^(0x[0-9a-fA-F]+|\d+)=(0x[0-9a-fA-F]+|\d+)$/);
          if (m) opts.watchpoints.push({ type: 'memory', address: parseInt(m[1], 0), value: parseInt(m[2], 0) });
        }
        break;
      }
      case '--r31': {
        const rv = args[++i];
        const m = rv.match(/^(\d+)=(0x[0-9a-fA-F]+|\d+)$/);
        if (m) opts.r31Map[parseInt(m[1], 10)] = parseInt(m[2], 0);
        break;
      }
      case '--vcd':
        opts.vcd = args[++i];
        break;
      case '--out':
        opts.out = args[++i];
        break;
      case '--pretty':
        opts.pretty = true;
        break;
      case '--no-signal':
        opts.noSignal = true;
        break;
      case '--dump-memory':
        opts.dumpMemory = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

function main() {
  const opts = parseArgs();
  const sim = new simulator.Simulator({ id: 'PRU0' });

  // Load input
  let instructions = [];

  if (opts.instructions) {
    const content = fs.readFileSync(opts.instructions, 'utf8');
    const lines = content.split('\n').map(l => {
      const commentIdx = l.indexOf(';');
      return (commentIdx >= 0 ? l.substring(0, commentIdx) : l).trim();
    }).filter(l => l.length > 0);
    instructions.push(...lines);
  }

  if (opts.inline.length > 0) {
    instructions.push(...opts.inline);
  }

  if (instructions.length === 0 && !opts.elf) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'No instructions provided. Use --instructions <file> or --inline <instr>.'
    }));
    process.exit(1);
  }

  let firmwareInfo = null;

  if (opts.elf) {
    try {
      const fw = sim.load_elf(opts.elf);
      firmwareInfo = {
        format: fw.format,
        entryPoint: fw.entryPoint,
        numSymbols: fw.symbols.length,
        dataSections: fw.data ? { name: fw.data.name, addr: fw.data.addr, size: fw.data.data.length } : null
      };
    } catch (e) {
      console.error(JSON.stringify({
        status: 'error',
        error: `Failed to load ELF: ${e.message}`
      }));
      process.exit(1);
    }
  }

  if (instructions.length > 0) {
    sim.loadInstructions(instructions);
  }

  // Set R31 map if provided
  if (Object.keys(opts.r31Map).length > 0) {
    sim.setR31Map(opts.r31Map);
  }

  // Run simulation
  try {
    const result = sim.runUntil({
      maxCycles: opts.cycles,
      watchpoints: opts.watchpoints
    });

    const output = {
      simulator: 'PRU Simulator',
      version: '1.0.0',
      status: result.hitWatchpoint
        ? (result.hitWatchpoint.type === 'halt' ? 'watchpoint_hit' :
           result.hitWatchpoint.type === 'cycles' ? 'cycle_limit' : 'watchpoint_hit')
        : 'cycle_limit',
      cycles: result.state.cycles,
      pc: result.state.pc,
      registers: result.state.registers,
      watchpoint: result.hitWatchpoint ?
        { type: result.hitWatchpoint.type, cycle: result.hitWatchpoint.cycle, pc: result.hitWatchpoint.pc,
          detail: result.hitWatchpoint.address !== undefined ? { address: result.hitWatchpoint.address } :
                  result.hitWatchpoint.register !== undefined ? { register: result.hitWatchpoint.register, value: result.hitWatchpoint.value } :
                  result.hitWatchpoint.value !== undefined ? { value: result.hitWatchpoint.value } : {} }
        : null,
      firmware: firmwareInfo,
      error: null
    };

    if (!opts.noSignal) {
      output.signal_trace = {
        length: result.r30History.length,
        r30: result.r30History,
        r31: result.r31History
      };
    }

    // Export VCD
    if (opts.vcd) {
      sim.saveVcd(opts.vcd);
      output.vcd_file = path.resolve(opts.vcd);
    }

    // Dump DMEM0 memory
    if (opts.dumpMemory) {
      const dmemSize = 8 * 1024; // 8KB
      const dmem = [];
      for (let addr = 0; addr < dmemSize; addr += 4) {
        const val = sim.readDMEM(addr, 4);
        if (val) {
          const word = val[0] | (val[1] << 8) | (val[2] << 16) | (val[3] << 24);
          if (word !== 0) {
            dmem.push({ addr: `0x${addr.toString(16).padStart(8, '0')}`, value: `0x${word.toString(16).padStart(8, '0')}` });
          }
        }
      }
      output.memory_dump = dmem;
      fs.writeFileSync(opts.dumpMemory, JSON.stringify(dmem, null, 2), 'utf8');
    }

    const jsonStr = opts.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);

    if (opts.out) {
      fs.writeFileSync(opts.out, jsonStr + '\n', 'utf8');
    } else {
      console.log(jsonStr);
    }

    // Exit code 2 if halt watchpoint was set but NOT triggered
    const hasHaltWatchpoint = opts.watchpoints.some(w => w.type === 'halt');
    if (hasHaltWatchpoint && (!result.hitWatchpoint || result.hitWatchpoint.type !== 'halt')) {
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Simulation error: ${e.message}`
    }));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, main };