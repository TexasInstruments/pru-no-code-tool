; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:     example to show UART and CRC functionality with pru-no-code-tool
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

; Registers this file reads after the generated code. The register allocator chooses them, so they are
; named once here. Only a block whose output no other block consumes keeps its register to the end (a
; consumed value is released and its register reused), which is why the pru1 design ends with the
; "Received_Frame" block.
    .if	$isdefed("PRU0")
; pru0: Memory_Access_3 loads the TX frame {data byte, CRC} from buffer; the UART TX block sends it
    .asg    R0.b0, TX_DATA_REG   ; data byte of the frame that was sent (0xAA)
    .elseif $isdefed("PRU1")
; pru1: CRC_0 = CRC computed over the received data byte; Received_Frame = {received data byte, received CRC}
    .asg    R0.b2, CRC_CALC_REG  ; CRC computed by CRC_0
    .asg    R0.b0, RX_DATA_REG   ; received data byte
    .asg    R0.b1, CRC_RX_REG    ; received CRC
    .endif

main:
    .if	$isdefed("PRU0")
     zero  &r0, 120 ; Clear the register space
    JMP sysconfig_generated_start
sysconfig_generated_end:
    .if	$isdefed("SOC_AM243X")
    LDI32  R2, 0x30010000
    .elseif $isdefed("SOC_AM261X")
    LDI32  R2, 0x48010000
    .endif
    ; Store TX data sent at SMEM[4] using SBBO
    SBBO   &TX_DATA_REG, R2, 4, 1
    halt
    .elseif	$isdefed("PRU1")
    zero   &r0, 120 ; Clear the register space
    JMP  sysconfig_generated_start

sysconfig_generated_end:
    ; Store CRC values to SMEM using absolute address 0x30010000
    ; CRC_CALC_REG = CRC computed from the received data, CRC_RX_REG = CRC received with it

    ; Load SMEM base address into R2
    .if	$isdefed("SOC_AM243X")
    LDI32  R2, 0x30010000
    .elseif $isdefed("SOC_AM261X")
    LDI32  R2, 0x48010000
    .endif

    ; Store RX calculated CRC at SMEM[0] using SBBO
    SBBO   &CRC_CALC_REG, R2, 0, 1

    ; Store TX received CRC at SMEM[1] using SBBO
    SBBO   &CRC_RX_REG, R2, 1, 1

    ; Store the received data byte at SMEM[3]
    SBBO   &RX_DATA_REG, R2, 3, 1

    ; Compare the two CRC values
    QBEQ   crc_match, CRC_RX_REG, CRC_CALC_REG

    ; CRC mismatch - store 0xFF at SMEM[2]
    LDI    R3.b0, 0xFF
    SBBO   &R3.b0, R2, 2, 1     ; Store 0xFF at [smem + 2]
    JMP    end_check

crc_match:
    ; CRC match - store 0x01 at SMEM[2]
    LDI    R3.b0, 0x01
    SBBO   &R3.b0, R2, 2, 1     ; Store 0x01 at [smem + 2]

end_check:
    HALT 
    .endif

