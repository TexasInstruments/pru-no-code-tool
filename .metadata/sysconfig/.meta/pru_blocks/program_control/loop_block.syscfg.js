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
		report.logError("Loop count cannot exceed 65,535. Use nested Loop blocks for higher iteration counts.", inst, "loopCount");
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
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/program_control/loop_block.md 

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

*** For finite loop ***
- Initialize loop counter : 1 cycle
- Fixed loop overhead: 1 cycle (counter initialization)
- Total cycles = 2 cycles + (loop_count × body_cycles)

*** For infinite loop ***
- 1 cycle overhead per iteration

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
- Nested loops are possible (place a LOOP block inside another LOOP block)
- Loop overhead is minimal (2-3 cycles setup, 2 cycles per iteration). Note: loop blocks do not emit a end label; break out via Flow Control (jump to next block or sysconfig_generated_end).

### Performance Calculation

**Formula**:
- Total cycles = Loop_overhead + (Loop_count × Body_cycles)

Where:
- Loop_overhead = 2-3 cycles (counter initialization + LOOP instruction; 3 for 4-byte counter)
- Body_cycles = sum of cycles for all blocks inside loop
- Loop_count = number of iterations

**Example**:
- Loop count: 100
- Body: Load Constant (1 cycle) + Delay(10) (10 cycles) = 11 cycles
- Total = 2 + (100 × 11) = 1102 cycles
- At 200MHz: 1103 × 5ns = 5.510 microseconds

### Terminology
- **Loop**: Programming construct that repeats a sequence of operations
- **Iteration**: One execution of the loop body
- **Loop counter**: Variable tracking how many iterations remain
- **Loop body**: The code/blocks executed each iteration
- **Infinite loop**: Loop that never terminates (runs forever)
- **Container block**: Block that contains other blocks (like a group)
- **Nested loop**: Loop inside another loop
- **Loop overhead**: Extra cycles required for loop management

---`;
}

exports = {
	displayName: "Loop",
	defaultInstanceName: "Loop_",
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