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
const MAX_DELAY_TRIPS = 65535;

const parallelBusModule = {
    displayName: "Parallel Bus / Strobe",
    defaultInstanceName: `${PRU_USED}_PARALLEL_BUS_INSTANCE_`,
    description: "A7 parallel bus / strobe.",
    longDescription: "Drives or samples a CONTIGUOUS field of data pins with a single strobe pulse. Setup and hold are loop-trip counts (integer 0..65535): a delay of N trips lasts 2 + 2N PRU cycles, and 0 emits no delay at all. Behaviour change: the loops used to collapse to one cycle regardless of the configured count; the default of 2 trips now gives a 6-cycle setup and a 6-cycle hold.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "direction", displayName: "Direction", default: "write", options: [{name:"write"}, {name:"read"}] },
        { name: "dataPinsStr", displayName: "Data Pins (R30/R31 Bits)", description: "Comma-separated R30/R31 bit numbers.", default: "12,13,14,15,16,17,18,19" },
        { name: "strobePin", displayName: "Strobe Pin", default: 20 },
        { name: "strobePolarity", displayName: "Strobe Polarity", default: "active-low", options: [{name:"active-low"}, {name:"active-high"}] },
        { name: "setupCycles", displayName: "Setup Delay Trips", description: "Setup delay in loop trips (0..65535): 2 + 2 x trips PRU cycles; 0 emits no delay loop.", longDescription: "Setup delay in loop trips, an integer 0..65535. Each trip is a sub + qbne pair = 2 PRU cycles, so the delay is 2 + 2 x trips cycles (the 2 is the ldi32 that loads the count); 0 trips emits no delay loop. Negative, fractional or above-65535 values are refused.", default: 2 },
        { name: "holdCycles", displayName: "Hold Delay Trips", description: "Hold delay in loop trips (0..65535): 2 + 2 x trips PRU cycles; 0 emits no delay loop.", longDescription: "Hold delay in loop trips, an integer 0..65535. Each trip is a sub + qbne pair = 2 PRU cycles, so the delay is 2 + 2 x trips cycles (the 2 is the ldi32 that loads the count); 0 trips emits no delay loop. Negative, fractional or above-65535 values are refused.", default: 2 },
        { name: "busValue", displayName: "Write Value (Hex/Dec)", default: "0xA5" },
        { name: "dataRegister", displayName: "Read Output Register (Unused)", description: "Unused: the read result goes to the allocated output.", default: "R1" },

        { name: "opCode", default: "m_parallel_bus_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 10, hidden: true },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => {
            const pins = inst.dataPinsStr.split(',').map(s => parseInt(s.trim()));
            return Math.min(...pins);
        }},
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => {
            const pins = inst.dataPinsStr.split(',').map(s => parseInt(s.trim()));
            return pins.length;
        }},
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => {
            const pins = inst.dataPinsStr.split(',').map(s => parseInt(s.trim()));
            const base = Math.min(...pins);
            const width = pins.length;
            let mask = 0;
            for(let i=0; i<width; i++) mask |= (1 << (base + i));
            return mask;
        }},
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => inst.strobePin },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.strobePolarity === "active-low" ? 1 : 0 },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => inst.setupCycles },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.holdCycles },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => {
            let val = parseInt(inst.busValue, 16);
            if (isNaN(val)) val = parseInt(inst.busValue);
            return val;
        }},
        { name: "constant9", hidden: true, default: 0, getValue: (inst) => inst.direction === "read" ? 1 : 0 },
        { name: "constant10", hidden: true, default: "", getValue: (inst) => inst.dataRegister },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 }
    ],

    ports: (inst) => {
        if (inst.direction === 'read') {
            return [
                { name: "output1", type: "output32" },
                { name: "prev", type: "IO_PREV" },
                { name: "next", type: "IO_NEXT" }
            ];
        }
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        // ldi32 + the sub/qbne loop are exact up to 2^32-1, but that is ~8.6e9 cycles (~43 s at 200 MHz) with no halt in sight;
        // 0xFFFF trips (131072 cycles, ~0.65 ms) is a bound no strobe timing needs to exceed. Below 0 the `.if N > 0` guard silently
        // drops the delay; at 2^32 ldi32 truncates to 0 and the sub wraps into a ~4e9-trip loop.
        [["setupCycles", "Setup"], ["holdCycles", "Hold"]].forEach(([key, label]) => {
            const n = inst[key];
            if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_DELAY_TRIPS) {
                validation.logError(`${label} delay trips must be an integer from 0 to ${MAX_DELAY_TRIPS} (got ${n})`, inst, key);
            }
        });
        const pins = inst.dataPinsStr.split(',').map(s => parseInt(s.trim()));
        if (pins.length === 0 || pins.some(isNaN)) {
            validation.logError("Invalid data pins", inst, "dataPinsStr");
            return;
        }
        const sorted = [...pins].sort((a, b) => a - b);
        const contiguous = sorted.every((b, i) => i === 0 || b === sorted[i - 1] + 1);
        if (!contiguous) validation.logError(`dataPins must be contiguous (got ${sorted.join(',')})`, inst, "dataPinsStr");
        if (pins.includes(inst.strobePin)) validation.logError("strobePin must not overlap dataPins", inst, "strobePin");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, BASE, WIDTH, MASK, STROBE_PIN, STROBE_POL_INV, SETUP, HOLD, VAL, IS_READ, DATA_REG`,
            `    .if IS_READ == 1`,
            `    .if STROBE_POL_INV == 1`,
            `    clr   R30, R30, STROBE_PIN`,
            `    .else`,
            `    set   R30, R30, STROBE_PIN`,
            `    .endif`,
            `    .if SETUP > 0`,
            `    ldi32 TEMP_REG1, SETUP`,
            `pb_s?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pb_s?, TEMP_REG1, 0`,
            `    .endif`,
            `    ldi32 TEMP_REG2, MASK`,
            `    ; Reduce in a full register, then move the low byte`,
            `    ; to RES (the allocator-sized output, often a .b piece). The`,
            `    ; old code wrote DATA_REG (a config string, not the output),`,
            `    ; so chained blocks read a stale register. DATA_REG is now`,
            `    ; unused (kept so existing instances still assemble). Buses wider than`,
            `    ; 8 bits store their low byte; widen output1Size for more.`,
            `    and   TEMP_REG3, R31, TEMP_REG2`,
            `    lsr   TEMP_REG3, TEMP_REG3, BASE`,
            `    and   RES, TEMP_REG3, 255`,
            `    .if HOLD > 0`,
            `    ldi32 TEMP_REG1, HOLD`,
            `pb_h?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pb_h?, TEMP_REG1, 0`,
            `    .endif`,
            `    .if STROBE_POL_INV == 1`,
            `    set   R30, R30, STROBE_PIN`,
            `    .else`,
            `    clr   R30, R30, STROBE_PIN`,
            `    .endif`,
            `    .else`,
            `    ldi32 TEMP_REG1, MASK`,
            `    not   TEMP_REG2, TEMP_REG1`,
            `    and   R30, R30, TEMP_REG2`,
            `    ldi32 TEMP_REG1, VAL`,
            `    lsl   TEMP_REG1, TEMP_REG1, BASE`,
            `    or    R30, R30, TEMP_REG1`,
            `    .if STROBE_POL_INV == 1`,
            `    set   R30, R30, STROBE_PIN`,
            `    .else`,
            `    clr   R30, R30, STROBE_PIN`,
            `    .endif`,
            `    .if SETUP > 0`,
            `    ldi32 TEMP_REG1, SETUP`,
            `pb_ws?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pb_ws?, TEMP_REG1, 0`,
            `    .endif`,
            `    .if STROBE_POL_INV == 1`,
            `    clr   R30, R30, STROBE_PIN`,
            `    .else`,
            `    set   R30, R30, STROBE_PIN`,
            `    .endif`,
            `    .if HOLD > 0`,
            `    ldi32 TEMP_REG1, HOLD`,
            `pb_wh?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  pb_wh?, TEMP_REG1, 0`,
            `    .endif`,
            `    .if STROBE_POL_INV == 1`,
            `    set   R30, R30, STROBE_PIN`,
            `    .else`,
            `    clr   R30, R30, STROBE_PIN`,
            `    .endif`,
            `    .endif`,
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
            if (inst.strobePin !== undefined) pins.push({ pin: parseInt(inst.strobePin), dir: "GPO" });
            if (inst.dataPinsStr) {
                String(inst.dataPinsStr).split(',').forEach(p => {
                    if (p.trim()) pins.push({ pin: parseInt(p.trim()), dir: inst.direction === "read" ? "GPI" : "GPO" });
                });
            }
            return pins;
        }
    ,
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = parallelBusModule;
