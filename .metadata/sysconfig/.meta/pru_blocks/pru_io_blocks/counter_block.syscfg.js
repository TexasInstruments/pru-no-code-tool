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

const counterModule = {
    displayName: "Transition Counter",
    defaultInstanceName: `${PRU_USED}_COUNTER_INSTANCE_`,
    description: "IEP-gated event transition counter.",
    longDescription: "Emits parameterized counter loop in PRU assembly.",
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

        { name: "inputPin", displayName: "Input R31 pin", default: "5", options: GPIO_SIGNALS },
        { name: "dataRegister", displayName: "Count Output Register (32-bit)", default: "R4" },
        { name: "gateMs", displayName: "Gate Duration (ms)", default: 100 },
        { name: "edgeType", displayName: "Edge to Count", default: "rising", options: [{name:"rising"}, {name:"falling"}, {name:"both"}] },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_counter_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 3, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.inputPin },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => Math.round((inst.gateMs * inst.clkHz) / 1000) },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => {
            if (inst.edgeType === 'rising') return 0;
            if (inst.edgeType === 'falling') return 1;
            return 2;
        }},

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
        if (inst.gateMs <= 0) validation.logError("gateMs must be > 0", inst, "gateMs");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, INPUT_PIN, GATE_COUNTS, EDGE_TYPE`,
            `    ldi32 TEMP_REG4, 0x0002E000`,
            `    ldi32 TEMP_REG1, 0x11`,
            `    sbbo  &TEMP_REG1, TEMP_REG4, 0, 4`,
            `    lbbo  &TEMP_REG1, TEMP_REG4, 0x10, 4`,
            `    ldi32 TEMP_REG2, GATE_COUNTS`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG2`,
            `    zero  &RES, 4`,
            `    qbbs  ct_ih?, R31, INPUT_PIN`,
            `ct_il?:`,
            `    lbbo  &TEMP_REG2, TEMP_REG4, 0x10, 4`,
            `    qbge  ct_ge?, TEMP_REG1, TEMP_REG2`,
            `    qbbc  ct_il?, R31, INPUT_PIN`,
            `    .if EDGE_TYPE != 1`,
            `    add   RES, RES, 1`,
            `    .endif`,
            `    qba   ct_ih?`,
            `ct_ih?:`,
            `    lbbo  &TEMP_REG2, TEMP_REG4, 0x10, 4`,
            `    qbge  ct_ge?, TEMP_REG1, TEMP_REG2`,
            `    qbbs  ct_ih?, R31, INPUT_PIN`,
            `    .if EDGE_TYPE != 0`,
            `    add   RES, RES, 1`,
            `    .endif`,
            `    qba   ct_il?`,
            `ct_ge?:`,
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
            pins.push({ pin: parseInt(inst.inputPin), dir: "GPI" });
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

exports = counterModule;
