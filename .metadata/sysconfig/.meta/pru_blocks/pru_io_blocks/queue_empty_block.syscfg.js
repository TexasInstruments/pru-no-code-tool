"use strict";

/*
 * queue_empty_block.syscfg.js - ICSSG broadside QUEUE_EMPTY status query.
 *
 * TRM reference: SPRUIM2J 6.4 "Functional Description", Table 6-60 "Hardware
 * Module Broadside ID Mapping":
 *   - Hardware Module: QUEUE_EMPTY
 *   - Broadside ID: 0xF0 (decimal 240)
 *   - Access: Shared XIN only across all 6 PRU cores (PRU0/1, RTU_PRU0/1, TX_PRU0/1)
 *
 * The block executes a 1-cycle XIN against device 0xF0 to read the 32-bit queue
 * empty status word into the destination register allocated for output1.
 * Writing (XOUT) to device 0xF0 is forbidden by the hardware architecture and
 * rejected as a build/validation error.
 */

const common = system.getScript("/common");

function getCoreType() {
    let coreName = "";
    try {
        coreName = String(common.getSelfSysCfgCoreName() || "").toLowerCase();
    } catch (e) {
        return "PRU";
    }
    if (coreName.includes("rtu")) return "RTU_PRU";
    if (coreName.includes("tx")) return "TX_PRU";
    if (coreName.includes("pru")) return "PRU";
    return "PRU";
}

const OPERATIONS = ["query"];

function macroNameFor(op) {
    return "m_queue_empty";
}

function opCode(inst) {
    return "m_queue_empty";
}

function cycleCount() {
    // 1-cycle XIN 0xF0 (SPRUIM2J Table 6-60) into destination register
    return 1;
}

function validate(inst, report) {
    const op = inst.operation || "query";
    if (OPERATIONS.indexOf(op) < 0) {
        report.logError(
            "QUEUE_EMPTY operation must be 'query' (SPRUIM2J Table 6-60).",
            inst, "operation"
        );
        return;
    }
    if (inst.direction && inst.direction !== "xin") {
        report.logError(
            "QUEUE_EMPTY device 0xF0 is XIN-only (SPRUIM2J Table 6-60). Writing or XOUT is not supported on this device.",
            inst, "operation"
        );
    }
}

function macroLines(name) {
    return [
        "m_queue_empty .macro RES",
        "    ; ICSSG QUEUE_EMPTY status query (SPRUIM2J 6.4, Table 6-60 Broadside ID 0xF0).",
        "    ; 0xF0 is a shared XIN-only broadside device reachable from all six cores.",
        "    ; Reads the 32-bit queue empty status word directly into allocator destination register RES.",
        "    xin   240, &RES, 4",
        "    .endm"
    ].join("\n");
}

const queueEmptyModule = {
    displayName: "QUEUE_EMPTY (ICSSG Queue Status Query)",
    requiresWidget: ["queue_empty"],
    defaultInstanceName: "QUEUE_EMPTY_",
    description: "ICSSG broadside queue empty status query (XIN device 0xF0 / 240).",
    longDescription:
        "Queries queue empty status through the ICSSG QUEUE_EMPTY broadside unit " +
        "(SPRUIM2J 6.4, Table 6-60 Broadside ID 0xF0 / 240). Device 0xF0 is a shared " +
        "XIN-only hardware status interface reachable from all six cores (PRU0/1, RTU_PRU0/1, " +
        "TX_PRU0/1). It reads the 32-bit queue empty bitmask in 1 cycle into the allocated output " +
        "register. XOUT on device 0xF0 is not supported by hardware. ICSSG only (AM64x/AM243x); " +
        "absent on ICSSM (AM261x/AM263Px). Maturity is 'simulator-tested': simulated via " +
        "XIN device 0xF0 handling in scripts/simulator.js.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },

        { name: "operation", displayName: "Operation", default: "query", options: [
            { name: "query", displayName: "Query (XIN 0xF0)" }
        ] },

        { name: "opCode", hidden: true, default: "m_queue_empty", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4 },
        { name: "numOfConstants", hidden: true, default: 0 },
        { name: "registerClobbers", hidden: true, default: "[]", getValue: () => "[]" },
        { name: "noOfCycles", displayName: "Peak Cycles", default: 1, readOnly: true, getValue: cycleCount }
    ],

    ports: (inst) => [
        { name: "prev", type: "IO_PREV" },
        { name: "next", type: "IO_NEXT" },
        { name: "output1", type: "output32" }
    ],

    validate,

    getMacro(pruInstructionMacro, requestedOpCode) {
        return macroLines("m_queue_empty");
    },

    // Machine-readable metadata used by documentation and tests.
    deviceId: 0xF0,
    deviceIds: { query: 0xF0 },
    direction: "xin_only",
    registerClobbers: { query: [] },
    cycleBasis: {
        query: { peakCycles: 1, basis: "1-cycle XIN 0xF0 (Table 6-60) into output register" }
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null
    },

    moduleStatic: { modules: function() { return [{
        name: "pru_register_allocator_validator",
        moduleName: "/pru_blocks/common/pru_blocks_static_module"
    }]; } }
};

exports = queueEmptyModule;
