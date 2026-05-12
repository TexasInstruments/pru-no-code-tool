function    getCrcNumber(crcType)
{
	if(crcType == "m_calculate_crc8")
	{
		return 8;
	}
	if(crcType == "m_calculate_crc16")
	{
		return 16;
	}
	if(crcType == "m_calculate_crc32")
	{
		return 32;
	}
}
function    getDataSize(instance)
{
	let crcType = instance["opCode"]
	if(crcType == "m_calculate_crc8")
	{
		return ".byte";
	}
	if(crcType == "m_calculate_crc16")
	{
		return ".ushort";
	}
	if(crcType == "m_calculate_crc32")
	{
		return ".uint";
	}
}
function    getLookUptable(instance)
{
	let generator = instance["crcPolynomial"];
	let crcType = instance["opCode"];
    let crcValues = [];  // Store values in an array first
    let crcNum = getCrcNumber(crcType);
    let crcMsbMask = Math.pow(2, (crcNum - 1));
    
    for(let dividend = 0; dividend < 256; dividend++)
    {
        let curByte = (dividend << (crcNum - 8));
        for(let bit = 0; bit < 8; bit++)
        {
            if((curByte & crcMsbMask) != 0)
            {
                curByte = curByte << 1;
                curByte = curByte ^ generator;
            }
            else
            {
                curByte = curByte << 1;
            }
        }
        // Add each value to the array
        crcValues.push(curByte & (Math.pow(2, crcNum) - 1));
    }

    // Join with comma and space (no reversal)
    return crcValues.join(", ");
}

function validate(inst, report) {
	if(inst["input1"].length == 0)
	{
		report.logWarning("crc is not intialized",inst)	
	}
	else
	{
		if(inst["crc_intialization"] == "zeros")
		{
			if(inst["input1"][0]["inst"]["constant1"] != 0)
			{
				report.logWarning("crc is not intialized with zero's",inst)		
			}
			if(inst["crcType"] == "m_calculate_crc8")
			{
				if(inst["crcPolynomial"] > 0xFF || inst["crcPolynomial"] < 0)
				{
					report.logWarning("crc polynomial not in range (0, 0xFF)",inst)
				}
			}
			if(inst["crcType"] == "m_calculate_crc16")
			{
				if(inst["crcPolynomial"] > 0xFFFF || inst["crcPolynomial"] < 0)
				{
					report.logWarning("crc polynomial not in range (0, 0xFFFF)",inst)
				}
			}
			if(inst["crcType"] == "m_calculate_crc32")
			{
				if(inst["crcPolynomial"] > 0xFFFFFFFF || inst["crcPolynomial"] < 0)
				{
					report.logWarning("crc polynomial not in range (0, 0xFFFFFFFF)",inst)
				}
			}
		}
		else
		{
			if(JSON.parse(JSON.stringify(inst["input1"][0]["inst"])).$module != "/pru_blocks/application_specific/crc_block")
			{
				report.logWarning("crc is not intialized form crc block",inst)		
			}	
		}
	}	
	if(inst["input2"].length == 0)
	{
		report.logWarning("input data not found",inst)	
	}else
	{
		if(inst["input2"][0]["inst"]["output1Size"]!=1)
		{
			report.logWarning("input data size greater than 255",inst)
		}
	}	
	
}

/**
 * Returns the body of a specific macro based on the macro name with parameters replaced
 * @param {string} pruInstructionMacro - The macro instruction string that contains the macro name and parameters
 * @param {Object} instance - The instance object containing configuration
 * @returns {string} The full macro body as a string with parameters replaced
 */
function getMacro(pruInstructionMacro, opCode)
{
    let macroBody = "";
    
    // Extract the macro name and parameters from the pruInstructionMacro
    const parts = pruInstructionMacro.trim().split(/\s*,\s*|\s+/);
    const macroName = parts[0] || opCode; // First part or opCode is the macro name
    const crcResult = parts[1] || "crcResult"; // Second part is crcResult
    const crcInit = parts[2] || "crcInit";   // Third part is crcInit
    const dataByte = parts[3] || "dataByte";  // Fourth part is dataByte
    const lutAddress = parts[4] || "lutAddress"; // Fifth part is lutAddress

    if(pruInstructionMacro == "")
    {
		macroBody = macroName + "	" + ".macro  " + crcResult + ", " + crcInit + ", " + dataByte + ", " + lutAddress + "\n";
		// Add parameter documentation
		macroBody += `	; Parameters:
	;   crcResult   - Register to store the calculated CRC value
	;   crcInit     - Register containing the initial/previous CRC value
	;   dataByte    - Register containing the input data byte to process
	;   lutAddress  - Address of the CRC lookup table in memory
`;
	}

	if (macroName && macroName.trim().startsWith("m_calculate_crc8")) {
        macroBody += `    LDI32   TEMP_REG1, ${lutAddress}
    XOR     TEMP_REG2.b0, ${crcInit}, ${dataByte}
    LBBO    &${crcResult}, TEMP_REG1, TEMP_REG2.b0, 1`;
    }
	
    if (macroName && macroName.trim().startsWith("m_calculate_crc16")) {
        macroBody += `    LDI32   TEMP_REG1, ${lutAddress}
    LSR     TEMP_REG2.b0, ${crcInit}, 8
    XOR     TEMP_REG2.b0, TEMP_REG2.b0, ${dataByte}
    LBBO    &${crcResult}, TEMP_REG1, TEMP_REG2.b0, 2
    LSL     TEMP_REG2, ${crcInit}, 8
    XOR     ${crcResult}, TEMP_REG2.w0, ${crcResult}`;
    }
    if (macroName && macroName.trim().startsWith("m_calculate_crc32")) {
        macroBody += `    LDI32   TEMP_REG1, ${lutAddress}
    LSR     TEMP_REG2.b0, ${crcInit}, 24
    XOR     TEMP_REG2.b0, TEMP_REG2.b0, ${dataByte}
    LBBO    &${crcResult}, TEMP_REG1, TEMP_REG2.b0, 4
    LSL     TEMP_REG2,  ${crcInit}, 8
    XOR     ${crcResult}, TEMP_REG2, ${crcResult}`;
    }
	
	if(pruInstructionMacro == "")
    {
		macroBody += "\n" + " .endm";	
	}
    
    return macroBody;
}

function getAIContext(){
	return getLongDescription() + `
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the CRC block in a .syscfg file.

### Adding a CRC Instance

\`\`\`javascript
const crc_block = scripting.addModule("/pru_blocks/application_specific/crc_block", {}, false);
const crc1 = crc_block.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| opCode | String | "m_calculate_crc8", "m_calculate_crc16", "m_calculate_crc32" | "m_calculate_crc8" | CRC algorithm type |
| crcPolynomial | Hex | Depends on CRC type | 0x07 | CRC polynomial (generator) |
| output1Size | String | "1", "2", "4" | "1" | Output size in bytes |

### Valid CRC Types and Polynomials

| CRC Type | Default Polynomial | Common Polynomials | Description |
|----------|-------------------|-------------------|-------------|
| CRC8 | 0x07 | 0x07, 0x31, 0x9B | 8-bit CRC (1 byte output) |
| CRC16 | 0x8005 | 0x8005, 0x1021, 0x8408 | 16-bit CRC (2 byte output) |
| CRC32 | 0x04C11DB7 | 0x04C11DB7, 0xEDB88320 | 32-bit CRC (4 byte output) |

### Example Configurations

**Standard CRC8:**
\`\`\`javascript
crc1.$name = "CRC8_Check";
crc1.opCode = "m_calculate_crc8";
crc1.crcPolynomial = 0x07;
crc1.output1Size = "1";
\`\`\`

**CRC16 for MODBUS:**
\`\`\`javascript
crc1.$name = "CRC16_MODBUS";
crc1.opCode = "m_calculate_crc16";
crc1.crcPolynomial = 0x8005;
crc1.output1Size = "2";
\`\`\`

**CRC32 for Ethernet:**
\`\`\`javascript
crc1.$name = "CRC32_Ethernet";
crc1.opCode = "m_calculate_crc32";
crc1.crcPolynomial = 0x04C11DB7;
crc1.output1Size = "4";
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect data input
scripting.connect(data_source, "output1", crc1, "input1");

// Connect CRC output to downstream block
scripting.connect(crc1, "output1", next_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", crc1, "prev");
scripting.connect(crc1, "next", next_block, "prev");
\`\`\`

### Important Notes

1. **Input Required**: input1 must be connected to provide data for CRC calculation.

2. **Polynomial Selection**: Choose appropriate polynomial for your protocol/standard.

3. **Output Size**: Must match CRC type (CRC8=1 byte, CRC16=2 bytes, CRC32=4 bytes).

4. **Lookup Table**: Block generates optimized lookup table for fast CRC calculation.
`;

}

function getLongDescription(){
	return `
## CRC Block (Cyclic Redundancy Check)

### Purpose
Calculates CRC checksums for error detection in data transmission and storage. CRC is a hash function that detects accidental changes to raw data.

### How It Works
1. **Input 1 (init)**: Connect CRC initialization value (either 0 from Load Constant or output from previous CRC block)
2. **Input 2 (data)**: Connect the data byte to process
3. **Process**: Uses table lookup and XOR operations to efficiently compute CRC
4. **Output**: Provides updated CRC value for next block or final checksum

### Configuration

**CRC Type**: Choose checksum size
- **CRC8**: 8-bit checksum (1 byte, 0-255)
- **CRC16**: 16-bit checksum (2 bytes, 0-65535)
- **CRC32**: 32-bit checksum (4 bytes, full 32-bit range)

**CRC Polynomial**: The generator polynomial in hexadecimal
- Defines the mathematical algorithm for CRC calculation
- Common polynomials:
  - CRC8: 0x07 (x⁸ + x² + x + 1)
  - CRC16: 0x8005 (x¹⁶ + x¹⁵ + x² + 1)
  - CRC32: 0x04C11DB7 (Ethernet/ZIP polynomial)

**CRC Initialization**: How to initialize the CRC accumulator
- **initialize_crc_result_with_zeros**: Start fresh calculation (connect LOAD_CONSTANT with value 0)
- **initialize_crc_result_from_crcblock**: Continue from previous CRC (chain CRC blocks)

### Technical Details (Additional Information)

**Generated Assembly** (CRC8 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- XOR    TEMP_REG2.b0, init, dataByte ; XOR init with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 1  ; Lookup (6 cycles)


**Generated Assembly** (CRC16 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- LSR    TEMP_REG2.b0, init, 8        ; Extract high byte
- XOR    TEMP_REG2.b0, TEMP_REG2.b0, dataByte  ; XOR with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 2   ; Lookup
- LSL    TEMP_REG2, init, 8           ; Shift init left
- XOR    result, TEMP_REG2.w0, result ; XOR with lookup (9 cycles)

**Generated Assembly** (CRC32 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- LSR    TEMP_REG2.b0, init, 24       ; Extract high byte
- XOR    TEMP_REG2.b0, TEMP_REG2.b0, dataByte  ; XOR with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 4   ; Lookup
- LSL    TEMP_REG2, init, 8           ; Shift init left
- XOR    result, TEMP_REG2, result    ; XOR with lookup (9 cycles)

**Performance**:
- CRC8: 6 PRU cycles per byte
- CRC16: 9 PRU cycles per byte
- CRC32: 9 PRU cycles per byte

**Lookup Table**: Automatically generated 256-entry table based on polynomial
- CRC8: 256 bytes (256 × 1 byte)
- CRC16: 512 bytes (256 × 2 bytes)
- CRC32: 1024 bytes (256 × 4 bytes)
- Table stored in PRU DMEM
- Pre-computed at configuration time

### How CRC Works

**Algorithm Overview**:
1. Initialize CRC register (typically to 0)
2. For each data byte:
   - XOR with appropriate bits of current CRC
   - Use result as index into lookup table
   - Update CRC with table value
3. Final CRC value is the checksum

**Why Use CRC?**
- Detects single-bit errors
- Detects burst errors
- Fast computation using lookup tables
- Widely used in networking (Ethernet), storage (ZIP), and embedded systems

### Usage Notes
- Always initialize with zeros for first CRC calculation
- When processing multiple bytes, chain CRC blocks together
- Input data must be 1 byte (8 bits)
- The polynomial determines error detection capability
- Different standards use different polynomials - verify your protocol requirements
- LUT is shared between CRC blocks with same polynomial and type

### Terminology
- **CRC**: Cyclic Redundancy Check - error-detecting code
- **Checksum**: Result of CRC calculation used to verify data integrity
- **Polynomial**: Mathematical basis for CRC algorithm (e.g., 0x07, 0x8005)
- **Generator polynomial**: Divisor used in CRC calculation
- **LUT**: Lookup Table - pre-computed CRC values for each possible byte
- **DMEM**: PRU Data Memory where lookup table is stored
- **Chaining**: Connecting CRC blocks to process multiple bytes sequentially
- **Error detection**: Ability to detect corrupted or modified data
`;
}

exports = {
	displayName: "CRC",
	defaultInstanceName: "CRC_",
	longDescription: getLongDescription(),
	getAIContext: getAIContext,
	uiView: "graph",
	templates: {
		//need to check what can be passed as argument to template file, right now no argument is required
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
			default: 2,
			hidden: true,
		},
		{
			name: "numOfOutputPorts",
			default: 1,
			hidden: true
		},
		{
			name: "numOfConstants",
			default: 1,
			hidden: true
		},
        {
			name: "crcType",
			displayName: "CRC",
			options: [
            {
				name: "m_calculate_crc8",
				displayName: "CRC8",
			},
			{
				name: "m_calculate_crc16",
				displayName: "CRC16",
			},
            {
				name: "m_calculate_crc32",
				displayName: "CRC32",
			}],
			default: "m_calculate_crc8",
			hidden: false
		},
		{
			name: "crcPolynomial",
			displayName: "CRC Polynomial",
			displayFormat: "hex",
			default: 0x0,
			hidden: false
		},
		{
			name: "constant1",
			displayName: "lookUpTableOffset",
			default: "",
			hidden: true,
			getValue: (inst) => {
				// Define the valid CRC opcodes
				const crcOptions = [
					"m_calculate_crc8",
					"m_calculate_crc16",
					"m_calculate_crc32"
				];
				
				/*if crc_initializated from crcblock read the opcode from input port*/
				if (inst["input1"] && 
					inst["input1"][0] && 
					inst["input1"][0]["inst"] && 
					inst["input1"][0]["inst"]["opCode"] && 
					crcOptions.includes(inst["input1"][0]["inst"]["opCode"])) {
					
					return inst["input1"][0]["inst"]["constant1"]
				}
				
				return inst.$name;
			}
		},
		{
			name: "lutName",
			hidden: true,
			default: "",	
			getValue: (inst) => {
				// Define the valid CRC opcodes
				const crcOptions = [
					"m_calculate_crc8",
					"m_calculate_crc16",
					"m_calculate_crc32"
				];
				
				/*if crc_initializated from crcblock read then lut is already initialized in dmem*/
				if (inst["input1"] && 
					inst["input1"][0] && 
					inst["input1"][0]["inst"] && 
					inst["input1"][0]["inst"]["opCode"] && 
					crcOptions.includes(inst["input1"][0]["inst"]["opCode"])) {
					return "";
				}
				return inst.$name;
			}	
		},
		{
			name: "opCode",
			displayName: "CRC",
			hidden: true,
			default: "",
			getValue: (inst) => {
				// Define the valid CRC opcodes
				const crcOptions = [
					"m_calculate_crc8",
					"m_calculate_crc16",
					"m_calculate_crc32"
				];
				/*if crc_initializated from crcblock read the opcode from input port*/
				if (inst["input1"] && 
					inst["input1"][0] && 
					inst["input1"][0]["inst"] && 
					inst["input1"][0]["inst"]["opCode"] && 
					crcOptions.includes(inst["input1"][0]["inst"]["opCode"])) {
					return inst["input1"][0]["inst"]["opCode"];
				}
				return inst["crcType"];
			}
		},
		{
			name: "lutMemoryLocation",
			displayName: "Lookup Table Memory Location",
			description: "Choose where to store the CRC lookup table",
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
- Use for CRC tables accessed by single PRU

**SMEM (Shared Memory)**:
- 64KB total, shared between all PRUs and R5F
- Slightly slower access
- Use when multiple PRUs need same CRC table
- Saves DMEM space for other data

**Memory Usage**:
- CRC8: 256 bytes
- CRC16: 512 bytes
- CRC32: 1024 bytes
`
		},
        {
			name: "crc_intialization",
			displayName: "CRC Intialization",
			options: [
            {
				name: "zeros",
				displayName: "intialize_crc_result_with_zeros",
			},
			{
				name: "crc_calculated_value",
				displayName: "intialize_crc_result_from_crcblock",
			}
            ],
			default: "zeros",
			onChange: function(inst, ui) {
				if(inst["crc_intialization"] == "crc_calculated_value")
				{
					ui.crcType.hidden = true
					ui.crcPolynomial.hidden = true
					ui.lutMemoryLocation.hidden = true
				}
				else
				{
					ui.crcType.hidden = false
					ui.crcPolynomial.hidden = false
					ui.lutMemoryLocation.hidden = false
				}
			}
		},
		{
			name: "output1Size",
			default: "1",
			hidden: true,
			getValue: (inst)=>
			{
				if(inst["opCode"] == "m_calculate_crc8")
				{
					return "1"
				}
				if(inst["opCode"] == "m_calculate_crc16")
				{
					return "2"
				}
				if(inst["opCode"] == "m_calculate_crc32")
				{
					return "4"
				}
			}
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			default: 1,
			getValue: (inst)=>
			{
				if(inst["opCode"] == "m_calculate_crc8")
				{
					return 6
				}
				if(inst["opCode"] == "m_calculate_crc16")
				{
					return 9
				}
				if(inst["opCode"] == "m_calculate_crc32")
				{
					return 9
				}
			}
		}
	],
	ports: (inst) => { 
		let ports = [];
		
		ports.push({ name: "input1", displayName:"init", type: "input" })
        ports.push({ name: "input2", displayName:"data", type: "input" })
		ports.push({ name: "prev", type: "PREV" })
		ports.push({ name: "next", type: "NEXT"})

		for(let iterator = 1; iterator <= inst["numOfOutputPorts"]; iterator++)
		{
			ports.push({ name: "output"+iterator.toString(), type: "output"})
		}

        return ports
	},
	validate,
	moduleStatic: {
        modules: function(inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: "/pru_blocks/common/pru_blocks_static_module"
            }]
        },
    },
	getMacro,
	getDataSize,
	getLookUptable
}