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

// WS2812B datasheet nominal pulse widths (ns) and the reset latch time.
const WS_T0H_NS = 400;
const WS_T0L_NS = 850;
const WS_T1H_NS = 800;
const WS_T1L_NS = 450;
const WS_RESET_NS = 60000;   // datasheet: low > 50 us latches the frame

// Every delay-loop count costs 2 PRU cycles (sub; qbne), and each pulse also
// carries fixed cycles outside the loop (measured on TI pru-simulator from
// the m_ws2812_tx macro below): a high pulse is 2*count + 3 cycles (ldi32 x2
// + clr), a low pulse is 2*count + 9 cycles after a 0 bit and 2*count + 10
// after a 1 bit (ldi32 x2 + bit-advance + next-bit decode + set).
const WS_CYCLES_PER_COUNT = 2;
const WS_HIGH_OVERHEAD = 3;
const WS_T0L_OVERHEAD = 9;
const WS_T1L_OVERHEAD = 10;

function wsDelayCount(ns, clkHz, overheadCycles) {
    const cycles = ns * clkHz / 1e9;
    return Math.max(1, Math.round((cycles - overheadCycles) / WS_CYCLES_PER_COUNT));
}

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i), displayName: `PRU GPIO ${i} (R30/R31.${i})`,
}));

const ws2812Module = {
    displayName: "WS2812 LED Strip",
    defaultInstanceName: `${PRU_USED}_WS2812_INSTANCE_`,
    description: "WS2812 addressable LED strip driver.",
    longDescription: "Emits precise cycle-timed bit-banging assembly for WS2812 LEDs. The 24-bit color register is sent bit 23 first in GRB packing (bits 23-16 green, bits 15-8 red, bits 7-0 blue).",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        {
            name: "blockMaturity",
            displayName: "Block Maturity",
            default: "dual-oracle-tested",
            options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}],
            hidden: true
        },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "pinId", displayName: "Output R30 pin", default: "5", options: GPIO_SIGNALS },
        { name: "dataRegister", displayName: "Data Register (24-bit Color)", default: "R0" },
        { name: "numLeds", displayName: "Number of LEDs", default: 10 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_ws2812_tx", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 8, hidden: true },
        
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.pinId },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => inst.numLeds },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => wsDelayCount(WS_T0H_NS, inst.clkHz, WS_HIGH_OVERHEAD) },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => wsDelayCount(WS_T0L_NS, inst.clkHz, WS_T0L_OVERHEAD) },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => wsDelayCount(WS_T1H_NS, inst.clkHz, WS_HIGH_OVERHEAD) },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => wsDelayCount(WS_T1L_NS, inst.clkHz, WS_T1L_OVERHEAD) },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => wsDelayCount(WS_RESET_NS, inst.clkHz, 0) },
        
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
        if (inst.numLeds <= 0) validation.logError("numLeds must be > 0", inst, "numLeds");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, PIN, DATA_REG, NUM_LEDS, T0H_CYC, T0L_CYC, T1H_CYC, T1L_CYC, TRESET_CYC`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, TRESET_CYC`,
            `ws_rs?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ws_rs?, TEMP_REG1, 0`,
            `    lsl   DATA_REG, DATA_REG, 1`,
            `    ldi   TEMP_REG2.w0, NUM_LEDS`,
            `ws_ll?:`,
            `    ldi   TEMP_REG2.b2, 24`,
            `ws_bl?:`,
            `    lsr   TEMP_REG1, DATA_REG, TEMP_REG2.b2`,
            `    and   TEMP_REG1, TEMP_REG1, 1`,
            `    qbeq  ws_z?, TEMP_REG1, 0`,
            `    set   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, T1H_CYC`,
            `ws_1h?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ws_1h?, TEMP_REG1, 0`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, T1L_CYC`,
            `ws_1l?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ws_1l?, TEMP_REG1, 0`,
            `    qba   ws_bd?`,
            `ws_z?:`,
            `    set   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, T0H_CYC`,
            `ws_0h?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ws_0h?, TEMP_REG1, 0`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, T0L_CYC`,
            `ws_0l?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ws_0l?, TEMP_REG1, 0`,
            `ws_bd?:`,
            `    mov   TEMP_REG1, TEMP_REG1`,
            `    sub   TEMP_REG2.b2, TEMP_REG2.b2, 1`,
            `    qbne  ws_bl?, TEMP_REG2.b2, 0`,
            `    sub   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    qbne  ws_ll?, TEMP_REG2.w0, 0`,
            `    lsr   DATA_REG, DATA_REG, 1`,
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
            pins.push({ pin: parseInt(inst.pinId), dir: "GPO" });
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

exports = ws2812Module;
