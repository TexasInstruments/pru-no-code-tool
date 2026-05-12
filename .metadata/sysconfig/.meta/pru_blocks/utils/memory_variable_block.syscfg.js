/**
 * Memory Variable Block
 *
 * Reserves uninitialized memory in .bss section using .usect directive.
 * Does not produce any runtime code - only memory declaration.
 */

function validate(inst, report) {
    // Validate label name
    if (!inst.labelName || inst.labelName.trim() === "") {
        report.logError("Label name cannot be empty", inst, "labelName");
    } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inst.labelName)) {
        report.logError("Label name must start with a letter or underscore and contain only letters, numbers, and underscores", inst, "labelName");
    }

    // Validate size
    if (inst.sizeInBytes < 1 || inst.sizeInBytes > 8192) {
        report.logError("Size must be between 1 and 8192 bytes", inst, "sizeInBytes");
    }

    // Validate alignment (must be power of 2)
    if (inst.alignment !== 0) {
        const isPowerOf2 = (inst.alignment & (inst.alignment - 1)) === 0;
        if (!isPowerOf2 || inst.alignment < 1) {
            report.logError("Alignment must be a power of 2 (1, 2, 4, 8, 16, etc.) or 0 for no alignment", inst, "alignment");
        }
    }
}

function getMacro(pruInstructionMacro, opCode) {
    // This block doesn't generate any runtime code
    return "; Memory reserved via .usect directive";
}

/**
 * Returns the .usect directive for this memory reservation
 * Called by the template to generate the assembly declaration
 */
function getUsectDirective(instance) {
    const labelName = instance.labelName;
    const sizeInBytes = instance.sizeInBytes;
    const sectionName = instance.sectionName || ".bss";

    // Always use 4-byte alignment (word-aligned)
    return `${labelName}\t.usect "${sectionName}", ${sizeInBytes}, 4`;
}

function getAIContext() {
    return getLongDescription() + `

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Memory Variable block in a .syscfg file.

### Adding a Memory Variable Instance

\\\`\\\`\\\`javascript
const memory_variable = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);
const mem_variable1 = memory_variable.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| labelName | String | Valid C identifier | "buffer" | Symbol name for the reserved memory |
| sizeInBytes | Integer | 1-8192 | 64 | Number of bytes to reserve |
| memoryLocation | String | "dmem" or "smem" | "dmem" | Memory location (DMEM=local, SMEM=shared) |

### Example Configurations

**Local buffer in DMEM:**
\\\`\\\`\\\`javascript
mem_variable1.$name = "Memory_Variable_0";
mem_variable1.labelName = "rxBuffer";
mem_variable1.sizeInBytes = 128;
mem_variable1.memoryLocation = "dmem";
\\\`\\\`\\\`

**Shared buffer in SMEM:**
\\\`\\\`\\\`javascript
mem_variable1.$name = "Shared_Buffer";
mem_variable1.labelName = "ipcBuffer";
mem_variable1.sizeInBytes = 512;
mem_variable1.memoryLocation = "smem";
\\\`\\\`\\\`

### Using with Memory Access Block

\\\`\\\`\\\`javascript
// Create Memory Reserve in DMEM
const memory_variable = scripting.addModule("/pru_blocks/utils/memory_variable_block", {}, false);
const mem_variable1 = memory_variable.addInstance();
mem_variable1.$name = "Memory_Variable_0";
mem_variable1.labelName = "my_buffer";
mem_variable1.sizeInBytes = 64;
mem_variable1.memoryLocation = "dmem";

// Create Memory Access that references the symbol
const memory_load_block = scripting.addModule("/pru_blocks/data_handling/memory_load_block", {}, false);
const mem_access1 = memory_load_block.addInstance();
mem_access1.$name = "Memory_Access_0";
mem_access1.operationMode = "write";
mem_access1.addressingMode = "symbol";
mem_access1.symbolSelect = "my_buffer";    // References the labelName above
mem_access1.dataSize = 4;
\\\`\\\`\\\`

### Important Notes

1. **Label Name Rules**: Must start with a letter or underscore, and contain only letters, numbers, and underscores.

2. **No Runtime Code**: This block only generates a .usect directive - no executable instructions.

3. **Alignment**: Memory is always 4-byte (word) aligned for optimal PRU access.

4. **Uninitialized**: Reserved memory has undefined contents at startup. Use Lookup Table block for initialized data.

5. **Memory Location**:
    - **DMEM (Local)**: 8 KB per PRU, fastest access, private to each PRU
    - **SMEM (Shared)**: 64 KB total, accessible by all PRUs and ARM cores, use for inter-core communication
`;
}

function getLongDescription() {
    return `
## Memory Variable Block

### Purpose
Reserves uninitialized memory space in a named section using the \`.usect\` directive. This is useful for declaring buffers, arrays, or any memory that doesn't need initialization at compile time.

### How It Works
1. **No Runtime Code**: This block only generates a memory reservation directive - no executable code
2. **Uninitialized**: The reserved memory has no initial contents (undefined values at startup)
3. **Named Section**: Memory is placed in a user-specified section (default: .bss)
4. **Linker Placement**: The linker determines the actual memory address based on the linker command file

### Configuration

**Label Name**
- The symbol name that points to the first byte of reserved memory
- Must start with a letter or underscore
- Can contain letters, numbers, and underscores
- Example: \`my_buffer\`, \`_data_array\`, \`rxBuffer1\`

**Size in Bytes**
- Number of bytes to reserve (1 to 8192)
- Example: 256 for a 256-byte buffer

**Memory Location**
- Choose where to allocate the memory:
- **DMEM (Local)**: Allocated in local PRU Data RAM (8 KB, fast access)
- **SMEM (Shared)**: Allocated in Shared RAM (64 KB, accessible by all PRUs and ARM cores)
- Default: DMEM (Local)

**Alignment** (Optional)
- Ensures the memory starts on a specific boundary
- Fixed to 4 bytes (word-aligned) for optimal PRU access
- Example: 4 for 4-byte (word) alignment

### Generated Assembly
\`\`\`assembly
; Example in DMEM (Local)
myBuffer    .usect ".udmem", 256, 4

; Example in SMEM (Shared)
sharedData  .usect ".usmem", 512, 4
\`\`\`

### .usect Directive Syntax
\`\`\`
symbol .usect "section name", size in bytes[, alignment]
\`\`\`

- **symbol**: Label pointing to first byte of reserved space
- **section name**: Name of uninitialized section (in quotes)
- **size in bytes**: Number of bytes to reserve
- **alignment**: Optional boundary alignment (power of 2)

### Usage Examples

**Example 1: Local Buffer in DMEM**
\`\`\`
Label: rxBuffer
Size: 128 bytes
Memory Location: DMEM (Local)

Generated: rxBuffer .usect ".udmem", 128, 4
\`\`\`

**Example 2: Shared Buffer in SMEM**
\`\`\`
Label: sharedData
Size: 512 bytes
Memory Location: SMEM (Shared)

Generated: sharedData .usect ".usmem", 512, 4
\`\`\`

**Example 3: Large Shared Buffer**
\`\`\`
Label: ipcBuffer
Size: 2048 bytes
Memory Location: SMEM (Shared)

Generated: ipcBuffer .usect ".usmem", 2048, 4
\`\`\`

### Accessing Reserved Memory

To access the reserved memory in your PRU code:
\`\`\`assembly
; Load address of reserved memory into register
LDI32   R0, myBuffer

; Write a byte to the buffer
SBBO    &R1, R0, 0, 1

; Read 4 bytes from offset 8
LBBO    &R2, R0, 8, 4
\`\`\`

### Differences from Lookup Table Block

| Feature | Memory Variable | Lookup Table |
|---------|---------------|--------------|
| Initialization | Uninitialized | Initialized with data |
| Directive | .usect | .data section |
| Use Case | Runtime buffers | Pre-computed values |
| Content | Undefined at start | User-defined values |

### Memory Considerations
- PRU DMEM is 8KB per core - plan your memory usage accordingly
- Multiple Memory Variable blocks can be used for different buffers
- The linker places all .bss sections together unless you use custom sections
- For initialized data, use the Lookup Table block instead

### Terminology
- **.usect**: Assembler directive to reserve Uninitialized SECTion space
- **.bss**: Block Started by Symbol - standard section for uninitialized data
- **Alignment**: Memory boundary constraint (addresses divisible by alignment value)
- **DMEM**: PRU Data Memory - 8KB local RAM in each PRU core

---`;
}

exports = {
    displayName: "Memory Variable",
    defaultInstanceName: "Memory_Variable_",
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
            name: "labelName",
            displayName: "Label Name",
            description: "Symbol name for the reserved memory (e.g., myBuffer, dataArray)",
            default: "buffer",
        },
        {
            name: "sizeInBytes",
            displayName: "Size in Bytes",
            description: "Number of bytes to reserve (1 to 8192)",
            default: 64,
        },
        {
            name: "memoryLocation",
            displayName: "Memory Location",
            description: "Choose where to allocate the memory",
            default: "dmem",
            options: [
                {
                    name: "dmem",
                    displayName: "DMEM (Local)"
                },
                {
                    name: "smem",
                    displayName: "SMEM (Shared)"
                }
            ]
        },
        {
            name: "alignment",
            displayName: "Alignment",
            description: "Memory alignment boundary (fixed to 4 bytes / word-aligned)",
            default: 1,
            hidden: true,
        },
        {
            name: "sectionName",
            displayName: "Section Name",
            description: "Name of the section to place memory in",
            default: ".udmem",
            hidden: true,
            getValue: (inst) => {
                // Use .udmem/.usmem for uninitialized data (defined in linker.cmd)
                // Avoids conflict with .initdmem/.initsmem used for initialized data
                return inst.memoryLocation === "dmem" ? ".udmem" : ".usmem";
            }
        },
        {
            name: "opCode",
            displayName: "Memory Variable",
            hidden: true,
            default: "",
        },
        {
            name: "memoryLabel",
            hidden: true,
            default: "",
            getValue: (inst) => {
                return inst.labelName;
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
                // Memory reserve is declaration only, no executable code
                return 0;
            }
        }
    ],
    ports: (inst) => {
        let ports = [];

        ports.push({ name: "prev", type: "PREV" })
        ports.push({ name: "next", type: "NEXT" })

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
    getMacro,
    validate,
    getUsectDirective,
}
