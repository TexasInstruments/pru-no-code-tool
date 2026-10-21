"use strict";

const appHostModule = {
    displayName: "Application Host (R5F)",
    defaultInstanceName: "R5F_HOST_APP_",
    description: "Generates R5F host code to load PRU firmware and handle IPC.",
    longDescription: "Creates a main.c for the R5F core that initializes the Sciclient, loads PRU firmware, and reads shared memory for encoder positions.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "enableSciclient", displayName: "Initialize Sciclient", default: true },
        { name: "enableIpcNotify", displayName: "Initialize IPC Notify", default: true },
        { name: "pru0FirmwareName", displayName: "PRU0 Firmware Array", default: "TXPRU0Firmware_0" },
        { name: "pru1FirmwareName", displayName: "PRU1 Firmware Array", default: "TXPRU1Firmware_0" },

        { name: "opCode", default: "m_host_app_none", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 0, hidden: true },
        
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 0, default: 0 }
    ],

    ports: (inst) => { 
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    getMacro(pruInstructionMacro, opCode) {
        return ""; // Host block does not emit PRU firmware instructions
    },

    templates: {
        "/pru_blocks/application_specific/r5f_main.c.xdt": "/r5f_main.c",
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

exports = appHostModule;
