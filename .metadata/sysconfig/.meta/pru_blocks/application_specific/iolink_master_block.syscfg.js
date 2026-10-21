"use strict";
/**
 * IO-Link Master Block
 *
 * Implements a complete IO-Link master transaction cycle (IEC 61131-9) for
 * the PRU-ICSS. Uses the ENDAT peripheral for hardware UART TX/RX framing
 * and the PRU GPIO for transceiver direction control and wake-up pulse
 * generation.
 *
 * COM rates: COM1=4.8k, COM2=38.4k, COM3=230.4k baud.
 * Frame format: UART 8N1 (8 data bits, no parity, 1 stop bit).
 * Half-duplex on C/Q line.
 *
 * The in-tool simulator does not model the ENDAT FIFO/TX/RX state machine, so
 * the transaction itself is not simulated (blockMaturity below).
 */

/**
 * Guarded .set definitions for the ICSS_CFG register symbols needed by the
 * ENDAT TX/RX wrapper (the same guarded symbols as uart_config.syscfg.js),
 * so the .asm file assembles even without explicit icss_cfg_regs.inc.
 */
function getIcssCfgDefinitions() {
    var s = "";
    s += "; ========== ICSS CFG register definitions (iolink_master_block) ==========\n";
    s += "    .if !$isdefed(\"ICSS_CFG\")\n";
    s += "    .asg    c4,     ICSS_CFG\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_GPCFG0\")\n";
    s += "ICSS_CFG_GPCFG0                 .set    0x0008\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_GPCFG1\")\n";
    s += "ICSS_CFG_GPCFG1                 .set    0x000C\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU0_ENDAT_TXCFG\")\n";
    s += "ICSS_CFG_PRU0_ENDAT_TXCFG       .set    0x00E4\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU1_ENDAT_TXCFG\")\n";
    s += "ICSS_CFG_PRU1_ENDAT_TXCFG       .set    0x0104\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU0_ENDAT_RXCFG\")\n";
    s += "ICSS_CFG_PRU0_ENDAT_RXCFG       .set    0x00E0\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU1_ENDAT_RXCFG\")\n";
    s += "ICSS_CFG_PRU1_ENDAT_RXCFG       .set    0x0100\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU0_ENDAT_CH0_CFG0\")\n";
    s += "ICSS_CFG_PRU0_ENDAT_CH0_CFG0    .set    0x00E8\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU0_ENDAT_CH1_CFG0\")\n";
    s += "ICSS_CFG_PRU0_ENDAT_CH1_CFG0    .set    0x00F0\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU0_ENDAT_CH2_CFG0\")\n";
    s += "ICSS_CFG_PRU0_ENDAT_CH2_CFG0    .set    0x00F8\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU1_ENDAT_CH0_CFG0\")\n";
    s += "ICSS_CFG_PRU1_ENDAT_CH0_CFG0    .set    0x0108\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU1_ENDAT_CH1_CFG0\")\n";
    s += "ICSS_CFG_PRU1_ENDAT_CH1_CFG0    .set    0x0110\n";
    s += "    .endif\n";
    s += "    .if !$isdefed(\"ICSS_CFG_PRU1_ENDAT_CH2_CFG0\")\n";
    s += "ICSS_CFG_PRU1_ENDAT_CH2_CFG0    .set    0x0118\n";
    s += "    .endif\n";
    s += "; ========================================================================\n";
    return s;
}

function comModeToBaud(comMode) {
    switch (comMode) {
        case "COM1": return 4800;
        case "COM2": return 38400;
        case "COM3": return 230400;
        default:     return 230400;
    }
}

function baudToClockDiv(baud) {
    var clkSrc = 192000000;
    var rate = clkSrc / baud;
    // IO-Link tolerates ~2% baud rate error, so rounding to nearest integer is fine.
    var div = Math.round(rate) - 1;
    if (div < 0 || div > 65535) { return -1; }
    return div;
}

var iolinkModule = {
    displayName: "IO-Link Master",
    defaultInstanceName: "IOLINK_MSTR_",
    description: "IO-Link master PHY timing engine (IEC 61131-9).",

    longDescription: [
        "IO-Link master PHY engine that runs a complete master -> device",
        "transaction cycle on the C/Q half-duplex line.",
        "",
        "**Protocol flow per transaction:**",
        "  1. Wake-up pulse: C/Q driven low for >=80 us, then released high.",
        "  2. M-sequence TX: Master transmits N bytes of 8N1 UART via ENDAT hardware.",
        "  3. Turnaround: C/Q released; master listens for >=4 bit periods.",
        "  4. Response RX: Device replies with M bytes of 8N1 UART via ENDAT hardware.",
        "  5. Idle: C/Q high.",
        "",
        "**Peripheral resources:**",
        "- ENDAT channel (1 of 3 per PRU) for hardware UART TX/RX framing.",
        "- 1x R30 GPIO for transceiver direction control (DIR).",
        "- 1x R30 GPIO for wake-up pulse drive.",
        "- No IEP, MAC, or SPAD required.",
        "",
        "**Supported COM rates:**",
        "  COM1 = 4.8 kbps  (divider 39999, frame 10 bits)",
        "  COM2 = 38.4 kbps (divider  4999, frame 10 bits)",
        "  COM3 = 230.4 kbps(divider   832, frame 10 bits)",
        "",
        "**BOM:** Requires an external IO-Link transceiver (e.g. TI OL1013, MAX14819)",
        "to convert the PRU's 3.3V ENDAT UART to 24V C/Q levels.",
        "",
        '**Status:** metadata only. The ENDAT programming follows the UART blocks',
        '(`uart_config`, `uart_tx_op`, `uart_rx_op`), but the in-tool simulator does',
        "NOT model the internal ENDAT FIFO/TX/RX state machine, so the transaction",
        "is not simulated; only the R30 wake-up/DIR waveform is checked.",
        "The M-sequence transmit sends byte 0 only; multi-byte M-sequences are not implemented."
    ].join("\n"),

    uiView: "graph",

    config: [
        { name: "$shape",     hidden: true, default: "square" },
        { name: "$topLabel",  hidden: true, default: "" },
        {
            name: "blockMaturity", displayName: "Block Maturity", default: "metadata-only",
            options: [
                {name: "metadata-only"},
                {name: "assembles"},
                {name: "simulator-tested"},
                {name: "dual-oracle-tested"},
                {name: "hardware-validated"}
            ],
            hidden: true
        },
        {
            name: "comMode",
            displayName: "COM Mode",
            description: "IO-Link baud-rate mode (COM1=4.8k, COM2=38.4k, COM3=230.4k)",
            default: "COM3",
            options: [
                {name: "COM1", displayName: "COM1 (4.8 kbps)"},
                {name: "COM2", displayName: "COM2 (38.4 kbps)"},
                {name: "COM3", displayName: "COM3 (230.4 kbps)"}
            ]
        },
        {
            name: "baudDivider",
            displayName: "ENDAT Clock Divider",
            description: "Calculated ENDAT clock divider for the selected COM mode",
            default: 832,
            readOnly: true,
            getValue: function(inst) { return baudToClockDiv(comModeToBaud(inst.comMode)); }
        },
        {
            name: "baudHz",
            displayName: "Baud Rate (Hz)",
            description: "Actual baud rate in Hz for the selected COM mode",
            default: 230400,
            readOnly: true,
            getValue: function(inst) { return comModeToBaud(inst.comMode); }
        },
        {
            name: "txBytes",
            displayName: "M-Sequence TX bytes",
            description: "Number of data bytes to transmit in the master frame (1..16). Preamble byte is added automatically in OPERATE mode.",
            default: 4,
            displayFormat: "dec"
        },
        {
            name: "rxBytes",
            displayName: "Response RX bytes",
            description: "Number of data bytes expected in the device response (0..16). 0 = receive phase skipped.",
            default: 4,
            displayFormat: "dec"
        },
        {
            name: "frameSizeBits",
            displayName: "Frame size (bits)",
            description: "Per-byte frame bits (start + 8 data + stop = 10 for IO-Link 8N1)",
            default: 10,
            readOnly: true,
            getValue: function() { return 10; }
        },
        {
            name: "bitPeriodNs",
            displayName: "Bit period (ns)",
            description: "Calculated bit period from the selected COM rate",
            default: 4340,
            readOnly: true,
            getValue: function(inst) { return Math.round(1e9 / comModeToBaud(inst.comMode)); }
        },
        {
            name: "dirPin",
            displayName: "DIR Pin (R30 bit)",
            description: "R30 GPIO bit to control transceiver direction (0=RX, 1=TX)",
            default: 2
        },
        {
            name: "wakePin",
            displayName: "Wake Pin (R30 bit)",
            description: "R30 GPIO bit for wake-up pulse drive (driven low for >=80 us)",
            default: 3
        },
        {
            name: "endatChannel",
            displayName: "ENDAT Channel",
            description: "ENDAT peripheral channel for UART TX/RX (0, 1, or 2)",
            default: 0,
            options: [
                {name: 0, displayName: "Channel 0"},
                {name: 1, displayName: "Channel 1"},
                {name: 2, displayName: "Channel 2"}
            ]
        },
        {
            name: "wakeLoops",
            displayName: "Wake-up delay loops",
            description: "Number of delay-loop iterations for the wake-up pulse (minimum >=80 us). Each loop ~5 cycles @ 200 MHz = 25 ns.",
            default: 6400
        },
        {
            name: "turnaroundBitPeriods",
            displayName: "Turnaround (bit periods)",
            description: "Number of bit periods to wait between TX and RX for bus turnaround (minimum 4 per IO-Link spec)",
            default: 5
        },
        {
            name: "mSeqPreambleBytes",
            displayName: "M-Seq preamble bytes",
            description: "Number of preamble bytes to prefix before the M-sequence payload (1 = PREOPPER, 0 = OPERATE with no preamble)",
            default: 0,
            hidden: false
        },
        { name: "opCode", default: "m_iolink_master", hidden: true },
        { name: "numOfInputPorts",   default: 2, hidden: true },
        { name: "numOfOutputPorts",  default: 1, hidden: true },
        { name: "output1Size",       default: 4, hidden: true },
        { name: "numOfConstants",    default: 9, hidden: true },
        { name: "constant1", default: 2, hidden: true, getValue: i => i.dirPin },
        { name: "constant2", default: 3, hidden: true, getValue: i => i.wakePin },
        { name: "constant3", default: 0, hidden: true, getValue: i => i.endatChannel },
        { name: "constant4", default: 832, hidden: true, getValue: i => i.baudDivider },
        { name: "constant5", default: 4, hidden: true, getValue: i => i.txBytes },
        { name: "constant6", default: 4, hidden: true, getValue: i => i.rxBytes },
        { name: "constant7", default: 5, hidden: true, getValue: i => i.turnaroundBitPeriods },
        { name: "constant8", default: 6400, hidden: true, getValue: i => i.wakeLoops },
        { name: "constant9", default: 0, hidden: true, getValue: i => i.mSeqPreambleBytes },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            getValue: function(inst) {
                var wake  = inst.wakeLoops         || 4000;
                var txB   = inst.txBytes           || 4;
                var rxB   = inst.rxBytes           || 4;
                var turn  = inst.turnaroundBitPeriods || 5;
                var baud  = comModeToBaud(inst.comMode || "COM3");
                var bitCy = 200e6 / baud;
                return (wake * 5) + 55 + (txB * 2) + 55 + (rxB * 15) + (turn * bitCy) + 20;
            },
            default: 50000
        }
    ],

    ports: function(inst) {
        return [
            { name: "prev",    type: "IO_PREV" },
            { name: "next",    type: "IO_NEXT" },
            { name: "input1",  type: "input32" },
            { name: "input2",  type: "input32" },
            { name: "output1", type: "output32" }
        ];
    },

    validate: function(inst, validation) {
        if (inst.txBytes < 1 || inst.txBytes > 16) {
            validation.logError("txBytes must be 1..16", inst, "txBytes");
        }
        if (inst.rxBytes < 0 || inst.rxBytes > 16) {
            validation.logError("rxBytes must be 0..16", inst, "rxBytes");
        }
        if (inst.dirPin === inst.wakePin) {
            validation.logError("DIR pin and Wake pin must differ", inst, "dirPin");
        }
        if (inst.dirPin < 0 || inst.dirPin > 15) {
            validation.logError("dirPin must be 0..15", inst, "dirPin");
        }
        if (inst.wakePin < 0 || inst.wakePin > 15) {
            validation.logError("wakePin must be 0..15", inst, "wakePin");
        }
        if (inst.wakeLoops < 1600) {
            validation.logWarning(
                "wakeLoops=" + inst.wakeLoops + " may be too short. Minimum 3200 (~80 us @ 200 MHz, ~5 cy/loop) recommended.",
                inst, "wakeLoops"
            );
        }
        if (inst.turnaroundBitPeriods < 4) {
            validation.logError("Turnaround must be at least 4 bit periods per IO-Link spec", inst, "turnaroundBitPeriods");
        }
        var div = baudToClockDiv(comModeToBaud(inst.comMode));
        if (div < 0 || div > 65535) {
            validation.logError("Computed clock divider " + div + " out of range (0-65535)", inst, "comMode");
        }
    },

    // Build macro assembly by joining lines.
    // Uses only basic string concatenation to avoid template literal pitfalls.
    getMacro: function(pruInstructionMacro, opCode) {
        opCode = opCode || "m_iolink_master";
        var lines = [];

        // ---- macro header ----
        lines.push(opCode + " .macro RES, DATA_IN_LO, DATA_IN_HI, DIR_PIN, WAKE_PIN, CHANNEL, CLK_DIV, TX_BYTES, RX_BYTES, TURN_BITS, WAKE_LPS, PREAMBLE");
        lines.push("    ; ================================================================");
        lines.push("    ; m_iolink_master -- IO-Link master transaction engine");
        lines.push("    ;");
        lines.push("    ; Performs one complete IO-Link master cycle:");
        lines.push("    ;   WAKE -> ENDAT TX (M-sequence) -> TURNAROUND -> ENDAT RX (response)");
        lines.push("    ;");
        lines.push("    ; Parameters:");
        lines.push("    ;   RES         -- Destination register for received response bytes");
        lines.push("    ;   DATA_IN_LO  -- Register with lower 32 bits of TX payload");
        lines.push("    ;   DATA_IN_HI  -- Register with upper 32 bits of TX payload");
        lines.push("    ;   DIR_PIN     -- R30 bit for transceiver direction (0=RX, 1=TX)");
        lines.push("    ;   WAKE_PIN    -- R30 bit for wake-up pulse (driven low for WAKE_LPS)");
        lines.push("    ;   CHANNEL     -- ENDAT channel (0/1/2)");
        lines.push("    ;   CLK_DIV     -- ENDAT TX clock divider");
        lines.push("    ;   TX_BYTES    -- Number of payload bytes to TX (1..16)");
        lines.push("    ;   RX_BYTES    -- Number of bytes expected from device (0..16, 0=skip RX)");
        lines.push("    ;   TURN_BITS   -- Turnaround pause in bit periods (min 4)");
        lines.push("    ;   WAKE_LPS    -- Wake-up delay loop iterations (~5 cy/iter @ 200 MHz)");
        lines.push("    ;   PREAMBLE    -- Preamble byte value (0 = no preamble)");
        lines.push("    ; ================================================================");

        // ---- register setup ----
        lines.push("    ; ---- register setup ----");
        lines.push("    ldi   RES, 0");
        lines.push("    ldi   TEMP_REG1, 0");
        lines.push("    ldi   TEMP_REG2, 0");
        lines.push("    ldi   TEMP_REG3, 0");

        // ---- Phase 1: Wake-up pulse ----
        lines.push("    ; ======== Phase 1: Wake-up pulse ========");
        lines.push("    ; Enable TX driver");
        lines.push("    set   R30, R30, DIR_PIN");
        lines.push("    ; Drive WAKE_PIN low");
        lines.push("    clr   R30, R30, WAKE_PIN");
        lines.push("    ; Hold for WAKE_LPS iterations (~5 cycles each = 25 ns)");
        lines.push("    ldi   TEMP_REG1.w0, WAKE_LPS");
        lines.push("m_iolink_wait_wake?:");
        lines.push("    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1");
        lines.push("    qbne  m_iolink_wait_wake?, TEMP_REG1.w0, 0");
        lines.push("    ; Release wake pin high");
        lines.push("    set   R30, R30, WAKE_PIN");
        lines.push("    ; Disable TX driver (C/Q floats, pull-up holds high)");
        lines.push("    clr   R30, R30, DIR_PIN");
        lines.push("    ; Brief idle before TX (10 loops ~ 250 ns)");
        lines.push("    ldi   TEMP_REG1.w0, 10");
        lines.push("m_iolink_post_wake?:");
        lines.push("    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1");
        lines.push("    qbne  m_iolink_post_wake?, TEMP_REG1.w0, 0");

        // ---- Phase 2: ENDAT TX configuration ----
        lines.push("    ; ======== Phase 2: Configure ENDAT TX ========");
        lines.push("    ; Disable RX, assert global reinit");
        lines.push("    ldi     R30.b3, 0x00");
        lines.push("    set     R31, R31, 19");
        lines.push("    ; Poll reinit busy");
        lines.push("    .if CHANNEL == 0");
        lines.push("m_iolink_wait_reinit_tx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_tx?, R31, 5");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("m_iolink_wait_reinit_tx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_tx?, R31, 13");
        lines.push("    .else");
        lines.push("m_iolink_wait_reinit_tx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_tx?, R31, 21");
        lines.push("    .endif");
        lines.push("    ldi     R30.b3, 0x00");
        lines.push("    ; Set PRU0 peripheral mode via GPCFG0");
        lines.push("    ldi32   TEMP_REG1, 0x04000000");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_GPCFG0");
        lines.push("    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4");
        lines.push("    ; Configure TX clock: [31:16]=CLK_DIV, [4]=0 (192 MHz UART_CLK)");
        lines.push("    ldi     TEMP_REG1.w0, 0");
        lines.push("    ldi     TEMP_REG1.w2, CLK_DIV");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_TXCFG");
        lines.push("    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4");
        lines.push("    ; Configure CHCFG0: frameSize=0 (continuous), bitSwap=1 (LSB-first)");
        lines.push("    ldi     TEMP_REG1, 0");
        lines.push("    set     TEMP_REG1, TEMP_REG1, 31");
        lines.push("    .if CHANNEL == 0");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH0_CFG0");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH1_CFG0");
        lines.push("    .else");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH2_CFG0");
        lines.push("    .endif");
        lines.push("    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4");
        lines.push("    ; Select channel with clk_mode=3");
        lines.push("    .if CHANNEL == 0");
        lines.push("    ldi     R30.w2, 0x0018");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    ldi     R30.w2, 0x0019");
        lines.push("    .else");
        lines.push("    ldi     R30.w2, 0x001A");
        lines.push("    .endif");

        // ---- Phase 3: Build and transmit M-sequence ----
        lines.push("    ; ======== Phase 3: Transmit M-Sequence ========");
        lines.push("    ; Enable TX driver for master transmission");
        lines.push("    set     R30, R30, DIR_PIN");
        lines.push("    ; Wait briefly (5 NOPs) for transceiver to turn on");
        lines.push("    nop");
        lines.push("    nop");
        lines.push("    nop");
        lines.push("    nop");
        lines.push("    nop");
        lines.push("    ; Pack TX data byte into 10-bit UART frame");
        lines.push("    ; Frame: [0]=start(0), [8:1]=data, [9]=stop(1)");
        lines.push("    ; SIMPLIFIED: pack byte 0 only (1-byte TX)");
        lines.push("    ; Multi-byte M-sequences are not implemented: only byte 0 is sent");
        lines.push("    mov     TEMP_REG4.b1, DATA_IN_LO   ; 8-bit data");
        lines.push("    lsl     TEMP_REG4.b1, TEMP_REG4.b1, 1  ; shift for start bit");
        lines.push("    set     TEMP_REG4.b1, TEMP_REG4.b1, 9  ; stop bit at position 9");
        lines.push("    ; Place into TEMP_REG1 bits 9..0");
        lines.push("    mov     TEMP_REG1.b0, TEMP_REG4.b1");
        lines.push("    lsl     TEMP_REG4.b1, TEMP_REG4.b1, 8");
        lines.push("    lsr     TEMP_REG1.b1, TEMP_REG4.b1, 8");
        lines.push("    and     TEMP_REG1.b1, TEMP_REG1.b1, 0x03");

        // ---- Phase 4: ENDAT TX FIFO load and start ----
        lines.push("    ; ======== ENDAT TX FIFO Load ========");
        lines.push("    ; TEMP_REG1 holds packed frame (up to 16 bits for 1 byte)");
        lines.push("    ; Load into FIFO bitSwap=1 (LSB on wire)");
        lines.push("    mov     R30.b0, TEMP_REG1.b0          ; Byte 0");
        lines.push("    .if TX_BYTES >= 2");
        lines.push("    mov     R30.b0, TEMP_REG1.b1          ; Byte 1");
        lines.push("    .endif");
        lines.push("    set     R31, R31, 18                  ; TX GO");
        lines.push("    ; Wait for TX complete (poll busy)");
        lines.push("    .if CHANNEL == 0");
        lines.push("m_iolink_wait_tx?:");
        lines.push("    qbbs    m_iolink_wait_tx?, R31, 5");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("m_iolink_wait_tx?:");
        lines.push("    qbbs    m_iolink_wait_tx?, R31, 13");
        lines.push("    .else");
        lines.push("m_iolink_wait_tx?:");
        lines.push("    qbbs    m_iolink_wait_tx?, R31, 21");
        lines.push("    .endif");
        lines.push("    ; Disable TX driver");
        lines.push("    clr     R30, R30, DIR_PIN");

        // ---- Phase 5: Turnaround ----
        lines.push("    ; ======== Phase 5: Turnaround ========");
        lines.push("    ; Wait TURN_BITS bit periods via nested delay loop");
        lines.push("    ; Inner: ~174 iterations per bit (calibrated for COM3 @ 230.4k)");
        lines.push("    ldi     TEMP_REG1.w0, TURN_BITS");
        lines.push("    ldi     TEMP_REG2.w0, 174");
        lines.push("m_iolink_turn_check?:");
        lines.push("    sub     TEMP_REG1.w0, TEMP_REG1.w0, 1");
        lines.push("    qbeq    m_iolink_turn_done?, TEMP_REG1.w0, 0");
        lines.push("    mov     TEMP_REG4.w0, TEMP_REG2.w0");
        lines.push("m_iolink_turn_inner?:");
        lines.push("    sub     TEMP_REG4.w0, TEMP_REG4.w0, 1");
        lines.push("    qbne    m_iolink_turn_inner?, TEMP_REG4.w0, 0");
        lines.push("    qbne    m_iolink_turn_check?, TEMP_REG1.w0, 1");
        lines.push("m_iolink_turn_done?:");
        lines.push("    nop");
        lines.push("    nop");

        // ---- Phase 6: ENDAT RX ----
        lines.push("    ; ======== Phase 6: Configure and Receive ENDAT RX ========");
        lines.push("    .if RX_BYTES > 0");
        lines.push("    ; ENDAT reinit for RX");
        lines.push("    ldi     R30.b3, 0x00");
        lines.push("    set     R31, R31, 19");
        lines.push("    .if CHANNEL == 0");
        lines.push("m_iolink_wait_reinit_rx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_rx?, R31, 5");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("m_iolink_wait_reinit_rx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_rx?, R31, 13");
        lines.push("    .else");
        lines.push("m_iolink_wait_reinit_rx?:");
        lines.push("    qbbs    m_iolink_wait_reinit_rx?, R31, 21");
        lines.push("    .endif");
        lines.push("    ldi     R30.b3, 0x00");
        lines.push("    ; Configure RXCFG: oversample=0 (1x), clkDiv=CLK_DIV");
        lines.push("    ldi     TEMP_REG1.w0, 0");
        lines.push("    ldi     TEMP_REG1.w2, CLK_DIV");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_RXCFG");
        lines.push("    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4");
        lines.push("    ; Configure CHCFG0: frameSize=10, bitSwap=1 (LSB first)");
        lines.push("    ldi     TEMP_REG1, 0");
        lines.push("    set     TEMP_REG1, TEMP_REG1, 31");
        lines.push("    ldi     TEMP_REG1.w0, (10 << 11)");
        lines.push("    .if CHANNEL == 0");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH0_CFG0");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH1_CFG0");
        lines.push("    .else");
        lines.push("    ldi     TEMP_REG2.w0, ICSS_CFG_PRU0_ENDAT_CH2_CFG0");
        lines.push("    .endif");
        lines.push("    sbco    &TEMP_REG1, ICSS_CFG, TEMP_REG2.w0, 4");
        lines.push("    ; Enable RX");
        lines.push("    .if CHANNEL == 0");
        lines.push("    set     R30, R30, 24");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    set     R30, R30, 25");
        lines.push("    .else");
        lines.push("    set     R30, R30, 26");
        lines.push("    .endif");
        lines.push("    ; Poll for valid frame byte");
        lines.push("    ldi     TEMP_REG3.b0, RX_BYTES");
        lines.push("m_iolink_rx_next_byte?:");
        lines.push("    ; Poll valid flag");
        lines.push("    .if CHANNEL == 0");
        lines.push("m_iolink_rx_wait_valid?:");
        lines.push("    qbbc    m_iolink_rx_wait_valid?, R31, 24");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("m_iolink_rx_wait_valid?:");
        lines.push("    qbbc    m_iolink_rx_wait_valid?, R31, 25");
        lines.push("    .else");
        lines.push("m_iolink_rx_wait_valid?:");
        lines.push("    qbbc    m_iolink_rx_wait_valid?, R31, 26");
        lines.push("    .endif");
        lines.push("    ; Read FIFO byte and accumulate in RES");
        lines.push("    mov     TEMP_REG4.b0, R30.b0");
        lines.push("    lsl     RES, RES, 8");
        lines.push("    or      RES, RES, TEMP_REG4.b0");
        lines.push("    ; Clear valid flag by toggling RX");
        lines.push("    .if CHANNEL == 0");
        lines.push("    clr     R30, R30, 24");
        lines.push("    set     R30, R30, 24");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    clr     R30, R30, 25");
        lines.push("    set     R30, R30, 25");
        lines.push("    .else");
        lines.push("    clr     R30, R30, 26");
        lines.push("    set     R30, R30, 26");
        lines.push("    .endif");
        lines.push("    sub     TEMP_REG3.b0, TEMP_REG3.b0, 1");
        lines.push("    qbne    m_iolink_rx_next_byte?, TEMP_REG3.b0, 0");
        lines.push("    ; Disable RX");
        lines.push("    .if CHANNEL == 0");
        lines.push("    clr     R30, R30, 24");
        lines.push("    .elseif CHANNEL == 1");
        lines.push("    clr     R30, R30, 25");
        lines.push("    .else");
        lines.push("    clr     R30, R30, 26");
        lines.push("    .endif");
        lines.push("    .endif ; RX_BYTES > 0");

        // ---- Phase 7: Cleanup ----
        lines.push("    ; ======== Phase 7: Cleanup ========");
        lines.push("    clr     R30, R30, DIR_PIN");
        lines.push("    set     R31, R31, 19");
        lines.push("    ldi     TEMP_REG1.w0, 20");
        lines.push("m_iolink_cleanup_delay?:");
        lines.push("    sub     TEMP_REG1.w0, TEMP_REG1.w0, 1");
        lines.push("    qbne    m_iolink_cleanup_delay?, TEMP_REG1.w0, 0");
        lines.push("    ldi     R30.b3, 0x00");
        lines.push("    .endm");

        return getIcssCfgDefinitions() + "\n" + lines.join("\n");
    },

    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.dirPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.wakePin), dir: "GPO" });
            return pins;
        },
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    }
};

exports = iolinkModule;
