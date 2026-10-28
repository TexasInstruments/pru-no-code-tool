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



function getLongDescription(){
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/pru_io_blocks/pru_gpo_block.md 

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
	defaultInstanceName: `${PRU_USED}_GPO_INSTANCE_`,
	longDescription: getLongDescription(),
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
                displayName: `${PRU_USED}_GPO_${i}`,
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
			ports.push({ name: "input"+iterator.toString(), type: "input32" })
		}
		for(let iterator = 1; iterator <= inst["numOfOutputPorts"]; iterator++)
		{
			ports.push({ name: "output"+iterator.toString(), type: "output32"})
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