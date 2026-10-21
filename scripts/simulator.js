/**
 * simulator.js - PRU simulator wrapper for scripted validation
 *
 * Provides a modular Simulator class wrapping SysConfig's pru_core.js / pru_dmem0.js /
 * pru_smem.js simulation engines. Adds:
 *
 *   G1 - load_elf(buffer): parse TI COFF PRU firmware binaries, load sections into DMEM/SMEM
 *   G2 - step() / stepPaced(): single-cycle through multi-cycle stepping for lock-step multicore runs
 *   G3 - runUntil({maxCycles, watchpoints}): halt on cycle budget, halt, PC, register, or memory conditions
 *   G4 - exportVcd(filePath): Value Change Dump waveform export
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
// the same-line label grammar must be the repo's canonical
// one (asm_label.js splitLabel, [A-Za-z0-9_?$]+). A narrower regex such as
// [A-Za-z_$][\w$]* rejects `?` anywhere and leading digits, so e.g.
// `pb_ws?: add r1,r1,1` would not register pb_ws? as a label and a
// `qbne pb_ws?, r1, 3` branch would silently fall through with errorParsing set.
const { splitLabel } = require('./asm_label');

/**
 * Minimal TI COFF (Common Object File Format) parser for PRU firmware .out files.
 *
 * The TI PRU toolchain (clpru) produces COFF REL32 files. This parser extracts:
 *   - File header
 *   - Section headers (.text, .data, .bss, etc.)
 *   - Section raw data
 *   - Symbol table entries
 *
 * TI COFF reference:
 *   https://www.ti.com/lit/an/spraao8/spraao8.pdf
 */
class CoffParser {
  /**
   * @param {Buffer} buffer - Raw binary buffer of a COFF .out file
   */
  constructor(buffer) {
    this.buffer = buffer;
    this.header = null;
    this.sections = [];
    this.symbols = [];
    this.stringTable = null;
  }

  /**
   * Parse the COFF file structure.
   * @returns {this}
   */
  parse() {
    const buf = this.buffer;
    if (buf.length < 22) {
      throw new Error(`COFF file too small: ${buf.length} bytes`);
    }

    // ---------- File header (20 bytes for COFF REL32) ----------
    const magic = buf.readUInt16LE(0);
    // TI PRU magic: 0x00C2 for COFF, 0x00C3 for COFF with clpru v2.3+
    if (magic !== 0x00C2 && magic !== 0x00C3) {
      throw new Error(`Not a TI COFF file. Magic: 0x${magic.toString(16)} (expected 0x00C2 or 0x00C3)`);
    }
    const nscns = buf.readUInt16LE(2);   // Number of sections
    const timdat = buf.readInt32LE(4);     // Date/time stamp
    const symptr = buf.readUInt32LE(8);    // Symbol table offset
    const nsyms = buf.readUInt32LE(12);    // Number of symbol table entries
    const opthdr = buf.readUInt16LE(16);   // Size of optional header (0 for PRU)
    const flags = buf.readUInt16LE(18);    // Flags

    this.header = { magic, nscns, timdat, symptr, nsyms, opthdr, flags };
    let offset = 20 + opthdr; // start of section headers

    // ---------- Section headers (40 bytes each) ----------
    for (let i = 0; i < nscns; i++) {
      if (offset + 40 > buf.length) break;
      const s_name = buf.toString('ascii', offset, offset + 8).replace(/\0/g, '').trim();
      const s_paddr = buf.readUInt32LE(offset + 8);
      const s_vaddr = buf.readUInt32LE(offset + 12);
      const s_size  = buf.readUInt32LE(offset + 16);
      const s_scnptr = buf.readUInt32LE(offset + 20);
      const s_relptr = buf.readUInt32LE(offset + 24);
      const s_lnnoptr = buf.readUInt32LE(offset + 28);
      const s_nreloc = buf.readUInt16LE(offset + 32);
      const s_nlnno = buf.readUInt16LE(offset + 34);
      const s_flags = buf.readUInt32LE(offset + 36);

      // Load raw data if the section has content and is not BSS (0x80)
      let data = null;
      const IS_BSS = (s_flags & 0x80) !== 0;
      if (!IS_BSS && s_size > 0 && s_scnptr > 0 && s_scnptr + s_size <= buf.length) {
        data = buf.slice(s_scnptr, s_scnptr + s_size);
      }

      this.sections.push({
        name: s_name,
        paddr: s_paddr,
        vaddr: s_vaddr,
        size: s_size,
        scnptr: s_scnptr,
        relptr: s_relptr,
        nreloc: s_nreloc,
        flags: s_flags,
        data
      });

      offset += 40;
    }

    // ---------- Symbol table ----------
    if (symptr > 0 && nsyms > 0) {
      let symOff = symptr;
      for (let i = 0; i < nsyms; i++) {
        if (symOff + 18 > buf.length) break;
        // Symbol name (8 bytes: either inline string or offset into string table)
        const n_name = buf.toString('ascii', symOff, symOff + 8);
        const n_value = buf.readInt32LE(symOff + 8);
        const n_scnum = buf.readInt16LE(symOff + 12);
        const n_type  = buf.readUInt16LE(symOff + 14);
        const n_sclass = buf.readUInt8(symOff + 16);
        const n_numaux = buf.readUInt8(symOff + 17);

        // Check if name is a string table offset (first 4 bytes form an offset when starts with \0\0\0\0)
        let name = n_name.replace(/\0/g, '').trim();
        if (name.length === 0 || (name.length > 0 && n_name.charCodeAt(0) === 0)) {
          // Name is in string table: offset is n_name as uint32
          const strOff = buf.readUInt32LE(symOff);
          if (strOff > 0 && this.stringTable && strOff < this.stringTable.length) {
            name = this.stringTable.toString('ascii', strOff).split('\0')[0];
          } else {
            name = `unnamed_${i}`;
          }
        }

        this.symbols.push({ name, value: n_value, scnum: n_scnum, type: n_type, sclass: n_sclass, numaux: n_numaux });
        symOff += 18;
      }

      // String table immediately follows symbol table entries
      const strTabOff = symptr + nsyms * 18;
      if (strTabOff < buf.length) {
        const strTabSize = buf.readUInt32LE(strTabOff);
        if (strTabSize > 0 && strTabOff + strTabSize <= buf.length) {
          this.stringTable = buf.slice(strTabOff, strTabOff + strTabSize);
        }
      }
    }

    return this;
  }

  /**
   * Get a specific section by name.
   * @param {string} name
   * @returns {Object|null}
   */
  section(name) {
    return this.sections.find(s => s.name === name) || null;
  }

  /**
   * Get the entry point (symbol "_c_int00" or first defined symbol value)
   * @returns {number}
   */
  entryPoint() {
    const main = this.symbols.find(s => s.name === '_c_int00' || s.name === '_start' || s.name === 'main');
    if (main) return main.value >>> 0;
    // Fall back to .text section vaddr
    const text = this.section('.text');
    return text ? text.vaddr : 0;
  }
}

/**
 * COFF symbol storage class constants used by TI tools
 */
const C_FILE = 0x66;
const C_EXT = 0x02;
const C_STAT = 0x03;
const C_LABEL = 0x05;
const C_MOS = 0x1A;
const C_MOE = 0x1B;

/**
 * Multi-format ELF/COFF loader for PRU firmware binaries.
 * Handles both TI COFF (.out) and ELF (.out/.elf) with .pru encoding.
 *
 * @param {Buffer} buffer - Raw firmware binary
 * @returns {Object} { text: Buffer, data: Buffer|null, symbols: Array, entryPoint: number }
 */
function loadPruFirmware(buffer) {
  if (buffer.length < 4) {
    throw new Error(`Firmware buffer too small: ${buffer.length} bytes`);
  }

  // Detect format by magic bytes
  const magic16 = buffer.readUInt16LE(0);
  const magic32 = buffer.readUInt32LE(0);

  // ELF magic: 0x7F 'E' 'L' 'F'
  if (buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    return loadElfFirmware(buffer);
  }

  // TI COFF magic
  if (magic16 === 0x00C2 || magic16 === 0x00C3) {
    return loadCoffFirmware(buffer);
  }

  // Raw binary (just instructions at offset 0)
  // Assume each instruction is 4 bytes
  // This is a fallback for simple test binaries
  return {
    text: buffer,
    data: null,
    symbols: [],
    entryPoint: 0,
    format: 'raw'
  };
}

/**
 * Load ELF PRU firmware.
 * Parses minimal ELF header to find .text and .data program headers.
 */
function loadElfFirmware(buffer) {
  if (buffer.length < 52) {
    throw new Error(`ELF file too small: ${buffer.length} bytes`);
  }

  const is64Bit = buffer[4] === 2;
  const isLittleEndian = buffer[5] === 1;
  const readU16 = isLittleEndian ? (off) => buffer.readUInt16LE(off) : (off) => buffer.readUInt16BE(off);
  const readU32 = isLittleEndian ? (off) => buffer.readUInt32LE(off) : (off) => buffer.readUInt32BE(off);
  const readU64 = isLittleEndian ? (off) => Number(buffer.readBigUInt64LE(off)) : (off) => Number(buffer.readBigUInt64BE(off));

  if (is64Bit) {
    throw new Error('64-bit ELF not supported (PRU is 32-bit)');
  }

  // ELF header fields
  const e_type = readU16(16);
  const e_machine = readU16(18);
  // PRU ELF machine IDs: EM_TI_PRU = 203 (0xCB), or EM_PRU = 0xCB
  if (e_machine !== 0xCB) {
    throw new Error(`Not a PRU ELF file. Machine: 0x${e_machine.toString(16)} (expected 0xCB)`);
  }
  const e_entry = readU32(24);
  const e_phoff = readU32(28);
  const e_shoff = readU32(32);
  const e_flags = readU32(36);
  const e_ehsize = readU16(40);
  const e_phentsize = readU16(42);
  const e_phnum = readU16(44);
  const e_shentsize = readU16(46);
  const e_shnum = readU16(48);
  const e_shstrndx = readU16(50);

  // Parse section headers to find .text and .data
  let textData = null;
  let dataSection = null;
  const symbols = [];

  if (e_shoff > 0 && e_shnum > 0) {
    // First read section name string table
    let shstrtabData = null;
    if (e_shstrndx < e_shnum && e_shstrndx >= 0) {
      const shOff = e_shoff + e_shstrndx * e_shentsize;
      const sh_nameOff = readU32(shOff + 16); // sh_offset
      const sh_size = readU32(shOff + 20);    // sh_size
      if (sh_nameOff + sh_size <= buffer.length) {
        shstrtabData = buffer.slice(sh_nameOff, sh_nameOff + sh_size);
      }
    }

    for (let i = 0; i < e_shnum; i++) {
      const shOff = e_shoff + i * e_shentsize;
      if (shOff + 40 > buffer.length) break;
      const sh_name = readU32(shOff);
      const sh_type = readU32(shOff + 4);
      const sh_flags = readU32(shOff + 8);
      const sh_addr = readU32(shOff + 12);
      const sh_offset = readU32(shOff + 16);
      const sh_size = readU32(shOff + 20);
      const sh_link = readU32(shOff + 24);
      const sh_info = readU32(shOff + 28);

      // Get section name from string table
      let sectionName = '';
      if (shstrtabData && sh_name < shstrtabData.length) {
        const end = shstrtabData.indexOf(0, sh_name);
        sectionName = shstrtabData.toString('ascii', sh_name, end >= 0 ? end : undefined);
      }

      // Load section data
      let sectionData = null;
      if (sh_type !== 8 /* SHT_NOBITS */ && sh_offset + sh_size <= buffer.length && sh_size > 0) {
        sectionData = buffer.slice(sh_offset, sh_offset + sh_size);
      }

      if (sectionName === '.text' && sectionData) {
        textData = sectionData;
      }
      if ((sectionName === '.data' || sectionName === '.rodata') && sectionData) {
        dataSection = { addr: sh_addr, data: sectionData, name: sectionName };
      }

      // Parse symbol table
      if (sh_type === 2 /* SHT_SYMTAB */ && sectionData) {
        const symSize = 16; // 32-bit ELF symbol: 16 bytes
        const numSyms = Math.floor(sectionData.length / symSize);
        // Get the associated string table from sh_link
        let strTabData = null;
        if (sh_link < e_shnum && sh_link > 0) {
          const strShOff = e_shoff + sh_link * e_shentsize;
          const strOff = readU32(strShOff + 16);
          const strSize = readU32(strShOff + 20);
          if (strOff + strSize <= buffer.length) {
            strTabData = buffer.slice(strOff, strOff + strSize);
          }
        }
        for (let s = 0; s < numSyms; s++) {
          const symOff = s * 16;
          const st_name = readU32(symOff);
          const st_value = readU32(symOff + 4);
          const st_size = readU32(symOff + 8);
          const st_info = buffer.readUInt8(symOff + 12);
          const st_other = buffer.readUInt8(symOff + 13);
          const st_shndx = readU16(symOff + 14);

          let symName = '';
          if (strTabData && st_name < strTabData.length) {
            const end = strTabData.indexOf(0, st_name);
            symName = strTabData.toString('ascii', st_name, end >= 0 ? end : undefined);
          }
          symbols.push({
            name: symName,
            value: st_value,
            size: st_size,
            bind: st_info >> 4,
            type: st_info & 0xF,
            shndx: st_shndx
          });
        }
      }
    }
  }

  // Fall back to program headers if section headers didn't yield data
  if (!textData && e_phoff > 0 && e_phnum > 0) {
    for (let i = 0; i < e_phnum; i++) {
      const phOff = e_phoff + i * e_phentsize;
      if (phOff + 32 > buffer.length) break;
      const p_type = readU32(phOff);
      const p_offset = readU32(phOff + 4);
      const p_vaddr = readU32(phOff + 8);
      const p_paddr = readU32(phOff + 12);
      const p_filesz = readU32(phOff + 16);
      const p_memsz = readU32(phOff + 20);
      const p_flags = readU32(phOff + 24);
      const p_align = readU32(phOff + 28);

      if (p_type === 1 /* PT_LOAD */ && p_offset + p_filesz <= buffer.length && p_filesz > 0) {
        const segData = buffer.slice(p_offset, p_offset + p_filesz);
        // Executable segments (PF_X = 1) are .text
        if (p_flags & 1) {
          textData = segData;
        } else {
          dataSection = { addr: p_vaddr, data: segData, name: '.data' };
        }
      }
    }
  }

  return {
    text: textData || Buffer.alloc(0),
    data: dataSection,
    symbols,
    entryPoint: e_entry,
    format: 'elf'
  };
}

/**
 * Load TI COFF PRU firmware.
 */
function loadCoffFirmware(buffer) {
  const parser = new CoffParser(buffer).parse();

  const textSect = parser.section('.text');
  const dataSect = parser.section('.data');

  let dataSection = null;
  if (dataSect && dataSect.data) {
    dataSection = { addr: dataSect.vaddr, data: dataSect.data, name: '.data' };
  }
  // Also check for .const, .rodata, .bss if no .data
  if (!dataSection) {
    for (const s of ['.const', '.rodata', '.bss']) {
      const sect = parser.section(s);
      if (sect && sect.data && sect.size > 0) {
        dataSection = { addr: sect.vaddr, data: sect.data, name: s };
        break;
      }
    }
  }

  return {
    text: textSect && textSect.data ? textSect.data : Buffer.alloc(0),
    data: dataSection,
    symbols: parser.symbols,
    entryPoint: parser.entryPoint(),
    format: 'coff'
  };
}

// ---------- VCD (Value Change Dump) Export ----------

/**
 * Format a VCD timestamp line.
 * @param {number} cycle
 * @returns {string}
 */
function vcdTimestamp(cycle) {
  return `#${cycle}\n`;
}

/**
 * VCD-encode a single-bit signal value: '0' or '1'.
 * @param {number} bitValue
 * @returns {string}
 */
function vcdBit(bitValue) {
  return bitValue ? '1' : '0';
}

/**
 * VCD-encode a multi-bit signal value.
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function vcdVector(value, width) {
  return `b${value.toString(2).padStart(width, '0')} `;
}

/**
 * Export R30/R31/pin-level traces as VCD format.
 *
 * @param {Array<number>} r30History - Per-cycle R30 values
 * @param {Array<number>} [r31History] - Per-cycle R31 values
 * @param {Object} [options]
 * @param {string} [options.moduleName='PRU'] - Module name for VCD header
 * @param {string} [options.date] - Date string
 * @param {string} [options.version='PRU Simulator'] - VCD version
 * @param {number} [options.timeScale=1] - Timescale unit (ns per cycle)
 * @param {Array<number>} [options.signals] - Specific bit indices to export (default: all 32 bits)
 * @returns {string} VCD content
 */
function exportVcd(r30History, r31History, options = {}) {
  const modName = options.moduleName || 'PRU';
  const dateStr = options.date || new Date().toISOString();
  const version = options.version || 'PRU Simulator';
  const timeScale = options.timeScale || 1;
  const sigFilter = options.signals; // undefined means all
  const cycles = r30History.length;

  const lines = [];
  lines.push('$version ' + version + ' $end');
  lines.push('$date ' + dateStr + ' $end');
  lines.push('$timescale ' + timeScale + 'ns $end');
  lines.push('$scope module ' + modName + ' $end');

  // Declare R30 bits
  const r30Bits = sigFilter || Array.from({ length: 32 }, (_, i) => i);
  for (const bit of r30Bits) {
    const code = String.fromCharCode(33 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
    lines.push(`$var wire 1 ${code} R30_${bit} $end`);
  }

  // Declare R31 bits
  const r31 = r31History || [];
  const r31Bits = sigFilter || Array.from({ length: 32 }, (_, i) => i);
  for (const bit of r31Bits) {
    const code = String.fromCharCode(97 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
    lines.push(`$var wire 1 ${code} R31_${bit} $end`);
  }

  lines.push('$upscope $end');
  lines.push('$enddefinitions $end');
  lines.push('$dumpvars');

  // Initial values at cycle 0
  for (const bit of r30Bits) {
    const code = String.fromCharCode(33 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
    lines.push(`${vcdBit((r30History[0] >> bit) & 1)}${code}`);
  }
  for (const bit of r31Bits) {
    const code = String.fromCharCode(97 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
    const val = r31.length > 0 ? (r31[0] >> bit) & 1 : 0;
    lines.push(`${vcdBit(val)}${code}`);
  }
  lines.push('$end');

  // Per-cycle changes
  for (let c = 1; c < cycles; c++) {
    lines.push(vcdTimestamp(c).trim());
    for (const bit of r30Bits) {
      const prev = (r30History[c - 1] >> bit) & 1;
      const curr = (r30History[c] >> bit) & 1;
      if (curr !== prev) {
        const code = String.fromCharCode(33 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
        lines.push(`${vcdBit(curr)}${code}`);
      }
    }
    if (r31.length > c) {
      for (const bit of r31Bits) {
        const prev = (r31[c - 1] >> bit) & 1;
        const curr = (r31[c] >> bit) & 1;
        if (curr !== prev) {
          const code = String.fromCharCode(97 + (bit % 26)) + (bit < 26 ? '' : Math.floor(bit / 26).toString(36));
          lines.push(`${vcdBit(curr)}${code}`);
        }
      }
    }
  }

  return lines.join('\n') + '\n';
}

// ========================================================================
// Simulator class
// ========================================================================

const SIM_DIR = path.join(__dirname, '../.metadata/sysconfig/.meta/pru_blocks/common/simulation');

/**
 * PRU simulator with a programmatic API for scripted validation.
 *
 * Usage:
 *   const sim = new Simulator();
 *   sim.loadInstructions([...], [...labels]);
 *   const state = sim.runUntil({ maxCycles: 100, watchpoints: [{ type: 'halt' }] });
 *   console.log(state.registers);
 *
 * Multiple core simulation:
 *   const core0 = new Simulator({ id: 'PRU0' });
 *   const core1 = new Simulator({ id: 'PRU1' });
 *   for (let i = 0; i < 100; i++) {
 *     core0.stepPaced(1);
 *     core1.stepPaced(1);
 *   }
 */
/**
 * ICSSG spinlock (XFR2SPIN) ownership flags.
 *
 * SPRUIM2J Table 6-60 gives XFR2SPIN as "1 copy per PRU_ICSSG system", and
 * 6.4.6.2.9 as "64 ownership flags (shared by SLICE0 and SLICE1 within an
 * PRU_ICSSG subsystem)". The defining property is that the SAME 64 flags are
 * seen by all six cores of the subsystem.
 *
 * That is why this state is module-scoped and keyed by subsystem rather than
 * hung off pruState like every other device model in this file. Each Simulator
 * compiles its own copy of the memory models into its own vm context, so
 * per-instance state is invisible to a second core BY CONSTRUCTION - a spinlock
 * modelled that way would let both cores "win" the same flag. A lock whose
 * state is not shared is not a lock.
 *
 * Keys are subsystem ids ('icssg0' by default); values map flag id -> the core
 * id currently holding it.
 */
const SPINLOCK_FLAGS = new Map();
const SPINLOCK_NUM_FLAGS = 64;
const SPINLOCK_DEVICE_ID = 0x90; // 144

// ICSSG BS RAM — per-core private 2KB (SPRUIM2J 6.4.6.2.5 Fig 6-49).
// TRM's "16KB" line on this row is copy-pasted from the FDB table; device is
// 2KB = 64 rows x 32B, row 0..63. Broadside IDs: 48 (0x30) address+data
// XOUT/XIN, 49 (0x31) snoop XOUT. Fig 6-49 assigns one device ID per core;
// 30 (0x1E) is RTU_PRU's ID and is not BS RAM on a PRU/TX_PRU core. All data windows are
// architecturally R2..R9 (< =32B); address is R10, exactly 2 bytes. Per-core
// private means per-Simulator instance, not per-subsystem like XFR2SPIN.
const BS_RAM_DEVICE_WRITE = 48;
const BS_RAM_DEVICE_SNOOP = 49;
const BS_RAM_DEVICE_READ = 48;
const BS_RAM_NUM_ROWS = 64;
const BS_RAM_ROW_BYTES = 32;

const FDB_DEVICE_DATA_ADDR = 30;
const FDB_DEVICE_PATTERN = 31;
const FDB_DEVICE_COMPARE = 35;
const FDB_NUM_ROWS = 512;
const FDB_ROW_BYTES = 32;
const FDB_PATTERN_BYTES = 16;

function spinlockSubsystem(name) {
  if (!SPINLOCK_FLAGS.has(name)) SPINLOCK_FLAGS.set(name, new Map());
  return SPINLOCK_FLAGS.get(name);
}

class Simulator {
  // See _xfr2trDrain. Not from the TRM -- a simulator pacing choice.
  static XFR2TR_DRAIN_PERIOD_CYCLES = 20;

  // Tests must be able to start from a known state without leaking
  // ownership between scenarios; nothing in the hardware corresponds to this.
  static resetSpinlocks() { SPINLOCK_FLAGS.clear(); }

  /** Inspect who holds a flag. Simulator inspection API, not a hardware path. */
  static spinlockOwner(flagId, subsystem = 'icssg0') {
    const owner = spinlockSubsystem(subsystem).get(flagId & (SPINLOCK_NUM_FLAGS - 1));
    return owner === undefined ? null : owner;
  }

  /**
   * @param {Object} [options]
   * @param {string} [options.id='PRU0'] - Instance identifier for multicore
   * @param {boolean} [options.autoLoadSimulation=true] - Auto-load pru_core.js/dmem0/smem
   * @param {Object} [options.simulationDir] - Override simulation scripts directory
   */
  constructor(options = {}) {
    this.id = options.id || 'PRU0';
    // Which PRU_ICSSG subsystem this core belongs to. Two Simulators
    // with the same subsystem contend for one set of 64 spinlock flags; two
    // with different subsystems do not (Table 6-60: one copy per subsystem).
    this.subsystem = options.subsystem || 'icssg0';
    this._autoLoad = options.autoLoadSimulation !== false;
    this._simDir = options.simulationDir || SIM_DIR;

    // Simulation state
    this._pruState = null;
    this._instructions = [];
    this._labels = [];
    this._labelMap = {};
    this._r30History = [];
    this._r31History = [];
    this._r31HistoryMap = {};
    this._mmioMap = {};

    // Firmware loading state
    this._firmware = null;           // { text, data, symbols, entryPoint, format }
    this._dmemSymbols = {};          // Symbol name → { address, size }
    this._rawInstructions = null;    // 32-bit instruction words from .text

    // Watchpoint state
    this._watchpoints = [];
    this._watchpointHit = null;

    // pru_core.js exports (loaded on demand)
    this._pruCore = null;
    this._pruDMEM0 = null;
    this._pruSMEM = null;

    // Script loading cache
    this._scriptCache = {};
  }

  /**
   * Ensure simulation scripts are loaded (idempotent).
   */
  _ensureLoaded() {
    if (this._pruCore) return;

    if (!fs.existsSync(this._simDir)) {
      throw new Error(`Simulation directory not found: ${this._simDir}`);
    }

    // Load pru_core.js, pru_dmem0.js, pru_smem.js via Node.js vm sandbox
    this._pruCore = this._loadSimScript('pru_core.js');
    this._pruDMEM0 = this._scriptCache['pru_dmem0.js'];
    this._pruSMEM = this._scriptCache['pru_smem.js'];
  }

  /**
   * Load a SysConfig simulation script in a Node.js vm sandbox.
   * @param {string} filename
   * @returns {Object}
   */
  _loadSimScript(filename) {
    const filePath = path.join(this._simDir, filename);
    const code = fs.readFileSync(filePath, 'utf8');

    const sandbox = {
      console: { log() {}, error() {}, warn() {} },
      Math,
      parseInt,
      isNaN,
      eval,
      Uint8Array,
      Array,
      JSON,
      system: {
        getScript: (p) => {
          const basename = path.basename(p);
          if (!this._scriptCache[basename]) {
            this._scriptCache[basename] = this._loadSimScript(basename);
          }
          return this._scriptCache[basename];
        }
      },
      exports: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: filePath, timeout: 10000 });
    return sandbox.exports;
  }

  // ==================================================================
  // API: Instruction loading
  // ==================================================================

  /**
   * Load assembly instructions for simulation.
   * @param {Array<string>} instructions - Assembly instruction strings
   * @param {Array<number|string>} labels - Labels per instruction index (0 for no label)
   */
  loadInstructions(instructions, labels = []) {
    this._ensureLoaded();
    this._instructions = [...instructions];
    this._labels = [...labels];
    this._labelMap = {};
    for (let i = 0; i < this._labels.length; i++) {
      if (this._labels[i] !== 0 && this._labels[i] !== undefined) {
        this._labelMap[this._labels[i]] = i;
      }
    }
    // A macro body pasted straight out of getMacro() (the same call
    // pru_syscfg.inc.xdt makes) carries its backward-branch target as an
    // INLINE "name:" line, e.g. "xs_spin$1$:", not as an entry in the
    // parallel `labels` array above. Register those too, pointing at their
    // own index: the line itself decodes as an unknown opcode and is a
    // harmless no-op (_executeSingleInstruction's default case), so landing
    // on it and falling through to the next real instruction is correct.
    // Without this, qbbc/qbbs/qbeq/... targeting such a label found no entry
    // in labelMap, the branch was silently not taken, and a contended spin
    // loop looked like a single arbitration attempt instead of a spin.
    //
    // Not every producer splits same-line labels before calling
    // loadInstructions (scripts that pass raw macro lines through do not).
    // loadInstructions therefore handles `lbl: instr` itself:
    // the label is registered at the line's own index and the stored line is
    // replaced with the bare instruction, so a branch to the label EXECUTES
    // that instruction instead of no-oping past it (and sequential flow no
    // longer silently drops it). It changes nothing for bare labels.
    for (let i = 0; i < this._instructions.length; i++) {
      const line = this._instructions[i];
      if (typeof line !== 'string') continue;
      // same label grammar as asm_label.js (reused, not
      // duplicated) - accepts `?` and leading digits in label names.
      const parts = splitLabel(line);
      if (!parts || !parts.label) continue;
      if (this._labelMap[parts.label] === undefined) this._labelMap[parts.label] = i;
      if (parts.rest) this._instructions[i] = parts.rest;
    }
    this._resetState();
  }

  /**
   * G1: Load PRU firmware binary (.out / .elf) via COFF/ELF parsing.
   *
   * Parses the binary to extract:
   *   - .text section (instructions) - stored as raw 32-bit words
   *   - .data section - loaded into DMEM0
   *   - Symbol table - available for watchpoint/breakpoint lookup
   *
   * Note: The simulator currently executes string-based assembly instructions.
   * This method stores the firmware's memory image and symbols. A future
   * enhancement will add raw opcode execution. For now, use loadInstructions()
   * with assembly strings, then load_elf() for data/symbol context.
   *
   * @param {Buffer|string} source - Binary buffer or path to .out/.elf file
   * @returns {Object} Parsed firmware info
   */
  load_elf(source) {
    this._ensureLoaded();

    const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    const firmware = loadPruFirmware(buffer);
    this._firmware = firmware;

    // Load data section into DMEM0
    if (firmware.data && firmware.data.data) {
      const dmemAddr = firmware.data.addr;
      this._pruDMEM0.writeDMEM0(dmemAddr, firmware.data.data);
    }

    // Register symbols from the binary
    this._dmemSymbols = {};
    for (const sym of firmware.symbols) {
      if (sym.name && typeof sym.value === 'number') {
        // For COFF symbol table entries with scnum > 0 (defined in a section)
        const addr = sym.value >>> 0;
        const size = sym.size || 4;
        this._dmemSymbols[sym.name] = { address: addr, size };
        this._pruDMEM0.addSymbol(sym.name, addr, size);
      }
    }

    // Store raw text section
    if (firmware.text && firmware.text.length > 0) {
      this._rawInstructions = [];
      for (let i = 0; i < firmware.text.length; i += 4) {
        if (i + 4 <= firmware.text.length) {
          this._rawInstructions.push(firmware.text.readUInt32LE(i));
        }
      }
    }

    return firmware;
  }

  // ==================================================================
  // API: Simulation control
  // ==================================================================

  /**
   * Reset simulation state (registers, history, PC, cycles).
   */
  _resetState() {
    this._pruState = {
      registers: new Array(32).fill(0),
      pc: 0,
      cycles: 0,
      carry: 0,
      loopStack: [],
      unknownInstruction: 0,
      errorParsing: 0,
      r31HistoryMap: this._r31HistoryMap,
      mmioMap: this._mmioMap,
      iepCount: 0,
      iepCmp0: 0,
      iepCmp1: 0,
      iepCmpStatus: 0,
      // XFR2TR ring state (SPRUIM2J Table 6-112). queue holds the
      // submitted-but-not-yet-drained TR IDs (capacity 8, the FIFO depth).
      xfr2tr: null,
      // BS RAM 2KB per-core private 64x32B. Per-core means per-Simulator
      // instance (this._pruState), not per-subsystem like XFR2SPIN. Lazily
      // allocated; each row is 8 words (32 bytes). Device IDs 48/49 are not
      // handled by the flat SPAD model (_spad): they are BS RAM or unsupported,
      // so a broadside access cannot appear to work by accident.
      bsRam: null,
      bsRamAddr: 0,
      fdb: null,
      unsupported_xfr: [],
      queue_empty: this._queueEmptyStatus !== undefined ? this._queueEmptyStatus : 0xFFFFFFFF
    };
    this._r30History = [0];
    this._r31History = [0];
    this._watchpointHit = null;
  }

  /**
   * Get current R30 value history (per-cycle snapshot).
   * @returns {Array<number>}
   */
  get r30History() {
    return [...this._r30History];
  }

  /**
   * Get current R31 value history (per-cycle snapshot).
   * @returns {Array<number>}
   */
  get r31History() {
    return [...this._r31History];
  }

  /**
   * Get current simulation state (registers, PC, cycles).
   * @returns {Object}
   */
  get state() {
    if (!this._pruState) return null;
    return {
      registers: [...this._pruState.registers],
      pc: this._pruState.pc,
      cycles: this._pruState.cycles,
      carry: this._pruState.carry,
      iepCount: this._pruState.iepCount,
      iepCmp0: this._pruState.iepCmp0,
      iepCmp1: this._pruState.iepCmp1,
      iepCmpStatus: this._pruState.iepCmpStatus,
      xfr2tr: this._pruState.xfr2tr ? JSON.parse(JSON.stringify(this._pruState.xfr2tr)) : null,
      bsRam: this._pruState.bsRam ? JSON.parse(JSON.stringify(this._pruState.bsRam)) : null,
      bsRamAddr: this._pruState.bsRamAddr,
      fdb: this._pruState.fdb ? {
        address: this._pruState.fdb.address,
        addressSet: this._pruState.fdb.addressSet,
        patternBytes: this._pruState.fdb.patternBytes,
        writes: this._pruState.fdb.writes,
        reads: this._pruState.fdb.reads,
        patternSets: this._pruState.fdb.patternSets,
        compares: this._pruState.fdb.compares
      } : null,
      // Per-core spinlock arbitration tally. The flag OWNERSHIP table
      // is deliberately not exposed here - it is subsystem state shared by all
      // six cores, not this core's state; read it via Simulator.spinlockOwner.
      spinlock: this._pruState.spinlock ? { ...this._pruState.spinlock } : null,
      spinlockForeignReleases: this._pruState.spinlockForeignReleases
        ? this._pruState.spinlockForeignReleases.map((r) => ({ ...r })) : [],
      unsupported_xfr: this._pruState.unsupported_xfr ? [...this._pruState.unsupported_xfr] : [],
      unknownInstruction: this._pruState.unknownInstruction,
      errorParsing: this._pruState.errorParsing
    };
  }

  /**
   * Set ICSSG QUEUE_EMPTY status for broadside device 0xF0.
   * @param {number} status - 32-bit queue empty bitmask
   */
  setQueueEmptyStatus(status) {
    this._queueEmptyStatus = status >>> 0;
    if (this._pruState) this._pruState.queue_empty = this._queueEmptyStatus;
  }

  /**
   * Set R31 input injection map.
   * @param {Object} map - Cycle → value
   */
  setR31Map(map) {
    this._r31HistoryMap = { ...map };
    if (this._pruState) {
      this._pruState.r31HistoryMap = this._r31HistoryMap;
    }
  }

  /**
   * Set MMIO register map.
   * @param {Object} map - Address → [{ cycle, value }, ...]
   */
  setMmioMap(map) {
    this._mmioMap = { ...map };
    if (this._pruState) {
      this._pruState.mmioMap = this._mmioMap;
    }
  }

  /**
   * G2: Step the simulation by exactly N cycles.
   *
   * Unlike the original simulatePruInstructions() which runs to completion,
   * step() executes up to `cycleCount` cycles and returns. Multiple
   * Simulator instances can be stepped in lockstep for multicore
   * co-simulation.
   *
   * @param {number} [cycleCount=1] - Number of cycles to execute
   * @returns {Object} Simulation state after stepping
   */
  stepPaced(cycleCount = 1) {
    this._ensureLoaded();
    if (!this._instructions.length) {
      throw new Error('No instructions loaded. Call loadInstructions() first.');
    }
    if (this._pruState && this._pruState.pc >= this._instructions.length) {
      // PC is out of bounds — simulation has ended
      return this.state;
    }

    // Reset if fresh
    if (!this._pruState) {
      this._resetState();
    }

    const targetCycle = this._pruState.cycles + cycleCount;
    const pruCore = this._pruCore;
    const instructions = this._instructions;
    const labelMap = this._labelMap;
    const r30History = this._r30History;
    const r31History = this._r31History;
    const pruState = this._pruState;

    while (pruState.cycles < targetCycle && pruState.pc < instructions.length) {
      // HALT detection: HALT instruction sets cycles = ARBITRARILY HIGH to end simulation
      // We need to check if the last instruction was HALT
      const instr = instructions[pruState.pc];
      if (instr && instr.toUpperCase().trim() === 'HALT') {
        // Record the halted state
        pruState.cycles++;
        r30History.push(pruState.registers[30]);
        r31History.push(pruState.registers[31]);
        pruState.pc++;
        break;
      }

      // Execute one instruction via pru_core's function
      // We can't call pruCore.simulatePruInstructions() directly since it
      // starts fresh. Instead we replicate the inner loop manually.
      pruCore._executeSingleInstruction
        ? pruCore._executeSingleInstruction(pruState, instructions, labelMap, r30History, r31History, targetCycle)
        : this._executeSingleInstruction(pruState, instructions, labelMap, r30History, r31History, targetCycle);
    }

    return this.state;
  }

  /**
   * The flag this core is currently pointing at.
   *
   * Table 6-98: "R1.b0[5-0] ... own_req_vector[5:0] input ... Defines which
   * flag to arbitrate", and 6.4.6.2.9 notes R1.b0 is "snooped or continually
   * monitored by the Spinlock" - so the selector is simply whatever is in
   * R1.b0 at the moment of the transaction, not something latched by an
   * earlier XOUT.
   */
  _spinlockSelectedFlag(pruState) {
    return (pruState.registers[1] >>> 0) & (SPINLOCK_NUM_FLAGS - 1);
  }

  /**
   * XIN 0x90 - arbitrate for the selected flag and return ownership in
   * R1.b3[0] (own_req_status; 0h lost, 1h won).
   *
   * Mutual exclusion lives here: the flag table is shared across Simulator
   * instances of the same subsystem, so once one core holds a flag every other
   * core's XIN returns 0 and its generated spin loop cannot fall through. The
   * result is written as a single BIT; the other seven bits of R1.b3 are left
   * alone, which is what makes the block's `and RES, R1.b3, 1` mask load
   * bearing rather than cosmetic.
   */
  _spinlockArbitrate(pruState, destRegN) {
    // Table 6-98 names R1 (b3) as the arbitration register. An XIN aimed
    // anywhere else is recorded, not silently answered.
    if (destRegN !== 1) {
      this._recordUnsupportedXfr(pruState, SPINLOCK_DEVICE_ID);
      return;
    }
    const flags = spinlockSubsystem(this.subsystem);
    const flagId = this._spinlockSelectedFlag(pruState);
    const holder = flags.get(flagId);

    let won;
    if (holder === undefined) {
      // Free: this core takes it. Fixed-priority arbitration (6.4.6.2.9) is
      // not modelled as a priority order because only one core can be inside
      // this call at a time in a lockstep-stepped co-simulation; what IS
      // modelled is that the loser gets 0.
      flags.set(flagId, this.id);
      won = 1;
    } else if (holder === this.id) {
      // Already ours. The TRM gives no re-entrancy semantics; re-arbitrating
      // for a flag you already hold returns "owned" because own_req_status
      // reports ownership, not a transition.
      won = 1;
    } else {
      won = 0;
    }

    const bit = 1 << 24; // R1.b3[0]
    pruState.registers[1] = ((pruState.registers[1] >>> 0) & ~bit) | (won ? bit : 0);
    pruState.registers[1] = pruState.registers[1] >>> 0;

    if (!pruState.spinlock) pruState.spinlock = { acquires: 0, wins: 0, losses: 0, releases: 0 };
    pruState.spinlock.acquires++;
    if (won) pruState.spinlock.wins++; else pruState.spinlock.losses++;
  }

  /**
   * XOUT 0x90 - "Flag clear" (Table 6-98).
   *
   * Modelled faithfully as an UNCONDITIONAL clear of the flag selected by
   * R1.b0: the TRM describes own_req_clr as clearing that flag, with no owner
   * check. That is precisely why releasing a lock this core never acquired is
   * dangerous, and why validateXfr2spinGlobal rejects an unmatched release at
   * build time. Softening it here to "only the owner may clear" would hide the
   * very hazard the validator exists to prevent.
   */
  _spinlockRelease(pruState, srcRegN) {
    if (srcRegN !== 1) {
      this._recordUnsupportedXfr(pruState, SPINLOCK_DEVICE_ID);
      return;
    }
    const flags = spinlockSubsystem(this.subsystem);
    const flagId = this._spinlockSelectedFlag(pruState);
    const holder = flags.get(flagId);

    if (!pruState.spinlock) pruState.spinlock = { acquires: 0, wins: 0, losses: 0, releases: 0 };
    pruState.spinlock.releases++;
    if (holder !== undefined && holder !== this.id) {
      if (!pruState.spinlockForeignReleases) pruState.spinlockForeignReleases = [];
      pruState.spinlockForeignReleases.push({ flagId, heldBy: holder, clearedBy: this.id });
    }
    flags.delete(flagId);
  }

  /**
   * BS RAM 64x32B per-core private (SPRUIM2J 6.4.6.2.5).
   */
  _bsRamState(pruState) {
    if (!pruState.bsRam) {
      pruState.bsRam = Array.from({ length: BS_RAM_NUM_ROWS }, () => new Array(8).fill(0));
      pruState.bsRamAddr = 0;
    }
    return pruState.bsRam;
  }

  _bsRamXout(pruState, bank, srcRegN, count) {
    // Address programming: R10, exactly 2 bytes, selects row 0..63.
    if (srcRegN === 10 && bank === BS_RAM_DEVICE_WRITE) {
      if (count !== 2) { this._recordUnsupportedXfr(pruState, bank); return; }
      const row = pruState.registers[10] & 0xFFFF;
      // The TRM is silent on 64..511; validator should have refused. Simulator
      // does not invent a wrap — treat >63 as unsupported and leave address unchanged.
      if (row > 63) { this._recordUnsupportedXfr(pruState, bank); return; }
      this._bsRamState(pruState);
      pruState.bsRamAddr = row & 0x3F;
      return;
    }
    // Data write: R2..R9 window, up to 32B. Both direct (48) and snoop (49) share this window.
    if ((bank === BS_RAM_DEVICE_WRITE || bank === BS_RAM_DEVICE_SNOOP) && srcRegN === 2) {
      if (count < 1 || count > 32) { this._recordUnsupportedXfr(pruState, bank); return; }
      const bs = this._bsRamState(pruState);
      const row = pruState.bsRamAddr & 0x3F;
      if (row >= BS_RAM_NUM_ROWS) { this._recordUnsupportedXfr(pruState, bank); return; }
      const words = Math.ceil(count / 4);
      for (let i = 0; i < words && i < 8; i++) {
        bs[row][i] = pruState.registers[2 + i] >>> 0;
      }
      // AutoIndex would increment here; TRM silent past row 63, so simulator
      // does NOT auto-wrap — validator is the guard.
      return;
    }
    // Anything else on BS RAM IDs is unsupported (wrong register/window/size).
    this._recordUnsupportedXfr(pruState, bank);
  }

  _bsRamXin(pruState, bank, destRegN, count) {
    // Snoop (49) is XOUT-only; XIN on snoop is unsupported.
    if (bank === BS_RAM_DEVICE_SNOOP) { this._recordUnsupportedXfr(pruState, bank); for (let i=0;i<Math.ceil(count/4)&&destRegN+i<=31;i++) pruState.registers[destRegN+i]=0; return; }
    if (bank === BS_RAM_DEVICE_READ) {
      if (destRegN !== 2 || count < 1 || count > 32) { this._recordUnsupportedXfr(pruState, bank); for (let i=0;i<Math.ceil(count/4)&&destRegN+i<=31;i++) pruState.registers[destRegN+i]=0; return; }
      const bs = this._bsRamState(pruState);
      const row = pruState.bsRamAddr & 0x3F;
      if (row >= BS_RAM_NUM_ROWS) { this._recordUnsupportedXfr(pruState, bank); return; }
      const words = Math.ceil(count / 4);
      for (let i = 0; i < words && i < 8; i++) {
        if (destRegN + i <= 31) pruState.registers[destRegN + i] = bs[row][i] >>> 0;
      }
      return;
    }
    this._recordUnsupportedXfr(pruState, bank);
  }

  _fdbState(pruState) {
    if (!pruState.fdb) {
      pruState.fdb = {
        table: Array.from({ length: FDB_NUM_ROWS }, () => new Uint8Array(FDB_ROW_BYTES)),
        address: 0,
        addressSet: false,
        pattern: new Uint8Array(FDB_PATTERN_BYTES),
        patternBytes: 0,
        writes: 0,
        reads: 0,
        patternSets: 0,
        addressSets: 0,
        compares: 0
      };
    }
    return pruState.fdb;
  }

  _copyRegsToBytes(pruState, startReg, count, maxBytes) {
    const n = Math.min(count, maxBytes);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const regIdx = startReg + Math.floor(i / 4);
      const byteInReg = i % 4;
      out[i] = ((pruState.registers[regIdx] >>> 0) >>> (byteInReg * 8)) & 0xFF;
    }
    return out;
  }

  _copyBytesToRegs(pruState, bytes, startReg, count) {
    const regs = Math.ceil(count / 4);
    for (let r = 0; r < regs && startReg + r <= 31; r++) pruState.registers[startReg + r] = 0;
    for (let i = 0; i < count && i < bytes.length; i++) {
      const regIdx = startReg + Math.floor(i / 4);
      const byteInReg = i % 4;
      if (regIdx <= 31) pruState.registers[regIdx] = (pruState.registers[regIdx] | (bytes[i] << (byteInReg * 8))) >>> 0;
    }
  }

  _fdbXout(pruState, bank, srcRegN, count) {
    const fdb = this._fdbState(pruState);
    if (bank === FDB_DEVICE_DATA_ADDR && srcRegN === 10) {
      if (count !== 2) { this._recordUnsupportedXfr(pruState, bank); return; }
      fdb.address = (pruState.registers[10] >>> 0) & 0x1FF;
      fdb.addressSet = true;
      fdb.addressSets++;
      return;
    }
    if (bank === FDB_DEVICE_DATA_ADDR && srcRegN === 2) {
      if (!fdb.addressSet || count < 1 || count > FDB_ROW_BYTES) { this._recordUnsupportedXfr(pruState, bank); return; }
      const bytes = this._copyRegsToBytes(pruState, 2, count, FDB_ROW_BYTES);
      fdb.table[fdb.address].set(bytes, 0);
      fdb.writes++;
      return;
    }
    if (bank === FDB_DEVICE_PATTERN && srcRegN === 2) {
      if (count < 1 || count > FDB_PATTERN_BYTES) { this._recordUnsupportedXfr(pruState, bank); return; }
      const bytes = this._copyRegsToBytes(pruState, 2, count, FDB_PATTERN_BYTES);
      fdb.pattern.fill(0);
      fdb.pattern.set(bytes, 0);
      fdb.patternBytes = count;
      fdb.patternSets++;
      return;
    }
    this._recordUnsupportedXfr(pruState, bank);
  }

  _fdbXin(pruState, bank, destRegN, count) {
    const fdb = this._fdbState(pruState);
    if (bank === FDB_DEVICE_DATA_ADDR) {
      if (!fdb.addressSet || destRegN !== 2 || count < 1 || count > FDB_ROW_BYTES) {
        this._recordUnsupportedXfr(pruState, bank);
        return;
      }
      this._copyBytesToRegs(pruState, fdb.table[fdb.address], 2, count);
      fdb.reads++;
      return;
    }
    if (bank === FDB_DEVICE_COMPARE) {
      if (destRegN !== 10 || count < 1 || count > 2) { this._recordUnsupportedXfr(pruState, bank); return; }
      let matched = fdb.addressSet && fdb.patternBytes > 0 ? 1 : 0;
      if (matched) {
        const row = fdb.table[fdb.address];
        for (let i = 0; i < fdb.patternBytes; i++) {
          if (row[i] !== fdb.pattern[i]) { matched = 0; break; }
        }
      }
      pruState.registers[10] = (pruState.registers[10] & ~0xFF) | matched;
      fdb.compares++;
      return;
    }
    this._recordUnsupportedXfr(pruState, bank);
  }

  /**
   * XFR2TR ring state (SPRUIM2J Table 6-112), lazily created on the
   * first XOUT that touches BS ID 0x70/0x71/0x72.
   */
  _xfr2trState(pruState) {
    if (!pruState.xfr2tr) {
      pruState.xfr2tr = { sourceBase: 0, trSize: 8, ringBase: 0, ringNums: 0, writePtr: 0, queue: [], nextDrainCycle: null };
    }
    return pruState.xfr2tr;
  }

  /**
   * A broadside ID this block did not model in the direction it was used
   * (e.g. XIN on the XOUT-only 0x70/0x72, or an XOUT/XIN with the wrong
   * register/byte-count). Table 6-112 and PR #30's policy: record it and
   * continue, do not trap and do not invent generic FIFO/staged-data state.
   */
  _recordUnsupportedXfr(pruState, id) {
    if (!pruState.unsupported_xfr) pruState.unsupported_xfr = [];
    if (pruState.unsupported_xfr.indexOf(id) === -1) pruState.unsupported_xfr.push(id);
  }

  /**
   * Table 6-112's submit FIFO drains into the ring in the background as
   * hardware processes it, but the TRM does not document a drain rate,
   * cycles-per-ID or otherwise. Draining once per EXECUTED INSTRUCTION would
   * undo a tight burst of back-to-back submits before a design could ever
   * reach the 8-entry capacity, so this paces draining on elapsed CYCLES
   * instead (XFR2TR_DRAIN_PERIOD_CYCLES) -- a documented simulator modeling
   * choice, not a hardware timing claim. It is slow enough that a short
   * submit burst fills the FIFO, and frequent enough that a genuine
   * wait-for-busy poll loop (which spans many cycles) makes real progress
   * rather than livelocking against a HOLD.
   */
  _xfr2trDrain(pruState) {
    const tr = pruState.xfr2tr;
    if (!tr || !tr.queue.length) return;
    if (tr.nextDrainCycle === null) {
      tr.nextDrainCycle = pruState.cycles + Simulator.XFR2TR_DRAIN_PERIOD_CYCLES;
      return;
    }
    if (pruState.cycles < tr.nextDrainCycle) return;
    tr.queue.shift();
    const ringSize = tr.ringNums + 1;
    tr.writePtr = ringSize > 0 ? (tr.writePtr + 1) % ringSize : 0;
    tr.nextDrainCycle = pruState.cycles + Simulator.XFR2TR_DRAIN_PERIOD_CYCLES;
  }

  /**
   * XOUT to BS ID 0x70/0x71/0x72. Returns true if PC should advance, false to
   * HOLD (Table 6-112's 8-level FIFO is full): no side effect is applied and
   * the same instruction is retried next cycle, using the existing PC-hold
   * pattern rather than rewinding PC or replaying a partial XOUT.
   */
  _xfr2trXout(pruState, bank, srcRegN, count) {
    const tr = this._xfr2trState(pruState);
    if (bank === 112) {
      // BS ID 0x70 XOUT: R6[17:0]=tr_msrc_base, R7[0]=tr_size. Write-only.
      if (srcRegN !== 6 || count !== 8) { this._recordUnsupportedXfr(pruState, bank); return true; }
      tr.sourceBase = pruState.registers[6] >>> 0 & 0x3FFFF;
      tr.trSize = (pruState.registers[7] & 1) ? 64 : 8;
      return true;
    }
    if (bank === 113) {
      // BS ID 0x71 XOUT: R6[17:0]=tr_rsrc_base, R7[19:8]=tr_rsrc_nums, R7[1]=tr_rscr_reset.
      if (srcRegN !== 6 || count !== 8) { this._recordUnsupportedXfr(pruState, bank); return true; }
      tr.ringBase = pruState.registers[6] >>> 0 & 0x3FFFF;
      tr.ringNums = (pruState.registers[7] >>> 8) & 0xFFF;
      if (pruState.registers[7] & 2) { tr.queue = []; tr.writePtr = 0; }
      return true;
    }
    // BS ID 0x72 XOUT: R5:R2 packed TR IDs, 2 bytes/ID, left packed, no holes.
    // ID 0 is a valid TR ID (Table 6-112: R2[11:0]=ID0), never a hole/sentinel.
    if (srcRegN !== 2 || count < 2 || count > 16 || (count % 2) !== 0) {
      this._recordUnsupportedXfr(pruState, bank);
      return true;
    }
    const numIds = count / 2;
    const ids = [];
    for (let i = 0; i < numIds; i++) {
      const word = pruState.registers[2 + Math.floor(i / 2)] >>> 0;
      ids.push((i % 2 === 0) ? (word & 0xFFF) : ((word >>> 16) & 0xFFF));
    }
    if (tr.queue.length + ids.length > 8) return false; // HOLD: no side effect, PC does not advance.
    tr.queue.push.apply(tr.queue, ids);
    return true;
  }

  /**
   * XIN from BS ID 0x71 (the only XFR2TR port with a documented XIN
   * direction). 0x70/0x72 are XOUT-only in Table 6-112; an XIN aimed at them
   * is recorded as unsupported and zero-filled rather than answered.
   */
  _xfr2trXin(pruState, bank, destRegN, count) {
    if (bank !== 113 || destRegN !== 7 || count !== 8) {
      this._recordUnsupportedXfr(pruState, bank);
      for (let i = 0; i < Math.ceil(count / 4) && destRegN + i <= 31; i++) pruState.registers[destRegN + i] = 0;
      return;
    }
    const tr = this._xfr2trState(pruState);
    const occ = Math.min(tr.queue.length, 0xF);
    pruState.registers[7] = ((tr.queue.length ? 1 : 0) | (occ << 8)) >>> 0;
    pruState.registers[8] = tr.writePtr >>> 0;
  }

  /**
   * Internal single-instruction execution (mirrors pru_core.js executeInstruction).
   */
  /**
   * Conditional-branch decode, aligned case-for-case with the
   * production core in
   * .metadata/sysconfig/.meta/pru_blocks/common/simulation/pru_core.js.
   *
   * Every block in this repo emits TI syntax, where the LABEL is operand 0:
   *
   *     qbbc  xs_spin?, R1.b3, 0
   *
   * That is what clpru assembles and what pru_core.js decodes. This decoder
   * used to read operand 0 as the register and operand 2 as the label - the
   * reverse - so _parseRegister("xs_spin?") failed, _handleParsingError bumped
   * the pc, and the branch was SILENTLY not taken. Nothing was reported: the
   * spin loop in m_xfr2spin_acquire fell straight through its own backward
   * branch and a contended lock therefore looked like a single lost
   * arbitration instead of a core parked in a loop. Every wait/spin loop run
   * through Simulator.stepPaced had the same hole; no call site in the repo
   * ever used the reversed order, so nothing depended on it.
   *
   * An unresolved target is counted as a parse error rather than silently
   * stepping to the next instruction, again matching pru_core.js: a branch to
   * a label that is not in the map is a broken program, and staying quiet
   * about it is what made the original defect invisible.
   */
  _executeConditionalBranch(pruState, opcode, operands, labelMap) {
    const label = (operands[0] || '').replace(/[,:]/g, '').trim();

    const reg1Info = this._parseRegister((operands[1] || '').replace(/,/g, ''));
    if (this._handleParsingError(pruState, reg1Info)) { pruState.pc++; return; }
    const reg1Value = this._getRegisterValue(pruState, reg1Info);

    const op2 = (operands[2] || '').replace(/,/g, '').trim();
    let src2Value;
    if (op2.toLowerCase().startsWith('r')) {
      const reg2Info = this._parseRegister(op2);
      if (this._handleParsingError(pruState, reg2Info)) { pruState.pc++; return; }
      src2Value = this._getRegisterValue(pruState, reg2Info);
    } else {
      src2Value = this._parseImmediate(op2);
      if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; return; }
    }

    // Comparison direction follows pru_core.js: for QBGT/QBGE/QBLT/QBLE the
    // form is `QB<cmp> LABEL, REG1, OP` and the test is OP <cmp> REG1.
    let take;
    switch (opcode) {
      case 'QBEQ': take = reg1Value === src2Value; break;
      case 'QBNE': take = reg1Value !== src2Value; break;
      case 'QBGT': take = (src2Value >>> 0) > (reg1Value >>> 0); break;
      case 'QBGE': take = (src2Value >>> 0) >= (reg1Value >>> 0); break;
      case 'QBLT': take = (src2Value >>> 0) < (reg1Value >>> 0); break;
      case 'QBLE': take = (src2Value >>> 0) <= (reg1Value >>> 0); break;
      case 'QBBS': take = (reg1Value & (1 << (src2Value & 0x1F))) !== 0; break;
      case 'QBBC': take = (reg1Value & (1 << (src2Value & 0x1F))) === 0; break;
      default: pruState.pc++; return;
    }

    if (!take) { pruState.pc++; return; }
    if (labelMap[label] !== undefined) {
      pruState.pc = labelMap[label];
    } else {
      pruState.errorParsing++;
      pruState.pc++;
    }
  }

  _executeSingleInstruction(pruState, instructions, labelMap, r30History, r31History, maxCycles) {
    const instr = instructions[pruState.pc];

    // Skip placeholder instructions
    if (instr === 0 || !instr) {
      pruState.pc++;
      return;
    }

    const instructionMatch = instr.trim().match(/^(\S+)(?:\s+(.*))?$/);
    if (!instructionMatch) {
      pruState.pc++;
      pruState.cycles++;
      return;
    }

    const opcode = instructionMatch[1].toUpperCase();
    const operandsString = instructionMatch[2] || '';
    const operands = operandsString.split(/,\s*/).map(op => op.trim());

    let cyclesToAdd = 1;

    switch (opcode) {
      case 'LDI': {
        const regInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        const src2Value = this._parseImmediate(operands[1]);
        if (this._handleParsingError(pruState, regInfo, src2Value)) { pruState.pc++; break; }
        let finalValue;
        if (regInfo.type === 'byte') finalValue = (src2Value >>> 0) & 0xFF;
        else if (regInfo.type === 'word') finalValue = (src2Value >>> 0) & 0xFFFF;
        else finalValue = (src2Value >>> 0) & 0xFFFF;
        this._setRegisterValue(pruState, regInfo, finalValue);
        pruState.pc++;
        break;
      }
      case 'LDI32': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        const src2Value = this._parseImmediate(operands[1]);
        if (this._handleParsingError(pruState, destRegInfo, src2Value)) { pruState.pc++; break; }
        this._setRegisterValue(pruState, destRegInfo, (src2Value >>> 0));
        pruState.pc++;
        break;
      }
      case 'MOV': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src2Value;
        if (operands[1].toLowerCase().startsWith('r')) {
          const srcRegInfo = this._parseRegister(operands[1].replace(/,/g, ''));
          if (this._handleParsingError(pruState, srcRegInfo)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, srcRegInfo);
        } else {
          src2Value = this._parseImmediate(operands[1]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, destRegInfo, src2Value);
        pruState.pc++;
        break;
      }
      case 'ADD': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        let src1Value, src2Value;
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          try {
            src2Value = this._parseImmediate(operands[2]);
            if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
          } catch (e) {
            src2Value = 0;
          }
        }
        const result = (src1Value >>> 0) + (src2Value >>> 0);
        pruState.carry = (result > 0xFFFFFFFF) ? 1 : 0;
        this._setRegisterValue(pruState, destRegInfo, result >>> 0);
        pruState.pc++;
        break;
      }
      case 'SUB': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        const result = (src1Value >>> 0) - (src2Value >>> 0);
        pruState.carry = (src1Value >= src2Value) ? 1 : 0;
        this._setRegisterValue(pruState, destRegInfo, result >>> 0);
        pruState.pc++;
        break;
      }
      case 'AND': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, destRegInfo, (src1Value & src2Value) >>> 0);
        pruState.pc++;
        break;
      }
      case 'OR': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, destRegInfo, (src1Value | src2Value) >>> 0);
        pruState.pc++;
        break;
      }
      case 'XOR': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, destRegInfo, (src1Value ^ src2Value) >>> 0);
        pruState.pc++;
        break;
      }
      case 'NOT': {
        const destReg = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destReg)) { pruState.pc++; break; }
        let srcVal;
        if (operands[1].toLowerCase().startsWith('r')) {
          const srcReg = this._parseRegister(operands[1].replace(/,/g, ''));
          if (this._handleParsingError(pruState, srcReg)) { pruState.pc++; break; }
          srcVal = this._getRegisterValue(pruState, srcReg);
        } else {
          srcVal = this._parseImmediate(operands[1]);
          if (this._handleParsingError(pruState, srcVal)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, destReg, (~srcVal) >>> 0);
        pruState.pc++;
        break;
      }
      case 'LSL': {
        const dest = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, dest)) { pruState.pc++; break; }
        let src1V, src2V;
        const src1R = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1R)) { pruState.pc++; break; }
        src1V = this._getRegisterValue(pruState, src1R);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2R = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2R)) { pruState.pc++; break; }
          src2V = this._getRegisterValue(pruState, src2R);
        } else {
          src2V = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2V)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, dest, (src1V << (src2V & 0x1F)) >>> 0);
        pruState.pc++;
        break;
      }
      case 'LSR': {
        const dest = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, dest)) { pruState.pc++; break; }
        let src1V, src2V;
        const src1R = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1R)) { pruState.pc++; break; }
        src1V = this._getRegisterValue(pruState, src1R);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2R = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2R)) { pruState.pc++; break; }
          src2V = this._getRegisterValue(pruState, src2R);
        } else {
          src2V = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2V)) { pruState.pc++; break; }
        }
        this._setRegisterValue(pruState, dest, (src1V >>> (src2V & 0x1F)) >>> 0);
        pruState.pc++;
        break;
      }
      case 'SET': {
        const destR = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destR)) { pruState.pc++; break; }
        let src2v;
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2R = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2R)) { pruState.pc++; break; }
          src2v = this._getRegisterValue(pruState, src2R);
        } else {
          src2v = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2v)) { pruState.pc++; break; }
        }
        const currVal = this._getRegisterValue(pruState, destR);
        this._setRegisterValue(pruState, destR, (currVal | (1 << src2v)) >>> 0);
        pruState.pc++;
        break;
      }
      case 'CLR': {
        const destR = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destR)) { pruState.pc++; break; }
        let src2v;
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2R = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2R)) { pruState.pc++; break; }
          src2v = this._getRegisterValue(pruState, src2R);
        } else {
          src2v = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2v)) { pruState.pc++; break; }
        }
        const currVal = this._getRegisterValue(pruState, destR);
        this._setRegisterValue(pruState, destR, (currVal & ~(1 << src2v)) >>> 0);
        pruState.pc++;
        break;
      }
      case 'QBA': {
        // Unconditional branch
        if (operands[0]) {
          const label = operands[0].replace(':', '').trim();
          if (labelMap[label] !== undefined) {
            pruState.pc = labelMap[label];
          } else {
            pruState.pc++;
          }
        } else {
          pruState.pc++;
        }
        cyclesToAdd = 0; // QBA is 0 wait cycles on PRU
        break;
      }
      // All eight conditional branches decode LABEL-first, the TI
      // syntax every block in this repo emits and the only form clpru and
      // pru_core.js accept. See _executeConditionalBranch.
      case 'QBEQ':
      case 'QBNE':
      case 'QBGT':
      case 'QBGE':
      case 'QBLT':
      case 'QBLE':
      case 'QBBS':
      case 'QBBC':
        this._executeConditionalBranch(pruState, opcode, operands, labelMap);
        break;
      case 'JMP': {
        if (operands[0].toLowerCase().startsWith('r')) {
          const reg = this._parseRegister(operands[0].replace(/,/g, ''));
          if (this._handleParsingError(pruState, reg)) { pruState.pc++; break; }
          pruState.pc = this._getRegisterValue(pruState, reg);
        } else {
          const label = operands[0].replace(':', '').trim();
          if (labelMap[label] !== undefined) pruState.pc = labelMap[label];
          else pruState.pc++;
        }
        cyclesToAdd = 0;
        break;
      }
      case 'NOP':
        pruState.pc++;
        break;
      case 'ZERO': {
        const op1Info = this._parseRegisterReference(operands[0].replace(/&|,/g, ''));
        const byteCountStr = operands[1] ? operands[1].replace(/,/g, '') : "4";
        const byteCount = this._parseImmediate(byteCountStr);
        if (op1Info) {
          const startReg = (op1Info.regNum !== undefined) ? op1Info.regNum : op1Info.reg;
          const numRegs = Math.ceil(byteCount / 4);
          for (let i = 0; i < numRegs && (startReg + i) < 32; i++) {
            pruState.registers[startReg + i] = 0;
          }
        }
        pruState.pc++;
        break;
      }
      case 'FILL': {
        const op1Info = this._parseRegisterReference(operands[0].replace(/&|,/g, ''));
        const byteCountStr = operands[1] ? operands[1].replace(/,/g, '') : "4";
        const byteCount = this._parseImmediate(byteCountStr);
        if (op1Info) {
          const startReg = (op1Info.regNum !== undefined) ? op1Info.regNum : op1Info.reg;
          const numRegs = Math.ceil(byteCount / 4);
          for (let i = 0; i < numRegs && (startReg + i) < 32; i++) {
            pruState.registers[startReg + i] = 0xFFFFFFFF;
          }
        }
        pruState.pc++;
        break;
      }
      case 'HALT': {
        // End simulation: set cycles to max to exit the loop in stepPaced
        pruState.pc++;
        pruState.cycles = maxCycles || Number.MAX_SAFE_INTEGER;
        cyclesToAdd = 0;
        break;
      }
      case 'LOOP': {
        // LOOP label, reg → iterate reg times starting at label
        const loopLabel = operands[0].replace(':', '').trim();
        let iterCount;
        if (operands[1].toLowerCase().startsWith('r')) {
          const reg = this._parseRegister(operands[1]);
          if (this._handleParsingError(pruState, reg)) { pruState.pc++; break; }
          iterCount = this._getRegisterValue(pruState, reg);
        } else {
          iterCount = this._parseImmediate(operands[1]);
          if (this._handleParsingError(pruState, iterCount)) { pruState.pc++; break; }
        }
        if (labelMap[loopLabel] !== undefined) {
          pruState.loopStack.push({
            targetLabel: labelMap[loopLabel],
            returnPC: pruState.pc + 1,
            count: iterCount,
            currentIteration: 1
          });
        }
        pruState.pc++;
        cyclesToAdd = 0;
        break;
      }
      case 'LBBO':
      case 'LBCO': {
        // LBBO &dest, base, offset, count
        const destStr = operands[0].replace(/^&/, '').trim();
        const destRegInfo = this._parseRegister(destStr);
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        // base register
        let baseValue = 0;
        const baseRef = operands[1].trim();
        if (baseRef.toLowerCase().startsWith('r')) {
          const br = this._parseRegister(baseRef);
          if (this._handleParsingError(pruState, br)) { pruState.pc++; break; }
          baseValue = this._getRegisterValue(pruState, br);
        } else if (baseRef.toLowerCase().startsWith('c')) {
          const cnum = parseInt(baseRef.substring(1), 10);
          baseValue = cnum === 28 ? 0x00000000 : cnum === 26 ? 0x0002E000 : 0;
        }
        // offset
        let offsetValue = 0;
        const offsetStr = operands[2].trim();
        if (offsetStr.toLowerCase().startsWith('r')) {
          const ori = this._parseRegister(offsetStr);
          if (this._handleParsingError(pruState, ori)) { pruState.pc++; break; }
          offsetValue = this._getRegisterValue(pruState, ori);
        } else {
          offsetValue = parseInt(offsetStr, 0);
        }
        // byte count
        const byteCount = parseInt(operands[3], 0);
        if (isNaN(byteCount) || byteCount < 1) { pruState.pc++; break; }

        const memAddress = baseValue + offsetValue;
        let data;
        if (memAddress >= 0x00010000 && memAddress < 0x00020000) {
          data = this._pruSMEM.readSMEM(memAddress, byteCount);
        } else if (memAddress >= 0x0002E000 && memAddress < 0x0002E100) {
          // IEP register reads — mirrors the SBCO write path (below) and
          // pru_core.js LBCO handler.  Without this, reads to c26 fell
          // through to DMEM0 and returned wrong data.
          const iepOffset = memAddress - 0x0002E000;
          let regVal = 0;
          if (iepOffset === 0x0C) regVal = pruState.iepCount;
          else if (iepOffset === 0x44) regVal = pruState.iepCmpStatus;
          else if (iepOffset === 0x48) regVal = pruState.iepCmp0;
          else if (iepOffset === 0x4C) regVal = pruState.iepCmp1;
          data = new Uint8Array(byteCount);
          for (let i = 0; i < byteCount; i++) {
            data[i] = (regVal >>> (i * 8)) & 0xFF;
          }
        } else {
          data = this._pruDMEM0.readDMEM0(memAddress, byteCount);
        }

        // Write into destination register(s)
        if (data) {
          let currentReg = destRegInfo.regNum;
          let currentByte = destRegInfo.bytePos || destRegInfo.wordPos * 2 || 0;
          let bytesRemaining = byteCount;
          let bufOffset = 0;
          while (bytesRemaining > 0) {
            const bytesFromThisReg = Math.min(bytesRemaining, 4 - currentByte);
            let regVal = this._getRegisterValue(pruState, { reg: currentReg, type: 'full' });
            for (let i = 0; i < bytesFromThisReg; i++) {
              if (bufOffset + i < data.length) {
                const byteShift = (currentByte + i) * 8;
                regVal = (regVal & ~(0xFF << byteShift)) | (data[bufOffset + i] << byteShift);
              }
            }
            pruState.registers[currentReg] = regVal >>> 0;
            bufOffset += bytesFromThisReg;
            bytesRemaining -= bytesFromThisReg;
            currentReg = (currentReg + 1) % 31;
            currentByte = 0;
          }
        }
        cyclesToAdd = 1 + Math.ceil(byteCount / 4);
        pruState.pc++;
        break;
      }
      case 'SBBO':
      case 'SBCO': {
        const srcStr = operands[0].replace(/^&/, '').trim();
        const srcRegInfo = this._parseRegister(srcStr);
        if (this._handleParsingError(pruState, srcRegInfo)) { pruState.pc++; break; }
        let baseValue = 0;
        const baseRef = operands[1].trim();
        if (baseRef.toLowerCase().startsWith('r')) {
          const br = this._parseRegister(baseRef);
          if (this._handleParsingError(pruState, br)) { pruState.pc++; break; }
          baseValue = this._getRegisterValue(pruState, br);
        } else if (baseRef.toLowerCase().startsWith('c')) {
          const cnum = parseInt(baseRef.substring(1), 10);
          baseValue = cnum === 28 ? 0x00000000 : cnum === 26 ? 0x0002E000 : 0;
        }
        let offsetValue = 0;
        const offsetStr = operands[2].trim();
        if (offsetStr.toLowerCase().startsWith('r')) {
          const ori = this._parseRegister(offsetStr);
          if (this._handleParsingError(pruState, ori)) { pruState.pc++; break; }
          offsetValue = this._getRegisterValue(pruState, ori);
        } else {
          offsetValue = parseInt(offsetStr, 0);
        }
        const byteCount = parseInt(operands[3], 0);
        if (isNaN(byteCount) || byteCount < 1) { pruState.pc++; break; }

        const memAddress = baseValue + offsetValue;
        const dataBuffer = new Uint8Array(byteCount);
        let currentReg = srcRegInfo.regNum;
        let currentByte = srcRegInfo.bytePos || srcRegInfo.wordPos * 2 || 0;
        let bytesRemaining = byteCount;
        let bufOffset = 0;
        while (bytesRemaining > 0 && currentReg <= 30) {
          const bytesFromThisReg = Math.min(bytesRemaining, 4 - currentByte);
          const regVal = pruState.registers[currentReg];
          for (let i = 0; i < bytesFromThisReg; i++) {
            dataBuffer[bufOffset + i] = (regVal >> ((currentByte + i) * 8)) & 0xFF;
          }
          bufOffset += bytesFromThisReg;
          bytesRemaining -= bytesFromThisReg;
          currentReg++;
          currentByte = 0;
        }

        if (memAddress >= 0x00010000 && memAddress < 0x00020000) {
          this._pruSMEM.writeSMEM(memAddress, dataBuffer);
        } else if (memAddress >= 0x0002E000 && memAddress < 0x0002E100) {
          const iepOffset = memAddress - 0x0002E000;
          let regVal = 0;
          for (let i = 0; i < byteCount; i++) regVal |= dataBuffer[i] << (i * 8);
          if (iepOffset === 0x0C) pruState.iepCount = regVal;
          else if (iepOffset === 0x44) pruState.iepCmpStatus &= ~regVal;
          else if (iepOffset === 0x48) pruState.iepCmp0 = regVal;
          else if (iepOffset === 0x4C) pruState.iepCmp1 = regVal;
        } else {
          this._pruDMEM0.writeDMEM0(memAddress, dataBuffer);
        }
        cyclesToAdd = 1 + Math.ceil(byteCount / 4);
        pruState.pc++;
        break;
      }
      case 'XOUT': {
        // XOUT bank, &src, count
        const bank = parseInt(operands[0], 0);
        const srcRef = operands[1].replace(/^&/, '').trim();
        let srcRegN = 0;
        if (srcRef.toLowerCase().startsWith('r')) {
          const reg = this._parseRegister(srcRef);
          if (this._handleParsingError(pruState, reg)) { pruState.pc++; break; }
          srcRegN = reg.reg;
        } else {
          srcRegN = parseInt(srcRef, 0);
        }
        const count = parseInt(operands[2], 0);

        if (bank === 0) {
          // MAC: write R28=R10, R29=R11
          pruState.registers[28] = pruState.registers[10];
          pruState.registers[29] = pruState.registers[11];
          pruState.pc++;
        } else if (bank === 112 || bank === 113 || bank === 114) {
          // XFR2TR (SPRUIM2J Table 6-112). 0x72 submit can HOLD if
          // the 8-level FIFO is full; only then does PC not advance.
          const advance = this._xfr2trXout(pruState, bank, srcRegN, count);
          if (advance) pruState.pc++;
        } else if (bank === SPINLOCK_DEVICE_ID) {
          // XOUT to 0x90 is the RELEASE. Table 6-98, INT_SPIN_ID row:
          // "own_req_clr control input ... will clear the flag selected by
          // R1.b0/own_req_vector". It is NOT a lock request - see the block's
          // header comment. The selector is R1.b0 regardless of which byte of
          // R1 the XOUT names.
          this._spinlockRelease(pruState, srcRegN);
          pruState.pc++;
        } else if (bank === BS_RAM_DEVICE_WRITE || bank === BS_RAM_DEVICE_SNOOP) {
          // BS RAM write (48) and snoop (49) XOUT, modelled as a 64x32B
          // per-core RAM rather than the flat SPAD model.
          this._bsRamXout(pruState, bank, srcRegN, count);
          pruState.pc++;
        } else if (bank === FDB_DEVICE_DATA_ADDR || bank === FDB_DEVICE_PATTERN) {
          this._fdbXout(pruState, bank, srcRegN, count);
          pruState.pc++;
        } else if (bank === 240) {
          // QUEUE_EMPTY device 0xF0 (240) is XIN-only (SPRUIM2J Table 6-60).
          // XOUT is not supported on this device.
          this._recordUnsupportedXfr(pruState, bank);
          pruState.unknownInstruction = "XOUT " + bank + ": QUEUE_EMPTY device 0xF0 is XIN-only (SPRUIM2J Table 6-60)";
          pruState.pc++;
        } else {
          // SPAD: store registers to scratchpad bank (note: 48/49 are no longer here)
          for (let i = 0; i < count; i++) {
            if (srcRegN + i <= 31) {
              const spadBank = this._spad || {};
              if (!this._spad) this._spad = {};
              if (!this._spad[bank]) this._spad[bank] = new Array(30).fill(0);
              this._spad[bank][i] = pruState.registers[srcRegN + i];
            }
          }
          pruState.pc++;
        }
        break;
      }
      case 'XIN': {
        // XIN bank, &dest, count
        const bank = parseInt(operands[0], 0);
        const destRef = operands[1].replace(/^&/, '').trim();
        let destRegN = 0;
        if (destRef.toLowerCase().startsWith('r')) {
          const reg = this._parseRegister(destRef);
          if (this._handleParsingError(pruState, reg)) { pruState.pc++; break; }
          destRegN = reg.reg;
        } else {
          destRegN = parseInt(destRef, 0);
        }
        const count = parseInt(operands[2], 0);

        if (bank === 0) {
          // MAC result: read back R26-R27 (or more)
          // Accumulator lower held in R25 context, result in R26(LO):R27(HI)
          const mulLo = (pruState.registers[28] >>> 0) * (pruState.registers[29] >>> 0);
          const macResult = (mulLo >>> 0) + (pruState.registers[25] >>> 0);
          const resultHi = Math.floor(macResult / 0x100000000) >>> 0;
          pruState.registers[26] = (macResult >>> 0);
          pruState.registers[27] = resultHi;
        } else if (bank === 160 || bank === 161 || bank === 162) {
          // ICSSG Byte Swap (BSWAP) broadside unit, SPRUIM2J 6.4.6.2.7,
          // device IDs from Table 6-95.  Written from the TRM; it is not an
          // independent oracle for blocks written from the same TRM section.
          const lanes = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
          const pack = (b) => (((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0);
          if (bank === 160) {
            // 6.4.6.2.7.1: within each register in the span, b0<->b3 and b1<->b2.
            // A span shorter than 4 bytes updates only the bytes it covers
            // (example 3: a 2-byte XIN gives R2.b0 = R2.b3, R2.b1 = R2.b2).
            let remaining = count, r = destRegN;
            while (remaining > 0 && r <= 29) {
              const n = Math.min(4, remaining);
              const cur = lanes(pruState.registers[r] >>> 0);
              const flipped = [cur[3], cur[2], cur[1], cur[0]];
              const out = cur.slice();
              for (let i = 0; i < n; i++) out[i] = flipped[i];
              pruState.registers[r] = pack(out);
              remaining -= n; r++;
            }
          } else {
            // 6.4.6.2.7.2 / 6.4.6.2.7.3: whole-window exchanges.  Both must
            // start at R2.b0; the pairs below are the TRM's own tables.
            const pairs = (bank === 161)
              ? [[2, 6], [3, 7], [4, 8], [5, 9]]
              : [[2, 14], [3, 15], [4, 16], [5, 17], [6, 10], [7, 11], [8, 12], [9, 13]];
            if (destRegN !== 2) {
              pruState.unknownInstruction =
                `XIN ${bank}: BSWAP ${bank === 161 ? '4_8' : '4_16'} must start at R2.b0 (SPRUIM2J 6.4.6.2.7)`;
            } else {
              for (const [a, b] of pairs) {
                const t = pruState.registers[a] >>> 0;
                pruState.registers[a] = pruState.registers[b] >>> 0;
                pruState.registers[b] = t;
              }
            }
          }
        } else if (bank === 112 || bank === 113 || bank === 114) {
          // XFR2TR (SPRUIM2J Table 6-112). Only 0x71 has a
          // documented XIN direction; 0x70/0x72 are XOUT-only.
          this._xfr2trXin(pruState, bank, destRegN, count);
        } else if (bank === SPINLOCK_DEVICE_ID) {
          // XIN from 0x90 is the ACQUIRE. Table 6-98: "own_req input
          // will assert during this XIN transaction. This assertion will cause
          // an arbitration event. The result ... returned to R1.b3[0] via
          // own_req_status. 0h: not owned/lost  1h: owned/won".
          this._spinlockArbitrate(pruState, destRegN);
        } else if (bank === BS_RAM_DEVICE_READ || bank === BS_RAM_DEVICE_WRITE || bank === BS_RAM_DEVICE_SNOOP) {
          // BS RAM XIN. A real 64x32B per-core model serves ID 48
          // (R2..R9, <=32B); Fig 6-49 uses that same per-core ID for XOUT/XIN.
          this._bsRamXin(pruState, bank, destRegN, count);
        } else if (bank === FDB_DEVICE_DATA_ADDR || bank === FDB_DEVICE_COMPARE) {
          this._fdbXin(pruState, bank, destRegN, count);
        } else if (bank === 240) {
          // ICSSG QUEUE_EMPTY broadside unit (SPRUIM2J Table 6-60 BS ID 0xF0 / 240).
          // Reads 32-bit queue empty status word.
          const status = (pruState.queue_empty !== undefined ? pruState.queue_empty : 0xFFFFFFFF) >>> 0;
          if (destRegN <= 31) {
            pruState.registers[destRegN] = status;
          }
        } else {
          // SPAD: load from scratchpad bank (note: 48/49 are no longer here)
          if (this._spad && this._spad[bank]) {
            for (let i = 0; i < count; i++) {
              if (destRegN + i <= 31 && i < this._spad[bank].length) {
                pruState.registers[destRegN + i] = this._spad[bank][i];
              }
            }
          }
        }
        pruState.pc++;
        break;
      }
      case 'ADC': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        const result = (src1Value >>> 0) + (src2Value >>> 0) + (pruState.carry >>> 0);
        pruState.carry = (result > 0xFFFFFFFF) ? 1 : 0;
        this._setRegisterValue(pruState, destRegInfo, result >>> 0);
        pruState.pc++;
        break;
      }
      case 'SUC': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        const result = (src1Value >>> 0) - (src2Value >>> 0) - (1 - (pruState.carry >>> 0));
        pruState.carry = (result <= 0xFFFFFFFF && result >= 0) ? 1 : 0;
        this._setRegisterValue(pruState, destRegInfo, result >>> 0);
        pruState.pc++;
        break;
      }
      case 'RSB': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        let src1Value, src2Value;
        const src1Reg = this._parseRegister(operands[1].replace(/,/g, ''));
        if (this._handleParsingError(pruState, src1Reg)) { pruState.pc++; break; }
        src1Value = this._getRegisterValue(pruState, src1Reg);
        if (operands[2].toLowerCase().startsWith('r')) {
          const src2Reg = this._parseRegister(operands[2].replace(/,/g, ''));
          if (this._handleParsingError(pruState, src2Reg)) { pruState.pc++; break; }
          src2Value = this._getRegisterValue(pruState, src2Reg);
        } else {
          src2Value = this._parseImmediate(operands[2]);
          if (this._handleParsingError(pruState, src2Value)) { pruState.pc++; break; }
        }
        const result = (src2Value >>> 0) - (src1Value >>> 0);
        pruState.carry = (src2Value >= src1Value) ? 1 : 0;
        this._setRegisterValue(pruState, destRegInfo, result >>> 0);
        pruState.pc++;
        break;
      }
      case 'MULL': {
        const destRegInfo = this._parseRegister(operands[0].replace(/,/g, ''));
        if (this._handleParsingError(pruState, destRegInfo)) { pruState.pc++; break; }
        const reg1 = this._parseRegister(operands[1].replace(/,/g, ''));
        const reg2 = this._parseRegister(operands[2].replace(/,/g, ''));
        if (this._handleParsingError(pruState, reg1, reg2)) { pruState.pc++; break; }
        const v1 = this._getRegisterValue(pruState, reg1);
        const v2 = this._getRegisterValue(pruState, reg2);
        this._setRegisterValue(pruState, destRegInfo, (v1 * v2) & 0xFFFFFFFF);
        pruState.pc++;
        cyclesToAdd = 3;
        break;
      }
      default: {
        // Skip unknown instructions (macro calls, assembler directives)
        pruState.unknownInstruction++;
        pruState.pc++;
        break;
      }
    }

    // The XFR2TR ring drains into place in the background at
    // hardware's own pace. One step AFTER each instruction's own dispatch
    // (so a submit's just-pushed IDs are visible to the very next
    // instruction, e.g. an immediate status read) keeps a wait-for-busy
    // poll loop making real progress instead of livelocking against a HOLD.
    if (pruState.xfr2tr) this._xfr2trDrain(pruState);

    // Handle loop stack
    if (pruState.loopStack && pruState.loopStack.length > 0) {
      const curLoop = pruState.loopStack[pruState.loopStack.length - 1];
      if (pruState.pc === curLoop.targetLabel) {
        if (curLoop.currentIteration >= curLoop.count) {
          pruState.loopStack.pop();
        } else {
          curLoop.currentIteration++;
          pruState.pc = curLoop.returnPC;
        }
      }
    }

    // Cycle accounting
    for (let c = 0; c < cyclesToAdd; c++) {
      pruState.cycles++;
      if (pruState.r31HistoryMap && pruState.r31HistoryMap[pruState.cycles] !== undefined) {
        pruState.registers[31] = pruState.r31HistoryMap[pruState.cycles];
      }
      pruState.iepCount++;
      if (pruState.iepCmp0 > 0 && pruState.iepCount >= pruState.iepCmp0) {
        pruState.iepCmpStatus |= 1;
        pruState.iepCount = 0;
      }
      if (pruState.iepCmp1 > 0 && pruState.iepCount >= pruState.iepCmp1) {
        pruState.iepCmpStatus |= 2;
      }
      r30History.push(pruState.registers[30]);
      r31History.push(pruState.registers[31]);
    }
  }

  /**
   * G3: Run simulation until cycle budget, halt, or watchpoint condition is met.
   *
   * Watchpoint types:
   *   { type: 'halt' } - Stop when HALT instruction is executed
   *   { type: 'pc', address: number } - Stop when PC reaches a specific address
   *   { type: 'register', register: number, value: number } - Stop when register equals value
   *   { type: 'memory', address: number, value: number } - Stop when memory at address equals value
   *   { type: 'cycles', value: number } - Maximum number of cycles (same as maxCycles)
   *
   * @param {Object} options
   * @param {number} [options.maxCycles=1000] - Maximum cycles to simulate
   * @param {Array<Object>} [options.watchpoints=[]] - Watchpoint conditions
   * @returns {Object} Final simulation state with { state, hitWatchpoint, r30History, r31History }
   */
  runUntil(options = {}) {
    const maxCycles = options.maxCycles || 1000;
    const watchpoints = options.watchpoints || [];

    this._ensureLoaded();
    if (!this._instructions.length) {
      throw new Error('No instructions loaded. Call loadInstructions() first.');
    }
    if (!this._pruState) {
      this._resetState();
    }

    const pruState = this._pruState;
    const instructions = this._instructions;
    const labelMap = this._labelMap;
    const r30History = this._r30History;
    const r31History = this._r31History;
    let hitWatchpoint = null;

    while (pruState.cycles < maxCycles && pruState.pc < instructions.length && !hitWatchpoint) {
      const instr = instructions[pruState.pc];

      // Check watchpoints BEFORE executing instruction
      for (const wp of watchpoints) {
        if (this._checkWatchpoint(wp, pruState, instructions, instr)) {
          hitWatchpoint = { ...wp, cycle: pruState.cycles, pc: pruState.pc };
          break;
        }
      }
      if (hitWatchpoint) break;

      this._executeSingleInstruction(pruState, instructions, labelMap, r30History, r31History, maxCycles);

      // Check watchpoints AFTER executing instruction
      if (!hitWatchpoint) {
        for (const wp of watchpoints) {
          if (this._checkWatchpoint(wp, pruState, instructions, instructions[pruState.pc])) {
            hitWatchpoint = { ...wp, cycle: pruState.cycles, pc: pruState.pc };
            break;
          }
        }
      }
    }

    // Final check: did we hit maxCycles?
    if (!hitWatchpoint && pruState.cycles >= maxCycles) {
      hitWatchpoint = { type: 'cycles', value: maxCycles, cycle: pruState.cycles, pc: pruState.pc };
    }

    this._watchpointHit = hitWatchpoint;
    return {
      state: this.state,
      hitWatchpoint,
      r30History: [...r30History],
      r31History: [...r31History]
    };
  }

  /**
   * Check if a watchpoint condition is met.
   * @returns {boolean}
   */
  _checkWatchpoint(wp, pruState, instructions, currentInstruction) {
    switch (wp.type) {
      case 'halt':
        if (currentInstruction && currentInstruction.toUpperCase().trim() === 'HALT') {
          return true;
        }
        return false;
      case 'pc':
        return pruState.pc === (wp.address >>> 0);
      case 'register':
        return wp.register >= 0 && wp.register <= 31 &&
          (pruState.registers[wp.register] >>> 0) === (wp.value >>> 0);
      case 'memory': {
        if (wp.address >= 0x00010000 && wp.address < 0x00020000) {
          const val = this._pruSMEM.readSMEM(wp.address, 4);
          const ival = val ? (val[0] | (val[1] << 8) | (val[2] << 16) | (val[3] << 24)) >>> 0 : 0;
          return ival === (wp.value >>> 0);
        }
        const val = this._pruDMEM0.readDMEM0(wp.address, 4);
        const ival = val ? (val[0] | (val[1] << 8) | (val[2] << 16) | (val[3] << 24)) >>> 0 : 0;
        return ival === (wp.value >>> 0);
      }
      case 'cycles':
        return pruState.cycles >= (wp.value || 0);
      default:
        return false;
    }
  }

  /**
   * Get the last watchpoint that was hit.
   * @returns {Object|null}
   */
  get lastWatchpointHit() {
    return this._watchpointHit;
  }

  /**
   * G4: Export simulation trace as Value Change Dump (VCD) format.
   *
   * @param {Object} [options]
   * @param {string} [options.moduleName] - Module name for VCD header
   * @param {number} [options.timeScale] - Timescale in ns per cycle
   * @param {Array<number>} [options.signals] - Specific bit indices to include
   * @returns {string} VCD content
   */
  exportVcd(options = {}) {
    return exportVcd(this._r30History, this._r31History, {
      moduleName: options.moduleName || this.id,
      timeScale: options.timeScale || 1,
      signals: options.signals,
      date: options.date,
      version: `PRU Simulator [${this.id}]`
    });
  }

  /**
   * Saves VCD trace to a file.
   * @param {string} filePath - Output file path
   * @param {Object} [options]
   * @returns {string} The file path written
   */
  saveVcd(filePath, options = {}) {
    const content = this.exportVcd(options);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  // ==================================================================
  // API: Memory access
  // ==================================================================

  /**
   * Read DMEM0 memory.
   * @param {number} address
   * @param {number} [size=4] - Bytes to read
   * @returns {Uint8Array|null}
   */
  readDMEM(address, size = 4) {
    this._ensureLoaded();
    return this._pruDMEM0.readDMEM0(address, size);
  }

  /**
   * Write to DMEM0 memory.
   * @param {number} address
   * @param {Uint8Array|Array} data
   * @returns {boolean}
   */
  writeDMEM(address, data) {
    this._ensureLoaded();
    return this._pruDMEM0.writeDMEM0(address, data);
  }

  /**
   * Read SMEM (Shared Memory).
   * @param {number} address
   * @param {number} [size=4] - Bytes to read
   * @returns {Uint8Array|null}
   */
  readSMEM(address, size = 4) {
    this._ensureLoaded();
    return this._pruSMEM.readSMEM(address, size);
  }

  /**
   * Write to SMEM.
   * @param {number} address
   * @param {Uint8Array|Array} data
   * @returns {boolean}
   */
  writeSMEM(address, data) {
    this._ensureLoaded();
    return this._pruSMEM.writeSMEM(address, data);
  }

  /**
   * Add a symbol to the DMEM symbol table.
   * @param {string} name
   * @param {number} address
   * @param {number} [size=4]
   * @returns {boolean}
   */
  addSymbol(name, address, size = 4) {
    this._ensureLoaded();
    return this._pruDMEM0.addSymbol(name, address, size);
  }

  /**
   * Get address of a symbol.
   * @param {string} name
   * @returns {number|null}
   */
  symbolAddress(name) {
    this._ensureLoaded();
    return this._pruDMEM0.getSymbolAddress(name);
  }

  /**
   * Get all loaded firmware symbols.
   * @returns {Object}
   */
  get firmwareSymbols() {
    return { ...this._dmemSymbols };
  }

  /**
   * Get firmware metadata.
   * @returns {Object|null}
   */
  get firmwareInfo() {
    if (!this._firmware) return null;
    return {
      format: this._firmware.format,
      entryPoint: this._firmware.entryPoint,
      dataSection: this._firmware.data ? {
        name: this._firmware.data.name,
        addr: this._firmware.data.addr,
        size: this._firmware.data.data.length
      } : null,
      numSymbols: this._firmware.symbols.length,
      numInstructions: this._rawInstructions ? this._rawInstructions.length : 0
    };
  }

  // ==================================================================
  // Internal helpers (mirrors pru_core.js parsing)
  // ==================================================================

  _parseImmediate(immStr) {
    try {
      const result = eval(immStr);
      if (typeof result !== 'number' || isNaN(result)) return -1;
      return result;
    } catch (e) {
      return -1;
    }
  }

  _parseRegister(regStr) {
    const fullRegex = /r(\d+)(\.b(\d+)|\.w(\d+))?/i;
    const match = regStr.match(fullRegex);
    if (!match) return -1;
    const regNum = parseInt(match[1]);
    if (match[3] !== undefined) {
      return { reg: regNum, type: 'byte', byteNum: parseInt(match[3]), mask: 0xFF, shift: parseInt(match[3]) * 8 };
    } else if (match[4] !== undefined) {
      return { reg: regNum, type: 'word', wordNum: parseInt(match[4]), mask: 0xFFFF, shift: parseInt(match[4]) * 8 };
    }
    return { reg: regNum, type: 'full' };
  }

  _handleParsingError(pruState, ...values) {
    for (const v of values) {
      if (v === -1) { pruState.errorParsing++; return true; }
    }
    return false;
  }

  _getRegisterValue(pruState, regInfo) {
    if (regInfo.type === 'full') return pruState.registers[regInfo.reg];
    return (pruState.registers[regInfo.reg] >> regInfo.shift) & regInfo.mask;
  }

  _setRegisterValue(pruState, regInfo, value) {
    if (regInfo.type === 'full') {
      pruState.registers[regInfo.reg] = value >>> 0;
    } else {
      const clearMask = ~(regInfo.mask << regInfo.shift);
      pruState.registers[regInfo.reg] = (pruState.registers[regInfo.reg] & clearMask) | (((value & regInfo.mask) << regInfo.shift) >>> 0);
    }
  }
}

// ========================================================================
// Exports
// ========================================================================

module.exports = {
  Simulator,
  CoffParser,
  loadPruFirmware,
  exportVcd
};
