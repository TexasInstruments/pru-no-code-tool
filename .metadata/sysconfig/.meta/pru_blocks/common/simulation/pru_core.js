const pruDMEM0 = system.getScript("/pru_blocks/common/simulation/pru_dmem0.js");
const pruSMEM = system.getScript("/pru_blocks/common/simulation/pru_smem.js");

// Helper function to parse immediate values (decimal or hex)
function parseImmediate(immStr) {
    try {
        const result = eval(immStr);
        // Check if the result is a valid number
        if (typeof result !== 'number' || isNaN(result)) {
            throw new Error("Result is not a valid number");
        }
        return result;
    } catch (error) {
        // Return a default value or throw a more specific error
        return -1; // Or throw new Error(`Invalid immediate value: ${immStr}`);
    }
}

// Helper function to parse register references (including .bx and .wx notation)
function parseRegister(regStr) {
    // The /i flag at the end makes the regex case-insensitive
    const fullRegex = /r(\d+)(\.b(\d+)|\.w(\d+))?/i;
    const match = regStr.match(fullRegex);
    
    if (!match) {
        return -1; // Return -1 to indicate an error
    }
    
    const regNum = parseInt(match[1]);
    
    if (match[3] !== undefined) {
        // Byte addressing: .b0, .b1, .b2, .b3
        return { 
            reg: regNum, 
            type: 'byte', 
            byteNum: parseInt(match[3]),
            mask: 0xFF,
            shift: parseInt(match[3]) * 8
        };
    } else if (match[4] !== undefined) {
        // Word addressing: .w0, .w1, .w2
        return { 
            reg: regNum, 
            type: 'word', 
            wordNum: parseInt(match[4]),
            mask: 0xFFFF,
            shift: parseInt(match[4]) * 8
        };
    } else {
        // Full register
        return { reg: regNum, type: 'full' };
    }
}

/**
 * Helper function to parse register references like R0, R1.b0, R2.w1, etc.
 * Case insensitive to handle both r0 and R0 formats.
 * 
 * @param {string} regRef - Register reference string
 * @return {Object|null} Object with register info or null if invalid
 */
function parseRegisterReference(regRef) {
    if (!regRef || typeof regRef !== 'string') {
        return null;
    }

    // Convert to lowercase for case-insensitive comparison
    const lowerRegRef = regRef.toLowerCase();
    
    // Regular expressions for different register formats
    const regRegex = /^r(\d+)$/;           // Matches r0, r1, r2, etc.
    const byteRegex = /^r(\d+)\.b([0-3])$/; // Matches r0.b0, r1.b1, etc.
    const wordRegex = /^r(\d+)\.w([0-2])$/; // Matches r0.w0, r1.w1, etc.
    
    let match;
    
    // Check for regular register format
    if ((match = lowerRegRef.match(regRegex))) {
        const regNum = parseInt(match[1], 10);
        if (regNum >= 0 && regNum <= 31) {
            return { regNum, byteMode: false, wordMode: false };
        }
    }
    
    // Check for byte format
    if ((match = lowerRegRef.match(byteRegex))) {
        const regNum = parseInt(match[1], 10);
        const bytePos = parseInt(match[2], 10);
        if (regNum >= 0 && regNum <= 31 && bytePos >= 0 && bytePos <= 3) {
            return { regNum, byteMode: true, wordMode: false, bytePos };
        }
    }
    
    // Check for word format
    if ((match = lowerRegRef.match(wordRegex))) {
        const regNum = parseInt(match[1], 10);
        const wordPos = parseInt(match[2], 10);
        if (regNum >= 0 && regNum <= 31 && wordPos >= 0 && wordPos <= 2) {
            return { regNum, byteMode: false, wordMode: true, wordPos };
        }
    }
    
    return null;
}

// Helper function to check parsing errors
function handleParsingError(pruState, ...values) {
    for (const value of values) {
        if (value === -1) {
            pruState.errorParsing++;
            return true;
        }
    }
    return false;
}

// Helper function to get register value (respecting .bx and .wx notation)
function getRegisterValue(pruState, regInfo) {
    if (regInfo.type === 'full') {
        return pruState.registers[regInfo.reg];
    } else if (regInfo.type === 'byte') {
        return (pruState.registers[regInfo.reg] >> regInfo.shift) & regInfo.mask;
    } else if (regInfo.type === 'word') {
        return (pruState.registers[regInfo.reg] >> regInfo.shift) & regInfo.mask;
    }
    return 0;
}

// Helper function to set register value (respecting .bx and .wx notation)
function setRegisterValue(pruState, regInfo, value) {
    if (regInfo.type === 'full') {
        pruState.registers[regInfo.reg] = value >>> 0; // Ensure 32-bit unsigned
    } else if (regInfo.type === 'byte') {
        // Clear the byte position and set the new value
        const clearMask = ~(regInfo.mask << regInfo.shift);
        pruState.registers[regInfo.reg] &= clearMask;
        pruState.registers[regInfo.reg] |= ((value & regInfo.mask) << regInfo.shift);
    } else if (regInfo.type === 'word') {
        // Clear the word position and set the new value
        const clearMask = ~(regInfo.mask << regInfo.shift);
        pruState.registers[regInfo.reg] &= clearMask;
        pruState.registers[regInfo.reg] |= ((value & regInfo.mask) << regInfo.shift);
    }
}

/**
 * Implements the SBBO (Store Bytes with Byte Offset) instruction
 * SBBO &src, baseaddr, byteOffset, byteCount
 * 
 * @param {Object} pruState - Current pruState
 * @param {string} src - Source register (format: Rn, Rn.bx, or Rn.wx)
 * @param {string} baseAddr - Base address register
 * @param {string} byteOffset - Byte offset register
 * @param {string} byteCount - Number of bytes to store (1-124)
 * @return {number} Number of cycles consumed
 */
function executeSbbo(pruState, src, baseAddr, byteOffset, byteCount) {
    // Parse the source register and format
    const srcInfo = parseRegisterReference(src);
    if (!srcInfo) {
        return 0;
    }

    // Special handling for R31
    if (srcInfo.regNum === 31) {
       return 0;
    }
    
    // Parse the base address
    let baseValue = 0;
    if (baseAddr.toLowerCase().startsWith('r')) {
        const baseRegInfo = parseRegisterReference(baseAddr);
        if (baseRegInfo) {
            baseValue = pruState.registers[baseRegInfo.regNum];
        } else {
            return 0;
        }
    } else if (baseAddr.toLowerCase().startsWith('c')) {
        const cNum = parseInt(baseAddr.substring(1), 10);
        if (cNum === 26) {
            baseValue = 0x0002E000; // IEP base address
        } else if (cNum === 28) {
            baseValue = 0x00000000; // DMEM0 base address
        } else {
            baseValue = 0;
        }
    } else {
        return 0;
    }
    
    // Parse the byte offset
    let offsetValue = 0;
    if (byteOffset.toLowerCase().startsWith('r')) {
        const offsetRegInfo = parseRegisterReference(byteOffset);
        if (offsetRegInfo) {
            offsetValue = pruState.registers[offsetRegInfo.regNum];
        } else {
            return 0;    
        }
    } else {
        // Assume immediate value
        offsetValue = parseInt(byteOffset, 0);
    }
    
    // Parse the byte count
    let count = parseInt(byteCount, 0);
    if (isNaN(count) || count < 1 || count > 124) {
        return 0;
    }
    
    // Calculate the memory address
    const memAddress = baseValue + offsetValue;
    
    // Create a buffer to hold all the data we'll write to memory
    const dataBuffer = new Uint8Array(count);
    
    // Determine starting position in register
    let currentReg = srcInfo.regNum;
    let currentByte = 0; // Default start at byte 0
    
    if (srcInfo.byteMode) {
        // For byte mode, start at the specified byte position
        currentByte = srcInfo.bytePos;
    } else if (srcInfo.wordMode) {
        // For word mode, start at the first byte of the specified word
        currentByte = srcInfo.wordPos;
    }
    
    // Extract bytes from registers and fill the data buffer
    let bytesRemaining = count;
    let bufferOffset = 0;
    
    while (bytesRemaining > 0) {
        // Calculate how many bytes we can extract from current register starting from currentByte
        const bytesFromThisReg = Math.min(bytesRemaining, 4 - currentByte);
        
        // Extract bytes from the register
        const regValue = pruState.registers[currentReg];
        for (let i = 0; i < bytesFromThisReg; i++) {
            if (bufferOffset + i < count) {
                dataBuffer[bufferOffset + i] = (regValue >> ((currentByte + i) * 8)) & 0xFF;
            }
        }
        
        // Update counters for next iteration
        bufferOffset += bytesFromThisReg;
        bytesRemaining -= bytesFromThisReg;
        
        // Move to next register with wrap-around from R30 to R0
        currentReg++;
        if (currentReg > 30) {
            currentReg = 0;
        }
        
        currentByte = 0; // Reset to byte 0 for subsequent registers
        
        // Safety check to avoid infinite loop
        if (currentReg === srcInfo.regNum && currentByte === 0) {
            break;
        }
    }
    
    // Write the data to memory (DMEM or SMEM based on address)
    let writeResult;
    if (memAddress >= 0x00010000 && memAddress < 0x00020000) {
        // SMEM range: 0x00010000 - 0x0001FFFF
        writeResult = pruSMEM.writeSMEM(memAddress, dataBuffer);
    } else if (memAddress >= 0x0002E000 && memAddress < 0x0002E100) {
        // IEP registers. Offsets per AM243x TRM SPRUIM2J Table 14-10902 (p6902):
        // 0x00 GLOBAL_CFG, 0x10/0x14 COUNT_REG0/1, 0x18/0x1C CAP_CFG/CAP_STATUS,
        // 0x20.. CAPRn, 0x70 CMP_CFG, 0x74 CMP_STATUS, 0x78+8j CMPj_REG0/1.
        // This is not the AM335x-era layout (count at 0x0C, compare block at
        // 0x40): here 0x0C is SLOW_COMPEN and 0x40-0x6C are capture registers.
        const iepOffset = memAddress - 0x0002E000;
        let regVal = 0;
        for (let i = 0; i < count; i++) {
            regVal |= dataBuffer[i] << (i * 8);
        }
        if (iepOffset === 0x00) {
            pruState.iepGlobalCfg = regVal;      // [0] CNT_ENABLE, [7:4] DEFAULT_INC
        } else if (iepOffset === 0x10) {
            pruState.iepCount = regVal;
        } else if (iepOffset === 0x70) {
            pruState.iepCmpCfg = regVal;         // [0] CMP0_RST_CNT_EN, [16:1] CMP_EN
        } else if (iepOffset === 0x74) {
            pruState.iepCmpStatus &= ~regVal; // Clear status bits written as 1 (W1C behavior)
        } else if (iepOffset === 0x14) {
            pruState.iepCountHi = regVal >>> 0;   // IEP_COUNT_REG1, upper 32 bits
        } else if (iepOffset >= 0x78 && iepOffset < 0x78 + 16 * 8) {
            // TRM SPRUIM2J 6.4.13: compares are 64-bit PAIRS, IEP_CMPj_REG0/REG1.
            // 0x4C is CMP0's upper half, NOT CMP1 - CMP1_REG0 is at 0x50. Both
            // halves are stored: dropping REG1 writes on the floor would make any
            // compare above 2^32 unreachable and silently mismatch firmware.
            const j = Math.floor((iepOffset - 0x78) / 8);
            if (((iepOffset - 0x78) % 8) === 0) {
                pruState.iepCmp[j] = regVal >>> 0;
            } else {
                pruState.iepCmpHi[j] = regVal >>> 0;
            }
        }
        writeResult = true;
    } else {
        // DMEM range: 0x00000000 - 0x00001FFF
        writeResult = pruDMEM0.writeDMEM0(memAddress, dataBuffer);
    }
    
    // Calculate the cycles according to the formula: 1 + (number of bytes to store)/4
    // Math.ceil ensures we round up for partial words
    return 1 + Math.ceil(count / 4);
}

/**
 * Implements the LBBO (Load Bytes with Byte Offset) instruction
 * LBBO &src, baseaddr, byteOffset, byteCount
 *
 * @param {Object} pruState - Current pruState 
 * @param {string} dest - Destination register (format: Rn, Rn.bx, or Rn.wx)
 * @param {string} baseAddr - Base address register or immediate value
 * @param {string} byteOffset - Byte offset register or immediate value
 * @param {string} byteCount - Number of bytes to load (1-124)
 * @return {number} Number of cycles consumed
 */
function executeLBBO(pruState, dest, baseAddr, byteOffset, byteCount) {
    // Parse the destination register and format
    const destInfo = parseRegisterReference(dest);
    if (!destInfo) {
        return 0;
    }

    // Special handling for R31
    if (destInfo.regNum === 31) {
        return 0;
    }
    
    // Parse the base address
    let baseValue = 0;
    if (baseAddr.toLowerCase().startsWith('r')) {
        const baseRegInfo = parseRegisterReference(baseAddr);
        if (baseRegInfo) {
            baseValue = pruState.registers[baseRegInfo.regNum];
        } else {
            return 0;
        }
    } else if (baseAddr.toLowerCase().startsWith('c')) {
        const cNum = parseInt(baseAddr.substring(1), 10);
        if (cNum === 26) {
            baseValue = 0x0002E000; // IEP base address
        } else if (cNum === 28) {
            baseValue = 0x00000000; // DMEM0 base address
        } else {
            baseValue = 0;
        }
    } else {
        return 0;
    }
    
    // Parse the byte offset
    let offsetValue = 0;
    if (byteOffset.toLowerCase().startsWith('r')) {
        const offsetRegInfo = parseRegisterReference(byteOffset);
        if (offsetRegInfo) {
            offsetValue = pruState.registers[offsetRegInfo.regNum];
        } else {
            return 0;
        }
    } else {
        // Assume immediate value
        offsetValue = parseInt(byteOffset, 0);
    }
    
    // Parse the byte count
    let count = parseInt(byteCount, 0);
    if (isNaN(count) || count < 1 || count > 124) {
        return 0;
    }
    
    // Calculate the memory address
    const memAddress = baseValue + offsetValue;
    
    // Load data from memory (DMEM or SMEM based on address)
    let memoryData;
    if (memAddress >= 0x00010000 && memAddress < 0x00020000) {
        // SMEM range: 0x00010000 - 0x0001FFFF
        memoryData = pruSMEM.readSMEM(memAddress, count);
    } else if (memAddress >= 0x0C000000 && memAddress < 0x0C0FFFFF) {
        // MMIO mock (e.g. SDFM 0x0C080000 base)
        if (pruState.mmioMap && pruState.mmioMap[memAddress]) {
            const history = pruState.mmioMap[memAddress];
            let activeValue = 0;
            for (let i = 0; i < history.length; i++) {
                if (pruState.cycles >= history[i].cycle) {
                    activeValue = history[i].value;
                } else {
                    break;
                }
            }
            memoryData = new Uint8Array(count);
            for (let i = 0; i < count; i++) {
                memoryData[i] = (activeValue >>> (i * 8)) & 0xFF;
            }
        } else {
            memoryData = new Uint8Array(count); // Default 0
        }
    } else if (memAddress >= 0x0002E000 && memAddress < 0x0002E100) {
        // IEP registers. Offsets per AM243x TRM SPRUIM2J Table 14-10902 (p6902):
        // 0x00 GLOBAL_CFG, 0x10/0x14 COUNT_REG0/1, 0x18/0x1C CAP_CFG/CAP_STATUS,
        // 0x20.. CAPRn, 0x70 CMP_CFG, 0x74 CMP_STATUS, 0x78+8j CMPj_REG0/1.
        // This is not the AM335x-era layout (count at 0x0C, compare block at
        // 0x40): here 0x0C is SLOW_COMPEN and 0x40-0x6C are capture registers.
        const iepOffset = memAddress - 0x0002E000;
        let regVal = 0;
        if (iepOffset === 0x00) {
            regVal = pruState.iepGlobalCfg;
        } else if (iepOffset === 0x10) {
            regVal = pruState.iepCount;
        } else if (iepOffset === 0x70) {
            regVal = pruState.iepCmpCfg;
        } else if (iepOffset === 0x74) {
            regVal = pruState.iepCmpStatus;
        } else if (iepOffset === 0x14) {
            regVal = pruState.iepCountHi;
        } else if (iepOffset >= 0x78 && iepOffset < 0x78 + 16 * 8) {
            const j = Math.floor((iepOffset - 0x78) / 8);
            regVal = (((iepOffset - 0x78) % 8) === 0) ? pruState.iepCmp[j] : pruState.iepCmpHi[j];
        }
        memoryData = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            memoryData[i] = (regVal >>> (i * 8)) & 0xFF;
        }
    } else {
        // DMEM range: 0x00000000 - 0x00001FFF
        memoryData = pruDMEM0.readDMEM0(memAddress, count);
    }

    if (!memoryData) {
        // Handle memory read error
        return 1; // Return minimum cycle count even on error
    }
    
    // Determine starting position in register
    let currentReg = destInfo.regNum;
    let currentByte = 0; // Default start at byte 0
    
    if (destInfo.byteMode) {
        // For byte mode, start at the specified byte position
        currentByte = destInfo.bytePos;
    } else if (destInfo.wordMode) {
        // For word mode, start at the first byte of the specified word
        currentByte = destInfo.wordPos;
    }
    
    // Load all bytes into registers
    let bytesRemaining = count;
    let memOffset = 0;
    
    while (bytesRemaining > 0) {
        // Calculate how many bytes we can fit in current register from currentByte
        const bytesInThisReg = Math.min(bytesRemaining, 4 - currentByte);
        
        // Create a mask to preserve bytes we're not changing in this register
        let mask = 0;
        for (let i = 0; i < bytesInThisReg; i++) {
            mask |= 0xFF << ((currentByte + i) * 8);
        }
        const invertedMask = ~mask & 0xFFFFFFFF;
        
        // Start with the current register value and clear the bytes we're going to modify
        let value = pruState.registers[currentReg] & invertedMask;
        
        // Add the new bytes from memory
        for (let i = 0; i < bytesInThisReg; i++) {
            if (memOffset + i < memoryData.length) {
                value |= (memoryData[memOffset + i] & 0xFF) << ((currentByte + i) * 8);
            }
        }
        
        // Update the register
        pruState.registers[currentReg] = value >>> 0;
        
        // Update counters for next iteration
        memOffset += bytesInThisReg;
        bytesRemaining -= bytesInThisReg;
        
        // Move to next register with wrap-around from R30 to R0
        // Note: R31 is not included in the wrap-around as it's often a special register
        currentReg++;
        if (currentReg > 30) {
            currentReg = 0;
        }
        
        currentByte = 0; // Reset to byte 0 for subsequent registers
        
        // Safety check to avoid infinite loop (should never happen with valid inputs)
        if (currentReg === destInfo.regNum && currentByte === 0) {
            break;
        }
    }
    
    // Calculate the cycles according to the formula: 1 + (number of bytes to load)/4
    // Math.ceil ensures we round up for partial words
    return 1 + Math.ceil(count / 4);
}

/**
 * Executes a single instruction in the PRU.
 *
 * @param {Object} pruState - The current state of the PRU.
 * @param {Array} pruInstructions - The array of PRU instructions.
 * @param {Object} labelMap - The map of labels to instruction addresses.
 * @param {Array} r30ValueHistory - The history of R30 values.
 * @param {Array} r31ValueHistory - The history of R31 values.
 * @return {undefined}
 */
function executeInstruction(pruState, pruInstructions, labelMap, r30ValueHistory, r31ValueHistory, cycleCount) {

    const instruction = pruInstructions[pruState.pc];

    // Skip if instruction is a placeholder (0) - do this BEFORE R31 injection
    // so we don't inject on placeholder cycles
    if (instruction === 0 || !instruction) {
        pruState.pc++;
        return;
    }

    // Parse the instruction using a regex that keeps the opcode and operands together
    const instructionMatch = instruction.trim().match(/^(\S+)(?:\s+(.*))?$/);
    if (!instructionMatch) {
        pruState.pc++;
        pruState.cycles++;
        return;
    }
    
    //instructionMatch[0] contains entire matched string
    const opcode = instructionMatch[1].toUpperCase();
    const operandsString = instructionMatch[2] || '';
    
    // Split operands by comma, accounting for spaces
    const operands = operandsString.split(/,\s*/).map(op => op.trim());

    let cyclesToAdd = 1;
    
    // Execute based on opcode
    switch (opcode) {
        case 'LDI': {
            // LDI rX[.bx/.wx], immediate
            // Note: LDI can load up to 16-bit values into word registers
            // For 32-bit values, LDI32 instruction is used instead
            const regInfo = parseRegister(operands[0].replace(/,/g, ''));
            const src2Value = parseImmediate(operands[1]);

            if (handleParsingError(pruState, regInfo, src2Value)) {
                pruState.pc++;
                break;
            }

            // Mask value based on destination register size
            let finalValue;
            if (regInfo.type === 'byte') {
                finalValue = (src2Value >>> 0) & 0xFF;  // 8-bit mask for .bx
            } else if (regInfo.type === 'word') {
                finalValue = (src2Value >>> 0) & 0xFFFF;  // 16-bit mask for .wx
            } else {
                // For full register, LDI is still limited to lower values
                // (LDI32 should be used for full 32-bit loads)
                finalValue = (src2Value >>> 0) & 0xFFFF;
            }
            setRegisterValue(pruState, regInfo, finalValue);
            pruState.pc++;
            break;
        }

        case 'LDI32': {
            // LDI32 Rdst, 32-bit_immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const src2Value = parseImmediate(operands[1]);
            
            if (handleParsingError(pruState, destRegInfo, src2Value)) {
                pruState.pc++;
                break;
            }
            
            // Ensure it's a 32-bit unsigned value
            const finalValue = src2Value >>> 0;
            setRegisterValue(pruState, destRegInfo, finalValue);
            pruState.pc++;
            break;
        }
        
        case 'MOV': {
            // MOV rX[.bx/.wx], rY[.bx/.wx] or MOV rX[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo)) {
                pruState.pc++;
                break;
            }
            
            let src2Value;
            if (operands[1].toLowerCase().startsWith('r')) {
                const srcRegInfo = parseRegister(operands[1].replace(/,/g, ''));
                if (handleParsingError(pruState, srcRegInfo)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcRegInfo);
            } else {
                src2Value = parseImmediate(operands[1]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            setRegisterValue(pruState, destRegInfo, src2Value);
            pruState.pc++;
            break;
        }
        
        case 'ADD': {
            // ADD rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or ADD rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }
            
            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Perform addition
            const tempResult = srcReg1Value + src2Value;
            const result = tempResult >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            // Update carry flag (set if the addition produced a carry out)
            pruState.carryFlag = (tempResult > 0xFFFFFFFF) ? 1 : 0;
            
            pruState.pc++;
            break;
        }
        
        case 'ADC': {
            // ADC rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or ADC rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));

            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }

            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }

            // Perform addition with carry
            const carryValue = pruState.carryFlag || 0;
            const tempResult = srcReg1Value + src2Value + carryValue;
            const result = tempResult >>> 0; // Ensure unsigned 32-bit result

            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);

            // Update carry flag (set if the addition produced a carry out)
            pruState.carryFlag = (tempResult > 0xFFFFFFFF) ? 1 : 0;

            pruState.pc++;
            break;
        }

        case 'SUB': {
            // SUB rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or SUB rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));

            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }

            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }

            // Perform subtraction
            const result = (srcReg1Value - src2Value) >>> 0; // Ensure unsigned 32-bit result

            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);

            // Update carry flag (set if borrow occurred)
            pruState.carryFlag = (srcReg1Value < src2Value) ? 1 : 0;

            pruState.pc++;
            break;
        }

        case 'SUC': {
            // SUC rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or SUC rX[.bx/.wx], rY[.bx/.wx], immediate
            // SUC = Subtract with Carry (borrow)
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));

            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }

            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }

            // Perform subtraction with borrow (carry flag)
            const borrowValue = pruState.carryFlag || 0;
            const result = (srcReg1Value - src2Value - borrowValue) >>> 0; // Ensure unsigned 32-bit result

            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);

            // Update carry flag (set if borrow occurred)
            pruState.carryFlag = ((srcReg1Value - borrowValue) < src2Value) ? 1 : 0;

            pruState.pc++;
            break;
        }
        
        case 'RSB': {
            // RSB rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or RSB rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }
            
            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Perform reverse subtraction (src2 - src1)
            const result = (src2Value - srcReg1Value) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            // Update carry flag (set if borrow occurred)
            pruState.carryFlag = (src2Value < srcReg1Value) ? 1 : 0;
            
            pruState.pc++;
            break;
        }
        
        case 'AND': {
            // AND rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or AND rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }
            
            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Perform bitwise AND
            const result = (srcReg1Value & src2Value) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            pruState.pc++;
            break;
        }
        
        case 'OR': {
            // OR rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or OR rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }
            
            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Perform bitwise OR
            const result = (srcReg1Value | src2Value) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            pruState.pc++;
            break;
        }
        
        case 'XOR': {
            // XOR rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or XOR rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcReg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcReg1Info)) {
                pruState.pc++;
                break;
            }
            
            const srcReg1Value = getRegisterValue(pruState, srcReg1Info);

            let src2Value;
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            if (operands[2].toLowerCase().startsWith('r')) {
                // Source 2 is a register
                const srcReg2Info = parseRegister(operands[2]);
                if (handleParsingError(pruState, srcReg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, srcReg2Info);
            } else {
                // Source 2 is an immediate value
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Perform bitwise XOR
            const result = (srcReg1Value ^ src2Value) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            pruState.pc++;
            break;
        }
        
        case 'LSL': {
            // LSL rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or LSL rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcRegInfo = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcRegInfo)) {
                pruState.pc++;
                break;
            }
            
            const srcValue = getRegisterValue(pruState, srcRegInfo);
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            // Parse the shift amount
            let shiftAmount;
            if (operands[2].toLowerCase().startsWith('r')) {
                // Shift amount is in a register
                const shiftRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, shiftRegInfo)) {
                    pruState.pc++;
                    break;
                }
                shiftAmount = getRegisterValue(pruState, shiftRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                // Shift amount is an immediate value
                shiftAmount = parseImmediate(operands[2]);
                if (handleParsingError(pruState, shiftAmount)) {
                    pruState.pc++;
                    break;
                }
                shiftAmount = shiftAmount & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Perform logical left shift
            const result = (srcValue << shiftAmount) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            // Update carry flag with the last bit shifted out
            if (shiftAmount > 0) {
                // The carry flag gets the last bit that was shifted out
                const lastBitShiftedOut = (srcValue >>> (32 - shiftAmount)) & 0x1;
                pruState.carryFlag = lastBitShiftedOut;
            }
            // If shiftAmount is 0, carry flag is not affected
            
            pruState.pc++;
            break;
        }
        
        case 'LSR': {
            // LSR rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx] or LSR rX[.bx/.wx], rY[.bx/.wx], immediate
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcRegInfo = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcRegInfo)) {
                pruState.pc++;
                break;
            }
            
            const srcValue = getRegisterValue(pruState, srcRegInfo);
            // Check if third operand exists (handle incomplete instructions during block connection)
            if (!operands[2] || operands[2].trim() === '') {
                pruState.pc++;
                break;
            }
            // Parse the shift amount
            let shiftAmount;
            if (operands[2].toLowerCase().startsWith('r')) {
                // Shift amount is in a register
                const shiftRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, shiftRegInfo)) {
                    pruState.pc++;
                    break;
                }
                shiftAmount = getRegisterValue(pruState, shiftRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                // Shift amount is an immediate value
                shiftAmount = parseImmediate(operands[2]);
                if (handleParsingError(pruState, shiftAmount)) {
                    pruState.pc++;
                    break;
                }
                shiftAmount = shiftAmount & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Perform logical right shift
            const result = (srcValue >>> shiftAmount) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            // Update carry flag with the last bit shifted out
            if (shiftAmount > 0) {
                // The carry flag gets the last bit that was shifted out
                const lastBitShiftedOut = (srcValue >>> (shiftAmount - 1)) & 0x1;
                pruState.carryFlag = lastBitShiftedOut;
            }
            // If shiftAmount is 0, carry flag is not affected
            
            pruState.pc++;
            break;
        }

        case 'NOT': {
            // NOT Rdst, Rsrc
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcRegInfo = parseRegister(operands[1]);
            
            if (handleParsingError(pruState, destRegInfo, srcRegInfo)) {
                pruState.pc++;
                break;
            }
            
            const srcValue = getRegisterValue(pruState, srcRegInfo);
            
            // Perform bitwise NOT (one's complement)
            const result = (~srcValue) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            pruState.pc++;
            break;
        }
        
        case 'SET': {
            // SET Rdst, Rsrc, bit
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcRegInfo = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcRegInfo)) {
                pruState.pc++;
                break;
            }
            
            const srcValue = getRegisterValue(pruState, srcRegInfo);
            
            // Parse the bit position
            let bitPosition;
            if (operands[2].toLowerCase().startsWith('r')) {
                const bitRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, bitRegInfo)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = getRegisterValue(pruState, bitRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                bitPosition = parseImmediate(operands[2]);
                if (handleParsingError(pruState, bitPosition)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = bitPosition & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Set the specified bit
            const result = (srcValue | (1 << bitPosition)) >>> 0;

            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);

            pruState.pc++;
            break;
        }

        case 'CLR': {
            // CLR Rdst, Rsrc, bit
            const destRegInfo = parseRegister(operands[0].replace(/,/g, ''));
            const srcRegInfo = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, destRegInfo, srcRegInfo)) {
                pruState.pc++;
                break;
            }
            
            const srcValue = getRegisterValue(pruState, srcRegInfo);
            
            // Parse the bit position
            let bitPosition;
            if (operands[2].toLowerCase().startsWith('r')) {
                const bitRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, bitRegInfo)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = getRegisterValue(pruState, bitRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                bitPosition = parseImmediate(operands[2]);
                if (handleParsingError(pruState, bitPosition)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = bitPosition & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Clear the specified bit
            const result = (srcValue & ~(1 << bitPosition)) >>> 0; // Ensure unsigned 32-bit result
            
            // Update the destination register
            setRegisterValue(pruState, destRegInfo, result);
            
            pruState.pc++;
            break;
        }

        case 'JMP': {
            // JMP label
            const label = operands[0];
            
            if (labelMap[label] !== undefined) {
                pruState.pc = labelMap[label];
            } else {
                // If label not found, increment error counter and move to next instruction
                pruState.errorParsing++;
                pruState.pc++;
            }
            break;
        }
        
        case 'QBEQ': {
            // QBEQ label, rX[.bx/.wx], rY[.bx/.wx] or QBEQ label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if equal
            if (reg1Value === src2Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }
        
        case 'QBNE': {
            // QBNE label, rX[.bx/.wx], rY[.bx/.wx] or QBNE label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if not equal
            if (reg1Value !== src2Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }
        
        case 'QBGT': {
            // QBGT label, rX[.bx/.wx], rY[.bx/.wx] or QBGT label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if greater than (unsigned comparison)
            // QBGT LABEL, REG1, OP - Branch if OP > REG1
            if (src2Value > reg1Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }

        case 'QBGE': {
            // QBGE label, rX[.bx/.wx], rY[.bx/.wx] or QBGE label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if greater than or equal (unsigned comparison)
            // QBGE LABEL, REG1, OP - Branch if OP >= REG1
            if (src2Value >= reg1Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }

        case 'QBLT': {
            // QBLT label, rX[.bx/.wx], rY[.bx/.wx] or QBLT label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if less than (unsigned comparison)
            // QBLT LABEL, REG1, OP - Branch if OP < REG1
            if (src2Value < reg1Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }

        case 'QBLE': {
            // QBLE label, rX[.bx/.wx], rY[.bx/.wx] or QBLE label, rX[.bx/.wx], immediate
            const label = operands[0];
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            let src2Value;
            if (operands[2].toLowerCase().startsWith('r')) {
                const reg2Info = parseRegister(operands[2].replace(/,/g, ''));
                if (handleParsingError(pruState, reg2Info)) {
                    pruState.pc++;
                    break;
                }
                src2Value = getRegisterValue(pruState, reg2Info);
            } else {
                src2Value = parseImmediate(operands[2]);
                if (handleParsingError(pruState, src2Value)) {
                    pruState.pc++;
                    break;
                }
            }
            
            // Branch if less than or equal (unsigned comparison)
            // QBLE LABEL, REG1, OP - Branch if OP <= REG1
            if (src2Value <= reg1Value) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }


        case 'QBBS': {
            // QBBS label, rX[.bx/.wx], bit
            const label = operands[0].replace(/,/g, '');
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            // Parse the bit position
            let bitPosition;
            if (operands[2].toLowerCase().startsWith('r')) {
                const bitRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, bitRegInfo)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = getRegisterValue(pruState, bitRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                bitPosition = parseImmediate(operands[2]);
                if (handleParsingError(pruState, bitPosition)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = bitPosition & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Branch if bit is set (1)
            if ((reg1Value & (1 << bitPosition)) !== 0) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }

        case 'QBBC': {
            // QBBC label, rX[.bx/.wx], bit
            const label = operands[0].replace(/,/g, '');
            const reg1Info = parseRegister(operands[1].replace(/,/g, ''));
            
            if (handleParsingError(pruState, reg1Info)) {
                pruState.pc++;
                break;
            }
            
            const reg1Value = getRegisterValue(pruState, reg1Info);
            
            // Parse the bit position
            let bitPosition;
            if (operands[2].toLowerCase().startsWith('r')) {
                const bitRegInfo = parseRegister(operands[2]);
                if (handleParsingError(pruState, bitRegInfo)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = getRegisterValue(pruState, bitRegInfo) & 0x1F; // Only use bottom 5 bits (0-31)
            } else {
                bitPosition = parseImmediate(operands[2]);
                if (handleParsingError(pruState, bitPosition)) {
                    pruState.pc++;
                    break;
                }
                bitPosition = bitPosition & 0x1F; // Only use bottom 5 bits (0-31)
            }
            
            // Branch if bit is clear (0)
            if ((reg1Value & (1 << bitPosition)) === 0) {
                if (labelMap[label] !== undefined) {
                    pruState.pc = labelMap[label];
                } else {
                    // If label not found, just move to next instruction
                    pruState.errorParsing++;
                    pruState.pc++;
                }
            } else {
                pruState.pc++;
            }
            break;
        }

        case 'QBA': {
            // QBA label - Quick Branch Always (unconditional branch)
            const label = operands[0];
            
            // Always branch to the label
            if (labelMap[label] !== undefined) {
                pruState.pc = labelMap[label];
            } else {
                // If label not found, just move to next instruction
                pruState.errorParsing++;
                pruState.pc++;
            }
            break;
        }
        
        case 'LBCO':
        case 'LBBO': {
            // Extract operands
            // LBBO/LBCO &dest, baseAddr, byteOffset, byteCount
            // Remove the '&' from the destination
            const lbboDest = operands[0].replace(/&|,/g, '');
            const lbboBaseAddr = operands[1].replace(/,/g, '');
            const lbboByteOffset = operands[2].replace(/,/g, '');
            const lbboByteCount = operands[3].replace(/,/g, '');
            
            cyclesToAdd = executeLBBO(pruState, lbboDest, lbboBaseAddr, lbboByteOffset, lbboByteCount);
            pruState.pc++;
            if(cyclesToAdd == 0)
            {
                pruState.errorParsing++;
            }
            break;
        }
            
        case 'SBCO':
        case 'SBBO': {
            // Extract operands
            // SBBO &src, baseAddr, byteOffset, byteCount
            // Remove the '&' from the source
            const sbboSrc = operands[0].replace(/&|,/g, '');
            const sbboBaseAddr = operands[1].replace(/,/g, '');
            const sbboByteOffset = operands[2].replace(/,/g, '');
            const sbboByteCount = operands[3].replace(/,/g, '');
            
            cyclesToAdd = executeSbbo(pruState, sbboSrc, sbboBaseAddr, sbboByteOffset, sbboByteCount);
            pruState.pc++;
            if(cyclesToAdd == 0)
            {
                pruState.errorParsing++;                    
            }
            break;
        }

        case 'LOOP': {
            console.log(`Executing PC ${pruState.pc}: LOOP ${operands.join(' ')}`);
            // LOOP label, count
            const label = operands[0].replace(/,/g, '');
            // Parse the count operand which can be a register or immediate
            let count;
            if (operands[1].toLowerCase().startsWith('r')) {
                const countRegInfo = parseRegister(operands[1]);
                if (handleParsingError(pruState, countRegInfo)) {
                    pruState.pc++;
                    break;
                }
                count = getRegisterValue(pruState, countRegInfo);
                // If using byte/word access, use the appropriate mask from countRegInfo
                if (countRegInfo.type !== 'full') {
                    count = count & countRegInfo.mask;
                }
            } else {
                count = parseImmediate(operands[1]);
                if (handleParsingError(pruState, count)) {
                    pruState.pc++;
                    break;
                }      
                // Limit to 8 bits (1-255) for immediate values
                count = count & 0xFF;
            }
            // Make sure count is valid (1-255)
            count = Math.max(1, Math.min(255, count));
            // Find the target label in the label map
            if (labelMap[label] !== undefined) {
                // Store loop information in pruState
                if (!pruState.loopStack) {
                    pruState.loopStack = [];
                }       
                // Push loop info to stack (PC to return to after loop, target label, and count)
                pruState.loopStack.push({
                    returnPC: pruState.pc + 1,
                    targetLabel: labelMap[label],
                    count: count,
                    currentIteration: 1
                });
                // Move to the instruction after LOOP
                pruState.pc++;
            } else {
                // If label not found, increment error counter and move to next instruction
                pruState.errorParsing++;
                pruState.pc++;
            }
            break;
        }

        case 'NOP': {
            // NOP - No Operation
            // Does nothing except consume a cycle
            pruState.pc++;
            break;
        }

        case 'ZERO': {
            const op1Info = parseRegisterReference(operands[0].replace(/&|,/g, ''));
            const byteCountStr = operands[1] ? operands[1].replace(/,/g, '') : "4";
            const byteCount = parseImmediate(byteCountStr);
            if (op1Info) {
                const startReg = (op1Info.regNum !== undefined) ? op1Info.regNum : op1Info.reg;
                const numRegs = Math.ceil(byteCount / 4);
                for (let i = 0; i < numRegs && (startReg + i) < 32; i++) {
                    pruState.registers[startReg + i] = 0;
                }
            }
            pruState.pc++;
            break;
        }

        case 'FILL': {
            const op1Info = parseRegisterReference(operands[0].replace(/&|,/g, ''));
            const byteCountStr = operands[1] ? operands[1].replace(/,/g, '') : "4";
            const byteCount = parseImmediate(byteCountStr);
            if (op1Info) {
                const startReg = (op1Info.regNum !== undefined) ? op1Info.regNum : op1Info.reg;
                const numRegs = Math.ceil(byteCount / 4);
                for (let i = 0; i < numRegs && (startReg + i) < 32; i++) {
                    pruState.registers[startReg + i] = 0xFFFFFFFF;
                }
            }
            pruState.pc++;
            break;
        }

        case 'MULL': {
            // MULL rX[.bx/.wx], rY[.bx/.wx], rZ[.bx/.wx]
            throw new Error("Simulator Error: PRU instruction 'MULL' does not exist in this PRU core. Use XOUT/XIN with MAC instead.");
            break;
        }

        case 'XOUT': {
            const deviceIdStr = operands[0].replace(/,/g, '');
            const deviceId = parseImmediate(deviceIdStr);
            if (handleParsingError(pruState, deviceId)) {
                pruState.pc++;
                break;
            }

            const op2Info = parseRegisterReference(operands[1].replace(/&|,/g, ''));
            const byteCountStr = operands[2] ? operands[2].replace(/,/g, '') : "4";
            const byteCount = parseImmediate(byteCountStr);

            if (deviceId === 0) {
                // MAC config
                if (!pruState.mac) pruState.mac = { enabled: false, mode: 0, result: 0n };
                pruState.mac.enabled = true;
                if (op2Info) {
                    pruState.mac.mode = getRegisterValue(pruState, op2Info);
                }
            } else if (deviceId >= 10 && deviceId <= 12) {
                // SPAD write
                const bank = deviceId - 10;
                if (byteCount > 120) {
                    throw new Error(`Simulator Error: SPAD transfer out of bounds (max 120 bytes). Attempted to transfer ${byteCount} bytes.`);
                }
                if (!pruState.spad) pruState.spad = { banks: [[], [], []] };
                if (op2Info) {
                    const startReg = op2Info.regNum;
                    const words = Math.ceil(byteCount / 4);
                    for(let i=0; i<words; i++) {
                        pruState.spad.banks[bank][i] = pruState.registers[(startReg + i) % 32];
                    }
                }
            }
            pruState.pc++;
            break;
        }

        case 'XIN': {
            const deviceIdStr = operands[0].replace(/,/g, '');
            const deviceId = parseImmediate(deviceIdStr);
            if (handleParsingError(pruState, deviceId)) {
                pruState.pc++;
                break;
            }

            const op2Info = parseRegisterReference(operands[1].replace(/&|,/g, ''));
            const byteCountStr = operands[2] ? operands[2].replace(/,/g, '') : "4";
            const byteCount = parseImmediate(byteCountStr);

            if (deviceId === 0) {
                // MAC read
                if (!pruState.mac) pruState.mac = { enabled: false, mode: 0, result: 0n };

                // Compute result on XIN
                if (pruState.mac.enabled) {
                    // Standard 32x32 -> 64 signed multiply
                    const op1 = pruState.registers[28];
                    const op2 = pruState.registers[29];
                    // Convert to JS signed 32-bit integer, then to BigInt
                    const val1 = BigInt(op1 | 0);
                    const val2 = BigInt(op2 | 0);
                    pruState.mac.result = val1 * val2;
                }

                if (op2Info) {
                    if (op2Info.regNum === 25) {
                        pruState.registers[op2Info.regNum] = pruState.mac.mode;
                    } else if (op2Info.regNum === 27) {
                        // Return upper 32 bits
                        pruState.registers[op2Info.regNum] = Number((pruState.mac.result >> 32n) & 0xFFFFFFFFn) >>> 0;
                    } else {
                        // Return lower 32 bits
                        pruState.registers[op2Info.regNum] = Number(pruState.mac.result & 0xFFFFFFFFn) >>> 0;
                        if (byteCount > 4) {
                            // Return upper 32 bits in next register
                            pruState.registers[(op2Info.regNum + 1) % 32] = Number((pruState.mac.result >> 32n) & 0xFFFFFFFFn) >>> 0;
                        }
                    }
                }
            } else if (deviceId >= 10 && deviceId <= 12) {
                // SPAD read
                const bank = deviceId - 10;
                if (byteCount > 120) {
                    throw new Error(`Simulator Error: SPAD transfer out of bounds (max 120 bytes). Attempted to transfer ${byteCount} bytes.`);
                }
                if (!pruState.spad) pruState.spad = { banks: [[], [], []] };
                if (op2Info) {
                    const startReg = op2Info.regNum;
                    const words = Math.ceil(byteCount / 4);
                    for(let i=0; i<words; i++) {
                        pruState.registers[(startReg + i) % 32] = pruState.spad.banks[bank][i] || 0;
                    }
                }
            }
            pruState.pc++;
            break;
        }

        case 'HALT': {
            // End simulation. With devices attached, the DEVICE keeps living
            // after the firmware stops: jumping the cycle counter to the end
            // would hand it one giant tick, and a monoflop that should
            // quietly expire mid-idle instead reads as a stalled transfer.
            // Mark halted and let the main loop idle the bus out to
            // cycleCount, one cycle at a time.
            if (pruState.deviceBus) {
                pruState.halted = true;
                pruState.pc++;
            } else {
                pruState.cycles = cycleCount;
            }
            break;
        }

        default: {
            // intent: fail loudly on real PRU instructions we know are not
            // yet modelled, so block-level tests can't silently "pass" on them.
            // But the static validator simulates the FULL generated firmware, which
            // contains macro invocations (m_*) and assembler directives (.*) that are
            // NOT base instructions and must not be executed here. Throwing on those
            // would break validation/build of every real example. So: throw only for
            // the explicit set of recognised-but-unimplemented base instructions, and
            // skip everything else (restoring pre-strict behaviour for macro calls).
            const UNIMPLEMENTED_BASE_INSTRUCTIONS = ["MAC", "MACU", "WBC"];
            if (UNIMPLEMENTED_BASE_INSTRUCTIONS.indexOf(opcode) !== -1) {
                throw new Error("Simulator Error: PRU instruction '" + opcode + "' is recognised but not yet implemented in pru_core.js (PC " + pruState.pc + "). Please add support before simulating blocks that use it.");
            }
            // Macro calls (m_*), directives (.*), and other non-base tokens: skip.
            // Track skipped macro calls (m_*) so the preview message can
            // explain why a macro-based design produced no protocol activity instead
            // of falsely reporting that the attached device was silent.
            const rawToken = instructionMatch[1];
            if (/^m_/i.test(rawToken)) {
                pruState.skippedMacroCount = (pruState.skippedMacroCount || 0) + 1;
                if (!pruState.skippedMacros) {
                    pruState.skippedMacros = [];
                }
                const macroName = rawToken.toLowerCase();
                if (pruState.skippedMacros.indexOf(macroName) === -1) {
                    pruState.skippedMacros.push(macroName);
                }
            }
            pruState.unknownInstruction++;
            pruState.pc++;
            break;
        }
    }

    // Check if we've reached a loop target label and need to handle loop control
    if (pruState.loopStack && pruState.loopStack.length > 0) {
        const currentLoop = pruState.loopStack[pruState.loopStack.length - 1];
        // If we've reached the target label
        if (pruState.pc === currentLoop.targetLabel) {
            // Check if we've completed all iterations
            if (currentLoop.currentIteration >= currentLoop.count) {
                // Loop complete, pop from stack and continue execution after the loop
                pruState.loopStack.pop();
            } else {
                // Increment iteration counter and jump back to instruction after LOOP
                currentLoop.currentIteration++;
                pruState.pc = currentLoop.returnPC;
            }
        }
    }

    // For multi-cycle instructions, push one value per cycle to keep array index = cycle number
    for (let c = 0; c < cyclesToAdd; c++) {
        pruState.cycles++;

        // Update R31 based on simulation input for this cycle
        if (pruState.r31HistoryMap && pruState.r31HistoryMap[pruState.cycles] !== undefined) {
            pruState.registers[31] = pruState.r31HistoryMap[pruState.cycles];
        }

        // Attached device models (Simulation Settings "Attached Device Model"
        // mode) close the loop: the bus resolves this cycle's R30 against the
        // devices' drives and the result is what R31 samples. This runs AFTER
        // the fixed history so a pin under device control is owned by the
        // device - a pre-authored history bit on the same pin would be two
        // drivers for one wire, and the bus is the only arbiter.
        if (pruState.deviceBus) {
            pruState.registers[31] = pruState.deviceBus.settle(pruState.cycles, pruState.registers[30]);
        }

        // Update IEP timer state, per TRM SPRUIM2J 6.4.13.
        // The counter only runs when enabled, compares fire only when CMP_EN
        // is set, and auto-reset needs CMP0_RST_CNT_EN, so firmware that never
        // configures the IEP cannot appear to work here and then hang on silicon.
        if (pruState.iepGlobalCfg & 0x1) {                       // [0] CNT_ENABLE
            const inc = (pruState.iepGlobalCfg >> 4) & 0xF;      // [7:4] DEFAULT_INC
            // The counter is 64-bit across COUNT_REG0/REG1. Carrying into the
            // high word matters: truncating at 32 bits wraps after 2^32 updates
            // (~21s at 200MHz) and makes any compare above 2^32 unreachable.
            const sum = pruState.iepCount + inc;
            pruState.iepCount = sum >>> 0;
            if (sum > 0xFFFFFFFF) {
                pruState.iepCountHi = (pruState.iepCountHi + 1) >>> 0;
            }
            let hit0 = false;
            for (let j = 0; j < 16; j++) {
                // [16:1] CMP_EN, bit 1 maps to CMP0.
                // EQUALITY, not >=. The IEP compare is a match on the counter
                // value, so with DEFAULT_INC > 1 a compare value that is not on
                // an increment boundary is stepped over and never fires - that is
                // hardware behaviour, not a modelling shortcut, and firmware must
                // program compares consistent with its increment. Using >= would
                // instead re-assert the event on every cycle past the threshold.
                if ((pruState.iepCmpCfg & (1 << (j + 1)))
                    && pruState.iepCount === pruState.iepCmp[j]
                    && pruState.iepCountHi === pruState.iepCmpHi[j]) {
                    pruState.iepCmpStatus |= (1 << j);
                    if (j === 0) hit0 = true;
                }
            }
            if (hit0 && (pruState.iepCmpCfg & 0x1)) {            // [0] CMP0_RST_CNT_EN
                pruState.iepCount = 0;
                pruState.iepCountHi = 0;
            }
        }

        r30ValueHistory.push(pruState.registers[30]);
        r31ValueHistory.push(pruState.registers[31]);
    }
    return;
}

/**
 * Simulates PRU instructions execution for a specified number of pruState.cycles
 *
 * @param {Array} pruInstructions - Array of PRU instructions to execute
 * @param {Array} pruInstructionsLabels - Array of labels corresponding to the instructions
 * @param {number} cycleCount - Number of pruState.cycles to simulate
 * @param {Object} r31HistoryMap - Optional map of cycle numbers to R31 values for simulation input (default: {})
 * @param {Object} mmioMap - Optional MMIO stub map
 * @param {Object} deviceBus - Optional DeviceBus (device_bus.js) with attached
 *        device models. When given, the bus is settled every cycle and its
 *        resolved level replaces R31 - this is the closed loop that Timestamp
 *        and Pattern mode cannot express, because a pre-authored history
 *        cannot react to what the firmware does.
 * @return {Object} The pruState and r30ValueHistory after simulation
 */
function simulatePruInstructions(pruInstructions, pruInstructionsLabels, cycleCount, r31HistoryMap = {}, mmioMap = {}, deviceBus = null) {
    // Initialize pruState.registers (r0-r31)
    const pruState = {
        registers : new Array(32).fill(0),
        pc: 0,
        cycles: 0,
        carry: 0,
        loopStack : [],
        unknownInstruction : 0,
        errorParsing : 0,
        skippedMacroCount: 0,
        skippedMacros: [],
        r31HistoryMap: r31HistoryMap,
        mmioMap: mmioMap,
        deviceBus: deviceBus,
        halted: false,
        iepCount: 0,
        iepGlobalCfg: 0,
        iepCmpCfg: 0,
        iepCountHi: 0,
        iepCmp: new Array(16).fill(0),
        iepCmpHi: new Array(16).fill(0),
        iepCmpStatus: 0
    };

    // With devices attached, R30 starts at the bus idle (driven pins high),
    // not at zero: the bus contract is pull-up idle, and a cold 0 would
    // present every clocked device with a falling edge the firmware never
    // generated. Open-loop runs (no bus) keep the historical zero start.
    if (deviceBus) {
        pruState.registers[30] = deviceBus.idlePruWord();
    }

    const r30ValueHistory = [deviceBus ? deviceBus.idlePruWord() : 0];
    const r31ValueHistory = [0];

    // Create label map for jumps
    const labelMap = {};
    for (let i = 0; i < pruInstructionsLabels.length; i++) {
        if (pruInstructionsLabels[i] !== 0) {
            labelMap[pruInstructionsLabels[i]] = i;
        }
    }

    // Execute instructions until cycle count is reached or PC is out of bounds
    while (pruState.cycles < cycleCount && pruState.pc < pruInstructions.length) {
        if (pruState.halted) {
            // Firmware halted with devices attached: the devices keep living.
            pruState.cycles++;
            pruState.registers[31] = pruState.deviceBus.settle(pruState.cycles, pruState.registers[30]);
            r30ValueHistory.push(pruState.registers[30]);
            r31ValueHistory.push(pruState.registers[31]);
            continue;
        }
        executeInstruction(pruState, pruInstructions, labelMap, r30ValueHistory, r31ValueHistory, cycleCount);
    }

    return {pruState, r30ValueHistory, r31ValueHistory};
}

// Export the functions and constants
exports = {
    simulatePruInstructions
};