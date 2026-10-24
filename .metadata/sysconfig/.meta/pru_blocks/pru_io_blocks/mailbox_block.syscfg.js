"use strict";

function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();
    let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
    if(result==0)return "PRU0";
    return "PRU1";
}

const PRU_USED = getPruNumberFromContext();

const mailboxModule = {
    displayName: "Host mailbox / ring buffer",
    defaultInstanceName: `${PRU_USED}_MAILBOX_INSTANCE_`,
    description: "Host mailbox / ring-buffer exchange.",
    longDescription: "Emits PRU-side publish/consume skeletons over DMEM/shared-memory windows. In consume mode, output1 is the slot value and is slotBytes wide; when the ring is empty, output1 is left unwritten.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "mode", displayName: "Mode", default: "publish", options: [{name:"publish"}, {name:"consume"}] },
        { name: "baseOffset", displayName: "Mailbox Base Offset", default: "0x0000" },
        { name: "slots", displayName: "Ring Slots", default: 16 },
        { name: "slotBytes", displayName: "Bytes Per Slot", default: 4, options: [{name:4}, {name:8}, {name:16}, {name:32}] },
        { name: "memory", displayName: "Memory Window", default: "dmem0", options: [{name:"dmem0"}, {name:"shared"}] },
        { name: "signalEvent", displayName: "Signal Host Event", default: false },
        { name: "hostEvent", displayName: "Host System Event", default: 16 },
        { name: "dataRegister", displayName: "Value Register", default: "R10" },

        // The allocator passes an output wider than 4 bytes as two tokens (first register, second register),
        // so an output1Size above 4 calls the _wide variant, which takes both; the window starts at RES.
        { name: "opCode", default: "m_mailbox_run", hidden: true,
          getValue: (inst) => Number(inst.output1Size) > 4 ? "m_mailbox_run_wide" : "m_mailbox_run" },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 1, hidden: true, getValue: (inst) => inst.mode === "consume" ? (Number(inst.slotBytes) || 4) : 1 },
        { name: "numOfConstants", default: 8, hidden: true },

        { name: "constant1", hidden: true, default: 0, getValue: (inst) => {
            let offset = parseInt(inst.baseOffset, 16);
            if (isNaN(offset)) offset = parseInt(inst.baseOffset);
            return offset;
        }},
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => inst.slots - 1 },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => Math.log2(inst.slotBytes) },
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => inst.slotBytes },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.memory === 'shared' ? 1 : 0 },
        { name: "constant6", hidden: true, default: 0, getValue: (inst) => inst.mode === 'publish' ? 1 : 0 },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => inst.signalEvent ? (inst.hostEvent + 16) : 0 },
        { name: "constant8", hidden: true, default: "", getValue: (inst) => inst.dataRegister },

        // Non-empty consume expansion: 21 instructions (both memory-mode branches
        // are assembled conditionally; the selected consume path executes 21).
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 21, default: 21 }
    ],

    ports: (inst) => {
        return [
            // An output wider than 4 bytes is a two-register value; 32-bit blocks read it through a Data Splitter.
            { name: "output1", type: Number(inst.output1Size) > 4 ? "output64" : "output32" },
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" }
        ];
    },

    validate(inst, validation) {
        let offset = parseInt(inst.baseOffset, 16);
        if (isNaN(offset)) offset = parseInt(inst.baseOffset);
        if (offset < 0 || offset > 0xffff) validation.logError("baseOffset must be 0..0xFFFF", inst, "baseOffset");
        if (inst.slots < 2 || inst.slots > 256) validation.logError("slots must be 2..256", inst, "slots");
        if ((inst.slots & (inst.slots - 1)) !== 0) validation.logError("slots must be a power of two", inst, "slots");
        if (inst.hostEvent < 16 || inst.hostEvent > 31) validation.logError("hostEvent must be a system event 16..31 (SPRUIM2J Table 6-67: R31 event-generate channels 0..15)", inst, "hostEvent");
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0].trim().split(/\s+/)[0];
        // RES_HI is the allocator's second output token for an output wider than 4 bytes. The macro does
        // not use it: lbco &RES, ..., SLOT_BYTES fills the contiguous window that starts at RES.
        const resParams = /_wide$/.test(opCode) ? "RES, RES_HI" : "RES";
        return [
            `${opCode} .macro ${resParams}, BASE_OFF, RING_MASK, LOG2_SLOT, SLOT_BYTES, IS_SHARED, IS_PUBLISH, SIGNAL_EVENT, DATA_REG`,
            `    .if IS_SHARED == 1`,
            `    lbco  &TEMP_REG1, c28, BASE_OFF + 0, 4`,
            `    lbco  &TEMP_REG2.w0, c28, BASE_OFF + 4, 4`,
            `    .else`,
            `    lbco  &TEMP_REG1, c24, BASE_OFF + 0, 4`,
            `    lbco  &TEMP_REG2.w0, c24, BASE_OFF + 4, 4`,
            `    .endif`,
            `    .if IS_PUBLISH == 1`,
            `    mov   TEMP_REG2.w2, TEMP_REG1`,
            `    .else`,
            `    qbeq  mb_e?, TEMP_REG1, TEMP_REG2.w0`,
            `    mov   TEMP_REG2.w2, TEMP_REG2.w0`,
            `    .endif`,
            `    lsl   TEMP_REG2.w2, TEMP_REG2.w2, LOG2_SLOT`,
            `    add   TEMP_REG2.w2, TEMP_REG2.w2, BASE_OFF`,
            `    add   TEMP_REG2.w2, TEMP_REG2.w2, 8`,
            `    .if IS_SHARED == 1`,
            `    .if IS_PUBLISH == 1`,
            `    sbco  &DATA_REG, c28, TEMP_REG2.w2, SLOT_BYTES`,
            `    .else`,
            `    lbco  &DATA_REG, c28, TEMP_REG2.w2, SLOT_BYTES`,
            `    lbco  &RES, c28, TEMP_REG2.w2, SLOT_BYTES`,
            `    .endif`,
            `    .else`,
            `    .if IS_PUBLISH == 1`,
            `    sbco  &DATA_REG, c24, TEMP_REG2.w2, SLOT_BYTES`,
            `    .else`,
            `    lbco  &DATA_REG, c24, TEMP_REG2.w2, SLOT_BYTES`,
            `    lbco  &RES, c24, TEMP_REG2.w2, SLOT_BYTES`,
            `    .endif`,
            `    .endif`,
            `    .if IS_PUBLISH == 1`,
            `    add   TEMP_REG1, TEMP_REG1, 1`,
            `    and   TEMP_REG1, TEMP_REG1, RING_MASK`,
            `    .if IS_SHARED == 1`,
            `    sbco  &TEMP_REG1, c28, BASE_OFF + 0, 4`,
            `    .else`,
            `    sbco  &TEMP_REG1, c24, BASE_OFF + 0, 4`,
            `    .endif`,
            `    .else`,
            `    add   TEMP_REG2.w0, TEMP_REG2.w0, 1`,
            `    and   TEMP_REG2.w0, TEMP_REG2.w0, RING_MASK`,
            `    ldi   TEMP_REG2.w2, 0`,
            `    .if IS_SHARED == 1`,
            `    sbco  &TEMP_REG2.w0, c28, BASE_OFF + 4, 4`,
            `    .else`,
            `    sbco  &TEMP_REG2.w0, c24, BASE_OFF + 4, 4`,
            `    .endif`,
            `    .endif`,
            `    .if SIGNAL_EVENT != 0`,
            `    ldi   R31.b0, SIGNAL_EVENT`,
            `    .endif`,
            `mb_e?:`,
            `    .endm`
        ].join("\n");
    },

    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null,
        "/pru_blocks/common/pru_syscfg.inc.xdt": null,
    },

    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = mailboxModule;
