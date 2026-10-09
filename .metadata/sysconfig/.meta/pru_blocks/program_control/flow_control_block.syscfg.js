/**
 * Enumerates every real, user-meaningful label in the current design that
 * a Flow Control block can validly jump to: every block's <name>_start
 * (entry point) and, for ordinary blocks, <name>_end (exit
 * point). Loop blocks do NOT expose `_end`. Conditional (If/Else) blocks only expose
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
    // Option A: filter dropdown targets against actually-emitted labels
    let emittedLabels = new Set();
    try {
        const allocator = system.getScript("/pru_blocks/common/register_allocation/pru_register_allocator.js");
        if (allocator && allocator.getPruRegisterAllocationSummary) {
            const summary = allocator.getPruRegisterAllocationSummary();
            if (summary && summary.labels) {
                for (const lbl of summary.labels) {
                    if (typeof lbl === 'string' && lbl.length > 0 && lbl !== '0') {
                        emittedLabels.add(lbl);
                    }
                }
            }
        }
    } catch (e) {}

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
					// Note: Loop blocks do not expose an _end label. Break via Flow Control to the next block or sysconfig_generated_end.
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
				// Ordinary block: only _start offered; _end stays emitted in assembly
				// but removed from dropdown (redundant with next block start).
				targets.push({
					name: `${inst.$name}_start`,
					displayName: inst.$name
				});
			}
		}
	}

	return targets.filter(t => emittedLabels.has(t.name));
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



function getLongDescription() {
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/program_control/flow_control_block.md 

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
- **Any block's "start"**: Every block has an addressable entry point. 

### _start targets

- Every block exposes \`<name>_start\` — jump here to (re-)run that block from its entry point.

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
- Every disconnected subgraph (chunk with no incoming "prev") must terminate in Flow Control; validated as warning ("checkDisconnectedChunks").
- Unreachable emitted labels (e.g. block "_start") that never execute during simulation trigger warnings (unreachable-chunk detection).
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