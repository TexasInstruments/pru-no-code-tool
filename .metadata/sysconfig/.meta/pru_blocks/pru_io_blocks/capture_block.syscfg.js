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

const captureModule = {
    displayName: "Capture Timer",
    defaultInstanceName: `${PRU_USED}_CAPTURE_INSTANCE_`,
    description: "PRU High-Precision Timer/Capture.",
    longDescription: "Emits parameterized capture logic to measure pulse widths, frequencies, or time between edges.",
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

        { name: "measurementType", displayName: "Measurement Type", default: "pulseWidth", options: [{name:"pulseWidth"}, {name:"frequency"}, {name:"timeBetweenEdges"}] },
        { name: "triggerSource", displayName: "Trigger Source", default: "iep", options: [{name:"iep"}, {name:"gpio"}, {name:"internal"}] },
        { name: "pin", displayName: "Target Pin (R31)", default: "5", options: GPIO_SIGNALS },
        { name: "dataRegister", displayName: "Output Register (32-bit)", default: "R4" },
        { name: "clkHz", displayName: "PRU/IEP clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_capture_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 4, hidden: true },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => {
            if (inst.triggerSource === 'iep') return 0;
            if (inst.triggerSource === 'gpio') return 1;
            return 2;
        }},
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => {
            if (inst.measurementType === 'pulseWidth') return 0;
            if (inst.measurementType === 'frequency') return 1;
            return 2;
        }},
        { name: "constant3", hidden: true, default: "", getValue: (inst) => inst.pin },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.dataRegister },

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
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, TRIG_SRC, MEASURE_TYPE, PIN, DATA_REG`,
            `    .if TRIG_SRC == 0`,
            `    ; Enable IEP counter with DEFAULT_INC=1`,
            `    ldi32 TEMP_REG1, 0x11`,
            `    sbco  &TEMP_REG1, c26, 0x00, 4`,
            `    ldi32 TEMP_REG1, 1`,
            `    sbco  &TEMP_REG1, c26, 0x18, 4`,
            `cp_iw?:`,
            `    lbco  &TEMP_REG1, c26, 0x1C, 4`,
            `    qbbc  cp_iw?, TEMP_REG1, 0`,
            `    lbco  &DATA_REG, c26, 0x20, 4`,
            `    .else`,
            `    .if MEASURE_TYPE == 0`,
            `cp_pw_r?:`,
            `    qbbc  cp_pw_r?, R31, PIN`,
            `    zero  &DATA_REG, 4`,
            `cp_pw_l?:`,
            `    add   DATA_REG, DATA_REG, 1`,
            `    qbbs  cp_pw_l?, R31, PIN`,
            `    .else`,
            `    .if MEASURE_TYPE == 1`,
            `cp_fq_fr?:`,
            `    qbbc  cp_fq_fr?, R31, PIN`,
            `cp_fq_fa?:`,
            `    qbbs  cp_fq_fa?, R31, PIN`,
            `    zero  &DATA_REG, 4`,
            `cp_fq_p?:`,
            `    add   DATA_REG, DATA_REG, 1`,
            `    qbbc  cp_fq_p?, R31, PIN`,
            `    .else`,
            `    qbbs  cp_tb_ih?, R31, PIN`,
            `cp_tb_il?:`,
            `    qbbc  cp_tb_il?, R31, PIN`,
            `    zero  &DATA_REG, 4`,
            `cp_tb_wf?:`,
            `    add   DATA_REG, DATA_REG, 1`,
            `    qbbs  cp_tb_wf?, R31, PIN`,
            `    qba   cp_tb_d?`,
            `cp_tb_ih?:`,
            `    qbbs  cp_tb_ih?, R31, PIN`,
            `    zero  &DATA_REG, 4`,
            `cp_tb_wr?:`,
            `    add   DATA_REG, DATA_REG, 1`,
            `    qbbc  cp_tb_wr?, R31, PIN`,
            `cp_tb_d?:`,
            `    .endif`,
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
            if (inst.pin !== undefined && inst.triggerSource !== "iep") pins.push({ pin: parseInt(inst.pin), dir: "GPI" });
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

exports = captureModule;
