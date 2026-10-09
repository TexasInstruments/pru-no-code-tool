function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}
}



function getLongDescription() {
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/data_handling/bitwise_block.md 

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