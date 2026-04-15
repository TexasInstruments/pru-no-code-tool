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
	
	This section describes how to programmatically configure the PRU GPO block in a .syscfg file.
	
	### Adding a PRU GPO Instance
	
	\\\`\\\`\\\`javascript
	const pru_gpo_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);
	const gpo1 = pru_gpo_block.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| constant1 | String | "R30, 0" to "R30, 19" | "R30, 0" | PRU GPO pin selection |
	| opCode | String | "SET", "CLR" | "SET" | Output operation (SET=HIGH, CLR=LOW) |
	
	### Valid Values for constant1
	
	| Value | Display Name | Description |
	|-------|--------------|-------------|
	| "R30, 0" | PRU_GPO_0 | Control output pin 0 |
	| "R30, 1" | PRU_GPO_1 | Control output pin 1 |
	| "R30, 2" | PRU_GPO_2 | Control output pin 2 |
	| ... | ... | ... |
	| "R30, 19" | PRU_GPO_19 | Control output pin 19 |
	
	### Valid Values for opCode
	
	| Value | Display Name | Description |
	|-------|--------------|-------------|
	| "SET" | SET SIGNAL | Sets the pin HIGH (logic 1) |
	| "CLR" | CLEAR SIGNAL | Sets the pin LOW (logic 0) |
	
	### Example Configurations
	
	**Set PRU_GPO_0 HIGH:**
	\\\`\\\`\\\`javascript
	gpo1.$name = "PRU_GPO_0_Set";
	gpo1.constant1 = "R30, 0";
	gpo1.opCode = "SET";
	\\\`\\\`\\\`
	
	**Clear PRU_GPO_5 (turn LED OFF):**
	\\\`\\\`\\\`javascript
	gpo1.$name = "LED_Off";
	gpo1.constant1 = "R30, 5";
	gpo1.opCode = "CLR";
	\\\`\\\`\\\`
	
	**Assert chip select (active low):**
	\\\`\\\`\\\`javascript
	gpo1.$name = "CS_Assert";
	gpo1.constant1 = "R30, 10";
	gpo1.opCode = "CLR";
	\\\`\\\`\\\`
	
	**Deassert chip select:**
	\\\`\\\`\\\`javascript
	gpo1.$name = "CS_Deassert";
	gpo1.constant1 = "R30, 10";
	gpo1.opCode = "SET";
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// GPO is a terminating block - no output connection
	// Connect control flow only
	scripting.connect(prev_block, "next", gpo1, "prev");
	scripting.connect(gpo1, "next", next_block, "prev");
	\\\`\\\`\\\`
	
	### Creating a Pulse
	
	\\\`\\\`\\\`javascript
	// Create SET and CLR blocks for pulse generation
	const pru_gpo_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);
	const gpo_set = pru_gpo_block.addInstance();
	const gpo_clr = pru_gpo_block.addInstance();
	
	gpo_set.$name = "Pulse_High";
	gpo_set.constant1 = "R30, 3";
	gpo_set.opCode = "SET";
	
	gpo_clr.$name = "Pulse_Low";
	gpo_clr.constant1 = "R30, 3";
	gpo_clr.opCode = "CLR";
	
	// Connect in sequence: SET -> delay -> CLR
	scripting.connect(gpo_set, "next", delay_block, "prev");
	scripting.connect(delay_block, "next", gpo_clr, "prev");
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Terminating Block**: GPO has no output port - it only controls physical pins.
	
	2. **Pin Mux**: Physical pin must be configured as PRU GPO in pin mux settings.
	
	3. **Single Cycle**: SET/CLR operations take only 1 PRU cycle.
	
	4. **Persistence**: Pin state persists until explicitly changed by another GPO block.
	
	5. **Multiple Pins**: Use separate GPO instances to control different pins.
	`;
}

function getLongDescription(){
	return `
	## PRU GPO Block (General Purpose Output)

	### Purpose
	Sets or clears digital output signals on PRU output pins. This is a terminating block that directly controls physical pin states.

	### How It Works
	1. **Select Pin**: Choose which PRU output pin to control (PRU_GPO_0 through PRU_GPO_19)
	2. **Select Operation**: Choose SET (HIGH) or CLEAR (LOW)
	3. **Execute**: Generates SET/CLR instruction to change the pin state immediately

	### Configuration
	- **PRU GPO Signal**: Select the output pin number (0-19)
	- Each pin maps to a specific bit in the R30 register
	- PRU_GPO_0 = bit 0, PRU_GPO_1 = bit 1, etc.
	- **Output Operation**:
	- **SET SIGNAL**: Sets the pin HIGH (logic 1)
	- **CLEAR SIGNAL**: Sets the pin LOW (logic 0)

	### Technical Details (Additional Information)
	**Generated Assembly**:
	- SET R30, pin_number      ; Set pin HIGH (1 cycle)
	- ; OR
	- CLR R30, pin_number      ; Set pin LOW (1 cycle)

	**Performance**: 1 PRU cycle

	**Register**: R30 is the PRU's output register
	- Write-only register
	- Controls state of PRU output pins
	- Changes take effect immediately

	### Usage Notes
	- This is a **terminating block** - it has no output connections
	- Multiple GPO blocks can control different pins independently
	- Pin states persist until explicitly changed
	- Physical pin behavior depends on pin mux configuration

	### Pin Mapping
	The PRU_GPO pins map to physical device pins based on your board's pin mux configuration. Check your device's technical reference manual for exact pin mappings.

	### Usage Examples

	**Example 1: Controlling an LED**
	\`\`\`
	[Some condition check] → PRU GPO (pin 5, SET)
							Turns LED ON

	[Another condition] → PRU GPO (pin 5, CLR)
						Turns LED OFF
	\`\`\`

	**Example 2: Generating a chip select signal**
	\`\`\`
	Start of SPI transaction:
	PRU GPO (CS pin, CLR) → Assert CS (active low)

	[SPI data transfer blocks]

	End of SPI transaction:
	PRU GPO (CS pin, SET) → Deassert CS (return to idle high)
	\`\`\`

	**Example 3: Creating a pulse/strobe signal**
	\`\`\`
	PRU GPO (pin 10, SET)  → Set pulse HIGH
	[Delay block]
	PRU GPO (pin 10, CLR)  → Set pulse LOW

	Generates a pulse of configurable width
	\`\`\`

	**Example 4: Multi-bit parallel output**
	\`\`\`
	PRU GPO (pin 0, SET/CLR)  → Bit 0 of parallel bus
	PRU GPO (pin 1, SET/CLR)  → Bit 1 of parallel bus
	PRU GPO (pin 2, SET/CLR)  → Bit 2 of parallel bus
	PRU GPO (pin 3, SET/CLR)  → Bit 3 of parallel bus

	Creates a 4-bit parallel output port
	\`\`\`

	**Example 5: Status/debug indicators**
	\`\`\`
	[Error detected] → PRU GPO (error LED pin, SET)
	[Normal operation] → PRU GPO (error LED pin, CLR)
	[Busy processing] → PRU GPO (busy LED pin, SET)
	[Idle] → PRU GPO (busy LED pin, CLR)
	\`\`\`

	**Example 6: GPIO bit-banging protocols**
	\`\`\`
	I2C Clock (SCL):
	PRU GPO (SCL pin, SET/CLR) at appropriate times

	I2C Data (SDA):
	PRU GPO (SDA pin, SET/CLR) for data transmission
	(Note: Need to switch to input mode for reading)
	\`\`\`

	### Terminology
	- **GPO**: General Purpose Output
	- **R30**: PRU output register (32-bit, write-only)
	- **SET**: Instruction that sets a bit to 1 (HIGH)
	- **CLR**: Instruction that clears a bit to 0 (LOW)
	- **Pin mux**: Pin multiplexer - configures physical pins for different functions
	- **Terminating block**: Block with no output connections to other blocks
	- **Bit-banging**: Software-controlled pin toggling to implement protocols
	- **Current drive**: Maximum current a pin can source or sink
	- **Open-drain**: Output configuration requiring external pull-up resistor
	- **Logic level**: Voltage representing HIGH (1) or LOW (0) state
	- **Pull-up/Pull-down**: Resistor that sets default pin state when not actively driven

	---
	`;
}

exports = {
	displayName: "PRU GPO",
	defaultInstanceName: "PRU_GPO_",
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
			displayName: "PRU GPO Signal",
			default: "R30, 0",
            options: Array.from({ length: 20 }, (_, i) => ({
                name: `R30, ${i}`,
                displayName: `PRU_GPO_${i}`,
            }))
		},
		{
			name: "opCode",
            displayName: "Output",
			default: "SET",
            options: [
            {
                name: "SET",
                displayName: "SET SIGNAL",
            },
            {
                name: "CLR",
                displayName: "CLEAR SIGNAL",
            }],
		},
		{
			name: "outputReg",
            default: "R30",
			hidden: true
		},
		{
			name: "numOfInputPorts",
			default: 0,
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
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				return 1;
			},
			default : 1
		}
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