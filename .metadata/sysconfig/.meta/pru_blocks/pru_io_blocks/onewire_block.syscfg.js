"use strict";

const TIMINGS_US = {
    standard:  { resetLow: 480, presenceWait: 70, resetRecovery: 410,
                 writeLow1: 6, writeHigh1: 64, writeLow0: 60, writeHigh0: 10,
                 readLow: 6, readSample: 9, readRecovery: 55 },
    overdrive: { resetLow: 70, presenceWait: 8.5, resetRecovery: 40,
                 writeLow1: 1.0, writeHigh1: 7.5, writeLow0: 7.5, writeHigh0: 2.5,
                 readLow: 1.0, readSample: 1.0, readRecovery: 7 },
};

const OPERATIONS = [
    { name: "reset",     displayName: "Reset + presence detect" },
    { name: "writeByte", displayName: "Write byte" },
    { name: "readByte",  displayName: "Read byte" },
];
const SPEEDS = [
    { name: "standard",  displayName: "Standard (~15 kbit/s)" },
    { name: "overdrive", displayName: "Overdrive (~125 kbit/s)" },
];

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

const cyc = (us, clkHz) => Math.round((us * clkHz) / 1e6);

function opCodeOf(inst) {
    return `m_onewire_${inst.operation}_${inst.speed}`;
}

const onewireModule = {
    displayName: "1-Wire Master",
    defaultInstanceName: `${PRU_USED}_ONEWIRE_INSTANCE_`,
    description: "Dallas/Maxim 1-Wire open-drain master (Maxim AN126 timing).",
    longDescription: "Bit-bangs the 1-Wire reset/presence pulse and read/write time slots.",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "dual-oracle-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "dataPin", displayName: "Data signal (R30/R31)",
          default: "7", options: GPIO_SIGNALS },
        { name: "operation", displayName: "Operation",
          default: "reset", options: OPERATIONS },
        { name: "speed", displayName: "Bus speed",
          default: "standard", options: SPEEDS },
        { name: "byteValue", displayName: "Byte to write (writeByte)",
          default: 0xCC, displayFormat: "hex" },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        // TI dynamic register allocator fields
        { name: "opCode", default: "m_onewire_reset_standard", hidden: true,
          getValue: (inst) => opCodeOf(inst) },
        { name: "numOfInputPorts", default: 1, hidden: true, 
          getValue: (inst) => inst.operation === "writeByte" ? 1 : 0 },
        { name: "numOfOutputPorts", default: 1, hidden: true, 
          getValue: (inst) => inst.operation !== "writeByte" ? 1 : 0 },
        { name: "output1Size", default: 1, hidden: true, 
          getValue: (inst) => inst.operation !== "writeByte" ? 1 : 0 },
        { name: "numOfConstants", default: 4, hidden: true,
          getValue: (inst) => {
              if (inst.operation === "reset") return 4;
              if (inst.operation === "writeByte") return 5;
              return 4; // readByte
          } 
        },
        // Constants exposed to macro call
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.dataPin },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => {
            const t = TIMINGS_US[inst.speed];
            return cyc(inst.operation === "writeByte" ? t.writeLow1 : inst.operation === "readByte" ? t.readLow : t.resetLow, inst.clkHz);
        }},
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => {
            const t = TIMINGS_US[inst.speed];
            return cyc(inst.operation === "writeByte" ? t.writeHigh1 : inst.operation === "readByte" ? t.readSample : t.presenceWait, inst.clkHz);
        }},
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => {
            const t = TIMINGS_US[inst.speed];
            return cyc(inst.operation === "writeByte" ? t.writeLow0 : inst.operation === "readByte" ? t.readRecovery : t.resetRecovery, inst.clkHz);
        }},
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => {
            const t = TIMINGS_US[inst.speed];
            return inst.operation === "writeByte" ? cyc(t.writeHigh0, inst.clkHz) : 0;
        }},
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (inst) => 1,
            default: 1
        }
    ],

    ports: (inst) => { 
        let ports = [];
        if (inst.operation === "writeByte") {
            ports.push({ name: "input1", type: "input32" });
        } else {
            ports.push({ name: "output1", type: "output32" });
        }
        ports.push({ name: "prev", type: "IO_PREV" });
        ports.push({ name: "next", type: "IO_NEXT" });
        return ports;
    },

    validate(inst, validation) {
        if (!OPERATIONS.some((o) => o.name === inst.operation)) {
            validation.logError("Unknown operation", inst, "operation");
        }
        if (inst.clkHz <= 0) {
            validation.logError("PRU clock must be > 0 Hz", inst, "clkHz");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        const op = opCode.includes("_reset_") ? "reset" : opCode.includes("_writeByte_") ? "writeByte" : "readByte";
        
        let out = [];
        if (op === "reset") {
            out = [
                `${opCode} .macro RES, PIN, RLOW, PWAIT, RREC`,
                `    clr   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, RLOW`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owrl?:`,
                `    sub   TEMP_REG1, TEMP_REG1, 1`,
                `    qbne  owrl?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, PWAIT`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owpw?:`,
                `    sub   TEMP_REG1, TEMP_REG1, 1`,
                `    qbne  owpw?, TEMP_REG1, 0`,
                `    ldi   RES, 0`,
                `    qbbs  owrd?, R31, PIN`,
                `    ldi   RES, 1`,
                `owrd?:`,
                `    ldi32 TEMP_REG1, RREC`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owrr?:`,
                `    sub   TEMP_REG1, TEMP_REG1, 1`,
                `    qbne  owrr?, TEMP_REG1, 0`,
                `    .endm`,
            ];
        } else if (op === "writeByte") {
            out = [
                // The generator always passes an output register, even for writeByte.
                `${opCode} .macro RES, VAL, PIN, W1L, W1H, W0L, W0H`,
                `    mov   TEMP_REG2, VAL`,
                `    ldi   TEMP_REG1, 8`,
                `owwb?:`,
                `    clr   R30, R30, PIN`,
                `    qbbc  oww0?, TEMP_REG2, 0`,
                `    ldi32 TEMP_REG1, W1L`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww1l?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww1l?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, W1H`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww1h?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww1h?, TEMP_REG1, 0`,
                `    qba   owwn?`,
                `oww0?:`,
                `    ldi32 TEMP_REG1, W0L`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww0l?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww0l?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, W0H`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww0h?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww0h?, TEMP_REG1, 0`,
                `owwn?:`,
                `    lsr   TEMP_REG2, TEMP_REG2, 1`,
                `    sub   TEMP_REG1, TEMP_REG1, 1`,
                `    qbne  owwb?, TEMP_REG1, 0`,
                `    .endm`,
            ];
            // BUGFIX: We need TWO registers for write loop state (VAL/shift register and bit count).
            // But TEMP_REG1 is overwritten inside the loop for delays!
            // Let's use TEMP_REG2 for VAL, but we still need a loop counter. 
            // Wait, we can't use TEMP_REG1 for both loop counter and delay counter.
            // TI provides TEMP_REG1 (R28) and TEMP_REG2 (R29).
            // If we use TEMP_REG2 for VAL (shift register), and TEMP_REG1 for delays, where does bit counter go?
            // Let's just hardcode R5 and R6 if TI allows, or push/pop? PRU has no stack.
            // Or we can use a register from the allocator. We could request an extra scratch output register, but it's write-only.
            // Wait! The macro in writeByte takes `VAL` as an input register. We can just shift `VAL` directly! It's a pass-by-value from allocator!
            // But `VAL` is an input register! The allocator might share it with other branches. We should NOT mutate `VAL`.
            // Let's define `TEMP_REG2` as the shift register (copy `VAL` to `TEMP_REG2`).
            // What about the bit counter? Let's use `r27.b0` or `r27` (some safe scratch)?
            // Wait, let's just use `TEMP_REG2` for both! 
            // R29 (TEMP_REG2) has 4 bytes. We can use R29.b0 for the shift register, and R29.b1 for the bit counter!
        }
        
        if (op === "writeByte") {
            out = [
                // The generator always passes an output register, even for writeByte.
                `${opCode} .macro RES, VAL, PIN, W1L, W1H, W0L, W0H`,
                `    mov   TEMP_REG2.b0, VAL`,
                `    ldi   TEMP_REG2.b1, 8`,
                `owwb?:`,
                `    clr   R30, R30, PIN`,
                `    qbbc  oww0?, TEMP_REG2.b0, 0`,
                `    ldi32 TEMP_REG1, W1L`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww1l?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww1l?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, W1H`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww1h?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww1h?, TEMP_REG1, 0`,
                `    qba   owwn?`,
                `oww0?:`,
                `    ldi32 TEMP_REG1, W0L`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww0l?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww0l?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, W0H`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `oww0h?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne oww0h?, TEMP_REG1, 0`,
                `owwn?:`,
                `    lsr   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
                `    sub   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
                `    qbne  owwb?, TEMP_REG2.b1, 0`,
                `    .endm`,
            ];
        } else if (op === "readByte") {
            out = [
                `${opCode} .macro ACC, PIN, RL, RS, RR`,
                `    ldi   ACC, 0`,
                `    ldi   TEMP_REG2.b1, 8`,
                `owrb?:`,
                `    clr   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, RL`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owrll?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne owrll?, TEMP_REG1, 0`,
                `    set   R30, R30, PIN`,
                `    ldi32 TEMP_REG1, RS`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owrsl?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne owrsl?, TEMP_REG1, 0`,
                `    lsr   ACC, ACC, 1`,
                `    qbbc  owrn?, R31, PIN`,
                `    set   ACC, ACC, 7`,
                `owrn?:`,
                `    ldi32 TEMP_REG1, RR`,
                `    lsr   TEMP_REG1, TEMP_REG1, 1`,
                `owrrl?:`, `    sub TEMP_REG1, TEMP_REG1, 1`, `    qbne owrrl?, TEMP_REG1, 0`,
                `    sub   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
                `    qbne  owrb?, TEMP_REG2.b1, 0`,
                `    .endm`,
            ];
        }
        
        return out.join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {

        getPinUsage: function(inst) {
            const pins = [];
            if (inst.dataPin !== undefined) {
                pins.push({ pin: parseInt(inst.dataPin), dir: "GPO", bidi: true });
                pins.push({ pin: parseInt(inst.dataPin), dir: "GPI", bidi: true });
            }
            return pins;
        }
    ,
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = onewireModule;
if (typeof module !== "undefined" && module.exports) module.exports = onewireModule;
