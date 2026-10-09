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

- **Sysconfig Generated End**: Jumps to the end label of the SysConfig-generated code. Allows any cleanup code or epilogue to execute. Recommended for normal program completion. Generated instruction: `JMP sysconfig_generated_end`
- **Halt**: Immediately stops the PRU execution. Puts PRU into halt state, no cleanup or epilogue runs. Generated instruction: `HALT`. Use for emergency stops or when no cleanup needed.
- **Any block's `_start`**: Every block in the design — ordinary blocks, If/Else blocks, Loop blocks, Group blocks — has an addressable `_start` entry point. The dropdown only lists real, currently-existing targets — SysConfig rejects the field if a previously-selected target no longer exists (e.g. the referenced block was renamed or deleted).

### _start vs _end targets

- Every block exposes `<name>_start` — jump here to (re-)run that block. For a finite Loop, this re-arms LOOP (counter reloads, not a clean continue); for an infinite loop (`startloop_N` with `QBA`), it acts like a true continue.

### Technical Details (Additional Information)

**Generated Assembly** (Sysconfig Generated End):
```asm
JMP  sysconfig_generated_end    ; Jump to end label (1 cycle)
```

**Generated Assembly** (Halt):
```asm
HALT                            ; Halt immediately (1 cycle)
```

**Generated Assembly** (block target):
```asm
JMP  Loop_0_start                ; Jump to the selected block's entry/exit point (1 cycle)
```

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
- **jumpTarget**: The single dropdown selecting where this block jumps to — Sysconfig Generated End, Halt, or any real `_start` target in the design, validated against the current design, not free text

--- 

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Flow Control block in a .syscfg file.

### Adding a Flow Control Instance

\`\`\`javascript
const flow_control_block = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
const flow1 = flow_control_block.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| jumpTarget | String | "JMP", "HALT", or the name of any real _start target in the design | "JMP" | Single dropdown covering every jump target — end of generated code, halt, or any block's entry point. Validated against the current design, not free text |

### Valid Values for jumpTarget

| Value | Display Name | Description |
|-------|--------------|-------------|
| "JMP" | Sysconfig Generated End | Jump to end label of generated code |
| "HALT" | Halt | Immediately stop PRU execution |
| "<name>_start" | <BlockName> | Jump to that block's entry point |

### _start targets

- Every block exposes `<name>_start` — jump here to (re-)run that block. For a finite Loop, this re-arms LOOP (counter reloads, not a clean continue); for an infinite loop (`startloop_N` with `QBA`), it acts like a true continue.

### Example Configurations

**Jump to end (normal exit):**
\`\`\`javascript
flow1.$name = "Flow_Control_End";
flow1.jumpTarget = "JMP";
\`\`\`

**Halt PRU immediately:**
\`\`\`javascript
flow1.$name = "Flow_Control_Halt";
flow1.jumpTarget = "HALT";
\`\`\`

**Jump to another block's entry point (e.g. re-entering a loop):**
\`\`\`javascript
flow1.$name = "Flow_Control_Custom";
flow1.jumpTarget = "Loop_0_start";   // Must match a real "<blockName>_start" target in the design — validated by SysConfig
\`\`\`

**Break out of a loop (example):**
```javascript
// TRUE branch jumps to the next connected block (e.g. SPI read) to exit loop.
flow_break.$name = "Flow_Control_Break";
flow_break.jumpTarget = "PRU0_SPI_Read_0_start";  // label of block after loop, lets say SPI read is connected to loop's next 
scripting.connect(if_else_check, "T", flow_break, "prev");
```

### Connecting to Other Blocks

\`\`\`javascript
// Flow Control is a terminating block - only has prev port, no next
scripting.connect(prev_block, "next", flow1, "prev");

// Often used after conditional block's true or false path
scripting.connect(if_else1, "T", flow1, "prev");  // Exit on true condition
\`\`\`

### Important Notes

1. **Terminating Block**: Flow Control has no output ports - it ends the execution path.

2. **No Next Port**: Cannot connect anything to this block's output - execution ends here.

3. **JMP vs HALT vs a block target**: Use "SysConfig Generated End" for normal exits (allows cleanup code), "Halt" for immediate stops, or select any other block's entry directly from the same dropdown (e.g. an If/Else block's own `_start` to re-evaluate it, or a Loop block's `_start` to re-enter).

4. **Single Cycle**: All jumpTarget options execute in 1 PRU cycle.

5. **jumpTarget is validated against the current design**: Every block gets an addressable `<blockName>_start` entry point, and the dropdown lists all of them alongside SysConfig Generated End / Halt — SysConfig rejects any value that doesn't correspond to a real target. If a referenced block is renamed or removed, re-select the target; SysConfig will flag it as invalid at validation time, not at the assembler build step.
### Validation Notes for AI Agents
- **Disconnected subgraphs**: Every disconnected block chunk must end in a Flow Control block. The validator checks this (`checkDisconnectedChunks`) and reports a warning per missing termination.
- **Dropdown filtering (Option A)**: Only labels actually emitted by the register allocator appear in the dropdown. Memory variables, lookup tables, and unreachable blocks are filtered out.
- **Unreachable chunks**: Post-simulation, unreachable emitted labels (`_start`, loop labels) trigger warnings (`Unreachable chunk: label 'X'...`). This is a warning, not an error.
