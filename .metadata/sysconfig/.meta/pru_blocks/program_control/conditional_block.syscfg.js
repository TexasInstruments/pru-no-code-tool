function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)	
		}
	}	
	//verifying if true port is connected true/false port(conditional input) are not
	if((inst["T"].length == 0))
	{
		report.logWarning("t_next port is not connected",inst);
	}
	//verifying if false port is connected true/false port(conditional input) are not
	if((inst["F"].length == 0))
	{
		report.logWarning("f_next port is not connected",inst);
	}
}

function getAIContext() {
    return getLongDescription() + `
	
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the If/Else (Conditional) block in a .syscfg file.

### Adding an If/Else Instance

\\\`\\\`\\\`javascript
const conditional_block = scripting.addModule("/pru_blocks/program_control/conditional_block", {}, false);
const if_else1 = conditional_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| conditionToCheck | String | See table below | "greaterThanInput2" | Comparison operation |

### Valid Values for conditionToCheck

| Value | Display Name | PRU Instruction | Description |
|-------|--------------|-----------------|-------------|
| "greaterThanInput2" | Greater Than Input2 | QBGT | input1 > input2 |
| "lessThanInput2" | Less Than Input2 | QBLT | input1 < input2 |
| "equalToInput2" | Equal To Input2 | QBEQ | input1 == input2 |
| "notEqualToInput2" | Not Equal To Input2 | QBNE | input1 != input2 |
| "greaterThanEqualtoInput2" | Greater Than Or Equal To Input2 | QBGE | input1 >= input2 |
| "lessThanEqualtoInput2" | Less Than Or Equal To Input2 | QBLE | input1 <= input2 |

### Example Configurations

**Check if value is greater than threshold:**
\\\`\\\`\\\`javascript
if_else1.$name = "Check_Threshold";
if_else1.conditionToCheck = "greaterThanInput2";
\\\`\\\`\\\`

**Check for equality:**
\\\`\\\`\\\`javascript
if_else1.$name = "Check_Equal";
if_else1.conditionToCheck = "equalToInput2";
\\\`\\\`\\\`

**Check if not zero:**
\\\`\\\`\\\`javascript
if_else1.$name = "Check_Not_Zero";
if_else1.conditionToCheck = "notEqualToInput2";
// Connect input1 to value, input2 to Load_Constant with value 0
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect comparison inputs
scripting.connect(value_block, "output1", if_else1, "input1");
scripting.connect(threshold_block, "output1", if_else1, "input2");

// Connect true path (executes when condition is TRUE)
scripting.connect(if_else1, "T", true_path_block, "prev");

// Connect false path (executes when condition is FALSE)
scripting.connect(if_else1, "F", false_path_block, "prev");

// Connect control flow input
scripting.connect(prev_block, "next", if_else1, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Two Inputs Required**: Both input1 and input2 must be connected for comparison.

2. **Two Output Paths**: Connect blocks to both T (true) and F (false) ports.

3. **Unsigned Comparison**: All comparisons treat values as unsigned integers.

4. **Single Cycle**: Comparison and branch decision execute in 1 PRU cycle.

5. **Port Names**: True path uses "T" port, False path uses "F" port (displayed as t_next/f_next).

6. **Terminate Each Branch with a Flow Control Block**: The code generator places the FALSE path immediately after the branch instruction, with the TRUE path at the branch target label. If the FALSE path has no explicit terminator, execution falls through into the TRUE path — causing both branches to execute regardless of the condition. Always end each branch (T and F) with a Flow Control block (HALT or END) to prevent this fall-through.
`;
}

function getLongDescription() {
		return `
## If/Else Block (Conditional Branching)

### Purpose
Implements conditional logic (IF/ELSE statements) to control program flow based on comparing two input values. Directs execution to different paths depending on whether the condition is true or false.

### How It Works
1. **Input 1**: First value to compare
2. **Input 2**: Second value to compare
3. **Condition**: Select comparison operation (>, <, ==, !=, >=, <=)
4. **Branching**:
- If condition is TRUE → executes blocks connected to **t_next** port
- If condition is FALSE → executes blocks connected to **f_next** port

### Configuration

**Condition To Check**: Select the comparison operation
- **Greater Than Input2**: Input1 > Input2
- **Less Than Input2**: Input1 < Input2
- **Equal To Input2**: Input1 == Input2
- **Not Equal To Input2**: Input1 != Input2
- **Greater Than Or Equal To Input2**: Input1 >= Input2
- **Less Than Or Equal To Input2**: Input1 <= Input2

### Technical Details (Additional Information)

**Generated Assembly**:
- ; Example: Greater Than Input2 (QBGT)
- QBGT TRUE_LABEL, input1_reg, input2_reg   ; Branch if input1 > input2 (1 cycle)
- ; FALSE path code here
- QBA  END_LABEL                             ; Jump to end
- TRUE_LABEL:
- ; TRUE path code here
- END_LABEL:

**PRU Branch Instructions**:
- **QBGT**: Quick Branch if Greater Than (unsigned comparison)
- **QBLT**: Quick Branch if Less Than (unsigned comparison)
- **QBEQ**: Quick Branch if Equal
- **QBNE**: Quick Branch if Not Equal
- **QBGE**: Quick Branch if Greater than or Equal
- **QBLE**: Quick Branch if Less than or Equal

**Performance**: 1 PRU cycle for the comparison and branch decision

**Comparison Type**: All comparisons are **unsigned** integer comparisons
- Treats values as unsigned (0 to 255 for bytes, 0 to 65535 for shorts, etc.)
- Negative numbers are not supported in standard mode

### Connection Ports

**Input Ports**:
- **input1**: First comparison value
- **input2**: Second comparison value

**Output Ports**:
- **t_next** (true next): Connect blocks to execute when condition is TRUE
- **f_next** (false next): Connect blocks to execute when condition is FALSE

### Usage Notes
- Both input ports must be connected for conditional operation
- Both t_next and f_next ports should be connected to avoid warnings
- Comparisons are unsigned - values treated as positive integers
- The conditional check happens instantly (1 cycle)
- Code on both branches is generated, only one path executes at runtime
- This block does not produce an output value - it only controls flow
- **Always terminate each branch (T and F) with a Flow Control block**: The FALSE path falls through to the TRUE path in the generated assembly unless explicitly stopped. Without a terminator on the FALSE branch, both branches execute sequentially regardless of the condition result.

### Terminology
- **Conditional branching**: Changing program flow based on a condition
- **IF/ELSE**: Fundamental programming construct for decisions
- **Branch instruction**: Assembly instruction that jumps to different code location
- **Quick Branch (QB)**: PRU's fast comparison and branch instructions
- **Unsigned comparison**: Treating all values as positive (0 to max)
- **Label**: Named location in assembly code for branching target
- **Control flow**: Order in which instructions execute
- **t_next/f_next**: True next and False next - execution paths after condition

---`;
}

exports = {
	displayName: "If/Else",
	defaultInstanceName: "If_Else_",
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
			name: "opCode",
			default: "LDI",
			hidden: true,
			getValue: (inst) => {
				if(inst["conditionToCheck"] == "greaterThanInput2")
				{
					return "QBGT";
				}
				if(inst["conditionToCheck"] == "lessThanInput2")
				{
					return "QBLT";
				}
				if(inst["conditionToCheck"] == "equalToInput2")
				{
					return "QBEQ";
				}
				if(inst["conditionToCheck"] == "notEqualToInput2")
				{
					return "QBNE";
				}
				if(inst["conditionToCheck"] == "greaterThanEqualtoInput2")
				{
					return "QBGE";
				}
				if(inst["conditionToCheck"] == "lessThanEqualtoInput2")
				{
					return "QBLE";
				}
			},
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
		{
			name: "numOfInputPorts",
			default: 2,
			hidden: true,
			getValue: (inst) => {
				if(inst["conditionToCheck"] != "branchAlways")
				{
					return 2;
				}
				return 0;
			},
		},
		{
			name: "numOfOutputPorts",
			default: 1,
			hidden: true
		},
        {
			name: "conditionToCheck",
			displayName: "Condition To Check",
			options: [
            {
				name: "greaterThanInput2",
				displayName: "Greater Than Input2",
			},
			{
				name: "lessThanInput2",
				displayName: "Less Than Input2",
			},
            {
				name: "equalToInput2",
				displayName: "Equal To Input2",
			},
			{
				name: "notEqualToInput2",
				displayName: "Not Equal To Input2",
			},
			{
				name: "greaterThanEqualtoInput2",
				displayName: "Greater Than Or Equal To Input2"
			},
			{
				name: "lessThanEqualtoInput2",
				displayName: "Less Than Or Equal To Input2"
			}],
			default: "greaterThanInput2"
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			default: 1,
			readOnly: true
		},
	],
	ports: (inst) => { 
		let ports = [];
		for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
		{
			ports.push({ name: "input"+iterator.toString(), type: "input32" })
		}
		ports.push({ name: "T",displayName: "t_next", type: "CONDITIONAL_NEXT"})
		ports.push({ name: "F",displayName: "f_next", type: "CONDITIONAL_NEXT"})
		ports.push({ name: "prev", type: "CONDITIONAL_PREV" })
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