/**
 * Memory Access Block
 *
 * Memory read/write block using LBBO/SBBO instructions with predefined
 * memory region base addresses (DMEM0, DMEM1, Shared RAM) or user-defined symbols.
 */

/**
 * Get all available Memory Variable symbols for the dropdown
 */
function getMemoryReserveSymbols() {
	let symbols = [];
	const memReserveModule = system.modules["/pru_blocks/utils/memory_variable_block"];
	if (memReserveModule && memReserveModule.$instances) {
		for (let instance of memReserveModule.$instances) {
			if (instance.labelName && instance.labelName !== "") {
				symbols.push({
					name: instance.labelName,
					displayName: `${instance.labelName} (${instance.sizeInBytes} bytes)`
				});
			}
		}
	}
	return symbols;
}

/**
 * Get the size of a Memory Variable block by symbol name
 */
function getMemoryReserveSize(symbolName) {
	const memReserveModule = system.modules["/pru_blocks/utils/memory_variable_block"];
	if (memReserveModule && memReserveModule.$instances) {
		for (let instance of memReserveModule.$instances) {
			if (instance.labelName === symbolName) {
				return instance.sizeInBytes;
			}
		}
	}
	return -1; // Symbol not found
}

function validate(inst, report) {
	// Check input port connections for write mode
	if (inst["operationMode"] === "write") {
		if (inst["input1"].length == 0) {
			report.logError("Data input must be connected for write operation", inst, "operationMode");
		}
	}
	
	// Validate symbol selection
	if (!inst["symbolSelect"] || inst["symbolSelect"] === "") {
		report.logError("Please select a memory symbol to access", inst, "symbolSelect");
	}

	let memory_variable = getMemoryReserveSymbols();
	let flag = 0;

	for (let i = 0 ; i < memory_variable.length ; ++i){
		if(inst["symbolSelect"] === memory_variable[i].name){
			flag = 1;
			break;
		}
	}

	if(!flag){
        report.logError("Invalid memory variable selected, please select from the dropdown", inst);
    }

	// Validate data size
	if (inst["dataSize"] < 1 || inst["dataSize"] > 4) {
		report.logError("Data size must be between 1 and 4 bytes", inst, "dataSize");
	}

	// Validate offset against memory reserve size
	if (inst["symbolSelect"] && inst["symbolSelect"] !== "") {
		const memSize = getMemoryReserveSize(inst["symbolSelect"]);
		if (memSize !== -1) {
			// Check if offset is within bounds
			if (inst["offsetValue"] < 0) {
				report.logError("Offset must be a positive value", inst, "offsetValue");
			}

			// Check if offset + dataSize exceeds memory bounds
			const endAddress = inst["offsetValue"] + inst["dataSize"];
			if (endAddress > memSize) {
				report.logError(
					`Memory access exceeds buffer size. Offset (${inst["offsetValue"]}) + Data Size (${inst["dataSize"]}) = ${endAddress} bytes, but buffer is only ${memSize} bytes`,
					inst,
					"offsetValue"
				);
			}
		}
	}
}

function getMacro(pruInstructionMacro, opCode) {
	let macroBody = "";

	// Determine if this is a read or write operation based on opCode
	const isWrite = opCode.includes("store") || opCode.includes("write");

	// Generate macro DEFINITION when called with empty pruInstructionMacro
	if (pruInstructionMacro === "") {
		if (isWrite) {
			// Store macro: dataReg, baseAddress, offset, count
			macroBody = opCode + "\t.macro dataReg, baseAddress, offset, count\n";
			macroBody += `\t; Memory Store (SBBO)
\t;   dataReg     - Source register containing data to store
\t;   baseAddress - Base address (symbol or hex address)
\t;   offset      - Byte offset from base address
\t;   count       - Number of bytes to store (1, 2, or 4)
\tLDI32   TEMP_REG1, baseAddress + offset
\tSBBO    &dataReg, TEMP_REG1, 0, count
`;
		} else {
			// Load macro: dataReg, baseAddress, offset, count
			macroBody = opCode + "\t.macro dataReg, baseAddress, offset, count\n";
			macroBody += `\t; Memory Load (LBBO)
\t;   dataReg     - Destination register to store loaded data
\t;   baseAddress - Base address (symbol or hex address)
\t;   offset      - Byte offset from base address
\t;   count       - Number of bytes to load (1, 2, or 4)
\tLDI32   TEMP_REG1, baseAddress + offset
\tLBBO    &dataReg, TEMP_REG1, 0, count
`;
		}
		macroBody += " .endm";
		return macroBody;
	}

	// For macro invocation, just return the pruInstructionMacro as-is
	// The register allocator already built the correct invocation string
	return pruInstructionMacro;
}

function getAIContext() {
    return getLongDescription() + `

	## How to Configure (For AI/Scripting)
	
	This section describes how to programmatically configure the Memory Access block in a .syscfg file.
	
	### Adding a Memory Access Instance
	
	\\\`\\\`\\\`javascript
	const memory_load_block = scripting.addModule("/pru_blocks/data_handling/memory_load_block", {}, false);
	const mem_access1 = memory_load_block.addInstance();
	\\\`\\\`\\\`
	
	### Configuration Parameters
	
	| Parameter | Type | Valid Values | Default | Description |
	|-----------|------|--------------|---------|-------------|
	| operationMode | String | "read", "write" | "read" | Read (LBBO) or Write (SBBO) operation |
	| symbolSelect | String | Symbol name from Memory Reserve | "" | Symbol name from Memory Variable block dropdown |
	| offsetValue | Integer | 0 to (buffer_size - dataSize) | 0 | Byte offset from symbol start, validated against buffer size |
	| dataSize | Integer | 1-112 | 4 | Number of bytes to read/write (1-112 bytes, register-aligned for >=4) |
	
	### Example Configurations
	
	**Read 4 bytes from beginning of buffer:**
	\\\`\\\`\\\`javascript
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
	\\\`\\\`\\\`
	
	**Write to shared memory buffer with offset:**
	\\\`\\\`\\\`javascript
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
	\\\`\\\`\\\`
	
	### Connecting to Other Blocks
	
	\\\`\\\`\\\`javascript
	// For WRITE mode: connect data source to input1
	scripting.connect(load_constant1, "output1", mem_access1, "input1");
	
	// For READ mode: connect output1 to downstream block
	scripting.connect(mem_access1, "output1", process_block, "input1");
	
	// Connect control flow
	scripting.connect(prev_block, "next", mem_access1, "prev");
	\\\`\\\`\\\`
	
	### Important Notes
	
	1. **Write Mode Inputs**: When operationMode="write", connect data to input1. If offsetMode="register", also connect offset to input2.
	
	2. **Read Mode Outputs**: When operationMode="read", the loaded data is available on output1.
	
	3. **Symbol Addressing**: When using addressingMode="symbol", the symbol must be defined by a Memory Variable block in the same configuration.
	`;
}

function getLongDescription() {
	return `
	## Memory Access Block

	### Purpose
	Read from or write to PRU memory using symbols defined by Memory Variable blocks. Uses LBBO (Load) or SBBO (Store) instructions with automatic address calculation and bounds checking.

	### How It Works
	1. **Select Operation**: Choose Read (LBBO) or Write (SBBO)
	2. **Select Memory Symbol**: Choose a symbol from Memory Variable block dropdown
	3. **Configure Offset**: Set the byte offset from the symbol's base address (0 to buffer size)
	4. **Set Data Size**: Choose how many bytes to access (1 to 112 bytes)
	5. **Execute**: PRU calculates the absolute address (symbol + offset) and executes LBBO/SBBO instruction

	### Memory Symbol Addressing
	The block uses symbols defined by **Memory Variable** blocks:
	- Select from the dropdown of available memory symbols
	- Each symbol shows its size (e.g., "buffer (64 bytes)")
	- The linker automatically resolves the symbol address at link time
	- Offset is validated against the buffer size to prevent overflow

	### Generated Assembly

	**Read Operation (LBBO)**:
	\`\`\`assembly
	LDI32 R28, (symbol + offset)  ; Calculate absolute address
	LBBO &R_output, R28, 0, byte_count  ; Load data from memory
	\`\`\`

	**Write Operation (SBBO)**:
	\`\`\`assembly
	LDI32 R28, (symbol + offset)  ; Calculate absolute address
	SBBO &R_input, R28, 0, byte_count   ; Store data to memory
	\`\`\`

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
	\`\`\`
	[Memory Variable: rxBuffer, 128 bytes, DMEM]
	[Memory Access] → [Process Data]
	Config: Operation=Read, Symbol=rxBuffer, Offset=0, Data Size=4 bytes
	Result: Reads 4 bytes from rxBuffer[0-3]
	\`\`\`

	#### Example 2: Write to Shared Memory (PRU to ARM communication)
	\`\`\`
	[Memory Variable: sharedData, 256 bytes, SMEM]
	[Data Source] → [Memory Access]
	Config: Operation=Write, Symbol=sharedData, Offset=0x10, Data Size=4 bytes
	Result: Writes 4 bytes to sharedData[16-19]
	\`\`\`

	#### Example 3: Array Element Access
	\`\`\`
	[Memory Variable: dataBuffer, 256 bytes, DMEM]
	[Memory Access] → [Process]
	Config: Operation=Read, Symbol=dataBuffer, Offset=32, Data Size=4 bytes
	Result: Reads 4 bytes from dataBuffer[32-35] (8th element in 4-byte array)
	\`\`\`

	#### Example 4: Store Result to Reserved Memory
	\`\`\`
	[Memory Variable: resultBuffer, 64 bytes, DMEM]
	[Calculation] → [Memory Access]
	Config: Operation=Write, Symbol=resultBuffer, Offset=0, Data Size=4 bytes
	Result: Writes 4 bytes to resultBuffer[0-3]
	\`\`\`

	#### Example 5: Multi-byte Transfer
	\`\`\`
	[Memory Variable: largeBuffer, 512 bytes, SMEM]
	[Data Source] → [Memory Access]
	Config: Operation=Write, Symbol=largeBuffer, Offset=0, Data Size=16 bytes
	Result: Writes 16 bytes to largeBuffer[0-15] using multiple registers
	\`\`\`

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

	---`;
}

exports = {
	displayName: "Memory Access",
	defaultInstanceName: "Memory_Access_",
	longDescription: getLongDescription(),
    getAIContext: getAIContext,
	uiView: "graph",
	templates: {
		"/pru_blocks/common/pru_syscfg.asm.xdt": null
	},
	config: [
		// Hidden shape/UI fields
		{
			name: "$shape",
			hidden: true,
			default: "pin",
		},
		{
			name: "$topLabel",
			hidden: true,
			default: "",
		},
		// Operation Mode Selection (User-visible)
		{
			name: "operationMode",
			displayName: "Operation",
			default: "read",
			description: "Choose read (LBBO) or write (SBBO) operation",
			options: [
				{
					name: "read",
					displayName: "Read (Load from Memory)",
				},
				{
					name: "write",
					displayName: "Write (Store to Memory)",
				}
			]
		},
		// Symbol Selection (User-visible)
		{
			name: "symbolSelect",
			displayName: "Select Memory Symbol",
			description: "Choose a memory symbol defined by a Memory Variable block",
			default: "",
			options: (inst) => {
				let options = getMemoryReserveSymbols();
				// Add empty option if no symbols defined
				if (options.length === 0) {
					options.push({
						name: "",
						displayName: "(No Memory Variable blocks defined)"
					});
				}
				return options;
			}
		},
		// Offset Value (User-visible)
		{
			name: "offsetValue",
			displayName: "Offset (bytes)",
			default: 0,
			displayFormat: "hex",
			description: "Byte offset from the start of the memory symbol. Must not exceed buffer size."
		},
		// Data Size Selection (User-visible)
		{
			name: "dataSize",
			displayName: "Data Size (bytes)",
			default: 4,
			description: "Number of bytes to access (1 to 112 bytes). Must be register-aligned for sizes >= 4 bytes.",
		},
		// Hidden instruction generation fields
		{
			name: "opCode",
			displayName: "Operation",
			default: "m_memory_load",
			hidden: true,
			getValue: (inst) => {
				return (inst["operationMode"] === "write") ? "m_memory_store" : "m_memory_load";
			}
		},
		{
			name: "outputReg",
			hidden: true,
			default: "",
			getValue: (inst) => {
				// For write mode, use "None" to prevent register allocator from adding output register
				// For read mode, leave empty to let register allocator handle it normally
				return (inst["operationMode"] === "write") ? "None" : "";
			}
		},
		{
			name: "constant1",
			hidden: true,
			default: "0x00000000, 0, 4",
			getValue: (inst) => {
				// Build instruction parameters: "baseAddress, offset, count"
				// Use symbol addressing with user-specified offset
				const baseAddress = inst["symbolSelect"] || "UNDEFINED_SYMBOL";
				const offset = inst["offsetValue"];
				const count = inst["dataSize"];
				return `${baseAddress}, ${offset}, ${count}`;
			}
		},
		{
			name: "numOfInputPorts",
			default: 0,
			hidden: true,
			getValue: (inst) => {
				let count = 0;
				// Input for data to write
				if (inst["operationMode"] === "write") {
					count = 1;
				}
				return count;
			}
		},
		{
			name: "numOfOutputPorts",
			default: 1,
			hidden: true,
			getValue: (inst) => {
				// Read mode has output, write mode doesn't
				return (inst["operationMode"] === "read") ? 1 : 0;
			}
		},
		{
			name: "numOfConstants",
			default: 1,
			hidden: true
		},
		{
			name: "noOfCycles",
			displayName: "Number Of Cycles",
			default: 3,
			getValue: (inst) => {
				// LDI32 (2 cycles) + LBBO (1 cycle)
				return 3;
			}
		},
		{
			name: "output1Size",
			default: 4,
			hidden: true,
			getValue: (inst) => {
				// Only return size for read mode (which has output)
				// Write mode has no output, return 0
				return (inst["operationMode"] === "read") ? inst["dataSize"] : 0;
			}
		},
		{
			name: "input1Size",
			default: 4,
			hidden: true,
			getValue: (inst) => {
				// For write mode, input1 is the data to store
				// For read mode with register offset, input1 is the offset (small value)
				if (inst["operationMode"] === "write") {
					return inst["dataSize"];
				}
				return 0;
			}
		}
	],
	ports: (inst) => {
		let ports = [];

		if (inst["operationMode"] === "write") {
			// Write mode: input for data to store
			ports.push({ name: "input1", displayName: "data", type: "input" });
		} else {
			// Read mode: output for loaded data
			ports.push({ name: "output1", displayName: "data", type: "output" });
		}

		// Control flow ports
		ports.push({ name: "prev", type: "PREV" });
		ports.push({ name: "next", type: "NEXT" });

		return ports;
	},
	validate,
	getMacro,
	moduleStatic: {
		modules: function (inst) {
			return [{
				name: "pru_register_allocator_validator",
				moduleName: "/pru_blocks/common/pru_blocks_static_module"
			}]
		},
	},
}
