/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
	let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
	if(result==0)return "PRU0";
    return "PRU1";
}
const PRU_USED = getPruNumberFromContext();  
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
	const sdiPin = inst["SDI Signal"];

	let flag = 0; 
	for (let i = 0 ; i < 20 ; ++i){
		if(sclkPin === `${i}`){
			flag = 1;
			break;
		}
	}  
	if(!flag){
		report.logError(`Illegal SCLK pin value, please select from the dropdown options`, inst, "SCLK Signal");
	}
	flag = 0; 
	for (let i = 0 ; i < 20 ; ++i){
		if(csPin === `${i}`){
			flag = 1;
			break;
		}
	}  
	if(!flag){
		report.logError(`Illegal CS pin value, please select from the dropdown options`, inst, "CS Signal");
	}
	if (csPin === sclkPin) {
		report.logError("CS Signal and SCLK Signal cannot use the same pin", inst, "CS Signal");
	}
	if (csPin === sdiPin) {
		report.logError("CS Signal and SDI Signal cannot use the same pin", inst, "CS Signal");
	}
	if (sclkPin === sdiPin) {
		report.logError("SCLK Signal and SDI Signal cannot use the same pin", inst, "SCLK Signal");
	}

	// Mode-specific pulse width validation (only for Controller mode)
	if (inst["Device Mode"] === "controller") {
		const mode = inst["SPI Mode"];
		const high = inst["sclk high pulse width (in PRU cycles)"];
		const low = inst["sclk low pulse width (in PRU cycles)"];

		let pruFreqMHz = 200;
		const staticMod = system.modules["/pru_blocks/common/pru_blocks_static_module"];
		if (staticMod && staticMod.$static && staticMod.$static.pruClkFreq) {
			pruFreqMHz = staticMod.$static.pruClkFreq;
		}
		const dataSetup = Math.ceil(inst["Data Setup Time"] * pruFreqMHz / 1000);

		if (mode === "MODE0") {
			// delay_component1 = high - 4, delay_component2 = low - 3 - dataSetup
			if (high < 4) report.logError("MODE0: SCLK High Width must be at least 4 cycles (overhead compensation for delay_component1)", inst, "sclk high pulse width (in PRU cycles)");
			if (low < 3 + dataSetup) report.logError(`MODE0: SCLK Low Width must be at least ${3 + dataSetup} cycles (3 cycles overhead + ${dataSetup} cycles Data Setup Time)`, inst, "sclk low pulse width (in PRU cycles)");
		}
		else if (mode === "MODE1") {
			// delay_component1 = high - 2 - dataSetup, delay_component2 = low - 5
			if (high < 2 + dataSetup) report.logError(`MODE1: SCLK High Width must be at least ${2 + dataSetup} cycles (2 cycles overhead + ${dataSetup} cycles Data Setup Time)`, inst, "sclk high pulse width (in PRU cycles)");
			if (low < 5) report.logError("MODE1: SCLK Low Width must be at least 5 cycles (overhead compensation for delay_component2)", inst, "sclk low pulse width (in PRU cycles)");
		}
		else if (mode === "MODE2") {
			// delay_component1 = low - 4, delay_component2 = high - 3 - dataSetup
			if (low < 4) report.logError("MODE2: SCLK Low Width must be at least 4 cycles (overhead compensation for delay_component1)", inst, "sclk low pulse width (in PRU cycles)");
			if (high < 3 + dataSetup) report.logError(`MODE2: SCLK High Width must be at least ${3 + dataSetup} cycles (3 cycles overhead + ${dataSetup} cycles Data Setup Time)`, inst, "sclk high pulse width (in PRU cycles)");
		}
		else if (mode === "MODE3") {
			// delay_component1 = low - 2 - dataSetup, delay_component2 = high - 5
			if (low < 2 + dataSetup) report.logError(`MODE3: SCLK Low Width must be at least ${2 + dataSetup} cycles (2 cycles overhead + ${dataSetup} cycles Data Setup Time)`, inst, "sclk low pulse width (in PRU cycles)");
			if (high < 5) report.logError("MODE3: SCLK High Width must be at least 5 cycles (overhead compensation for delay_component2)", inst, "sclk high pulse width (in PRU cycles)");
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
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode; // First part is the macro name
    const dataReg = parts[1] || "dataReg";
    const PACKETSIZE = parts[2] || "PACKETSIZE";
    const bitId = parts[3] || "bitId";
    const SCLK_PIN = parts[4] || "SCLK_PIN";
    const SDI_PIN = parts[5] || "SDI_PIN";
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
			macroBody = macroName + "	" + ".macro  " + dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDI_PIN + ", CS_PIN, CS_FILTER_CYCLES\n";
			// Add parameter documentation for Peripheral (slave) mode
			macroBody += `	; Parameters:
	;   dataReg           - Register to store received data
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock input pin number (GPI)
	;   SDI_PIN           - Serial data input pin number (GPI)
	;   CS_PIN            - Chip select input pin number (GPI)
	;   CS_FILTER_CYCLES  - CS filter cycles for glitch rejection
`;
		} else {
			macroBody = macroName + "	" + ".macro  " + dataReg + ", " + PACKETSIZE + ", " + bitId + ", " + SCLK_PIN + ", " + SDI_PIN + ", " + DELAY_COMPEN_1 + ", " + DELAY_COMPEN_2 + ", CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME\n";
			// Add parameter documentation for Controller (master) mode
			macroBody += `	; Parameters:
	;   dataReg           - Register to store received data
	;   PACKETSIZE        - Number of bits in the packet (8-32)
	;   bitId             - Register to track current bit position
	;   SCLK_PIN          - Serial clock output pin number (GPO)
	;   SDI_PIN           - Serial data input pin number (GPI)
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
    if (macroName === "m_read_packet_spi_mode1_msb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	set r30, r30,   ${SCLK_PIN}
	sub     ${bitId}, ${bitId}, 1
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, 0
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`
	}
    if (macroName === "m_read_packet_spi_mode1_lsb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	clr r30, r30,   ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	.loop   ${DELAY_COMPEN_2} ; 0
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30,   ${CS_PIN}`;
    }

    // MODE0 Controller mode macros (CPOL=0, CPHA=0) - Clock idles LOW
    if (macroName === "m_read_packet_spi_mode0_msb_gpo_sclk") {
        macroBody += `	clr r30, r30,   ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	clr r30, r30, ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, 0
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }
    if (macroName === "m_read_packet_spi_mode0_lsb_gpo_sclk") {
        macroBody += `	clr r30, r30, ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	clr r30, r30, ${SCLK_PIN}
	add     ${bitId}, ${bitId}, 1
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }

    // MODE3 Controller mode macros (CPOL=1, CPHA=1) - Clock idles HIGH
    if (macroName === "m_read_packet_spi_mode3_msb_gpo_sclk") {
        macroBody += `	set r30, r30, ${SCLK_PIN}
	clr r30, r30, ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	clr r30, r30, ${SCLK_PIN}
	sub     ${bitId}, ${bitId}, 1
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	set r30, r30, ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, 0
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }
    if (macroName === "m_read_packet_spi_mode3_lsb_gpo_sclk") {
        macroBody += `	set r30, r30, ${SCLK_PIN}
	clr r30, r30, ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	clr r30, r30, ${SCLK_PIN}
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	nop
	set r30, r30, ${SCLK_PIN}
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }

    // MODE2 Controller mode macros (CPOL=1, CPHA=0) - Clock idles HIGH
    if (macroName === "m_read_packet_spi_mode2_msb_gpo_sclk") {
        macroBody += `	set r30, r30, ${SCLK_PIN}
	clr r30, r30, ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	clr r30, r30, ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	set r30, r30,   ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, 0
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }
    if (macroName === "m_read_packet_spi_mode2_lsb_gpo_sclk") {
        macroBody += `	set r30, r30, ${SCLK_PIN}
	clr r30, r30, ${CS_PIN}
	.loop   ${CS_SETUP_TIME}
	nop
	.endloop
	ldi     ${bitId}, 0
READ_BIT_LOOP?:
	.loop   ${DATA_SETUP_TIME}
	nop
	.endloop
	clr r30, r30, ${SCLK_PIN}
	.loop   ${DELAY_COMPEN_1}
	nop
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	set r30, r30,   ${SCLK_PIN}
	add     ${bitId}, ${bitId}, 1
	.loop   ${DELAY_COMPEN_2}
	nop
	.endloop
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}
	.loop   ${CS_HOLD_TIME}
	nop
	.endloop
	set r30, r30, ${CS_PIN}`;
    }

	// Peripheral mode macros - MODE0
	if (macroName === "m_read_packet_spi_mode0_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	; MODE0 SAMPLING_EDGE: wait for rising edge (wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	qbne    READ_BIT_LOOP?, ${bitId}, 0`;
	}
	if (macroName === "m_read_packet_spi_mode0_slave_lsb_gpi_sclk") {
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
READ_BIT_LOOP?:
	; MODE0 SAMPLING_EDGE: wait for rising edge (wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}`;
	}

	// Peripheral mode macros - MODE1
	if (macroName === "m_read_packet_spi_mode1_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	; MODE1 SAMPLING_EDGE: wait for falling edge (wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	qbne    READ_BIT_LOOP?, ${bitId}, 0`;
	}
	if (macroName === "m_read_packet_spi_mode1_slave_lsb_gpi_sclk") {
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
READ_BIT_LOOP?:
	; MODE1 SAMPLING_EDGE: wait for falling edge (wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}`;
	}

	// Peripheral mode macros - MODE2
	if (macroName === "m_read_packet_spi_mode2_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	; MODE2 SAMPLING_EDGE: wait for falling edge (wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	qbne    READ_BIT_LOOP?, ${bitId}, 0`;
	}
	if (macroName === "m_read_packet_spi_mode2_slave_lsb_gpi_sclk") {
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
READ_BIT_LOOP?:
	; MODE2 SAMPLING_EDGE: wait for falling edge (wait_high_pulse)
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}`;
	}

	// Peripheral mode macros - MODE3
	if (macroName === "m_read_packet_spi_mode3_slave_msb_gpi_sclk") {
		macroBody += `	; Wait for CS high pulse (CS going HIGH then LOW)
wait_for_high_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbc    wait_for_high_transition?, r31, ${CS_PIN}
	.endloop
wait_for_low_transition?:
	.loop   ${CS_FILTER_CYCLES}
	qbbs    wait_for_low_transition?, r31, ${CS_PIN}
	.endloop
	ldi     ${bitId}, ${PACKETSIZE}
READ_BIT_LOOP?:
	sub     ${bitId}, ${bitId}, 1
	; MODE3 SAMPLING_EDGE: wait for rising edge (wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	qbne    READ_BIT_LOOP?, ${bitId}, 0`;
	}
	if (macroName === "m_read_packet_spi_mode3_slave_lsb_gpi_sclk") {
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
READ_BIT_LOOP?:
	; MODE3 SAMPLING_EDGE: wait for rising edge (wait_low_pulse)
wait_for_low_transition_loop?:
	.loop   1
	qbbs    wait_for_low_transition_loop?, r31, ${SCLK_PIN}
	.endloop
wait_for_high_transition_loop?:
	.loop   1
	qbbc    wait_for_high_transition_loop?, r31, ${SCLK_PIN}
	.endloop
	qbbc    BIT_ENTRY_0?, r31, ${SDI_PIN}
	set     ${dataReg}, ${dataReg}, ${bitId}
	qba     SKIP_BIT_ENTRY_0?
BIT_ENTRY_0?:
	clr     ${dataReg}, ${dataReg}, ${bitId}
	nop
SKIP_BIT_ENTRY_0?:
	add     ${bitId}, ${bitId}, 1
	qbne    READ_BIT_LOOP?, ${bitId}, ${PACKETSIZE}`;
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

This section describes how to programmatically configure the SPI Read block in a .syscfg file.

### Adding a SPI Read Instance

\\\`\\\`\\\`javascript
const pru_spi_read = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_read", {}, false);
const spi_read1 = pru_spi_read.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE1" | Clock polarity and phase |
| packetSize | Integer | 8-32 | 8 | Number of bits to read |
| Endiness | String | "most significant bit first", "least significant bit first" | "least significant bit first" | Bit order |
| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
| SDI Signal | String | "0"-"19" | "1" | GPIO pin for data input |
| CS Signal | String | "0"-"19" | "2" | GPIO pin for chip select |
| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock high time (Controller only) |
| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
| CS Setup Time | Integer | 0-10000 | 35 | CS setup time in nanoseconds (Controller only) |
| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
| Data Setup Time | Integer | 0-10000 | 0 | Data setup time in nanoseconds, converted to PRU cycles internally (Controller only) |
| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |

### Example Configurations

**SPI Controller Read, MODE1, 8-bit, LSB first:**
\\\`\\\`\\\`javascript
spi_read1.$name = "SPI_Read_0";
spi_read1["Device Mode"] = "controller";
spi_read1["SPI Mode"] = "MODE1";
spi_read1.packetSize = 8;
spi_read1["Endiness"] = "least significant bit first";
spi_read1["SCLK Signal"] = "0";
spi_read1["SDI Signal"] = "1";
spi_read1["CS Signal"] = "2";
spi_read1["sclk high pulse width (in PRU cycles)"] = 7;
spi_read1["sclk low pulse width (in PRU cycles)"] = 7;
spi_read1["CS Setup Time"] = 35;
spi_read1["CS Hold Time"] = 10;
\\\`\\\`\\\`

**SPI Peripheral Read, MODE3, 16-bit, MSB first:**
\\\`\\\`\\\`javascript
spi_read1.$name = "SPI_Peripheral_Read";
spi_read1["Device Mode"] = "peripheral";
spi_read1["SPI Mode"] = "MODE3";
spi_read1.packetSize = 16;
spi_read1["Endiness"] = "most significant bit first";
spi_read1["SCLK Signal"] = "4";         // Input pin for clock
spi_read1["SDI Signal"] = "5";
spi_read1["CS Signal"] = "6";           // Input pin for CS
spi_read1["CS Filter Cycles"] = 2;
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect SPI Read output to downstream processing block
scripting.connect(spi_read1, "output1", process_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", spi_read1, "prev");
scripting.connect(spi_read1, "next", next_block, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI). SDI is always input (GPI).

2. **Pin Uniqueness**: All three signals (CS, SCLK, SDI) must use different GPIO pins.

3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	- MODE0: Min High=4, Min Low=3
	- MODE1: Min High=1, Min Low=6
	- MODE2: Min High=3, Min Low=4
	- MODE3: Min High=6, Min Low=1

4. **Read-Only Operation**: This block only reads data from the SPI bus. Use SPI Write or SPI Transfer for sending data.
`;
}

function getLongDescription() {
		return `
## PRU SPI Read Block

### Purpose
Implements SPI (Serial Peripheral Interface) protocol to read data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins.

### How It Works

**Controller Mode:**
1. **Configure Pins**: Select SCLK (clock output), SDI (data input), and CS (chip select output) pins
2. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
3. **Execute**: Generates bit-banged SPI read sequence with proper timing
4. **Output**: Provides received data to the next block

**Peripheral Mode:**
1. **Configure Pins**: Select SCLK (clock input), SDI (data input), and CS (chip select input) pins
2. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
3. **Execute**: Waits for CS assertion and controller clock, then reads data
4. **Output**: Provides received data to the next block

### SPI Protocol
SPI is a synchronous serial communication protocol with:
- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
- **SDI (Serial Data In)**: Data line from device to PRU
- **CS (Chip Select)**: Activates the peripheral device (active low)
- **Modes**: Determines clock polarity (CPOL) and phase (CPHA)

### Configuration Parameters

**Device Mode**: Select Controller or Peripheral operation mode

**SPI Mode**: Select MODE0-3 based on clock polarity and phase
- **MODE0** (CPOL=0, CPHA=0): Clock idles low, data sampled on rising edge, shifted on falling edge
- **MODE1** (CPOL=0, CPHA=1): Clock idles low, data sampled on falling edge, shifted on rising edge
- **MODE2** (CPOL=1, CPHA=0): Clock idles high, data sampled on falling edge, shifted on rising edge
- **MODE3** (CPOL=1, CPHA=1): Clock idles high, data sampled on rising edge, shifted on falling edge

**Packet Size**: Number of bits to read (8-32)
- 8 bits = 1 byte (most common)
- 16 bits = 2 bytes
- 32 bits = 4 bytes (maximum)

**Endianness**: Bit order
- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
- **Least significant bit first** (LSB): Bit 0 → bit 7

**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

**SDI Signal**: Select PRU_GPI pin for data input

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

### Maximum Achievable Frequency
Different SPI modes have different minimum SCLK width requirements due to timing overhead.
Cycles per bit: **(2+d1) + (5+d2)**

**Theoretical Maximum (d1=0, d2=0 — controller overhead only):**
- **MODE0**: Min High=4, Min Low=3 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE1**: Min High=1, Min Low=6 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE2**: Min High=3, Min Low=4 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE3**: Min High=6, Min Low=1 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)

**Practical Maximum (d1=10, d2=7 — recommended for reliable operation):**
- All modes: Min High+Low = 24 cycles → **200 MHz = 8.33 MHz** | **333 MHz = 13.88 MHz**

**Note**: Theoretical maximums assume ideal peripheral response. Practical values (d1=10, d2=7) are recommended for reliable operation and are validated against the open-pru SPI slave macros. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. Always verify with oscilloscope and increase pulse widths if data corruption occurs.

### Setup and Hold Times (Controller Mode Only)

![](../.metadata/sysconfig/.meta/images/setup_and_hold_time.png)

- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
- **Data Setup Time**: Minimum time (in nanoseconds) MISO data must be stable before the sampling clock edge. Nops are inserted before the sampling edge. Automatically converted to PRU cycles internally using Math.ceil.

**Note**: CS Setup Time, CS Hold Time, and Data Setup Time are all specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

### Peripheral Mode Parameters
- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

### Technical Details (Additional Information)

**Performance**:
- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold

### SPI Communication
**Typical SPI Transaction**:
1. Controller asserts CS (waits CS Setup Time)
2. Controller generates clock on SCLK
3. On each clock edge, peripheral outputs one bit on SDI
4. PRU samples SDI after Data Setup Time and stores the bit
5. Repeat for all bits in packet
6. Controller waits CS Hold Time, then deasserts CS

### Usage Notes
- No hardware SPI - uses GPIO bit-banging for flexibility
- Clock timing directly controls SPI speed
- Setup and hold times should match peripheral device datasheet requirements
- Ensure peripheral device supports the configured SPI mode and speed
- Physical pins must be configured via pin mux

### Simulating Input Data

To test SPI Read without hardware, use the **Simulation Settings** module to simulate the SDI (Serial Data In) signal:

1. **Open Simulation Settings**: Navigate to the Simulation Settings module
2. **Select GPI Pin**: In "Select R31 (Input) Signals", select the pin configured as SDI Signal
3. **Configure Input Mode**: Choose Timestamp Mode or Pattern Mode
4. **Define Data Pattern**: Enter the bit values the PRU should receive

**Example - Simulating 0xA5 (10100101) with MODE1:**
\`\`\`
Input Mode: Timestamp
Input Cycles: [100, 107, 114, 121, 128, 135, 142, 149]
Input Values: [1, 0, 1, 0, 0, 1, 0, 1]
\`\`\`

**Timing Calculation:**
- CS Setup Time determines when the first clock edge occurs
- For SCLK high=7, low=7: each bit period = 14 cycles
- MODE1 samples on falling edge: set data before the falling edge
- Align your input transitions with the expected sample points

**Viewing Results:**
- The simulation waveform shows both SCLK (output) and SDI (input)
- Verify that data transitions align with the correct clock edges
- Check the received data register value in the **PRU register allocation summary** view under **SIMULATION RESULTS**

---

### How to Verify Simulation Results

After running simulation:

1. Open the **PRU register allocation summary** view
2. Look for the **SIMULATION RESULTS** section at the bottom
3. Find your SPI Read block and verify the simulated value

---

### Tips for Creating Custom Patterns

1. **Always observe your actual waveform first**: Your actual SCLK timing depends on:
- Where the SPI Read block is placed in your flow
- Blocks executed before it (they consume cycles)
- Your specific timing configuration

2. **Start with all 1s or all 0s**: Set \`Input Cycles: [1]\`, \`Input Values: [1]\` or \`[0]\` with Repeat Last Bit enabled to verify you can receive constant data

3. **Identify exact sample points from waveform**:
- Run simulation with the above constant pattern
- Look at the SCLK waveform to see when clock edges occur
- Note the cycle numbers of the sampling edges for your mode:
	- MODE0: Rising edges
	- MODE1: Falling edges
	- MODE2: Falling edges
	- MODE3: Rising edges

4. **Set SDI transitions BEFORE sample points**: Once you know when sampling occurs (e.g., cycles 50, 60, 70...), set your SDI transitions a few cycles earlier (e.g., cycles 48, 58, 68...)

5. **Use the mode's sampling edge**:
- MODE0/MODE2: Sample on the first clock edge after the idle state changes
- MODE1/MODE3: Sample on the second clock edge

6. **Verify incrementally**: If the full byte isn't working, test one bit at a time to identify timing issues

### Terminology
- **SPI**: Serial Peripheral Interface - synchronous serial protocol
- **Bit-banging**: Software-controlled pin toggling to implement protocols
- **SCLK**: Serial Clock - timing signal for synchronization
- **SDI**: Serial Data In - data from peripheral to controller
- **CS**: Chip Select - enables/disables peripheral device
- **MSB/LSB**: Most/Least Significant Bit - bit order
- **Endianness**: Order of bit/byte transmission
- **CPOL**: Clock Polarity - idle state of clock (0=LOW, 1=HIGH)
- **CPHA**: Clock Phase - which edge shifts data (0=first edge, 1=second edge)
- **Setup Time**: Minimum time data must be stable before clock edge
- **Hold Time**: Minimum time data must remain stable after clock edge
- **CS Setup Time**: Time between CS assertion and first clock edge
- **CS Hold Time**: Time between last clock edge and CS deassertion

---`;
}


exports = {
	displayName: "PRU SPI Read",
	defaultInstanceName: `${PRU_USED}_SPI_Read_`,
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
					let pruFreqMHz = 200;
					const staticMod = system.modules["/pru_blocks/common/pru_blocks_static_module"];
					if (staticMod && staticMod.$static && staticMod.$static.pruClkFreq) {
						pruFreqMHz = staticMod.$static.pruClkFreq;
					}
					const csSetupCycles   = Math.ceil(inst["CS Setup Time"]   * pruFreqMHz / 1000);
					const csHoldCycles    = Math.ceil(inst["CS Hold Time"]    * pruFreqMHz / 1000);
					const dataSetupCycles = Math.ceil(inst["Data Setup Time"] * pruFreqMHz / 1000);
					// Controller mode: dataReg, PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, DELAY_COMPEN_1, DELAY_COMPEN_2, CS_PIN, CS_SETUP_TIME, CS_HOLD_TIME, DATA_SETUP_TIME
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+", " + inst["SDI Signal"] + ", " + inst["delay_component1"] + ", " + inst["delay_component2"] + ", " + inst["CS Signal"]
						+ ", " + csSetupCycles + ", " + csHoldCycles + ", " + dataSetupCycles;
				} else {
					// Peripheral mode: dataReg, PACKETSIZE, bitId, SCLK_PIN, SDI_PIN, CS_PIN, CS_FILTER_CYCLES (MODE removed - now in macro name)
					return inst["packetSize"] + ", TEMP_REG1.b0, " + inst["SCLK Signal"]
						+", " + inst["SDI Signal"] + ", " + inst["CS Signal"] + ", " + inst["CS Filter Cycles"];
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
						displayName: `${PRU_USED}_GPO_${i}`
					}));
				} else {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `${PRU_USED}_GPI_${i}`
					}));
				}
			}
		},
        {
			name: "SDI Signal",
			default: "1",
            options: Array.from({ length: 20 }, (_, i) => ({
                name : `${i}`,
                displayName: `${PRU_USED}_GPI_${i}`
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
						displayName: `${PRU_USED}_GPO_${i}`
					}));
				} else {
					return Array.from({ length: 20 }, (_, i) => ({
						name : `${i}`,
						displayName: `${PRU_USED}_GPI_${i}`
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
			displayName: "Data Setup Time (ns)",
			description: "Time after clock edge before sampling data (nanoseconds). Converted to PRU cycles internally using Math.ceil.",
			default: 0,
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
			name: "CS Setup Time",
			displayName: "CS Setup Time (ns)",
			description: "Time delay after CS assertion before starting SPI transaction",
			default: 35,
			range: [0, 10000],
			hidden: false
		},
		{
			name: "CS Hold Time",
			displayName: "CS Hold Time (ns)",
			description: "Time delay after SPI transaction before CS deassertion",
			default: 10,
			range: [0, 10000],
			hidden: false
		},
        {
            name: "delay_component1",
            default : 1,
            hidden: true,
            getValue: (inst) => {
				// Only apply mode-specific logic for Controller mode
				if (inst["Device Mode"] === "peripheral") {
					return 0; // Not used in Peripheral mode
				}

				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];

				let pruFreqMHz = 200;
				const staticMod = system.modules["/pru_blocks/common/pru_blocks_static_module"];
				if (staticMod && staticMod.$static && staticMod.$static.pruClkFreq) {
					pruFreqMHz = staticMod.$static.pruClkFreq;
				}
				const dataSetup = Math.ceil(inst["Data Setup Time"] * pruFreqMHz / 1000);

				let value = 0;

				// MODE0: SHIFTING_EDGE = SET SCLK (HIGH pulse starts), overhead = 5
				if (mode === "MODE0") value = high - 4;

				// MODE1: DATA_SETUP_TIME is now in the HIGH half (before CLR SCLK sampling edge)
				// HIGH half overhead: SET SCLK + sub (1) + dataSetup = 2 + dataSetup
				else if (mode === "MODE1") value = high - 2 - dataSetup;

				// MODE2: DATA_SETUP_TIME is not in this half (accounted for in delay_component2)
				// LOW half overhead: overhead compensation of 4 = low - 4
				else if (mode === "MODE2") value = low - 4 ;

				// MODE3: DATA_SETUP_TIME is now in the LOW half (before SET SCLK sampling edge)
				// LOW half overhead: CLR SCLK + sub (1) + dataSetup = 2 + dataSetup
				else value = low - 2 - dataSetup;  // MODE3

				// Ensure delay component is not negative
				return Math.max(0, value);
			},
        },
        {
            name: "delay_component2",
            default : 1,
            hidden: true,
            getValue: (inst) => {
				// Only apply mode-specific logic for Controller mode
				if (inst["Device Mode"] === "peripheral") {
					return 0; // Not used in Peripheral mode
				}

				const mode = inst["SPI Mode"];
				const high = inst["sclk high pulse width (in PRU cycles)"];
				const low = inst["sclk low pulse width (in PRU cycles)"];

				let pruFreqMHz = 200;
				const staticMod = system.modules["/pru_blocks/common/pru_blocks_static_module"];
				if (staticMod && staticMod.$static && staticMod.$static.pruClkFreq) {
					pruFreqMHz = staticMod.$static.pruClkFreq;
				}
				const dataSetup = Math.ceil(inst["Data Setup Time"] * pruFreqMHz / 1000);

				let value = 0;

				// MODE0: DATA_SETUP_TIME is in the LOW half (before SET SCLK sampling edge)
				// LOW half overhead: CLR SCLK + dataSetup + bit handling (4) + qbne (1) = 6 + dataSetup
				if (mode === "MODE0") value = low - 3 - dataSetup;

				// MODE1: DATA_SETUP_TIME is in the HIGH half (not here)
				// LOW half overhead: CLR SCLK + bit handling (4) + qbne (1) = 6
				else if (mode === "MODE1") value = low - 5;

				// MODE2: DATA_SETUP_TIME is in the HIGH half (before CLR SCLK sampling edge)
				// HIGH half overhead: overhead compensation of 3 + dataSetup = high - 3 - dataSetup
				else if (mode === "MODE2") value = high - 3 - dataSetup;

				// MODE3: DATA_SETUP_TIME is in the LOW half (not here)
				// HIGH half overhead: SET SCLK + bit handling (4) + qbne (1) = 6
				else value = high - 5;  // MODE3

				// Ensure delay component is not negative
				return Math.max(0, value);
			},
        },
		{
			name: "opCode",
            displayName: "m_read_packet_spi_mode1_msb_gpo_sclk",
			default: "m_read_packet_spi_mode1_msb_gpo_sclk",
			hidden: true,
            getValue: (inst) => {
				// Get the mode number from SPI Mode string (e.g., "MODE3" -> "mode3")
				const mode = inst["SPI Mode"].toLowerCase();

				if (inst["Device Mode"] === "controller") {
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_read_packet_spi_" + mode + "_msb_gpo_sclk";
					}
					else
					{
						return "m_read_packet_spi_" + mode + "_lsb_gpo_sclk"
					}
				} else {
					// Peripheral mode - now includes mode in the name
					if(inst["Endiness"] == "most significant bit first")
					{
						return "m_read_packet_spi_" + mode + "_slave_msb_gpi_sclk";
					}
					else
					{
						return "m_read_packet_spi_" + mode + "_slave_lsb_gpi_sclk"
					}
				}
			},
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
			default: 0,
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
				// Controller mode: includes CS setup, bit loop, and CS hold time
				// Peripheral mode: includes CS filter, bit loop (no CS setup/hold)
				if (inst["Device Mode"] === "controller") {
					let pruFreqMHz = 200;
					const staticMod = system.modules["/pru_blocks/common/pru_blocks_static_module"];
					if (staticMod && staticMod.$static && staticMod.$static.pruClkFreq) {
						pruFreqMHz = staticMod.$static.pruClkFreq;
					}
					const csSetupCycles  = Math.ceil(inst["CS Setup Time"]   * pruFreqMHz / 1000);
					const csHoldCycles   = Math.ceil(inst["CS Hold Time"]    * pruFreqMHz / 1000);
					const dataSetupCycles = Math.ceil(inst["Data Setup Time"] * pruFreqMHz / 1000);

					// Cycles per bit: fixed overhead + DATA_SETUP_TIME + delay_component1 + delay_component2
					const cyclesPerBit = 7 + dataSetupCycles + inst["delay_component1"] + inst["delay_component2"];

					return 1 + csSetupCycles + 1 +
					       (inst["packetSize"] * cyclesPerBit) +
					       csHoldCycles + 1;
				} else {
					return 4 + inst["delay_component1"] + (inst["packetSize"] - 1) * (6 + inst["delay_component1"] + inst["delay_component2"]);
				}
			},
			default : 1
		},
	],
	ports: (inst) => { 
		let ports = [];
		for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
		{
			ports.push({ name: "input"+iterator.toString(), type: "input32" })
		}
		for(let iterator = 1; iterator <= inst["numOfOutputPorts"]; iterator++)
		{
			ports.push({ name: "output"+iterator.toString(), type: "output32"})
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
1 + delay component1 + 1 to clear

2nd to packet size:
3 +  delay component2 + 1 to set
1 + delay component1 + 1 to clear

*/