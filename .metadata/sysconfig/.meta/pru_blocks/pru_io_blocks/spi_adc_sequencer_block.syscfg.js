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

function validate(inst, validation) {
    const sequence = inst.channel_sequence.split(",").map(x => x.trim()).filter(Boolean);
    if (sequence.length < 1 || sequence.length > 25 ||
        sequence.some(word => !Number.isInteger(Number(word)) || Number(word) < 0 || Number(word) > 0xffffffff)) {
        validation.logError("channel_sequence must contain 1..25 integer MOSI words", inst, "channel_sequence");
    }
    if (inst.spi_mode !== "MODE0") {
        validation.logError("Only MODE0 is supported by this block", inst, "spi_mode");
    }

    const pins = [inst.cs_pin, inst.sclk_pin, inst.mosi_pin, inst.miso_pin];
    const uniquePins = new Set(pins);
    if (uniquePins.size !== pins.length) {
        validation.logError("CS, SCLK, MOSI, and MISO pins must be distinct", inst);
    }

    const noOfCycles = inst.noOfCycles;
    if (inst.sample_period < noOfCycles) {
        validation.logError(`Sequence takes ${noOfCycles} cycles, but sample_period is ${inst.sample_period}. Cannot fit sequence in period.`, inst, "sample_period");
    }
}

const spiAdcSequencerModule = {
    displayName: "SPI ADC Sequencer",
    defaultInstanceName: `${PRU_USED}_SPI_ADC_SEQ_`,
    description: "Sequenced SPI ADC sampling front-end.",
    longDescription: "Executes a sequence of SPI conversions with fixed deadlines and t_conv waits.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "bits_per_frame", displayName: "Bits per frame", default: 16 },
        { name: "spi_mode", displayName: "SPI Mode", default: "MODE0", options: [{name: "MODE0"}] },
        { name: "t_conv", displayName: "Conversion Time (cycles)", default: 200 },
        { name: "sample_period", displayName: "Sample Period / Grid (cycles)", default: 5000 },
        { name: "channel_sequence", displayName: "Channel Sequence (CSV of MOSI words)", default: "0xA500" },

        { name: "cs_pin", displayName: "CS Signal (R30)", default: "3", options: GPIO_SIGNALS },
        { name: "sclk_pin", displayName: "SCLK Signal (R30)", default: "0", options: GPIO_SIGNALS },
        { name: "mosi_pin", displayName: "MOSI Signal (R30)", default: "2", options: GPIO_SIGNALS },
        { name: "miso_pin", displayName: "MISO Signal (R31)", default: "1", options: GPIO_SIGNALS },

        { name: "base_data_reg", displayName: "Base Data Register", default: "R4" },

        { name: "bug_inject", hidden: true, default: "none", options: [{name: "none"}, {name: "clocks_while_cs_deasserted"}, {name: "wrong_clock_count"}] },

        {
            name: "opCode",
            default: "m_spi_adc_seq",
            hidden: true,
            getValue: (inst) => {
                let seq = inst.channel_sequence.split(",").map(x => x.trim()).filter(x => x !== "");
                let bug = inst.bug_inject || "none";
                return `m_spi_adc_seq_${seq.length}_${bug}`;
            }
        },
        { name: "numOfInputPorts", default: 0, hidden: true },
        {
            // One 4-byte result port per channel (RES0..RESn-1) so channels never overwrite each other
            // and a 16-bit frame is not truncated; the allocator emits them via multiOutputMacroArgs.
            name: "numOfOutputPorts", hidden: true, default: 1,
            getValue: inst => Math.max(1, inst.channel_sequence.split(",").map(x => x.trim()).filter(Boolean).length)
        },
        { name: "multiOutputMacroArgs", hidden: true, default: true },
        ...Array.from({length: 25}, (_, n) => ({ name: `output${n + 1}Size`, hidden: true, default: 4 })),
        {
            name: "numOfConstants",
            getValue: (inst) => {
                let seq = inst.channel_sequence.split(",").map(x => x.trim()).filter(x => x !== "");
                return 7 + seq.length; // six fixed values, one command per channel, then PAD_CYCLES
            },
            default: 8
        },
        ...Array.from({length: 32}, (_, n) => ({
            name: `constant${n + 1}`, hidden: true, default: 0,
            getValue: inst => {
                const seq = inst.channel_sequence.split(",").map(x => x.trim()).filter(Boolean);
                const fixed = [inst.cs_pin, inst.sclk_pin, inst.mosi_pin, inst.miso_pin, inst.t_conv, inst.bits_per_frame];
                if (n < fixed.length) return Number(fixed[n]);
                if (n < 6 + seq.length) return Number(seq[n - 6]);
                return Math.max(0, inst.sample_period - inst.noOfCycles);
            }
        })),

        {
            name: "noOfCycles",
            displayName: "Worst-case Cycles (calculated)",
            getValue: (inst) => {
                const seq = inst.channel_sequence.split(",").map(x => x.trim()).filter(x => x !== "");
                const bits = inst.bits_per_frame;
                let actual = 0;
                for (let i = 0; i < seq.length; i++) {
                    actual += 13 + inst.t_conv + (17 * bits);
                }
                return actual;
            },
            default: 1
        }
    ],

    ports: (inst) => {
        const n = Math.max(1, inst.channel_sequence.split(",").map(x => x.trim()).filter(Boolean).length);
        return [
            ...Array.from({length: Math.min(n, 25)}, (_, i) => ({ name: `output${i + 1}`, type: "output32" })),
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate: validate,

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];

        // opCode format: m_spi_adc_seq_2_none
        let parts = opCode.split("_");
        let numChannels = 1;
        let bugInject = "none";

        if (parts.length >= 6) {
            numChannels = parseInt(parts[4]);
            bugInject = parts.slice(5).join("_");
        } else {
            // fallback
            let match = opCode.match(/m_spi_adc_seq_(\d+)/);
            if (match) numChannels = parseInt(match[1]);
        }

        let resParams = [];
        let cmdParams = [];
        for (let i = 0; i < numChannels; i++) {
            resParams.push(`RES${i}`);
            cmdParams.push(`CMD${i}`);
        }
        let args = resParams.concat(["CS_PIN", "SCLK_PIN", "MOSI_PIN", "MISO_PIN", "T_CONV", "BITS"]).concat(cmdParams).concat(["PAD_CYCLES"]);

        let lines = [`${opCode} .macro ${args.join(", ")}`];

        for (let i = 0; i < numChannels; i++) {
            let cmd = `CMD${i}`;
            let destReg = `RES${i}`;

            lines.push(`    clr R30, R30, CS_PIN`);
            lines.push(`    .loop T_CONV`);
            lines.push(`    nop`);
            lines.push(`    .endloop`);

            lines.push(`    ldi TEMP_REG2.b0, BITS`);
            lines.push(`    sub TEMP_REG2.b0, TEMP_REG2.b0, 1`);
            lines.push(`    ldi32 TEMP_REG1, ${cmd}`);
            lines.push(`    ldi32 TEMP_REG3, 0`);

            let lbl = `ch${i}`;

            lines.push(`${lbl}_bit_loop?:`);
            lines.push(`    qbbc ${lbl}_mosi_zero?, TEMP_REG1, TEMP_REG2.b0`);
            lines.push(`    set R30, R30, MOSI_PIN`);
            lines.push(`    qba ${lbl}_mosi_done?`);
            lines.push(`${lbl}_mosi_zero?:`);
            lines.push(`    clr R30, R30, MOSI_PIN`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`${lbl}_mosi_done?:`);
            lines.push(`    lsl TEMP_REG3, TEMP_REG3, 1`);
            lines.push(`    qbbc ${lbl}_miso_zero?, R31, MISO_PIN`);
            lines.push(`    add TEMP_REG3, TEMP_REG3, 1`);
            lines.push(`    qba ${lbl}_miso_done?`);
            lines.push(`${lbl}_miso_zero?:`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`${lbl}_miso_done?:`);
            lines.push(`    set R30, R30, SCLK_PIN`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`    clr R30, R30, SCLK_PIN`);
            lines.push(`    sub TEMP_REG2.b0, TEMP_REG2.b0, 1`);
            lines.push(`    qbne ${lbl}_bit_loop?, TEMP_REG2.b0, 0xFF`);

            lines.push(`    mov ${destReg}, TEMP_REG3`);

            if (bugInject === "wrong_clock_count") {
                lines.push(`    set R30, R30, SCLK_PIN`);
                lines.push(`    nop`);
                lines.push(`    clr R30, R30, SCLK_PIN`);
            }

            lines.push(`    set R30, R30, CS_PIN`);

            if (bugInject === "clocks_while_cs_deasserted") {
                lines.push(`    set R30, R30, SCLK_PIN`);
                lines.push(`    nop`);
                lines.push(`    clr R30, R30, SCLK_PIN`);
            }

            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`    nop`);
            lines.push(`    nop`);
        }

        // Delay logic using PAD_CYCLES
        lines.push(`    ldi32 TEMP_REG1, PAD_CYCLES`);
        lines.push(`pad_loop?:`);
        lines.push(`    sub TEMP_REG1, TEMP_REG1, 1`);
        lines.push(`    qbne pad_loop?, TEMP_REG1, 0`);

        lines.push(`    .endm`);
        return lines.join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.cs_pin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.sclk_pin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.mosi_pin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.miso_pin), dir: "GPI" });
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

exports = spiAdcSequencerModule;
