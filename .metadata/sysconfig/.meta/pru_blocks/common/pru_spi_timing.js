"use strict";
/*
 * pru_spi_timing.js - shared timing checks of the pru_spi_read / pru_spi_write / pru_spi_transfer blocks: the
 * "CS Setup Time" / "CS Hold Time" / "Data Setup Time" nanosecond settings as the PRU cycle counts their macros take.
 *
 * Facts this rests on (TI clpru 2.3.3, measured with --asm_listing):
 *   - `.loop N` / `nop` / `.endloop` is unrolled at assembly time into N `nop` instructions. A PRU instruction
 *     takes one cycle, so a macro formal of N costs exactly N cycles with no loop overhead.
 *   - `.loop 0` is accepted and emits nothing.
 *   - Every nop is a word of IRAM (4 bytes; a PRU core has 12 KB), so the count is capped (MAX_DELAY_CYCLES).
 *
 * The PRU core clock is the "PRU Clock Frequency" setting (pruClkFreq) of the Simulation Settings static module.
 * When the static module is absent the helper falls back to that setting's default, DEFAULT_PRU_CLK_MHZ.
 */

const DEFAULT_PRU_CLK_MHZ = 200;

// Each delay site expands to this many nops at most (1 KB of the 12 KB PRU IRAM); a macro has up to two such sites.
const MAX_DELAY_CYCLES = 256;

// The Simulation Settings option "333.333 MHz" is the AM64x/AM243x 1000/3 MHz core clock.
const CLK_333_OPTION_MHZ = 333.333;

function pruClockMhz() {
    let mhz = DEFAULT_PRU_CLK_MHZ;
    const staticModule = system.modules["/pru_blocks/common/pru_blocks_static_module"];
    if (staticModule && staticModule.$static && staticModule.$static.pruClkFreq) {
        mhz = Number(staticModule.$static.pruClkFreq);
    }
    return Math.abs(mhz - CLK_333_OPTION_MHZ) < 1e-3 ? 1000 / 3 : mhz;
}

/**
 * Setup and hold times are minimums, so the conversion rounds UP: ceil(ns * MHz / 1000).
 * The tiny subtraction keeps an exact product (35 ns at 200 MHz = 7 cycles) from tipping to 8 on float noise.
 * 0 ns (or less) is 0 cycles, which the macros turn into an empty `.loop 0`.
 */
function nsToCycles(ns, mhz) {
    const t = Number(ns);
    if (!(t > 0)) return 0;
    return Math.ceil(t * mhz / 1000 - 1e-9);
}

/** Cycle count for one nanosecond setting at the design's current PRU clock. */
function csDelayCycles(ns) {
    return nsToCycles(ns, pruClockMhz());
}

/**
 * Report an error for each of CS Setup Time / CS Hold Time / Data Setup Time whose converted count exceeds
 * MAX_DELAY_CYCLES. Peripheral mode does not use these settings.
 */
function validateCsTimes(inst, report) {
    if (inst["Device Mode"] === "peripheral") return;
    const mhz = pruClockMhz();
    ["CS Setup Time", "CS Hold Time", "Data Setup Time"].forEach(function (name) {
        const cycles = nsToCycles(inst[name], mhz);
        if (cycles > MAX_DELAY_CYCLES) {
            report.logError(name + " of " + inst[name] + " ns is " + cycles + " PRU cycles at " + mhz.toFixed(3) + " MHz; the limit is "
                + MAX_DELAY_CYCLES + " PRU cycles (each cycle is one nop in program memory). Lower the time or the PRU Clock Frequency.",
                inst, name);
        }
    });
}

// program-memory budget check. Every delay cycle is one nop (4 bytes of IRAM), so one maxed block is ~2 KB and a few
// of them overflow the 12 KB a PRU core has. The linker already refuses an overflowing .text, but only after the whole design has
// been generated; this reports it at validation, naming the design total.
const IRAM_BUDGET_BYTES = 12 * 1024;
// Fixed instructions of one block's macro body, rounded UP from the clpru .text of single-block builds (controller and
// peripheral, 8-32 bit packets, MODE0-3: 0x44..0x64 bytes for the whole design incl. its data-load and CS-idle blocks).
const FIXED_BLOCK_INSTRUCTIONS = 28;
// Peripheral macros unroll `.loop CS_FILTER_CYCLES` at this many sites.
const FILTER_SITES = 2;
// CS Filter Cycles has range [1, 0xFFFFFFFF]: the smallest filter a peripheral block can be lowered to.
const MIN_CS_FILTER_CYCLES = 1;
const SPI_MODULES = [
    "/pru_blocks/pru_io_blocks/pru_spi_read",
    "/pru_blocks/pru_io_blocks/pru_spi_write",
    "/pru_blocks/pru_io_blocks/pru_spi_transfer"
];

/**
 * Upper-bound estimate of the program memory one SPI block instance takes: 4 bytes per instruction. Controller mode: the fixed body
 * plus every delay site (CS setup, CS hold, data setup and the two SCLK pulse compensations). Peripheral mode: the fixed body plus
 * the CS glitch filter, `.loop CS_FILTER_CYCLES` at two sites of the slave macro (wait for CS high, wait for CS low), each unrolled
 * into CS Filter Cycles copies of one qbbc/qbbs. Both modes' settings are hidden in the other mode.
 */
function estimateIramBytes(inst) {
    let instructions = FIXED_BLOCK_INSTRUCTIONS;
    if (inst["Device Mode"] !== "peripheral") {
        instructions += csDelayCycles(inst["CS Setup Time"]) + csDelayCycles(inst["CS Hold Time"])
            + csDelayCycles(inst["Data Setup Time"]) + Number(inst["delay_component1"]) + Number(inst["delay_component2"]);
    } else {
        instructions += FILTER_SITES * Number(inst["CS Filter Cycles"]);
    }
    return 4 * instructions;
}

/**
 * Warn, once per design (on the first SPI instance), when the estimated IRAM of all pru_spi_* instances together exceeds the
 * 12 KB of one PRU core. A warning and not an error: the estimate is an upper bound and the other blocks of the design are
 * not counted, so it can neither prove a fit nor prove an overflow (the linker is the final word). The advice names the
 * actual cause: when the peripheral CS Filter Cycles loops alone push the design over the budget, the warning
 * says so instead of advising the controller-mode CS Setup / Hold, Data Setup and SCLK widths. "Alone" means the design would
 * fit with every filter at its minimum of 1 cycle; a design that still overflows then gets the controller advice.
 * Tightness (estimate / linked .text, 3 peripheral blocks): within 10% at CS Filter Cycles >= 100 (read 1.08x, write
 * 1.07x, transfer 1.04x); loose at small filters because the fixed body is rounded up (read: 2.20x at 1, 2.04x at 2, 1.52x at 10,
 * 1.23x at 30; write 2.05x / 1.92x / 1.47x / 1.21x; transfer 1.39x / 1.35x / 1.21x / 1.11x). Always conservative, never under.
 */
function validateIramBudget(inst, report) {
    const all = [];
    SPI_MODULES.forEach(function (name) {
        const mod = system.modules[name];
        if (mod && mod.$instances) mod.$instances.forEach(function (i) { all.push(i); });
    });
    if (all.length === 0 || all[0] !== inst) return;
    let total = 0, filterBytes = 0, minFilterBytes = 0;
    all.forEach(function (i) {
        total += estimateIramBytes(i);
        if (i["Device Mode"] === "peripheral") {
            filterBytes += 4 * FILTER_SITES * Number(i["CS Filter Cycles"]);
            minFilterBytes += 4 * FILTER_SITES * MIN_CS_FILTER_CYCLES;
        }
    });
    if (total > IRAM_BUDGET_BYTES) {
        let advice;
        // Lowering the filter only helps while the design fits with every filter at its minimum (CS Filter Cycles >= 1, so a
        // peripheral block never drops below 8 bytes of filter): otherwise the controller-side widths must shrink too.
        if (filterBytes > 0 && total - filterBytes + minFilterBytes <= IRAM_BUDGET_BYTES) {
            advice = "The CS Filter Cycles loops of the peripheral-mode block(s) push it over: lower the CS Filter Cycles";
        } else {
            advice = "Shorten the CS Setup / Hold Time, Data Setup Time and SCLK pulse widths, or lower the PRU Clock Frequency";
        }
        report.logWarning("The " + all.length + " SPI block(s) in this design need an estimated " + total + " bytes of program memory (IRAM), over the "
            + IRAM_BUDGET_BYTES + " bytes of one PRU core (4 bytes per instruction; every delay cycle is a nop). " + advice
            + "; the linker will refuse an overflowing .text."
            + (filterBytes > 0 ? " The estimate is conservative: within 10% of the linked size for peripheral CS filters of 100 cycles or more, "
                + "but up to about 2x over at small filters (the default filter of 2 cycles reads about 2x for read / write, 1.35x for transfer)." : ""), inst);
    }
}

exports = {
    IRAM_BUDGET_BYTES: IRAM_BUDGET_BYTES,
    estimateIramBytes: estimateIramBytes,
    validateIramBudget: validateIramBudget,
    DEFAULT_PRU_CLK_MHZ: DEFAULT_PRU_CLK_MHZ,
    MAX_DELAY_CYCLES: MAX_DELAY_CYCLES,
    pruClockMhz: pruClockMhz,
    nsToCycles: nsToCycles,
    csDelayCycles: csDelayCycles,
    validateCsTimes: validateCsTimes
};
