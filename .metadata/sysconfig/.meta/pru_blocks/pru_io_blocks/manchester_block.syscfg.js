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

const CONVENTIONS = [
    { name: "ieee", displayName: "IEEE 802.3" },
    { name: "thomas", displayName: "G.E. Thomas" }
];

// Fixed cycles m_manchester_run spends between two R30 writes, outside its delay
// (pad + ldi32 + 2-cycle sub/qbne loop), counted from the getMacro body below. Both data
// paths (bit 1 / bit 0) are laid out to cost the same, so the half-bit does not depend on the data.
//   first half  (first-half write .. mid-bit write):  write 1, qba 1, qbbc mask 1, lsl mask 1,
//                                                     ldi32 2, qbbc data 1                 = 7
//   second half (mid-bit write .. next bit's write):   write 1, qba 1, qbbc mask 1, lsl mask 1,
//                                                     ldi32 2, lsl 1, sub 1, qbne 1, qbbc 1 = 10
//   (after the last bit the trailing nop replaces the next bit's qbbc, so the macro returns
//    exactly one half-bit after the last mid-bit edge)
// The extra-cycle mask's nop is not overhead: it is the +1 of a long half-bit (see below).
const MANCHESTER_OVERHEAD = { first: 7, second: 10 };
const MIN_DELAY = 2;     // the delay loop runs at least once: pad (0/1) + 2 * loops, loops >= 1

// Half-bit k of the byte starts round(k * H) cycles after the first edge, H = clkHz / (2 * bitRateHz)
// (round half up, exact integer arithmetic). A whole-cycle H gives every half-bit exactly H; a
// fractional H gives half-bits of floor(H) and floor(H) + 1, and no edge is ever more than half a
// cycle from its nominal time, so the error does not accumulate over the byte.
function manchesterTiming(clkHz, bitRateHz) {
    const clk = Math.round(clkHz), twoRate = 2 * Math.round(bitRateHz);
    if (!(clk > 0) || !(twoRate > 0)) return null;
    const edge = (k) => Math.floor((2 * k * clk + twoRate) / (2 * twoRate));
    const base = Math.floor(clk / twoRate);
    let mask = 0;
    for (let k = 0; k < 16; k++) {
        const extra = edge(k + 1) - edge(k) - base;      // 0 or 1
        mask |= extra << (15 - k);                        // MSB = first half of the first bit
    }
    const path = (overhead) => {
        const delay = base - overhead;
        return { overhead, delay, loops: delay >> 1, pad: delay & 1 };
    };
    return { half: clk / twoRate, base, mask, first: path(MANCHESTER_OVERHEAD.first),
             second: path(MANCHESTER_OVERHEAD.second) };
}

const manchesterModule = {
    displayName: "Manchester Encoder",
    defaultInstanceName: `${PRU_USED}_MANCHESTER_INSTANCE_`,
    description: "Manchester-encoded TX line.",
    longDescription: "Cycle-exact half-bit timing on the PRU for jitter-free mid-bit edges: every half-bit is " +
        "clkHz / (2 * bitRateHz) PRU cycles on both data paths, so the bit period does not depend on the data, and the " +
        "macro returns one half-bit after the last mid-bit edge. The delay counts are the nominal half-bit minus the fixed " +
        "instruction overhead (7 cycles before the mid-bit edge, 10 after it). A fractional half-bit puts edge k at " +
        "round(k * H) cycles (half-bits of floor(H) or floor(H) + 1), so no edge is more than half a cycle off and the " +
        "error does not accumulate. Fastest rate: clkHz / 24 (8.33 Mbit/s at 200 MHz).",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "dual-oracle-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "signalPin", displayName: "Signal R30 pin", default: "13", options: GPIO_SIGNALS },
        { name: "dataRegister", displayName: "Byte to encode (Reg)", default: "R5.b0" },
        { name: "bitRateHz", displayName: "Bit rate (Hz)", default: 1000000 },
        { name: "convention", displayName: "Encoding convention", default: "ieee", options: CONVENTIONS },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_manchester_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 8, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.signalPin },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => (manchesterTiming(inst.clkHz, inst.bitRateHz) || { mask: 0 }).mask },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => inst.convention === "thomas" ? 1 : 0 },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        { name: "constant5", hidden: true, default: 1, getValue: (inst) => Math.max(1, (manchesterTiming(inst.clkHz, inst.bitRateHz) || { first: { loops: 1 } }).first.loops) },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => (manchesterTiming(inst.clkHz, inst.bitRateHz) || { first: { pad: 0 } }).first.pad },
        { name: "constant7", hidden: true, default: 1, getValue: (inst) => Math.max(1, (manchesterTiming(inst.clkHz, inst.bitRateHz) || { second: { loops: 1 } }).second.loops) },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => (manchesterTiming(inst.clkHz, inst.bitRateHz) || { second: { pad: 0 } }).second.pad },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 }
    ],

    ports: (inst) => {
        return [
            { name: "output1", type: "output32" },
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (inst.bitRateHz <= 0) validation.logError("bitRateHz must be > 0", inst, "bitRateHz");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
        const t = manchesterTiming(inst.clkHz, inst.bitRateHz);
        if (!t) return;
        // Every half-bit is the nominal half-bit; the fixed instructions around the delay
        // must leave room for a delay loop of at least one pass on the longer (second-half) path.
        const need = MANCHESTER_OVERHEAD.second + MIN_DELAY;
        if (t.second.delay < MIN_DELAY) {
            validation.logError(`bitRateHz ${inst.bitRateHz} too high for clkHz ${inst.clkHz}: the half-bit is ` +
                `${t.half.toFixed(2)} cycles but the encoder's fixed overhead is ${MANCHESTER_OVERHEAD.second} cycles ` +
                `per half-bit plus a ${MIN_DELAY}-cycle minimum delay (needs >= ${need} cycles per half-bit, ` +
                `i.e. bitRateHz <= ${Math.floor(inst.clkHz / (2 * need))})`, inst, "bitRateHz");
        } else if (t.second.loops > 0xFFFFFFFF) {
            validation.logError(`bitRateHz ${inst.bitRateHz} too low for clkHz ${inst.clkHz}: delay loop count exceeds 32 bits`, inst, "bitRateHz");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            // N1/P1, N2/P2 = delay-loop passes / 1-cycle pad after the first-half and the
            // mid-bit write (nominal - fixed overhead, MANCHESTER_OVERHEAD); XMASK bit 15-k adds one
            // cycle to half-bit k. The bit-1 and bit-0 paths cost the same cycles at every step.
            `${opCode} .macro RES, SIG_PIN, XMASK, CONV_THOMAS, DATA_BYTE, N1, P1, N2, P2`,
            `    ldi   TEMP_REG2.w0, XMASK`,
            `    ldi   TEMP_REG2.b2, 8`,
            `mc_b?:`,
            `    qbbc  mc_z?, DATA_BYTE, 7`,
            `    .if CONV_THOMAS == 1`,
            `    set   R30, R30, SIG_PIN`,
            `    .else`,
            `    clr   R30, R30, SIG_PIN`,
            `    .endif`,
            `    qba   mc_h1?`,
            `mc_z?:`,
            `    .if CONV_THOMAS == 1`,
            `    clr   R30, R30, SIG_PIN`,
            `    .else`,
            `    set   R30, R30, SIG_PIN`,
            `    .endif`,
            `    qba   mc_h1?`,
            `mc_h1?:`,
            `    qbbc  mc_e1?, TEMP_REG2, 15`,
            `    nop`,
            `mc_e1?:`,
            `    lsl   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    .if P1 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi32 TEMP_REG1, N1`,
            `mc_d1?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  mc_d1?, TEMP_REG1, 0`,
            `    qbbc  mc_z2?, DATA_BYTE, 7`,
            `    .if CONV_THOMAS == 1`,
            `    clr   R30, R30, SIG_PIN`,
            `    .else`,
            `    set   R30, R30, SIG_PIN`,
            `    .endif`,
            `    qba   mc_h2?`,
            `mc_z2?:`,
            `    .if CONV_THOMAS == 1`,
            `    set   R30, R30, SIG_PIN`,
            `    .else`,
            `    clr   R30, R30, SIG_PIN`,
            `    .endif`,
            `    qba   mc_h2?`,
            `mc_h2?:`,
            `    qbbc  mc_e2?, TEMP_REG2, 15`,
            `    nop`,
            `mc_e2?:`,
            `    lsl   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    .if P2 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi32 TEMP_REG1, N2`,
            `mc_d2?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  mc_d2?, TEMP_REG1, 0`,
            `    lsl   DATA_BYTE, DATA_BYTE, 1`,
            `    sub   TEMP_REG2.b2, TEMP_REG2.b2, 1`,
            `    qbne  mc_b?, TEMP_REG2.b2, 0`,
            `    nop`,
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
            pins.push({ pin: parseInt(inst.signalPin), dir: "GPO" });
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

exports = manchesterModule;
