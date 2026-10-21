"use strict";

/*
 * FDB Generic Broadside RAM + 16-byte Compare (ICSSG).
 *
 * -----------------------------------------------------------------------------
 * NON-ETHERNET USE: WHAT THE TRM SAYS
 * -----------------------------------------------------------------------------
 * The FDB generic-mode controls live in the MII_G_RT register space. The
 * local functional extract identifies the enable bits as
 * MII_G_RT_FDB_GEN_CFG2[7] and [8]. That placement raised the question whether FDB generic mode
 * requires a configured MII port at all, which would rule out using it
 * without Ethernet.
 *
 * What the TRM says (consulted):
 *   - SPRUIM2J 6.4.11.2.3.7.4 "FDB Generic Mode" describes the generic access
 *     as PRU broadside XOUT/XIN to IDs 30/31/35 through R10 (address) and
 *     R2..R9/R2..R5 (data/pattern). The text lists FDB_GEN_MODE_EN_BK0/BK1
 *     and FDB_GEN_MODE_BYTE_EN in MII_G_RT_FDB_GEN_CFG2 as the enables, with no
 *     sentence that says "MII0/MII1 must be enabled/port-configured" as a
 *     prerequisite for this path.
 *   - Table 6-60 "Hardware Module Broadside ID Mapping" lists FDB IDs 30,
 *     31, 35 as broadside peripherals reachable from PRU0/PRU1 (1 cycle per
 *     XFR), again without a footnote that ties ID availability to MII port
 *     state. Table 6-105 (Generic Mode Transfer Timing) describes the
 *     2-cycle hazard between pattern/address/data XFR and the XIN 35
 *     compare_result, without conditioning it on MII configuration.
 *   - The LUT/bridging mode section (6.4.11.2.3.7.2-3) IS explicitly driven
 *     by RX SOF and Ethernet framing and is, by construction, Ethernet-owned.
 *     That mode is left NOT BUILT by this block (see OUT OF SCOPE below).
 *   - The only place where MII_RT configuration and a broadside ID interact
 *     is the XFR2PSI shared pair 0x58/0x59 case (Table 6-60 + MII_G_RT_ICSS_G_CFG
 *     bit 9, modelled in xfr2psi_block.syscfg.js). That is a precedent for a
 *     cfg bit that lives in the same register block yet gates a DIFFERENT
 *     peripheral - it does not imply every cfg bit in MII_G_RT is MII-port-
 *     dependent.
 *
 * What the TRM does NOT say, and therefore what we do NOT claim:
 *   The TRM is silent on whether the FDB clock/reset or its generic-mode
 *   datapath are gated by the MII0/MII1 port-enable bits in MII_G_RT. No
 *   sentence proves independence, and no sentence proves dependence, and no
 *   second source settles it.
 *
 * Conclusion, with an explicit caveat: the TRM's generic-mode
 * prose and broadside tables describe the access without listing MII port
 * configuration as a prerequisite, so we proceed on that reading, but the TRM
 * does not state independence in a single settling sentence and this has not
 * been proven on silicon. The block is therefore delivered as
 * "simulator-tested" at most, and its header and docs carry this caveat
 * rather than a claim that the question is closed. Compare is
 * described as a single-row compare (not a search) with no cycle advantage
 * over register compares after a 1-cycle XIN.
 *
 *   SPRUIM2J references relied upon: Table 6-60 (broadside ID mapping),
 *   Table 6-103 (FDB_Address 9-bit, R10[8] bank select), Table 6-105
 *   (2-cycle hazard), Section 6.4.11.2.3.7.4 (Generic Mode), and 6.4.11.2.1
 *   MII_G_RT_FDB_GEN_CFG2[7]/[8] generic-bank enables.
 *
 * -----------------------------------------------------------------------------
 * DESIGN (from SPRUIM2J)
 * -----------------------------------------------------------------------------
 * fdb_gp_ram_block. PRU0/PRU1 only, never RTU_PRU/TX_PRU. ICSSG
 * only; ICSSM (AM261x) must be refused via pru_device_caps.
 *
 * What it provides: 16 KB of shared 32-byte-wide table memory (512 rows x 32 B),
 * addressed by a 9-bit FDB_Address where R10[8] selects the bank (Table 6-103),
 * plus arbitrated inter-PRU IPC when guarded by XFR2SPIN. The compare
 * is NOT a search - it compares the pattern (ID 31) against the CURRENTLY
 * ADDRESSED ROW only (ID 30 address XFR). Walking N rows costs N x (advance +
 * 2-cycle wait + read) and has NO cycle advantage over four 32-bit register
 * compares after a 1-cycle XIN. The hashed search exists only in LUT/bridging
 * mode with Ethernet framing, which this block does not implement.
 *
 * Operations:
 *   set_address    XOUT R10, 2 -> BS ID 30  (FDB address, R10[8]=bank)
 *   write / read   R2..R9, 1..32 B, BS ID 30 (row data)
 *   set_pattern    XOUT R2..R5, 1..16 B, BS ID 31 (compare pattern)
 *   compare_result XIN R10 from BS ID 35, only >=2 cycles after pattern/address/data XFR
 *
 * Cost per SPRUIM2J Table 6-105: 1 cycle per XFR plus a 2-cycle hazard before
 * compare_result. This block does not write MII_G_RT_FDB_GEN_CFG2 from PRU
 * firmware; it fails closed unless an external initializer is acknowledged.
 *
 * OUT OF SCOPE, NOT BUILT: LUT/bridging mode (Ethernet-owned, RX-SOF driven)
 * and FDB results registers 32/33/34 (cannot be armed from PRU XOUT).
 */

function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();
    let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) result = parseInt(match[1]);
    }
    if (result == 0) return "PRU0";
    return "PRU1";
}
const PRU_USED = getPruNumberFromContext();

function getCoreType() {
    try {
        const common = system.getScript("/common");
        const coreName = common.getSelfSysCfgCoreName();
        if (coreName && coreName.includes("rtu")) return "RTU_PRU";
        if (coreName && coreName.includes("tx")) return "TX_PRU";
        if (coreName && coreName.includes("pru")) return "PRU";
    } catch (e) {}
    return "PRU";
}

// Table 6-60 broadside IDs used by this block
const BS_IDS = { dataAddr: 30, pattern: 31, compareResult: 35 };

const OPERATIONS = {
    set_address:    { opCode: "m_fdb_set_address",    cycles: 1, clobbers: [[10,1]], label: "set_address XOUT R10,2 ID30" },
    write:          { opCode: "m_fdb_write",          cycles: 1, clobbers: [],       label: "write XOUT R2..R9 ID30" },
    read:           { opCode: "m_fdb_read",           cycles: 1, clobbers: [[2,8]],  label: "read XIN R2..R9 ID30" },
    set_pattern:    { opCode: "m_fdb_set_pattern",    cycles: 1, clobbers: [],       label: "set_pattern XOUT R2..R5 ID31" },
    compare_result: { opCode: "m_fdb_compare_result", cycles: 1, clobbers: [[10,1]], label: "compare_result XIN R10 ID35" }
};

function operationName(inst) {
    const op = (inst && inst.operation) || "set_address";
    return OPERATIONS[op] ? op : "set_address";
}
function opCode(inst) { return OPERATIONS[operationName(inst)].opCode; }
function cycleCount(inst) { return OPERATIONS[operationName(inst)].cycles; }
function clobbers(inst) { return OPERATIONS[operationName(inst)].clobbers; }

function validate(inst, report) {
    const op = operationName(inst);

    // Core gating: PRU0/PRU1 only, never RTU_PRU/TX_PRU (ICSSG)
    const core = getCoreType();
    if (core !== "PRU") {
        report.logError("FDB Generic RAM is attached to PRU0/PRU1 only (SPRUIM2J FDB Generic Mode, Table 6-60 IDs 30/31/35 are PRU1/0 only); placed core is '" + core + "'", inst, "operation");
    }

    // Address >511 (9-bit FDB_Address per Table 6-103)
    if (op === "set_address") {
        const addr = Number(inst.fdbAddress);
        if (!Number.isInteger(addr) || addr < 0 || addr > 511) {
            report.logError("FDB address must be an integer 0..511 (9-bit FDB_Address, Table 6-103; R10[8] selects the bank). Got '" + inst.fdbAddress + "'.", inst, "fdbAddress");
        }
        const sz = Number(inst.r10TransferSize);
        if (sz !== 2) {
            report.logError("R10 transfer size must be 2 bytes (XOUT R10, 2 -> BS ID 30, Table 6-103). Got '" + inst.r10TransferSize + "'.", inst, "r10TransferSize");
        }
        // External initialization requirement
        if (!inst.externalInitProvided) {
            report.logError("FDB Generic Mode requires MII_G_RT_FDB_GEN_CFG2[7:8] to be enabled by an external application. Check the 'Acknowledged: External Initialization Required' box to confirm you have provided it.", inst, "externalInitProvided");
        }
    }

    // write / read: R2..R9 1..32 bytes ID30
    if (op === "write" || op === "read") {
        const bc = Number(inst.byteCount);
        if (!Number.isInteger(bc) || bc < 1 || bc > 32) {
            report.logError("Byte count for " + op + " must be an integer 1..32 (R2..R9 window, 32 bytes max, ID 30). Got '" + inst.byteCount + "'.", inst, "byteCount");
        }
    }

    // set_pattern: 1..16 bytes ID31, and wider than FDB_GEN_MODE_BYTE_EN is refused
    if (op === "set_pattern") {
        const pb = Number(inst.patternBytes);
        if (!Number.isInteger(pb) || pb < 1 || pb > 16) {
            report.logError("Pattern size must be an integer 1..16 bytes (XOUT R2..R5, ID 31). Got '" + inst.patternBytes + "'.", inst, "patternBytes");
        }
        // FDB_GEN_MODE_BYTE_EN allows only a subset of the 16 pattern bytes to be compared.
        // Expose as a 16-bit mask (bit N enables pattern byte N). If patternBytes exceeds
        // the number of enabled bytes, the pattern is wider than the mode allows.
        let mask = 0;
        try {
            let raw = inst.fdbGenModeByteEn;
            if (typeof raw === "string") { raw = raw.trim(); mask = raw.startsWith("0x")||raw.startsWith("0X") ? parseInt(raw,16) : Number(raw); }
            else mask = Number(raw);
        } catch(e){ mask = NaN; }
        if (!Number.isInteger(mask) || mask < 0 || mask > 0xFFFF) {
            report.logError("FDB_GEN_MODE_BYTE_EN must be a 16-bit mask 0x0000..0xFFFF (enables pattern bytes). Got '" + inst.fdbGenModeByteEn + "'.", inst, "fdbGenModeByteEn");
        } else if (Number.isInteger(pb) && pb>=1 && pb<=16) {
            let enabled = 0; let m = mask >>>0;
            while (m) { enabled += m & 1; m >>>=1; }
            // If mask==0, no byte is enabled at all – any pattern is wider than allowed
            // If enabled < pb, pattern claims more bytes than the mode will compare
            if (enabled === 0) {
                report.logError("Pattern of " + pb + " bytes requires FDB_GEN_MODE_BYTE_EN to enable at least " + pb + " byte(s), but mask is 0x0000 (no byte enabled).", inst, "fdbGenModeByteEn");
            } else if (enabled < pb) {
                // hex with 4 digits
                const hex = "0x" + mask.toString(16).toUpperCase().padStart(4,"0");
                report.logError("Pattern of " + pb + " bytes is wider than FDB_GEN_MODE_BYTE_EN allows: mask " + hex + " enables only " + enabled + " byte(s). Reduce patternBytes or widen the mask (FDB_GEN_CFG).", inst, "patternBytes");
            }
        }
    }

    // compare_result is XIN ID35 - no per-instance range; the 2-cycle hazard is global (validateFdbGpRamGlobal).

    // IP block wants this specifically for non-Ethernet IPC: if the user marks
    // this instance as shared across PRU0/PRU1, the single-core SysConfig still
    // builds, but the cross-core validator (global) will demand a spinlock guard.
    // No per-instance error here – that would refuse single-core use.
}

function macroLines(op) {
    if (op === "set_address") {
        return [
            "m_fdb_set_address .macro RES, ADDR",
            "    ; FDB Generic Mode set_address - SPRUIM2J 6.4.11.2.3.7.4 Table 6-103.",
            "    ; R10 = FDB_Address (9-bit, R10[8]=bank select), XOUT 30, &R10, 2.",
            "    ldi   R10, ADDR",
            "    xout  30, &R10, 2",
            "    mov   RES, R10",
            "    .endm"
        ].join("\n");
    }
    if (op === "write") {
        return [
            "m_fdb_write .macro RES, BYTECOUNT",
            "    ; FDB Generic Mode write - SPRUIM2J 6.4.11.2.3.7.4 Table 6-103.",
            "    ; XOUT 30, &R2, BYTECOUNT (R2..R9, 1..32 bytes, LSB-justified).",
            "    ; Caller must have staged payload into R2..R9 before this XOUT.",
            "    xout  30, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "read") {
        return [
            "m_fdb_read .macro RES, BYTECOUNT",
            "    ; FDB Generic Mode read - SPRUIM2J 6.4.11.2.3.7.4 Table 6-103.",
            "    ; XIN 30, &R2, BYTECOUNT (R2..R9, 1..32 bytes). 1 cycle per XFR.",
            "    xin   30, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "set_pattern") {
        return [
            "m_fdb_set_pattern .macro RES, PATTERN_BYTES",
            "    ; FDB Generic Mode set_pattern - SPRUIM2J 6.4.11.2.3.7.4.",
            "    ; XOUT 31, &R2, PATTERN_BYTES (R2..R5, 1..16 bytes).",
            "    xout  31, &R2, PATTERN_BYTES",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "compare_result") {
        return [
            "m_fdb_compare_result .macro RES",
            "    ; FDB Generic Mode compare_result - SPRUIM2J Table 6-105.",
            "    ; XIN 35, &R10, 1 (result of pattern vs currently addressed row).",
            "    ; Must be >=2 cycles after the last pattern/address/data XFR.",
            "    xin   35, &R10, 1",
            "    mov   RES, R10",
            "    .endm"
        ].join("\n");
    }
    throw new Error("Unsupported FDB operation " + op);
}

const fdbGpRamModule = {
    displayName: "FDB Generic RAM (ICSSG, PRU0/PRU1)",
    requiresWidget: ["fdb_gp"],
    defaultInstanceName: "FDB_GP_",
    description: "16 KB FDB generic broadside RAM (512 rows x 32 B, ID 30) + 16-byte pattern compare (IDs 31/35). PRU0/PRU1 only; arbitrated IPC when guarded by XFR2SPIN.",
    longDescription:
        "16 KB of shared 32-byte-wide table memory via the FDB generic broadside path " +
        "(SPRUIM2J 6.4.11.2.3.7.4, Tables 6-103/6-105; BS IDs 30 data/address, 31 pattern, 35 compare_result; " +
        "Table 6-60: 1 cycle per XFR; Table 6-105: 2-cycle hazard before XIN 35). " +
        "512 rows x 32 B are addressed by a 9-bit FDB_Address where R10[8] selects the bank; set_address XOUTs " +
        "R10,2 to ID 30, write/read XFER R2..R9 (1..32 B) on ID 30, set_pattern XOUTs R2..R5 (1..16 B) on ID 31, " +
        "compare_result XINs R10 from ID 35. What the block provides is the table memory plus arbitrated inter-PRU IPC " +
        "when every shared access is guarded by an XFR2SPIN spinlock. " +
        "The compare is NOT a search: it compares the pattern against the CURRENTLY ADDRESSED ROW only. Walking N " +
        "rows costs N x (advance + 2-cycle wait + read) and has NO cycle advantage over four 32-bit register " +
        "compares after a 1-cycle XIN; the hashed search exists only in LUT/bridging mode with Ethernet framing, " +
        "which this block does not implement. MII_G_RT_FDB_GEN_CFG2[7]/[8] must be " +
        "asserted by external initialization for the bank selected by R10[8]. " +
        "GO/NO-GO: the TRM's generic-mode prose and broadside tables describe this path without listing MII port " +
        "configuration as a prerequisite, so the block is offered for non-Ethernet protocols on that reading; the " +
        "TRM is however silent on whether the FDB clock/reset is gated by MII port enables, and this has not been " +
        "proven on silicon - see header comment for exact tables/sections. Maturity is simulator-tested at most.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },

        { name: "operation", displayName: "Operation", default: "set_address", options: [
            { name: "set_address", displayName: "set_address - XOUT R10,2 -> ID 30" },
            { name: "write", displayName: "write - XOUT R2..R9, 1..32 B, ID 30" },
            { name: "read", displayName: "read - XIN R2..R9, 1..32 B, ID 30" },
            { name: "set_pattern", displayName: "set_pattern - XOUT R2..R5, 1..16 B, ID 31" },
            { name: "compare_result", displayName: "compare_result - XIN R10, ID 35 (>=2 cycles after XFR)" }
        ] },

        { name: "fdbAddress", displayName: "FDB Address (0..511, R10[8]=bank)", default: 0,
          description: "9-bit row address. Bit 8 selects the bank (Table 6-103). Bank enable must be asserted." },
        { name: "r10TransferSize", displayName: "R10 XFER size (must be 2)", default: 2,
          description: "Broadside XFER byte count for R10 (set_address). Must be 2 (Table 6-103)." },
        { name: "byteCount", displayName: "Byte count (1..32) for write/read", default: 32,
          description: "Number of bytes to XFER on ID 30 via R2..R9 (1..32, LSB-justified)." },
        { name: "patternBytes", displayName: "Pattern bytes (1..16) for set_pattern", default: 16,
          description: "Number of pattern bytes to XOUT on ID 31 via R2..R5 (1..16)." },
        { name: "fdbGenModeByteEn", displayName: "FDB_GEN_MODE_BYTE_EN (16-bit mask, hex)", default: "0xFFFF",
          description: "Which pattern bytes participate in the compare (bit N enables byte N). Must cover patternBytes." },

        // CFG enables live in MII_G_RT at CFG2 [7] and [8] (SPRUIM2J 6.4.11.2.3.7.4).
        // The TRM does not specify the exact memory offset for CFG2 or confirm clock/reset gating from MII_G_RT.
        // Therefore, this block requires that external initialization (e.g., from R5F/Linux)
        // configures the generic mode and compare-size fields before the PRU uses it.
        { name: "externalInitProvided", displayName: "Acknowledged: External Initialization Required", default: false,
          description: "FDB Generic Mode requires MII_G_RT_FDB_GEN_CFG2[7:8] to be enabled by an external application. Check this to acknowledge." },

        // Sharing intent: when guarded inter-PRU IPC is wanted, the validator demands a spinlock guard
        { name: "sharedAcrossPru", displayName: "Shared PRU0<->PRU1 IPC region", default: false,
          description: "When true, this FDB access is shared between PRU0 and PRU1 and must be guarded by an XFR2SPIN lock in the graph." },
        { name: "protectedRegion", displayName: "Protected region name", default: "fdb_gp_ram",
          description: "XFR2SPIN acquire/release instances must use this same protectsVariable value to guard shared FDB access." },

        { name: "opCode", hidden: true, default: "m_fdb_set_address", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0, getValue: (inst) => {
            // write claims one input for graph ordering (payload already in R2..R9 window)
            if (operationName(inst)==="write") return 1;
            return 0;
        }},
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4 },
        { name: "numOfConstants", hidden: true, default: 3, getValue: (inst) => {
            const op = operationName(inst);
            if (op==="set_address") return 1;
            if (op==="write" || op==="read") return 1;
            if (op==="set_pattern") return 1;
            return 0;
        }},
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => {
            const op = operationName(inst);
            if (op==="set_address") return Number(inst.fdbAddress)||0;
            if (op==="write" || op==="read") return Number(inst.byteCount)||0;
            if (op==="set_pattern") return Number(inst.patternBytes)||0;
            return 0;
        }},
        { name: "constant2", hidden: true, default: 0, getValue: (inst)=> Number(inst.r10TransferSize)||0 },
        { name: "constant3", hidden: true, default: 0, getValue: (inst)=> {
            let m=inst.fdbGenModeByteEn;
            try{ if(typeof m==="string"){m=m.trim(); return m.startsWith("0x")||m.startsWith("0X")?parseInt(m,16):Number(m);} return Number(m);}catch(e){return 0;}
        }},
        { name: "registerClobbers", hidden: true, default: "[]", getValue: (inst) => JSON.stringify(clobbers(inst)) },
        { name: "noOfCycles", displayName: "Peak cycles", default: 1, readOnly: true, getValue: cycleCount }
    ],

    ports: (inst) => {
        const base = [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }];
        if (operationName(inst)==="write") return base.concat([{name:"input1",type:"input32"},{name:"output1",type:"output32"}]);
        return base.concat([{ name: "output1", type: "output32" }]);
    },

    validate,

    getMacro(pruInstructionMacro, requestedOpCode) {
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const op = Object.keys(OPERATIONS).find((o)=> OPERATIONS[o].opCode===name || o===name);
        if (!op) throw new Error("Unsupported FDB macro " + JSON.stringify(name));
        return macroLines(op);
    },

    deviceIds: BS_IDS,
    operations: OPERATIONS,
    trmReference: {
        broadsideIds: "Table 6-60 (FDB IDs 30,31,35, PRU0/PRU1)",
        address: "Table 6-103 (9-bit FDB_Address, R10[8]=bank)",
        hazard: "Table 6-105 (1 cycle per XFR + 2-cycle hazard before XIN 35)",
        genericMode: "6.4.11.2.3.7.4 (FDB Generic Mode - MII_G_RT_FDB_GEN_CFG2[7]/[8] enables and FDB_GEN_MODE_BYTE_EN)",
        goNoGo: "GO with caveat: generic-mode prose/tables do not list MII port config as prerequisite, but TRM is silent on clock/reset gating - not proven on silicon (see header)."
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null
    },
    moduleStatic: {
        modules: function () {
            return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }];
        }
    }
};

exports = fdbGpRamModule;
