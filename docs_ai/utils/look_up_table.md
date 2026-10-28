NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/utils/look_up_table.md

## Lookup Table Block

### Purpose
Defines a lookup table (LUT) that stores data values in PRU Data Memory (DMEM). This table can be accessed by Access Lookup Table block during PRU execution.

### How It Works
1. **Definition**: You define table data in this block (manually, using patterns, or importing from JSON)
2. **Compilation**: The data is placed in the PRU firmware's .data section during compilation
3. **Runtime Initialization**: The R5F core writes this data to PRU DMEM before starting the PRU
4. **Access**: Access Lookup Table block reads from this table during PRU execution

### Configuration Steps
1. **Set Table Size**: Specify how many entries your table needs (1-65536)
2. **Choose Data Type**:
- **byte** (8-bit): Values 0-255, uses 1 byte per entry
- **ushort** (16-bit): Values 0-65535, uses 2 bytes per entry
- **uint** (32-bit): Full 32-bit values, uses 4 bytes per entry
3. **Input Data**: Choose one of three methods:
- **Manual/Pattern**: Use Initialize Pattern dropdown to auto-generate data
- **Paste JSON Data**: For large tables, paste JSON data directly
- **Load JSON From File**: For very large tables, browse and load a JSON file

### Data Input Methods

**Method 1: Pattern-Based (Quick Setup)**
- **Sequential**: 0, 1, 2, 3, ... (default)
- **All zeros**: 0, 0, 0, 0, ...
- **All ones**: 0xFF, 0xFF, ... (or 0xFFFF/0xFFFFFFFF based on type)
- **Custom fill**: Same value repeated
- **Manual**: Edit the comma-separated list directly

**Method 2: Paste JSON Data (For Large Tables)**
Paste JSON directly in the text field:
```json
{
"values": [0, 1, 2, 3, 4, 5, ...],
"dataType": "byte"
}
```

**Method 3: Load JSON From File (Recommended for Very Large Tables)**
Browse and select a .json file from your file system with the same format:
```json
{
"values": [0, 1, 2, 3, 4, 5, ...],
"dataType": "byte"
}
```

**JSON Format Details:**
- **Required**: "values" field containing an array of numbers
- **Optional**: "dataType" field ("byte", "ushort", or "uint") - will auto-set the data type if provided
- The table size is automatically updated to match the array length
- All values must be valid numbers appropriate for the selected data type

### Memory Layout
- LUT data is stored in PRU DMEM starting at offset determined by linker
- Total size = (table size) × (bytes per entry)
- Maximum DMEM size: 8KB per PRU core

### Technical Details (Additional Information)
**Generated Assembly**: Creates a .data section with the table values
- .data
- .align 4
- LUT_0: .byte 0, 1, 2, 3, 4, 5, 6, 7, ...


**Performance**: No runtime overhead - data is pre-loaded in memory

### Terminology
- **LUT**: Lookup Table - array of pre-computed values
- **DMEM**: PRU Data Memory - 8KB local RAM in each PRU core
- **.data section**: Section in firmware binary that contains initialized data
- **R5F initialization**: Main ARM core writes LUT to PRU memory before starting PRU

---

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Lookup Table block in a .syscfg file.

### Adding a Lookup Table Instance

```javascript
const look_up_table = scripting.addModule("/pru_blocks/utils/look_up_table", {}, false);
const lut1 = look_up_table.addInstance();
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| tableSize | Integer | 1-65536 | 16 | Number of entries in the table |
| dataType | String | "byte", "ushort", "uint" | "byte" | Data type for each entry |
| importMethod | String | "manual", "json_paste", "json_file" | "manual" | How to input data |
| initPattern | String | "manual", "sequential", "zeros", "ones", "custom" | "sequential" | Pattern for auto-generating data |
| customValue | Integer | Depends on dataType | 0 | Fill value when initPattern="custom" |
| tableData | String | Comma-separated values | "0,1,2,..." | The actual table data |

### Valid Values for dataType

| Value | Display Name | Range | Bytes per Entry |
|-------|--------------|-------|-----------------|
| "byte" | 8-bit (0-255) | 0-255 | 1 |
| "ushort" | 16-bit (0-65535) | 0-65535 | 2 |
| "uint" | 32-bit | 0-4294967295 | 4 |

### Valid Values for initPattern

| Value | Display Name | Description |
|-------|--------------|-------------|
| "manual" | Manual Entry | Edit tableData directly |
| "sequential" | Sequential (0, 1, 2, ...) | Auto-fill with 0, 1, 2, ... |
| "zeros" | All Zeros | Fill with 0 |
| "ones" | All Ones | Fill with 0xFF/0xFFFF/0xFFFFFFFF |
| "custom" | Fill With Custom Value | Fill with customValue |

### Example Configurations

**Small sequential table (16 bytes):**
```javascript
lut1.$name = "Lookup_Table_0";
lut1.tableSize = 16;
lut1.dataType = "byte";
lut1.initPattern = "sequential";
// tableData auto-generates: "0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15"
```

**Sine wave lookup table (256 entries, 16-bit):**
```javascript
lut1.$name = "Sine_Table";
lut1.tableSize = 256;
lut1.dataType = "ushort";
lut1.initPattern = "manual";
lut1.tableData = "32768, 33572, 34376, ...";  // Pre-computed sine values
```

**Custom fill value:**
```javascript
lut1.$name = "Init_Buffer";
lut1.tableSize = 64;
lut1.dataType = "uint";
lut1.initPattern = "custom";
lut1.customValue = 0xDEADBEEF;
```

### Connecting to Other Blocks

```javascript
// Lookup Table is data-only, connect Access Lookup Table to read from it
const access_lut = scripting.addModule("/pru_blocks/utils/access_look_up_table", {}, false);
const access1 = access_lut.addInstance();
access1.lutReference = lut1.$name;  // Reference this lookup table

// Connect index source to Access Lookup Table
scripting.connect(index_block, "output1", access1, "input1");
```

### Important Notes

1. **Data Only**: Lookup Table block defines data storage - use Access Lookup Table to read values.

2. **Memory Size**: Total memory = tableSize × bytes per entry. Maximum DMEM is 8KB per PRU.

3. **R5F Initialization**: Data is written to PRU DMEM by the R5F core before PRU starts.

4. **JSON Import**: For large tables, use importMethod="json_paste" or "json_file" with format:
    ```json
    { "values": [0, 1, 2, ...], "dataType": "byte" }
    ```
