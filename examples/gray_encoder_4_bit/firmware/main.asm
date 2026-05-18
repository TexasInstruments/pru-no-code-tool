; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:    example to show how to build a 4 bit gray encoder using pru-no-code-tool 
;
;   Steps to build :
;
;   - Using ccs:
;             - Import pru project to ccs workspace
;             - main.asm file gets copied to ccs workspace
;             - Modify main.asm file
;             - Build the pru project, after which .out (Executable output file) and .h (Firmware header) files gets generated
;             - Either .out (Executable output file) can be loaded to PRU using ccs or R5F can write to PRU IRAM using PRUICSS driver
;   - Using makefile:
;             - Use command gmake -all to build PRU project     
;
;***************************************************************************************

; CCS/makefile specific settings
    .retain     ; Required for building .out with assembly file
    .retainrefs ; Required for building .out with assembly file

    .include    "pru_syscfg.inc"

    .global     main
    .ref        gray_encoder_start
    .sect       ".text:main"

;********
;* MAIN *
;********

main:
    zero    &r0, 120

    ; 4-bit Binary-to-Gray Code Encoder using PRU No-Code Tool blocks:
    ;
    ;   [Load Constant (binary_index)] --> [Access Lookup Table (gray_encode)]
    ;        R0.b2 = 5 (input)                 R0.b3 = lut[R0.b2] (output)
    ;
    ; The Lookup Table block (gray_encoder_lut) holds 16 pre-computed Gray code
    ; values in PRU DMEM (written by R5F before PRU starts). The Access Lookup
    ; Table block reads lut[index] in 5 cycles using LDI32 + LBBO.
    ;
    ; These blocks are wrapped in a Group block (gray_encoder).
    ; Group blocks generate a named subroutine (gray_encoder_start) that can be
    ; called from main.asm using CALL, and auto-generate a return (JMP RET_ADDR0).
    ; This keeps the sysconfig-generated code modular and reusable.
    ; Refer to the Group block description in SysConfig for full details.
    CALL    gray_encoder_start

    ; R0.b2 = binary input index (4-bit), R0.b3 = Gray code encoded output
    LDI32   R2, 0x30010000
    SBBO    &R0.b2, R2, 0, 1   ; Store input  at SMEM[0x30010000 + 0]
    SBBO    &R0.b3, R2, 1, 1   ; Store output at SMEM[0x30010000 + 1]
    halt
