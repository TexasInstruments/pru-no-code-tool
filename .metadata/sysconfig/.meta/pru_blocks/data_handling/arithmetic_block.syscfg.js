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

This section describes how to programmatically configure the Arithmetic block in a .syscfg file.

### Adding an Arithmetic Instance

\\\`\\\`\\\`javascript
const arithmetic_block = scripting.addModule("/pru_blocks/data_handling/arithmetic_block", {}, false);
const arith1 = arithmetic_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| opCode | String | "ADD", "ADC", "SUB", "SUC" | "ADC" | Math operation to perform |
| output1Size | String | "maxOfInputs", "1", "2", "4" | "maxOfInputs" | Output size in bytes |

### Valid Values for opCode

| Value | Display Name | Description |
|-------|--------------|-------------|
| "ADD" | Addition | result = input1 + input2 |
| "ADC" | Addition With Carry | result = input1 + input2 + carry |
| "SUB" | Subtract | result = input1 - input2 |
| "SUC" | Subtract With Borrow | result = input1 - input2 - borrow |

### Valid Values for output1Size

| Value | Display Name | Description |
|-------|--------------|-------------|
| "maxOfInputs" | Maximum of Inputs | Auto-size based on largest input |
| "1" | One byte | Force 8-bit result |
| "2" | two bytes | Force 16-bit result |
| "4" | four bytes | Force 32-bit result |

### Example Configurations

**Simple Addition:**
\\\`\\\`\\\`javascript
arith1.$name = "Add_Values";
arith1.opCode = "ADD";
arith1.output1Size = "maxOfInputs";
\\\`\\\`\\\`

**Subtraction with 32-bit output:**
\\\`\\\`\\\`javascript
arith1.$name = "Subtract_32bit";
arith1.opCode = "SUB";
arith1.output1Size = "4";
\\\`\\\`\\\`

**Addition with carry (for multi-precision):**
\\\`\\\`\\\`javascript
arith1.$name = "Add_With_Carry";
arith1.opCode = "ADC";
arith1.output1Size = "4";
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect two data sources to inputs
scripting.connect(load_constant1, "output1", arith1, "input1");
scripting.connect(load_constant2, "output1", arith1, "input2");

// Connect output to downstream block
scripting.connect(arith1, "output1", next_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", arith1, "prev");
scripting.connect(arith1, "next", next_block, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Two Inputs Required**: Both input1 and input2 must be connected.

2. **Carry/Borrow Flag**: ADC and SUC use the carry/borrow flag from previous arithmetic operations.

3. **Single Cycle**: All arithmetic operations complete in 1 PRU cycle.

4. **Overflow**: Results wrap around - no overflow detection.
`;

}

function getLongDescription() {
		return `
## Arithmetic Block

### Purpose
Performs mathematical operations on two input values and outputs the result. Supports addition and subtraction with optional carry/borrow handling.

### How It Works
1. **Connect Inputs**: Connect two data sources to input1 and input2
2. **Select Operation**: Choose the arithmetic operation (ADD, ADC, SUB, SUC)
3. **Execute**: Generates the corresponding PRU arithmetic instruction
4. **Output**: Provides the calculation result to the next block

### Available Operations

**ADDITION**
- Standard add operation: result = input1 + input2
- Ignores carry flag

**ADDITION_WITH_CARRY**
- Includes carry from previous operation: result = input1 + input2 + carry
- Useful for multi-precision arithmetic (adding numbers larger than 32 bits)

**SUBTRACT**
- Standard subtract: result = input1 - input2
- Ignores borrow flag

**SUBTRACT_WITH_BORROW** (note: displays as "SUBTRACT_WITH_BARROW" in UI)
- Includes borrow from previous operation: result = input1 - input2 - borrow
- Useful for multi-precision subtraction

### Configuration
- **Math Operation**: Select ADD, ADC, SUB, or SUC
- **Output Size**: Choose result size
- **Maximum of Inputs**: Auto-size based on largest input (recommended)
- **One byte**: Force 8-bit result
- **Two bytes**: Force 16-bit result
- **Four bytes**: Force 32-bit result

### Technical Details (Additional Information)
**Generated Assembly**:
- ADD result, input1, input2     ; Addition (1 cycle)
- ADC result, input1, input2     ; Addition with carry (1 cycle)
- SUB result, input1, input2     ; Subtraction (1 cycle)
- SUC result, input1, input2     ; Subtract with borrow (1 cycle)

**Performance**: 1 PRU cycle for all operations

### Carry/Borrow Flags
- PRU maintains a carry flag that is set/cleared by arithmetic operations
- ADC/SUC instructions use this flag for extended precision arithmetic
- Example: Adding two 64-bit numbers requires two ADC operations

### Usage Notes
- Both inputs must be connected
- Output size should accommodate the expected result range
- Overflow is not detected - wraps around modulo 2^(output_size)

### Terminology
- **Carry**: Overflow bit from addition, used in multi-word operations
- **Borrow**: Underflow bit from subtraction, used in multi-word operations
- **Multi-precision**: Arithmetic on numbers larger than register size
`;

}

exports = {
	displayName: "Arithmetic",
	defaultInstanceName: "Arithmetic_",
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
			default: "square",
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
		{
			name: "numOfInputPorts",
			default: 2,
			hidden: true
		},
		{
			name: "numOfOutputPorts",
			default: 1,
			hidden: true
		},
        {
			name: "opCode",
			displayName: "Math Operation",
			options: [
            {
				name: "ADC",
				displayName: "Addition With Carry",
			},
			{
				name: "ADD",
				displayName: "Addition",
			},
            {
				name: "SUC",
				displayName: "Subtract With Borrow",
			},
			{
				name: "SUB",
				displayName: "Subtract",
			}],
			default: "ADC"
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
	getAIContext
}