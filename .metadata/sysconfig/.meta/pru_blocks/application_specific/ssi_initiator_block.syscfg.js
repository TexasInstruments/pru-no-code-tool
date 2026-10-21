"use strict";
const ssiModule = {
    displayName: "SSI Initiator",
    defaultInstanceName: "SSI_INITIATOR_",
    description: "Synchronous SSI absolute encoder initiator (generic).",
    longDescription: `Generic synchronous SSI initiator with configurable frame width (8-32), single-turn/multi-turn extraction, clock polarity/rate, optional parity and error bits, gray/binary decode, and timeout.\n\nPeripheral resources: bit-bangs one R30 clock output and one R31 data input; no PRU peripherals (IEP/MAC/SPAD) required. Pinmux: clock and data must be on distinct PRU R30/R31 bits routed through PRU-ICSSG pinmux (AM64x/AM243x/AM261x). Isolation: single PRU slice owns both pins during transfer; concurrent workloads must not drive the same R30 bit and must avoid R31 contention. Deterministic timing: each clock half-period uses halfPeriodCycles delay-loop iterations, each costing two PRU cycles; monoTimeCycles likewise counts two-cycle idle iterations. The per-bit clock path costs about 4*halfPeriodCycles plus instruction overhead. TIMEOUT_CYCLES is reserved and does not run a delay loop. BOM: RS-422/RS-485 transceiver required for differential SSI (e.g. AM26C31/32); no BOM change for single-ended test. Simulator validates logical shift, gray decode, parity and extraction; physical propagation delay, transceiver skew and monoflop timing require silicon validation.`,
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "totalWidth", displayName: "Total frame width (bits)", default: 25, description: "Total SSI bits clocked per frame (8-32)" },
        { name: "singleTurnBits", displayName: "Single-turn bits (LSBs)", default: 13 },
        { name: "multiTurnBits", displayName: "Multi-turn bits (above ST)", default: 12 },
        { name: "clkPin", displayName: "CLK Pin (R30 bit)", default: 0 },
        { name: "dataPin", displayName: "DATA Pin (R31 bit)", default: 1 },
        { name: "clockPolarity", displayName: "Clock idle polarity (1=high, SSI standard; 0=inverted line)", default: 1, description: "1: clock idles HIGH, the SSI convention (Hengstler AC58, P+F AVM78E/AVS36M) and what the simulator's SSI encoder model speaks. 0: every clock level inverted, for an inverting line driver between PRU and encoder; the simulator model does not attach inverted, so 0 is not simulator-verified." },
        { name: "halfPeriodCycles", displayName: "Half-period delay loops", default: 10, description: "Delay iterations per half clock period; defines clock rate" },
        { name: "monoTimeCycles", displayName: "Monoflop timeout loops", default: 20, description: "Idle delay after frame before next transfer" },
        { name: "parityEnable", displayName: "Parity bit present (last bit)", default: false },
        { name: "parityType", displayName: "Parity type (0=even,1=odd)", default: 0 },
        { name: "errorBitEnable", displayName: "Error bit present (bit before parity or last bit)", default: false },
        { name: "grayCode", displayName: "Gray-coded payload", default: true },
        { name: "timeoutCycles", displayName: "Stuck-data timeout loops", default: 100 },
        { name: "opCode", default: "m_ssi_read", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 13, hidden: true },
        // Positional order MUST match the .macro line in getMacro(): RES, TOTAL_WIDTH, ST_BITS, MT_BITS, CLK_PIN, DATA_PIN, CPOL,
        // HALF_PERIOD, MONO_CYCLES, PARITY_EN, PARITY_TYPE, ERR_EN, GRAY_EN, TIMEOUT_CYCLES (arity AND order are checked by
        // tests/test_ssi_syscfg.py, which decodes the generated firmware against an SSI encoder model).
        { name: "constant1", default: 25, hidden: true, getValue: (inst) => inst.totalWidth }, // totalWidth
        { name: "constant2", default: 13, hidden: true, getValue: (inst) => inst.singleTurnBits }, // singleTurnBits
        { name: "constant3", default: 12, hidden: true, getValue: (inst) => inst.multiTurnBits }, // multiTurnBits
        { name: "constant4", default: 0, hidden: true, getValue: (inst) => inst.clkPin }, // clkPin
        { name: "constant5", default: 1, hidden: true, getValue: (inst) => inst.dataPin }, // dataPin
        { name: "constant6", default: 1, hidden: true, getValue: (inst) => inst.clockPolarity }, // clockPolarity
        { name: "constant7", default: 10, hidden: true, getValue: (inst) => inst.halfPeriodCycles }, // halfPeriodCycles
        { name: "constant8", default: 20, hidden: true, getValue: (inst) => inst.monoTimeCycles }, // monoTimeCycles
        { name: "constant9", default: 0, hidden: true, getValue: (inst) => inst.parityEnable ? 1 : 0 }, // parityEnable
        { name: "constant10", default: 0, hidden: true, getValue: (inst) => inst.parityType }, // parityType
        { name: "constant11", default: 0, hidden: true, getValue: (inst) => inst.errorBitEnable ? 1 : 0 }, // errorBitEnable
        { name: "constant12", default: 1, hidden: true, getValue: (inst) => inst.grayCode ? 1 : 0 }, // grayCode
        { name: "constant13", default: 100, hidden: true, getValue: (inst) => inst.timeoutCycles }, // timeoutCycles
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => {
            const w = inst.totalWidth || 25;
            const hp = inst.halfPeriodCycles || 10;
            // Two half-period loops cost 4*hp per bit; include the first
            // idle hold, end-of-frame pulse and two-cycle monoflop trips.
            return w * (9 + 4 * hp) + 4 * hp + 2 * (inst.monoTimeCycles || 20) + 40;
        }, default: 1345 }
    ],
    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "output1", type: "output32" }
        ];
    },
    validate(inst, validation) {
        if (inst.totalWidth < 8 || inst.totalWidth > 32) validation.logError("totalWidth must be 8..32", inst, "totalWidth");
        if (inst.singleTurnBits < 1 || inst.singleTurnBits > 32) validation.logError("singleTurnBits must be 1..32", inst, "singleTurnBits");
        if (inst.multiTurnBits < 0 || inst.multiTurnBits > 32) validation.logError("multiTurnBits must be 0..32", inst, "multiTurnBits");
        if ((inst.singleTurnBits + inst.multiTurnBits) > inst.totalWidth) {
            // allow parity/error bits to consume remainder; just ensure ST+MT <= total
            if ((inst.singleTurnBits + inst.multiTurnBits) > inst.totalWidth) validation.logError("singleTurnBits + multiTurnBits must be <= totalWidth", inst, "singleTurnBits");
        }
        if (inst.clkPin === inst.dataPin) validation.logError("clkPin and dataPin must differ", inst, "clkPin");
        if (inst.clkPin < 0 || inst.clkPin > 15) validation.logError("clkPin must be 0..15", inst, "clkPin");
        if (inst.dataPin < 0 || inst.dataPin > 15) validation.logError("dataPin must be 0..15", inst, "dataPin");
        if (inst.halfPeriodCycles < 2) validation.logError("halfPeriodCycles too small (min 2)", inst, "halfPeriodCycles");
    },
    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, TOTAL_WIDTH, ST_BITS, MT_BITS, CLK_PIN, DATA_PIN, CPOL, HALF_PERIOD, MONO_CYCLES, PARITY_EN, PARITY_TYPE, ERR_EN, GRAY_EN, TIMEOUT_CYCLES`,
            `    ; --- SSI Initiator (generic synchronous) ---`,
            `    ; RES = shifted frame (TOTAL_WIDTH bits, MSB first); with GRAY_EN the position payload is converted to binary`,
            `    ; Caller extracts ST/MT via shifts/masks; parity/error checked -> STATUS in TEMP_REG2.b0 (0=ok,1=parity err,2=timeout,4=error bit)`,
            `    ; Frame (SSI datasheet convention, CPOL=1): CLK idles high. The first falling`,
            `    ; edge latches the position; each rising edge shifts out the next bit, MSB first;`,
            `    ; DATA is sampled in the high phase, before the next falling edge. A frame is`,
            `    ; n+1 pulses for n bits: the falling edge after the LSB ends the word (encoder`,
            `    ; drives DATA low for its monoflop time). clockPolarity 0 inverts every clock level.`,
            `    ; Parity: if enabled, last bit is parity over preceding bits`,
            `    ; Error bit: if enabled, bit before parity (or last) is active-low error flag`,
            `    ldi   RES, 0`,
            `    ldi   TEMP_REG1, 0               ; bit counter copy`,
            `    ldi   TEMP_REG2, 0               ; status = 0`,
            `    ; init clock to idle`,
            `    .if CPOL == 1`,
            `    set   R30, R30, CLK_PIN`,
            `    .else`,
            `    clr   R30, R30, CLK_PIN`,
            `    .endif`,
            `    ; hold idle for a half period so the first pulse is full width`,
            `    ldi   TEMP_REG3.w0, HALF_PERIOD`,
            `m_ssi_hp0?:`,
            `    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`,
            `    qbne  m_ssi_hp0?, TEMP_REG3.w0, 0`,
            `    ; bit loop counter = TOTAL_WIDTH`,
            `    ldi   TEMP_REG1.b0, TOTAL_WIDTH`,
            `m_ssi_bitloop?:`,
            `    ; drive clock to active (invert CPOL)`,
            `    .if CPOL == 1`,
            `    clr   R30, R30, CLK_PIN`,
            `    .else`,
            `    set   R30, R30, CLK_PIN`,
            `    .endif`,
            `    ; half-period delay 1`,
            `    ldi   TEMP_REG3.w0, HALF_PERIOD`,
            `m_ssi_hp1?:`,
            `    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`,
            `    qbne  m_ssi_hp1?, TEMP_REG3.w0, 0`,
            `    ; drive clock back to idle`,
            `    .if CPOL == 1`,
            `    set   R30, R30, CLK_PIN`,
            `    .else`,
            `    clr   R30, R30, CLK_PIN`,
            `    .endif`,
            `    ; half-period delay 2`,
            `    ldi   TEMP_REG3.w0, HALF_PERIOD`,
            `m_ssi_hp2?:`,
            `    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`,
            `    qbne  m_ssi_hp2?, TEMP_REG3.w0, 0`,
            `    ; sample DATA in the idle phase, after the shift edge and before the next active edge`,
            `    lsl   RES, RES, 1`,
            `    qbbc  m_ssi_zero?, R31, DATA_PIN`,
            `    or    RES, RES, 1`,
            `m_ssi_zero?:`,
            `    sub   TEMP_REG1.b0, TEMP_REG1.b0, 1`,
            `    qbne  m_ssi_bitloop?, TEMP_REG1.b0, 0`,
            `    ; end-of-frame pulse (n+1): its active edge ends the word, encoder starts its monoflop`,
            `    .if CPOL == 1`,
            `    clr   R30, R30, CLK_PIN`,
            `    .else`,
            `    set   R30, R30, CLK_PIN`,
            `    .endif`,
            `    ldi   TEMP_REG3.w0, HALF_PERIOD`,
            `m_ssi_hp3?:`,
            `    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`,
            `    qbne  m_ssi_hp3?, TEMP_REG3.w0, 0`,
            `    .if CPOL == 1`,
            `    set   R30, R30, CLK_PIN`,
            `    .else`,
            `    clr   R30, R30, CLK_PIN`,
            `    .endif`,
            `    ; monoflop idle delay: monoTimeCycles must cover the encoder's monoflop time`,
            `    ; before the next read, or the encoder sees the next frame as overclocking`,
            `    ldi   TEMP_REG3.w0, MONO_CYCLES`,
            `m_ssi_mono?:`,
            `    sub   TEMP_REG3.w0, TEMP_REG3.w0, 1`,
            `    qbne  m_ssi_mono?, TEMP_REG3.w0, 0`,
            `    ; --- parity check (if enabled) : last bit is parity ---`,
            `    .if PARITY_EN == 1`,
            `    ; compute even parity of bits TOTAL_WIDTH-1..0 excluding last`,
            `    mov   TEMP_REG3, RES`,
            `    and   TEMP_REG3, TEMP_REG3, 1        ; parity bit`,
            `    lsr   TEMP_REG1, RES, 1              ; data without parity`,
            `    ; xor-fold to 1 bit (popcount parity)`,
            `    lsr   TEMP_REG4, TEMP_REG1, 16`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 8`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 4`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 2`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 1`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    and   TEMP_REG1, TEMP_REG1, 1        ; computed even parity`,
            `    .if PARITY_TYPE == 1`,
            `    xor   TEMP_REG1, TEMP_REG1, 1        ; invert for odd`,
            `    .endif`,
            `    qbeq  m_ssi_parity_ok?, TEMP_REG1, TEMP_REG3`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 1  ; parity error`,
            `m_ssi_parity_ok?:`,
            `    .endif`,
            `    ; --- error bit check (if enabled) ---`,
            `    .if ERR_EN == 1`,
            `    .if PARITY_EN == 1`,
            `    ; error bit is bit 1 (second last)`,
            `    lsr   TEMP_REG1, RES, 1`,
            `    and   TEMP_REG1, TEMP_REG1, 1`,
            `    .else`,
            `    and   TEMP_REG1, RES, 1`,
            `    .endif`,
            `    qbne  m_ssi_err_ok?, TEMP_REG1, 0   ; error bit active low => 0 means error? spec varies; treat 0 as error here? we treat 1=ok,0=error for low-active`,
            `    ; Actually SSI error is often 0 = error, so if bit==0 -> flag`,
            `    ; So invert: if TEMP_REG1==0 => error`,
            `    or    TEMP_REG2.b0, TEMP_REG2.b0, 4`,
            `m_ssi_err_ok?:`,
            `    .endif`,
            `    ; --- Gray -> binary on the position payload (after parity: parity covers the raw bits) ---`,
            `    ; Payload sits above the error/parity bits; prefix-XOR folds reflected Gray to binary.`,
            `    .if GRAY_EN == 1`,
            `    lsr   TEMP_REG1, RES, (PARITY_EN + ERR_EN)`,
            `    lsr   TEMP_REG4, TEMP_REG1, 1`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 2`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 4`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 8`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsr   TEMP_REG4, TEMP_REG1, 16`,
            `    xor   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    lsl   TEMP_REG1, TEMP_REG1, (PARITY_EN + ERR_EN)`,
            `    and   RES, RES, ((1 << (PARITY_EN + ERR_EN)) - 1)`,
            `    or    RES, RES, TEMP_REG1`,
            `    .endif`,
            `    ; Caller can test TEMP_REG2.b0 for nonzero to detect fault`,
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
            pins.push({ pin: parseInt(inst.dataPin), dir: "GPI" });
            return pins;
        },
        modules: function(inst) {
            return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }];
        },
    },
};
exports = ssiModule;
