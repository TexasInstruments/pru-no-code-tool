"use strict";

function validate(inst, report) {
    // "<name>_pid_state" is emitted as a .usect state symbol derived from $name; only the derived form is checked (a reserved base such as c0 still assembles as c0_pid_state — probed with clpru).
    if (typeof system !== "undefined" && system.getScript) {
        var reservedNames = system.getScript("/pru_blocks/common/pru_reserved_names.js");
        if (reservedNames && typeof reservedNames.validateDerivedSymbol === "function") {
            reservedNames.validateDerivedSymbol(inst, report, "$name", ["_pid_state"], "This block emits the '<name>_pid_state' state symbol derived from the instance name.");
        }
    }
}

const pidModule = {
    displayName: "IQMath PID Controller",
    requiresWidget: ["mac"],
    defaultInstanceName: "PID_CTRL_",
    description: "Proportional-Integral-Derivative (PID) controller using IQMath.",
    longDescription: "Calculates the PID output based on Setpoint and Feedback using fixed-point Q12 math via the PRU MAC broadside interface.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },

        { name: "blockMaturity", displayName: "Block Maturity", default: "simulator-tested", options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}], hidden: true },

        { name: "kp", displayName: "Proportional Gain (Kp)", default: "1.0" },
        { name: "ki", displayName: "Integral Gain (Ki)", default: "0.1" },
        { name: "kd", displayName: "Derivative Gain (Kd)", default: "0.01" },

        { name: "opCode", default: "m_iqmath_pid", hidden: true },
        { name: "numOfInputPorts", default: 2, hidden: true }, // Setpoint, Feedback
        { name: "numOfOutputPorts", default: 1, hidden: true },
        { name: "output1Size", default: 4, hidden: true },
        { name: "numOfConstants", default: 4, hidden: true },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => String(Math.round(parseFloat(inst.kp) * 4096)) },
        { name: "constant2", hidden: true, default: "", getValue: (inst) => String(Math.round(parseFloat(inst.ki) * 4096)) },
        { name: "constant3", hidden: true, default: "", getValue: (inst) => String(Math.round(parseFloat(inst.kd) * 4096)) },
        { name: "constant4", hidden: true, default: "", getValue: (inst) => inst.$name + "_pid_state" },

        // Counted from the default generated macro/evidence run: 50 cycles,
        // including the three operand-latency NOPs (LDI32 expands to two PRU instructions).
        { name: "noOfCycles", displayName: "Number Of Cycles", getValue: (inst) => 50, default: 50 }
    ],

    ports: (inst) => {
        return [
            { name: "prev", type: "IO_PREV" },
            { name: "next", type: "IO_NEXT" },
            { name: "input1", type: "input32" },
            { name: "input2", type: "input32" },
            { name: "output1", type: "output32" }
        ];
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        return [
            `${opCode} .macro RES, SETPOINT, FEEDBACK, KP, KI, KD, STATE_PTR`,
            `    ; --- PID Controller (Fixed-Point Q12) ---`,
            `    ; Layout in STATE_PTR (16 bytes): [Integral, Prev_Error, Error, Derivative]`,
            ``,
            `    ; 1. Calculate and save Error`,
            `    ldi32 TEMP_REG3, STATE_PTR`,
            `    sub   TEMP_REG4, SETPOINT, FEEDBACK`,
            `    sbbo  &TEMP_REG4, TEMP_REG3, 8, 4  ; Save Error to offset 8`,
            ``,
            `    ; 2. Calculate and save Derivative (Error - Prev_Error)`,
            `    lbbo  &TEMP_REG1, TEMP_REG3, 4, 4  ; Load Prev_Error into TEMP_REG1`,
            `    sub   TEMP_REG2, TEMP_REG4, TEMP_REG1 ; Derivative = Error - Prev_Error`,
            `    sbbo  &TEMP_REG2, TEMP_REG3, 12, 4 ; Save Derivative to offset 12`,
            ``,
            `    ; 3. Update and save Prev_Error`,
            `    sbbo  &TEMP_REG4, TEMP_REG3, 4, 4  ; Save Error as Prev_Error to offset 4`,
            ``,
            `    ; 4. Update and save Integral (Integral + Error)`,
            `    lbbo  &TEMP_REG1, TEMP_REG3, 0, 4  ; Load Integral into TEMP_REG1`,
            `    add   TEMP_REG1, TEMP_REG1, TEMP_REG4`,
            `    sbbo  &TEMP_REG1, TEMP_REG3, 0, 4  ; Save new Integral to offset 0`,
            ``,
            `    ; Initialize Output Accumulator to 0`,
            `    ldi32 RES, 0`,
            ``,
            `    ; Configure MAC for multiply-only mode`,
            `    ldi32 TEMP_REG3, 0`,
            `    xout  0, &TEMP_REG3, 1`,
            ``,
            `    ; --- Kp * Error ---`,
            `    ldi32 TEMP_REG3, STATE_PTR`,
            `    lbbo  &TEMP_REG2, TEMP_REG3, 8, 4  ; Load Error into TEMP_REG2 (R29)`,
            `    ldi32 TEMP_REG1, KP                ; Load Kp into TEMP_REG1 (R28)`,
            `    nop`,
            `    xin   0, &TEMP_REG3, 8`,
            `    ; Q12 64-to-32 shift (handles sign)`,
            `    lsr   TEMP_REG3, TEMP_REG3, 12`,
            `    lsl   TEMP_REG4, TEMP_REG4, 20`,
            `    or    TEMP_REG3, TEMP_REG3, TEMP_REG4`,
            `    add   RES, RES, TEMP_REG3`,
            ``,
            `    ; --- Ki * Integral ---`,
            `    ldi32 TEMP_REG3, STATE_PTR`,
            `    lbbo  &TEMP_REG2, TEMP_REG3, 0, 4  ; Load Integral into TEMP_REG2 (R29)`,
            `    ldi32 TEMP_REG1, KI                ; Load Ki into TEMP_REG1 (R28)`,
            `    nop`,
            `    xin   0, &TEMP_REG3, 8`,
            `    lsr   TEMP_REG3, TEMP_REG3, 12`,
            `    lsl   TEMP_REG4, TEMP_REG4, 20`,
            `    or    TEMP_REG3, TEMP_REG3, TEMP_REG4`,
            `    add   RES, RES, TEMP_REG3`,
            ``,
            `    ; --- Kd * Derivative ---`,
            `    ldi32 TEMP_REG3, STATE_PTR`,
            `    lbbo  &TEMP_REG2, TEMP_REG3, 12, 4 ; Load Derivative into TEMP_REG2 (R29)`,
            `    ldi32 TEMP_REG1, KD                ; Load Kd into TEMP_REG1 (R28)`,
            `    nop`,
            `    xin   0, &TEMP_REG3, 8`,
            `    lsr   TEMP_REG3, TEMP_REG3, 12`,
            `    lsl   TEMP_REG4, TEMP_REG4, 20`,
            `    or    TEMP_REG3, TEMP_REG3, TEMP_REG4`,
            `    add   RES, RES, TEMP_REG3`,
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

    validate,
};

exports = pidModule;
