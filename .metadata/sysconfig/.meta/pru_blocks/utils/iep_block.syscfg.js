function validate(inst, report) {
    if (inst.clkHz <= 0) report.logError("clkHz must be > 0", inst, "clkHz");
    if (inst.periodNs <= 0) report.logError("periodNs must be > 0", inst, "periodNs");
    if (inst.cmpIndex < 0 || inst.cmpIndex > 15) report.logError("cmpIndex must be 0..15", inst, "cmpIndex");
    if (inst.func === 'periodic' && inst.cmpIndex !== 0) {
        report.logError("periodic auto-reset requires cmpIndex 0", inst, "cmpIndex");
    }
}

function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const res = parts[1] || "RES";
    const func = parts[2] || "func";
    const counts = parts[3] || "counts";
    const cmpIndex = parts[4] || "cmpIndex";
    const autoReset = parts[5] || "autoReset";

    if(pruInstructionMacro == "") {
        macroBody = macroName + "	.macro " + res + ", " + func + ", " + counts + ", " + cmpIndex + ", " + autoReset + "\n";
        macroBody += `    ; Parameters: func(0=periodic,1=oneshot,2=capture), counts, cmpIndex, autoReset\n`;
    }

    macroBody += `
    ; IEP register offsets: TRM SPRUIM2J 14.3.6.1.25.
    .asg 0x00, IEP_GLOBAL_CFG
    .asg 0x70, IEP_CMP_CFG
    .asg 0x74, IEP_CMP_STATUS
    .asg 0x78, IEP_CMP0
    .asg 0x11, INCR_1_ENABLE
    .asg c26, CONST_IEP
    
    .if (${func} != 2) ; Not capture
iep_init?:
    ldi   R0, INCR_1_ENABLE
    sbco  &R0, CONST_IEP, IEP_GLOBAL_CFG, 4
    ldi32 R2, ${counts}
    sbco  &R2, CONST_IEP, IEP_CMP0, 4
    
    .if (${func} == 0)
        .if (${autoReset} == 1)
            ldi   R0, 0x03 ; periodic CMP0 en+reset
        .else
            ldi   R0, 0x02 ; oneshot: CMP_EN[0] only (bit 0 is CMP0_RST_CNT_EN)
        .endif
    .else
        ldi   R0, 0x02 ; oneshot: CMP_EN[0] only (bit 0 is CMP0_RST_CNT_EN)
    .endif
    sbco  &R0, CONST_IEP, IEP_CMP_CFG, 4
    ldi   R0, 1
    sbco  &R0, CONST_IEP, IEP_CMP_STATUS, 4
    
iep_wait_cmp?:
wait_loop?:
    lbco  &R1, CONST_IEP, IEP_CMP_STATUS, 4
    qbbc  wait_loop?, R1, ${cmpIndex}
    ldi   R0, 1
    sbco  &R0, CONST_IEP, IEP_CMP_STATUS, 4
    .endif
`;

    if(pruInstructionMacro == "") {
        macroBody += "\n    .endm\n";	
    }
    return macroBody;
}

exports = {
    displayName: "IEP Timer",
    defaultInstanceName: "IEP_",
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "func", displayName: "Sub-function", default: "periodic", options: [
            {name: "periodic"}, {name: "oneshot"}, {name: "capture"}
        ]},
        { name: "clkHz", displayName: "IEP clock (Hz)", default: 200000000 },
        { name: "periodNs", displayName: "Period (ns)", default: 5000 },
        { name: "cmpIndex", displayName: "Compare index", default: 0 },
        { name: "autoReset", displayName: "CMP0 auto-reset", default: true },
        
        { name: "constant1", hidden: true, default: "0", getValue: (inst) => {
            if (inst.func === "periodic") return "0";
            if (inst.func === "oneshot") return "1";
            return "2";
        }},
        { name: "constant2", hidden: true, default: "1000", getValue: (inst) => {
            return Math.round((inst.periodNs * inst.clkHz) / 1e9) + "";
        }},
        { name: "constant3", hidden: true, default: "0", getValue: (inst) => inst.cmpIndex + "" },
        { name: "constant4", hidden: true, default: "1", getValue: (inst) => inst.autoReset ? "1" : "0" },
        
        { name: "numOfConstants", hidden: true, default: 4 },
        { name: "opCode", hidden: true, default: "m_iep_block" },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0 },
        { name: "noOfCycles", hidden: true, default: 10 }
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
