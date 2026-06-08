# conditional

## Introduction

This example demonstrates the use of pru-no-code-tool for GPO set/clear operation using the if/else block, if the condition is true , we set GPO0 or else we clear GPO0
---

## No-Code Tool Block Design

This example demonstrates the If/Else block's branching behaviour and highlights a critical wiring rule: **each branch must be terminated with a Flow Control block**.

### Why Flow Control Termination is Required

The If/Else block generates a conditional branch instruction (`QBLT` in this case). The code generator lays out the FALSE path immediately after the branch, followed by the TRUE path at the branch target label. Without an explicit terminator at the end of the FALSE path, execution falls through into the TRUE path's code — meaning both GPO set and GPO clear would run regardless of the condition.

Adding a Flow Control (HALT) block at the end of each branch prevents this fall-through. Each path executes its own GPO operation and halts independently.

```
Without termination (WRONG):          With termination (CORRECT):

QBLT TRUE_LABEL, R0, R1               QBLT TRUE_LABEL, R0, R1
; FALSE path                          ; FALSE path
<clear_gpo>                           <clear_gpo>
; falls through into TRUE path!       HALT          ← Flow_Control_0 stops here
TRUE_LABEL:                           TRUE_LABEL:
<set_gpo>                             <set_gpo>
                                      HALT          ← Flow_Control_1 stops here
```

### Block Flow

```
[Load Constant: data_1]   value = 4  ──┐
                                        ├──► [If/Else: If_Else_0]   condition: input1 < input2
[Load Constant: data_2]   value = 5  ──┘         │            │
                                                  │ T          │ F
                                              (4 < 5          (4 < 5
                                             = TRUE)         = FALSE)
                                                  │            │
                                                  ▼            ▼
                                           [GPO: set_gpo]  [GPO: clear_gpo]
                                                  │            │
                                                  ▼            ▼
                                        [Flow_Control_1]  [Flow_Control_0]
                                              HALT             HALT
```

Since 4 < 5 is TRUE, the T branch executes: `set_gpo` runs and the PRU halts. The `clear_gpo` path is never reached.

### Block Configuration Details

**Load Constant (`data_1`)**
- Value: 4 — feeds If/Else input1

**Load Constant (`data_2`)**
- Value: 5 — feeds If/Else input2 (the threshold)

**If/Else (`If_Else_0`)**
- Condition: `lessThanInput2` — TRUE when input1 < input2 (4 < 5 → TRUE)
- T port → `set_gpo`
- F port → `clear_gpo`
- 1 PRU cycle for the comparison and branch

**PRU GPO (`set_gpo`)**
- Sets GPO0 HIGH on the TRUE branch

**PRU GPO (`clear_gpo`)**
- Clears GPO0 LOW on the FALSE branch

**Flow Control (`Flow_Control_1`)**
- HALT — terminates the TRUE branch after `set_gpo`
- Prevents fall-through into any code that follows

**Flow Control (`Flow_Control_0`)**
- HALT — terminates the FALSE branch after `clear_gpo`
- Same reason — each branch needs its own explicit terminator

### Generated Assembly Structure

```asm
    LDI    Ra.b0, 4                 ; data_1
    LDI    Rb.b0, 5                 ; data_2
    QBLT   TRUE_LABEL, Ra.b0, Rb.b0 ; branch if Ra < Rb (4 < 5 → taken)

; FALSE path (clear_gpo)
    CLR    R30, R30, <gpo_bit>      ; clear GPO
    HALT                            ; Flow_Control_0

TRUE_LABEL:
; TRUE path (set_gpo)
    SET    R30, R30, <gpo_bit>      ; set GPO
    HALT                            ; Flow_Control_1
```

---

# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSG          | ICSSG0 - PRU0
 ICSSM          | ICSSM1 - PRU0 (am261x only)
 Toolchain      | pru-cgt
 Board          | am243x-lp, am261x-lp
 Example folder | examples/conditional/

# Steps to Run the Example

> Prerequisite: [PRU-CGT-2-3](https://www.ti.com/tool/PRU-CGT) (ti-pru-cgt) should be installed at: `C:/ti/`

- **When using CCS projects to build**, import the CCS project from the above mentioned Example folder path for R5F and PRU, After this `main.asm`, `linker.cmd` files gets copied to ccs workspace of PRU project. The `main.asm` contains sample code to halt PRU program

     - Build the PRU project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Build Flow: Once you click on build in PRU project, firmware header file which is generated in release or debug folder of ccs workspace, is moved to  `<pru-no-code-tool/examples/conditional/firmware/device/>`

     - Build the R5F project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Firmware header file path is included in R5F project include options by default, Instructions in Firmware header file can be written into PRU IRAM memory using PRUICSS_loadFirmware API (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe))
          - Build Flow: Once you click on build in R5F project, SysConfig files are generated, Finally the R5F project will be generated using both the generated SysConfig and PRU project binaries.

     - Launch a CCS debug session and run the executable, (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_LAUNCH_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_LAUNCH_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_LAUNCH_PAGE.html))
     
