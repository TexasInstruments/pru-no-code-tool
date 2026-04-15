function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)	
		}
	}	
}

function getNumOfBytes(value)
{
	value = value.toString(2);
	if(value.length <= 8)
	{
		return 1;
	}
	if(value.length <= 16)
	{
		return 2;
	}
	if(value.length <= 24)
	{
		return 3;
	}
	return 4;
}

function getAIContext() {
    return getLongDescription() + `

	## How to Configure (For AI/Scripting)

	This section describes how to programmatically configure the PRU GPI block in a .syscfg file.
	
	### Adding a PRU GPI Instance
	
	\\\`\\\`\\\`javascript
	const pru_gpi_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpi_block", {}, false);
	const gpi1 = pru_gpi_block.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| constant1 | String | "R31, 1 << 0" to "R31, 1 << 19" | "R31, 1 << 0" | PRU GPI pin selection (bit mask) |
	
	### Valid Values for constant1
	
	| Value | Display Name | Description |
	|-------|--------------|-------------|
	| "R31, 1 << 0" | PRU_GPI_0 | Read input pin 0 |
	| "R31, 1 << 1" | PRU_GPI_1 | Read input pin 1 |
	| "R31, 1 << 2" | PRU_GPI_2 | Read input pin 2 |
	| ... | ... | ... |
	| "R31, 1 << 19" | PRU_GPI_19 | Read input pin 19 |
	
	### Example Configurations
	
	**Read from PRU_GPI_0:**
	\\\`\\\`\\\`javascript
	gpi1.$name = "PRU_GPI_0";
	gpi1.constant1 = "R31, 1 << 0";
	\\\`\\\`\\\`
	
	**Read from PRU_GPI_5 (button input):**
	\\\`\\\`\\\`javascript
	gpi1.$name = "Button_Input";
	gpi1.constant1 = "R31, 1 << 5";
	\\\`\\\`\\\`
	
	**Read from PRU_GPI_14 (UART RX line):**
	\\\`\\\`\\\`javascript
	gpi1.$name = "UART_RX_Monitor";
	gpi1.constant1 = "R31, 1 << 14";
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// Connect GPI output to downstream processing block
	scripting.connect(gpi1, "output1", process_block, "input1");
	
	// Connect control flow
	scripting.connect(prev_block, "next", gpi1, "prev");
	scripting.connect(gpi1, "next", next_block, "prev");
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Output**: The GPI block outputs the masked bit value from R31 (either 0 or non-zero based on pin state).
	
	2. **Pin Mux**: Physical pin must be configured as PRU GPI in pin mux settings.
	
	3. **Read-Only**: R31 is a read-only register that reflects current pin states.
	
	4. **Single Cycle**: Reading takes only 1 PRU cycle.
	`;
}

function getLongDescription(){
	return `
## PRU GPI Block (General Purpose Input)

### Purpose
Reads digital input signals from PRU input pins and outputs the pin state to the next block.

### How It Works
1. **Select Pin**: Choose which PRU input pin to read (PRU_GPI_0 through PRU_GPI_19)
2. **Read Operation**: Generates an AND instruction to mask and read the specific bit from R31 register
3. **Output**: Provides the pin value (0 or 1) to the next block

### Configuration
- **PRU GPI Signal**: Select the input pin number (0-19)
  - Each pin maps to a specific bit in the R31 register
  - PRU_GPI_0 = bit 0, PRU_GPI_1 = bit 1, etc.

### Technical Details (Additional Information)
**Generated Assembly**:
- AND result, R31, (1 << pin_number)    ; Mask the specific bit (1 cycle)

**Performance**: 1 PRU cycle

**Register**: R31 is the PRU's input register
- Read-only register
- Reflects current state of PRU input pins
- Updated automatically by hardware

### Pin Mapping
The PRU_GPI pins map to physical device pins based on your board's pin mux configuration. Check your device's technical reference manual for exact pin mappings.

### Usage Examples

**Example 1: Reading a button state**
\`\`\`
PRU GPI Block configured for PRU_GPI_5
  ↓ (outputs button state: 1=pressed, 0=released)
Next block processes button state
\`\`\`

**Example 2: Reading multiple sensors**
\`\`\`
PRU GPI (pin 0) → Sensor 1 state
PRU GPI (pin 1) → Sensor 2 state
PRU GPI (pin 2) → Sensor 3 state
\`\`\`

**Example 3: Monitoring a UART RX line**
\`\`\`
PRU GPI (pin 14) → UART RX signal state → Process in custom code
\`\`\`

### Simulating Input Data

To test PRU GPI without hardware, use the **Simulation Settings** module to simulate pin state changes on R31:

**Simulation Setup:**
1. **Open Simulation Settings**: Navigate to the Simulation Settings module
2. **Select R31 Pin**: In "Select R31 (Input) Signals", select the pin configured for GPI
3. **Configure Input Mode**: Choose Timestamp Mode or Pattern Mode
4. **Define Pin States**: Enter when the pin should be HIGH (1) or LOW (0)

**Example - Simulating button press on PRU_GPI_5:**
\`\`\`
R31 Bit 5 - Timestamp Mode:
  Input Cycles: [0, 100, 200, 300]
  Input Values: [0, 1, 1, 0]

  Interpretation:
  - Cycles 0-99: Button released (0)
  - Cycles 100-199: Button pressed (1)
  - Cycles 200-299: Button still pressed (1)
  - Cycles 300+: Button released (0)
\`\`\`

**Example - Simulating PWM signal on PRU_GPI_3:**
\`\`\`
R31 Bit 3 - Pattern Mode:
  Pattern: 1111110000111111000011111100001111110000

  Simulates a 60% duty cycle PWM signal
\`\`\`

**Example - Simulating sensor transitions:**
\`\`\`
R31 Bit 10 - Timestamp Mode:
  Input Cycles: [50, 150, 250, 350, 450]
  Input Values: [1, 0, 1, 0, 1]

  Simulates sensor detecting presence at specific time intervals
\`\`\`

**Viewing Results:**
- Monitor the output value from the GPI block
- Verify the masked bit value matches expected R31 state
- Check that transitions occur at the configured cycle times
- Use waveform view to visualize input signal timing

### Terminology
- **GPI**: General Purpose Input
- **R31**: PRU input register (32-bit, read-only)
- **Bit masking**: Using AND operation to isolate a specific bit
- **Pin mux**: Pin multiplexer - configures physical pins for different functions
- **Pull-up/Pull-down**: Resistor that sets default pin state when not driven
- **Debouncing**: Filtering technique to remove noise from mechanical switches
- **Floating**: Unconnected pin that can randomly read 0 or 1

---
`;
}

exports = {
	displayName: "PRU GPI",
	defaultInstanceName: "PRU_GPI_",
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
			default: "pin",
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
		{
			name: "constant1",
			displayName: "PRU GPI Signal",
			default: "R31, 1 << 0",
            options: Array.from({ length: 20 }, (_, i) => ({
                name: `R31, 1 << ${i}`,
                displayName: `PRU_GPI_${i}`,
            }))
		},
		{
			name: "opCode",
            displayName: "Output",
			default: "AND",
			hidden: true
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
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				return 1;
			},
			default : 1
		},
        {
			name: "output1Size",
            default: 1,
			hidden: true,
            getValue: (inst) => {

				let bytes = getNumOfBytes(eval(inst["constant1"].split(",")[1].trim()));
				if(bytes == 3)
				{
					return bytes + 1;
				}
				return bytes
			}
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
		ports.push({ name: "prev", type: "IO_PREV" })
        ports.push({ name: "next", type: "IO_NEXT" })
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
}