/**
 * UART RX Op block.
 * Assumes peripheral is already configured by uart_config block.
 * Only does: assert rx_en → bit polling loop → data extraction → de-assert rx_en.
 */

/**
 * Get the uart_config instance bound to this op block via sharedModuleInstances.
 * inst.uartConfig is auto-populated by SysConfig when the shared instance is created.
 */
function getConfigInst(inst) {
    return (inst && inst.uartConfig) ? inst.uartConfig : null;
}

function validate(inst, report) {
    const cfg = inst.uartConfig;
    if (!cfg) {
        report.logError(
            "A UART Config block is required before using UART RX Op. " +
            "Add a UART Config block with RX Config enabled and connect it earlier in the control flow.",
            inst
        );
        return;
    }
    if (!cfg.enableRX) {
        report.logError(
            "The UART Config block does not have RX Config enabled. " +
            "Enable RX Config in the UART Config block.",
            inst
        );
    }

    // Enforce all uart_rx_op instances use the same rxFrameSize value
    const rxOpModule = system.modules["/pru_blocks/pru_io_blocks/uart_rx_op"];
    if (rxOpModule && rxOpModule.$instances && rxOpModule.$instances.length > 1) {
        const firstFrameSize = rxOpModule.$instances[0].rxFrameSize;
        const mismatch = rxOpModule.$instances.some(i => i.rxFrameSize !== firstFrameSize);
        if (mismatch) {
            report.logError(
                `All UART RX Op blocks must have the same RX Frame Size value. ` +
                `uart_config uses the first instance's value (${firstFrameSize} bits) for RX configuration — ` +
                `mismatched instances will generate incorrect assembly.`,
                inst, "rxFrameSize"
            );
        }
    }
}

/**
 * Returns the macro body for the UART RX Op block.
 * Mirrors the original uart_rx.syscfg.js bit loop and extraction exactly.
 * Only difference: no peripheral config writes — those are in uart_config block.
 *
 * Sequence:
 *   1. Assert rx_en (resolved at code-gen time from channel)
 *   2. Loop frameSize times: qbbc poll, read middle sample, set to clear, accumulate
 *   3. Extract data (identical to original uart_rx — remove start/stop bits)
 *   4. Disable rx_en
 */
function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;

    const isExtended = macroName.includes("_ext");
    const isLSB      = macroName.includes("_lsb_");

    // Oversample middle bit — resolved at code-gen time from macro name
    let middleBit;
    if      (macroName.includes("_1x")) middleBit = 0;
    else if (macroName.includes("_2x")) middleBit = 0;
    else if (macroName.includes("_4x")) middleBit = 2;
    else                                middleBit = 4; // 8x default

    // Parameter positions — same as original uart_rx
    let dataByteRegLo, dataByteRegHi, channel, clockDiv, rxClkSel, oversample, startBitPol, frameSize, bitSwap;

    if (isExtended) {
        dataByteRegLo = parts[1] || "dataByteRegLo";
        dataByteRegHi = parts[2] || "dataByteRegHi";
        channel       = parts[3] || "channel";
        clockDiv      = parts[4] || "clockDiv";
        rxClkSel      = parts[5] || "rxClkSel";
        oversample    = parts[6] || "oversample";
        startBitPol   = parts[7] || "startBitPol";
        frameSize     = parts[8] || "frameSize";
        bitSwap       = parts[9] || "bitSwap";
    } else {
        dataByteRegLo = parts[1] || "dataByteRegLo";
        dataByteRegHi = "0";
        channel       = parts[2] || "channel";
        clockDiv      = parts[3] || "clockDiv";
        rxClkSel      = parts[4] || "rxClkSel";
        oversample    = parts[5] || "oversample";
        startBitPol   = parts[6] || "startBitPol";
        frameSize     = parts[7] || "frameSize";
        bitSwap       = parts[8] || "bitSwap";
    }

    // Channel-dependent values are emitted as assembler .if conditionals
    // so they resolve correctly at assemble time from the macro parameter,
    // not at JS code-gen time when channel is still the placeholder string.

    const bitAccumReg   = "TEMP_REG1";
    const bitCounterReg = isExtended ? "TEMP_REG1.b0" : "TEMP_REG2.b0";
    const tempSampleReg = isExtended ? "TEMP_REG1.b1" : "TEMP_REG2.b1";

    if (pruInstructionMacro === "") {
        if (isExtended) {
            macroBody = macroName + "\t.macro  " + dataByteRegLo + ", " + dataByteRegHi + ", "
                + channel + ", " + clockDiv + ", " + rxClkSel + ", " + oversample + ", "
                + startBitPol + ", " + frameSize + ", " + bitSwap + "\n";
        } else {
            macroBody = macroName + "\t.macro  " + dataByteRegLo + ", "
                + channel + ", " + clockDiv + ", " + rxClkSel + ", " + oversample + ", "
                + startBitPol + ", " + frameSize + ", " + bitSwap + "\n";
        }
        macroBody += `\t; UART RX Op — no peripheral config writes
\t; uart_config block must be called before this block
`;
    }

    // Assert rx_en — use assembler .if so it resolves from the macro parameter
    macroBody += `
\t; ========== Enable RX for selected channel ==========
\t.if ${channel} == 0
\tldi     r30.b3, 0x01                       ; rx_en0 (bit24)
\t.elseif ${channel} == 1
\tldi     r30.b3, 0x02                       ; rx_en1 (bit25)
\t.else
\tldi     r30.b3, 0x04                       ; rx_en2 (bit26)
\t.endif

`;

    // Bit accumulation loop — channel bits resolved via assembler .if
    if (isExtended) {
        macroBody += `\tldi     ${dataByteRegLo}, 0
\tldi     ${dataByteRegHi}, 0
\tldi     ${bitCounterReg}, 0

rx_bit_loop?:
\t; Poll valid flag for selected channel
\t.if ${channel} == 0
\tqbbc    rx_bit_loop?, r31, 24              ; val0 — CH0
\tmov     ${tempSampleReg}, r31.b0           ; rx_data_out0
\tset     r31, r31, 24                       ; clear val0
\t.elseif ${channel} == 1
\tqbbc    rx_bit_loop?, r31, 25              ; val1 — CH1
\tmov     ${tempSampleReg}, r31.b1           ; rx_data_out1
\tset     r31, r31, 25                       ; clear val1
\t.else
\tqbbc    rx_bit_loop?, r31, 26              ; val2 — CH2
\tmov     ${tempSampleReg}, r31.b2           ; rx_data_out2
\tset     r31, r31, 26                       ; clear val2
\t.endif

\tqbbs    set_bit?, ${tempSampleReg}, ${middleBit}
`;
        if (isLSB) {
            macroBody += `\tlsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqbbc    no_carry?, ${dataByteRegHi}, 0
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_carry?:
\tlsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
\tqba     next_bit?
set_bit?:
\tlsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqbbc    no_carry_set?, ${dataByteRegHi}, 0
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_carry_set?:
\tlsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
\tset     ${dataByteRegHi}, ${dataByteRegHi}, 31
`;
        } else {
            macroBody += `\tlsl     ${dataByteRegHi}, ${dataByteRegHi}, 1
\tqbbc    no_carry?, ${dataByteRegLo}, 31
\tset     ${dataByteRegHi}, ${dataByteRegHi}, 0
no_carry?:
\tlsl     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqba     next_bit?
set_bit?:
\tlsl     ${dataByteRegHi}, ${dataByteRegHi}, 1
\tqbbc    no_carry_set?, ${dataByteRegLo}, 31
\tset     ${dataByteRegHi}, ${dataByteRegHi}, 0
no_carry_set?:
\tlsl     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 0
`;
        }
        macroBody += `next_bit?:
\tadd     ${bitCounterReg}, ${bitCounterReg}, 1
\tqbgt    rx_bit_loop?, ${bitCounterReg}, ${frameSize}

`;
    } else {
        macroBody += `\tldi     ${bitAccumReg}, 0
\tldi     ${bitCounterReg}, 0

rx_bit_loop?:
\t; Poll valid flag for selected channel
\t.if ${channel} == 0
\tqbbc    rx_bit_loop?, r31, 24              ; val0 — CH0
\tmov     ${tempSampleReg}, r31.b0           ; rx_data_out0
\tset     r31, r31, 24                       ; clear val0
\t.elseif ${channel} == 1
\tqbbc    rx_bit_loop?, r31, 25              ; val1 — CH1
\tmov     ${tempSampleReg}, r31.b1           ; rx_data_out1
\tset     r31, r31, 25                       ; clear val1
\t.else
\tqbbc    rx_bit_loop?, r31, 26              ; val2 — CH2
\tmov     ${tempSampleReg}, r31.b2           ; rx_data_out2
\tset     r31, r31, 26                       ; clear val2
\t.endif

\tqbbs    set_bit?, ${tempSampleReg}, ${middleBit}
`;
        if (isLSB) {
            macroBody += `\tlsr     ${bitAccumReg}, ${bitAccumReg}, 1
\tqba     next_bit?
set_bit?:
\tlsr     ${bitAccumReg}, ${bitAccumReg}, 1
\tset     ${bitAccumReg}, ${bitAccumReg}, 31
`;
        } else {
            macroBody += `\tlsl     ${bitAccumReg}, ${bitAccumReg}, 1
\tqba     next_bit?
set_bit?:
\tlsl     ${bitAccumReg}, ${bitAccumReg}, 1
\tset     ${bitAccumReg}, ${bitAccumReg}, 0
`;
        }
        macroBody += `next_bit?:
\tadd     ${bitCounterReg}, ${bitCounterReg}, 1
\tqbgt    rx_bit_loop?, ${bitCounterReg}, ${frameSize}

`;
    }

    // Extraction — identical to original uart_rx
    if (isExtended) {
        if (isLSB) {
            macroBody += `\t; Extract data (extended LSB): shift to align, remove start bit
\tldi     TEMP_REG2.w0, 64
\tsub     TEMP_REG2.w0, TEMP_REG2.w0, ${frameSize}
shift_loop?:
\tqbeq    shift_done?, TEMP_REG2.w0, 0
\tlsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqbbc    no_shift_carry?, ${dataByteRegHi}, 0
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_shift_carry?:
\tlsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
\tsub     TEMP_REG2.w0, TEMP_REG2.w0, 1
\tqba     shift_loop?
shift_done?:
\tlsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqbbc    no_start_carry?, ${dataByteRegHi}, 0
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_start_carry?:
\tlsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
\t.if ${frameSize} == 33
\tclr     ${dataByteRegLo}, ${dataByteRegLo}, 31
\tldi     ${dataByteRegHi}, 0
\t.elseif ${frameSize} == 34
\tldi     ${dataByteRegHi}, 0
\t.else
\tldi     TEMP_REG2, 1
\tlsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 34)
\tsub     TEMP_REG2, TEMP_REG2, 1
\tand     ${dataByteRegHi}, ${dataByteRegHi}, TEMP_REG2
\t.endif
`;
        } else {
            macroBody += `\t; Extract data (extended MSB): remove stop bit, mask data bits
\tlsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
\tqbbc    no_stop_carry?, ${dataByteRegHi}, 0
\tset     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_stop_carry?:
\tlsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
\t.if ${frameSize} == 33
\tclr     ${dataByteRegLo}, ${dataByteRegLo}, 31
\tldi     ${dataByteRegHi}, 0
\t.elseif ${frameSize} == 34
\tldi     ${dataByteRegHi}, 0
\t.else
\tldi     TEMP_REG2, 1
\tlsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 34)
\tsub     TEMP_REG2, TEMP_REG2, 1
\tand     ${dataByteRegHi}, ${dataByteRegHi}, TEMP_REG2
\t.endif
`;
        }
    } else {
        if (isLSB) {
            macroBody += `\t; Extract data (standard LSB): shift to align, remove start bit, mask
\tldi     TEMP_REG2.w0, 32
\tsub     TEMP_REG2.w0, TEMP_REG2.w0, ${frameSize}
\tlsr     ${bitAccumReg}, ${bitAccumReg}, TEMP_REG2.w0
\tlsr     ${dataByteRegLo}, ${bitAccumReg}, 1
\tldi     TEMP_REG2, 1
\tlsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 2)
\tsub     TEMP_REG2, TEMP_REG2, 1
\tand     ${dataByteRegLo}, ${dataByteRegLo}, TEMP_REG2
`;
        } else {
            macroBody += `\t; Extract data (standard MSB): remove stop bit, mask data bits
\tlsr     ${dataByteRegLo}, ${bitAccumReg}, 1
\tldi     TEMP_REG2, 1
\tlsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 2)
\tsub     TEMP_REG2, TEMP_REG2, 1
\tand     ${dataByteRegLo}, ${dataByteRegLo}, TEMP_REG2
`;
        }
    }

    macroBody += `
\t; ========== Disable rx_en ==========
\tldi     r30.b3, 0x00
`;

    if (pruInstructionMacro === "") {
        macroBody += "\n .endm";
    }

    return macroBody;
}

function getLongDescription() {
    return `
## UART RX Op (Per-Reception Operation)

### Purpose
Receives one UART frame using the ENDAT peripheral. This block handles only the
per-reception work: assert rx_en, poll and accumulate all frameSize bits,
extract data, de-assert rx_en. **The \`UART Config\` block (with RX Config enabled)
must appear earlier in the control flow** to set up the peripheral registers before
this block is called.

### Generated Sequence
1. Assert rx_en for the configured channel (R30[26/25/24] for CH2/CH1/CH0)
2. Loop frameSize times: poll valid flag (R31[26/25/24]), read middle oversample bit from R31 byte, clear flag, accumulate into output register
3. Extract data — shift to align, remove start and stop bits, mask to data width
4. De-assert rx_en (R30.b3 = 0x00)

### No Peripheral Register Writes
No GPCFG, RXCFG, or CH_CFG0 writes — those are handled once by \`UART Config\`.
This means the op block is fast and suitable for repeated calls in a loop.

### Output Port
The output register size depends on the configured RX Frame Size:

| Frame Size | Data Bits | Output Port Type | Register(s) |
|------------|-----------|------------------|-------------|
| 3–32 bits  | 1–30 bits | **32-bit** (output32) | 1 register (Rx) |
| 33–64 bits | 31–62 bits | **64-bit** (output64) | 2 registers (Rx:Rx+1) |

- **output1** (32-bit mode): received data word in a single dynamically allocated register
- **output1** (64-bit mode): received data in two consecutive registers — lower 32 bits in the allocated register, upper bits in the next register

### Configuration
All parameters are automatically read from the paired \`UART Config\` block — no
duplicate settings needed here. Only \`RX Frame Size\` is set on this block directly,
since it determines the output port type (32-bit vs 64-bit) which the register
allocator needs to know at design time.

### RX Frame Size
- Total bits per frame = data bits + 2 (start bit + stop bit)
- Standard UART 8-bit: frameSize = 10
- 16-bit payload: frameSize = 18
- frameSize > 32 activates extended mode (two output registers, 64-bit output port)

### Calculation Example
- UART Config: 192 MHz clock, 12 MHz baud, 8x oversample
- RX Clock = 192 / (clockDiv+1) = 192 / 2 = 96 MHz
- Baud Rate = 96 MHz / 8 = 12 MHz ✓
- frameSize = 18 → 16 data bits → 32-bit output port (fits in one register)

### Terminology
- **Valid Flag**: R31 status bit set by hardware when an oversampled bit is ready to read
- **Middle Sample**: For 8x oversample the middle sample is bit 4 of the 8-sample window — most noise-immune point
- **Extended Mode**: frameSize ≥ 33 → data bits ≥ 31 → requires two consecutive output registers
- **rx_en**: R30[26:24] — enables reception on the selected channel; asserting it starts the hardware

---
`;
}

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the UART RX Op block in a .syscfg file.

**CRITICAL**: The UART RX Op block requires a paired \`UART Config\` block with RX enabled.
The op block reads all RX parameters (channel, baud rate, oversample, bit order, start bit polarity)
from the config block automatically. Only \`rxFrameSize\` is set on the op block itself.

### Step 1 — Add and configure a UART Config block (RX enabled)

\`\`\`javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();
uart_config1.$name    = "PRU_UART_CONFIG_0";
uart_config1.enableTX = false;         // TX-only or TX+RX — set as needed
uart_config1.enableRX = true;
uart_config1.rxChannel         = 2;    // Channel 2 (GPI11 = PERIF2_IN)
uart_config1.rxClockSource     = 0;    // 192 MHz (UART_CLK)
uart_config1.rxBaudRate        = 12;   // 12 MHz
uart_config1.rxOversampleSize  = 7;    // 8x oversample
uart_config1.rxStartBitPolarity = 1;   // Rising edge
uart_config1.rxBitSwap         = true; // LSB first (standard UART)
\`\`\`

### Step 2 — Add and configure the UART RX Op block

\`\`\`javascript
const uart_rx_op = scripting.addModule("/pru_blocks/pru_io_blocks/uart_rx_op", {}, false);
const uart_rx_op1 = uart_rx_op.addInstance();
uart_rx_op1.$name       = "PRU_UART_RX_OP_0";
uart_rx_op1.rxFrameSize = 18;          // 16 data bits + start + stop = 18
uart_rx_op1.uartConfig  = uart_config1; // Link to config block
\`\`\`

### Step 3 — Connect control flow and data

\`\`\`javascript
// Control flow: config must run before op
scripting.connect(uart_config1, "next", uart_rx_op1, "prev");

// Data: connect op output to downstream block
scripting.connect(uart_rx_op1, "output1", next_block, "input1");

// Control flow out of op
scripting.connect(uart_rx_op1, "next", next_block, "prev");
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| rxFrameSize | Integer | 3–64 | 10 | Total frame bits (dataBits + 2). Values > 32 use 64-bit output port |

All other RX parameters (channel, baud rate, oversample, bit order, start bit polarity) are
read from the paired \`UART Config\` block — do not duplicate them here.

### Output Port Type by Frame Size

| rxFrameSize | Data Bits | Output Port | Notes |
|-------------|-----------|-------------|-------|
| 3–32 | 1–30 | 32-bit (output32) | Single register output |
| 33–64 | 31–62 | 64-bit (output64) | Two consecutive registers; downstream block must accept 64-bit input |

### Common Frame Sizes

| Protocol | Data Bits | rxFrameSize |
|----------|-----------|-------------|
| Standard UART 8-bit | 8 | 10 |
| UART 16-bit payload | 16 | 18 |
| UART 24-bit payload | 24 | 26 |
| UART 30-bit payload | 30 | 32 |
| UART 31-bit payload (extended) | 31 | 33 |

### Important Notes

1. **UART Config must appear before UART RX Op** in the control flow (connect config "next" to op "prev").

2. **rxFrameSize > 32 activates extended mode** — output port becomes 64-bit. Downstream blocks must be wired to accept a 64-bit input.

3. **No peripheral register writes in this block** — only rx_en assert/de-assert and the bit polling loop. All register setup is in \`UART Config\`.

4. **uartConfig linkage is mandatory** — always set \`uart_rx_op1.uartConfig = uart_config1\` or the block will error during validation.
`;
}

exports = {
    displayName: "PRU UART RX Op",
    defaultInstanceName: "PRU_UART_RX_OP_",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
    uiView: "graph",
    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null
    },
    config: [
        {
            name: "$shape",
            hidden: true,
            default: "square",
        },
        {
            name: "$topLabel",
            hidden: true,
            default: "",
        },
        // Local rxFrameSize — source of truth for ports() and output1Size
        // uart_config reads this via getRxFrameSize() instead of having its own field
        {
            name: "rxFrameSize",
            displayName: "RX Frame Size (bits)",
            description: "Total bits per RX frame = dataBits + 2 (start + stop). Range: 3-64. Values > 32 use extended mode (two output registers).",
            default: 10,
            range: [3, 64],
            displayFormat: "dec"
        },
        // Read-only display of config block settings
        {
            name: "configInfo",
            displayName: "Config Block RX Settings",
            description: "Parameters read from the UART Config block (RX section)",
            default: "No config block found",
            readOnly: true,
            getValue: (inst) => {
                const cfg = getConfigInst(inst);
                if (!cfg) return "No UART Config block found";
                if (!cfg.enableRX) return "UART Config block has RX disabled";
                return `Ch${cfg.rxChannel}, ${inst.rxFrameSize}b frame, ` +
                       `${cfg.rxBitSwap ? "LSB" : "MSB"}, start=${cfg.rxStartBitPolarity}, ` +
                       `${cfg.rxBaudRate}MHz, ` +
                       `${["1x","2x","","4x","","","","8x"][cfg.rxOversampleSize]}OS`;
            }
        },
        // ===== HIDDEN CODE GEN FIELDS =====
        {
            name: "constant1",
            hidden: true,
            default: "2, 1, 0, 7, 1, 10, 1",
            getValue: (inst) => {
                const cfg = getConfigInst(inst);
                if (!cfg) return "2, 1, 0, 7, 1, 10, 1";
                let osMul;
                if (cfg.rxOversampleSize === 0)      osMul = 1;
                else if (cfg.rxOversampleSize === 1) osMul = 2;
                else if (cfg.rxOversampleSize === 3) osMul = 4;
                else                                 osMul = 8;
                const clkMHz = cfg.rxClockSource === 0 ? 192 : 200;
                const bxo = cfg.rxBaudRate * osMul;
                const rxDiv = (bxo === 0 || clkMHz % bxo !== 0) ? 0 : (clkMHz / bxo) - 1;
                return `${cfg.rxChannel}, ${rxDiv}, ${cfg.rxClockSource}, ` +
                       `${cfg.rxOversampleSize}, ${cfg.rxStartBitPolarity}, ${inst.rxFrameSize}, ` +
                       `${cfg.rxBitSwap ? 1 : 0}`;
            }
        },
        {
            name: "opCode",
            displayName: "m_uart_rx_op",
            default: "m_uart_rx_op",
            hidden: true,
            getValue: (inst) => {
                const cfg = getConfigInst(inst);
                const pruNum   = cfg ? cfg.pruSelect : 0;
                const bitOrder = cfg ? (cfg.rxBitSwap ? "lsb" : "msb") : "lsb";
                const dataBits = inst.rxFrameSize - 2;
                const isExt    = dataBits >= 31;
                let osName;
                const osEnc = cfg ? cfg.rxOversampleSize : 7;
                if (osEnc === 0)      osName = "1x";
                else if (osEnc === 1) osName = "2x";
                else if (osEnc === 3) osName = "4x";
                else                  osName = "8x";
                const extSuffix = isExt ? "_ext" : "";
                return `m_uart_rx_op_pru${pruNum}_${bitOrder}_${osName}${extSuffix}`;
            }
        },
        {
            name: "numOfInputPorts",
            default: 0,
            hidden: true
        },
        {
            name: "numOfOutputPorts",
            default: 1,
            hidden: true
        },
        {
            name: "output1Size",
            hidden: true,
            default: 4,
            getValue: (inst) => {
                const dataBits = inst.rxFrameSize - 2;
                return dataBits >= 31 ? 8 : 4;
            }
        },
        {
            name: "numOfConstants",
            default: 1,
            hidden: true
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (inst) => {
                const frameSize = inst.rxFrameSize;
                // rx_en assert(1) + loop(frameSize * ~5) + extract(~8) + disable(1)
                return 10 + (frameSize * 5);
            },
            default: 60
        },
    ],
    ports: (inst) => {
        const dataBits = inst.rxFrameSize - 2;
        const outputType = dataBits >= 31 ? "output64" : "output32";
        const portName = outputType === "output64" ? "out64" : "output1" 
        return [
            { name: "output1", type: outputType, displayName: portName },
            { name: "prev",    type: "PREV"     },
            { name: "next",    type: "NEXT"     },
        ];
    },
    validate,
    sharedModuleInstances: (_inst) => {
        return [
            {
                name: "uartConfig",
                displayName: "UART Config",
                moduleName: "/pru_blocks/pru_io_blocks/uart_config",
                collapsed: false,
            }
        ];
    },
    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    },
    getMacro
}
