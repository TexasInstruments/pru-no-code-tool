; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:    example to show how to send incremental data using loop block and SPI block from the pru-no-code-tool
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
    ; an example in which we send incremental data through the SPI protocol ( data from 1 - 10 (LSB first)) using the pru-no-code-tool
    ; the preinit feature of the loop block is employed for this purpose , check the description of the loop block for more info ! 
    zero &r0,120 
    JMP     sysconfig_generated_start
sysconfig_generated_end:
    halt
