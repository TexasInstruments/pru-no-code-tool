function validate(inst, report) {
	// Port connection warnings
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}

	// Pin uniqueness validation (for both Controller and Peripheral modes)
	const csPin = inst["CS Signal"];
	const sclkPin = inst["SCLK Signal"];
	const sdoPin = inst["SDO Signal"];

	if (csPin === sclkPin) {
		report.logError("CS Signal and SCLK Signal cannot use the same pin", inst, "CS Signal");
	}
	if (csPin === sdoPin) {
		report.logError("CS Signal and SDO Signal cannot use the same pin", inst, "CS Signal");
	}
	if (sclkPin === sdoPin) {
		report.logError("SCLK Signal and SDO Signal cannot use the same pin", inst, "SCLK Signal");
	}

	// Mode-specific pulse width validation (only for Controller mode)
	if (inst["Device Mode"] === "controller") {
		const mode = inst["SPI Mode"];
		const high = inst["sclk high pulse width (in PRU cycles)"];
		const low = inst["sclk low pulse width (in PRU cycles)"];

		if (mode === "MODE0") {
			// delay_component1 = high - 2, delay_component2 = low - 6
			if (high < 2) {
				report.logError("MODE0: SCLK High Width must be at least 2 cycles (overhead compensation for delay_component1)", inst, "sclk high pulse width (in PRU cycles)");
			}
			if (low < 6) {
				report.logError("MODE0: SCLK Low Width must be at least 6 cycles (overhead compensation for delay_component2)", inst, "sclk low pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE1") {
			// delay_component1 = high - 4, delay_component2 = low - 3
			if (high < 4) {
				report.logError("MODE1: SCLK High Width must be at least 4 cycles (overhead compensation for delay_component1)", inst, "sclk high pulse width (in PRU cycles)");
			}
			if (low < 3) {
				report.logError("MODE1: SCLK Low Width must be at least 3 cycles (overhead compensation for delay_component2)", inst, "sclk low pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE2") {
			// delay_component1 = low - 1, delay_component2 = high - 6
			if (low < 1) {
				report.logError("MODE2: SCLK Low Width must be at least 1 cycle (overhead compensation for delay_component1)", inst, "sclk low pulse width (in PRU cycles)");
			}
			if (high < 6) {
				report.logError("MODE2: SCLK High Width must be at least 6 cycles (overhead compensation for delay_component2)", inst, "sclk high pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE3") {
			// delay_component1 = low - 4, delay_component2 = high - 3
			if (low < 4) {
				report.logError("MODE3: SCLK Low Width must be at least 4 cycles (overhead compensation for delay_component1)", inst, "sclk low pulse width (in PRU cycles)");
			}
			if (high < 3) {
				report.logError("MODE3: SCLK High Width must be at least 3 cycles (overhead compensation for delay_component2)", inst, "sclk high pulse width (in PRU cycles)");
			}
		}
	}
}
/**
 * Returns the body of a specific macro based on the macro name with parameters replaced
 * @param {string} pruInstructionMacro - The macro instruction string that contains the macro name and parameters
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";

    // Extract the macro name and parameters from the pruInstructionMacro
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode; // First part is the macro name
    const dataReg = parts[1] || "dataReg";
    const PACKETSIZE = parts[2] || "PACKETSIZE";
    const bitId = parts[3] || "bitId";
    const SCLK_PIN = parts[4] || "SCLK_PIN";
    const SDO_PIN = parts[5] || "SDO_PIN";
    const DELAY_COMPEN_1 = parts[6] || "DELAY_COMPEN_1";
    const DELAY_COMPEN_2 = parts[7] || "DELAY_COMPEN_2";
    // For Controller mode, CS_PIN is 8th parameter (index 8)
    // For Peripheral mode, CS_PIN is 6th parameter (index 6) - MODE parameter removed
    const CS_PIN = macroName.includes("slave") ? (parts[6] || "CS_PIN") : (parts[8] || "CS_PIN");
    const CS_FILTER_CYCLES = parts[7] || "CS_FILTER_CYCLES"; // For Peripheral mode, 7th parameter is CS_FILTER_CYCLES
    const CS_SETUP_TIME = parts[9] || "CS_SETUP_TIME"; // For Controller mode, 9th parameter is CS_SETUP_TIME
    const CS_HOLD_TIME = parts[10] || "CS_HOLD_TIME"; // For Controller mode, 10th parameter is CS_HOLD_TIME
    const DATA_SETUP_TIME = parts[11] || "DATA_SETUP_TIME"; // For Controller mode, 11th parameter is DATA_SETUP_TIME

	if(pruInstructionMacro == "")
    {
		if (macroName.includes("slave")) {
			macroBody = macroName + "	" + ".macro  " + dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDO_PIN + ", CS_PIN, CS_FILTER_CYCLES\n";
			// Add parameter documentation for Peripheral (slave) mode
			macroBody += `	; Parameters:
	;   dataReg           - Register containing data to transmit
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock input pin number (GPI)
	;   SDO_PIN           - Serial data output pin number (GPO)
	;   CS_PIN            - Chip select input pin number (GPI)
	;   CS_FILTER_CYCLES  - CS filter cycles for glitch rejection
`;
		} else {
			macroBody = macroName + "	" + ".macro  " + dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDO_PIN + ", " + DELAY_COMPEN_1 + ", " + DELAY_COMPEN_2 + ", CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME\n";
			// Add parameter documentation for Controller (master) mode
			macroBody += `	; Parameters:
	;   dataReg           - Register containing data to transmit
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock output pin number (GPO)
	;   SDO_PIN           - Serial data output pin number (GPO)
	;   DELAY_COMPEN_1    - High pulse delay compensation (PRU cycles)
	;   DELAY_COMPEN_2    - Low pulse delay compensation (PRU cycles)
	;   CS_PIN            - Chip select output pin number (GPO)
	;   CS_SETUP_TIME     - Setup time after CS assertion (PRU cycles)
	;   CS_HOLD_TIME      - Hold time before CS deassertion (PRU cycles)
	;   DATA_SETUP_TIME   - Data setup time after clock edge (PRU cycles)
`;
		}
	}
    // Define macros using template literals with direct parameter substitution
    // Controller mode macros
    if (macroName === "m_send_packet_spi_mode1_msb_gpo_sclk") {
        macroBody += `	clr r30, r30,    ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
SEND_BIT_LOOP?:
	set r30, r30,   ${SCLK_PIN}
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
    }
    if (macroName === "m_send_packet_spi_mode1_lsb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	set r30, r30,   ${SCLK_PIN}
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1} ; 0
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2} ; 1
	nop
	.endloop
	add             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

    // MODE0 Controller mode macros (CPOL=0, CPHA=0) - Clock idles LOW
    if (macroName === "m_send_packet_spi_mode0_msb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
SEND_BIT_LOOP?:
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
    }
    if (macroName === "m_send_packet_spi_mode0_lsb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	add             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

    // MODE3 Controller mode macros (CPOL=1, CPHA=1) - Clock idles HIGH
    if (macroName === "m_send_packet_spi_mode3_msb_gpo_sclk") {
        macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
SEND_BIT_LOOP?:
	clr r30, r30,   ${SCLK_PIN}
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
    }
    if (macroName === "m_send_packet_spi_mode3_lsb_gpo_sclk") {
        macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	clr r30, r30,   ${SCLK_PIN}
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	add             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

    // MODE2 Controller mode macros (CPOL=1, CPHA=0) - Clock idles HIGH
    if (macroName === "m_send_packet_spi_mode2_msb_gpo_sclk") {
        macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
SEND_BIT_LOOP?:
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
    }
    if (macroName === "m_send_packet_spi_mode2_lsb_gpo_sclk") {
        macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	qbbc            skip_data_high?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba             skip_data_low?
skip_data_high?:
	clr r30, r30,   ${SDO_PIN}
	nop
skip_data_low?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	add             ${bitId}, ${bitId}, 1
	qbne            SEND_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Peripheral mode macros - MODE0
	if (macroName === "m_send_packet_spi_mode0_slave_msb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
	; MODE0 BEGINNING: No wait - shift data right away
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0
	sub     ${bitId}, ${bitId}, 1
	; MODE0 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
SEND_BIT_LOOP_END?:`;
	}
	if (macroName === "m_send_packet_spi_mode0_slave_lsb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
	; MODE0 BEGINNING: No wait - shift data right away
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
	; MODE0 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral mode macros - MODE1
	if (macroName === "m_send_packet_spi_mode1_slave_msb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
	; MODE1 BEGINNING: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0
	sub     ${bitId}, ${bitId}, 1
	; MODE1 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
SEND_BIT_LOOP_END?:`;
	}
	if (macroName === "m_send_packet_spi_mode1_slave_lsb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
	; MODE1 BEGINNING: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
	; MODE1 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral mode macros - MODE2
	if (macroName === "m_send_packet_spi_mode2_slave_msb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
	; MODE2 BEGINNING: No wait - shift data right away
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0
	sub     ${bitId}, ${bitId}, 1
	; MODE2 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
SEND_BIT_LOOP_END?:`;
	}
	if (macroName === "m_send_packet_spi_mode2_slave_lsb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
	; MODE2 BEGINNING: No wait - shift data right away
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
	; MODE2 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral mode macros - MODE3
	if (macroName === "m_send_packet_spi_mode3_slave_msb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
	; MODE3 BEGINNING: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0
	sub     ${bitId}, ${bitId}, 1
	; MODE3 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
SEND_BIT_LOOP_END?:`;
	}
	if (macroName === "m_send_packet_spi_mode3_slave_lsb_gpo_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
	; MODE3 BEGINNING: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
	; MODE3 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	if(pruInstructionMacro == "")
    {
		macroBody += "\n" + " .endm";
	}
    return macroBody;
}

function getAIContext() {
    return getLongDescription() + `
	## How to Configure (For AI/Scripting)
	
	This section describes how to programmatically configure the SPI Write block in a .syscfg file.
	
	### Adding a SPI Write Instance
	
	\\\`\\\`\\\`javascript
	const pru_spi_write = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_write", {}, false);
	const spi_write1 = pru_spi_write.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
	| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE1" | Clock polarity and phase |
	| packetSize | Integer | 8-32 | 8 | Number of bits to write |
	| Endiness | String | "most significant bit first", "least significant bit first" | "least significant bit first" | Bit order |
	| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
	| SDO Signal | String | "0"-"19" | "1" | GPIO pin for data output |
	| CS Signal | String | "0"-"19" | "2" | GPIO pin for chip select |
	| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock high time (Controller only) |
	| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
	| CS Setup Time | Integer | 0-10000 | 10 | CS setup time in nanoseconds (Controller only) |
	| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
	| Data Setup Time | Integer | 0-100 | 0 | Data setup time in PRU cycles (Controller only) |
	| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |
	
	### Example Configurations
	
	**SPI Controller Write, MODE1, 8-bit, LSB first:**
	\\\`\\\`\\\`javascript
	spi_write1.$name = "SPI_Write_0";
	spi_write1["Device Mode"] = "controller";
	spi_write1["SPI Mode"] = "MODE1";
	spi_write1.packetSize = 8;
	spi_write1["Endiness"] = "least significant bit first";
	spi_write1["SCLK Signal"] = "0";
	spi_write1["SDO Signal"] = "1";
	spi_write1["CS Signal"] = "2";
	spi_write1["sclk high pulse width (in PRU cycles)"] = 7;
	spi_write1["sclk low pulse width (in PRU cycles)"] = 7;
	spi_write1["CS Setup Time"] = 10;
	spi_write1["CS Hold Time"] = 10;
	\\\`\\\`\\\`
	
	**SPI Peripheral Write, MODE0, 32-bit, MSB first:**
	\\\`\\\`\\\`javascript
	spi_write1.$name = "SPI_Peripheral_Write";
	spi_write1["Device Mode"] = "peripheral";
	spi_write1["SPI Mode"] = "MODE0";
	spi_write1.packetSize = 32;
	spi_write1["Endiness"] = "most significant bit first";
	spi_write1["SCLK Signal"] = "4";         // Input pin for clock
	spi_write1["SDO Signal"] = "5";          // Output pin for data
	spi_write1["CS Signal"] = "6";           // Input pin for CS
	spi_write1["CS Filter Cycles"] = 2;
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// Connect data source to SPI Write input (data to transmit)
	scripting.connect(load_constant1, "output1", spi_write1, "input1");
	
	// Connect control flow
	scripting.connect(prev_block, "next", spi_write1, "prev");
	scripting.connect(spi_write1, "next", next_block, "prev");
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI). SDO is always output (GPO).
	
	2. **Pin Uniqueness**: All three signals (CS, SCLK, SDO) must use different GPIO pins.
	
	3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	   - MODE0: Min High=2, Min Low=6
	   - MODE1: Min High=4, Min Low=3
	   - MODE2: Min High=6, Min Low=1
	   - MODE3: Min High=3, Min Low=4
	
	4. **Input Required**: This block requires a data input connection. Connect a Load Constant block or other data source to input1.
	
	5. **Write-Only Operation**: This block only writes data to the SPI bus. Use SPI Read or SPI Transfer for receiving data.
	`;
}

function getLongDescription() {
		return `
	## PRU SPI Write Block

	### Purpose
	Implements SPI (Serial Peripheral Interface) protocol to write data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins.

	### How It Works

	**Controller Mode:**
	1. **Connect Input**: Connect data source to input port
	2. **Configure Pins**: Select SCLK (clock output), SDO (data output), and CS (chip select output) pins
	3. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
	4. **Execute**: Generates bit-banged SPI write sequence with proper timing

	**Peripheral Mode:**
	1. **Connect Input**: Connect data source to input port
	2. **Configure Pins**: Select SCLK (clock input), SDO (data output), and CS (chip select input) pins
	3. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
	4. **Execute**: Waits for CS assertion and controller clock, then writes data

	### SPI Protocol
	SPI is a synchronous serial communication protocol with:
	- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
	- **SDO (Serial Data Out)**: Data line from PRU to device
	- **CS (Chip Select)**: Activates the peripheral device (active low)
	- **Modes**: Determines clock polarity (CPOL) and phase (CPHA)

	### Configuration Parameters

	**Device Mode**: Select Controller or Peripheral operation mode

	**SPI Mode**: Select MODE0-3 based on clock polarity and phase
	- **MODE0** (CPOL=0, CPHA=0): Clock idles low, data sampled on rising edge, shifted on falling edge
	- **MODE1** (CPOL=0, CPHA=1): Clock idles low, data sampled on falling edge, shifted on rising edge
	- **MODE2** (CPOL=1, CPHA=0): Clock idles high, data sampled on falling edge, shifted on rising edge
	- **MODE3** (CPOL=1, CPHA=1): Clock idles high, data sampled on rising edge, shifted on falling edge

	**Packet Size**: Number of bits to write (8-32)
	- 8 bits = 1 byte (most common)
	- 16 bits = 2 bytes
	- 32 bits = 4 bytes (maximum)

	**Endianness**: Bit order
	- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
	- **Least significant bit first** (LSB): Bit 0 → bit 7

	**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

	**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

	**SDO Signal**: Select PRU_GPO pin for data output

	### Clock Timing (Controller Mode Only)
	- **SCLK High Width**: PRU cycles clock stays HIGH
	- **SCLK Low Width**: PRU cycles clock stays LOW
	- **Cycle Period**: Depends on PRU Clock Frequency (should be configured from R5F core and update same frequency in Simulation Settings to use while simulation)
	- 200 MHz: 1 cycle = 5ns
	- 250 MHz: 1 cycle = 4ns
	- 333.333 MHz: 1 cycle = 3ns
	- **Example** (at 333.333 MHz): High=7, Low=7 → 14 cycles per bit → ~23.8MHz SPI clock
	- **Example** (at 200 MHz): High=7, Low=7 → 14 cycles per bit → ~14.3MHz SPI clock
	- The **SPI Clock Frequency** field below automatically calculates the actual frequency based on your configured PRU clock
	- Peripheral mode follows controller's clock timing

	### Maximum Achievable Frequency (at 200 MHz PRU Clock)
	Different SPI modes have different minimum SCLK width requirements due to timing overhead:
	- **MODE0**: Min High=2, Min Low=6 → Max Frequency = 25.00 MHz (Total: 8 cycles)
	- **MODE1**: Min High=4, Min Low=3 → Max Frequency = 28.57 MHz (Total: 7 cycles)
	- **MODE2**: Min High=6, Min Low=1 → Max Frequency = 28.57 MHz (Total: 7 cycles)
	- **MODE3**: Min High=3, Min Low=4 → Max Frequency = 28.57 MHz (Total: 7 cycles)

	**Note**: These are theoretical maximums at 200 MHz PRU clock. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. Always verify with oscilloscope and increase pulse widths if data corruption occurs.

	### Setup and Hold Times (Controller Mode Only)

	![](../.metadata/sysconfig/.meta/images/setup_and_hold_time.png)

	- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
	- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
	- **Data Setup Time**: Time delay (in PRU cycles) to hold data stable after clock edge. This provides additional hold time for data stability on slow devices.

	**Note**: CS Setup Time and CS Hold Time are specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

	### Peripheral Mode Parameters
	- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

	### Technical Details  (Additional Information)

	**Performance**:
	- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
	- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold

	### SPI Communication
	**Typical SPI Transaction**:
	1. Controller asserts CS (waits CS Setup Time)
	2. Controller outputs data bit on SDO (waits Data Setup Time)
	3. Controller generates clock pulse on SCLK
	4. Peripheral device samples SDO on clock edge
	5. Repeat for all bits in packet
	6. Controller waits CS Hold Time, then deasserts CS

	### Usage Notes
	- No hardware SPI - uses GPIO bit-banging for flexibility
	- Clock timing directly controls SPI speed
	- MODE2 and MODE3 initialize SCLK to HIGH (idle state) before asserting CS
	- Setup and hold times should match peripheral device datasheet requirements
	- Data input must be connected to this block
	- Ensure peripheral device supports the configured SPI mode and speed
	- Physical pins must be configured via pin mux
	- This is a **terminating block** - no output connections

	### Simulation

	The SPI Write block generates output signals (SCLK, SDO, CS) that can be viewed in the simulation waveform:

	1. **Configure Simulation Settings**: Navigate to the Simulation Settings module
	2. **Select Output Signals**: In "Select R30 (Output) Signals", select the pins configured for SCLK, SDO, and CS
	3. **Set Cycle Count**: Ensure "Number Of PRU Cycles To Simulate" covers your entire SPI transaction
	4. **Run Simulation**: View the generated waveforms to verify timing and data output

	**Peripheral Mode Simulation:**
	When using Peripheral mode, you need to simulate the controller's SCLK and CS signals:
	1. Select the SCLK and CS pins in "Select R31 (Input) Signals"
	2. Configure a clock pattern for SCLK using Pattern Mode
	3. Configure CS assertion timing using Timestamp Mode
	4. The PRU will respond to these simulated inputs by outputting data on SDO

	**Example - Simulating controller clock for Peripheral mode:**
	\`\`\`
	SCLK Pin - Pattern Mode:
	Bit Pattern: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]  (7 LOW, 7 HIGH)
	Pattern Start Cycle: 100
	Repeat Count: 8 (for 8 bits)

	CS Pin - Timestamp Mode:
	Input Cycles: [50, 250]
	Input Values: [0, 1]  (Assert at cycle 50, deassert at cycle 250)
	\`\`\`

	### Terminology
	- **SPI**: Serial Peripheral Interface - synchronous serial protocol
	- **Bit-banging**: Software-controlled pin toggling to implement protocols
	- **SCLK**: Serial Clock - timing signal for synchronization
	- **SDO**: Serial Data Out - data from controller to peripheral
	- **MSB/LSB**: Most/Least Significant Bit - bit order
	- **Endianness**: Order of bit/byte transmission
	- **CPOL**: Clock Polarity - idle state of clock (0=LOW, 1=HIGH)
	- **CPHA**: Clock Phase - which edge shifts data (0=first edge, 1=second edge)
	- **Setup Time**: Minimum time data must be stable before clock edge
	- **Hold Time**: Minimum time data must remain stable after clock edge
	- **CS Setup Time**: Time between CS assertion and first clock edge
	- **CS Hold Time**: Time between last clock edge and CS deassertion
	---
	`;
}

exports = {
	displayName: "PRU SPI Write",
	defaultInstanceName: "PRU_SPI_Write_",
	longDescription: getLongDescription(),
    getAIContext: getAIContext,
	uiView: "graph",
	templates: {
		//need to check what can be passed as argument to template file, right now no argument is required
        "/pru_blocks/common/pru_syscfg.asm.xdt": null
    },
	config: [
		{
			name: "$shape",
			hidden: true,
			default: "square",
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
        {
            name: "constant1",
            hidden: true,
            default : "TEMP_REG1",
            getValue: (inst) => {
				if (inst["Device Mode"] === "controller") {
					// Controller mode: dataReg, PACKETSIZE, bitId, SCLK_PIN, SDO_PIN, DELAY_COMPEN_1, DELAY_COMPEN_2, CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+", " + inst["SDO Signal"] + ", " + inst["delay_component1"] + ", " + inst["delay_component2"] + ", " + inst["CS Signal"]
						+ ", " + inst["CS Setup Time"] + ", " + inst["CS Hold Time"] + ", " + inst["Data Setup Time"];
				} else {
					// Peripheral mode: dataReg, PACKETSIZE, bitId, SCLK_PIN, SDO_PIN, CS_PIN, CS_FILTER_CYCLES (MODE removed - now in macro name)
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+", " + inst["SDO Signal"] + ", " + inst["CS Signal"] + ", " + inst["CS Filter Cycles"];
				}
			},
        },
		{
			name: "Device Mode",
			displayName: "Device Mode",
			default: "controller",
			options: [
				{
					name: "controller",
					displayName: "Controller",
				},
				{
					name: "peripheral",
					displayName: "Peripheral",
				}
			],
			onChange: (inst, ui) => {
				// Hide SCLK timing controls in Peripheral mode (Peripheral follows Controller's clock)
				ui["sclk high pulse width (in PRU cycles)"].hidden = (inst["Device Mode"] === "peripheral");
				ui["sclk low pulse width (in PRU cycles)"].hidden = (inst["Device Mode"] === "peripheral");
				// Hide CS Filter Cycles in Controller mode (only used in Peripheral mode)
				ui["CS Filter Cycles"].hidden = (inst["Device Mode"] === "controller");
				// Hide CS Setup/Hold Time in Peripheral mode (only used in Controller mode)
				ui["CS Setup Time"].hidden = (inst["Device Mode"] === "peripheral");
				ui["CS Hold Time"].hidden = (inst["Device Mode"] === "peripheral");
				// Hide Data Setup Time in Peripheral mode (only used in Controller mode)
				ui["Data Setup Time"].hidden = (inst["Device Mode"] === "peripheral");
			}
		},
		{
			name: "SPI Mode",
			displayName: "SPI Mode",
			default: "MODE1",
			options: [
				{
					name: "MODE0",
					displayName: "MODE0 (CPOL=0, CPHA=0)",
				},
				{
					name: "MODE1",
					displayName: "MODE1 (CPOL=0, CPHA=1)",
				},
				{
					name: "MODE2",
					displayName: "MODE2 (CPOL=1, CPHA=0)",
				},
				{
					name: "MODE3",
					displayName: "MODE3 (CPOL=1, CPHA=1)",
				}
			],
		},
		{
			name: "packetSize",
			displayName: "Packet Size",
            default: 8,
            range: [8, 32],
		},
        {
			name: "Endiness",
            default:"least significant bit first",
			options: [
                {
                    name: "most significant bit first",
                    displayName: "Most Significant Bit First",
                },
                {
                    name: "least significant bit first",
                    displayName: "Least Significant Bit First",
                }],
		},
		{
			name: "SCLK Signal",
			displayName: "SCLK Signal",
			default: "0",
            options: (inst) => {
				if (inst["Device Mode"] === "controller") {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `PRU_GPO_${i}`
					}));
				} else {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `PRU_GPI_${i}`
					}));
				}
			}
		},
        {
			name: "SDO Signal",
			default: "1",
            options: Array.from({ length: 20 }, (_, i) => ({
                name : `${i}`,
                displayName: `PRU_GPO_${i}`
            }))
		},
		{
			name: "CS Signal",
			displayName: "CS Signal",
			default: "2",
            options: (inst) => {
				if (inst["Device Mode"] === "controller") {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `PRU_GPO_${i}`
					}));
				} else {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `PRU_GPI_${i}`
					}));
				}
			}
		},
		{
            name: "sclk high pulse width (in PRU cycles)",
            displayName : "SCLK High Width In PRU Cycles",
            default : 7,
            range: [1, 0xFFFFFFFF],
			hidden: false
        },
        {
            name: "sclk low pulse width (in PRU cycles)",
            displayName : "SCLK Low Width In PRU Cycles",
            default : 7,
            range: [1, 0xFFFFFFFF],
			hidden: false
        },
		{
			name: "Data Setup Time",
			displayName: "Data Setup Time (PRU cycles)",
			description: "Time delay to hold data stable after clock edge (hold time for data stability)",
			default: 0,
			range: [0, 100],
			hidden: false
		},
		{
			name: "CS Setup Time",
			displayName: "CS Setup Time (nanoseconds)",
			description: "Time delay after CS assertion before starting SPI transaction",
			default: 10,
			range: [0, 10000],
			hidden: false
		},
		{
			name: "CS Hold Time",
			displayName: "CS Hold Time (nanoseconds)",
			description: "Time delay after SPI transaction before CS deassertion",
			default: 10,
			range: [0, 10000],
			hidden: false
		},
		{
			name: "CS Filter Cycles",
			displayName: "CS Filter Cycles (Peripheral Mode)",
			default: 2,
			range: [1, 0xFFFFFFFF],
			hidden: true
		},
        {
            name: "delay_component1",
            default : 1,
            hidden: true,
            getValue: (inst) => {
				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];

				let value = 0;

				// MODE0 (CPHA=0, CPOL=0): SHIFTING_EDGE = SET SCLK (HIGH pulse starts)
				// Overhead: SET SCLK = 1 cycle
				if (mode === "MODE0") {
					value = high - 2;
				}
				// MODE1 (CPHA=1, CPOL=0): SHIFTING_EDGE = SET SCLK (HIGH pulse starts)
				// Overhead: SET SCLK + data setup (3) = 4 cycles
				else if (mode === "MODE1") {
					value = high - 4;
				}
				// MODE2 (CPHA=0, CPOL=1): SHIFTING_EDGE = CLR SCLK (LOW pulse starts)
				// Overhead: CLR SCLK = 1 cycle
				// DELAY_COMPEN_1 extends LOW pulse, so use low_width
				else if (mode === "MODE2") {
					value = low - 1;
				}
				// MODE3 (CPHA=1, CPOL=1): SHIFTING_EDGE = CLR SCLK (LOW pulse starts)
				// Overhead: CLR SCLK + data setup (3) = 4 cycles
				// DELAY_COMPEN_1 extends LOW pulse, so use low_width
				else {  // MODE3
					value = low - 4;
				}

				// Ensure delay component is not negative
				return Math.max(0, value);
			},
        },
        {
            name: "delay_component2",
            default : 1,
            hidden: true,
            getValue: (inst) => {
				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];

				let value = 0;

				// MODE0 (CPHA=0, CPOL=0): CLR SCLK starts LOW pulse
				// LOW overhead: CLR SCLK + loop control (2) + data setup (3) = 6 cycles
				// DELAY_COMPEN_2 extends LOW pulse, so use low_width
				if (mode === "MODE0") {
					value = low - 6;
				}
				// MODE1 (CPHA=1, CPOL=0): SAMPLING_EDGE = CLR SCLK (LOW pulse starts)
				// Overhead: CLR SCLK + loop control (2) = 3 cycles
				else if (mode === "MODE1") {
					value = low - 3;
				}
				// MODE2 (CPHA=0, CPOL=1): SET SCLK starts HIGH pulse
				// HIGH overhead: SET SCLK + loop control (2) + data setup (3) = 6 cycles
				// DELAY_COMPEN_2 extends HIGH pulse, so use high_width
				else if (mode === "MODE2") {
					value = high - 6;
				}
				// MODE3 (CPHA=1, CPOL=1): SAMPLING_EDGE = SET SCLK (HIGH pulse starts)
				// Overhead: SET SCLK + loop control (2) = 3 cycles
				// DELAY_COMPEN_2 extends HIGH pulse, so use high_width
				else {  // MODE3
					value = high - 3;
				}

				// Ensure delay component is not negative
				return Math.max(0, value);
			},
        },
		{
			name: "opCode",
            displayName: "m_send_packet_spi_mode1_msb_gpo_sclk",
			default: "m_send_packet_spi_mode1_msb_gpo_sclk",
			hidden: true,
            getValue: (inst) => {
				// Get the mode number from SPI Mode string (e.g., "MODE3" -> "mode3")
				const mode = inst["SPI Mode"].toLowerCase();

				if (inst["Device Mode"] === "controller") {
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_send_packet_spi_" + mode + "_msb_gpo_sclk";
					}
					else
					{
						return "m_send_packet_spi_" + mode + "_lsb_gpo_sclk"
					}
				} else {
					// Peripheral mode - now includes mode in the name
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_send_packet_spi_" + mode + "_slave_msb_gpo_sclk";
					}
					else
					{
						return "m_send_packet_spi_" + mode + "_slave_lsb_gpo_sclk"
					}
				}
			},
		},
		{
			name: "outputReg",
            default: "None",
			hidden: true
		},
        {
            name: "mode",
            default: "MODE1",
            hidden: true,
			getValue: (inst) => {
				return inst["SPI Mode"];
			}
        },
		{
			name: "numOfInputPorts",
			default: 1,
			hidden: true
		},
		{
			name: "numOfOutputPorts",
			default: 0,
			hidden: true
		},
		{
			name: "numOfConstants",
			default: 1,
			hidden: true
		},
		{
			name: "spiFrequency",
			displayName: "SPI Clock Frequency (MHz)",
			description: "Calculated SPI clock frequency based on PRU cycle time and configured pulse widths",
			hidden: false,
			getValue: (inst) => {
				if (inst["Device Mode"] === "peripheral") {
					return "N/A (follows Controller)";
				}
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];
				const totalCycles = high + low;

				// Get PRU clock frequency from Simulation Settings
				let pruFreqMHz = 200; // Default
				const staticModule = system.modules["/pru_blocks/common/pru_blocks_static_module"];
				if (staticModule && staticModule.$static && staticModule.$static.pruClkFreq) {
					pruFreqMHz = staticModule.$static.pruClkFreq;
				}

				const spiFreqMHz = pruFreqMHz / totalCycles;

				return spiFreqMHz.toFixed(2) + " MHz";
			},
			default: "N/A"
		},
		{
			name: "spiPeriod",
			displayName: "SPI Clock Period (ns)",
			description: "Calculated SPI clock period based on PRU cycle time and configured pulse widths",
			hidden: false,
			getValue: (inst) => {
				if (inst["Device Mode"] === "peripheral") {
					return "N/A (follows Controller)";
				}
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];
				const totalCycles = high + low;

				// Get PRU clock frequency from Simulation Settings
				let pruFreqMHz = 200; // Default
				const staticModule = system.modules["/pru_blocks/common/pru_blocks_static_module"];
				if (staticModule && staticModule.$static && staticModule.$static.pruClkFreq) {
					pruFreqMHz = staticModule.$static.pruClkFreq;
				}

				const pruCycleNs = 1000 / pruFreqMHz; // Convert MHz to ns/cycle
				const spiPeriodNs = totalCycles * pruCycleNs;

				return spiPeriodNs.toFixed(2) + " ns";
			},
			default: "N/A"
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				// Controller mode: includes CS setup, bit loop, and CS hold time
				// Peripheral mode: includes CS filter, bit loop (no CS setup/hold)
				if (inst["Device Mode"] === "controller") {
					const csSetupTime = inst["CS Setup Time"];
					const csHoldTime = inst["CS Hold Time"];
					const dataSetupTime = inst["Data Setup Time"];

					// Cycles per bit: 7 fixed + DATA_SETUP_TIME + delay_component1 + delay_component2
					const cyclesPerBit = 7 + dataSetupTime + inst["delay_component1"] + inst["delay_component2"];

					return 1 + csSetupTime + 1 +
					       (inst["packetSize"] * cyclesPerBit) +
					       csHoldTime + 1;
				} else {
					return 6 + inst["delay_component1"] + (inst["packetSize"] - 1) * (6 + inst["delay_component1"] + inst["delay_component2"]);
				}
			},
			default : 1
		},
	],
	ports: (inst) => { 
		let ports = [];
		for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
		{
			ports.push({ name: "input"+iterator.toString(), type: "input" })
		}
		for(let iterator = 1; iterator <= inst["numOfOutputPorts"]; iterator++)
		{
			ports.push({ name: "output"+iterator.toString(), type: "output"})
		}
		ports.push({ name: "prev", type: "PREV" })
		ports.push({ name: "next", type: "NEXT"})
        return ports
	},
	validate,
	moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    },
	getMacro
}

/*
notes:

1st bit :
2 cycles to set
3 + delay component1 + 1 to clear

2nd to packet size:
2 +  delay component2 + 1 to set
3 + delay component1 + 1 to clear

*/