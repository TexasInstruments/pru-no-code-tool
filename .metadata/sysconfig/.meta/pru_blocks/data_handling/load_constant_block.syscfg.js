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
	return getLongDescription()  + `
	## How to Configure (For AI/Scripting)

	This section describes how to programmatically configure the Load Constant block in a .syscfg file.

	### Adding a Load Constant Instance

	\\\`\\\`\\\`javascript
	const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
	const ldi1 = load_constant_block.addInstance();
	\\\`\\\`\\\`

	### Configuration Parameters

	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| constant1 | Integer | 0 to 0xFFFFFFFF | 0 | Constant value to load |

	### Example Configurations

	**Load small value (8-bit, uses LDI):**
	\\\`\\\`\\\`javascript
	ldi1.$name = "Load_Small";
	ldi1.constant1 = 0x55;           // 85 decimal
	\\\`\\\`\\\`

	**Load medium value (16-bit, uses LDI):**
	\\\`\\\`\\\`javascript
	ldi1.$name = "Load_Medium";
	ldi1.constant1 = 0x1234;         // 4660 decimal
	\\\`\\\`\\\`

	**Load large value (32-bit, uses LDI32):**
	\\\`\\\`\\\`javascript
	ldi1.$name = "Load_Large";
	ldi1.constant1 = 0xDEADBEEF;     // 3735928559 decimal
	\\\`\\\`\\\`

	**Load bit mask:**
	\\\`\\\`\\\`javascript
	ldi1.$name = "Bit_Mask";
	ldi1.constant1 = 0xFF00FF00;     // Alternating byte mask
	\\\`\\\`\\\`

	**Load zero:**
	\\\`\\\`\\\`javascript
	ldi1.$name = "Zero_Value";
	ldi1.constant1 = 0;
	\\\`\\\`\\\`

	### Connecting to Other Blocks

	\\\`\\\`\\\`javascript
	// Connect output to downstream block (e.g., arithmetic, UART TX, SPI)
	scripting.connect(ldi1, "output1", arithmetic_block, "input1");

	// Connect control flow
	scripting.connect(prev_block, "next", ldi1, "prev");
	scripting.connect(ldi1, "next", next_block, "prev");
	\\\`\\\`\\\`

	### Important Notes

	1. **Source Block**: Load Constant has no input - it's a data source.

	2. **Auto-sizing**: The block automatically selects LDI (1 cycle) for values ≤ 0xFFFF and LDI32 (2 cycles) for larger values.

	3. **Output Size**: Output register size is automatically determined:
	- 1 byte for values 0-255
	- 2 bytes for values 256-65535
	- 4 bytes for values > 65535

	4. **Hexadecimal**: Values can be specified in hex (0x prefix) or decimal.
	`;
}

function getLongDescription() {
	return `
## Load Constant Block

### Purpose
Loads an immediate constant value into a register. This is typically the starting block in a data flow, providing initial values or configuration parameters.

### How It Works
1. **Enter Value**: Specify a constant value (0 to 0xFFFFFFFF)
2. **Auto-sizing**: Block automatically selects the appropriate instruction based on value size
3. **Output**: Provides the constant value to the next block

### Configuration
- **Constant Value**: Enter any value from 0 to 4,294,967,295 (0xFFFFFFFF)
  - Can be entered in decimal or hexadecimal format
  - Block automatically determines optimal instruction

### Technical Details (Additional Information)
**Generated Assembly** (auto-selected based on value size):
; For values 0-255 (8-bit):
LDI result, value                  ; 1 cycle

; For values 256-65535 (16-bit):
LDI result, value                  ; 1 cycle

; For values > 65535 (32-bit):
LDI32 result, value                ; 1 cycle (uses two instruction slots)

**Performance**: 1 PRU cycle

### Usage Notes
- No input connections - this is a source block
- Output can be connected to any block that accepts data input
- Value is loaded at the time this block executes in the flow
- Commonly used for:
  - Table indices
  - Counter initialization
  - Configuration values
  - Bit masks

### Terminology
- **LDI**: Load Immediate - instruction to load a constant into a register
- **LDI32**: Load 32-bit Immediate - instruction for full 32-bit constants
- **Immediate value**: Constant value embedded directly in the instruction

---
`;
}

exports = {
	displayName: "Load Constant",
	defaultInstanceName: "Load_Constant_",
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
			displayName: "Constant Value",
			default: 0,
			range: [0x0, 0xFFFFFFFF],
			onChange: (inst,ui) => {
				let bytes = inst["output1Size"];
				if(bytes == 3)
				{
					//storing in 4 continous bytes to number of instructions to access
					//trade off :  Need to check whether to reduce number of instrutions or register usage
					return bytes + 1;
				}
				if(bytes == 1)
				{
					inst["opCode"] = "LDI"
				}
				if(bytes == 2)
				{
					inst["opCode"] = "LDI"
				}
				if(bytes == 4)
				{
					inst["opCode"] = "LDI32"
				}
			}
		},
		{
			name: "opCode",
			default: "LDI",
			hidden: true
		},
		{
			name: "output1Size",
            default: 1,
			hidden: true,
            getValue: (inst) => {
				let bytes = getNumOfBytes(inst["constant1"]);
				if(bytes == 3)
				{
					//storing in 4 continous bytes to number of instructions to access
					//trade off :  Need to check whether to reduce number of instrutions or register usage
					return bytes + 1;
				}
				return bytes
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
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				if(inst["opCode"] == "LDI")
				{
					return 1;
				}
				return 2;
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
}