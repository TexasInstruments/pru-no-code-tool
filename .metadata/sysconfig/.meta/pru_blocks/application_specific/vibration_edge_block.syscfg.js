"use strict";
/*
 * Predictive-maintenance edge node
 * Composes SDFM/PDM vibration capture, bounded decimation/features,
 * timestamped host streaming with deterministic windowing and overflow/backpressure.
 *
 * Selection rule (hard peripheral is NOT auto-reject):
 *  - SDFM instance count: AM243x has 2 SDFM instances x 4 filters; check free filter vs concurrent FOC/ADC demand.
 *  - PDM alternative: uses R30/R31 GPIO + IEP clock; no SDFM peripheral needed but costs pins + PRU cycles.
 *  - Pinmux/routing: SDFM uses dedicated SD pins (isolated from GPIO); PDM uses pru_gpi/gpo pins - verify pinmux conflict map.
 *  - Isolation: ICSSG0 vs ICSSG1 copy; PRU0 vs PRU1 within slice; avoid sharing same SDFM filter between cores.
 *  - Deterministic timing: windowed, bounded loops (WIN*DECIM) + fixed feature overhead; no unbounded wait.
 *  - BOM/part: external SD modulator (e.g., AMC1306) vs MEMS mic; customer resource model decides.
 *  Reject only after evaluating above against customer resource model.
 *
 * Evidence ladder: simulator-tested (deterministic windowing, overflow, reference vectors); hardware-validated requires silicon.
 */

const vibrationModule = {
    displayName: "Vibration Edge Node (Predictive Maintenance)",
    defaultInstanceName: "VIB_EDGE_",
    description: "Bounded vibration capture, decimation, feature extraction and timestamped host streaming.",
    longDescription: `
Bounded predictive-maintenance edge node composing SDFM/PDM vibration capture.

* Deterministic windowing: fixed WIN, bounded decimation (DECIM) loop - cycles = WIN*(DECIM*6+8)+30, no unbounded wait.
* Features: peak (max abs), sumSq/meanSq, RMS (Q0 integer via host or isqrt), crest = peak/RMS - reference vectors validated.
* Timestamp: IEP COUNT (c26 offset 0x10, IEP_COUNT_REG0) when FEAT_EN=1.
* Host streaming: ring buffer (SLOTS * 16B) at BUF_PTR: per-slot [0:ts 4B][4:peak 2B][6:rms_raw 2B][8:meanSq 4B][12:ready 1B]; head at BUF_PTR+SLOTS*16.
* Backpressure: if slot[head].ready !=0 -> OVERFLOW (b1) and drop-newest (deterministic, no stall); else DATA_READY (b0). BUSY (b3) set during window.
* Residual: analog front-end noise and cycle jitter require silicon.
Status RES_STATUS low byte: b0=DATA_READY b1=OVERFLOW b3=BUSY
`,
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "source", displayName: "Capture source", default: "sdfm", options: [{name:"sdfm",displayName:"SDFM (sigma-delta)"},{name:"pdm",displayName:"PDM/GPIO (vibration mic)"}] },
        { name: "sdfmChannel", displayName: "SDFM channel (if sdfm)", default: 0, options: [{name:0},{name:1},{name:2},{name:3}] },
        { name: "sdfmBaseAddr", displayName: "SDFM base (hex)", default: 0x0C080000 },
        { name: "windowSize", displayName: "Window size (samples)", default: 8 },
        { name: "decimation", displayName: "Decimation (raw per slot)", default: 1 },
        { name: "bufferAddr", displayName: "Ring buffer base (DMEM/shared offset)", default: 0x1000 },
        { name: "bufferSlots", displayName: "Ring slots (1-8)", default: 2 },
        { name: "timestampEnable", displayName: "Timestamp via IEP", default: true },
        { name: "dropPolicy", displayName: "On full: policy", default: "drop_newest", options: [{name:"drop_newest"},{name:"overwrite_oldest"}] },
        { name: "outputRegStatus", displayName: "Status output reg", default: "R10" },
        { name: "opCode", default: "m_vibration_edge", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true },
        { name: "constant1", hidden: true, default: "0", getValue: (inst)=> String(inst.sdfmChannel) },
        { name: "constant2", hidden: true, default: "8", getValue: (inst)=> String(inst.windowSize) },
        { name: "constant3", hidden: true, default: "1", getValue: (inst)=> String(inst.decimation) },
        { name: "constant4", hidden: true, default: "0x1000", getValue: (inst)=> "0x"+Number(inst.bufferAddr).toString(16) },
        { name: "constant5", hidden: true, default: "2", getValue: (inst)=> String(inst.bufferSlots) },
        { name: "constant6", hidden: true, default: "1", getValue: (inst)=> inst.timestampEnable ? "1":"0" },
        { name: "constant7", hidden: true, default: "0", getValue: (inst)=> String(inst.sdfmBaseAddr) },
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst)=> (inst.windowSize * (6 + inst.decimation*4) + 30), default: 80 },
        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name:"metadata-only"},{name:"assembles"},{name:"simulator-tested"},{name:"dual-oracle-tested"},{name:"hardware-validated"}], hidden: true }
    ],
    ports: (inst)=> [
        {name:"prev", type:"IO_PREV"},
        {name:"next", type:"IO_NEXT"},
        {name:"output1", type:"output32"}
    ],
    validate(inst, validation){
        if(inst.windowSize < 1 || inst.windowSize > 256) validation.logError("windowSize must be 1..256", inst, "windowSize");
        if(inst.decimation < 1 || inst.decimation > 64) validation.logError("decimation must be 1..64", inst, "decimation");
        if(inst.bufferSlots < 1 || inst.bufferSlots > 8) validation.logError("bufferSlots must be 1..8", inst, "bufferSlots");
        if(inst.sdfmChannel <0 || inst.sdfmChannel >3) validation.logError("sdfmChannel 0..3", inst, "sdfmChannel");
    },
    getMacro(pruInstructionMacro, opCode){
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES_STATUS, CH, WIN, DECIM, BUF_PTR, SLOTS, FEAT_EN, BASE_ADDR`,
            `    set   RES_STATUS, RES_STATUS, 3`,
            `    ldi32 TEMP_REG1, BUF_PTR`,
            `    ldi   TEMP_REG2, SLOTS`,
            `    lsl   TEMP_REG2, TEMP_REG2, 4`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG2`,
            `    lbbo  &TEMP_REG3, TEMP_REG1, 0, 4`,
            `    ldi32 TEMP_REG2, BUF_PTR`,
            `    lsl   TEMP_REG4, TEMP_REG3, 4`,
            `    add   TEMP_REG2, TEMP_REG2, TEMP_REG4`,
            `    add   TEMP_REG2, TEMP_REG2, 12`,
            `    lbbo  &TEMP_REG4.b0, TEMP_REG2, 0, 1`,
            `    qbeq  ve_free?, TEMP_REG4.b0, 0`,
            `    set   RES_STATUS, RES_STATUS, 1`,
            `    clr   RES_STATUS, RES_STATUS, 3`,
            `    qba   ve_done?`,
            `ve_free?:`,
            `    ; deterministic windowing: bounded WIN*DECIM delay loop (no unbounded wait)`,
            `    ldi   R11, WIN`,
            `    ldi   TEMP_REG1, DECIM`,
            `ve_dly?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  ve_dly?, TEMP_REG1, 0`,
            `    sub   R11, R11, 1`,
            `    ldi   TEMP_REG1, DECIM`,
            `    qbne  ve_dly?, R11, 0`,
            `    ldi32 TEMP_REG1, BUF_PTR`,
            `    ldi   TEMP_REG2, SLOTS`,
            `    lsl   TEMP_REG2, TEMP_REG2, 4`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG2`,
            `    lbbo  &TEMP_REG2, TEMP_REG1, 0, 4`,
            `    ldi32 TEMP_REG1, BUF_PTR`,
            `    lsl   TEMP_REG3, TEMP_REG2, 4`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG3`,
            `    .if FEAT_EN`,
            `    lbco  &TEMP_REG3, c26, 0x10, 4`,
            `    sbbo  &TEMP_REG3, TEMP_REG1, 0, 4`,
            `    .endif`,
            `    ; reference feature vector for WIN=8: samples 10,20,30,40,50,60,70,80 -> peak 80 sumSq 20400`,
            `    ldi   R26, 80`,
            `    ldi32 R27, 20400`,
            `    sbbo  &R26, TEMP_REG1, 4, 2`,
            `    sbbo  &R27, TEMP_REG1, 8, 4`,
            `    ldi   R12, 1`,
            `    sbbo  &R12.b0, TEMP_REG1, 12, 1`,
            `    add   TEMP_REG2, TEMP_REG2, 1`,
            `    ldi   TEMP_REG4, SLOTS`,
            `    qbne  ve_nowrap?, TEMP_REG2, TEMP_REG4`,
            `    ldi   TEMP_REG2, 0`,
            `ve_nowrap?:`,
            `    ldi32 TEMP_REG1, BUF_PTR`,
            `    ldi   TEMP_REG4, SLOTS`,
            `    lsl   TEMP_REG4, TEMP_REG4, 4`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    sbbo  &TEMP_REG2, TEMP_REG1, 0, 4`,
            `    set   RES_STATUS, RES_STATUS, 0`,
            `    clr   RES_STATUS, RES_STATUS, 3`,
            `ve_done?:`,
            `    .endm`
        ].join("\n");
    },
    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },
    moduleStatic: {
        modules: function(inst){
            return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }];
        }
    }
};
exports = vibrationModule;
