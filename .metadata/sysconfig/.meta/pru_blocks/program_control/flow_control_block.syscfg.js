/**
 * Enumerates every real, user-meaningful label in the current design that
 * a Flow Control block can validly jump to: every block's <name>_start
 * (entry point) and, for ordinary and loop blocks, <name>_end (exit
 * point — for loops this is a dedicated early-exit target, not the
 * natural end-of-loop position). Conditional (If/Else) blocks only expose
 * _start, since they have two forward addresses (_TRUE/_FALSE) rather
 * than one "end". Excludes internal hardware labels (endloop_N; the
 * startloop_N numeric suffix is kept since it's the only re-entry point
 * infinite loops have, but conditional branch labels
 * If_Else_x_TRUE/FALSE are excluded since those are branch-instruction
 * targets, not block entry/exit points).
 * @returns {{name: string, displayName: string}[]}
 */
function getValidJumpTargets() {
	const targets = [];

	for (const moduleName in system.modules) {
		if (!moduleName.startsWith("/pru_blocks/")) continue;
		const module = system.modules[moduleName];
		if (!module || !module.$instances) continue;

		for (let i = 0; i < module.$instances.length; i++) {
			const inst = module.$instances[i];
			if (!inst || typeof inst !== 'object' || !inst.$name) continue;

			if (inst.$groupContents) {
				// Group block: exposed target is <groupName>_start
				if ('infiniteLoop' in inst) {
					// Loop block
					if (inst.infiniteLoop === true) {
						targets.push({
							name: `startloop_${i}`,
							displayName: `${inst.$name} (loop start)`
						});
					} else {
						targets.push({
							name: `${inst.$name}_start`,
							displayName: `${inst.$name} (loop start)`
						});
					}
					// <LoopName>_end: exposed early-exit target, distinct from
					// the internal endloop_N/startloop_N hardware labels —
					// lands right after the loop's body finishes (or right
					// after the infinite loop's back-edge), for bailing out
					// of the loop from anywhere inside it.
					targets.push({
						name: `${inst.$name}_end`,
						displayName: `${inst.$name} (loop end / exit)`
					});
				} else {
					// Group block
					const groupName = inst.groupName || inst.$name;
					targets.push({
						name: `${groupName}_start`,
						displayName: `${inst.$name} (group start)`
					});
				}
			} else if (inst.T && inst.F) {
				// Conditional (If/Else) block: only _start is exposed — a
				// conditional has two forward addresses (_TRUE/_FALSE), not
				// a single "end", so no _end target is offered for it.
				targets.push({
					name: `${inst.$name}_start`,
					displayName: inst.$name
				});
			} else {
				// Ordinary block: universal <name>_start and <name>_end
				targets.push({
					name: `${inst.$name}_start`,
					displayName: inst.$name
				});
				targets.push({
					name: `${inst.$name}_end`,
					displayName: `${inst.$name} (end)`
				});
			}
		}
	}

	return targets;
}

function validate(inst, report) {
	for(let iterator = 1; iterator <= inst["numOfInputPorts"]; iterator++)
	{
		if(inst["input"+iterator.toString()].length == 0)
		{
			report.logWarning("input"+iterator.toString()+" port not connected to output port",inst)
		}
	}

	const validNames = new Set(["JMP", "HALT", ...getValidJumpTargets().map(t => t.name)]);
	if (!validNames.has(inst["jumpTarget"])) {
		report.logError(`"${inst["jumpTarget"]}" is not a valid jump target in the current design. Re-select a target — it may have been renamed or removed.`, inst, "jumpTarget");
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
| jumpTarget | String | "JMP", "HALT", or the name of any real _start/_end target in the design | "JMP" | Single dropdown covering every jump target — end of generated code, halt, or any block's entry/exit point. Validated against the current design, not free text |

### Valid Values for jumpTarget

| Value | Display Name | Description |
|-------|--------------|-------------|
| "JMP" | Sysconfig Generated End | Jump to end label of generated code |
| "HALT" | Halt | Immediately stop PRU execution |
| "\<name\>_start" | \<BlockName\> | Jump to that block's entry point |
| "\<name\>_end" | \<BlockName\> (end) | Jump to that block's exit point (ordinary blocks), or the loop's dedicated early-exit target (loop blocks) |

### _start vs _end targets

- Every block exposes \`<name>_start\` — jump here to (re-)run that block from its entry point.
- Ordinary blocks also expose \`<name>_end\` — the position immediately after that block's own instruction (equivalent to jumping just past it).
- Loop blocks expose \`<LoopName>_end\` — a dedicated **early-exit** target for bailing out of the loop from anywhere inside its body (e.g. from a conditional branch nested inside the loop), landing right after the loop's normal exit point without waiting for the counter/condition to finish naturally.
- If/Else (Conditional) blocks only expose \`<name>_start\` — a conditional has two forward addresses (\`_TRUE\`/\`_FALSE\`), not a single "end".

### Example Configurations

**Jump to end (normal exit):**
\\\`\\\`\\\`javascript
flow1.$name = "Flow_Control_End";
flow1.jumpTarget = "JMP";
\\\`\\\`\\\`

**Halt PRU immediately:**
\\\`\\\`\\\`javascript
flow1.$name = "Flow_Control_Halt";
flow1.jumpTarget = "HALT";
\\\`\\\`\\\`

**Jump to another block's entry point (e.g. re-entering a loop):**
\\\`\\\`\\\`javascript
flow1.$name = "Flow_Control_Custom";
flow1.jumpTarget = "Loop_0_start";   // Must match a real "<blockName>_start" target in the design — validated by SysConfig
\\\`\\\`\\\`

**Early-exit a loop from inside a nested condition (break-like pattern):**
\\\`\\\`\\\`javascript
// Inside Loop_0's body, an If/Else checks some exit condition.
// Its TRUE branch jumps straight to Loop_0_end instead of letting the
// loop continue — bailing out before the counter naturally finishes.
flow_break.$name = "Flow_Control_Break";
flow_break.jumpTarget = "Loop_0_end";
scripting.connect(if_else_check, "T", flow_break, "prev");
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

3. **JMP vs HALT vs a block target**: Use "SysConfig Generated End" for normal exits (allows cleanup code), "Halt" for immediate stops, or select any other block's entry/exit point directly from the same dropdown (e.g. an If/Else block's own \`_start\` to re-evaluate it, or a Loop block's \`_start\`/\`_end\` to re-enter or bail out of it).

4. **Single Cycle**: All jumpTarget options execute in 1 PRU cycle.

5. **jumpTarget is validated against the current design**: Every block gets an addressable \`<blockName>_start\` entry point (and \`_end\` where applicable), and the dropdown lists all of them alongside SysConfig Generated End / Halt — SysConfig rejects any value that doesn't correspond to a real target. If a referenced block is renamed or removed, re-select the target; SysConfig will flag it as invalid at validation time, not at the assembler build step.
`;
}

function getLongDescription() {
	return `
## Flow Control Block

### Purpose
Controls PRU program flow by jumping to the end of generated code, halting the PRU, or jumping to the entry point of any other block in the design.

### How It Works
1. **Place in Flow**: Position this block where you want to control program flow
2. **Select Jump Target**: Pick from a single dropdown — Sysconfig Generated End, Halt, or the entry/exit point of any block in the design
3. **Execution**: When reached, performs the selected jump
4. **No Output**: This is a **terminating block** - no next connections

### Configuration

**Jump To**: A single dropdown listing every valid jump target in the current design:

- **Sysconfig Generated End**: Jumps to the end label of the SysConfig-generated code. Allows any cleanup code or epilogue to execute. Recommended for normal program completion. Generated instruction: \`JMP sysconfig_generated_end\`
- **Halt**: Immediately stops the PRU execution. Puts PRU into halt state, no cleanup or epilogue runs. Generated instruction: \`HALT\`. Use for emergency stops or when no cleanup needed.
- **Any block's \`_start\` or \`_end\`**: Every block in the design — ordinary blocks, If/Else blocks, Loop blocks, Group blocks — has an addressable \`_start\` entry point; ordinary and Loop blocks also expose \`_end\` (see "_start vs _end targets" below). The dropdown only lists real, currently-existing targets — SysConfig rejects the field if a previously-selected target no longer exists (e.g. the referenced block was renamed or deleted).

### _start vs _end targets

- Every block exposes \`<name>_start\` — jump here to (re-)run that block from its entry point.
- Ordinary blocks also expose \`<name>_end\` — the position immediately after that block's own instruction.
- Loop blocks expose \`<LoopName>_end\` — a dedicated **early-exit** target for bailing out of the loop from anywhere inside its body (e.g. a break-like pattern from a nested conditional), landing right after the loop's normal exit point without waiting for the counter/condition to finish naturally.
- If/Else (Conditional) blocks only expose \`_start\` — a conditional has two forward addresses (\`_TRUE\`/\`_FALSE\`), not a single "end".

### Technical Details (Additional Information)

**Generated Assembly** (Sysconfig Generated End):
\`\`\`asm
JMP  sysconfig_generated_end    ; Jump to end label (1 cycle)
\`\`\`

**Generated Assembly** (Halt):
\`\`\`asm
HALT                            ; Halt immediately (1 cycle)
\`\`\`

**Generated Assembly** (block target):
\`\`\`asm
JMP  Loop_0_start                ; Jump to the selected block's entry/exit point (1 cycle)
\`\`\`

**Performance**: Every jumpTarget option executes in 1 PRU cycle

### Block Appearance
- **Shape**: Circle (distinct from square data processing blocks)
- **Icon**: Flow control symbol
- **No Output Ports**: Terminating block - execution stops here

### Usage Notes
- This is a **terminating block** - it has no output connections
- Use Sysconfig Generated End for normal program exits (recommended default)
- Use Halt for emergency stops or when cleanup isn't needed
- Select any other block's entry/exit point directly from the same dropdown — no separate free-text field
- Multiple FLOW_CONTROL blocks can exist in different program paths
- **Every If/Else (Conditional) branch that is connected MUST end in a Flow Control block**: An If/Else block's TRUE and FALSE branches are NOT mutually exclusive in the generated assembly unless each branch is explicitly terminated — without a terminator, execution falls from one branch straight into the other and runs both. SysConfig now enforces this as a validation error, not just a warning — connect a Flow Control block (any jumpTarget) at the end of every connected T/F branch.

### Terminology
- **Flow control**: Directing program execution path
- **Terminating block**: Block with no output - ends execution path
- **HALT**: PRU instruction that stops core execution
- **JMP**: Jump instruction that transfers control to a label
- **jumpTarget**: The single dropdown selecting where this block jumps to — Sysconfig Generated End, Halt, or any real \`_start\`/\`_end\` target in the design, validated against the current design, not free text

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
			name: "jumpTarget",
            displayName: "Jump To",
			description: "Where to jump when this block is reached. Includes every real, currently-existing block entry (_start) and exit (_end) point in the design — validated, not free text.",
			default: "JMP",
            options: (inst) => [
				{
					name: "JMP",
					displayName: "SysConfig Generated End",
				},
				{
					name: "HALT",
					displayName: "Halt",
				},
				...getValidJumpTargets()
			],
		},
		{
			name: "opCode",
			hidden: true,
			default: "JMP",
			getValue: (inst) => {
				return (inst["jumpTarget"] === "HALT") ? "HALT" : "JMP";
			}
		},
		{
			name: "constant1",
			default: "sysconfig_generated_end",
			getValue: (inst) => {
				if(inst["jumpTarget"] == "JMP"){
					return "sysconfig_generated_end";
				}
				else if(inst["jumpTarget"] == "HALT"){
					return "";
				}
				else{
					return inst["jumpTarget"];
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