---

## Memory Access Block

### Purpose

Reads from or writes to a named memory buffer defined by a Memory Variable block. Uses LBBO (load) or SBBO (store) instructions with automatic symbol-based address calculation and compile-time bounds validation.

### Features

- Read (LBBO) and Write (SBBO) modes
- Accesses named symbols defined by Memory Variable blocks
- Byte offset from symbol base address
- Data sizes 1-8 bytes
- Compile-time bounds checking (offset + size ≤ buffer size)
- 3-cycle execution

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| Operation | Read or write | Read (Load from Memory), Write (Store to Memory) |
| Memory Variable Selected | Shows which Memory Variable is currently bound to this block | — |
| Memory Variable (nested) | Configure the auto-created buffer's label, size, and location directly below this block | — |
| Offset (bytes) | Byte offset from symbol base | 0 to (buffer size - data size) |
| Data Size (bytes) | Number of bytes to access | 1–8 |

When the Memory Access block is added to the design, a Memory Variable block is automatically
created and nested under it. Configure the buffer through the nested block. If multiple
Memory Variable blocks exist in the design, use the dropdown to select which one to access.
Multiple Memory Access blocks can share the same buffer by pointing to the same label name.

### Ports

| Mode | Port | Description |
|------|------|-------------|
| Read | output1 (data) | Loaded value output to next block |
| Write | input1 (data) | Value to store — connect from upstream block |
| Both | prev / next | Standard control flow |

### How It Works

**Read (LBBO):**
```assembly
LDI32   TEMP_REG1, (symbol + offset)    ; Calculate address (2 cycles)
LBBO    &R_output, TEMP_REG1, 0, size   ; Load from memory (1 cycle)
```

**Write (SBBO):**
```assembly
LDI32   TEMP_REG1, (symbol + offset)    ; Calculate address (2 cycles)
SBBO    &R_input, TEMP_REG1, 0, size    ; Store to memory (1 cycle)
```

### Performance

- **Total**: 3 PRU cycles (2 for LDI32 + 1 for LBBO/SBBO, plus memory access latency)
- Uses TEMP_REG1 (R28) internally — this register is reserved during execution

### Memory Locations

| Location | Size | Use Case |
|---------|------|---------|
| DMEM (Local) | 8 KB per PRU | PRU-private data, fastest access |
| SMEM (Shared) | 64 KB total | PRU-to-ARM or PRU-to-PRU communication |

The memory location is determined by the referenced Memory Variable block's configuration.

### Validation Rules

- A Memory Variable is always available — auto-created if none exist in the design
- `offsetValue` must be ≥ 0
- `offset + dataSize` must not exceed the buffer's declared size
- Write mode requires `input1` to be connected
- Removing the Memory Access block also removes its auto-created Memory Variable

### Usage Examples

**Read 4 bytes from a local buffer:**
```
[Memory Variable: rxBuffer, 128 bytes, DMEM]
[Memory Access: Read, symbol=rxBuffer, offset=0, size=4] → [Process Data]
```

**Write result to shared memory for ARM to read:**
```
[Calculation] → [Memory Access: Write, symbol=ipcBuffer, offset=0x10, size=4]
[Memory Variable: ipcBuffer, 256 bytes, SMEM]
```

**Array element access (e.g., 8th element of a 4-byte array):**
```
[Memory Access: Read, symbol=dataBuffer, offset=32, size=4] → [Next Block]
```

---
