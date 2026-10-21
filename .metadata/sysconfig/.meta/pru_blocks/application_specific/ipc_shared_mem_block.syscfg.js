"use strict";

function validate(inst, report) {
    // VariableName is emitted as a .usect reservation label and referenced by the block macro; reject clpru reserved identifiers via the shared helper.
    if (typeof system !== "undefined" && system.getScript) {
        var reservedNames = system.getScript("/pru_blocks/common/pru_reserved_names.js");
        if (reservedNames && typeof reservedNames.validateSymbolField === "function") {
            reservedNames.validateSymbolField(inst, report, "variableName", "This symbol is emitted as a .usect reservation label and referenced by the block macro.");
        }
    }
}

const ipcSharedMemModule = {
    displayName: "IPC Shared Memory",
    defaultInstanceName: "IPC_SHMEM_",
    description: "Defines an IPC Shared Memory structure.",
    longDescription: "Creates a shared memory bridge for passing data between PRU and R5F Host.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "variableName", displayName: "Variable Name", default: "encoder_data" },
        { name: "memorySection", displayName: "Memory Section", default: "PRU_SHARED_RAM", options: [{name: "PRU_SHARED_RAM"}, {name: "PRU_DRAM_0"}, {name: "PRU_DRAM_1"}] },
        { name: "dataType", displayName: "Data Type", default: "uint32_t", options: [{name: "uint32_t"}, {name: "int32_t"}, {name: "float"}] },

        /*
         * A SysConfig design is scoped to ONE core context
         * (common.getSelfSysCfgCoreName()), and there is no API anywhere in
         * this tool that can read another core's design. So "is this region
         * also written by a different core?" is not derivable - it has to be
         * asserted, the same way xfr2psi_block makes the user assert
         * RTU_PRU_PSI_SHARE_EN for a register only the peer design can set.
         *
         * When this is true, validateXfr2spinGlobal requires a matched
         * XFR2SPIN acquire/release pair around this write. Left false, the
         * write is treated as single-writer and nothing is required - which is
         * also why the default is the SAFE-TO-UNDERSTATE direction: false
         * means "I claim only this core writes it".
         */
        { name: "crossCoreWriters", displayName: "Also written by another core", default: false,
          description: "Assert when a different PRU core (or the host) also WRITES this region. " +
                       "A cross-core write with no XFR2SPIN lock around it is a build error: the " +
                       "tool cannot see the peer core's design, so it cannot infer this." },

        { name: "opCode", default: "m_ipc_shmem_write", hidden: true },
        { name: "numOfInputPorts", default: 1, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "output1Size", default: 0, hidden: true },
        { name: "outputReg", default: "None", hidden: true },
        { name: "numOfConstants", default: 1, hidden: true },
        
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.variableName },
        
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 2, default: 2 }
    ],

    ports: (inst) => { 
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "input1", type: "input32" }
        ];
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro IN1, VAR_NAME`,
            `    ; Write to IPC shared memory variable`,
            `    ; Assuming VAR_NAME is allocated in the chosen memory section`,
            `    ; IN1 is allocator-sized (often a .b/.w piece); &IN1`,
            `    ; would store bytes IN1+1.. past the value. Copy through a`,
            `    ; full register so SBBO stores exactly the 4-byte value.`,
            `    mov   TEMP_REG3, IN1`,
            `    ldi32 TEMP_REG1, VAR_NAME`,
            `    sbbo  &TEMP_REG3, TEMP_REG1, 0, 4`,
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

    validate,
};

exports = ipcSharedMemModule;
