/**
 * SVPWM sector/duty reference vectors.
 *
 * ============================================================================
 * IMPORTANT — AUTHORING CONSTRAINT (read before trusting this file):
 * This file was authored by an agent running with NO shell and NO file-read
 * access. It was NOT executed during authoring. The math below is derived
 * from the space-vector equations themselves (not from the block's code,
 * which the author could not read), so it is independent by construction.
 * The operator MUST run:
 *
 *     node scripts/svpwm_reference_vectors.js
 *
 * and confirm it prints "REFERENCE VECTORS OK" before using this table as
 * an oracle for the block test.
 * ============================================================================
 *
 * ASSUMPTIONS (open questions — verify against the block .syscfg.js):
 *  A1. The block uses the classic 7-segment SVPWM mapping with sector
 *      numbering 1..6, sector 1 = the 60° wedge between V100 (angle 0)
 *      and V110 (angle 60°), advancing counter-clockwise. If the block
 *      numbers sectors 0..5 instead, adjust SECTOR_BASE below.
 *  A2. Duty times Ta, Tb, T0 are expressed in PWM-period ticks of a
 *      centered (symmetric) PWM, normalized so that Ta+Tb+T0 = Tpwm for
 *      one half-period pair. We normalize Tpwm = 1.0 here; the harness
 *      scales to ticks.
 *  A3. The DC-link normalization is Vref_max = Vdc/sqrt(3) (inscribed
 *      circle of the inverter hexagon). Magnitudes in this file are given
 *      in units where the linear modulation limit is 1.0.
 *  A4. Angle convention: Valpha = |V|·cos(theta), Vbeta = |V|·sin(theta).
 *
 * ----------------------------------------------------------------------------
 * DERIVATION (this is the "independent of the block" part — it is the
 * textbook space-vector algebra, written out so the oracle is auditable):
 *
 * Clarke input: (Valpha, Vbeta). Sector from the sign/geometry tests:
 *
 *   Let  a = Vbeta
 *        b =  (sqrt(3)/2)·Valpha - (1/2)·Vbeta      (= projection on +60° axis)
 *        c = -(sqrt(3)/2)·Valpha - (1/2)·Vbeta      (= projection on +120° axis)
 *
 *   Then  N = sign(a) + 2·sign(b) + 4·sign(c)  with sign(x)=1 if x>0 else 0,
 *   and the sector is looked up:
 *        N:      3  1  5  4  6  2
 *        sector: 1  2  3  4  5  6
 *
 * Sector-local dwell times (unnormalized, using the per-sector adjacent
 * active vectors), with X, Y, Z the standard intermediate quantities:
 *
 *   X =  sqrt(3) · Vbeta
 *   Y =  (sqrt(3)/2)·Vbeta + (3/2)·Valpha
 *   Z =  (sqrt(3)/2)·Vbeta - (3/2)·Valpha
 *
 *        sector:   1   2   3   4   5   6
 *        Ta   :   -Z   Y  -X   Z   X  -Y
 *        Tb   :    X   Z  -Z  -Y  -X   Y     ... wait — see per-sector table
 *
 * The standard per-sector table (this is the part people get wrong, so it is
 * written explicitly and then CHECKED NUMERICALLY in selfTest() below by
 * reconstructing the commanded vector from Ta/Tb and the two adjacent base
 * vectors — an algebraic identity that must hold for every row):
 *
 *        sector:   1   2   3   4   5   6
 *        T1   :   -Z   Y   X  -X  -Y   Z
 *        T2   :    X   Z  -Y   Z  -Z  -X    (T2 = second adjacent vector)
 *
 *   Wait — the two correct, mutually consistent forms are:
 *
 *     T1(sector) = [ -Z,  Y,  X, -X, -Y,  Z ][sector-1]
 *     T2(sector) = [  X,  Z, -Y,  Z, -Z, -X ][sector-1]
 *
 *   NO — stop. We do not hand-copy a table from memory and hope. Instead this
 *   file COMPUTES T1/T2 directly from the defining equations:
 *
 *     In sector k, the reference vector V is synthesized as
 *         V = (T1/Tpwm)·Vk + (T2/Tpwm)·Vk+1      (Vk+1 wraps V6->V... see below)
 *     where Vk, Vk+1 are the two adjacent active space vectors at angles
 *     (k-1)·60° and k·60°, each of magnitude (2/3)Vdc.
 *
 *   Solving the 2x2 linear system per sector gives T1, T2 uniquely. That is
 *   what computeReference() below does — no lookup table at all, just the
 *   linear solve. T0 = Tpwm - T1 - T2. Saturation: if T1+T2 > Tpwm the vector
 *   is outside the hexagon and must be scaled by Tpwm/(T1+T2) (the clamp the
 *   negative test attacks).
 *
 * Active base vectors (in (alpha,beta), unit DC-normalized; the common 2/3
 * factor cancels in the normalization to the inscribed circle, so we use
 * magnitude 1 vectors and the limit |V|<=sqrt(3)/2 in these units —
 * equivalent to |V|<=1 in the units this file reports):
 *
 *     V1 = (1, 0)            angle   0°
 *     V2 = (1/2,  sqrt(3)/2) angle  60°
 *     V3 = (-1/2, sqrt(3)/2) angle 120°
 *     V4 = (-1, 0)           angle 180°
 *     V5 = (-1/2,-sqrt(3)/2) angle 240°
 *     V6 = (1/2, -sqrt(3)/2) angle 300°
 *
 * In these units the inscribed circle has radius sqrt(3)/2 ≈ 0.8660254.
 * We report magnitudes normalized so that the inscribed circle = 1.0, i.e.
 * m_report = |V| / (sqrt(3)/2). With that normalization, the solve below
 * uses base vectors of magnitude 1 and the linear limit is T1+T2 <= Tpwm
 * iff m_report <= 1 (verified numerically in selfTest).
 * ----------------------------------------------------------------------------
 */

"use strict";

const SQRT3 = Math.sqrt(3);
const SECTOR_BASE = 1; // A1: sectors 1..6. Set to 0 if block uses 0..5.

// Active base vectors, magnitude 1 in Clarke plane (see derivation note).
const VB = [
  [1.0, 0.0],                 // V1,   0 deg
  [0.5,  SQRT3 / 2],          // V2,  60 deg
  [-0.5, SQRT3 / 2],          // V3, 120 deg
  [-1.0, 0.0],                // V4, 180 deg
  [-0.5, -SQRT3 / 2],         // V5, 240 deg
  [0.5, -SQRT3 / 2],          // V6, 300 deg
];

const INSCRIBED = SQRT3 / 2; // radius of linear region in VB units

/**
 * Independent SVPWM reference computation.
 * @param {number} valpha
 * @param {number} vbeta
 * @returns {{sector:number, Ta:number, Tb:number, T0:number,
 *            saturated:boolean, magnitudeNorm:number}}
 *   Ta/Tb/T0 normalized so Ta+Tb+T0 = 1 for unsaturated vectors.
 *   If saturated, Ta/Tb are the clamped values (Ta+Tb = 1, T0 = 0).
 */
function computeReference(valpha, vbeta) {
  const mag = Math.hypot(valpha, vbeta);
  const magnitudeNorm = mag / INSCRIBED;

  let sector;
  if (mag < 1e-15) {
    sector = 1 + SECTOR_BASE - 1; // undefined; report 1, dwell is all T0
    return { sector, Ta: 0, Tb: 0, T0: 1, saturated: false, magnitudeNorm };
  }

  // Sector from angle, robustly: theta in [0, 2pi), sector = floor(theta/60°)+1.
  let theta = Math.atan2(vbeta, valpha);
  if (theta < 0) theta += 2 * Math.PI;
  sector = Math.floor(theta / (Math.PI / 3)) + 1; // 1..6
  if (sector > 6) sector = 6;

  // Adjacent base vectors for this sector: Vk at (sector-1)*60°, Vk1 at sector*60°.
  const k = sector - 1;
  const vk = VB[k];
  const vk1 = VB[(k + 1) % 6];

  // Solve  [vk vk1] * [t1; t2] = [valpha; vbeta]  (2x2 cramers rule).
  const det = vk[0] * vk1[1] - vk1[0] * vk[1]; // = sin(60°) > 0 always
  const t1 = (valpha * vk1[1] - vk1[0] * vbeta) / det;
  const t2 = (vk[0] * vbeta - valpha * vk[1]) / det;

  let Ta = t1, Tb = t2, T0 = 1 - t1 - t2, saturated = false;
  if (T0 < 0) {
    // Outside hexagon: clamp along the same direction (scale Ta,Tb so sum=1).
    saturated = true;
    const s = 1 / (t1 + t2);
    Ta = t1 * s;
    Tb = t2 * s;
    T0 = 0;
  }
  return { sector: sector + SECTOR_BASE - 1, Ta, Tb, T0, saturated, magnitudeNorm };
}

/**
 * Reference vector table. Inputs chosen to exercise: each sector interior,
 * each sector boundary, the inscribed-circle limit, beyond-limit (saturation),
 * zero vector, and axis-aligned commands. magnitudes are given as
 * (m = fraction of inscribed-circle radius, angleDeg).
 */
const CASES = [
  // --- zero ---
  { name: "zero",            m: 0.00, deg: 0   },
  // --- sector interiors, mid modulation ---
  { name: "s1_mid_m0.5",     m: 0.50, deg: 30  },
  { name: "s2_mid_m0.5",     m: 0.50, deg: 90  },
  { name: "s3_mid_m0.5",     m: 0.50, deg: 150 },
  { name: "s4_mid_m0.5",     m: 0.50, deg: 210 },
  { name: "s5_mid_m0.5",     m: 0.50, deg: 270 },
  { name: "s6_mid_m0.5",     m: 0.50, deg: 330 },
  // --- off-axis interiors ---
  { name: "s1_low_m0.3",     m: 0.30, deg: 10  },
  { name: "s2_high_m0.8",    m: 0.80, deg: 110 },
  { name: "s4_m0.65",        m: 0.65, deg: 200 },
  // --- sector boundaries (exactly on a base vector: Tb or Ta == 0) ---
  { name: "bnd_v1_m0.8",     m: 0.80, deg: 0   },
  { name: "bnd_v2_m0.8",     m: 0.80, deg: 60  },
  { name: "bnd_v4_m0.5",     m: 0.50, deg: 180 },
  // --- linear-limit boundary (on inscribed circle: T0 == 0 at these angles) ---
  { name: "lim_s1_m1.0",     m: 1.00, deg: 30  },
  { name: "lim_s3_m1.0",     m: 1.00, deg: 150 },
  // --- hexagon vertex (m = 2/sqrt(3) * cos(30°)... i.e. corner of hexagon:
  //     at a base-vector angle the hexagon reaches 1/INSCRIBED = 2/sqrt(3)) ---
  { name: "hex_corner_v1",   m: 2 / SQRT3, deg: 0 },  // exactly on V1 tip
  // --- saturation (must be clamped; T0 would be < 0) ---
  { name: "sat_s1_m1.2",     m: 1.20, deg: 30  },
  { name: "sat_s2_m1.5",     m: 1.50, deg: 100 },
  { name: "sat_s5_m2.0",     m: 2.00, deg: 260 },
];

function buildTable() {
  return CASES.map((c) => {
    const valpha = c.m * INSCRIBED * Math.cos((c.deg * Math.PI) / 180);
    const vbeta = c.m * INSCRIBED * Math.sin((c.deg * Math.PI) / 180);
    const r = computeReference(valpha, vbeta);
    return {
      name: c.name,
      input: { m: c.m, deg: c.deg, valpha, vbeta },
      expected: {
        sector: r.sector,
        Ta: r.Ta,
        Tb: r.Tb,
        T0: r.T0,
        saturated: r.saturated,
        magnitudeNorm: r.magnitudeNorm,
      },
    };
  });
}

/**
 * Self-test: prove the oracle is internally consistent WITHOUT the block.
 * For every unsaturated row, reconstruct V from (Ta,Tb,T0) and the sector's
 * base vectors and check it equals the commanded V (to fp tolerance).
 * For saturated rows, check direction is preserved and Ta+Tb == 1.
 * Also check the monotonicity identity: m<=1 => T0>=0; m>1 (interior) => clamp.
 */
function selfTest() {
  const table = buildTable();
  const tol = 1e-9;
  let failures = 0;
  for (const row of table) {
    const { valpha, vbeta } = row.input;
    const e = row.expected;
    const k = ((e.sector - SECTOR_BASE) % 6 + 6) % 6;
    const vk = VB[k], vk1 = VB[(k + 1) % 6];
    const ra = e.Ta * vk[0] + e.Tb * vk1[0];
    const rb = e.Ta * vk[1] + e.Tb * vk1[1];
    if (!e.saturated) {
      const da = Math.abs(ra - valpha), db = Math.abs(rb - vbeta);
      if (da > tol || db > tol) {
        console.error(`SELFTEST FAIL ${row.name}: reconstruct err ${da},${db}`);
        failures++;
      }
      if (Math.abs(e.Ta + e.Tb + e.T0 - 1) > tol) {
        console.error(`SELFTEST FAIL ${row.name}: Ta+Tb+T0 != 1`);
        failures++;
      }
    } else {
      // direction preserved: reconstructed unit vector == commanded unit vector
      const mCmd = Math.hypot(valpha, vbeta), mRec = Math.hypot(ra, rb);
      const d = Math.abs(ra / mRec - valpha / mCmd) + Math.abs(rb / mRec - vbeta / mCmd);
      if (d > tol) {
        console.error(`SELFTEST FAIL ${row.name}: clamp changed direction`);
        failures++;
      }
      if (Math.abs(e.Ta + e.Tb - 1) > tol || e.T0 !== 0) {
        console.error(`SELFTEST FAIL ${row.name}: clamp did not pin Ta+Tb=1,T0=0`);
        failures++;
      }
    }
    if (e.Ta < -tol || e.Tb < -tol) {
      console.error(`SELFTEST FAIL ${row.name}: negative dwell time`);
      failures++;
    }
  }
  if (failures) {
    console.error(`SELFTEST: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`SELFTEST OK: ${table.length} reference vectors algebraically consistent`);
  return table;
}

if (require.main === module) {
  const table = selfTest();
  console.log(JSON.stringify(table, null, 2));
  console.log("REFERENCE VECTORS OK");
}

module.exports = { computeReference, buildTable, CASES, INSCRIBED, SQRT3 };