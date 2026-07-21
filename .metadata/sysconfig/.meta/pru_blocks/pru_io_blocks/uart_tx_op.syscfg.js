/**
 * Single-shot TX operation (dataBits 1-29).
 * Assumes peripheral is already configured by uart_tx_config block.
 * Only does: frame construction + FIFO load + start + wait TX done.
 */
function getMacroSingleShot(pruInstructionMacro, opCode) {
    let macroBody = "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const dataRegLo = parts[1] || "dataRegLo";
    const channel   = parts[2] || "channel";
    const dataBits  = parts[3] || "dataBits";

    const isLSB     = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol  = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));
    const startBitPol = startBit1 ? "1" : "0";

    const numBytesMatch = macroName.match(/_(\d)byte_/);
    const numFifoBytes  = numBytesMatch ? parseInt(numBytesMatch[1]) : 2;

    if (pruInstructionMacro === "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + channel + ", " + dataBits + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing data (up to 29 bits)
\t;   channel         - ENDAT channel (0, 1, or 2) - must match uart_tx_config channel
\t;   dataBits        - Number of data bits to transmit (1-29)
\t; Configuration: ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Single-shot (frame size <= 31 bits), FIFO loads: ${numFifoBytes} bytes
\t; NOTE: uart_tx_config block must be called before this block to set up the peripheral
`;
    }

    macroBody += `
\t; ========== Per-command Reinit (reinit BEFORE de-asserting rx_en — TRM order) ==========
\t; Clears FIFO, resets state machines, handles stuck rx_en from a previous incomplete RX.
\tset     r31, r31, 19                       ; 1. Global Reinit FIRST
\t.if ${channel} == 0
wait_reinit?:
\tqbbs    wait_reinit?, r31, 5               ; 2. Wait — CH0 busy bit
\t.elseif ${channel} == 1
wait_reinit?:
\tqbbs    wait_reinit?, r31, 13              ; 2. Wait — CH1 busy bit
\t.else
wait_reinit?:
\tqbbs    wait_reinit?, r31, 21              ; 2. Wait — CH2 busy bit
\t.endif
\tldi     r30.b3, 0x00                       ; 3. De-assert rx_en AFTER reinit

\t; ========== Select Channel + clk_mode=1 ==========
\t; clk_mode=1: free-running, stops HIGH after last RX frame.
\t; Keeps clock running after TX so the encoder can clock its response back.
\t.if ${channel} == 0
\tldi     r30.w2, 0x0008                    ; clk_mode=1 (bits[20:19]=0b01), ch=0
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0009                    ; clk_mode=1, ch=1
\t.else
\tldi     r30.w2, 0x000A                    ; clk_mode=1, ch=2
\t.endif

\t; ========== Construct Frame ==========
\tmov     TEMP_REG1, ${dataRegLo}
`;

    if (isLSB) {
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
    } else {
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
        macroBody += `\tmov     r30.b0, TEMP_REG1.b0\n`;
        if (numFifoBytes >= 2) macroBody += `\tmov     r30.b0, TEMP_REG1.b1\n`;
        if (numFifoBytes >= 3) macroBody += `\tmov     r30.b0, TEMP_REG1.b2\n`;
        if (numFifoBytes >= 4) macroBody += `\tmov     r30.b0, TEMP_REG1.b3\n`;
    } else {
        macroBody += `\tmov     r30.b0, TEMP_REG1.b3\n`;
        if (numFifoBytes >= 2) macroBody += `\tmov     r30.b0, TEMP_REG1.b2\n`;
        if (numFifoBytes >= 3) macroBody += `\tmov     r30.b0, TEMP_REG1.b1\n`;
        if (numFifoBytes >= 4) macroBody += `\tmov     r30.b0, TEMP_REG1.b0\n`;
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

    if (pruInstructionMacro === "") {
        macroBody += "\n .endm";
    }
    return macroBody;
}

/**
 * Specific-bit TX operation for 30, 31, 32 bits.
 * Mirrors getMacroSpecificBits from uart_tx.syscfg.js but without config writes.
 */
function getMacroSpecificBits(pruInstructionMacro, opCode, bitSize) {
    let macroBody = "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const dataRegLo = parts[1] || "dataRegLo";
    const channel   = parts[2] || "channel";

    const isLSB     = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol  = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));
    const startBitPol = startBit1 ? "1" : "0";

    const frameSize    = bitSize + 2;
    const numFifoBytes = Math.ceil(frameSize / 8);

    if (pruInstructionMacro === "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + channel + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing ${bitSize} bits of data
\t;   channel         - ENDAT channel (0, 1, or 2) - must match uart_tx_config channel
\t; Configuration: ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Continuous (${bitSize}-bit specific), frame size = ${frameSize} bits, ${numFifoBytes} bytes
\t; NOTE: uart_tx_config block must be called before this block to set up the peripheral
`;
    }

    macroBody += `
\t; ========== Per-command Reinit (reinit BEFORE de-asserting rx_en — TRM order) ==========
\tset     r31, r31, 19                       ; 1. Global Reinit FIRST
\t.if ${channel} == 0
wait_reinit?:
\tqbbs    wait_reinit?, r31, 5               ; 2. Wait — CH0 busy bit
\t.elseif ${channel} == 1
wait_reinit?:
\tqbbs    wait_reinit?, r31, 13              ; 2. Wait — CH1 busy bit
\t.else
wait_reinit?:
\tqbbs    wait_reinit?, r31, 21              ; 2. Wait — CH2 busy bit
\t.endif
\tldi     r30.b3, 0x00                       ; 3. De-assert rx_en AFTER reinit

\t; ========== Select Channel + clk_mode=1 ==========
\t.if ${channel} == 0
\tldi     r30.w2, 0x0008                    ; clk_mode=1 (bits[20:19]=0b01), ch=0
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0009                    ; clk_mode=1, ch=1
\t.else
\tldi     r30.w2, 0x000A                    ; clk_mode=1, ch=2
\t.endif

`;

    if (isLSB) {
        if (bitSize === 30) {
            macroBody += `
\t; ========== Construct Frame (LSB First, 30-bit) ==========
\t; Frame: start@0, data[29:0]@[30:1], stop@31 — total 32 bits = 4 bytes
\tmov     TEMP_REG1, ${dataRegLo}
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (startBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
            if (stopBitPol  === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31\n`;
            else                     macroBody += `\tclr     TEMP_REG1, TEMP_REG1, 31\n`;
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
            macroBody += `
\t; ========== Construct Frame (LSB First, 31-bit) ==========
\t; Frame: start@0, data[30:0]@[31:1], stop@32 — total 33 bits = 5 bytes
\tmov     TEMP_REG1, ${dataRegLo}
\tldi     TEMP_REG2, 0
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (startBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
            if (stopBitPol  === "1") macroBody += `\tset     TEMP_REG2, TEMP_REG2, 0\n`;
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
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2
\tmov     r30.b0, TEMP_REG2.b0

`;
        } else if (bitSize === 32) {
            macroBody += `
\t; ========== Construct Frame (LSB First, 32-bit) ==========
\t; Frame: start@0, data[30:0]@[31:1], data[31]@32, stop@33 — total 34 bits = 5 bytes
\tmov     TEMP_REG1, ${dataRegLo}
\tlsr     TEMP_REG2, TEMP_REG1, 31
\tor      TEMP_REG2, TEMP_REG2, 0xFC
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (startBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
            if (stopBitPol  === "1") macroBody += `\tset     TEMP_REG2, TEMP_REG2, 1\n`;
            else                     macroBody += `\tclr     TEMP_REG2, TEMP_REG2, 1\n`;
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
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2
\tmov     r30.b0, TEMP_REG2.b0

`;
        }
    } else {
        // MSB mode 30/31/32 — mirrors uart_tx.syscfg.js getMacroSpecificBits MSB section
        if (bitSize === 30) {
            macroBody += `
\t; ========== Construct Frame (MSB First, 30-bit) ==========
\t; Frame: start@31, data[29:0]@[30:1], stop@0 — total 32 bits = 4 bytes
\tmov     TEMP_REG1, ${dataRegLo}
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (startBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31\n`;
            if (stopBitPol  === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
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
            macroBody += `
\t; ========== Construct Frame (MSB First, 31-bit) ==========
\t; Frame: start@32 (TEMP_REG2 bit 0), data[30:0]@[31:1], stop@0 — total 33 bits = 5 bytes
`;
            if (startBitPol === "0") {
                macroBody += `\tldi     TEMP_REG2, 0xFE\n`;
            } else {
                macroBody += `\tldi     TEMP_REG2, 0\n\tset     TEMP_REG2, TEMP_REG2, 0\n`;
            }
            macroBody += `\tmov     TEMP_REG1, ${dataRegLo}
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (stopBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (MSB First) ==========
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
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2
\tmov     r30.b0, TEMP_REG1.b0

`;
        } else if (bitSize === 32) {
            macroBody += `
\t; ========== Construct Frame (MSB First, 32-bit) ==========
\t; Frame: start@33 (TEMP_REG2 bit 1), data[31]@32 (TEMP_REG2 bit 0), data[30:0]@[31:1], stop@0
\t; Total: 34 bits = 5 bytes
`;
            if (startBitPol === "0") {
                macroBody += `\tldi     TEMP_REG2, 0xFC\n`;
            } else {
                macroBody += `\tldi     TEMP_REG2, 0\n\tset     TEMP_REG2, TEMP_REG2, 1\n`;
            }
            macroBody += `\tmov     TEMP_REG1, ${dataRegLo}
\tlsr     ${dataRegLo}, ${dataRegLo}, 31
\tor      TEMP_REG2, TEMP_REG2, ${dataRegLo}
\tlsl     TEMP_REG1, TEMP_REG1, 1
`;
            if (stopBitPol === "1") macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
            macroBody += `
\t; ========== Load Initial 4 Bytes to FIFO (MSB First) ==========
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
\tqblt    wait_fifo_for_byte5?, ${dataRegLo}, 2
\tmov     r30.b0, TEMP_REG1.b0

`;
        }
    }

    // Wait for FIFO empty then TX complete for 31/32 bit cases
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

    if (pruInstructionMacro === "") {
        macroBody += "\n .endm";
    }
    return macroBody;
}

/**
 * Continuous TX operation (dataBits 33-62).
 * Mirrors getMacroContinuous from uart_tx.syscfg.js but without config writes.
 */
function getMacroContinuous(pruInstructionMacro, opCode) {
    let macroBody = "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName  = parts[0] || opCode;
    const dataRegLo  = parts[1] || "dataRegLo";
    const dataRegHi  = parts[2] || "dataRegHi";
    const channel    = parts[3] || "channel";
    const dataBits   = parts[4] || "dataBits";

    const isLSB     = macroName.includes("_lsb_");
    const startBit1 = macroName.includes("_start1");

    const hasExplicitStop0 = macroName.includes("_stop0");
    const hasExplicitStop1 = macroName.includes("_stop1");
    const stopBitPol  = hasExplicitStop0 ? "0" : (hasExplicitStop1 ? "1" : (startBit1 ? "0" : "1"));
    const startBitPol = startBit1 ? "1" : "0";

    const numBytesMatch  = macroName.match(/_(\d)byte_/);
    const numFifoBytes   = numBytesMatch ? parseInt(numBytesMatch[1]) : 5;
    const continuousBytes = numFifoBytes - 4;

    if (pruInstructionMacro === "") {
        macroBody = macroName + "\t" + ".macro  " + dataRegLo + ", " + dataRegHi + ", " + channel + ", " + dataBits + "\n";
        macroBody += `\t; Parameters:
\t;   dataRegLo       - Register containing lower 32 bits of data
\t;   dataRegHi       - Register containing upper bits of data (next consecutive register)
\t;   channel         - ENDAT channel (0, 1, or 2) - must match uart_tx_config channel
\t;   dataBits        - Number of data bits to transmit (33-62)
\t; Configuration: ${isLSB ? "LSB" : "MSB"} first, start bit=${startBitPol}, stop bit=${stopBitPol}
\t; Mode: Continuous, total bytes = ${numFifoBytes} (initial 4 + continuous ${continuousBytes})
\t; NOTE: uart_tx_config block must be called before this block to set up the peripheral
`;
    }

    macroBody += `
\t; ========== Per-command Reinit (reinit BEFORE de-asserting rx_en — TRM order) ==========
\tset     r31, r31, 19                       ; 1. Global Reinit FIRST
\t.if ${channel} == 0
wait_reinit?:
\tqbbs    wait_reinit?, r31, 5               ; 2. Wait — CH0 busy bit
\t.elseif ${channel} == 1
wait_reinit?:
\tqbbs    wait_reinit?, r31, 13              ; 2. Wait — CH1 busy bit
\t.else
wait_reinit?:
\tqbbs    wait_reinit?, r31, 21              ; 2. Wait — CH2 busy bit
\t.endif
\tldi     r30.b3, 0x00                       ; 3. De-assert rx_en AFTER reinit

\t; ========== Select Channel + clk_mode=1 ==========
\t.if ${channel} == 0
\tldi     r30.w2, 0x0008                    ; clk_mode=1 (bits[20:19]=0b01), ch=0
\t.elseif ${channel} == 1
\tldi     r30.w2, 0x0009                    ; clk_mode=1, ch=1
\t.else
\tldi     r30.w2, 0x000A                    ; clk_mode=1, ch=2
\t.endif

`;

    if (isLSB) {
        macroBody += `
\t; ========== Construct Frame (LSB First, Continuous >32-bit) ==========
\tmov     TEMP_REG1, ${dataRegLo}
\tmov     TEMP_REG2, ${dataRegHi}
\tlsr     ${dataRegLo}, TEMP_REG1, 31
\tlsl     TEMP_REG1, TEMP_REG1, 1
\tlsl     TEMP_REG2, TEMP_REG2, 1
\tor      TEMP_REG2, TEMP_REG2, ${dataRegLo}

`;
        if (startBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, 0\n`;
        }
        if (stopBitPol === "1") {
            macroBody += `\t.if (${dataBits} + 1) < 32
\tset     TEMP_REG1, TEMP_REG1, (${dataBits} + 1)
\t.else
\tset     TEMP_REG2, TEMP_REG2, (${dataBits} + 1 - 32)
\t.endif
`;
        } else {
            macroBody += `\t.if (${dataBits} + 1) < 32
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
        const byteNamesLSB = ["TEMP_REG2.b0", "TEMP_REG2.b1", "TEMP_REG2.b2", "TEMP_REG2.b3"];
        for (let i = 0; i < continuousBytes; i++) {
            const byteNum = 5 + i;
            macroBody += `\t; ========== Load Byte ${byteNum} via Continuous Polling ==========
wait_fifo_for_byte${byteNum}?:
\tmov     ${dataRegLo}, r31
\tlsr     ${dataRegLo}, ${dataRegLo}, 2
\tand     ${dataRegLo}, ${dataRegLo}, 0x7
\tqblt    wait_fifo_for_byte${byteNum}?, ${dataRegLo}, 2
\tmov     r30.b0, ${byteNamesLSB[i]}

`;
        }
    } else {
        macroBody += `
\t; ========== Construct Frame (MSB First, Continuous >32-bit) ==========
\tldi     TEMP_REG1, 0
\tldi     TEMP_REG2, 0
`;
        if (startBitPol === "1") {
            macroBody += `\tset     TEMP_REG1, TEMP_REG1, 31\n`;
        }
        macroBody += `\tmov     TEMP_REG2, ${dataRegHi}
\tlsl     TEMP_REG2, TEMP_REG2, (63 - ${dataBits})
\tor      TEMP_REG1, TEMP_REG1, TEMP_REG2
\tmov     TEMP_REG2, ${dataRegLo}
\tlsr     TEMP_REG2, TEMP_REG2, (${dataBits} - 31)
\tor      TEMP_REG1, TEMP_REG1, TEMP_REG2
\tmov     TEMP_REG2, ${dataRegLo}
\tlsl     TEMP_REG2, TEMP_REG2, (63 - ${dataBits})
`;
        if (stopBitPol === "1") {
            macroBody += `\tset     TEMP_REG2, TEMP_REG2, (62 - ${dataBits})\n`;
        } else {
            macroBody += `\tclr     TEMP_REG2, TEMP_REG2, (62 - ${dataBits})\n`;
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
        const byteNamesMSB = ["TEMP_REG2.b3", "TEMP_REG2.b2", "TEMP_REG2.b1", "TEMP_REG2.b0"];
        for (let i = 0; i < continuousBytes; i++) {
            const byteNum = 5 + i;
            macroBody += `\t; ========== Load Byte ${byteNum} via Continuous Polling ==========
wait_fifo_for_byte${byteNum}?:
\tmov     TEMP_REG1, r31
\tlsr     TEMP_REG1, TEMP_REG1, 2
\tand     TEMP_REG1, TEMP_REG1, 0x7
\tqblt    wait_fifo_for_byte${byteNum}?, TEMP_REG1, 2
\tmov     r30.b0, ${byteNamesMSB[i]}

`;
        }
    }

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

    if (pruInstructionMacro === "") {
        macroBody += "\n .endm";
    }
    return macroBody;
}

function getMacro(pruInstructionMacro, opCode) {
    // Check for specific bit-size macros (30, 31, 32 bits)
    const bitSizeMatch = opCode.match(/_(\d+)bit_/);
    if (bitSizeMatch) {
        const bitSize = parseInt(bitSizeMatch[1]);
        if (bitSize >= 30 && bitSize <= 32) {
            return getMacroSpecificBits(pruInstructionMacro, opCode, bitSize);
        }
    }

    const numBytesMatch = opCode.match(/_(\d)byte_/);
    const numFifoBytes  = numBytesMatch ? parseInt(numBytesMatch[1]) : 2;

    if (numFifoBytes <= 4) {
        return getMacroSingleShot(pruInstructionMacro, opCode);
    } else {
        return getMacroContinuous(pruInstructionMacro, opCode);
    }
}

/**
 * Helper to get the uart_config instance.
 * Only call this from getValue functions, NOT from validate or ports.
 */
function getConfigInst() {
    const cfgModule = system.modules["/pru_blocks/pru_io_blocks/uart_config"];
    if (cfgModule && cfgModule.$instances && cfgModule.$instances.length > 0) {
        return cfgModule.$instances[0];
    }
    return null;
}

function validate(inst, report) {
    const cfgModule = system.modules["/pru_blocks/pru_io_blocks/uart_config"];
    if (!cfgModule || !cfgModule.$instances || cfgModule.$instances.length === 0) {
        report.logError(
            "A UART Config block is required before using UART TX Op. " +
            "Add a UART Config block with TX Config enabled and connect it earlier in the control flow.",
            inst
        );
        return;
    }
    const cfg = cfgModule.$instances[0];
    if (!cfg.enableTX) {
        report.logError(
            "The UART Config block does not have TX Config enabled. " +
            "Enable TX Config in the UART Config block.",
            inst
        );
    }

    for (let i = 1; i <= inst["numOfInputPorts"]; i++) {
        if (inst["input" + i.toString()].length === 0) {
            report.logWarning("input" + i.toString() + " port not connected to output port", inst);
        }
    }

    // Enforce all uart_tx_op instances use the same dataBits value
    const txOpModule = system.modules["/pru_blocks/pru_io_blocks/uart_tx_op"];
    if (txOpModule && txOpModule.$instances && txOpModule.$instances.length > 1) {
        const firstDataBits = txOpModule.$instances[0].dataBits;
        const mismatch = txOpModule.$instances.some(i => i.dataBits !== firstDataBits);
        if (mismatch) {
            report.logError(
                `All UART TX Op blocks must have the same Data Bits value. ` +
                `uart_config uses the first instance's value (${firstDataBits}b) for TX configuration — ` +
                `mismatched instances will generate incorrect assembly.`,
                inst, "dataBits"
            );
        }
    }
}

function getLongDescription() {
    return `
## UART TX Op (Per-Transmission Operation)

### Purpose
Transmits one UART frame using the ENDAT peripheral. This block handles only the
per-transmission work: frame construction, FIFO loading, start trigger, and wait for
TX complete. **The \`UART Config\` block (with TX Config enabled) must appear earlier in
the control flow** to set up the peripheral registers before this block is called.

### Generated Sequence
1. Per-command reinit (R31 bit 19) — clears FIFO and state machines (TRM-mandated order: reinit before de-asserting rx_en)
2. Poll reinit busy bit (R31[5/13/21] for CH0/CH1/CH2)
3. De-assert rx_en (R30.b3 = 0x00)
4. Channel select + clk_mode write to R30.w2
5. Frame construction — insert start bit, shift data bits, insert stop bit (LSB or MSB order)
6. FIFO load — 1–4 bytes for single-shot (dataBits ≤ 29); 4 bytes + continuous polling for dataBits 30–32; 4 bytes + byte 5 polling for dataBits 33–62
7. Start transmission (R31 bit 18 = tx_channel_go)
8. Wait for TX complete (poll R31[5/13/21] busy bit)

### No Peripheral Register Writes
No GPCFG, TXCFG, or CH_CFG0 writes — those are handled once by \`UART Config\`.
This means the op block is suitable for repeated calls in a loop with minimal overhead.

### Input Port
The input register size depends on the configured Data Bits:

| Data Bits | Input Port Type | Register(s) |
|-----------|-----------------|-------------|
| 1–32 bits | **32-bit** (input32) | 1 register (Rx) |
| 33–62 bits | **64-bit** (input64) | 2 consecutive registers (Rx:Rx+1) |

- **input1** (32-bit mode): data word to transmit in a single register
- **input1** (64-bit mode): data in two consecutive registers — lower 32 bits in the allocated register, upper bits in the next register

### Configuration
All TX parameters (channel, baud rate, bit order, start/stop polarity) are automatically
read from the paired \`UART Config\` block. Only \`Data Bits\` is set on this block directly,
since it determines the input port type (32-bit vs 64-bit) which the register allocator
needs to know at design time.

### Data Bits
- Number of payload bits to transmit (excluding start and stop bits)
- Range: 1–62
- dataBits ≤ 29: single-shot mode, 1–4 FIFO bytes
- dataBits 30–32: specific-bit mode, 4–5 FIFO bytes
- dataBits 33–62: continuous mode, 5+ FIFO bytes with polling

### Calculation Example
- UART Config: 192 MHz clock, 12 MHz baud, LSB first, start=1, stop=0
- Data Bits: 16 → frame = start(1) + 16 data bits + stop(0) = 18 bits → 3 FIFO bytes
- Frame size written to CH_CFG0 by config block: 18 (dataBits + 2)

### Terminology
- **Per-command Reinit**: Reinit triggered before every TX to clear FIFO and reset state machines
- **FIFO**: 32-bit TX FIFO in the ENDAT peripheral — data bytes pushed via R30[7:0]
- **tx_channel_go**: R31 bit 18 — triggers transmission of the loaded FIFO content
- **Busy bit**: R31[5/13/21] — 1 = last bit still on wire, 0 = TX complete
- **Single-shot**: TX_FRAME_SIZE set in CH_CFG0 — hardware stops after exactly that many bits
- **Continuous mode**: TX_FRAME_SIZE = 0 — hardware transmits until FIFO is empty

---
`;
}

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the UART TX Op block in a .syscfg file.

**CRITICAL**: The UART TX Op block requires a paired \`UART Config\` block with TX enabled.
The op block reads all TX parameters (channel, baud rate, bit order, start/stop polarity)
from the config block automatically. Only \`Data Bits\` is set on the op block itself.

### Step 1 — Add and configure a UART Config block (TX enabled)

\`\`\`javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();
uart_config1.$name     = "PRU_UART_CONFIG_0";
uart_config1.enableTX  = true;
uart_config1.enableRX  = false;        // TX-only or TX+RX — set as needed
uart_config1.txChannel         = 0;    // Channel 0 (GPO0=CLK, GPO1=DOUT, GPO2=OE)
uart_config1.txClockSource     = 0;    // 192 MHz (UART_CLK)
uart_config1.txBaudRate        = 12;   // 12 MHz
uart_config1.txStartBitPolarity = 1;   // Start bit = 1 (high)
uart_config1.txStopBitPolarity  = 0;   // Stop bit = 0 (low)
uart_config1.txBitSwap         = true; // LSB first (standard UART)
\`\`\`

### Step 2 — Add and configure the UART TX Op block

\`\`\`javascript
const uart_tx_op = scripting.addModule("/pru_blocks/pru_io_blocks/uart_tx_op", {}, false);
const uart_tx_op1 = uart_tx_op.addInstance();
uart_tx_op1.$name      = "PRU_UART_TX_OP_0";
uart_tx_op1.dataBits   = 16;            // 16 data payload bits
uart_tx_op1.uartConfig = uart_config1;  // Link to config block
\`\`\`

### Step 3 — Connect control flow and data

\`\`\`javascript
// Control flow: config must run before op
scripting.connect(uart_config1, "next", uart_tx_op1, "prev");

// Data: connect upstream data source to op input
scripting.connect(data_source_block, "output1", uart_tx_op1, "input1");

// Control flow out of op
scripting.connect(uart_tx_op1, "next", next_block, "prev");
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| dataBits | Integer | 1–62 | 8 | Number of data payload bits. Determines input port type (32-bit vs 64-bit) |

All other TX parameters (channel, baud rate, bit order, start/stop polarity) are
read from the paired \`UART Config\` block — do not duplicate them here.

### Input Port Type by Data Bits

| dataBits | Input Port | Notes |
|----------|------------|-------|
| 1–32 | 32-bit (input32) | Single register input |
| 33–62 | 64-bit (input64) | Two consecutive registers; upstream block must produce 64-bit output |

### Common Data Bit Configurations

| Protocol | Data Bits | Frame Bits (dataBits+2) | Mode |
|----------|-----------|------------------------|------|
| Standard UART 8-bit | 8 | 10 | Single-shot |
| 16-bit payload | 16 | 18 | Single-shot |
| 24-bit payload | 24 | 26 | Single-shot |
| 29-bit payload | 29 | 31 | Single-shot (max single-shot) |
| 30-bit payload | 30 | 32 | Specific-bit mode |
| 32-bit payload | 32 | 34 | Specific-bit mode |
| 33-bit payload | 33 | 35 | Continuous mode |

### Important Notes

1. **UART Config must appear before UART TX Op** in the control flow (connect config "next" to op "prev").

2. **dataBits > 32 activates continuous mode** — input port becomes 64-bit. The upstream data source block must produce a 64-bit output.

3. **No peripheral register writes in this block** — only per-command reinit, frame construction, FIFO load, and TX trigger. All register setup is in \`UART Config\`.

4. **uartConfig linkage is mandatory** — always set \`uart_tx_op1.uartConfig = uart_config1\` or the block will error during validation.

5. **All UART TX Op instances must use the same dataBits value** — \`UART Config\` uses the first instance's dataBits for TX_FRAME_SIZE configuration. Mismatched instances will generate incorrect assembly.
`;
}

exports = {
    displayName: "PRU UART TX Op",
    defaultInstanceName: "PRU_UART_TX_OP_",
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
        // ========== Read-only display fields from config block ==========
        {
            name: "configInfo",
            displayName: "Config Block Settings",
            description: "Parameters read from the UART TX Config block",
            default: "No config block found",
            readOnly: true,
            getValue: (inst) => {
                const cfg = getConfigInst();
                if (!cfg) return "No UART Config block found";
                if (!cfg.enableTX) return "UART Config block has TX disabled";
                return `Ch${cfg.txChannel}, ${inst.dataBits}b, ${cfg.txBitSwap ? "LSB" : "MSB"}, start=${cfg.txStartBitPolarity}, stop=${cfg.txStopBitPolarity}, ${cfg.txBaudRate}MHz`;
            }
        },
        // ========== User configurables needed by ports() — cannot use system.modules here ==========
        // dataBits and channel must match the UART TX Config block settings
        {
            name: "dataBits",
            displayName: "Data Bits",
            description: "Must match the UART TX Config block. Determines number of input ports.",
            default: 8,
            range: [1, 62]
        },
        // ========== Hidden fields used by code generator ==========
        {
            name: "constant1",
            hidden: true,
            default: "0, 8",
            getValue: (inst) => {
                const cfg = getConfigInst();
                const channel  = cfg ? cfg.txChannel : 0;
                const dataBits = inst.dataBits;
                if (dataBits >= 30 && dataBits <= 32) {
                    return `${channel}`;
                }
                return `${channel}, ${dataBits}`;
            }
        },
        {
            name: "opCode",
            displayName: "m_uart_tx_op",
            default: "m_uart_tx_op",
            hidden: true,
            getValue: (inst) => {
                const cfg = getConfigInst();
                const pruNum   = cfg ? cfg.pruSelect              : 0;
                const bitOrder = cfg ? (cfg.txBitSwap ? "lsb" : "msb") : "lsb";
                const startBit = cfg ? cfg.txStartBitPolarity     : 1;
                const stopBit  = cfg ? cfg.txStopBitPolarity      : 0;
                const dataBits = inst.dataBits;
                const needsStopSuffix = (startBit === stopBit);
                const stopSuffix = needsStopSuffix ? `_stop${stopBit}` : "";

                if (dataBits >= 30 && dataBits <= 32) {
                    return `m_uart_tx_op_${dataBits}bit_pru${pruNum}_${bitOrder}_start${startBit}${stopSuffix}`;
                } else {
                    const frameSize    = dataBits + 2;
                    const numFifoBytes = Math.floor((frameSize + 7) / 8);
                    return `m_uart_tx_op_${numFifoBytes}byte_pru${pruNum}_${bitOrder}_start${startBit}${stopSuffix}`;
                }
            }
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
            getValue: (inst) => 1
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
            name: "input1Size",
            hidden: true,
            default: 4,
            getValue: (inst) => {
                if (inst.dataBits > 32)  return 8;
                if (inst.dataBits <= 8)  return 1;
                if (inst.dataBits <= 16) return 2;
                return 4;
            }
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (inst) => {
                const frameSize    = inst.dataBits + 2;
                const numFifoBytes = Math.floor((frameSize + 7) / 8);
                if (numFifoBytes <= 4) {
                    return 6 + numFifoBytes;
                } else {
                    const continuousBytes = numFifoBytes - 4;
                    return 6 + 4 + (continuousBytes * 6) + 5;
                }
            },
            default: 9
        },
    ],
    ports: (inst) => {
        const dataBits = inst.dataBits;
        const inputType = dataBits > 32 ? "input64" : "input32";
        const portName = inputType === "input64" ? "in64" : "input1";
        return [
            { name: "input1", type: inputType, displayName: portName },
            { name: "prev",   type: "PREV" },
            { name: "next",   type: "NEXT" },
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
