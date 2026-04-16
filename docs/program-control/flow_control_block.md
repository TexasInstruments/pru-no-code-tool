---

## Flow Control Block

### Purpose

Controls PRU program flow by either jumping to the end of SysConfig-generated code or halting the PRU immediately. This is a terminating block — it has no output port.

### Features

- Two modes: jump to generated end label, or halt the PRU
- Single-cycle execution
- Terminating block — no next connection
- Distinct circular shape in the UI

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Jump To | What to do when this block is reached | Sysconfig Generated End, Halt |

### Options

**Sysconfig Generated End** (`JMP`):
- Jumps to the `sysconfig_generated_end` label — the end of all SysConfig-generated assembly
- Any handwritten epilogue code in `main.asm` after that label will still execute
- Recommended for normal program exits

**Halt** (`HALT`):
- Immediately stops PRU execution
- No cleanup or epilogue code runs
- Use for emergency stops or when no further cleanup is needed

### Generated Assembly

```assembly
; Sysconfig Generated End mode:
JMP   sysconfig_generated_end    ; Jump to end label (1 cycle)

; Halt mode:
HALT                              ; Stop PRU execution (1 cycle)
```

### Technical Details

- **Performance**: 1 PRU cycle
- **Shape**: Circle (distinct from square data blocks)
- **No output ports** — execution ends here
- Multiple Flow Control blocks can exist in different paths of the same design

### Common Use Cases

- Exiting from a conditional branch early (e.g., error detected → jump to end)
- Ending the true or false path of an If/Else block
- Stopping the PRU after one-shot initialization completes
- Emergency halt on fault conditions

### Example: Early Exit on Error

```
If/Else (error != 0)
  ├── t_next → Flow Control (Halt)       ; Stop on error
  └── f_next → [continue normal flow]
```

---
