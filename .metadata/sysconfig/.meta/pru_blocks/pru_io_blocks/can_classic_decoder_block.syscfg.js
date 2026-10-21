"use strict";

function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();
    let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
    if(result==0)return "PRU0";
    return "PRU1";
}

const PRU_USED = getPruNumberFromContext();

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i), displayName: `PRU GPIO ${i} (R31.${i})`,
}));

// bit-timing model. The macro polls in 3-cycle ticks; the destuff/shift path costs exactly 10 cycles on
// every path (measured), so the wait loop is 3 * ticks + 0..2 pad cycles.
const POLL_TICK_CYCLES = 3;
const PATH_CYCLES = 10;
const MIN_SJW_CYCLES = POLL_TICK_CYCLES;
const MAX_BIT_CYCLES = 20000;     // the wait counter and the SOF reload are 16-bit ldi immediates

function bitCycles(inst) {
    return Math.round(inst.clkHz / (inst.bitRateKbps * 1000));
}

function samplePointCycles(inst) {
    return Math.round(bitCycles(inst) * inst.samplePointPercent / 100);
}

// SJW is rounded to the 3-cycle tick, never below one tick.
function sjwTicks(inst) {
    return Math.max(1, Math.floor((inst.sjwCycles + 1) / POLL_TICK_CYCLES));
}

// Everything the macro needs, derived here (the evidence emitter and the TI pru-simulator parser do not evaluate `.eval`).
//   wt  wait-loop ticks per bit        (BIT_CYC - 10) / 3
//   rp  remainder pad nops (0..2)      (BIT_CYC - 10) - 3 * wt          => 10 + 3 * wt + rp = BIT_CYC
//   sq  hard-sync reload ticks         (SAMPLE_CYC - rp - 10 + 1) / 3   => effective sample point 3 * sq + rp + 10
//   xs  SOF reload ticks               (BIT_CYC + 3 * sq + 4) / 3       and  rs = (BIT_CYC + 4) mod 3 pad nops
function timing(inst) {
    const n = bitCycles(inst);
    const s = samplePointCycles(inst);
    const wt = Math.floor((n - PATH_CYCLES) / POLL_TICK_CYCLES);
    const rp = (n - PATH_CYCLES) - POLL_TICK_CYCLES * wt;
    const sq = Math.floor((s - rp - PATH_CYCLES + 1) / POLL_TICK_CYCLES);
    const xs = Math.floor((n + POLL_TICK_CYCLES * sq + 4) / POLL_TICK_CYCLES);
    const rs = (n + 4) - POLL_TICK_CYCLES * xs + POLL_TICK_CYCLES * sq;
    return { n, s, wt, rp, sq, xs, rs, sj: sjwTicks(inst) };
}

// The armed poll window must contain the nominal edge +-SJW. Measured from the sample instruction (cycle 1 of the 10-cycle
// path), the first poll is at cycle 11 and the last at about BIT_CYC - 3 * (3 + sjwTicks) - 3. With the 0..2 cycle poll
// latency and the 0..2 cycle remainder pad that needs, in PRU cycles:
//   sample point (edge to sample)        >= 6 * sjwTicks + 16
//   Phase_Seg2 (sample to end of bit)    >= 3 * sjwTicks + 16
function minSampleCycles(inst) {
    return 2 * POLL_TICK_CYCLES * sjwTicks(inst) + 16;
}

function minPhaseSeg2Cycles(inst) {
    return POLL_TICK_CYCLES * sjwTicks(inst) + 16;
}

// Smallest BIT_CYC for which some sample point satisfies both bounds with the minimum SJW of one tick (41 cycles).
function minBitCyclesAtOneTick() {
    return (2 * POLL_TICK_CYCLES + 16) + (POLL_TICK_CYCLES + 16);
}

function validate(inst, report) {
    const integer = (v) => typeof v === "number" && Number.isInteger(v);
    if (!integer(inst.bitRateKbps) || inst.bitRateKbps < 1) {
        report.logError("bitRateKbps must be a whole number of kbit/s >= 1", inst, "bitRateKbps");
        return;
    }
    if (!integer(inst.clkHz) || inst.clkHz < 1) {
        report.logError("clkHz must be the PRU clock in Hz (a whole number >= 1)", inst, "clkHz");
        return;
    }
    if (!integer(inst.samplePointPercent) || inst.samplePointPercent < 50 || inst.samplePointPercent > 95) {
        report.logError("samplePointPercent must be a whole number from 50 to 95 (CAN controllers use 75 to 87.5)", inst, "samplePointPercent");
        return;
    }
    if (!integer(inst.sjwCycles) || inst.sjwCycles < MIN_SJW_CYCLES) {
        report.logError(`sjwCycles must be a whole number of PRU cycles >= ${MIN_SJW_CYCLES} (one 3-cycle poll tick; the macro rounds it to whole ticks)`, inst, "sjwCycles");
        return;
    }
    const n = bitCycles(inst);
    const floor = minBitCyclesAtOneTick();
    if (n < floor) {
        report.logError(`bit time is ${n} PRU cycles (clkHz / (bitRateKbps * 1000)); the minimum is ${floor}. Lower bitRateKbps or raise clkHz`, inst, "bitRateKbps");
        return;
    }
    if (n > MAX_BIT_CYCLES) {
        report.logError(`bit time is ${n} PRU cycles; the maximum is ${MAX_BIT_CYCLES} (16-bit wait counter). Raise bitRateKbps or lower clkHz`, inst, "bitRateKbps");
        return;
    }
    const s = samplePointCycles(inst);
    // ISO 11898-1: SJW may not exceed either phase segment. Phase_Seg2 is N - S; the segment before the sample point is S.
    const sjw = sjwTicks(inst) * POLL_TICK_CYCLES;
    if (sjw > n - s) {
        report.logError(`sjwCycles (${inst.sjwCycles}, ${sjw} after rounding to whole ticks) exceeds Phase_Seg2 = bit time - sample point = ${n - s} cycles; lower sjwCycles or the sample point`, inst, "sjwCycles");
        return;
    }
    // The soft-resync poll window must contain the nominal edge +-SJW. Blame sjwCycles when one tick would have fitted.
    const oneTickFits = s >= 22 && n - s >= 19;
    if (s < minSampleCycles(inst)) {
        report.logError(`sample point is ${s} cycles after the edge; with sjwCycles = ${inst.sjwCycles} the soft-resync poll window needs at least ${minSampleCycles(inst)}. ${oneTickFits ? "Lower sjwCycles" : "Raise samplePointPercent or the bit time"}`, inst, oneTickFits ? "sjwCycles" : "samplePointPercent");
        return;
    }
    if (n - s < minPhaseSeg2Cycles(inst)) {
        report.logError(`Phase_Seg2 (bit time - sample point) is ${n - s} cycles; with sjwCycles = ${inst.sjwCycles} the 10-cycle destuff path plus the soft-resync poll window needs at least ${minPhaseSeg2Cycles(inst)}. ${oneTickFits ? "Lower sjwCycles" : "Lower samplePointPercent or raise the bit time"}`, inst, oneTickFits ? "sjwCycles" : "samplePointPercent");
        return;
    }
    const actual = inst.clkHz / n / 1000;
    if (Math.abs(actual - inst.bitRateKbps) / inst.bitRateKbps > 0.005) {
        report.logWarning(`clkHz / ${n} cycles gives ${actual.toFixed(3)} kbit/s, more than 0.5% from bitRateKbps = ${inst.bitRateKbps}; the bit time is a whole number of PRU cycles`, inst, "bitRateKbps");
    }
}

const canClassicModule = {
    displayName: "CAN Classic Decoder (Slice)",
    defaultInstanceName: `${PRU_USED}_CAN_DEC_INSTANCE_`,
    description: "CAN Classic protocol payload descrambler with configurable bit time, sample point and SJW-bounded resynchronisation.",
    longDescription: "Reads a bit-stuffed CAN Classic stream at a configurable bit rate, handles bit destuffing (skip after 5 identical), and extracts a 32-bit payload without MULL. Excludes arbitration and CRC for this slice; it does not flag stuff errors and does not check that SOF is still dominant at its sample point. TIMING: bit time is clkHz / (bitRateKbps * 1000) PRU cycles (200 for 1 Mbit/s and 400 for 500 kbit/s at 200 MHz); the sample point is samplePointPercent of the bit; the decoder hard-syncs on the SOF edge and then applies a soft resync (ISO 11898-1: recessive-to-dominant edges only, at most one per bit, armed after a recessive sample) whose correction is clamped to sjwCycles (rounded to the 3-cycle poll tick, default one tick). The destuff path costs exactly 10 PRU cycles on every path and the remainder of the bit is a cycle-counted 3-cycle poll loop, so sample-to-sample is exactly one bit time. Supported bit time is 41 to 20000 PRU cycles (sjwCycles = 3). Verified on the TI pru-simulator running the real clpru ELF at 200 and 400 cycles per bit (clean frame, per-bit jitter, oscillator drift, a phase error larger than SJW); NOT hardware validated. The block waits for the SOF edge and then runs for 32 destuffed bits, so it has no bounded peak cycle count: noOfCycles is -1 (unknown) and the generated OVERALL PEAK CYCLES header reads Unknown. BREAKING CHANGE: the old fixed 10-PRU-cycles-per-bit sampling (PRU clock / 10) is gone, and a saved .syscfg that lacks the new bitRateKbps, clkHz, samplePointPercent and sjwCycles fields now decodes at the defaults, 1 Mbit/s at 200 MHz = 200 cycles per bit. Dead zone: at the minimum configurations a late edge more than SJW + 2 cycles after nominal is ignored (the sample point does not move), and an early edge within the 10-cycle destuff path after the sample is ignored. See docs/can_classic_bit_timing.md for the cycle budget.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "rxBit", displayName: "RX R31 bit", default: "0", options: GPIO_SIGNALS },
        { name: "bitRateKbps", displayName: "CAN bit rate (kbit/s)", default: 1000 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },
        { name: "samplePointPercent", displayName: "Sample point (% of bit time)", default: 75 },
        { name: "sjwCycles", displayName: "Synchronisation jump width (PRU cycles)", default: 3 },

        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },

        { name: "opCode", default: "m_can_classic_decoder", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.rxBit },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => timing(inst).wt },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => timing(inst).rp },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => timing(inst).xs },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => timing(inst).rs },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => timing(inst).sq },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => timing(inst).sj },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => -1, default: -1 }
    ],

    validate,

    ports: (inst) => {
        return [
            { name: "output1", type: "output32" },
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.rxBit), dir: "GPI" });
            return pins;
        },
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `; CAN Classic Bit-Stuffed Decoder Slice (configurable bit time, sample point, SOF hard sync, SJW-bounded soft resync)`,
            `; Descrambles 32 bits from RX stream (removes stuff bits)`,
            `; Does not use MULL`,
            `; Arguments (all derived by the block from bitRateKbps, clkHz, samplePointPercent, sjwCycles; BIT_CYC is`,
            `; clkHz / (bitRateKbps * 1000), e.g. 200 for 1 Mbit/s and 400 for 500 kbit/s at 200 MHz):`,
            `;   WAIT_TICKS  (BIT_CYC - 10) / 3   3-cycle poll ticks per bit`,
            `;   PAD_CYC     (BIT_CYC - 10) mod 3 nops after the wait loop, so 10 + 3 * WAIT_TICKS + PAD_CYC = BIT_CYC`,
            `;   SOF_TICKS   (BIT_CYC + 3 * HARD_TICKS + 4) / 3   wait from the SOF edge to the first data-bit sample`,
            `;   SOF_PAD     (BIT_CYC + 4) mod 3 nops on the SOF path`,
            `;   HARD_TICKS  (SAMPLE_CYC - PAD_CYC - 10 + 1) / 3   ticks to wait after an in-window edge (hard sync)`,
            `;   SJW_TICKS   max(1, (SJW_CYC + 1) / 3)   synchronisation jump width in 3-cycle ticks`,
            `; The destuff/shift path costs exactly 10 cycles on every path (sample instruction included). The rest of`,
            `; the bit is a 3-cycle poll loop (WAIT_TICKS iterations) plus PAD_CYC nops, so sample-to-sample is BIT_CYC.`,
            `; Hard sync on the SOF edge only; later recessive-to-dominant edges are a SOFT resync clamped to +-SJW`,
            `; (ISO 11898-1), at most one per bit, armed only after a recessive sample. See docs/can_classic_bit_timing.md.`,
            `; Temporaries: TEMP_REG1 (R28) wait counter, TEMP_REG2 (R29) compare scratch, R8..R10 as before.`,
            `${opCode} .macro RES, RX_BIT, WAIT_TICKS, PAD_CYC, SOF_TICKS, SOF_PAD, HARD_TICKS, SJW_TICKS`,
            `    ; Temporaries in R8, R9, R10 for this slice`,
            `    ldi R8, 0 ; R_COUNT = 0`,
            `    ldi R9, 1 ; R_SAME = 1`,
            `    ldi R10, 1 ; R_PREV = 1`,
            `    ldi RES, 0 ; R_RESULT = 0`,
            ``,
            `WAIT_SOF?:`,
            `    qbbs WAIT_SOF?, R31, RX_BIT ; 1-cycle poll while RX is 1; falls through on the SOF edge (hard sync)`,
            `    ldi R10, 0 ; +1`,
            `    ldi R9, 1 ; +2`,
            `    ldi R8, 0 ; +3`,
            `    ldi TEMP_REG1, SOF_TICKS ; +4  the first data-bit sample is BIT_CYC + sample point after the SOF edge`,
            `    .if SOF_PAD >= 1`,
            `    nop`,
            `    .endif`,
            `    .if SOF_PAD >= 2`,
            `    nop`,
            `    .endif`,
            `    jmp WAIT_D? ; SOF edge to the unarmed loop is 6 + SOF_PAD cycles`,
            ``,
            `; Armed wait loop (previous sample recessive): 3 cycles per tick, polls for a dominant edge.`,
            `; Runs while TEMP_REG1 > G = SJW_TICKS + 3, then falls into the unarmed loop for the last G ticks`,
            `; (an edge in the final G ticks is not used, which also keeps the soft-resync reload >= 1).`,
            `WAIT_A?:`,
            `    qbbc EDGE?, R31, RX_BIT ; dominant: edge found (a taken branch costs 1 cycle)`,
            `    sub TEMP_REG1, TEMP_REG1, 1`,
            `    qbne WAIT_A?, TEMP_REG1, (SJW_TICKS + 3)`,
            `; Unarmed wait loop: identical 3-cycle tick, no edge poll.`,
            `WAIT_D?:`,
            `    nop`,
            `    sub TEMP_REG1, TEMP_REG1, 1`,
            `    qbne WAIT_D?, TEMP_REG1, 0`,
            `    ; remainder pad: PAD_CYC = BIT_CYC - 10 - 3 * WAIT_TICKS cycles (0..2) so the bit is exactly BIT_CYC`,
            `    .if PAD_CYC >= 1`,
            `    nop`,
            `    .endif`,
            `    .if PAD_CYC >= 2`,
            `    nop`,
            `    .endif`,
            ``,
            `LOOP?:`,
            `    qbbs BIT_IS_1?, R31, RX_BIT ; cycle 1 = the sample instant`,
            `BIT_IS_0?:`,
            `    qbne NO_STUFF_0?, R9, 5 ; 2`,
            `    ; Stuff bit 0 (cycles 3..10)`,
            `    ldi R9, 1`,
            `    ldi R10, 0`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    nop`,
            `    nop`,
            `    nop`,
            `    nop`,
            `    qbne WAIT_D?, R8, 32 ; 10`,
            `    jmp EXIT?`,
            `NO_STUFF_0?:`,
            `    lsl RES, RES, 1 ; 3`,
            `    add R8, R8, 1 ; 4`,
            `    qbeq CHECK_SAME_0?, R10, 0 ; 5`,
            `    ; Diff 0 (cycles 6..10)`,
            `    ldi R9, 1`,
            `    ldi R10, 0`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    nop`,
            `    qbne WAIT_D?, R8, 32 ; 10`,
            `    jmp EXIT?`,
            `CHECK_SAME_0?:`,
            `    ; Same 0 (cycles 6..10)`,
            `    add R9, R9, 1`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    nop`,
            `    nop`,
            `    qbne WAIT_D?, R8, 32 ; 10`,
            `    jmp EXIT?`,
            ``,
            `BIT_IS_1?:`,
            `    qbne NO_STUFF_1?, R9, 5 ; 2`,
            `    ; Stuff bit 1 (cycles 3..10)`,
            `    ldi R9, 1`,
            `    ldi R10, 1`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    nop`,
            `    nop`,
            `    nop`,
            `    nop`,
            `    qbne WAIT_A?, R8, 32 ; 10, recessive sample: the next wait is armed`,
            `    jmp EXIT?`,
            `NO_STUFF_1?:`,
            `    lsl RES, RES, 1 ; 3`,
            `    or RES, RES, 1 ; 4`,
            `    add R8, R8, 1 ; 5`,
            `    qbeq CHECK_SAME_1?, R10, 1 ; 6`,
            `    ; Diff 1 (cycles 7..10)`,
            `    ldi R9, 1`,
            `    ldi R10, 1`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    qbne WAIT_A?, R8, 32 ; 10`,
            `    jmp EXIT?`,
            `CHECK_SAME_1?:`,
            `    ; Same 1 (cycles 7..10)`,
            `    add R9, R9, 1`,
            `    ldi TEMP_REG1, WAIT_TICKS`,
            `    nop`,
            `    qbne WAIT_A?, R8, 32 ; 10`,
            `    jmp EXIT?`,
            ``,
            `; Soft resync, entered from the armed poll (TEMP_REG1 = ticks still to wait, this one included).`,
            `; A nominal edge arrives with TEMP_REG1 = HARD_TICKS + 3. Within +-SJW_TICKS of that the reload is the`,
            `; hard-sync value HARD_TICKS; beyond it the reload is the nominal wait (TEMP_REG1 - 3) shifted by exactly`,
            `; +-SJW_TICKS. Every path is 8 cycles + the poll cycle = 9 = 3 ticks.`,
            `EDGE?:`,
            `    ldi TEMP_REG2, (HARD_TICKS + 3 - SJW_TICKS) ; 1`,
            `    qbgt LATE?, TEMP_REG1, TEMP_REG2 ; 2  lower bound > TEMP_REG1: edge later than nominal + SJW`,
            `    ldi TEMP_REG2, (HARD_TICKS + 3 + SJW_TICKS) ; 3`,
            `    qblt EARLY?, TEMP_REG1, TEMP_REG2 ; 4  upper bound < TEMP_REG1: edge earlier than nominal - SJW`,
            `    ldi TEMP_REG1, HARD_TICKS ; 5  within SJW: hard sync to the edge`,
            `    nop ; 6`,
            `    nop ; 7`,
            `    jmp WAIT_D? ; 8`,
            `LATE?:`,
            `    ldi TEMP_REG2, SJW_TICKS ; 3  (reload = TEMP_REG1 - 3 + SJW_TICKS)`,
            `    sub TEMP_REG1, TEMP_REG1, 3 ; 4`,
            `    add TEMP_REG1, TEMP_REG1, TEMP_REG2 ; 5`,
            `    nop ; 6`,
            `    nop ; 7`,
            `    jmp WAIT_D? ; 8`,
            `EARLY?:`,
            `    ldi TEMP_REG2, (SJW_TICKS + 3) ; 5  (reload = TEMP_REG1 - 3 - SJW_TICKS)`,
            `    sub TEMP_REG1, TEMP_REG1, TEMP_REG2 ; 6`,
            `    nop ; 7`,
            `    jmp WAIT_D? ; 8`,
            `EXIT?:`,
            `    .endm`
        ].join('\n');
    }
};

exports = canClassicModule;
