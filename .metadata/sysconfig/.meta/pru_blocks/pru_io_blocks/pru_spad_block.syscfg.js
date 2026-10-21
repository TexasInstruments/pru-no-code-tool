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

const pruSpadModule = {
    displayName: "PRU<->PRU scratchpad (XFR)",
    defaultInstanceName: `${PRU_USED}_PRU_SPAD_INSTANCE_`,
    description: "A8 PRU<->PRU scratchpad (broadside XFR) block.",
    longDescription: "The PRU-ICSS scratchpad is 3 banks of 30 x 32-bit registers, shared by both PRU cores.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "role", displayName: "Role", default: "producer", options: [{name:"producer"}, {name:"consumer"}] },
        { name: "bank", displayName: "Scratchpad bank", default: 0, options: [{name:0}, {name:1}, {name:2}] },
        { name: "baseReg", displayName: "First transfer register (R#)", default: 5 },
        { name: "wordCount", displayName: "Data words (32-bit)", default: 4 },
        { name: "handshake", displayName: "Handshake", default: "seq", options: [{name:"none"}, {name:"seq"}] },
        { name: "signalEvent", displayName: "Signal peer PRU after xout", default: false },
        { name: "pruEvent", displayName: "PRU system event #", default: 18 },
        { name: "demoValue", displayName: "Producer demo payload word", default: 0 },

        { name: "opCode", default: "m_pru_spad_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => inst.role === 'producer' ? 1 : 0 },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => inst.handshake === 'seq' ? 1 : 0 },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => 10 + inst.bank },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => inst.baseReg },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => (inst.wordCount + (inst.handshake === 'seq' ? 1 : 0)) * 4 },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => inst.signalEvent ? (inst.pruEvent + 16) : 0 },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.demoValue },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 }
    ],

    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (inst.baseReg < 0 || inst.baseReg > 29) validation.logError("baseReg must be 0..29", inst, "baseReg");
        if (inst.wordCount < 1 || inst.wordCount > 30) validation.logError("wordCount must be 1..30", inst, "wordCount");
        if (inst.pruEvent < 16 || inst.pruEvent > 31) validation.logError("pruEvent must be a system event 16..31 (SPRUIM2J Table 6-67: event-generate channels 0..15)", inst, "pruEvent");
        const extra = inst.handshake === 'seq' ? 1 : 0;
        const totalWords = inst.wordCount + extra;
        const lastReg = inst.baseReg + totalWords - 1;
        if (totalWords > 30) validation.logError("transfer exceeds the 30-word scratchpad bank", inst, "wordCount");
        if (lastReg > 28) validation.logError("transfer window runs into reserved registers", inst, "baseReg");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, IS_PRODUCER, HAS_SEQ, BANK_DEV, BASE_REG, XFER_BYTES, SIGNAL_EVENT, DEMO_VAL`,
            `    .if IS_PRODUCER == 1`,
            `    ; Not fully macroizable dynamically because XOUT takes &Rn syntax natively.`,
            `    ; The register allocator must substitute this safely if required, but XFR handles &R# syntax.`,
            `    .endif`,
            `    .endm`
        ].join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = pruSpadModule;
