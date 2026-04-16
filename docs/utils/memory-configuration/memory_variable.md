---

## Memory Variable Block

### Purpose

Reserves a named, uninitialized memory buffer in PRU Data Memory (DMEM) or Shared Memory (SMEM) using the `.usect` assembler directive. The symbol name can then be referenced by Memory Access blocks to read from or write to this buffer at runtime.

### Features

- Named symbol pointing to reserved memory
- DMEM (local, 8 KB) or SMEM (shared, 64 KB) allocation
- 1–8192 bytes per reservation
- 4-byte (word) aligned automatically
- No runtime code — declaration only
- Multiple Memory Variable blocks can be used for separate buffers

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| Label Name | Symbol name for the reserved memory | Valid C identifier (letters, numbers, underscore; cannot start with number) |
| Size in Bytes | Number of bytes to reserve | 1–8192 |
| Memory Location | Where to allocate the buffer | DMEM (Local), SMEM (Shared) |

### Generated Assembly

```assembly
; DMEM example:
myBuffer    .usect  ".udmem", 128, 4

; SMEM example:
sharedData  .usect  ".usmem", 512, 4
```

### .usect Directive

```
symbol  .usect  "section_name", size_in_bytes, alignment
```

- Places `size_in_bytes` of uninitialized space in the named section
- Alignment is fixed to 4 bytes (word-aligned) for optimal PRU access
- The linker resolves the actual address at link time

### Memory Location Comparison

| | DMEM (Local) | SMEM (Shared) |
|-|-------------|--------------|
| Size | 8 KB per PRU | 64 KB total |
| Access speed | Fastest | Slightly slower |
| Accessibility | Private to one PRU | All PRUs + ARM |
| Use case | PRU-private buffers, stacks | IPC, shared data |

### Differences from Lookup Table Block

| Feature | Memory Variable | Lookup Table |
|---------|----------------|--------------|
| Initial content | Uninitialized (undefined) | Pre-defined values |
| Directive | `.usect` | `.data` section |
| Use case | Runtime buffers, IPC | Pre-computed tables |
| R5F initialization | Not required | Required (writes data before PRU starts) |

### Validation Rules

- Label name must be a valid C identifier
- Size: 1–8192 bytes
- Alignment must be a power of 2 (fixed to 4 in practice)

### Usage Workflow

1. Add a **Memory Variable** block and configure label name, size, and memory location
2. Add a **Memory Access** block — the symbol appears in the dropdown
3. Configure the Memory Access with operation (read/write), offset, and data size
4. Connect data source (write) or data destination (read) to the Memory Access block

### Example: PRU-to-ARM Communication Buffer

```
Memory Variable:
  labelName = "ipcBuffer"
  sizeInBytes = 256
  memoryLocation = SMEM

Memory Access (Write):
  symbol = ipcBuffer
  offset = 0
  size = 4
  input1 → [calculated result]
```
The ARM core can read `ipcBuffer` from shared memory after the PRU writes to it.

---
