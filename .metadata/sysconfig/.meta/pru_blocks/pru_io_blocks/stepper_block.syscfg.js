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

// Between rising STEP edges the macro executes 13 instructions outside its
// two delay loops.  Each loop costs 2 cycles per iteration and its count is
// halved (lsr 1), so the delay is 2*floor(H/2) + 2*floor((M-H)/2) for the
// high count H and total M.  H is therefore kept even, and M-H is even
// whenever M is, which loses a cycle only when M (= period - 13) is odd.
const STEPPER_LOOP_OVERHEAD_CYCLES = 13;
const MIN_STEPPER_PERIOD_CYCLES = STEPPER_LOOP_OVERHEAD_CYCLES + 4;

function requestedPeriodCycles(inst) {
    return Math.round(inst.clkHz / inst.maxSpeedSps);
}

function generatedDelayCycles(inst) {
    return requestedPeriodCycles(inst) - STEPPER_LOOP_OVERHEAD_CYCLES;
}

function generatedPulseHighCycles(inst) {
    return 2 * Math.floor(generatedDelayCycles(inst) / 4);
}

const stepperModule = {
    displayName: "Stepper Motor",
    defaultInstanceName: `${PRU_USED}_STEPPER_INSTANCE_`,
    description: "Stepper Motor Step/Dir driver.",
    longDescription: "Emits a parameterized STEP/DIR pulse train for a stepper motor. " +
        "The generated delay subtracts the macro's fixed 13-cycle per-step overhead, " +
        "so consecutive STEP rising edges equal round(clkHz / maxSpeedSps) with a " +
        "residual window of -1 to 0 PRU cycles: 0 when the rounded period is odd, " +
        "-1 when it is even (the two delay loops each count in 2-cycle steps). The minimum representable requested period is 17 PRU cycles " +
        "(maxSpeedSps <= clkHz / 17); this leaves at least one iteration in both " +
        "high and low delay loops.",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "stepPin", displayName: "Step R30 Pin", default: "5", options: GPIO_SIGNALS },
        { name: "dirPin", displayName: "Direction R30 Pin", default: "6", options: GPIO_SIGNALS },
        { name: "numSteps", displayName: "Target Steps", default: 1000 },
        { name: "profile", displayName: "Velocity Profile", default: "constant", options: [{name: "constant"}, {name: "linear"}] },
        { name: "maxSpeedSps", displayName: "Max Speed (steps/s)", default: 1000 },
        { name: "clkHz", displayName: "PRU Clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_stepper_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 5, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.stepPin },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.dirPin },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => inst.numSteps },
        { name: "constant4", hidden: true, default: 0, getValue: generatedDelayCycles },
        { name: "constant5", hidden: true, default: 0, getValue: generatedPulseHighCycles },

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
        if (inst.stepPin === inst.dirPin) validation.logError("stepPin and dirPin must differ", inst, "dirPin");
        if (inst.maxSpeedSps <= 0) validation.logError("maxSpeedSps must be > 0", inst, "maxSpeedSps");
        if (inst.maxSpeedSps > 0 && requestedPeriodCycles(inst) < MIN_STEPPER_PERIOD_CYCLES)
            validation.logError(`maxSpeedSps requires a period of at least ${MIN_STEPPER_PERIOD_CYCLES} PRU cycles (maxSpeedSps <= clkHz / ${MIN_STEPPER_PERIOD_CYCLES})`, inst, "maxSpeedSps");
        if (inst.numSteps <= 0) validation.logError("numSteps must be > 0", inst, "numSteps");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, STEP_PIN, DIR_PIN, STEPS, MIN_DELAY_CYCLES, PULSE_HIGH_CYCLES`,
            `    clr   R30, R30, STEP_PIN`,
            `    set   R30, R30, DIR_PIN`,
            `    ldi TEMP_REG2.w0, STEPS`,
            `st_l?:`,
            `    set   R30, R30, STEP_PIN`,
            `    ldi32 TEMP_REG1, PULSE_HIGH_CYCLES`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `st_h?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  st_h?, TEMP_REG1, 0`,
            `    clr   R30, R30, STEP_PIN`,
            `    ldi32 TEMP_REG1, MIN_DELAY_CYCLES`,
            `    ldi32 TEMP_REG3, PULSE_HIGH_CYCLES`,
            `    sub   TEMP_REG1, TEMP_REG1, TEMP_REG3`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `st_d?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  st_d?, TEMP_REG1, 0`,
            `    sub   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    qbne  st_l?, TEMP_REG2.w0, 0`,
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
            pins.push({ pin: parseInt(inst.stepPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dirPin), dir: "GPO" });
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

exports = stepperModule;
