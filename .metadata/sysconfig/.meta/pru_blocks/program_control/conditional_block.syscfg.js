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

function getLongDescription() {
		return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/program_control/conditional_block.md 

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