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

const i2cModule = {
    displayName: "I2C master (open-drain)",
    defaultInstanceName: `${PRU_USED}_I2C_INSTANCE_`,
    description: "A3 open-drain I2C master.",
    longDescription: "Emits a parameterized START / address-byte / ACK / STOP frame (in read mode, followed by an 8-bit data receive and NACK). ADDRESS NACK: the master samples SDA while SCL is high for the ninth (ACK) clock. SDA high means the target did not acknowledge: the master then skips the data phase, issues STOP with the same tSU;STO / tBUF delays as a normal frame (SDA driven low after the ninth clock falls, SCL released, SDA released), and falls through to the next block without any further SCL clock. In read mode the RX Output Register is not written on that path. The NACK flag register is OPTIONAL and empty by default: the STOP and early exit happen either way, but no flag is written and no register is reserved, so existing designs (a second I2C block, encoder_speed_block on R8) generate unchanged. When you type a register in NACK Flag Register (a result register like the status/fault registers of safety_dual_monitor_block and hall_block) the sampled ACK bit is stored there on every call (0 = target acknowledged, 1 = address NACK) and the register is reserved, so a following block can test it (for example a Flow Control compare against 0). At a 200 MHz PRU clock, the delay loop makes each SCL low/high phase and the START/STOP hold/setup phases at least the UM10204 minima for the selected 100, 400, or 1000 kHz mode (tLOW, tHIGH, tSU;STA, tHD;STA, tSU;STO, and tSU;DAT). HALF_TRIPS is one half-period in cycles divided by two, plus a margin of 4 trips, because each delay-loop trip is two PRU cycles (sub + qbne); the resulting waveform is deliberately no faster than the selected bus rate. Frame duration (noOfCycles) is modeled as ~9 SCL clocks (11 bit times) for write mode and ~18 SCL clocks (20 bit times) for read mode.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        {
            name: "blockMaturity",
            displayName: "Block Maturity",
            default: "dual-oracle-tested",
            options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}],
            hidden: true
        },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "sclBit", displayName: "SCL R30 Bit", default: "0", options: GPIO_SIGNALS },
        { name: "sdaBit", displayName: "SDA R30 Bit", default: "1", options: GPIO_SIGNALS },
        { name: "bitRateKhz", displayName: "Bit Rate (kHz)", default: "400", options: [{name:"100"}, {name:"400"}, {name:"1000"}] },
        { name: "addr7", displayName: "7-bit Target Address", default: "0x50" },
        { name: "rw", displayName: "Direction", default: "write", options: [{name:"write"}, {name:"read"}] },
        { name: "dataRegister", displayName: "RX Output Register (Read Mode)", default: "R7" },
        { name: "nackRegister", displayName: "NACK Flag Register (optional)", default: "" },
        { name: "clkHz", displayName: "PRU Clock (Hz)", default: 200000000 },

        { name: "opCode", default: "m_i2c_run", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.sclBit },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => inst.sdaBit },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => {
            const halfCycles = Math.round(inst.clkHz / (inst.bitRateKhz * 1000 * 2));
            // ldi/sub/qbne realizes 2*HALF_TRIPS+6 cycles in the ELF. The
            // four extra trips keep every 400 kHz low phase at its 1.3 us floor.
            return Math.max(1, Math.ceil(halfCycles / 2) + 4);
        }},
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => {
            let addr = parseInt(inst.addr7, 16);
            if (isNaN(addr)) addr = parseInt(inst.addr7);
            return (addr << 1) | (inst.rw === 'read' ? 1 : 0);
        }},
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.rw === "read" ? 1 : 0 },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => inst.dataRegister },
        { name: "constant7", hidden: true, default: "", getValue: (inst) => inst.nackRegister || "TEMP_REG1" },

        // Nominal frame time: write (~9 clocks + START/STOP, 11 bit times) or
        // read (~18 clocks + START/STOP, 20 bit times). It is speed-dependent
        // because the macro deliberately delays every phase; this is not a raw
        // instruction count. Serves as a lower bound within ~12% of measured frame.
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            description: "Nominal frame time: write (~9 SCL clocks, 11 bit times) or read (~18 SCL clocks, 20 bit times).",
            getValue: (inst) => {
                const bitPeriod = Math.ceil(inst.clkHz / (inst.bitRateKhz * 1000));
                const bitTimes = inst.rw === "read" ? 20 : 11;
                return bitPeriod * bitTimes;
            },
            default: 5500
        }
    ],

    ports: (inst) => {
        if (inst.rw === 'read') {
            return [
                { name: "output1", type: "output32" },
                { name: "prev", type: "IO_PREV" },
                { name: "next", type: "IO_NEXT" }
            ];
        }
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        if (inst.sclBit === inst.sdaBit) validation.logError("sclBit and sdaBit must differ", inst, "sclBit");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, SCL_BIT, SDA_BIT, HALF_TRIPS, ADDR_BYTE, IS_READ, DATA_REG, NACK_REG`,
            `    set   R30, R30, SCL_BIT`,
            `    set   R30, R30, SDA_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_ss?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_ss?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SDA_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_sh?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_sh?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SCL_BIT`,
            `    ldi32 TEMP_REG1, ADDR_BYTE`,
            `    lsl   TEMP_REG1, TEMP_REG1, 24`,
            `    ldi TEMP_REG2.b0, 8`,
            `ic_dl?:`,
            `    lsr   TEMP_REG2.b1, TEMP_REG1, 31`,
            `    and   TEMP_REG2.b1, TEMP_REG2.b1, 1`,
            `    clr   R30, R30, SDA_BIT`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.b1, SDA_BIT`,
            `    or    R30, R30, TEMP_REG2.w2`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_ds?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_ds?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SCL_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_dh?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_dh?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SCL_BIT`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  ic_dl?, TEMP_REG2.b0, 0`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_al?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_al?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SDA_BIT`,
            `    set   R30, R30, SCL_BIT`,
            `    lsr   TEMP_REG1, R31, SDA_BIT`,
            `    and   NACK_REG, TEMP_REG1, 1`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_ah?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_ah?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SCL_BIT`,
            `    qbne  ic_st?, NACK_REG, 0`,
            `    .if IS_READ == 1`,
            `    set   R30, R30, SDA_BIT`,
            `    ldi32 DATA_REG, 0`,
            `    ldi TEMP_REG2.b0, 8`,
            `ic_rl?:`,
            `    lsl   DATA_REG, DATA_REG, 1`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_rs?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_rs?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SCL_BIT`,
            `    lsr   TEMP_REG1, R31, SDA_BIT`,
            `    and   TEMP_REG1, TEMP_REG1, 1`,
            `    or    DATA_REG, DATA_REG, TEMP_REG1`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_rh?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_rh?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SCL_BIT`,
            `    sub   TEMP_REG2.b0, TEMP_REG2.b0, 1`,
            `    qbne  ic_rl?, TEMP_REG2.b0, 0`,
            `    set   R30, R30, SDA_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_nl?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_nl?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SCL_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_nh?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_nh?, TEMP_REG2.w2, 0`,
            `    clr   R30, R30, SCL_BIT`,
            `    .endif`,
            `ic_st?:`,
            `    clr   R30, R30, SDA_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_sl?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_sl?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SCL_BIT`,
            `    ldi TEMP_REG2.w2, HALF_TRIPS`,
            `ic_sp?:`,
            `    sub   TEMP_REG2.w2, TEMP_REG2.w2, 1`,
            `    qbne  ic_sp?, TEMP_REG2.w2, 0`,
            `    set   R30, R30, SDA_BIT`,
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
            if (inst.sclBit !== undefined) {
                pins.push({ pin: parseInt(inst.sclBit), dir: "GPO" });
            }
            if (inst.sdaBit !== undefined) {
                pins.push({ pin: parseInt(inst.sdaBit), dir: "GPO", bidi: true });
                pins.push({ pin: parseInt(inst.sdaBit), dir: "GPI", bidi: true });
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

exports = i2cModule;
