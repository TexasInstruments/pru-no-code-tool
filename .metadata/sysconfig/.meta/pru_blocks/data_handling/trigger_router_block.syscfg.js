function validate(inst, report) {
    if (inst.route1 !== 255 && (inst.route1 < 0 || inst.route1 > 31)) report.logError("route1 must be 0..31 or 255", inst, "route1");
    if (inst.route2 !== 255 && (inst.route2 < 0 || inst.route2 > 31)) report.logError("route2 must be 0..31 or 255", inst, "route2");
    if (inst.route3 !== 255 && (inst.route3 < 0 || inst.route3 > 31)) report.logError("route3 must be 0..31 or 255", inst, "route3");
    if (inst.route4 !== 255 && (inst.route4 < 0 || inst.route4 > 31)) report.logError("route4 must be 0..31 or 255", inst, "route4");
}

function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const res = parts[1] || "RES";
    const route1 = parts[2] || "route1";
    const route2 = parts[3] || "route2";
    const route3 = parts[4] || "route3";
    const route4 = parts[5] || "route4";

    if(pruInstructionMacro == "") {
        macroBody = macroName + "	.macro " + res + ", " + route1 + ", " + route2 + ", " + route3 + ", " + route4 + "\n";
        macroBody += `    ; Parameters: route1..4 (255 means unused)\n`;
    }

    macroBody += `
trigger_router_loop?:
    .if (${route1} < 32)
    qbbc  no_route_1?, R31, ${route1}
    .if (route1 == 30)
    jal R29.w0, trigger_handler_30_start
    .elseif (route1 == 31)
    jal R29.w0, trigger_handler_31_start
    .endif
no_route_1?:
    .endif

    .if (${route2} < 32)
    qbbc  no_route_2?, R31, ${route2}
    .if (route2 == 30)
    jal R29.w0, trigger_handler_30_start
    .elseif (route2 == 31)
    jal R29.w0, trigger_handler_31_start
    .endif
no_route_2?:
    .endif

    .if (${route3} < 32)
    qbbc  no_route_3?, R31, ${route3}
    .if (route3 == 30)
    jal R29.w0, trigger_handler_30_start
    .elseif (route3 == 31)
    jal R29.w0, trigger_handler_31_start
    .endif
no_route_3?:
    .endif

    .if (${route4} < 32)
    qbbc  no_route_4?, R31, ${route4}
    .if (route4 == 30)
    jal R29.w0, trigger_handler_30_start
    .elseif (route4 == 31)
    jal R29.w0, trigger_handler_31_start
    .endif
no_route_4?:
    .endif

    ; Short delay between polling checks
    ldi   R0, 100
evaluation_delay?:
    sub   R0, R0, 1
    qbne  evaluation_delay?, R0, 0
    qba   trigger_router_loop?
`;

    if(pruInstructionMacro == "") {
        macroBody += "\n    .endm\n";
    }
    return macroBody;
}

exports = {
    displayName: "Trigger Event Router",
    defaultInstanceName: "TriggerRouter_",
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "route1", displayName: "Route 1 R31 Bit", default: 255 },
        { name: "route2", displayName: "Route 2 R31 Bit", default: 255 },
        { name: "route3", displayName: "Route 3 R31 Bit", default: 255 },
        { name: "route4", displayName: "Route 4 R31 Bit", default: 255 },

        { name: "constant1", hidden: true, default: "255", getValue: (inst) => inst.route1 + "" },
        { name: "constant2", hidden: true, default: "255", getValue: (inst) => inst.route2 + "" },
        { name: "constant3", hidden: true, default: "255", getValue: (inst) => inst.route3 + "" },
        { name: "constant4", hidden: true, default: "255", getValue: (inst) => inst.route4 + "" },

        { name: "numOfConstants", hidden: true, default: 4 },
        { name: "opCode", hidden: true, default: "m_trigger_router_block" },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0 },
        { name: "noOfCycles", hidden: true, default: 100 }
    ],
    ports: (inst) => [
        { name: "prev", type: "PREV" }
    ],
    validate,
    getMacro,
    templates: { "/pru_blocks/common/pru_syscfg.asm.xdt": null },
    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            [inst.route1, inst.route2, inst.route3, inst.route4].forEach(r => {
                if (parseInt(r) !== 255) pins.push({ pin: parseInt(r), dir: "GPI" });
            });
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
