/**
 * pru_dmem0.js - PRU DMEM0 memory model with symbol table
 * 
 * Provides a model of PRU DMEM0 memory (8KB) starting at 0x00000000
 * with functions to write and read data from this memory, plus
 * symbol table functionality.
 */

// Create 8KB memory array (each element is a byte)
const DMEM0_SIZE = 8 * 1024; // 8KB
const dmem0 = new Uint8Array(DMEM0_SIZE);

// Initialize memory with zeros
for (let i = 0; i < DMEM0_SIZE; i++) {
    dmem0[i] = 0;
}

// Symbol table - maps symbol names to addresses
const symbolTable = {
    byName: {},
};

/**
 * Add a symbol to the symbol table
 * @param {string} name - Symbol name
 * @param {number} address - Memory address
 * @param {number} [size=0] - Size of the symbol in bytes (optional)
 * @param {string} [type=''] - Type of the symbol (optional)
 * @returns {boolean} - True if successful, false if error
 */
function addSymbol(name, address, size) {
    // Validate parameters
    if (!name || typeof name !== 'string') {
        return false;
    }
    
    if (typeof address !== 'number' || address < 0 || address >= DMEM0_SIZE) {
        return false;
    }
    
    // Check if symbol name already exists
    if (symbolTable.byName[name]) {
        return false;
    }
    
    // Add to both maps
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
 * Writes data to the PRU DMEM0 memory at a specified address.
 *
 * @param {number|string} address - The address to write to. Can be a number or a symbol name.
 * @param {Array|Uint8Array} data - The data to write. this should be Uint8Array.
 * @return {boolean} Returns true if the write is successful, false otherwise.
 */
function writeDMEM0(address, data) {
    // Handle address as symbol name
    if (typeof address === 'string') {
        address = getSymbolAddress(address);
    }
    
    // Validate address
    if (address < 0 || address >= DMEM0_SIZE) {
        return false;
    }
    
    if (Array.isArray(data) || data instanceof Uint8Array) {
        // Array of values
        const dataLength = data.length;
        
        // Check if there's enough space
        if (address + dataLength > DMEM0_SIZE) {
            return false;
        }
        
        // Write the array data
        for (let i = 0; i < dataLength; i++) {
            if (i < data.length) {
                dmem0[address + i] = data[i] & 0xFF;
            } else {
                dmem0[address + i] = 0;
            }
        }
    } else {
        return false;
    }
    
    return true;
}

/**
 * Read data from DMEM0 at specified address
 * @param {number|string} address - Starting memory address (0x00000000 to 0x00001FFF) or symbol name
 * @param {number} length - Number of bytes to read
 * @returns {Uint8Array|null} - Data read from memory or null if error
 */
function readDMEM0(address, length) {
    // Handle address as symbol name
    if (typeof address === 'string') {
        address = getSymbolAddress(address);
    }
    
    // Validate parameters
    if (address < 0 || address >= DMEM0_SIZE) {
        return null;
    }
    
    if (!length || length <= 0) {
        return null;
    }
    
    // Check if read is within bounds
    if (address + length > DMEM0_SIZE) {
        return null;
    }
    
    // Create result array and copy data
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        result[i] = dmem0[address + i];
    }
    
    return result;
}

/**
 * Get a copy of the entire DMEM0 memory
 * @returns {Uint8Array} - Copy of DMEM0 memory
 */
function getDMEM0() {
    return new Uint8Array(dmem0);
}

/**
 * Reset DMEM0 memory to zeros
 */
function resetDMEM0() {
    for (let i = 0; i < DMEM0_SIZE; i++) {
        dmem0[i] = 0;
    }
}

/**
 * Adds data section contents to the PRU DMEM0 simulation
 * This function processes dataSectionContents and adds them to the DMEM0 memory simulation
 */
function addDataSectionContents(dataContents, memoryOffset) {        
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
        if (dataType === '.short') {
            elementSize = 2;
        } else if (dataType === '.uint') {
            elementSize = 4;
        }
        
        // Add symbol to DMEM0 symbol table with size information
        addSymbol(symbolName, memoryOffset, dataValues.length * elementSize);
        
        // Write data to DMEM0 memory based on data type
        if (dataType === '.byte') {
            // For byte data, we can directly write the array
            writeDMEM0(memoryOffset, new Uint8Array(dataValues));
            memoryOffset += dataValues.length;
        } else {
            // For multi-byte types, we need to write each value with proper byte ordering
            for (let j = 0; j < dataValues.length; j++) {
                const value = dataValues[j];
                
                if (dataType === '.short') {
                    // Write 2-byte value (little-endian)
                    writeDMEM0(memoryOffset, value & 0xFF, 1);
                    writeDMEM0(memoryOffset + 1, (value >> 8) & 0xFF, 1);
                    memoryOffset += 2;
                } else if (dataType === '.uint') {
                    // Write 4-byte value (little-endian)
                    writeDMEM0(memoryOffset, value & 0xFF, 1);
                    writeDMEM0(memoryOffset + 1, (value >> 8) & 0xFF, 1);
                    writeDMEM0(memoryOffset + 2, (value >> 16) & 0xFF, 1);
                    writeDMEM0(memoryOffset + 3, (value >> 24) & 0xFF, 1);
                    memoryOffset += 4;
                }
            }
        }
    }
    
    return memoryOffset; // Return the total size used
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
    writeDMEM0,
    readDMEM0,
    getDMEM0,
    resetDMEM0,
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