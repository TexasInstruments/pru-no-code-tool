let copyCmd = "cp";
let copyArgs = ["$browsedFile", "$comFile"];

if (system.getOS() == "win") {
    copyCmd = "cmd.exe";
    copyArgs = ["/c", "copy", "$browsedFile", "$comFile"];
}

function getLookUptable(instance) {
    return instance["tableData"];
}

function getDataSize(instance) {
    if (instance["dataType"] == "byte") {
        return ".byte";
    }
    if (instance["dataType"] == "ushort") {
        return ".ushort";
    }
    if (instance["dataType"] == "uint") {
        return ".uint";
    }
}
/*to do: figure out a way for the user to input large number of values without manually entering
everything*/
function validate(inst, report) {
    if (inst["tableSize"] < 1 || inst["tableSize"] > 65536) {
        report.logError("Table size must be between 1 and 65536", inst);
    }

    if (inst["tableData"].length == 0) {
        report.logWarning("LUT data is empty", inst);
    }
    else {
        const values = inst["tableData"].split(',').map(val => parseInt(val.trim()));
        const maxSize = inst["tableSize"];
        const actualSize = values.length;
        if (actualSize > maxSize) {
            report.logError(`Too many values: entered ${actualSize} values but maximum table size is ${maxSize}`, inst);
        }
        if (values.some(Number.isNaN)) {
            report.logWarning("All LUT values must be valid numbers", inst);
        }
        if (inst["dataType"] == "byte") {
            if (values.some(val => val > 0xFF || val < 0)) {
                report.logWarning("LUT values not in range (0, 0xFF) for byte type", inst);
            }
        }
        if (inst["dataType"] == "ushort") {
            if (values.some(val => val > 0xFFFF || val < 0)) {
                report.logWarning("LUT values not in range (0, 0xFFFF) for ushort type", inst);
            }
        }
        if (inst["dataType"] == "uint") {
            if (values.some(val => val > 0xFFFFFFFF || val < 0)) {
                report.logWarning("LUT values not in range (0, 0xFFFFFFFF) for uint type", inst);
            }
        }
    }
}
function getMacro(pruInstructionMacro, opCode) {
    // This block doesn't generate any runtime code, only data section
    return "0";
}
function getAIContext() {
    return getLongDescription() + `

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Lookup Table block in a .syscfg file.

### Adding a Lookup Table Instance

\\\`\\\`\\\`javascript
const look_up_table = scripting.addModule("/pru_blocks/utils/look_up_table", {}, false);
const lut1 = look_up_table.addInstance();
\\\`\\\`\\\`

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
\\\`\\\`\\\`javascript
lut1.$name = "Lookup_Table_0";
lut1.tableSize = 16;
lut1.dataType = "byte";
lut1.initPattern = "sequential";
// tableData auto-generates: "0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15"
\\\`\\\`\\\`

**Sine wave lookup table (256 entries, 16-bit):**
\\\`\\\`\\\`javascript
lut1.$name = "Sine_Table";
lut1.tableSize = 256;
lut1.dataType = "ushort";
lut1.initPattern = "manual";
lut1.tableData = "32768, 33572, 34376, ...";  // Pre-computed sine values
\\\`\\\`\\\`

**Custom fill value:**
\\\`\\\`\\\`javascript
lut1.$name = "Init_Buffer";
lut1.tableSize = 64;
lut1.dataType = "uint";
lut1.initPattern = "custom";
lut1.customValue = 0xDEADBEEF;
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Lookup Table is data-only, connect Access Lookup Table to read from it
const access_lut = scripting.addModule("/pru_blocks/utils/access_look_up_table", {}, false);
const access1 = access_lut.addInstance();
access1.lutReference = lut1.$name;  // Reference this lookup table

// Connect index source to Access Lookup Table
scripting.connect(index_block, "output1", access1, "input1");
\\\`\\\`\\\`

### Important Notes

1. **Data Only**: Lookup Table block defines data storage - use Access Lookup Table to read values.

2. **Memory Size**: Total memory = tableSize × bytes per entry. Maximum DMEM is 8KB per PRU.

3. **R5F Initialization**: Data is written to PRU DMEM by the R5F core before PRU starts.

4. **JSON Import**: For large tables, use importMethod="json_paste" or "json_file" with format:
    \\\`\\\`\\\`json
    { "values": [0, 1, 2, ...], "dataType": "byte" }
    \\\`\\\`\\\`
`;
}

function getLongDescription() {
        return `
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
\`\`\`json
{
"values": [0, 1, 2, 3, 4, 5, ...],
"dataType": "byte"
}
\`\`\`

**Method 3: Load JSON From File (Recommended for Very Large Tables)**
Browse and select a .json file from your file system with the same format:
\`\`\`json
{
"values": [0, 1, 2, 3, 4, 5, ...],
"dataType": "byte"
}
\`\`\`

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

---`;
}

exports = {
    displayName: "Lookup Table",
    defaultInstanceName: "Lookup_Table_",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
    uiView: "graph",
    templates: {
        "/pru_blocks/common/pru_syscfg.asm.xdt": null
    },
    config: [
        {
            name: "$shape",
            hidden: true,
            default: "square",
        },
        {
            name: "$topLabel",
            hidden: true,
            default: "",
        },
        {
            name: "numOfInputPorts",
            default: 0,
            hidden: true,
        },
        {
            name: "numOfOutputPorts",
            default: 0,
            hidden: true
        },
        {
            name: "numOfConstants",
            default: 0,
            hidden: true
        },
        {
            name: "lutMemoryLocation",
            displayName: "Lookup Table Memory Location",
            description: "Choose where to store the lookup table",
            options: [
                {
                    name: "dmem",
                    displayName: "DMEM (Local - 8KB)"
                },
                {
                    name: "smem",
                    displayName: "SMEM (Shared - 64KB)"
                }
            ],
            default: "dmem",
            longDescription: `
**DMEM (Local PRU Memory)**:
- 8KB per PRU core
- Fast access
- Private to each PRU
- Use for lookup tables accessed by single PRU

**SMEM (Shared Memory)**:
- 64KB total, shared between all PRUs and R5F
- Slightly slower access
- Use when multiple PRUs need same lookup table
- Saves DMEM space for other data

**Memory Usage**:
- byte: tableSize × 1 byte
- ushort: tableSize × 2 bytes
- uint: tableSize × 4 bytes
`
        },
        {
            name: "tableSize",
            displayName: "Number of Table Entries",
            description: "Size of lookup table (1 to 65536)",
            default: 16,
            onChange: function (inst, ui) {
                // When table size changes, regenerate table data based on current pattern
                if (inst.initPattern !== "manual") {
                    let values = [];
                    let fillValue;

                    switch (inst.initPattern) {
                        case "zeros":
                            fillValue = 0;
                            break;
                        case "ones":
                            if (inst.dataType === "byte") fillValue = 0xFF;
                            else if (inst.dataType === "ushort") fillValue = 0xFFFF;
                            else fillValue = 0xFFFFFFFF;
                            break;
                        case "custom":
                            fillValue = inst.customValue || 0;
                            break;
                        case "sequential":
                        default:
                            fillValue = null;
                            break;
                    }

                    for (let i = 0; i < inst.tableSize; i++) {
                        if (inst.initPattern === "sequential") {
                            values.push(i);
                        } else {
                            values.push(fillValue);
                        }
                    }

                    inst.tableData = values.join(", ");
                }
            }
        },
        {
            name: "importMethod",
            displayName: "Data Input Method",
            options: [
                { name: "manual", displayName: "Manual Or Pattern" },
                { name: "json_paste", displayName: "Paste JSON Data" },
                { name: "json_file", displayName: "Load JSON From File" }
            ],
            default: "manual",
            onChange: function (inst, ui) {
                const isManual = (inst.importMethod === "manual");
                const isJsonPaste = (inst.importMethod === "json_paste");
                const isJsonFile = (inst.importMethod === "json_file");

                // Show manual/pattern fields
                ui.initPattern.hidden = !isManual;
                ui.customValue.hidden = !isManual || inst.initPattern !== "custom";
                ui.tableData.hidden = !isManual;
                ui.manualDataPreview.hidden = !isManual;

                // Show JSON paste fields
                ui.jsonInput.hidden = !isJsonPaste;
                ui.jsonFormatExample.hidden = !isJsonPaste;
                ui.importJsonButton.hidden = !isJsonPaste;
                ui.jsonParseStatus.hidden = !isJsonPaste;

                // Show JSON file browser field
                ui.loadJsonFromFile.hidden = !isJsonFile;
                ui.jsonFileStatus.hidden = !isJsonFile;
                ui.jsonFileFormatExample.hidden = !isJsonFile;
            }
        },
        {
            name: "jsonInput",
            displayName: "Paste JSON Here",
            description: "Paste your JSON data in the required format",
            default: "",
            hidden: true,
            longDescription: `Required JSON format:
{
  "name": "My Lookup Table",
  "values": [0, 1, 2, 3, 4, 5, 6, 7, ...]
}

IMPORTANT:
- The "values" field MUST contain an array of numbers
- Optional fields: "name", "description", "dataType" are allowed but will be ignored
- See "JSON Format Example" field below for a preview based on your current table data

Click the info icon or expand this description to see full details.`
        },
        {
            name: "jsonFormatExample",
            displayName: "JSON Format Example",
            description: "Example format based on your current table data",
            default: "",
            readOnly: true,
            hidden: true,
            getValue: function (inst) {
                // Generate example based on current tableData
                let exampleValues = [];
                const currentData = inst.tableData ? inst.tableData.split(',').map(v => v.trim()) : [];

                // Show first 8 values as example
                if (currentData.length > 0) {
                    exampleValues = currentData.slice(0, Math.min(8, currentData.length));
                } else {
                    exampleValues = [0, 1, 2, 3, 4, 5, 6, 7];
                }
                const hasMore = inst.tableSize > 8;

                return `{
  "name": "My Lookup Table",
  "values": [${exampleValues.join(', ')}${hasMore ? ', ...' : ''}]
}

Note: Your table has ${inst.tableSize} entries. Include all ${inst.tableSize} values in the "values" array.`;
            }
        },
        {
            name: "importJsonButton",
            displayName: "Import JSON Data",
            description: "Click to import the JSON data above",
            default: false,
            hidden: true,
            onChange: function (inst) {
                if (!inst.jsonInput || inst.jsonInput.trim() === "") {
                    inst.jsonParseError = "Please paste JSON data above";
                    return;
                }

                try {
                    const parsed = JSON.parse(inst.jsonInput.trim());

                    // Validate required structure
                    if (typeof parsed !== 'object' || parsed === null) {
                        inst.jsonParseError = 'JSON must be an object with "values" field';
                        return;
                    }

                    if (!parsed.hasOwnProperty('values')) {
                        inst.jsonParseError = 'JSON must contain "values" field. Example: {"values": [1, 2, 3, 4]}';
                        return;
                    }

                    if (!Array.isArray(parsed.values)) {
                        inst.jsonParseError = '"values" must be an array';
                        return;
                    }

                    if (parsed.values.length === 0) {
                        inst.jsonParseError = '"values" array is empty';
                        return;
                    }

                    // Validate all values are numbers
                    const invalidIndices = [];
                    parsed.values.forEach((v, idx) => {
                        if (typeof v !== 'number' && isNaN(parseInt(v))) {
                            invalidIndices.push(idx);
                        }
                    });

                    if (invalidIndices.length > 0) {
                        const examples = invalidIndices.slice(0, 3).map(i => `index ${i}: "${parsed.values[i]}"`).join(', ');
                        inst.jsonParseError = `Found ${invalidIndices.length} non-numeric value(s). Examples: ${examples}`;
                        return;
                    }

                    // Success! Import the data
                    const values = parsed.values.map(v => typeof v === 'number' ? v : parseInt(v));
                    inst.tableData = values.join(", ");
                    inst.tableSize = values.length;
                    inst.jsonParseError = "";

                    // Optionally update dataType if provided in JSON and valid
                    if (parsed.dataType && ['byte', 'ushort', 'uint'].includes(parsed.dataType)) {
                        inst.dataType = parsed.dataType;
                    }

                } catch (e) {
                    inst.jsonParseError = "JSON parse error: " + e.message + ". Check that your JSON is properly formatted.";
                }
            }
        },
        {
            name: "jsonParseError",
            displayName: "",
            default: "",
            hidden: true
        },
        {
            name: "jsonParseStatus",
            displayName: "Import Status",
            default: "",
            hidden: true,
            getValue: (inst) => {
                if (inst.jsonParseError && inst.jsonParseError !== "") {
                    return "Error: " + inst.jsonParseError;
                }
                if (inst.importMethod === "json_paste" && inst.tableData && inst.tableData.split(',').length === inst.tableSize) {
                    return "Successfully imported " + inst.tableSize + " values";
                }
                return "";
            }
        },
        {
            name: "loadJsonFromFile",
            displayName: "Load Lookup Table From JSON File",
            description: "Browse and select a JSON file containing the lookup table values",
            buttonText: "Browse For JSON File",
            fileFilter: ".json",
            pickDirectory: false,
            nonSerializable: true,
            hidden: true,
            onLaunch: (inst) => {
                return {
                    command: copyCmd,
                    args: copyArgs,
                    initialData: "initialData",
                    inSystemPath: true,
                };
            },
            onComplete: (inst, _ui, result) => {
                if (result.data === "error") {
                    inst.jsonFileError = "ERROR LOADING FILE";
                    return;
                } else if (result.data === "initialData") {
                    inst.jsonFileError = "ERROR RUNNING SCRIPT";
                    return;
                } else {
                    if (typeof result.data !== 'string') {
                      inst.jsonFileError = "ERROR: Invalid file data format";
                       return;
                    }
                    let jsonData = null;

                    try {
                        jsonData = JSON.parse(result.data);
                    } catch (e) {
                        inst.jsonFileError = "ERROR PARSING JSON: " + e.message;
                        return;
                    }

                    // Validate required structure
                    if (typeof jsonData !== 'object' || jsonData === null) {
                        inst.jsonFileError = 'JSON must be an object with "values" field';
                        return;
                    }

                    if (!jsonData.hasOwnProperty('values')) {
                        inst.jsonFileError = 'JSON must contain "values" field. Example: {"values": [1, 2, 3, 4]}';
                        return;
                    }

                    if (!Array.isArray(jsonData.values)) {
                        inst.jsonFileError = '"values" must be an array';
                        return;
                    }

                    if (jsonData.values.length === 0) {
                        inst.jsonFileError = '"values" array is empty';
                        return;
                    }

                    // Validate all values are numbers
                    const invalidIndices = [];
                    jsonData.values.forEach((v, idx) => {
                        if (typeof v !== 'number' && isNaN(parseInt(v))) {
                            invalidIndices.push(idx);
                        }
                    });

                    if (invalidIndices.length > 0) {
                        const examples = invalidIndices.slice(0, 3).map(i => `index ${i}: "${jsonData.values[i]}"`).join(', ');
                        inst.jsonFileError = `Found ${invalidIndices.length} non-numeric value(s). Examples: ${examples}`;
                        return;
                    }

                    // Success! Import the data
                    const values = jsonData.values.map(v => typeof v === 'number' ? v : parseInt(v));
                    inst.tableData = values.join(", ");
                    inst.tableSize = values.length;
                    inst.jsonFileError = "";

                    // Optionally update dataType if provided in JSON and valid
                    if (jsonData.dataType && ['byte', 'ushort', 'uint'].includes(jsonData.dataType)) {
                        inst.dataType = jsonData.dataType;
                    }
                }
            }
        },
        {
            name: "jsonFileError",
            displayName: "",
            default: "",
            hidden: true
        },
        {
            name: "jsonFileStatus",
            displayName: "Import Status",
            default: "",
            hidden: true,
            getValue: (inst) => {
                if (inst.jsonFileError && inst.jsonFileError !== "") {
                    return "Error: " + inst.jsonFileError;
                }
                if (inst.importMethod === "json_file" && inst.tableData && inst.tableData.split(',').length === inst.tableSize) {
                    return "Successfully loaded " + inst.tableSize + " values from JSON file";
                }
                return "";
            }
        },
        {
            name: "jsonFileFormatExample",
            displayName: "Required JSON File Format",
            description: "Your JSON file should follow this format",
            default: "",
            readOnly: true,
            hidden: true,
            getValue: function (inst) {
                let exampleValues = [];
                const currentData = inst.tableData ? inst.tableData.split(',').map(v => v.trim()) : [];

                // Show first 8 values as example
                if (currentData.length > 0) {
                    exampleValues = currentData.slice(0, Math.min(8, currentData.length));
                } else {
                    exampleValues = [0, 1, 2, 3, 4, 5, 6, 7];
                }

                const hasMore = inst.tableSize > 8;

                return `Save a JSON file with this format:

{
  "values": [${exampleValues.join(', ')}${hasMore ? ', ...' : ''}],
  "dataType": "${inst.dataType}"
}

Required:
- "values" field with array of ${inst.tableSize} numbers
Optional:
- "dataType" field (auto-sets to "${inst.dataType}")

Then click "Browse For JSON File" button above to select it.`;
            }
        },
        {
            name: "initPattern",
            displayName: "Initialize Pattern",
            description: "Choose how to initialize the table values",
            options: [
                { name: "manual", displayName: "Manual Entry (Comma Separated)" },
                { name: "sequential", displayName: "Sequential (0, 1, 2, ...)" },
                { name: "zeros", displayName: "All Zeros" },
                { name: "ones", displayName: "All Ones (0xFF/0xFFFF/0xFFFFFFFF Based On Data Type)" },
                { name: "custom", displayName: "Fill With Custom Value" }
            ],
            default: "sequential",
            onChange: function (inst, ui) {
                // Auto-generate tableData based on pattern
                if (inst.initPattern !== "manual") {
                    let values = [];
                    let fillValue;

                    switch (inst.initPattern) {
                        case "zeros":
                            fillValue = 0;
                            break;
                        case "ones":
                            if (inst.dataType === "byte") fillValue = 0xFF;
                            else if (inst.dataType === "ushort") fillValue = 0xFFFF;
                            else fillValue = 0xFFFFFFFF;
                            break;
                        case "custom":
                            fillValue = inst.customValue || 0;
                            break;
                        case "sequential":
                        default:
                            fillValue = null; // Handle separately
                            break;
                    }

                    for (let i = 0; i < inst.tableSize; i++) {
                        if (inst.initPattern === "sequential") {
                            values.push(i);
                        } else {
                            values.push(fillValue);
                        }
                    }

                    inst.tableData = values.join(", ");
                }

                // Show/hide custom value field
                ui.customValue.hidden = (inst.initPattern !== "custom");
            }
        },
        {
            name: "customValue",
            displayName: "Custom Fill Value",
            description: "Value to fill all table entries with",
            default: 0,
            displayFormat: "hex",
            hidden: true,
            onChange: function (inst, ui) {
                // When custom value changes and custom pattern is selected, regenerate table
                if (inst.initPattern === "custom") {
                    let values = [];
                    for (let i = 0; i < inst.tableSize; i++) {
                        values.push(inst.customValue || 0);
                    }
                    inst.tableData = values.join(", ");
                }
            }
        },
        {
            name: "tableData",
            displayName: "Table Data",
            description: "Enter comma-separated values for your lookup table",
            default: "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15",
            longDescription: "You can manually edit these values or use the Initialize Pattern option above to auto-generate them"
        },
        {
            name: "manualDataPreview",
            displayName: "Format Example",
            description: "Example format for comma-separated values",
            default: "",
            readOnly: true,
            hidden: false,
            getValue: function (inst) {
                // Generate example values based on table size
                let exampleValues = [];
                const showCount = Math.min(16, inst.tableSize);

                for (let i = 0; i < showCount; i++) {
                    exampleValues.push(i);
                }

                const hasMore = inst.tableSize > showCount;

                return `${exampleValues.join(', ')}${hasMore ? ', ...' : ''}`;
            }
        },

        {
            name: "dataType",
            displayName: "Data Type",
            options: [
                {
                    name: "byte",
                    displayName: "8-bit (0-255)",
                },
                {
                    name: "ushort",
                    displayName: "16-bit (0-65535)",
                },
                {
                    name: "uint",
                    displayName: "32-bit",
                }
            ],
            default: "byte",
        },
        {
            name: "opCode",
            displayName: "LUT",
            hidden: true,
            default: "",
        },
        {
            name: "constant1",
            displayName: "lookUpTableOffset",
            default: "",
            hidden: true,
            getValue: (inst) => {
                return inst.$name;
            }
        },
        {
            name: "lutName",
            hidden: true,
            default: "",
            getValue: (inst) => {
                return inst.$name;
            }
        },
        {
            name: "output1Size",
            default: "0",
            hidden: true,
            getValue: (inst) => {
                return "0";
            }
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            default: 0,
            getValue: (inst) => {
                // Lookup table is data definition only, no executable code
                return 0;
            }
        }
    ],
    ports: (inst) => {
        let ports = [];

        ports.push({ name: "prev", type: "PREV" })
        ports.push({ name: "next", type: "NEXT" })

        for (let iterator = 1; iterator <= inst["numOfOutputPorts"]; iterator++) {
            ports.push({ name: "output" + iterator.toString(), type: "output" })
        }

        return ports
    },
    moduleStatic: {
        modules: function (inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        }
    },
    getDataSize,
    getMacro,
    validate,
    getLookUptable,
}