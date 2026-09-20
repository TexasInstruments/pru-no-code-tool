/**
 * Data Splitter Block
 *
 * Takes a 64-bit input (two consecutive registers) and outputs either
 * the lower 32 bits or upper 32 bits as a single 32-bit output.
 */

function getMacro(pruInstructionMacro, opCode) {
    const isUpper = opCode.includes("_upper");

    if (pruInstructionMacro === "") {
        let macroBody = opCode + "\t.macro  dataOut, dataRegLo, dataRegHi\n";
        macroBody += `\t; Data Splitter — extract ${isUpper ? "upper" : "lower"} 32 bits from 64-bit input
\t;   dataOut   - Destination register (32-bit output)
\t;   dataRegLo - Lower 32 bits of 64-bit input
\t;   dataRegHi - Upper 32 bits of 64-bit input
\tmov     dataOut, ${isUpper ? "dataRegHi" : "dataRegLo"}
`;
        macroBody += " .endm";
        return macroBody;
    }

    return pruInstructionMacro;
}

function getLongDescription() {
    return `
## Data Splitter Block

### Purpose
Extracts the lower or upper 32 bits from a 64-bit input (two consecutive registers).
Connect the output of a 64-bit block (e.g. UART RX Op in extended mode, Memory Access
with dataSize > 4) to this block's input, and select which half you need.

### Generated Assembly
**Lower 32 bits:**
\`\`\`assembly
MOV  R_out, dataRegLo   ; copy lower register
\`\`\`

**Upper 32 bits:**
\`\`\`assembly
MOV  R_out, dataRegHi   ; copy upper register
\`\`\`

### Ports
- **in64**: 64-bit data input (two consecutive registers)
- **out32**: 32-bit data output (selected half)

### Configuration
- **Split Select**: Choose \`lower\` (bits 31:0) or \`upper\` (bits 63:32)
`;
}

exports = {
    displayName: "Data Splitter",
    defaultInstanceName: "Data_Splitter_",
    longDescription: getLongDescription(),
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
            name: "splitSelect",
            displayName: "Split Select",
            description: "Select which 32-bit half of the 64-bit input to output",
            default: "lower",
            options: [
                { name: "lower", displayName: "Lower 32 bits (bits 31:0)" },
                { name: "upper", displayName: "Upper 32 bits (bits 63:32)" },
            ]
        },
        // ===== HIDDEN CODE GEN FIELDS =====
        {
            name: "opCode",
            displayName: "m_data_splitter",
            default: "m_data_splitter_lower",
            hidden: true,
            getValue: (inst) => {
                return inst.splitSelect === "upper"
                    ? "m_data_splitter_upper"
                    : "m_data_splitter_lower";
            }
        },
        {
            name: "outputReg",
            default: "",
            hidden: true
        },
        {
            name: "numOfInputPorts",
            default: 1,
            hidden: true
        },
        {
            name: "numOfOutputPorts",
            default: 1,
            hidden: true
        },
        {
            name: "numOfConstants",
            default: 0,
            hidden: true
        },
        {
            name: "input1Size",
            default: 8,
            hidden: true
        },
        {
            name: "output1Size",
            default: 4,
            hidden: true
        },
        {
            name: "noOfCycles",
            displayName: "Number Of Cycles",
            default: 1,
            getValue: (_inst) => 1
        },
    ],
    ports: (_inst) => [
        { name: "input1",  type: "input64", displayName: "in64"  },
        { name: "output1", type: "output32" },
        { name: "prev",    type: "PREV"     },
        { name: "next",    type: "NEXT"     },
    ],
    getMacro,
    moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }];
        },
    },
}
