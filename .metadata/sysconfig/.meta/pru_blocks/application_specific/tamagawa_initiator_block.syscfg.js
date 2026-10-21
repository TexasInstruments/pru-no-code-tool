"use strict";

const tamagawaModule = {
    displayName: "Tamagawa Initiator",
    defaultInstanceName: "TAMAGAWA_INITIATOR_",
    description: "Tamagawa protocol initiator leveraging Motor Control SDK.",
    longDescription: "Interfaces with the Tamagawa encoder via PRU. Simulator only implements payload parsing tests due to UART NRZ timing constraints at 2.5 Mbps.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
		{
			name: "blockMaturity",
			displayName: "Block Maturity",
			default: "dual-oracle-tested",
			options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}],
			hidden: true
		},
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "baudRate", displayName: "Baud Rate", default: 2500000 },
        { name: "txPin", displayName: "TX Pin", default: 0 },
        { name: "rxPin", displayName: "RX Pin", default: 1 },
        { name: "dataId", displayName: "Data ID", default: 3 },

        { name: "opCode", default: "m_tamagawa_read", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true }, // Returns a 32-bit position value
        { name: "numOfConstants", default: 0, hidden: true },
        
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 500, default: 500 }
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
            `${opCode} .macro RES`,
            `    ; --- Tamagawa Payload Parsing Slice ---`,
            `    ; True 2.5 Mbps UART bit-banging cannot be simulated honestly here.`,
            `    ; Instead, we parse a deterministic response frame assumed loaded by PRU hardware.`,
            `    ; Data ID 0 Response: [CF, SF, ABS0, ABS1, ABS2, ENID, CRC]`,
            `    ; For simulator testing, we assume:`,
            `    ; TEMP_REG1 = [SF, ABS0, ABS1, ABS2] (bytes in Little-Endian layout)`,
            `    `,
            `    ; Extract Absolute Position (ABS0, ABS1, ABS2) from TEMP_REG1`,
            `    ; Shift right by 8 to drop SF, then mask to 24-bits`,
            `    lsr   RES, TEMP_REG1, 8`,
            `    ldi32 TEMP_REG2, 0x00FFFFFF`,
            `    and   RES, RES, TEMP_REG2`,
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

exports = tamagawaModule;
