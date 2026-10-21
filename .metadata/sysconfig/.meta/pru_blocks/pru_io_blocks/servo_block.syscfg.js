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

const cyc = (us, clkHz) => Math.round((us * clkHz) / 1e6);

const servoModule = {
    displayName: "RC Servo / ESC PWM",
    defaultInstanceName: `${PRU_USED}_SERVO_INSTANCE_`,
    description: "RC servo / analog-ESC PWM output.",
    longDescription: "Produces a single cycle-exact pulse and waits the remainder of the frame period.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "signalPin", displayName: "Signal R30 pin", default: "8", options: GPIO_SIGNALS },
        { name: "pulseUs", displayName: "Pulse width (us)", default: 1500 },
        { name: "frameUs", displayName: "Frame period (us)", default: 20000 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_servo_pulse", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 3, hidden: true },
        
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.signalPin },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => cyc(inst.pulseUs, inst.clkHz) },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => cyc(inst.frameUs - inst.pulseUs, inst.clkHz) },
        
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
        if (inst.pulseUs < 500 || inst.pulseUs > 2500) validation.logError("pulseUs must be 500..2500", inst, "pulseUs");
        if (inst.frameUs <= 0) validation.logError("frameUs must be > 0", inst, "frameUs");
        if (inst.pulseUs >= inst.frameUs) validation.logError("pulseUs must be < frameUs", inst, "pulseUs");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, PIN, HIGH_CYC, LOW_CYC`,
            `    set R30, R30, PIN`,
            `    ldi32 TEMP_REG1, HIGH_CYC`,
            `    lsr TEMP_REG1, TEMP_REG1, 1`,
            `svh?:`,
            `    sub TEMP_REG1, TEMP_REG1, 1`,
            `    qbne svh?, TEMP_REG1, 0`,
            `    clr R30, R30, PIN`,
            `    ldi32 TEMP_REG1, LOW_CYC`,
            `    lsr TEMP_REG1, TEMP_REG1, 1`,
            `svl?:`,
            `    sub TEMP_REG1, TEMP_REG1, 1`,
            `    qbne svl?, TEMP_REG1, 0`,
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

exports = servoModule;
