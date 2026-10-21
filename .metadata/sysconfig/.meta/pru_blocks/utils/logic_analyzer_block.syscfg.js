function validate(inst, report) {
    if (inst.sampleRateHz <= 0) report.logError("sampleRateHz must be > 0", inst, "sampleRateHz");
    if (inst.clkHz <= 0) report.logError("clkHz must be > 0", inst, "clkHz");
    if (inst.bufferSize <= 0 || (inst.bufferSize & (inst.bufferSize - 1)) !== 0) {
        report.logError("bufferSize must be a positive power of two", inst, "bufferSize");
    }
    if (inst.triggerPin < 0 || inst.triggerPin > 31) report.logError("triggerPin must be 0..31", inst, "triggerPin");
}

function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const res = parts[1] || "RES";
    const periodCycles = parts[2] || "periodCycles";
    const bufferSize = parts[3] || "bufferSize";
    const triggerPin = parts[4] || "triggerPin";
    const triggerSlope = parts[5] || "triggerSlope";

    if(pruInstructionMacro == "") {
        macroBody = macroName + "	.macro " + res + ", " + periodCycles + ", " + bufferSize + ", " + triggerPin + ", " + triggerSlope + "\n";
        macroBody += `    ; Parameters: periodCycles, bufferSize, triggerPin, triggerSlope(0=none,1=rising,2=falling)\n`;
    }

    macroBody += `
    .asg c28, CONST_SHARED_RAM          ; c28 = CTPPR0.C28_POINTER << 8 (reset 0 = own DMEM); the static module sets it to shared RAM 0x10000 at startup

    .if (${triggerSlope} == 1) ; rising
wait_trigger_low?:
    qbbs  wait_trigger_low?, R31, ${triggerPin}
wait_trigger_high?:
    qbbc  wait_trigger_high?, R31, ${triggerPin}
    .endif

    .if (${triggerSlope} == 2) ; falling
wait_trigger_high?:
    qbbc  wait_trigger_high?, R31, ${triggerPin}
wait_trigger_low?:
    qbbs  wait_trigger_low?, R31, ${triggerPin}
    .endif

    ; Start sampling into shared RAM buffer
    ldi   R10, ${bufferSize}              ; Samples counter
    ldi   R2, 0                         ; Offset index in buffer (bytes)

sample_loop?:
    ; Read R31 pins
    mov   R0, R31                       ; Capture entire register state

    ; Write sample to Shared RAM buffer
    sbco  &R0, CONST_SHARED_RAM, R2, 4  ; Write 32-bit sample
    add   R2, R2, 4                     ; Increment write offset

    ; Sample period timing delay
    ldi   R6, ${periodCycles}
delay_loop?:
    sub   R6, R6, 1
    qbne  delay_loop?, R6, 0

    sub   R10, R10, 1
    qbne  sample_loop?, R10, 0
`;

    if(pruInstructionMacro == "") {
        macroBody += "\n    .endm\n";
    }
    return macroBody;
}

exports = {
    displayName: "Logic Analyzer",
    defaultInstanceName: "LogicAnalyzer_",
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "sampleRateHz", displayName: "Sample Rate (Hz)", default: 10000000 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },
        { name: "bufferSize", displayName: "Buffer Size (samples)", default: 1024 },
        { name: "triggerPin", displayName: "Trigger R31 pin", default: 0 },
        { name: "triggerSlope", displayName: "Trigger Slope", default: "rising", options: [
            {name: "none"}, {name: "rising"}, {name: "falling"}
        ]},

        { name: "constant1", hidden: true, default: "7", getValue: (inst) => {
            // Between successive samples: 7 fixed cycles plus 2 per delay trip.
            return Math.max(1, Math.round((inst.clkHz / inst.sampleRateHz - 7) / 2)) + "";
        }},
        { name: "constant2", hidden: true, default: "1024", getValue: (inst) => inst.bufferSize + "" },
        { name: "constant3", hidden: true, default: "0", getValue: (inst) => inst.triggerPin + "" },
        { name: "constant4", hidden: true, default: "1", getValue: (inst) => {
            if (inst.triggerSlope === "none") return "0";
            if (inst.triggerSlope === "rising") return "1";
            return "2";
        }},

        { name: "numOfConstants", hidden: true, default: 4 },
        { name: "opCode", hidden: true, default: "m_logic_analyzer_block" },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0 },
        { name: "noOfCycles", hidden: true, default: 1024 }
    ],
    ports: (inst) => [
        { name: "prev", type: "PREV" },
        { name: "next", type: "NEXT" }
    ],
    validate,
    getMacro,
    templates: { "/pru_blocks/common/pru_syscfg.asm.xdt": null },
    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            if (inst.triggerSlope !== "none") pins.push({ pin: parseInt(inst.triggerPin), dir: "GPI" });   // R31 read only under slope 1/2
            return pins;
        },
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    }
};
