---

## Group Block (Code Organization Container)

### Purpose

Organizes related blocks into a named, callable section of code. A group is a visual container — blocks dragged inside it are compiled into a separate subroutine that can be called from `main.asm` any number of times.

### Features

- Named subroutine with auto-generated start label
- Callable from `main.asm` using the `CALL` macro
- Automatic return instruction generated — no Flow Control block needed inside
- Can be called multiple times from different points in firmware
- Supports nesting (Loop blocks inside groups, groups inside groups)
- Resizable container (default 500×250 px)

### Configuration

| Parameter | Description |
|-----------|-------------|
| Group Name | Unique identifier — becomes the assembly label prefix (e.g., `my_group` → `my_group_start`) |

### Naming Rules

- Valid C identifier: letters, numbers, underscore only
- Cannot start with a number
- Must be unique across all groups in the design
- Recommended: keep under 32 characters
- Use descriptive names: `adc_config`, `sensor_init`, `data_process`

### How It Works

1. **Create** a Group block and set a unique Group Name
2. **Drag blocks** into the gray container — they become the group's body
3. **Connect blocks** inside using their normal ports
4. **Call** the group from `main.asm` using the `CALL` macro

### Calling Groups from main.asm

```assembly
    .ref    my_group_start          ; Reference the group's start label

main:
    CALL    my_group_start          ; Execute group — returns automatically
    CALL    my_group_start          ; Can be called again
    halt
```

- Use `CALL` (not `JAL` directly) — the CALL macro is defined in `pru_syscfg.inc`
- Execution automatically returns to the instruction after `CALL`
- The return address register is R27.w0 (`RET_ADDR0`)

### Generated Assembly Structure

For a group named `my_group`:

```assembly
; --- SysConfig generated section (ungrouped blocks) ---
sysconfig_generated_start:
    ; ... ungrouped blocks here ...
    JMP  sysconfig_generated_end

; --- Group subroutine ---
    .global  my_group_start
my_group_start:
    ; ... blocks inside the group ...
    JMP  RET_ADDR0              ; Auto-generated return
```

### Ungrouped vs Grouped Blocks

| | Ungrouped | Grouped |
|-|-----------|---------|
| Execution | Automatic when `sysconfig_generated_start` is called | Only when explicitly called via `CALL group_start` |
| Use case | Initialization, always-needed code | Optional, conditional, or reusable functionality |
| Return | Jumps to `sysconfig_generated_end` | Auto-generated `JMP RET_ADDR0` |

### Important Notes

- Group blocks have **no input/output/prev/next ports** — they are pure containers
- Blocks inside a group follow normal connection and execution order rules
- Adding a Flow Control (HALT or JMP) inside a group is optional — for conditional exits within the group body
- Groups are independent — they do not automatically call each other

---
