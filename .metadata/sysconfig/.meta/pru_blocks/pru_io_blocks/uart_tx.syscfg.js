/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
    // Extract the last character which should be the PRU number
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            return parseInt(match[1]);
        }
    }

    // Default to PRU0 if unable to determine
    return 0;
}

function validate(inst, report) {
    // Get clock frequency based on clock source selection
    // 0 = 192 MHz (ICSSGn_UART_CLK), 1 = 200 MHz (ICSSGn_CORE_CLK)
    const uartClkMHz = inst.clockSource === 0 ? 192 : 200;

    // Check if clock is divisible by baudRate
    // Formula: clockDivider = (CLK / baudRate) - 1
    if (uartClkMHz % inst.baudRate !== 0) {
        report.logError(`Clock (${uartClkMHz} MHz) is not divisible by baudRate = ${inst.baudRate} MHz. Choose a baud rate where ${uartClkMHz} is divisible by baudRate.`, inst, "baudRate");
    } else {
        // Check clock divider range
        const clockDivider = (uartClkMHz / inst.baudRate) - 1;
        if (clockDivider < 0 || clockDivider > 65535) {
            report.logError(`Calculated clock divider (${clockDivider}) is out of range (0-65535). Adjust baud rate.`, inst, "baudRate");
        }
    }

    // Validate data bits range (1-62 bits)
    // For dataBits <= 29: single-shot mode (frame size <= 31 bits)
    // For dataBits > 29: continuous mode (frame size <= 64 bits)
    if (inst.dataBits < 1 || inst.dataBits > 62) {
        report.logError("Data bits must be between 1 and 62", inst, "dataBits");
    }

    // Port connection warnings - numOfInputPorts is dynamically set based on dataBits
    for (let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++) {
        if (inst["input" + iterator.toString()].length == 0) {
            report.logWarning("input" + iterator.toString() + " port not connected to output port", inst);
        }
    }
}

/**
 * Returns the body of the UART TX configuration macro for single-shot mode (1-29 bits)
 * @param {string} pruInstructionMacro - The macro instruction string
 * @param {string} opCode - The operation code (macro name)
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacroSingleShot(pruInstructionMacro, opCode) {
    let macroBody = "";

    // Extract parameters from the pruInstructionMacro
    // Parameter order: dataRegLo, channel, clockDiv, txClkSel, dataBits
    // (dataRegHi is NOT used in single-shot mode, so not included in macro signature)
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const dataRegLo = parts[1] || "dataRegLo";   // Input1: Lower 32 bits
    const channel = parts[2] || "channel";
    const clockDiv = parts[3] || "clockDiv";
    const txClkSel = parts[4] || "txClkSel";     // TX clock source: 0=192MHz, 1=200MHz
    const dataBits = parts[5] || "dataBits";

    // Extract variant information from macro name
    const isPRU0 = macroName.includes("_pru0_");
    const isLSB = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    // Extract number of FIFO bytes from macro name (1-4 for single-shot)
    const numBytesMatch = macroName.match(/_(\d)byte_/);
    const numFifoBytes = numBytesMatch ? parseInt(numBytesMatch[1]) : 2;

    // Determine actual values
    const pruNum = isPRU0 ? "0" : "1";
    const gpcfgReg = isPRU0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const txcfgReg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_TXCFG" : "ICSS_CFG_PRU1_ENDAT_TXCFG";
    const ch0cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const ch1cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const ch2cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";
    const startBitPol = startBit1 ? "1" : "0";
    // Check for explicit stop bit suffix, otherwise derive from start bit (default: opposite)
    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));

    if (pruInstructionMacro == "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + channel + ", " + clockDiv + ", " + txClkSel + ", " + dataBits + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing data (input1, up to 29 bits)
\t;   channel         - ENDAT channel (0, 1, or 2)
\t;   clockDiv        - TX clock divider (0-65535): TX_freq = core_clk / (clockDiv + 1)
\t;   txClkSel        - TX clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK)
\t;   dataBits        - Number of data bits to transmit (1-29 for single-shot)
\t; Configuration: PRU${pruNum}, ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Single-shot (frame size <= 31 bits)
\t; FIFO loads: ${numFifoBytes} bytes
`;
    }

    macroBody += `
\t; ========== ENDAT Peripheral Reset Sequence ==========
\t; Global Reinit to clear FIFO and state machines
\tset     r31, r31, 19

\t; ========== Delay after Reinit ==========
\t.loop   20
\tnop
\t.endloop

\t; ========== Configure GPCFG${pruNum} for PRU${pruNum} Peripheral Mode ==========
\tldi32   TEMP_REG1, 0x04000000
\tldi     TEMP_REG2.w0, ${gpcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure TX Clock ==========
\t; [31:16] = clockDiv, [4] = TX_CLK_SEL (0=192MHz, 1=200MHz)
\tldi     TEMP_REG1.w0, (${txClkSel} << 4)
\tldi     TEMP_REG1.w2, ${clockDiv}
\tldi     TEMP_REG2.w0, ${txcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure Channel CFG0 Register ==========
\t; [31] = bitSwap, [15:11] = frameSize = dataBits + 2
\tldi     TEMP_REG1.w0, (${dataBits} + 2) << 11
\tldi     TEMP_REG1.w2, 0
`;

    if (isLSB) {
        macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31           ; Set bit 31 (bitSwap=1, LSB first)
`;
    }

    macroBody += `\t.if ${channel} == 0
\tldi     TEMP_REG2.w0, ${ch0cfg0Reg}
\t.elseif ${channel} == 1
\tldi     TEMP_REG2.w0, ${ch1cfg0Reg}
\t.else
\tldi     TEMP_REG2.w0, ${ch2cfg0Reg}
\t.endif
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Select Channel ==========
\t.if ${channel} == 0
\tldi     r30.w2, 0x0000
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0001
\t.else
\tldi     r30.w2, 0x0002
\t.endif

\t; ========== Construct Frame ==========
\tmov     TEMP_REG1, ${dataRegLo}
`;

    if (isLSB) {
        // LSB mode: Frame layout after shift: start@0, data@[dataBits:1], stop@(dataBits+1)
        if (stopBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, ${dataBits}     ; Set stop bit (will be at dataBits+1 after shift)
`;
        } else {
            macroBody += `\tclr     TEMP_REG1, TEMP_REG1, ${dataBits}     ; Clear stop bit (will be at dataBits+1 after shift)
`;
        }
        macroBody += `\tlsl     TEMP_REG1, TEMP_REG1, 1                ; Shift left for start bit at position 0
`;
        if (startBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set start bit at position 0
`;
        }
        // Note: For start bit = 0, bit 0 is already 0 after left shift
    } else {
        // MSB mode: Frame layout: start@31, data@[30:(31-dataBits)], stop@(31-dataBits-1)
        macroBody += `\tlsl     TEMP_REG1, TEMP_REG1, (31 - ${dataBits})  ; Align data to MSB
`;
        if (startBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31             ; Set start bit at position 31
`;
        } else {
            macroBody += `\tclr     TEMP_REG1, TEMP_REG1, 31             ; Clear start bit at position 31
`;
        }
        if (stopBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, (31 - ${dataBits} - 1)  ; Set stop bit
`;
        } else {
            macroBody += `\tclr     TEMP_REG1, TEMP_REG1, (31 - ${dataBits} - 1)  ; Clear stop bit
`;
        }
    }

    macroBody += `
\t; ========== Load FIFO ==========
`;

    if (isLSB) {
        macroBody += `\tmov     r30.b0, TEMP_REG1.b0
`;
        if (numFifoBytes >= 2) macroBody += `\tmov     r30.b0, TEMP_REG1.b1
`;
        if (numFifoBytes >= 3) macroBody += `\tmov     r30.b0, TEMP_REG1.b2
`;
        if (numFifoBytes >= 4) macroBody += `\tmov     r30.b0, TEMP_REG1.b3
`;
    } else {
        macroBody += `\tmov     r30.b0, TEMP_REG1.b3
`;
        if (numFifoBytes >= 2) macroBody += `\tmov     r30.b0, TEMP_REG1.b2
`;
        if (numFifoBytes >= 3) macroBody += `\tmov     r30.b0, TEMP_REG1.b1
`;
        if (numFifoBytes >= 4) macroBody += `\tmov     r30.b0, TEMP_REG1.b0
`;
    }

    macroBody += `
\t; ========== Start Transmission ==========
\tset     r31, r31, 18

\t; ========== Wait for TX Complete ==========
\t.if ${channel} == 0
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 5
\t.elseif ${channel} == 1
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 13
\t.else
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 21
\t.endif
`;

    if (pruInstructionMacro == "") {
        macroBody += "\n .endm";
    }

    return macroBody;
}

/**
 * Returns the body of the UART TX configuration macro for continuous mode (30-62 bits)
 * MSB-first only for now
 * @param {string} pruInstructionMacro - The macro instruction string
 * @param {string} opCode - The operation code (macro name)
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacroContinuous(pruInstructionMacro, opCode) {
    let macroBody = "";

    // Extract parameters from the pruInstructionMacro
    // Parameter order: dataRegLo, dataRegHi, channel, clockDiv, txClkSel, dataBits
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const dataRegLo = parts[1] || "dataRegLo";   // Input1: Lower 32 bits
    const dataRegHi = parts[2] || "dataRegHi";   // Input2: Upper 32 bits
    const channel = parts[3] || "channel";
    const clockDiv = parts[4] || "clockDiv";
    const txClkSel = parts[5] || "txClkSel";     // TX clock source: 0=192MHz, 1=200MHz
    const dataBits = parts[6] || "dataBits";

    // Extract variant information from macro name
    const isPRU0 = macroName.includes("_pru0_");
    const isLSB = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    // Extract number of FIFO bytes from macro name (5-8 for continuous)
    const numBytesMatch = macroName.match(/_(\d)byte_/);
    const numFifoBytes = numBytesMatch ? parseInt(numBytesMatch[1]) : 5;

    // Determine actual values
    const pruNum = isPRU0 ? "0" : "1";
    const gpcfgReg = isPRU0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const txcfgReg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_TXCFG" : "ICSS_CFG_PRU1_ENDAT_TXCFG";
    const ch0cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const ch1cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const ch2cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";
    const startBitPol = startBit1 ? "1" : "0";
    // Check for explicit stop bit suffix, otherwise derive from start bit (default: opposite)
    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));

    // Number of bytes to load via continuous polling (after initial 4 bytes)
    const continuousBytes = numFifoBytes - 4;

    if (pruInstructionMacro == "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + dataRegHi + ", " + channel + ", " + clockDiv + ", " + txClkSel + ", " + dataBits + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing lower 32 bits of data (input1)
\t;   dataRegHi       - Register containing upper bits of data (input2)
\t;   channel         - ENDAT channel (0, 1, or 2)
\t;   clockDiv        - TX clock divider (0-65535): TX_freq = core_clk / (clockDiv + 1)
\t;   txClkSel        - TX clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK)
\t;   dataBits        - Number of data bits to transmit (30-62 for continuous)
\t; Configuration: PRU${pruNum}, ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Continuous (frame size = 0, total bytes = ${numFifoBytes})
\t; Initial FIFO load: 4 bytes, Continuous load: ${continuousBytes} bytes
`;
    }

    macroBody += `
\t; ========== ENDAT Peripheral Reset Sequence ==========
\t; Global Reinit to clear FIFO and state machines
\tset     r31, r31, 19

\t; ========== Delay after Reinit ==========
\t.loop   20
\tnop
\t.endloop

\t; ========== Configure GPCFG${pruNum} for PRU${pruNum} Peripheral Mode ==========
\tldi32   TEMP_REG1, 0x04000000
\tldi     TEMP_REG2.w0, ${gpcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure TX Clock ==========
\t; [31:16] = clockDiv, [4] = TX_CLK_SEL (0=192MHz, 1=200MHz)
\tldi     TEMP_REG1.w0, (${txClkSel} << 4)
\tldi     TEMP_REG1.w2, ${clockDiv}
\tldi     TEMP_REG2.w0, ${txcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure Channel CFG0 Register ==========
\t; [31] = bitSwap, [15:11] = frameSize = 0 (continuous mode)
\tldi     TEMP_REG1.w0, 0                    ; Frame size = 0 for continuous mode
\tldi     TEMP_REG1.w2, 0
`;

    if (isLSB) {
        macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31           ; Set bit 31 (bitSwap=1, LSB first)
`;
    }

    macroBody += `\t.if ${channel} == 0
\tldi     TEMP_REG2.w0, ${ch0cfg0Reg}
\t.elseif ${channel} == 1
\tldi     TEMP_REG2.w0, ${ch1cfg0Reg}
\t.else
\tldi     TEMP_REG2.w0, ${ch2cfg0Reg}
\t.endif
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Select Channel ==========
\t; Use ldi to r30.w2 to avoid read-modify-write on r30.b0 (FIFO port)
\t.if ${channel} == 0
\tldi     r30.w2, 0x0000
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0001
\t.else
\tldi     r30.w2, 0x0002
\t.endif

`;

    // Frame construction for continuous mode (MSB-first)
    // Following the pattern from main.asm:
    // - dataRegHi contains upper bits, dataRegLo contains lower 32 bits
    // - For MSB mode: start bit at position 31 of first register
    // - Data flows from MSB of dataRegHi down through dataRegLo
    // - Stop bit at calculated position in second register

    if (isLSB) {
        // LSB-first continuous mode (>32 bits only, 30-32 handled by getMacroSpecificBits)
        // Frame layout: [0]=start, [1..dataBits]=data, [dataBits+1]=stop
        // FIFO loads from byte 0 upward (low bytes first)
        // Use TEMP_REG1 for lower frame, TEMP_REG2 for upper frame

        macroBody += `\t; ========== Construct Frame (LSB First, Continuous >32-bit) ==========
\t; Frame: start@0, data@[1..dataBits], stop@(dataBits+1)
\t; Total frame bits = dataBits + 2 = ${dataBits} + 2
\t;
\t; >32-bit case: data spans dataRegLo and dataRegHi
\t; Copy data to TEMP registers for manipulation
\tmov     TEMP_REG1, ${dataRegLo}            ; Lower 32 bits
\tmov     TEMP_REG2, ${dataRegHi}            ; Upper bits
\t;
\t; 64-bit left shift by 1 to make room for start bit at position 0
\t; Save bit 31 of TEMP_REG1, shift both registers left, OR saved bit into TEMP_REG2
\tlsr     ${dataRegLo}, TEMP_REG1, 31        ; Save bit 31 into dataRegLo (temp use)
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift lower left by 1
\tlsl     TEMP_REG2, TEMP_REG2, 1            ; Shift upper left by 1
\tor      TEMP_REG2, TEMP_REG2, ${dataRegLo} ; OR saved bit into upper reg bit 0

`;
            if (startBitPol === "1") {
                macroBody += `\t; Set start bit at position 0
\tset     TEMP_REG1, TEMP_REG1, 0
`;
            }
            // Note: For start bit = 0, bit 0 is already 0 after left shift

            // Stop bit position = dataBits + 1 (after shifting)
            // If dataBits + 1 < 32, stop bit is in TEMP_REG1
            // If dataBits + 1 >= 32, stop bit is in TEMP_REG2 at position (dataBits + 1 - 32)
            if (stopBitPol === "1") {
                macroBody += `\t; Set stop bit at position (dataBits + 1)
\t.if (${dataBits} + 1) < 32
\tset     TEMP_REG1, TEMP_REG1, (${dataBits} + 1)
\t.else
\tset     TEMP_REG2, TEMP_REG2, (${dataBits} + 1 - 32)
\t.endif
`;
            } else {
                macroBody += `\t; Clear stop bit at position (dataBits + 1)
\t.if (${dataBits} + 1) < 32
\tclr     TEMP_REG1, TEMP_REG1, (${dataBits} + 1)
\t.else
\tclr     TEMP_REG2, TEMP_REG2, (${dataBits} + 1 - 32)
\t.endif
`;
            }

            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (LSB First) ==========
\tmov     r30.b0, TEMP_REG1.b0
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b3

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

`;
            // Load remaining bytes via continuous polling
            const byteNamesLSB = ["TEMP_REG2.b0", "TEMP_REG2.b1", "TEMP_REG2.b2", "TEMP_REG2.b3"];
            for (let i = 0; i < continuousBytes; i++) {
                const byteNum = 5 + i;
                macroBody += `\t; ========== Load Byte ${byteNum} via Continuous Polling ==========
wait_fifo_for_byte${byteNum}?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte${byteNum}?, ${dataRegLo}, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, ${byteNamesLSB[i]}

`;
            }

    } else {
        // MSB-first continuous mode (>32 bits only, 30-32 handled by getMacroSpecificBits)
        // Use TEMP_REG1 for first 32 bits of frame, TEMP_REG2 for remaining bits
        //
        // Frame layout (for dataBits data bits):
        //   Total frame = dataBits + 2 bits (start + data + stop)
        //   Transmitted MSB first: start, data[dataBits-1], data[dataBits-2], ..., data[0], stop
        //
        // For transmission, we pack into TEMP_REG1 (first 32 bits) and TEMP_REG2 (remaining bits)
        // TEMP_REG1.b3 transmitted first, then b2, b1, b0, then TEMP_REG2.b3, b2, b1, b0
        //
        // Input:
        //   dataRegHi: upper (dataBits - 32) bits of data in positions [(dataBits-33):0]
        //   dataRegLo: lower 32 bits of data in positions [31:0]
        //
        // Frame bit positions (MSB = bit 63 transmitted first):
        //   Bit (dataBits+1): start bit (at position 31 of TEMP_REG1)
        //   Bits dataBits..1: data bits
        //   Bit 0: stop bit

        macroBody += `\t; ========== Construct Frame (MSB First, Continuous >32-bit) ==========
\t; Frame: start + ${dataBits} data bits + stop = ${dataBits} + 2 bits total
\t; Input: dataRegHi[(${dataBits}-33):0] = upper ${dataBits}-32 bits, dataRegLo[31:0] = lower 32 bits
\t;
\t; TEMP_REG1 bit layout: [31]=start, [30:0]=data[${dataBits}-1:${dataBits}-31]
\t; TEMP_REG2 bit layout: [31:(64-${dataBits})]=data[${dataBits}-32:0], [...:0]=padding+stop
\t;
\t; Step 1: Clear TEMP_REG1 and TEMP_REG2
\tldi     TEMP_REG1, 0
\tldi     TEMP_REG2, 0
`;

        if (startBitPol === "1") {
            macroBody += `
\t; Step 2: Set start bit at position 31 of TEMP_REG1
\tset     TEMP_REG1, TEMP_REG1, 31
`;
        }

        macroBody += `
\t; Step 3: Place upper data bits (dataRegHi) into TEMP_REG1
\t;   dataRegHi has (${dataBits} - 32) bits in positions [(${dataBits}-33):0]
\t;   These should go to TEMP_REG1 positions [30:(31-(${dataBits}-32))] = [30:(63-${dataBits})]
\t;   Shift left by (63 - ${dataBits}) to align MSB of dataRegHi at bit 30
\tmov     TEMP_REG2, ${dataRegHi}
\tlsl     TEMP_REG2, TEMP_REG2, (63 - ${dataBits})
\tor      TEMP_REG1, TEMP_REG1, TEMP_REG2

\t; Step 4: Place top bits of dataRegLo into TEMP_REG1
\t;   We need (64 - ${dataBits} - 1) = (63 - ${dataBits}) bits from top of dataRegLo
\t;   These are dataRegLo[31:(${dataBits}-31)] going to TEMP_REG1[(62-${dataBits}):0]
\t;   Shift dataRegLo right by (${dataBits} - 31) to position these bits at LSB
\tmov     TEMP_REG2, ${dataRegLo}
\tlsr     TEMP_REG2, TEMP_REG2, (${dataBits} - 31)
\tor      TEMP_REG1, TEMP_REG1, TEMP_REG2

\t; Step 5: Place remaining bits of dataRegLo into TEMP_REG2
\t;   Remaining bits are dataRegLo[(${dataBits}-32):0] = (${dataBits} - 31) bits
\t;   These go to TEMP_REG2[31:(32-(${dataBits}-31))] = [31:(63-${dataBits})]
\t;   Shift left by (63 - ${dataBits}) to align at MSB of TEMP_REG2
\t;   But also need to leave room for stop bit at the end
\t;   Actually: shift left by (32 - (${dataBits} - 31)) = (63 - ${dataBits})
\tmov     TEMP_REG2, ${dataRegLo}
\tlsl     TEMP_REG2, TEMP_REG2, (63 - ${dataBits})
`;

        if (stopBitPol === "1") {
            macroBody += `
\t; Step 6: Set stop bit
\t;   Stop bit position in TEMP_REG2 = (63 - ${dataBits}) - 1 = (62 - ${dataBits})
\t;   For ${dataBits}=62: position = 0, for ${dataBits}=33: position = 29
\tset     TEMP_REG2, TEMP_REG2, (62 - ${dataBits})
`;
        } else {
            macroBody += `
\t; Step 6: Clear stop bit at position (62 - ${dataBits})
\tclr     TEMP_REG2, TEMP_REG2, (62 - ${dataBits})
`;
        }

        macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (MSB First) ==========
\tmov     r30.b0, TEMP_REG1.b3
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b0

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

`;
        // Load remaining bytes via continuous polling (MSB first order: b3, b2, b1, b0)
        const byteNamesMSB = ["TEMP_REG2.b3", "TEMP_REG2.b2", "TEMP_REG2.b1", "TEMP_REG2.b0"];
        for (let i = 0; i < continuousBytes; i++) {
            const byteNum = 5 + i;
            macroBody += `\t; ========== Load Byte ${byteNum} via Continuous Polling ==========
wait_fifo_for_byte${byteNum}?:
\tmov     TEMP_REG1, r31
\tlsr     TEMP_REG1, TEMP_REG1, 2
\tand     TEMP_REG1, TEMP_REG1, 0x7
\tqblt    wait_fifo_for_byte${byteNum}?, TEMP_REG1, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, ${byteNamesMSB[i]}

`;
        }
    }

    // Wait for FIFO empty and TX complete
    macroBody += `\t; ========== Wait for FIFO Empty ==========
wait_fifo_empty?:
\tmov     TEMP_REG1, r31
\tlsr     TEMP_REG1, TEMP_REG1, 2
\tand     TEMP_REG1, TEMP_REG1, 0x7
\tqbne    wait_fifo_empty?, TEMP_REG1, 0

\t; ========== Wait for TX Complete ==========
\t.if ${channel} == 0
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 5
\t.elseif ${channel} == 1
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 13
\t.else
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 21
\t.endif
`;

    if (pruInstructionMacro == "") {
        macroBody += "\n .endm";
    }

    return macroBody;
}

/**
 * Returns the body of the UART TX configuration macro
 * Dispatches to single-shot, continuous, or specific bit-size mode based on macro name
 */
function getMacro(pruInstructionMacro, opCode) {
    // Check for specific bit-size macros (30, 31, 32 bits)
    const bitSizeMatch = opCode.match(/_(\d+)bit_/);
    if (bitSizeMatch) {
        const bitSize = parseInt(bitSizeMatch[1]);
        if (bitSize >= 30 && bitSize <= 32) {
            return getMacroSpecificBits(pruInstructionMacro, opCode, bitSize);
        }
    }

    // Extract number of bytes from macro name to determine mode
    const numBytesMatch = opCode.match(/_(\d)byte_/);
    const numFifoBytes = numBytesMatch ? parseInt(numBytesMatch[1]) : 2;

    if (numFifoBytes <= 4) {
        return getMacroSingleShot(pruInstructionMacro, opCode);
    } else {
        return getMacroContinuous(pruInstructionMacro, opCode);
    }
}

/**
 * Returns the body of the UART TX macro for specific bit sizes (30, 31, 32 bits)
 * These need special handling because all data is in dataRegLo only
 */
function getMacroSpecificBits(pruInstructionMacro, opCode, bitSize) {
    let macroBody = "";

    // Extract parameters from the pruInstructionMacro
    // For 30-32 bit macros, format is: macroName dataRegLo, channel, clockDiv, txClkSel
    // (dataRegHi is not used since all data fits in dataRegLo)
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const dataRegLo = parts[1] || "dataRegLo";
    const channel = parts[2] || "channel";
    const clockDiv = parts[3] || "clockDiv";
    const txClkSel = parts[4] || "txClkSel";     // TX clock source: 0=192MHz, 1=200MHz

    // Extract variant information from macro name
    const isPRU0 = macroName.includes("_pru0_");
    const isLSB = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    // Determine actual values
    const pruNum = isPRU0 ? "0" : "1";
    const gpcfgReg = isPRU0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const txcfgReg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_TXCFG" : "ICSS_CFG_PRU1_ENDAT_TXCFG";
    const ch0cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const ch1cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const ch2cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";
    const startBitPol = startBit1 ? "1" : "0";
    // Check for explicit stop bit suffix, otherwise derive from start bit (default: opposite)
    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));

    const frameSize = bitSize + 2;
    const numFifoBytes = Math.ceil(frameSize / 8);

    if (pruInstructionMacro == "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + channel + ", " + clockDiv + ", " + txClkSel + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing ${bitSize} bits of data (input1)
\t;   channel         - ENDAT channel (0, 1, or 2)
\t;   clockDiv        - TX clock divider (0-65535): TX_freq = core_clk / (clockDiv + 1)
\t;   txClkSel        - TX clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK)
\t; Configuration: PRU${pruNum}, ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Continuous (${bitSize}-bit specific), frame size = ${frameSize} bits, ${numFifoBytes} bytes
`;
    }

    // Common configuration section
    macroBody += `
\t; ========== ENDAT Peripheral Reset Sequence ==========
\t; Global Reinit to clear FIFO and state machines
\tset     r31, r31, 19

\t; ========== Delay after Reinit ==========
\t.loop   20
\tnop
\t.endloop

\t; ========== Configure GPCFG${pruNum} for PRU${pruNum} Peripheral Mode ==========
\tldi32   TEMP_REG1, 0x04000000
\tldi     TEMP_REG2.w0, ${gpcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure TX Clock ==========
\t; [31:16] = clockDiv, [4] = TX_CLK_SEL (0=192MHz, 1=200MHz)
\tldi     TEMP_REG1.w0, (${txClkSel} << 4)
\tldi     TEMP_REG1.w2, ${clockDiv}
\tldi     TEMP_REG2.w0, ${txcfgReg}
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Configure Channel CFG0 Register ==========
\t; [31] = bitSwap, [15:11] = frameSize = 0 (continuous mode)
\tldi     TEMP_REG1.w0, 0                    ; Frame size = 0 for continuous mode
\tldi     TEMP_REG1.w2, 0
`;

    if (isLSB) {
        macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31           ; Set bit 31 (bitSwap=1, LSB first)
`;
    }

    macroBody += `\t.if ${channel} == 0
\tldi     TEMP_REG2.w0, ${ch0cfg0Reg}
\t.elseif ${channel} == 1
\tldi     TEMP_REG2.w0, ${ch1cfg0Reg}
\t.else
\tldi     TEMP_REG2.w0, ${ch2cfg0Reg}
\t.endif
\tsbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

\t; ========== Select Channel ==========
\t; Use ldi to r30.w2 to avoid read-modify-write on r30.b0 (FIFO port)
\t.if ${channel} == 0
\tldi     r30.w2, 0x0000
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0001
\t.else
\tldi     r30.w2, 0x0002
\t.endif

`;

    // Frame construction based on bit size and bit order
    // NOTE: Global Reinit is placed INSIDE each case to match working main.asm timing
    if (isLSB) {
        if (bitSize === 30) {
            // 30 bits LSB: frame = 32 bits, all fits in TEMP_REG1
            // Data bits [29:0] -> shifted to [30:1], start at bit 0, stop at bit 31
            macroBody += `\t; ========== Construct Frame (LSB First, 30-bit) ==========
\t; Frame: start@0, data[29:0]@[30:1], stop@31
\t; Total: 32 bits = 4 bytes
\tmov     TEMP_REG1, ${dataRegLo}            ; 30 bits of data (bits [29:0])
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift left by 1 for start bit
`;
            if (startBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set start bit at position 0
`;
            }
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31             ; Set stop bit at position 31
`;
            } else {
                macroBody += `\tclr     TEMP_REG1, TEMP_REG1, 31             ; Clear stop bit at position 31
`;
            }
            macroBody += `
\t; ========== Load 4 Bytes to FIFO (LSB First) ==========
\tmov     r30.b0, TEMP_REG1.b0
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b3

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

`;
        } else if (bitSize === 31) {
            // 31 bits LSB: frame = 33 bits
            // Data bits [30:0] -> shifted to [31:1], start at bit 0, stop at bit 32 (TEMP_REG2)
            macroBody += `\t; ========== Construct Frame (LSB First, 31-bit) ==========
\t; Frame: start@0, data[30:0]@[31:1], stop@32
\t; Total: 33 bits = 5 bytes
\tmov     TEMP_REG1, ${dataRegLo}            ; 31 bits of data (bits [30:0])
\tldi     TEMP_REG2, 0                       ; Clear TEMP_REG2 for stop bit
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift left by 1 for start bit
`;
            if (startBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set start bit at position 0
`;
            }
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG2, TEMP_REG2, 0              ; Set stop bit at position 32 (bit 0 of TEMP_REG2)
`;
            }
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (LSB First) ==========
\tmov     r30.b0, TEMP_REG1.b0
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b3

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

\t; ========== Load Byte 5 via Continuous Polling ==========
wait_fifo_for_byte5?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, TEMP_REG2.b0

`;
        } else if (bitSize === 32) {
            // 32 bits LSB: frame = 34 bits
            // Data bits [31:0] -> start@0, data[30:0]@[31:1], data[31]@32, stop@33
            // IMPORTANT: Set unused bits [7:2] to 1 to prevent false start bit detection after stop
            macroBody += `\t; ========== Construct Frame (LSB First, 32-bit) ==========
\t; Frame: start@0, data[30:0]@[31:1], data[31]@32, stop@33
\t; Total: 34 bits = 5 bytes
\t; Set unused bits [7:2] to 1 to prevent false start bit detection after stop
\tmov     TEMP_REG1, ${dataRegLo}            ; 32 bits of data
\t; Save bit 31 before shifting, and set unused bits [7:2] to 1
\tlsr     TEMP_REG2, TEMP_REG1, 31           ; Save bit 31 into bit 0 of TEMP_REG2
\tor      TEMP_REG2, TEMP_REG2, 0xFC         ; Set bits [7:2] = 1 to prevent false start detection
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift lower 31 bits left by 1
`;
            if (startBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set start bit at position 0
`;
            }
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG2, TEMP_REG2, 1              ; Set stop bit at position 33 (bit 1 of TEMP_REG2)
`;
            } else {
                macroBody += `\tclr     TEMP_REG2, TEMP_REG2, 1              ; Clear stop bit at position 33 (bit 1 of TEMP_REG2)
`;
            }
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (LSB First) ==========
\tmov     r30.b0, TEMP_REG1.b0
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b3

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

\t; ========== Load Byte 5 via Continuous Polling ==========
wait_fifo_for_byte5?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, TEMP_REG2.b0

`;
        }
    } else {
        // MSB mode
        if (bitSize === 30) {
            // 30 bits MSB: frame = 32 bits, all fits in TEMP_REG1
            // Data bits [29:0] -> shifted to [30:1], start at bit 31, stop at bit 0
            macroBody += `\t; ========== Construct Frame (MSB First, 30-bit) ==========
\t; Frame: start@31, data[29:0]@[30:1], stop@0
\t; Total: 32 bits = 4 bytes
\tmov     TEMP_REG1, ${dataRegLo}            ; 30 bits of data (bits [29:0])
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift left by 1 for stop bit at position 0
`;
            if (startBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31             ; Set start bit at position 31
`;
            }
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set stop bit at position 0
`;
            }
            // Note: For stop bit = 0, bit 0 is already 0 after left shift, no need to clear
            macroBody += `
\t; ========== Load 4 Bytes to FIFO (MSB First) ==========
\tmov     r30.b0, TEMP_REG1.b3
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b1
\tmov     r30.b0, TEMP_REG1.b0

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

`;
        } else if (bitSize === 31) {
            // 31 bits MSB: frame = 33 bits
            // TEMP_REG2.b0 bit 0 = start, TEMP_REG1 = 31 data bits + stop at bit 0
            // Load order: TEMP_REG2.b0, then TEMP_REG1.b3, b2, b1, b0
            // IMPORTANT: Set unused bits [7:1] to 1 to prevent false start bit detection (only needed when start=0)
            macroBody += `\t; ========== Construct Frame (MSB First, 31-bit) ==========
\t; Frame: start@32 (TEMP_REG2 bit 0), data[30:0]@[31:1], stop@0
\t; Total: 33 bits = 5 bytes
\t; Load order: TEMP_REG2.b0, TEMP_REG1.b3, b2, b1, b0
`;
            if (startBitPol === "0") {
                macroBody += `\t; Set unused bits [7:1] to 1 to prevent false start bit detection when start=0
\tldi     TEMP_REG2, 0xFE                    ; Set bits [7:1] = 1, bit 0 = 0 (start bit)
`;
            } else {
                macroBody += `\tldi     TEMP_REG2, 0
\tset     TEMP_REG2, TEMP_REG2, 0              ; Set start bit at bit 0 of TEMP_REG2
`;
            }
            macroBody += `\tmov     TEMP_REG1, ${dataRegLo}            ; 31 bits of data (bits [30:0])
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift left by 1 for stop bit at position 0
`;
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set stop bit at position 0
`;
            }
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (MSB First) ==========
\t; Load order: TEMP_REG2.b0 (start bit), TEMP_REG1.b3, b2, b1
\tmov     r30.b0, TEMP_REG2.b0
\tmov     r30.b0, TEMP_REG1.b3
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b1

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

\t; ========== Load Byte 5 via Continuous Polling ==========
wait_fifo_for_byte5?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, TEMP_REG1.b0                 ; Load byte 5 directly from TEMP_REG1.b0

`;
        } else if (bitSize === 32) {
            // 32 bits MSB: frame = 34 bits - EXACTLY MATCHING main.asm working code
            // TEMP_REG2.b0: start@bit1, data[31]@bit0 (like r17 in main.asm)
            // TEMP_REG1: data[30:0]@[31:1], stop@bit0 (like r16 in main.asm)
            // Load order: TEMP_REG2.b0, TEMP_REG1.b3, b2, b1, b0
            // IMPORTANT: Set unused bits [7:2] to 1 to prevent false start bit detection (only needed when start=0)
            macroBody += `\t; ========== Construct Frame (MSB First, 32-bit) - SAME AS WORKING main.asm ==========
\t; Frame: start@33 (TEMP_REG2 bit 1), data[31]@32 (TEMP_REG2 bit 0), data[30:0]@[31:1], stop@0
\t; Total: 34 bits = 5 bytes
\t; Load order: TEMP_REG2.b0, TEMP_REG1.b3, b2, b1, b0
\t; TEMP_REG2 = r17 in main.asm, TEMP_REG1 = r16 in main.asm, dataRegLo = r18 in main.asm
`;
            if (startBitPol === "0") {
                macroBody += `\t; Set unused bits [7:2] to 1 to prevent false start bit detection when start=0
\tldi     TEMP_REG2, 0xFC                    ; Set bits [7:2] = 1, bits [1:0] = 0
`;
            } else {
                macroBody += `\tldi     TEMP_REG2, 0
\tset     TEMP_REG2, TEMP_REG2, 1              ; Set start bit at bit 1 of TEMP_REG2
`;
            }
            macroBody += `\tmov     TEMP_REG1, ${dataRegLo}            ; 32 bits of data (TEMP_REG1 = r16)
\t; Save bit 31 of data into bit 0 of TEMP_REG2
\tlsr     ${dataRegLo}, ${dataRegLo}, 31     ; Get bit 31 (dataRegLo used as temp, like r18)
\tor      TEMP_REG2, TEMP_REG2, ${dataRegLo} ; OR into bit 0 of TEMP_REG2
\tlsl     TEMP_REG1, TEMP_REG1, 1            ; Shift remaining 31 bits left by 1 for stop bit
`;
            if (stopBitPol === "1") {
                macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0              ; Set stop bit at position 0
`;
            }
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (MSB First) ==========
\t; Load order: TEMP_REG2.b0 (start + MSB), TEMP_REG1.b3, b2, b1
\tmov     r30.b0, TEMP_REG2.b0
\tmov     r30.b0, TEMP_REG1.b3
\tmov     r30.b0, TEMP_REG1.b2
\tmov     r30.b0, TEMP_REG1.b1

\t; ========== Start Transmission ==========
\tset     r31, r31, 18

\t; ========== Load Byte 5 via Continuous Polling ==========
wait_fifo_for_byte5?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2   ; Wait until FIFO <= 2
\tmov     r30.b0, TEMP_REG1.b0                 ; Load byte 5 directly from TEMP_REG1.b0

`;
        }
    }

    // Wait for FIFO empty and TX complete (for 31 and 32 bit cases)
    if (bitSize >= 31) {
        macroBody += `\t; ========== Wait for FIFO Empty ==========
wait_fifo_empty?:
\tmov     TEMP_REG1, r31
\tlsr     TEMP_REG1, TEMP_REG1, 2
\tand     TEMP_REG1, TEMP_REG1, 0x7
\tqbne    wait_fifo_empty?, TEMP_REG1, 0

`;
    }

    macroBody += `\t; ========== Wait for TX Complete ==========
\t.if ${channel} == 0
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 5
\t.elseif ${channel} == 1
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 13
\t.else
wait_tx_done?:
\tqbbs    wait_tx_done?, r31, 21
\t.endif
`;

    if (pruInstructionMacro == "") {
        macroBody += "\n .endm";
    }

    return macroBody;
}

function getAIContext() {
    return getLongDescription() + `

    ## How to Configure (For AI/Scripting)
    
    This section describes how to programmatically configure the UART TX block in a .syscfg file.
    
    ### Adding a UART TX Instance
    
    \`\`\`javascript
    const uart_tx = scripting.addModule("/pru_blocks/pru_io_blocks/uart_tx", {}, false);
    const uart_tx1 = uart_tx.addInstance();
    \`\`\`
    
    ### Configuration Parameters
    
    | Parameter | Type | Valid Values | Default | Description |
    |-----------|------|--------------|---------|-------------|
    | pruSelect | Integer | 0, 1 | Auto-detected | PRU Selection (0=PRU0, 1=PRU1) - auto-detected from system context (read-only) |
    | channel | Integer | 0, 1, 2 | 0 | ENDAT channel for UART TX |
    | clockSource | Integer | 0, 1 | 0 | Clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK) |
    | baudRate | Integer | MHz value | 12 | Baud rate in MHz. Clock source must be divisible by baudRate |
    | startBitPolarity | Integer | 0, 1 | 1 | Start bit polarity (0=Low, 1=High) |
    | stopBitPolarity | Integer | 0, 1 | 0 | Stop bit polarity (0=Low, 1=High) |
    | bitSwap | Boolean | true, false | true | Enable LSB-first transmission (true) or MSB-first (false) |
    | dataBits | Integer | 1-62 | 8 | Number of data bits to transmit (NOT including start/stop) |
    
    ### Valid Baud Rates
    **With 192 MHz clock source (default):**
    192 / baudRate must be an integer. Valid baud rates include:
    - 192 MHz (clockDivider = 0)
    - 96 MHz (clockDivider = 1)
    - 64 MHz (clockDivider = 2)
    - 48 MHz (clockDivider = 3)
    - 32 MHz (clockDivider = 5)
    - 24 MHz (clockDivider = 7)
    - 16 MHz (clockDivider = 11)
    - 12 MHz (clockDivider = 15)
    - 8 MHz (clockDivider = 23)
    - 6 MHz (clockDivider = 31)
    - 4 MHz (clockDivider = 47)
    - 3 MHz (clockDivider = 63)
    - 2 MHz (clockDivider = 95)
    - 1 MHz (clockDivider = 191)
    
    **With 200 MHz clock source:**
    200 / baudRate must be an integer. Valid baud rates include:
    - 200 MHz (clockDivider = 0)
    - 100 MHz (clockDivider = 1)
    - 50 MHz (clockDivider = 3)
    - 40 MHz (clockDivider = 4)
    - 25 MHz (clockDivider = 7)
    - 20 MHz (clockDivider = 9)
    - 10 MHz (clockDivider = 19)
    - 8 MHz (clockDivider = 24)
    - 5 MHz (clockDivider = 39)
    - 4 MHz (clockDivider = 49)
    - 2 MHz (clockDivider = 99)
    - 1 MHz (clockDivider = 199)
    
    ### Example Configurations
    
    **Standard 8-bit UART at 12 MHz (192 MHz clock):**
    \`\`\`javascript
    uart_tx1.$name = "UART_TX_0";
    uart_tx1.pruSelect = 0;
    uart_tx1.channel = 0;
    uart_tx1.clockSource = 0;          // 192 MHz (UART_CLK)
    uart_tx1.baudRate = 12;            // 12 MHz baud rate
    uart_tx1.dataBits = 8;
    uart_tx1.bitSwap = true;           // LSB first (standard UART)
    uart_tx1.startBitPolarity = 0;     // Standard UART start bit (low)
    uart_tx1.stopBitPolarity = 1;      // Standard UART stop bit (high)
    \`\`\`
    
    **8-bit UART at 10 MHz using 200 MHz clock:**
    \`\`\`javascript
    uart_tx1.$name = "UART_TX_200MHz";
    uart_tx1.pruSelect = 0;
    uart_tx1.channel = 0;
    uart_tx1.clockSource = 1;          // 200 MHz (CORE_CLK)
    uart_tx1.baudRate = 10;            // 10 MHz baud rate (200/10 = 20, divider = 19)
    uart_tx1.dataBits = 8;
    uart_tx1.bitSwap = true;
    uart_tx1.startBitPolarity = 0;
    uart_tx1.stopBitPolarity = 1;
    \`\`\`
    
    **Extended 32-bit transmission on PRU1, Channel 2:**
    \`\`\`javascript
    uart_tx1.$name = "UART_TX_Extended";
    uart_tx1.pruSelect = 1;
    uart_tx1.channel = 2;
    uart_tx1.clockSource = 0;          // 192 MHz (UART_CLK)
    uart_tx1.baudRate = 24;            // 24 MHz baud rate
    uart_tx1.dataBits = 32;            // 32 data bits (uses continuous mode)
    uart_tx1.bitSwap = false;          // MSB first
    uart_tx1.startBitPolarity = 1;
    uart_tx1.stopBitPolarity = 0;
    \`\`\`
    
    ### Connecting to Other Blocks
    
    \`\`\`javascript
    // Connect data source to UART TX input
    scripting.connect(load_constant1, "output1", uart_tx1, "input1");
    
    // For dataBits > 32, also connect upper 32 bits
    scripting.connect(load_constant2, "output1", uart_tx1, "input2");
    
    // Connect control flow
    scripting.connect(prev_block, "next", uart_tx1, "prev");
    \`\`\`
    
    ### Important Notes for Extended Mode (dataBits > 32)
    
    When transmitting more than 32 data bits, you need **two Load Constant blocks** connected to the UART TX:
    - **input1**: Lower 32 bits of data (from first Load Constant block)
    - **input2**: Upper bits of data (from second Load Constant block)
    
    **Example for 40-bit transmission:**
    \`\`\`javascript
    // Add two Load Constant blocks for 40-bit data
    const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
    const load_constant1 = load_constant_block.addInstance();
    const load_constant2 = load_constant_block.addInstance();
    
    load_constant1.$name = "Load_Constant_Lower";
    load_constant1.constant1 = 0xAABBCCDD;    // Lower 32 bits
    
    load_constant2.$name = "Load_Constant_Upper";
    load_constant2.constant1 = 0xFF;          // Upper 8 bits (bits 32-39)
    
    // UART TX configured for 40 data bits
    uart_tx1.$name = "UART_TX_40bit";
    uart_tx1.dataBits = 40;
    
    // Connect both inputs
    scripting.connect(load_constant1, "output1", uart_tx1, "input1");
    scripting.connect(load_constant2, "output1", uart_tx1, "input2");
    \`\`\`
    `;
}

function getLongDescription() {
    /* TODO: add longDescription */
    return "";
}

exports = {
    displayName: "PRU UART TX",
    defaultInstanceName: "PRU_UART_TX_",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
    uiView: "graph",
    requiredIncludes: [
        /*TODO :  review on how to add include files for the modules*/
    ],
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
        // ========== User Configuration Parameters ==========
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
        {
            name: "channel",
            displayName: "Channel Selection",
            description: "ENDAT channel to use for UART TX (0, 1, or 2)",
            default: 0,
            options: [
                { name: 0, displayName: "Channel 0" },
                { name: 1, displayName: "Channel 1" },
                { name: 2, displayName: "Channel 2" }
            ]
        },
        {
            name: "clockSource",
            displayName: "Clock Source",
            description: "TX clock source selection. 192 MHz (ICSSGn_UART_CLK) or 200 MHz (ICSSGn_CORE_CLK)",
            default: 0,
            options: [
                { name: 0, displayName: "192 MHz (UART_CLK)" },
                { name: 1, displayName: "200 MHz (CORE_CLK)" }
            ]
        },
        {
            name: "baudRate",
            displayName: "Baud Rate (MHz)",
            description: "Desired UART baud rate in MHz. Clock must be divisible by baudRate.",
            default: 12,
            displayFormat: "dec"
        },
        {
            name: "clockDivider",
            displayName: "Clock Divider (Calculated)",
            description: "Calculated clock divider = (clockSource / baudRate) - 1",
            default: 15,
            readOnly: true,
            getValue: (inst) => {
                // Get clock frequency based on clock source selection
                const uartClkMHz = inst.clockSource === 0 ? 192 : 200;
                if (inst.baudRate === 0 || uartClkMHz % inst.baudRate !== 0) {
                    return 0; // Invalid, validation will catch this
                }
                return (uartClkMHz / inst.baudRate) - 1;
            }
        },
        {
            name: "startBitPolarity",
            displayName: "Start Bit Polarity",
            description: "Polarity of start bit. Standard UART: 0 (line goes low to indicate start)",
            default: 1,
            options: [
                { name: 0, displayName: "0 (Low/Space)" },
                { name: 1, displayName: "1 (High/Mark)" }
            ]
        },
        {
            name: "stopBitPolarity",
            displayName: "Stop Bit Polarity",
            description: "Polarity of stop bit. Standard UART: 1 (line returns high after data)",
            default: 0,
            options: [
                { name: 0, displayName: "0 (Low/Space)" },
                { name: 1, displayName: "1 (High/Mark)" }
            ]
        },
        {
            name: "bitSwap",
            displayName: "Bit Swap (LSB First)",
            description: "Enable LSB-first transmission (standard UART). When disabled, MSB is transmitted first",
            default: true
        },
        {
            name: "dataBits",
            displayName: "Data Bits",
            description: "Number of data bits to transmit (1-62). 1-29: single-shot mode, 30-62: continuous mode",
            default: 8,
            range: [1, 62]
        },
        // ========== Calculated/Hidden Configuration ==========
        {
            name: "txMode",
            displayName: "TX Mode",
            description: "Transmission mode based on data bits",
            hidden: false,
            getValue: (inst) => {
                return inst.dataBits <= 29 ? "Single-shot" : "Continuous";
            },
            default: "Single-shot"
        },
        {
            name: "constant1",
            hidden: true,
            default: "0, 15, 0, 8",
            getValue: (inst) => {
                // Build the macro parameters string
                // Parameters: channel, clockDiv, txClkSel, dataBits (dataBits omitted for 30/31/32 bit specific macros)
                // dataRegLo and dataRegHi come from connected input blocks
                const channel = inst.channel;
                const txClkSel = inst.clockSource;  // 0=192MHz, 1=200MHz

                // Calculate clock divider from baud rate using selected clock source
                const uartClkMHz = inst.clockSource === 0 ? 192 : 200;
                const clockDiv = (inst.baudRate === 0 || uartClkMHz % inst.baudRate !== 0)
                    ? 0
                    : (uartClkMHz / inst.baudRate) - 1;

                const dataBits = inst.dataBits;

                // For 30, 31, 32 bit specific macros, dataBits is encoded in macro name
                if (dataBits >= 30 && dataBits <= 32) {
                    return `${channel}, ${clockDiv}, ${txClkSel}`;
                }
                return `${channel}, ${clockDiv}, ${txClkSel}, ${dataBits}`;
            },
        },
        {
            name: "opCode",
            displayName: "m_uart_tx",
            default: "m_uart_tx",
            hidden: true,
            getValue: (inst) => {
                // Generate macro name based on data bits, PRU, bit order, start bit and stop bit polarity
                // For 30, 31, 32 bits: use specific bit-size macros
                // For others: use byte-count based macros
                const pruNum = inst.pruSelect;
                const bitOrder = inst.bitSwap ? "lsb" : "msb";
                const startBit = inst.startBitPolarity;
                const stopBit = inst.stopBitPolarity;

                // Determine if we need explicit stop bit suffix
                // Default behavior: start=0->stop=1, start=1->stop=0
                // Only add _stop suffix for non-default cases (start=stop)
                const needsStopSuffix = (startBit === stopBit);
                const stopSuffix = needsStopSuffix ? `_stop${stopBit}` : "";

                if (inst.dataBits >= 30 && inst.dataBits <= 32) {
                    // Use specific bit-size macro for 30, 31, 32 bits
                    return `m_uart_tx_${inst.dataBits}bit_pru${pruNum}_${bitOrder}_start${startBit}${stopSuffix}`;
                } else {
                    // Use byte-count based macro for other sizes
                    const frameSize = inst.dataBits + 2;
                    const numFifoBytes = Math.floor((frameSize + 7) / 8);
                    return `m_uart_tx_${numFifoBytes}byte_pru${pruNum}_${bitOrder}_start${startBit}${stopSuffix}`;
                }
            },
        },
        {
            name: "outputReg",
            default: "None",
            hidden: true
        },
        {
            name: "numOfInputPorts",
            default: 1,
            hidden: true,
            getValue: (inst) => {
                // Single-shot (1-32 bits): only needs input1
                // Continuous (33-62 bits): needs input1 and input2
                return inst.dataBits > 32 ? 2 : 1;
            }
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
            name: "uartBitPeriod",
            displayName: "UART Bit Period",
            description: "Calculated period per bit based on baud rate",
            hidden: false,
            getValue: (inst) => {
                // Bit period = 1 / baudRate (in MHz) = 1000 / baudRate (in ns)
                const bitPeriodNs = 1000 / inst.baudRate;

                if (bitPeriodNs >= 1000) {
                    return (bitPeriodNs / 1000).toFixed(2) + " us";
                } else {
                    return bitPeriodNs.toFixed(2) + " ns";
                }
            },
            default: "N/A"
        },
        {
            name: "totalBytes",
            displayName: "Total Bytes",
            description: "Total bytes to transmit including start and stop bits",
            hidden: false,
            getValue: (inst) => {
                const frameSize = inst.dataBits + 2;
                return Math.floor((frameSize + 7) / 8);
            },
            default: 2
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (inst) => {
                const frameSize = inst.dataBits + 2;
                const numFifoBytes = Math.floor((frameSize + 7) / 8);

                if (numFifoBytes <= 4) {
                    // Single-shot mode: ~25 base + FIFO loads
                    return 25 + numFifoBytes;
                } else {
                    // Continuous mode: ~25 base + 4 initial + polling overhead + remaining bytes
                    // Polling overhead: ~5 cycles per byte (mov, lsr, and, qblt, mov)
                    const continuousBytes = numFifoBytes - 4;
                    return 25 + 4 + (continuousBytes * 6) + 5; // +5 for final waits
                }
            },
            default: 27
        },
        {
            name: "input1Size",
            hidden: true,
            default: 4,
            getValue: (inst) => {
                // For dataBits 1-8: 1 byte, 9-16: 2 bytes, 17-24: 3->4 bytes, 25+: 4 bytes
                const dataBits = inst.dataBits;
                if (dataBits <= 8) return 1;
                if (dataBits <= 16) return 2;
                return 4;  // 17+ bits needs 4 bytes (3 bytes rounds to 4)
            }
        },
        {
            name: "input2Size",
            hidden: true,
            default: 0,
            getValue: (inst) => {
                // Only need input2 for dataBits > 32 (continuous mode with two registers)
                return inst.dataBits > 32 ? 4 : 0;
            }
        }
    ],
    ports: (inst) => {
        let ports = [];
        // Two input ports: input1 (lower 32 bits), input2 (upper 32 bits)
        for (let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++) {
            ports.push({ name: "input" + iterator.toString(), type: "input" });
        }
        ports.push({ name: "prev", type: "PREV" });
        ports.push({ name: "next", type: "NEXT" });
        return ports;
    },
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