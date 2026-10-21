"use strict";

function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();
    let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
    if(result==0)return "PRU0";
    return "PRU1";
}

const PRU_USED = getPruNumberFromContext();

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i), displayName: `PRU GPIO ${i} (R30/R31.${i})`,
}));

const BITRATES = { dshot150: 150000, dshot300: 300000, dshot600: 600000, dshot1200: 1200000 };
const VARIANTS = Object.keys(BITRATES).map(k => ({ name: k }));

function dshotFrame(throttle, telemetry) {
    const value = (throttle << 1) | (telemetry ? 1 : 0);
    const crc = (value ^ (value >> 4) ^ (value >> 8)) & 0x0F;
    return ((value << 4) | crc) & 0xFFFF;
}

// Fixed cycles m_dshot_tx spends on each edge-to-edge path outside its delay
// (pad + ldi + 2-cycle sub/qbne loop), counted from the getMacro body below. The 1-bit and
// 0-bit paths are laid out to cost the same, so the bit period does not depend on the data.
//   high (rising write .. falling write): set 1, qbbc frame 1, ldi 1                       = 3
//   low  (falling write .. next rising):  clr 1, ldi 1, qba 1, qbbc mask 1, lsl 1, sub 1,
//                                         qbne 1                                          = 7
//   (after the 16th bit the qbne falls through where the next set would be, so the macro
//    returns exactly at the end of the last bit period)
// The extra-cycle mask's nop is not overhead: it is the +1 of a long bit (see below).
const DSHOT_OVERHEAD = { high: 3, low: 7 };
const MIN_DELAY = 2;        // the delay loop runs at least once: pad (0/1) + 2 * loops, loops >= 1
const MAX_LOOPS = 0xFFFF;   // ldi TEMP_REG1.w0 (TEMP_REG1.b2 is the bit counter)

// Rounding rule: bit i rises round(i * P) cycles after the first rising edge, P = clkHz / rate
// (round half up, exact integer arithmetic), so a bit is floor(P) or floor(P) + 1 cycles and no
// edge is more than half a cycle from its nominal time - the frame error does not accumulate.
// High time = round(3/4 * P) for a 1 and round(3/8 * P) for a 0 (the DShot duty ratios).
function dshotTiming(clkHz, rate) {
    const clk = Math.round(clkHz);
    if (!(clk > 0) || !(rate > 0)) return null;
    const rise = (i) => Math.floor((2 * i * clk + rate) / (2 * rate));
    const base = Math.floor(clk / rate);
    let mask = 0;
    for (let i = 0; i < 16; i++) {
        mask |= (rise(i + 1) - rise(i) - base) << (15 - i);   // MSB = first bit sent
    }
    const high1 = Math.floor((6 * clk + 4 * rate) / (8 * rate));    // round(3 * clk / (4 * rate))
    const high0 = Math.floor((6 * clk + 8 * rate) / (16 * rate));   // round(3 * clk / (8 * rate))
    const path = (nominal, overhead) => {
        const delay = nominal - overhead;
        return { nominal, overhead, delay, loops: delay >> 1, pad: delay & 1 };
    };
    return {
        period: clk / rate, base, mask,
        high1: path(high1, DSHOT_OVERHEAD.high), low1: path(base - high1, DSHOT_OVERHEAD.low),
        high0: path(high0, DSHOT_OVERHEAD.high), low0: path(base - high0, DSHOT_OVERHEAD.low),
    };
}

const DSHOT_PATHS = ["high1", "low1", "high0", "low0"];

function dshotTimingOf(inst) {
    return dshotTiming(inst.clkHz, BITRATES[inst.variant]);
}

function dshotLoops(inst, key) {
    const t = dshotTimingOf(inst);
    return t ? Math.max(1, t[key].loops) : 1;
}

function dshotPad(inst, key) {
    const t = dshotTimingOf(inst);
    return t ? t[key].pad : 0;
}

function isRegMode(inst) {
    return inst.throttleMode === "register";
}

const dshotModule = {
    displayName: "DShot Digital ESC",
    defaultInstanceName: `${PRU_USED}_DSHOT_INSTANCE_`,
    description: "DShot digital ESC protocol transmitter.",
    longDescription: "Transmits a 16-bit DShot frame (11-bit throttle, 1-bit telemetry, 4-bit CRC) over a single GPIO pin. " +
        "Bit timing is cycle-exact and the same for 1 and 0 bits: bit i rises round(i * P) cycles after the first edge, " +
        "P = clkHz / bitrate, so each bit is floor(P) or floor(P) + 1 cycles and no edge drifts more than half a cycle " +
        "(DShot1200 at 200 MHz: 166/167-cycle bits, 2667-cycle frame for 2666.67 nominal). The high time is round(3/4 P) " +
        "for a 1 and round(3/8 P) for a 0. Delay counts are the nominal time minus the fixed instruction overhead " +
        "(3 cycles high, 7 cycles low); a variant whose overhead does not fit at the given clkHz is rejected. " +
        "In register mode (throttleMode = 'register'), the 11-bit throttle is read from a full PRU register (throttleRegister, R0..R27) " +
        "with CRC computed dynamically on the PRU; the 11-bit mask applied to the register is defensive (bits above the frame never reach the wire), so it is pinned by source inspection, not by a behavioural test; telemetry request remains a build-time configuration option.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "signalPin", displayName: "Signal R30 Pin", default: "9", options: GPIO_SIGNALS },
        { name: "variant", displayName: "DShot Variant", default: "dshot600", options: VARIANTS },
        { name: "throttleMode", displayName: "Throttle Mode", default: "constant",
          options: [{ name: "constant" }, { name: "register" }] },
        { name: "throttleRegister", displayName: "Throttle Register", default: "R14" },
        { name: "throttle", displayName: "Throttle (0..2047)", default: 0 },
        { name: "telemetry", displayName: "Request Telemetry", default: false },
        { name: "clkHz", displayName: "PRU Clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_dshot_tx", hidden: true,
          getValue: (inst) => isRegMode(inst) ? "m_dshot_tx_reg" : "m_dshot_tx" },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 10, hidden: true,
          getValue: (inst) => isRegMode(inst) ? 12 : 10 },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.signalPin },
        // frame in bits 31..16, the extra-cycle (rounding) mask in bits 15..0, both MSB first
        { name: "constant2", hidden: true, default: "", getValue: (inst) => {
            if (isRegMode(inst)) return inst.throttleRegister;
            const t = dshotTimingOf(inst);
            return String(((dshotFrame(inst.throttle, inst.telemetry) << 16) | (t ? t.mask : 0)) >>> 0);
        } },
        { name: "constant3", hidden: true, default: 1, getValue: (inst) => {
            if (isRegMode(inst)) return inst.telemetry ? 1 : 0;
            return dshotLoops(inst, "high1");
        } },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => {
            if (isRegMode(inst)) {
                const t = dshotTimingOf(inst);
                return t ? t.mask : 0;
            }
            return dshotPad(inst, "high1");
        } },
        { name: "constant5", hidden: true, default: 1, getValue: (inst) => {
            if (isRegMode(inst)) return dshotLoops(inst, "high1");
            return dshotLoops(inst, "low1");
        } },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => {
            if (isRegMode(inst)) return dshotPad(inst, "high1");
            return dshotPad(inst, "low1");
        } },
        { name: "constant7", hidden: true, default: 1, getValue: (inst) => {
            if (isRegMode(inst)) return dshotLoops(inst, "low1");
            return dshotLoops(inst, "high0");
        } },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => {
            if (isRegMode(inst)) return dshotPad(inst, "low1");
            return dshotPad(inst, "high0");
        } },
        { name: "constant9", hidden: true, default: 1, getValue: (inst) => {
            if (isRegMode(inst)) return dshotLoops(inst, "high0");
            return dshotLoops(inst, "low0");
        } },
        { name: "constant10", hidden: true, default: 0, getValue: (inst) => {
            if (isRegMode(inst)) return dshotPad(inst, "high0");
            return dshotPad(inst, "low0");
        } },
        { name: "constant11", hidden: true, default: 1, getValue: (inst) => dshotLoops(inst, "low0") },
        { name: "constant12", hidden: true, default: 0, getValue: (inst) => dshotPad(inst, "low0") },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 1, default: 1 }
    ],

    ports: (inst) => {
        return [
            { name: "output1", type: "output32" },
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (!isRegMode(inst)) {
            if (inst.throttle < 0 || inst.throttle > 2047) validation.logError("throttle must be 0..2047", inst, "throttle");
        } else {
            if (!/^\s*R\d+\s*$/i.test(inst.throttleRegister)) {
                validation.logError("throttleRegister must be a full PRU register (e.g. R0..R27; sub-register tokens are not supported for 11-bit throttle)", inst, "throttleRegister");
            } else {
                const regNum = parseInt(inst.throttleRegister.replace(/^\s*R/i, ""), 10);
                if (regNum < 0 || regNum > 27) {
                    validation.logError("throttleRegister must be between R0 and R27", inst, "throttleRegister");
                }
            }
        }
        if (inst.throttleMode !== "constant" && inst.throttleMode !== "register") {
            validation.logError("throttleMode must be 'constant' or 'register'", inst, "throttleMode");
        }
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
        const t = dshotTimingOf(inst);
        if (!t) return;
        // Each edge-to-edge path must fit its fixed overhead plus a delay loop of one pass.
        for (const key of DSHOT_PATHS) {
            const p = t[key];
            if (p.delay < MIN_DELAY) {
                validation.logError(`${inst.variant} at clkHz ${inst.clkHz}: the ${key} time is ${p.nominal} cycles ` +
                    `but its fixed overhead is ${p.overhead} cycles plus a ${MIN_DELAY}-cycle minimum delay ` +
                    `(needs >= ${p.overhead + MIN_DELAY}); raise clkHz or choose a slower variant`, inst, "variant");
                return;
            }
            if (p.loops > MAX_LOOPS) {
                validation.logError(`${inst.variant} at clkHz ${inst.clkHz}: the ${key} delay needs ${p.loops} loop passes, ` +
                    `more than the 16-bit counter holds (${MAX_LOOPS})`, inst, "clkHz");
                return;
            }
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        if (opCode.includes("reg")) {
            return [
                `${opCode} .macro RES, PIN, THROTTLE_REG, TELEMETRY, XMASK, NH1, PH1, NL1, PL1, NH0, PH0, NL0, PL0`,
                `    mov   TEMP_REG2, THROTTLE_REG`,
                `    lsl   TEMP_REG2, TEMP_REG2, 21`,
                `    lsr   TEMP_REG2, TEMP_REG2, 20`,
                `    .if TELEMETRY == 1`,
                `    set   TEMP_REG2, TEMP_REG2, 0`,
                `    .endif`,
                `    lsr   TEMP_REG1, TEMP_REG2, 4`,
                `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG2`,
                `    lsr   TEMP_REG1.w2, TEMP_REG2, 8`,
                `    xor   TEMP_REG1.w0, TEMP_REG1.w0, TEMP_REG1.w2`,
                `    and   TEMP_REG1.b0, TEMP_REG1.b0, 0x0F`,
                `    lsl   TEMP_REG2, TEMP_REG2, 4`,
                `    or    TEMP_REG2.b0, TEMP_REG2.b0, TEMP_REG1.b0`,
                `    lsl   TEMP_REG2, TEMP_REG2, 16`,
                `    ldi   TEMP_REG2.w0, XMASK`,
                `    ldi   TEMP_REG1.b2, 16`,
                `ds_b?:`,
                `    set   R30, R30, PIN`,
                `    qbbc  ds_z?, TEMP_REG2, 31`,
                `    .if PH1 == 1`,
                `    nop`,
                `    .endif`,
                `    ldi   TEMP_REG1.w0, NH1`,
                `ds_1h?:`,
                `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
                `    qbne  ds_1h?, TEMP_REG1.w0, 0`,
                `    clr   R30, R30, PIN`,
                `    .if PL1 == 1`,
                `    nop`,
                `    .endif`,
                `    ldi   TEMP_REG1.w0, NL1`,
                `ds_1l?:`,
                `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
                `    qbne  ds_1l?, TEMP_REG1.w0, 0`,
                `    qba   ds_n?`,
                `ds_z?:`,
                `    .if PH0 == 1`,
                `    nop`,
                `    .endif`,
                `    ldi   TEMP_REG1.w0, NH0`,
                `ds_0h?:`,
                `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
                `    qbne  ds_0h?, TEMP_REG1.w0, 0`,
                `    clr   R30, R30, PIN`,
                `    .if PL0 == 1`,
                `    nop`,
                `    .endif`,
                `    ldi   TEMP_REG1.w0, NL0`,
                `ds_0l?:`,
                `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
                `    qbne  ds_0l?, TEMP_REG1.w0, 0`,
                `    qba   ds_n?`,
                `ds_n?:`,
                `    qbbc  ds_e?, TEMP_REG2, 15`,
                `    nop`,
                `ds_e?:`,
                `    lsl   TEMP_REG2, TEMP_REG2, 1`,
                `    sub   TEMP_REG1.b2, TEMP_REG1.b2, 1`,
                `    qbne  ds_b?, TEMP_REG1.b2, 0`,
                `    .endm`
            ].join("\n");
        }
        return [
            // NHx/PHx, NLx/PLx = delay-loop passes / 1-cycle pad for the high and low part
            // of a 1 (x=1) and a 0 (x=0) bit (nominal - fixed overhead, DSHOT_OVERHEAD); FRAME_XMASK
            // bit 15-i adds one cycle to bit i. Both bit paths cost the same cycles at every step.
            `${opCode} .macro RES, PIN, FRAME_XMASK, NH1, PH1, NL1, PL1, NH0, PH0, NL0, PL0`,
            `    ldi32 TEMP_REG2, FRAME_XMASK`,
            `    ldi   TEMP_REG1.b2, 16`,
            `ds_b?:`,
            `    set   R30, R30, PIN`,
            `    qbbc  ds_z?, TEMP_REG2, 31`,
            `    .if PH1 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi   TEMP_REG1.w0, NH1`,
            `ds_1h?:`,
            `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
            `    qbne  ds_1h?, TEMP_REG1.w0, 0`,
            `    clr   R30, R30, PIN`,
            `    .if PL1 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi   TEMP_REG1.w0, NL1`,
            `ds_1l?:`,
            `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
            `    qbne  ds_1l?, TEMP_REG1.w0, 0`,
            `    qba   ds_n?`,
            `ds_z?:`,
            `    .if PH0 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi   TEMP_REG1.w0, NH0`,
            `ds_0h?:`,
            `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
            `    qbne  ds_0h?, TEMP_REG1.w0, 0`,
            `    clr   R30, R30, PIN`,
            `    .if PL0 == 1`,
            `    nop`,
            `    .endif`,
            `    ldi   TEMP_REG1.w0, NL0`,
            `ds_0l?:`,
            `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
            `    qbne  ds_0l?, TEMP_REG1.w0, 0`,
            `    qba   ds_n?`,
            `ds_n?:`,
            `    qbbc  ds_e?, TEMP_REG2, 15`,
            `    nop`,
            `ds_e?:`,
            `    lsl   TEMP_REG2, TEMP_REG2, 1`,
            `    sub   TEMP_REG1.b2, TEMP_REG1.b2, 1`,
            `    qbne  ds_b?, TEMP_REG1.b2, 0`,
            `    .endm`
        ].join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.signalPin), dir: "GPO" });
            return pins;
        },
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = dshotModule;
