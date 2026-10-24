"use strict";
/*
 * pru_reserved_names.js — ONE shared clpru reserved-identifier list.
 *
 * A SysConfig instance name the assembler rejects must be a SysConfig
 * validation ERROR, not a build failure. Every block that emits its instance
 * name (or a name derived from it) as an assembly label or symbol calls into
 * this file from its validate(); the list lives HERE ONLY — do not copy it
 * into blocks.
 *
 * Checked against TI clpru 2.3.3: each name below, used as a data symbol
 * (`<name> .byte 1, 2, 3` in .initdmem — exactly what the CRC/LUT blocks emit)
 * and as a code label (`<name>:`), fails with [E0300] "<name> is a reserved
 * identifier". Names that assemble are not listed: SCAN, BROAD, IDLE, MULL, MUL, b4-b7,
 * w0-w7, assembler directives (byte/ushort/uint/usect/text/sect/global/...),
 * sp, pc, main, call, ret, TEMP_REG1 and ordinary names all assemble fine.
 *
 * Case (each claim checked with clpru 2.3.3, both as a data symbol and as
 * a code label): register names r0-r31/c0-c31
 * are case-insensitive (R5, C0 fail) — ANY case is rejected. Mnemonics are
 * rejected in exact-lowercase (add) and exact-ALL-UPPERCASE (ADD) only; a
 * mixed-case form (Add, Ldi32) ASSEMBLES and must be accepted, because a
 * name that assembles is not reserved. Byte lanes are
 * rejected lowercase only (b0 fails; B0 ASSEMBLES and is accepted).
 *
 * Loading: blocks reach this file through
 *   system.getScript("/pru_blocks/common/pru_reserved_names.js")
 * the same way pru_spi_* blocks share pru_spi_timing.js. It needs no
 * `system` object itself, so harnesses can load it for real in a bare vm.
 */

// PRU general-purpose registers R0-R31 and constant-table registers C0-C31.
var REGISTER_NAMES = [];
(function () {
    var i;
    for (i = 0; i < 32; i++) { REGISTER_NAMES.push("r" + i); }
    for (i = 0; i < 32; i++) { REGISTER_NAMES.push("c" + i); }
})();

// Byte-lane selectors the assembler reserves as identifiers (w0-w7 are NOT
// reserved — checked with clpru, they assemble — so only b0-b3 are listed).
var BYTE_LANE_NAMES = ["b0", "b1", "b2", "b3"];

// PRU instruction mnemonics clpru reserves (each checked lowercase and
// ALL-UPPERCASE; mixed-case forms assemble and are NOT rejected — see
// isReservedAsmName. SCAN/BROAD/IDLE/MULL/MUL assemble and are NOT listed).
var MNEMONIC_NAMES = [
    "add", "adc", "sub", "suc", "rsb", "rsc",
    "and", "or", "xor", "not", "min", "max", "clr", "set",
    "lsl", "lsr", "lmbd",
    "mov", "ldi", "ldi32", "lbbo", "sbbo", "lbco", "sbco", "zero", "fill",
    "mvib", "mviw", "mvid",
    "jmp", "jal",
    "qbgt", "qbge", "qblt", "qble", "qbeq", "qbne", "qba", "qbbc", "qbbs",
    "loop", "halt", "slp",
    "wbc", "wbs",
    "xin", "xout", "xchg", "sxin", "sxout", "sxchg", "nop"
];

var RESERVED_ASM_NAMES = REGISTER_NAMES.concat(BYTE_LANE_NAMES, MNEMONIC_NAMES);

var REGISTER_LOOKUP = {};
REGISTER_NAMES.forEach(function (n) { REGISTER_LOOKUP[n] = true; });

var BYTE_LANE_LOOKUP = {};
BYTE_LANE_NAMES.forEach(function (n) { BYTE_LANE_LOOKUP[n] = true; });

var MNEMONIC_LOOKUP = {};
var MNEMONIC_UPPER_LOOKUP = {};
MNEMONIC_NAMES.forEach(function (n) {
    MNEMONIC_LOOKUP[n] = true;
    MNEMONIC_UPPER_LOOKUP[n.toUpperCase()] = true;
});

/**
 * True when `name` is a clpru reserved identifier, using the assembler's own
 * case rules (see header): registers match case-insensitively; mnemonics
 * match the exact-lowercase or exact-ALL-UPPERCASE spelling only (mixed-case
 * assembles, so it is accepted); byte lanes match the exact-lowercase
 * spelling only (B0 assembles, so it is accepted).
 */
function isReservedAsmName(name) {
    if (name === undefined || name === null) return false;
    var s = String(name);
    if (REGISTER_LOOKUP[s.toLowerCase()] === true) return true;
    if (BYTE_LANE_LOOKUP[s] === true) return true;
    if (MNEMONIC_LOOKUP[s] === true) return true;
    if (MNEMONIC_UPPER_LOOKUP[s] === true) return true;
    return false;
}

function reservedErrorFor(kind, value, detail) {
    return "Instance " + kind + " \"" + value + "\" is a clpru reserved " +
        "identifier ([E0300]; PRU register, constant-table register or " +
        "instruction mnemonic) and cannot be used as an assembly label or " +
        "symbol. Rename it." + (detail ? " " + detail : "");
}

/**
 * Reject a reserved instance ($name). For blocks that emit the bare name
 * (crc, look_up_table, modbus lutName). `detail` names the emission, e.g.
 * "This block emits '<name> .byte ...' into .initdmem."
 */
function validateInstanceName(inst, report, detail) {
    if (!inst || inst.$name === undefined || inst.$name === null) return;
    if (isReservedAsmName(inst.$name)) {
        report.logError(reservedErrorFor("name", inst.$name, detail), inst);
    }
}

/**
 * Reject a reserved value in a derived assembly symbol. Some blocks never
 * emit the raw name: conditional emits `<name>_TRUE`/`<name>_FALSE` branch
 * labels, group emits `<groupName>_start`, pid emits `<name>_pid_state`.
 * Those derived symbols assemble even for a reserved base (checked with clpru: c0_TRUE,
 * c0_start, c0_pid_state and add_TRUE all build), so only the DERIVED form
 * is checked — a reserved base whose derived symbols assemble is accepted.
 * `field` is a config field name, or "$name" for the instance name.
 */
function validateDerivedSymbol(inst, report, field, suffixes, detail) {
    if (!inst) return;
    var value = (field === "$name") ? inst.$name : inst[field];
    if (value === undefined || value === null) return;
    if (String(value).trim() === "") return; // emptiness is reported by the block itself
    suffixes.forEach(function (suffix) {
        var derived = String(value) + suffix;
        if (isReservedAsmName(derived)) {
            report.logError("Derived name \"" + derived + "\" (from " + field + ") is a clpru reserved " +
                "identifier ([E0300]; PRU register, constant-table register or " +
                "instruction mnemonic) and cannot be used as an assembly label or " +
                "symbol. Rename it." + (detail ? " " + detail : ""), inst, field === "$name" ? undefined : field);
        }
    });
}

/**
 * Reject a reserved value in a named config field that is emitted as an
 * assembly label or symbol (groupName, labelName, variableName).
 */
function validateSymbolField(inst, report, field, detail) {
    if (!inst) return;
    var value = inst[field];
    if (value === undefined || value === null) return;
    if (String(value).trim() === "") return; // emptiness is reported by the block itself
    if (isReservedAsmName(value)) {
        report.logError("Reserved name \"" + value + "\" (" + field + ") is a clpru reserved " +
            "identifier ([E0300]; PRU register, constant-table register or " +
            "instruction mnemonic) and cannot be used as an assembly label or " +
            "symbol. Rename it." + (detail ? " " + detail : ""), inst, field);
    }
}

exports = {
    RESERVED_ASM_NAMES: RESERVED_ASM_NAMES,
    isReservedAsmName: isReservedAsmName,
    validateInstanceName: validateInstanceName,
    validateDerivedSymbol: validateDerivedSymbol,
    validateSymbolField: validateSymbolField
};
if (typeof module !== "undefined" && module && module.exports) { module.exports = exports; }
