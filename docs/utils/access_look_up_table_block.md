---

## Access Lookup Table Block

### Purpose

Reads a single value from a Lookup Table block stored in PRU memory using a runtime index. The result is output to the next block for further processing.

### Features

- Auto-creates a paired Lookup Table block when added (no manual setup required)
- Index-based access — reads `table[index]` at runtime
- Output size automatically matches the referenced table's data type (1, 2, or 4 bytes)
- 5-cycle execution (2 for address load + 3 for memory read)
- Bounds checking at configuration time for constant indices

### Configuration

| Parameter | Description |
|-----------|-------------|
| Lookup Table Selected | Shows which Lookup Table is currently bound to this block |
| Lookup Table (nested) | Configure the auto-created table's size, data type, and values directly below this block |

When the Access Lookup Table block is added to the design, a Lookup Table block is automatically
created and nested under it. Configure the table data through the nested block. If multiple
Lookup Table blocks exist in the design, use the dropdown to select which one to read from.

### Ports

| Port | Direction | Description |
|------|-----------|-------------|
| index (input1) | Input | Zero-based index into the table (0 to tableSize-1) |
| dout (output1) | Output | Value read from `table[index]` |
| prev / next | Control | Standard flow control ports |

### How It Works

1. Receives the index value from the connected input block
2. Calculates the absolute memory address: `table_base + (index × entry_size)`
3. Loads the value from PRU DMEM/SMEM using LBBO
4. Outputs the retrieved value to the next block

### Generated Assembly

```assembly
LDI32   TEMP_REG1, `LUT_BASE_ADDRESS`    ; Load table base address (2 cycles)
LBBO    &result, TEMP_REG1, index, size  ; Load entry from memory (3 cycles)
```

### Performance

- **Total**: 5 PRU cycles (assuming word-aligned access)
- Add +1 cycle if index causes non-word-aligned access

### Output Size

The output register size is automatically determined by the referenced table:

| Table Data Type | Output Size |
|----------------|------------|
| byte | 1 byte |
| ushort | 2 bytes |
| uint | 4 bytes |

### Validation Rules

- A Lookup Table is always available — auto-created if none exist in the design
- If the index input is a constant, it is validated to be within `[0, tableSize-1]`
- Runtime bounds checking is NOT performed — ensure index stays in range
- Removing the Access Lookup Table block also removes its auto-created Lookup Table

### Usage Example

```
[Load Constant (index=5)] → [Access Lookup Table (Sine_Table)] → [UART TX]
```
Reads entry 5 from `Sine_Table` and sends it over UART.

---
