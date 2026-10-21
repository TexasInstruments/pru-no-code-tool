"use strict";

/*
 * ICSSG Broadside Stitch FIFO.
 *
 * This is NOT a software bit accumulator. It is a thin wrapper over the ICSSG's own 2-deep x 32-byte
 * broadside FIFO at device ID 0x08 (SPRUIM2J 6.4.11.2.3.7.5 "Broadside Stitch
 * FIFO", Table 6-134):
 *
 *   "A simple 2 deep by 32 Byte Wide broadside FIFO is attached to ID = 08 to
 *    enable the firmware to efficiently pack fragments into aligned data words."
 *
 *   XOUT 8, &R2, N   (N = 1..32) packs N bytes into the FIFO, LSB-justified.
 *   XIN  8, &R2, 32  reads 32 bytes back into R2:R9, LSB-justified (fewer
 *                    valid bytes than 32 still returns the whole window).
 *   R10[0] (R10.b0 bit 0) set + XOUT 8, &R10, 1  subtracts 4 bytes from wr_ptr
 *                    (rewind the last push).
 *   R10[1] (R10.b0 bit 1) set + XOUT 8, &R10, 1  resets rd_ptr and wr_ptr.
 *
 * Table 6-60: STITCH_FIFO64, ID 08, 2 copies, PRU1/0 ONLY - not RTU_PRU, not
 * TX_PRU. validate() below enforces that; the block must not be registered
 * into topModules_rtu_tx_pru (soc/pru_blocks_am243x.syscfg.js and
 * soc/pru_blocks_am64x.syscfg.js).
 *
 * R2:R9 and R10 are architectural, exactly like the BSWAP 0xA1/0xA2 windows in
 * bswap_block.syscfg.js: this block declares them via registerClobbers rather
 * than pre-reserving them in the allocator (pru_register_allocator.js), so a
 * design that holds a live value inside one of those windows across a stitch
 * FIFO op is rejected at build time by validateStitchFifoGlobal in
 * pru_blocks_static_module.syscfg.js - the same mechanism validateBswapGlobal
 * uses, sharing the fixedWindowClobberedRegisters() helper.
 *
 * "push" only ever writes R2 (not the whole R2:R9 window): this block feeds a
 * single 32-bit dataflow register as INPUT, so byteCount is bounded to 1-4 -
 * sending more would push whatever happens to be in R3-R9 (uninitialized by
 * this block) into the hardware FIFO. Repeated pushes are how fragments
 * narrower than 32 bytes are stitched together; "pop" then reads the full
 * 32-byte aligned window back in one XIN.
 *
 * Maturity: the TI pru-simulator has no model of device 0x08 (it is not one of
 * the SPAD/MAC/BSWAP banks scripts/simulator.js recognises), so this block
 * cannot claim simulator-tested or any label above it. The checks are static:
 * (a) every emitted macro assembles with clpru, including through
 * allocator-style two/three-register-operand calls; (b) the emitted text
 * contains exactly the four XFR forms above with device ID 8 and the
 * documented register ranges - asserted on the text in
 * scripts/sim/test_stitch_fifo.js; (c) the validator/palette/clobber
 * arms in the same file.
 */
const MODES = {
    push: {
        clobbers: [[2, 1]],
        label: "XOUT 8, &R2, N (push a fragment, N = 1..4 bytes, LSB-justified)"
    },
    pop: {
        clobbers: [[2, 8]],
        label: "XIN 8, &R2, 32 (read the 32-byte aligned window back into R2:R9)"
    },
    rewind: {
        clobbers: [[10, 1]],
        label: "R10.b0 bit0 set + XOUT 8, &R10, 1 (subtract 4 bytes from wr_ptr)"
    },
    reset: {
        clobbers: [[10, 1]],
        label: "R10.b0 bit1 set + XOUT 8, &R10, 1 (reset rd_ptr and wr_ptr)"
    }
};
const TRM_CITE = "SPRUIM2J 6.4.11.2.3.7.5 \"Broadside Stitch FIFO\", Table 6-134";
const CORE_CITE = "SPRUIM2J Table 6-60 (STITCH_FIFO64, ID 08, 2 copies, PRU1/0 ONLY)";

function getCoreType() {
    try {
        const common = system.getScript("/common");
        const coreName = common.getSelfSysCfgCoreName();
        if (coreName && coreName.includes("rtu")) return "RTU_PRU";
        if (coreName && coreName.includes("tx")) return "TX_PRU";
        if (coreName && coreName.includes("pru")) return "PRU";
    } catch (e) { /* unavailable in reduced test stubs */ }
    return "PRU";
}

function opName(inst) {
    return (inst && inst.operation) || "push";
}
function macroNameFor(op) {
    return "m_stitch_" + op;
}
function opCode(inst) {
    return macroNameFor(opName(inst));
}
function modeInfo(inst) {
    return MODES[opName(inst)] || MODES.push;
}
function byteCount(inst) {
    const bc = Number(inst && inst.byteCount);
    return Number.isInteger(bc) ? bc : 4;
}
function cycleCount(inst) {
    const op = opName(inst);
    // SPRUIM2J 6.4.6.2.5: "XFR (XIN/XOUT/XCHG) instructions operate in one
    // clock cycle." Each mode adds the dataflow MOV/LDI instructions the
    // allocator's independent RES/INPUT operands make necessary (same
    // accounting bswap_block.syscfg.js uses for its own dataflow MOV).
    if (op === "push") return 3;   // mov R2,INPUT + xout + mov RES,R2
    if (op === "pop") return 2;    // xin + mov RES,R2
    return 2;                      // rewind/reset: ldi R10.b0 + xout
}

function validate(inst, report) {
    const op = opName(inst);
    if (!MODES[op]) {
        report.logError(
            "Stitch FIFO operation '" + op + "' is not one of the ICSSG broadside forms (" + TRM_CITE + "). " +
            "Valid operations are " + Object.keys(MODES).join(", ") + ".", inst, "operation");
        return;
    }

    const core = getCoreType();
    if (core !== "PRU") {
        report.logError(
            "The Broadside Stitch FIFO (device ID 0x08) is reachable from PRU1/0 only (" + CORE_CITE +
            "); placed core is '" + core + "'.", inst, "operation");
    }

    if (op === "push") {
        const bc = byteCount(inst);
        if (!Number.isInteger(bc) || bc < 1 || bc > 4) {
            report.logError(
                "Push byte count must be 1-4. This block copies a single 32-bit INPUT register into R2 " +
                "before XOUT (" + TRM_CITE + " - hardware source window is R2:R9); requesting more than 4 " +
                "bytes would push uninitialized R3-R9 data into the FIFO.", inst, "byteCount");
        }
        if (!inst.input1 || inst.input1.length === 0) {
            report.logWarning("input1 port is not connected to an output port", inst, "input1");
        }
    } else if (inst.input1 && inst.input1.length > 0) {
        report.logWarning(
            "Stitch FIFO operation '" + op + "' does not consume a dataflow input (" + modeInfo(inst).label +
            "); input1 does not feed the operation and is used only for graph ordering.", inst, "input1");
    }
}

function macroLines(op, macroName) {
    macroName = macroName || macroNameFor(op);
    const sig = macroName + " .macro RES, INPUT, BYTECOUNT";
    if (op === "push") {
        return [
            sig,
            "    ; ICSSG Broadside Stitch FIFO push (" + TRM_CITE + ").",
            "    ; XOUT source window is fixed at R2 (architectural, like the BSWAP",
            "    ; 4_8/4_16 windows); INPUT is staged there before the transfer.",
            "    mov   R2, INPUT",
            "    xout  8, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "pop") {
        return [
            sig,
            "    ; ICSSG Broadside Stitch FIFO pop (" + TRM_CITE + ").",
            "    ; XIN always reads the full 32-byte window into R2:R9; RES is",
            "    ; loaded from R2 (the first word) so the block still has an output.",
            "    ; INPUT/BYTECOUNT are not used by this operation.",
            "    xin   8, &R2, 32",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "rewind") {
        return [
            sig,
            "    ; ICSSG Broadside Stitch FIFO rewind (" + TRM_CITE + ").",
            "    ; R10[0] (R10.b0 bit 0) subtracts 4 bytes from the current wr_ptr.",
            "    ; INPUT/BYTECOUNT are not used by this operation.",
            "    ldi   R10.b0, 1",
            "    xout  8, &R10, 1",
            "    mov   RES, R10",
            "    .endm"
        ].join("\n");
    }
    if (op === "reset") {
        return [
            sig,
            "    ; ICSSG Broadside Stitch FIFO reset (" + TRM_CITE + ").",
            "    ; R10[1] (R10.b0 bit 1) resets both rd_ptr and wr_ptr.",
            "    ; INPUT/BYTECOUNT are not used by this operation.",
            "    ldi   R10.b0, 2",
            "    xout  8, &R10, 1",
            "    mov   RES, R10",
            "    .endm"
        ].join("\n");
    }
    throw new Error("Unsupported stitch FIFO operation " + op);
}

const stitchFifoModule = {
    displayName: "Stitch FIFO (ICSSG Broadside)",
    requiresWidget: ["stitch_fifo"],
    defaultInstanceName: "STITCH_FIFO_",
    description: "Aligns fragmented streams via the ICSSG broadside Stitch FIFO (XOUT/XIN device ID 0x08).",
    longDescription:
        "Wraps the ICSSG 2-deep x 32-byte broadside FIFO at device ID 0x08 (" + TRM_CITE + "). " +
        "push (XOUT) packs 1-4 bytes of the block's INPUT into the FIFO LSB-justified; repeated pushes " +
        "stitch narrow fragments (SENT nibbles, Manchester symbols, DShot frames, ...) into the FIFO " +
        "without a software shift chain. pop (XIN) reads the 32-byte aligned window back into R2:R9. " +
        "rewind backs the write pointer off by 4 bytes; reset clears both pointers. " + CORE_CITE + ": " +
        "the block's own validate() rejects RTU_PRU and TX_PRU cores, and it is registered only into the " +
        "PRU-core module list, never topModules_rtu_tx_pru. R2:R9 and R10 are architectural windows, " +
        "declared via registerClobbers exactly as bswap_block.syscfg.js declares its fixed 0xA1/0xA2 " +
        "windows; a design that holds a live value in one of them across a stitch FIFO op is rejected at " +
        "build time. Maturity is 'assembles': the TI pru-simulator has no device model for ID 0x08, so " +
        "this block does not claim simulator-tested or higher; it is checked that every emitted macro " +
        "assembles with clpru and that the emitted text is exactly the documented XFR forms.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },
        { name: "operation", displayName: "Stitch FIFO operation", default: "push", options: [
            { name: "push", displayName: "push - XOUT fragment into FIFO (1-4 bytes)" },
            { name: "pop", displayName: "pop - XIN 32-byte aligned window back" },
            { name: "rewind", displayName: "rewind - back wr_ptr off by 4 bytes" },
            { name: "reset", displayName: "reset - clear rd_ptr and wr_ptr" }
        ] },
        { name: "byteCount", displayName: "Push byte count (1-4)", default: 4,
          description: "Only used when operation = push. Bytes of INPUT (LSB-justified) sent to the FIFO." },
        { name: "opCode", hidden: true, default: "m_stitch_push", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 1 },
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "numOfConstants", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4 },
        { name: "constant1", hidden: true, default: 4, getValue: byteCount },
        // Consumed by validateStitchFifoGlobal. push clobbers only R2 (this
        // block never writes more than one register's worth of real data);
        // pop clobbers the full R2:R9 window (XIN always fills all 8
        // registers); rewind/reset clobber R10.
        { name: "registerClobbers", hidden: true, default: "[]", getValue: (inst) => JSON.stringify(modeInfo(inst).clobbers) },
        { name: "noOfCycles", displayName: "Peak cycles", default: 3, readOnly: true, getValue: cycleCount }
    ],

    ports: function() {
        return [
            { name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" },
            { name: "input1", type: "input32" }, { name: "output1", type: "output32" }
        ];
    },
    validate,
    getMacro: function(pruInstructionMacro, requestedOpCode) {
        // Static validation supplies the complete allocator call, e.g.
        // "m_stitch_push R4, R5, 4". Its opcode is the first whitespace or
        // comma-delimited token, not the entire pre-comma fragment.
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const op = Object.keys(MODES).find((m) => macroNameFor(m) === name || m === name);
        if (!op) {
            throw new Error("Unsupported Stitch FIFO macro " + name);
        }
        return macroLines(op, name);
    },

    // Machine-readable metadata.
    modes: MODES,
    registerClobbers: Object.keys(MODES).reduce((out, key) => { out[key] = MODES[key].clobbers; return out; }, {}),
    deviceId: 0x08,
    cycleEvidence: {
        push: { peakCycles: 3, basis: "1-cycle XOUT (SPRUIM2J 6.4.6.2.5) plus the MOV staging INPUT into R2 and the MOV publishing R2 as the block output" },
        pop: { peakCycles: 2, basis: "1-cycle XIN (SPRUIM2J 6.4.6.2.5) plus the MOV that publishes R2 as the block output" },
        rewind: { peakCycles: 2, basis: "1-cycle XOUT (SPRUIM2J 6.4.6.2.5) plus the LDI that sets R10.b0 bit0" },
        reset: { peakCycles: 2, basis: "1-cycle XOUT (SPRUIM2J 6.4.6.2.5) plus the LDI that sets R10.b0 bit1" }
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

exports = stitchFifoModule;
