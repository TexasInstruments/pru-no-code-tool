"use strict";

/*
 * RTU_PRU XFR2TR ring accelerator.
 *
 * References: SPRUIM2J 6.4.6.3.3 "PRU_ICSSG XFR2TR Ring Accelerator" and Table
 * 6-112 "RTU_PRU to XFR2TR Ring Interface". One ring is attached to each
 * RTU_PRU core; it accelerates a local Data RAM2 copy from a preconfigured
 * source TR list to a destination ring, driven by XOUT-submitted TR IDs.
 *
 * Table 6-112, read literally (this is the only authority used here):
 *   R6[17:0] 0x70 XOUT  tr_msrc_base       (needs mode 0x4)
 *   R7[0]    0x70 XOUT  tr_size            0=8B, 1=64B
 *   R6[17:0] 0x71 XOUT  tr_rsrc_base       (needs mode 0x40 or 0x08)
 *   R7[1]    0x71 XOUT  tr_rscr_reset      resets the ring write pointer
 *   R7[19:8] 0x71 XOUT  tr_rsrc_nums       ring size - 1 (0=1 TR .. 4095=4096 TRs)
 *   R7[0]    0x71 XIN   tr_rsrc_busy       0=not busy, 1=busy
 *   R7[11:8] 0x71 XIN   tr_rscr_fifo_occ   submit FIFO occupancy (0..8)
 *   R8[17:0] 0x71 XIN   tr_rsrc_wrt_ptr    current ring write pointer
 *   R5:R2    0x72 XOUT  packed TR IDs, 12 bits each, 2 bytes/ID, left packed,
 *                       no holes: R2[11:0]=ID0, R2[27:16]=ID1, R3[11:0]=ID2, ...
 *
 * So 0x70 is XOUT-only (source config), 0x71 is XOUT (ring config) + XIN
 * (status) on the SAME broadside ID, and 0x72 is XOUT-only (submit). There is
 * no fourth documented direction; XIN on 0x70/0x72 and XOUT-as-submit-replay
 * on 0x71 are simply not part of the interface and are recorded as unsupported
 * rather than given invented behaviour.
 *
 * Register windows are architectural per operation (never the full R2:R8
 * span every time): configure only ever touches R6:R7 (twice, for 0x70 then
 * 0x71); status touches R7:R8; submit touches R2:R5. Each operation declares
 * only the window it actually writes, and pru_blocks_static_module rejects a
 * design that holds a live graph value inside that window across the call
 * (same pattern as BSWAP's fixed-window clobber check).
 *
 * Dataflow: configure/status have no hardware payload to route (their fields
 * are compile-time ring/source geometry, matching the TRM's own worked
 * example which submits a literal ID sequence, not a computed one) so they
 * declare no input port, rather than threading an input through a MOV that
 * does not feed the hardware. submit is the one operation with a real
 * payload — the up-to-4 packed ID words — and that payload is routed through
 * four real input ports (input1..input4 -> R2..R5), so the allocator's own
 * producer registers are what XOUT actually submits; nothing is hard-coded.
 *
 * ID 0 is a valid TR ID (Table 6-112: R2[11:0]=ID0), not a hole/sentinel;
 * the TRM's own example is `XOUT 0,1,2,6,3` where the ring itself is fixed.
 *
 * No doorbell: the TRM documents no doorbell register for XFR2TR. Submission
 * is the XOUT 0x72 itself; firmware must not expect a separate trigger write.
 * No hardware ring completion: hardware does not signal completion via an
 * interrupt or a "done" bit that self-clears on ring wrap. Firmware polls
 * tr_rsrc_busy / tr_rscr_fifo_occ / tr_rsrc_wrt_ptr via XIN 0x71 (status op)
 * to observe progress. The simulator's drain (Simulator.XFR2TR_DRAIN_PERIOD_CYCLES)
 * is a pacing model, not a hardware timing claim. Nothing in this block
 * invents a doorbell or a completion interrupt that Table 6-112 does not list.
 *
 * Memory placement: R6[17:0] is 18 bits (0..0x3FFFF). Larger
 * values truncate in hardware; this block refuses them at build time instead
 * of silently aliasing inside the window. Furthermore, the source TR list
 * (tr_msrc_base) and the destination ring (tr_rsrc_base) must reside inside
 * PRU_ICSSG Shared RAM / Data RAM2 — the only RAM the RTU_PRU local copy
 * engine can address without a system-level path. In the local view
 * (SPRACJ8 Migration Guide / SPRUIM2J local map) Shared Data RAM 2 starts at
 * 0x0001_0000; the simulator's SMEM models 64 KB there (0x00010000-0x0001FFFF
 * on AM64x/AM243x). Bases outside that window, or bases whose
 * base+entries*trSize extent would leave the window (or exceed the 4 KB
 * source-TR ceiling below), are build errors.
 *
 * 4 KB source-TR ceiling: the source TR list that the ring
 * copies from is capped at 4 KB (4096 bytes). Table 6-112 has no register
 * that carries a source-list length — the only length register is
 * tr_rsrc_nums, which sizes the DESTINATION ring (1..4096 entries) and is a
 * completely separate object from the SOURCE list the 4 KB ceiling
 * constrains. So the ceiling is checked as sourceTrCount*trSize<=4096, where
 * sourceTrCount is a build-time-only bookkeeping field (when omitted it
 * takes DEFAULT_SOURCE_TR_COUNT, the same literal the UI declares) — NOT as
 * ringEntries*trSize<=4096, which would wrongly reject a 4096-entry ring
 * (the TRM's own documented maximum) whenever it paired with an 8-byte
 * tr_size. ringEntries keeps its own independent 1..4096 range check with no
 * byte ceiling attached; sourceTrCount's extent still has to fit inside
 * Data RAM2/Shared like every other sourceBase check.
 *
 * Maturity is "simulator-tested": the emitted macro is executed against a
 * TRM-derived device model in scripts/simulator.js, which also models the
 * 8-level submit FIFO (blocking/hold without replaying the XOUT side effect,
 * and drain/progress so a wait-for-busy poll is not a livelock). That model
 * was written from the same TRM section as this block, so it is not an
 * independent oracle and this is not a silicon-correlation claim. Following
 * the BSWAP precedent, this device model lives only in
 * scripts/simulator.js (the engine the acceptance test exercises); the
 * separate .metadata/.../simulation/pru_core.js engine is left untouched
 * rather than shipping a second, untested copy of the same logic.
 */

const OPERATIONS = ["configure", "submit", "status"];

// The source TR list length has ONE default, used by both the declared
// SysConfig config default below and validate()'s omitted-field path.
// Defaulting the omitted path to ringEntries while the UI declares a literal
// 16 would give a programmatic caller and a real design two different answers
// from the same block (and would make a 4096-entry ring with trSize=8 a hard
// build error, the over-rejection the sourceTrCount field exists to remove).
// One constant, both paths.
const DEFAULT_SOURCE_TR_COUNT = 16;

function operationName(inst) {
    const op = (inst && inst.operation) || "configure";
    return OPERATIONS.indexOf(op) !== -1 ? op : "configure";
}
function macroNameFor(op) { return "m_xfr2tr_" + op; }
function opCode(inst) { return macroNameFor(operationName(inst)); }

// Table 6-112: tr_rsrc_nums is the ring size MINUS ONE (0 = 1 TR .. 4095 = 4096 TRs).
function rawNums(inst) {
    const entries = Number(inst.ringEntries);
    return Number.isInteger(entries) && entries >= 1 && entries <= 4096 ? entries - 1 : 0;
}
// Table 6-112: each submitted ID is a 12-bit field in a 2-byte (16-bit) slot,
// left packed with no holes -- 1 ID needs 2 bytes, 8 IDs need 16 bytes. There
// is no 4-byte/register rounding: a 3-ID submit is a real 6-byte XOUT.
function submitBytes(inst) {
    const count = Number(inst.submitCount);
    const n = Number.isInteger(count) && count >= 1 && count <= 8 ? count : 1;
    return n * 2;
}

function getCoreType() {
    try {
        const common = system.getScript("/common");
        const raw = common.getSelfSysCfgCoreName();
        const coreName = (raw || "").toLowerCase();
        // coreName.includes("rtu") would be a loose substring check — it matches "artu", "virtual", "myrtu_device"
        // and any future core name that merely contains those three letters.
        // Tighten to the documented token "_rtu_pru" / "_tx_pru" (SPRACJ8 /
        // pru_blocks_am64x.syscfg.js uses includes("rtu") discrimination for the
        // same reason; here we require the underscored form, which correctly
        // distinguishes "icss_g0_rtu_pru0" from "icss_g0_artu_pru0").
        if (coreName && coreName.includes("_rtu_pru")) return "RTU_PRU";
        if (coreName && coreName.includes("_tx_pru")) return "TX_PRU";
        if (coreName && coreName.includes("pru")) return "PRU";
    } catch (e) { /* reduced test harnesses may not provide /common */ }
    return "PRU";
}

// Peak-cycle estimates are an emitted-instruction-count claim, not a hardware
// timing benchmark (same caveat as cycleEvidence). submit is the
// one operation that can genuinely block -- Table 6-112's FIFO is 8 levels
// deep and a full-FIFO submit holds until the ring drains -- so its bound is
// declared unknown (-1) rather than a fixed count that ignores backpressure.
function cycles(inst) {
    const op = operationName(inst);
    if (op === "submit") return -1;
    if (op === "status") return 2;   // xin 113,&R7,8 ; mov RES,R7
    return 7;                        // configure: 2x(ldi32 x2 + xout) + ldi RES
}

// configure only ever writes R6:R7 (twice, for 0x70 then 0x71); status reads
// into R7:R8; submit writes R2:R5. Declaring the narrow per-operation window
// (rather than a blanket R2:R8) means the live-value rejection in
// pru_blocks_static_module only fires for a design that actually collides
// with what this specific instance touches.
function clobbers(inst) {
    const op = operationName(inst);
    if (op === "submit") return [[2, 4]];
    if (op === "status") return [[7, 2]];
    return [[6, 2]];
}

function macroText(op) {
    if (op === "configure") {
        return [
            macroNameFor(op) + " .macro RES, SRC_BASE, TR_SIZE, RING_BASE, RING_NUMS, RESET",
            "    ; Table 6-112 BS ID 0x70 XOUT: R6[17:0]=tr_msrc_base, R7[0]=tr_size (0=8B,1=64B).",
            "    ldi32 R6, SRC_BASE",
            "    ldi32 R7, TR_SIZE",
            "    xout  112, &R6, 8",
            "    ; BS ID 0x71 XOUT: R6[17:0]=tr_rsrc_base, R7[19:8]=tr_rsrc_nums (ring size - 1), R7[1]=tr_rscr_reset.",
            "    ldi32 R6, RING_BASE",
            "    ldi32 R7, ((RING_NUMS << 8) | (RESET << 1))",
            "    xout  113, &R6, 8",
            "    ldi   RES, 1",
            "    .endm"
        ].join("\n");
    }
    if (op === "submit") {
        return [
            macroNameFor(op) + " .macro RES, IN1, IN2, IN3, IN4, SUBMIT_BYTES",
            "    ; Table 6-112 BS ID 0x72 XOUT: R5:R2 packed TR IDs, 2 bytes/ID, left packed, no holes.",
            "    ; IN1..IN4 are the allocator's own producer registers for R2..R5; only the first",
            "    ; SUBMIT_BYTES bytes of R2..R5 are actually latched by the accelerator.",
            "    mov   R2, IN1",
            "    mov   R3, IN2",
            "    mov   R4, IN3",
            "    mov   R5, IN4",
            "    xout  114, &R2, SUBMIT_BYTES",
            "    mov   RES, R2",
            "    .endm"
        ].join("\n");
    }
    if (op === "status") {
        return [
            macroNameFor(op) + " .macro RES",
            "    ; Table 6-112 BS ID 0x71 XIN: R7[0]=tr_rsrc_busy, R7[11:8]=tr_rscr_fifo_occ, R8[17:0]=tr_rsrc_wrt_ptr.",
            "    xin   113, &R7, 8",
            "    mov   RES, R7",
            "    .endm"
        ].join("\n");
    }
    throw new Error("Unsupported XFR2TR operation " + op);
}

function validate(inst, report) {
    const op = operationName(inst);
    if (inst && inst.operation && OPERATIONS.indexOf(inst.operation) === -1) {
        report.logError(
            "XFR2TR operation '" + inst.operation + "' is not one of Table 6-112's flows: " + OPERATIONS.join(", "),
            inst, "operation");
        return;
    }

    const core = getCoreType();
    if (core !== "RTU_PRU") {
        report.logError(
            "XFR2TR is attached to the RTU_PRU cores only (SPRUIM2J 6.4.6.3.3); placed core is '" + core + "'",
            inst, "operation");
    }

    if (op === "configure") {
        const entries = Number(inst.ringEntries);
        if (!Number.isInteger(entries) || entries < 1 || entries > 4096) {
            report.logError(
                "ringEntries must be an integer 1..4096 (Table 6-112 tr_rsrc_nums encodes ring size - 1)",
                inst, "ringEntries");
        }
        const trSize = Number(inst.trSize);
        if (trSize !== 8 && trSize !== 64) {
            report.logError("trSize must be 8 or 64 bytes (Table 6-112 tr_size)", inst, "trSize");
        }

        // 4 KB source-TR ceiling applies to
        // the SOURCE TR list (tr_msrc_base), not to the destination ring.
        // Table 6-112 has no source-list-length register — tr_rsrc_nums sizes
        // the ring only — so sourceTrCount is a build-time-only bookkeeping
        // field, independent of ringEntries, that says how many TR
        // descriptors actually live at sourceBase. When omitted it takes the
        // single DEFAULT_SOURCE_TR_COUNT above -- the same literal the UI
        // declares -- so the programmatic and SysConfig paths cannot disagree.
        // Using ringEntries*trSize directly would make a 4096-entry ring
        // (Table 6-112's own maximum, legal per the range check just above) a
        // hard build error whenever trSize=8 — contradicting this validator. ringEntries itself
        // carries no byte ceiling: only sourceTrCount does.
        const sourceTrCountRaw = inst.sourceTrCount;
        const sourceTrCountGiven = !(sourceTrCountRaw === undefined || sourceTrCountRaw === null);
        const sourceTrCount = sourceTrCountGiven ? Number(sourceTrCountRaw) : DEFAULT_SOURCE_TR_COUNT;
        const sourceCountValid = Number.isInteger(sourceTrCount) && sourceTrCount >= 1 && sourceTrCount <= 4096;
        if (sourceTrCountGiven && !sourceCountValid) {
            report.logError(
                "sourceTrCount must be an integer 1..4096 (number of TR descriptors physically present at sourceBase)",
                inst, "sourceTrCount");
        } else if (sourceCountValid && (trSize === 8 || trSize === 64)) {
            const total = sourceTrCount * trSize;
            if (total > 4096) {
                report.logError(
                    "sourceTrCount*trSize=" + total + " exceeds the 4 KB source-TR ceiling (SPRUIM2J 6.4.6.3.3; max 4096 bytes: 512x8B or 64x64B). " +
                    "This constrains the source TR list at sourceBase, not the destination ring (ringEntries, which may independently be up to 4096).",
                    inst, "sourceTrCount");
            }
        }

        // sourceBase/ringBase must fit in 18 bits and must lie
        // inside PRU_ICSSG Shared RAM / Data RAM2. Larger values would truncate
        // via R6[17:0] and silently alias inside the window, so they are refused.
        // Local view: Shared Data RAM 2 at 0x0001_0000, 64 KB on AM64x/AM243x
        // (SPRACJ8 Migration Guide; simulator SMEM 0x00010000-0x0001FFFF).
        const MAX_18 = 0x3FFFF;
        const SHARED_BASE = 0x00010000;
        const SHARED_END = 0x0001FFFF;
        // each base owns a DIFFERENT length. The
        // source TR list at sourceBase is sourceTrCount descriptors long; the
        // destination ring at ringBase is ringEntries descriptors long. Sizing
        // both regions off ringEntries -- as this function did while
        // sourceTrCount could already diverge from it -- lets a design whose
        // source list physically contains the ring, or runs off the end of
        // Shared RAM, validate clean. `count`/`countField` name the length that
        // actually governs the region being checked.
        function checkBase(name, field, count, countField) {
            // SysConfig fills defaults (0x10000/0x10800) before validate in the UI;
            // the legacy tests call validate with only ringEntries/trSize,
            // so missing bases are treated as "default-provided" and not flagged.
            if (inst[field] === undefined || inst[field] === null) return;
            const v = Number(inst[field]);
            if (!Number.isInteger(v) || v < 0 || v > MAX_18) {
                report.logError(
                    name + " must be an integer 0..0x3FFFF (R6[17:0], 18 bits) — larger values would truncate past bit 17 and alias inside the window (Table 6-112 R6[17:0] tr_msrc/tr_rsrc_base)",
                    inst, field);
                return;
            }
            // Must be inside PRU_ICSSG Shared RAM / Data RAM2 window.
            if (v < SHARED_BASE || v > SHARED_END) {
                report.logError(
                    name + " 0x" + v.toString(16) + " is outside PRU_ICSSG Shared RAM / Data RAM2 (0x00010000-0x0001FFFF per SPRUIM2J local map 0x0001_0000 Shared Data RAM 2; SPRACJ8). The RTU_PRU local copy engine cannot address that window.",
                    inst, field);
                return;
            }
            // Alignment: TRs are 8 or 64 bytes, so base must be aligned.
            const align = (trSize === 64 ? 64 : (trSize === 8 ? 8 : 0));
            if (align && v % align !== 0) {
                report.logError(
                    name + " 0x" + v.toString(16) + " must be " + align + "-byte aligned for trSize=" + trSize + " (Table 6-112 tr_msrc_base/tr_rsrc_base are TR-aligned)",
                    inst, field);
            }
            // Extent must stay inside the window, measured with THIS region's
            // own descriptor count (sourceTrCount for sourceBase, ringEntries
            // for ringBase).
            if (Number.isInteger(count) && count >= 1 && count <= 4096 && (trSize === 8 || trSize === 64)) {
                const extent = v + count * trSize - 1;
                if (extent > SHARED_END) {
                    report.logError(
                        name + " region 0x" + v.toString(16) + " + " + countField + "=" + count + "*" + trSize + "B = 0x" + extent.toString(16) + " exceeds PRU_ICSSG Shared/Data2 window end 0x" + SHARED_END.toString(16) + " (would wrap/alias outside local RAM)",
                        inst, field);
                }
            }
        }
        // Only run when trSize is sane; otherwise the alignment/ceiling messages would be noise.
        if (trSize === 8 || trSize === 64) {
            checkBase("sourceBase", "sourceBase", sourceTrCount, "sourceTrCount");
            checkBase("ringBase", "ringBase", entries, "ringEntries");
            // Distinctness: source and ring must not overlap (they are separate windows).
            // As in checkBase: the source list spans
            // sourceTrCount descriptors and the ring spans ringEntries, so
            // sizing both off ringEntries would miss an overlap whenever the
            // two counts diverge (e.g. a 512-entry source list under a
            // 16-entry ring reads clean while it runs straight through it).
            if (sourceCountValid && Number.isInteger(entries) && entries >= 1 && entries <= 4096) {
                const s = Number(inst.sourceBase);
                const r = Number(inst.ringBase);
                if (Number.isInteger(s) && Number.isInteger(r) && s >= SHARED_BASE && s <= SHARED_END && r >= SHARED_BASE && r <= SHARED_END) {
                    const sEnd = s + sourceTrCount * trSize;
                    const rEnd = r + entries * trSize;
                    const overlap = !(sEnd <= r || rEnd <= s);
                    if (overlap && s !== r) {
                        // Overlapping but not identical — identical is allowed only when ringEntries*trSize covers same slice? We still warn as overlap would corrupt.
                        // Keep as error: TR list and ring are separate copies; overlapping extents alias.
                        // If bases are equal, that's definitely overlap (same window) — also an error unless entries*trSize==0.
                        report.logError(
                            "sourceBase 0x" + s.toString(16) + " (sourceTrCount=" + sourceTrCount + "*" + trSize + "B) and ringBase 0x" + r.toString(16) + " (ringEntries=" + entries + "*" + trSize + "B) regions overlap — the source TR list and destination ring must be disjoint inside Shared/Data2",
                            inst, "ringBase");
                    } else if (s === r) {
                        report.logError(
                            "sourceBase and ringBase must be distinct (both 0x" + s.toString(16) + ") — the source TR list and destination ring cannot share the same base",
                            inst, "ringBase");
                    }
                }
            }
        }
    }

    if (op === "submit") {
        const count = Number(inst.submitCount);
        if (!Number.isInteger(count) || count < 1 || count > 8) {
            report.logError(
                "submitCount must be an integer 1..8 (Table 6-112: up to 8 IDs per XOUT; ID 0 is a valid TR ID, not a hole)",
                inst, "submitCount");
            return;
        }

        // Item ask: "a hole in the left-packed ID list is a build error."
        //
        // Table 6-112 packs two 12-bit IDs per 32-bit word with no holes and
        // no offsets, and the macro latches only the first submitCount*2
        // bytes of R2:R5 -- so an N-ID submit consumes exactly
        // ceil(N/2) words, fed by input1..input{ceil(N/2)}.
        //
        // Two design shapes are holes, and both are invisible at runtime
        // because the hardware has no way to report either:
        //
        //   - a REQUIRED input port left unconnected. R2..R5 are the
        //     allocator's producer registers; an unconnected port means that
        //     word is never written, so a stale register value is submitted
        //     as a TR ID in the middle of the list.
        //   - a port connected BEYOND the last latched word. The producer
        //     believes its ID is queued; XOUT never reads that far, so the
        //     ID is silently dropped and the list is short.
        //
        // Port connectivity is only inspected when the caller actually
        // supplied port arrays. The legacy tests call validate()
        // with bare field objects and no graph, and a design's ports are
        // always arrays in SysConfig, so "no port key is an array" means
        // "no connectivity information was provided", not "nothing is
        // connected" -- exactly how the missing-base case is treated above.
        const PORTS = ["input1", "input2", "input3", "input4"];
        const portsDescribed = PORTS.some((name) => Array.isArray(inst[name]));
        if (portsDescribed) {
            const wordsLatched = Math.ceil(count / 2);
            for (let i = 0; i < PORTS.length; i++) {
                const name = PORTS[i];
                const wired = Array.isArray(inst[name]) && inst[name].length > 0;
                const needed = i < wordsLatched;
                if (needed && !wired) {
                    report.logError(
                        "submitCount=" + count + " latches " + (count * 2) + " bytes = " + wordsLatched +
                        " word(s) of R2:R5, so " + name + " (R" + (2 + i) + ") carries TR ID" + (2 * i) +
                        (2 * i + 1 < count ? "/ID" + (2 * i + 1) : "") + " and must be connected. " +
                        "Leaving it unconnected puts a hole in the left-packed ID list (Table 6-112 packs two " +
                        "12-bit IDs per word with no holes or offsets): a stale R" + (2 + i) +
                        " is submitted as a live TR ID and no hardware status reports it.",
                        inst, name);
                } else if (!needed && wired) {
                    report.logError(
                        name + " (R" + (2 + i) + ") is connected but submitCount=" + count + " latches only " +
                        (count * 2) + " bytes = " + wordsLatched + " word(s) of R2:R5, so XOUT 0x72 never reads it. " +
                        "The ID it produces is silently dropped. Raise submitCount to " + ((i + 1) * 2 - 1) +
                        " or more, or disconnect " + name + ".",
                        inst, name);
                }
            }
        }
    }
}

const xfr2trModule = {
    displayName: "XFR2TR Ring Accelerator (RTU_PRU)",
    requiresWidget: ["xfr2tr"],
    defaultInstanceName: "XFR2TR_",
    description: "RTU_PRU XFR2TR transfer-request ring accelerator (SPRUIM2J 6.4.6.3.3, Table 6-112).",
    longDescription:
        "Local Data RAM2 copy accelerator attached to each RTU_PRU core (SPRUIM2J 6.4.6.3.3). " +
        "'configure' XOUTs BS ID 0x70 (source TR list base + TR size) then BS ID 0x71 (ring base, " +
        "ring size - 1, reset). 'submit' XOUTs up to 8 packed TR IDs to BS ID 0x72 through four real " +
        "input ports (R2:R5); ID 0 is a valid TR ID, not a hole. 'status' XINs BS ID 0x71 for " +
        "busy/FIFO-occupancy/write-pointer. Each operation declares only the R-register window Table " +
        "6-112 says it touches, and a design holding a live value in that window across the call is " +
        "rejected at build time (same pattern as BSWAP). The submit FIFO is 8 levels deep " +
        "(Table 6-112); scripts/simulator.js models that capacity, so a submit beyond capacity holds " +
        "without replaying the XOUT side effect until the ring drains. No doorbell: Table 6-112 lists no doorbell register; submission is the XOUT 0x72 itself. " +
        "No hardware ring completion: hardware does not issue an interrupt or a self-clearing done bit on wrap; firmware must poll busy/fifo_occ/wrt_ptr via the status XIN. " +
        "Bases are R6[17:0] (18 bits, 0..0x3FFFF) and must lie inside PRU_ICSSG Shared RAM / Data RAM2 (0x00010000-0x0001FFFF local; SPRACJ8), aligned to trSize, with base+extent inside the window, disjoint source/ring, and sourceTrCount*trSize <=4096 (4 KB source-TR ceiling; independent of ringEntries, which may be up to 4096 on its own). " +
        "Maturity is simulator-tested only: the device model was written from the same TRM section as this block and is not an independent oracle, and there is no hardware-correlation claim.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "operation", displayName: "Operation", default: "configure", options: [
            { name: "configure", displayName: "Configure (0x70 source + 0x71 ring)" },
            { name: "submit", displayName: "Submit IDs (0x72)" },
            { name: "status", displayName: "Status (XIN 0x71)" }
        ] },

        { name: "sourceBase", displayName: "Source TR list base (tr_msrc_base)", default: 0x10000,
          description: "R6[17:0] on BS ID 0x70 XOUT. Must be inside PRU_ICSSG Shared RAM / Data RAM2 (0x00010000-0x0001FFFF local; 18 bits, trSize-aligned). No doorbell; submission is the XOUT 0x72 itself." },
        { name: "sourceTrCount", displayName: "Source TR list length (1..4096)", default: DEFAULT_SOURCE_TR_COUNT,
          description: "Number of TR descriptors physically present at sourceBase. Table 6-112 has no register for this -- it is a build-time-only field, independent of ringEntries (the destination ring size) -- and it is what the 4 KB source-TR ceiling (sourceTrCount*trSize<=4096) actually constrains. It also sizes the sourceBase extent and the sourceBase/ringBase disjointness check, which measure the source list, not the ring. Omitting it takes this same declared default (16); it does NOT fall back to ringEntries." },
        { name: "ringBase", displayName: "Ring base (tr_rsrc_base)", default: 0x10800,
          description: "R6[17:0] on BS ID 0x71 XOUT. Must be inside PRU_ICSSG Shared RAM / Data RAM2 (0x00010000-0x0001FFFF local; 18 bits, trSize-aligned), disjoint from sourceBase, with base+ringEntries*trSize inside the window." },
        { name: "ringEntries", displayName: "Ring entries (N, 1..4096)", default: 16,
          description: "Encoded as N-1 in R7[19:8] (tr_rsrc_nums). Must be >= the max IDs submitted in a single burst anywhere in the design (enforced by validateXfr2trGlobal), or the ring wraps over live descriptors. Not subject to the 4 KB ceiling -- that applies to sourceTrCount, a separate field." },
        { name: "trSize", displayName: "TR size (bytes)", default: 8, options: [{ name: 8 }, { name: 64 }],
          description: "R7[0] on BS ID 0x70 XOUT (0=8B, 1=64B)." },
        { name: "reset", displayName: "Reset ring write pointer", default: false,
          description: "R7[1] on BS ID 0x71 XOUT (tr_rscr_reset)." },
        { name: "submitCount", displayName: "IDs to submit (1..8)", default: 1,
          description: "Determines the XOUT byte count (2 bytes/ID, Table 6-112)." },

        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", hidden: true,
          options: [{ name: "metadata-only" }, { name: "assembles" }, { name: "simulator-tested" }, { name: "dual-oracle-tested" }, { name: "hardware-validated" }] },

        { name: "opCode", hidden: true, default: "m_xfr2tr_configure", getValue: opCode },
        { name: "numOfInputPorts", hidden: true, default: 0, getValue: (inst) => (operationName(inst) === "submit" ? 4 : 0) },
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4 },
        { name: "numOfConstants", hidden: true, default: 5, getValue: (inst) => {
            const op = operationName(inst);
            return op === "configure" ? 5 : (op === "submit" ? 1 : 0);
        } },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => {
            const op = operationName(inst);
            if (op === "configure") return Number(inst.sourceBase) || 0;
            if (op === "submit") return submitBytes(inst);
            return 0;
        } },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) =>
            operationName(inst) === "configure" ? (Number(inst.trSize) === 64 ? 1 : 0) : 0 },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) =>
            operationName(inst) === "configure" ? (Number(inst.ringBase) || 0) : 0 },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) =>
            operationName(inst) === "configure" ? rawNums(inst) : 0 },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) =>
            operationName(inst) === "configure" ? (inst.reset ? 1 : 0) : 0 },

        { name: "registerClobbers", hidden: true, default: "[]", getValue: (inst) => JSON.stringify(clobbers(inst)) },
        { name: "noOfCycles", displayName: "Peak cycles", default: 7, readOnly: true, getValue: cycles }
    ],

    ports: (inst) => {
        const base = [{ name: "prev", type: "IO_PREV" }, { name: "next", type: "IO_NEXT" }];
        if (operationName(inst) === "submit") {
            return base.concat([
                { name: "input1", type: "input32" }, { name: "input2", type: "input32" },
                { name: "input3", type: "input32" }, { name: "input4", type: "input32" },
                { name: "output1", type: "output32" }
            ]);
        }
        return base.concat([{ name: "output1", type: "output32" }]);
    },

    validate,

    getMacro(pruInstructionMacro, requestedOpCode) {
        const raw = (requestedOpCode || pruInstructionMacro || "").trim();
        const name = raw.split(/[\s,]+/)[0];
        const op = OPERATIONS.find((o) => macroNameFor(o) === name || o === name);
        if (!op) throw new Error("Unsupported XFR2TR macro " + name);
        return macroText(op);
    },

    // Machine-readable metadata for tests/tooling.
    deviceIds: { sourceConfig: 0x70, ringConfigStatus: 0x71, submit: 0x72 },
    registerClobbers: { configure: [[6, 2]], submit: [[2, 4]], status: [[7, 2]] },
    cycleEvidence: {
        configure: { peakCycles: 7, basis: "2x LDI32 (2 instr each) + XOUT per BS ID (0x70 then 0x71), plus the RES marker" },
        submit: { peakCycles: -1, basis: "Table 6-112's submit FIFO is 8 levels deep; a full-FIFO XOUT holds until the ring drains, so the bound is declared unknown rather than fixed" },
        status: { peakCycles: 2, basis: "1 XIN (Table 6-112 BS ID 0x71) plus the MOV that publishes the status word as RES" }
    },
    fifoCapacity: 8,

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        modules: function () {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = xfr2trModule;
