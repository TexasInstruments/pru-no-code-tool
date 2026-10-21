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

// The CLK period is bitCycles exactly. Every instruction in m_serdes_run is one PRU cycle and none of them branches
// on data, so each CLK phase is a fixed instruction count plus a delay of D cycles, built as
// `ldi` + TRIPS x (sub, qbne) = 1 + 2*TRIPS cycles, followed by PAD (0..2) nops.
//   CLK low  (clr CLK .. set CLK): clr CLK, shift TX word, sub, qbne | take bit, and, clr DOUT, lsl, or        = 9
//   CLK high (set CLK .. clr CLK): set CLK, lsr R31, and, MSB: lsl, or, nop / LSB: lsr, lsl 7, or (into b3)  = 6
const SERDES_LOW_FIXED = 9;
const SERDES_HIGH_FIXED = 6;                // same for both bit orders since (3 RX instructions per bit each)
const SERDES_MAX_TRIPS = 0xFFFF;          // the trip counter is TEMP_REG2.w2

function serdesDelay(cycles) {
    const d = Math.max(0, cycles);
    if (d < 3) return { trips: 0, pad: d };
    return { trips: Math.floor((d - 1) / 2), pad: (d - 1) % 2 };
}

// Phase split: CLK-low (setup) = round(bitCycles * pre / (pre + post)), clamped to what the fixed instructions allow.
function serdesTiming(inst) {
    const bitCycles = Number(inst.bitCycles), pre = Number(inst.preCycles), post = Number(inst.postCycles);
    const highFixed = SERDES_HIGH_FIXED;
    const minimum = SERDES_LOW_FIXED + highFixed;
    const share = (pre + post) > 0 ? pre / (pre + post) : 0.5;
    const requested = Math.round(bitCycles * share);
    const low = Math.max(SERDES_LOW_FIXED, Math.min(requested, bitCycles - highFixed));
    const high = bitCycles - low;
    const lowDelay = serdesDelay(low - SERDES_LOW_FIXED);
    const highDelay = serdesDelay(high - highFixed);
    return {
        bitCycles, minimum, lowFixed: SERDES_LOW_FIXED, highFixed, requested, low, high,
        lowTrips: lowDelay.trips, lowPad: lowDelay.pad, highTrips: highDelay.trips, highPad: highDelay.pad,
    };
}

const SERDES_LONG_DESCRIPTION = `
## SerDes (shift register)

Shifts a WIDTH-bit word out on DOUT and samples DIN into the RX output register, one bit per CLK period, MSB- or LSB-first.
Each bit: DOUT is driven while CLK is low, CLK rises, DIN is sampled on the next cycle, CLK falls.

### Technical Details (Additional Information)

**Bit period.** The CLK period is exactly **bitCycles** PRU cycles, for both bit orders, on every bit and for every
data value (no instruction in the bit loop branches on data). The block derives the delay loop counts from bitCycles:

- CLK-low phase fixed cost: 9 cycles (clr CLK, shift TX word, loop decrement, loop branch, take TX bit, mask, clr DOUT, shift, or into R30).
- CLK-high phase fixed cost: 6 cycles for both bit orders (set CLK, read R31, mask, then MSB-first: shift RX word, or, nop; LSB-first: shift RX word, move the bit to 7, or into the top byte).
- Each phase adds a delay of D cycles: an \`ldi\` plus TRIPS two-cycle (sub, qbne) trips, then 0..2 \`nop\`s.
  D < 3 is D nops; otherwise TRIPS = floor((D - 1) / 2) and one \`nop\` when D is even.
- Minimum bitCycles = 15 for both bit orders. A smaller value is rejected. The maximum is set by the 16-bit trip counter (65535 trips per phase).

**Setup / hold shares (preCycles / postCycles).** These no longer count delay-loop trips. They set the CLK phase split within the bit:
the CLK-low (setup) phase is round(bitCycles * preCycles / (preCycles + postCycles)) cycles and the CLK-high (hold) phase is the rest.
When that request does not fit the fixed cost of a phase, the split is clamped (CLK low at least 9 cycles, CLK high at least 6)
and SysConfig warns with the split actually generated. The defaults 4 / 4 give a 50% split (17 low / 16 high at bitCycles 33).

**Migration.** Before bitCycles was ignored: the period was 17 + 2 * (preCycles + postCycles) cycles MSB-first and one more
LSB-first, so a saved design with the defaults (33 / 4 / 4) keeps a 33-cycle period MSB-first and goes from 34 to 33 LSB-first;
any other preCycles / postCycles now produce the configured bitCycles instead of the old trip-derived period.

**Evidence.** tests/test_serdes_bit_period.py measures the CLK period from R30 edges on the TI pru-simulator running the
real SysConfig + clpru ELF at bitCycles 14..64, both bit orders, against the configured number. NOT hardware validated.
`;

function isRegMode(inst) {
    return inst.txMode === "register";
}

const serdesModule = {
    displayName: "SerDes (shift register)",
    defaultInstanceName: `${PRU_USED}_SERDES_INSTANCE_`,
    description: "A4 SerDes primitive.",
    longDescription: SERDES_LONG_DESCRIPTION,
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "dual-oracle-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "width", displayName: "Bits per word", default: 8 },
        { name: "bitOrder", displayName: "Bit order", default: "MSB", options: [{name:"MSB"}, {name:"LSB"}] },
        { name: "bitCycles", displayName: "Cycles per bit", default: 33,
          description: "CLK period in PRU cycles, exact for both bit orders (minimum 15)." },
        { name: "preCycles", displayName: "Setup (CLK low) share", default: 4,
          description: "CLK-low phase = round(bitCycles * preCycles / (preCycles + postCycles)) cycles, clamped to the fixed instruction cost." },
        { name: "postCycles", displayName: "Hold (CLK high) share", default: 4,
          description: "CLK-high phase = bitCycles minus the CLK-low phase." },
        { name: "doutBit", displayName: "Data-out R30 bit", default: "0", options: GPIO_SIGNALS },
        { name: "clkBit", displayName: "Clock R30 bit", default: "1", options: GPIO_SIGNALS },
        { name: "dinBit", displayName: "Data-in R31 bit", default: "2", options: GPIO_SIGNALS },
        { name: "txMode", displayName: "Transmit Mode", default: "constant", options: [{name: "constant"}, {name: "register"}] },
        { name: "txRegister", displayName: "TX Input Register", default: "R2" },
        { name: "demoWord", displayName: "Demo word (hex)", default: "0xA5" },
        { name: "dataRegister", displayName: "RX Output Register", default: "R1" },

        { name: "opCode", default: "m_serdes_run", hidden: true,
          getValue: (inst) => isRegMode(inst) ? "m_serdes_run_reg" : "m_serdes_run" },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 12, hidden: true },
        
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => inst.width },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => inst.bitOrder === 'MSB' ? 1 : 0 },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => 32 - inst.width },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.doutBit },
        { name: "constant5", hidden: true, default: "", getValue: (inst) => inst.clkBit },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => inst.dinBit },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => serdesTiming(inst).lowTrips },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => serdesTiming(inst).lowPad },
        { name: "constant9", hidden: true, default: 0, getValue: (inst) => serdesTiming(inst).highTrips },
        { name: "constant10", hidden: true, default: 0, getValue: (inst) => serdesTiming(inst).highPad },
        { name: "constant11", hidden: true, default: "", getValue: (inst) => {
            if (isRegMode(inst)) return inst.txRegister;
            let val = parseInt(inst.demoWord, 16);
            if (isNaN(val)) val = parseInt(inst.demoWord);
            return String(val);
        }},
        { name: "constant12", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        
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
        if (inst.width < 1 || inst.width > 32) validation.logError("width must be 1..32", inst, "width");
        if (inst.doutBit === inst.clkBit) validation.logError("doutBit and clkBit must differ", inst, "doutBit");
        if (isRegMode(inst)) {
            if (!/^\s*R\d+(\.[bw]\d)?\s*$/i.test(inst.txRegister)) {
                validation.logError("txRegister must be a valid PRU register (e.g. R0..R27)", inst, "txRegister");
            } else {
                const sub = /\.([bw])\d\s*$/i.exec(inst.txRegister);
                if (sub) {
                    const subBits = sub[1].toLowerCase() === "b" ? 8 : 16;
                    if (inst.width > subBits) {
                        validation.logError(`txRegister ${String(inst.txRegister).trim()} is ${subBits} bits, narrower than width ${inst.width}: the word would be silently truncated; use a wider sub-register or a full register`, inst, "txRegister");
                    }
                }
            }
        }
        if (inst.txMode !== "constant" && inst.txMode !== "register") {
            validation.logError("txMode must be 'constant' or 'register'", inst, "txMode");
        }
        const t = serdesTiming(inst);
        if (!Number.isInteger(t.bitCycles)) {
            validation.logError(`bitCycles must be a whole number of PRU cycles, got ${inst.bitCycles}`, inst, "bitCycles");
        } else if (t.bitCycles < t.minimum) {
            validation.logError(`bitCycles ${t.bitCycles} is below the minimum ${t.minimum} for ${inst.bitOrder}-first: one bit costs ${t.lowFixed} fixed cycles with CLK low and ${t.highFixed} with CLK high`, inst, "bitCycles");
        } else if (t.lowTrips > SERDES_MAX_TRIPS || t.highTrips > SERDES_MAX_TRIPS) {
            validation.logError(`bitCycles ${t.bitCycles} needs more than ${SERDES_MAX_TRIPS} delay trips in one CLK phase`, inst, "bitCycles");
        }
        const pre = Number(inst.preCycles), post = Number(inst.postCycles);
        if (!Number.isInteger(pre) || !Number.isInteger(post) || pre < 0 || post < 0 || pre + post === 0) {
            validation.logError("preCycles and postCycles must be non-negative whole numbers with a positive sum", inst, "preCycles");
        } else if (Number.isInteger(t.bitCycles) && t.bitCycles >= t.minimum && t.low !== t.requested) {
            validation.logWarning(`CLK phase split clamped: requested ${t.requested} cycles CLK low, generated ${t.low} low / ${t.high} high (fixed cost ${t.lowFixed} low, ${t.highFixed} high)`, inst, "preCycles");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        const isReg = opCode.includes("reg");
        const txArg = isReg ? "TX_REG" : "DEMO_WORD";
        const txLoad = isReg ? "    mov   TEMP_REG1, TX_REG" : "    ldi32 TEMP_REG1, DEMO_WORD";
        return [
            `${opCode} .macro RES, WIDTH, IS_MSB, ALIGN, DOUT_BIT, CLK_BIT, DIN_BIT, LOW_TRIPS, LOW_PAD, HIGH_TRIPS, HIGH_PAD, ${txArg}, DATA_REG`,
            `    zero  &DATA_REG, 4`,
            txLoad,
            `    .if IS_MSB == 1`,
            `    lsl   TEMP_REG1, TEMP_REG1, ALIGN`,
            `    .endif`,
            `    ldi TEMP_REG2.b0, WIDTH`,
            `    clr   R30, R30, CLK_BIT`,
            `    clr   R30, R30, DOUT_BIT`,
            `sd_tx?:`,
            `    .if IS_MSB == 1`,
            `    lsr   TEMP_REG2.b1, TEMP_REG1, 31`,
            `    .else`,
            `    mov   TEMP_REG2.b1, TEMP_REG1.b0`,
            `    .endif`,
            `    and   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
            `    clr   R30, R30, DOUT_BIT`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.b1, DOUT_BIT`,
            `    or    R30, R30, TEMP_REG2.w2`,
            `    ; CLK low = 9 fixed cycles + LOW_TRIPS delay (1 + 2*trips) + LOW_PAD nops`,
            `    .if LOW_TRIPS != 0`,
            `    ldi TEMP_REG2.w2, LOW_TRIPS`,
            `sd_pre?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  sd_pre?, TEMP_REG2.w2, 0`,
            `    .endif`,
            `    .if LOW_PAD != 0`,
            `    nop`,
            `    .endif`,
            `    .if LOW_PAD == 2`,
            `    nop`,
            `    .endif`,
            `    set   R30, R30, CLK_BIT`,
            `    lsr   TEMP_REG2.b1, R31, DIN_BIT`,
            `    and   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
            `    .if IS_MSB == 1`,
            `    lsl   DATA_REG, DATA_REG, 1`,
            `    or    DATA_REG, DATA_REG, TEMP_REG2.b1`,
            `    nop   ; Keep MSB/LSB per-bit counts equal`,
            `    .else`,
            `    lsr   DATA_REG, DATA_REG, 1`,
            `    lsl   TEMP_REG2.b1, TEMP_REG2.b1, 7`,
            `    or    DATA_REG.b3, DATA_REG.b3, TEMP_REG2.b1`,
            `    .endif`,
            `    ; CLK high = 6 fixed cycles (both orders) + HIGH_TRIPS delay (1 + 2*trips) + HIGH_PAD nops`,
            `    .if HIGH_TRIPS != 0`,
            `    ldi TEMP_REG2.w2, HIGH_TRIPS`,
            `sd_pos?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  sd_pos?, TEMP_REG2.w2, 0`,
            `    .endif`,
            `    .if HIGH_PAD != 0`,
            `    nop`,
            `    .endif`,
            `    .if HIGH_PAD == 2`,
            `    nop`,
            `    .endif`,
            `    clr   R30, R30, CLK_BIT`,
            `    .if IS_MSB == 1`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1`,
            `    .else`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `    .endif`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  sd_tx?, TEMP_REG2.b0, 0`,
            `    .if IS_MSB == 0`,
            `    lsr   DATA_REG, DATA_REG, ALIGN`,
            `    .endif`,
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
            pins.push({ pin: parseInt(inst.doutBit), dir: "GPO" });
            pins.push({ pin: parseInt(inst.clkBit), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dinBit), dir: "GPI" });
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

exports = serdesModule;
