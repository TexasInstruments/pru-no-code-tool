"use strict";
// Scope: ENDAT UART framing, CRC, and collision echo handling are not complete. The block is metadata-only; no generated ELF behavior is claimed.
// R31 event-generate byte (SPRUIM2J 6.4.5.2.2.2, Table 6-67, PDF p584): bit 5 = vec_valid strobe, bits 3:0 = channel 0..15,
// channel n drives INTC system event 16+n. So byte = 0x20 | (event - 16); 0xxxxx (bit 5 clear) generates nothing.
// The config stays a system event number (16..31); the encoding is applied here, once, in constant12.
const R31_EVENT_VALID = 0x20;
const R31_FIRST_SYSTEM_EVENT = 16;
const R31_LAST_SYSTEM_EVENT = 31;
// Out of range encodes to 0 (no strobe); validate() reports the range error, so a bad value gives one clear message and no negative constant.
function r31EventGenerateByte(systemEvent) {
    if (!(systemEvent >= R31_FIRST_SYSTEM_EVENT && systemEvent <= R31_LAST_SYSTEM_EVENT)) return 0;
    return R31_EVENT_VALID | (systemEvent - R31_FIRST_SYSTEM_EVENT);
}

const serialGatewayModule = {
    // Test-status sentence for the generated block reference; the generic sentence would overstate this block.
    docVerdict: "Metadata, SysConfig generation, and `clpru` assembly pass for a minimal connected design. Protocol behavior is unverified.",
    displayName: "Industrial Serial Gateway",
    defaultInstanceName: "SERIAL_GATEWAY_",
    description: "RS-485 half-duplex serial gateway with Modbus RTU, DMX512 and custom framing, CRC, mailbox host queue.",
    longDescription: `Half-duplex RS-485 serial gateway block that transports framed payloads over PRU-ICSSG ENDAT UART hardware and routes data through a shared-memory mailbox ring buffer to the host (R5F/A53).\n\n` +
        `Transport: drives an R30 direction pin (DE/RE for RS-485 transceiver) and uses the ENDAT UART peripheral for TX/RX at configurable baud rates (1.2 kbaud - 12 Mbaud). Turnaround time (idle before TX-to-RX or RX-to-TX switch) is configurable as a delay loop count.\n\n` +
        `Framing modes:\n` +
        `- MODBUS_RTU: address (1B) + function (1B) + data (0-252B) + CRC16 (2B, poly 0x8005, big-endian). Slave address match filter. Inter-frame silence detection (3.5 char = ~350 bit times at baud rate, floor to 2 byte-times for short frames).\n` +
        `- DMX512: Break (configurable duration, default 100 us low) + MAB (12 us high) + start code (slot 0) + 1-512 slot bytes at 250 kbaud.\n` +
        `- CUSTOM: configurable delimiter (start byte), optional escape byte, CRC16/CRC8/sum, max frame length.\n\n` +
        `CRC: For Modbus RTU uses CRC16-IBM (poly 0x8005, init 0xFFFF, ref-in/ref-out). DMX512 uses no CRC. CUSTOM mode selects CRC type from a CRC8-Dallas/CRC16-IBM/simple-sum set.\n\n` +
        `Mailbox: received frames are published to the host ring buffer (configurable DMEM/shared memory offset, 8-256 slots, 4-32 bytes per slot). Frames exceeding slotBytes are truncated or split across multiple slots with a continuation flag. The host signals new frames by updating the ring write pointer; the PRU polls the host-to-PRU queue (from mailbox) for TX commands (address+payload to send).\n\n` +
        `Timeout: configurable inter-byte timeout (delay loops between consecutive bytes). If inter-byte gap exceeds timeout, the frame-in-progress is discarded and the bus is released.\n\n` +
        `Bus collision: after TX, read back the echoed data on the RX line. Any mismatch is flagged as a collision in the status register output.\n\n` +
        `Peripheral resources: uses one ENDAT UART channel (CH0/1/2) for both TX and RX (half-duplex), one R30 GPIO bit for RS-485 direction control. Requires the R30 pin for DE/RE, the ENDAT RX channel for receive, and the ENDAT TX channel for transmit. Pinmux: the RS-485 DE/RE pin must be on a PRU R30 bit routed through PRU-ICSSG pinmux. Isolation: single PRU slice owns the UART channel and direction pin during the full exchange. Deterministic timing: each byte at a given baud rate is handled by the ENDAT hardware; framing/turnaround uses calibrated delay loops. BOM: an RS-485 transceiver (e.g. THVD1450, SN65HVD72) with DE/RE tied to the designated R30 pin. Current maturity: metadata-only. The emitted macro has mailbox and direction-control scaffolding, but TX/RX framing, ENDAT UART programming, CRC, and collision echo handling are incomplete; no generated ELF behavior is claimed. Physical transceiver timing also requires silicon validation.`,
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "blockMaturity", displayName: "Block Maturity", default: "metadata-only", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "baudRate", displayName: "Baud Rate (bps)", default: 115200, description: "Serial baud rate (1200..12000000)" },
        { name: "uartChannel", displayName: "ENDAT UART Channel", default: 0, options: [{name: 0}, {name: 1}, {name: 2}], description: "ENDAT peripheral channel for half-duplex TX/RX" },
        { name: "clockSource", displayName: "Clock Source (0=192MHz, 1=200MHz)", default: 0 },
        { name: "dirPin", displayName: "RS-485 DIR Pin (R30 Bit)", default: 0, description: "R30 GPIO bit for DE/RE control (1=TX, 0=RX)" },
        { name: "turnaroundCycles", displayName: "Turnaround Delay Loops", default: 50, description: "Delay loops between TX-to-RX or RX-to-TX direction switch" },
        { name: "framingMode", displayName: "Framing Mode", default: "MODBUS_RTU", options: [{name: "MODBUS_RTU"}, {name: "DMX512"}, {name: "CUSTOM"}], description: "Protocol framing layer" },
        { name: "modbusAddress", displayName: "Modbus Slave Address", default: 1, description: "Modbus RTU slave address (0=broadcast, 1-247)" },
        { name: "dmxSlotCount", displayName: "DMX Slot Count", default: 16, description: "DMX512 slots per packet (1-512)" },
        { name: "dmxBreakCycles", displayName: "DMX Break Delay Loops", default: 200, description: "Delay loops for DMX break" },
        { name: "dmxMabCycles", displayName: "DMX MAB Delay Loops", default: 20, description: "Delay loops for DMX Mark-After-Break" },
        { name: "customStartDelim", displayName: "Custom Start Delimiter (hex)", default: "0xAA" },
        { name: "customEscapeByte", displayName: "Custom Escape Byte (0=Disabled)", default: "0x00" },
        { name: "customCrcType", displayName: "Custom CRC Type", default: "CRC16_IBM", options: [{name: "CRC8_DALLAS"}, {name: "CRC16_IBM"}, {name: "SUM8"}] },
        { name: "customMaxLen", displayName: "Custom Max Frame Length", default: 64 },
        { name: "crcEnable", displayName: "Enable CRC16 (Modbus)", default: true },
        { name: "interByteTimeout", displayName: "Inter-byte Timeout Loops", default: 200, description: "Delay loops for inter-byte timeout" },
        { name: "collisionDetect", displayName: "Enable Bus Collision Detect", default: true },
        { name: "mbBaseOffset", displayName: "Mailbox Base Offset", default: "0x2000" },
        { name: "mbSlots", displayName: "Mailbox Slots", default: 16 },
        { name: "mbSlotBytes", displayName: "Mailbox Bytes Per Slot", default: 32 },
        { name: "mbMemory", displayName: "Mailbox Memory Window", default: "dmem0" },
        { name: "mbSignalEvent", displayName: "Signal Host Event On Publish", default: false },
        { name: "mbHostEvent", displayName: "Host System Event", default: 16, description: "PRU_ICSSG system event 16..31 raised on publish (encoded to the R31.b0 event-generate byte 0x20 | (event - 16))" },
        { name: "opCode", default: "m_serial_gateway_run", hidden: true },
        { name: "numOfInputPorts", default: 2, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "input1Size", default: 4, hidden: true },
        { name: "input2Size", default: 4, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        // Call order: STATUS, TX_DATA_REG, TX_CMD_REG, then these 23 macro parameters.
        { name: "numOfConstants", default: 23, hidden: true },
        { name: "constant1", default: 0, hidden: true, getValue: i => ({MODBUS_RTU: 0, DMX512: 1, CUSTOM: 2})[i.framingMode] },
        { name: "constant2", default: 1666, hidden: true, getValue: i => Math.max(1, Math.round((i.clockSource ? 200000000 : 192000000) / i.baudRate)) },
        { name: "constant3", default: 0, hidden: true, getValue: i => i.uartChannel },
        { name: "constant4", default: 0, hidden: true, getValue: i => i.dirPin },
        { name: "constant5", default: 50, hidden: true, getValue: i => i.turnaroundCycles },
        { name: "constant6", default: 200, hidden: true, getValue: i => i.interByteTimeout },
        { name: "constant7", default: 8192, hidden: true, getValue: i => parseInt(i.mbBaseOffset, 16) },
        { name: "constant8", default: 4, hidden: true, getValue: i => Math.log2(i.mbSlots) },
        { name: "constant9", default: 32, hidden: true, getValue: i => i.mbSlotBytes },
        { name: "constant10", default: 0, hidden: true, getValue: i => i.mbMemory === "shared" ? 1 : 0 },
        { name: "constant11", default: 0, hidden: true, getValue: i => i.mbSignalEvent ? 1 : 0 },
        { name: "constant12", default: 16, hidden: true, getValue: i => r31EventGenerateByte(i.mbHostEvent) },
        { name: "constant13", default: 1, hidden: true, getValue: i => i.modbusAddress },
        { name: "constant14", default: 16, hidden: true, getValue: i => i.dmxSlotCount },
        { name: "constant15", default: 200, hidden: true, getValue: i => i.dmxBreakCycles },
        { name: "constant16", default: 20, hidden: true, getValue: i => i.dmxMabCycles },
        { name: "constant17", default: 170, hidden: true, getValue: i => parseInt(i.customStartDelim, 16) },
        { name: "constant18", default: 0, hidden: true, getValue: i => parseInt(i.customEscapeByte, 16) },
        { name: "constant19", default: 1, hidden: true, getValue: i => ({CRC8_DALLAS: 0, CRC16_IBM: 1, SUM8: 2})[i.customCrcType] },
        { name: "constant20", default: 64, hidden: true, getValue: i => i.customMaxLen },
        { name: "constant21", default: 1, hidden: true, getValue: i => i.crcEnable ? 1 : 0 },
        { name: "constant22", default: 1, hidden: true, getValue: i => i.collisionDetect ? 1 : 0 },
        { name: "constant23", default: 200, hidden: true, getValue: i => i.interByteTimeout },
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => {
            const nSlots = inst.dmxSlotCount || 16;
            const ml = inst.customMaxLen || 64;
            const maxBytes = Math.max(nSlots + 1, ml + 4, 16);
            return 1000 + maxBytes * 120 + (inst.turnaroundCycles || 50) + (inst.interByteTimeout || 200);
        }, default: 5000 }
    ],
    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "input1", type: "input32", description: "TX payload data" },
            { name: "input2", type: "input32", description: "TX command byte0=addr byte1=fn" },
            { name: "output1", type: "output32", description: "Status: byte0=RX count byte1=faultFlags" }
        ];
    },
    validate(inst, validation) {
        if (inst.baudRate < 1200 || inst.baudRate > 12000000) validation.logError("baudRate must be 1200..12000000", inst, "baudRate");
        if (inst.dirPin < 0 || inst.dirPin > 15) validation.logError("dirPin must be 0..15", inst, "dirPin");
        if (inst.uartChannel < 0 || inst.uartChannel > 2) validation.logError("uartChannel must be 0..2", inst, "uartChannel");
        if (inst.framingMode === "MODBUS_RTU" && (inst.modbusAddress < 0 || inst.modbusAddress > 247))
            validation.logError("modbusAddress must be 0..247", inst, "modbusAddress");
        if (inst.framingMode === "DMX512") {
            if (inst.dmxSlotCount < 1 || inst.dmxSlotCount > 512) validation.logError("dmxSlotCount must be 1..512", inst, "dmxSlotCount");
            if (inst.baudRate !== 250000) validation.logInfo("DMX512 standard baud rate is 250000", inst, "baudRate");
        }
        if (inst.framingMode === "CUSTOM" && (inst.customMaxLen < 4 || inst.customMaxLen > 256))
            validation.logError("customMaxLen must be 4..256", inst, "customMaxLen");
        if (!(inst.mbHostEvent >= R31_FIRST_SYSTEM_EVENT && inst.mbHostEvent <= R31_LAST_SYSTEM_EVENT))
            validation.logError("mbHostEvent must be a system event 16..31 (R31 event-generate channels 0..15)", inst, "mbHostEvent");
        if (inst.mbSlots < 2 || inst.mbSlots > 256) validation.logError("mbSlots must be 2..256", inst, "mbSlots");
        if ((inst.mbSlots & (inst.mbSlots - 1)) !== 0) validation.logError("mbSlots must be a power of two", inst, "mbSlots");
        if (inst.mbSlotBytes < 4 || inst.mbSlotBytes > 32) validation.logError("mbSlotBytes must be 4..32", inst, "mbSlotBytes");
        if (inst.turnaroundCycles < 5) validation.logError("turnaroundCycles too small", inst, "turnaroundCycles");
    },
    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        // NB: Avoid arithmetic expressions in sbco/lbco operands.
        //     Load address+offset into a register and use that register.
        return [
            `${opCode} .macro STATUS, TX_DATA_REG, TX_CMD_REG, MODE, BAUDRATE_DIV, UART_CH, DIR_PIN, TURNAROUND, TIMEOUT_BYTES, MB_BASE, MB_SLOT_LOG2, MB_SLOT_BYTES, MB_IS_SHARED, MB_SIGNAL_EV, MB_HOST_EV, MODBUS_ADDR, DMX_SLOTS, DMX_BREAK_CYCLES, DMX_MAB_CYCLES, CUSTOM_DELIM, CUSTOM_ESC, CUSTOM_CRC_TYPE, CUSTOM_MAX_BYTES, CRC_EN, COLL_EN, INTER_BYTE_TMO`,
            `    ldi   STATUS, 0`,
            `    ; Phase 1: TX queue consume`,
            `    ldi   TEMP_REG3.w2, MB_BASE`,
            `    .if MB_IS_SHARED == 1`,
            `    lbco  &TEMP_REG1, c28, TEMP_REG3.w2, 4`,
            `    add   TEMP_REG2.w0, TEMP_REG3.w2, 4`,
            `    lbco  &TEMP_REG2.w0, c28, TEMP_REG2.w0, 4`,
            `    .else`,
            `    lbco  &TEMP_REG1, c24, TEMP_REG3.w2, 4`,
            `    add   TEMP_REG2.w0, TEMP_REG3.w2, 4`,
            `    lbco  &TEMP_REG2.w0, c24, TEMP_REG2.w0, 4`,
            `    .endif`,
            `    qbeq  sg_rx_phase, TEMP_REG1, TEMP_REG2.w0`,
            `    ; read payload slot: offset = ((readPtr & mask) << log2) + MB_BASE + 8`,
            `    ldi   TEMP_REG4.w2, (1 << MB_SLOT_LOG2) - 1`,
            `    and   TEMP_REG4.w2, TEMP_REG2.w0, TEMP_REG4.w2`,
            `    lsl   TEMP_REG4.w2, TEMP_REG4.w2, MB_SLOT_LOG2`,
            `    add   TEMP_REG4.w2, TEMP_REG4.w2, TEMP_REG3.w2`,
            `    add   TEMP_REG4.w2, TEMP_REG4.w2, 8`,
            `    .if MB_IS_SHARED == 1`,
            `    lbco  &TEMP_REG3, c28, TEMP_REG4.w2, MB_SLOT_BYTES`,
            `    .else`,
            `    lbco  &TEMP_REG3, c24, TEMP_REG4.w2, MB_SLOT_BYTES`,
            `    .endif`,
            `    ; increment PRU read ptr (TEMP_REG1 = masked (ptr+1))`,
            `    add   TEMP_REG1, TEMP_REG2.w0, 1`,
            `    ldi   TEMP_REG4.w2, (1 << MB_SLOT_LOG2) - 1`,
            `    and   TEMP_REG1, TEMP_REG1, TEMP_REG4.w2`,
            `    ; write back: sbco &TEMP_REG1, c24, MB_BASE+4, 4`,
            `    add   TEMP_REG4.w2, TEMP_REG3.w2, 4`,
            `    .if MB_IS_SHARED == 1`,
            `    sbco  &TEMP_REG1, c28, TEMP_REG4.w2, 4`,
            `    .else`,
            `    sbco  &TEMP_REG1, c24, TEMP_REG4.w2, 4`,
            `    .endif`,
            `    ; DIR = TX`,
            `    set   R30, R30, DIR_PIN`,
            `    ldi   TEMP_REG4.w0, TURNAROUND`,
            `sg_tx_turn:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  sg_tx_turn, TEMP_REG4.w0, 0`,
            `    ; turnaround delay then DIR = RX`,
            `    ldi   TEMP_REG4.w0, TURNAROUND`,
            `sg_tx_done:`,
            `    sub   TEMP_REG4.w0, TEMP_REG4.w0, 1`,
            `    qbne  sg_tx_done, TEMP_REG4.w0, 0`,
            `    clr   R30, R30, DIR_PIN`,
            `    .if COLL_EN == 1`,
            `    ; collision echo placeholder`,
            `    .endif`,
            `sg_rx_phase:`,
            `    ; Phase 2: RX mailbox publish`,
            `    clr   R30, R30, DIR_PIN`,
            `    ldi   TEMP_REG3.w2, MB_BASE`,
            `    .if MB_IS_SHARED == 1`,
            `    lbco  &TEMP_REG1, c28, TEMP_REG3.w2, 4`,
            `    .else`,
            `    lbco  &TEMP_REG1, c24, TEMP_REG3.w2, 4`,
            `    .endif`,
            `    ldi   TEMP_REG2.w2, (1 << MB_SLOT_LOG2) - 1`,
            `    and   TEMP_REG4.w2, TEMP_REG1, TEMP_REG2.w2`,
            `    lsl   TEMP_REG4.w2, TEMP_REG4.w2, MB_SLOT_LOG2`,
            `    add   TEMP_REG4.w2, TEMP_REG4.w2, TEMP_REG3.w2`,
            `    add   TEMP_REG4.w2, TEMP_REG4.w2, 8`,
            `    add   STATUS, STATUS, 1`,
            `    .if MB_IS_SHARED == 1`,
            `    sbco  &STATUS, c28, TEMP_REG4.w2, MB_SLOT_BYTES`,
            `    .else`,
            `    sbco  &STATUS, c24, TEMP_REG4.w2, MB_SLOT_BYTES`,
            `    .endif`,
            `    add   TEMP_REG1, TEMP_REG1, 1`,
            `    and   TEMP_REG1, TEMP_REG1, TEMP_REG2.w2`,
            `    .if MB_IS_SHARED == 1`,
            `    sbco  &TEMP_REG1, c28, TEMP_REG3.w2, 4`,
            `    .else`,
            `    sbco  &TEMP_REG1, c24, TEMP_REG3.w2, 4`,
            `    .endif`,
            `    .if MB_SIGNAL_EV != 0`,
            `    ldi   R31.b0, MB_HOST_EV`,
            `    .endif`,
            `    .endm`,
        ].join("\n");
    },
    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },
    moduleStatic: {
        getPinUsage: function(inst) {
            const pins = [];
            pins.push({ pin: parseInt(inst.dirPin), dir: "GPO" });
            return pins;
        },
        modules: function(inst) {
            return [{ name: "pru_register_allocator_validator", moduleName: "/pru_blocks/common/pru_blocks_static_module" }];
        },
    },
};
exports = serialGatewayModule;
