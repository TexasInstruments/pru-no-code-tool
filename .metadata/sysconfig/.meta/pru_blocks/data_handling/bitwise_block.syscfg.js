function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}
}

function getAIContext(){
	return getLongDescription() + `
	## How to Configure (For AI/Scripting)
	
	This section describes how to programmatically configure the Bitwise block in a .syscfg file.
	
	### Adding a Bitwise Instance
	
	\\\`\\\`\\\`javascript
	const bitwise_block = scripting.addModule("/pru_blocks/data_handling/bitwise_block", {}, false);
	const bitwise1 = bitwise_block.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| opCode | String | "AND", "OR", "XOR", "NOT", "LSL", "LSR" | "AND" | Bitwise operation to perform |
	| output1Size | String | "maxOfInputs", "1", "2", "4" | "maxOfInputs" | Output size in bytes |
	
	### Valid Values for opCode
	
	| Value | Inputs | Description |
	|-------|--------|-------------|
	| "AND" | 2 | Bitwise AND: result = input1 & input2 |
	| "OR" | 2 | Bitwise OR: result = input1 \| input2 |
	| "XOR" | 2 | Bitwise XOR: result = input1 ^ input2 |
	| "NOT" | 1 | Bitwise NOT: result = ~input1 |
	| "LSL" | 2 | Logical Shift Left: result = input1 << input2 |
	| "LSR" | 2 | Logical Shift Right: result = input1 >> input2 |
	
	### Valid Values for output1Size
	
	| Value | Display Name | Description |
	|-------|--------------|-------------|
	| "maxOfInputs" | Maximum of Inputs | Auto-size based on largest input |
	| "1" | One byte | Force 8-bit result |
	| "2" | two bytes | Force 16-bit result |
	| "4" | four bytes | Force 32-bit result |
	
	### Example Configurations
	
	**Bitwise AND (masking):**
	\\\`\\\`\\\`javascript
	bitwise1.$name = "Mask_Bits";
	bitwise1.opCode = "AND";
	bitwise1.output1Size = "maxOfInputs";
	\\\`\\\`\\\`
	
	**Bitwise OR (setting flags):**
	\\\`\\\`\\\`javascript
	bitwise1.$name = "Set_Flags";
	bitwise1.opCode = "OR";
	bitwise1.output1Size = "4";
	\\\`\\\`\\\`
	
	**Bitwise NOT (invert):**
	\\\`\\\`\\\`javascript
	bitwise1.$name = "Invert_Bits";
	bitwise1.opCode = "NOT";
	bitwise1.output1Size = "maxOfInputs";
	\\\`\\\`\\\`
	
	**Left Shift:**
	\\\`\\\`\\\`javascript
	bitwise1.$name = "Shift_Left";
	bitwise1.opCode = "LSL";
	bitwise1.output1Size = "4";
	\\\`\\\`\\\`
	
	**Right Shift:**
	\\\`\\\`\\\`javascript
	bitwise1.$name = "Shift_Right";
	bitwise1.opCode = "LSR";
	bitwise1.output1Size = "maxOfInputs";
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// For two-input operations (AND, OR, XOR, LSL, LSR)
	scripting.connect(data_source, "output1", bitwise1, "input1");
	scripting.connect(mask_or_shift_amount, "output1", bitwise1, "input2");
	
	// For single-input operation (NOT)
	scripting.connect(data_source, "output1", bitwise1, "input1");
	
	// Connect output to downstream block
	scripting.connect(bitwise1, "output1", next_block, "input1");
	
	// Connect control flow
	scripting.connect(prev_block, "next", bitwise1, "prev");
	scripting.connect(bitwise1, "next", next_block, "prev");
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Input Count**: NOT requires 1 input; all other operations require 2 inputs.
	
	2. **Single Cycle**: All bitwise operations complete in 1 PRU cycle.
	
	3. **Shift Amount**: For LSL/LSR, input2 specifies the number of bit positions to shift.
	
	4. **Logical Shift**: LSL and LSR fill vacated bits with zeros (no sign extension).
	`;
}

function getLongDescription() {
	return `
	## Bitwise Block

	### Purpose
	Performs bitwise logical operations and bit shift operations on input values. Essential for bit manipulation, masking, and data formatting.

	### How It Works
	1. **Connect Inputs**: Connect one or two data sources (depends on operation)
	2. **Select Operation**: Choose the bitwise operation
	3. **Execute**: Generates the corresponding PRU bitwise instruction
	4. **Output**: Provides the result to the next block

	### Available Operations

	**AND** (2 inputs)
	- Bitwise AND: result = input1 & input2
	- Used for masking bits, clearing specific bits
	- Example: 0b1100 AND 0b1010 = 0b1000

	**OR** (2 inputs)
	- Bitwise OR: result = input1 | input2
	- Used for setting bits, combining flags
	- Example: 0b1100 OR 0b1010 = 0b1110

	**XOR** (2 inputs)
	- Bitwise XOR (exclusive OR): result = input1 ^ input2
	- Used for toggling bits, comparison
	- Example: 0b1100 XOR 0b1010 = 0b0110

	**NOT** (1 input)
	- Bitwise NOT (complement): result = ~input1
	- Inverts all bits
	- Example: NOT 0b1100 = 0b0011 (in 4-bit)

	**LSL** (2 inputs)
	- Logical Shift Left: result = input1 << input2
	- Shifts bits left, fills with zeros
	- Equivalent to multiplying by 2^input2
	- Example: 0b0011 LSL 2 = 0b1100

	**LSR** (2 inputs)
	- Logical Shift Right: result = input1 >> input2
	- Shifts bits right, fills with zeros
	- Equivalent to dividing by 2^input2 (unsigned)
	- Example: 0b1100 LSR 2 = 0b0011

	### Configuration
	- **Bitwise Operation**: Select AND, OR, XOR, NOT, LSL, or LSR
	- Number of inputs adjusts automatically based on operation

	### Technical Details (Additional Information)
	**Generated Assembly**:
	- AND result, input1, input2     ; Bitwise AND (1 cycle)
	- OR  result, input1, input2     ; Bitwise OR (1 cycle)
	- XOR result, input1, input2     ; Bitwise XOR (1 cycle)
	- NOT result, input1             ; Bitwise NOT (1 cycle)
	- LSL result, input1, input2     ; Left shift (1 cycle)
	- LSR result, input1, input2     ; Right shift (1 cycle)

	**Performance**: 1 PRU cycle for all operations

	### Common Use Cases
	- **Masking**: Use AND with bitmask to extract specific bits
	- **Setting flags**: Use OR to set specific bits to 1
	- **Toggling**: Use XOR to flip specific bits
	- **Packing data**: Use shifts and OR to combine multiple values
	- **Extracting fields**: Use shifts and AND to extract bit fields

	### Terminology
	- **Bitwise**: Operations that work on individual bits
	- **Mask**: Bit pattern used to select/clear specific bits
	- **Shift**: Moving bits left or right within a value
	- **Logical shift**: Shift that fills with zeros (vs arithmetic shift)
	`;
}

exports = {
	displayName: "Bitwise",
	defaultInstanceName: "Bitwise_",
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
			default: "and",
			getValue: (inst) => {
				if(inst["opCode"] == "LSL" || inst["opCode"] == "LSR")
                {
                    return "square";
                }
                if(inst["opCode"] == "AND")
				{
					return "and"
				}
				if(inst["opCode"] == "NOT")
				{
					return "not"
				}
				if(inst["opCode"] == "OR")
				{
					return "or"
				}
				return "xor"
			}
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
		{
			name: "opCode",
			displayName: "Bitwise Operation",
			options: [
            {
				name: "AND"
			},
            {
				name: "NOT"
			},
            {
				name: "OR"
			},
			{
				name: "XOR"
			},
			{
				name: "LSL"
			},
			{
				name: "LSR"
			}],
			default: "AND"
		},
		{
			name: "numOfInputPorts",
			default: 2,
			getValue: (inst) => {
				if(inst["opCode"] == "NOT")
                {
                    return 1;
                }
				return 2;
			},
			hidden: true
		},
		{
			name: "numOfOutputPorts",
			default: 1,
			hidden: true
		},
		{
			name: "output1Size",
			displayName: "Output1 Size",
			default: "maxOfInputs",
			options: [
				{
					name: "maxOfInputs",
					displayName: "Maximum of Inputs",
				},
				{
					name: "1",
					displayName: "One byte",
				},
				{
					name: "2",
					displayName: "two bytes",
				},
				{
					name: "4",
					displayName: "four bytes",
				}
			],
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			default: 1,
			readOnly: true
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
	getAIContext
}