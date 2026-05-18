; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:    assembly code to demonstrate conditional and bitwise operations capabilities of pru-no-code-tool
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

    .global     main
    .ref        sysconfig_generated_start
    .global     sysconfig_generated_end 
    .sect       ".text:main"

;********
;* MAIN *
;********

main:
    ; a simple example showing the conditional and bitwise blocks of the pru-no-code tool 
    ; based on the if/else condition , we set/clear the bit 7 of the data 
    ; then we set/clear gpo0 and store the results in smem for r5f processing  

    ; the result is stored in R0.b1 
    zero &r0,120 
    JMP     sysconfig_generated_start
sysconfig_generated_end:
    ; Store results to SMEM (base address 0x30010000)
    ; R28 = SMEM base address
    LDI32   R28, 0x30010000

    ; Check R30 bit 0 to determine which branch was taken
    ; bit 0 clear -> TRUE branch (data_1 >= data_2): bit_set result in R0.b2, smem[0]=0
    ; bit 0 set   -> FALSE branch (data_1 < data_2): bit_clear result in R1.b1, smem[0]=1
    QBBS    gpo_was_set, R30, 0

gpo_was_cleared:
    ; smem[0] = 0 (TRUE branch: bit 7 was set)
    LDI     R29.b0, 0
    SBBO    &R29.b0, R28, 0, 1
    ; smem[1] = R0.b2 (bit_set result)
    SBBO    &R0.b2, R28, 1, 1
    ; smem[2] = R0.b0 (bit_set_original_data)
    SBBO    &R0.b0, R28, 2, 1
    JMP     store_done

gpo_was_set:
    ; smem[0] = 1 (FALSE branch: bit 7 was cleared)
    LDI     R29.b0, 1
    SBBO    &R29.b0, R28, 0, 1
    ; smem[1] = R1.b1 (bit_clear result)
    SBBO    &R1.b1, R28, 1, 1
    ; smem[2] = R0.b3 (bit_clear_original_data)
    SBBO    &R0.b3, R28, 2, 1

store_done:
    halt
