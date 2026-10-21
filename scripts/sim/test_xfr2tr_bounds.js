"use strict";

/* redo — fixes four gaps left by * (1) sourceBase/ringBase outside PRU_ICSSG Shared/Data2 and >18-bit truncation were silently aliased;
 * (2) 4KB source-TR ceiling (sourceTrCount*trSize <=4096) was missing;
 * (3) no-doorbell / no-hardware-ring-completion were undocumented;
 * (4) getCoreType used loose includes("rtu") matching artu/virtual.
 * Each gap gets a red arm: mutating the fix back to the buggy state must flip the assertion.
 *
 * Plus three further properties: the ring-vs-submit TRAP, the
 * N-1 tr_rsrc_nums encoder, and the hole in the left-packed ID list. The TRAP
 * is cross-instance, so it runs through the committed
 * scripts/global_runner.js, which drives the SHIPPED
 * validateXfr2trGlobal rather than a copy of the rule.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const blockPath = path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "pru_io_blocks", "xfr2tr_block.syscfg.js");

function loadBlock(coreName) {
    const source = fs.readFileSync(blockPath, "utf8");
    const sandbox = { exports: {}, console, system: { getScript: () => ({ getSelfSysCfgCoreName: () => coreName || "icss_g0_rtu_pru0" }) } };
    vm.runInNewContext(source, sandbox, { filename: "xfr2tr_block.syscfg.js" });
    return sandbox.exports;
}
const block = loadBlock("icss_g0_rtu_pru0");

function validateErrors(inst, coreName) {
    const b = coreName ? loadBlock(coreName) : block;
    const errs = [];
    b.validate(inst, { logError: (m) => errs.push(String(m)), logWarning: () => {} });
    return errs;
}
function ok(msg) { console.log("  ok:", msg); }

// ---------------------------------------------------------------------------
// Gap 1: sourceBase/ringBase 18-bit and Shared/Data2 window
// ---------------------------------------------------------------------------
// Happy: defaults inside window (0x10000-0x1FFFF) with 18-bit fit.
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x10800, ringEntries: 16, trSize: 8 }), []);
ok("gap1 happy: 0x10000/0x10800 inside Shared/Data2");

// 18-bit overflow: 0x40000 = 1<<18 truncates to 0x00000 in R6[17:0] — must be refused, not aliased.
let errs = validateErrors({ operation: "configure", sourceBase: 0x40000, ringBase: 0x10800, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /0x3FFFF|18 bits|truncate/i.test(e) && /sourceBase/i.test(e)), `0x40000 must be refused as >18 bits, got ${JSON.stringify(errs)}`);
ok("gap1 red: sourceBase 0x40000 >18 bits is refused");

// 0x50000 also >18 bits on ringBase
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x50000, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /0x3FFFF|18 bits|truncate/i.test(e) && /ringBase/i.test(e)), `ringBase 0x50000 must be refused`);
ok("gap1 red: ringBase 0x50000 >18 bits is refused");

// Negative and non-integer also refused
errs = validateErrors({ operation: "configure", sourceBase: -1, ringBase: 0x10800, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /sourceBase/i.test(e)), "negative sourceBase must be refused");
ok("gap1 red: negative base refused");

// Outside Shared/Data2 but inside 18 bits: e.g. 0x00002000 (DMEM1 local, not Shared/Data2)
errs = validateErrors({ operation: "configure", sourceBase: 0x00002000, ringBase: 0x10800, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /Shared.*Data.*2|outside.*0x00010000/i.test(e) && /sourceBase/i.test(e)), `0x2000 outside Shared/Data2 must be refused, got ${JSON.stringify(errs)}`);
ok("gap1 red: sourceBase 0x2000 outside Shared/Data2 refused");

// 0x00000000 also outside (DMEM0)
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x00000000, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /Shared.*Data.*2|outside.*0x00010000/i.test(e) && /ringBase/i.test(e)), "ringBase 0x0 outside Shared/Data2 must be refused");
ok("gap1 red: ringBase 0x0 outside Shared/Data2 refused");

// 0x00020000 is INTC window, not Shared/Data2 — must be refused even though <0x3FFFF
errs = validateErrors({ operation: "configure", sourceBase: 0x00020000, ringBase: 0x10800, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /Shared.*Data.*2|outside.*0x00010000/i.test(e)), "0x20000 INTC window must be refused");
ok("gap1 red: 0x20000 INTC window refused");

// Inside window but misaligned for trSize 64: 0x10001 %64 !=0
errs = validateErrors({ operation: "configure", sourceBase: 0x10001, ringBase: 0x10800, ringEntries: 4, trSize: 64 });
assert.ok(errs.some(e => /aligned/i.test(e) && /sourceBase/i.test(e)), "misaligned base must be refused");
ok("gap1 red: misaligned base refused");

// Extent overflow, SOURCE side: 0x1FC00 + 64*64B = 0x20C00 leaves the window.
// Each base is sized by ITS OWN descriptor count, so the
// source region's length is sourceTrCount*trSize; passing only ringEntries
// here would prove nothing about the source region.
errs = validateErrors({ operation: "configure", sourceBase: 0x1FC00, ringBase: 0x10800, ringEntries: 4, trSize: 64, sourceTrCount: 64 });
assert.ok(errs.some(e => /sourceBase/i.test(e) && /sourceTrCount/i.test(e) && /exceeds.*0x.*1ffff|wrap/i.test(e)),
    `source extent overflow must be refused, got ${JSON.stringify(errs)}`);
ok("gap1 red: source extent overflow refused (sized by sourceTrCount)");

// Extent overflow, RING side: the ring is sized by ringEntries, not by the
// source list, so a 1-entry source list must not mask a ring that overruns.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x1FC00, ringEntries: 64, trSize: 64, sourceTrCount: 1 });
assert.ok(errs.some(e => /ringBase/i.test(e) && /ringEntries/i.test(e) && /exceeds.*0x.*1ffff|wrap/i.test(e)),
    `ring extent overflow must be refused, got ${JSON.stringify(errs)}`);
ok("gap1 red: ring extent overflow refused (sized by ringEntries)");

// Defect-3 discriminator. A 512-entry source list at 0x1FE00 runs off the end
// of Shared/Data2 (0x1FE00 + 512*8B = 0x20E00) while the 16-entry ring makes
// the OLD ringEntries-sized extent (0x1FE80) look clean. Sizing both regions
// off ringEntries -- what this validator did before -- accepts this design.
errs = validateErrors({ operation: "configure", sourceBase: 0x1FE00, ringBase: 0x10800, ringEntries: 16, trSize: 8, sourceTrCount: 512 });
assert.ok(errs.some(e => /sourceBase/i.test(e) && /exceeds/i.test(e)),
    `a source list longer than the ring must still be extent-checked, got ${JSON.stringify(errs)}`);
ok("defect3 red: source extent uses sourceTrCount, not ringEntries");

// Mirror arm, so the fix cannot pass by over-rejecting: the same 4 KB source
// list placed where it fits must be ACCEPTED even though the ring is tiny.
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x1E000, ringBase: 0x10800, ringEntries: 16, trSize: 8, sourceTrCount: 512 }), [],
    "a 4 KB source list that fits inside the window must be accepted");
ok("defect3 green: fitting source list with a small ring accepted");

// Overlap must also use each region's own length: a 4 KB source list at
// 0x10000 physically contains a 16-entry ring at 0x10800, which the
// ringEntries-sized overlap test (0x10000..0x1007F vs 0x10800) missed.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x10800, ringEntries: 16, trSize: 8, sourceTrCount: 512 });
assert.ok(errs.some(e => /overlap/i.test(e)),
    `a source list that spans the ring must be refused as overlapping, got ${JSON.stringify(errs)}`);
ok("defect3 red: overlap uses sourceTrCount for the source region");

// Mutation: if region check is removed, 0x2000 would incorrectly pass — prove arm is not vacuous
const sourceText = fs.readFileSync(blockPath, "utf8");
assert.ok(sourceText.includes("SHARED_BASE") && sourceText.includes("SHARED_END"), "source must contain Shared/Data2 window constants");
assert.ok(sourceText.includes("0x3FFFF"), "source must contain 18-bit ceiling 0x3FFFF");
ok("gap1 mutation: Shared/Data2 and 18-bit constants present");

// Overlapping regions must be refused (source and ring share window)
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x10000, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /distinct|overlap/i.test(e) && /ringBase/i.test(e)), "identical bases must be refused");
ok("gap1 red: identical bases refused");
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x10040, ringEntries: 16, trSize: 8 });
assert.ok(errs.some(e => /overlap/i.test(e)), "overlapping bases must be refused");
ok("gap1 red: overlapping bases refused");

// ---------------------------------------------------------------------------
// Gap 2: 4 KB source-TR ceiling (sourceTrCount*trSize <=4096)
// The ceiling is a property of the SOURCE TR list, so every arm here states
// sourceTrCount explicitly. Arms phrased in ringEntries alone would be
// asserting the very coupling the defect-5 fix below removes.
// ---------------------------------------------------------------------------
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 512, trSize: 8, sourceTrCount: 512 }), [], "512*8=4096 must pass");
ok("gap2 happy: 512*8=4096 passes");
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11800, ringEntries: 64, trSize: 64, sourceTrCount: 64 }), [], "64*64=4096 must pass");
ok("gap2 happy: 64*64=4096 passes");
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 513, trSize: 8, sourceTrCount: 513 });
assert.ok(errs.some(e => /4 KB|4096|ceiling/i.test(e) && /sourceTrCount/i.test(e)), `513*8=4104 must hit ceiling, got ${JSON.stringify(errs)}`);
ok("gap2 red: 513*8 exceeds 4096 refused");
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 65, trSize: 64, sourceTrCount: 65 });
assert.ok(errs.some(e => /4 KB|4096|ceiling/i.test(e)), "65*64=4160 must hit ceiling");
ok("gap2 red: 65*64 exceeds 4096 refused");
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 1024, trSize: 8, sourceTrCount: 1024 });
assert.ok(errs.some(e => /4 KB|4096|ceiling/i.test(e)), "1024*8=8192 must hit ceiling");
ok("gap2 red: 1024*8 exceeds 4096 refused");

// The omitted-sourceTrCount path takes DEFAULT_SOURCE_TR_COUNT (the same
// literal the UI declares), NOT ringEntries -- so a large ring with no
// explicit source list is accepted rather than hitting the source ceiling.
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x12000, ringEntries: 1024, trSize: 8 }), [],
    "ringEntries=1024 with sourceTrCount omitted must NOT hit the source ceiling");
ok("gap2 green: omitted sourceTrCount uses the declared default, not ringEntries");

// Mutation: prove ceiling string exists and is tied to validation
assert.ok(sourceText.includes("4 KB") && sourceText.includes("4096"), "source must mention 4KB/4096 ceiling");
ok("gap2 mutation: ceiling constant present");

// ---------------------------------------------------------------------------
// the 4 KB
// ceiling must constrain sourceTrCount (the SOURCE TR list), not ringEntries
// (the destination ring). ringEntries=4096 is Table 6-112's own documented
// maximum (tr_rsrc_nums=4095) and must be ACCEPTED, while a too-large source
// list must still be refused independently of ring size.
// ---------------------------------------------------------------------------
// An omitted sourceTrCount takes DEFAULT_SOURCE_TR_COUNT, so ringEntries can
// reach Table 6-112's documented maximum without the source ceiling firing.
// The arms below state sourceTrCount explicitly anyway, to isolate the
// ceiling fix from the default. ringBase is placed clear of the source
// region's own extent so the disjointness check is not what fires.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x18000, ringEntries: 4096, trSize: 8, sourceTrCount: 512 });
assert.deepStrictEqual(errs, [], `ringEntries=4096 with a small independent sourceTrCount must be ACCEPTED (TRM maximum), got ${JSON.stringify(errs)}`);
ok("defect5 green: ringEntries=4096 (TRM maximum) accepted when sourceTrCount is independently small");

// The same design with the legacy (undocumented) ringEntries*trSize framing
// would have been a hard error at 4096*8=32768 -- confirm the ceiling really
// moved off ringEntries by checking a giant ring with a TINY source list
// passes even though ringEntries*trSize alone would be enormous.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x18000, ringEntries: 4096, trSize: 8, sourceTrCount: 1 });
assert.deepStrictEqual(errs, [], `ringEntries=4096 sourceTrCount=1 must be ACCEPTED, got ${JSON.stringify(errs)}`);
ok("defect5 green: maximal ring (4096) + minimal source list (1) accepted");

// The real ceiling must still fire, independent of ringEntries, when the
// SOURCE list itself is too big -- even for a tiny ring.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 16, trSize: 8, sourceTrCount: 600 });
assert.ok(errs.some(e => /4 KB|4096|ceiling/i.test(e) && /sourceTrCount/i.test(e)),
    `sourceTrCount=600 (4800 bytes) must hit the ceiling even with a tiny ring, got ${JSON.stringify(errs)}`);
ok("defect5 red: oversized sourceTrCount refused independent of ringEntries");

// sourceTrCount out of range on its own must be refused.
errs = validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 16, trSize: 8, sourceTrCount: 0 });
assert.ok(errs.some(e => /sourceTrCount/i.test(e)), `sourceTrCount=0 must be refused, got ${JSON.stringify(errs)}`);
ok("defect5 red: sourceTrCount=0 refused");

// Mutation: prove the decoupling is real in source (not just message text).
assert.ok(sourceText.includes("sourceTrCount"), "source must contain the decoupled sourceTrCount field/check");
ok("defect5 mutation: sourceTrCount present in source");

// ---------------------------------------------------------------------------
// Gap 3: no-doorbell / no-hardware-ring-completion documented
// ---------------------------------------------------------------------------
const longDesc = block.longDescription || "";
assert.ok(/no doorbell/i.test(longDesc) && /XOUT 0x72/i.test(longDesc), `longDescription must document no-doorbell (got ${longDesc.slice(0,120)}...)`);
ok("gap3: longDescription mentions no doorbell");
assert.ok(/no hardware ring completion/i.test(longDesc) && /poll/i.test(longDesc), "longDescription must document no-hardware-ring-completion and poll");
ok("gap3: longDescription mentions no hardware ring completion + poll");
const srcBaseCfg = block.config.find(c=>c.name==="sourceBase");
const ringBaseCfg = block.config.find(c=>c.name==="ringBase");
assert.ok(/No doorbell/i.test(srcBaseCfg.description), "sourceBase description must mention No doorbell");
assert.ok(/Shared.*Data.*2|0x00010000/i.test(ringBaseCfg.description), "ringBase description must mention Shared/Data2 window");
ok("gap3: config descriptions document window + no-doorbell");

// Sources contain the doc strings too (so a deletion would be caught)
assert.ok(/No doorbell/.test(sourceText), "sourceText must contain No doorbell string");
assert.ok(/No hardware ring completion/.test(sourceText), "sourceText must contain No hardware ring completion string");
ok("gap3 mutation: doc strings present in source");

// Also top comment documents it
assert.ok(sourceText.includes("No doorbell") && sourceText.includes("No hardware ring completion"), "top comment must document both facts");
ok("gap3: top comment documents both facts");

// ---------------------------------------------------------------------------
// Gap 4: getCoreType tightened from includes("rtu") to includes("rtu_pru")
// ---------------------------------------------------------------------------
// Real RTU core must still be accepted
assert.deepStrictEqual(validateErrors({ operation: "status" }, "icss_g0_rtu_pru0"), [], "real RTU_PRU must pass");
ok("gap4 happy: icss_g0_rtu_pru0 is RTU_PRU");
assert.deepStrictEqual(validateErrors({ operation: "status" }, "icss_g1_rtu_pru1"), [], "icss_g1_rtu_pru1 must pass");
ok("gap4 happy: icss_g1_rtu_pru1 is RTU_PRU");
// Loose substring fakes must NOT be treated as RTU — they must be rejected as PRU
for (const fake of ["icss_g0_virtual0", "icss_g0_artu_pru0", "myrtu_device", "icss_g0_rtu0", "icss_g0_pru0_artu", "RTU", "rtu"]) {
    const fakeErrs = validateErrors({ operation: "status" }, fake);
    assert.ok(fakeErrs.some(e=>/RTU_PRU/.test(e)), `loose fake "${fake}" must be rejected as non-RTU (got ${JSON.stringify(fakeErrs)})`);
}
ok("gap4 red: loose rtu fakes are correctly rejected (not RTU_PRU)");

// Case-insensitive: upper RTU_PRU should still be RTU_PRU if lowercased
assert.deepStrictEqual(validateErrors({ operation: "status" }, "ICSS_G0_RTU_PRU0"), [], "upper RTU_PRU must still be RTU_PRU");
ok("gap4 happy: upper RTU_PRU still recognized");

// TX_PRU tightening as well
assert.ok(validateErrors({ operation: "status" }, "icss_g0_tx_pru0").some(e=>/RTU_PRU/.test(e)), "TX_PRU must be rejected for XFR2TR (RTU only)");
ok("gap4: TX_PRU correctly rejected for XFR2TR");
for (const fakeTx of ["mytexas_device", "context", "icss_tx0"]) {
    const e = validateErrors({ operation: "status" }, fakeTx);
    // These fakes contain "tx" loosely but not "tx_pru" — must be PRU, thus still rejected but via PRU path (same error, not misclassified as TX_PRU)
    // The key is they are not TX_PRU; error message still says placed core is 'PRU' not 'TX_PRU', proving tightening.
    assert.ok(e.some(x=>/RTU_PRU/.test(x)), `fakeTx "${fakeTx}" must be rejected`);
}
ok("gap4 red: loose tx fakes not misclassified");

// Robust structural check: whole source, not a brittle 800-char slice that truncated
// before the second includes() call (the 800-char window ended mid-return after
// _rtu_pru, so _tx_pru was only present as a comment substring, not as code).
assert.ok(sourceText.includes('includes("_rtu_pru")'), "getCoreType must check _rtu_pru (tight) via includes");
assert.ok(sourceText.includes('includes("_tx_pru")'), "getCoreType must check _tx_pru");
assert.ok(/includes\("_rtu_pru"\)/.test(sourceText), "getCoreType must use includes(\"_rtu_pru\")");
ok("gap4 mutation: getCoreType uses tight _rtu_pru/_tx_pru checks (robust whole-file)");

// ---------------------------------------------------------------------------
// Keep original contract: happy path still holds for valid Shared/Data2 bases
// ---------------------------------------------------------------------------
assert.deepStrictEqual(validateErrors({ operation: "configure", sourceBase: 0x10000, ringBase: 0x11000, ringEntries: 16, trSize: 8 }), []);
assert.deepStrictEqual(validateErrors({ operation: "submit", submitCount: 4 }), []);
assert.deepStrictEqual(validateErrors({ operation: "status" }, "icss_g0_rtu_pru0"), []);
ok("regression: happy paths still pass inside valid window");


// ---------------------------------------------------------------------------
// THE TRAP (item: "submitting N IDs into a ring declared with tr_rsrc_nums
// below N-1 is a build error"). Cross-instance: ringEntries is on a configure
// instance, submitCount on a submit instance, so it lives in
// validateXfr2trGlobal and the per-instance validate() above cannot see it.
//
// Driven through the committed runner, which loads the SHIPPED static module,
// so dead-coding the whole guard turns these arms red.
// ---------------------------------------------------------------------------
const globalRunner = require(path.join(root, "scripts", "global_runner.js"));

function ringAndSubmit(ringEntries, submitCount) {
    return [
        globalRunner.instFromConfig("CFG", "configure", { sourceBase: 0x10000, ringBase: 0x10800, ringEntries, trSize: 8, sourceTrCount: 1 }),
        globalRunner.instFromConfig("SUB", "submit", { submitCount }),
    ];
}
function trapErrors(ringEntries, submitCount) {
    return globalRunner.globalErrors(ringAndSubmit(ringEntries, submitCount));
}

// The trap itself: a 1-entry ring under an 8-ID burst wraps over live
// descriptors, and hardware reports nothing.
errs = trapErrors(1, 8);
assert.ok(errs.some(e => /ringEntries/i.test(e) && /submitCount|submit/i.test(e) && /tr_rsrc_nums/i.test(e)),
    `ringEntries=1 under submitCount=8 must be refused, got ${JSON.stringify(errs)}`);
ok("trap red: ringEntries=1 with submitCount=8 refused");

// The boundary, both sides. This is the arm that catches an off-by-one in the
// guard itself (ringSize < maxSubmit - 1), which the trap arm above cannot:
// tr_rsrc_nums is zero-based, so an 8-ID XOUT needs tr_rsrc_nums >= 7, i.e.
// ringEntries >= 8. Exactly 8 must be ACCEPTED and exactly 7 REFUSED.
for (let n = 1; n <= 7; n++) {
    assert.ok(trapErrors(n, 8).length > 0, `ringEntries=${n} is below submitCount=8 and must be refused`);
}
assert.deepStrictEqual(trapErrors(8, 8), [], "ringEntries=8 exactly meets submitCount=8 and must be accepted");
assert.deepStrictEqual(trapErrors(9, 8), [], "ringEntries=9 exceeds submitCount=8 and must be accepted");
ok("trap red: boundary is exact -- 7 refused, 8 accepted (tr_rsrc_nums >= submitCount-1)");

// ... and the emitted encoding at the acceptance boundary really is 7, read
// from the block's own constant4 accessor rather than recomputed here.
assert.strictEqual(
    globalRunner.constantValue("constant4", globalRunner.instFromConfig("CFG", "configure", { ringEntries: 8 })), 7,
    "at the acceptance boundary ringEntries=8 the emitted tr_rsrc_nums must be 7");
ok("trap: emitted tr_rsrc_nums at the boundary is 7, not 8");

// Controls, so the guard cannot pass by refusing everything.
assert.deepStrictEqual(trapErrors(16, 1), [], "a ring far larger than the burst must be accepted");
assert.deepStrictEqual(
    globalRunner.globalErrors([globalRunner.instFromConfig("CFG", "configure", { sourceBase: 0x10000, ringBase: 0x10800, ringEntries: 1, trSize: 8, sourceTrCount: 1 })]),
    [], "a design with no submit instance has no burst to outgrow the ring");
ok("trap green: adequate ring accepted; configure-only design accepted");

// ---------------------------------------------------------------------------
// The N-1 encoder. rawNums()
// is the quantity the TRAP guard above consumes and the one number this block
// exists to get right; mutating `entries - 1` to `entries` was green
// everywhere before this arm.
// ---------------------------------------------------------------------------
for (const [entries, expected] of [[1, 0], [2, 1], [8, 7], [16, 15], [4096, 4095]]) {
    const got = globalRunner.constantValue("constant4", globalRunner.instFromConfig("CFG", "configure", { ringEntries: entries }));
    assert.strictEqual(got, expected,
        `tr_rsrc_nums for ringEntries=${entries} must be ${expected} (Table 6-112 encodes ring size MINUS ONE), got ${got}`);
}
// Out-of-range ringEntries must not emit a wrapped encoding; validate() is
// what refuses the design, and the accessor stays at 0 rather than -1.
assert.strictEqual(globalRunner.constantValue("constant4", globalRunner.instFromConfig("CFG", "configure", { ringEntries: 0 })), 0,
    "an out-of-range ringEntries must not encode as -1");
// A submit instance carries no ring geometry at all.
assert.strictEqual(globalRunner.constantValue("constant4", globalRunner.instFromConfig("SUB", "submit", { submitCount: 4 })), 0,
    "constant4 is ring geometry and must be 0 on a submit instance");
ok("encoder red: tr_rsrc_nums is ringEntries-1 across the full 1..4096 range");

// The submit byte count is the same shape of encoded literal: 2 bytes per ID.
for (const [count, bytes] of [[1, 2], [3, 6], [8, 16]]) {
    assert.strictEqual(globalRunner.constantValue("constant1", globalRunner.instFromConfig("SUB", "submit", { submitCount: count })), bytes,
        `submitCount=${count} must latch ${bytes} bytes (2 bytes/ID, no 4-byte rounding)`);
}
ok("encoder red: submit XOUT byte count is submitCount*2");

// ---------------------------------------------------------------------------
// Hole in the left-packed ID list (item ask). Table 6-112 packs two 12-bit IDs
// per 32-bit word with no holes or offsets, and the macro latches only the
// first submitCount*2 bytes of R2:R5 -- so an N-ID submit consumes exactly
// ceil(N/2) words fed by input1..input{ceil(N/2)}.
// ---------------------------------------------------------------------------
const WIRED = [{ inst: { $name: "PRODUCER" } }];
function submitPorts(submitCount, wiredPorts) {
    const inst = { operation: "submit", submitCount };
    for (let i = 1; i <= 4; i++) inst["input" + i] = wiredPorts.includes(i) ? WIRED : [];
    return inst;
}

// Fully wired for the words actually latched: accepted.
assert.deepStrictEqual(validateErrors(submitPorts(4, [1, 2])), [], "submitCount=4 needs exactly input1+input2");
assert.deepStrictEqual(validateErrors(submitPorts(1, [1])), [], "submitCount=1 needs exactly input1");
assert.deepStrictEqual(validateErrors(submitPorts(8, [1, 2, 3, 4])), [], "submitCount=8 needs all four words");
// An odd count still consumes the whole word its second ID slot lives in.
assert.deepStrictEqual(validateErrors(submitPorts(3, [1, 2])), [], "submitCount=3 spans two words (ID2 is in R3's low half)");
ok("hole green: a contiguously wired ID list is accepted");

// A gap in the middle: input2 unconnected while input3 is wired. The XOUT
// still latches R3, so a stale register is submitted as a live TR ID.
errs = validateErrors(submitPorts(6, [1, 3]));
assert.ok(errs.some(e => /input2/.test(e) && /hole/i.test(e)),
    `an unconnected input2 under submitCount=6 is a hole, got ${JSON.stringify(errs)}`);
ok("hole red: a gap in the middle of the ID list is refused");

// The first word missing is the same defect at offset 0.
errs = validateErrors(submitPorts(2, []));
assert.ok(errs.some(e => /input1/.test(e) && /hole/i.test(e)),
    `an unconnected input1 is a hole, got ${JSON.stringify(errs)}`);
ok("hole red: an unconnected first word is refused");

// The mirror defect: a producer wired past the last latched word. XOUT never
// reads that far, so its ID is dropped with no diagnostic on hardware.
errs = validateErrors(submitPorts(2, [1, 3]));
assert.ok(errs.some(e => /input3/.test(e) && /dropped|never reads/i.test(e)),
    `input3 wired under submitCount=2 is silently dropped and must be refused, got ${JSON.stringify(errs)}`);
ok("hole red: a producer wired past the last latched word is refused");

// Legacy callers that describe no ports at all are not accused of holes --
// the arms above pass bare field objects, and "no port key present"
// means "no connectivity was described", not "nothing is connected".
assert.deepStrictEqual(validateErrors({ operation: "submit", submitCount: 8 }), [],
    "a caller that supplies no port arrays must not be treated as fully unconnected");
ok("hole green: absent port information is not a hole");

// Mutation guard: the rule must be computed from submitCount, not pinned to a
// constant number of words.
assert.ok(/Math\.ceil\(count \/ 2\)/.test(sourceText),
    "the latched-word count must be derived from submitCount, not hardcoded");
ok("hole mutation: latched word count is derived from submitCount");

console.log("XFR2TR gap-closure tests passed");
