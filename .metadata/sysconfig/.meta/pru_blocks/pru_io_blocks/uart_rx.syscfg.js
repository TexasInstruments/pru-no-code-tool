/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            return parseInt(match[1]);
        }
    }
    return 0;
}

function validate(inst, report) {
    // Get oversample multiplier from encoding (0=1x, 1=2x, 3=4x, 7=8x)
    let oversampleMultiplier;
    if (inst.oversampleSize === 0) {
        oversampleMultiplier = 1;
    } else if (inst.oversampleSize === 1) {
        oversampleMultiplier = 2;
    } else if (inst.oversampleSize === 3) {
        oversampleMultiplier = 4;
    } else {
        oversampleMultiplier = 8;
    }

    // Get clock frequency based on clock source selection
    // 0 = 192 MHz (ICSSGn_UART_CLK), 1 = 200 MHz (ICSSGn_CORE_CLK)
    const uartClkMHz = inst.clockSource === 0 ? 192 : 200;
    const baudRateTimesOversample = inst.baudRate * oversampleMultiplier;

    // Check divisibility: clock % (baudRate * oversample) should be 0
    if (uartClkMHz % baudRateTimesOversample !== 0) {
        report.logError(`Clock (${uartClkMHz} MHz) is not divisible by (baudRate * oversample) = ${inst.baudRate} * ${oversampleMultiplier} = ${baudRateTimesOversample}. Choose a baud rate where ${uartClkMHz} is divisible by (baudRate * oversample).`, inst, "baudRate");
    } else {
        // Check clock divider range
        const clockDivider = (uartClkMHz / baudRateTimesOversample) - 1;
        if (clockDivider < 0 || clockDivider > 65535) {
            report.logError(`Calculated clock divider (${clockDivider}) is out of range (0-65535). Adjust baud rate.`, inst, "baudRate");
        }
    }

    // Validate frame size - currently limited to 32 bits (30 data bits + start + stop)
    // Extended mode (>32 bits) requires multi-register handling that is not yet implemented
    if (inst.frameSize < 3 || inst.frameSize > 32) {
        report.logError("Frame size must be between 3 and 32 bits (1-30 data bits + start + stop). Extended mode (>32 bits) is not currently supported.", inst, "frameSize");
    }
}

/**
 * Returns guarded .set/.asg definitions for ICSS_CFG register symbols.
 * Emitted once at the top of the generated macro so the assembler has the
 * symbols available even when icss_cfg_regs.inc / icss_regs.inc are not
 * explicitly included by the user.
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
 * Returns the body of the UART RX configuration macro
 * @param {string} pruInstructionMacro - The macro instruction string
 * @param {string} opCode - The operation code (macro name)
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacro(pruInstructionMacro, opCode) {
    // When generating the macro definition (not an inline call), prepend the
    // guarded ICSS_CFG register definitions so they are available to the assembler.
    const prefix = (pruInstructionMacro === "") ? getIcssCfgDefinitions() : "";

    let macroBody = "";

    // Check if this is extended mode (>32 data bits, needs two output registers)
    const isExtended = opCode.includes("_ext");

    // Extract parameters from the pruInstructionMacro
    // Parameter order follows system convention: <output register(s)>, <constants>
    // Extended mode (8 bytes): "R0, R1, channel, ..." - two output registers
    // Standard mode (4 bytes): "R0, channel, ..." - one output register
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;

    // Determine if this is extended mode based on macro name
    let dataByteRegLo, dataByteRegHi, channel, clockDiv, rxClkSel, oversample, startBitPol, frameSize, bitSwap;

    if (isExtended) {
        // Extended mode: two output registers (8 bytes = "R0, R1")
        dataByteRegLo = parts[1] || "dataByteRegLo";   // Output register for lower 32 bits
        dataByteRegHi = parts[2] || "dataByteRegHi";   // Output register for upper 32 bits
        channel = parts[3] || "channel";
        clockDiv = parts[4] || "clockDiv";
        rxClkSel = parts[5] || "rxClkSel";             // RX clock source: 0=192MHz, 1=200MHz
        oversample = parts[6] || "oversample";
        startBitPol = parts[7] || "startBitPol";
        frameSize = parts[8] || "frameSize";
        bitSwap = parts[9] || "bitSwap";
    } else {
        // Standard mode: one output register (4 bytes = "R0")
        dataByteRegLo = parts[1] || "dataByteRegLo";   // Output register for data (up to 32 bits)
        dataByteRegHi = "0";                            // Not used in standard mode, set to 0
        channel = parts[2] || "channel";
        clockDiv = parts[3] || "clockDiv";
        rxClkSel = parts[4] || "rxClkSel";             // RX clock source: 0=192MHz, 1=200MHz
        oversample = parts[5] || "oversample";
        startBitPol = parts[6] || "startBitPol";
        frameSize = parts[7] || "frameSize";
        bitSwap = parts[8] || "bitSwap";
    }

    // Internal registers using TEMP_REG1/TEMP_REG2 for temp operations
    // For standard mode: TEMP_REG1 = bit accumulation, TEMP_REG2.b0 = counter, TEMP_REG2.b1 = temp sample
    //                    Output: dataByteRegLo = extracted data, dataByteRegHi = 0
    // For extended mode: output registers (dataByteRegLo/dataByteRegHi) used for 64-bit accumulation
    //                    TEMP_REG1.b0 = counter, TEMP_REG1.b1 = temp sample, TEMP_REG2 = temp calcs
    const bitAccumReg = "TEMP_REG1";  // For standard mode accumulation
    const bitCounterReg = isExtended ? "TEMP_REG1.b0" : "TEMP_REG2.b0";
    const tempSampleReg = isExtended ? "TEMP_REG1.b1" : "TEMP_REG2.b1";

    if (pruInstructionMacro == "") {
        if (isExtended) {
            // Extended mode: two output registers in macro signature
            macroBody = macroName + "	" + ".macro  " + dataByteRegLo + ", " + dataByteRegHi + ", " + channel + ", " + clockDiv + ", " +
                        rxClkSel + ", " + oversample + ", " + startBitPol + ", " + frameSize + ", " + bitSwap + "\n";
            macroBody += `	; Parameters (Extended Mode - >=31 data bits):
	;   dataByteRegLo   - Output register for lower 32 bits of extracted data (dynamically allocated)
	;   dataByteRegHi   - Output register for upper bits of extracted data (dynamically allocated)
	;   channel         - ENDAT channel (0, 1, or 2)
	;   clockDiv        - RX clock divider (1-65535): RX_freq = core_clk / (clockDiv + 1)
	;   rxClkSel        - RX clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK)
	;   oversample      - Oversample size encoding (0=1x, 1=2x, 3=4x, 7=8x) - bits[2:0] value
	;   startBitPol     - Start bit polarity (0=falling, 1=rising edge)
	;   frameSize       - Frame size in bits (33-64 for extended mode)
	;   bitSwap         - Bit swap/LSB first (0=disabled, 1=enabled)
	; Internal registers (TEMP_REG1/TEMP_REG2 are used for counters and temp calculations)
`;
        } else {
            // Standard mode: one output register in macro signature
            macroBody = macroName + "	" + ".macro  " + dataByteRegLo + ", " + channel + ", " + clockDiv + ", " +
                        rxClkSel + ", " + oversample + ", " + startBitPol + ", " + frameSize + ", " + bitSwap + "\n";
            macroBody += `	; Parameters (Standard Mode - <=30 data bits):
	;   dataByteRegLo   - Output register for extracted data (dynamically allocated)
	;   channel         - ENDAT channel (0, 1, or 2)
	;   clockDiv        - RX clock divider (1-65535): RX_freq = core_clk / (clockDiv + 1)
	;   rxClkSel        - RX clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK)
	;   oversample      - Oversample size encoding (0=1x, 1=2x, 3=4x, 7=8x) - bits[2:0] value
	;   startBitPol     - Start bit polarity (0=falling, 1=rising edge)
	;   frameSize       - Frame size in bits (3-32 for standard mode, typical 10 for UART)
	;   bitSwap         - Bit swap/LSB first (0=disabled, 1=enabled)
	; Internal registers (TEMP_REG1/TEMP_REG2 are used for bit accumulation and counters)
`;
        }
    }

    // Check if this is one of our UART RX config macros
    // macroName format: m_uart_rx_config_pru0_lsb_8x or m_uart_rx_config_pru1_msb_4x
    const isPRU0 = macroName.includes("_pru0_");
    const isPRU1 = macroName.includes("_pru1_");
    const isLSB = macroName.includes("_lsb_");
    const isMSB = macroName.includes("_msb_");

    // Determine PRU-specific register names
    const pruNum = isPRU0 ? "0" : "1";
    const gpcfgReg = isPRU0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const rxcfgReg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_RXCFG" : "ICSS_CFG_PRU1_ENDAT_RXCFG";
    const ch0cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const ch1cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const ch2cfg0Reg = isPRU0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";

    if (isLSB || isMSB) {
        macroBody += `
    ; ========== Global Reinit THEN de-assert rx_en (TRM Table 6-424 sequence) ==========
	; TRM note: "assert tx_global_reinit then de-assert rx_en"
	set     r31, r31, 19                       ; 1. Trigger reinit first
    ; ========== Delay after Reinit ==========
    .loop   20
    nop
    .endloop
	ldi     r30.b3, 0x00                       ; 2. De-assert rx_en after reinit has settled

	; ========== Configure GPCFG${pruNum} for PRU${pruNum} Peripheral Mode ==========
	; Set mux mode to peripheral mode for PRU${pruNum}
	ldi32   TEMP_REG1, 0x04000000
	ldi     TEMP_REG2.w0, ${gpcfgReg}
	sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

	; ========== Configure RX Clock and Oversample ==========
	; Build RXCFG register value:
	; [31:16] = clockDiv (RX_DIV_FACTOR)
	; [4] = RX_CLK_SEL (0=192MHz, 1=200MHz)
	; [3] = startBitPol (RX_SB_POL)
	; [2:0] = oversample encoding (RX_OVERSAMPLE_SIZE)
	ldi     TEMP_REG1.w0, (${rxClkSel} << 4) | ${oversample}  ; Clock select bit[4] + Oversample bits[2:0]
`;
        // Only add startBitPol check if it's not 0
        if (startBitPol !== "0") {
            macroBody += `	set     TEMP_REG1.w0, TEMP_REG1.w0, 3      ; Set bit 3 (startBitPol=1)\n`;
        }
        macroBody += `	ldi     TEMP_REG1.w2, ${clockDiv}          ; Clock divider bits[31:16]
	ldi     TEMP_REG2.w0, ${rxcfgReg}
	sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

	; ========== Configure Channel CFG0 Register ==========
	; Build CHx_CFG0 register value:
	; [31] = bitSwap (LSB first if set)
	; [27:16] = frameSize (number of bits to receive)
	ldi     TEMP_REG1.w0, 0                    ; Clear lower word
	ldi     TEMP_REG1.w2, ${frameSize}         ; Frame size in bits[27:16] (upper word)
`;
        // Only set bit 31 for LSB macros
        if (isLSB) {
            macroBody += `	set     TEMP_REG1, TEMP_REG1, 31           ; Set bit 31 (bitSwap=1, LSB first)\n`;
        }
        // For MSB macros, bit 31 stays 0 (MSB first)

        // Select CHx_CFG0 offset based on channel (at macro generation time)
        let ch_cfg_offset = "";
        if (channel === "0") {
            ch_cfg_offset = ch0cfg0Reg;
        } else if (channel === "1") {
            ch_cfg_offset = ch1cfg0Reg;
        } else {
            ch_cfg_offset = ch2cfg0Reg;
        }

        macroBody += `	ldi     TEMP_REG2.w0, ${ch_cfg_offset}
	sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

	; ========== Enable RX for Selected Channel ==========
`;
        // Select RX enable bit based on channel (at macro generation time)
        let rx_enable_bit = "";
        if (channel === "0") {
            rx_enable_bit = "24";
        } else if (channel === "1") {
            rx_enable_bit = "25";
        } else {
            rx_enable_bit = "26";
        }

        // Determine rx_data register byte index
        let rx_data_byte = "";
        if (channel === "0") {
            rx_data_byte = "0";
        } else if (channel === "1") {
            rx_data_byte = "1";
        } else {
            rx_data_byte = "2";
        }

        // Determine middle bit based on macro name
        let middle_bit;
        if (macroName.includes("_1x")) {
            middle_bit = 0;
        } else if (macroName.includes("_2x")) {
            middle_bit = 0;
        } else if (macroName.includes("_4x")) {
            middle_bit = 2;
        } else {
            middle_bit = 4;
        }

        // Calculate R30.b3 value with RX enable bit set (avoid read-modify-write on full R30)
        // Bit 24 = CH0 (0x01), Bit 25 = CH1 (0x02), Bit 26 = CH2 (0x04) in byte 3
        let r30_b3_value;
        if (channel === "0") {
            r30_b3_value = "0x01";  // Bit 24
        } else if (channel === "1") {
            r30_b3_value = "0x02";  // Bit 25
        } else {
            r30_b3_value = "0x04";  // Bit 26
        }
        macroBody += `	ldi     r30.b3, ${r30_b3_value}

`;

        // ========== Bit Accumulation Logic ==========
        if (isExtended) {
            // Extended mode: use two output registers for 64-bit accumulation
            macroBody += `	ldi     ${dataByteRegLo}, 0
	ldi     ${dataByteRegHi}, 0
	ldi     ${bitCounterReg}, 0

rx_bit_loop?:
	qbbc    rx_bit_loop?, r31, ${rx_enable_bit}
	mov     ${tempSampleReg}, r31.b${rx_data_byte}
	set     r31, r31, ${rx_enable_bit}

	qbbs    set_bit?, ${tempSampleReg}, ${middle_bit}
`;
            // Bit accumulation for extended mode based on LSB vs MSB
            if (isLSB) {
                // LSB first: bits shift right through Hi then Lo, new bit enters at Hi bit 31
                macroBody += `	; Shift right through both registers (bit 0 of Hi goes to bit 31 of Lo)
	lsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qbbc    no_carry?, ${dataByteRegHi}, 0
	set     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_carry?:
	lsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
	qba     next_bit?
set_bit?:
	; Shift right and set incoming bit at Hi bit 31
	lsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qbbc    no_carry_set?, ${dataByteRegHi}, 0
	set     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_carry_set?:
	lsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
	set     ${dataByteRegHi}, ${dataByteRegHi}, 31
`;
            } else {
                // MSB first: bits shift left through Lo then Hi, new bit enters at Lo bit 0
                macroBody += `	; Shift left through both registers (bit 31 of Lo goes to bit 0 of Hi)
	lsl     ${dataByteRegHi}, ${dataByteRegHi}, 1
	qbbc    no_carry?, ${dataByteRegLo}, 31
	set     ${dataByteRegHi}, ${dataByteRegHi}, 0
no_carry?:
	lsl     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qba     next_bit?
set_bit?:
	; Shift left and set incoming bit at Lo bit 0
	lsl     ${dataByteRegHi}, ${dataByteRegHi}, 1
	qbbc    no_carry_set?, ${dataByteRegLo}, 31
	set     ${dataByteRegHi}, ${dataByteRegHi}, 0
no_carry_set?:
	lsl     ${dataByteRegLo}, ${dataByteRegLo}, 1
	set     ${dataByteRegLo}, ${dataByteRegLo}, 0
`;
            }
            macroBody += `next_bit?:
	add     ${bitCounterReg}, ${bitCounterReg}, 1
	qbgt    rx_bit_loop?, ${bitCounterReg}, frameSize

`;
        } else {
            // Standard mode: use single TEMP_REG1 for 32-bit accumulation
            macroBody += `	ldi     ${bitAccumReg}, 0
	ldi     ${bitCounterReg}, 0

rx_bit_loop?:
	qbbc    rx_bit_loop?, r31, ${rx_enable_bit}
	mov     ${tempSampleReg}, r31.b${rx_data_byte}
	set     r31, r31, ${rx_enable_bit}

	qbbs    set_bit?, ${tempSampleReg}, ${middle_bit}
`;
            // Bit accumulation for standard mode based on LSB vs MSB
            if (isLSB) {
                macroBody += `	lsr     ${bitAccumReg}, ${bitAccumReg}, 1
	qba     next_bit?
set_bit?:
	lsr     ${bitAccumReg}, ${bitAccumReg}, 1
	set     ${bitAccumReg}, ${bitAccumReg}, 31
`;
            } else {
                macroBody += `	lsl     ${bitAccumReg}, ${bitAccumReg}, 1
	qba     next_bit?
set_bit?:
	lsl     ${bitAccumReg}, ${bitAccumReg}, 1
	set     ${bitAccumReg}, ${bitAccumReg}, 0
`;
            }
            macroBody += `next_bit?:
	add     ${bitCounterReg}, ${bitCounterReg}, 1
	qbgt    rx_bit_loop?, ${bitCounterReg}, frameSize

`;
        }

        // ========== Extraction Logic ==========
        // Data bits = frameSize - 2 (remove start and stop bits)
        if (isExtended) {
            // Extended mode extraction: data spans two registers (64-bit)
            if (isLSB) {
                // LSB first extended: bits accumulated at high end of Hi:Lo pair
                // After receiving frameSize bits, they are in bits [63 : 64-frameSize]
                // We need to shift right by (64 - frameSize) to align, then remove start bit
                macroBody += `	; Extract data (extended LSB): shift to align, remove start bit
	; Shift right by (64 - frameSize) across both registers
	ldi     TEMP_REG2.w0, 64
	sub     TEMP_REG2.w0, TEMP_REG2.w0, ${frameSize}
	; Shift Hi:Lo right by TEMP_REG2.w0 bits
shift_loop?:
	qbeq    shift_done?, TEMP_REG2.w0, 0
	; Shift right by 1: carry bit 0 of Hi to bit 31 of Lo
	lsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qbbc    no_shift_carry?, ${dataByteRegHi}, 0
	set     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_shift_carry?:
	lsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
	sub     TEMP_REG2.w0, TEMP_REG2.w0, 1
	qba     shift_loop?
shift_done?:
	; Now shift right by 1 more to remove start bit
	lsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qbbc    no_start_carry?, ${dataByteRegHi}, 0
	set     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_start_carry?:
	lsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
	; Data bits are now aligned at Lo bit 0, spanning Lo and Hi
	; Mask to keep only data bits
	; For frameSize 33: dataBits=31, stop bit may be carried to Lo bit 31, clear it
	; For frameSize 34: dataBits=32, all data in Lo after shift, just clear Hi
	; For frameSize 35+: dataBits=33+, upper bits in Hi = frameSize - 34
	.if ${frameSize} == 33
	clr     ${dataByteRegLo}, ${dataByteRegLo}, 31         ; Clear any garbage carried to Lo bit 31
	ldi     ${dataByteRegHi}, 0                            ; Clear Hi (no upper data bits)
	.elseif ${frameSize} == 34
	ldi     ${dataByteRegHi}, 0                            ; Clear Hi (no upper data bits)
	.else
	ldi     TEMP_REG2, 1
	lsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 34)
	sub     TEMP_REG2, TEMP_REG2, 1
	and     ${dataByteRegHi}, ${dataByteRegHi}, TEMP_REG2
	.endif
`;
            } else {
                // MSB first extended: bits accumulated at low end of Hi:Lo pair
                // Frame layout: Hi contains upper bits (including start), Lo contains lower 32 bits
                // [frameSize-1]=start (in Hi), data spans Hi:Lo, [0]=stop (in Lo)
                macroBody += `	; Extract data (extended MSB): remove stop bit, mask data bits
	; Shift right by 1 across both registers to remove stop bit
	lsr     ${dataByteRegLo}, ${dataByteRegLo}, 1
	qbbc    no_stop_carry?, ${dataByteRegHi}, 0
	set     ${dataByteRegLo}, ${dataByteRegLo}, 31
no_stop_carry?:
	lsr     ${dataByteRegHi}, ${dataByteRegHi}, 1
	; Mask to keep only data bits (removes start bit)
	; For frameSize 33: dataBits=31, start bit carried to Lo bit 31, clear it
	; For frameSize 34: dataBits=32, all data in Lo after shift, just clear Hi
	; For frameSize 35+: dataBits=33+, upper bits in Hi = frameSize - 34
	.if ${frameSize} == 33
	clr     ${dataByteRegLo}, ${dataByteRegLo}, 31         ; Clear start bit carried to Lo bit 31
	ldi     ${dataByteRegHi}, 0                            ; Clear Hi (no upper data bits)
	.elseif ${frameSize} == 34
	ldi     ${dataByteRegHi}, 0                            ; Clear Hi (no upper data bits)
	.else
	ldi     TEMP_REG2, 1
	lsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 34)
	sub     TEMP_REG2, TEMP_REG2, 1
	and     ${dataByteRegHi}, ${dataByteRegHi}, TEMP_REG2
	.endif
`;
            }
        } else {
            // Standard mode extraction: data in single register (no Hi register)
            if (isLSB) {
                // LSB first: bits accumulated at high end of register, shift right to align
                // After receiving frameSize bits, they are in bits [31 : 32-frameSize]
                // We need to:
                // 1. Shift right by (32 - frameSize) to align to bit 0
                // 2. Shift right by 1 to remove start bit
                // 3. Mask to keep only (frameSize - 2) data bits
                // NOTE: Use TEMP_REG2.w0 for shift amount since TEMP_REG1 holds accumulated bits
                macroBody += `	; Extract data: shift to align, remove start bit, mask data bits
	ldi     TEMP_REG2.w0, 32
	sub     TEMP_REG2.w0, TEMP_REG2.w0, ${frameSize}
	lsr     ${bitAccumReg}, ${bitAccumReg}, TEMP_REG2.w0  ; Align frame to bit 0
	lsr     ${dataByteRegLo}, ${bitAccumReg}, 1              ; Remove start bit (shift right by 1)
	; Mask to (frameSize - 2) data bits: mask = (1 << (frameSize-2)) - 1
	ldi     TEMP_REG2, 1
	lsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 2)
	sub     TEMP_REG2, TEMP_REG2, 1
	and     ${dataByteRegLo}, ${dataByteRegLo}, TEMP_REG2      ; Keep only data bits
`;
            } else {
                // MSB first: bits accumulated at low end of register
                // After receiving frameSize bits, they are in bits [frameSize-1 : 0]
                // Frame layout: [frameSize-1]=start, [frameSize-2:1]=data, [0]=stop
                // We need to:
                // 1. Shift right by 1 to remove stop bit (data now at [frameSize-3:0], start at [frameSize-2])
                // 2. Mask to keep only (frameSize - 2) data bits (removes start bit)
                // NOTE: Use TEMP_REG2 for mask calculation since TEMP_REG1 holds accumulated bits
                macroBody += `	; Extract data: remove stop bit, mask data bits (removes start bit)
	lsr     ${dataByteRegLo}, ${bitAccumReg}, 1              ; Remove stop bit (shift right by 1)
	; Mask to (frameSize - 2) data bits: mask = (1 << (frameSize-2)) - 1
	ldi     TEMP_REG2, 1
	lsl     TEMP_REG2, TEMP_REG2, (${frameSize} - 2)
	sub     TEMP_REG2, TEMP_REG2, 1
	and     ${dataByteRegLo}, ${dataByteRegLo}, TEMP_REG2      ; Keep only data bits
`;
            }
        }

        // Note: Data is now available in dataByteRegLo (and dataByteRegHi for extended mode)
        // The connected block will use these registers for further processing

        macroBody += `
	; ========== Disable RX (TRM step 7) ==========
	; Clear rx_en to disable channel - resets all counters and flags
	ldi     r30.b3, 0x00
`;
    }

    if (pruInstructionMacro == "") {
        macroBody += "\n" + " .endm";
    }

    return prefix + macroBody;
}

function getAIContext() {
    return getLongDescription() + `
    ## How to Configure (For AI/Scripting)
    
    This section describes how to programmatically configure the UART RX block in a .syscfg file.
    
    ### Adding a UART RX Instance
    
    \`\`\`javascript
    const uart_rx = scripting.addModule("/pru_blocks/pru_io_blocks/uart_rx", {}, false);
    const uart_rx1 = uart_rx.addInstance();
    \`\`\`
    
    ### Configuration Parameters
    
    | Parameter | Type | Valid Values | Default | Description |
    |-----------|------|--------------|---------|-------------|
    | pruSelect | Integer | 0, 1 | Auto-detected | PRU Selection (0=PRU0, 1=PRU1) - auto-detected from system context (read-only) |
    | channel | Integer | 0, 1, 2 | 2 | ENDAT channel for UART RX |
    | clockSource | Integer | 0, 1 | 0 | Clock source (0=192MHz UART_CLK, 1=200MHz CORE_CLK) |
    | baudRate | Integer | MHz value | 12 | Baud rate in MHz. Clock source must be divisible by (baudRate × oversample) |
    | oversampleSize | Integer | 0, 1, 3, 7 | 7 | Oversample encoding (0=1x, 1=2x, 3=4x, 7=8x) |
    | startBitPolarity | Integer | 0, 1 | 1 | Start bit edge detection (0=Falling, 1=Rising) |
    | frameSize | Integer | 3-64 | 10 | Total frame bits (dataBits + 2 for start/stop) |
    | bitSwap | Boolean | true, false | true | Enable LSB-first reception (true) or MSB-first (false) |
    
    ### Valid Baud Rates
    **With 192 MHz clock source and 8x oversample (default):**
    192 / (baudRate × 8) must be an integer. Valid baud rates include:
    - 24 MHz (clockDivider = 0)
    - 12 MHz (clockDivider = 1)
    - 8 MHz (clockDivider = 2)
    - 6 MHz (clockDivider = 3)
    - 4 MHz (clockDivider = 5)
    - 3 MHz (clockDivider = 7)
    - 2 MHz (clockDivider = 11)
    - 1 MHz (clockDivider = 23)
    
    **With 200 MHz clock source and 8x oversample:**
    200 / (baudRate × 8) must be an integer. Valid baud rates include:
    - 25 MHz (clockDivider = 0)
    - 5 MHz (clockDivider = 4)
    - 2.5 MHz (clockDivider = 9)
    - 1.25 MHz (clockDivider = 19)
    
    ### Example Configurations
    
    **Standard 8-bit UART at 12 MHz with 8x oversample (192 MHz clock):**
    \`\`\`javascript
    uart_rx1.$name = "UART_RX_0";
    uart_rx1.pruSelect = 1;
    uart_rx1.channel = 2;
    uart_rx1.clockSource = 0;          // 192 MHz (UART_CLK)
    uart_rx1.baudRate = 12;            // 12 MHz baud rate
    uart_rx1.oversampleSize = 7;       // 8x oversample
    uart_rx1.frameSize = 10;           // 8 data bits + start + stop = 10
    uart_rx1.bitSwap = true;           // LSB first (standard UART)
    uart_rx1.startBitPolarity = 0;     // Detect falling edge (standard UART)
    \`\`\`
    
    **8-bit UART at 25 MHz using 200 MHz clock:**
    \`\`\`javascript
    uart_rx1.$name = "UART_RX_200MHz";
    uart_rx1.pruSelect = 1;
    uart_rx1.channel = 2;
    uart_rx1.clockSource = 1;          // 200 MHz (CORE_CLK)
    uart_rx1.baudRate = 25;            // 25 MHz baud rate (200 / (25 × 8) = 1, divider = 0)
    uart_rx1.oversampleSize = 7;       // 8x oversample
    uart_rx1.frameSize = 10;
    uart_rx1.bitSwap = true;
    uart_rx1.startBitPolarity = 0;
    \`\`\`
    
    **Extended 31-bit reception on PRU0, Channel 0:**
    \`\`\`javascript
    uart_rx1.$name = "UART_RX_Extended";
    uart_rx1.pruSelect = 0;
    uart_rx1.channel = 0;
    uart_rx1.clockSource = 0;          // 192 MHz (UART_CLK)
    uart_rx1.baudRate = 12;            // 12 MHz baud rate
    uart_rx1.oversampleSize = 7;       // 8x oversample
    uart_rx1.frameSize = 33;           // 31 data bits + start + stop = 33 (uses extended mode)
    uart_rx1.bitSwap = false;          // MSB first
    uart_rx1.startBitPolarity = 1;     // Detect rising edge
    \`\`\`
    
    ### Connecting to Other Blocks
    
    \`\`\`javascript
    // Connect UART RX output to downstream processing block
    scripting.connect(uart_rx1, "output1", process_block, "input1");
    
    // Connect control flow
    scripting.connect(prev_block, "next", uart_rx1, "prev");
    scripting.connect(uart_rx1, "next", next_block, "prev");
    \`\`\`
    
    ### Important Notes for Extended Mode (frameSize >= 33, i.e., dataBits >= 31)
    
    When receiving 31 or more data bits:
    - The output register is **8 bytes** (two 32-bit registers)
    - Lower 32 bits are in the first output register
    - Upper bits are in the second output register
    - Blocks connected to output1 will automatically receive the full 64-bit value
    `;
}

function getLongDescription() {
    return `
## UART RX (Hardware-Accelerated via ENDAT)

### Purpose
Configures the PRU-ICSS ENDAT peripheral hardware for UART reception at high speed (up to 12 Mbaud) and receives one complete UART frame. This block performs hardware initialization, frame reception, bit extraction, and outputs the processed data byte via a dynamically allocated output register.

### How It Works
1. **Peripheral Mode**: Sets GPCFG to enable peripheral interface mode for the selected PRU
2. **RX Clock Configuration**: Configures clock divider and oversample rate
   - RX frequency = Core_Clock / (divider + 1)
   - Example: 192 MHz / (1+1) = 96 MHz with 8x oversample = 12 MHz baud rate
3. **Start Bit Detection**: Configures start bit polarity (rising/falling edge)
4. **Frame Configuration**: Sets frame size and bit ordering (LSB/MSB first)
5. **Channel Selection**: Configures one of three available channels (CH0, CH1, or CH2)
6. **Global Reinit**: Resets the ENDAT peripheral hardware state before each reception
   - **Important**: Reinit clears all pending/buffered data in the ENDAT peripheral
   - This ensures clean state for each frame but means previously buffered frames are lost
   - Reinit must complete before RX enable (20-cycle wait loop included)
7. **RX Enable**: Enables reception on the selected channel
8. **Frame Reception**: Polls for valid data, reads oversampled bits, extracts middle sample
9. **Bit Accumulation**: Assembles bits according to LSB/MSB first setting
10. **Data Extraction**: Removes start/stop bits, extracts data byte to output register

### Output Port
- **output1**: Received data byte (1 byte) - dynamically allocated register
  - Connect this port to downstream blocks that need to process the received data

### Configuration Parameters

**Channel Selection** (0, 1, or 2)
- Selects which ENDAT channel to use for UART RX
- Each channel can operate independently
- Default: 2 (matches most common configurations)

**Clock Source** (192 MHz or 200 MHz)
- RX clock source selection
- 192 MHz: ICSSGn_UART_CLK (default) - tested up to 32 MHz baud rate
- 200 MHz: ICSSGn_CORE_CLK - tested up to 20 MHz baud rate
- Configured via PRU0_ED_RX_CLK_SEL bit in ICSSG_PRU0_ED_RX_CFG_REG
- Default: 192 MHz

**Baud Rate (MHz)**
- Desired UART baud rate in MHz
- Selected clock source must be divisible by (baudRate × oversample)
- Clock divider is automatically calculated: (clockSource / (baudRate × oversample)) - 1
- Example with 192 MHz: 12 MHz baud with 8x oversample → clockDivider = (192 / (12 × 8)) - 1 = 1
- Example with 200 MHz: 10 MHz baud with 8x oversample → clockDivider = (200 / (10 × 8)) - 1 = (200/80) - 1 = 1.5 (invalid)
- Default: 12 MHz

**Oversample Size** (1x, 2x, 4x, 8x)
- Number of samples per bit for robust reception
- Higher oversample = better noise immunity
- 8x oversample means 8 samples per bit, block checks middle sample (bit 4)
- 4x oversample checks bit 2, 2x/1x check bit 0
- RX baud rate = RX_clock / oversample
- Default: 8x

**Start Bit Polarity** (Falling=0, Rising=1)
- Defines the edge that indicates start of frame
- Standard UART uses falling edge (idle high → start low)
- Default: Rising (1)

**Frame Size** (3-32 bits)
- Total number of bits to receive per frame
- Standard UART: 10 bits (1 start + 8 data + 1 stop)
- Maximum supported: 32 bits (30 data bits + start + stop)
- Default: 10

**Bit Swap (LSB First)** (Enabled/Disabled)
- Enable: LSB transmitted first (standard UART)
- Disable: MSB transmitted first
- Default: Enabled

### Calculation Example
- UART Clock: 192 MHz
- Baud Rate: 12 MHz
- Oversample: 8x
- Clock Divider: (192 / (12 × 8)) - 1 = 1
- RX Clock: 192 / (1+1) = 96 MHz
- Verification: 96 MHz / 8 = 12 MHz ✓

### Generated Assembly
\`\`\`assembly
; Configure GPCFG1 for peripheral mode
ldi32   TEMP_REG1, 0x04000000
ldi     TEMP_REG2.w0, ICSS_CFG_GPCFG1
sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

; Configure RXCFG (clock divider, oversample, start bit polarity)
ldi     TEMP_REG1.w0, 0x000F        ; Oversample + polarity
ldi     TEMP_REG1.w2, 0x0001        ; Clock divider
ldi     TEMP_REG2.w0, ICSS_CFG_PRU1_ENDAT_RXCFG
sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

; Configure CHx_CFG0 (frame size, bit swap)
ldi     TEMP_REG1.w0, 0x000A        ; Frame size = 10
ldi     TEMP_REG1.w2, 0x8000        ; Bit swap enabled
ldi     TEMP_REG2.w0, ICSS_CFG_PRU1_ENDAT_CH2_CFG0
sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4

; Global reinit
set     r31, r31, 19
; Wait...

; Enable RX on channel 2
set     r30, r30, 26
\`\`\`

### Performance
- **Configuration Cycles**: ~25-30 cycles (GPCFG1, RXCFG, CHx_CFG0, reinit wait, RX enable)
- **Reception Cycles**: Variable, depends on frame size and baud rate
  - Standard 10-bit frame: ~10 iterations of bit polling loop
  - Each bit: Wait for valid flag + read + clear + accumulate (~5-10 cycles per bit)
- **Total**: ~50-100 cycles typical for 10-bit frame
- **Max Baud Rate**: Up to 12 Mbaud with proper clock configuration

### Usage Notes
- This block performs **both configuration and reception** of one UART frame
- Execution continues to next block after frame is received and stored
- **Reinit Side Effects**:
  - Global reinit (R31 bit 19) resets TX and RX state machines
  - Any data currently being received or buffered will be lost
  - Reinit is required before first use and recommended between frames for clean state
  - 20-cycle wait ensures reinit completes before RX enable
- Data is output to the dynamically allocated output register (connect output port to downstream blocks)
- Valid flag must be cleared (set R31 bit) after each bit read to prevent overflow
- Hardware automatically deserializes incoming UART frames with oversampling

### Terminology
- **UART**: Universal Asynchronous Receiver/Transmitter - serial communication protocol
- **ENDAT**: PRU-ICSS peripheral hardware used for high-speed serial reception
- **Baud Rate**: Bits per second transmission rate
- **Oversample**: Multiple samples per bit for noise immunity and bit detection
- **Start Bit**: Single bit that marks beginning of frame (typically falling edge)
- **Stop Bit**: Single bit that marks end of frame (typically high)
- **Frame**: Complete data transmission including start, data, and stop bits
- **LSB First**: Least Significant Bit transmitted first (standard UART)
- **MSB First**: Most Significant Bit transmitted first (non-standard)
- **Bit Swap**: Hardware feature to reverse bit order (LSB↔MSB)
- **Valid Flag**: R31 status bit indicating channel has valid data ready
- **Global Reinit**: Hardware reset of ENDAT TX and RX state machines
- **Channel**: One of three independent ENDAT reception paths (CH0, CH1, CH2)
- **GPCFG**: Global Peripheral Configuration register
- **RXCFG**: Receive Configuration register (clock, oversample, polarity)
- **CHx_CFG0**: Channel Configuration register (frame size, bit swap)
- **Output Register**: Dynamically allocated register where received byte is stored
- **R30**: PRU output register (used for RX enable control)
- **R31**: PRU input register (used for valid flags and data bits)

---
`;
}

exports = {
    displayName: "PRU UART RX",
    defaultInstanceName: "PRU_UART_RX_",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
    uiView: "graph",
    requiredIncludes: [
        /*TODO :  review on how to add include files for the modules*/
        // for a workaround defined the registers in the UART block itself 
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
            description: "ENDAT channel to use for UART RX (0, 1, or 2)",
            default: 2,
            options: [
                { name: 0, displayName: "Channel 0" },
                { name: 1, displayName: "Channel 1" },
                { name: 2, displayName: "Channel 2" }
            ]
        },
        {
            name: "clockSource",
            displayName: "Clock Source",
            description: "RX clock source selection. 192 MHz (ICSSGn_UART_CLK) or 200 MHz (ICSSGn_CORE_CLK)",
            default: 0,
            options: [
                { name: 0, displayName: "192 MHz (UART_CLK)" },
                { name: 1, displayName: "200 MHz (CORE_CLK)" }
            ]
        },
        {
            name: "baudRate",
            displayName: "Baud Rate (MHz)",
            description: "Desired UART baud rate in MHz. Clock must be divisible by (baudRate * oversample).",
            default: 12,
            displayFormat: "dec"
        },
        {
            name: "clockDivider",
            displayName: "Clock Divider (Calculated)",
            description: "Calculated clock divider = (clockSource / (baudRate * oversample)) - 1",
            default: 1,
            readOnly: true,
            getValue: (inst) => {
                // Get oversample multiplier from encoding (0=1x, 1=2x, 3=4x, 7=8x)
                let oversampleMultiplier;
                if (inst.oversampleSize === 0) {
                    oversampleMultiplier = 1;
                } else if (inst.oversampleSize === 1) {
                    oversampleMultiplier = 2;
                } else if (inst.oversampleSize === 3) {
                    oversampleMultiplier = 4;
                } else {
                    oversampleMultiplier = 8;
                }
                // Get clock frequency based on clock source selection
                const uartClkMHz = inst.clockSource === 0 ? 192 : 200;
                const baudRateTimesOversample = inst.baudRate * oversampleMultiplier;
                if (baudRateTimesOversample === 0 || uartClkMHz % baudRateTimesOversample !== 0) {
                    return 0; // Invalid, validation will catch this
                }
                return (uartClkMHz / baudRateTimesOversample) - 1;
            }
        },
        {
            name: "oversampleSize",
            displayName: "Oversample Size",
            description: "Number of samples per bit. Baud rate = RX_clock / oversample",
            default: 7,  // 7 = 8x oversample (bits[2:0] encoding)
            options: [
                { name: 0, displayName: "1x" },
                { name: 1, displayName: "2x" },
                { name: 3, displayName: "4x" },
                { name: 7, displayName: "8x" }
            ]
        },
        {
            name: "startBitPolarity",
            displayName: "Start Bit Polarity",
            description: "Edge that indicates start of frame",
            default: 1,  // 1 = rising edge
            options: [
                { name: 0, displayName: "Falling Edge (0)" },
                { name: 1, displayName: "Rising Edge (1)" }
            ]
        },
        {
            name: "frameSize",
            displayName: "Frame Size (bits)",
            description: "Total bits per frame = dataBits + 2 (start + stop). Range: 3-64 (1-62 data bits)",
            default: 10,
            range: [3, 64],
            displayFormat: "dec"
        },
        {
            name: "bitSwap",
            displayName: "Bit Swap (LSB First)",
            description: "Enable LSB-first transmission (standard UART)",
            default: true
        },
        // ========== Calculated/Hidden Configuration ==========
        {
            name: "constant1",
            hidden: true,
            default: "2, 1, 0, 7, 1, 10, 1",
            getValue: (inst) => {
                // Build the macro parameters string
                // Macro signature: m_uart_rx_config dataByteRegLo (output1), dataByteRegHi (output2), channel, clockDiv, rxClkSel, oversample, startBitPol, frameSize, bitSwap
                // Note: dataByteRegLo/dataByteRegHi are dynamically allocated as output ports and prepended by register allocator
                // Internal registers (bitAccumReg, bitCounterReg, tempSampleReg) use TEMP_REG1/TEMP_REG2
                const channel = inst.channel;
                const rxClkSel = inst.clockSource;  // 0=192MHz, 1=200MHz

                // Calculate clock divider from baud rate using selected clock source
                let oversampleMultiplier;
                if (inst.oversampleSize === 0) {
                    oversampleMultiplier = 1;
                } else if (inst.oversampleSize === 1) {
                    oversampleMultiplier = 2;
                } else if (inst.oversampleSize === 3) {
                    oversampleMultiplier = 4;
                } else {
                    oversampleMultiplier = 8;
                }
                const uartClkMHz = inst.clockSource === 0 ? 192 : 200;
                const baudRateTimesOversample = inst.baudRate * oversampleMultiplier;
                const clockDiv = (baudRateTimesOversample === 0 || uartClkMHz % baudRateTimesOversample !== 0)
                    ? 0
                    : (uartClkMHz / baudRateTimesOversample) - 1;

                const oversample = inst.oversampleSize;
                const startBitPol = inst.startBitPolarity;
                const frameSize = inst.frameSize;
                const bitSwap = inst.bitSwap ? 1 : 0;

                return `${channel}, ${clockDiv}, ${rxClkSel}, ${oversample}, ${startBitPol}, ${frameSize}, ${bitSwap}`;
            },
        },
        {
            name: "opCode",
            displayName: "m_uart_rx_config",
            default: "m_uart_rx_config",
            hidden: true,
            getValue: (inst) => {
                // Generate macro name based on PRU, bit order, oversample size, and extended mode
                // Format: m_uart_rx_config_pru<0|1>_<lsb|msb>_<1x|2x|4x|8x>[_ext]
                const pruNum = inst.pruSelect;
                const bitOrder = inst.bitSwap ? "lsb" : "msb";
                const dataBits = inst.frameSize - 2;
                // Extended mode for dataBits >= 31 (frameSize >= 33)
                const isExtended = dataBits >= 31;
                let oversampleName;
                if (inst.oversampleSize === 0) {
                    oversampleName = "1x";
                } else if (inst.oversampleSize === 1) {
                    oversampleName = "2x";
                } else if (inst.oversampleSize === 3) {
                    oversampleName = "4x";
                } else {
                    oversampleName = "8x";
                }
                const extSuffix = isExtended ? "_ext" : "";
                return `m_uart_rx_config_pru${pruNum}_${bitOrder}_${oversampleName}${extSuffix}`;
            },
        },
        {
            name: "numOfInputPorts",
            default: 0,  // No input - this block receives data from UART hardware
            hidden: true
        },
        {
            name: "numOfOutputPorts",
            default: 1,
            hidden: true
        },
        {
            name: "output1Size",
            default: 8,
            hidden: true,
            getValue: (inst) => {
                // Data bits = frameSize - 2 (remove start and stop bits)
                const dataBits = inst.frameSize - 2;
                // Extended mode (>=31 data bits) needs 8 bytes (two 32-bit registers)
                // Standard mode (<=30 data bits) needs 4 bytes (one 32-bit register)
                return dataBits >= 31 ? 8 : 4;
            }
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
            name: "rxOversampleClock",
            displayName: "RX Oversample Clock",
            description: "RX oversample clock frequency = baudRate * oversample",
            hidden: false,
            getValue: (inst) => {
                // Get oversample multiplier from encoding (0=1x, 1=2x, 3=4x, 7=8x)
                let oversampleMultiplier;
                if (inst.oversampleSize === 0) {
                    oversampleMultiplier = 1;
                } else if (inst.oversampleSize === 1) {
                    oversampleMultiplier = 2;
                } else if (inst.oversampleSize === 3) {
                    oversampleMultiplier = 4;
                } else {
                    oversampleMultiplier = 8;
                }
                const rxClkMHz = inst.baudRate * oversampleMultiplier;

                if (rxClkMHz >= 1) {
                    return rxClkMHz.toFixed(2) + " MHz";
                } else {
                    return (rxClkMHz * 1000).toFixed(2) + " kHz";
                }
            },
            default: "N/A"
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: (inst) => {
                // Approximate cycle count:
                // GPCFG1 config: 4 cycles
                // RXCFG config: 6 cycles
                // CHx_CFG0 config: 8 cycles (with branching)
                // Global reinit: 23 cycles (set + wait loop)
                // RX enable: 5 cycles (with branching)
                // Total: ~46 cycles
                return 46;
            },
            default: 46
        }
    ],
    ports: (inst) => {
        let ports = [];
        // Output port for received data (8 bytes = two 32-bit registers for 64-bit data)
        ports.push({ name: "output1", type: "output" });
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
