const pruRegisterAllocator = system.getScript("/pru_blocks/common/register_allocation/pru_register_allocator.js");
const pruDMEM0 = system.getScript("/pru_blocks/common/simulation/pru_dmem0.js");
const pruSMEM = system.getScript("/pru_blocks/common/simulation/pru_smem.js");
const pruSimulator =  system.getScript("/pru_blocks/common/simulation/pru_core.js");
const simulationData = {cycleCount : [], r30Bits : [], r31Bits : []};

// ============================================================================
// R31 Simulation Input Functions
// ============================================================================
/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
	let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
	if(result==0)return "PRU0";
    return "PRU1";
}
/**
 * Helper function to validate timestamp input for a specific GPI pin
 */
function validateTimestampInput(inst, report, pinNum) {
    const cyclesField = `gpi${pinNum}_inputCycles`;
    const valuesField = `gpi${pinNum}_inputValues`;

    let inputCycles, inputValues;
    try {
        inputCycles = JSON.parse(inst[cyclesField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Cycles format. Use JSON array syntax like [100, 105, 110]`, inst, cyclesField);
        return false;
    }

    try {
        inputValues = JSON.parse(inst[valuesField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Values format. Use JSON array syntax like [1, 0, 1]`, inst, valuesField);
        return false;
    }

    if (!Array.isArray(inputCycles)) {
        report.logError(`GPI${pinNum} Cycles must be an array. Example: [100, 105, 110]`, inst, cyclesField);
        return false;
    }

    if (!Array.isArray(inputValues)) {
        report.logError(`GPI${pinNum} Values must be an array. Example: [1, 0, 1]`, inst, valuesField);
        return false;
    }

    if (inputCycles.length !== inputValues.length) {
        report.logError(
            `GPI${pinNum} Cycles (${inputCycles.length} elements) and GPI${pinNum} Values (${inputValues.length} elements) must have the same length`,
            inst,
            cyclesField
        );
        return false;
    }

    // Validate that all cycles are positive integers (minimum 1, since cycle 0 is not displayed)
    for (let i = 0; i < inputCycles.length; i++) {
        if (!Number.isInteger(inputCycles[i]) || inputCycles[i] < 1) {
            report.logError(`GPI${pinNum} Cycles must contain positive integers (minimum 1). Invalid value at index ${i}: ${inputCycles[i]}`, inst, cyclesField);
            return false;
        }
    }

    // Validate that cycles are in ascending order
    for (let i = 1; i < inputCycles.length; i++) {
        if (inputCycles[i] <= inputCycles[i-1]) {
            report.logError(`GPI${pinNum} Cycles must be in strictly ascending order. Found ${inputCycles[i-1]} followed by ${inputCycles[i]} at index ${i}`, inst, cyclesField);
            return false;
        }
    }

    // Validate that all values are 0 or 1
    for (let i = 0; i < inputValues.length; i++) {
        if (inputValues[i] !== 0 && inputValues[i] !== 1) {
            report.logError(`GPI${pinNum} Values must be 0 or 1. Invalid value at index ${i}: ${inputValues[i]}`, inst, valuesField);
            return false;
        }
    }

    return true;
}

/**
 * Helper function to validate pattern input for a specific GPI pin
 */
function validatePatternInput(inst, report, pinNum) {
    const patternField = `gpi${pinNum}_bitPattern`;
    const startCycleField = `gpi${pinNum}_patternStartCycle`;
    const repeatCountField = `gpi${pinNum}_patternRepeatCount`;

    let bitPattern;
    try {
        bitPattern = JSON.parse(inst[patternField]);
    } catch(e) {
        report.logError(`Invalid GPI${pinNum} Pattern format. Use JSON array syntax like [0, 1, 1, 0]`, inst, patternField);
        return false;
    }

    if (!Array.isArray(bitPattern)) {
        report.logError(`GPI${pinNum} Pattern must be an array. Example: [0, 1, 1, 0]`, inst, patternField);
        return false;
    }

    if (bitPattern.length === 0) {
        report.logError(`GPI${pinNum} Pattern cannot be empty`, inst, patternField);
        return false;
    }

    // Validate that all pattern values are 0 or 1
    for (let i = 0; i < bitPattern.length; i++) {
        if (bitPattern[i] !== 0 && bitPattern[i] !== 1) {
            report.logError(`GPI${pinNum} Pattern values must be 0 or 1. Invalid value at index ${i}: ${bitPattern[i]}`, inst, patternField);
            return false;
        }
    }

    // Validate start cycle (minimum 1, since cycle 0 is not displayed)
    if (!Number.isInteger(inst[startCycleField]) || inst[startCycleField] < 1) {
        report.logError(`GPI${pinNum} Pattern Start Cycle must be a positive integer (minimum 1)`, inst, startCycleField);
        return false;
    }

    // Validate pattern repeat count
    if (!Number.isInteger(inst[repeatCountField]) || inst[repeatCountField] < 1) {
        report.logError(`GPI${pinNum} Pattern Repeat Count must be a positive integer (minimum 1)`, inst, repeatCountField);
        return false;
    }

    return true;
}

/**
 * Validate R31 simulation input configuration
 */
function validateR31SimulationInput(inst, report) {
    // Get the list of selected pins from signalsToDisplayR31
    const selectedPins = inst.signalsToDisplayR31 || [];

    // Validate each selected pin
    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        const inputModeField = `gpi${pinNum}_inputMode`;
        const inputMode = inst[inputModeField];

        if (inputMode === "timestamp") {
            if (!validateTimestampInput(inst, report, pinNum)) {
                return false;
            }
        } else if (inputMode === "pattern") {
            if (!validatePatternInput(inst, report, pinNum)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Generate history for a single GPI pin
 */
function generatePinHistory(inst, pinNum) {
    const inputModeField = `gpi${pinNum}_inputMode`;
    const inputMode = inst[inputModeField];
    const pinHistory = {};

    if (inputMode === "pattern") {
        // Pattern mode
        const patternField = `gpi${pinNum}_bitPattern`;
        const startCycleField = `gpi${pinNum}_patternStartCycle`;
        const repeatCountField = `gpi${pinNum}_patternRepeatCount`;

        let bitPattern;
        try {
            bitPattern = JSON.parse(inst[patternField]);
        } catch(e) {
            // Invalid JSON - return empty history, validation will show error
            return {};
        }

        if (!Array.isArray(bitPattern) || bitPattern.length === 0) {
            return {};
        }

        const startCycle = inst[startCycleField];
        const repeatCount = inst[repeatCountField];

        let currentCycle = startCycle;

        // Repeat pattern for the specified number of times
        for (let repeat = 0; repeat < repeatCount; repeat++) {
            for (let i = 0; i < bitPattern.length; i++) {
                pinHistory[currentCycle] = bitPattern[i];
                currentCycle++;
            }
        }
    } else {
        // Timestamp mode
        const cyclesField = `gpi${pinNum}_inputCycles`;
        const valuesField = `gpi${pinNum}_inputValues`;
        const repeatLastBitField = `gpi${pinNum}_repeatLastBit`;

        let inputCycles, inputValues;
        try {
            inputCycles = JSON.parse(inst[cyclesField]);
            inputValues = JSON.parse(inst[valuesField]);
        } catch(e) {
            // Invalid JSON - return empty history, validation will show error
            return {};
        }

        if (!Array.isArray(inputCycles) || !Array.isArray(inputValues) || inputCycles.length === 0) {
            return {};
        }

        const repeatLastBit = inst[repeatLastBitField];

        // Build history from timestamps
        for (let i = 0; i < inputCycles.length; i++) {
            const cycle = inputCycles[i];
            const value = inputValues[i];
            pinHistory[cycle] = value;
        }

        // Fill in intermediate cycles and handle repeat last bit
        const maxCycle = inputCycles[inputCycles.length - 1];
        let lastValue = 0;

        for (let cycle = 0; cycle <= maxCycle; cycle++) {
            if (pinHistory[cycle] !== undefined) {
                lastValue = pinHistory[cycle];
            } else {
                pinHistory[cycle] = lastValue;
            }
        }

        // Handle repeat last bit for cycles beyond the last timestamp
        if (repeatLastBit) {
            const finalValue = inputValues[inputValues.length - 1];
            const globalSimulationCycles = inst.pruCyclesToSimulate || 2000;
            // Extend to the global simulation length
            for (let cycle = maxCycle + 1; cycle <= globalSimulationCycles; cycle++) {
                pinHistory[cycle] = finalValue;
            }
        }
    }

    return pinHistory;
}

/**
 * Main function to generate R31 history by combining all enabled GPI pins
 */
function generateR31HistoryFromStaticModule(inst) {
    const r31History = {};
    const selectedPins = inst.signalsToDisplayR31 || [];

    // Generate history for each selected pin
    const pinHistories = [];
    for (const pinNumStr of selectedPins) {
        const pinNum = parseInt(pinNumStr);
        pinHistories.push({
            pinNum: pinNum,
            history: generatePinHistory(inst, pinNum)
        });
    }

    // Find the maximum cycle across all pins
    let maxCycle = 0;
    for (const pinData of pinHistories) {
        const cycles = Object.keys(pinData.history).map(Number);
        if (cycles.length > 0) {
            maxCycle = Math.max(maxCycle, ...cycles);
        }
    }

    // Combine all pin histories into R31 values
    for (let cycle = 0; cycle <= maxCycle; cycle++) {
        let r31Value = 0;

        for (const pinData of pinHistories) {
            if (pinData.history[cycle] === 1) {
                r31Value |= (1 << pinData.pinNum);
            }
        }

        r31History[cycle] = r31Value;
    }

    return r31History;
}

// onChange handler for the R31 signals selection
function onSignalsToDisplayR31Change(inst, ui) {
    if (!ui) return;

    const selectedPins = inst.signalsToDisplayR31 || [];

    // Show/hide configuration for each pin based on selection
    for (let pinNum = 0; pinNum <= 19; pinNum++) {
        const isSelected = selectedPins.includes(String(pinNum));
        const inputMode = inst[`gpi${pinNum}_inputMode`];
        const isTimestamp = (inputMode === "timestamp");
        const isPattern = (inputMode === "pattern");

        // Show/hide separator
        if (ui[`gpi${pinNum}_separator`]) {
            ui[`gpi${pinNum}_separator`].hidden = !isSelected;
        }

        // Show/hide input mode selector
        if (ui[`gpi${pinNum}_inputMode`]) {
            ui[`gpi${pinNum}_inputMode`].hidden = !isSelected;
        }

        // Show/hide timestamp fields
        if (ui[`gpi${pinNum}_inputCycles`]) {
            ui[`gpi${pinNum}_inputCycles`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_inputValues`]) {
            ui[`gpi${pinNum}_inputValues`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_repeatLastBit`]) {
            ui[`gpi${pinNum}_repeatLastBit`].hidden = !(isSelected && isTimestamp);
        }

        // Show/hide pattern fields
        if (ui[`gpi${pinNum}_bitPattern`]) {
            ui[`gpi${pinNum}_bitPattern`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternStartCycle`]) {
            ui[`gpi${pinNum}_patternStartCycle`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternRepeatCount`]) {
            ui[`gpi${pinNum}_patternRepeatCount`].hidden = !(isSelected && isPattern);
        }
    }
}

// Helper function to generate onChange handler for input mode selector
function createInputModeOnChange(pinNum) {
    return function(inst, ui) {
        if (!ui) return;

        const selectedPins = inst.signalsToDisplayR31 || [];
        const isSelected = selectedPins.includes(String(pinNum));
        const inputMode = inst[`gpi${pinNum}_inputMode`];
        const isTimestamp = (inputMode === "timestamp");
        const isPattern = (inputMode === "pattern");

        // Show/hide timestamp fields
        if (ui[`gpi${pinNum}_inputCycles`]) {
            ui[`gpi${pinNum}_inputCycles`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_inputValues`]) {
            ui[`gpi${pinNum}_inputValues`].hidden = !(isSelected && isTimestamp);
        }
        if (ui[`gpi${pinNum}_repeatLastBit`]) {
            ui[`gpi${pinNum}_repeatLastBit`].hidden = !(isSelected && isTimestamp);
        }

        // Show/hide pattern fields
        if (ui[`gpi${pinNum}_bitPattern`]) {
            ui[`gpi${pinNum}_bitPattern`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternStartCycle`]) {
            ui[`gpi${pinNum}_patternStartCycle`].hidden = !(isSelected && isPattern);
        }
        if (ui[`gpi${pinNum}_patternRepeatCount`]) {
            ui[`gpi${pinNum}_patternRepeatCount`].hidden = !(isSelected && isPattern);
        }
    };
}

/**
 * Generate configuration fields for R31 simulation input (for pins 0-19)
 */
function generateR31SimulationInputConfigs() {
    const configs = [];

    // Generate configuration fields for GPI pins 0-19 (hidden by default)
    for (let pinNum = 0; pinNum <= 19; pinNum++) {
        // Add a separator/header before each pin's configuration
        configs.push({
            name: `gpi${pinNum}_separator`,
            displayName: `━━━━━━━━━━ ${getPruNumberFromContext()}_GPI_${pinNum} Input Configuration ━━━━━━━━━━`,
            longDescription: `Configure simulation input data for GPI${pinNum} (R31 register bit ${pinNum})`,
            default: "",
            hidden: true,
            readOnly: true
        });

        // Input mode selector
        configs.push({
            name: `gpi${pinNum}_inputMode`,
            displayName: `GPI${pinNum} Input Mode`,
            description: "Choose between timestamp-based or pattern-based input",
            default: "timestamp",
            hidden: true,
            options: [
                { name: "timestamp", displayName: "Timestamp Mode" },
                { name: "pattern", displayName: "Pattern Mode" }
            ],
            onChange: createInputModeOnChange(pinNum)
        });

        // Timestamp mode fields
        configs.push({
            name: `gpi${pinNum}_inputCycles`,
            displayName: `GPI${pinNum} Input Cycles`,
            description: "PRU cycle numbers when bit value changes (minimum 1). Example: [100, 105, 110]",
            default: "[1]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_inputValues`,
            displayName: `GPI${pinNum} Input Values`,
            description: "Bit values (0 or 1) at each timestamp. Example: [1, 0, 1]",
            default: "[0]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_repeatLastBit`,
            displayName: `GPI${pinNum} Repeat Last Bit`,
            description: "Continue repeating the last bit value for all subsequent cycles",
            default: false,
            hidden: true
        });

        // Pattern mode fields
        configs.push({
            name: `gpi${pinNum}_bitPattern`,
            displayName: `GPI${pinNum} Bit Pattern`,
            description: "Bit pattern to repeat. Example: [0, 1, 1, 0]",
            default: "[1, 0]",
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_patternStartCycle`,
            displayName: `GPI${pinNum} Pattern Start Cycle`,
            description: "PRU cycle number where pattern starts (minimum 1)",
            default: 1,
            hidden: true
        });

        configs.push({
            name: `gpi${pinNum}_patternRepeatCount`,
            displayName: `GPI${pinNum} Pattern Repeat Count`,
            description: "Number of times to repeat the pattern",
            default: 10,
            hidden: true
        });
    }

    return configs;
}

/**
 * Expands loop directives in the given macroBody.
 *
 * @param {string} macroBody - The macroBody to expand loop directives in.
 * @return {string} The macroBody with loop directives expanded.
 */
function expandLoopDirectives(macroBody) {
    // Split the macroBody into lines and trim each line
    const lines = macroBody.split('\n').map(line => line.trim());
    const result = [];
    
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        
        // Check if this line contains a .loop directive
        const loopMatch = line.match(/\.loop\s+(\d+)/);
        if (loopMatch) {
            const loopCount = parseInt(loopMatch[1], 10);
            const loopBodyLines = [];
            
            // Collect all lines until we find .endloop
            let j = i + 1;
            while (j < lines.length && !lines[j].includes('.endloop')) {
                loopBodyLines.push(lines[j]);
                j++;
            }
            
            // Skip the .loop line, loop body, and .endloop line
            i = j + 1;
            
            // Add the loop body repeated loopCount times
            for (let k = 0; k < loopCount; k++) {
                result.push(...loopBodyLines);
            }
        } else {
            // Regular line, just add it
            result.push(line);
            i++;
        }
    }
    
    return result.join('\n');
}

/**
 * Expands macros in the given PRU instructions.
 *
 * @param {Array} pruInstructionsWithMacros - Array of PRU instructions with macros.
 * @param {Array} pruInstructionsLabelWithMacros - Array of labels corresponding to the PRU instructions.
 * @return {Object} Object containing the expanded PRU instructions and their labels.
 */
function expandMacros(pruInstructionsWithMacros, pruInstructionsLabelWithMacros)
{
    let pruInstructionModules = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructionModules;
    let pruInstructions = [];
    let pruInstructionsLabels = [];
    let macroCount = 0;
    
    for(let i = 0; i < pruInstructionModules.length; i++)
    {
        // First check if the module exists and has a getMacro function
        let macroBody = (system.modules[pruInstructionModules[i]] && 
                         typeof system.modules[pruInstructionModules[i]].getMacro === 'function') ? 
                        system.modules[pruInstructionModules[i]].getMacro(pruInstructionsWithMacros[i], "") : 
                        undefined;
        
        if(macroBody) {
            // Expand the loop directives in the macro body
            macroBody = expandLoopDirectives(macroBody);
            // If there is macro body, call seperateInstructionsAndLabels
            let macroDefinition = seperateInstructionsAndLabels(macroCount, 
                                                    macroBody);   
		    // Handle case when label is added before macro in auto generated code and first instruction in macro
			pruInstructions.push(0);
			pruInstructionsLabels.push(pruInstructionsLabelWithMacros[i]);
            pruInstructions = pruInstructions.concat(macroDefinition.macroInstructions);
            pruInstructionsLabels = pruInstructionsLabels.concat(macroDefinition.macroInstructionsLabels);            
            //increment macro count
            macroCount++;
        }
        else {
            // No macro definition, use instruction as is
            pruInstructions.push(pruInstructionsWithMacros[i]);
            pruInstructionsLabels.push(pruInstructionsLabelWithMacros[i]);
        }
    }

    return {pruInstructions, pruInstructionsLabels}
}

/**
 * Replaces temporary register placeholders with their actual register numbers
 * @param {Array} instructions - Array of PRU instructions that may contain TEMP_REG placeholders
 * @return {Array} Array of instructions with TEMP_REG placeholders replaced
 */
function replaceTemporaryRegisters(instructions) {
    return instructions.map(instruction => {
        // Skip if instruction is not a string (could be 0 or other values)
        if (typeof instruction !== 'string') {
            return instruction;
        }
        
        // Replace TEMP_REG1 with R28 and TEMP_REG2 with R29
        return instruction
            .replace(/TEMP_REG1(\.\w+)?/g, 'R28$1')
            .replace(/TEMP_REG2(\.\w+)?/g, 'R29$1');
    });
}

/**
 * Retrieves the macro definition for a given instance.
 *
 * @param {number} macroCount - The macro count (? will be replaced with this value).
 * @param {string} macroBody - The macro body.
 * @return {Object} An object containing the macro instructions and their labels.
 */
function seperateInstructionsAndLabels(macroCount, macroBody)
{
    // If macroBody wasn't provided, try to get it from the module
    if (!macroBody) {
        return undefined;
    }
    
    const macroInstructions = [];
    const macroInstructionsLabels = [];
    
    // Split the macro body into lines
    const lines = macroBody.trim().split('\n');
    
    // Process the macro body (assuming only either label or instruction can be present in one line)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip empty lines and comments
        if (!line || line.startsWith(';')) {
            continue;
        }
    
        // Case 1: Line with both label and instruction
        if (line.includes(':') && line.split(':')[1].trim()) {
            const parts = line.split(':');
            const label = parts[0].trim().replace(/\?/g, macroCount);
            let instruction = parts[1].trim().replace(/\?/g, macroCount);
            
            macroInstructions.push(instruction);
            macroInstructionsLabels.push(label);
        }
        // Case 2: Line with only a label
        else if (line.includes(':')) {
            const label = line.split(':')[0].trim().replace(/\?/g, macroCount);
            
            macroInstructions.push(0);
            macroInstructionsLabels.push(label);
        }
        // Case 3: Line with only an instruction
        else {
            const instruction = line.replace(/\?/g, macroCount);
            
            macroInstructions.push(instruction);
            macroInstructionsLabels.push(0);
        }
    }
    
    return {
        macroInstructions,
        macroInstructionsLabels
    };
}


function getDataSectionContents()
{
    let dataSectionContents = [];
    let systemModules = system.modules;

    for (let module_name in systemModules) {
        let module = systemModules[module_name];
        if (module) {
            for (let iterator1 = 0; iterator1 < module.$instances.length; iterator1++) {
                let instance = module.$instances[iterator1];
                if (instance["lutName"] && (instance["lutName"]!="")) {
                    // Check if module has required functions
                    if (typeof module.getDataSize === 'function' &&
                        typeof module.getLookUptable === 'function') {

                        // Get memory location choice from config (dmem or smem), default to dmem if not specified
                        let memoryLocationChoice = instance["lutMemoryLocation"] || "dmem";

                        dataSectionContents.push({
                            symbolName: instance["lutName"],
                            symbolDataType: module.getDataSize(instance),
                            symbolData: module.getLookUptable(instance),
                            section: memoryLocationChoice  // Memory location: dmem or smem
                        });
                    }
                }
            }
        }
    }

    return dataSectionContents;
}

/**
 * Gets all .usect directives from Memory Reserve blocks
 * @returns {Array} Array of .usect directive strings
 */
function getUsectLinkerDirectives()
{
    let usectDirectives = [];
    let systemModules = system.modules;

    // Look for Memory Reserve module
    const memReserveModule = systemModules["/pru_blocks/utils/memory_variable_block"];
    if (memReserveModule && memReserveModule.$instances) {
        for (let instance of memReserveModule.$instances) {
            if (instance["labelName"] && instance["labelName"] !== "") {
                // Call the module's getUsectDirective function if available
                if (typeof memReserveModule.getUsectDirective === 'function') {
                    usectDirectives.push(memReserveModule.getUsectDirective(instance));
                } else {
                    // Fallback: construct directive directly (always 4-byte aligned)
                    const labelName = instance.labelName;
                    const sizeInBytes = instance.sizeInBytes;
                    const sectionName = instance.sectionName ;

                    usectDirectives.push(`${labelName}\t.usect "${sectionName}", ${sizeInBytes}, 1`);
                }
            }
        }
    }

    return usectDirectives;
}

/**
 * Generate assembly code for initialized data sections (.initdmem and .initsmem)
 * Returns formatted assembly with section directives and data definitions
 * @returns {string} Assembly code for initialized data sections
 */
function getInitSectDirectives() {
    let assembly = "";

    const dataSectionContents = getDataSectionContents();
    if (!dataSectionContents || dataSectionContents.length === 0) {
        return assembly;
    }

    // Separate DMEM and SMEM data
    const dmemData = dataSectionContents.filter(item => item.section === "dmem" || !item.section);
    const smemData = dataSectionContents.filter(item => item.section === "smem");

    // Generate DMEM section (.initdmem) for initialized data
    if (dmemData.length > 0) {
        assembly += '    .sect       ".initdmem"\n';
        for (let item of dmemData) {
            assembly += `${item.symbolName} ${item.symbolDataType} ${item.symbolData}\n`;
        }
    }

    // Generate SMEM section (.initsmem) for initialized data
    if (smemData.length > 0) {
        assembly += '    .sect       ".initsmem"\n';
        for (let item of smemData) {
            assembly += `${item.symbolName} ${item.symbolDataType} ${item.symbolData}\n`;
        }
    }

    return assembly;
}

function prepareR30DataForPlotting(r30ValueHistory) {
    // Clear existing data
    simulationData.cycleCount = [];
    simulationData.r30Bits = [];

    // Get maxCycles from the length of r30ValueHistory
    const maxCycles = r30ValueHistory.length - 1;

    // Create cycle count array with pattern [1, 1.99999, 2, 2.99999, 3, ...] (skip cycle 0)
    for (let i = 1; i <= maxCycles; i++) {
        simulationData.cycleCount.push(i);
        simulationData.cycleCount.push(i + 0.99999); // Add the value just before the next integer
    }

    // Initialize r30Bits array with empty arrays for each bit (0-20)
    for (let bit = 0; bit <= 20; bit++) {
        simulationData.r30Bits[bit] = [];
    }

    // For each cycle, extract each bit value from r30ValueHistory and duplicate for the stepped pattern
    // Start from index 1 to skip cycle 0
    for (let i = 1; i <= maxCycles; i++) {
        const value = r30ValueHistory[i] || 0;

        for (let bit = 0; bit <= 20; bit++) {
            // Extract bit value using bitwise AND and shift
            const bitValue = (value & (1 << bit)) ? 1 : 0;

            // Add the same bit value twice - once for the integer and once for the x.99999
            simulationData.r30Bits[bit].push(bitValue);
            simulationData.r30Bits[bit].push(bitValue);
        }
    }
}

function prepareR31DataForPlotting(r31ValueHistory) {
    // Clear existing R31 data
    simulationData.r31Bits = [];

    // Get maxCycles from the length of r31ValueHistory
    const maxCycles = r31ValueHistory.length - 1;

    // Initialize r31Bits array with empty arrays for each bit (0-20)
    for (let bit = 0; bit <= 20; bit++) {
        simulationData.r31Bits[bit] = [];
    }

    // For each cycle, extract each bit value from r31ValueHistory and duplicate for the stepped pattern
    // Start from index 1 to skip cycle 0
    for (let i = 1; i <= maxCycles; i++) {
        const value = r31ValueHistory[i] || 0;

        for (let bit = 0; bit <= 20; bit++) {
            // Extract bit value using bitwise AND and shift
            const bitValue = (value & (1 << bit)) ? 1 : 0;

            // Add the same bit value twice - once for the integer and once for the x.99999
            simulationData.r31Bits[bit].push(bitValue);
            simulationData.r31Bits[bit].push(bitValue);
        }
    }
}

/**
 * Collects R31 history from the static module's simulation input configuration
 * @returns {Object} Combined R31 history map (cycle -> R31 value)
 */
function collectR31History() {
    // Get the static module instance
    const staticModule = system.modules["/pru_blocks/common/pru_blocks_static_module"];
    if (staticModule && staticModule.$static) {
        return generateR31HistoryFromStaticModule(staticModule.$static);
    }
    return {};
}


/**
 * Detects cycles in the control flow and data flow graph (prev/next/T/F and input/output ports).
 * Uses DFS with three-color marking: 0=unvisited, 1=in-stack, 2=done.
 * @returns {string|null} Error message if a cycle is found, null otherwise
 */
function detectControlFlowCycle() {
    const systemModules = system.modules;
    const color = {};  // instanceName -> 0 (unvisited) | 1 (in stack) | 2 (done)
    const parent = {}; // instanceName -> instanceName (for path reconstruction)
    // const debugPaths = []; // Track all edges traversed for debugging

    // Collect all instances that participate in control flow or data flow
    const allInstances = {};
    for (const moduleName in systemModules) {
        const module = systemModules[moduleName];
        if (!module) continue;
        for (const instance of module.$instances) {
            if (!instance.$name) continue;
            // Include instances with control flow ports (next/prev/T/F) or data flow ports (input/output)
            if (instance.next !== undefined || instance.prev !== undefined ||
                instance.input1 !== undefined || instance.input2 !== undefined ||
                instance.output1 !== undefined) {
                allInstances[instance.$name] = instance;
                color[instance.$name] = 0;
            }
        }
    }

    // Iterative DFS using explicit stack to avoid call stack overflow
    // Each stack entry is {instance, expanded} where expanded=false means
    // we are entering the node, expanded=true means we are leaving it
    for (const startName in allInstances) {
        if (color[startName] !== 0) continue;

        const stack = [{ instance: allInstances[startName], expanded: false }];

        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const name = top.instance.$name;

            if (!top.expanded) {
                // First visit — mark as in-stack
                top.expanded = true;
                color[name] = 1;

                // Collect all outgoing edges: control flow (next, T, F) and data flow (output consumers)
                const outgoing = [];
                const nextInst = top.instance.next?.[0]?.inst;
                if (nextInst) {
                    outgoing.push(nextInst);
                }
                const trueInst = top.instance.T?.[0]?.inst;
                if (trueInst) {
                    outgoing.push(trueInst);
                }
                const falseInst = top.instance.F?.[0]?.inst;
                if (falseInst) {
                    outgoing.push(falseInst);
                }
                const output1Inst = top.instance.output1?.[0]?.inst;
                if (output1Inst) {
                    const size = top.instance.output1.length
                    for (var i = 0; i < size; ++i) {
                        const output1Inst_all = top.instance.output1?.[i]?.inst;
                        outgoing.push(output1Inst_all);
                    }
                }
                for (const neighbor of outgoing) {
                    if (!neighbor.$name) continue;
                    const neighborName = neighbor.$name;
                    if (color[neighborName] === 1) {
                        // Back edge — cycle found, reconstruct path
                        let path = [neighborName];
                        let cur = name;
                        while (cur && cur !== neighborName) {
                            path.unshift(cur);
                            cur = parent[cur];
                        }
                        path.unshift(neighborName);
                        return `Cycle detected in block connections: ${path.join(" → ")}. Remove the looping connection to fix this.`;
                    }
                    if (color[neighborName] === 0) {
                        parent[neighborName] = name;
                        stack.push({ instance: neighbor, expanded: false });
                    }
                }
            } else {
                // Second visit — leaving the node, mark as done
                color[name] = 2;
                stack.pop();
            }
        }
    }

    return null;
}

function validate(inst, report)
{
	// Check for cycles in the control flow graph before anything else
	const cycleError = detectControlFlowCycle();
	if (cycleError) {
		report.logError(cycleError, inst);
		return;
	}

	// Validate R31 simulation input configuration
	validateR31SimulationInput(inst, report);

	// Check for UART blocks and warn about unsupported simulation
	const uartModule = system.modules["/pru_blocks/pru_io_blocks/uart_config"];
	const hasUartBlock = (uartModule && uartModule.$instances && uartModule.$instances.length > 0)

	if (hasUartBlock) {
		report.logWarning(
			"UART blocks detected in configuration. Note: Three-channel peripheral interface simulation is not currently supported. " +
			"UART TX/RX blocks will not be simulated in the waveform viewer. The blocks will function correctly on hardware.",
			inst
		);
	}

	//allocating pru registers for all blocks at system level
	pruRegisterAllocator.allocatePruRegisters();
	//validating register allocation
	let pruInstructionsWithMacros = pruRegisterAllocator.getPruRegisterAllocationSummary().pruInstructions;
	let pruInstructionsLabelWithMacros = pruRegisterAllocator.getPruRegisterAllocationSummary().labels;

	let hasRegisterError = pruInstructionsWithMacros.some(instruction =>
		instruction.includes("-1")
	);

	if (hasRegisterError) {
		report.logError("Out of PRU registers, reduce number of PRU blocks added", inst);
	}
    /*prepare instructions and init dmem0 for simulation*/
    else {
		// If UART blocks are present, skip simulation and return zeros
		if (hasUartBlock) {
			const cyclesToSimulate = inst["pruCyclesToSimulate"];
			const r30ValueHistory = new Array(cyclesToSimulate).fill(0);
			const r31ValueHistory = new Array(cyclesToSimulate).fill(0);
			const pruState = {
				registers: new Array(32).fill(0)
			};

			prepareR30DataForPlotting(r30ValueHistory);
			prepareR31DataForPlotting(r31ValueHistory);

			return {pruState, r30ValueHistory, r31ValueHistory};
		}

		/*add instructions to simulate the PRU Instructions by expanding macros*/
		let {pruInstructions, pruInstructionsLabels } = expandMacros(pruInstructionsWithMacros, pruInstructionsLabelWithMacros);
        // Replace TEMP_REG references with actual register numbers
        pruInstructions = replaceTemporaryRegisters(pruInstructions);
        // Reset DMEM0 simulation memory
        pruDMEM0.resetDMEM0();
        // Clear DMEM0 symbol table before adding new symbols
        pruDMEM0.clearSymbolTable();

        // Reset SMEM simulation memory
        pruSMEM.resetSMEM();
        // Clear SMEM symbol table before adding new symbols
        pruSMEM.clearSymbolTable();

        // Get all data section contents
        const allDataSectionContents = getDataSectionContents();

        // Separate DMEM and SMEM data based on section field
        const dmemData = allDataSectionContents.filter(item => item.section === "dmem" || !item.section);
        const smemData = allDataSectionContents.filter(item => item.section === "smem");

        // Add DMEM data section contents starting at 0x00000000
        // Returns next available address after all data
        let nextDmemAddress = pruDMEM0.addDataSectionContents(dmemData, 0x00000000);

        // Add SMEM data section contents starting at 0x00010000 (64KB offset)
        // Returns next available address after all data
        let nextSmemAddress = pruSMEM.addDataSectionContents(smemData, 0x00010000);

        // Add Memory Variable block symbols to symbol table
        const memReserveModule = system.modules["/pru_blocks/utils/memory_variable_block"];
        if (memReserveModule && memReserveModule.$instances) {
            for (let instance of memReserveModule.$instances) {
                const labelName = instance.labelName;
                const sizeInBytes = instance.sizeInBytes;
                const memoryLocation = instance.memoryLocation;

                if (labelName && sizeInBytes) {
                    if (memoryLocation === "dmem") {
                        // Add to DMEM symbol table at next available address
                        pruDMEM0.addSymbol(labelName, nextDmemAddress, sizeInBytes);
                        nextDmemAddress += sizeInBytes;  // Move to next available address
                    } else if (memoryLocation === "smem") {
                        // Add to SMEM symbol table at next available address
                        pruSMEM.addSymbol(labelName, nextSmemAddress, sizeInBytes);
                        nextSmemAddress += sizeInBytes;  // Move to next available address
                    }
                }
            }
        }

        // Replace instruction symbol references with actual memory addresses
        // First replace DMEM symbols
        pruInstructions = pruDMEM0.replaceSymbolReferences(pruInstructions);
        // Then replace SMEM symbols
        pruInstructions = pruSMEM.replaceSymbolReferences(pruInstructions);
        const r31HistoryMap = collectR31History();
        let {pruState, r30ValueHistory, r31ValueHistory} = pruSimulator.simulatePruInstructions(pruInstructions, pruInstructionsLabels, inst["pruCyclesToSimulate"], r31HistoryMap);

        prepareR30DataForPlotting(r30ValueHistory);
        prepareR31DataForPlotting(r31ValueHistory);
        // return pruState, r30ValueHistory, and r31ValueHistory
        return {pruState, r30ValueHistory, r31ValueHistory}
	}
}

function getAIContext() {
    return getLongDescription();
}

function getLongDescription() {
    return `
## Simulation Settings

### Purpose
Configure the PRU simulation environment including PRU clock frequency, cycle count, output signal display, and input signal simulation for testing PRU blocks without hardware.

### How It Works
1. **Set Clock Frequency**: Configure PRU clock frequency (must match your R5F/A53 PRUICSS configuration)
2. **Set Simulation Duration**: Configure the number of PRU cycles to simulate
3. **Select Output Signals**: Choose which R30 (GPO) pins to display in the waveform viewer
4. **Configure Input Signals**: Select R31 (GPI) pins and define their input patterns for simulation
5. **Run Simulation**: The simulator executes PRU instructions and generates waveforms

### ⚠️ UART Block Simulation Limitation

**UART TX/RX blocks are not currently supported for simulation.** UART blocks use the three-channel peripheral interface which is not yet implemented in the simulator. When a UART block is present in your configuration:
- The simulator will display zero values for all signals
- No PRU instruction simulation will occur
- The waveform viewer will show flat lines at zero
- **UART blocks will function correctly on hardware** - this limitation only affects simulation

If you need to test UART communication, you must use actual hardware. All other PRU blocks (SPI, I2C, PWM, etc.) are fully supported in simulation.

### Configuration Parameters

**PRU Clock Frequency**: The PRU core clock frequency used by your hardware configuration. This setting is critical for:
- **Timing Calculations**: Converts nanosecond timing values to PRU cycles (e.g., CS Setup Time in SPI blocks)
- **Accurate Simulation**: Ensures simulated timing matches real hardware behavior
- **Frequency Display**: Shows correct calculated SPI clock frequencies

**⚠️ IMPORTANT**: This frequency MUST match the "Core Clk" setting in your R5F or A53 PRUICSS driver configuration:
1. Open your R5F/A53 SysConfig file
2. Navigate to: **TI Drivers & Middleware → PRUICSS**
3. Find the **"Core Clk"** parameter
4. Set the **same frequency** here in Simulation Settings

**Common Frequencies**:
- **200 MHz** (5 ns/cycle) - Default
- **225 MHz** (4.44 ns/cycle)
- **250 MHz** (4 ns/cycle)
- **300 MHz** (3.33 ns/cycle)
- **333.333 MHz** (3 ns/cycle) - Common for AM64x/AM243x

Mismatched frequencies will cause timing-sensitive operations (SPI, ADC) to fail on hardware even if simulation works correctly.

**Number Of PRU Cycles To Simulate**: Total PRU clock cycles to execute during simulation. Increase this value for longer transactions or multiple SPI packets.

**Select R30 (Output) Signals**: Choose which GPO pins (R30 register bits) to display in the simulation waveform. These show the actual output generated by your PRU blocks (e.g., SCLK, SDO, CS signals).

**Select R31 (Input) Signals**: Choose which GPI pins (R31 register bits) to simulate and display. When you select a pin, additional configuration options appear below to define the input data pattern.

### Input Simulation Configuration

For each selected GPI pin, you can configure the input data using one of two modes:

#### Timestamp Mode
Define input changes at specific PRU cycle numbers:
- **Input Cycles**: JSON array of PRU cycle numbers when the bit value changes. Example: \`[100, 107, 114, 121]\`
- **Input Values**: JSON array of bit values (0 or 1) at each timestamp. Example: \`[1, 0, 1, 0]\`
- **Repeat Last Bit**: When enabled, the last bit value continues for all subsequent cycles

**Example - Simulating SPI SDI data (0xA5 = 10100101):**
\`\`\`
Input Cycles: [100, 107, 114, 121, 128, 135, 142, 149]
Input Values: [1, 0, 1, 0, 0, 1, 0, 1]
\`\`\`
This sends bit values at each clock edge (assuming 7-cycle clock period starting at cycle 100).

#### Pattern Mode
Define a repeating bit pattern:
- **Bit Pattern**: JSON array of bits to repeat. Example: \`[0, 1, 1, 0, 1, 0, 0, 1]\`
- **Pattern Start Cycle**: PRU cycle number where the pattern begins
- **Pattern Repeat Count**: Number of times to repeat the pattern

**Example - Simulating a clock signal:**
\`\`\`
Bit Pattern: [0, 0, 0, 1, 1, 1]
Pattern Start Cycle: 50
Pattern Repeat Count: 10
\`\`\`
This creates a clock with 3 cycles LOW, 3 cycles HIGH, repeating 10 times (60 total cycles) starting at cycle 50.

### Usage Tips

**For SPI Read blocks:**
- Configure the SDI (Serial Data In) pin with the data you want to receive
- Time the bit transitions to align with the SCLK edges based on the SPI mode
- For MODE1 (sample on falling edge): set data just before each falling edge

**Calculating Timing:**
- Timing calculations depend on your configured PRU Clock Frequency
- Example at 333.333 MHz: 1 cycle = 3ns
- Example at 200 MHz: 1 cycle = 5ns
- For SPI with SCLK high=7, low=7: bit period = 14 cycles = 42ns @ 333MHz or 70ns @ 200MHz
- First SCLK edge typically occurs after CS setup time + initial cycles

**Debugging:**
- Start with a simple pattern and verify the waveform
- Use the waveform viewer to check signal alignment
- Ensure input transitions occur at the correct sample points for your SPI mode

### Terminology
- **R30**: PRU output register - bits control GPO pins
- **R31**: PRU input register - bits reflect GPI pin states
- **GPO**: General Purpose Output - output pins controlled by PRU
- **GPI**: General Purpose Input - input pins read by PRU
- **Timestamp Mode**: Define signal changes at specific cycle numbers
- **Pattern Mode**: Define a repeating bit sequence
`;
}

exports  = {
	//static module which allocates registers to all modules,
	//this module is not visible to user but error is thrown when it is out of registers
	displayName: "Simulation Settings",
    longDescription: getLongDescription(),
    getAIContext: getAIContext,
	moduleStatic: {
        validate,
        config: [
            {
                name: "pruClkFreq",
                displayName: "PRU Clock Frequency",
                description: "PRU core clock frequency (must match PRUICSS Core Clk setting in R5F/A53 SysConfig)",
                longDescription: `
### PRU Clock Frequency Configuration

This setting defines the PRU core clock frequency and is used for:
1. Converting timing values from nanoseconds to PRU cycles (e.g., CS Setup Time in SPI blocks)
2. Accurate simulation timing calculations
3. Displaying calculated SPI clock frequencies

**Important:** This value MUST match the "Core Clk" setting in your R5F or A53 PRUICSS driver configuration in SysConfig.

**To find your Core Clk setting:**
1. Open your R5F/A53 SysConfig file
2. Navigate to: TI Drivers & Middleware → PRUICSS
3. Look for "Core Clk" parameter
4. Set the same frequency here

**Common Configurations:**
- AM64x/AM243x: Typically 333.333 MHz or 200 MHz
- AM62x: Check your device-specific configuration

If the frequencies don't match, timing-sensitive operations (SPI, ADC) may not work correctly on hardware.
`,
                default: 200,
                options: [
                    { name: 200, displayName: "200 MHz" },
                    { name: 225, displayName: "225 MHz" },
                    { name: 250, displayName: "250 MHz" },
                    { name: 300, displayName: "300 MHz" },
                    { name: 333.333, displayName: "333.333 MHz" }
                ]
            },
            {
                name: "pruCyclesToSimulate",
                displayName: "Pru Cycles Simulated",
                description: "Total number of PRU clock cycles to execute during simulation",
                default: 2000,
            },
            {
                name: "signalsToDisplay",
                displayName : "Select Output Signals To Display",
                description: "Choose which GPO output pins to display in the simulation waveform viewer",
                default: ["0", "1", "2"],
                options: Array.from({ length: 20 }, (_, i) => ({
                    name : `${i}`,
                    displayName: `${getPruNumberFromContext()}_GPO_${i}`
                }))
            },
            {
                name: "signalsToDisplayR31",
                displayName : "Select Input Signals To Display",
                description: "Select GPI pins to simulate input data. Configuration options appear below for each selected pin.",
                longDescription: `
### Input Signal Simulation

Select which GPI pins you want to simulate input data for. When you select a pin:
1. Configuration fields appear below for that pin
2. Choose between **Timestamp Mode** or **Pattern Mode**
3. Define the input data that will be injected into R31 during simulation

This allows you to test PRU blocks that read from input pins (like SPI Read's SDI pin) without actual hardware.

**Timestamp Mode**: Specify exact cycle numbers and corresponding bit values
**Pattern Mode**: Define a repeating bit pattern with start cycle and repeat count
`,
                default: [],
                minSelections: 0,
                options: Array.from({ length: 20 }, (_, i) => ({
                    name : `${i}`,
                    displayName: `${getPruNumberFromContext()}_GPI_${i}`
                })),
                onChange: onSignalsToDisplayR31Change
            },
            // Add R31 simulation input configuration fields
            ...generateR31SimulationInputConfigs(),
        ],
	},
    getDataSectionContents,
    getInitSectDirectives,
    getUsectLinkerDirectives,
    simulationData
};