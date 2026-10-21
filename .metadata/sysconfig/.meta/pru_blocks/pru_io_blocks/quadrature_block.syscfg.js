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

const quadratureModule = {
    displayName: "Quadrature encoder decoder",
    defaultInstanceName: `${PRU_USED}_QUAD_INSTANCE_`,
    description: "AB/ABZ quadrature decoder.",
    longDescription: "Emits a polling decoder with position and edge-count state in PRU registers.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "aBit", displayName: "A Input R31 Pin", default: "0", options: GPIO_SIGNALS },
        { name: "bBit", displayName: "B Input R31 Pin", default: "1", options: GPIO_SIGNALS },
        { name: "zBit", displayName: "Z Input R31 Pin", default: "2", options: GPIO_SIGNALS },
        { name: "useIndex", displayName: "Use Z Index", default: false },
        { name: "sampleCycles", displayName: "Sample Delay Trips", default: 10 },
        { name: "countMode", displayName: "Count Mode", default: "x4", options: [{name: "x1"}, {name: "x2"}, {name: "x4"}] },

        { name: "posRegister", displayName: "Position Register (32-bit)", default: "R4" },
        { name: "edgeRegister", displayName: "Edge Count Register (32-bit)", default: "R5" },

        { name: "opCode", default: "m_quadrature_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true }, /* continuous block */
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 8, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.aBit },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.bBit },
        { name: "constant3", hidden: true, default: "", getValue: (inst) => inst.zBit },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => inst.useIndex ? 1 : 0 },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.countMode === 'x4' ? 4 : (inst.countMode === 'x2' ? 2 : 1) },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => inst.sampleCycles },
        { name: "constant7", hidden: true, default: "", getValue: (inst) => inst.posRegister },
        { name: "constant8", hidden: true, default: "", getValue: (inst) => inst.edgeRegister },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 },
        { name: "blockMaturity", displayName: "Block Maturity", default: "dual-oracle-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true }
    ],

    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" }
        ];
    },

    validate(inst, validation) {
        if (inst.aBit === inst.bBit || inst.aBit === inst.zBit || inst.bBit === inst.zBit) {
            validation.logError("aBit, bBit, and zBit must differ", inst, "aBit");
        }
        if (inst.sampleCycles < 1) validation.logError("sampleCycles must be >= 1", inst, "sampleCycles");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, A_BIT, B_BIT, Z_BIT, USE_INDEX, COUNT_MODE, SAMPLE_TRIPS, POS_REG, EDGE_REG`,
            `    ldi32 POS_REG, 0`,
            `    ldi32 EDGE_REG, 0`,
            `    qbbs  qd_ia?, R31, A_BIT`,
            `    ldi32 TEMP_REG1, 0`,
            `    qba   qd_ib?`,
            `qd_ia?:`,
            `    ldi32 TEMP_REG1, 2`,
            `qd_ib?:`,
            `    qbbc  qd_l?, R31, B_BIT`,
            `    add   TEMP_REG1, TEMP_REG1, 1`,
            `qd_l?:`,
            `    ldi TEMP_REG2.w0, 0`,
            `    qbbc  qd_rb?, R31, A_BIT`,
            `    ldi TEMP_REG2.w0, 2`,
            `qd_rb?:`,
            `    qbbc  qd_hs?, R31, B_BIT`,
            `    add   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `qd_hs?:`,
            `    qbeq  qd_sd?, TEMP_REG2.w0, TEMP_REG1`,
            `    lsl   TEMP_REG2.w2, TEMP_REG1, 2`,
            `    or    TEMP_REG2.w2, TEMP_REG2.w2, TEMP_REG2.w0`,
            `    .if COUNT_MODE == 4`,
            `    .else`,
            `    .if COUNT_MODE == 2`,
            `    and   TEMP_REG2.b3, TEMP_REG2.w2, 1`,
            `    qbeq  qd_sd?, TEMP_REG2.b3, 0`,
            `    .else`,
            `    qbeq  qd_sd?, TEMP_REG2.w2, 1`,
            `    qbeq  qd_sd?, TEMP_REG2.w2, 2`,
            `    qbeq  qd_sd?, TEMP_REG2.w2, 3`,
            `    .endif`,
            `    .endif`,
            `    qbeq  qd_fw?, TEMP_REG2.w2, 1`,
            `    qbeq  qd_fw?, TEMP_REG2.w2, 7`,
            `    qbeq  qd_fw?, TEMP_REG2.w2, 14`,
            `    qbeq  qd_fw?, TEMP_REG2.w2, 8`,
            `    qbeq  qd_rv?, TEMP_REG2.w2, 2`,
            `    qbeq  qd_rv?, TEMP_REG2.w2, 11`,
            `    qbeq  qd_rv?, TEMP_REG2.w2, 13`,
            `    qbeq  qd_rv?, TEMP_REG2.w2, 4`,
            `    qba   qd_ul?`,
            `qd_fw?:`,
            `    add   POS_REG, POS_REG, 1`,
            `    add   EDGE_REG, EDGE_REG, 1`,
            `    qba   qd_ul?`,
            `qd_rv?:`,
            `    sub   POS_REG, POS_REG, 1`,
            `    add   EDGE_REG, EDGE_REG, 1`,
            `qd_ul?:`,
            `    mov   TEMP_REG1, TEMP_REG2.w0`,
            `qd_sd?:`,
            `    .if USE_INDEX == 1`,
            `    qbbc  qd_ni?, R31, Z_BIT`,
            `    ldi32 POS_REG, 0`,
            `qd_ni?:`,
            `    .endif`,
            `    ldi TEMP_REG2.w0, SAMPLE_TRIPS`,
            `qd_dl?:`,
            `    sub   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    qbne  qd_dl?, TEMP_REG2.w0, 0`,
            `    qba   qd_l?`,
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
            if (inst.useIndex) pins.push({ pin: parseInt(inst.zBit), dir: "GPI" });   // Z is read only under USE_INDEX == 1
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

exports = quadratureModule;
