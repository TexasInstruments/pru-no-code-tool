"use strict";

/**
 * Helper function to extract PRU number from system context
 */
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

/**
 * Multi-Axis Motion Controller Block
 *
 * What this block does (checked on TI pru-simulator):
 *
 *   - Up to 4 axes of step/dir/enable on R30, driven from ONE fixed-length
 *     scheduler tick. Every tick performs the same instruction sequence, so a
 *     tick is an exact number of PRU cycles (tickCycles() below) and a step
 *     period is an exact number of ticks.
 *   - Per axis a 32-bit phase accumulator (a DDA) adds a constant each tick;
 *     a carry out of the add is one step. The constant is
 *     round(2^32 * speed * tick / clkHz), computed at generation time.
 *   - Synchronized start: with syncEnable the accumulators are pre-loaded to
 *     2^32 - inc, so EVERY axis carries on the very first tick and the first
 *     step of all axes is one single `or R30, R30, mask` write - the same
 *     cycle, not "close together".
 *   - Step bits of all axes rise in one 32-bit write and fall in one 32-bit
 *     write, so pulse width is identical on every axis.
 *   - E-Stop: the GPI pin is sampled once per tick; when asserted every pin
 *     this block drives is cleared, status bit 7 is latched and the core
 *     HALTs. Worst-case latency is one tick plus the clamp (measured).
 *   - Constant speed per axis, steps counted down to targetSteps.
 *
 * What it does NOT do:
 *   - No trapezoidal acceleration: accel0..3 are accepted but ignored.
 *   - No IEP timebase: timing is the fixed-length tick above, not the IEP.
 *   - No home/limit switch handling: homeSwPin/limitPPin/limitNPin are ignored.
 *   - No command-queue consumption and no underrun detection: targets are the
 *     static values below; dmemBase is ignored (state lives in registers).
 *
 * Registers: the macro uses R18..R25 (acc/remaining per axis, two per axis)
 * plus TEMP_REG1..TEMP_REG4. R18..R25 are NOT allocated by the register
 * allocator (it hands out R0 upward), but a design must not pin its own
 * values there.
 */

const MAX_AXES = 4;
const CLK_DEFAULT = 200000000;

/* Registers used for per-axis state: axis a -> acc = R(18+2a), remaining = R(19+2a). */
const STATE_BASE_REG = 18;

/* DIR/EN settle delay (cycles) before the first step. */
const SETTLE_ITERS = 20;

/**
 * Decompose the STEP high time into a delay loop + nops.
 * The step bits go high on the `or R30` and low on the `and R30`, so the high
 * time is (delay cycles in between) + 1.
 */
function pulseDelay(pulseCycles) {
    const delay = Math.max(0, pulseCycles - 1);
    if (delay <= 2) return { k: 0, nops: delay };
    const k = Math.floor((delay - 1) / 2);   /* loop costs 1 + 2k cycles */
    return { k: k, nops: (delay - 1) % 2 };
}

/**
 * Exact PRU cycles of one scheduler tick (measured on TI pru-simulator).
 *
 * tick = 1 (mask clear) + 1 (e-stop test) + 9 per axis + 1 (broadside or)
 *      + pulse delay + 1 (broadside and) + 1 (mov of axis 0 remaining count)
 *      + (axes - 1) (or-chain of the other remaining counts) + 1 (loop branch)
 *      = 10 * axes + 5 + pulse delay
 */
function tickCycles(inst) {
    const n = inst.numAxes;
    const pd = pulseDelay(inst.pulseWidthCycles);
    const delay = (pd.k > 0 ? 1 + 2 * pd.k : 0) + pd.nops;
    return 1 + 1 + 9 * n + 1 + delay + 1 + 1 + (n - 1) + 1;
}

/** 32-bit phase increment per tick for an axis. */
function phaseInc(inst, axis) {
    const speed = inst["maxSpeedSps" + axis];
    const perTick = speed * tickCycles(inst) / inst.clkHz;
    return Math.round(perTick * 4294967296);
}

function hex32(v) {
    return "0x" + ((v >>> 0).toString(16).toUpperCase());
}

function stepMask(inst) {
    let m = 0;
    for (let a = 0; a < inst.numAxes; a++) m |= (1 << parseInt(inst["stepPin" + a], 10));
    return m >>> 0;
}

function allMask(inst) {
    let m = 0;
    for (let a = 0; a < inst.numAxes; a++) {
        m |= (1 << parseInt(inst["stepPin" + a], 10));
        m |= (1 << parseInt(inst["dirPin" + a], 10));
        m |= (1 << parseInt(inst["enablePin" + a], 10));
    }
    return m >>> 0;
}

/* constant index of axis `a`, field `f` (0 step,1 dir,2 en,3 inc,4 target,5 fwd).
   The TI assembler segfaults on a macro with more than 32 formals, so the call is
   RES + 7 globals + 6 per axis x 4 = 32 - exactly the limit. */
function axisConst(a, f) { return 8 + 6 * a + f; }

function axisConfig(a) {
    const S = String(a);
    const defs = [["0","1","2"], ["3","4","5"], ["6","7","8"], ["9","10","11"]][a];
    return [
        { name: "stepPin" + S,    displayName: `Axis ${S} - Step Pin (GPO)`,     default: defs[0], options: GPIO_SIGNALS },
        { name: "dirPin" + S,     displayName: `Axis ${S} - Dir Pin (GPO)`,      default: defs[1], options: GPIO_SIGNALS },
        { name: "enablePin" + S,  displayName: `Axis ${S} - Enable Pin (GPO)`,   default: defs[2], options: GPIO_SIGNALS },
        { name: "homeSwPin" + S,  displayName: `Axis ${S} - Home Switch (Reserved)`, description: "GPI. Reserved: not used by the macro.",  default: defs[0], options: GPIO_SIGNALS },
        { name: "limitPPin" + S,  displayName: `Axis ${S} - Limit+ (Reserved)`, description: "GPI. Reserved: not used by the macro.",       default: defs[1], options: GPIO_SIGNALS },
        { name: "limitNPin" + S,  displayName: `Axis ${S} - Limit- (Reserved)`, description: "GPI. Reserved: not used by the macro.",       default: defs[2], options: GPIO_SIGNALS },
        { name: "targetSteps" + S,displayName: `Axis ${S} - Target Steps`,       default: 1000 },
        { name: "maxSpeedSps" + S,displayName: `Axis ${S} - Speed (Steps/s)`, description: "Constant step rate in steps per second.", default: 1000 },
        { name: "accel" + S,      displayName: `Axis ${S} - Acceleration (Reserved)`, description: "Steps/s^2. Reserved: ignored, the macro does not ramp.", default: 5000 },
        { name: "initDir" + S,    displayName: `Axis ${S} - Initial Direction`,  default: "1",
          options: [{name: "0", displayName: "Reverse"}, {name: "1", displayName: "Forward"}] },
    ];
}

function axisConstants(a) {
    return [
        { name: "constant" + axisConst(a, 0), hidden: true, default: 0,  getValue: (inst) => parseInt(inst["stepPin" + a], 10) },
        { name: "constant" + axisConst(a, 1), hidden: true, default: 0,  getValue: (inst) => parseInt(inst["dirPin" + a], 10) },
        { name: "constant" + axisConst(a, 2), hidden: true, default: 0,  getValue: (inst) => parseInt(inst["enablePin" + a], 10) },
        { name: "constant" + axisConst(a, 3), hidden: true, default: "", getValue: (inst) => hex32(phaseInc(inst, a)) },
        { name: "constant" + axisConst(a, 4), hidden: true, default: 0,  getValue: (inst) => inst["targetSteps" + a] },
        { name: "constant" + axisConst(a, 5), hidden: true, default: 0,  getValue: (inst) => (inst["initDir" + a] === "1") ? 1 : 0 },
    ];
}

const multiAxisMotionModule = {
    displayName: "Multi-Axis Motion Controller",
    defaultInstanceName: `${PRU_USED}_MULTIAXIS_INSTANCE_`,
    description: "Fixed-tick coordinated multi-axis step/dir generator (up to 4 axes, constant speed).",
    longDescription: "Drives up to 4 stepper axes (Step+Dir+Enable on R30) from one fixed-length scheduler tick. " +
        "Each axis is a 32-bit phase accumulator; a carry is one step. With Synchronized Start every axis steps on the same first tick, " +
        "and all step pins of a tick rise and fall in single 32-bit R30 writes, so pulse width is identical on every axis. " +
        "An asserted E-Stop input clears every pin the block drives, latches status bit 7 and halts. " +
        "Constant speed only: the acceleration, home-switch, limit-switch and DMEM-base fields are reserved and ignored, " +
        "and there is no IEP timebase, command-queue input or underrun detection. State is held in R18..R25.",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested",
          options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"},
                    {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        /* --- Number of axes --- */
        { name: "numAxes", displayName: "Number of Axes", default: 2,
          options: [{name: 1}, {name: 2}, {name: 3}, {name: 4}] },

        ...axisConfig(0),
        ...axisConfig(1),
        ...axisConfig(2),
        ...axisConfig(3),

        /* --- Global --- */
        { name: "eStopPin",    displayName: "E-Stop Input (GPI, Active High)", default: "15", options: GPIO_SIGNALS },
        { name: "syncEnable",  displayName: "Synchronized Start",          default: true },
        { name: "clkHz",       displayName: "PRU Clock (Hz)",              default: 200000000 },
        { name: "dmemBase",    displayName: "DMEM State Table Base (Hex)", description: "Reserved: not used by the macro.", default: "0x0100" },
        { name: "pulseWidthCycles", displayName: "Step Pulse Width (PRU Cycles)", default: 10 },

        /* --- Hidden generated constants --- */
        { name: "opCode", default: "m_multi_axis_motion_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 31, hidden: true },

        /* constants 1-7: global parameters */
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => inst.numAxes },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => parseInt(inst.eStopPin, 10) },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => pulseDelay(inst.pulseWidthCycles).k },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => pulseDelay(inst.pulseWidthCycles).nops },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.syncEnable ? 1 : 0 },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => hex32(~stepMask(inst)) },
        { name: "constant7", hidden: true, default: "", getValue: (inst) => hex32(~allMask(inst)) },

        /* constants 8-31: 6 per axis (step, dir, en, phase inc, target, forward) */
        ...axisConstants(0),
        ...axisConstants(1),
        ...axisConstants(2),
        ...axisConstants(3),

        { name: "noOfCycles", displayName: "Number Of Cycles",
          getValue: (inst) => tickCycles(inst), default: 50 }
    ],

    ports: (inst) => {
        return [
            { name: "output1", type: "output32" },  /* Status register (bitfield, bit 7 = E-Stop) */
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        /* Validate pin uniqueness across all configured axes */
        const usedPins = {};
        const checkPin = (pin, label, axis) => {
            if (!pin || pin === "") return;
            const key = `GPO_${pin}`;
            if (usedPins[key]) {
                validation.logError(`Pin GPO${pin} used by ${usedPins[key]} and ${label} on axis ${axis}`,
                    inst, label);
            }
            usedPins[key] = label;
        };
        for (let a = 0; a < inst.numAxes; a++) {
            checkPin(inst[`stepPin${a}`],   `stepPin${a}`,   a);
            checkPin(inst[`dirPin${a}`],    `dirPin${a}`,    a);
            checkPin(inst[`enablePin${a}`], `enablePin${a}`, a);
        }
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
        if (inst.numAxes < 1 || inst.numAxes > 4)
            validation.logError("numAxes must be 1..4", inst, "numAxes");
        for (let a = 0; a < 4; a++) {
            if (inst[`targetSteps${a}`] < 0 || inst[`targetSteps${a}`] > 16777215)
                validation.logError(`targetSteps${a} must be 0..16777215`, inst, `targetSteps${a}`);
            if (inst[`maxSpeedSps${a}`] < 1 || inst[`maxSpeedSps${a}`] > 200000)
                validation.logError(`maxSpeedSps${a} must be 1..200000`, inst, `maxSpeedSps${a}`);
            if (inst[`accel${a}`] < 1 || inst[`accel${a}`] > 10000000)
                validation.logError(`accel${a} must be 1..10000000`, inst, `accel${a}`);
        }
        if (inst.pulseWidthCycles < 2 || inst.pulseWidthCycles > 100)
            validation.logError("pulseWidthCycles must be 2..100", inst, "pulseWidthCycles");
        let base = parseInt(inst.dmemBase, 16);
        if (isNaN(base) || base < 0x0000 || base > 0x1fff)
            validation.logError("dmemBase must be 0x0000..0x1FFF", inst, "dmemBase");

        /* A step needs at least one full tick high and one low: a rate above
           half the tick rate cannot be generated. */
        if (inst.clkHz > 0 && inst.numAxes >= 1 && inst.numAxes <= 4) {
            const tick = tickCycles(inst);
            for (let a = 0; a < inst.numAxes; a++) {
                const stepsPerTick = inst[`maxSpeedSps${a}`] * tick / inst.clkHz;
                if (stepsPerTick > 0.5) {
                    validation.logError(
                        `maxSpeedSps${a}=${inst[`maxSpeedSps${a}`]} needs ${stepsPerTick.toFixed(2)} steps per ${tick}-cycle tick; ` +
                        `the tick generates at most one step per two ticks`, inst, `maxSpeedSps${a}`);
                }
            }
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        const formals = ["RES", "NUM_AXES", "ESTOP_PIN", "PULSE_K", "PULSE_NOPS", "SYNC", "INV_STEP_MASK", "INV_ALL_MASK"];
        for (let a = 0; a < MAX_AXES; a++) {
            for (const f of ["STEP", "DIR", "EN", "INC", "TGT", "FWD"]) formals.push(`${f}${a}`);
        }
        const L = [];
        L.push(`${opCode} .macro ${formals.join(", ")}`);
        L.push(`    ; Fixed-tick multi-axis step/dir generator. Per-axis state: acc = R${STATE_BASE_REG}+2a, remaining = R${STATE_BASE_REG + 1}+2a`);
        L.push(`    zero  &RES, 1`);
        L.push(`    ; --- per-axis state, direction and enable ---`);
        for (let a = 0; a < MAX_AXES; a++) {
            const acc = `R${STATE_BASE_REG + 2 * a}`, rem = `R${STATE_BASE_REG + 2 * a + 1}`;
            L.push(`    .if NUM_AXES >= ${a + 1}`);
            L.push(`    .if SYNC == 1`);
            L.push(`    ldi32 ${acc}, INC${a}`);
            L.push(`    rsb   ${acc}, ${acc}, 0                ; acc = 2^32 - inc: carries on the very first tick`);
            L.push(`    .else`);
            L.push(`    ldi32 ${acc}, 0`);
            L.push(`    .endif`);
            L.push(`    ldi32 ${rem}, TGT${a}`);
            L.push(`    .if FWD${a} == 1`);
            L.push(`    set   R30, R30, DIR${a}`);
            L.push(`    .else`);
            L.push(`    clr   R30, R30, DIR${a}`);
            L.push(`    .endif`);
            L.push(`    set   R30, R30, EN${a}`);
            L.push(`    .endif`);
        }
        L.push(`    ; --- DIR/EN settle before the first step ---`);
        L.push(`    ldi   TEMP_REG3.w0, ${SETTLE_ITERS}`);
        L.push(`ma_settle?:`);
        L.push(`    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`);
        L.push(`    qbne  ma_settle?, TEMP_REG3.w0, 0`);
        L.push(`    ldi32 TEMP_REG4, INV_STEP_MASK`);
        L.push(`    ; --- scheduler tick: identical instruction sequence every pass ---`);
        L.push(`ma_tick?:`);
        L.push(`    ldi   TEMP_REG1, 0`);
        L.push(`    qbbs  ma_estop?, R31, ESTOP_PIN`);
        for (let a = 0; a < MAX_AXES; a++) {
            const acc = `R${STATE_BASE_REG + 2 * a}`, rem = `R${STATE_BASE_REG + 2 * a + 1}`;
            L.push(`    .if NUM_AXES >= ${a + 1}`);
            L.push(`    ldi32 TEMP_REG3, INC${a}`);
            L.push(`    ldi   TEMP_REG2, 0`);
            L.push(`    add   ${acc}, ${acc}, TEMP_REG3        ; carry out = one step`);
            L.push(`    adc   TEMP_REG2, TEMP_REG2, 0`);
            L.push(`    min   TEMP_REG2, TEMP_REG2, ${rem}      ; no step once the target is reached`);
            L.push(`    sub   ${rem}, ${rem}, TEMP_REG2`);
            L.push(`    lsl   TEMP_REG2, TEMP_REG2, STEP${a}`);
            L.push(`    or    TEMP_REG1, TEMP_REG1, TEMP_REG2`);
            L.push(`    .endif`);
        }
        L.push(`    or    R30, R30, TEMP_REG1                ; broadside: all axes step on the same cycle`);
        L.push(`    .if PULSE_K > 0`);
        L.push(`    ldi   TEMP_REG3.w0, PULSE_K`);
        L.push(`ma_pw?:`);
        L.push(`    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`);
        L.push(`    qbne  ma_pw?, TEMP_REG3.w0, 0`);
        L.push(`    .endif`);
        L.push(`    .if PULSE_NOPS > 0`);
        L.push(`    mov   TEMP_REG3, TEMP_REG3`);
        L.push(`    .endif`);
        L.push(`    .if PULSE_NOPS > 1`);
        L.push(`    mov   TEMP_REG3, TEMP_REG3`);
        L.push(`    .endif`);
        L.push(`    and   R30, R30, TEMP_REG4                ; broadside: all step pins fall together`);
        L.push(`    mov   TEMP_REG2, R19`);
        for (let a = 1; a < MAX_AXES; a++) {
            L.push(`    .if NUM_AXES >= ${a + 1}`);
            L.push(`    or    TEMP_REG2, TEMP_REG2, R${STATE_BASE_REG + 2 * a + 1}`);
            L.push(`    .endif`);
        }
        L.push(`    qbne  ma_tick?, TEMP_REG2, 0`);
        L.push(`    qba   ma_done?`);
        L.push(`ma_estop?:`);
        L.push(`    ; Emergency stop: clear every pin this block drives, latch status bit 7, halt`);
        L.push(`    ldi32 TEMP_REG2, INV_ALL_MASK`);
        L.push(`    and   R30, R30, TEMP_REG2`);
        L.push(`    set   RES, RES, 7`);
        L.push(`    halt`);
        L.push(`ma_done?:`);
        L.push(`    .endm`);
        return L.join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            for (let a = 0; a < inst.numAxes; a++) {
                pins.push({ pin: parseInt(inst["stepPin" + a]), dir: "GPO" });
                pins.push({ pin: parseInt(inst["dirPin" + a]), dir: "GPO" });
                pins.push({ pin: parseInt(inst["enablePin" + a]), dir: "GPO" });
            }
            pins.push({ pin: parseInt(inst.eStopPin), dir: "GPI" });
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

exports = multiAxisMotionModule;
