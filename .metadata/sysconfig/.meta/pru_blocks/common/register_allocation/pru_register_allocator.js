/**
 * PRU Register Allocator
 * 
 * Manages allocation of PRU registers (R0-R29) for blocks.
 * R28 and R29 are reserved as temporary registers per block.
 */

// Constants for register allocation
const TOTAL_PRU_REGISTERS = 30;      // Total registers R0-R29
const RESERVED_REGISTERS = 2;        // Reserve registers if required (R28 & R29 are reserved as temp registers)
const numOfPruRegisters = TOTAL_PRU_REGISTERS - RESERVED_REGISTERS; // Available for allocation
const numOfBytesPerRegister = 4;
const totalBytes = numOfPruRegisters * numOfBytesPerRegister;

// System modules reference
const systemModules = system.modules;

// Global state variables
let moduleInstanceRegisterMap;
let pruByteArray;
let pruRegisterAllocationSummary;
let cycleBudgetMap = new Map();
let groupMetadata;
let loopCounterRegisters = {};  // Track loop counters: {instanceName: {byteOffset, numBytes}}
let groupReturnAddrByteOffset = -1;  // Single allocated return address register for all group blocks

/**
 * Returns PRU registers allocation summary
 */
function getPruRegisterAllocationSummary() {
    return pruRegisterAllocationSummary;
}

/**
 * Gets free byte offset from available PRU register memory
 * @param {number} numOfBytes - Number of bytes requested (any size up to 112 bytes)
 * @returns {number} Byte offset or -1 if not available
 */
function getFreeByteOffset(numOfBytes) {
    for (let i = 0; i < totalBytes; i++) {
        // Check alignment requirements based on byte size
        // 1 byte: any alignment
        // 2 bytes: must not start at byte 3 (prevents crossing register boundary)
        // 4+ bytes: must be register-aligned (start at byte 0 of a register)
        let alignmentOk = false;

        if (numOfBytes === 1) {
            alignmentOk = true;  // Any alignment (byte sub-field: .b0, .b1, .b2, .b3)
        } else if (numOfBytes === 2) {
            alignmentOk = ((i % 4) !== 3);  // Word sub-field alignment (.w0 at bytes 0-1, .w1 at bytes 1-2, .w2 at bytes 2-3)
        } else {
            alignmentOk = ((i % 4) === 0);  // Register-aligned for 3+ bytes
        }

        if (alignmentOk) {
            let numOfFreeBytesFound = 0;

            // Check if we have enough contiguous free bytes
            for (let j = i; j < i + numOfBytes && j < totalBytes; j++) {
                if (pruByteArray[j] === 0) {
                    numOfFreeBytesFound += 1;
                } else {
                    break;
                }
            }

            if (numOfFreeBytesFound === numOfBytes) {
                // Mark bytes as reserved
                for (let j = i; j < i + numOfBytes && j < totalBytes; j++) {
                    pruByteArray[j] = 1;
                }
                return i;
            }
        }
    }

    // Required number of free bytes not found
    return -1;
}

/**
 * Converts byte offset to PRU register notation
 * @param {number} byteOffset - Byte offset in PRU memory
 * @param {number} numOfBytes - Number of bytes required (any size up to 112 bytes)
 * @returns {string|number} PRU register notation or -1 if unallocated
 */
function getPruRegister(byteOffset, numOfBytes) {
    if (byteOffset === -1) {
        // Register unallocated
        return -1;
    }

    let pruRegister = parseInt(byteOffset / numOfBytesPerRegister);

    // Format register based on byte size
    if (numOfBytes === 1) {
        // Single byte: R#.b0, R#.b1, R#.b2, or R#.b3
        pruRegister = `R${pruRegister}.b${byteOffset % numOfBytesPerRegister}`;
    } else if (numOfBytes === 2) {
        // Two bytes: R#.w0, R#.w1, or R#.w2
        pruRegister = `R${pruRegister}.w${byteOffset % numOfBytesPerRegister}`;
    } else if (numOfBytes === 4) {
        // Single register: R#
        pruRegister = `R${pruRegister}`;
    } else {
        // Multi-register allocation (5+ bytes): Return starting register only
        // Blocks that use multi-register allocations (like UART) will handle
        // the register range themselves based on their specific needs
        pruRegister = `R${pruRegister}`;
    }

    return pruRegister;
}

/**
 * Releases allocated PRU register memory
 * @param {number} byteOffset - Starting byte offset
 * @param {number} numOfBytes - Number of bytes to release
 */
function disallocatePruRegisters(byteOffset, numOfBytes) {
    // If registers were not allocated (byteOffset is -1), nothing to do
    if (byteOffset === -1) {
        return;
    }
    
    // Clear the allocated bytes in the pruByteArray
    for (let i = byteOffset; i < (byteOffset + numOfBytes); i++) {
        pruByteArray[i] = 0;
    }
}

/**
 * Inverts PRU instruction opcode for conditional branching
 * @param {string} opCode - Original opcode
 * @returns {string} Inverted opcode
 */
function invertOpcode(opCode) {
    const opcodeMap = {
        "QBGT": "QBLE",
        "QBLT": "QBGE",
        "QBLE": "QBGT",
        "QBGE": "QBLT",
        "QBEQ": "QBNE",
        "QBNE": "QBEQ"
    };
    
    return opcodeMap[opCode] || opCode;
}

function addToPruRegisterAllocationSummary(label, instruction, instance, instanceName, cycleConsumed) {
    // Skip adding to instruction stream if this is a declaration-only block
    // Check if: 0 cycles AND (empty opCode OR opCode is "")
    if (cycleConsumed === 0 && instance &&
        (instance.opCode === "" || !instance.opCode || instance.opCode.trim() === "")) {
        //This block does not have any assembly instruction (eg :- memory variable allocates memory using linker directives)
        return;
    }

    pruRegisterAllocationSummary.labels.push(typeof label === 'string' ? label : 0);
    pruRegisterAllocationSummary.pruInstructions.push(instruction);
    pruRegisterAllocationSummary.pruInstructionInstances.push(instance);
    if(cycleConsumed != 0)
    {
        pruRegisterAllocationSummary.pruInstructionModules.push(moduleInstanceRegisterMap[instanceName]["moduleName"]);
        pruRegisterAllocationSummary.connectedNodesInPeakCyclePath.push(moduleInstanceRegisterMap[instanceName]["connectedNodesInPeakCyclePath"]);
        pruRegisterAllocationSummary.peakCycles.push(cycleConsumed);
    }else{
        pruRegisterAllocationSummary.pruInstructionModules.push(null);
        pruRegisterAllocationSummary.connectedNodesInPeakCyclePath.push(null);
        pruRegisterAllocationSummary.peakCycles.push(cycleConsumed);
    }
}

/**
 * Extracts and removes pre-init block instructions from the instruction arrays.
 * These instructions will be moved before the loop setup.
 * @param {number} startIndex - Index from where to start looking for pre-init instructions
 * @param {Set} preInitBlockNames - Set of block names that are marked as pre-init
 * @returns {Object} Object containing extracted instructions and their count
 */
function extractPreInitInstructions(startIndex, preInitBlockNames) {
    const extracted = {
        labels: [],
        instructions: [],
        instances: [],
        modules: [],
        peakCycles: [],
        connectedNodes: []
    };

    if (preInitBlockNames.size === 0) {
        return extracted;
    }

    // Find indices of pre-init block instructions (collect in reverse order to safely splice)
    const indicesToRemove = [];
    for (let i = startIndex; i < pruRegisterAllocationSummary.pruInstructions.length; i++) {
        const inst = pruRegisterAllocationSummary.pruInstructionInstances[i];
        if (inst && preInitBlockNames.has(inst.$name)) {
            indicesToRemove.push(i);
        }
    }

    // Extract in reverse order to maintain correct indices during removal
    for (let j = indicesToRemove.length - 1; j >= 0; j--) {
        const i = indicesToRemove[j];
        // Extract and remove from each array
        extracted.labels.unshift(pruRegisterAllocationSummary.labels.splice(i, 1)[0]);
        extracted.instructions.unshift(pruRegisterAllocationSummary.pruInstructions.splice(i, 1)[0]);
        extracted.instances.unshift(pruRegisterAllocationSummary.pruInstructionInstances.splice(i, 1)[0]);
        extracted.modules.unshift(pruRegisterAllocationSummary.pruInstructionModules.splice(i, 1)[0]);
        extracted.peakCycles.unshift(pruRegisterAllocationSummary.peakCycles.splice(i, 1)[0]);
        extracted.connectedNodes.unshift(pruRegisterAllocationSummary.connectedNodesInPeakCyclePath.splice(i, 1)[0]);
    }

    return extracted;
}

/**
 * Inserts pre-init instructions at the specified index in the instruction arrays.
 * @param {number} insertIndex - Index where to insert the pre-init instructions
 * @param {Object} preInitData - Object containing the extracted pre-init data
 */
function insertPreInitInstructions(insertIndex, preInitData) {
    if (preInitData.instructions.length === 0) {
        return;
    }

    // Insert all extracted arrays at the specified index
    pruRegisterAllocationSummary.labels.splice(insertIndex, 0, ...preInitData.labels);
    pruRegisterAllocationSummary.pruInstructions.splice(insertIndex, 0, ...preInitData.instructions);
    pruRegisterAllocationSummary.pruInstructionInstances.splice(insertIndex, 0, ...preInitData.instances);
    pruRegisterAllocationSummary.pruInstructionModules.splice(insertIndex, 0, ...preInitData.modules);
    pruRegisterAllocationSummary.peakCycles.splice(insertIndex, 0, ...preInitData.peakCycles);
    pruRegisterAllocationSummary.connectedNodesInPeakCyclePath.splice(insertIndex, 0, ...preInitData.connectedNodes);
}

function processLoopCounterGroup(instance) {
    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents;
    let maxCycles = 0;
    // First pass: Process program control block (without output1 port or T and F ports and next ports)
    for (const instanceName of groupContents) {
        const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
        if(moduleInstanceRegisterMap[instanceName]?.endBlock === true)
        {
            const instance = systemModules[moduleName]?.$instances[instanceNum];
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
            maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[instanceName].peakCycles);
        }
    }
    
    // Second pass: Process all blocks without output1 port or T and F ports and next port is unconnected
    for (const instanceName of groupContents) {
        // skip blocks which are in group blocks (eg: loop block)
        if (moduleInstanceRegisterMap[instanceName]?.nextArrayLength === -1) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
            const instance = systemModules[moduleName]?.$instances[instanceNum]; 
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
            maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[instanceName].peakCycles);
        }
    }

    // Third pass: Process all result nodes (end nodes where output isn't connected to anything)
    for (const instanceName of groupContents) {
        // skip blocks which are in group blocks (eg: loop block)
        if (moduleInstanceRegisterMap[instanceName]?.output1ArrayLength === -1) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
            const instance = systemModules[moduleName]?.$instances[instanceNum];     
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
            maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[instanceName].peakCycles);
        }
    }
    
    return maxCycles;
}
function processGroupBlock(instance){
    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents;
    let maxCycles = 0;
    const instanceName = instance.$name;
    const groupName = instance.groupName || instanceName;

    // Allocate return address register on first group block (2 bytes for word address)
    if (groupReturnAddrByteOffset === -1) {
        groupReturnAddrByteOffset = getFreeByteOffset(2);
    }

    let label = `${groupName}_start`;
    let instruction = "0";
    //first pass
    addToPruRegisterAllocationSummary(label,instruction,instance,instanceName,0);
    for (const childInstanceName of groupContents){
        const {moduleName,instanceNum} = moduleInstanceRegisterMap[childInstanceName];
        if(moduleInstanceRegisterMap[childInstanceName]?.endBlock===true){
            const childInstance = systemModules[moduleName]?.$instances[instanceNum];
            pushInstruction(childInstance,null);
            if("conditionCalculated" in moduleInstanceRegisterMap[childInstanceName]){
                moduleInstanceRegisterMap[childInstanceName].conditionCalculated=1;
            }
            else if("blockOutputCalculated" in moduleInstanceRegisterMap[childInstanceName]){
                moduleInstanceRegisterMap[childInstanceName].blockOutputCalculated=1;
            }
            maxCycles = Math.max(maxCycles,moduleInstanceRegisterMap[childInstanceName].peakCycles);
        }
    }
    // Second pass: Process blocks with unconnected next port
    for (const childInstanceName of groupContents) {
        if (moduleInstanceRegisterMap[childInstanceName]?.nextArrayLength === -1) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[childInstanceName];
            const childInstance = systemModules[moduleName]?.$instances[instanceNum];
            pushInstruction(childInstance, null);

            if("conditionCalculated" in moduleInstanceRegisterMap[childInstanceName]) {
                moduleInstanceRegisterMap[childInstanceName].conditionCalculated = 1;
            } else if ("blockOutputCalculated" in moduleInstanceRegisterMap[childInstanceName]) {
                moduleInstanceRegisterMap[childInstanceName].blockOutputCalculated = 1;
            }
            maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[childInstanceName].peakCycles);
        }
    }

    // Third pass: Process result nodes (unconnected output)
    for (const childInstanceName of groupContents) {
        if (moduleInstanceRegisterMap[childInstanceName]?.output1ArrayLength === -1) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[childInstanceName];
            const childInstance = systemModules[moduleName]?.$instances[instanceNum];
            pushInstruction(childInstance, null);

            if("conditionCalculated" in moduleInstanceRegisterMap[childInstanceName]) {
                moduleInstanceRegisterMap[childInstanceName].conditionCalculated = 1;
            } else if ("blockOutputCalculated" in moduleInstanceRegisterMap[childInstanceName]) {
                moduleInstanceRegisterMap[childInstanceName].blockOutputCalculated = 1;
            }
            maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[childInstanceName].peakCycles);
        }
    }

    // Automatically generate return instruction at end of group and 1 to maxCycles
    // This allows groups to be called with CALL and return automatically
    const retAddrRegister = getPruRegister(groupReturnAddrByteOffset, 2);
    let returnInstruction = `JMP ${retAddrRegister}`;
    addToPruRegisterAllocationSummary("", returnInstruction, instance, instanceName, 0);

    return maxCycles + 1;
}
/**
 * Step 1: Collect all blocks on a branch by following next and output1
 * ports forward from the branch head.
 * @param {Object} instance - Branch head (block connected to T or F port)
 * @returns {Set<string>} Set of instance names on this branch's chain
 */
function collectBranchChain(instance) {
    const chain = new Set();
    const queue = [instance];

    while (queue.length > 0) {
        const inst = queue.shift();
        if (!inst || !inst.$name) continue;
        const name = inst.$name;
        if (chain.has(name)) continue;
        chain.add(name);

        // Forward: control flow
        const nextInst = inst.next?.[0]?.inst;
        if (nextInst) queue.push(nextInst);

        // Forward: data flow to consumers
        if (inst.output1) {
            for (const conn of inst.output1) {
                if (conn?.inst) queue.push(conn.inst);
            }
        }
    }

    return chain;
}

/**
 * Step 2: Collect all transitive input-port predecessors of a set of blocks.
 * Only walks backward via input ports — never crosses into branch blocks.
 * @param {Set<string>} chainNames - Set of block names on the branch chain
 * @returns {Set<string>} Set of input dependency instance names
 */
function collectInputDependencies(chainNames) {
    const deps = new Set();
    const queue = [];

    // Seed the queue with direct inputs of every block in the chain
    for (const name of chainNames) {
        const { moduleName, instanceNum } = moduleInstanceRegisterMap[name] || {};
        if (moduleName === undefined) continue;
        const inst = system.modules[moduleName]?.$instances[instanceNum];
        if (!inst) continue;
        for (let i = 1; i <= (inst.numOfInputPorts || 0); i++) {
            const inputInst = inst["input" + i]?.[0]?.inst;
            if (inputInst && !chainNames.has(inputInst.$name)) {
                queue.push(inputInst);
            }
        }
    }

    while (queue.length > 0) {
        const inst = queue.shift();
        if (!inst || !inst.$name) continue;
        const name = inst.$name;
        if (deps.has(name)) continue;
        deps.add(name);

        // Keep walking backward via input ports
        for (let i = 1; i <= (inst.numOfInputPorts || 0); i++) {
            const inputInst = inst["input" + i]?.[0]?.inst;
            if (inputInst) queue.push(inputInst);
        }
    }

    return deps;
}

/**
 * Collects all input dependencies of a branch (data blocks that feed into
 * the branch but are not part of the branch chain itself).
 * @param {Object} instance - Branch head (block connected to T or F port)
 * @returns {Set<string>} Set of input dependency instance names
 */
function collectInputPredecessors(instance) {
    const chain = collectBranchChain(instance);
    return collectInputDependencies(chain);
}

/**
 * Gets PRU Instructions from blocks connected in the system
 * @param {Object} instance - The current block instance
 * @param {Object} parentInstance - The parent block instance
 * @returns {number|string} Number of bytes allocated to output port 1 if available, label for conditional blocks, or -1 if allocation failed
 */
function pushInstruction(instance, parentInstance) {
    // Early return if instance is null
    if (instance === null) {
        return;
    }
    
    const instanceName = instance.$name;
    
    // Handle output array tracking
    if (moduleInstanceRegisterMap[instanceName]?.output1ArrayLength !== -1) {
        moduleInstanceRegisterMap[instanceName].output1ArrayLength--;
    }
    
    // Return early if output has already been calculated
    if (moduleInstanceRegisterMap[instanceName]?.blockOutputCalculated === 1) {
        return moduleInstanceRegisterMap[instanceName].numOfBytesReqByOutput1; 
    }
    
    // Return label if condition is already calculated
    if (moduleInstanceRegisterMap[instanceName]?.conditionCalculated === 1) {
        return moduleInstanceRegisterMap[instanceName].label;
    }
    // Process prev port if it exists and is connected
    let label;
    if (instance?.["prev"] && instance?.["prev"][0]?.["inst"]) {
        const prevPortInstanceName = instance["prev"][0]?.["inst"]?.$name;
        // Process the previous block
        label = pushInstruction(instance["prev"][0]["inst"], instance);
        moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath =
        new Set([...moduleInstanceRegisterMap[prevPortInstanceName].connectedNodesInPeakCyclePath]);
        // If prev returned a conditional branch label, emit it as a standalone
        // label line now — before any input processing — so that all inputs
        // for this branch are emitted AFTER the label, not before it.
        if (typeof label === "string" && label !== "") {
            addToPruRegisterAllocationSummary(label, "0", instance, instanceName, 0);
            label = 0;
        }
    }

    // If this is a conditional block, hoist shared input predecessors of both
    // branches BEFORE processing the if/else's own input ports.
    // This ensures hoisted blocks get their registers first, so the input
    // registers are not deallocated and reused by hoisted blocks.
    // This issue comes cause we are not going with the noraml register allocation
    // process and are allocating the registers for the blocks connected to the T/F ports 
    // of the if/else block first 
    if (instance.T && instance.F) {
        const trueHead  = instance.T?.[0]?.inst;
        const falseHead = instance.F?.[0]?.inst;
        if (trueHead && falseHead) {
            const truePreds  = collectInputPredecessors(trueHead);
            const falsePreds = collectInputPredecessors(falseHead);
            for (const sharedName of truePreds) {
                if (falsePreds.has(sharedName)) {
                    const { moduleName, instanceNum } = moduleInstanceRegisterMap[sharedName];
                    const sharedInst = systemModules[moduleName]?.$instances[instanceNum];
                    if (sharedInst) {
                        pushInstruction(sharedInst, null);
                    }
                }
            }
        }
    }

    // Process input ports
    const inputPort = "input";
    let maxBytesUsed = 1;
    let inputValues = "";

    // Process each input port
    for (let iterator1 = 1; iterator1 <= instance.numOfInputPorts; iterator1++) {
        const inputInstance = instance[inputPort + iterator1]?.[0]?.inst;
        const inputInstanceName = inputInstance?.$name;
        
        if (inputInstanceName) {
            // Recursively process connected input
            const noOfBytesUsedByInput = pushInstruction(inputInstance, instance);

            moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath = new Set([
                ...moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath,
                ...moduleInstanceRegisterMap[inputInstanceName].connectedNodesInPeakCyclePath
            ]);
            
            // Update max bytes used
            maxBytesUsed = noOfBytesUsedByInput > maxBytesUsed ? noOfBytesUsedByInput : maxBytesUsed;
            
            // Get register notation for this input's output
            inputValues = inputValues + getPruRegister(
                moduleInstanceRegisterMap[inputInstanceName].byteOffsetOfOutput1,
                moduleInstanceRegisterMap[inputInstanceName].numOfBytesReqByOutput1
            ) + " , ";
        }
    }

    // Update output size if output1Size is specified and not set to "maxOfInputs"
    if (instance["output1Size"] && instance["output1Size"] !== "maxOfInputs") {
        maxBytesUsed = parseInt(instance["output1Size"]);
    }

    // get peak cycle path nodes cycle budget
    for (const value of moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath) {
        if(moduleInstanceRegisterMap[instanceName]["peakCycles"] == "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN")
        {
            break;    
        }
        if(cycleBudgetMap[value] == "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN")
        {
            moduleInstanceRegisterMap[instanceName]["peakCycles"] = "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN";
            break;
        }
        moduleInstanceRegisterMap[instanceName]["peakCycles"] += cycleBudgetMap[value];
    }

    // Append constant values
    for (let iterator1 = 1; iterator1 <= (instance.numOfConstants || 0); iterator1++) {
        inputValues = inputValues + instance["constant" + iterator1] + " , ";
    }
    
    // Disallocate registers for inputInstance ports that are no longer needed
    for (let iterator1 = 1; iterator1 <= instance.numOfInputPorts; iterator1++) {
        const inputInstance = instance[inputPort + iterator1]?.[0]?.inst;
        const inputInstanceName = inputInstance?.$name;
        if (inputInstanceName) {
            // Skip disallocation for inputs that are still needed by other blocks
            if (moduleInstanceRegisterMap[inputInstanceName].output1ArrayLength === 0) {
                disallocatePruRegisters(
                    moduleInstanceRegisterMap[inputInstanceName].byteOffsetOfOutput1,
                    moduleInstanceRegisterMap[inputInstanceName].numOfBytesReqByOutput1
                );
            }
        }
    }
    
    let instruction;
    // Process loop blocks
    if (instance.$groupContents) {
        // Process loop counter
        if ('infiniteLoop' in instance) {
            if (instance.infiniteLoop == false) {
                // Record starting index before loop counter (for pre-init insertion point)
                const loopStartIndex = pruRegisterAllocationSummary.pruInstructions.length;

                //push instruction to init loop count
                const byteOffset = getFreeByteOffset(instance.loopCountRegSize);
                // Track loop counter register allocation
                loopCounterRegisters[instanceName] = {
                    byteOffset: byteOffset,
                    numBytes: instance.loopCountRegSize
                };
                instruction = `LDI ${getPruRegister(byteOffset, instance.loopCountRegSize)}, ${instance.loopCount}`;
                addToPruRegisterAllocationSummary(label, instruction, instance, instanceName, 0);
                //push loop instruction
                instruction = `LOOP endloop_${moduleInstanceRegisterMap[instanceName].instanceNum}, ${getPruRegister(byteOffset, instance.loopCountRegSize)}`;
                label = 0;
                addToPruRegisterAllocationSummary(label, instruction, instance, instanceName, 0);
                //push all the blocks inside loop block
                let loopBlockCycleBudget = processLoopCounterGroup(instance);

                // Handle pre-init blocks: extract their instructions and move before loop counter
                // Note: preInitBlocks is an array of block name strings (from multi-select options)
                const preInitBlockNames = new Set(instance.preInitBlocks || []);
                if (preInitBlockNames.size > 0) {
                    // Loop body starts after LOOP instruction (loopStartIndex + 2)
                    const loopBodyStartIndex = loopStartIndex + 2;
                    // Extract pre-init instructions from loop body
                    const preInitData = extractPreInitInstructions(loopBodyStartIndex, preInitBlockNames);
                    // Insert them before the loop counter LDI
                    insertPreInitInstructions(loopStartIndex, preInitData);
                }

                //multiply loopBlockCycleBudget with loop counter value
                loopBlockCycleBudget = loopBlockCycleBudget * instance.loopCount;
                //add current node and its cycle budget by pushing end_loop_inst_num label
                label = `endloop_${moduleInstanceRegisterMap[instanceName].instanceNum}`;
                instruction = "0";
                cycleBudgetMap[instanceName] += loopBlockCycleBudget;
            }
            if (instance.infiniteLoop == true) {
                // Record starting index before startloop label (for pre-init insertion point)
                const loopStartIndex = pruRegisterAllocationSummary.pruInstructions.length;

                instruction = "0";
                label = `startloop_${moduleInstanceRegisterMap[instanceName].instanceNum}`;
                addToPruRegisterAllocationSummary(label, instruction, instance, instanceName, 0);
                //push all the blocks inside loop block
                let loopBlockCycleBudget = processLoopCounterGroup(instance);

                // Handle pre-init blocks: extract their instructions and move before startloop label
                // Note: preInitBlocks is an array of block name strings (from multi-select options)
                const preInitBlockNames = new Set(instance.preInitBlocks || []);
                if (preInitBlockNames.size > 0) {
                    // Loop body starts after startloop label (loopStartIndex + 1)
                    const loopBodyStartIndex = loopStartIndex + 1;
                    // Extract pre-init instructions from loop body
                    const preInitData = extractPreInitInstructions(loopBodyStartIndex, preInitBlockNames);
                    // Insert them before the startloop label
                    insertPreInitInstructions(loopStartIndex, preInitData);
                }

                instruction = `QBA startloop_${moduleInstanceRegisterMap[instanceName].instanceNum}`;
                label = 0;
                cycleBudgetMap[instanceName] = "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN";
            }
        }
        else {  // Group block - skip inline processing, will be handled separately
            return 0;  // Don't process group blocks in the normal flow
        }
    }
    else
    {
        // Generate PRU instruction for conditional block
        if (instance.T && instance.F) {
            // Get opcode of conditional block
            let opCode;
            // Get label and opCode for conditional block
            // If Conditional block instruction is pushed in the true branch then invert the opCode
            if (parentInstance?.$name === instance.T?.[0]?.inst?.$name) {
                opCode = invertOpcode(instance.opCode);
                moduleInstanceRegisterMap[instanceName].label = `${instance.$name}_FALSE`;
            } else {
                opCode = instance.opCode;
                moduleInstanceRegisterMap[instanceName].label = `${instance.$name}_TRUE`;
            }
            inputValues  = inputValues.trim().slice(0, -1); // Remove trailing comma
            // Swap operands: PRU QB* semantics are QBGT LABEL, REG1, OP → branches if OP > REG1
            // So to branch if input1 > input2, we need: QBGT LABEL, input2, input1
            const inputParts = inputValues.split(",").map(s => s.trim());
            const swappedInputValues = `${inputParts[1]} , ${inputParts[0]}`;
            const outputLabel = moduleInstanceRegisterMap[instanceName].label;
            // create instruction
            instruction = `${opCode} ${outputLabel}, ${swappedInputValues}`;
        } 
        // Process GPO blocks where out register is specified and fixed
        else if(instance.outputReg)
        {
            // Get output register notation
            const outputRegister = instance["outputReg"];

            // Clean up input values string (remove trailing comma and space)
            if (inputValues.endsWith(" , ")) {
                inputValues = inputValues.slice(0, -3);
            }
            if(instance.outputReg == "None")
            {
                instruction = `${instance.opCode} ${inputValues}`
            }
            else
            {
                //create Instruction
                instruction = `${instance.opCode} ${outputRegister}, ${inputValues}`;
            }
        }
        // Generate PRU instruction for regular blocks
        else {
            // Allocate registers for output
            const byteOffset = getFreeByteOffset(maxBytesUsed);
            
            if (byteOffset === -1) {
                return -1; // Failed to allocate registers
            }
            
            // Update register map with allocation info
            moduleInstanceRegisterMap[instanceName].byteOffsetOfOutput1 = byteOffset;
            moduleInstanceRegisterMap[instanceName].numOfBytesReqByOutput1 = maxBytesUsed;
            
            // Get output register notation
            const outputRegister = getPruRegister(byteOffset, maxBytesUsed);

            // Clean up input values string (remove trailing comma and space)
            if (inputValues.endsWith(" , ")) {
                inputValues = inputValues.slice(0, -3);
            }
            //create Instruction
            instruction = `${instance.opCode} ${outputRegister}, ${inputValues}`;
        }
    }
    if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
    {
        moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
    }
    else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
    {
        moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
    }
    //add current node and its cycle budget
    moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath.add(instanceName);
    if(cycleBudgetMap[instanceName] == "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN")
    {
        moduleInstanceRegisterMap[instanceName]["peakCycles"] = "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN";
    }
    else if(moduleInstanceRegisterMap[instanceName]["peakCycles"] != "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN")
    {
        moduleInstanceRegisterMap[instanceName]["peakCycles"] += cycleBudgetMap[instanceName];
    }
    addToPruRegisterAllocationSummary(label, instruction, instance, instanceName, moduleInstanceRegisterMap[instanceName]["peakCycles"]);
    
    return maxBytesUsed;
}

/**
 * Allocates PRU registers based on blocks connected by user
 */
function allocatePruRegisters() {
    // Initialize data structures
    pruRegisterAllocationSummary = {
        "labels": [],
        "pruInstructions": [],
        "peakCycles": [],
        "connectedNodesInPeakCyclePath": [],
        "pruInstructionModules" : [],
        "pruInstructionInstances": []
    };
    
    moduleInstanceRegisterMap = {};
    pruByteArray = new Array(totalBytes).fill(0);
    loopCounterRegisters = {};  // Reset loop counter tracking
    groupReturnAddrByteOffset = -1;  // Reset group return address register
    let loopBlockInstanceNames = [];
    let groupBlockInstanceNames = [];
    groupMetadata = [];
    // Prepare moduleInstanceRegisterMap 
    for (const moduleName in systemModules) {
        const module = systemModules[moduleName];
        
        if (!module) {
            continue;
        }
        
        for (let i = 0; i < module.$instances.length; i++) {
            const instance = module.$instances[i];
            const instanceName = instance.$name;
            
            // Skip instances without a name
            if (!instanceName) {
                continue;
            }

            if(instance.noOfCycles ==  -1)
            {
                cycleBudgetMap[instanceName] = "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN"
            }
            else
            {
                cycleBudgetMap[instanceName] = instance.noOfCycles
            }
            
            // Handle blocks with output1 port
            if (instance.output1) {
                // TODO: Currently assuming each block has only one output port
                const outputArrayLength = instance.output1.length === 0 ? -1 : instance.output1.length;
                
                moduleInstanceRegisterMap[instanceName] = {
                    "blockOutputCalculated": 0,
                    "output1ArrayLength": outputArrayLength,
                    "byteOffsetOfOutput1": -1,
                    "numOfBytesReqByOutput1": 0,
                    "peakCycles": 0,
                    "moduleName": moduleName,
                    "instanceNum": i,
                    "connectedNodesInPeakCyclePath" : new Set()
                };
            }
            // Handle conditional blocks
            else if (instance.T && instance.F) {
                moduleInstanceRegisterMap[instanceName] = {
                    "conditionCalculated": 0,
                    "label": instanceName,
                    "numOfBytesReqByOutput1": 0,
                    "peakCycles": 0,
                    "moduleName": moduleName,
                    "instanceNum": i,
                    "connectedNodesInPeakCyclePath" : new Set()
                };
            }
            // Handle blocks without output1 port or T and F ports
            else if (instance.next)
            {
                const nextArrayLength = instance.next.length === 0 ? -1 : instance.next.length
                moduleInstanceRegisterMap[instanceName] = {
                    "blockOutputCalculated": 0,
                    "nextArrayLength": nextArrayLength,
                    "byteOffsetOfOutput1": -1,
                    "numOfBytesReqByOutput1": 0,
                    "peakCycles": 0,
                    "moduleName": moduleName,
                    "instanceNum": i,
                    "connectedNodesInPeakCyclePath" : new Set()
                };
                // Handle group blocks ( eg : loop block)
                // loop Counter
                if(instance.$groupContents && ('infiniteLoop' in instance)){
                    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents
                    loopBlockInstanceNames = loopBlockInstanceNames.concat(groupContents);   
                }
            }
            //Handle program end block instances(without output1 port or T and F ports or next ports)
            else
            {
                moduleInstanceRegisterMap[instanceName] = {
                    "blockOutputCalculated": 0,
                    "byteOffsetOfOutput1": -1,
                    "numOfBytesReqByOutput1": 0,
                    "peakCycles": 0,
                    "moduleName": moduleName,
                    "instanceNum": i,
                    "connectedNodesInPeakCyclePath" : new Set(),
                    "endBlock" : true
                };
                // Handle group blocks ( eg : loop block)
                // infinite count
                if(instance.$groupContents && ('infiniteLoop' in instance)){
                    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents
                    loopBlockInstanceNames = loopBlockInstanceNames.concat(groupContents);   
                }
                if(instance.$groupContents && !('infiniteLoop' in instance)){
                    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents
                    groupBlockInstanceNames = groupBlockInstanceNames.concat(groupContents);

                    groupMetadata.push({
                        groupName : instance.groupName || instanceName,
                        instanceName : instanceName,
                        groupContents : groupContents
                    });
                }
            }
        }
    }

    // First pass: Process program control block (without output1 port or T and F ports and next ports)
    for (const instanceName in moduleInstanceRegisterMap) {
        const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
        if(moduleInstanceRegisterMap[instanceName]?.endBlock === true && (!loopBlockInstanceNames.includes(instanceName)) && (!groupBlockInstanceNames.includes(instanceName)))
        {
            const instance = systemModules[moduleName]?.$instances[instanceNum];
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
        }
    }
    
    // Second pass: Process all blocks without output1 port or T and F ports and next port is unconnected
    for (const instanceName in moduleInstanceRegisterMap) {
        // skip blocks which are in group blocks (eg: loop block)
        if (moduleInstanceRegisterMap[instanceName]?.nextArrayLength === -1 && (!loopBlockInstanceNames.includes(instanceName)) && (!groupBlockInstanceNames.includes(instanceName))) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
            const instance = systemModules[moduleName]?.$instances[instanceNum]; 
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
        }
    }

    // Third pass: Process all result nodes (end nodes where output isn't connected to anything)
    for (const instanceName in moduleInstanceRegisterMap) {
        // skip blocks which are in group blocks (eg: loop block)
        if (moduleInstanceRegisterMap[instanceName]?.output1ArrayLength === -1 && (!loopBlockInstanceNames.includes(instanceName)) && (!groupBlockInstanceNames.includes(instanceName))) {
            const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
            const instance = systemModules[moduleName]?.$instances[instanceNum];     
            // Process the instruction chain starting from this result node
            pushInstruction(instance, null);
            // Mark as calculated
            if("conditionCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
            }
            else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName])
            {
                moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
            }
        }
    }

    // Fourth pass: Process group blocks separately (outside default execution flow)
    for (const groupInfo of groupMetadata) {
        const { instanceName } = groupInfo;
        const { moduleName, instanceNum } = moduleInstanceRegisterMap[instanceName];
        const instance = systemModules[moduleName]?.$instances[instanceNum];
        processGroupBlock(instance);
    }

    // Add return register info to groupMetadata if groups exist
    if (groupMetadata.length > 0 && groupReturnAddrByteOffset !== -1) {
        const retAddrRegister = getPruRegister(groupReturnAddrByteOffset, 2);
        for (const groupInfo of groupMetadata) {
            groupInfo.returnRegister = retAddrRegister;
        }
    }

}

/**
 * Generates formatted register allocation summary as assembly comments
 * @returns {string} Multi-line comment block showing register allocations
 */
function getRegisterAllocationComments() {
    let comments = [];

    // Header with decorative border
    comments.push(";**************************************************************************************");
    comments.push("; Register Allocation Summary");
    comments.push(";");
    comments.push("; NOTE: When each block's code is executed, the registers listed below");
    comments.push(";       will be actively used for their respective functions. The values");
    comments.push(";       stored in these registers may be modified during execution.");
    comments.push(";       Avoid using these registers in your custom code to prevent conflicts.");

    let allocationMap = {};

    // 1. Collect regular block allocations
    for (const instanceName in moduleInstanceRegisterMap) {
        const entry = moduleInstanceRegisterMap[instanceName];
        // Skip blocks without output register or conditional blocks
        if (entry.byteOffsetOfOutput1 !== -1 &&
            entry.numOfBytesReqByOutput1 > 0 &&
            entry.conditionCalculated === undefined) {
            const regNotation = getPruRegister(entry.byteOffsetOfOutput1, entry.numOfBytesReqByOutput1);
            if (regNotation !== -1) {
                allocationMap[instanceName] = {
                    registers: [regNotation],
                    peakCycles: entry.peakCycles
                };
            }
        }
    }

    // 2. Add loop counters
    for (const instanceName in loopCounterRegisters) {
        const loopReg = loopCounterRegisters[instanceName];
        const regNotation = getPruRegister(loopReg.byteOffset, loopReg.numBytes);
        if (regNotation !== -1) {
            if (!allocationMap[instanceName]) {
                allocationMap[instanceName] = {
                    registers: [],
                    peakCycles: moduleInstanceRegisterMap[instanceName]?.peakCycles || 0
                };
            }
            allocationMap[instanceName].registers.push(regNotation + " (loop counter)");
        }
    }

    // 3. Add group return address register (shared by all groups)
    if (groupReturnAddrByteOffset !== -1) {
        const regNotation = getPruRegister(groupReturnAddrByteOffset, 2);
        if (regNotation !== -1) {
            // Add to first group block for display
            if (groupMetadata.length > 0) {
                const firstGroupInstanceName = groupMetadata[0].instanceName;
                if (!allocationMap[firstGroupInstanceName]) {
                    allocationMap[firstGroupInstanceName] = {
                        registers: [],
                        peakCycles: moduleInstanceRegisterMap[firstGroupInstanceName]?.peakCycles || 0
                    };
                }
                allocationMap[firstGroupInstanceName].registers.push(regNotation + " (group return address)");
            }
        }
    }

    // 4. Generate sorted output in table format
    const sortedNames = Object.keys(allocationMap).sort();

    if (sortedNames.length > 0) {
        // Find maximum name length for alignment (ensure at least as wide as header)
        const maxNameLen = Math.max(...sortedNames.map(n => n.length), "Block Name".length);
        const maxRegLen = Math.max(...sortedNames.map(n => allocationMap[n].registers.join(", ").length), "Allocated Registers".length);

        // Table header
        comments.push("; +" + "-".repeat(maxNameLen + 2) + "+" + "-".repeat(maxRegLen + 2) + "+");
        comments.push("; | " + "Block Name".padEnd(maxNameLen) + " | " + "Allocated Registers".padEnd(maxRegLen) + " |");
        comments.push("; +" + "-".repeat(maxNameLen + 2) + "+" + "-".repeat(maxRegLen + 2) + "+");

        // Table rows
        for (const name of sortedNames) {
            const info = allocationMap[name];
            const registerList = info.registers.join(", ");
            comments.push("; | " + name.padEnd(maxNameLen) + " | " + registerList.padEnd(maxRegLen) + " |");
        }

        // Table footer
        comments.push("; +" + "-".repeat(maxNameLen + 2) + "+" + "-".repeat(maxRegLen + 2) + "+");
    }

    // 5. Calculate overall peak cycles for the entire configuration
    let overallPeakCycles = 0;
    let hasInfiniteLoop = false;
    for (const instanceName in moduleInstanceRegisterMap) {
        const entry = moduleInstanceRegisterMap[instanceName];
        if (entry.peakCycles === "INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN") {
            hasInfiniteLoop = true;
        } else if (typeof entry.peakCycles === 'number') {
            overallPeakCycles = Math.max(overallPeakCycles, entry.peakCycles);
        }
    }

    // 6. Add reserved registers and overall peak cycles summary
    if (sortedNames.length > 0) {
        comments.push(";");
    }
    comments.push("; TEMP_REG1 (R28) -> Used by all macros");
    comments.push("; TEMP_REG2 (R29) -> Used by all macros");

    // Add overall peak cycles summary
    comments.push(";");
    comments.push(";--------------------------------------------------------------------------------------");
    if (hasInfiniteLoop) {
        comments.push("; OVERALL PEAK CYCLES: Unknown - Infinite loop detected in configuration");
    } else {
        comments.push(`; OVERALL PEAK CYCLES: ${overallPeakCycles + 1} cycles (worst-case timing) including group and non-group code`);
    }
    comments.push(";--------------------------------------------------------------------------------------");

    // Footer border
    comments.push(";**************************************************************************************");
    comments.push("");  // Blank line for spacing

    return comments.join("\n");
}

/**
 * Gets allocated register(s) for a specific block
 * @param {string} instanceName - Block instance name
 * @returns {string} Register allocation string (e.g., "R0", "R1.w0", "R2, R3") or "-" if none
 */
function getBlockRegisterAllocation(instanceName) {
    if (!moduleInstanceRegisterMap || !moduleInstanceRegisterMap[instanceName]) {
        return "-";
    }

    const entry = moduleInstanceRegisterMap[instanceName];
    let registers = [];

    // Check for output register allocation
    if (entry.byteOffsetOfOutput1 !== -1 && entry.numOfBytesReqByOutput1 > 0) {
        const regNotation = getPruRegister(entry.byteOffsetOfOutput1, entry.numOfBytesReqByOutput1);
        if (regNotation !== -1) {
            registers.push(regNotation);
        }
    }

    // Check for loop counter register
    if (loopCounterRegisters[instanceName]) {
        const loopReg = loopCounterRegisters[instanceName];
        const regNotation = getPruRegister(loopReg.byteOffset, loopReg.numBytes);
        if (regNotation !== -1) {
            registers.push(regNotation + " (loop)");
        }
    }

    // Check if this is a group block and include shared return address register
    if (groupMetadata.some(g => g.instanceName === instanceName) && groupReturnAddrByteOffset !== -1) {
        const regNotation = getPruRegister(groupReturnAddrByteOffset, 2);
        if (regNotation !== -1) {
            registers.push(regNotation + " (group return)");
        }
    }

    return registers.length > 0 ? registers.join(", ") : "-";
}

exports = {
	getPruRegisterAllocationSummary,
    allocatePruRegisters,
    getGroupMetadata: () => groupMetadata,
    getRegisterAllocationComments,
    getBlockRegisterAllocation
}