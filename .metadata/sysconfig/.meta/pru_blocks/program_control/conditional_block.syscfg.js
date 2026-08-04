const FLOW_CONTROL_MODULE = "/pru_blocks/program_control/flow_control_block";
const CONDITIONAL_MODULE = "/pru_blocks/program_control/conditional_block";

/**
 * Walks forward from a T/F branch head via BOTH "next" (control flow) and
 * "output1" (data flow fanout) connections — matching the reachability
 * model already used elsewhere for branch chains (collectBranchChain in
 * pru_register_allocator.js) and cycle detection (detectControlFlowCycle
 * in pru_blocks_static_module.syscfg.js). A branch head with no outgoing
 * "next" of its own can still be "handled" if a data consumer of its
 * output eventually reaches a Flow Control block via ITS OWN "next" chain
 * (e.g. Memory_Access -> Arithmetic.input1 (data) -> Arithmetic.next ->
 * Flow Control). Only a genuine dead end (no next, no output1 consumers,
 * and not a Flow Control block itself) on every reachable path is an error.
 * If the chain reaches a nested conditional block, both of ITS T and F
 * branches must recursively terminate the same way.
 * Returns an error message, or null if the branch terminates correctly.
 */
function branchTerminates(headInst, ownerName, branchLabel) {
	const visited = new Set();

	function walk(current) {
		if (!current || !current.$name || visited.has(current.$name)) {
			return true; // Already visited (or a cycle, reported separately) — treat as handled
		}
		visited.add(current.$name);

		// $module is a live object reference on the instance; round-trip
		// through JSON to get the plain module path string for comparison
		// (matches the pattern used elsewhere in this codebase, e.g.
		// crc_block.syscfg.js).
		const currentModulePath = JSON.parse(JSON.stringify(current)).$module;

		if (currentModulePath === FLOW_CONTROL_MODULE) {
			return true; // This path terminates correctly
		}

		if (currentModulePath === CONDITIONAL_MODULE) {
			const trueHead = current.T?.[0]?.inst;
			const falseHead = current.F?.[0]?.inst;
			if (!trueHead || !falseHead) {
				// Nested conditional with an unconnected branch is caught by
				// its own validate() call; don't double-report here.
				return true;
			}
			// Both of the nested conditional's own branches must terminate.
			return walk(trueHead) && walk(falseHead);
		}

		const nextInst = current.next?.[0]?.inst;
		const outputConsumers = current.output1 ? current.output1.map(c => c?.inst).filter(Boolean) : [];

		if (!nextInst && outputConsumers.length === 0) {
			return false; // Genuine dead end, never reached a Flow Control block
		}

		let handled = false;
		if (nextInst) {
			handled = walk(nextInst) || handled;
		}
		for (const consumer of outputConsumers) {
			handled = walk(consumer) || handled;
		}
		return handled;
	}

	const terminatesOk = walk(headInst);
	if (terminatesOk) {
		return null;
	}
	return `${ownerName}'s ${branchLabel} branch does not reach a Flow Control block on any path. Without one, execution falls through into the other branch. Add a Flow Control block at the end of this branch (directly, or via a data-consuming block's own control-flow chain).`;
}

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

	// Any branch that IS connected must terminate in a Flow Control block,
	// otherwise it falls through into the other branch's code.
	const trueHead = inst.T?.[0]?.inst;
	if (trueHead) {
		const err = branchTerminates(trueHead, inst.$name, "T");
		if (err) {
			report.logError(err, inst, "T");
		}
	}
	const falseHead = inst.F?.[0]?.inst;
	if (falseHead) {
		const err = branchTerminates(falseHead, inst.$name, "F");
		if (err) {
			report.logError(err, inst, "F");
		}
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

// REQUIRED: both true_path_block's and false_path_block's chains must each
// end in a Flow Control block, or validation fails. Example (standalone
// If/Else, NOT inside a Loop block):
const flow_control_block = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
const flow_true = flow_control_block.addInstance();
flow_true.$name = "Flow_Control_True_End";
flow_true.jumpTarget = "JMP"; // or "HALT", or any real "<blockName>_start"/"_end" target to jump elsewhere
scripting.connect(true_path_block, "next", flow_true, "prev");

const flow_false = flow_control_block.addInstance();
flow_false.$name = "Flow_Control_False_End";
flow_false.jumpTarget = "JMP";
scripting.connect(false_path_block, "next", flow_false, "prev");
\\\`\\\`\\\`

**If the If/Else block is inside a Loop block's \\\`$groupContents\\\`**, "JMP"/"HALT" would exit the loop
entirely (or halt the PRU) instead of continuing the loop — jump to the loop's own \\\`_start\\\`
target instead so the loop keeps iterating:
\\\`\\\`\\\`javascript
// if_else1 is one of the instances inside loop_block1.$groupContents
const flow_true = flow_control_block.addInstance();
flow_true.$name = "Flow_Control_True_End";
flow_true.jumpTarget = "Loop_0_start"; // matches loop_block1.$name + "_start" — continues the loop
scripting.connect(true_path_block, "next", flow_true, "prev");

const flow_false = flow_control_block.addInstance();
flow_false.$name = "Flow_Control_False_End";
flow_false.jumpTarget = "Loop_0_start";
scripting.connect(false_path_block, "next", flow_false, "prev");
\\\`\\\`\\\`
Jumping to the loop's \\\`_start\\\` (not the loop's \\\`_end\\\`) is what resumes normal looping — \\\`_end\\\`
is the dedicated early-exit/break target, for when you want to abandon the loop instead of continuing it.

### Important Notes

1. **Two Inputs Required**: Both input1 and input2 must be connected for comparison.

2. **Two Output Paths**: Connect blocks to both T (true) and F (false) ports.

3. **Unsigned Comparison**: All comparisons treat values as unsigned integers.

4. **Single Cycle**: Comparison and branch decision execute in 1 PRU cycle.

5. **Port Names**: True path uses "T" port, False path uses "F" port (displayed as t_next/f_next).

6. **Every Connected Branch MUST Terminate in a Flow Control Block**: The code generator places the FALSE path immediately after the branch instruction, with the TRUE path at the branch target label. If a connected branch (T or F) has no explicit terminator, execution falls through into the other branch — causing both to execute regardless of the condition. This is now enforced by SysConfig validation (an error, not a warning) — any connected T or F branch that doesn't end in a Flow Control block will fail validation. A branch left entirely unconnected is still fine (nothing happens on that path).

7. **Where the Flow Control Block Should Jump To Depends On Context**:
   - **Standalone If/Else** (not inside a Loop block): jump to \\\`JMP\\\` (SysConfig Generated End), \\\`HALT\\\`, or any other block's \\\`_start\\\`/\\\`_end\\\` target.
   - **If/Else nested inside a Loop block**: jump to that Loop's own \\\`<LoopName>_start\\\` target, so execution resumes the loop instead of exiting it. Using \\\`JMP\\\`/\\\`HALT\\\` here ends the whole program early instead of continuing the loop — only do that if that's actually the intent (e.g. an early-exit condition that should stop everything, not just this iteration). To break out of the loop early without ending the whole program, jump to the Loop's \\\`<LoopName>_end\\\` target instead.
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
- FalseBranchHead_start:
- QBGT If_Else_0_TRUE, input1_reg, input2_reg   ; Branch if input1 > input2 (1 cycle)
- ; FALSE path code here
- ; FALSE branch MUST end in a Flow Control block (e.g. JMP sysconfig_generated_end)
- If_Else_0_TRUE:
- TrueBranchHead_start:
- ; TRUE path code here
- ; TRUE branch MUST end in a Flow Control block

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
- **Any connected branch (T or F) MUST terminate in a Flow Control block**: The FALSE path falls through to the TRUE path in the generated assembly unless explicitly stopped, and vice versa. SysConfig validation now enforces this as an error — connect a Flow Control block at the end of every connected branch. Leaving a branch entirely unconnected is fine; only connected-but-unterminated branches are rejected.
- **What that Flow Control block should jump to depends on where the If/Else block lives**:
  - **Standalone If/Else** (not inside a Loop block): jump to Sysconfig Generated End, Halt, or any other block's \`_start\`/\`_end\` target.
  - **If/Else nested inside a Loop block**: jump to that Loop's \`<LoopName>_start\` target so execution resumes the loop instead of exiting the whole program. Jumping to Sysconfig Generated End or Halt from inside a loop's branch ends the entire program early rather than just this iteration — only intentional if that's really the goal. To break out of the loop early (without ending the whole program), jump to the Loop's \`<LoopName>_end\` target instead.
- Every block, including this one and every block on either branch, has an addressable \`<blockName>_start\` entry point that a Flow Control block elsewhere in the design can jump to (e.g. to re-run this comparison, or to re-enter a Loop block from inside a branch).

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