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

const hallModule = {
    displayName: "Hall commutation decoder",
    defaultInstanceName: `${PRU_USED}_HALL_INSTANCE_`,
    description: "3-phase Hall sensor commutation decoder with sector LUT, IEP speed, illegal trap.",
    longDescription: `Hall commutation decoder for 3-phase BLDC motors.\n\nSix-entry sector LUT: Hall code (A<<2|B<<1|C) maps 001->0, 011->1, 010->2, 110->3, 100->4, 101->5; 000 and 111 are illegal and trap.\nIEP edge timestamp for speed: on each sector edge the IEP counter (c26, 0x10) is sampled via LBCO and the delta from the previous edge is written to VEL_REG.\nIllegal-state trap: 000/111 sets FAULT_REG=1, SECTOR_REG=0xFFFFFFFF and does NOT interpolate; uses only TEMP_REG1 and TEMP_REG2 (2-TEMP_REG pattern).`,
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "aBit", displayName: "Hall A R31 Pin", default: "0", options: GPIO_SIGNALS },
        { name: "bBit", displayName: "Hall B R31 Pin", default: "1", options: GPIO_SIGNALS },
        { name: "cBit", displayName: "Hall C R31 Pin", default: "2", options: GPIO_SIGNALS },
        { name: "sampleCycles", displayName: "Sample Delay Trips", default: 10 },

        { name: "sectorRegister", displayName: "Sector Register (32-bit)", default: "R4" },
        { name: "velRegister", displayName: "Velocity Register (IEP Delta)", default: "R5" },
        { name: "faultRegister", displayName: "Fault Register (0=ok,1=illegal)", default: "R6" },

        { name: "opCode", default: "m_hall_decode", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.aBit },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.bBit },
        { name: "constant3", hidden: true, default: "", getValue: (inst) => inst.cBit },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.sectorRegister },
        { name: "constant5", hidden: true, default: "", getValue: (inst) => inst.velRegister },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => inst.faultRegister },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.sampleCycles },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 },
        { name: "blockMaturity", displayName: "Block Maturity", default: "metadata-only", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true }
    ],

    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" }
        ];
    },

    validate(inst, validation) {
        if (inst.aBit === inst.bBit || inst.aBit === inst.cBit || inst.bBit === inst.cBit) {
            validation.logError("aBit, bBit, and cBit must differ", inst, "aBit");
        }
        if (inst.sampleCycles < 1) validation.logError("sampleCycles must be >= 1", inst, "sampleCycles");
        if (inst.sectorRegister === inst.velRegister || inst.sectorRegister === inst.faultRegister || inst.velRegister === inst.faultRegister) {
            validation.logError("sector, velocity and fault registers must differ", inst, "sectorRegister");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, A_BIT, B_BIT, C_BIT, SECTOR_REG, VEL_REG, FAULT_REG, SAMPLE_TRIPS`,
            `    ; Hall init - use only TEMP_REG1 and TEMP_REG2 (2-TEMP_REG pattern)`,
            `    ldi32 FAULT_REG, 0`,
            `    ldi32 VEL_REG, 0`,
            `    ldi32 TEMP_REG1, 0               ; prev IEP timestamp`,
            `    ldi32 TEMP_REG2, 0               ; bit0..2 code temp, sector temp in b1`,
            `    ldi32 SECTOR_REG, 0xffffffff     ; invalid until first legal sector`,
            `hall_loop?:`,
            `    ; ----- build 3-bit Hall code (A<<2|B<<1|C) into TEMP_REG2.b0 -----`,
            `    ldi TEMP_REG2.b0, 0`,
            `    qbbs hall_a1?, R31, A_BIT`,
            `    qba hall_b?`,
            `hall_a1?:`,
            `    or TEMP_REG2.b0, TEMP_REG2.b0, 4`,
            `hall_b?:`,
            `    qbbs hall_b1?, R31, B_BIT`,
            `    qba hall_c?`,
            `hall_b1?:`,
            `    or TEMP_REG2.b0, TEMP_REG2.b0, 2`,
            `hall_c?:`,
            `    qbbs hall_c1?, R31, C_BIT`,
            `    qba hall_lut?`,
            `hall_c1?:`,
            `    or TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `hall_lut?:`,
            `    ; ----- six-entry sector LUT + illegal trap -----`,
            `    qbeq hall_fault?, TEMP_REG2.b0, 0`,
            `    qbeq hall_fault?, TEMP_REG2.b0, 7`,
            `    qbeq hall_s0?, TEMP_REG2.b0, 1`,
            `    qbeq hall_s1?, TEMP_REG2.b0, 3`,
            `    qbeq hall_s2?, TEMP_REG2.b0, 2`,
            `    qbeq hall_s3?, TEMP_REG2.b0, 6`,
            `    qbeq hall_s4?, TEMP_REG2.b0, 4`,
            `    qbeq hall_s5?, TEMP_REG2.b0, 5`,
            `    qba hall_fault?`,
            `hall_s0?:`,
            `    ldi TEMP_REG2.b1, 0`,
            `    qba hall_edge?`,
            `hall_s1?:`,
            `    ldi TEMP_REG2.b1, 1`,
            `    qba hall_edge?`,
            `hall_s2?:`,
            `    ldi TEMP_REG2.b1, 2`,
            `    qba hall_edge?`,
            `hall_s3?:`,
            `    ldi TEMP_REG2.b1, 3`,
            `    qba hall_edge?`,
            `hall_s4?:`,
            `    ldi TEMP_REG2.b1, 4`,
            `    qba hall_edge?`,
            `hall_s5?:`,
            `    ldi TEMP_REG2.b1, 5`,
            `hall_edge?:`,
            `    ; ----- edge detection: compare current sector (TEMP_REG2.b1) with SECTOR_REG -----`,
            `    qbeq hall_delay?, TEMP_REG2.b1, SECTOR_REG`,
            `    ; ----- IEP edge timestamp for speed (c26, 0x10) via R10 spill -----`,
            `    mov R10.b0, TEMP_REG2.b1`,
            `    mov TEMP_REG2, TEMP_REG1`,
            `    lbco &TEMP_REG1, c26, 0x10, 4`,
            `    sub VEL_REG, TEMP_REG1, TEMP_REG2`,
            `    mov SECTOR_REG, R10.b0`,
            `    qba hall_delay?`,
            `hall_fault?:`,
            `    ; ----- illegal-state trap: do NOT interpolate -----`,
            `    ldi32 SECTOR_REG, 0xffffffff`,
            `    ldi FAULT_REG, 1`,
            `    ; hold fault - do not update velocity on illegal`,
            `hall_delay?:`,
            `    ldi TEMP_REG2.w0, SAMPLE_TRIPS`,
            `hall_dl?:`,
            `    sub TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    qbne hall_dl?, TEMP_REG2.w0, 0`,
            `    qba hall_loop?`,
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
            for (const k of ["aBit", "bBit", "cBit"]) {
                if (inst[k] !== undefined) pins.push({ pin: parseInt(inst[k]), dir: "GPI" });
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

exports = hallModule;
