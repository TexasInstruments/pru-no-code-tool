---

## Flow Control Block

### Purpose

Controls PRU program flow by jumping to the end of SysConfig-generated code, halting the PRU immediately, or jumping to the entry (`_start`) or exit (`_end`) point of any other block in the design. This is a terminating block — it has no output port.

### Features

- Single dropdown listing every valid jump target in the current design
- Single-cycle execution
- Terminating block — no next connection
- Distinct circular shape in the UI
- Target list is validated against the live design — renamed/removed blocks are flagged as errors, not silently broken

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Jump To | Where to jump when this block is reached | Sysconfig Generated End, Halt, or any block's `_start`/`_end` target in the current design |

### Options

**Sysconfig Generated End** (`JMP`):
- Jumps to the `sysconfig_generated_end` label — the end of all SysConfig-generated assembly
- Any handwritten epilogue code in `main.asm` after that label will still execute
- Recommended for normal program exits

**Halt** (`HALT`):
- Immediately stops PRU execution
- No cleanup or epilogue code runs
- Use for emergency stops or when no further cleanup is needed

**Any block's `_start` target**:
- Every block in the design exposes an addressable `<blockName>_start` entry point
- Select the target directly from the same dropdown — no separate free-text field
- If the referenced block is later renamed or deleted, SysConfig flags this block as invalid at validation time instead of silently generating a broken jump

### `_start` vs `_end`

- **`<name>_start`**: jump here to (re-)run that block from its entry point. For a Loop block, jumping here for a finite loop re-arms LOOP (counter reloads), not a clean continue; only for infinite loops (startloop_N with QBA) does it act like a true continue.
- **`<name>_end`**: for ordinary blocks, the position immediately after that block's own instruction and not exposed as an option to jump to using flow control. For Loop blocks, for breaking out of the loop we can have a flow control which can jump to the block which comes next to the loop block, connected to next port of the loop block 
- If/Else blocks only expose `_start` — no `_end` is offered for them.

### Generated Assembly

```assembly
; Sysconfig Generated End:
JMP   sysconfig_generated_end    ; Jump to end label (1 cycle)

; Halt:
HALT                              ; Stop PRU execution (1 cycle)

; Jump to a block's start (e.g. re-entering a Loop):
JMP   Loop_0_start                ; Jump to that block's entry point (1 cycle)

```

### Technical Details

- **Performance**: 1 PRU cycle for any option
- **Shape**: Circle (distinct from square data blocks)
- **No output ports** — execution ends here
- Multiple Flow Control blocks can exist in different paths of the same design
- The dropdown only lists real, currently-existing targets in the design — it is rebuilt live from every block's `$name`, so it always reflects the current design state

### Common Use Cases

- Ending the true or false path of an If/Else block (see [If/Else block](conditional_block.md))
- Re-entering a Loop block from inside a nested branch (jump to `<LoopName>_start`)
- Breaking out of a Loop early from inside its body (jump to the start of the next block connected after loop block)
- Stopping the PRU after one-shot initialization completes
- Emergency halt on fault conditions

### Example: Early Exit on Error

```
If/Else (error != 0)
  ├── t_next → Flow Control (Halt)       ; Stop on error
  └── f_next → [continue normal flow]
```

### Example: Continuing a Loop from a Nested If/Else

```
Loop_0
  └── If/Else (check exit condition)
        ├── t_next → Flow Control (Jump To = "SPI_block_start")    ; break out of the loop and jump outside to the start of the next block connected 
        └── f_next → Flow Control (Jump To = "Loop_0_start")  ; continue looping
```

---

### Disconnected Subgraphs
Every disconnected chunk of blocks (subgraphs with no incoming `prev` connection) must terminate in a Flow Control block. Without this, execution from one chunk falls through into the next chunk, causing unexpected behavior. The tool validates this and reports an error (`Disconnected chunk 'X' missing Flow Control termination`) if any disconnected subgraph doesn't end with Flow Control.

### Unreachable Chunk Warnings
After simulation, any emitted block label (`_start`, `_end`, `startloop_*`, `endloop_*`) that was never executed produces a visible warning (`Unreachable chunk: label 'X'...`). This helps identify dead or disconnected code that the simulation never reaches.
