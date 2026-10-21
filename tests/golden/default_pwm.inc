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
;   File:     pru_syscfg.inc
;
;   Brief:    sysconfig generated pru macros
;************************************************************************************

;************************************* PRU/ICSSG definitions ************************
; Define ICSSG instance, SLICE, and PRU symbols (if not already defined by compiler)
    .if    !$defined("ICSSG0")
ICSSG0      .set 1
    .endif
    .if    !$defined("PRU0")
PRU0        .set 1
    .endif
    .if    !$defined("SLICE0")
SLICE0      .set 1
    .endif





;************************************* register definitions *************************
            .asg	R28,	   TEMP_REG1
            .asg	R29,	   TEMP_REG2
            .asg	R26,	   TEMP_REG3
            .asg	R27,	   TEMP_REG4

;**********************************
;*    subroutine macros           *
;**********************************

;**********************************
;*    auto generated macros       *
;**********************************


m_pwm_run .macro RES, PIN, PERIOD_COUNTS, DUTY_COUNTS, ACTIVE_HIGH, EN_COMP, COMP_PIN, DEADBAND_COUNTS
    ; IEP setup. Per TRM SPRUIM2J 6.4.13 the counter only runs when
    ; GLOBAL_CFG[0] CNT_ENABLE is set, GLOBAL_CFG[7:4] DEFAULT_INC is the
    ; step size, and a compare only fires when its CMP_CFG[16:1] CMP_EN bit
    ; is set - CMP_EN starts at bit 1, so CMP0 is bit 1 and CMP1 is bit 2.
    ; Omitting these left the block waiting on a compare that never fired.
    ; Order matters. Enabling the counter or the compares before the
    ; compare values are installed leaves stale CMP0/CMP1 live against a
    ; running counter, which can fire an event and reset the period before
    ; this macro's values land - visible on re-invocation. TRM 6.4.13
    ; sequence: disable, program, clear status, then enable last.
    ldi32 TEMP_REG1, 0
    sbco  &TEMP_REG1, c26, 0x00, 4
    sbco  &TEMP_REG1, c26, 0x70, 4
    sbco  &TEMP_REG1, c26, 0x10, 4
    ldi32 TEMP_REG1, 0x3
    sbco  &TEMP_REG1, c26, 0x74, 4
    ldi32 TEMP_REG1, PERIOD_COUNTS
    sbco  &TEMP_REG1, c26, 0x78, 4
    ldi32 TEMP_REG1, DUTY_COUNTS
    ; 0x50 is CMP1_REG0. 0x4C is CMP0's UPPER half - the compare registers
    ; are 64-bit pairs (IEP_CMPj_REG0/REG1), so writing duty there corrupted
    ; CMP0 and left CMP1 unprogrammed.
    sbco  &TEMP_REG1, c26, 0x80, 4
    ldi32 TEMP_REG1, 0x7
    sbco  &TEMP_REG1, c26, 0x70, 4
    ldi32 TEMP_REG1, 0x11
    sbco  &TEMP_REG1, c26, 0x00, 4
pw_l?:
    .if ACTIVE_HIGH
    .if EN_COMP == 1
    clr   R30, R30, COMP_PIN
    .endif
    set   R30, R30, PIN
    .else
    .if EN_COMP == 1
    set   R30, R30, COMP_PIN
    .endif
    clr   R30, R30, PIN
    .endif
pw_wd?:
    lbco  &TEMP_REG1, c26, 0x74, 4
    qbbc  pw_wd?, TEMP_REG1, 1
    .if ACTIVE_HIGH
    clr   R30, R30, PIN
    .if EN_COMP == 1
    ; TODO: insert DEADBAND_COUNTS delay here before toggling comp pin
    set   R30, R30, COMP_PIN
    .endif
    .else
    set   R30, R30, PIN
    .if EN_COMP == 1
    ; TODO: insert DEADBAND_COUNTS delay here before toggling comp pin
    clr   R30, R30, COMP_PIN
    .endif
    .endif
    ldi32 TEMP_REG1, 2
    sbco  &TEMP_REG1, c26, 0x74, 4
pw_wp?:
    lbco  &TEMP_REG1, c26, 0x74, 4
    qbbc  pw_wp?, TEMP_REG1, 0
    ldi32 TEMP_REG1, 1
    sbco  &TEMP_REG1, c26, 0x74, 4
    qba   pw_l?
    .endm
