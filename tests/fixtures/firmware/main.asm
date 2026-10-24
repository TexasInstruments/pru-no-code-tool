; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:    Test fixture: jumps to the SysConfig-generated code and halts at
;             sysconfig_generated_end, so a test can link one generated
;             pru_syscfg.asm and run it to completion on the simulator.
;
;***************************************************************************************

; CCS/makefile specific settings
    .retain     ; Required for building .out with assembly file
    .retainrefs ; Required for building .out with assembly file

    .global     main
    .ref        sysconfig_generated_start
    .sect       ".text:main"

;********
;* MAIN *
;********

main:
    ; halt the program after jumping to sysconfig generated start
    JMP     sysconfig_generated_start

    .global sysconfig_generated_end
sysconfig_generated_end:
    halt
