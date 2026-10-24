// pid_reference_vectors.js — Independent Q12 fixed-point PID reference model
// for iqmath_pid_block (used by scripts/pid_cosim.js).
//
// ============================================================================
// CONVENTIONS
// ============================================================================
//
// 1. Sampling-time convention
//   The gains Kp, Ki, Kd are **already folded** with the sampling
//   time. That is:
//     - Ki = ki * Ts  (integral gain includes the timestep)
//     - Kd = kd / Ts  (derivative gain includes the inverse timestep)
//   The difference equations therefore use Ki and Kd directly without explicit
//   multiplication by dt. If the firmware instead multiplies by dt at runtime,
//   EVERY vector here will disagree — this is the single most likely source of
//   model/firmware mismatch.
//
// 2. Q12 format
//   4096 == 1.0. All signals (setpoint, feedback, error, integral, derivative,
//   output) and all gains (Kp, Ki, Kd) are Q12 fixed point.
//
// 3. Product truncation
//   PRU shift-and-add multiplies truncate; the firmware does NOT round
//   products. Therefore this reference model truncates: after computing the Q24
//   sum (Kp*e + Ki*integral + Kd*derivative), we arithmetic-shift right by 12
//   (toward -infinity for negative values) to return to Q12.
//
// 4. No integral clamping
//   This reference does NOT clamp the integral accumulator. If the firmware
//   implements anti-windup clamping, long sequences with sustained error will
//   diverge from this reference; that divergence is expected, not a bug.
//
// 5. State initialization
//   integral[-1] = 0, e[-1] = 0 at the start of each sequence.
//
// ============================================================================
// DIFFERENCE EQUATIONS (positional PID)
// ============================================================================
//   e[n]         = setpoint[n] - feedback[n]
//   integral[n]  = integral[n-1] + e[n]
//   derivative[n]= e[n] - e[n-1]
//   u[n]         = (Kp*e[n] + Ki*integral[n] + Kd*derivative[n]) >> 12
//
// All arithmetic in Q12. Products are Q24; final shift truncates back to Q12.
// ============================================================================

(function () {
  'use strict';

  const Q12_ONE = 4096;

  // Truncating arithmetic right shift (toward -infinity for negatives)
  function q12Shift(q24) {
    return q24 >> 12;  // JS >> is arithmetic (sign-preserving)
  }

  // PID step: compute one iteration
  // state = { integral: Q12, prevError: Q12 }
  // Returns { e, integral, derivative, u } all in Q12
  function pidStep(setpoint, feedback, kp, ki, kd, state) {
    const e = setpoint - feedback;
    const integral = state.integral + e;
    const derivative = e - state.prevError;

    // Q24 products
    const pTerm = kp * e;
    const iTerm = ki * integral;
    const dTerm = kd * derivative;

    const u = q12Shift(pTerm + iTerm + dTerm);

    // Update state
    state.integral = integral;
    state.prevError = e;

    return { e, integral, derivative, u };
  }

  // Run a full sequence
  // seq = { name, kp, ki, kd, steps: [{setpoint, feedback}, ...] }
  // Returns array of { e, integral, derivative, u } for each step
  function runSequence(seq) {
    const state = { integral: 0, prevError: 0 };
    const results = [];
    for (const step of seq.steps) {
      const out = pidStep(step.setpoint, step.feedback, seq.kp, seq.ki, seq.kd, state);
      results.push(out);
    }
    return results;
  }

  // ========================================================================
  // TEST SEQUENCES (all values in Q12)
  // ========================================================================

  const sequences = [
    {
      name: 'step_response',
      description: 'Setpoint steps 0→1.0, feedback held at 0',
      kp: 4096,  // 1.0
      ki: 410,   // 0.1 (410/4096 ≈ 0.1001)
      kd: 41,    // 0.01 (41/4096 ≈ 0.01001)
      steps: [
        { setpoint: 4096, feedback: 0 },
        { setpoint: 4096, feedback: 0 },
        { setpoint: 4096, feedback: 0 },
        { setpoint: 4096, feedback: 0 },
        { setpoint: 4096, feedback: 0 },
        { setpoint: 4096, feedback: 0 },
      ],
      expected: [
        { e: 4096, integral: 4096,  derivative: 4096, u: 4547 },
        { e: 4096, integral: 8192,  derivative: 0,    u: 4916 },
        { e: 4096, integral: 12288, derivative: 0,    u: 5326 },
        { e: 4096, integral: 16384, derivative: 0,    u: 5736 },
        { e: 4096, integral: 20480, derivative: 0,    u: 6146 },
        { e: 4096, integral: 24576, derivative: 0,    u: 6556 },
      ],
    },

    {
      name: 'ramp',
      description: 'Setpoint ramps 0→1.0 in 0.2 steps, feedback=0',
      kp: 4096,
      ki: 410,
      kd: 41,
      steps: [
        { setpoint: 0,    feedback: 0 },
        { setpoint: 819,  feedback: 0 },  // 0.2
        { setpoint: 1638, feedback: 0 },  // 0.4
        { setpoint: 2458, feedback: 0 },  // 0.6
        { setpoint: 3277, feedback: 0 },  // 0.8
        { setpoint: 4096, feedback: 0 },  // 1.0
      ],
      expected: [
        { e: 0,    integral: 0,     derivative: 0,   u: 0 },
        { e: 819,  integral: 819,   derivative: 819, u: 909 },
        { e: 1638, integral: 2457,  derivative: 819, u: 1892 },
        { e: 2458, integral: 4915,  derivative: 820, u: 2958 },
        { e: 3277, integral: 8192,  derivative: 819, u: 4105 },
        { e: 4096, integral: 12288, derivative: 819, u: 5334 },
      ],
    },

    {
      name: 'zero_error_held',
      description: 'Setpoint = feedback = 0.5, error stays zero',
      kp: 4096,
      ki: 410,
      kd: 41,
      steps: [
        { setpoint: 2048, feedback: 2048 },
        { setpoint: 2048, feedback: 2048 },
        { setpoint: 2048, feedback: 2048 },
        { setpoint: 2048, feedback: 2048 },
        { setpoint: 2048, feedback: 2048 },
        { setpoint: 2048, feedback: 2048 },
      ],
      expected: [
        { e: 0, integral: 0, derivative: 0, u: 0 },
        { e: 0, integral: 0, derivative: 0, u: 0 },
        { e: 0, integral: 0, derivative: 0, u: 0 },
        { e: 0, integral: 0, derivative: 0, u: 0 },
        { e: 0, integral: 0, derivative: 0, u: 0 },
        { e: 0, integral: 0, derivative: 0, u: 0 },
      ],
    },

    {
      name: 'sign_reversal',
      description: 'Error reverses sign mid-sequence',
      kp: 4096,
      ki: 410,
      kd: 41,
      steps: [
        { setpoint: 2048, feedback: 0 },
        { setpoint: 2048, feedback: 0 },
        { setpoint: 2048, feedback: 0 },
        { setpoint: 2048, feedback: 4096 },  // error flips negative
        { setpoint: 2048, feedback: 4096 },
        { setpoint: 2048, feedback: 4096 },
      ],
      expected: [
        { e: 2048,  integral: 2048, derivative: 2048,  u: 2273 },
        { e: 2048,  integral: 4096, derivative: 0,     u: 2458 },
        { e: 2048,  integral: 6144, derivative: 0,     u: 2663 },
        { e: -2048, integral: 4096, derivative: -4096, u: -1679 },
        { e: -2048, integral: 2048, derivative: 0,     u: -1843 },
        { e: -2048, integral: 0,    derivative: 0,     u: -2048 },
      ],
    },

    {
      name: 'large_error',
      description: 'Saturating/large error: setpoint=1.0, feedback=-1.0',
      kp: 4096,
      ki: 410,
      kd: 41,
      steps: [
        { setpoint: 4096, feedback: -4096 },
        { setpoint: 4096, feedback: -4096 },
        { setpoint: 4096, feedback: -4096 },
        { setpoint: 4096, feedback: -4096 },
        { setpoint: 4096, feedback: -4096 },
        { setpoint: 4096, feedback: -4096 },
      ],
      expected: [
        { e: 8192, integral: 8192,  derivative: 8192, u: 9094 },
        { e: 8192, integral: 16384, derivative: 0,    u: 9832 },
        { e: 8192, integral: 24576, derivative: 0,    u: 10652 },
        { e: 8192, integral: 32768, derivative: 0,    u: 11472 },
        { e: 8192, integral: 40960, derivative: 0,    u: 12292 },
        { e: 8192, integral: 49152, derivative: 0,    u: 13112 },
      ],
    },
  ];

  // ========================================================================
  // SELF-TEST (runs on load)
  // ========================================================================

  function selfTest() {
    let totalVectors = 0;

    for (const seq of sequences) {
      const computed = runSequence(seq);

      if (computed.length !== seq.expected.length) {
        throw new Error(
          `Sequence '${seq.name}': length mismatch ` +
          `(computed ${computed.length}, expected ${seq.expected.length})`
        );
      }

      for (let i = 0; i < computed.length; i++) {
        const c = computed[i];
        const e = seq.expected[i];

        if (c.e !== e.e || c.integral !== e.integral ||
            c.derivative !== e.derivative || c.u !== e.u) {
          throw new Error(
            `Sequence '${seq.name}' step ${i}: mismatch\n` +
            `  computed:   e=${c.e} int=${c.integral} der=${c.derivative} u=${c.u}\n` +
            `  expected:   e=${e.e} int=${e.integral} der=${e.derivative} u=${e.u}`
          );
        }
      }

      totalVectors += computed.length;
    }

    console.log(`SELFTEST OK: ${totalVectors} PID vectors`);
    return totalVectors;
  }

  // Run self-test immediately on load
  const vectorCount = selfTest();

  // Export
  module.exports = {
    sequences,
    pidStep,
    runSequence,
    Q12_ONE,
    vectorCount,
  };

})();
