## Access Lookup Table Block

### Purpose
Reads data from a lookup table stored in PRU Data Memory (DMEM) using an index value.

### How It Works
1. **Input**: Receives an index value (0 to tableSize-1) from the connected block
2. **Process**: Generates assembly code to read from the selected Lookup Table at that index position
3. **Output**: Sends the retrieved data value to the next block

### Configuration Steps
1. A Lookup Table block is automatically created and nested below — configure it with your table data
2. If multiple Lookup Table blocks exist, use the "Lookup Table Selected" field to choose which one to read from
3. Connect an index value to the "index" input port
4. The output data size automatically matches the referenced table's data type (byte/ushort/uint)

### Technical Details (Additional Information)
**Generated Assembly**:
- LDI32   TEMP_REG1, `LUT_BASE_ADDRESS`    ; Load table base address (2 cycles)
- LBBO    &result, TEMP_REG1, index, size  ; Load data from PRU DRAM (3 cycles for ≤4 bytes)

**Performance**: 5 PRU cycles total (assuming word-aligned access to PRU DRAM)
- LDI32: 2 cycles
- LBBO: 3 cycles (2 + N where N=1 for reading ≤4 bytes)

Note: Add +1 cycle if index results in non-word-aligned address

**Terminology**:
- **LBBO**: Load Byte Burst from Offset - reads 1/2/4 bytes from memory
- **DMEM**: PRU Data Memory - 8KB local RAM in each PRU core
- **Index**: Zero-based position in the table (must be less than table size)

---
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Access Lookup Table block in a .syscfg file.

### Adding an Access Lookup Table Instance

\`\`\`javascript
const access_look_up_table = scripting.addModule("/pru_blocks/utils/access_look_up_table", {}, false);
const access_lut1 = access_look_up_table.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| lutReference | String | Name of a Lookup Table instance | "" | Which Lookup Table to read from |

### Example Configurations

**Read from a lookup table:**
\`\`\`javascript
// First create the Lookup Table
const look_up_table = scripting.addModule("/pru_blocks/utils/look_up_table", {}, false);
const lut1 = look_up_table.addInstance();
lut1.$name = "Sine_Table";
lut1.tableSize = 256;
lut1.dataType = "ushort";
lut1.initPattern = "sequential";

// Then create Access Lookup Table to read from it
access_lut1.$name = "Read_Sine";
access_lut1.lutReference = "Sine_Table";
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect index source to input (index port)
scripting.connect(load_constant1, "output1", access_lut1, "input1");

// Connect output to downstream block
scripting.connect(access_lut1, "output1", uart_tx1, "input1");

// Connect control flow
scripting.connect(prev_block, "next", access_lut1, "prev");
scripting.connect(access_lut1, "next", next_block, "prev");
\`\`\`

### Important Notes

1. **Requires Lookup Table**: A Lookup Table block must exist and be referenced by lutReference.

2. **Index Input**: Connect a block that provides the index value (0 to tableSize-1) to input1.

3. **Output Size**: Automatically matches the referenced Lookup Table's dataType (1, 2, or 4 bytes).

4. **Bounds Checking**: Validation warns if constant index is out of bounds. Runtime bounds checking is not performed.

5. **Performance**: 5 PRU cycles total (2 for LDI32 + 3 for LBBO).