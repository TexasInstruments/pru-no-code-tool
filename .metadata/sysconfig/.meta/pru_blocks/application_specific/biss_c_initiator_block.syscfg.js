"use strict";

const bissCModule = {
    displayName: "BiSS-C Initiator",
    defaultInstanceName: "BISS_C_INITIATOR_",
    description: "BiSS-C protocol initiator leveraging Motor Control SDK.",
    longDescription: "Interfaces with the BiSS-C encoder. It is a shift register only: clock spacing is a fixed NOP (the clock frequency is not configurable), and there is no CRC, start/ACK or timeout handling. TI pru-simulator measures an 8-cycle bit period with changing input data. Exact 5 MHz physical timing and propagation delay are not implemented.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
		{
			name: "blockMaturity",
			displayName: "Block Maturity",
			default: "simulator-tested",
			options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}],
			hidden: true
		},
        { name: "$topLabel", hidden: true, default: "" },
        
        // Not used by the macro (clock spacing is a fixed NOP); hidden until clock timing is implemented.
        { name: "clockFreq", displayName: "Clock Frequency (Hz)", default: 5000000, hidden: true },
        { name: "clkPin", displayName: "CLK Pin", default: 0 },
        { name: "dataPin", displayName: "DATA Pin", default: 1 },
        { name: "dataLen", displayName: "Data Length (bits)", default: 32 },

        { name: "opCode", default: "m_biss_c_read", hidden: true },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        // The macro takes the pin numbers and the frame length as arguments, so
        // clkPin / dataPin / dataLen reach the emitted assembly.
        { name: "numOfConstants", default: 3, hidden: true },
        { name: "constant1", hidden: true, default: 0, getValue: (inst) => inst.clkPin },
        { name: "constant2", hidden: true, default: 1, getValue: (inst) => inst.dataPin },
        { name: "constant3", hidden: true, default: 32, getValue: (inst) => inst.dataLen },
        
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 500, default: 500 }
    ],

    ports: (inst) => { 
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "output1", type: "output32" }
        ];
    },

    validate(inst, validation) {
        const len = Number(inst.dataLen);
        if (!Number.isInteger(len) || len < 1 || len > 32) {
            validation.logError("dataLen must be an integer 1..32 (the result is one 32-bit register)", inst, "dataLen");
        }
        for (const field of ["clkPin", "dataPin"]) {
            const pin = Number(inst[field]);
            if (!Number.isInteger(pin) || pin < 0 || pin > 19) {
                validation.logError(field + " must be a PRU pin 0..19", inst, field);
            }
        }
        if (Number(inst.clkPin) === Number(inst.dataPin)) {
            validation.logError("clkPin and dataPin must differ", inst, "clkPin");
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, CLK, DATA, LEN`,
            `    ; --- BiSS-C Logical Shift Register Slice ---`,
            `    ; This loop models the synchronous clocking and data capture.`,
            `    ; Note: Simulator does not validate exact 5 MHz timing or propagation delay.`,
            `    ldi   TEMP_REG1, LEN              ; Bit counter (dataLen bits)`,
            `    ldi   RES, 0                      ; Clear result`,
            `m_biss_c_loop?:`,
            `    ; MA idles HIGH between frames: pulse it low, then back high.`,
            `    ; Ending each bit on clr would leave MA low after the frame, and the`,
            `    ; encoder would see the next transaction start from the wrong level.`,
            `    ; Set MA clock pin low`,
            `    clr   R30, R30, CLK               ; (clkPin: MA clock output bit)`,
            `    ; Wait half-period (not simulated accurately)`,
            `    nop`,
            `    ; Set MA clock pin high: rising edge k, slave presents bit k after it`,
            `    set   R30, R30, CLK`,
            `    ; Shift RES left by 1 to make room for new bit`,
            `    lsl   RES, RES, 1`,
            `    ; Sample SLO data pin`,
            `    qbbc  m_biss_c_zero?, R31, DATA   ; (dataPin: SLO data input bit)`,
            `    add   RES, RES, 1                 ; Set LSB if data is high`,
            `m_biss_c_zero?:`,
            `    sub   TEMP_REG1, TEMP_REG1, 1`,
            `    qbne  m_biss_c_loop?, TEMP_REG1, 0`,
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
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
};

exports = bissCModule;
