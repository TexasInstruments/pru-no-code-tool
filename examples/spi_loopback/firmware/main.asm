; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:     example to SPI loopback using SPI read/write block from the pru-no-code-tool
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
    JMP sysconfig_generated_start
sysconfig_generated_end:
