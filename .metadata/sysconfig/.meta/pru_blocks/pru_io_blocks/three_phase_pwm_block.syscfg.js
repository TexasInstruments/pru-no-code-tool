"use strict";

// Edge-aligned PWM only; center-aligned PWM is not implemented. The event list is sorted once per call.
// Timing is checked on the JS PRU core and on TI pru-simulator's IEP model, with c26 mapped to the IEP as on the
// device (tests/test_counted_pwm.py).

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i),
    displayName: `PRU GPIO ${i} (R30.${i})`,
}));

// Event-table scheduler.
//
// Once per call the duties are sorted and turned into an event stream in STATE: one token per
// distinct edge time, earliest in bits 0..3. A single-edge token is 4 bits (1..3 high-off of leg
// A..C, 4..6 low-on of leg A..C, 7 strobe). Code 0 escapes to an 8-bit token, bits 3-5 src and
// bits 6-7 flags: src 1..3 coincident high-offs of equal duty (bit 6: the strobe too; bit 7
// instead: that leg is the only clamped one), src 4..6 coincident low-ons (bit 6 strobe, bit 7
// high-offs two dead-times above), src 7 a low-on at PERIOD - DEADTIME with the clamped high-offs
// (bits 6-7 leg) or, bits 6-7 both set, every leg clamped, src 0 two clamped legs (bits 6-7 name
// the unclamped leg) or, all zero, the period boundary. TEMP_REG3 keeps a copy for every period.
//
// Per period the inner loop is one IEP CNT read and one compare against the next event time;
// coincident edges are one R30 write; dead time exists only as event times.
function buildThreePhaseMacro(opCode, counted) {
    const T1 = "TEMP_REG1", T2 = "TEMP_REG2", T3 = "TEMP_REG3", T4 = "TEMP_REG4";
    const L = [];
    const e = (...xs) => xs.forEach(x => L.push("    " + x));
    const lab = n => L.push(`tp_${n}?:`);
    const legs = [
        { x: "a", h: "AH", l: "AL", duty: "DUTY_A" },
        { x: "b", h: "BH", l: "BL", duty: "DUTY_B" },
        { x: "c", h: "CH", l: "CL", duty: "DUTY_C" },
    ];
    // Three tests reach every single-edge handler; code 0 clears the strobe and escapes.
    const spine = () => e("qbbs tp_n1?, STATE, 0", "qbbs tp_n01?, STATE, 1", "qbbs tp_la?, STATE, 2",
        "clr R30, R30, TRIGGER", "qba tp_esc?");

    if (counted) {
        L.push(`${opCode} .macro STATE, DUTY_A, DUTY_B, DUTY_C, PERIOD, DEADTIME, AH, AL, BH, BL, CH, CL, TRIGGER, PERIOD_COUNT`);
    } else {
        L.push(`${opCode} .macro STATE, DUTY_A, DUTY_B, DUTY_C, PERIOD, DEADTIME, AH, AL, BH, BL, CH, CL, TRIGGER`);
    }
    e("; Own IEP CMP0 without counter reset: the counter runs past PERIOD, so a late event is never missed.");
    e(`ldi ${T1}, 0x11`, `sbco  &${T1}, c26, 0x00, 4`, `ldi32 ${T1}, PERIOD`, `sbco  &${T1}, c26, 0x78, 4`,
      `ldi ${T1}, 0x02`, `sbco  &${T1}, c26, 0x70, 4`);
    e("clr R30, R30, AH", "clr R30, R30, AL", "clr R30, R30, BH", "clr R30, R30, BL",
      "clr R30, R30, CH", "clr R30, R30, CL", "clr R30, R30, TRIGGER");

    // ---- once per call: duties clamped to PERIOD, sorted with their legs ----
    e("; Edge order, once per call. TEMP_REG4 byte k describes duty rank k+1: bits 0-1 leg (A=1..C=3),");
    e("; 2 high side on, 3 clamped, 4 low side on, 5 low-on after the strobe, 6 high-off after it,");
    e("; 7 one of them at the strobe. Byte 3: equal ranks 1-2, 2-3; rank gap 2-1, 3-1, 3-2 equal to");
    e("; 2*DEADTIME (a high-off coincides with a low-on); the same gaps below 2*DEADTIME.");
    e(`ldi32 STATE, PERIOD`);
    [[T1, "DUTY_A", "ca"], [T2, "DUTY_B", "cb"], [T3, "DUTY_C", "cc"]].forEach(([r, d, n]) => {
        e(`mov ${r}, ${d}`, `qbge tp_${n}?, ${r}, STATE`, `mov ${r}, STATE`); lab(n);
    });
    e(`ldi32 ${T4}, 0x00171615`);
    const cswap = (ra, rb, ba, bb, n) => {
        e(`qbge tp_${n}?, ${ra}, ${rb}`, `xor ${ra}, ${ra}, ${rb}`, `xor ${rb}, ${rb}, ${ra}`, `xor ${ra}, ${ra}, ${rb}`,
          `mov STATE.b0, ${T4}.b${ba}`, `mov ${T4}.b${ba}, ${T4}.b${bb}`, `mov ${T4}.b${bb}, STATE.b0`);
        lab(n);
    };
    cswap(T1, T2, 0, 1, "s1"); cswap(T2, T3, 1, 2, "s2"); cswap(T1, T2, 0, 1, "s3");
    const R = [T1, T2, T3];
    const B = (k, bit) => 8 * k + bit;
    const ool = [];
    // High side on above 2*DEADTIME (its on-time is duty - 2*DEADTIME); ranks ascend, so stop early.
    e(`ldi STATE, DEADTIME`, `add STATE, STATE, DEADTIME`);
    R.forEach((r, k) => e(`qblt tp_hk?, ${r}, STATE`, `clr ${T4}, ${T4}, ${B(k, 2)}`));
    lab("hk");
    const gap = (ra, rb, eqBit, ltBit, n) => {
        e(`sub ${ra}, ${ra}, ${rb}`, `qbgt tp_${n}l?, ${ra}, STATE`, `qbne tp_${n}d?, ${ra}, STATE`,
          `set ${T4}, ${T4}, ${eqBit}`);
        lab(`${n}d`); e(`add ${ra}, ${ra}, ${rb}`);
        ool.push(() => { lab(`${n}l`); e(`set ${T4}, ${T4}, ${ltBit}`, `qba tp_${n}d?`); });
    };
    gap(T3, T2, 28, 31, "ge"); gap(T3, T1, 27, 30, "gb"); gap(T2, T1, 26, 29, "ga");
    e(`qbne tp_q1?, ${T1}, ${T2}`, `set ${T4}, ${T4}, 24`); lab("q1");
    e(`qbne tp_q2?, ${T2}, ${T3}`, `set ${T4}, ${T4}, 25`); lab("q2");
    e(`ldi32 STATE, PERIOD`);
    [2, 1, 0].forEach(k => e(`qbne tp_ck?, ${R[k]}, STATE`, `set ${T4}, ${T4}, ${B(k, 3)}`));
    lab("ck");
    // Low side on for 0 < duty < PERIOD - DEADTIME (duty 0 turns it on with the high sides).
    e(`sub STATE, STATE, DEADTIME`);
    [2, 1, 0].forEach(k => e(`qbgt tp_lk?, ${R[k]}, STATE`, `clr ${T4}, ${T4}, ${B(k, 4)}`));
    lab("lk");
    R.forEach((r, k) => e(`qbne tp_zk?, ${r}, 0`, `clr ${T4}, ${T4}, ${B(k, 4)}`));
    lab("zk");
    // Strobe relations; every rank after the strobe (duties near PERIOD) takes the short path.
    const sRel = (gtBit, n) => {
        e(`qbge tp_${n}?, ${T1}, STATE`);
        R.forEach((r, k) => e(`set ${T4}, ${T4}, ${B(k, gtBit)}`));
        e(`qba tp_${n}d2?`);
        lab(n);
        R.forEach((r, k) => {
            e(`qbge tp_${n}e${k}?, ${r}, STATE`, `set ${T4}, ${T4}, ${B(k, gtBit)}`, `qba tp_${n}d${k}?`);
            lab(`${n}e${k}`); e(`qbne tp_${n}d${k}?, ${r}, STATE`, `set ${T4}, ${T4}, ${B(k, 7)}`); lab(`${n}d${k}`);
        });
    };
    e(`ldi32 STATE, PERIOD >> 1`, `add STATE, STATE, DEADTIME`);
    sRel(6, "sh");
    e(`sub STATE, STATE, DEADTIME`, `sub STATE, STATE, DEADTIME`);
    sRel(5, "sl");

    // ---- tokens, latest first: each shifts the earlier ones up. TEMP_REG2 bit 0: strobe pending ----
    e(`ldi ${T2}, 1`, `ldi STATE, 0`);
    let uid = 0;
    // Strobe not yet placed and this edge not after it: the strobe goes in now (it is later),
    // unless they coincide, in which case the coincident write carries it.
    const sCheck = (k, gtBit, absorb) => {
        const n = `sc${uid}`;
        e(`qbbc tp_${n}?, ${T2}, 0`, `qbbs tp_${n}?, ${T4}, ${B(k, gtBit)}`, `clr ${T2}, ${T2}, 0`,
          `qbbc tp_${n}e?, ${T4}, ${B(k, 7)}`, `${absorb} tp_${n}?, ${T4}, ${B(k, 5)}`);
        lab(`${n}e`); e(`lsl STATE, STATE, 4`, `or STATE.b0, STATE.b0, 7`);
        lab(n);
    };
    const itemH = (k) => {
        const n = `ih${uid++}`;
        e(`qbbc tp_${n}z?, ${T4}, ${B(k, 2)}`);
        sCheck(k, 6, "qbbs");
        // Coincides with an earlier edge (equal duty below, or a low-on two dead-times below): skip.
        [[], [24, 26], [25, 27, 28]][k].forEach(b => e(`qbbs tp_${n}z?, ${T4}, ${b}`));
        e(`qbbs tp_${n}x?, ${T4}, ${B(k, 3)}`);
        [[24], [25], []][k].forEach(b => e(`qbbs tp_${n}g?, ${T4}, ${b}`));
        e(`qbbc tp_${n}s?, ${T4}, ${B(k, 7)}`, `qbbs tp_${n}g?, ${T4}, ${B(k, 5)}`);
        lab(`${n}s`);
        e(`lsl STATE, STATE, 4`, `and ${T1}.b0, ${T4}.b${k}, 3`, `or STATE.b0, STATE.b0, ${T1}.b0`);
        lab(`${n}z`);
        ool.push(() => {
            // Clamped: the lowest clamped rank clears every clamped high side (one, two or three legs).
            lab(`${n}x`);
            e(`lsl STATE, STATE, 8`);
            if (k === 2) e(`and ${T1}.b0, ${T4}.b2, 3`, `lsl ${T1}.b0, ${T1}.b0, 3`, `or ${T1}.b0, ${T1}.b0, 0x80`);
            else if (k === 1) e(`and ${T1}.b0, ${T4}.b0, 3`, `lsl ${T1}.b0, ${T1}.b0, 6`);
            else e(`ldi ${T1}.b0, 0xf8`);
            e(`or STATE.b0, STATE.b0, ${T1}.b0`, `qba tp_${n}z?`);
            lab(`${n}g`);
            e(`lsl STATE, STATE, 8`, `and ${T1}.b0, ${T4}.b${k}, 3`, `lsl ${T1}.b0, ${T1}.b0, 3`,
              `qbbc tp_${n}h?, ${T4}, ${B(k, 7)}`, `qbbc tp_${n}h?, ${T4}, ${B(k, 5)}`, `set ${T1}.b0, ${T1}.b0, 6`);
            lab(`${n}h`); e(`or STATE.b0, STATE.b0, ${T1}.b0`, `qba tp_${n}z?`);
        });
    };
    const itemL = (k) => {
        const n = `il${uid++}`;
        e(`qbbc tp_${n}z?, ${T4}, ${B(k, 4)}`);
        sCheck(k, 5, "qbbc");
        [[], [24], [25]][k].forEach(b => e(`qbbs tp_${n}z?, ${T4}, ${b}`));
        const cross = [[26, 27], [28], []][k];
        [[24], [25], []][k].concat(cross).forEach(b => e(`qbbs tp_${n}g?, ${T4}, ${b}`));
        e(`qbbc tp_${n}s?, ${T4}, ${B(k, 7)}`, `qbbc tp_${n}g?, ${T4}, ${B(k, 5)}`);
        lab(`${n}s`);
        e(`lsl STATE, STATE, 4`, `and ${T1}.b0, ${T4}.b${k}, 3`, `add ${T1}.b0, ${T1}.b0, 3`, `or STATE.b0, STATE.b0, ${T1}.b0`);
        lab(`${n}z`);
        ool.push(() => {
            lab(`${n}g`);
            e(`lsl STATE, STATE, 8`);
            const hx = [[[26, B(1, 3)], [27, B(2, 3)]], [[28, B(2, 3)]], []][k];
            if (hx.length) e(`qbbc tp_${n}n?, ${T4}, ${B(2, 3)}`);
            hx.forEach(([xb, cb], i) => { e(`qbbc tp_${n}n${i}?, ${T4}, ${xb}`, `qbbs tp_${n}x?, ${T4}, ${cb}`); lab(`${n}n${i}`); });
            if (hx.length) lab(`${n}n`);
            e(`and ${T1}.b0, ${T4}.b${k}, 3`, `add ${T1}.b0, ${T1}.b0, 3`, `lsl ${T1}.b0, ${T1}.b0, 3`,
              `qbbc tp_${n}c?, ${T4}, ${B(k, 7)}`, `qbbs tp_${n}c?, ${T4}, ${B(k, 5)}`, `set ${T1}.b0, ${T1}.b0, 6`);
            lab(`${n}c`);
            cross.forEach(b => e(`qbbs tp_${n}y?, ${T4}, ${b}`));
            e(`qba tp_${n}o?`);
            lab(`${n}y`); e(`set ${T1}.b0, ${T1}.b0, 7`);
            lab(`${n}o`); e(`or STATE.b0, STATE.b0, ${T1}.b0`, `qba tp_${n}z?`);
            if (hx.length) {
                lab(`${n}x`);
                e(`and ${T1}.b0, ${T4}.b${k}, 3`, `sub ${T1}.b0, ${T1}.b0, 1`, `lsl ${T1}.b0, ${T1}.b0, 6`,
                  `or ${T1}.b0, ${T1}.b0, 0x38`, `or STATE.b0, STATE.b0, ${T1}.b0`, `qba tp_${n}z?`);
            }
        });
    };
    // Reverse merge of the high-off and low-on streams (both in duty-rank order); byte-3 bits
    // 29..31: high-off 2 before low-on 1, high-off 3 before low-on 1, high-off 3 before low-on 2.
    itemL(2);
    e(`qbbc tp_m1?, ${T4}, 31`);
    itemL(1);
    e(`qbbc tp_m2?, ${T4}, 30`);
    itemL(0); itemH(2);
    e(`qba tp_ta1?`);
    lab("m2"); itemH(2); e(`qbbc tp_tb?, ${T4}, 29`, `qba tp_ta?`);
    lab("m1"); itemH(2); itemL(1); e(`qbbc tp_tb?, ${T4}, 29`);
    lab("ta"); itemL(0);
    lab("ta1"); itemH(1);
    lab("ta2"); itemH(0);
    e(`qbbc tp_mo?, ${T2}, 0`, `lsl STATE, STATE, 4`, `or STATE.b0, STATE.b0, 7`, `qba tp_mo?`);
    lab("tb"); itemH(1); itemL(0); e(`qba tp_ta2?`);
    ool.forEach(f => f());
    lab("mo");
    e(`mov ${T3}, STATE`);
    if (counted) e(`ldi32 ${T4}, PERIOD_COUNT`);

    // ---- every period ----
    lab("period");
    e("; Every period, the first included, restarts the counter so each period is the same");
    e("; waveform as one m_three_phase_pwm_period call. High sides on at DEADTIME, with the low");
    e("; side of any leg at duty 0, in one write.");
    e(`mov STATE, ${T3}`, `mov ${T2}, R30`);
    e(`ldi ${T1}, DEADTIME`, `add ${T1}, ${T1}, DEADTIME`);
    legs.forEach(g => { e(`qbge tp_o${g.x}?, ${g.duty}, ${T1}`, `set ${T2}, ${T2}, ${g.h}`); lab(`p${g.x}`); });
    e(`qba tp_r0?`);
    legs.forEach(g => { lab(`o${g.x}`); e(`qbne tp_p${g.x}?, ${g.duty}, 0`, `set ${T2}, ${T2}, ${g.l}`, `qba tp_p${g.x}?`); });
    lab("r0");
    e(`ldi ${T1}, 0`, `sbco  &${T1}, c26, 0x10, 4`, `ldi ${T1}, 1`, `sbco  &${T1}, c26, 0x74, 4`);
    lab("p0");
    e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_p0?, ${T1}, DEADTIME`, `mov R30, ${T2}`);
    spine();
    // Single-edge handlers. TEMP_REG1 holds the last counter sample: an event already due by it
    // is written without another read.
    const fast = (g, isLow) => {
        const n = (isLow ? "l" : "h") + g.x;
        e(`clr R30, R30, TRIGGER`, `lsr STATE, STATE, 4`,
          `${isLow ? "add" : "sub"} ${T2}, ${g.duty}, DEADTIME`, `qbge tp_w${n}?, ${T2}, ${T1}`);
        lab(`q${n}`); e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_q${n}?, ${T1}, ${T2}`);
        lab(`w${n}`); e(isLow ? `set R30, R30, ${g.l}` : `clr R30, R30, ${g.h}`);
        spine();
    };
    lab("n1"); e("qbbs tp_n11?, STATE, 1", "qbbs tp_lb?, STATE, 2");
    lab("ha"); fast(legs[0], false);
    lab("n11"); e("qbbs tp_s?, STATE, 2");
    lab("hc"); fast(legs[2], false);
    lab("n01"); e("qbbs tp_lc?, STATE, 2");
    lab("hb"); fast(legs[1], false);
    lab("la"); fast(legs[0], true);
    lab("lb"); fast(legs[1], true);
    lab("lc"); fast(legs[2], true);
    lab("s");
    e(`lsr STATE, STATE, 4`, `ldi32 ${T2}, PERIOD >> 1`, `qbge tp_ws?, ${T2}, ${T1}`);
    lab("qs"); e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_qs?, ${T1}, ${T2}`);
    lab("ws"); e(`set R30, R30, TRIGGER`);
    lab("dec"); spine();

    lab("esc");
    e("qbeq tp_end?, STATE, 0", "qbbs tp_e1?, STATE, 3", "qbbs tp_e2?, STATE, 4", "qbbs tp_gla?, STATE, 5",
      "qbbs tp_x2a?, STATE, 6", "qba tp_x2b?");
    lab("e1"); e("qbbs tp_e3?, STATE, 4", "qbbs tp_glb?, STATE, 5", "qba tp_gha?");
    lab("e3"); e("qbbs tp_g7?, STATE, 5", "qba tp_ghc?");
    lab("e2"); e("qbbs tp_glc?, STATE, 5", "qba tp_ghb?");
    // Coincident high-offs of equal duty [+ strobe], one write. The poll compares CNT + DEADTIME
    // with the duty, so TEMP_REG2 is free to hold the R30 image.
    legs.forEach((g, i) => {
        lab(`gh${g.x}`);
        e(`qbbs tp_x1${g.x}?, STATE, 7`, `mov ${T2}, R30`, `clr ${T2}, ${T2}, ${g.h}`);
        legs.forEach((o, j) => { if (j !== i) { e(`qbne tp_gh${g.x}${o.x}?, ${o.duty}, ${g.duty}`, `clr ${T2}, ${T2}, ${o.h}`); lab(`gh${g.x}${o.x}`); } });
        e(`qbbc tp_gh${g.x}s?, STATE, 6`, `set ${T2}, ${T2}, TRIGGER`); lab(`gh${g.x}s`);
        e(`lsr STATE, STATE, 8`, `add ${T1}, ${T1}, DEADTIME`, `qbge tp_ghw${g.x}?, ${g.duty}, ${T1}`);
        lab(`ghp${g.x}`);
        e(`lbco &${T1}, c26, 0x10, 4`, `add ${T1}, ${T1}, DEADTIME`, `qbgt tp_ghp${g.x}?, ${T1}, ${g.duty}`);
        lab(`ghw${g.x}`); e(`sub ${T1}, ${T1}, DEADTIME`, `mov R30, ${T2}`);
        spine();
        // The only clamped leg: its high side clears at PERIOD - DEADTIME.
        lab(`x1${g.x}`);
        e(`lsr STATE, STATE, 8`, `ldi32 ${T2}, PERIOD - DEADTIME`, `qbge tp_x1${g.x}w?, ${T2}, ${T1}`);
        lab(`x1${g.x}q`); e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_x1${g.x}q?, ${T1}, ${T2}`);
        lab(`x1${g.x}w`); e(`clr R30, R30, ${g.h}`, `qba tp_dec?`);
    });
    // Coincident low-ons of equal duty [+ strobe] [+ high-offs two dead-times above], one write.
    // The poll compares CNT - DEADTIME with the duty (CNT >= DEADTIME after the high-side write).
    legs.forEach((g, i) => {
        lab(`gl${g.x}`);
        e(`mov ${T2}, R30`, `set ${T2}, ${T2}, ${g.l}`);
        legs.forEach((o, j) => { if (j !== i) { e(`qbne tp_gl${g.x}${o.x}?, ${o.duty}, ${g.duty}`, `set ${T2}, ${T2}, ${o.l}`); lab(`gl${g.x}${o.x}`); } });
        e(`qbbc tp_gl${g.x}s?, STATE, 6`, `set ${T2}, ${T2}, TRIGGER`); lab(`gl${g.x}s`);
        e(`qbbs tp_gl${g.x}y?, STATE, 7`, `lsr STATE, STATE, 8`, `sub ${T1}, ${T1}, DEADTIME`,
          `qbge tp_glw${g.x}?, ${g.duty}, ${T1}`, `qba tp_glp${g.x}?`);
        // Bit 7: compare the other duties with this one + 2*DEADTIME. TEMP_REG1 then no longer
        // holds a counter sample, so the poll starts with a fresh read.
        lab(`gl${g.x}y`);
        e(`add ${T1}, ${g.duty}, DEADTIME`, `add ${T1}, ${T1}, DEADTIME`);
        legs.forEach((o, j) => { if (j !== i) { e(`qbne tp_gl${g.x}y${o.x}?, ${o.duty}, ${T1}`, `clr ${T2}, ${T2}, ${o.h}`); lab(`gl${g.x}y${o.x}`); } });
        e(`lsr STATE, STATE, 8`);
        lab(`glp${g.x}`);
        e(`lbco &${T1}, c26, 0x10, 4`, `sub ${T1}, ${T1}, DEADTIME`, `qbgt tp_glp${g.x}?, ${T1}, ${g.duty}`);
        lab(`glw${g.x}`); e(`add ${T1}, ${T1}, DEADTIME`, `mov R30, ${T2}`);
        spine();
    });
    // src 7: a low-on at PERIOD - DEADTIME with the clamped high-offs (bits 6-7 leg), or HX3.
    lab("g7");
    e("qbbs tp_g7b?, STATE, 6", "qbbs tp_g7c?, STATE, 7", "qba tp_g7a?");
    lab("g7b"); e("qbbs tp_x3?, STATE, 7", "qba tp_g7bb?");
    legs.forEach((g, i) => {
        lab(i === 1 ? "g7bb" : `g7${g.x}`);
        e(`mov ${T2}, R30`, `set ${T2}, ${T2}, ${g.l}`);
        legs.forEach((o, j) => { if (j !== i) { e(`qbne tp_gx${g.x}${o.x}?, ${o.duty}, ${g.duty}`, `set ${T2}, ${T2}, ${o.l}`); lab(`gx${g.x}${o.x}`); } });
        e(`clr ${T2}, ${T2}, AH`, `clr ${T2}, ${T2}, BH`, `clr ${T2}, ${T2}, CH`, `lsr STATE, STATE, 8`,
          `sub ${T1}, ${T1}, DEADTIME`, `qbge tp_gxw${g.x}?, ${g.duty}, ${T1}`);
        lab(`gxp${g.x}`);
        e(`lbco &${T1}, c26, 0x10, 4`, `sub ${T1}, ${T1}, DEADTIME`, `qbgt tp_gxp${g.x}?, ${T1}, ${g.duty}`);
        lab(`gxw${g.x}`); e(`add ${T1}, ${T1}, DEADTIME`, `mov R30, ${T2}`, `qba tp_dec?`);
    });
    // Two clamped legs (bits 6-7 = unclamped leg A 1, B 2, C 3): both high sides in one write.
    lab("x2a"); e("qbbs tp_x2c?, STATE, 7");
    [["x2a1", "BH", "CH"], ["x2b", "AH", "CH"], ["x2c", "AH", "BH"]].forEach(([n, p, q]) => {
        if (n !== "x2a1") lab(n);
        e(`lsr STATE, STATE, 8`, `ldi32 ${T2}, PERIOD - DEADTIME`, `qbge tp_${n}w?, ${T2}, ${T1}`);
        lab(`${n}q`); e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_${n}q?, ${T1}, ${T2}`);
        lab(`${n}w`); e(`mov ${T2}, R30`, `clr ${T2}, ${T2}, ${p}`, `clr ${T2}, ${T2}, ${q}`, `mov R30, ${T2}`, `qba tp_dec?`);
    });
    // Every leg clamped: only the period boundary follows, so STATE can hold the time.
    lab("x3");
    e(`mov ${T2}, R30`, `clr ${T2}, ${T2}, AH`, `clr ${T2}, ${T2}, BH`, `clr ${T2}, ${T2}, CH`,
      `ldi32 STATE, PERIOD - DEADTIME`, `qbge tp_x3w?, STATE, ${T1}`);
    lab("x3q"); e(`lbco &${T1}, c26, 0x10, 4`, `qbgt tp_x3q?, ${T1}, STATE`);
    lab("x3w"); e(`mov R30, ${T2}`);
    // Period boundary: CMP0 flags CNT = PERIOD; the low sides off in one write. Every high-off
    // and the strobe clear come earlier in the event list, so this is the all-off state.
    lab("end");
    e(`mov STATE, R30`, `clr STATE, STATE, AL`, `clr STATE, STATE, BL`, `clr STATE, STATE, CL`);
    lab("qe"); e(`lbco &${T1}, c26, 0x74, 4`, `qbbc tp_qe?, ${T1}, 0`, `mov R30, STATE`);
    if (counted) e(`sub ${T4}, ${T4}, 1`, `qbne tp_period?, ${T4}, 0`);
    e(`ldi ${T1}, 1`, `sbco &${T1}, c26, 0x74, 4`, `ldi ${T1}, 0`, `sbco &${T1}, c26, 0x70, 4`);
    L.push("    .endm");
    // One label per address: the JS reference core keeps only the last of consecutive labels,
    // so branches to an earlier one are pointed at the last and the earlier lines dropped.
    const alias = {};
    for (let i = L.length - 2; i >= 0; i--) {
        if (L[i].startsWith("tp_") && L[i + 1].startsWith("tp_")) {
            const to = L[i + 1].slice(0, -1);
            alias[L[i].slice(0, -1)] = alias[to] || to;
            L.splice(i, 1);
        }
    }
    return L.map(l => l.replace(/tp_\w+\?/g, m => alias[m] || m)).join("\n");
}
const threePhasePwmModule = {
    displayName: "Three-phase complementary PWM",
    defaultInstanceName: "THREE_PHASE_PWM_",
    description: "Emit one synchronized three-phase complementary PWM period from SVPWM duties.",
    longDescription: "Consumes phase A/B/C duty counts and emits one edge-aligned PWM period on six R30 pins. Each call sorts its edges once into an event list (the duties are the same for every period of the call); each period then reads the IEP counter once per poll iteration, compares it with the next event time and writes R30 when that time is reached. Edge times in IEP counts from the period start: high sides on at DEADTIME, high-off at min(duty, PERIOD) - DEADTIME, low-on at duty + DEADTIME, the sample strobe at PERIOD/2, all off at PERIOD. A high side stays off when its duty is at or below 2 x DEADTIME (its on-time, duty - 2 x DEADTIME, would be zero or less); a low side stays off when duty >= PERIOD - DEADTIME, and the low side of a leg at duty 0 turns on with the high sides; duties above the period are limited to the period. Dead time is never a busy-wait: it exists only as event times. Nominally both devices of a half bridge are off for 2 x DEADTIME counts, from the ideal high-off (duty - DEADTIME) to the ideal low-on (duty + DEADTIME). The delivered gap can be shorter when a late high-off bunches with an on-time low-on; the smallest gaps observed are about 8 counts at DEADTIME 10 and 16 at DEADTIME 20 (for example duties 424, 424, 444 at PERIOD 800, and 4, 4, 44 at PERIOD 400 with DEADTIME 20). This minimum is an observed value pinned by the scheduling tests, not a guarantee; the two devices are never on together. Edges with the same count change in one R30 write. Timing in cycles (= IEP counts): one poll iteration W = 4 (lbco of CNT + qbgt), counter sample to the R30 write X = 5, write to the next write when that edge is already due X2 = 8. An edge is never early; an isolated edge is late by at most W + X = 9 counts, and the k-th edge of a cluster of single-edge writes by at most W + X + (k-1) x X2. A write that changes several pins at once (coincident edges, clamped legs) goes through an escape token and takes up to 32 cycles to dispatch; the per-kind costs are measured by the scheduling tests. The strobe rises at PERIOD/2 under the same bound and is one poll iteration (4 cycles) wide. DEADTIME is an 8-bit immediate (at most 255). The macro owns IEP GLOBAL_CFG, CMP_CFG, CMP0, CNT and CMP_STATUS for the period (CMP0 flags the period end without resetting the counter, so a late edge is never lost), then disables CMP0 before returning. By default one call emits one period. Set Period count to N (1..2147483647) to emit N periods in one call: each period restarts the IEP counter and is the same waveform, edge for edge, as one single-period call, and compare events are disabled after the last. Consecutive periods are separated by 32 cycles (a back-to-back pair of single-period calls is separated by 182 because each call sorts its edges again and re-programs the IEP); the final return costs 2 cycles more than a single-period call (period decrement and branch), all after the last all-off edge. At small PERIOD with duties near PERIOD the late edges can land after the nominal period end (PERIOD 64, DEADTIME 1: an edge up to 77 counts late, an effective period of about 126 counts). The generated macro is about 985 instructions per inlined instance, roughly a third of a 3072-instruction instruction RAM; the single-period and the counted macro are separate bodies. Conservative instruction bound scales with N.\n\nTiming restrictions: this is a software block and its timing is not hardware-exact. (1) Dead time is nominally 2 x DEADTIME. The delivered minimum measured is about 8 counts at DEADTIME 10 and about 16 at DEADTIME 20, when a late high-off clusters with an on-time low-on. No overlap was seen in about 2000 configurations. It is an observed value pinned by tests, not a guaranteed minimum. (2) Single-edge writes are up to 8 counts late (W + X = 9 bound). Edges written together (coincident edges, clamped legs) are about 10 to 36 counts late in the test cases, against the 12-count budget of the single-edge path; example: PERIOD 800, DEADTIME 10, duties 400/400/400 gives low-ons 31 counts late. (3) This applies to the software block. ICSS-M on AM261x has no PWM module; on AM243x/AM64x the ICSSG hardware PWM module (not covered by this block) is the better fit when dead time must be a guaranteed minimum.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "blockMaturity", hidden: true, default: "simulator-tested", options: [{name:"metadata-only"},{name:"assembles"},{name:"simulator-tested"},{name:"dual-oracle-tested"},{name:"hardware-validated"}] },
        { name: "periodCounts", displayName: "PWM period counts", default: 1000 },
        { name: "deadtimeCounts", displayName: "Dead-time counts", default: 10 },
        { name: "periodCount", displayName: "Period count (0 = single period)", default: 0 },
        { name: "phaseAHighPin", displayName: "Phase A high-side pin", default: "0", options: GPIO_SIGNALS },
        { name: "phaseALowPin", displayName: "Phase A low-side pin", default: "1", options: GPIO_SIGNALS },
        { name: "phaseBHighPin", displayName: "Phase B high-side pin", default: "2", options: GPIO_SIGNALS },
        { name: "phaseBLowPin", displayName: "Phase B low-side pin", default: "3", options: GPIO_SIGNALS },
        { name: "phaseCHighPin", displayName: "Phase C high-side pin", default: "4", options: GPIO_SIGNALS },
        { name: "phaseCLowPin", displayName: "Phase C low-side pin", default: "5", options: GPIO_SIGNALS },
        { name: "sampleTriggerPin", displayName: "Center sample-trigger pin", default: "6", options: GPIO_SIGNALS },
        {
            name: "opCode",
            hidden: true,
            default: "m_three_phase_pwm_period",
            getValue: inst => (inst.periodCount > 0 ? "m_three_phase_pwm_counted" : "m_three_phase_pwm_period"),
        },
        { name: "numOfInputPorts", hidden: true, default: 3 },
        { name: "input1Size", hidden: true, default: 4 },
        { name: "input2Size", hidden: true, default: 4 },
        { name: "input3Size", hidden: true, default: 4 },
        { name: "numOfOutputPorts", hidden: true, default: 1 },
        { name: "output1Size", hidden: true, default: 4 },
        {
            name: "numOfConstants",
            hidden: true,
            default: 9,
            getValue: inst => (inst.periodCount > 0 ? 10 : 9),
        },
        { name: "constant1", hidden: true, default: 1000, getValue: i => i.periodCounts },
        { name: "constant2", hidden: true, default: 10, getValue: i => i.deadtimeCounts },
        { name: "constant3", hidden: true, default: "0", getValue: i => i.phaseAHighPin },
        { name: "constant4", hidden: true, default: "1", getValue: i => i.phaseALowPin },
        { name: "constant5", hidden: true, default: "2", getValue: i => i.phaseBHighPin },
        { name: "constant6", hidden: true, default: "3", getValue: i => i.phaseBLowPin },
        { name: "constant7", hidden: true, default: "4", getValue: i => i.phaseCHighPin },
        { name: "constant8", hidden: true, default: "5", getValue: i => i.phaseCLowPin },
        { name: "constant9", hidden: true, default: "6", getValue: i => i.sampleTriggerPin },
        {
            name: "constant10",
            hidden: true,
            default: 0,
            getValue: inst => inst.periodCount || 0,
        },
        {
            name: "noOfCycles",
            displayName: "Conservative instruction bound",
            default: 1260,
            getValue: i => (i.periodCount > 0 ? (i.periodCounts + 260) * i.periodCount : i.periodCounts + 260),
        },
    ],

    ports: () => [
        { name: "input1", type: "input32" },
        { name: "input2", type: "input32" },
        { name: "input3", type: "input32" },
        { name: "output1", type: "output32" },
        { name: "prev", type: "IO_PREV" },
        { name: "next", type: "IO_NEXT" },
    ],

    validate(inst, validation) {
        if (inst.periodCounts < 64 || inst.periodCounts > 0x7fffffff) validation.logError("periodCounts must be 64..2147483647", inst, "periodCounts");
        if (inst.deadtimeCounts < 1 || 2 * inst.deadtimeCounts >= inst.periodCounts) validation.logError("deadtimeCounts must be positive and less than half the period", inst, "deadtimeCounts");
        const pins = [inst.phaseAHighPin, inst.phaseALowPin, inst.phaseBHighPin, inst.phaseBLowPin, inst.phaseCHighPin, inst.phaseCLowPin, inst.sampleTriggerPin];
        if (new Set(pins).size !== pins.length) validation.logError("All six gate pins and the sample-trigger pin must be unique", inst, "sampleTriggerPin");
        if (inst.periodCount !== undefined && inst.periodCount !== null) {
            if (!Number.isInteger(inst.periodCount) || inst.periodCount < 0 || inst.periodCount > 0x7fffffff) {
                validation.logError("periodCount must be 0..2147483647", inst, "periodCount");
            }
        }
    },

    getMacro(call, opCode) {
        // The generator's expansion path calls getMacro(call, ""): the call text is the only thing
        // that says which variant is in use. Anything but the counted call keeps the single period.
        const counted = typeof call === "string" && call.trim().startsWith("m_three_phase_pwm_counted");
        opCode = opCode || (counted ? "m_three_phase_pwm_counted" : "m_three_phase_pwm_period");
        return buildThreePhaseMacro(opCode, opCode.trim().startsWith("m_three_phase_pwm_counted"));
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },
    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.phaseAHighPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.phaseALowPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.phaseBHighPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.phaseBLowPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.phaseCHighPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.phaseCLowPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.sampleTriggerPin), dir: "GPO" });
            return pins;
        },
        modules: () => [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }] },
};

exports = threePhasePwmModule;
