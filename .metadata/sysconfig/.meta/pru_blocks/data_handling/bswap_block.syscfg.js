"use strict";

/*
 * ICSSG Byte Swap (BSWAP) broadside unit.
 *
 * BSWAP is not a PRU opcode; it is a broadside peripheral reached with XIN.
 * Evidence: SPRUIM2J 6.4.6.2.7 and Table 6-95 (device IDs), Table 6-60
 * (6 copies: PRU1/0 + RTU_PRU1/0 + TX_PRU1/0).
 *
 *   160 (0xA0)  Byte Order Swap  - in place on ANY of R0-R29 (6.4.6.2.7.1)
 *   161 (0xA1)  4_8              - R2-R5  <-> R6-R9          (6.4.6.2.7.2)
 *   162 (0xA2)  4_16             - R2-R5  <-> R14-R17 and
 *                                  R6-R9  <-> R10-R13        (6.4.6.2.7.3)
 *
 * The 0xA0 span is chosen by the XIN start register and length, so the
 * dataflow value never has to be staged into a fixed register: this block
 * hands XIN the allocator's own register and reserves nothing.  0xA1 and
 * 0xA2 are the opposite - the windows are architectural and cannot move,
 * so those modes publish registerClobbers and a design that holds a live
 * value across them is REJECTED by validateBswapGlobal in
 * pru_blocks_static_module (not silently allocated around).
 */
const MODES = {
    word_swap: {
        id: 0xA0, bytes: 4, clobbers: [], fixedWindow: false,
        label: "0xA0 Byte Order Swap", trm: "SPRUIM2J 6.4.6.2.7.1"
    },
    swap_4_8: {
        // "must start at R2.b0 and cannot exceed R9" -> R2..R9 = 32 bytes.
        id: 0xA1, bytes: 32, clobbers: [[2, 4], [6, 4]], fixedWindow: true,
        label: "0xA1 4_8 (R2-R5 <-> R6-R9)", trm: "SPRUIM2J 6.4.6.2.7.2"
    },
    swap_4_16: {
        // "must start at R2.b0 and cannot exceed R17" -> R2..R17 = 64 bytes.
        id: 0xA2, bytes: 64, clobbers: [[2, 4], [6, 4], [10, 4], [14, 4]], fixedWindow: true,
        label: "0xA2 4_16 (R2-R5 <-> R14-R17, R6-R9 <-> R10-R13)", trm: "SPRUIM2J 6.4.6.2.7.3"
    }
};

// Modes that existed before the broadside redo.  They are refused by name
// rather than silently remapped: shipped software byte-lane MOVs
// whose halfword swap/rotate_left/rotate_right bodies were byte-for-byte
// identical, so a silent alias would preserve exactly that class of bug.
const REMOVED_MODES = {
    swap: "word_swap",
    rotate_left: null,
    rotate_right: null
};

function modeName(inst) {
    return (inst && inst.mode) || "word_swap";
}
function modeInfo(inst) {
    return MODES[modeName(inst)] || MODES.word_swap;
}
function macroNameFor(mode) {
    return "m_bswap_" + mode;
}
function opCode(inst) {
    return macroNameFor(modeName(inst));
}
function cycleCount() {
    // Table 6-95 gives the XIN itself as 1 cycle.  The second cycle is the
    // dataflow MOV that exists only because RES and INPUT are independent
    // allocator operands; it is counted rather than hidden.
    return 2;
}

function validate(inst, report) {
    const name = modeName(inst);
    if (!MODES[name]) {
        const hint = REMOVED_MODES[name] !== undefined
            ? (REMOVED_MODES[name]
                ? " Use '" + REMOVED_MODES[name] + "'."
                : " The ICSSG BSWAP unit has no rotate function (Table 6-95); build a rotate from shifts in a separate block.")
            : "";
        report.logError(
            "BSWAP mode '" + name + "' is not an ICSSG BSWAP function. Valid modes are " +
            Object.keys(MODES).join(", ") + "." + hint, inst, "mode");
        return;
    }
    if (inst.byteWidth !== undefined) {
        report.logError(
            "BSWAP no longer has a Width setting: the span is the XIN length, and 0xA1/0xA2 " +
            "operate on fixed register windows. Remove byteWidth and select a mode.", inst, "mode");
    }
    if (MODES[name].fixedWindow && inst.input1 && inst.input1.length > 0) {
        report.logWarning(
            "BSWAP mode '" + name + "' swaps a fixed register window in place (" + MODES[name].trm +
            "); input1 does not feed the operation and is used only for graph ordering.", inst, "input1");
    }
    if (!MODES[name].fixedWindow && (!inst.input1 || inst.input1.length === 0)) {
        report.logWarning("input1 port is not connected to an output port", inst);
    }
}

function macroLines(mode, macroName) {
    const info = MODES[mode];
    macroName = macroName || macroNameFor(mode);
    if (!info.fixedWindow) {
        return [
            macroName + " .macro RES, INPUT",
            "    ; ICSSG BSWAP " + info.label + " (" + info.trm + ", Table 6-95).",
            "    ; 0xA0 operates in place on any of R0-R29, so the swap is done on the",
            "    ; allocator's own output register and no fixed range is reserved.",
            "    mov   RES, INPUT",
            "    xin   " + info.id + ", &RES, " + info.bytes,
            "    .endm"
        ].join("\n");
    }
    return [
        macroName + " .macro RES, INPUT",
        "    ; ICSSG BSWAP " + info.label + " (" + info.trm + ", Table 6-95).",
        "    ; The window is architectural and swaps in place; INPUT does not feed it.",
        "    ; RES is loaded from R2 after the swap so the block still has an output.",
        "    xin   " + info.id + ", &R2, " + info.bytes,
        "    mov   RES, R2",
        "    .endm"
    ].join("\n");
}

const bswapModule = {
    displayName: "BSWAP (ICSSG Byte Swap)",
    requiresWidget: ["bswap"],
    defaultInstanceName: "BSWAP_",
    description: "Byte reordering through the ICSSG BSWAP broadside unit (XIN 0xA0/0xA1/0xA2).",
    longDescription:
        "Emits a real XIN against the ICSSG Byte Swap unit (SPRUIM2J 6.4.6.2.7, Table 6-95): " +
        "0xA0 flips byte order in place in the block's own register; 0xA1 swaps R2-R5 with R6-R9; " +
        "0xA2 swaps R2-R5 with R14-R17 and R6-R9 with R10-R13. The 0xA1/0xA2 windows are fixed, " +
        "so this block declares them in registerClobbers and a design holding a live value across " +
        "such a swap is rejected at build time. BSWAP is an ICSSG widget and is absent on ICSSM " +
        "(AM261x/AM263Px); there is no software fallback in this block - it is a hardware block " +
        "and requiresWidget says so. Maturity is 'assembles': the emitted macro is assembled by " +
        "clpru and executed against a TRM-derived XIN device model in scripts/simulator.js. That " +
        "model and this block were both written from SPRUIM2J, so the simulator arm is not an " +
        "independent oracle and cannot substitute for silicon validation.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },
        { name: "mode", displayName: "BSWAP function", default: "word_swap", options: [
            { name: "word_swap", displayName: "0xA0 byte order swap (in place, any register)" },
            { name: "swap_4_8", displayName: "0xA1 4_8 (R2-R5 <-> R6-R9)" },
            { name: "swap_4_16", displayName: "0xA2 4_16 (R2-R5 <-> R14-R17, R6-R9 <-> R10-R13)" }
        ] },
        { name: "opCode", hidden: true, default: "m_bswap_word_swap", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 1 },
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "numOfConstants", hidden: true, default: 0 },
        { name: "output1Size", hidden: true, default: 4 },
        // Consumed by validateBswapGlobal. Empty for 0xA0 by construction:
        // that mode has no fixed window, so declaring one would reserve
        // registers the hardware does not require.
        { name: "registerClobbers", hidden: true, default: "[]", getValue: (inst) => JSON.stringify(modeInfo(inst).clobbers) },
        { name: "noOfCycles", displayName: "Peak cycles", default: 2, readOnly: true, getValue: cycleCount }
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
        // "m_bswap_word_swap R4, R5".  Its opcode is the first whitespace or
        // comma-delimited token, not the entire pre-comma fragment.
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const mode = Object.keys(MODES).find((m) => macroNameFor(m) === name || m === name);
        if (!mode) {
            throw new Error("Unsupported BSWAP macro " + name);
        }
        return macroLines(mode, name);
    },

    // Machine-readable evidence.  Cycle counts are an instruction-count claim
    // plus the TRM's 1-cycle XIN, not a hardware benchmark.
    modes: MODES,
    registerClobbers: Object.keys(MODES).reduce((out, key) => { out[key] = MODES[key].clobbers; return out; }, {}),
    deviceIds: Object.keys(MODES).reduce((out, key) => { out[key] = MODES[key].id; return out; }, {}),
    cycleEvidence: {
        word_swap: { peakCycles: 2, basis: "1-cycle XIN 0xA0 (Table 6-95) plus the dataflow MOV into the output register" },
        swap_4_8: { peakCycles: 2, basis: "1-cycle XIN 0xA1 (Table 6-95) plus the MOV that publishes R2 as the block output" },
        swap_4_16: { peakCycles: 2, basis: "1-cycle XIN 0xA2 (Table 6-95) plus the MOV that publishes R2 as the block output" }
    },
    // Deliberate assertion, not an oversight: at 16-bit width a byte swap and
    // a single-byte rotate are the same permutation of two bytes, which is why
    // three halfword bodies were identical.  Rather than ship three
    // aliases the block exposes none: 0xA0 with a 2-byte XIN span covers it
    // (TRM 6.4.6.2.7.1 example 3: R2.b0 = R2.b3, R2.b1 = R2.b2).
    halfwordEquivalenceNote: "swap == rotate_left == rotate_right at 16-bit width; modes collapsed rather than aliased",

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null
    },
    moduleStatic: { modules: function() { return [{
        name: "pru_register_allocator_validator",
        moduleName: "/pru_blocks/common/pru_blocks_static_module"
    }]; } }
};

exports = bswapModule;
