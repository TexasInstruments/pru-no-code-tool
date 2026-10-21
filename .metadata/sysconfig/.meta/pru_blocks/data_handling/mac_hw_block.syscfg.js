"use strict";

const macHwModule = {
    displayName: "MAC Hardware (Multiply-Accumulate)",
    requiresWidget: ["mac"],
    defaultInstanceName: "MAC_HW_",
    description: "Hardware Multiply-Accumulate using PRU MAC widget.",
    longDescription: "Utilizes the PRU's internal MAC hardware to perform fast multiplication and accumulation (A * B + C).",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "blockMaturity", displayName: "Block Maturity", default: "dual-oracle-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },

        { name: "opCode", default: "m_mac_hw", hidden: true },
        { name: "numOfInputPorts", default: 3, hidden: true }, // A, B, Accumulator
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 0, hidden: true },
        
        // Default generated macro evidence: 9 cycles (including the emitted HALT).
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 9, default: 9 }
    ],

    ports: (inst) => { 
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "input1", type: "input32" },
            { name: "input2", type: "input32" },
            { name: "input3", type: "input32" },
            { name: "output1", type: "output32" }
        ];
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, OP_A, OP_B, ACC_VAL`,
            `    ; --- MAC Hardware ---`,
            `    ; Configure MAC for multiply-only mode`,
            `    ldi32 R25, 0`,
            `    xout  0, &R25, 1`,
            `    ; Load operands to MAC input registers`,
            `    mov   R28, OP_A`,
            `    mov   R29, OP_B`,
            `    nop`,
            `    ; Read result (lower 32-bits from R26)`,
            `    xin   0, &TEMP_REG3, 4`,
            `    ; Accumulate`,
            `    add   RES, TEMP_REG3, ACC_VAL`,
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

exports = macHwModule;
