function validate(inst, report) {
    if (inst.inputEventBit < 0 || inst.inputEventBit > 31) {
        report.logError("inputEventBit must be 0..31", inst, "inputEventBit");
    }
    if (inst.outputEvent < 16 || inst.outputEvent > 31) {
        report.logError("outputEvent must be a system event 16..31 (SPRUIM2J Table 6-67: R31 event-generate channels 0..15)", inst, "outputEvent");
    }
}

function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const res = parts[1] || "RES";
    const mode = parts[2] || "mode";
    const inputEventBit = parts[3] || "inputEventBit";
    const outputEvent = parts[4] || "outputEvent";
    const clearAfterWait = parts[5] || "clearAfterWait";

    if(pruInstructionMacro == "") {
        macroBody = macroName + "	.macro " + res + ", " + mode + ", " + inputEventBit + ", " + outputEvent + ", " + clearAfterWait + "\n";
        macroBody += `    ; Parameters: mode, inputEventBit, outputEvent, clearAfterWait\n`;
    }

    macroBody += `
    .if (${mode} != 1) ; wait or waitThenSignal
event_wait?:
    qbbc  event_wait?, R31, ${inputEventBit}
    .if (${clearAfterWait} == 1)
    ; Clear/ack is SoC INTC-specific.
    ldi   R0, ${inputEventBit}
    .endif
    .endif
    .if (${mode} != 0) ; signal or waitThenSignal
    ldi   R31.b0, ${outputEvent} + 16
    .endif
`;

    if(pruInstructionMacro == "") {
        macroBody += "\n    .endm\n";
    }
    return macroBody;
}

exports = {
    displayName: "Event / Interrupt",
    defaultInstanceName: "Event_",
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "mode", displayName: "Mode", default: "wait", options: [
            {name: "wait"}, {name: "signal"}, {name: "waitThenSignal"}
        ]},
        { name: "inputEventBit", displayName: "Input Event R31 Bit", default: 30 },
        { name: "outputEvent", displayName: "Output System Event", default: 16 },
        { name: "clearAfterWait", displayName: "Clear Event After Wait", default: true },

        { name: "constant1", hidden: true, default: "0", getValue: (inst) => {
            if (inst.mode === "wait") return "0";
            if (inst.mode === "signal") return "1";
            return "2";
        }},
        { name: "constant2", hidden: true, default: "30", getValue: (inst) => inst.inputEventBit + "" },
        { name: "constant3", hidden: true, default: "16", getValue: (inst) => inst.outputEvent + "" },
        { name: "constant4", hidden: true, default: "1", getValue: (inst) => inst.clearAfterWait ? "1" : "0" },

        { name: "numOfConstants", hidden: true, default: 4 },
        { name: "opCode", hidden: true, default: "m_event_block" },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0 },
        { name: "noOfCycles", hidden: true, default: 3 }
    ],
    ports: (inst) => [
        { name: "prev", type: "PREV" },
        { name: "next", type: "NEXT" }
    ],
    validate,
    getMacro,
    templates: { "/pru_blocks/common/pru_syscfg.asm.xdt": null },
    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    }
};
