/**
 * test_dual_oracle_red.js - Red Discrimination Test for Dual-Oracle Harness
 *
 * Proves that the dual-oracle harness goes RED (fails loudly) when presented
 * with an instruction modeled/accepted by the JS simulator but rejected by clpru.
 *
 * Case A: 'MULL' instruction (non-existent opcode).
 * Case B: 'ldi32 c26, 0x0002E000' (modeled/ignored by JS simulator, but rejected by clpru as invalid instruction).
 */

const { executeDualOracle } = require('./dual_oracle_harness');

function testRedDiscrimination() {
    console.log('=== Running Dual-Oracle Negative Discrimination Proof (Red Test) ===\n');

    // Case 1: MULL instruction
    console.log('Test 1: Macro with non-existent MULL opcode...');
    const mullMacro = `
m_faulty_multiply .macro OUT, IN1, IN2
    mull  OUT, IN1, IN2
.endm
`;
    let caughtMullError = null;
    try {
        executeDualOracle({
            name: 'faulty_macro_mull',
            testId: 'red_test_mull',
            initialRegisters: { r2: 50, r3: 25 },
            macro: mullMacro,
            macroArgs: { OUT: 'R4', IN1: 'R2', IN2: 'R3' }
        });
    } catch (err) {
        caughtMullError = err;
    }

    if (!caughtMullError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on MULL!');
        process.exit(1);
    }
    console.log('  -> Caught expected error: ' + caughtMullError.message.split('\n')[0]);

    // Case 2: Instruction accepted/ignored by JS simulator, but rejected by clpru
    console.log('\nTest 2: Instruction modeled/accepted by JS simulator but rejected by clpru (ldi32 c26)...');
    const invalidAsm = [
        'ldi32 c26, 0x0002E000',
        'ldi R0, 42'
    ];
    let caughtClpruError = null;
    try {
        executeDualOracle({
            name: 'invalid_c26_load_rejected_by_clpru',
            testId: 'red_test_c26',
            instructions: invalidAsm
        });
    } catch (err) {
        caughtClpruError = err;
    }

    if (!caughtClpruError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on clpru-rejected instruction!');
        process.exit(1);
    }

    console.log('  -> Caught expected clpru rejection:');
    console.log('     ' + caughtClpruError.message.split('\n').slice(0, 3).join('\n     '));

    if (!caughtClpruError.isCompilationFailure && !caughtClpruError.message.includes('COMPILATION REJECTED')) {
        console.error('❌ DISCRIMINATION FAILURE: Expected clpru compilation rejection.');
        process.exit(1);
    }

    // Case 3: Mutated design expectation in 1-Wire Reset (expected R4=0 when presence returns 1)
    console.log('\nTest 3: Mutated design expectation in 1-Wire (expected R4=0 vs actual 1)...');
    const { loadBlockModule } = require('./dual_oracle_harness');
    const onewireMod = loadBlockModule('onewire_block', 'pru_io_blocks');
    const owResetMacro = onewireMod.getMacro('', 'm_onewire_reset_standard');
    let caughtOwError = null;
    try {
        executeDualOracle({
            name: 'mutated_1wire_expectation',
            testId: 'red_test_1wire',
            initialRegisters: { r4: 0 },
            macro: owResetMacro,
            macroArgs: {
                RES: 'R4',
                PIN: '7',
                RLOW: '10',
                PWAIT: '4',
                RREC: '8'
            },
            expectedRegisters: { r4: 0 } // Mutated from true expectation 1
        });
    } catch (err) {
        caughtOwError = err;
    }

    if (!caughtOwError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on mutated 1-Wire expectation!');
        process.exit(1);
    }
    console.log('  -> Caught expected mutation mismatch: ' + caughtOwError.message.split('\n')[0]);

    // Case 4: Mutated design expectation in Quadrature transition (expected R4=99 vs actual 1)
    console.log('\nTest 4: Mutated design expectation in Quadrature (expected R4=99 vs actual 1)...');
    let caughtQuadError = null;
    try {
        executeDualOracle({
            name: 'mutated_quadrature_expectation',
            testId: 'red_test_quad',
            instructions: [
                'ldi32 R4, 0',
                'ldi32 R5, 0',
                'ldi32 R28, 0',
                'ldi R29.w0, 1',
                'lsl R29.w2, R28, 2',
                'or  R29.w2, R29.w2, R29.w0',
                'qbeq qd_fw, R29.w2, 1',
                'qba  qd_done',
                'qd_fw:',
                'add  R4, R4, 1',
                'add  R5, R5, 1',
                'qd_done:'
            ],
            expectedRegisters: { r4: 99 } // Mutated from true expectation 1
        });
    } catch (err) {
        caughtQuadError = err;
    }

    if (!caughtQuadError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on mutated Quadrature expectation!');
        process.exit(1);
    }
    console.log('  -> Caught expected mutation mismatch: ' + caughtQuadError.message.split('\n')[0]);

    // Case 5: Mutated register bit in WS2812 (invalid register syntax rejected by clpru)
    console.log('\nTest 5: Mutated invalid operand in WS2812 (R99 rejected by clpru)...');
    const ws2812Mod = loadBlockModule('ws2812_block', 'pru_io_blocks');
    const ws2812Macro = ws2812Mod.getMacro('', 'm_ws2812_tx');
    let caughtWsError = null;
    try {
        executeDualOracle({
            name: 'mutated_ws2812_invalid_reg',
            testId: 'red_test_ws2812',
            macro: ws2812Macro,
            macroArgs: {
                RES: 'R4',
                PIN: '5',
                DATA_REG: 'R99', // Invalid register R99
                NUM_LEDS: '1',
                T0H_CYC: '2',
                T0L_CYC: '2',
                T1H_CYC: '2',
                T1L_CYC: '2',
                TRESET_CYC: '5'
            }
        });
    } catch (err) {
        caughtWsError = err;
    }

    if (!caughtWsError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on invalid register!');
        process.exit(1);
    }
    console.log('  -> Caught expected invalid register rejection: ' + caughtWsError.message.split('\n')[0]);

    // Case 6: Mutated design expectation in Multi-Axis sync start (expected R10=999 vs actual 1)
    console.log('\nTest 6: Mutated design expectation in Multi-Axis Sync Start (expected R10=999 vs actual 1)...');
    let caughtMaError = null;
    try {
        executeDualOracle({
            name: 'mutated_multiaxis_sync_expectation',
            testId: 'red_test_multiaxis',
            instructions: [
                'zero &R10, 4',
                'ldi32 R2, 0x00000049',
                'or   R30, R30, R2',
                'add  R10, R10, 1'
            ],
            expectedRegisters: { r10: 999 } // Mutated from true expectation 1
        });
    } catch (err) {
        caughtMaError = err;
    }

    if (!caughtMaError) {
        console.error('❌ DISCRIMINATION FAILURE: Dual-oracle harness unexpectedly PASSED on mutated Multi-Axis expectation!');
        process.exit(1);
    }
    console.log('  -> Caught expected mutation mismatch: ' + caughtMaError.message.split('\n')[0]);

    console.log('\n✅ RED PROOF VERIFIED: The dual-oracle harness successfully went RED on all negative test cases.');
}

testRedDiscrimination();

