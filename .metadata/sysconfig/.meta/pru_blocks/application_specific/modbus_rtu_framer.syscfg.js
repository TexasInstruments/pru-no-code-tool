/**
 * modbus_rtu_framer.syscfg.js — Modbus RTU frame delimiting on a PRU.
 *
 * WHAT THIS BLOCK REALLY DOES
 *   Receives Modbus RTU frames over the PRU-ICSS ENDAT UART character layer
 *   (the same hardware interface the UART blocks - uart_config, uart_tx_op,
 *   uart_rx_op - drive) and
 *   delimits frames by MEASURING the 3.5-character-time inter-frame silence
 *   in PRU cycles. The silence watchdog is a 3-cycle countdown loop that is
 *   restarted after every received character; when it reaches zero without a
 *   new character starting, the frame boundary is declared. That measured
 *   gap - not a software timer, not an interrupt - is the feature.
 *
 *   After the boundary: CRC-16 (Modbus parameters: reflected 0xA001, init
 *   0xFFFF, table-driven) is computed over the received payload with
 *   shift/XOR/LBBO only (the PRU has no MULL), the slave address is filtered,
 *   and a status/length/CRC result register is produced.
 *
 * WHY NOT crc_block
 *   crc_block WAS checked first. Its CRC16 path is MSB-first non-reflected
 *   (LSR crcInit,8 / table over the high byte). Modbus RTU requires the
 *   reflected variant (0xA001 reflection of 0x8005, init 0xFFFF, LSB-first
 *   update over the LOW byte). The existing block cannot produce Modbus
 *   CRC values, so this block ships its own 256-entry reflected table via
 *   the same lutName/getLookUptable mechanism.
 *
 * SCOPE NOTES
 *   - A hardware UART plus a well-fed software timer works fine at
 *     9.6-19.2 kbaud, where 3.5 characters is milliseconds of slack.
 *     The PRU case strengthens at 115.2 kbaud and above, and on a loaded
 *     R5F where timer interrupts jitter. This block claims no universal
 *     advantage.
 *   - RS-485 direction control does not exist yet. This block has NO
 *     dependency on it: drive the transceiver DE/RE pin from
 *     PRU GPO blocks around the response transmission; nothing here touches
 *     the direction pin.
 *   - Transmission of the response is owned by uart_tx_op block instances
 *     reading the validated frame buffer; this block is the RX delimiting
 *     half. The pre-response 3.5-character gap can be produced with a
 *     Delay block configured from the same silenceTicks value shown below.
 *
 * REGISTER BUDGET: TEMP_REG1/TEMP_REG2 only (2-TEMP allocator pattern),
 * plus one dynamically allocated frame result register.
 */

/**
 * Extract PRU number from system context (same helper as uart_config).
 */
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
const PRU_USED = getPruNumberFromContext();

/**
 * Oversample encoding (bits[2:0]) -> oversample multiplier.
 * Same encoding as uart_config: 0=1x, 1=2x, 3=4x, 7=8x.
 */
function oversampleMultiplierOf(enc) {
    if (enc === 0) return 1;
    if (enc === 1) return 2;
    if (enc === 3) return 4;
    return 8;
}

/**
 * Middle sample bit within the oversampled r31.b{ch} byte (same as the UART RX blocks).
 */
function middleBitOf(enc) {
    if (enc === 3) return 2;   // 4x
    if (enc === 7) return 4;   // 8x
    return 0;                  // 1x, 2x
}

/**
 * Silence watchdog loop = qbbs + sub + qbne = 3 PRU cycles per iteration.
 * t3.5 = 3.5 char times; Modbus RTU char = 11 bit times (8E1 / 8N2),
 * so the threshold is 38.5 bit times. Computed at generation time with
 * shifts/adds in JS; the PRU never multiplies (no MULL on this core).
 */
function silenceTicksOf(inst) {
    const bitCycles = (inst.pruClockMhz * 1000000) / inst.baudRate;
    const silenceCycles = Math.ceil(38.5 * bitCycles);
    return Math.ceil(silenceCycles / 3);
}

/**
 * ENDAT RX clock divider for a real-world baud rate. Unlike uart_config (which
 * demands exact divisibility of the UART clock), Modbus bauds such
 * as 115200 never divide 192/200 MHz exactly. The hardware divider is an
 * integer, so we take the NEAREST divider and enforce the UART-standard
 * ~2% cumulative baud tolerance. Actual baud error is reported by validate().
 */
function endatClockDividerOf(inst) {
    const mult = oversampleMultiplierOf(inst.oversampleSize);
    const uartClkHz = (inst.clockSource === 0 ? 192 : 200) * 1000000;
    const oversampleClk = inst.baudRate * mult;
    if (oversampleClk <= 0) return { div: 0, errPct: 100 };
    const div = Math.round(uartClkHz / oversampleClk) - 1;
    const actual = uartClkHz / ((div + 1) * mult);
    const errPct = Math.abs(actual - inst.baudRate) / inst.baudRate * 100;
    return { div: Math.max(0, Math.min(65535, div)), errPct: errPct };
}

function validate(inst, report) {
    // $name is emitted as the reflected CRC-16 table symbol in .initdmem; reject clpru reserved identifiers via the shared helper.
    if (typeof system !== "undefined" && system.getScript) {
        var reservedNames = system.getScript("/pru_blocks/common/pru_reserved_names.js");
        if (reservedNames && typeof reservedNames.validateInstanceName === "function") {
            reservedNames.validateInstanceName(inst, report, "This block emits the instance name as its reflected CRC-16 table symbol in .initdmem.");
        }
    }
    const mult = oversampleMultiplierOf(inst.oversampleSize);

    if (inst.baudRate <= 0) {
        report.logError("Baud rate must be positive.", inst, "baudRate");
    }
    if (inst.slaveAddress < 0 || inst.slaveAddress > 247) {
        report.logError("Modbus slave address must be 0-247 (0 = broadcast).", inst, "slaveAddress");
    }
    if (!inst.bufferSymbol || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(inst.bufferSymbol)) {
        report.logError("Buffer symbol must be a valid assembler identifier.", inst, "bufferSymbol");
    }
    if (inst.pruClockMhz !== 192 && inst.pruClockMhz !== 200) {
        report.logError("PRU clock must be 192 or 200 MHz.", inst, "pruClockMhz");
    }

    // ENDAT character-layer divider: nearest integer, UART baud tolerance 2%
    const d = endatClockDividerOf(inst);
    if (d.errPct > 2.0) {
        report.logError(
            "Nearest ENDAT divider (" + d.div + ") gives " + d.errPct.toFixed(2) +
            "% baud error — beyond the ~2% UART tolerance. Choose a different baud/oversample combination.",
            inst, "baudRate");
    } else if (d.errPct > 0) {
        report.logInfo("ENDAT divider " + d.div + " gives " + d.errPct.toFixed(3) +
            "% baud error (within the ~2% UART tolerance). The silence watchdog is still exact: it is derived from the PRU clock, not the divider.",
            inst);
    }

    if (inst.baudRate > 19200) {
        report.logInfo("Modbus spec: above 19200 baud, fixed 750 us / 1.75 ms timers are permitted. " +
            "This block still measures 3.5 character-times exactly (" +
            ((38.5 / inst.baudRate) * 1e6).toFixed(1) + " us), which is the more precise choice.", inst);
    }
}

/**
 * Guarded ICSS_CFG definitions (as in uart_config: the include files are not
 * available to generated macros).
 */
function getIcssCfgDefinitions(pruNum) {
    const gpcfg = pruNum === 0 ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const rxcfg = pruNum === 0 ? "ICSS_CFG_PRU0_ENDAT_RXCFG" : "ICSS_CFG_PRU1_ENDAT_RXCFG";
    const ch0 = pruNum === 0 ? "ICSS_CFG_PRU0_ENDAT_CH0_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH0_CFG0";
    const ch1 = pruNum === 0 ? "ICSS_CFG_PRU0_ENDAT_CH1_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH1_CFG0";
    const ch2 = pruNum === 0 ? "ICSS_CFG_PRU0_ENDAT_CH2_CFG0" : "ICSS_CFG_PRU1_ENDAT_CH2_CFG0";
    return `\
; ========== ICSS CFG register definitions (auto-generated, guarded) ==========
    .if !$isdefed("ICSS_CFG")
    .asg    c4,     ICSS_CFG
    .endif
    .if !$isdefed("${gpcfg}")
${gpcfg}                 .set    0x000${pruNum === 0 ? "8" : "C"}
    .endif
    .if !$isdefed("${rxcfg}")
${rxcfg}       .set    0x00${pruNum === 0 ? "E0" : "100"}
    .endif
    .if !$isdefed("${ch0}")
${ch0}    .set    0x00${pruNum === 0 ? "E8" : "108"}
    .endif
    .if !$isdefed("${ch1}")
${ch1}    .set    0x00${pruNum === 0 ? "F0" : "110"}
    .endif
    .if !$isdefed("${ch2}")
${ch2}    .set    0x00${pruNum === 0 ? "F8" : "118"}
    .endif
; ============================================================================
`;
}

/**
 * Macro body generator.
 *
 * clpru RULE:
 * a NUMERIC LITERAL must NEVER appear in a .macro PARAMETER position of the
 * DECLARATION — [E0004] "Substitution symbol operand expected". All
 * configuration values are therefore either
 *   (a) passed at the CALL SITE (values are legal there), or
 *   (b) baked into the macro BODY at generation time (channel bit numbers,
 *       register offsets selected from the opCode variant).
 *
 * Declaration: m_modbus_rtu_rx_frame_pru{0|1}_ch{0|1|2}_{1x|2x|4x|8x}
 *              .macro frameReg, slaveAddr, silenceTicks, clockDiv, bufSymbol, lutSymbol
 *
 * frameReg layout on return:
 *   frameReg.b0 = status  (0=OK, 1=CRC error, 2=address mismatch, 3=too short)
 *   frameReg.b1 = frame length in bytes (including address and CRC bytes)
 *   frameReg.w2 = computed CRC-16 (reflected 0xA001, init 0xFFFF)
 */
function getMacro(pruInstructionMacro, opCode) {
    const isDefinition = (pruInstructionMacro === "");
    const prefix = isDefinition ? getIcssCfgDefinitions(opCode.includes("_pru0_") ? 0 : 1) : "";

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const frameReg = parts[1] || "frameReg";
    const slaveAddr = parts[2] || "slaveAddr";
    const silenceTicks = parts[3] || "silenceTicks";
    const clockDiv = parts[4] || "clockDiv";
    const bufSymbol = parts[5] || "bufSymbol";
    const lutSymbol = parts[6] || "lutSymbol";

    // Channel-derived hardware facts (selected at generation time from the
    // opCode variant).
    const pruNum = macroName.includes("_pru0_") ? "0" : "1";
    const channel = macroName.includes("_ch0_") ? "0" : (macroName.includes("_ch1_") ? "1" : "2");
    const gpcfgReg = pruNum === "0" ? "ICSS_CFG_GPCFG0" : "ICSS_CFG_GPCFG1";
    const rxcfgReg = pruNum === "0" ? "ICSS_CFG_PRU0_ENDAT_RXCFG" : "ICSS_CFG_PRU1_ENDAT_RXCFG";
    let chCfg0Reg, rxEnableBit, busyBit, rxDataByte, r30b3Enable;
    if (channel === "0") { chCfg0Reg = "ICSS_CFG_PRU" + pruNum + "_ENDAT_CH0_CFG0"; rxEnableBit = "24"; busyBit = "5";  rxDataByte = "0"; r30b3Enable = "0x01"; }
    else if (channel === "1") { chCfg0Reg = "ICSS_CFG_PRU" + pruNum + "_ENDAT_CH1_CFG0"; rxEnableBit = "25"; busyBit = "13"; rxDataByte = "1"; r30b3Enable = "0x02"; }
    else { chCfg0Reg = "ICSS_CFG_PRU" + pruNum + "_ENDAT_CH2_CFG0"; rxEnableBit = "26"; busyBit = "21"; rxDataByte = "2"; r30b3Enable = "0x04"; }

    // Middle sample bit from the oversample variant in the macro name
    let middleBit;
    if (macroName.includes("_1x") || macroName.includes("_2x")) middleBit = "0";
    else if (macroName.includes("_4x")) middleBit = "2";
    else middleBit = "4";

    // UART character = 10 bits (1 start + 8 data + 1 stop), LSB first.
    const frameBits = 10;
    const alignShift = 32 - frameBits; // 22: position of the start bit after reception

    let body = "";

    if (isDefinition) {
        body = macroName + "\t.macro  " + frameReg + ", " + slaveAddr + ", " + silenceTicks +
               ", " + clockDiv + ", " + bufSymbol + ", " + lutSymbol + "\n";
        body += "\t; Parameters (ALL substitution symbols — never numeric literals here, clpru [E0004]):\n" +
            "\t;   frameReg     - allocated result register: b0=status, b1=length, w2=CRC-16\n" +
            "\t;   slaveAddr    - this station's Modbus address (0 also accepted = broadcast)\n" +
            "\t;   silenceTicks - 3.5-char-time silence threshold in watchdog iterations (3 cycles each)\n" +
            "\t;   clockDiv     - ENDAT RX clock divider matching the paired uart_config block\n" +
            "\t;   bufSymbol    - label of the 256-byte frame buffer (Memory Variable block, .udmem)\n" +
            "\t;   lutSymbol    - label of the 256-entry reflected CRC-16 lookup table (.initdmem)\n" +
            "\t; Register budget: TEMP_REG1/TEMP_REG2 only, plus frameReg.\n";
    }

    body += "\
    ; ===== character layer init (ENDAT RX sequence, as the UART blocks program it) =====\n\
    ; TRM sequence: assert tx_global_reinit, wait for busy clear, de-assert rx_en\n\
    set     r31, r31, 19\n\
mb_wait_reinit?:\n\
    qbbs    mb_wait_reinit?, r31, " + busyBit + "\n\
    ldi     r30.b3, 0x00\n\
    ldi32   TEMP_REG1, 0x04000000\n\
    ldi     TEMP_REG2.w0, " + gpcfgReg + "\n\
    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4\n\
    ldi     TEMP_REG1.w0, " + (oversampleEncodingFromName(macroName)) + "   ; oversample bits[2:0] (same encoding as uart_config)\n\
    ldi     TEMP_REG1.w2, " + clockDiv + "\n\
    ldi     TEMP_REG2.w0, " + rxcfgReg + "\n\
    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4\n\
    ldi     TEMP_REG1.w0, 0\n\
    ldi     TEMP_REG1.w2, " + frameBits + "   ; frame size in bits [27:16]\n\
    set     TEMP_REG1, TEMP_REG1, 31   ; bitSwap = LSB first (standard UART)\n\
    ldi     TEMP_REG2.w0, " + chCfg0Reg + "\n\
    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4\n\
    ldi     r30.b3, " + r30b3Enable + "   ; enable RX on channel " + channel + "\n\
\n\
    ; ===== Modbus RTU delimiting: measured 3.5-character-time silence =====\n\
    ldi     " + frameReg + ".b0, 0\n\
    ldi     " + frameReg + ".b1, 0\n\
mb_wait_char?:\n\
    ldi32   TEMP_REG1, " + silenceTicks + "\n\
mb_gap_loop?:\n\
    qbbs    mb_char_rx?, r31, " + rxEnableBit + "   ; new character bit ready? (restart watchdog)\n\
    sub     TEMP_REG1, TEMP_REG1, 1\n\
    qbne    mb_gap_loop?, TEMP_REG1, 0\n\
    ; watchdog hit zero: " + silenceTicks + " iterations x 3 cycles of measured silence\n\
    qbeq    mb_wait_char?, " + frameReg + ".b1, 0   ; idle line (no frame yet): keep listening\n\
    qba     mb_frame_check?              ; frame boundary declared here\n\
mb_char_rx?:\n\
    ; receive one " + frameBits + "-bit UART character (per-bit valid-flag polling loop)\n\
    ldi     TEMP_REG1, 0\n\
    ldi     TEMP_REG2.b0, 0\n\
mb_bit_loop?:\n\
    qbbc    mb_bit_loop?, r31, " + rxEnableBit + "\n\
    mov     TEMP_REG2.b1, r31.b" + rxDataByte + "\n\
    set     r31, r31, " + rxEnableBit + "\n\
    qbbs    mb_got_one?, TEMP_REG2.b1, " + middleBit + "\n\
    lsr     TEMP_REG1, TEMP_REG1, 1\n\
    qba     mb_next_bit?\n\
mb_got_one?:\n\
    lsr     TEMP_REG1, TEMP_REG1, 1\n\
    set     TEMP_REG1, TEMP_REG1, 31\n\
mb_next_bit?:\n\
    add     TEMP_REG2.b0, TEMP_REG2.b0, 1\n\
    qbne    mb_bit_loop?, TEMP_REG2.b0, " + frameBits + "\n\
    ldi     TEMP_REG2.w0, " + alignShift + "\n\
    lsr     TEMP_REG1, TEMP_REG1, TEMP_REG2.w0\n\
    lsr     TEMP_REG1, TEMP_REG1, 1     ; drop start bit\n\
    ldi     TEMP_REG2, 1\n\
    lsl     TEMP_REG2, TEMP_REG2, 8\n\
    sub     TEMP_REG2, TEMP_REG2, 1\n\
    and     TEMP_REG1, TEMP_REG1, TEMP_REG2\n\
    ; append byte to frame buffer; frames beyond 255 bytes drop the excess\n\
    ; (truncation then fails the CRC check and reports status 1)\n\
    qbgt    mb_no_store?, " + frameReg + ".b1, 254\n\
    ldi32   TEMP_REG2, " + bufSymbol + "\n\
    sbbo    &TEMP_REG1, TEMP_REG2, " + frameReg + ".b1, 1\n\
    add     " + frameReg + ".b1, " + frameReg + ".b1, 1\n\
mb_no_store?:\n\
    qba     mb_wait_char?               ; restart the silence watchdog\n\
\n\
mb_frame_check?:\n\
    qble    mb_status_short?, " + frameReg + ".b1, 3   ; need addr+fnc+CRC2\n\
    ; ---- CRC-16 (Modbus: reflected 0xA001, init 0xFFFF) over length-2 bytes ----\n\
    ; No MULL on PRU: table lookup + shifts + XOR only.\n\
    ; CRC lives in " + frameReg + ".b2 (low) / .b3 (high); .b0 is the buffer pointer.\n\
    ldi     " + frameReg + ".b2, 0xFF\n\
    ldi     " + frameReg + ".b3, 0xFF\n\
    ldi     " + frameReg + ".b0, 0\n\
    sub     TEMP_REG2.b2, " + frameReg + ".b1, 2\n\
mb_crc_next?:\n\
    qbeq    mb_crc_done?, TEMP_REG2.b2, 0\n\
    ldi32   TEMP_REG1, " + bufSymbol + "\n\
    lbbo    &TEMP_REG2.b1, TEMP_REG1, " + frameReg + ".b0, 1\n\
    xor     TEMP_REG2.b0, " + frameReg + ".b2, TEMP_REG2.b1\n\
    ldi32   TEMP_REG1, " + lutSymbol + "\n\
    lbbo    &TEMP_REG2.w0, TEMP_REG1, TEMP_REG2.b0, 2\n\
    mov     " + frameReg + ".b2, " + frameReg + ".b3   ; crc >>= 8\n\
    ldi     " + frameReg + ".b3, 0\n\
    xor     " + frameReg + ".b2, " + frameReg + ".b2, TEMP_REG2.b0\n\
    xor     " + frameReg + ".b3, " + frameReg + ".b3, TEMP_REG2.b1\n\
    add     " + frameReg + ".b0, " + frameReg + ".b0, 1\n\
    sub     TEMP_REG2.b2, TEMP_REG2.b2, 1\n\
    qba     mb_crc_next?\n\
mb_crc_done?:\n\
    ldi32   TEMP_REG1, " + bufSymbol + "\n\
    lbbo    &TEMP_REG2.b0, TEMP_REG1, " + frameReg + ".b0, 2   ; received CRC, little-endian\n\
    xor     TEMP_REG2.b0, TEMP_REG2.b0, " + frameReg + ".b2\n\
    xor     TEMP_REG2.b1, TEMP_REG2.b1, " + frameReg + ".b3\n\
    or      TEMP_REG2.b0, TEMP_REG2.b0, TEMP_REG2.b1\n\
    qbeq    mb_addr_ok?, TEMP_REG2.b0, 0\n\
    qba     mb_status_crc?\n\
mb_addr_ok?:\n\
    ldi     " + frameReg + ".b0, 0\n\
    lbbo    &TEMP_REG2.b0, TEMP_REG1, " + frameReg + ".b0, 1\n\
    qbeq    mb_status_ok?, TEMP_REG2.b0, " + slaveAddr + "\n\
    qbeq    mb_status_ok?, TEMP_REG2.b0, 0   ; broadcast\n\
    qba     mb_status_addr?\n\
mb_status_ok?:\n\
    ldi     " + frameReg + ".b0, 0\n\
    qba     mb_done?\n\
mb_status_crc?:\n\
    ldi     " + frameReg + ".b0, 1\n\
    qba     mb_done?\n\
mb_status_addr?:\n\
    ldi     " + frameReg + ".b0, 2\n\
    qba     mb_done?\n\
mb_status_short?:\n\
    ldi     " + frameReg + ".b0, 3\n\
mb_done?:\n\
    ; RX is left enabled: this block is normally placed inside a Loop block\n\
    ; so the next frame is delimited immediately after this one.\n";

    if (isDefinition) {
        body += "\n .endm";
    }

    return prefix + body;
}

function oversampleEncodingFromName(macroName) {
    if (macroName.includes("_8x")) return "7";
    if (macroName.includes("_4x")) return "3";
    if (macroName.includes("_2x")) return "1";
    return "0";
}

/**
 * Modbus CRC-16 lookup table, reflected form.
 * crc_next = (crc >> 8) ^ table[(crc ^ byte) & 0xFF], poly 0xA001, init 0xFFFF.
 * This is NOT what crc_block generates (that one is MSB-first non-reflected,
 * which cannot produce Modbus CRC values — checked before writing this).
 */
function getLookUptable(instance) {
    const values = [];
    for (let dividend = 0; dividend < 256; dividend++) {
        let cur = dividend;
        for (let bit = 0; bit < 8; bit++) {
            if (cur & 1) {
                cur = (cur >> 1) ^ 0xA001;
            } else {
                cur = cur >> 1;
            }
        }
        values.push("0x" + (cur & 0xFFFF).toString(16).toUpperCase().padStart(4, "0"));
    }
    return values.join(", ");
}

function getDataSize(instance) {
    return ".ushort";
}

function getLongDescription() {
    return `
## Modbus RTU Framer (RX delimiting with measured 3.5-character silence)

### Purpose
Receives one Modbus RTU frame over the PRU-ICSS ENDAT UART character layer
(the same hardware the \`uart_config\` / \`uart_tx_op\` / \`uart_rx_op\` blocks drive) and delimits it by
**measuring the 3.5-character-time inter-frame silence in PRU cycles**. The
block then validates the frame with CRC-16 (Modbus parameters) and filters the
slave address.

### The determinism feature
RTU frames are delimited by 3.5 character-times of silence. A frame boundary
missed because an interrupt was late is a corrupted transaction. This block
measures the gap with a 3-cycle countdown watchdog that is restarted on every
received character; the boundary is declared only when the full interval of
measured silence elapses. The threshold is computed at generation time
(\`silenceTicks\`, shown in the block table) from the configured baud and PRU
clock.

**Scope of the advantage:** a hardware UART plus a well-fed software
timer works fine at 9.6–19.2 kbaud, where 3.5 characters is milliseconds. The
PRU case strengthens at 115.2 kbaud and above, and on a loaded R5F where
timer interrupts jitter. This block claims no universal advantage.

### How it works
1. **Character layer init** — the ENDAT RX programming sequence (global
   reinit, GPCFG peripheral mode, RXCFG clock + oversampling, CHx_CFG0 frame
   format, RX enable). Character reception uses per-bit valid-flag polling.
   Response transmission is owned by \`uart_tx_op\` block instances downstream — this block is the RX
   delimiting half.
2. **Reception** — bytes are appended to a 256-byte frame buffer in DMEM
   (reserved by a paired Memory Variable block using \`bufferSymbol\`).
3. **Silence watchdog** — 3 cycles per iteration; 3.5 char times = 38.5 bit
   times (11-bit RTU characters). Idle line (no frame started) keeps
   listening.
4. **CRC-16** — table-driven reflected 0xA001 / init 0xFFFF, over the
   length−2 payload. Shifts, XORs and LBBO only: the PRU has no MULL, and none
   is needed. \`crc_block\` was checked first: its CRC16 path is MSB-first
   non-reflected and cannot produce Modbus CRC values, so this block ships
   its own reflected table through the same lutName mechanism.
5. **Address filter** — frame accepted if byte 0 equals \`slaveAddress\` or 0
   (broadcast).

### Result register (output1, 4 bytes)
| Field | Meaning |
|-------|---------|
| b0 | status: 0 = OK, 1 = CRC error, 2 = address mismatch, 3 = frame too short (< 4 bytes) |
| b1 | frame length in bytes (address + PDU + 2 CRC bytes) |
| w2 | computed CRC-16 (little-endian in b2/b3, matching on-wire order) |

Frames longer than 255 bytes drop the excess bytes; the truncation then fails
CRC and reports status 1. The block **blocks** until a frame is delimited
(it waits for silence), as a UART RX block waits for a character.

### Dependencies
- **RS-485 direction control does not exist yet.** This block does not depend
  on it and does not touch a direction pin. Drive the transceiver DE/RE
  pin from PRU GPO blocks around response transmission when that hardware is
  present.
- **Frame buffer:** add a Memory Variable block with \`labelName\` =
  \`bufferSymbol\`, 256 bytes, \`.udmem\`. The linker resolves the label.
- **CRC table:** emitted automatically (512 bytes) via the block's lutName in
  \`.initdmem\`; multiple framer instances each emit their own table.
- **Pre-response gap:** the Modbus requirement to wait 3.5 character times
  before transmitting a response can be met with a Delay block configured
  from the same \`silenceTicks\` value.

### Timing
- Watchdog granularity: 3 PRU cycles (poll + decrement + branch).
- Example defaults (200 MHz PRU, 115200 baud): bit = 1736 cycles, silence =
  66,736 cycles = 22246 watchdog iterations ≈ 333.7 µs measured at
  cycle granularity.
- CRC: ~13 cycles per byte (two LDI32 bases, LBBO, shift/XOR update).
- The block's \`noOfCycles\` reports only the deterministic init portion; the
  reception/wait phase is inherently blocking.

### Register budget
TEMP_REG1 / TEMP_REG2 only (2-TEMP allocator pattern) plus the allocated
frame result register. No MULL anywhere; all scaling is done at generation
time or with shifts.

### What is NOT claimed
- No pru-simulator co-simulation of this block yet — it is checked by a clean
  clpru assembly of the generated macro (see
  \`scripts/verify_modbus_build.js\`) plus a JS-side check of the generated
  CRC table against the bitwise reference.
- No TX-side framing (CRC append + gap enforcement) inside this block; build
  it from uart_tx_op + CRC arithmetic downstream.
`;
}

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

### Adding an Instance

\`\`\`javascript
const modbus = scripting.addModule("/pru_blocks/application_specific/modbus_rtu_framer", {}, false);
const framer1 = modbus.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| slaveAddress | Integer | 0-247 | 1 | This station's Modbus address (0 accepts broadcast) |
| baudRate | Integer | >0, clock-divisible | 115200 | Baud rate; ENDAT clock must divide by baud*oversample |
| pruClockMhz | Integer | 192, 200 | 200 | PRU core clock used for the silence measurement |
| clockSource | Integer | 0, 1 | 0 | ENDAT RX clock: 0 = 192 MHz UART_CLK, 1 = 200 MHz CORE_CLK (must match paired uart blocks) |
| channel | Integer | 0, 1, 2 | 2 | ENDAT channel (must match paired uart blocks) |
| oversampleSize | Integer | 0, 1, 3, 7 | 7 | Oversample encoding (0=1x, 1=2x, 3=4x, 7=8x — same encoding as uart_config: 7 means 8x) |
| bufferSymbol | String | identifier | "modbus_rtu_frame_buf" | Label of the 256-byte .udmem frame buffer (Memory Variable block) |
| lutMemoryLocation | String | "dmem", "smem" | "dmem" | Where the 512-byte CRC table is placed |

### Required companion blocks
1. **Memory Variable** with \`labelName\` = \`bufferSymbol\`, \`sizeInBytes\` = 256,
   section \`.udmem\` — the frame buffer this macro writes via SBBO.
2. **uart_config + uart_tx_op instances** for the response path (character layer TX).
3. **Loop block** if you want continuous frame reception.

### Example

\`\`\`javascript
framer1.$name = "MODBUS_FRAMER_0";
framer1.slaveAddress = 17;
framer1.baudRate = 115200;
framer1.pruClockMhz = 200;
framer1.clockSource = 0;
framer1.channel = 2;
framer1.oversampleSize = 7;          // 8x oversampling
framer1.bufferSymbol = "modbus_rx_frame_buf";
\`\`\`

### Connecting

\`\`\`javascript
// Result register (status/length/CRC) to downstream consumers
scripting.connect(framer1, "output1", status_consumer, "input1");
// Control flow
scripting.connect(prev_block, "next", framer1, "prev");
scripting.connect(framer1, "next", next_block, "prev");
\`\`\`

### Important Notes
1. The macro declaration takes ONLY substitution symbols; all numeric config
   is passed at the call site or baked into the body (clpru [E0004] rejects
   numeric literals in .macro parameter positions).
2. \`channel\`, \`clockSource\`, \`oversampleSize\` must match the paired
   uart_config instance — they describe the same hardware.
3. The block blocks until a frame is delimited by measured silence.
4. Read the frame PDU from the buffer via Memory Access blocks using
   \`bufferSymbol\` after checking status == 0.
`;
}

exports = {
    displayName: "Modbus RTU Framer",
    defaultInstanceName: "MODBUS_RTU_",
    longDescription: getAIContext(),
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
            name: "numOfConstants",
            default: 1,
            hidden: true
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
        {
            name: "slaveAddress",
            displayName: "Slave Address",
            description: "This station's Modbus address (0-247; incoming frames addressed to 0 = broadcast are also accepted)",
            default: 1,
            displayFormat: "dec"
        },
        {
            name: "baudRate",
            displayName: "Baud Rate",
            description: "Modbus baud rate. ENDAT clock source must be divisible by (baudRate * oversample multiplier).",
            default: 115200,
            displayFormat: "dec"
        },
        {
            name: "pruClockMhz",
            displayName: "PRU Clock (MHz)",
            description: "PRU core clock used to convert 3.5 character-times into watchdog iterations",
            default: 200,
            options: [
                { name: 192, displayName: "192 MHz" },
                { name: 200, displayName: "200 MHz" }
            ]
        },
        {
            name: "clockSource",
            displayName: "ENDAT Clock Source",
            description: "Must match the paired uart_config block: 0 = 192 MHz UART_CLK, 1 = 200 MHz CORE_CLK",
            default: 0,
            options: [
                { name: 0, displayName: "192 MHz (UART_CLK)" },
                { name: 1, displayName: "200 MHz (CORE_CLK)" }
            ]
        },
        {
            name: "channel",
            displayName: "ENDAT Channel",
            description: "ENDAT channel used for RX (must match the paired uart blocks)",
            default: 2,
            options: [
                { name: 0, displayName: "Channel 0" },
                { name: 1, displayName: "Channel 1" },
                { name: 2, displayName: "Channel 2" }
            ]
        },
        {
            name: "oversampleSize",
            displayName: "Oversample Size",
            description: "Samples per bit (encoding shared with uart_config: 0=1x, 1=2x, 3=4x, 7=8x)",
            default: 7,
            options: [
                { name: 0, displayName: "1x" },
                { name: 1, displayName: "2x" },
                { name: 3, displayName: "4x" },
                { name: 7, displayName: "8x" }
            ]
        },
        {
            name: "bufferSymbol",
            displayName: "Frame Buffer Symbol",
            description: "Assembler label of the 256-byte .udmem frame buffer. Reserve it with a Memory Variable block using this exact labelName.",
            default: "modbus_rtu_frame_buf"
        },
        {
            name: "clockDivider",
            displayName: "Clock Divider (Calculated)",
            description: "ENDAT RX divider = (clockSource / (baudRate * oversample)) - 1, rounded to the nearest integer",
            default: 0,
            readOnly: true,
            getValue: (inst) => endatClockDividerOf(inst).div
        },
        {
            name: "silenceTicksDisplay",
            displayName: "3.5-Char Silence Watchdog",
            description: "Watchdog iterations (3 PRU cycles each) that delimit a frame boundary",
            hidden: false,
            readOnly: true,
            default: "N/A",
            getValue: (inst) => {
                const ticks = silenceTicksOf(inst);
                const us = (38.5 / inst.baudRate) * 1e6;
                return ticks + " ticks (" + us.toFixed(1) + " us)";
            }
        },
        {
            name: "constant1",
            hidden: true,
            default: "",
            getValue: (inst) => {
                // Call-site arguments appended after the allocated output
                // register. Values here are legal; only the .macro
                // DECLARATION must use substitution symbols (clpru E0004).
                return inst.slaveAddress + ", " + silenceTicksOf(inst) + ", " +
                       endatClockDividerOf(inst).div + ", " + inst.bufferSymbol + ", " + inst.$name;
            }
        },
        {
            name: "opCode",
            displayName: "m_modbus_rtu_rx_frame",
            hidden: true,
            default: "",
            getValue: (inst) => {
                let oversampleName;
                if (inst.oversampleSize === 0) oversampleName = "1x";
                else if (inst.oversampleSize === 1) oversampleName = "2x";
                else if (inst.oversampleSize === 3) oversampleName = "4x";
                else oversampleName = "8x";
                return "m_modbus_rtu_rx_frame_pru" + inst.pruSelect + "_ch" + inst.channel + "_" + oversampleName;
            }
        },
        {
            name: "lutName",
            hidden: true,
            default: "",
            getValue: (inst) => inst.$name
        },
        {
            name: "lutMemoryLocation",
            displayName: "CRC Table Memory Location",
            description: "Where the 512-byte reflected CRC-16 lookup table is placed",
            options: [
                { name: "dmem", displayName: "DMEM (Local - 8KB)" },
                { name: "smem", displayName: "SMEM (Shared - 64KB)" }
            ],
            default: "dmem"
        },
        {
            name: "output1Size",
            default: "4",
            hidden: true
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            default: 40,
            getValue: (inst) => 40 // deterministic character-layer init portion only;
            // reception + silence watchdog + CRC are data-dependent (blocking)
        }
    ],
    ports: (inst) => {
        let ports = [];
        ports.push({ name: "output1", type: "output32" });
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
    getMacro,
    getDataSize,
    getLookUptable
}
