## Memory Access Block

### Purpose
Read from or write to PRU memory using symbols defined by Memory Variable blocks. Uses LBBO (Load) or SBBO (Store) instructions with automatic address calculation and bounds checking.

### How It Works
1. **Select Operation**: Choose Read (LBBO) or Write (SBBO)
2. **Configure Memory Variable**: A Memory Variable block is automatically created and nested below — configure its label name, size, and memory location
3. **Configure Offset**: Set the byte offset from the symbol's base address (0 to buffer size)
4. **Set Data Size**: Choose how many bytes to access (1 to 112 bytes)
5. **Execute**: PRU calculates the absolute address (symbol + offset) and executes LBBO/SBBO instruction

### Memory Symbol Addressing
The block uses symbols defined by **Memory Variable** blocks:
- A Memory Variable is auto-created and nested under each Memory Access block
- If multiple Memory Variable blocks exist, select which one to access via the dropdown
- Multiple Memory Access blocks can share the same buffer by pointing to the same label name
- The linker automatically resolves the symbol address at link time
- Offset is validated against the buffer size to prevent overflow

### Generated Assembly

**Read Operation (LBBO)**:
```assembly
LDI32 R28, (symbol + offset)  ; Calculate absolute address
LBBO &R_output, R28, 0, byte_count  ; Load data from memory
```

**Write Operation (SBBO)**:
```assembly
LDI32 R28, (symbol + offset)  ; Calculate absolute address
SBBO &R_input, R28, 0, byte_count   ; Store data to memory
```

### Configuration Parameters

#### Operation
- **Read (Load from Memory)**: Uses LBBO instruction, has output port
- **Write (Store to Memory)**: Uses SBBO instruction, has input port for data

#### Select Memory Symbol
- Choose a symbol from the dropdown of available Memory Variable blocks
- Shows symbol name and size (e.g., "buffer (64 bytes)")
- The linker resolves the symbol address automatically

#### Offset (bytes)
- Byte offset from the start of the memory symbol
- Range: 0 to (buffer size - data size)
- Validated to ensure offset + data size doesn't exceed buffer bounds
- Example: offset=8 accesses bytes 8-11 (for 4-byte read)

#### Data Size (bytes)
- Number of bytes to read or write
- Range: 1 to 112 bytes
- For sizes >= 4 bytes, data must be register-aligned
- Default: 4 bytes

### Technical Details (Additional Information)

**Performance**: 3 PRU cycles total
- LDI32: 2 cycles (load 32-bit address)
- LBBO/SBBO: 1 cycle (+ memory access latency)

**Register Usage**:
- Uses TEMP_REG1 (R28) internally for address calculation

### Usage Examples

#### Example 1: Read from Memory Reserve buffer
```
[Memory Variable: rxBuffer, 128 bytes, DMEM]
[Memory Access] → [Process Data]
Config: Operation=Read, Symbol=rxBuffer, Offset=0, Data Size=4 bytes
Result: Reads 4 bytes from rxBuffer[0-3]
```

#### Example 2: Write to Shared Memory (PRU to ARM communication)
```
[Memory Variable: sharedData, 256 bytes, SMEM]
[Data Source] → [Memory Access]
Config: Operation=Write, Symbol=sharedData, Offset=0x10, Data Size=4 bytes
Result: Writes 4 bytes to sharedData[16-19]
```

#### Example 3: Array Element Access
```
[Memory Variable: dataBuffer, 256 bytes, DMEM]
[Memory Access] → [Process]
Config: Operation=Read, Symbol=dataBuffer, Offset=32, Data Size=4 bytes
Result: Reads 4 bytes from dataBuffer[32-35] (8th element in 4-byte array)
```

#### Example 4: Store Result to Reserved Memory
```
[Memory Variable: resultBuffer, 64 bytes, DMEM]
[Calculation] → [Memory Access]
Config: Operation=Write, Symbol=resultBuffer, Offset=0, Data Size=4 bytes
Result: Writes 4 bytes to resultBuffer[0-3]
```

#### Example 5: Multi-byte Transfer
```
[Memory Variable: largeBuffer, 512 bytes, SMEM]
[Data Source] → [Memory Access]
Config: Operation=Write, Symbol=largeBuffer, Offset=0, Data Size=16 bytes
Result: Writes 16 bytes to largeBuffer[0-15] using multiple registers
```

### Ports

**Read Mode**:
- Input: offset (only in Register Input mode)
- Output: data (loaded value)

**Write Mode**:
- Input 1: data (value to store)
- Input 2: offset (only in Register Input mode)

### Important Notes

1. **Symbol Resolution**: The linker resolves the actual memory address at link time. The symbol points to the memory location defined by the Memory Variable block.

2. **Bounds Checking**: The block validates that offset + data size doesn't exceed the buffer size. If validation fails, an error is shown in SysConfig.

3. **TEMP_REG1 Usage**: The block uses R28 (TEMP_REG1) internally for address calculation. This register is reserved and should not be used by other blocks during execution.

4. **Memory Location**: The symbol's memory location (DMEM or SMEM) is determined by the Memory Variable block configuration:
- DMEM (Local): Fast access, 8KB per PRU, private to each core
- SMEM (Shared): Shared between PRUs and ARM, 64KB total, use for inter-core communication

### Terminology

- **LBBO**: Load Byte Burst Operation - PRU instruction for direct memory read
- **SBBO**: Store Byte Burst Operation - PRU instruction for direct memory write
- **DMEM**: Data Memory - PRU local RAM
- **Symbol**: Named memory location defined by Memory Variable block
- **.usect**: Assembler directive used by Memory Reserve to allocate memory

---

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Memory Access block in a .syscfg file.

### Adding a Memory Access Instance

\`\`\`javascript
const memory_load_block = scripting.addModule("/pru_blocks/data_handling/memory_load_block", {}, false);
const mem_access1 = memory_load_block.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| operationMode | String | "read", "write" | "read" | Read (LBBO) or Write (SBBO) operation |
| symbolSelect | String | Symbol name from Memory Reserve | "" | Symbol name from Memory Variable block dropdown |
| offsetValue | Integer | 0 to (buffer_size - dataSize) | 0 | Byte offset from symbol start, validated against buffer size |
| dataSize | Integer | 1-112 | 4 | Number of bytes to read/write (1-112 bytes, register-aligned for >=4) |

### Example Configurations

**Read 4 bytes from beginning of buffer:**
\`\`\`javascript
// First create Memory Variable block
const memory_reserve = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);
const mem_reserve1 = memory_reserve.addInstance();
mem_reserve1.$name = "Memory_Reserve_0";
mem_reserve1.labelName = "rxBuffer";
mem_reserve1.sizeInBytes = 128;
mem_reserve1.memoryLocation = "dmem";  // Local PRU memory

// Configure Memory Access to read from it
mem_access1.$name = "Memory_Access_Read";
mem_access1.operationMode = "read";
mem_access1.symbolSelect = "rxBuffer";
mem_access1.offsetValue = 0;
mem_access1.dataSize = 4;
\`\`\`

**Write to shared memory buffer with offset:**
\`\`\`javascript
// First create Memory Variable block in shared memory
const memory_reserve = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);
const mem_reserve1 = memory_reserve.addInstance();
mem_reserve1.$name = "Memory_Reserve_0";
mem_reserve1.labelName = "sharedData";
mem_reserve1.sizeInBytes = 256;
mem_reserve1.memoryLocation = "smem";  // Shared memory for PRU-ARM communication

// Configure Memory Access to write to offset 0x10
mem_access1.$name = "Memory_Access_Write";
mem_access1.operationMode = "write";
mem_access1.symbolSelect = "sharedData";
mem_access1.offsetValue = 0x10;  // Write to bytes 16-19
mem_access1.dataSize = 4;
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// For WRITE mode: connect data source to input1
scripting.connect(load_constant1, "output1", mem_access1, "input1");

// For READ mode: connect output1 to downstream block
scripting.connect(mem_access1, "output1", process_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", mem_access1, "prev");
\`\`\`

### Important Notes

1. **Write Mode Inputs**: When operationMode="write", connect data to input1. If offsetMode="register", also connect offset to input2.

2. **Read Mode Outputs**: When operationMode="read", the loaded data is available on output1.

3. **Symbol Addressing**: When using addressingMode="symbol", the symbol must be defined by a Memory Variable block in the same configuration.