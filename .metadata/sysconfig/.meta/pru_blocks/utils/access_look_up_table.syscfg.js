// function getLookUptable(instance) {
//     return instance["tableData"];
// }
function getReferencedLUT(inst) {
    // If user explicitly selected a LUT from the dropdown, use that
    if (inst.lutReference && inst.lutReference !== "") {
        const lutModule = system.modules["/pru_blocks/utils/look_up_table"];
        if (lutModule && lutModule.$instances) {
            const found = lutModule.$instances.find(lut => lut.$name === inst.lutReference);
            if (found) return found;
        }
    }
    // Fall back to the auto-created shared LUT
    if (inst.lutTable) {
        return inst.lutTable;
    }
    return null;
}

function getLookupTables(){
    let options = [];
    const lutModule = system.modules["/pru_blocks/utils/look_up_table"];
    if (lutModule && lutModule.$instances) {
        options = lutModule.$instances.map(lutInst => ({
            name: lutInst.$name,
            displayName: lutInst.$name
        }));
    }
    return options;
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
    const referencedLUT = getReferencedLUT(inst);
    if (!referencedLUT) {
        report.logError("Please select a lookup table to access", inst);
        return;
    }
    if (inst["input1"].length == 0) {
        report.logWarning("LUT input is not connected", inst);
    }
    else {
        // Validate that input index is within bounds [0, tableSize-1]
        const inputInst = inst["input1"][0]["inst"];
        if (inputInst && inputInst["constant1"] !== undefined) {
            const inputValue = parseInt(inputInst["constant1"], 10);
            const tableSize = referencedLUT["tableSize"];
            if (!isNaN(inputValue)) {
                if (inputValue < 0) {
                    report.logError(`LUT index ${inputValue} is negative. Valid range is [0, ${tableSize - 1}]`, inst);
                }
                else if (inputValue >= tableSize) {
                    report.logError(`LUT index ${inputValue} is out of bounds. Valid range is [0, ${tableSize - 1}]`, inst);
                }
            }
        }
    }
}
function getMacro(pruInstructionMacro, opCode) {
    let macroBody = "";

    // Extract the macro name and parameters from the pruInstructionMacro
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode; // First part or opCode is the macro name
    const result = parts[1] || "result"; // Second part is result register
    const index = parts[2] || "index";   // Third part is index register
    const lutAddress = parts[3] || "lutAddress"; // Fourth part is lutAddress
    const byteSize = parts[4] || "byteSize"; // Fifth part is showing the number of byte size of the data

    if (pruInstructionMacro == "") {
        macroBody = macroName + "	" + ".macro  " + result + ", " + index + ", " + lutAddress + ", " + byteSize + "\n";
		// Add parameter documentation
		macroBody += `	; Parameters:
	;   result      - Destination register to store the looked-up value
	;   index       - Index register containing table position (0 to tableSize-1)
	;   lutAddress  - Base address of the lookup table in memory
	;   byteSize    - Size of each table entry in bytes (1, 2, or 4)
`;
    }
    if (macroName && macroName.trim().startsWith("m_lookup_table")) {
        macroBody += `    LDI32   TEMP_REG1, ${lutAddress}
    LBBO    &${result}, TEMP_REG1, ${index}, ${byteSize}`;
    }

    if (pruInstructionMacro == "") {
        macroBody += "\n" + " .endm";
    }

    return macroBody;
}

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Access Lookup Table block in a .syscfg file.

### Adding an Access Lookup Table Instance

\\\`\\\`\\\`javascript
const access_look_up_table = scripting.addModule("/pru_blocks/utils/access_look_up_table", {}, false);
const access_lut1 = access_look_up_table.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| lutReference | String | Name of a Lookup Table instance | "" | Which Lookup Table to read from |

### Example Configurations

**Read from a lookup table:**
\\\`\\\`\\\`javascript
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
\\\`\\\`\\\`

### Connecting to Other Blocks

\\\`\\\`\\\`javascript
// Connect index source to input (index port)
scripting.connect(load_constant1, "output1", access_lut1, "input1");

// Connect output to downstream block
scripting.connect(access_lut1, "output1", uart_tx1, "input1");

// Connect control flow
scripting.connect(prev_block, "next", access_lut1, "prev");
scripting.connect(access_lut1, "next", next_block, "prev");
\\\`\\\`\\\`

### Important Notes

1. **Requires Lookup Table**: A Lookup Table block must exist and be referenced by lutReference.

2. **Index Input**: Connect a block that provides the index value (0 to tableSize-1) to input1.

3. **Output Size**: Automatically matches the referenced Lookup Table's dataType (1, 2, or 4 bytes).

4. **Bounds Checking**: Validation warns if constant index is out of bounds. Runtime bounds checking is not performed.

5. **Performance**: 5 PRU cycles total (2 for LDI32 + 3 for LBBO).
`;
}

function getLongDescription() {
    return `
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
- LDI32   TEMP_REG1, \`LUT_BASE_ADDRESS\`    ; Load table base address (2 cycles)
- LBBO    &result, TEMP_REG1, index, size  ; Load data from PRU DRAM (3 cycles for ≤4 bytes)

**Performance**: 5 PRU cycles total (assuming word-aligned access to PRU DRAM)
- LDI32: 2 cycles
- LBBO: 3 cycles (2 + N where N=1 for reading ≤4 bytes)

Note: Add +1 cycle if index results in non-word-aligned address

**Terminology**:
- **LBBO**: Load Byte Burst from Offset - reads 1/2/4 bytes from memory
- **DMEM**: PRU Data Memory - 8KB local RAM in each PRU core
- **Index**: Zero-based position in the table (must be less than table size)

---`;
}

exports = {
    displayName: "Access Lookup Table",
    defaultInstanceName: "Access_Lookup_Table_",
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
            default: 1,
            hidden: true,
        },
        {
            name: "numOfOutputPorts",
            default: 1,
            hidden: true
        },
        {
            name: "numOfConstants",
            default: 2,
            hidden: true
        },
        {
            name: "opCode",
            displayName: "LUT",
            hidden: true,
            default: "m_lookup_table",
        },
        {
            name: "constant1",
            displayName: "lookUpTableOffset",
            default: "",
            hidden: true,
            getValue: (inst) => {
                const lut = getReferencedLUT(inst);
                return lut ? lut.$name : "";
            }
        },
        {
            name: "constant2",
            displayName: "byteSize",
            default: "",
            hidden: true,
            getValue: (inst) => {
                const lut = getReferencedLUT(inst);
                if (lut) {
                    if (lut["dataType"] == "byte")   return "1";
                    if (lut["dataType"] == "ushort") return "2";
                    if (lut["dataType"] == "uint")   return "4";
                }
                return "1";
            }
        },
        {
            name: "lutReference",
            displayName: "Lookup Table Selected",
            description: "Which lookup table is selected to access",
            default: "",
            getValue: (inst) => {
                // Only fall back to auto-created LUT when user hasn't picked one yet
                if (inst.lutTable) {
                    return inst.lutTable.$name;
                }
                return "";
            },
            options: (inst) => {
                // Get all available LOOKUP_TABLE instances
                let options = [];
                const lutModule = system.modules["/pru_blocks/utils/look_up_table"];
                if (lutModule && lutModule.$instances) {
                    options = lutModule.$instances.map(lutInst => ({
                        name: lutInst.$name,
                        displayName: lutInst.$name
                    }));
                }
                return options;
            }
        },
        {
            name: "output1Size",
            default: "0",
            hidden: true,
            getValue: (inst) => {
                const lut = getReferencedLUT(inst);
                if (lut) {
                    if (lut["dataType"] == "byte")   return "1";
                    if (lut["dataType"] == "ushort") return "2";
                    if (lut["dataType"] == "uint")   return "4";
                }
                return "0";
            }
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            default: 1,
            getValue: (inst) => {
                // LDI32 takes 2 cycles (loads 32-bit value as two 16-bit moves)
                // LBBO from PRU DRAM takes 2 + N cycles where N is number of 4-byte words
                // For 1, 2, or 4 bytes (all ≤4 bytes): N = 1, so LBBO takes 2 + 1 = 3 cycles
                // Total: 2 (LDI32) + 3 (LBBO) = 5 cycles
                // Note: This assumes word-aligned access. Add +1 if non-aligned.
                return 5;
            }
        }
    ],
    ports: (inst) => {
        let ports = [];

        ports.push({ name: "input1", displayName: "index", type: "input" })

        ports.push({ name: "prev", type: "PREV" })
        ports.push({ name: "next", type: "NEXT" })

        ports.push({ name: "output1", displayName: "dout", type: "output" })

        return ports
    },
    sharedModuleInstances: (inst) => {
        return [
            {
                name: "lutTable",
                displayName: "Lookup Table",
                moduleName: "/pru_blocks/utils/look_up_table",
                collapsed: false,
            }
        ];
    },
    moduleStatic: {
        modules: function (inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        }
    },
    getMacro,
    validate,
}