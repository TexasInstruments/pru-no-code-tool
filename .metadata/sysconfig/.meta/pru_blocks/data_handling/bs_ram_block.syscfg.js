"use strict";

/*
 * ICSSG Broadside BS RAM — per-core private 2 KB scratch (SPRUIM2J 6.4.6.2.5,
 * Fig 6-49, Tables 6-91/6-92).
 *
 * TRM references and the trap:
 *   SPRUIM2J 6.4.6.2.5 describes BS RAM as a per-core private broadside memory
 *   with a deterministic XOUT/XIN sequence and no other owner. Fig 6-49 shows
 *   the sequence; Tables 6-91/6-92 map the broadside control registers.
 *   The TRM is INTERNALLY INCONSISTENT on the address space:
 *     reading A, PDF p.624 (printed 624), 6.4.6.2.5: "Each PRU core, RTU_PRU
 *       core, and TX_PRU core has a dedicated 2KB Broadside (BS) RAM"
 *       -> 2048 / 32 = 64 rows, row index 0..63.
 *     reading B, PDF p.625 (printed 625), Table 6-92: R10 bits 8-0 RAM_Address
 *       "Index is direct mapping to the 16KB RAM." -> 9 bits = 512 entries
 *       x 32 B = 16 KB. The same table says "Rollovers of RAM_Address are not
 *       supported".
 *   Both are on adjacent pages of one section and cannot both be true. The
 *   "16KB" wording matches the FDB RAM (6.4.6.2.10, 16KB) and may be a
 *   copy-paste from it, but that is a guess, not a TRM statement. The block
 *   keeps the CONSERVATIVE range 0..63 (reading A): rows 64..511 are refused
 *   rather than aliased or invented. Widening it needs a bench, not a reading.
 *   AutoIndex past row 63 is the same class — TRM gives no defined wrap or
 *   fault — and is also refused statically.
 *
 * Broadside IDs (TRM Tables 6-91/6-92, Fig 6-49):
 *   48 (0x30) — BS RAM address + data write (XOUT). R10, 2 bytes selects the
 *               row (R10.w0[5:0] row 0..63); then R2..R9 is the 32-byte row
 *               window. This block's write loads ONLY R2 from its INPUT port,
 *               so write is limited to BYTECOUNT 1..4: a longer XOUT
 *               would send stale R3..R9. ID 48 is the only path that programs the
 *               address; it is XOUT-only for data as well.
 *   48 (0x30) — BS RAM read (XIN) as well as address + data write (XOUT).
 *               After the same 48/R10 address setup, XIN 48, &R2, BYTECOUNT
 *               returns the first BYTECOUNT bytes of the row (the XIN
 *               length is the byteCount config, not a hardcoded 32). Fig 6-49 assigns one ID per core; instruction
 *               direction selects read versus write. Decimal 30 (0x1E) is
 *               RTU_PRU's ID, and on PRU is FDB_Data (Table 6-100), so it
 *               must never be emitted by this PRU/TX_PRU block. XIN source
 *               window is likewise
 *               architecturally R2..R9 and at most 32 bytes.
 *   49 (0x31) — BS RAM + SUM32 snoop (XOUT). Writes the same R2..R9 window to
 *               BS RAM and to the SUM32 accelerator in one XOUT. Snoop is
 *               XOUT-only; an XIN on 49
 *               is a protocol violation, and snoop has no documented TX_PRU
 *               mapping (SPRUIM2J Table 6-93 documents PRU 47/49 and RTU 38/39
 *               but nothing for TX_PRU). TRM Table 6-91 requires a 32 Byte write
 *               here; only R2 comes from INPUT, so the macro zero-fills R3..R9
 * rather than sending stale register contents.
 *
 * Per-core private: each PRU core has its own 2 KB (64 x 32 B). The memory
 *   is not shared between cores and not subject to spinlock/FIFO arbitration;
 *   determinacy comes from that privacy, not from a shared-mutex protocol.
 *   The simulator therefore keeps a per-Simulator (per-core) 64 x 32 B model,
 *   not a per-subsystem table like XFR2SPIN.
 *
 * Register windows are architectural (like BSWAP 0xA1/0xA2 and Stitch FIFO):
 *   R10 for the 2-byte address, R2..R9 for the up-to-32-byte data window.
 *   Declared via registerClobbers and rejected by validateBsRamGlobal if a
 *   live graph value would be overwritten, rather than pre-reserving them in
 *   the allocator.
 *
 * Core and device ID note:
 *   Device ID 48 is the PRU and TX_PRU base-mode mapping for both directions
 *   (Fig 6-49; Table 6-91). RTU_PRU's different mapping is not implemented;
 *   TX_PRU is legal for base write/read but not snoop (Table 6-93).
 *
 * Snoop ownership constraint: sum32_block also owns XOUT 49, but SysConfig
 * blocks cannot invoke another block's getMacro() or reuse its graph ports:
 * SUM32's macro takes a DMEM address and LBBOs it, while this block's input is
 * an already-allocated value. Therefore delegation is not expressible in the
 * current block model; this operation remains a documented duplicate until a
 * shared broadside-macro primitive exists.
 *
 * Cycle count: 1 by house convention (SPRUIM2J 6.4.6.2.5 notes XFR is 1 cycle;
 *   the address + data pair is still counted as 1 in the block's cycle
 *   metadata). Must NOT be promoted above simulator-tested maturity without a
 *   bench; stated explicitly in cycleBasis.
 */

const BS_RAM_SIZE = 2048;
const ROW_BYTES = 32;
const NUM_ROWS = 64; // 2048/32
const ROW_MAX = 63;
const WRITE_MAX_BYTES = 4; // only R2 is loaded from INPUT

const IDS_PRU = { addr: 48, snoop: 49, read: 48 };
// RTU IDs exist in TRM but this block does not implement them — wrong-core ID arm.
const OPERATIONS = ["write", "read", "snoop_write"];

function getCoreType() {
    try {
        const common = system.getScript("/common");
        const coreName = common.getSelfSysCfgCoreName();
        if (coreName && coreName.includes("rtu")) return "RTU_PRU";
        if (coreName && coreName.includes("tx")) return "TX_PRU";
        if (coreName && coreName.includes("pru")) return "PRU";
    } catch (e) { /* test harnesses may stub /common */ }
    return "PRU";
}

function opName(inst) {
    return (inst && inst.operation) || "write";
}
function macroNameFor(op) {
    return "m_bsram_" + op;
}
function opCode(inst) {
    return macroNameFor(opName(inst));
}
function cycleCount() {
    // House convention: 1 cycle (XFR is 1 cycle per SPRUIM2J 6.4.6.2.5). The
    // address XOUT (R10,2) plus the data XOUT/XIN share that one-cycle claim;
    // no bench has measured this sequence, so it must not be used to claim
    // hardware-validated maturity.
    return 1;
}
function clobbers(inst) {
    const op = opName(inst);
    // Address always needs R10 (2 bytes); data needs R2..R9 up to 32 bytes.
    if (op === "read" || op === "write" || op === "snoop_write") return [[10,1],[2,8]];
    return [[10,1]];
}

function validate(inst, report) {
    const op = opName(inst);
    if (OPERATIONS.indexOf(op) === -1) {
        report.logError("BS RAM operation '" + op + "' is not one of " + OPERATIONS.join(", ") + ".", inst, "operation");
        return;
    }

    const core = getCoreType();

    // RTU_PRU has a distinct mapping not implemented by this PRU/TX_PRU
    // block. TX_PRU is legal for the base ID 48 read/write paths (Fig 6-49).
    if (core === "RTU_PRU") {
        report.logError("BS RAM base device ID 48 (0x30) is implemented here for PRU/TX_PRU only (SPRUIM2J Fig 6-49). RTU_PRU has a distinct mapping not implemented by this block; placed core is '" + core + "'.", inst, "operation");
    }

    // snoop on TX_PRU — TX_PRU has no SUM32/BS RAM snoop path (Table 6-93 documents
    // PRU 49 and RTU 39 but nothing for TX_PRU).
    if (op === "snoop_write" && core === "TX_PRU") {
        report.logError("BS RAM snoop (XOUT 49 / 0x31) has no documented TX_PRU mapping (SPRUIM2J Table 6-93 only lists PRU 49 and RTU 39). Snoop on TX_PRU is refused.", inst, "operation");
    }

    // XIN on snoop IDs: snoop is XOUT-only. If the instance claims a snoop
    // operation but would need an XIN (e.g. snoop + read, or a hidden useXin flag),
    // refuse. This arm is exercised by setting inst.snoop && read or via the
    // explicit snoop_read ghost.
    if ((op === "snoop_write" && inst.useXin) || (inst.snoop && op === "read")) {
        report.logError("XIN on snoop device ID 49 (BS RAM + SUM32) is not a defined direction (SPRUIM2J Tables 6-91/6-92: snoop is XOUT 49 only). Snoop is write-only.", inst, "operation");
    }
    if (inst.xinOnSnoop) {
        report.logError("XIN on snoop device ID 49 is not a defined direction (SPRUIM2J Tables 6-91/6-92: snoop is XOUT 49 only).", inst, "operation");
    }

    // address >63: conservative 2KB = 64 rows reading (TRM p.624). Table 6-92 (p.625) says 9-bit / 16KB = 512 rows;
    // the TRM contradicts itself, so 64..511 are refused (see header).
    const row = Number(inst.rowAddress);
    if (inst.rowAddress !== undefined && inst.rowAddress !== null && inst.rowAddress !== "") {
        if (!Number.isInteger(row) || row < 0 || row > ROW_MAX) {
            report.logError("BS RAM row address must be an integer 0.." + ROW_MAX + " (device is 2KB = " + NUM_ROWS + " rows x " + ROW_BYTES + " B; SPRUIM2J 6.4.6.2.5 Fig 6-49; Tables 6-91/6-92. The TRM is inconsistent: 6.4.6.2.5 (PDF p.624) says 2KB, Table 6-92 (PDF p.625) says RAM_Address is 9 bits / 16KB; the conservative 2KB reading is enforced and rows 64..511 are refused rather than aliased). Got '" + inst.rowAddress + "'.", inst, "rowAddress");
        }
    } else if (row !== 0) {
        // Allow default 0 when unset; otherwise require integer check already done.
    }

    // R10 writes that are not exactly 2 bytes: address programming is R10, 2 bytes.
    if (inst.addressBytes !== undefined && Number(inst.addressBytes) !== 2) {
        report.logError("BS RAM address programming is XOUT 48, &R10, 2 (SPRUIM2J Fig 6-49). R10 byte count must be exactly 2, got " + inst.addressBytes + ".", inst, "rowAddress");
    }
    if (inst.addressByteCount !== undefined && Number(inst.addressByteCount) !== 2) {
        report.logError("BS RAM address programming is XOUT 48, &R10, 2 (SPRUIM2J Fig 6-49). R10 byte count must be exactly 2.", inst, "rowAddress");
    }

    // windows outside R2..R9, or larger than 32 B: data window is architecturally
    // R2..R9 (SPRUIM2J Tables 6-91/6-92), at most 32 bytes per row.
    if (inst.dataStartReg !== undefined && Number(inst.dataStartReg) !== 2) {
        report.logError("BS RAM data window is architecturally R2..R9 (SPRUIM2J Tables 6-91/6-92). Start register must be R2, got R" + inst.dataStartReg + ".", inst, "operation");
    }
    if (inst.windowStart !== undefined && Number(inst.windowStart) !== 2) {
        report.logError("BS RAM data window must start at R2 (SPRUIM2J Tables 6-91/6-92).", inst, "operation");
    }
    // byteCount / window size checks
    const bc = inst.byteCount !== undefined ? Number(inst.byteCount) : (inst.windowBytes !== undefined ? Number(inst.windowBytes) : null);
    if (bc !== null && (!Number.isInteger(bc) || bc < 1 || bc > ROW_BYTES)) {
        report.logError("BS RAM row is " + ROW_BYTES + " bytes (2KB / " + NUM_ROWS + " rows). Window larger than " + ROW_BYTES + " B would alias onto the next row. Got " + inst.byteCount + ".", inst, "operation");
    }
    // The write macro loads only R2 (4 bytes) from INPUT. A longer XOUT 48 would transfer R3..R9 too, which hold whatever
    // the surrounding program left there. Refused rather than loading R3..R9 from an undeclared source.
    if (op === "write" && bc !== null && Number.isInteger(bc) && bc > WRITE_MAX_BYTES) {
        report.logError("BS RAM write loads only R2 (4 bytes) from its input, so Bytes must be 1.." + WRITE_MAX_BYTES + " for write; got " + inst.byteCount + ". A longer XOUT 48 would send stale R3..R9. Use snoop write (32 Byte, R3..R9 zero-filled) for a full row.", inst, "byteCount");
    }
    // SPRUIM2J 6.4.6.2.5 "BS RAM + SUM32 snoop mode": "This mode requires a 32 Byte write."
    // Refused rather than forced to 32: silently rewriting the user's byteCount would hide the mistake and change what the design transfers.
    if (op === "snoop_write" && bc !== null && bc !== ROW_BYTES) {
        report.logError("BS RAM snoop write (XOUT 49) requires a 32 Byte write (SPRUIM2J 6.4.6.2.5 BS RAM + SUM32 snoop mode, Table 6-91). Bytes must be 32, got " + inst.byteCount + ".", inst, "byteCount");
    }
    if (inst.dataByteCount !== undefined && Number(inst.dataByteCount) > ROW_BYTES) {
        report.logError("BS RAM row is " + ROW_BYTES + " bytes; window larger than " + ROW_BYTES + " B is refused.", inst, "operation");
    }

    // AutoIndex running past row 63: TRM is silent on wrap vs fault; refuse.
    if (inst.autoIndex) {
        const count = inst.autoCount !== undefined ? Number(inst.autoCount) : (inst.burstRows !== undefined ? Number(inst.burstRows) : 1);
        const start = Number(row);
        if (Number.isInteger(start) && Number.isInteger(count) && count >= 1) {
            if (start + count - 1 > ROW_MAX) {
                report.logError("BS RAM AutoIndex from row " + start + " for " + count + " row(s) would run past row " + ROW_MAX + " (device is 2KB = 64 rows). The TRM is silent on AutoIndex past the end (no defined wrap or fault); refused statically.", inst, "rowAddress");
            }
        }
    }
    // Also catch single-step autoIndex that would overflow by 1
    if (inst.autoIncrement && Number.isInteger(row) && row >= ROW_MAX) {
        report.logError("BS RAM AutoIndex at row " + row + " would advance past row " + ROW_MAX + "; TRM is silent on this overflow and it is refused.", inst, "rowAddress");
    }
}

function macroLines(op, macroName) {
    macroName = macroName || macroNameFor(op);
    if (op === "write") {
        return [
            macroName + " .macro RES, INPUT, ROW, BYTECOUNT",
            "    ; ICSSG BS RAM write — SPRUIM2J 6.4.6.2.5 Fig 6-49, Tables 6-91/6-92.",
            "    ; Device is 2KB = 64 rows x 32 B; ROW 0..63 (TRM p.624 vs Table 6-92 p.625 disagree; conservative range).",
            "    ; Address is programmed via R10 (2 bytes). Only R2 is loaded from INPUT, so BYTECOUNT is 1..4 (validate()).",
            "    ldi   R10.w0, ROW",
            "    xout  48, &R10, 2",
            "    mov   R2, INPUT",
            "    xout  48, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "snoop_write") {
        return [
            macroName + " .macro RES, INPUT, ROW, BYTECOUNT",
            "    ; ICSSG BS RAM + SUM32 snoop write — SPRUIM2J 6.4.6.2.5/6.4.6.2.6 Tables 6-91/6-93: device 49 (0x31).",
            "    ; Table 6-91 requires a 32 Byte write: only R2 is INPUT, so zero R3..R9 instead of sending stale registers.",
            "    ; Also writes BS RAM; TRM 6.4.6.2.5: same R10 address + R2..R9 window as direct write.",
            "    ldi   R10.w0, ROW",
            "    xout  48, &R10, 2",
            "    mov   R2, INPUT",
            "    zero  &R3, 28",
            "    xout  49, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "read") {
        return [
            macroName + " .macro RES, ROW, BYTECOUNT",
            "    ; ICSSG BS RAM read — SPRUIM2J 6.4.6.2.5 Fig 6-49: XIN 48 (0x30).",
            "    ; Address via R10 (2 bytes), data via R2..R9; XIN length is BYTECOUNT (1..32), RES gets R2 (first 4 bytes).",
            "    ldi   R10.w0, ROW",
            "    xout  48, &R10, 2",
            "    xin   48, &R2, BYTECOUNT",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    throw new Error("Unsupported BS RAM operation " + op);
}

const bsRamModule = {
    displayName: "BS RAM (ICSSG Broadside RAM)",
    requiresWidget: ["bs_ram"],
    defaultInstanceName: "BSRAM_",
    description: "Per-core private 2KB broadside RAM (XOUT/XIN 48; snoop XOUT 49): address via R10, data via R2..R9.",
    longDescription:
        "Wraps the ICSSG per-core private 2KB BS RAM (SPRUIM2J 6.4.6.2.5, Fig 6-49, Tables 6-91/6-92): " +
        "64 rows x 32 B, row 0..63. The TRM is internally inconsistent on the address space: " +
        "6.4.6.2.5 (PDF p.624) says each core has a dedicated 2KB BS RAM (2048/32 = 64 rows), while " +
        "Table 6-92 (PDF p.625) gives R10 RAM_Address as bits 8-0 (512 entries) mapped to a '16KB RAM'. " +
        "This block enforces the conservative 2KB reading, so a row address >63 is a build error. Sequences are deterministic XOUT/XIN with no other owner. " +
        "Address is programmed via R10 (exactly 2 bytes, XOUT 48); data is via R2..R9 " +
        "(XOUT/XIN 48 for direct read/write, 49 for BS RAM+SUM32 snoop). Write loads only R2 from its " +
        "input, so write is limited to 1..4 bytes; read honours Bytes as the XIN length (1..32); snoop " +
        "requires 32 Bytes (Table 6-91) and zero-fills R3..R9. Snoop is XOUT-only " +
        "(XIN on snoop is refused) and has no TX_PRU mapping. AutoIndex past row 63 and addresses " +
        "64..511 are refused statically — the TRM is silent on them and no behaviour is invented. " +
        "R10 and R2..R9 are architectural windows declared via registerClobbers and rejected if a " +
        "live value would be overwritten. Cycle count is 1 by house convention (SPRUIM2J 6.4.6.2.5: " +
        "XFR is 1 cycle) and must not promote maturity above simulator-tested without a bench. " +
        "Default Bytes changed 32 -> 4; a saved Snoop Write that used the old default must set Bytes = 32. " +
        "Available only on ICSSG (AM64x/AM243x), PRU0/PRU1 cores.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "assembles", hidden: true,
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}] },
        { name: "operation", displayName: "Operation", default: "write", options: [
            { name: "write", displayName: "Write (XOUT 48, &R2, 1..4 Bytes)" },
            { name: "read", displayName: "Read (XIN 48, &R2, Bytes)" },
            { name: "snoop_write", displayName: "Snoop write (XOUT 49, BS RAM+SUM32)" }
        ] },
        { name: "rowAddress", displayName: "Row Address (0..63)", default: 0, description: "BS RAM row 0..63 (2KB = 64 x 32B, TRM p.624). Table 6-92 (p.625) says 9-bit / 16KB; the TRM is inconsistent, so rows 64..511 are refused." },
        { name: "byteCount", displayName: "Bytes", default: 4, description: "Bytes from R2 up. Write: 1..4. Read: 1..32 (XIN length). Snoop write: exactly 32 (R3..R9 zero-filled).", longDescription: "Transfer size in bytes, starting at R2 (R2..R9). Write: 1..4 (only R2 is loaded from the input). Read: 1..32 (XIN length). Snoop write: must be exactly 32 (SPRUIM2J Table 6-91; R3..R9 are zero-filled)." },
        { name: "autoIndex", displayName: "AutoIndex", description: "Increment the row after each transfer.", default: false },
        { name: "autoCount", displayName: "AutoIndex Burst Rows", default: 1, description: "When AutoIndex is on, number of sequential rows. Refused if row+count-1 >63." },

        // Hidden knobs used only to exercise the 7 validator arms via direct instance mutation in tests.
        // They are not part of the palette but are validated if present.
        { name: "addressBytes", hidden: true, default: 2 },
        { name: "dataStartReg", hidden: true, default: 2 },

        // Macro call order is RES, input1.., constant1.. (pru_register_allocator): INPUT precedes ROW and BYTECOUNT.
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => Number(inst.rowAddress) },
        { name: "constant2", hidden: true, default: 4, getValue: (inst) => Number(inst.byteCount) },
        { name: "opCode", hidden: true, default: "m_bsram_write", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0, getValue: (inst) => inst.operation === "write" || inst.operation === "snoop_write" ? 1 : 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0, getValue: (inst) => inst.operation === "read" ? 1 : 1 },
        { name: "numOfConstants", hidden: true, default: 2, getValue: () => 2 },
        { name: "output1Size", hidden: true, default: 4 },
        { name: "registerClobbers", hidden: true, default: "[]", getValue: (inst) => JSON.stringify(clobbers(inst)) },
        { name: "noOfCycles", displayName: "Peak Cycles", default: 1, readOnly: true, getValue: cycleCount }
    ],

    ports: (inst) => {
        const base = [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }];
        const op = opName(inst);
        if (op === "read") return base.concat([{ name: "output1", type: "output32" }]);
        return base.concat([{ name: "input1", type: "input32" }]);
    },

    validate,

    getMacro(pruInstructionMacro, requestedOpCode) {
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const op = Object.keys({write:1,read:1,snoop_write:1}).find((k) => macroNameFor(k) === name || k === name) || opName({operation: name.replace("m_bsram_","")});
        if (OPERATIONS.indexOf(op) === -1) throw new Error("Unsupported BS RAM macro " + name);
        return macroLines(op, name);
    },

    // Machine-readable metadata (instruction-count claim, not hardware bench).
    numRows: NUM_ROWS,
    rowBytes: ROW_BYTES,
    deviceSizeBytes: BS_RAM_SIZE,
    deviceIds: IDS_PRU,
    cycleBasis: {
        write: { peakCycles: 1, basis: "House convention: 1 cycle per XFR (SPRUIM2J 6.4.6.2.5). Address XOUT R10,2 plus data XOUT R2,32 counted as one broadside transaction." },
        read: { peakCycles: 1, basis: "House convention: 1 cycle per XFR (SPRUIM2J 6.4.6.2.5). Address XOUT R10,2 plus data XIN R2,BYTECOUNT counted as one broadside transaction." },
        snoop_write: { peakCycles: 1, basis: "House convention: 1 cycle per XFR. Address XOUT R10,2 plus snoop XOUT R2,32 (device 49) counted as one." }
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null
    },
    moduleStatic: { modules: function() { return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }]; } }
};

exports = bsRamModule;
