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
	const sdiPin = inst["SDI Signal"];

	if (csPin === sclkPin) {
		report.logError("CS Signal and SCLK Signal cannot use the same pin", inst, "CS Signal");
	}
	if (csPin === sdoPin) {
		report.logError("CS Signal and SDO Signal cannot use the same pin", inst, "CS Signal");
	}
	if (csPin === sdiPin) {
		report.logError("CS Signal and SDI Signal cannot use the same pin", inst, "CS Signal");
	}
	if (sclkPin === sdoPin) {
		report.logError("SCLK Signal and SDO Signal cannot use the same pin", inst, "SCLK Signal");
	}
	if (sclkPin === sdiPin) {
		report.logError("SCLK Signal and SDI Signal cannot use the same pin", inst, "SCLK Signal");
	}
	if (sdoPin === sdiPin) {
		report.logError("SDO Signal and SDI Signal cannot use the same pin", inst, "SDO Signal");
	}

	// Mode-specific pulse width validation (only for Controller mode)
	if (inst["Device Mode"] === "controller") {
		const mode = inst["SPI Mode"];
		const high = inst["sclk high pulse width (in PRU cycles)"];
		const low = inst["sclk low pulse width (in PRU cycles)"];

		if (mode === "MODE0") {
			if (high < 4) {
				report.logError("MODE0: SCLK High Width must be at least 4 cycles", inst, "sclk high pulse width (in PRU cycles)");
			}
			if (low < 6) {
				report.logError("MODE0: SCLK Low Width must be at least 6 cycles (overhead compensation)", inst, "sclk low pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE1") {
			if (high < 2) {
				report.logError("MODE1: SCLK High Width must be at least 2 cycles", inst, "sclk high pulse width (in PRU cycles)");
			}
			if (low < 6) {
				report.logError("MODE1: SCLK Low Width must be at least 6 cycles", inst, "sclk low pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE2") {
			if (low < 4) {
				report.logError("MODE2: SCLK Low Width must be at least 4 cycles (overhead compensation)", inst, "sclk low pulse width (in PRU cycles)");
			}
			if (high < 6) {
				report.logError("MODE2: SCLK High Width must be at least 6 cycles (overhead compensation)", inst, "sclk high pulse width (in PRU cycles)");
			}
		}
		else if (mode === "MODE3") {
			if (low < 2) {
				report.logError("MODE3: SCLK Low Width must be at least 2 cycles", inst, "sclk low pulse width (in PRU cycles)");
			}
			if (high < 6) {
				report.logError("MODE3: SCLK High Width must be at least 6 cycles", inst, "sclk high pulse width (in PRU cycles)");
			}
		}
	}
}

function getNumOfBytes(value)
{
	// value is packet size in bits, return number of bytes needed
	if(value <= 8)
	{
		return 1;
	}
	if(value <= 16)
	{
		return 2;
	}
	if(value <= 24)
	{
		return 3;
	}
	return 4;
}

/**
 * Returns the body of a specific macro based on the macro name with parameters replaced
 * @param {string} pruInstructionMacro - The macro instruction string that contains the macro name and parameters
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";

    // Extract the macro name and parameters from the pruInstructionMacro
    // Parameter order: r_dataReg (output/receive), s_dataReg (input/send), PACKETSIZE, bitId, ...
    // This matches the system's instruction format: opCode <output>, <input>, <constants>
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode;
    const r_dataReg = parts[1] || "r_dataReg";  // Position 1: output register (receive)
    const s_dataReg = parts[2] || "s_dataReg";  // Position 2: input register (send)
    const PACKETSIZE = parts[3] || "PACKETSIZE";
    const bitId = parts[4] || "bitId";
    const SCLK_PIN = parts[5] || "SCLK_PIN";
    const SDI_PIN = parts[6] || "SDI_PIN";
    const SDO_PIN = parts[7] || "SDO_PIN";
    const DELAY_COMPEN_1 = parts[8] || "DELAY_COMPEN_1";
    const DELAY_COMPEN_2 = parts[9] || "DELAY_COMPEN_2";
    const CS_PIN = macroName.includes("slave") ? (parts[8] || "CS_PIN") : (parts[10] || "CS_PIN");
    const CS_FILTER_CYCLES = parts[9] || "CS_FILTER_CYCLES";
    const CS_SETUP_TIME = parts[11] || "CS_SETUP_TIME";
    const CS_HOLD_TIME = parts[12] || "CS_HOLD_TIME";
    const DATA_SETUP_TIME = parts[13] || "DATA_SETUP_TIME";

	if(pruInstructionMacro == "")
    {
		if (macroName.includes("slave")) {
			macroBody = macroName + "	" + ".macro  " + r_dataReg + ", " + s_dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDI_PIN + ", " + SDO_PIN + ", CS_PIN, CS_FILTER_CYCLES\n";
			// Add parameter documentation for Peripheral (slave) mode
			macroBody += `	; Parameters:
	;   r_dataReg         - Register to store received data (output)
	;   s_dataReg         - Register containing data to transmit (input)
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock input pin number (GPI)
	;   SDI_PIN           - Serial data input pin number (GPI)
	;   SDO_PIN           - Serial data output pin number (GPO)
	;   CS_PIN            - Chip select input pin number (GPI)
	;   CS_FILTER_CYCLES  - CS filter cycles for glitch rejection
`;
		} else {
			macroBody = macroName + "	" + ".macro  " + r_dataReg + ", " + s_dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDI_PIN + ", " + SDO_PIN + ", " + DELAY_COMPEN_1 + ", " + DELAY_COMPEN_2 + ", CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME\n";
			// Add parameter documentation for Controller (master) mode
			macroBody += `	; Parameters:
	;   r_dataReg         - Register to store received data (output)
	;   s_dataReg         - Register containing data to transmit (input)
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock output pin number (GPO)
	;   SDI_PIN           - Serial data input pin number (GPI)
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

	// Controller MODE0 MSB (CPOL=0, CPHA=0) - Clock idles LOW, sample on rising, shift on falling
	if (macroName === "m_transfer_packet_spi_mode0_msb_gpo_sclk") {
		macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1 
READ_BIT_LOOP?:
	; MODE0 SHIFTING_EDGE: falling edge (CLR SCLK) - but clock already LOW, so shift data first
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	; MODE0 SAMPLING_EDGE: rising edge (SET SCLK)
	set r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	sub     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE0 LSB
	if (macroName === "m_transfer_packet_spi_mode0_lsb_gpo_sclk") {
		macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE1 MSB (CPOL=0, CPHA=1) - Clock idles LOW, sample on falling, shift on rising
	if (macroName === "m_transfer_packet_spi_mode1_msb_gpo_sclk") {
		macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
READ_BIT_LOOP?:
	; MODE1 SHIFTING_EDGE: rising edge (SET SCLK)
	set r30, r30,   ${SCLK_PIN}
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	; MODE1 SAMPLING_EDGE: falling edge (CLR SCLK)
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE1 LSB
	if (macroName === "m_transfer_packet_spi_mode1_lsb_gpo_sclk") {
		macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	set r30, r30,   ${SCLK_PIN}
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE2 MSB (CPOL=1, CPHA=0) - Clock idles HIGH, sample on falling, shift on rising
	if (macroName === "m_transfer_packet_spi_mode2_msb_gpo_sclk") {
		macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
READ_BIT_LOOP?:
	; MODE2 SHIFTING_EDGE: rising edge (SET SCLK) - but clock already HIGH, so shift data first
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	; MODE2 SAMPLING_EDGE: falling edge (CLR SCLK)
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	sub     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE2 LSB
	if (macroName === "m_transfer_packet_spi_mode2_lsb_gpo_sclk") {
		macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE3 MSB (CPOL=1, CPHA=1) - Clock idles HIGH, sample on rising, shift on falling
	if (macroName === "m_transfer_packet_spi_mode3_msb_gpo_sclk") {
		macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE} - 1
READ_BIT_LOOP?:
	; MODE3 SHIFTING_EDGE: falling edge (CLR SCLK)
	clr r30, r30,   ${SCLK_PIN}
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	; MODE3 SAMPLING_EDGE: rising edge (SET SCLK)
	set r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	sub     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, 0xFF
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Controller MODE3 LSB
	if (macroName === "m_transfer_packet_spi_mode3_lsb_gpo_sclk") {
		macroBody += `	set r30, r30,   ${SCLK_PIN}
	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	clr r30, r30,   ${SCLK_PIN}
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
	}

	// Peripheral MODE0 MSB (CPOL=0, CPHA=0) - Clock idles LOW, sample on rising, shift on falling
	if (macroName === "m_transfer_packet_spi_mode0_slave_msb_gpi_sclk") {
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
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	; MODE0 SAMPLING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	; Sampling received bit
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	sub     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0xFF
	; MODE0 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE0 LSB
	if (macroName === "m_transfer_packet_spi_mode0_slave_lsb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE1 MSB (CPOL=0, CPHA=1) - Clock idles LOW, sample on falling, shift on rising
	if (macroName === "m_transfer_packet_spi_mode1_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
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
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	; MODE1 SAMPLING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	sub     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0xFF
	; MODE1 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE1 LSB
	if (macroName === "m_transfer_packet_spi_mode1_slave_lsb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE2 MSB (CPOL=1, CPHA=0) - Clock idles HIGH, sample on falling, shift on rising
	if (macroName === "m_transfer_packet_spi_mode2_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
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
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	; MODE2 SAMPLING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	sub     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0xFF
	; MODE2 SHIFTING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE2 LSB
	if (macroName === "m_transfer_packet_spi_mode2_slave_lsb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
SEND_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE3 MSB (CPOL=1, CPHA=1) - Clock idles HIGH, sample on rising, shift on falling
	if (macroName === "m_transfer_packet_spi_mode3_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
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
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
	; MODE3 SAMPLING_EDGE: wait for rising edge (m_wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	sub     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, 0xFF
	; MODE3 SHIFTING_EDGE: wait for falling edge (m_wait_high_pulse)
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
	qba     SEND_BIT_LOOP?
SEND_BIT_LOOP_END?:`;
	}

	// Peripheral MODE3 LSB
	if (macroName === "m_transfer_packet_spi_mode3_slave_lsb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, 0
wait_for_high_transition_loop_beginning?:
	.loop   1
	qbbc    wait_for_high_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop_beginning?:
	.loop   1
	qbbs    wait_for_low_transition_loop_beginning?, r31, ${SCLK_PIN}
	.endloop
SEND_BIT_LOOP?:
	qbbc    data_low?, ${s_dataReg}, ${bitId}
	set r30, r30,   ${SDO_PIN}
	qba     data_high?
data_low?:
	clr r30, r30,   ${SDO_PIN}
	NOP
data_high?:
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${r_dataReg}, ${r_dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${r_dataReg}, ${r_dataReg}, ${bitId}
	NOP
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbeq    SEND_BIT_LOOP_END?, ${bitId}, ${PACKETSIZE}
wait_for_high_transition_loop2?:
	.loop   1
	qbbc    wait_for_high_transition_loop2?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop2?:
	.loop   1
	qbbs    wait_for_low_transition_loop2?, r31, ${SCLK_PIN}
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
	
	This section describes how to programmatically configure the SPI Transfer block in a .syscfg file.
	
	### Adding a SPI Transfer Instance
	
	\`\`\`javascript
	const pru_spi_transfer = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_transfer", {}, false);
	const spi1 = pru_spi_transfer.addInstance();
	\`\`\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
	| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE3" | Clock polarity and phase |
	| packetSize | Integer | 8-32 | 32 | Number of bits per transfer |
	| Endiness | String | "most significant bit first", "least significant bit first" | "most significant bit first" | Bit order |
	| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
	| SDI Signal | String | "0"-"19" | "1" | GPIO pin for data input |
	| SDO Signal | String | "0"-"19" | "2" | GPIO pin for data output |
	| CS Signal | String | "0"-"19" | "3" | GPIO pin for chip select |
	| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 9 | Clock high time (Controller only) |
	| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
	| CS Setup Time | Integer | 0-10000 | 35 | CS setup time in nanoseconds (Controller only) |
	| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
	| Data Setup Time | Integer | 0-100 | 0 | Data setup time in PRU cycles (Controller only) |
	| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |
	
	### Example Configurations
	
	**SPI Controller, MODE3, 8-bit, MSB first:**
	\`\`\`javascript
	spi1.$name = "SPI_Controller_0";
	spi1["Device Mode"] = "controller";
	spi1["SPI Mode"] = "MODE3";
	spi1.packetSize = 8;
	spi1["Endiness"] = "most significant bit first";
	spi1["SCLK Signal"] = "0";
	spi1["SDI Signal"] = "1";
	spi1["SDO Signal"] = "2";
	spi1["CS Signal"] = "3";
	spi1["sclk high pulse width (in PRU cycles)"] = 13;
	spi1["sclk low pulse width (in PRU cycles)"] = 11;
	spi1["CS Setup Time"] = 35;
	spi1["CS Hold Time"] = 10;
	\`\`\`
	
	**SPI Peripheral, MODE0, 32-bit, LSB first:**
	\`\`\`javascript
	spi1.$name = "SPI_Peripheral_0";
	spi1["Device Mode"] = "peripheral";
	spi1["SPI Mode"] = "MODE0";
	spi1.packetSize = 32;
	spi1["Endiness"] = "least significant bit first";
	spi1["SCLK Signal"] = "4";         // Input pin for clock
	spi1["SDI Signal"] = "5";
	spi1["SDO Signal"] = "6";
	spi1["CS Signal"] = "7";           // Input pin for CS
	spi1["CS Filter Cycles"] = 2;
	\`\`\`
	
	### Connecting to Other Blocks
	
	\`\`\`javascript
	// Connect data source to SPI input (data to transmit)
	scripting.connect(load_constant1, "output1", spi1, "input1");
	
	// Connect SPI output to downstream block (received data)
	scripting.connect(spi1, "output1", process_block, "input1");
	
	// Connect control flow
	scripting.connect(prev_block, "next", spi1, "prev");
	scripting.connect(spi1, "next", next_block, "prev");
	\`\`\`
	
	### Important Notes
	
	1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI).
	
	2. **Pin Uniqueness**: All four signals (CS, SCLK, SDI, SDO) must use different GPIO pins.
	
	3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	   - MODE0: Min High=4, Min Low=6
	   - MODE1: Min High=2, Min Low=6
	   - MODE2: Min High=6, Min Low=4
	   - MODE3: Min High=6, Min Low=2
	
	4. **Full-Duplex Operation**: This block simultaneously sends and receives data. Connect both input (transmit data) and use output (receive data) for full-duplex communication.
	`;
}

function getLongDescription() {
		return `
	## PRU SPI Transfer Block

	### Purpose
	Implements full-duplex SPI (Serial Peripheral Interface) transfer operation in both Controller and Peripheral modes using bit-banging on PRU GPIO pins. This block simultaneously sends and receives data in a single transaction.

	### How It Works

	**Controller Mode:**
	1. **Connect Input**: Connect data source to input port (data to transmit)
	2. **Configure Pins**: Select SCLK (clock output), SDI (data input), SDO (data output), and CS (chip select output) pins
	3. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
	4. **Execute**: Generates bit-banged SPI transfer sequence with concurrent read and write
	5. **Output**: Provides received data to the next block

	**Peripheral Mode:**
	1. **Connect Input**: Connect data source to input port (data to transmit)
	2. **Configure Pins**: Select SCLK (clock input), SDI (data input), SDO (data output), and CS (chip select input) pins
	3. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
	4. **Execute**: Waits for CS assertion and controller clock, then simultaneously reads and writes data
	5. **Output**: Provides received data to the next block

	### SPI Protocol
	SPI is a synchronous serial communication protocol with:
	- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
	- **SDI (Serial Data In)**: Data line from device to PRU
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

	**Packet Size**: Number of bits to transfer (8-32)
	- 8 bits = 1 byte (most common)
	- 16 bits = 2 bytes
	- 32 bits = 4 bytes (maximum)

	**Endianness**: Bit order
	- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
	- **Least significant bit first** (LSB): Bit 0 → bit 7

	**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

	**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

	**SDI Signal**: Select PRU_GPI pin for data input (receive from device)

	**SDO Signal**: Select PRU_GPO pin for data output (transmit to device)

	### Clock Timing (Controller Mode Only)
	- **SCLK High Width**: PRU cycles clock stays HIGH
	- **SCLK Low Width**: PRU cycles clock stays LOW
	- **Cycle Period**: Depends on PRU Clock Frequency(should be configured from R5F core and update same frequency in Simulation Settings to use while simulation)
	- 200 MHz: 1 cycle = 5ns
	- 250 MHz: 1 cycle = 4ns
	- 333.333 MHz: 1 cycle = 3ns
	- **Example** (at 333.333 MHz): High=13, Low=11 → 24 cycles per bit → ~13.9MHz SPI clock
	- **Example** (at 200 MHz): High=13, Low=11 → 24 cycles per bit → ~8.3MHz SPI clock
	- The **SPI Clock Frequency** field below automatically calculates the actual frequency based on your configured PRU clock
	- Peripheral mode follows controller's clock timing
	- **Important**: Timing margins must be sufficient for peripheral response time. Increase pulse widths if data transfer is unreliable.

	### Maximum Achievable Frequency (at 200 MHz PRU Clock)
	Different SPI modes have different minimum SCLK width requirements due to timing overhead:
	- **MODE0**: Min High=4, Min Low=6 → Max Frequency = 20.00 MHz (Total: 10 cycles)
	- **MODE1**: Min High=2, Min Low=6 → Max Frequency = 25.00 MHz (Total: 8 cycles)
	- **MODE2**: Min High=6, Min Low=4 → Max Frequency = 20.00 MHz (Total: 10 cycles)
	- **MODE3**: Min High=6, Min Low=2 → Max Frequency = 25.00 MHz (Total: 8 cycles)

	**Note**: These are theoretical maximums at 200 MHz PRU clock. Full-duplex operation requires adequate timing margins for bidirectional data transfer. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. For full-duplex transfers, the peripheral must respond quickly after the shifting edge for the controller to sample correctly on the sampling edge. If receiving corrupted data, increase SCLK pulse widths significantly beyond these minimums.

	### Setup and Hold Times (Controller Mode Only)

	![](../.metadata/sysconfig/.meta/images/setup_and_hold_time.png)

	- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
	- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
	- **Data Setup Time**: Time delay (in PRU cycles) after clock edge before sampling data. This provides additional setup time for data stability on slow devices.

	**Note**: CS Setup Time and CS Hold Time are specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

	### Peripheral Mode Parameters
	- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

	### Technical Details (Additional Information)

	**Performance**:
	- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
	- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold
	- Full-duplex: Same cycles as half-duplex, but transfers both directions simultaneously

	### SPI Communication
	**Typical SPI Full-Duplex Transfer**:
	1. Controller asserts CS (waits CS Setup Time)
	2. Controller outputs data bit on SDO and generates clock edge
	3. On the sampling clock edge:
	- Peripheral samples controller's data on SDI
	- Controller samples peripheral's data on SDI (concurrently)
	4. Repeat for all bits in packet
	5. Controller waits CS Hold Time, then deasserts CS

	**Key Timing Consideration**:
	In full-duplex mode, the peripheral must output its data quickly enough after detecting the shifting clock edge so the controller can sample it on the sampling edge. If timing is too tight, increase SCLK Low Width (MODE1/MODE3) or SCLK High Width (MODE0/MODE2) to give the peripheral more time to respond.

	### Usage Notes
	- No hardware SPI - uses GPIO bit-banging for flexibility
	- Full-duplex transfers data in both directions simultaneously
	- Clock timing directly controls SPI speed
	- MODE2 and MODE3 initialize SCLK to HIGH (idle state) before asserting CS
	- Setup and hold times should match peripheral device datasheet requirements
	- Data input must be connected to this block for transmit data
	- Output provides received data for further processing
	- Ensure peripheral device supports the configured SPI mode and speed
	- Physical pins must be configured via pin mux
	- **Timing margins are critical**: If receiving incorrect data, increase SCLK pulse widths to give peripheral more response time

	### Simulating Input Data

	To test SPI Transfer without hardware, use the **Simulation Settings** module to simulate the SDI (Serial Data In) signal:

	1. **Open Simulation Settings**: Navigate to the Simulation Settings module
	2. **Select GPI Pin**: In "Select R31 (Input) Signals", select the pin configured as SDI Signal
	3. **Configure Input Mode**: Choose Timestamp Mode or Pattern Mode
	4. **Define Data Pattern**: Enter the bit values the PRU should receive from the simulated peripheral device

	**Example - Simulating peripheral sending 0xC3 (11000011) with MODE3:**
	\`\`\`
	Input Mode: Timestamp
	Input Cycles: [120, 144, 168, 192, 216, 240, 264, 288]
	Input Values: [1, 1, 0, 0, 0, 0, 1, 1]
	\`\`\`

	### Terminology
	- **SPI**: Serial Peripheral Interface - synchronous serial protocol
	- **Bit-banging**: Software-controlled pin toggling to implement protocols
	- **Full-duplex**: Simultaneous bidirectional data transfer
	- **SCLK**: Serial Clock - timing signal for synchronization
	- **SDI**: Serial Data In - data from peripheral to controller
	- **SDO**: Serial Data Out - data from controller to peripheral
	- **CS**: Chip Select - enables/disables peripheral device
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
	displayName: "PRU SPI Transfer",
	defaultInstanceName: "PRU_SPI_Transfer_",
	longDescription: getLongDescription(),
    getAIContext: getAIContext,
	uiView: "graph",
	templates: {
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
				// The system will automatically prepend the output register (r_dataReg) before these values
				// So we only need to provide: s_dataReg (from input), PACKETSIZE, bitId, and the rest
				if (inst["Device Mode"] === "controller") {
					// Macro signature: r_dataReg, s_dataReg, PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, SDO_PIN, DELAY_COMPEN_1, DELAY_COMPEN_2, CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME
					// System provides: r_dataReg (allocated output), <input connection>
					// We provide: PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, SDO_PIN, DELAY_COMPEN_1, DELAY_COMPEN_2, CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+ ", " + inst["SDI Signal"] + ", " + inst["SDO Signal"] + ", " + inst["delay_component1"] + ", " + inst["delay_component2"] + ", " + inst["CS Signal"]
						+ ", " + inst["CS Setup Time"] + ", " + inst["CS Hold Time"] + ", " + inst["Data Setup Time"];
				} else {
					// Macro signature: r_dataReg, s_dataReg, PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, SDO_PIN, CS_PIN, CS_FILTER_CYCLES
					// System provides: r_dataReg (allocated output), <input connection>
					// We provide: PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, SDO_PIN, CS_PIN, CS_FILTER_CYCLES
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+ ", " + inst["SDI Signal"] + ", " + inst["SDO Signal"] + ", " + inst["CS Signal"] + ", " + inst["CS Filter Cycles"];
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
			default: "MODE3",
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
            default: 32,
            range: [8, 32],
		},
        {
			name: "Endiness",
            default:"most significant bit first",
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
			name: "SDI Signal",
			displayName: "SDI Signal",
			default: "1",
            options: Array.from({ length: 20 }, (_, i) => ({
                name : `${i}`,
                displayName: `PRU_GPI_${i}`
            }))
		},
		{
			name: "SDO Signal",
			displayName: "SDO Signal",
			default: "2",
            options: Array.from({ length: 20 }, (_, i) => ({
                name : `${i}`,
                displayName: `PRU_GPO_${i}`
            }))
		},
		{
			name: "CS Signal",
			displayName: "CS Signal",
			default: "3",
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
            default : 9,
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
			default: 35,
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
				// Peripheral mode doesn't use delay components
				if (inst["Device Mode"] === "peripheral") {
					return 0;
				}

				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];
                let value = 0; 
				// Based on m_transfer_packet_spi_master_gpo_sclk timing
				// MODE0/MODE3: Uses high pulse for delay_compen_1
				// MODE1/MODE2: Uses low pulse for delay_compen_1 
				if (mode === "MODE0") {
					 value = low - 6;
				}
				else if (mode === "MODE1") {
					value = high - 4;
				}
				else if (mode === "MODE2") {
					value = high - 6;
				}
				else {  // MODE3
					value = low - 4;
				}
				return Math.max(0,value);
			},
        },
        {
            name: "delay_component2",
            default : 1,
            hidden: true,
            getValue: (inst) => {
				// Peripheral mode doesn't use delay components
				if (inst["Device Mode"] === "peripheral") {
					return 0;
				}

				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];
                let value=0;
				// Based on m_transfer_packet_spi_master_gpo_sclk timing
				if (mode === "MODE0") {
					value = high - 4;
				}
				else if (mode === "MODE1") {
					value = low - 6;
				}
				else if (mode === "MODE2") {
					value = low - 4;
				}
				else {  // MODE3
					value = high - 6;
				}
				return Math.max(0,value);
			},
        },
		{
			name: "opCode",
            displayName: "m_transfer_packet_spi_mode3_msb_gpo_sclk",
			default: "m_transfer_packet_spi_mode3_msb_gpo_sclk",
			hidden: true,
            getValue: (inst) => {
				const mode = inst["SPI Mode"].toLowerCase();

				if (inst["Device Mode"] === "controller") {
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_transfer_packet_spi_" + mode + "_msb_gpo_sclk";
					}
					else
					{
						return "m_transfer_packet_spi_" + mode + "_lsb_gpo_sclk"
					}
				} else {
					// Peripheral mode
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_transfer_packet_spi_" + mode + "_slave_msb_gpi_sclk";
					}
					else
					{
						return "m_transfer_packet_spi_" + mode + "_slave_lsb_gpi_sclk"
					}
				}
			},
		},
        {
            name: "mode",
            default: "MODE3",
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
			default: 1,
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
			name: "output1Size",
            default: 1,
			hidden: true,
            getValue: (inst) => {
                return getNumOfBytes(inst["packetSize"]);
			}
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				if (inst["Device Mode"] === "controller") {
					const csSetupTime = inst["CS Setup Time"];
					const csHoldTime = inst["CS Hold Time"];
					const dataSetupTime = inst["Data Setup Time"];

					// Based on m_transfer_packet_spi_master_gpo_sclk: ~ (4+d1) + (6+d2) cycles per bit
					const cyclesPerBit = 10 + dataSetupTime + inst["delay_component1"] + inst["delay_component2"];

					return 1 + csSetupTime + 1 +
					       (inst["packetSize"] * cyclesPerBit) +
					       csHoldTime + 1;
				} else {
					// Peripheral mode: 13 cycles per bit (6 shifting + 7 sampling)
					return 6 + inst["CS Filter Cycles"] + (inst["packetSize"] * 13);
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
