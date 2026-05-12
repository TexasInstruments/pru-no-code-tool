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

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Group block in a .syscfg file.

### Adding a Group Instance

\\\`\\\`\\\`javascript
const group_block = scripting.addModule("/pru_blocks/program_control/group_block", {}, false);
const group_block1 = group_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| groupName | String | Valid identifier (letters, numbers, underscore) | "" | Unique name for the group (becomes assembly label) |
| $size | Array | [width, height] | [500, 250] | Size of the group container in pixels |

### Naming Rules for groupName

- Must be a valid C identifier
- Can contain letters (a-z, A-Z), numbers (0-9), and underscore (_)
- Cannot start with a number
- Must be unique across all groups
- Recommended: Keep under 32 characters

### Example Configurations

**Create a group with blocks inside:**
\\\`\\\`\\\`javascript
group_block1.$name = "Group_0";
group_block1.groupName = "my_group";
group_block1.$size = [500, 320];
\\\`\\\`\\\`

### Adding Blocks Inside the Group

\\\`\\\`\\\`javascript
// Use $groupContents to specify which blocks are inside the group
group_block1.$groupContents = [load_constant_block3, load_constant_block4, conditional_block2, pru_gpo_block1, pru_gpo_block2];
\\\`\\\`\\\`

### Complete Example with Conditional Inside Group

\\\`\\\`\\\`javascript
// Create blocks
const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const load_constant_block3 = load_constant_block.addInstance();
const load_constant_block4 = load_constant_block.addInstance();

const conditional_block = scripting.addModule("/pru_blocks/program_control/conditional_block", {}, false);
const conditional_block2 = conditional_block.addInstance();

const pru_gpo_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpo_block", {}, false);
const pru_gpo_block1 = pru_gpo_block.addInstance();
const pru_gpo_block2 = pru_gpo_block.addInstance();

const group_block = scripting.addModule("/pru_blocks/program_control/group_block", {}, false);
const group_block1 = group_block.addInstance();

// Configure blocks
load_constant_block3.$name = "Load_Constant_2";
load_constant_block3.constant1 = 14;

load_constant_block4.$name = "Load_Constant_3";
load_constant_block4.constant1 = 15;

conditional_block2.$name = "If_Else_1";
conditional_block2.conditionToCheck = "lessThanEqualtoInput2";

pru_gpo_block1.$name = "PRU_GPO_0";
pru_gpo_block2.$name = "PRU_GPO_1";

// Configure group
group_block1.$name = "Group_0";
group_block1.groupName = "my_group";
group_block1.$size = [500, 320];

// Add blocks inside the group
group_block1.$groupContents = [load_constant_block3, load_constant_block4, conditional_block2, pru_gpo_block1, pru_gpo_block2];

// Connect blocks inside the group
scripting.connect(load_constant_block3, "output1", conditional_block2, "input1");
scripting.connect(load_constant_block4, "output1", conditional_block2, "input2");
scripting.connect(conditional_block2, "T", pru_gpo_block1, "prev");
scripting.connect(conditional_block2, "F", pru_gpo_block2, "prev");

// Set positions
group_block1.$position = [0, 150];
load_constant_block3.$position = [60, 40];
load_constant_block4.$position = [60, 105];
conditional_block2.$position = [210, 65];
pru_gpo_block1.$position = [360, 70];
pru_gpo_block2.$position = [370, 130];
\\\`\\\`\\\`

### Calling Groups from main.asm

\\\`\\\`\\\`asm
; In main.asm - declare and call the group
	.ref my_group_start         ; Reference the group's start label

main:
	CALL my_group_start         ; Execute all blocks in the group
	; Execution automatically returns here

	CALL my_group_start         ; Can call multiple times

	halt
\\\`\\\`\\\`

### Important Notes

1. **Container Block**: Group is a container - use $groupContents to add blocks inside.

2. **No Ports**: Group blocks have no input/output ports - they define code sections.

3. **Label Generation**: A group named "xyz" generates label "xyz_start" in assembly.

4. **Automatic Return**: Groups automatically add return instruction - no Flow Control needed.

5. **CALL Macro**: Use CALL (not JMP) to invoke groups so execution returns properly.

6. **Independent Execution**: Groups only execute when explicitly called from main.asm.

7. **Return Register**: The register allocator automatically allocates a register for the return address.

---

## Critical Pitfalls (AI Must Read)

### Pitfall 1: \`groupName\` is SEPARATE from \`$name\` — both must be set
The group block has two distinct name fields:
- \`$name\`: SysConfig instance identifier (e.g., "Group_0") — used internally by SysConfig
- \`groupName\`: generates the assembly label (e.g., "my_group" → \`my_group_start\`) — used in main.asm

Leaving \`groupName\` empty causes a **build error**: "Group name cannot be empty".
Always set both in the .syscfg file:
\\\`\\\`\\\`javascript
group_block1.$name     = "Group_0";
group_block1.groupName = "my_group";  // REQUIRED - do not omit
\\\`\\\`\\\`

### Pitfall 2: \`$groupContents\` CANNOT be set via \`changeConfiguration\` MCP tool
The \`changeConfiguration\` tool does not support \`$groupContents\`. It must be set by directly
editing the .syscfg file:
\\\`\\\`\\\`javascript
group_block1.$groupContents = [load_constant_block1, access_look_up_table1];
\\\`\\\`\\\`
After calling \`changeConfiguration\` and \`save\`, always re-read the .syscfg file to verify
\`$groupContents\` was written correctly and add it manually if missing.

### Pitfall 3: main.asm MUST \`.include "pru_syscfg.inc"\` to use CALL
\`CALL\` is a macro defined in \`pru_syscfg.inc\` (expands to \`JAL RET_ADDR0, func\`).
It is NOT a native PRU instruction. Without the include, the assembler errors with:
"[E0003] Invalid instruction: CALL".
Add this at the top of main.asm before any group calls:
\\\`\\\`\\\`asm
	.include    "pru_syscfg.inc"
	.ref        my_group_start
\\\`\\\`\\\`

### Pitfall 4: Register allocation SHIFTS when blocks move into a Group
The group return address uses \`R0.w0\` (low 16 bits = \`R0.b0\` + \`R0.b1\`).
To avoid collision, the allocator shifts data registers up (e.g., \`R0.b0\`/\`R0.b1\` → \`R0.b2\`/\`R0.b3\`).
**After any structural change** (adding/removing a group, moving blocks in/out):
1. Rebuild the project
2. Re-read the Register Allocation Summary in the generated \`pru_syscfg.asm\`
3. Update all \`SBBO\` / \`LBBO\` register references in main.asm accordingly
`;
}

function getLongDescription() {
	return `
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
    getAIContext: getAIContext,
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