function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}
}

function getAIContext() {
    return getLongDescription() + `

	## How to Configure (For AI/Scripting)
	
	This section describes how to programmatically configure the Flow Control block in a .syscfg file.
	
	### Adding a Flow Control Instance
	
	\\\`\\\`\\\`javascript
	const flow_control_block = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
	const flow1 = flow_control_block.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| opCode | String | "JMP", "HALT" | "JMP" | Jump target: end of generated code or halt |
	
	### Valid Values for opCode
	
	| Value | Display Name | Description |
	|-------|--------------|-------------|
	| "JMP" | Sysconfig Generated End | Jump to end label of generated code |
	| "HALT" | Halt | Immediately stop PRU execution |
	
	### Example Configurations
	
	**Jump to end (normal exit):**
	\\\`\\\`\\\`javascript
	flow1.$name = "Flow_Control_End";
	flow1.opCode = "JMP";
	\\\`\\\`\\\`
	
	**Halt PRU immediately:**
	\\\`\\\`\\\`javascript
	flow1.$name = "Flow_Control_Halt";
	flow1.opCode = "HALT";
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// Flow Control is a terminating block - only has prev port, no next
	scripting.connect(prev_block, "next", flow1, "prev");
	
	// Often used after conditional block's true or false path
	scripting.connect(if_else1, "T", flow1, "prev");  // Exit on true condition
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Terminating Block**: Flow Control has no output ports - it ends the execution path.
	
	2. **No Next Port**: Cannot connect anything to this block's output - execution ends here.
	
	3. **JMP vs HALT**: Use JMP for normal exits (allows cleanup code), HALT for immediate stops.
	
	4. **Single Cycle**: Both JMP and HALT execute in 1 PRU cycle.
	`;
}

function getLongDescription() {
	return `
	## Flow Control Block

	### Purpose
	Controls PRU program flow by either jumping to the end of generated code or halting the PRU.

	### How It Works
	1. **Place in Flow**: Position this block where you want to control program flow
	2. **Select Jump Target**: Choose between END or HALT
	3. **Execution**: When reached, performs the selected jump
	4. **No Output**: This is a **terminating block** - no next connections

	### Configuration

	**Jump To**: Select where the program should jump

	**Option 1: Sysconfig Generated End**
	- Jumps to the end label of the SysConfig-generated code
	- Allows any cleanup code or epilogue to execute
	- Recommended for normal program completion
	- Generated instruction: JMP sysconfig_generated_end

	**Option 2: Halt**
	- Immediately stops the PRU execution
	- Puts PRU into halt state
	- No cleanup or epilogue runs
	- Generated instruction: HALT
	- Use for emergency stops or when no cleanup needed

	### Technical Details (Additional Information)

	**Generated Assembly** (END):
	\`\`\`asm
	JMP  sysconfig_generated_end    ; Jump to end label (1 cycle)
	\`\`\`

	**Generated Assembly** (HALT):
	\`\`\`asm
	HALT                            ; Halt immediately (1 cycle)
	\`\`\`

	**Performance**: Both options execute in 1 PRU cycle

	### Block Appearance
	- **Shape**: Circle (distinct from square data processing blocks)
	- **Icon**: Flow control symbol
	- **No Output Ports**: Terminating block - execution stops here

	### Usage Notes
	- This is a **terminating block** - it has no output connections
	- Use END for normal program exits (recommended default)
	- Use HALT for emergency stops or when cleanup isn't needed
	- Multiple FLOW_CONTROL blocks can exist in different program paths

	### Terminology
	- **Flow control**: Directing program execution path
	- **Terminating block**: Block with no output - ends execution path
	- **HALT**: PRU instruction that stops core execution
	- **JMP**: Jump instruction that transfers control to a label

	--- `;
}

exports = {
	displayName: "Flow Control",
	defaultInstanceName: "Flow_Control_",
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
			default: "circle",
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		},
		{
			name: "opCode",
            displayName: "Jump To",
			default: "JMP",
            options: [
				{
					name: "JMP",
					displayName: "SysConfig Generated End",
				},
				{
					name: "HALT",
					displayName: "Halt",
				}
			],
		},
		{
			name: "constant1",
			default: "sysconfig_generated_end",
			getValue: (inst) => {
				if(inst["opCode"] == "JMP"){
					return "sysconfig_generated_end";
				}
				else{
					return "";
				}
			},
			hidden: true
		},
		{
			name: "outputReg",
            default: "None",
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
			default: 1,
			hidden: true
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			getValue: (inst) => {
				return 1;
			},
			default : 1
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