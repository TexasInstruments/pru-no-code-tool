; SPDX-License-Identifier: BSD-3-Clause
; Copyright (C) 2024-2025 Texas Instruments Incorporated - http://www.ti.com/

;***************************************************************************************
;   File:     main.asm
;
;   Brief:    IPC loop — waits for R5F to set trigger byte in SMEM,
;             runs no-code TX/RX, stores result, clears trigger.
;
;   Shared memory layout (0x30010000 = PRU1 DRAM physical base):
;       offset 0x00 : uint8_t  trigger  (R5F writes 1; PRU clears to 0 when done)
;       offset 0x01 : uint8_t  reserved[3]
;       offset 0x04 : uint32_t result   (PRU writes RX result R0 here)
;
;***************************************************************************************

; CCS/makefile specific settings
    .retain     ; Required for building .out with assembly file
    .retainrefs ; Required for building .out with assembly file

    .global     main
    .ref        sysconfig_generated_start
    .global     sysconfig_generated_end
    .sect       ".text:main"

IPC_BASE_ADDR       .set    0x30010000
IPC_TRIGGER_OFFSET  .set    0x00
IPC_RESULT_OFFSET   .set    0x04

;********
;* MAIN *
;********

main:
    zero    &r0, 120                        ; Clear all registers at startup

    ; R10 = IPC base address (kept throughout, no conflict with no-code macros)
    ; R11 = scratch register for IPC reads/writes
    LDI32   R10, IPC_BASE_ADDR

    ; Clear trigger and result so R5F sees a clean state
    LDI     R11, 0
    SBBO    &R11, R10, IPC_TRIGGER_OFFSET, 4  ; clears trigger + 3 reserved bytes
    SBBO    &R11, R10, IPC_RESULT_OFFSET,  4  ; clears result
    JMP     sysconfig_generated_start
sysconfig_generated_end:
    halt   ; should never reach here as infinite loop 