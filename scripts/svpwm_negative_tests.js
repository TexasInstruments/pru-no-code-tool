/**
 * Negative tests for SVPWM: saturation clamp and shoot-through /
 * dead-time rejection.
 *
 * ============================================================================
 * IMPORTANT — AUTHORING CONSTRAINT:
 * Authored with NO shell and NO file-read access. NOT executed during
 * authoring. The reference-model half of this file is pure math and is
 * complete; the half that loads the actual block's generated JS (or its
 * .asm through the PRU core simulator) depends on module paths and export
 * names the author could not read. Those seams are marked with
 * `// OPERATOR TODO(...)` and the file REFUSES TO PASS (exits 2) if the
 * block under test is not wired in — a green run with the block stubbed
 * out is impossible by construction.
 *
 * Operator must run:
 *     node scripts/svpwm_negative_tests.js
 * Expected (with block wired): "NEGATIVE TESTS OK"
 * Then perform the two MUTATION experiments (section M below) and confirm
 * each turns the suite red. Record transcripts in docs/evidence/svpwm.md.
 * ============================================================================
 *
 * DESIGN RULE ENCODED (this is the thing being tested):
 *  1. SATURATION: any commanded (Valpha,Vbeta) with |V| > inscribed-circle
 *     radius must be clamped so that Ta+Tb <= Tpwm with T0 >= 0. A "wrap"
 *     (negative T0, or dwell times exceeding the period) is a defect.
 *  2. SHOOT-THROUGH: for each complementary pair (Hx,Lx), there must be no
 *     instant where both are asserted. With dead-time DT > 0, the off->on
 *     transition of either device must lag the on->off transition of its
 *     complement by >= DT ticks. If DT is set to 0, a switching instant
 *     exists where both gate signals straddle the edge — the check must
 *     then FAIL against raw PWM edge timestamps (this is the mutation gate).
 *
 * MUTATION EXPERIMENTS (the proof the tests can fail):
 *  M1. Saturation: in the block's generated source, remove/bypass the clamp
 *      (e.g. delete the `if (T0 < 0)` scale-down, or whatever the block's
 *      equivalent is — search for the min/scale against the period).
 *      Re-run: test_saturation_clamp MUST fail. Revert.
 *  M2. Dead-time: set the block's DEADTIME_TICKS design constant to 0 and
 *      regenerate/rebuild. Re-run: test_shootthrough MUST fail on raw edge
 *      timestamps. Revert.
 *  Both mutations attack REAL design constants, not test-side expectations.
 *  The expectations below are computed from the independent oracle in
 *  scripts/svpwm_reference_vectors.js, never from the block's own output.
 */

"use strict";

const ref = require("./svpwm_reference_vectors.js");

// ---------------------------------------------------------------------------
// Block-under-test seam. The author could not read the repo, so this loader
// tries the plausible locations and REFUSES to pass if none provide the two
// functions the tests need. OPERATOR TODO: point this at the real block.
// ---------------------------------------------------------------------------
function loadBlockUnderTest() {
  const candidates = [
    // OPERATOR TODO(paths): confirm the real generated-module path for the
    // SVPWM/three-phase PWM block. These are guesses.
    "../.metadata/sysconfig/.meta/pru_blocks/application_specific/svpwm_block.syscfg.js",
    "../.metadata/sysconfig/.meta/pru_blocks/application_specific/svpwm_block.js",
    "../build_out/svpwm_build_test/svpwm_block.js",
  ];
  for (const p of candidates) {
    try {
      const m = require(p);
      const api = {
        // Required: duty computation. (valpha,vbeta) -> {sector,Ta,Tb,T0}
        // in the block's native tick units, plus its Tpwm and normalization.
        computeDuties:
          m.computeDuties || m.svpwmCompute || (m.default && m.default.computeDuties),
        // Required: gate waveform for a fixed duty set over >=1 PWM period.
        // Must return edge timestamps per channel:
        //   { H:[{t,level}...], L:{...}, ... } or a sampler f(t)->{H1,L1,...}
        simulateGates:
          m.simulateGates || m.simulatePwm || (m.default && m.default.simulateGates),
        meta: m.meta || {},
      };
      if (api.computeDuties || api.simulateGates) return { api, path: p };
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

const block = loadBlockUnderTest();

function die(msg) {
  console.error("NEGATIVE TESTS ABORT: " + msg);
  console.error(
    "The block under test is not wired in. Fix loadBlockUnderTest() (OPERATOR TODO).\n" +
      "This file intentionally cannot pass without the real block; a stubbed green\n" +
      "run would be a falsified deliverable."
  );
  process.exit(2);
}

// ===========================================================================
// Test 1 — Saturation must clamp, not wrap.
// ===========================================================================
function test_saturation_clamp() {
  if (!block || !block.api.computeDuties)
    die("computeDuties unavailable; cannot run saturation test");
  const { computeDuties, meta } = block.api;
  const TPWM = meta.TpwmTicks || 1; // normalized if unknown
  const satCases = ref
    .buildTable()
    .filter((r) => r.expected.saturated);

  let failures = 0;
  for (const row of satCases) {
    const { valpha, vbeta } = row.input;
    const got = computeDuties(valpha, vbeta);
    // Scale oracle's normalized Ta,Tb to block ticks if TPWM known.
    const scale = TPWM;
    const expTa = row.expected.Ta * scale;
    const expTb = row.expected.Tb * scale;

    // Hard invariants (must hold for ANY correct clamp):
    const sum = got.Ta + got.Tb;
    if (sum > TPWM * (1 + 1e-9)) {
      console.error(
        `SAT FAIL ${row.name}: Ta+Tb=${sum} exceeds Tpwm=${TPWM} (wrap, not clamp)`
      );
      failures++;
    }
    if (got.T0 < 0) {
      console.error(`SAT FAIL ${row.name}: negative T0=${got.T0} (wrapped dwell)`);
      failures++;
    }
    // Direction preservation: clamped vector must remain in the same sector
    // and same direction as commanded.
    if (got.sector !== row.expected.sector) {
      console.error(
        `SAT FAIL ${row.name}: sector ${got.sector} != expected ${row.expected.sector} (clamp changed sector)`
      );
      failures++;
    }
    // Clamped magnitude should equal the oracle's clamped dwell split.
    const tol = Math.max(1e-6 * scale, 1e-9);
    if (Math.abs(got.Ta - expTa) > tol || Math.abs(got.Tb - expTb) > tol) {
      console.error(
        `SAT FAIL ${row.name}: dwell mismatch got (${got.Ta},${got.Tb}) expected (${expTa},${expTb})`
      );
      failures++;
    }
  }
  console.log(
    failures
      ? `test_saturation_clamp: ${failures} FAILURES over ${satCases.length} vectors`
      : `test_saturation_clamp: PASS (${satCases.length} over-modulation vectors clamped)`
  );
  return failures === 0;
}

// ===========================================================================
// Test 2 — Shoot-through: no simultaneous H+L assertion; dead-time honored.
// ===========================================================================
function test_shootthrough() {
  if (!block || !block.api.simulateGates)
    die("simulateGates unavailable; cannot run shoot-through test");
  const { simulateGates, meta } = block.api;
  const DT = meta.deadtimeTicks;
  if (typeof DT !== "number")
    die("block meta.deadtimeTicks missing; cannot bound dead-time window");

  // Sweep several operating points incl. sector boundaries where edges collide.
  const points = ref.buildTable();
  let failures = 0;

  for (const row of points) {
    const waves = simulateGates(row.input.valpha, row.input.vbeta, {
      periods: 2,
    });
    // waves must expose, per phase x in {1,2,3}: edgesHx, edgesLx as sorted
    // arrays of {t, level(0|1)}. OPERATOR TODO(adapter): adapt shape here.
    for (const ph of [1, 2, 3]) {
      const H = waves[`H${ph}`], L = waves[`L${ph}`];
      if (!H || !L) die(`waveform for phase ${ph} missing`);
      // (a) sample both signals on a fine grid: never both high.
      const tEnd = Math.max(H[H.length - 1].t, L[L.length - 1].t);
      const step = Math.max(1, Math.floor((meta.deadtimeTicks || 1) / 4));
      const level = (edges, t) => {
        let lvl = 0;
        for (const e of edges) {
          if (e.t > t) break;
          lvl = e.level;
        }
        return lvl;
      };
      for (let t = 0; t <= tEnd; t += step) {
        if (level(H, t) === 1 && level(L, t) === 1) {
          console.error(
            `SHOOT-THROUGH FAIL ${row.name} ph${ph}: H and L both high at t=${t}`
          );
          failures++;
          break;
        }
      }
      // (b) dead-time window: every H fall->L rise and L fall->H rise gap >= DT.
      const ev = [
        ...H.map((e) => ({ ...e, sig: "H" })),
        ...L.map((e) => ({ ...e, sig: "L" })),
      ].sort((a, b) => a.t - b.t);
      for (let i = 0; i + 1 < ev.length; i++) {
        const a = ev[i], b = ev[i + 1];
        const handoff =
          (a.sig === "H" && a.level === 0 && b.sig === "L" && b.level === 1) ||
          (a.sig === "L" && a.level === 0 && b.sig === "H" && b.level === 1);
        if (handoff && b.t - a.t < DT) {
          console.error(
            `DEADTIME FAIL ${row.name} ph${ph}: ${a.sig}->${b.sig} gap ${b.t - a.t} < DT=${DT}`
          );
          failures++;
        }
      }
    }
  }
  console.log(
    failures
      ? `test_shootthrough: ${failures} FAILURES`
      : `test_shootthrough: PASS (no overlap; all handoff gaps >= ${DT} ticks)`
  );
  return failures === 0;
}

// ===========================================================================
// Mutation-gate self-check helpers.
// These exist so the operator can demonstrate red-ness cleanly:
//  - mutate saturation clamp off  -> expect test_saturation_clamp() === false
//  - set DEADTIME_TICKS = 0       -> expect test_shootthrough() === false
// Both functions are pure pass/fail returns, so a red result is unambiguous.
// ===========================================================================

if (require.main === module) {
  const results = [];
  // Always validate the oracle first; if the oracle is broken the negatives
  // mean nothing.
  require("./svpwm_reference_vectors.js"); // selfTest runs on import? No — run explicitly:
  ref.buildTable(); // throws? no; but selfTest is run below via direct call
  // (selfTest is executed by requiring the module only when run as main, so
  // call it here through a fresh require of its exported pieces is not
  // possible; instead re-run the public build + spot invariants.)
  // Minimal inline oracle sanity: every unsaturated row sums to 1.
  for (const row of ref.buildTable()) {
    const e = row.expected;
    if (!e.saturated && Math.abs(e.Ta + e.Tb + e.T0 - 1) > 1e-9) {
      die(`oracle row ${row.name} inconsistent — fix svpwm_reference_vectors.js first`);
    }
  }

  results.push(["saturation_clamp", test_saturation_clamp()]);
  results.push(["shootthrough", test_shootthrough()]);

  let bad = 0;
  for (const [name, ok] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) bad++;
  }
  if (bad) {
    console.error(`NEGATIVE TESTS: ${bad} failing group(s)`);
    process.exit(1);
  }
  console.log("NEGATIVE TESTS OK");
}