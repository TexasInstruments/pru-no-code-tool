/**
 * pru_smem.js - PRU SMEM (Shared Memory) model with symbol table
 *
 * Provides a model of PRU Shared Memory (64KB) starting at 0x00010000
 * with functions to write and read data from this memory, plus
 * symbol table functionality.
 */

// Create 64KB shared memory array (each element is a byte)
const SMEM_SIZE = 64 * 1024; // 64KB
const SMEM_BASE_ADDRESS = 0x00010000; // SMEM starts at 64KB offset
const smem = new Uint8Array(SMEM_SIZE);

// Initialize memory with zeros
for (let i = 0; i < SMEM_SIZE; i++) {
    smem[i] = 0;
}

// Symbol table - maps symbol names to addresses
const symbolTable = {
    byName: {},
};

/**
 * Add a symbol to the symbol table
 * @param {string} name - Symbol name
 * @param {number} address - Memory address (absolute address including SMEM_BASE_ADDRESS)
 * @param {number} [size=0] - Size of the symbol in bytes (optional)
 * @returns {boolean} - True if successful, false if error
 */
function addSymbol(name, address, size) {
    // Validate parameters
    if (!name || typeof name !== 'string') {
        return false;
    }

    if (typeof address !== 'number' || address < SMEM_BASE_ADDRESS || address >= (SMEM_BASE_ADDRESS + SMEM_SIZE)) {
        return false;
    }

    // Check if symbol name already exists
    if (symbolTable.byName[name]) {
        return false;
    }

    // Add to symbol table
    symbolTable.byName[name] = {
        address,
        size: size,
    };

    return true;
}

/**
 * Remove a symbol from the symbol table by name
 * @param {string} name - Symbol name to remove
 * @returns {boolean} - True if removed, false if not found
 */
function removeSymbol(name) {
    if (!symbolTable.byName[name]) {
        return false;
    }
    delete symbolTable.byName[name];
    return true;
}

/**
 * Get address of a symbol
 * @param {string} name - Symbol name
 * @returns {number|null} - Address or null if symbol not found
 */
function getSymbolAddress(name) {
    return symbolTable.byName[name]?.address ?? null;
}

/**
 * Get complete symbol table
 * @returns {object} - Copy of the symbol table
 */
function getSymbolTable() {
    // Return a deep copy to prevent direct modification
    return JSON.parse(JSON.stringify(symbolTable));
}

/**
 * Clear the entire symbol table
 */
function clearSymbolTable() {
    symbolTable.byName = {};
}

/**
 * Writes data to the PRU SMEM at a specified address.
 *
 * @param {number|string} address - The address to write to (absolute address or symbol name)
 * @param {Array|Uint8Array} data - The data to write. This should be Uint8Array.
 * @return {boolean} Returns true if the write is successful, false otherwise.
 */
function writeSMEM(address, data) {
    // Handle address as symbol name
    if (typeof address === 'string') {
        address = getSymbolAddress(address);
        if (address === null) {
            return false;
        }
    }

    // Validate address is in SMEM range
    if (address < SMEM_BASE_ADDRESS || address >= (SMEM_BASE_ADDRESS + SMEM_SIZE)) {
        return false;
    }

    // Convert absolute address to SMEM offset
    const offset = address - SMEM_BASE_ADDRESS;

    if (Array.isArray(data) || data instanceof Uint8Array) {
        // Array of values
        const dataLength = data.length;

        // Check if there's enough space
        if (offset + dataLength > SMEM_SIZE) {
            return false;
        }

        // Write the array data
        for (let i = 0; i < dataLength; i++) {
            if (i < data.length) {
                smem[offset + i] = data[i] & 0xFF;
            } else {
                smem[offset + i] = 0;
            }
        }
    } else {
        return false;
    }

    return true;
}

/**
 * Read data from SMEM at specified address
 * @param {number|string} address - Starting memory address (absolute address or symbol name)
 * @param {number} length - Number of bytes to read
 * @returns {Uint8Array|null} - Data read from memory or null if error
 */
function readSMEM(address, length) {
    // Handle address as symbol name
    if (typeof address === 'string') {
        address = getSymbolAddress(address);
        if (address === null) {
            return null;
        }
    }

    // Validate address is in SMEM range
    if (address < SMEM_BASE_ADDRESS || address >= (SMEM_BASE_ADDRESS + SMEM_SIZE)) {
        return null;
    }

    if (!length || length <= 0) {
        return null;
    }

    // Convert absolute address to SMEM offset
    const offset = address - SMEM_BASE_ADDRESS;

    // Check if read is within bounds
    if (offset + length > SMEM_SIZE) {
        return null;
    }

    // Create result array and copy data
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        result[i] = smem[offset + i];
    }

    return result;
}

/**
 * Get a copy of the entire SMEM memory
 * @returns {Uint8Array} - Copy of SMEM memory
 */
function getSMEM() {
    return new Uint8Array(smem);
}

/**
 * Reset SMEM memory to zeros
 */
function resetSMEM() {
    for (let i = 0; i < SMEM_SIZE; i++) {
        smem[i] = 0;
    }
}

/**
 * Adds data section contents to the PRU SMEM simulation
 * This function processes dataSectionContents and adds them to the SMEM memory simulation
 *
 * @param {Array} dataContents - Array of data section items
 * @param {number} memoryOffset - Starting offset in SMEM (absolute address)
 * @returns {number} - The next available memory offset after loading data
 */
function addDataSectionContents(dataContents, memoryOffset) {
    // Validate starting offset is in SMEM range
    if (memoryOffset < SMEM_BASE_ADDRESS) {
        memoryOffset = SMEM_BASE_ADDRESS;
    }

    // Process each data section entry
    for (let i = 0; i < dataContents.length; i++) {
        const dataItem = dataContents[i];
        const symbolName = dataItem.symbolName;
        const dataType = dataItem.symbolDataType;
        const symbolDataStr = dataItem.symbolData;

        // Parse the comma-separated values into an array of numbers
        const dataValues = symbolDataStr.split(',').map(val => parseInt(val.trim(), 10));

        // Determine element size based on dataType
        let elementSize = 1;
        if (dataType === '.ushort') {
            elementSize = 2;
        } else if (dataType === '.uint') {
            elementSize = 4;
        }

        // Add symbol to SMEM symbol table with size information
        addSymbol(symbolName, memoryOffset, dataValues.length * elementSize);

        // Write data to SMEM memory based on data type
        if (dataType === '.byte') {
            // For byte data, we can directly write the array
            writeSMEM(memoryOffset, new Uint8Array(dataValues));
            memoryOffset += dataValues.length;
        } else {
            // For multi-byte types, we need to write each value with proper byte ordering (little-endian)
            for (let j = 0; j < dataValues.length; j++) {
                const value = dataValues[j];

                if (dataType === '.ushort') {
                    // Write 2-byte value (little-endian)
                    const bytes = new Uint8Array([
                        value & 0xFF,
                        (value >> 8) & 0xFF
                    ]);
                    writeSMEM(memoryOffset, bytes);
                    memoryOffset += 2;
                } else if (dataType === '.uint') {
                    // Write 4-byte value (little-endian)
                    const bytes = new Uint8Array([
                        value & 0xFF,
                        (value >> 8) & 0xFF,
                        (value >> 16) & 0xFF,
                        (value >> 24) & 0xFF
                    ]);
                    writeSMEM(memoryOffset, bytes);
                    memoryOffset += 4;
                }
            }
        }
    }

    return memoryOffset; // Return the next available offset
}

/**
 * Replaces symbol references in PRU instructions with their actual memory addresses
 * @param {Array} instructions - Array of PRU instructions that may contain symbol references
 * @return {Array} Array of instructions with symbol references replaced with actual addresses
 */
function replaceSymbolReferences(instructions) {
    return instructions.map(instruction => {
        // Skip if instruction is not a string
        if (typeof instruction !== 'string') {
            return instruction;
        }

        // Find symbols in the instruction (words starting with letters/underscore)
        return instruction.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (match, symbolName) => {
            // Get the symbol address
            const address = getSymbolAddress(symbolName);

            // If it's a valid symbol (address is not null or undefined), replace it with the address
            if (address !== null && address !== undefined) {
                return `0x${address.toString(16).padStart(8, '0')}`;
            }

            // Otherwise, leave the original text
            return match;
        });
    });
}

// Export the functions and constants
exports = {
    SMEM_BASE_ADDRESS,
    SMEM_SIZE,
    writeSMEM,
    readSMEM,
    getSMEM,
    resetSMEM,
    // Symbol table functions
    addSymbol,
    removeSymbol,
    getSymbolAddress,
    getSymbolTable,
    clearSymbolTable,
    // Data section functions
    addDataSectionContents,
    replaceSymbolReferences
};
