function validate(inst, report) {
	// Validate that group name is non-empty
	if (!inst.groupName || inst.groupName.trim() === "") {
		report.logError("Group name cannot be empty", inst);
	}

	// Validate that group name is a valid identifier (alphanumeric + underscore)
	if (inst.groupName && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inst.groupName)) {
		report.logError("Group name must be a valid identifier (letters, numbers, underscore only, cannot start with number)", inst);
	}

	// Validate no duplicate group names
	const groupModule = system.modules["/pru_blocks/program_control/group_block"];
	if (groupModule && groupModule.$instances) {
		const duplicates = groupModule.$instances.filter(other =>
			other !== inst && other.groupName && inst.groupName && other.groupName === inst.groupName
		);
		if (duplicates.length > 0) {
			report.logError(`Group name "${inst.groupName}" is already used by another group`, inst);
		}
	}

	// Warn if group is empty
	if (!inst.$groupContents || inst.$groupContents.length === 0) {
		report.logWarning("Group is empty - no blocks inside. Drag blocks into this group container to add them.", inst);
	}

	// Warn if group name is very long
	if (inst.groupName && inst.groupName.length > 32) {
		report.logWarning("Group name is very long - consider shortening for readability", inst);
	}
}



function getLongDescription() {
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/program_control/group_block.md 

## Group Block (Code Organization Container)

### Purpose
The Group Block allows you to organize related blocks into named, reusable sections that can be selectively executed from your main.asm firmware. This enables modular code organization where you have full control over which functionality executes and when.

### Key Concept
Instead of all blocks executing sequentially in one flow, you can:
- **Group related functionality** together (e.g., ADC config, sensor initialization, data processing)
- **Execute groups selectively** by calling them from main.asm only when needed
- **Keep ungrouped blocks** in the default execution path (\`sysconfig_generated_start/end\`)

---

## How To Use Group Blocks

### Step 1: Create a Group Block
1. Add a **Group Block** from the program control palette
2. Give it a **meaningful name** (e.g., "adc_config", "sensor_init", "data_process")
- Must be a valid identifier (letters, numbers, underscore only)
- Cannot start with a number
- Must be unique across all groups

### Step 2: Add Blocks Inside the Group
1. **Drag blocks** into the gray group container box
2. Connect blocks inside using their input/output/prev/next ports (same as normal)
3. The group acts as a visual container - all blocks inside will execute together when the group is called

### Step 3: Call Groups from main.asm
Simply use the CALL macro to invoke groups - execution automatically continues after the call.

**Example for a group named "ABC":**

\`\`\`asm
; In main.asm - declare the group start label
	.ref ABC_start          ; Reference the start label (defined in pru_syscfg.asm)

main:
	; Your initialization code...

	; Call the ABC group - execution automatically returns here
	CALL ABC_start
	; No label needed! Execution continues here automatically

	; You can call the same group multiple times
	CALL ABC_start
	; Returns here again

	halt
\`\`\`

**Important:**
- Use the CALL macro (defined in pru_syscfg.inc) instead of JAL directly
- Execution automatically returns to the next instruction after CALL
- No need to define end labels manually
- Groups can be called multiple times from anywhere in main.asm
- The CALL macro uses R27.w0 as the return address register


## Technical Details

### Generated Labels
For a group named "my_group":
- **Start label**: \`my_group_start\` (declared as \`.global\` in pru_syscfg.asm)
- **No end label needed** - RET instruction automatically returns to caller

### CALL/RET Pattern
Groups use standard subroutine calling convention:
- **CALL macro**: Uses JAL (Jump And Link) to save return address and jump to group
- **RET instruction**: Returns to the saved address
- **Return address register**: R27.w0 (RET_ADDR0)
- **Automatic return**: No manual label management required

### Execution Flow
1. **Ungrouped blocks** are processed first and appear in the \`sysconfig_generated_start\` section
2. **Grouped blocks** are processed separately and appear AFTER the default section
3. Groups only execute when you explicitly call them from main.asm
4. Each group **automatically generates** a return instruction (\`JMP RET_ADDR0\`) at the end

### Processing Order Inside Groups
Blocks inside groups follow the same execution order rules:
- **End blocks** (blocks with no output/next/T/F ports) process first
- **Unconnected next** blocks process second
- **Result nodes** (unconnected output ports) process third
- Data dependencies via input ports ensure correct evaluation order

### Container Features
- **Resizable**: Default 500×250 pixels, drag corners to resize
- **Visual organization**: Gray box clearly shows which blocks belong to the group
- **Drag-and-drop**: Simply drag blocks into/out of the container
- **Nesting support**: Can contain Loop blocks, or be nested in other groups

---

## Important Notes

### Automatic Return Generation
Groups automatically generate a return instruction at the end:
- No Flow Control block required
- Return instruction (\`JMP RET_ADDR0\`) is automatically added
- Execution returns to the instruction after CALL
- Optional: You can still add Flow Control blocks inside groups for conditional exits or HALT

### Ungrouped vs Grouped Blocks
- **Ungrouped blocks**: Execute automatically when you call \`sysconfig_generated_start\`
- **Grouped blocks**: Only execute when you explicitly call their start label
- Choose wisely what goes where based on your program flow

### Label Naming
- Group names become assembly labels
- Use descriptive names: "adc_config" not "group1"
- Keep names concise (< 32 characters recommended)
- Follow C identifier rules (no spaces, no special chars except underscore)

### Groups are Independent
- Groups don't automatically call each other
- Each group is a standalone code section
- You control the execution order from main.asm
- This gives you maximum flexibility

---

## Comparison: Grouped vs Ungrouped

| Feature | Ungrouped Blocks | Grouped Blocks |
|---------|------------------|----------------|
| Execution | Auto (when calling sysconfig_generated_start) | Manual (when you call group_start) |
| Use case | Initialization, always-needed code | Optional, conditional, or repeated functionality |
| Labels | sysconfig_generated_start/end | \`groupName\`_start (only) |
| Return Handling | JMP to sysconfig_generated_end | Automatic JMP RET_ADDR0 generated |
| Flexibility | Executes every time | Execute only when called |

---`;
}

exports = {
	displayName: "Group",
	defaultInstanceName: "Group_",
	longDescription: getLongDescription(),
	uiView: "graph",
	templates: {
		"/pru_blocks/common/pru_syscfg.asm.xdt": null
	},
	config: [
		{
			name: "$shape",
			hidden: true,
			default: "group",
		},
		{
			name: "$topLabel",
			hidden: true,
			default: "",
		},
		{
			name: "$size",
			default: [500, 250],
		},
		{
			name: "$groupContents",
			options: (inst) => _.chain(system.modules)
				.flatMap((mod) => mod.$instances)
				.without(inst)
				.value(),
			isArray: true,
			hidden: true
		},
		{
			name: "groupName",
			displayName: "Group Name",
			description: "Unique identifier for this group (used to generate labels)",
			default: "",
			placeholder: "e.g., adc_config, sensor_init, data_process",
		},
		{
			name: "opCode",
			default: "group",
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
			default: 0,
			hidden: true
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				// Group container itself has no cycle overhead
				// Cycles determined by blocks inside
				return 0;
			},
			default: 0,
			hidden: true
		}
	],
	ports: (inst) => {
		let ports = [];
		// As Groups are printed separately, the sequencing is not supported
		// so removing ports for group block
		return ports;
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