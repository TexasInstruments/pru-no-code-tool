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



function getLongDescription() {
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/data_handling/load_constant_block.md 

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
}