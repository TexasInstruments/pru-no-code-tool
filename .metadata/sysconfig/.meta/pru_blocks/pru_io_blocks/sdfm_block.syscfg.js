"use strict";

const sdfmModule = {
    displayName: "SDFM (Sigma-Delta Filter Module)",
    defaultInstanceName: "SDFM_",
    description: "Sigma-Delta Filter Module for current sensing.",
    longDescription: "Interfaces with the SDFM peripheral to read phase currents for motor control loops.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "filterChannel", displayName: "Filter Channel", default: 0, options: [{name: 0}, {name: 1}, {name: 2}, {name: 3}] },
        { name: "osr", displayName: "Over Sampling Ratio (OSR)", default: 64 },

        { name: "opCode", default: "m_sdfm_read", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 1, hidden: true },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => inst.filterChannel },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 10, default: 10 },
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true }
    ],

    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "output1", type: "output32" }
        ];
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, CHANNEL`,
            `    ; --- SDFM Configurable MMIO Read ---`,
            `    ; Exact AM243x PRU-ICSSG SD register map is not available locally.`,
            `    ; This is a configurable MMIO read slice that computes offset from base.`,
            `    ; Assume base 0x0C080000, reading channel offset (CHANNEL * 4).`,
            `    ldi32 TEMP_REG1, 0x0C080000`,
            `    ldi   TEMP_REG2.w0, CHANNEL`,
            `    lsl   TEMP_REG2.w0, TEMP_REG2.w0, 2`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG2.w0`,
            `    lbbo  &RES, TEMP_REG1, 0, 4`,
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

exports = sdfmModule;
