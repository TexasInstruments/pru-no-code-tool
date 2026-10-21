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
    name: String(i), displayName: `PRU GPIO ${i} (R30/R31.${i})`,
}));

const CHANNELS = [
    { name: "mono", displayName: "Mono" },
    { name: "stereoLeft", displayName: "Stereo Left" },
    { name: "stereoRight", displayName: "Stereo Right" }
];

// M_pdm_run's fixed instructions around each half-period's delay loop, counted from the getMacro
// body below. The sample is branch-free (lsl, lsr R31, and, or = 4 cycles) so the clock does not depend on
// the data, and it sits in the half that ends at the sample edge (mono / left: the high half; right: the low half).
//   high half (set .. clr):      set 1, [pad 0/1], ldi32 2, 2 * loops, [sample 4 if mono/left]          = 3 + ...
//   low half  (clr .. next set): clr 1, [pad 0/1], ldi32 2, 2 * loops, [sample 4 if right], sub 1, qbne 1 = 5 + ...
//   whole macro: ldi 1, ldi 1, bits * period, mov RES 1 (the last low half ends where the next set would be)
const PDM_OVERHEAD = { high: 3, low: 5, sample: 4 };
const PDM_SETUP_CYCLES = 2, PDM_EPILOGUE_CYCLES = 1;
const MIN_DELAY = 2;     // the delay loop runs at least once: pad (0/1) + 2 * loops, loops >= 1

// The clock period is round(clkHz / clkRateHz) PRU cycles (round half up), split into a high half of
// floor(period / 2) and a low half of the rest; each half's delay is its length minus the fixed overhead above,
// as pad + 2 * loops. The period is within half a cycle of clkHz / clkRateHz (97.66 -> 98 at 2.048 MHz and
// 200 MHz; 64 exactly at 3.125 MHz).
function pdmTiming(clkHz, clkRateHz, channel, numBits) {
    const clk = Math.round(clkHz), rate = Math.round(clkRateHz);
    if (!(clk > 0) || !(rate > 0)) return null;
    const sampleHigh = channel !== "stereoRight";
    const period = Math.floor((2 * clk + rate) / (2 * rate));
    const high = Math.floor(period / 2), low = period - high;
    const half = (len, overhead) => {
        const delay = len - overhead;
        return { len, overhead, delay, loops: delay >> 1, pad: delay & 1 };
    };
    return {
        period, sampleHigh,
        high: half(high, PDM_OVERHEAD.high + (sampleHigh ? PDM_OVERHEAD.sample : 0)),
        low: half(low, PDM_OVERHEAD.low + (sampleHigh ? 0 : PDM_OVERHEAD.sample)),
        cycles: PDM_SETUP_CYCLES + (Number(numBits) || 0) * period + PDM_EPILOGUE_CYCLES
    };
}

const pdmModule = {
    displayName: "PDM Microphone",
    defaultInstanceName: `${PRU_USED}_PDM_INSTANCE_`,
    description: "PDM (pulse-density-modulation) mic reader.",
    longDescription: "Generates a jitter-free clock and samples on the correct edge every period. The clock period is " +
        "round(clkHz / clkRateHz) PRU cycles (98 at 2.048 MHz and 200 MHz, 64 at 3.125 MHz), high for floor(period / 2) cycles; the " +
        "delay counts are each half's length minus the fixed instruction overhead and the sample is branch-free, so the period does " +
        "not depend on the data. After the last bit the shifted-in word (the first sample is the MSB, right-aligned in 'Bits per " +
        "word', at most 32) is copied to output1 (4 bytes) as well as left in the Output Register. The block takes " +
        "3 + bits * period PRU cycles (Number Of Cycles). Fastest clock: about clkHz / 18 (mono / left), clkHz / 21 (right).",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "clkPin", displayName: "PDM clock R30 pin", default: "11", options: GPIO_SIGNALS },
        { name: "dataPin", displayName: "PDM data R31 pin", default: "12", options: GPIO_SIGNALS },
        { name: "clkRateHz", displayName: "PDM clock rate (Hz)", default: 2048000 },
        { name: "channel", displayName: "Channel / sample edge", default: "mono", options: CHANNELS },
        { name: "dataRegister", displayName: "Output Register (32-bit)", default: "R5" },
        { name: "numBits", displayName: "Bits per word", default: 32 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_pdm_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 9, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.clkPin },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.dataPin },
        { name: "constant3", hidden: true, default: 1, getValue: (inst) => Math.max(1, (pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits) || { high: { loops: 1 } }).high.loops) },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => (pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits) || { high: { pad: 0 } }).high.pad },
        { name: "constant5", hidden: true, default: 1, getValue: (inst) => Math.max(1, (pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits) || { low: { loops: 1 } }).low.loops) },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => (pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits) || { low: { pad: 0 } }).low.pad },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.channel !== "stereoRight" ? 1 : 0 },
        { name: "constant8", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        { name: "constant9", hidden: true, default: 0, getValue: (inst) => inst.numBits },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => (pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits) || { cycles: 1 }).cycles, default: 1 }
    ],

    ports: (inst) => {
        return [
            { name: "output1", type: "output32" },
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (inst.clkPin === inst.dataPin) validation.logError("clkPin and dataPin must differ", inst, "dataPin");
        if (inst.clkRateHz <= 0) validation.logError("clkRateHz must be > 0", inst, "clkRateHz");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
        if (!(inst.numBits >= 1 && inst.numBits <= 32) || Math.floor(inst.numBits) !== inst.numBits) validation.logError("numBits must be an integer from 1 to 32 (the word is shifted into one 32-bit register)", inst, "numBits");
        const t = pdmTiming(inst.clkHz, inst.clkRateHz, inst.channel, inst.numBits);
        if (!t) return;
        const need = Math.max(2 * (t.high.overhead + MIN_DELAY), 2 * (t.low.overhead + MIN_DELAY) - 1);
        if (t.high.delay < MIN_DELAY || t.low.delay < MIN_DELAY) {
            validation.logError(`clkRateHz ${inst.clkRateHz} too high for clkHz ${inst.clkHz}: the clock period is ${t.period} cycles but the ` +
                `block's fixed overhead needs ${need} (${t.high.overhead} + ${MIN_DELAY} in the high half, ${t.low.overhead} + ${MIN_DELAY} in the low half, ` +
                `i.e. clkRateHz <= ${Math.floor(inst.clkHz / need)})`, inst, "clkRateHz");
        } else if (t.high.loops > 0xFFFFFFFF || t.low.loops > 0xFFFFFFFF) {
            validation.logError(`clkRateHz ${inst.clkRateHz} too low for clkHz ${inst.clkHz}: delay loop count exceeds 32 bits`, inst, "clkRateHz");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            // NH/PH and NL/PL = delay-loop passes / 1-cycle pad in the high and low half
            // (half length - PDM_OVERHEAD); SAMPLE_HIGH picks the half that holds the 4-cycle sample.
            `${opCode} .macro RES, CLK_PIN, DATA_PIN, NH, PH, NL, PL, SAMPLE_HIGH, DATA_REG, NUM_BITS`,
            `    ldi   DATA_REG, 0`,
            `    ldi   TEMP_REG2.b0, NUM_BITS`,
            `pd_b?:`,
            `    set   R30, R30, CLK_PIN`,
            `    .if PH == 1`,
            `    nop`,
            `    .endif`,
            `    ldi32 TEMP_REG1, NH`,
            `pd_h?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pd_h?, TEMP_REG1, 0`,
            `    .if SAMPLE_HIGH`,
            `    lsl   DATA_REG, DATA_REG, 1`,
            `    lsr   TEMP_REG1, R31, DATA_PIN`,
            `    and   TEMP_REG1, TEMP_REG1, 1`,
            `    or    DATA_REG, DATA_REG, TEMP_REG1`,
            `    .endif`,
            `    clr   R30, R30, CLK_PIN`,
            `    .if PL == 1`,
            `    nop`,
            `    .endif`,
            `    ldi32 TEMP_REG1, NL`,
            `pd_l?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pd_l?, TEMP_REG1, 0`,
            `    .if SAMPLE_HIGH = 0`,
            `    lsl   DATA_REG, DATA_REG, 1`,
            `    lsr   TEMP_REG1, R31, DATA_PIN`,
            `    and   TEMP_REG1, TEMP_REG1, 1`,
            `    or    DATA_REG, DATA_REG, TEMP_REG1`,
            `    .endif`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  pd_b?, TEMP_REG2.b0, 0`,
            `    mov   RES, DATA_REG`,
            `    .endm`
        ].join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.clkPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dataPin), dir: "GPI" });
            return pins;
        },
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = pdmModule;
