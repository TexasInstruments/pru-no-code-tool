; Copyright (C) 2024 Texas Instruments Incorporated - http://www.ti.com/
;
; Redistribution and use in source and binary forms, with or without
; modification, are permitted provided that the following conditions
; are met:
;
; Redistributions of source code must retain the above copyright
; notice, this list of conditions and the following disclaimer.
;
; Redistributions in binary form must reproduce the above copyright
; notice, this list of conditions and the following disclaimer in the
; documentation and/or other materials provided with the
; distribution.
;
; Neither the name of Texas Instruments Incorporated nor the names of
; its contributors may be used to endorse or promote products derived
; from this software without specific prior written permission.
;
; THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
; "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
; LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
; A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
; OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
; SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
; LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
; DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
; THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
; (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
; OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

;************************************************************************************
;   File:     pru_syscfg.asm
;
;   Brief:    sysconfig generated pru firmware
;************************************************************************************

    ;sysconfig_generated_start label should be invoked from main.asm to run sysconfig generated code
    .global     sysconfig_generated_start
    ;sysconfig_generated_end label should be defined in main.asm to transfer back control to main.asm
    .ref        sysconfig_generated_end


;************************************* includes *************************************
    .include    "pru_syscfg.inc"

    .retain     ; Required for building .out with assembly file
    .retainrefs ; Required for building .out with assembly file


;************************************************************************************
;   Uninitialized memory reservations (.usect)
;************************************************************************************

    .retain     ; Required for building .out with assembly file
    .retainrefs ; Required for building .out with assembly file
    .sect       ".text"
;**************************************************************************************
;                       syconfig_generated
;**************************************************************************************
;**************************************************************************************
; Register Allocation Summary
;
; NOTE: When each block's code is executed, the registers listed below
;       will be actively used for their respective functions. The values
;       stored in these registers may be modified during execution.
;       Avoid using these registers in your custom code to prevent conflicts.
; TEMP_REG1 (R28) -> Used by all macros
; TEMP_REG2 (R29) -> Used by all macros
;
;--------------------------------------------------------------------------------------
; OVERALL PEAK CYCLES: 2 cycles (worst-case timing) including group and non-group code
;--------------------------------------------------------------------------------------
;**************************************************************************************

;**************************************************************************************
;                    PRU assembly code outside group block
;**************************************************************************************
sysconfig_generated_start:
    ;PRU Instruction of Flow_Control_0
    HALT 
    ;Incase program is reached here, halt so that code related to group blocks is not executed
    halt


;**************************************************************************************
;                 PRU assembly code of Group blocks
;**************************************************************************************
