"use strict";
const endatModule = {
    displayName: "EnDat 2.2 Initiator",
    defaultInstanceName: "ENDAT_INITIATOR_",
    description: "EnDat 2.2 absolute encoder initiator (staged scope: position mode command TX + position telegram RX).",
    longDescription: `Heidenhain EnDat 2.2 initiator (RS-485, up to 2 Mbps without propagation-delay compensation). Staged implementation slice: position mode command + position telegram with CRC check and recovery idle.\n\nFRAMING: CLOCK idles HIGH (H p.6). The first falling clock edge starts the transfer and latches the position; after two clock pulses (2T, t1Clocks) the master sends the 6-bit mode command M2 M1 M0 plus its redundant copy, MSB first, with NO CRC (H p.7). modeCommand 000111 (7) = "encoder send position values" (EnDat 2.1 command set), 111000 (56) = "send position value with additional data" (EnDat 2.2 set). The master then releases DATA and keeps clocking through the encoder's calculation time until the start bit (DATA = 1), giving up after timeoutCycles clocks (status bit1, RES 0). ABSENT ENCODER: a transceiver with fail-safe biasing (failsafe=1, the common part default) reads an unplugged or dead encoder as a steady HIGH line, i.e. an immediate start bit and then all-ones data, so it reports CRC error + F1 (status 0x5), NOT "no start bit" (bit1); bit1 is only seen with a line that stays LOW (no fail-safe bias, or a dead driver). Reply: start bit S = 1 | F1 (error 1) | F2 (error 2, EnDat 2.2 commands only, transmitted inverted) | position, LSB first | CRC-5, MSB first (H p.8-9). CRC (TI endat_make_crc_pos): x^5+x^3+x+1, all flip-flops preset to 1, over F1 [F2] and the position bits in wire order (start bit excluded), register inverted. DATA_RX is sampled at the rising clock edge (TI AM243x TRM 6.4.5.2.2.3.6: captured on the positive edge). Status in TEMP_REG2.b0: bit0=CRC error, bit1=no start bit, bit2=F1 (error 1), bit3=error 2. RES holds the raw telegram (MSB = start bit); the position is LSB first on the wire, so the caller reverses the position field (as TI's driver does).\n\nPINS: one RS-485 transceiver per encoder: CLOCK out on one R30 bit, DATA driven through the transceiver driver from DATA_TX (R30) with its driver enable on DATA_EN (R30, DE = 1 only during the lead-in and the mode command), and the receiver output on DATA_RX (R31). TI's EnDat receiver uses the same split (pins endat_out, endat_out_en, endat_in). A PRU pad is either an input or an output, so TX, EN and RX must be different pad indices.\n\nSTAGED SCOPE (NOT implemented): other mode commands (parameters, memory area selection, reset, test values), additional data 1/2 and the EnDat 2.2 command supplement (MRS code), telegrams longer than 32 bits (needs a second accumulator register), propagation-delay compensation for clock rates above 2 MHz (requires IEP timestamping).\n\nPeripheral resources (selection rule): the hard EnDat peripheral (PRU-ICSSG three-channel peripheral interface) is preferred when available and correctly pinned; fallback is bit-banged PRU via an RS-485 transceiver - the staged PRU initiator consumes zero dedicated peripheral instances (no UART/SPI/IEP required in fallback). All four pins must sit on the same PRU-ICSSG slice through pinmux (AM64x/AM243x/AM261x). Isolation: the owning PRU slice must be the only master driving CLK_PIN, DATA_TX_PIN and DATA_EN_PIN during a telegram. Concurrent workload: the transfer is a busy-wait delay-loop sequence; the PRU cannot service other blocks mid-telegram (budget documented in noOfCycles). Deterministic timing: every clock half-period is a calibrated delay loop (halfPeriodCycles); at 200 MHz PRU, halfPeriodCycles=25 gives ~1.9 MHz, and trecCycles=1000 gives 10 us of recovery. BOM/part: one RS-485 transceiver with driver enable per encoder channel (e.g. SN65HVD / THVD class), termination per the EnDat cable spec. Simulator validation: the real clpru ELF of a one-block design runs on TI pru-simulator in a closed loop against TI pru-simulator's EnDat encoder model through its RS-485 transceiver model (models not in every pru-simulator revision; tests/test_endat_framing.py); EnDat is not yet selectable in the gmake sim front door (ported:false). Physical propagation delay and transceiver switching glitches require silicon validation.`,
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "singleTurnBits", displayName: "Single-turn bits (LSBs)", default: 13 },
        { name: "multiTurnBits", displayName: "Multi-turn bits (above ST)", default: 10 },
        { name: "totalBits", displayName: "Total telegram bits", default: 30, description: "Must equal 1 start + error bits (1 for 000111, 2 for 111000) + ST + MT + 5 CRC bits (max 32)" },
        { name: "modeCommand", displayName: "Mode command (6-bit)", default: 7, description: "EnDat position mode command, sent MSB first after the 2T lead-in: 7 = 000111 (send position values, EnDat 2.1 set, reply S F1 position CRC), 56 = 111000 (send position value with additional data, EnDat 2.2 set, reply S F1 F2 position CRC)" },
        { name: "clkPin", displayName: "CLOCK Pin (R30 bit)", default: 0 },
        { name: "dataTxPin", displayName: "DATA TX Pin (R30 bit)", default: 1, description: "RS-485 transceiver driver input (master -> encoder data)" },
        { name: "dataRxPin", displayName: "DATA RX Pin (R31 bit)", default: 2, description: "RS-485 transceiver receiver output (encoder -> master data, same differential pair)" },
        { name: "dataEnPin", displayName: "DATA EN Pin (R30 bit)", default: 3, description: "RS-485 transceiver driver enable (DE): high only during the lead-in and the mode command (TI EnDat pin endat_out_en)" },
        { name: "halfPeriodCycles", displayName: "Half-period delay loops", default: 25, description: "Delay iterations per clock half-period; 25 ~ 2 Mbps at 200 MHz PRU (RS-422; 2 Mbps ceiling, faster half-periods fault in the pru-simulator EnDat encoder model)" },
        { name: "t1Clocks", displayName: "t1 free clocks before command", default: 2, description: "Clock pulses issued after clock start before master command TX (encoder startup)" },
        { name: "trtCycles", displayName: "Turn-around delay loops (tRT)", default: 20, description: "Idle loops between releasing DATA (DE = 0) after the mode command and the first calculation-time clock" },
        { name: "trecCycles", displayName: "Recovery delay loops (tRec)", default: 1000, description: "Idle loops after clock stop before the next telegram may start; strict 10 us recovery (1000 ≈ 2000 cycles = 10 us at 200 MHz PRU; shorter tRec faults in the pru-simulator EnDat encoder model)" },
        { name: "timeoutCycles", displayName: "Start-bit timeout (clocks)", default: 100, description: "Clock pulses the master gives the encoder to finish its calculation time (tcal, typically 5 us) and send the start bit; status bit1 if none arrives. 100 clocks at ~1.9 MHz is ~52 us" },
        { name: "opCode", default: "m_endat_read", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 13, hidden: true },
        { name: "constant1", default: 7, hidden: true, getValue: (inst) => inst.modeCommand },
        { name: "constant2", default: 30, hidden: true, getValue: (inst) => inst.totalBits },
        { name: "constant3", default: 13, hidden: true, getValue: (inst) => inst.singleTurnBits },
        { name: "constant4", default: 10, hidden: true, getValue: (inst) => inst.multiTurnBits },
        { name: "constant5", default: 0, hidden: true, getValue: (inst) => inst.clkPin },
        { name: "constant6", default: 1, hidden: true, getValue: (inst) => inst.dataTxPin },
        { name: "constant7", default: 2, hidden: true, getValue: (inst) => inst.dataRxPin },
        { name: "constant8", default: 25, hidden: true, getValue: (inst) => inst.halfPeriodCycles },
        { name: "constant9", default: 2, hidden: true, getValue: (inst) => inst.t1Clocks },
        { name: "constant10", default: 20, hidden: true, getValue: (inst) => inst.trtCycles },
        { name: "constant11", default: 1000, hidden: true, getValue: (inst) => inst.trecCycles },
        { name: "constant12", default: 100, hidden: true, getValue: (inst) => inst.timeoutCycles },
        { name: "constant13", default: 3, hidden: true, getValue: (inst) => inst.dataEnPin },
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => {
            const tb = inst.totalBits || 30;
            const hp = inst.halfPeriodCycles || 25;
            const pulse = 4 + 4 * hp;                        // clr + delay + set + delay (one clock pulse)
            const idle = 3 + 2 * hp;                         // idle-high settle before the first low pulse
            const t1 = (inst.t1Clocks || 2) * (pulse + 3);
            const tx = 6 * (pulse + 6);                      // data drive + pulse + shift/counter
            const trt = 3 + 2 * (inst.trtCycles || 20);
            const hunt = 1 * (pulse + 6);                    // best case: start bit on the first tcal clock
            const rx = (tb - 1) * (pulse + 5);               // pulse + lsl/qbbc/or/sub/qbne
            const crc = (tb - 6) * 9 + 30;
            const trec = 1 + 2 * (inst.trecCycles || 1000);
            return idle + t1 + tx + trt + hunt + rx + crc + trec + 50;
        }, default: 6538 }
    ],
    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "output1", type: "output32" }
        ];
    },
    validate(inst, validation) {
        const errorBits = inst.modeCommand === 56 ? 2 : 1;   // F2 only for EnDat 2.2 commands (H p.8)
        const maxPos = 32 - 6 - errorBits;
        if (inst.modeCommand !== 7 && inst.modeCommand !== 56) validation.logError("modeCommand must be 7 (000111, send position values) or 56 (111000, position with additional data); other EnDat mode commands are not implemented", inst, "modeCommand");
        if (inst.singleTurnBits < 1 || inst.singleTurnBits > maxPos) validation.logError(`singleTurnBits must be 1..${maxPos} (telegram must fit 32 bits)`, inst, "singleTurnBits");
        if (inst.multiTurnBits < 0 || inst.multiTurnBits > maxPos) validation.logError(`multiTurnBits must be 0..${maxPos}`, inst, "multiTurnBits");
        if ((inst.singleTurnBits + inst.multiTurnBits) > maxPos) validation.logError(`singleTurnBits + multiTurnBits must be <= ${maxPos} (1 start + ${errorBits} error + position + 5 CRC <= 32 bits)`, inst, "singleTurnBits");
        if (inst.totalBits !== (inst.singleTurnBits + inst.multiTurnBits + 6 + errorBits)) validation.logError(`totalBits must equal 1 start + ${errorBits} error + ST + MT + 5 CRC bits`, inst, "totalBits");
        const pins = [inst.clkPin, inst.dataTxPin, inst.dataRxPin, inst.dataEnPin];
        if (new Set(pins).size !== pins.length) validation.logError("clkPin, dataTxPin, dataEnPin and dataRxPin must all differ (a PRU pad is an input or an output, and TX, DE and RX are separate transceiver pins)", inst, "clkPin");
        if (inst.clkPin < 0 || inst.clkPin > 15) validation.logError("clkPin must be 0..15", inst, "clkPin");
        if (inst.dataTxPin < 0 || inst.dataTxPin > 15) validation.logError("dataTxPin must be 0..15", inst, "dataTxPin");
        if (inst.dataEnPin < 0 || inst.dataEnPin > 15) validation.logError("dataEnPin must be 0..15", inst, "dataEnPin");
        if (inst.dataRxPin < 0 || inst.dataRxPin > 15) validation.logError("dataRxPin must be 0..15", inst, "dataRxPin");
        if (inst.halfPeriodCycles < 2) validation.logError("halfPeriodCycles too small (min 2)", inst, "halfPeriodCycles");
        if (inst.halfPeriodCycles < 25) validation.logWarning("halfPeriodCycles below 25 exceeds the 2 MHz clock ceiling without propagation-delay compensation (H p.6)", inst, "halfPeriodCycles");
        if (inst.t1Clocks !== 2) validation.logWarning("EnDat sends the mode command after two clock pulses (2T, H p.8); other t1Clocks values misframe the command", inst, "t1Clocks");
        if (inst.timeoutCycles < 1 || inst.timeoutCycles > 65535) validation.logError("timeoutCycles must be 1..65535", inst, "timeoutCycles");
        if (inst.trecCycles < 500) validation.logError("trecCycles below 500 violates the 10 us recovery time (need >=1000 at 200 MHz)", inst, "trecCycles");
        if (inst.trecCycles < 1000) validation.logWarning("trecCycles below 1000 is below the 10 us recovery target (2000 cycles at 200 MHz)", inst, "trecCycles");
    },
    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, MODE_CMD, TOTAL_BITS, ST_BITS, MT_BITS, CLK_PIN, DATA_TX_PIN, DATA_RX_PIN, HALF_PERIOD, T1_CLOCKS, TRT_CYCLES, TREC_CYCLES, TIMEOUT_CYCLES, DATA_EN_PIN`,
            `    ; --- EnDat 2.2 Initiator (RS-485 transceiver: TX + DE on R30, RX on R31; 2 Mbps; CRC-5; tRec) ---`,
            `    ; Framing per HEIDENHAIN EnDat 2.2 Technical Information ID 383942 (H) and TI MCU+ Motor Control SDK`,
            `    ; endat_drv.c (TI); page references below are to H.`,
            `    ; Transfer: CLK idles HIGH (H p.6); the first falling edge latches the position; T1_CLOCKS (2T) lead-in pulses;`,
            `    ;   6-bit MODE_CMD = M2 M1 M0 + redundant copy, MSB first, no CRC (H p.7); DE released; the master keeps`,
            `    ;   clocking through tcal until the start bit (DATA = 1), at most TIMEOUT_CYCLES clocks; then TOTAL_BITS-1 bits.`,
            `    ; DATA_RX is sampled at the end of each low phase, i.e. at the rising edge (TRM: captured on the positive edge).`,
            `    ; RES = TOTAL_BITS bits, MSB = first bit received: S(=1) | F1 | F2 (EnDat 2.2 commands only) | P0..P(n-1)`,
            `    ;   (position LSB first, so P_i sits at bit TOTAL_BITS-2-E-i, E = error bits) | CRC4..CRC0`,
            `    ; E = TOTAL_BITS - ST_BITS - MT_BITS - 6: 1 for 000111 (2.1 set), 2 for 111000 (2.2 set) (H p.8)`,
            `    ; TEMP_REG2.b0 status: bit0=CRC error, bit1=no start bit within TIMEOUT_CYCLES clocks, bit2=F1 (error 1),`,
            `    ;   bit3=error 2 (F2 is sent inverted, H p.9: set when F2 = 0)`,
            `    ldi   RES, 0`,
            `    ldi   TEMP_REG2.b0, 0            ; status = 0`,
            `    set   R30, R30, CLK_PIN          ; clock idles HIGH (EnDat); each bit is a low pulse, so the frame ends high`,
            `    clr   R30, R30, DATA_TX_PIN`,
            `    clr   R30, R30, DATA_EN_PIN      ; transceiver in receive (DE = 0)`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD   ; hold the idle-high level one half period so the first low pulse is not a runt`,
            `m_endat_idle?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_idle?, TEMP_REG4.w0, 0`,
            `    set   R30, R30, DATA_EN_PIN      ; master drives the line (TX = 0) for the lead-in and the mode command`,
            `    ; --- t1: T1_CLOCKS lead-in pulses; the first falling edge starts the transfer (H p.8: 2T) ---`,
            `    ldi   TEMP_REG1.b0, T1_CLOCKS`,
            `m_endat_t1?:`,
            `    clr   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_t1d1?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_t1d1?, TEMP_REG4.w0, 0`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_t1d2?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_t1d2?, TEMP_REG4.w0, 0`,
            `    sub   TEMP_REG1.b0, TEMP_REG1.b0, 1`,
            `    qbne  m_endat_t1?, TEMP_REG1.b0, 0`,
            `    ; --- mode command: 6 bits, MSB first (M2 first), no CRC (H p.7) ---`,
            `    ldi   TEMP_REG3, MODE_CMD`,
            `    ldi   TEMP_REG1.b0, 6`,
            `m_endat_tx?:`,
            `    qbbc  m_endat_tx0?, TEMP_REG3, 5`,
            `    set   R30, R30, DATA_TX_PIN`,
            `    qba   m_endat_txd?`,
            `m_endat_tx0?:`,
            `    clr   R30, R30, DATA_TX_PIN`,
            `m_endat_txd?:`,
            `    clr   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_txd1?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_txd1?, TEMP_REG4.w0, 0`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_txd2?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_txd2?, TEMP_REG4.w0, 0`,
            `    lsl   TEMP_REG3, TEMP_REG3, 1`,
            `    sub   TEMP_REG1.b0, TEMP_REG1.b0, 1`,
            `    qbne  m_endat_tx?, TEMP_REG1.b0, 0`,
            `    ; --- turn-around: release the line (DE = 0), wait tRT ---`,
            `    clr   R30, R30, DATA_TX_PIN`,
            `    clr   R30, R30, DATA_EN_PIN`,
            `    ldi   TEMP_REG4.w0, TRT_CYCLES`,
            `m_endat_trt?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_trt?, TEMP_REG4.w0, 0`,
            `    ; --- tcal: keep clocking until the start bit (DATA = 1), at most TIMEOUT_CYCLES clocks (H p.8) ---`,
            `    ldi   TEMP_REG1.w0, TIMEOUT_CYCLES`,
            `m_endat_sb?:`,
            `    clr   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_sbd1?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_sbd1?, TEMP_REG4.w0, 0`,
            `    qbbs  m_endat_sbok?, R31, DATA_RX_PIN  ; sample at the rising edge`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_sbd2?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_sbd2?, TEMP_REG4.w0, 0`,
            `    sub   TEMP_REG1.w0, TEMP_REG1.w0, 1`,
            `    qbne  m_endat_sb?, TEMP_REG1.w0, 0`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 2  ; no start bit: framing error, the checks are skipped`,
            `    qba   m_endat_stop?`,
            `m_endat_sbok?:`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_sbd3?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_sbd3?, TEMP_REG4.w0, 0`,
            `    ldi   RES, 1                     ; the start bit`,
            `    ; --- RX: TOTAL_BITS-1 bits after the start bit, MSB-first accumulation ---`,
            `    ldi   TEMP_REG1.b0, (TOTAL_BITS - 1)`,
            `m_endat_rx?:`,
            `    clr   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_rxd1?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_rxd1?, TEMP_REG4.w0, 0`,
            `    lsl   RES, RES, 1`,
            `    qbbc  m_endat_rx0?, R31, DATA_RX_PIN  ; sample at the rising edge`,
            `    or    RES, RES, 1`,
            `m_endat_rx0?:`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, HALF_PERIOD`,
            `m_endat_rxd2?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_rxd2?, TEMP_REG4.w0, 0`,
            `    sub   TEMP_REG1.b0, TEMP_REG1.b0, 1`,
            `    qbne  m_endat_rx?, TEMP_REG1.b0, 0`,
            `m_endat_stop?:`,
            `    ; --- clock stays HIGH + recovery idle (tRec, H p.8 tm) ---`,
            `    set   R30, R30, CLK_PIN`,
            `    ldi   TEMP_REG4.w0, TREC_CYCLES`,
            `m_endat_trec?:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  m_endat_trec?, TEMP_REG4.w0, 0`,
            `    qbbs  m_endat_crck?, TEMP_REG2.b0, 1  ; no frame to check`,
            `    ; --- F1 = error 1 (active high) ---`,
            `    qbbc  m_endat_f1?, RES, (TOTAL_BITS - 2)`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 4`,
            `m_endat_f1?:`,
            `    ; --- F2 = error 2: only for EnDat 2.2 commands, sent inverted (H p.9) ---`,
            `    ldi   TEMP_REG4.b0, (TOTAL_BITS - ST_BITS - MT_BITS - 6)`,
            `    qbne  m_endat_f2?, TEMP_REG4.b0, 2`,
            `    qbbs  m_endat_f2?, RES, (TOTAL_BITS - 3)`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 8`,
            `m_endat_f2?:`,
            `    ; --- CRC-5 (TI endat_drv.c endat_make_crc_pos): x^5+x^3+x+1, init 11111, over F1 [F2] + position in`,
            `    ;     wire order (start bit excluded), result inverted, MSB first ---`,
            `    ldi   TEMP_REG1, 0x1F                    ; crc accumulator, all ones`,
            `    lsr   TEMP_REG3, RES, 5                  ; S + covered bits (CRC field stripped)`,
            `    ldi   TEMP_REG4, (32 - (TOTAL_BITS - 6))  ; left-align: the start bit falls off, F1 lands at bit 31`,
            `    lsl   TEMP_REG3, TEMP_REG3, TEMP_REG4`,
            `    ldi   TEMP_REG4.b0, (TOTAL_BITS - 7)     ; covered bit count - 1 (loop processes bit then decrements; exits on wrap)`,
            `m_endat_crcl?:`,
            `    qbbs  m_endat_ct1?, TEMP_REG1, 4         ; crc top bit`,
            `    qbbs  m_endat_cd10?, TEMP_REG3, 31       ; top=0: data bit?`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1            ; top=0,d=0: ex=0, shift only`,
            `    and   TEMP_REG1, TEMP_REG1, 0x1F`,
            `    qba   m_endat_cnx?`,
            `m_endat_cd10?:`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1            ; top=0,d=1: ex=1, shift+xor`,
            `    and   TEMP_REG1, TEMP_REG1, 0x1F`,
            `    xor   TEMP_REG1, TEMP_REG1, 0x0B         ; x^3+x+1 (x^5 term implicit)`,
            `    qba   m_endat_cnx?`,
            `m_endat_ct1?:`,
            `    qbbs  m_endat_cd11?, TEMP_REG3, 31       ; top=1: data bit?`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1            ; top=1,d=0: ex=1, shift+xor`,
            `    and   TEMP_REG1, TEMP_REG1, 0x1F`,
            `    xor   TEMP_REG1, TEMP_REG1, 0x0B`,
            `    qba   m_endat_cnx?`,
            `m_endat_cd11?:`,
            `    lsl   TEMP_REG1, TEMP_REG1, 1            ; top=1,d=1: ex=0, shift only`,
            `    and   TEMP_REG1, TEMP_REG1, 0x1F`,
            `m_endat_cnx?:`,
            `    lsl   TEMP_REG3, TEMP_REG3, 1            ; next data bit to bit 31`,
            `    sub   TEMP_REG4.b0, TEMP_REG4.b0, 1`,
            `    qbbc  m_endat_crcl?, TEMP_REG4.b0, 5      ; loop while counter not wrapped below zero`,
            `    xor   TEMP_REG1, TEMP_REG1, 0x1F         ; inverted output`,
            `    and   TEMP_REG3, RES, 0x1F               ; received CRC field`,
            `    qbeq  m_endat_crck?, TEMP_REG1, TEMP_REG3`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 1      ; CRC mismatch`,
            `m_endat_crck?:`,
            `    ; Caller: test TEMP_REG2.b0 for nonzero to detect faults before using RES`,
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
            pins.push({ pin: parseInt(inst.clkPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dataTxPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dataEnPin), dir: "GPO" });
            pins.push({ pin: parseInt(inst.dataRxPin), dir: "GPI" });
            return pins;
        },
        modules: function(inst) {
            return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }];
        },
    },
};
exports = endatModule;
