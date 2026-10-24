---

## IPC Shared Memory Block

### Purpose

The IPC Shared Memory block reserves a 4-byte variable in PRU memory and stores its input value there, so that a host processor (for example the R5F) or another PRU core can read it.

### Features

- Reserves the variable with a `.usect` directive in the selected section
- Stores the full 32-bit input value on every pass
- Optional cross-core write check: when another core also writes the variable, SysConfig requires an XFR2SPIN acquire/release pair around the write

### Configuration

| Parameter | Description | Default | Options |
|-----------|-------------|---------|---------|
| Variable Name | Label of the reserved variable (must not be an assembler reserved name) | `encoder_data` | Text string |
| Memory Section | Where the variable is reserved | `PRU_SHARED_RAM` | `PRU_SHARED_RAM` (`.usmem`), `PRU_DRAM_0` (`.udmem`, the data RAM of the core the design runs on) |
| Data Type | Type recorded for the variable; the store is always 4 bytes | `uint32_t` | `uint32_t`, `int32_t`, `float` |
| Also written by another core | Assert when another core or the host also writes this variable | `false` | `true`, `false` |

### How It Works

The block emits:

```assembly
mov   TEMP_REG3, IN1
ldi32 TEMP_REG1, VAR_NAME
sbbo  &TEMP_REG3, TEMP_REG1, 0, 4
```

The input is copied into a full register first, so the store writes exactly the 4-byte value even when the allocator placed the input in a byte or word of a register. The block costs 4 cycles.

### Important Notes

- The host must use the address the linker assigns to the variable (from the map file); the block does not generate host-side code.
- Not validated on hardware.

---
