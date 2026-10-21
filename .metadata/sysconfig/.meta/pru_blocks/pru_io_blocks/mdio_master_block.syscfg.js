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

// MDC timing model of m_mdio_xfer, measured from the simulated pin trace (tests/test_mdio_preamble_mdc.py):
// shortest MDC high phase = 2*trips + 2 cycles in both modes; shortest low phase = 2*trips + 9 cycles in write mode but
// only 2*trips + 2 in read mode (the turn-around runs md_ta1_hi -> clr -> ldi -> md_ta2_lo -> set back to back).
const MDC_CYCLES_PER_TRIP = 2;
const MDC_HIGH_FIXED_CYCLES = 2;
const MDC_LOW_FIXED_CYCLES = 9;
const MDC_LOW_FIXED_CYCLES_READ = 2;
const MDC_MIN_PHASE_NS = 160;
const MDC_MIN_PERIOD_NS = 400;
// A frame is 64 MDC clocks in both directions (32 preamble + 14 header + 18 TA/data in write mode; 32 + 14 + 2 TA + 16
// data in read mode), 4 delay trips each (two per phase), plus fixed setup/epilogue cycles measured from the same trace.
const MDC_FRAME_CLOCKS = 64;
const MDC_FRAME_FIXED_CYCLES_WRITE = 720;
const MDC_FRAME_FIXED_CYCLES_READ = 690;

function mdioFrameCycles(inst) {
    const trips = parseInt(inst.halfTrips, 10) || 0;
    return MDC_FRAME_CLOCKS * 2 * MDC_CYCLES_PER_TRIP * trips +
        (inst.rw === "read" ? MDC_FRAME_FIXED_CYCLES_READ : MDC_FRAME_FIXED_CYCLES_WRITE);
}

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i), displayName: `PRU GPIO ${i} (R30/R31.${i})`,
}));

const mdioModule = {
    displayName: "MDIO Clause 22 master",
    defaultInstanceName: `${PRU_USED}_MDIO_INSTANCE_`,
    description: "IEEE 802.3 Clause 22 PHY management read/write transaction (MDC <= 2.5 MHz).",
    longDescription: `Bit-banged MDIO Clause 22 master (STA) for Ethernet PHY management.\n\nWire contract per IEEE 802.3 Clause 22 only: 32-bit preamble of 1s, ST=01, OP (01=write, 10=read), 5-bit PHYAD, 5-bit REGAD, turn-around (master 10 on write; master released and PHY drives 0 on read), 16-bit data MSB first. MDC half period is HALF_TRIPS delay-loop trips (2 PRU cycles each plus a fixed per-phase cost); validation requires MDC high and low >= 160 ns and period >= 400 ns (the 2.5 MHz Clause 22 ceiling) at the configured PRU clock.\n\nVendor MDIO behaviours (TI ICSS doorbells, register layouts, driver sequencing) are intentionally NOT part of this block.\n\nUses only TEMP_REG1 and TEMP_REG2 (2-TEMP_REG pattern). In read mode the 16-bit result is written to the data register (dataRegister) and is also exposed on output1 (RES), so it can be wired to a downstream block; write data is taken from the WRDATA argument register. dataRegister must be a full register token R<n> (e.g. R4): the read copies the 32-bit result with one mov, so a sub-register token such as R4.b0 or R4.w0 truncates the sample or leaves the register's upper bytes stale; the allocator reserves the whole register either way.`,
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "mdcBit", displayName: "MDC R30 bit", default: "0", options: GPIO_SIGNALS },
        { name: "mdioBit", displayName: "MDIO R30/R31 bit", default: "1", options: GPIO_SIGNALS },
        { name: "phyAddr", displayName: "PHY address (5-bit)", default: "0" },
        { name: "regAddr", displayName: "Register address (5-bit)", default: "0" },
        { name: "rw", displayName: "Direction", default: "write", options: [{name:"read"}, {name:"write"}] },
        { name: "halfTrips", displayName: "MDC half-period delay trips", default: 50 },
        { name: "dataRegister", displayName: "RX/TX data register", default: "R4" },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_mdio_xfer", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.mdcBit },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.mdioBit },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => inst.halfTrips },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => parseInt(inst.phyAddr, 10) & 0x1F },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => parseInt(inst.regAddr, 10) & 0x1F },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => inst.rw === "read" ? 1 : 0 },
        { name: "constant7", hidden: true, default: "", getValue: (inst) => inst.dataRegister },

        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => mdioFrameCycles(inst), default: 1 },
        { name: "blockMaturity", displayName: "Block Maturity", default: "metadata-only", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true }
    ],

    ports: (inst) => {
        const out = inst.rw === "read" ? [{ name: "output1", type: "output32" }] : [];
        return [
            ...out,
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (inst.mdcBit === inst.mdioBit) {
            validation.logError("mdcBit and mdioBit must differ", inst, "mdcBit");
        }
        const phy = parseInt(inst.phyAddr, 10);
        if (isNaN(phy) || phy < 0 || phy > 31) {
            validation.logError("phyAddr must be 0..31 (5-bit Clause 22 PHYAD)", inst, "phyAddr");
        }
        const reg = parseInt(inst.regAddr, 10);
        if (isNaN(reg) || reg < 0 || reg > 31) {
            validation.logError("regAddr must be 0..31 (5-bit Clause 22 REGAD)", inst, "regAddr");
        }
        // IEEE 802.3 22.2.2.11: MDC high >= 160 ns, low >= 160 ns, period >= 400 ns (2.5 MHz ceiling).
        // The cycle cost of one MDC cycle is MDC_CYCLES_PER_TRIP per delay trip (sub + qbne) plus a fixed
        // cost per phase, measured from the simulated pin trace of the macro (tests/test_mdio_preamble_mdc.py).
        // A larger trip count is always legal (slower MDC); only too-fast is refused.
        const lowFixed = inst.rw === "read" ? MDC_LOW_FIXED_CYCLES_READ : MDC_LOW_FIXED_CYCLES;
        const nsPerCycle = 1e9 / inst.clkHz;
        const minHiCycles = MDC_MIN_PHASE_NS / nsPerCycle;
        // (the low-phase term never exceeds the high-phase one, since lowFixed >= MDC_HIGH_FIXED_CYCLES; kept so the code states the rule)
        const minLoCycles = MDC_MIN_PHASE_NS / nsPerCycle;
        const minPeriodCycles = MDC_MIN_PERIOD_NS / nsPerCycle;
        const minTrips = Math.max(
            Math.ceil((minHiCycles - MDC_HIGH_FIXED_CYCLES) / MDC_CYCLES_PER_TRIP),
            Math.ceil((minLoCycles - lowFixed) / MDC_CYCLES_PER_TRIP),
            Math.ceil((minPeriodCycles - MDC_HIGH_FIXED_CYCLES - lowFixed) / (2 * MDC_CYCLES_PER_TRIP)));
        if (inst.halfTrips < minTrips) {
            validation.logError(
                `halfTrips=${inst.halfTrips} exceeds the 2.5 MHz Clause 22 MDC ceiling ` +
                `(MDC phases >= ${MDC_MIN_PHASE_NS} ns and period >= ${MDC_MIN_PERIOD_NS} ns need >= ${minTrips} trips ` +
                `at ${inst.clkHz / 1e6} MHz PRU clock)`,
                inst, "halfTrips");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, MDC_BIT, MDIO_BIT, HALF_TRIPS, PHY_ADDR, REG_ADDR, IS_READ, WRDATA_REG`,
            `    ; MDIO Clause 22 master - IEEE 802.3 wire contract only`,
            `    ; 2-TEMP_REG pattern: TEMP_REG1 shifts the frame, TEMP_REG2 is bit counter/delay`,
            `    clr   R30, R30, MDC_BIT`,
            `    set   R30, R30, MDIO_BIT`,
            `    ; ---- preamble: 32 clocked 1 bits (IEEE 802.3 22.2.4.5.1) ----`,
            `    ldi32 TEMP_REG1, 0xFFFFFFFF`,
            `    ldi   TEMP_REG2.b0, 32`,
            `md_pre?:`,
            `    lsr   TEMP_REG2.w2, TEMP_REG1, 31`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.w2, MDIO_BIT`,
            `    clr   R30, R30, MDIO_BIT`,
            `    or    R30, R30, TEMP_REG2.w2`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_pre_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_pre_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_pre_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_pre_hi?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, MDC_BIT`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  md_pre?, TEMP_REG2.b0, 0`,
            `    ; ---- header: ST=01 OP PHYAD REGAD, 14 bits MSB first ----`,
            `    .if IS_READ == 1`,
            `    ldi32 TEMP_REG1, ((0x1000 | (2 << 10) | (PHY_ADDR << 5) | REG_ADDR) << 18)`,
            `    .else`,
            `    ldi32 TEMP_REG1, ((0x1000 | (1 << 10) | (PHY_ADDR << 5) | REG_ADDR) << 18)`,
            `    .endif`,
            `    ldi   TEMP_REG2.b0, 14`,
            `md_hdr?:`,
            `    lsr   TEMP_REG2.w2, TEMP_REG1, 31`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.w2, MDIO_BIT`,
            `    clr   R30, R30, MDIO_BIT`,
            `    or    R30, R30, TEMP_REG2.w2`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_hdr_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_hdr_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_hdr_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_hdr_hi?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, MDC_BIT`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  md_hdr?, TEMP_REG2.b0, 0`,
            `    .if IS_READ == 1`,
            `    ; ---- read: release MDIO (1) for TA bit 1 and TA bit 2, PHY drives 0 ----`,
            `    set   R30, R30, MDIO_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_ta1_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_ta1_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_ta1_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_ta1_hi?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_ta2_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_ta2_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_ta2_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_ta2_hi?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, MDC_BIT`,
            `    ; ---- sample 16 data bits from R31 on rising MDC ----`,
            `    ldi32 RES, 0`,
            `    ldi   TEMP_REG2.b0, 16`,
            `md_rd?:`,
            `    lsl   RES, RES, 1`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_rd_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_rd_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_rd_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_rd_hi?, TEMP_REG2.w2, 0`,
            `    lsr   TEMP_REG2.w2, R31, MDIO_BIT`,
            `    and   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    or    RES, RES, TEMP_REG2.w2`,
            `    clr   R30, R30, MDC_BIT`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  md_rd?, TEMP_REG2.b0, 0`,
            `    ; read result: RES is output1, WRDATA_REG is the data register (dataRegister)`,
            `    mov   WRDATA_REG, RES`,
            `    .else`,
            `    ; ---- write: TA=10 then 16 data bits, shifted as 18 bits ----`,
            `    ldi32 TEMP_REG2, 0x80000000`,
            `    lsl   TEMP_REG1, WRDATA_REG, 14`,
            `    or    TEMP_REG1, TEMP_REG1, TEMP_REG2`,
            `    ldi   TEMP_REG2.b0, 18`,
            `md_wr?:`,
            `    lsr   TEMP_REG2.w2, TEMP_REG1, 31`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.w2, MDIO_BIT`,
            `    clr   R30, R30, MDIO_BIT`,
            `    or    R30, R30, TEMP_REG2.w2`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_wr_lo?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_wr_lo?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, MDC_BIT`,
            `    ldi   TEMP_REG2.w2, HALF_TRIPS`,
            `md_wr_hi?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  md_wr_hi?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, MDC_BIT`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  md_wr?, TEMP_REG2.b0, 0`,
            `    .endif`,
            `    ; idle: MDC low, MDIO released high`,
            `    clr   R30, R30, MDC_BIT`,
            `    set   R30, R30, MDIO_BIT`,
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
            pins.push({ pin: parseInt(inst.mdcBit), dir: "GPO" });
            if (inst.rw === "read") {   // R31 is sampled only under IS_READ == 1
                pins.push({ pin: parseInt(inst.mdioBit), dir: "GPO", bidi: true });
                pins.push({ pin: parseInt(inst.mdioBit), dir: "GPI", bidi: true });
            } else {
                pins.push({ pin: parseInt(inst.mdioBit), dir: "GPO" });
            }
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

exports = mdioModule;
