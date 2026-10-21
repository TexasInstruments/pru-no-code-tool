function validate(inst, report) {
    if (inst.contextSwitchOverhead < 0) report.logError("contextSwitchOverhead must be >= 0", inst, "contextSwitchOverhead");
    if (inst.task1_id !== 255 && (inst.task1_id < 0 || inst.task1_id > 31)) report.logError("task1_id must be 0..31 or 255", inst, "task1_id");
}

function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";

    const generateTaskJal = (taskParam) => {
        let jumps = "";
        for (let i = 0; i < 32; i++) {
            jumps += `    .if (${taskParam} == ${i})\n    jal R29.w0, task_${i}_start\n    .endif\n`;
        }
        return jumps;
    };

    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const res = parts[1] || "RES";
    const task1 = parts[2] || "task1";
    const task2 = parts[3] || "task2";
    const task3 = parts[4] || "task3";
    const task4 = parts[5] || "task4";

    if(pruInstructionMacro == "") {
        macroBody = macroName + "	.macro " + res + ", " + task1 + ", " + task2 + ", " + task3 + ", " + task4 + "\n";
        macroBody += `    ; Parameters: task1..4 (255 means unused)\n`;
    }

    macroBody += `
    .asg c26, CONST_IEP
    .asg 0x10, IEP_TMR_CNT ; IEP_COUNT_REG0 (0x0C is IEP_SLOW_COMPEN_REG)
    .asg 200000, TASK_0_PERIOD
    .asg 400000, TASK_1_PERIOD
    .asg 600000, TASK_2_PERIOD
    .asg 800000, TASK_3_PERIOD
    ; Initialize periods
    ldi32 R5, TASK_0_PERIOD
    ldi32 R6, TASK_1_PERIOD
    ldi32 R7, TASK_2_PERIOD
    ldi32 R8, TASK_3_PERIOD

    .asg "task1", t1_p
    .asg "task2", t2_p
    .asg "task3", t3_p
    .asg "task4", t4_p

scheduler_init?:
    ; Initialize task last-run registers (R10-R13)
    zero  &R10, 16

scheduler_loop?:
    .if (${task1} < 32)
    ; Task 1 check (QBGT label, a, b branches when b > a: skip while delta < period)
    lbco  &R2, CONST_IEP, IEP_TMR_CNT, 4
    sub   R3, R2, R10            ; delta = current - last_0
    ldi32 R5, TASK_0_PERIOD
    qbgt  skip_task_0?, R3, R5
    mov   R10, R2                ; last_0 = current
    
    ; Dispatch Task (cooperative subroutine call)
${generateTaskJal('task1')}
skip_task_0?:
    .endif

    .if (${task2} < 32)
    ; Task 2 check
    lbco  &R2, CONST_IEP, IEP_TMR_CNT, 4
    sub   R3, R2, R11            ; delta = current - last_1
    ldi32 R5, TASK_1_PERIOD
    qbgt  skip_task_1?, R3, R5
    mov   R11, R2                ; last_1 = current
    
${generateTaskJal('task2')}
skip_task_1?:
    .endif

    .if (${task3} < 32)
    ; Task 3 check
    lbco  &R2, CONST_IEP, IEP_TMR_CNT, 4
    sub   R3, R2, R12            ; delta = current - last_2
    ldi32 R5, TASK_2_PERIOD
    qbgt  skip_task_2?, R3, R5
    mov   R12, R2                ; last_2 = current
    
${generateTaskJal('task3')}
skip_task_2?:
    .endif

    .if (${task4} < 32)
    ; Task 4 check
    lbco  &R2, CONST_IEP, IEP_TMR_CNT, 4
    sub   R3, R2, R13            ; delta = current - last_3
    ldi32 R5, TASK_3_PERIOD
    qbgt  skip_task_3?, R3, R5
    mov   R13, R2                ; last_3 = current
    
${generateTaskJal('task4')}
skip_task_3?:
    .endif

    ; Cooperative yield loop delay to prevent busy looping
    ldi   R0, 100
yield_delay?:
    sub   R0, R0, 1
    qbne  yield_delay?, R0, 0
    qba   scheduler_loop?
`;

    if(pruInstructionMacro == "") {
        macroBody += "\n    .endm\n";	
    }
    return macroBody;
}

exports = {
    displayName: "Cooperative Task Scheduler",
    defaultInstanceName: "Scheduler_",
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "timerSource", displayName: "Timer Source", default: "iep", options: [
            {name: "iep"}, {name: "external"}
        ]},
        { name: "contextSwitchOverhead", displayName: "Context Switch Overhead (cycles)", default: 10 },
        { name: "task1_id", displayName: "Task 1 ID", default: 0 },
        { name: "task2_id", displayName: "Task 2 ID", default: 1 },
        { name: "task3_id", displayName: "Task 3 ID", default: 255 },
        { name: "task4_id", displayName: "Task 4 ID", default: 255 },
        
        { name: "constant1", hidden: true, default: "0", getValue: (inst) => inst.task1_id + "" },
        { name: "constant2", hidden: true, default: "1", getValue: (inst) => inst.task2_id + "" },
        { name: "constant3", hidden: true, default: "255", getValue: (inst) => inst.task3_id + "" },
        { name: "constant4", hidden: true, default: "255", getValue: (inst) => inst.task4_id + "" },
        
        { name: "numOfConstants", hidden: true, default: 4 },
        { name: "opCode", hidden: true, default: "m_scheduler_block" },
        { name: "numOfInputPorts", hidden: true, default: 0 },
        { name: "numOfOutputPorts", hidden: true, default: 0 },
        { name: "noOfCycles", hidden: true, default: 100 }
    ],
    ports: (inst) => [
        { name: "prev", type: "PREV" }
    ],
    validate,
    getMacro,
    templates: { "/pru_blocks/common/pru_syscfg.asm.xdt": null },
    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    }
};
