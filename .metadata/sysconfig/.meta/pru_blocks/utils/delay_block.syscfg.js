function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)	
		}
	}	
}

/**
 * Returns the body of a specific macro based on the macro name with parameters replaced
 * @param {string} pruInstructionMacro - The macro instruction string that contains the macro name and parameters
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacro(pruInstructionMacro, opCode) {

    let macroBody = "";
    
    // Extract the macro name and parameters from the pruInstructionMacro
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode; // First part is the macro name
    const count = parts[1] || "count";
    
    if(pruInstructionMacro == "") {
        if (opCode === "nop") {
            return "";
        }
        macroBody = macroName + "	" + ".macro  " + count + "\n";
		// Add parameter documentation
		macroBody += `	; Parameters:
	;   count  - Number of PRU clock cycles to delay (wait time)
`;
    }

    if (macroName === "nop") {
        return "nop";
    }

    macroBody += `	loop    endloop?, ${count} - 1
	NOP
endloop?:`;

    if(pruInstructionMacro == "") {
        macroBody += "\n" + " .endm";	
    }
    
    return macroBody;
}

function getAIContext() {
    return getLongDescription() + `

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Delay block in a .syscfg file.

### Adding a Delay Instance

\\\`\\\`\\\`javascript
const delay_block = scripting.addModule("/pru_blocks/utils/delay_block", {}, false);
const delay1 = delay_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| delayCount | Integer | 1-255 | 1 | Number of PRU clock cycles to wait |

### Example Configurations

**Short delay (50ns at 200MHz):**
\\\`\\\`\\\`javascript
delay1.$name = "Delay_Short";
delay1.delayCount = 10;           // 10 cycles = 50ns
\\\`\\\`\\\`

**Medium delay (500ns at 200MHz):**
\\\`\\\`\\\`javascript
delay1.$name = "Delay_Medium";
delay1.delayCount = 100;          // 100 cycles = 500ns
\\\`\\\`\\\`

**Maximum single-block delay (1.275us at 200MHz):**
\\\`\\\`\\\`javascript
delay1.$name = "Delay_Max";
delay1.delayCount = 255;          // 255 cycles = 1.275us
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect control flow (Delay is a pass-through block)
scripting.connect(prev_block, "next", delay1, "prev");
scripting.connect(delay1, "next", next_block, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Maximum Delay**: Single Delay block limited to 255 cycles. Use Loop block for longer delays.

2. **Timing**: At 200MHz PRU clock, 1 cycle = 5ns. delayCount of 200 = 1 microsecond.

3. **Pass-through**: Delay block has no data ports - it only introduces timing delay in the control flow.

4. **Single Cycle Special Case**: When delayCount=1, generates single NOP instruction instead of loop.
`;
}

function getLongDescription() {
	return `
## Delay Block

### Purpose
Introduces a precise timing delay in PRU execution. Each delay count equals one PRU clock cycle.

### How It Works
1. **Set Delay**: Specify the number of PRU clock cycles to wait (1-255)
2. **Execute**: Generates a loop that executes NOP instructions for the specified duration
3. **Continue**: After delay completes, execution proceeds to the next block

### Configuration
- **PRU Clocks To Wait**: Number of cycles to delay (1-255)
- Each cycle = 5ns at 200MHz PRU clock
- Example: 200 cycles = 1 microsecond delay

### Timing Calculations
At 200MHz PRU clock (default on most TI devices):
- 1 cycle = 5 nanoseconds
- 200 cycles = 1 microsecond
- 200,000 cycles = 1 millisecond (requires multiple blocks)

**Examples**:
- 10 cycles = 50ns
- 100 cycles = 500ns
- 255 cycles (max) = 1.275 microseconds

### Technical Details (Additional Information)
**Generated Assembly**:
- loop endloop, count - 1    ; Setup loop counter (2 cycles overhead)
-     NOP                     ; No operation (count-1 times)
- endloop:                    ; Loop end label

**Total Cycles**: count + 2 (2 cycle overhead for loop setup)

### Usage Notes
- Maximum delay per block: 255 cycles (hardware limitation)
- Minimum delay is 1 cycle (+ 2 overhead = 3 total)
- This is a **pass-through block** - connects input to output without modification

### For Delays Greater Than 255 Cycles

Since the Delay block is limited to 255 cycles maximum, use the **Loop block** for longer delays:

**Method 1: Loop with single Delay block**

Loop (count: N) → Delay (255 cycles)

Total delay = N × 255 cycles
Example: Loop count 10 with Delay 255 = 2,550 cycles = 12.75μs @ 200MHz

**Method 2: Loop with multiple Delay blocks in sequence**

Loop (count: N) → Delay (255 cycles) → Delay (255 cycles) → Delay (100 cycles)

Total delay = N × (255 + 255 + 100) = N × 610 cycles
Example: Loop count 100 with 610 cycles = 61,000 cycles = 305μs @ 200MHz

**Method 3: Nested loops for very long delays**

Outer Loop (count: 1000)
└─ Inner Loop (count: 200)
	└─ Delay (255 cycles)

Total delay = 1000 × 200 × 255 = 51,000,000 cycles = 255ms @ 200MHz

**Delay Examples**:
- **10 microseconds**: Loop(40) → Delay(50) = 2,000 cycles
- **100 microseconds**: Loop(100) → Delay(200) = 20,000 cycles
- **1 millisecond**: Loop(200) → Loop(5) → Delay(200) = 200,000 cycles
- **10 milliseconds**: Loop(1000) → Loop(10) → Delay(200) = 2,000,000 cycles

**Important Notes**:
- Loop overhead adds 2-3 cycles per iteration
- For precise timing, account for loop setup overhead
- Inner loop body executes sequentially (prev to next connections)
- Use simulation to verify exact cycle counts

### Terminology
- **PRU Clock**: The clock signal driving PRU execution (typically 200MHz)
- **Cycle**: One tick of the PRU clock
- **NOP**: No Operation - instruction that does nothing but consume time
- **Loop overhead**: Extra cycles required for loop setup/teardown
- **Nested loops**: Loop block inside another Loop block for longer delays

---`;
}

exports = {
	displayName: "Delay",
	defaultInstanceName: "Delay_",
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
			name: "$topLabel",
			hidden: true,
            default: "",
		},
        {
            name: "constant1",
            hidden: true,
            default : "1",
            getValue: (inst) => {
				return inst["delayCount"] + ""
			},
        },
		{
			name: "delayCount",
			displayName: "PRU Clocks To Wait",
			default: 1,
            range: [1, 255],
		},
        {
			name: "opCode",
            displayName: "m_wait_cycles",
			default: "m_wait_cycles",
            getValue: (inst) => {
                if(inst["delayCount"] == 1)
                {
                    return "nop";
                }
				return "m_wait_cycles";
			},
			hidden: true
		},
		{
			name: "numOfInputPorts",
			default: 0,
			hidden: true
		},
        {
			name: "outputReg",
            default: "None",
			hidden: true
		},
		{
			name: "numOfConstants",
			default: 0,
			hidden: true,
            getValue: (inst) => {
                if(inst["delayCount"] == 1)
                {
                    return 0;
                }
				return 1;
			},
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
            default: 1,
			getValue: (inst) => {
				return inst["delayCount"];
			},
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
	getMacro
}
