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

const sentModule = {
    displayName: "SENT (SAE J2716) TX",
    defaultInstanceName: `${PRU_USED}_SENT_INSTANCE_`,
    description: "SAE J2716 (SENT) protocol transmitter.",
    longDescription: "Transmits a SENT frame using edge timing. Each nibble is encoded as the time between successive falling edges, so the CRC nibble is closed by a final falling edge (a low pulse of lowTicks, then the pin is released high). Chaining: the macro returns the pin high straight after that closing low, so a second frame started immediately re-asserts low only a few cycles later (a ~15 ns high runt between two low pulses). Separate back-to-back frames by at least one tick of idle high (for example a Delay block), or the receiver may see the closing low and the next sync pulse merge.",
    uiView: "graph",

    config: [
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },
        
        { name: "signalPin", displayName: "Signal R30 pin", default: "10", options: GPIO_SIGNALS },
        { name: "dataRegister", displayName: "Data Register (32-bit)", default: "R5" },
        { name: "tickUs", displayName: "Tick / UT (us)", default: 3 },
        { name: "numDataNibbles", displayName: "Data nibbles", default: 6 },
        { name: "lowTicks", displayName: "Low-pulse ticks", default: 5 },
        { name: "clkHz", displayName: "PRU clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_sent_tx", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },
        
        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.signalPin },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => Math.round((inst.tickUs * inst.clkHz) / 1e6) },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => {
            const tickCyc = Math.round((inst.tickUs * inst.clkHz) / 1e6);
            return (56 * tickCyc) - (inst.lowTicks * tickCyc);
        } },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => {
            const tickCyc = Math.round((inst.tickUs * inst.clkHz) / 1e6);
            return (12 * tickCyc) - (inst.lowTicks * tickCyc);
        } },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => {
            const tickCyc = Math.round((inst.tickUs * inst.clkHz) / 1e6);
            return inst.lowTicks * tickCyc;
        } },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.numDataNibbles + 2 },
        
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
        if (inst.tickUs < 3 || inst.tickUs > 90) validation.logError("tickUs must be 3..90", inst, "tickUs");
        if (inst.numDataNibbles < 1 || inst.numDataNibbles > 6) validation.logError("numDataNibbles must be 1..6", inst, "numDataNibbles");
        if (inst.lowTicks < 4 || inst.lowTicks > 11) validation.logError("lowTicks must be 4..11", inst, "lowTicks");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, PIN, DATA_REG, TICK_CYC, SYNC_HIGH_CYC, NIBBLE_BASE_HIGH_CYC, LOW_CYC, NIBBLE_COUNT`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, LOW_CYC`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `sn_sl?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  sn_sl?, TEMP_REG1, 0`,
            `    set   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, SYNC_HIGH_CYC`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `sn_sh?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  sn_sh?, TEMP_REG1, 0`,
            `    ldi   TEMP_REG2.b1, NIBBLE_COUNT`,
            `sn_n?:`,
            `    and   TEMP_REG2.b0, DATA_REG, 0x0F`,
            `    lsr   DATA_REG, DATA_REG, 4`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, LOW_CYC`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `sn_nl?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  sn_nl?, TEMP_REG1, 0`,
            `    set   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, NIBBLE_BASE_HIGH_CYC`,
            `    ldi TEMP_REG2.w2, TICK_CYC`,
            `sn_m?:`,
            `    qbeq  sn_md?, TEMP_REG2.b0, 0`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG2.w2`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qba   sn_m?`,
            `sn_md?:`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `sn_nh?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  sn_nh?, TEMP_REG1, 0`,
            `    sub   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
            `    qbne  sn_n?, TEMP_REG2.b1, 0`,
            `    clr   R30, R30, PIN`,
            `    ldi32 TEMP_REG1, LOW_CYC`,
            `    lsr   TEMP_REG1, TEMP_REG1, 1`,
            `sn_cl?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  sn_cl?, TEMP_REG1, 0`,
            `    set   R30, R30, PIN`,
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

exports = sentModule;
