# 4-bit Gray Code Encoder

## Introduction

This example demonstrates the use of the pru-no-code-tool to implement a 4-bit binary-to-Gray code encoder using the **Lookup Table** and **Access Lookup Table** blocks, organized inside a **Group** block.

A 16-entry Lookup Table is pre-loaded into PRU DMEM by the R5F before the PRU starts. The Access Lookup Table block reads the Gray code value corresponding to the 4-bit binary input index in 5 PRU cycles (LDI32 + LBBO). The two blocks are wrapped in a Group block, which generates a named subroutine (`gray_encoder_start`) that is called from `main.asm` using the `CALL` macro.

The R5F reads the result from PRU ICSSG0 Shared RAM (SMEM at `0x30010000`) and prints the binary input and its Gray code output over the UART console.

---

## No-Code Tool Block Design

This example introduces two concepts working together: the **Lookup Table + Access Lookup Table** pair for O(1) data conversion, and the **Group block** for packaging that logic into a named callable subroutine.

### The Group Block's Role

All blocks in this design live inside a Group block named `gray_encoder`. A Group generates a standalone assembly subroutine — `gray_encoder_start` — rather than inline code. The PRU does not execute the group automatically; `main.asm` calls it explicitly with `CALL gray_encoder_start`, execution runs through the two blocks inside, and control returns to `main.asm` automatically (the tool appends `JMP RET_ADDR0`).

This is the key difference from previous examples: the no-code blocks here define a **reusable function**, not a linear program.

### Block Flow

```
main.asm:
    CALL gray_encoder_start
        │
        ▼
┌─── [Group: gray_encoder] ──────────────────────────────┐
│                                                         │
│   [Load Constant: binary_index]   value = 5             │
│           │  (index)                                    │
│           ▼                                             │
│   [Access Lookup Table: gray_encode]                    │
│       table: gray_encoder_lut                           │
│       input: binary_index output (5)                    │
│       output: Gray code at index 5 → 7 (0b0111)        │
│                                                         │
└─────────────────────────────────────────────────────────┘
        │
        ▼  (automatic return to main.asm)
    result register holds Gray code value
```

### Block Configuration Details

**Load Constant (`binary_index`)**
- Value: 5 — the 4-bit binary input to encode (range 0–15)
- Acts as the index into the lookup table
- Rename from the default `Load_Constant_0` to `binary_index` — makes the data flow self-documenting

**Access Lookup Table (`gray_encode`)**
- Table: `gray_encoder_lut`
- input1: `binary_index` output (value 5)
- Performs a 5-cycle table lookup (LDI32 base address + LBBO byte read)
- Output: the Gray code byte at index 5 → **7** (0x07, binary `0111`)

**Lookup Table (`gray_encoder_lut`)**
- Init pattern: manual
- 16 entries covering all 4-bit inputs (0–15):

```
Binary │  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15
Gray   │  0   1   3   2   6   7   5   4  12  13  15  14  10  11   9   8
```

This is the standard binary-to-Gray conversion (`Gray = N XOR (N >> 1)`). The table is pre-loaded into PRU DMEM by the R5F before the PRU starts.

**Group (`gray_encoder`)**
- `$name`: `gray_encoder` (SysConfig instance ID)
- `groupName`: `gray_encoder` (generates assembly label `gray_encoder_start`)
- Contains: `binary_index`, `gray_encode`
- No Flow Control block needed — the tool automatically appends the return instruction
- Has no prev/next ports; called exclusively via `CALL` from `main.asm`

### Generated Assembly Structure

```asm
; sysconfig_generated_start section is empty (no ungrouped blocks)

; Group subroutine — only executes when called
gray_encoder_start:
    LDI    Rx.b0, 5                     ; binary_index = 5
    LDI32  Ry, <gray_encoder_lut_addr>  ; load LUT base address
    LBBO   &Rx.b0, Ry, Rx.b0, 1        ; Rx.b0 = lut[5] = 7
    JMP    RET_ADDR0                    ; return to caller
```

### main.asm Integration

```asm
    .include "pru_syscfg.inc"       ; required — defines CALL macro and RET_ADDR0
    .ref    sysconfig_generated_start
    .ref    gray_encoder_start      ; reference the group's generated label

main:
    zero    &r0, 120
    CALL    gray_encoder_start      ; execute the encoder, result in output register
    ; result (Gray code = 7) now available in register
    ; main.asm stores it to SMEM for R5F to read
    HALT
```

---

# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSG          | ICSSG0 - PRU0
 ICSSM          | ICSSM1 - PRU1 (am261x only)
 Toolchain      | pru-cgt
 Board          | am243x-lp, am261x-lp
 Example folder | examples/gray_encoder_4_bit/

# Steps to Run the Example

> Prerequisite: [PRU-CGT-2-3](https://www.ti.com/tool/PRU-CGT) (ti-pru-cgt) should be installed at: `C:/ti/`

- **When using CCS projects to build**, import the CCS project from the above mentioned Example folder path for R5F and PRU, After this `main.asm`, `linker.cmd` files gets copied to ccs workspace of PRU project. The `main.asm` contains sample code to halt PRU program

     - Build the PRU project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Build Flow: Once you click on build in PRU project, firmware header file which is generated in release or debug folder of ccs workspace, is moved to  `<pru-no-code-tool/examples/gray_encoder_4_bit/firmware/device/>`

     - Build the R5F project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Firmware header file path is included in R5F project include options by default, Instructions in Firmware header file can be written into PRU IRAM memory using PRUICSS_loadFirmware API (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe))
          - Build Flow: Once you click on build in R5F project, SysConfig files are generated, Finally the R5F project will be generated using both the generated SysConfig and PRU project binaries.

     - Launch a CCS debug session and run the executable, (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_LAUNCH_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_LAUNCH_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_LAUNCH_PAGE.html))
     
