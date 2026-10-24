"use strict";

/*
 * ICSSG Spinlock (XFR2SPIN) hardware mutex.
 *
 * References, from SPRUIM2J (Table 6-60 "Hardware Module Broadside
 * ID Mapping", PDF p573; and 6.4.6.2.9 / 6.4.6.2.9.1 Table 6-98, PDF p638-639):
 *
 *   Table 6-60:  XFR2SPIN   0x90   "1 copy per PRU_ICSSG system"
 *   6.4.6.2.9:   "64 ownership flags (shared by SLICE0 and SLICE1 within an
 *                 PRU_ICSSG subsystem) with support of 14 initiators,
 *                 including: - 6 Internal PRU cores: PRU0/1, RTU_PRU0/1 and
 *                 TX_PRU0/1 cores"
 *
 * ---------------------------------------------------------------------------
 * THE DIRECTION OF EACH ACCESS IS THE WHOLE POINT OF THIS BLOCK.
 * ---------------------------------------------------------------------------
 * Table 6-98, the INT_SPIN_ID 0x90 rows, assigns the two directions OPPOSITE
 * to the way a "request then read back" peripheral usually works:
 *
 *   R1.b0[5-0]  BS ID: NA    "Always exported"   Flag selection
 *               own_req_vector[5:0] - "Defines which flag to arbitrate".
 *               6.4.6.2.9 spells out that this register is NOT XOUT'd:
 *               "PRU, RTU_PRU and TX_PRU cores use R1.b0 register, which is
 *                snooped or continually monitored by the Spinlock. XOUT of
 *                this register is not required. XIN of R1.b0 causes
 *                arbitration action."
 *
 *   R1.b3[0]    INT_SPIN_ID 0x90   XIN    Flag status and arbitration
 *               "own_req input will assert during this XIN transaction. This
 *                assertion will cause an arbitration event. The result of this
 *                arbitration is returned to R1.b3[0] via own_req_status
 *                0h: not owned/lost   1h: owned/won"
 *               => ACQUIRE IS AN XIN.
 *
 *   R1.b0       INT_SPIN_ID 0x90   XOUT   Flag clear
 *               "own_req_clr input will assert during the XOUT ... This
 *                assertion will clear the flag selected by R1.b0/
 *                own_req_vector"
 *               => RELEASE IS THE XOUT.
 *
 * So on device 0x90 an XOUT does NOT request the lock - it DROPS it. Emitting
 * "XOUT 0x90 then read back with XIN 0x90" as an acquire would clear the very
 * flag the core is trying to take, which is a worse race than having no lock
 * at all. That sequence is only correct for the EXTERNAL spinlock IDs
 * (EXT_SPIN_ID0 0x91 / EXT_SPIN_ID1 0x92), where Table 6-98 does map XOUT to
 * "Flag status and arbitration". This block models the INTERNAL device only.
 *
 * ---------------------------------------------------------------------------
 * THE EIGHT NOPS
 * ---------------------------------------------------------------------------
 * "NOTE: Firmware must have 8 NOP before XIN after XOUT." appears three times
 * in Table 6-98, on the EXT_SPIN_ID0 0x91 XOUT block and on both EXT_SPIN_ID1
 * 0x92 blocks. It is NOT printed against the INT_SPIN_ID 0x90 rows, so for
 * 0x90 it is a conservative carry-over, not a quoted requirement; `nopBasis`
 * below records it as such rather than as a TRM citation.
 *
 * Because acquire and release are separate blocks that the graph may schedule
 * in any order, the only placement that actually satisfies "8 NOP before XIN
 * after XOUT" is at the END of RELEASE (the only XOUT this block emits). Eight
 * NOPs inside acquire would guard nothing: acquire contains no XOUT.
 */

// Table 6-60 / Table 6-98. Decimal 144 is what the assembler and the
// simulator's bank dispatch actually see; both forms are asserted in the tests
// so a future edit cannot change one without the other.
const INT_SPIN_ID = 0x90;

// 6.4.6.2.9: 64 ownership flags, selected by own_req_vector[5:0] = R1.b0[5:0].
const NUM_FLAGS = 64;

// Table 6-98: "Firmware must have 8 NOP before XIN after XOUT."
const NOPS_AFTER_XOUT = 8;

/*
 * The spinlock interface is hardwired to R1: R1.b0 is the continuously snooped
 * flag selector and R1.b3[0] is the arbitration result. R1 is a register the
 * allocator can hand to an ordinary block, so every operation here clobbers a
 * fixed architectural register in exactly the sense validateBswapGlobal already
 * polices. Declared at module level (not as a configurable): SysConfig rejects
 * array-typed configurables, and every instance clobbers R1 identically, so
 * there is nothing per-instance to express.
 */
const CLOBBERED_REGISTER = 1;

const OPERATIONS = {
    acquire: {
        opCode: "m_xfr2spin_acquire",
        // Blocking. Cycle budget is deliberately -1, which the register
        // allocator maps to INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN: a spin
        // whose duration is set by another core must not report a number.
        cycles: -1,
        hasOutput: true,
        blocking: true,
        label: "acquire (spin until owned)"
    },
    try_acquire: {
        opCode: "m_xfr2spin_try_acquire",
        // LDI + XIN + AND. One arbitration attempt, no loop.
        cycles: 3,
        hasOutput: true,
        blocking: false,
        label: "try_acquire (one arbitration attempt, returns ownership bit)"
    },
    release: {
        opCode: "m_xfr2spin_release",
        // LDI + XOUT + 8 NOP.
        cycles: 2 + NOPS_AFTER_XOUT,
        hasOutput: false,
        blocking: false,
        label: "release (clear the flag)"
    }
};

function operationName(inst) {
    return (inst && inst.operation) || "acquire";
}
function operationInfo(inst) {
    return OPERATIONS[operationName(inst)] || OPERATIONS.acquire;
}
function opCode(inst) {
    return operationInfo(inst).opCode;
}
function cycleCount(inst) {
    return operationInfo(inst).cycles;
}
function hasOutput(inst) {
    return operationInfo(inst).hasOutput;
}

function validate(inst, report) {
    const name = operationName(inst);
    if (!OPERATIONS[name]) {
        report.logError(
            "XFR2SPIN operation '" + name + "' is not one of " +
            Object.keys(OPERATIONS).join(", ") + ".", inst, "operation");
        return;
    }

    // 6.4.6.2.9: own_req_vector is 6 bits, so exactly 64 flags exist. An out of
    // range id would silently alias onto a DIFFERENT lock once truncated to
    // [5:0] - i.e. two designs that believe they hold different locks would
    // share one. Reject rather than mask.
    const id = Number(inst.lockId);
    if (!Number.isInteger(id) || id < 0 || id >= NUM_FLAGS) {
        report.logError(
            "Lock ID must be an integer in 0.." + (NUM_FLAGS - 1) + " (SPRUIM2J 6.4.6.2.9: " +
            "own_req_vector[5:0] selects one of " + NUM_FLAGS + " ownership flags). Got '" +
            inst.lockId + "'.", inst, "lockId");
    }

    if (name === "acquire") {
        report.logInfo(
            "This acquire SPINS until the flag is won. Arbitration is fixed-priority " +
            "(SPRUIM2J 6.4.6.2.9), not fair, so a lower-priority core can be starved " +
            "indefinitely. Its cycle budget is reported as unknown rather than as a number. " +
            "Use try_acquire in a hard real-time path.", inst, "operation");
    }
}

/*
 * Macro bodies. `getMacro("", opCode)` - the production path used by
 * pru_syscfg.inc.xdt - routes here, and these are the ONLY bodies defined:
 * there is no test-only branch that emits something different from what a
 * generated firmware gets.
 */
function macroLines(operation) {
    const info = OPERATIONS[operation];

    if (operation === "release") {
        const lines = [
            info.opCode + " .macro LOCK_ID",
            "    ; ICSSG Spinlock RELEASE - SPRUIM2J 6.4.6.2.9.1 Table 6-98, INT_SPIN_ID 0x90.",
            "    ; R1.b0[5:0] = own_req_vector selects which of the 64 flags to act on.",
            "    ; It is continuously snooped by the spinlock and is NOT XOUT'd to select.",
            "    ldi   R1.b0, LOCK_ID",
            "    ; XOUT against 0x90 asserts own_req_clr, which clears the flag selected",
            "    ; by R1.b0/own_req_vector. On 0x90 the XOUT is the RELEASE, not a request.",
            "    xout  " + INT_SPIN_ID + ", &R1.b0, 1",
            "    ; Table 6-98: \"Firmware must have 8 NOP before XIN after XOUT.\" These sit",
            "    ; at the end of release because this is the only XOUT the block emits, so",
            "    ; this is the only placement that separates it from a following acquire XIN."
        ];
        for (let i = 0; i < NOPS_AFTER_XOUT; i++) lines.push("    nop");
        lines.push("    .endm");
        return lines.join("\n");
    }

    // try_acquire: exactly one arbitration event.
    if (operation === "try_acquire") {
        return [
            info.opCode + " .macro RES, LOCK_ID",
            "    ; ICSSG Spinlock TRY-ACQUIRE - SPRUIM2J 6.4.6.2.9.1 Table 6-98, 0x90.",
            "    ; Select the flag. R1.b0 is snooped, so a plain LDI is the selector write",
            "    ; (6.4.6.2.9: \"XOUT of this register is not required\").",
            "    ldi   R1.b0, LOCK_ID",
            "    ; The XIN itself asserts own_req and causes the arbitration event; the",
            "    ; verdict is returned in R1.b3[0] via own_req_status.",
            "    xin   " + INT_SPIN_ID + ", &R1.b3, 1",
            "    ; Ownership is the BIT R1.b3[0] (0h not owned/lost, 1h owned/won), not the",
            "    ; byte R1.b3. Masking to bit 0 keeps the result boolean even when the other",
            "    ; seven bits of R1.b3 carry unrelated state.",
            "    and   RES, R1.b3, 1",
            "    .endm"
        ].join("\n");
    }

    // acquire: spin until won.
    return [
        info.opCode + " .macro RES, LOCK_ID",
        "    ; ICSSG Spinlock ACQUIRE (blocking) - SPRUIM2J 6.4.6.2.9.1 Table 6-98, 0x90.",
        "    ; Select the flag once; R1.b0 is continuously snooped so it does not need to",
        "    ; be rewritten on every retry.",
        "    ldi   R1.b0, LOCK_ID",
        "xs_spin?:",
        "    ; Each XIN is a fresh arbitration event. While another core holds the flag,",
        "    ; own_req_status comes back 0 and this loop does not fall through - that is",
        "    ; the mutual exclusion, and it is what makes a second core block here.",
        "    xin   " + INT_SPIN_ID + ", &R1.b3, 1",
        "    qbbc  xs_spin?, R1.b3, 0",
        "    ; Won. Publish the ownership BIT, masked to bit 0 so the output is boolean.",
        "    and   RES, R1.b3, 1",
        "    .endm"
    ].join("\n");
}

const xfr2spinModule = {
    displayName: "XFR2SPIN (ICSSG Hardware Spinlock)",
    requiresWidget: ["xfr2spin"],
    defaultInstanceName: "SPINLOCK_",
    description: "Hardware mutex over the ICSSG spinlock (broadside 0x90): acquire/try_acquire/release one of 64 ownership flags.",
    longDescription:
        "Takes and drops one of the 64 ICSSG ownership flags through the internal spinlock " +
        "broadside port (SPRUIM2J Table 6-60: XFR2SPIN 0x90, one copy per PRU_ICSSG subsystem; " +
        "6.4.6.2.9: 64 flags shared by SLICE0 and SLICE1, reachable by all six PRU cores). " +
        "Directions follow Table 6-98's INT_SPIN_ID rows exactly: the flag is selected by writing " +
        "R1.b0[5:0] (continuously snooped - never XOUT'd), an XIN against 0x90 raises the " +
        "arbitration event and returns ownership in R1.b3[0], and an XOUT against 0x90 clears the " +
        "flag. An XOUT is therefore a RELEASE on this device, never a request - the opposite " +
        "convention to the external spinlock IDs 0x91/0x92. 'acquire' spins until it wins and " +
        "reports its cycle budget as unknown, because the wait is set by another core; " +
        "'try_acquire' makes one attempt and returns the ownership bit. Arbitration is " +
        "fixed-priority, not fair. This is an ICSSG widget: ICSSM (AM261x/AM263Px) has no " +
        "spinlock and there is no software fallback, which requiresWidget states. Maturity is " +
        "'assembles': the emitted macros are assembled by clpru from genuinely SysConfig-generated " +
        "output and executed against a TRM-derived 0x90 model in scripts/simulator.js. That model " +
        "and this block were both written from SPRUIM2J, so the simulator arm is not an " +
        "independent oracle and makes no silicon claim.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },
        { name: "operation", displayName: "Operation", default: "acquire", options: [
            { name: "acquire", displayName: "acquire - spin until the flag is won" },
            { name: "try_acquire", displayName: "try_acquire - one attempt, returns ownership bit" },
            { name: "release", displayName: "release - clear the flag" }
        ] },
        { name: "lockId", displayName: "Lock ID (0-63)", default: 0,
          description: "Which of the 64 ICSSG ownership flags to use (own_req_vector[5:0])." },
        // The region this lock protects. Matched by validateXfr2spinGlobal against the
        // variable name of a block that declares a cross-core write, so that "is this
        // buffer locked" is answerable at build time.
        { name: "protectsVariable", displayName: "Protects Shared Variable", default: "",
          description: "Name of the shared variable this lock guards (the variable a cross-core writing block stores to). Required to protect a cross-core region." },

        { name: "opCode", hidden: true, default: "m_xfr2spin_acquire", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 1, getValue: (inst) => (hasOutput(inst) ? 1 : 0) },
        { name: "numOfConstants", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4, getValue: (inst) => (hasOutput(inst) ? 4 : 0) },
        // Release produces no value: the allocator's "None" path emits
        // `m_xfr2spin_release <constants>` with no output register operand.
        { name: "outputReg", hidden: true, default: "", getValue: (inst) => (hasOutput(inst) ? "" : "None") },
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => Number(inst.lockId) },
        { name: "noOfCycles", displayName: "Peak Cycles", default: -1, readOnly: true, getValue: cycleCount }
    ],

    ports: function (inst) {
        const ports = [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
        if (hasOutput(inst)) ports.push({ name: "output1", type: "output32" });
        return ports;
    },

    validate,

    getMacro: function (pruInstructionMacro, requestedOpCode) {
        // Static validation hands over a whole allocator call such as
        // "m_xfr2spin_acquire R4, 7"; the .xdt production path hands over
        // ("", instance.opCode). Take the first token of whichever is present
        // so BOTH callers land on the same body; returning a bare .macro/.endm
        // on the ("", opCode) path would ship firmware with no spinlock access
        // in it at all.
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const operation = Object.keys(OPERATIONS).find(
            (op) => OPERATIONS[op].opCode === name || op === name);
        if (!operation) {
            throw new Error("Unsupported XFR2SPIN macro " + JSON.stringify(name));
        }
        return macroLines(operation);
    },

    // Machine-readable metadata, consumed by the tests and the validator.
    operations: OPERATIONS,
    deviceId: INT_SPIN_ID,
    numFlags: NUM_FLAGS,
    nopsAfterXout: NOPS_AFTER_XOUT,
    clobberedRegister: CLOBBERED_REGISTER,
    trmReference: {
        deviceId: "Table 6-60 (PDF p573): 'XFR2SPIN 0x90 1 copy per PRU_ICSSG system'",
        flagSelect: "Table 6-98 (PDF p638): R1.b0[5-0] own_req_vector, 'Always exported'; 6.4.6.2.9: 'XOUT of this register is not required'",
        acquire: "Table 6-98 INT_SPIN_ID 0x90 XIN: 'own_req input will assert during this XIN transaction ... result ... returned to R1.b3[0] via own_req_status 0h: not owned/lost 1h: owned/won'",
        release: "Table 6-98 INT_SPIN_ID 0x90 XOUT: 'Flag clear ... will clear the flag selected by R1.b0/own_req_vector'",
        cores: "6.4.6.2.9: '64 ownership flags ... 6 Internal PRU cores: PRU0/1, RTU_PRU0/1 and TX_PRU0/1 cores'"
    },
    // Recorded as an inference, not as a citation. See the header comment.
    nopBasis: {
        quote: "Table 6-98: 'NOTE: Firmware must have 8 NOP before XIN after XOUT.'",
        printedAgainst: ["EXT_SPIN_ID0 0x91 XOUT", "EXT_SPIN_ID1 0x92 XOUT", "EXT_SPIN_ID1 0x92 XIN"],
        appliedTo: "INT_SPIN_ID 0x90 release",
        status: "conservative-carryover",
        note: "The note is NOT printed against the 0x90 rows. 0x90 is specified as a 2-cycle " +
              "response and 0x91/0x92 as 4-6, so carrying the longer separation onto 0x90 is " +
              "safe but is an inference. Not verified on silicon."
    },
    // A genuine ambiguity in the source, surfaced rather than silently resolved.
    knownTrmAmbiguity: {
        what: "Which byte the release XOUT targets.",
        detail: "Table 6-98's 'PRU Register' column gives the flag-clear row as R1.b0, but the " +
                "prose in the same row says the clear asserts 'during the XOUT R1.b3 transaction' " +
                "(and 'XOUT R1.b1' for 0x91/0x92). The TRM is internally inconsistent.",
        resolution: "This block emits XOUT 0x90, &R1.b0, 1 - the structured Register column, which " +
                    "also agrees with 'clear the flag selected by R1.b0/own_req_vector'.",
        status: "UNVERIFIED on silicon. Needs a hardware run or a TI reference example to settle."
    },
    cycleBasis: {
        acquire: { peakCycles: -1, basis: "unbounded: LDI + a spin of XIN/QBBC whose length is set by the core holding the flag" },
        try_acquire: { peakCycles: 3, basis: "LDI + 1-cycle XIN (Table 6-60 broadside access) + AND mask" },
        release: { peakCycles: 10, basis: "LDI + XOUT + the 8 NOP separation" }
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null
    },
    moduleStatic: {
        modules: function () {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        }
    }
};

exports = xfr2spinModule;
