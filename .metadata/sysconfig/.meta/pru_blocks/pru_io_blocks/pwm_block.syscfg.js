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

const GPIO_SIGNALS = Array.from({ length: 20 }, (_, i) => ({
    name: String(i), displayName: `PRU GPIO ${i} (R30/R31.${i})`,
}));

const pwmModule = {
    displayName: "PWM (IEP-synced)",
    defaultInstanceName: `${PRU_USED}_PWM_INSTANCE_`,
    description: "P1 PWM generator (IEP-synced).",
    longDescription: "Emits a single-channel IEP-CMP PWM (CMP0=period, CMP1=duty) edge-aligned. By default it loops forever and has no next port. Set Period count to N (1..2147483647) to emit exactly N full periods and then fall through to the next block: the block gains a next port, compare events are disabled after the last period, and every period, the last included, runs the same macro as the continuous mode, so the edge timing is the same. It is not cycle-exact: each edge lands 0..3 cycles after its IEP compare event, because the block polls the IEP status with a 4-cycle loop. Derived from the macro text and checked in TI pru-simulator with c26 mapped to its IEP model, as on the device, and the IEP at the core clock (LBCO = 3 cycles, not verified on silicon): the steady period is P +/-3 cycles; the first period is P+7..P+10; the steady active width is D-8..D-2 (D-9..D-3 with the complementary output); the complement edge follows its main edge by exactly 1 cycle. These windows hold only when the duty count D is at least 11 and the low time P-D is at least 10 counts (P = period counts, D = duty counts).  The exit costs 4 cycles, all after the final period boundary (measured from the cycle at which the continuous mode would start period N+1 to the cycle counter on return, in TI pru-simulator on the clpru ELF). Note: Deadband (ns) is accepted but not yet inserted between the main and complementary edges, in either mode.",
    uiView: "graph",

    config: [
        { name: "$shape", hidden: true, default: "pin" },
		{
			name: "blockMaturity",
			displayName: "Block Maturity",
			default: "simulator-tested",
			options: [{name: "metadata-only"}, {name: "assembles"}, {name: "simulator-tested"}, {name: "dual-oracle-tested"}, {name: "hardware-validated"}],
			hidden: true
		},
        { name: "$topLabel", hidden: true, default: "" },

        { name: "clkHz", displayName: "IEP Clock (Hz)", default: 200000000 },
        { name: "periodNs", displayName: "Period (ns)", default: 5000 },
        { name: "dutyPct", displayName: "Duty (%)", default: 25 },
        { name: "pin", displayName: "Output R30 Pin", default: "5", options: GPIO_SIGNALS },
        { name: "activeHigh", displayName: "Active High", default: true },
        { name: "enableComplementary", displayName: "Enable Complementary Output", default: false },
        { name: "compPin", displayName: "Complementary R30 Pin", default: "6", options: GPIO_SIGNALS },
        { name: "deadbandNs", displayName: "Deadband (ns)", default: 100 },
        { name: "periodCount", displayName: "Period Count (0=Continuous)", default: 0 },

        { name: "opCode", default: "m_pwm_run", hidden: true, getValue: (inst) => (inst.periodCount > 0 ? "m_pwm_run_counted" : "m_pwm_run") },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true }, /* Continuous block when periodCount is 0 */
        { name: "output1Size", default: 0, hidden: true },
        { name: "numOfConstants", default: 7, hidden: true, getValue: (inst) => (inst.periodCount > 0 ? 8 : 7) },

        { name: "constant1", hidden: true, default: "", getValue: (inst) => inst.pin },
        { name: "constant2", hidden: true, default: 0, getValue: (inst) => Math.round((inst.periodNs * inst.clkHz) / 1e9) },
        { name: "constant3", hidden: true, default: 0, getValue: (inst) => {
            const period = Math.round((inst.periodNs * inst.clkHz) / 1e9);
            return Math.round((period * inst.dutyPct) / 100);
        }},
        { name: "constant4", hidden: true, default: 0, getValue: (inst) => inst.activeHigh ? 1 : 0 },
        { name: "constant5", hidden: true, default: 0, getValue: (inst) => inst.enableComplementary ? 1 : 0 },
        { name: "constant6", hidden: true, default: "", getValue: (inst) => inst.compPin },
        { name: "constant7", hidden: true, default: 0, getValue: (inst) => Math.round((inst.deadbandNs * inst.clkHz) / 1e9) },
        { name: "constant8", hidden: true, default: 0, getValue: (inst) => inst.periodCount || 0 },

        { name: "noOfCycles", displayName: "Number Of Cycles", default: 1,
          // Continuous mode never returns, so its 1 is a placeholder. A counted run is finite: the bound is
          // 2x the IEP period count per period plus a margin for the setup and the 4-cycle exit, times N
          // (as three_phase_pwm_block does); tests check it covers the simulated clpru run.
          getValue: (inst) => {
              if (!(inst.periodCount > 0)) return 1;
              const counts = Math.round((inst.periodNs * inst.clkHz) / 1e9);
              return (2 * counts + 64) * inst.periodCount;
          } }
    ],

    ports: (inst) => {
        const p = [
            { name: "prev", type: "IO_PREV" }
        ];
        if (inst && inst.periodCount > 0) {
            p.push({ name: "next", type: "IO_NEXT" });
        }
        return p;
    },

    validate(inst, validation) {
        if (inst.periodNs <= 0) validation.logError("periodNs must be > 0", inst, "periodNs");
        if (inst.dutyPct < 0 || inst.dutyPct > 100) validation.logError("dutyPct must be 0..100", inst, "dutyPct");
        if (inst.clkHz <= 0) validation.logError("clkHz must be > 0", inst, "clkHz");
        if (inst.enableComplementary && inst.pin === inst.compPin) validation.logError("Complementary pin must be different", inst, "compPin");
        if (inst.periodCount !== undefined && inst.periodCount !== null) {
            if (!Number.isInteger(inst.periodCount) || inst.periodCount < 0 || inst.periodCount > 0x7fffffff) {
                validation.logError("periodCount must be 0..2147483647", inst, "periodCount");
            }
            // A counted run waits for the CMP1 (duty) event once per period; with 0 duty counts that
            // event never fires, so the run never ends and the header cycle budget is meaningless.
            // Continuous mode keeps its (pre-existing) duty-0 behaviour and is not checked here.
            else if (inst.periodCount > 0 && inst.periodNs > 0 && inst.clkHz > 0 && inst.dutyPct >= 0 && inst.dutyPct <= 100) {
                const periodCounts = Math.round((inst.periodNs * inst.clkHz) / 1e9);
                const dutyCounts = Math.round((periodCounts * inst.dutyPct) / 100);
                if (dutyCounts < 1) {
                    validation.logError(`Counted mode needs at least 1 duty count, but Duty (${inst.dutyPct}%) of Period (${inst.periodNs} ns) is ${dutyCounts} IEP counts at ${inst.clkHz} Hz and the run would never end: raise dutyPct or periodNs, or set periodCount to 0`, inst, "dutyPct");
                }
            }
        }
    },

    getMacro(pruInstructionMacro, opCode) {
        opCode = opCode || pruInstructionMacro.split(",")[0];
        if (opCode.trim().startsWith("m_pwm_run_counted")) {
            return [
                `${opCode} .macro RES, PIN, PERIOD_COUNTS, DUTY_COUNTS, ACTIVE_HIGH, EN_COMP, COMP_PIN, DEADBAND_COUNTS, PERIOD_COUNT`,
                `    ; Counted mode: TEMP_REG2 holds the periods still to emit. It is loaded first so the`,
                `    ; IEP setup below is cycle-identical to m_pwm_run.`,
                `    ldi32 TEMP_REG2, PERIOD_COUNT`,
                `    ; IEP setup. Per TRM SPRUIM2J 6.4.13 the counter only runs when`,
                `    ; GLOBAL_CFG[0] CNT_ENABLE is set, GLOBAL_CFG[7:4] DEFAULT_INC is the`,
                `    ; step size, and a compare only fires when its CMP_CFG[16:1] CMP_EN bit`,
                `    ; is set - CMP_EN starts at bit 1, so CMP0 is bit 1 and CMP1 is bit 2.`,
                `    ; Omitting these left the block waiting on a compare that never fired.`,
                `    ; Order matters. Enabling the counter or the compares before the`,
                `    ; compare values are installed leaves stale CMP0/CMP1 live against a`,
                `    ; running counter, which can fire an event and reset the period before`,
                `    ; this macro's values land - visible on re-invocation. TRM 6.4.13`,
                `    ; sequence: disable, program, clear status, then enable last.`,
                `    ldi32 TEMP_REG1, 0`,
                `    sbco  &TEMP_REG1, c26, 0x00, 4`,
                `    sbco  &TEMP_REG1, c26, 0x70, 4`,
                `    sbco  &TEMP_REG1, c26, 0x10, 4`,
                `    ldi32 TEMP_REG1, 0x3`,
                `    sbco  &TEMP_REG1, c26, 0x74, 4`,
                `    ldi32 TEMP_REG1, PERIOD_COUNTS`,
                `    sbco  &TEMP_REG1, c26, 0x78, 4`,
                `    ldi32 TEMP_REG1, DUTY_COUNTS`,
                `    sbco  &TEMP_REG1, c26, 0x80, 4`,
                `    ldi32 TEMP_REG1, 0x7`,
                `    sbco  &TEMP_REG1, c26, 0x70, 4`,
                `    ldi32 TEMP_REG1, 0x11`,
                `    sbco  &TEMP_REG1, c26, 0x00, 4`,
                `pw_l?:`,
                `    .if ACTIVE_HIGH`,
                `    .if EN_COMP == 1`,
                `    clr   R30, R30, COMP_PIN`,
                `    .endif`,
                `    set   R30, R30, PIN`,
                `    .else`,
                `    .if EN_COMP == 1`,
                `    set   R30, R30, COMP_PIN`,
                `    .endif`,
                `    clr   R30, R30, PIN`,
                `    .endif`,
                `pw_wd?:`,
                `    lbco  &TEMP_REG1, c26, 0x74, 4`,
                `    qbbc  pw_wd?, TEMP_REG1, 1`,
                `    .if ACTIVE_HIGH`,
                `    clr   R30, R30, PIN`,
                `    .if EN_COMP == 1`,
                `    ; DEADBAND_COUNTS is accepted but not inserted here, exactly as in m_pwm_run: the`,
                `    ; complementary edge follows the main edge with no added delay.`,
                `    set   R30, R30, COMP_PIN`,
                `    .endif`,
                `    .else`,
                `    set   R30, R30, PIN`,
                `    .if EN_COMP == 1`,
                `    ; DEADBAND_COUNTS is accepted but not inserted here, exactly as in m_pwm_run: the`,
                `    ; complementary edge follows the main edge with no added delay.`,
                `    clr   R30, R30, COMP_PIN`,
                `    .endif`,
                `    .endif`,
                `    ldi32 TEMP_REG1, 2`,
                `    sbco  &TEMP_REG1, c26, 0x74, 4`,
                `pw_wp?:`,
                `    lbco  &TEMP_REG1, c26, 0x74, 4`,
                `    qbbc  pw_wp?, TEMP_REG1, 0`,
                `    ; m_pwm_run spends two cycles here on ldi32 TEMP_REG1, 1. Counted mode does the same`,
                `    ; two cycles of work (a one-cycle ldi plus the period decrement) so every period,`,
                `    ; the last included, takes exactly as long as in m_pwm_run.`,
                `    ldi   TEMP_REG1, 1`,
                `    sub   TEMP_REG2, TEMP_REG2, 1`,
                `    sbco  &TEMP_REG1, c26, 0x74, 4`,
                `    qbne  pw_l?, TEMP_REG2, 0`,
                `    ldi32 TEMP_REG1, 0`,
                `    sbco  &TEMP_REG1, c26, 0x70, 4`,
                `    .endm`
            ].join("\n");
        }
        return [
            `${opCode} .macro RES, PIN, PERIOD_COUNTS, DUTY_COUNTS, ACTIVE_HIGH, EN_COMP, COMP_PIN, DEADBAND_COUNTS`,
            `    ; IEP setup. Per TRM SPRUIM2J 6.4.13 the counter only runs when`,
            `    ; GLOBAL_CFG[0] CNT_ENABLE is set, GLOBAL_CFG[7:4] DEFAULT_INC is the`,
            `    ; step size, and a compare only fires when its CMP_CFG[16:1] CMP_EN bit`,
            `    ; is set - CMP_EN starts at bit 1, so CMP0 is bit 1 and CMP1 is bit 2.`,
            `    ; Omitting these left the block waiting on a compare that never fired.`,
            `    ; Order matters. Enabling the counter or the compares before the`,
            `    ; compare values are installed leaves stale CMP0/CMP1 live against a`,
            `    ; running counter, which can fire an event and reset the period before`,
            `    ; this macro's values land - visible on re-invocation. TRM 6.4.13`,
            `    ; sequence: disable, program, clear status, then enable last.`,
            `    ldi32 TEMP_REG1, 0`,
            `    sbco  &TEMP_REG1, c26, 0x00, 4`,
            `    sbco  &TEMP_REG1, c26, 0x70, 4`,
            `    sbco  &TEMP_REG1, c26, 0x10, 4`,
            `    ldi32 TEMP_REG1, 0x3`,
            `    sbco  &TEMP_REG1, c26, 0x74, 4`,
            `    ldi32 TEMP_REG1, PERIOD_COUNTS`,
            `    sbco  &TEMP_REG1, c26, 0x78, 4`,
            `    ldi32 TEMP_REG1, DUTY_COUNTS`,
            `    ; 0x50 is CMP1_REG0. 0x4C is CMP0's UPPER half - the compare registers`,
            `    ; are 64-bit pairs (IEP_CMPj_REG0/REG1), so writing duty there corrupted`,
            `    ; CMP0 and left CMP1 unprogrammed.`,
            `    sbco  &TEMP_REG1, c26, 0x80, 4`,
            `    ldi32 TEMP_REG1, 0x7`,
            `    sbco  &TEMP_REG1, c26, 0x70, 4`,
            `    ldi32 TEMP_REG1, 0x11`,
            `    sbco  &TEMP_REG1, c26, 0x00, 4`,
            `pw_l?:`,
            `    .if ACTIVE_HIGH`,
            `    .if EN_COMP == 1`,
            `    clr   R30, R30, COMP_PIN`,
            `    .endif`,
            `    set   R30, R30, PIN`,
            `    .else`,
            `    .if EN_COMP == 1`,
            `    set   R30, R30, COMP_PIN`,
            `    .endif`,
            `    clr   R30, R30, PIN`,
            `    .endif`,
            `pw_wd?:`,
            `    lbco  &TEMP_REG1, c26, 0x74, 4`,
            `    qbbc  pw_wd?, TEMP_REG1, 1`,
            `    .if ACTIVE_HIGH`,
            `    clr   R30, R30, PIN`,
            `    .if EN_COMP == 1`,
            `    ; deadband: DEADBAND_COUNTS is not inserted before the complementary pin toggles`,
            `    set   R30, R30, COMP_PIN`,
            `    .endif`,
            `    .else`,
            `    set   R30, R30, PIN`,
            `    .if EN_COMP == 1`,
            `    ; deadband: DEADBAND_COUNTS is not inserted before the complementary pin toggles`,
            `    clr   R30, R30, COMP_PIN`,
            `    .endif`,
            `    .endif`,
            `    ldi32 TEMP_REG1, 2`,
            `    sbco  &TEMP_REG1, c26, 0x74, 4`,
            `pw_wp?:`,
            `    lbco  &TEMP_REG1, c26, 0x74, 4`,
            `    qbbc  pw_wp?, TEMP_REG1, 0`,
            `    ldi32 TEMP_REG1, 1`,
            `    sbco  &TEMP_REG1, c26, 0x74, 4`,
            `    qba   pw_l?`,
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
            pins.push({ pin: parseInt(inst.pin), dir: "GPO" });
            if (inst.enableComplementary) pins.push({ pin: parseInt(inst.compPin), dir: "GPO" });
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

exports = pwmModule;
