// normalize loop_block.accumulators to {pairs, error}. Accepts an
// array of {preInit, update} (or a JSON string of one); anything else is a
// validation error. Malformed entries are ignored by the register allocator;
// validate() below rejects them so a typo can never silently disable the
// accumulator.
function parseLoopAccumulators(value) {
	let list = value;
	if (list === undefined || list === null) return { pairs: [], error: null };
	if (typeof list === "string") {
		if (list.trim() === "") return { pairs: [], error: null };
		try {
			list = JSON.parse(list);
		} catch (e) {
			return { pairs: [], error: "is not valid JSON (" + e.message + ")" };
		}
	}
	if (!Array.isArray(list)) return { pairs: [], error: "must be an array of {preInit, update} objects" };
	const pairs = [];
	for (const entry of list) {
		if (!entry || typeof entry.preInit !== "string" || typeof entry.update !== "string") {
			return { pairs: [], error: "every entry must be a {preInit: \"<block>\", update: \"<block>\"} object" };
		}
		pairs.push({ preInit: entry.preInit, update: entry.update });
	}
	return { pairs: pairs, error: null };
}

function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}

	// Validate loop count - PRU LOOP instruction supports up to 16-bit counters (max 65535)
	if(inst["infiniteLoop"] === false && inst["loopCount"] > 65535)
	{
		report.logError("Loop count cannot exceed 65,535. Split the work into sequential finite loops; PRU hardware LOOP instructions cannot nest.", inst, "loopCount");
	}

	/*
	 * The PRU has one hardware LOOP context.  A LOOP emitted by a child
	 * overwrites its enclosing Loop's end address/counter, so the enclosing
	 * body falls out after its first pass.  Walk through Group containers as
	 * well: a Delay hidden in a Group is still emitted physically in this
	 * Loop's body.
	 *
	 * Only a finite Loop emits LOOP (an infinite one emits QBA), and children
	 * listed in preInitBlocks are hoisted ahead of the LOOP, so both are exempt.
	 *
	 * Keep this capability-based rather than a name/path check.  Delay marks
	 * itself below, and any future block that emits the hardware instruction
	 * can opt in with the same hidden configurable.
	 */
	function findNestedHardwareLoop(contents, seen, skipNames) {
		for (const child of (contents || [])) {
			if (!child || seen.indexOf(child) !== -1) continue;
			if (skipNames && skipNames.has(child.$name)) continue;
			seen.push(child);
			if (child.emitsHardwareLoop === true) return child;
			const nested = findNestedHardwareLoop(child.$groupContents, seen, skipNames);
			if (nested) return nested;
		}
		return null;
	}
	// An infinite Loop emits QBA, not LOOP, and preInitBlocks are hoisted out
	// of the body ahead of the LOOP, so neither can clobber the context.
	const nestedHardwareLoop = inst["infiniteLoop"] === false
		? findNestedHardwareLoop(inst.$groupContents, [], new Set(inst["preInitBlocks"] || []))
		: null;
	if (nestedHardwareLoop) {
		report.logError(
			`PRU hardware LOOP instructions cannot nest: ${nestedHardwareLoop.$name || "a block"} emits LOOP inside ${inst.$name || "this Loop"}. Move it outside the Loop or unroll the body.`,
			inst,
			"$groupContents");
	}

	// explicit accumulator bindings and exported result blocks.
	const memberNames = new Set(((inst.$groupContents) || []).map((b) => (b && b.$name)));
	for (const name of (inst.exportedBlocks || [])) {
		if (!memberNames.has(name)) {
			report.logError("Exported block '" + name + "' is not inside this loop. exportedBlocks must name blocks from this loop's contents.", inst, "exportedBlocks");
		}
	}
	const accumulators = parseLoopAccumulators(inst.accumulators);
	if (accumulators.error) {
		report.logError("Invalid accumulator bindings: " + accumulators.error + " Expected [{preInit: \"<block>\", update: \"<block>\"}].", inst, "accumulators");
	}
	for (const pair of accumulators.pairs) {
		if (!memberNames.has(pair.preInit)) {
			report.logError("Accumulator preInit block '" + pair.preInit + "' is not inside this loop.", inst, "accumulators");
		} else if (!((inst.preInitBlocks) || []).includes(pair.preInit)) {
			report.logError("Accumulator preInit block '" + pair.preInit + "' must also be listed in Pre-Initialization Blocks so its value is set once before the loop instead of on every iteration.", inst, "accumulators");
		}
		if (!memberNames.has(pair.update)) {
			report.logError("Accumulator update block '" + pair.update + "' is not inside this loop.", inst, "accumulators");
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
    return getLongDescription() + `
	
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Loop block in a .syscfg file.

### Adding a Loop Instance

\\\`\\\`\\\`javascript
const loop_block = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);
const loop_block1 = loop_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| infiniteLoop | Boolean | true, false | false | Enable infinite loop mode |
| loopCount | Integer | 1-65535 (0x1-0xFFFF) | 1 | Number of iterations (hidden if infiniteLoop=true) |
| preInitBlocks | Array | Block $name values inside loop | [] | Blocks to execute once before loop starts |
| exportedBlocks | Array | Block $name values inside loop | [] | Blocks whose final-iteration output may be read outside the loop |
| accumulators | String (JSON) | [{"preInit": "k", "update": "a"}] | "" | Accumulator bindings coalescing each update block with its preInit register |
| $size | Array | [width, height] | [500, 250] | Size of the loop container in pixels |

### Example Configurations

**Fixed count loop (100 iterations):**
\\\`\\\`\\\`javascript
loop_block1.$name = "Loop_0";
loop_block1.infiniteLoop = false;
loop_block1.loopCount = 100;
loop_block1.$size = [500, 290];
\\\`\\\`\\\`

**Infinite loop (runs forever):**
\\\`\\\`\\\`javascript
loop_block1.$name = "Main_Loop";
loop_block1.infiniteLoop = true;
// Note: loopCount is ignored when infiniteLoop is true
\\\`\\\`\\\`

**Loop with pre-initialization blocks:**
\\\`\\\`\\\`javascript
// Pre-init blocks execute ONCE before the loop starts, not on every iteration
loop_block1.$name = "Loop_0";
loop_block1.loopCount = 10;
loop_block1.preInitBlocks = ["If_Else_0", "Load_Constant_1", "PRU_GPI_0"];
\\\`\\\`\\\`

|**Loop-carried accumulator (repeat-add):**
\\\`\\\`\\\`javascript
// k_acc is set once before the loop; acc adds x into the SAME register each pass
loop_block1.$name = "Loop_0";
loop_block1.loopCount = 10;
loop_block1.$groupContents = [k_acc, acc];
loop_block1.preInitBlocks = ["k_acc"];
loop_block1.accumulators = "[{\\"preInit\\": \\"k_acc\\", \\"update\\": \\"acc\\"}]";
// The store sits AFTER the loop and reads the final sum
loop_block1.exportedBlocks = ["acc"];
scripting.connect(wr, "input1", acc, "output1");
scripting.connect(lp, "next", wr, "prev");
\\\`\\\`\\\`

### Adding Blocks Inside the Loop

\\\`\\\`\\\`javascript
// Use $groupContents to specify which blocks are inside the loop
loop_block1.$groupContents = [load_constant_block1, load_constant_block2, conditional_block1, pru_gpi_block1, pru_gpi_block2];
\\\`\\\`\\\`

### Complete Example with Conditional Inside Loop

\\\`\\\`\\\`javascript
// Create blocks
const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const load_constant_block1 = load_constant_block.addInstance();
const load_constant_block2 = load_constant_block.addInstance();

const conditional_block = scripting.addModule("/pru_blocks/program_control/conditional_block", {}, false);
const conditional_block1 = conditional_block.addInstance();

const pru_gpi_block = scripting.addModule("/pru_blocks/pru_io_blocks/pru_gpi_block", {}, false);
const pru_gpi_block1 = pru_gpi_block.addInstance();
const pru_gpi_block2 = pru_gpi_block.addInstance();

const loop_block = scripting.addModule("/pru_blocks/program_control/loop_block", {}, false);
const loop_block1 = loop_block.addInstance();

// Configure blocks
load_constant_block1.$name = "Load_Constant_0";
load_constant_block1.constant1 = 5;

load_constant_block2.$name = "Load_Constant_1";
load_constant_block2.constant1 = 10;

conditional_block1.$name = "If_Else_0";
conditional_block1.conditionToCheck = "notEqualToInput2";

pru_gpi_block1.$name = "PRU_GPI_0";
pru_gpi_block2.$name = "PRU_GPI_1";

// Configure loop with pre-init blocks
loop_block1.$name = "Loop_0";
loop_block1.loopCount = 1;
loop_block1.preInitBlocks = ["If_Else_0", "Load_Constant_1", "PRU_GPI_0"];
loop_block1.$size = [500, 290];

// Add blocks inside the loop
loop_block1.$groupContents = [load_constant_block1, load_constant_block2, conditional_block1, pru_gpi_block1, pru_gpi_block2];

// Connect blocks
scripting.connect(load_constant_block1, "output1", conditional_block1, "input1");
scripting.connect(load_constant_block2, "output1", conditional_block1, "input2");
scripting.connect(conditional_block1, "T", pru_gpi_block1, "prev");
scripting.connect(conditional_block1, "F", pru_gpi_block2, "prev");

// Set positions
loop_block1.$position = [0, 0];
load_constant_block1.$position = [105, 55];
load_constant_block2.$position = [105, 120];
conditional_block1.$position = [245, 70];
pru_gpi_block1.$position = [395, 65];
pru_gpi_block2.$position = [400, 130];
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect control flow into the loop
scripting.connect(prev_block, "next", loop_block1, "prev");

// Connect control flow out of the loop (only for non-infinite loops)
scripting.connect(loop_block1, "next", next_block, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Container Block**: Loop is a container - use $groupContents to add blocks inside.

2. **Max Iterations**: Maximum loop count is 65,535 (16-bit limit). For more work, use sequential finite loops or host scheduling; PRU hardware loops cannot nest.

3. **Infinite Loop**: When infiniteLoop=true, the next port is hidden and loop never exits.

4. **Pre-Initialization**: Use preInitBlocks with block $name values (as strings) for blocks that should execute once before the loop starts. Useful for initializing accumulators or one-time setup.

5. **Loop Overhead**: Fixed loops add 2-3 cycles overhead plus 2 cycles per iteration.

6. **No hardware-loop nesting**: A Loop body must not contain another hardware Loop or a Delay whose count is greater than one. SysConfig rejects this because the PRU has only one hardware LOOP context.
`;
}

function getLongDescription() {
	return `
## Loop Block (Repetition Control)

### Purpose
Repeats a sequence of blocks multiple times. This is a container block that executes all blocks inside it for a specified number of iterations or infinitely.

### How It Works
1. **Place Blocks Inside**: Drag and drop blocks into the LOOP container (the gray box)
2. **Configure Iterations**: Set loop count or enable infinite loop
3. **Execution**: All blocks inside the loop execute sequentially based on the next port to prev port connection.If prev and next port are disconnected then blocks execute based on their input dependency.
4. **Exit**: After all iterations complete, execution continues to blocks connected to the next port

### Configuration

**Infinite Loop**: Checkbox option
- **Unchecked** (default): Loop runs for specified count, then continues
- **Checked**: Loop runs forever - program stays in loop indefinitely
- Warning: Infinite loops never exit, so the next port is hidden
- Use with caution - ensure you want the PRU to loop forever

**Loop Count**: Number of iterations (1 to 65,535)
- Only visible when Infinite Loop is unchecked
- Determines how many times the loop body executes
- Range: 1 to 0xFFFF (16-bit, limited by PRU LOOP instruction)

**Pre-Initialization Blocks**: Multi-select dropdown
- Select blocks whose instructions should execute ONCE before the loop starts, not on every iteration
- Useful for initializing accumulators, counters, or one-time setup operations
- Selected blocks are still inside the loop visually, but their code is moved outside
- A pre-initialized value keeps its value on every iteration. It changes only in the accumulator pattern: the value is updated in place only when it has exactly ONE data reader, that reader is a single-instruction Arithmetic or Bitwise block, and the allocator places that block's result starting at the value's own register byte, so the result is stored back there and counts up each pass. In every other case (more than one reader, a different kind of reader, or a result placed anywhere else) the pre-initialized value stays constant for the whole loop.
- Declare that pattern explicitly with Accumulator Bindings (\`accumulators = "[{\\"preInit\\": \\"k_acc\\", \\"update\\": \\"acc\\"}]"\`): this is a declared, checked contract that requires the update to reuse the preInit register, so the update reads and writes the same register on every pass (for example \`ADD R0.w2, R0.w2, R0.w0\`) with zero extra cycles per iteration. The underlying single-reader coalescing is the same one used for pre-initialized values; the explicit binding additionally rejects invalid shapes loudly. The preInit block must also be listed in Pre-Initialization Blocks, both blocks must sit inside this loop, and the preInit value must have exactly one data reader (the update block); anything else is a build error, never a silent recompute.
- Let blocks after the loop read a final-iteration result with Exported Result Blocks (\`exportedBlocks = ["acc"]\`): a consumer downstream of the loop may read an exported block (for example a memory write storing the accumulated sum once, after the loop). A consumer outside the loop reading a block inside it that is NOT exported, or reading an export before the loop, is a validation error.

**Common Use Cases for Pre-Initialization**:
1. **Accumulator Pattern**: Initialize a variable to 0 before accumulating values across iterations
2. **Counter Initialization**: Set starting value for a counter that increments each iteration
3. **Configuration Setup**: One-time register or peripheral configuration before repeated operations

**Example - Sending Incrementing Values (0,1,2,3...) over SPI**:
- Load_Constant_0 (value 0) → Mark as pre-init (initial accumulator value)
- Load_Constant_1 (value 1) → Leave in loop (increment value)
- Arithmetic_0 (ADD) → Accumulates: result = result + 1
- SPI_Write → Sends accumulated value

Without pre-init: Sends 1,1,1,1,1... (accumulator resets to 0 each iteration)
With Load_Constant_0 as pre-init: Sends 1,2,3,4,5... (accumulator initialized once)

### Technical Details (Additional Information)

**Generated Assembly** (Fixed count loop without pre-init):
\`\`\`asm
; Initialize loop counter
LDI    loop_counter, loop_count      ; Load iteration count (1-2 cycles)
LOOP endloop_label, loop_counter     ; Hardware loop instruction
; ... blocks inside loop execute here ...
endloop_label:
; Continue after loop
\`\`\`

**Generated Assembly** (Fixed count loop WITH pre-init):
\`\`\`asm
; Pre-initialization blocks execute ONCE here (before loop)
LDI    R0.b1, 0                      ; Example: Initialize accumulator

; Initialize loop counter
LDI    loop_counter, loop_count      ; Load iteration count
LOOP endloop_label, loop_counter     ; Hardware loop instruction
; ... remaining blocks inside loop execute here ...
LDI    R0.b2, 1                      ; Example: Increment value
ADD    R0.b1, R0.b1, R0.b2           ; Accumulate: R0.b1 = R0.b1 + 1
endloop_label:
; Continue after loop (R0.b1 now contains accumulated result)
\`\`\`

**Generated Assembly** (Infinite loop):
\`\`\`asm
; Pre-initialization blocks (if any) execute ONCE here
startloop_label:
; ... blocks inside loop execute here ...
QBA    startloop_label               ; Unconditional jump back
; No code after this - never reached
\`\`\`

**Performance**:
- Fixed loop overhead: 2-3 cycles (counter initialization)
- Per-iteration overhead: 2 cycles (decrement + branch check)
- Infinite loop overhead: 1 cycle per iteration (unconditional jump)
- Total cycles = overhead + (loop_count × body_cycles)

**Loop Counter Register**: Automatically sized based on loop count
- 1-255: 1 byte register
- 256-65535: 2 byte register

### Container Block Behavior

**Visual Layout**:
- Loop block appears as a resizable gray box
- Drag blocks inside the loop boundary to include them
- Blocks inside execute in sequence from prev to next
- Default size: 500×250 pixels (can be resized)

**Block Order Inside Loop**:
Blocks execute in the order they are connected via prev/next ports within the loop container.

### Usage Notes
- Loop block is a **container** - place other blocks inside it
- All blocks inside the loop execute in sequence each iteration
- Use **Pre-Initialization Blocks** for one-time setup (accumulators, counters)
- Pre-init blocks are processed during code generation - their instructions move outside the loop automatically
- Register allocation/deallocation happens normally - pre-init just reorders the generated instructions
- Infinite loops are useful for continuous monitoring or periodic tasks
- Be careful with infinite loops - they never exit
- Loop counter uses a register - this register is reserved during loop execution
- PRU hardware loops cannot nest. Do not place a fixed-count Loop or a Delay (count > 1) in a fixed-count Loop body; unroll the body or split it into sequential loops. An infinite Loop compiles to a branch rather than LOOP, so it may contain either, and blocks listed in preInitBlocks run once before the LOOP and are exempt.
- Loop overhead is minimal (2-3 cycles setup, 2 cycles per iteration)

### Performance Calculation

**Formula**:
- Total cycles = Loop_overhead + (Loop_count × Body_cycles)

Where:
- Loop_overhead = 2-3 cycles (counter initialization)
- Body_cycles = sum of cycles for all blocks inside loop
- Loop_count = number of iterations

**Example**:
- Loop count: 100
- Body: Load Constant (1 cycle) + Delay(10) (10 cycles) = 11 cycles
- Total = 3 + (100 × 11) = 1103 cycles
- At 200MHz: 1103 × 5ns = 5.515 microseconds

### Terminology
- **Loop**: Programming construct that repeats a sequence of operations
- **Iteration**: One execution of the loop body
- **Loop counter**: Variable tracking how many iterations remain
- **Loop body**: The code/blocks executed each iteration
- **Infinite loop**: Loop that never terminates (runs forever)
- **Container block**: Block that contains other blocks (like a group)
- **Hardware-loop context**: PRU state used by the fixed-count \`LOOP\` instruction; only one is available, so fixed loops cannot nest
- **Loop overhead**: Extra cycles required for loop management

---`;
}

exports = {
	displayName: "Loop",
	defaultInstanceName: "Loop_",
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
			hidden : true
		},
		{
			name : "infiniteLoop",
			displayName : "Infinite Loop",
			default : false,
			onChange: (inst, ui) => {
				ui.loopCount.hidden = inst["infiniteLoop"]; 
			}
		},
		{
			name: "opCode",
			default: "loop",
            hidden : true
		},
		{
			// Consumed by an enclosing Loop.validate(). Infinite loops use QBA,
			// while finite loops consume the PRU's sole hardware LOOP context.
			name: "emitsHardwareLoop",
			default: true,
			hidden: true,
			getValue: (inst) => inst["infiniteLoop"] === false
		},
        {
            name : "loopCount",
			displayName: "Loop Count",
            default : 1,
			range: [0x1, 0xFFFF]
        },
		{
			name: "preInitBlocks",
			displayName: "Pre-Initialization Blocks",
			description: "Select blocks that should execute ONCE before the loop starts (not on every iteration). Useful for initializing accumulators.",
			default: [],
			minSelections: 0,
			options: (inst) => {
				// Return blocks that are inside this loop's $groupContents
				const groupContents = inst.$groupContents || [];
				return groupContents.map(blockInstance => ({
					name: blockInstance.$name,
					displayName: blockInstance.$name
				}));
			}
		},
		{
			name: "exportedBlocks",
			displayName: "Exported Result Blocks",
			description: "Blocks inside this loop whose final-iteration output may be read by blocks outside the loop (for example a memory write storing the accumulated sum once, after the loop). Without an entry here, a consumer outside the loop reading a block inside it is a container-boundary error.",
			default: [],
			minSelections: 0,
			options: (inst) => {
				// Return blocks that are inside this loop's $groupContents
				const groupContents = inst.$groupContents || [];
				return groupContents.map(blockInstance => ({
					name: blockInstance.$name,
					displayName: blockInstance.$name
				}));
			}
		},
		{
			name: "accumulators",
			displayName: "Accumulator Bindings",
			description: "Loop-carried accumulator bindings as a JSON string '[{\\\"preInit\\\": \\\"<block>\\\", \\\"update\\\": \\\"<block>\\\"}]': the update (Arithmetic/Bitwise) block's destination register is coalesced with its preInit block's register, so the update reads and writes the same register on every pass with zero extra cycles per iteration. The preInit block must also be listed in Pre-Initialization Blocks, both blocks must sit inside this loop, and the preInit value must have exactly one data reader (the update block).",
			default: "",
		},
        {
			name : "loopCountRegSize",
            default: 1,
			hidden: true,
            getValue: (inst) => {
				let bytes = getNumOfBytes(inst["loopCount"]);
				if(bytes == 3)
				{
					//storing in 4 continous bytes to number of instructions to access
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
				if(inst["infiniteLoop"] == false)
				{
					//2 for loading loop counter and 1 for loop instruction
					if(inst["loopCountRegSize"] == 4)
					{
						return 3;
					}
					return 2;
				}
				//when infinity block is connected return -1 as indicator of unknown cycle budget
				return -1;
			},
			default : 2,
			hidden : true
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
		if(inst["infiniteLoop"] == false)
		{
			ports.push({ name: "next", type: "NEXT"})
		}
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
