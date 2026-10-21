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

const encoderSpeedModule = {
    displayName: "Encoder Speed (IEP)",
    defaultInstanceName: `${PRU_USED}_ENCODER_SPEED_INSTANCE_`,
    description: "PRU quadrature encoder speed measurement.",
    longDescription: "Emits parameterized speed, position and direction decoder loop in PRU assembly.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "aBit", displayName: "A input R31 pin", default: "3", options: GPIO_SIGNALS },
        { name: "bBit", displayName: "B input R31 pin", default: "4", options: GPIO_SIGNALS },
        { name: "velocityMethod", displayName: "Velocity Method", default: "iep", options: [{name:"iep"}, {name:"pulse-count"}] },
        
        { name: "posRegister", displayName: "Position Register (32-bit)", default: "R4" },
        { name: "velRegister", displayName: "Velocity Register (32-bit)", default: "R5" },
        { name: "dirRegister", displayName: "Direction Register (32-bit)", default: "R8" },

        { name: "opCode", default: "m_encoder_speed_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 6, hidden: true },
        
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.aBit },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.bBit },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => inst.velocityMethod === 'iep' ? 1 : 0 },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.posRegister },
        { name: "constant5", hidden: true, default: "", getValue: (inst) => inst.velRegister },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => inst.dirRegister },
        
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 }
    ],

    ports: (inst) => { 
        return [
            { name: "prev", type: "IO_PREV" }
        ];
    },

    validate(inst, validation) {
        if (inst.aBit === inst.bBit) validation.logError("aBit and bBit must differ", inst, "aBit");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, A_BIT, B_BIT, IS_IEP, POS_REG, VEL_REG, DIR_REG`,
            `    zero  &POS_REG, 4`,
            `    zero  &VEL_REG, 4`,
            `    zero  &DIR_REG, 4`,
            `    ldi32 TEMP_REG1, 0`,
            `    qbbs  es_ia?, R31, A_BIT`,
            `    ldi TEMP_REG2.w0, 0`,
            `    qba   es_ib?`,
            `es_ia?:`,
            `    ldi TEMP_REG2.w0, 2`,
            `es_ib?:`,
            `    qbbc  es_l?, R31, B_BIT`,
            `    add   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `es_l?:`,
            `    ldi TEMP_REG2.w2, 0`,
            `    qbbc  es_rb?, R31, A_BIT`,
            `    ldi TEMP_REG2.w2, 2`,
            `es_rb?:`,
            `    qbbc  es_hs?, R31, B_BIT`,
            `    add   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `es_hs?:`,
            `    qbeq  es_sd?, TEMP_REG2.w2, TEMP_REG2.w0`,
            `    .if IS_IEP == 1`,
            `    lbco  &TEMP_REG3, c26, 0x10, 4`,
            `    sub   VEL_REG, TEMP_REG3, TEMP_REG1`,
            `    mov   TEMP_REG1, TEMP_REG3`,
            `    .endif`,
            `    lsl   TEMP_REG4, TEMP_REG2.w0, 2`,
            `    or    TEMP_REG4, TEMP_REG4, TEMP_REG2.w2`,
            `    qbeq  es_fw?, TEMP_REG4, 1`,
            `    qbeq  es_fw?, TEMP_REG4, 7`,
            `    qbeq  es_fw?, TEMP_REG4, 14`,
            `    qbeq  es_fw?, TEMP_REG4, 8`,
            `    qbeq  es_rv?, TEMP_REG4, 2`,
            `    qbeq  es_rv?, TEMP_REG4, 11`,
            `    qbeq  es_rv?, TEMP_REG4, 13`,
            `    qbeq  es_rv?, TEMP_REG4, 4`,
            `    qba   es_ul?`,
            `es_fw?:`,
            `    add   POS_REG, POS_REG, 1`,
            `    ldi32 DIR_REG, 1`,
            `    qba   es_ul?`,
            `es_rv?:`,
            `    sub   POS_REG, POS_REG, 1`,
            `    ldi32 DIR_REG, 0xffffffff`,
            `es_ul?:`,
            `    mov   TEMP_REG2.w0, TEMP_REG2.w2`,
            `es_sd?:`,
            `    ldi TEMP_REG2.w2, 10`,
            `es_dl?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  es_dl?, TEMP_REG2.w2, 0`,
            `    qba   es_l?`,
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
            pins.push({ pin: parseInt(inst.aBit), dir: "GPI" });
            pins.push({ pin: parseInt(inst.bBit), dir: "GPI" });
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

exports = encoderSpeedModule;
