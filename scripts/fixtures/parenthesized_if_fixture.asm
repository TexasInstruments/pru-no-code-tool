; red-arm fixture: the comment and outer parentheses must not make
; the emitter lose the selected instruction.
m_parenthesized_if_fixture .macro VALUE
    .if (VALUE == 1) ; selected instruction
        ldi R10, 1
    .endif
    .endm
