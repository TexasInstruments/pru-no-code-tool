/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
/**
 * Read txDataBits from the uart_tx_op instance if one exists.
 * Falls back to 8 if no uart_tx_op is present.
 */
function getTxDataBits() {
    const txOpModule = system.modules["/pru_blocks/pru_io_blocks/uart_tx_op"];
    if (txOpModule && txOpModule.$instances && txOpModule.$instances.length > 0) {
        return txOpModule.$instances[0].dataBits;
    }
    return 8;
}

/**
 * Read rxFrameSize from the uart_rx_op instance if one exists.
 * Falls back to 10 if no uart_rx_op is present.
 */
function getRxFrameSize() {
    const rxOpModule = system.modules["/pru_blocks/pru_io_blocks/uart_rx_op"];
    if (rxOpModule && rxOpModule.$instances && rxOpModule.$instances.length > 0) {
        return rxOpModule.$instances[0].rxFrameSize;
    }
    return 10;
}

function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            return parseInt(match[1]);
        }
    }
    return 0;
}

function validate(inst, report) {
    // At least one of TX or RX must be enabled
    if (!inst.enableTX && !inst.enableRX) {
        report.logError("At least one of TX Config or RX Config must be enabled.", inst, "enableTX");
        report.logError("At least one of TX Config or RX Config must be enabled.", inst, "enableRX");
    }

    if (inst.enableTX) {
        const uartClkMHz = inst.txClockSource === 0 ? 192 : 200;
        if (uartClkMHz % inst.txBaudRate !== 0) {
            report.logError(
                `TX: Clock (${uartClkMHz} MHz) is not divisible by baudRate = ${inst.txBaudRate} MHz.`,
                inst, "txBaudRate");
        } else {
            const div = (uartClkMHz / inst.txBaudRate) - 1;
            if (div < 0 || div > 65535) {
                report.logError(
                    `TX: Calculated clock divider (${div}) is out of range (0-65535).`,
                    inst, "txBaudRate");
            }
        }
    }

    if (inst.enableRX) {
        let oversampleMul;
        if (inst.rxOversampleSize === 0)      oversampleMul = 1;
        else if (inst.rxOversampleSize === 1) oversampleMul = 2;
        else if (inst.rxOversampleSize === 3) oversampleMul = 4;
        else                                  oversampleMul = 8;

        const uartClkMHz = inst.rxClockSource === 0 ? 192 : 200;
        const baudXOs = inst.rxBaudRate * oversampleMul;
        if (uartClkMHz % baudXOs !== 0) {
            report.logError(
                `RX: Clock (${uartClkMHz} MHz) is not divisible by (baudRate * oversample) = ${baudXOs}.`,
                inst, "rxBaudRate");
        } else {
            const div = (uartClkMHz / baudXOs) - 1;
            if (div < 0 || div > 65535) {
                report.logError(
                    `RX: Calculated clock divider (${div}) is out of range (0-65535).`,
                    inst, "rxBaudRate");
            }
        }
    }
}

/**
 * Returns guarded ICSS_CFG register symbol definitions (TX + RX registers).
 */
function getIcssCfgDefinitions() {
    return `\
; ========== ICSS CFG register definitions (auto-generated, guarded) ==========
    .if !$isdefed("ICSS_CFG")
    .asg    c4,     ICSS_CFG
    .endif
    .if !$isdefed("ICSS_CFG_GPCFG0")
ICSS_CFG_GPCFG0                 .set    0x0008
    .endif
    .if !$isdefed("ICSS_CFG_GPCFG1")
ICSS_CFG_GPCFG1                 .set    0x000C
    .endif
    .if !$isdefed("ICSS_CFG_PRU0_ENDAT_TXCFG")
ICSS_CFG_PRU0_ENDAT_TXCFG       .set    0x00E4
    .endif
    .if !$isdefed("ICSS_CFG_PRU1_ENDAT_TXCFG")
ICSS_CFG_PRU1_ENDAT_TXCFG       .set    0x0104
    .endif
    .if !$isdefed("ICSS_CFG_PRU0_ENDAT_RXCFG")
ICSS_CFG_PRU0_ENDAT_RXCFG       .set    0x00E0
    .endif
    .if !$isdefed("ICSS_CFG_PRU1_ENDAT_RXCFG")
ICSS_CFG_PRU1_ENDAT_RXCFG       .set    0x0100
    .endif
    .if !$isdefed("ICSS_CFG_PRU0_ENDAT_CH0_CFG0")
ICSS_CFG_PRU0_ENDAT_CH0_CFG0    .set    0x00E8
    .endif
    .if !$isdefed("ICSS_CFG_PRU0_ENDAT_CH1_CFG0")
ICSS_CFG_PRU0_ENDAT_CH1_CFG0    .set    0x00F0
    .endif
    .if !$isdefed("ICSS_CFG_PRU0_ENDAT_CH2_CFG0")
ICSS_CFG_PRU0_ENDAT_CH2_CFG0    .set    0x00F8
    .endif
    .if !$isdefed("ICSS_CFG_PRU1_ENDAT_CH0_CFG0")
ICSS_CFG_PRU1_ENDAT_CH0_CFG0    .set    0x0108
    .endif
    .if !$isdefed("ICSS_CFG_PRU1_ENDAT_CH1_CFG0")
ICSS_CFG_PRU1_ENDAT_CH1_CFG0    .set    0x0110
    .endif
    .if !$isdefed("ICSS_CFG_PRU1_ENDAT_CH2_CFG0")
ICSS_CFG_PRU1_ENDAT_CH2_CFG0    .set    0x0118
    .endif
; ============================================================================
`;
}

/**
 * Returns the macro body for the combined UART Config block.
 *
 * Sequence:
 *   1. Global Reinit FIRST (TRM-mandated: reinit before de-asserting rx_en)
 *   2. Poll busy bit (channel 0 busy bit covers the peripheral reinit)
 *   3. De-assert rx_en AFTER reinit (handles stuck rx_en from previous run)
 *   4. GPCFG write (once — same PRU for TX and RX)
 *   5. [if TX] TXCFG write, TX CH_CFG0 write, r30.w2 channel select + clk_mode=1
 *   6. [if RX] RXCFG write, RX CH_CFG0 write
 */
function getMacro(pruInstructionMacro, opCode) {
    const prefix = (pruInstructionMacro === "") ? getIcssCfgDefinitions() : "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;

    // Decode what is enabled from macro name
    const hasTX = macroName.includes("_tx_");
    const hasRX = macroName.includes("_rx_");

    const isPRU0  = macroName.includes("_pru0");
    const pruNum  = isPRU0 ? "0" : "1";
    const gpcfgReg = isPRU0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";

    // TX register aliases
    const txcfgReg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_TXCFG"       : "ICSS_CFG_PRU1_ENDAT_TXCFG";
    const txCh0Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const txCh1Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const txCh2Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";

    // RX register aliases
    const rxcfgReg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_RXCFG"       : "ICSS_CFG_PRU1_ENDAT_RXCFG";
    const rxCh0Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const rxCh1Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const rxCh2Reg   = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0"    : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";

    // Parse macro name for TX section params
    // TX section in name: _tx_ch{N}_lsb|msb_start{N}[_stop{N}]_ss|cont
    let txChannel = "0", txIsLSB = true, txIsSS = true, txHasExplicitStop = false, txStopBit = "0";
    if (hasTX) {
        const txChMatch = macroName.match(/_tx_ch(\d)_/);
        if (txChMatch) txChannel = txChMatch[1];
        txIsLSB = macroName.includes("_tx_ch" + txChannel + "_lsb_");
        txIsSS  = macroName.includes("_ss");
        const stopMatch = macroName.match(/_tx_[^_]+_[^_]+_start\d_stop(\d)/);
        if (stopMatch) { txHasExplicitStop = true; txStopBit = stopMatch[1]; }
    }

    // Parse macro name for RX section params
    // RX section in name: _rx_ch{N}_lsb|msb_1x|2x|4x|8x
    let rxChannel = "0", rxIsLSB = true;
    if (hasRX) {
        const rxChMatch = macroName.match(/_rx_ch(\d)_/);
        if (rxChMatch) rxChannel = rxChMatch[1];
        rxIsLSB = macroName.includes("_rx_ch" + rxChannel + "_lsb_");
    }

    // Parameter positions depend on what's enabled
    // For TX+RX: macro params = txChannel, txClockDiv, txClkSel, txDataBits, rxChannel, rxClockDiv, rxClkSel, rxOversample, rxStartBitPol, rxFrameSize
    // For TX only: txChannel, txClockDiv, txClkSel, txDataBits
    // For RX only: rxChannel, rxClockDiv, rxClkSel, rxOversample, rxStartBitPol, rxFrameSize
    let paramIdx = 1;
    let txCh, txClockDiv, txClkSel, txDataBits;
    let rxCh, rxClockDiv, rxClkSel, rxOversample, rxStartBitPol, rxFrameSize;

    if (hasTX) {
        txCh       = parts[paramIdx++] || "txChannel";
        txClockDiv = parts[paramIdx++] || "txClockDiv";
        txClkSel   = parts[paramIdx++] || "txClkSel";
        txDataBits = parts[paramIdx++] || "txDataBits";
    }
    if (hasRX) {
        rxCh          = parts[paramIdx++] || "rxChannel";
        rxClockDiv    = parts[paramIdx++] || "rxClockDiv";
        rxClkSel      = parts[paramIdx++] || "rxClkSel";
        rxOversample  = parts[paramIdx++] || "rxOversample";
        rxStartBitPol = parts[paramIdx++] || "rxStartBitPol";
        rxFrameSize   = parts[paramIdx++] || "rxFrameSize";
    }

    let macroBody = "";

    if (pruInstructionMacro === "") {
        // Build macro signature
        let sigParams = [];
        if (hasTX) sigParams.push("txChannel", "txClockDiv", "txClkSel", "txDataBits");
        if (hasRX) sigParams.push("rxChannel", "rxClockDiv", "rxClkSel", "rxOversample", "rxStartBitPol", "rxFrameSize");
        macroBody = macroName + "\t.macro  " + sigParams.join(", ") + "\n";
        macroBody += `\t; UART Combined Config — PRU${pruNum}${hasTX ? ", TX enabled" : ""}${hasRX ? ", RX enabled" : ""}\n`;
    }

    macroBody += `
\t; ========== Step 1: Global Reinit (TRM-mandated order: reinit BEFORE de-asserting rx_en) ==========
\t; If rx_en was left HIGH by a previous stuck RX, reinit resets the RX state machine first.
\tset     r31, r31, 19                       ; 1. Global Reinit — clears FIFO and state machines

\t; ========== Step 2: Poll Reinit Busy Bit (channel 0) ==========
wait_reinit?:
\tqbbs    wait_reinit?, r31, 5
\tldi     r30.b3, 0x00                       ; 3. De-assert rx_en AFTER reinit confirmed complete

\t; ========== Step 3: GPCFG — Enable Peripheral Mode for PRU${pruNum} ==========
\tldi32   TEMP_REG1, 0x04000000
\tldi     TEMP_REG2.w0, ${gpcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4
`;

    if (hasTX) {
        const isSingleShot = txIsSS;
        // Shift by 3 because we write byte 1 (+1 offset) only.
        // TX_FRAME_SIZE lives in CFG0[15:11]. Within byte 1 (CFG0[15:8]), that is bits[7:3].
        const frameSizeExpr = isSingleShot ? `(${txDataBits} + 2) << 3` : `0`;
        const frameSizeComment = isSingleShot
            ? `; byte1[7:3] = TX_FRAME_SIZE = txDataBits + 2 (single-shot)`
            : `; byte1[7:3] = 0 (continuous mode)`;

        macroBody += `
\t; ========== Step 4: TX Clock Configuration (TXCFG) ==========
\t; [31:16] = clockDiv, [4] = TX_CLK_SEL (0=192MHz, 1=200MHz)
\tldi     TEMP_REG1.w0, (${txClkSel} << 4)
\tldi     TEMP_REG1.w2, ${txClockDiv}
\tldi     TEMP_REG2.w0, ${txcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Step 5: TX Channel CFG0 — TX frame size (byte 1) + TX_FIFO_SWAP_BITS (byte 3) ==========
\t; Byte 1 (+1 offset): read-modify-write — preserve TX_WDLY[10:8], set TX_FRAME_SIZE[15:11]
\t; ${frameSizeComment}
\t.if ${txCh} == 0
\tldi     TEMP_REG2.w0, ${txCh0Reg} + 1
\t.elseif ${txCh} == 1
\tldi     TEMP_REG2.w0, ${txCh1Reg} + 1
\t.else
\tldi     TEMP_REG2.w0, ${txCh2Reg} + 1
\t.endif
\tlbco    &TEMP_REG1.b0, ICSS_CFG, TEMP_REG2.w0, 1  ; read existing byte 1
\tand     TEMP_REG1.b0, TEMP_REG1.b0, 0x07           ; clear TX_FRAME_SIZE[15:11], keep WDLY[10:8]
\tor      TEMP_REG1.b0, TEMP_REG1.b0, ${frameSizeExpr}  ; set TX_FRAME_SIZE
\tsbco    &TEMP_REG1.b0, ICSS_CFG, TEMP_REG2.w0, 1  ; write byte 1 back only
\t; Byte 3 (+3 offset): TX_FIFO_SWAP_BITS = bit 31 of CFG0 = bit 7 of byte 3
\t; ${txIsLSB ? "LSB first: set TX_FIFO_SWAP_BITS=1" : "MSB first: clear TX_FIFO_SWAP_BITS=0"}
\t.if ${txCh} == 0
\tldi     TEMP_REG2.w0, ${txCh0Reg} + 3
\t.elseif ${txCh} == 1
\tldi     TEMP_REG2.w0, ${txCh1Reg} + 3
\t.else
\tldi     TEMP_REG2.w0, ${txCh2Reg} + 3
\t.endif
\tlbco    &TEMP_REG1.b0, ICSS_CFG, TEMP_REG2.w0, 1  ; read existing byte 3
${txIsLSB
    ? `\tset     TEMP_REG1.b0, TEMP_REG1.b0, 7           ; set bit 7 = TX_FIFO_SWAP_BITS (LSB first)`
    : `\tclr     TEMP_REG1.b0, TEMP_REG1.b0, 7           ; clear bit 7 = TX_FIFO_SWAP_BITS (MSB first)`}
\tsbco    &TEMP_REG1.b0, ICSS_CFG, TEMP_REG2.w0, 1  ; write byte 3 back only

\t; ========== Step 6: TX Channel Select + clk_mode=1 ==========
\t; clk_mode=1: free-running, stops HIGH after last RX frame
\t; This keeps the clock running after TX so the encoder can clock its response back.
\t.if ${txCh} == 0
\tldi     r30.w2, 0x0008                    ; clk_mode=1 (bits[20:19]=0b01), ch=0
\t.elseif ${txCh} == 1
\tldi     r30.w2, 0x0009                    ; clk_mode=1, ch=1
\t.else
\tldi     r30.w2, 0x000A                    ; clk_mode=1, ch=2
\t.endif
`;
    }

    if (hasRX) {
        macroBody += `
\t; ========== Step ${hasTX ? "7" : "4"}: RX Clock Configuration (RXCFG) ==========
\t; [31:16] = clockDiv, [4] = RX_CLK_SEL, [3] = startBitPol, [2:0] = oversample encoding
\tldi     TEMP_REG1.w0, (${rxClkSel} << 4) | ${rxOversample}
`;
        // startBitPol is a runtime param — use assembler conditional
        macroBody += `\t.if ${rxStartBitPol} != 0
\tset     TEMP_REG1.w0, TEMP_REG1.w0, 3    ; Set bit 3 (startBitPol=1)
\t.endif
\tldi     TEMP_REG1.w2, ${rxClockDiv}
\tldi     TEMP_REG2.w0, ${rxcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Step ${hasTX ? "8" : "5"}: RX Channel CFG0 — RX frame size + bitSwap (bytes 2-3) ==========
\t; Writes bytes 2-3 (+2 offset, 2 bytes) only — does NOT touch byte 1 (TX frame size).
\t; [27:16] = RX_FRAME_SIZE, [31] = bitSwap (LSB first)
\t.if ${rxCh} == 0
\tldi     TEMP_REG2.w0, ${rxCh0Reg} + 2
\t.elseif ${rxCh} == 1
\tldi     TEMP_REG2.w0, ${rxCh1Reg} + 2
\t.else
\tldi     TEMP_REG2.w0, ${rxCh2Reg} + 2
\t.endif
\tldi     TEMP_REG1.w0, ${rxFrameSize}  ; RX_FRAME_SIZE in bits[27:16] of this 2-byte write
`;
        if (rxIsLSB) {
            macroBody += `\tset     TEMP_REG1.w0, TEMP_REG1.w0, 15     ; Set bit 31 of CFG0 (bitSwap=1, LSB first) — bit 15 of this 2-byte write\n`;
        }
        macroBody += `\tsbco    &TEMP_REG1.w0, ICSS_CFG, TEMP_REG2.w0, 2  ; write bytes 2-3 only
`;
    }

    if (pruInstructionMacro === "") {
        macroBody += "\n .endm";
    }

    return prefix + macroBody;
}

function getLongDescription() {
    return `
## UART Config (Combined TX + RX Hardware Configuration)

### Purpose
Configures the PRU-ICSS ENDAT peripheral for UART TX, RX, or both. Run this block
**once at init**. A single Global Reinit covers both TX and RX setup.

Use the **UART TX Op** block for per-transmission operations and the
**UART RX Op** block for per-reception operations.

### Enable Checkboxes
- **Enable TX Config**: Show and apply TX configuration parameters
- **Enable RX Config**: Show and apply RX configuration parameters
- At least one must be enabled.

### Generated Sequence
1. Global Reinit (r31 bit 19) FIRST — flushes FIFO and state machines (TRM-mandated order)
2. Poll busy bit — deterministic wait for reinit completion
3. De-assert rx_en AFTER reinit — handles stuck rx_en from a previous run
4. GPCFG write — enable peripheral interface mode (once, shared by TX and RX)
5. *(if TX enabled)* TXCFG write, TX CH_CFG0 write, r30.w2 channel select + clk_mode=1
6. *(if RX enabled)* RXCFG write, RX CH_CFG0 write

### Notes
- TX and RX can use **different channels** (e.g. TX on CH0, RX on CH2)
- Only one instance of this block is allowed per design (\`maxInstances: 1\`)
- GPCFG is written once regardless of whether TX-only, RX-only, or both are enabled
`;
}

exports = {
    displayName: "PRU UART Config",
    defaultInstanceName: "PRU_UART_CONFIG_",
    maxInstances: 1,
    longDescription: getLongDescription(),
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
        {
            name: "pruSelect",
            displayName: "PRU Selection",
            description: "Auto-detected from system context (read-only)",
            default: getPruNumberFromContext(),
            readOnly: true,
            options: [
                { name: 0, displayName: "PRU0" },
                { name: 1, displayName: "PRU1" }
            ]
        },

        // ===== TX CONFIG =====
        {
            name: "enableTX",
            displayName: "Enable TX Config",
            description: "Enable TX peripheral configuration. Required if using UART TX Op block.",
            default: true,
            onChange: function(inst, ui) {
                const show = inst.enableTX;
                ui.txChannel.hidden          = !show;
                ui.txClockSource.hidden      = !show;
                ui.txBaudRate.hidden         = !show;
                ui.txClockDivider.hidden     = !show;
                ui.txStartBitPolarity.hidden = !show;
                ui.txStopBitPolarity.hidden  = !show;
                ui.txBitSwap.hidden          = !show;
                ui.txMode.hidden             = !show;
            }
        },
        {
            name: "txChannel",
            displayName: "TX Channel",
            description: "ENDAT channel for UART TX (0, 1, or 2)",
            default: 0,
            hidden: false,
            options: [
                { name: 0, displayName: "Channel 0" },
                { name: 1, displayName: "Channel 1" },
                { name: 2, displayName: "Channel 2" }
            ]
        },
        {
            name: "txClockSource",
            displayName: "TX Clock Source",
            description: "192 MHz (ICSSGn_UART_CLK) or 200 MHz (ICSSGn_CORE_CLK)",
            default: 0,
            hidden: false,
            options: [
                { name: 0, displayName: "192 MHz (UART_CLK)" },
                { name: 1, displayName: "200 MHz (CORE_CLK)" }
            ]
        },
        {
            name: "txBaudRate",
            displayName: "TX Baud Rate (MHz)",
            description: "Desired TX baud rate in MHz. Clock must be divisible by baudRate.",
            default: 12,
            hidden: false,
            displayFormat: "dec"
        },
        {
            name: "txClockDivider",
            displayName: "TX Clock Divider (Calculated)",
            description: "Calculated TX clock divider = (clockSource / baudRate) - 1",
            default: 15,
            readOnly: true,
            hidden: false,
            getValue: (inst) => {
                const clkMHz = inst.txClockSource === 0 ? 192 : 200;
                if (inst.txBaudRate === 0 || clkMHz % inst.txBaudRate !== 0) return 0;
                return (clkMHz / inst.txBaudRate) - 1;
            }
        },
        {
            name: "txStartBitPolarity",
            displayName: "TX Start Bit Polarity",
            description: "Polarity of TX start bit",
            default: 1,
            hidden: false,
            options: [
                { name: 0, displayName: "0 (Low/Space)" },
                { name: 1, displayName: "1 (High/Mark)" }
            ]
        },
        {
            name: "txStopBitPolarity",
            displayName: "TX Stop Bit Polarity",
            description: "Polarity of TX stop bit",
            default: 0,
            hidden: false,
            options: [
                { name: 0, displayName: "0 (Low/Space)" },
                { name: 1, displayName: "1 (High/Mark)" }
            ]
        },
        {
            name: "txBitSwap",
            displayName: "TX Bit Swap (LSB First)",
            description: "Enable LSB-first transmission (standard UART). Disable for MSB-first.",
            default: true,
            hidden: false,
        },
        {
            name: "txMode",
            displayName: "TX Mode",
            description: "Transmission mode based on TX data bits",
            hidden: false,
            readOnly: true,
            getValue: (_inst) => getTxDataBits() <= 29 ? "Single-shot" : "Continuous",
            default: "Single-shot"
        },
        // ===== RX CONFIG =====
        {
            name: "enableRX",
            displayName: "Enable RX Config",
            description: "Enable RX peripheral configuration. Required if using UART RX Op block.",
            default: true,
            onChange: function(inst, ui) {
                const show = inst.enableRX;
                ui.rxChannel.hidden          = !show;
                ui.rxClockSource.hidden      = !show;
                ui.rxBaudRate.hidden         = !show;
                ui.rxClockDivider.hidden     = !show;
                ui.rxOversampleSize.hidden   = !show;
                ui.rxStartBitPolarity.hidden = !show;
                ui.rxBitSwap.hidden          = !show;
            }
        },
        {
            name: "rxChannel",
            displayName: "RX Channel",
            description: "ENDAT channel for UART RX (0, 1, or 2)",
            default: 2,
            hidden: false,
            options: [
                { name: 0, displayName: "Channel 0" },
                { name: 1, displayName: "Channel 1" },
                { name: 2, displayName: "Channel 2" }
            ]
        },
        {
            name: "rxClockSource",
            displayName: "RX Clock Source",
            description: "192 MHz (ICSSGn_UART_CLK) or 200 MHz (ICSSGn_CORE_CLK)",
            default: 0,
            hidden: false,
            options: [
                { name: 0, displayName: "192 MHz (UART_CLK)" },
                { name: 1, displayName: "200 MHz (CORE_CLK)" }
            ]
        },
        {
            name: "rxBaudRate",
            displayName: "RX Baud Rate (MHz)",
            description: "Desired RX baud rate in MHz. Clock must be divisible by (baudRate * oversample).",
            default: 12,
            hidden: false,
            displayFormat: "dec"
        },
        {
            name: "rxClockDivider",
            displayName: "RX Clock Divider (Calculated)",
            description: "Calculated RX clock divider = (clockSource / (baudRate * oversample)) - 1",
            default: 1,
            readOnly: true,
            hidden: false,
            getValue: (inst) => {
                let osMul;
                if (inst.rxOversampleSize === 0)      osMul = 1;
                else if (inst.rxOversampleSize === 1) osMul = 2;
                else if (inst.rxOversampleSize === 3) osMul = 4;
                else                                  osMul = 8;
                const clkMHz = inst.rxClockSource === 0 ? 192 : 200;
                const bxo = inst.rxBaudRate * osMul;
                if (bxo === 0 || clkMHz % bxo !== 0) return 0;
                return (clkMHz / bxo) - 1;
            }
        },
        {
            name: "rxOversampleSize",
            displayName: "RX Oversample Size",
            description: "Samples per bit. Higher = better noise immunity.",
            default: 7,
            hidden: false,
            options: [
                { name: 0, displayName: "1x" },
                { name: 1, displayName: "2x" },
                { name: 3, displayName: "4x" },
                { name: 7, displayName: "8x" }
            ]
        },
        {
            name: "rxStartBitPolarity",
            displayName: "RX Start Bit Polarity",
            description: "Edge that indicates start of RX frame (0=Falling, 1=Rising)",
            default: 1,
            hidden: false,
            options: [
                { name: 0, displayName: "Falling Edge (0)" },
                { name: 1, displayName: "Rising Edge (1)" }
            ]
        },
        {
            name: "rxBitSwap",
            displayName: "RX Bit Swap (LSB First)",
            description: "Enable LSB-first reception (standard UART). Disable for MSB-first.",
            default: true,
            hidden: false,
        },

        // ===== HIDDEN CODE GEN FIELDS =====
        {
            name: "constant1",
            hidden: true,
            default: "0, 15, 0, 8",
            getValue: (inst) => {
                let params = [];
                if (inst.enableTX) {
                    const clkMHz = inst.txClockSource === 0 ? 192 : 200;
                    const txDiv = (inst.txBaudRate === 0 || clkMHz % inst.txBaudRate !== 0)
                        ? 0 : (clkMHz / inst.txBaudRate) - 1;
                    params.push(inst.txChannel, txDiv, inst.txClockSource, getTxDataBits());
                }
                if (inst.enableRX) {
                    let osMul;
                    if (inst.rxOversampleSize === 0)      osMul = 1;
                    else if (inst.rxOversampleSize === 1) osMul = 2;
                    else if (inst.rxOversampleSize === 3) osMul = 4;
                    else                                  osMul = 8;
                    const clkMHz = inst.rxClockSource === 0 ? 192 : 200;
                    const bxo = inst.rxBaudRate * osMul;
                    const rxDiv = (bxo === 0 || clkMHz % bxo !== 0)
                        ? 0 : (clkMHz / bxo) - 1;
                    params.push(inst.rxChannel, rxDiv, inst.rxClockSource,
                                inst.rxOversampleSize, inst.rxStartBitPolarity, getRxFrameSize());
                }
                return params.join(", ");
            }
        },
        {
            name: "opCode",
            displayName: "m_uart_config",
            default: "m_uart_config",
            hidden: true,
            getValue: (inst) => {
                const pruNum   = inst.pruSelect;
                let name = `m_uart_config_pru${pruNum}`;

                if (inst.enableTX) {
                    const bitOrder = inst.txBitSwap ? "lsb" : "msb";
                    const startBit = inst.txStartBitPolarity;
                    const stopBit  = inst.txStopBitPolarity;
                    const needsStop = (startBit === stopBit);
                    const stopSuffix = needsStop ? `_stop${stopBit}` : "";
                    const modeSuffix = getTxDataBits() <= 29 ? "_ss" : "_cont";
                    name += `_tx_ch${inst.txChannel}_${bitOrder}_start${startBit}${stopSuffix}${modeSuffix}`;
                }

                if (inst.enableRX) {
                    const bitOrder = inst.rxBitSwap ? "lsb" : "msb";
                    let osName;
                    if (inst.rxOversampleSize === 0)      osName = "1x";
                    else if (inst.rxOversampleSize === 1) osName = "2x";
                    else if (inst.rxOversampleSize === 3) osName = "4x";
                    else                                  osName = "8x";
                    name += `_rx_ch${inst.rxChannel}_${bitOrder}_${osName}`;
                }

                return name;
            }
        },
        {
            name: "outputReg",
            default: "None",
            hidden: true
        },
        {
            name: "numOfInputPorts",
            default: 0,
            hidden: true
        },
        {
            name: "numOfOutputPorts",
            default: 0,
            hidden: true
        },
        {
            name: "numOfConstants",
            default: 1,
            hidden: true
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (_inst) => 20,
            default: 20
        },
    ],
    ports: (_inst) => [
        { name: "prev", type: "PREV" },
        { name: "next", type: "NEXT" },
    ],
    validate,
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
