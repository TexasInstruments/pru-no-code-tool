"use strict";

/*
 * ICSSG SUM32 hardware accelerator (TRM SPRUIM2J 6.4.6.2.6, Tables 6-93/6-94).
 *
 * XOUT writes 32 bytes from R2-R9 into the accelerator; XIN reads the
 * running 32-bit sum back from R29 and self-clears it on read. This block
 * is registered on the PRU0/PRU1 core list ONLY (soc/pru_blocks_am64x.syscfg.js
 * and soc/pru_blocks_am243x.syscfg.js, topModules_pru). The TRM documents a
 * separate RTU_PRU device-ID mapping (38/39) but says nothing about TX_PRU,
 * so this block is deliberately NOT added to topModules_rtu_tx_pru, which is
 * shared by RTU_PRU and TX_PRU cores — that would offer it on a core this
 * block cannot honor. validate() below still rejects a non-PRU core as
 * defense in depth.
 *
 * Two operations:
 *   accumulate      - input1 supplies the 32-bit DMEM byte address of the
 *                      32-byte block to checksum. The generated macro LBBOs
 *                      that block into R2-R9 (Table 6-94) and then XOUTs it
 *                      to SUM32. Device 47 (SUM32 only) or 49 (BS RAM +
 *                      SUM32 snoop, also writes BS RAM) — the snoop mode is
 *                      a separate `bsRamSnoop` option because it has the
 *                      side effect of writing BS RAM.
 *   read_and_clear  - XIN device 2 reads the 32-bit sum and self-clears it.
 *                      TRM 6.4.6.2.6: firmware must insert >=3 NOPs / 3 clock
 *                      cycles between the last XOUT and this XIN or the sum
 *                      read back is wrong. The generator enforces this by
 *                      always emitting the 3 NOPs inside the macro, rather
 *                      than documenting the hazard for firmware to remember.
 *
 * R2-R9 (allocator bytes 8..39) is a FIXED window, not something the
 * allocator picks — LBBO/XOUT hard-code it. Whenever any accumulate
 * instance is present, pru_register_allocator.allocatePruRegisters() blanket-
 * reserves those bytes (same precedent as the XFR2PSI R1:R5 window)
 * so no other block's live value can ever be allocated there. The first
 * pass shipped the XOUT without this declaration, so the allocator
 * treated R2-R9 as free general-purpose pool and silently checksummed
 * whatever unrelated block landed there. validateSum32Global in
 * pru_blocks_static_module is the safety net if that reservation is ever
 * bypassed or deleted.
 */

function getCoreType() {
    try {
        const common = system.getScript("/common");
        const coreName = common.getSelfSysCfgCoreName();
        if (coreName && coreName.includes("rtu")) return "RTU_PRU";
        if (coreName && coreName.includes("tx")) return "TX_PRU";
        if (coreName && coreName.includes("pru")) return "PRU";
    } catch (e) { /* test harnesses may stub /common without this call */ }
    return "PRU";
}

function opCode(inst) {
    if (inst.operation === "read_and_clear") return "m_sum32_read_clear";
    return inst.bsRamSnoop ? "m_sum32_accumulate_snoop" : "m_sum32_accumulate_only";
}

function cycleCount(inst) {
    // TRM 6.4.6.2.6: the SUM32 operation itself is 2 clock cycles and is
    // pipelined, so back-to-back 32-byte XOUTs see no backpressure. accumulate
    // now also LBBOs 32 bytes (8 words) from DMEM first: PRU ISA LBBO timing
    // used elsewhere in this tree (utils/access_look_up_table.syscfg.js) is
    // 2 + N cycles for N 4-byte words, so 2 + 8 = 10 cycles, plus the 2-cycle
    // SUM32 op = 12.
    if (inst.operation === "accumulate") return 12;
    // read_and_clear: 3 mandatory hazard NOPs + 2-cycle op + 1-cycle read pipe.
    return 6;
}

function validate(inst, report) {
    if (["accumulate", "read_and_clear"].indexOf(inst.operation) < 0) {
        report.logError("SUM32 operation must be accumulate or read_and_clear.", inst, "operation");
    }
    if (inst.bsRamSnoop && inst.operation !== "accumulate") {
        report.logError(
            "BS RAM snoop only applies to the accumulate operation (XOUT device 49/38). " +
            "read_and_clear always uses XIN device 2 and ignores this option.",
            inst, "bsRamSnoop"
        );
    }
    if (inst.operation === "accumulate" && (!inst.input1 || inst.input1.length === 0)) {
        report.logWarning(
            "input1 (DMEM source address) is not connected. The allocator substitutes a dummy " +
            "register for an unconnected input, so accumulate would LBBO+XOUT whatever 32 bytes " +
            "happen to sit at that address, not real user data.",
            inst, "input1"
        );
    }
    const core = getCoreType();
    if (core !== "PRU") {
        report.logError(
            `SUM32 device IDs implemented by this block (47/49 XOUT, 02 XIN) are the PRU-core ` +
            `mapping only (TRM Table 6-93). RTU_PRU uses a different device-ID pair (38/39) not ` +
            `implemented here, and TX_PRU is not documented at all; placed core is '${core}'.`,
            inst, "operation"
        );
    }
}

function macroLines(name) {
    const bodies = {
        "m_sum32_accumulate_only": [
            `${name} .macro SRC_ADDR`,
            "    ; SUM32 accumulate, SUM32-only device (TRM Table 6-93: 47 / 0x2F on PRU).",
            "    ; Loads the 32-byte block to checksum from DMEM address SRC_ADDR into",
            "    ; R2-R9 (Table 6-94), then writes it to the SUM32 accelerator.",
            "    lbbo  &R2, SRC_ADDR, 0, 32",
            "    xout  47, &R2, 32",
            "    .endm"
        ],
        "m_sum32_accumulate_snoop": [
            `${name} .macro SRC_ADDR`,
            "    ; SUM32 accumulate, BS RAM + SUM32 snoop device (TRM Table 6-93: 49 / 0x31",
            "    ; on PRU). Loads the 32-byte block to checksum from DMEM address SRC_ADDR",
            "    ; into R2-R9 (Table 6-94), then writes it to BOTH the Broadside (BS) RAM",
            "    ; and the SUM32 accelerator in the same XOUT (TRM 6.4.6.2.5 / 6.4.6.2.6).",
            "    lbbo  &R2, SRC_ADDR, 0, 32",
            "    xout  49, &R2, 32",
            "    .endm"
        ],
        "m_sum32_read_clear": [
            `${name} .macro RES`,
            "    ; TRM 6.4.6.2.6: firmware must insure >=3 NOPs or 3 clock cycles between",
            "    ; the last XOUT and this XIN, or the sum read back is wrong. Enforced HERE",
            "    ; by the generator rather than documented for firmware to remember.",
            "    nop",
            "    nop",
            "    nop",
            "    ; XIN device 2 (0x02, TRM Table 6-93): reads the 32-bit sum into R29",
            "    ; (TEMP_REG2 alias, Table 6-94). The read self-clears the SUM32 accumulator.",
            "    xin   2, &TEMP_REG2, 4",
            "    mov   RES, TEMP_REG2",
            "    .endm"
        ]
    };
    if (!bodies[name]) {
        throw new Error("Unsupported SUM32 macro " + name);
    }
    return bodies[name].join("\n");
}

const sum32Module = {
    displayName: "SUM32 (ICSSG UDP Checksum Accelerator)",
    requiresWidget: ["sum32"],
    defaultInstanceName: "SUM32_",
    description: "ICSSG SUM32 one's-complement checksum accelerator (UDP checksum offload).",
    longDescription: "Accumulates a running one's-complement sum over 32-byte DMEM blocks: input1 " +
        "supplies the 32-bit DMEM byte address of the block, which is LBBO'd into R2-R9 and then " +
        "XOUT to the accelerator, and reads the sum back (self-clearing) via XIN into R29 (TRM " +
        "SPRUIM2J 6.4.6.2.6, Tables 6-93/6-94). R2-R9 are reserved across the whole design whenever " +
        "an accumulate instance is present, so no other block's value can land in that window. " +
        "PRU-core device IDs only: 47 (SUM32 only) / 49 (BS RAM + SUM32 snoop) for XOUT, 02 for XIN. " +
        "Available only on ICSSG devices (AM64x/AM243x), on PRU0/PRU1 cores.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },

        { name: "operation", displayName: "Operation", default: "accumulate", options: [
            { name: "accumulate", displayName: "Accumulate (LBBO DMEM block, XOUT R2-R9 to SUM32)" },
            { name: "read_and_clear", displayName: "Read and Clear (XIN sum, self-clears)" }
        ] },
        { name: "bsRamSnoop", displayName: "BS RAM + SUM32 snoop (also writes BS RAM)", default: false,
          description: "Only meaningful for the accumulate operation. Uses device 49/38 instead of " +
              "47/39, which ALSO writes the 32-byte block to Broadside (BS) RAM as a side effect " +
              "(TRM 6.4.6.2.5)." },

        { name: "opCode", hidden: true, default: "m_sum32_accumulate_only", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0,
          getValue: (inst) => inst.operation === "accumulate" ? 1 : 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0,
          getValue: (inst) => inst.operation === "read_and_clear" ? 1 : 0 },
        { name: "output1Size", hidden: true, default: 0,
          getValue: (inst) => inst.operation === "read_and_clear" ? 4 : 0 },
        { name: "numOfConstants", hidden: true, default: 0 },
        // accumulate has no dataflow output (side effect on R2-R9 only); "None"
        // here skips the allocator's automatic output-register allocation
        // (same idiom as delay_block.syscfg.js).
        { name: "outputReg", hidden: true, default: "",
          getValue: (inst) => inst.operation === "accumulate" ? "None" : "" },

        { name: "noOfCycles", displayName: "Peak cycles", default: 12, readOnly: true, getValue: cycleCount }
    ],

    ports: (inst) => {
        const base = [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
        if (inst.operation === "read_and_clear") {
            return base.concat([{ name: "output1", type: "output32" }]);
        }
        return base.concat([{ name: "input1", type: "input32" }]);
    },

    validate,

    getMacro(pruInstructionMacro, requestedOpCode) {
        const raw = requestedOpCode || pruInstructionMacro || "";
        const name = raw.trim().split(/[\s,]+/)[0];
        return macroLines(name);
    },

    // Machine-readable metadata used by documentation and tests. Instruction
    // / TRM-cycle-count claims, not a hardware benchmark.
    cycleEvidence: {
        accumulate: { peakCycles: 12, basis: "LBBO &R2, SRC_ADDR, 0, 32 loads 8 words from DMEM: " +
            "2 + N cycles for N 4-byte words (PRU ISA LBBO timing, same convention as " +
            "utils/access_look_up_table.syscfg.js) = 2 + 8 = 10, plus the SUM32 op itself which is " +
            "2 clock cycles per TRM 6.4.6.2.6, pipelined so back-to-back 32-byte XOUTs see no " +
            "backpressure." },
        read_and_clear: { peakCycles: 6, basis: "3 mandatory NOP hazard cycles (TRM 6.4.6.2.6) + " +
            "2-cycle SUM32 op + 1-cycle read pipe before the XIN returns a correct sum." }
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

exports = sum32Module;
