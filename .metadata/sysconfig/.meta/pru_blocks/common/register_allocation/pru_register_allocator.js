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
let containerOf = {};            // child instance name -> name of the loop/group block that lists it in $groupContents
let deferredLoopReleases = {};   // loop instance name -> map entries to release when that loop's body has been emitted
let hoistedOutOf = {};           // child instance name -> loops that list it in preInitBlocks (it is emitted BEFORE them)
let hoistedInPlace = {};         // ALU instance name -> [{entry, container}] preInit inputs it released to accumulate in place
let accumulatorBindings = {};    // update block name -> {preInit, container} from loop_block.accumulators

/**
 * Block fields that name a PRU register typed by the user and emitted VERBATIM by the block's macro. The allocator must
 * not hand such a register to another live value, or the macro would overwrite it. Every register named here is
 * removed from the pool, for the whole design, before anything is allocated.
 * Key: module path. Value: list of field descriptors:
 *   default : the field's default value in the block source; a conflict between two fields both still at default is a WARNING, not an error
 *   field : config name holding the register ("R4", "R5.b0", "R3.w1", or a bare register number)
 *   bytes : width of a bare register token (a .bN/.wN token carries its own width); a number or (inst) => number
 *   fullRegister : the macro does a fixed 4-byte access (`zero &REG, 4`, `lbco &REG, ..., 4`, `ldi32 REG`) whatever the token, so a
 *           sub-register token (R0.b0) still reserves max(token, 4) bytes from its first byte
 *   when  : (inst) => bool, the field is only read/written in some modes
 *   role  : what the macro does with the register: "w" writes a result there, "r" only reads it, "rm" reads it AND destroys
 *           it (shifts it out); a string or (inst) => string. Used for the overlap check only (see reservePinnedRegisters).
 * Fields that exist but are never touched by the macro are deliberately absent: reserving them would move allocations for nothing.
 */
const PINNED_REGISTER_FIELDS = {
    // Entries are added together with the blocks that declare such fields.
};

let pinnedRegisters = [];          // {block, field, token, firstByte, bytes} for every user-typed register, in the pool or not
let pinnedRegisterConflicts = [];  // two pins that claim the same byte, reported by validation as an ERROR
let pinnedProblems = [];           // {block, field, token, why} typed registers that are not a usable register window (ERROR in validation)
let pinnedByteCount = 0;           // bytes of the pool removed by pins
let poolAfterPins = [];            // pruByteArray right after the architectural windows and the pins were removed (free-register suggestion)

/**
 * Parses a typed register ("R4", "R5.b0", "R3.w1", 7) into {firstByte, bytes} (windowBytes: the macro's window, not the token, sets the width of a sub-register token), or null when it is not a register token.
 */
function parsePinnedRegister(value, bareBytes, windowBytes) {
    const m = /^\s*R(\d+)(?:\.([bw])([0-3]))?\s*$/i.exec(typeof value === "number" ? "R" + value : String(value));
    if (!m || (m[2] && m[2].toLowerCase() === "w" && m[3] === "3")) return null;   // .w3 would straddle two registers
    const reg = parseInt(m[1], 10);
    if (!m[2]) return { firstByte: reg * numOfBytesPerRegister, bytes: bareBytes };
    const tokenBytes = m[2].toLowerCase() === "b" ? 1 : 2;
    // a macro that moves a byte window starting at the token  covers the window, not just the token
    return { firstByte: reg * numOfBytesPerRegister + parseInt(m[3], 10), bytes: windowBytes ? Math.max(tokenBytes, bareBytes) : tokenBytes };
}

/**
 * Two pins on the same bytes are fine only when one block hands a value to another through the register (one writes,
 * the other only reads) or both only read. Two writers, a reader
 * that destroys what another reads, and any two fields of ONE block would overwrite each other.
 */
function isIntendedHandOff(a, b) {
    if (a.block === b.block) return false;
    const pair = [a.role, b.role].sort().join("+");
    return pair === "r+w" || pair === "r+r" || pair === "rm+w";
}

/**
 * Removes the user-pinned registers (all bytes they overlap) from the pool. Must run before anything is allocated.
 * Pins that fall outside R0-R27 (R28/R29 temporaries, R30/R31) take nothing from the pool.
 *
 * A pin whose block only READS the register (role "r") cannot damage
 * anything, so it is reserved only when another block's pin WRITES those bytes (a hand-off through
 * the register). A read-only pin with no writer is fed by an allocator output that happens to sit in that
 * register. Reserving it would
 * take the register away from the very value it is meant to publish, so it stays in the pool until the block takes a data
 * input and is flagged reserved:false in getPinnedRegisters().
 */
function reservePinnedRegisters() {
    pinnedRegisters = [];
    pinnedRegisterConflicts = [];
    pinnedProblems = [];
    pinnedByteCount = 0;
    for (const moduleName in PINNED_REGISTER_FIELDS) {
        const instances = systemModules[moduleName]?.$instances || [];
        for (const instance of instances) {
            for (const spec of PINNED_REGISTER_FIELDS[moduleName]) {
                if (spec.when && !spec.when(instance)) continue;
                const raw = instance[spec.field];
                if (raw === undefined || raw === null || raw === "") continue;
                const bareBytes = typeof spec.bytes === "function" ? spec.bytes(instance) : (spec.bytes || numOfBytesPerRegister);
                const parsed = parsePinnedRegister(raw, bareBytes, typeof spec.bytes === "function" || spec.fullRegister === true);
                const token = typeof raw === "number" ? "R" + raw : String(raw);
                if (!parsed) {
                    pinnedProblems.push({ block: instance.$name, field: spec.field, token: token,
                                          why: "is not a PRU register (write R0-R27, optionally with .b0-.b3 or .w0-.w2, e.g. R4 or R5.b0)" });
                    continue;
                }
                // a field marked ownWindowCheck is range-checked by its own block validator; every other field is checked here
                if (!spec.ownWindowCheck && parsed.firstByte + parsed.bytes > totalBytes) {
                    pinnedProblems.push({ block: instance.$name, field: spec.field, token: token,
                                          why: "makes the block touch " + parsed.bytes + " byte(s) from byte " + parsed.firstByte + ", past R27 (R28/R29 are the compiler temporaries, R30/R31 the I/O registers); choose a register whose window ends at or before R27.b3" });
                }
                const role = typeof spec.role === "function" ? spec.role(instance) : spec.role;
                pinnedRegisters.push({ block: instance.$name, field: spec.field, role: role, token: token,
                                       firstByte: parsed.firstByte, bytes: parsed.bytes, reserved: true,
                                       alwaysReserve: Boolean(spec.alwaysReserve),
                                       atDefault: String(raw).trim().toUpperCase() === String(spec.default).toUpperCase() });
            }
        }
    }
    const overlaps = (p, q) => p.firstByte < q.firstByte + q.bytes && q.firstByte < p.firstByte + p.bytes;
    for (const pin of pinnedRegisters) {
        if (pin.role === "r" && !pin.alwaysReserve) pin.reserved = pinnedRegisters.some(q => q.role === "w" && q.block !== pin.block && overlaps(pin, q));
    }
    const owners = Array.from({ length: totalBytes }, () => []);
    const reported = {};
    for (const pin of pinnedRegisters) {
        for (let b = pin.firstByte; b < pin.firstByte + pin.bytes && b < totalBytes; b++) {
            for (const other of owners[b]) {
                const key = other.block + "." + other.field + "|" + pin.block + "." + pin.field;
                if (!reported[key] && !isIntendedHandOff(other, pin)) {
                    reported[key] = true;
                    pinnedRegisterConflicts.push({ first: other, second: pin });
                }
            }
            if (pin.reserved && pruByteArray[b] === 0) { pruByteArray[b] = 1; pinnedByteCount++; }
            owners[b].push(pin);
        }
    }
    poolAfterPins = Array.from(pruByteArray);
}

/**
 * emit position of each block (first instruction), after allocation.
 */
function pinnedEmitOrder() {
    const order = {};
    (pruRegisterAllocationSummary.pruInstructionInstances || []).forEach((inst, i) => {
        if (inst && inst.$name !== undefined && order[inst.$name] === undefined) order[inst.$name] = i;
    });
    return order;
}

function pinsOverlap(p, q) {
    return p.firstByte < q.firstByte + q.bytes && q.firstByte < p.firstByte + p.bytes;
}

const UNCONDITIONAL_EXIT_OPCODES = ["HALT", "JMP"];   // flow_control_block: HALT, or JMP to the end of the generated code

/** the instance object of an allocated block, by name. */
function allocatedInstanceNamed(name) {
    const entry = moduleInstanceRegisterMap[name];
    return entry ? systemModules[entry.moduleName]?.$instances[entry.instanceNum] : undefined;
}

/** names of the callable (non-loop) groups around a block, innermost first, as one comparable string. */
function callableGroupChain(name) {
    return enclosingContainers(name).filter(c => !(moduleInstanceRegisterMap[c] && moduleInstanceRegisterMap[c].groupIsLoop)).join("/");
}

/**
 * true when EVERY control-flow path from `startName` (next, T and F ports) ends in an unconditional exit (a Flow Control
 * HALT or JMP) without ever reaching `targetName`. A path that just ends (no successor, no exit) is NOT such a path: the emitted
 * code falls through into whatever follows (an if/else whose T branch has no HALT runs on into the F branch). A conditional with its T or F port unconnected is likewise a non-exit (the missing branch is not provably an exit).
 */
function flowExitsBefore(startName, targetName) {
    const seen = new Set();
    const walk = (name) => {
        if (name === targetName) return false;
        const inst = allocatedInstanceNamed(name);
        if (!inst) return false;
        if (/\/flow_control_block$/.test(moduleInstanceRegisterMap[name].moduleName) && UNCONDITIONAL_EXIT_OPCODES.includes(String(inst.opCode).toUpperCase())) return true;
        if (/\/conditional_block$/.test(moduleInstanceRegisterMap[name].moduleName) && (!(inst.T || []).length || !(inst.F || []).length)) return false;
        if (seen.has(name)) return true;
        seen.add(name);
        const successors = [].concat(inst.next || [], inst.T || [], inst.F || []).map(c => c?.inst?.$name).filter(Boolean);
        return successors.length > 0 && successors.every(walk);
    };
    return walk(startName);
}

/**
 * is the emit order of two blocks the order they run in? Only then can "no reader between them" prove a lost value.
 * Not provable when the blocks sit in different callable groups (hand-written main.asm calls the groups in an order the generator
 * cannot see), or when the earlier block's every path ends in HALT/JMP before the later block (mutually exclusive branches).
 * Straight line, and the same loop body, stay provable.
 */
function executionOrderProvable(earlyName, lateName) {
    return callableGroupChain(earlyName) === callableGroupChain(lateName) && !flowExitsBefore(earlyName, lateName);
}

/**
 * the pin conflicts, each marked `harmful` when the overlap provably destroys a value unread: two writers ('w') of
 * overlapping bytes with NO reader ('r'/'rm') of them between the two in emit order (or two fields of one block). The first
 * writer's result is then dead before anything uses it, whether the registers were typed or left at their defaults.
 * Everything else (a reader between the writers, i.e. the register is reused one value at a time) is not provably harmful.
 * "between" needs (a) the emit order to BE the execution order (executionOrderProvable) and (b) a reader whose window
 * overlaps the bytes the second writer destroys (the overlap of the two writers), not merely the first writer's window.
 * Must be called after allocation (needs the emit order).
 */
function getPinnedConflictsClassified() {
    const order = pinnedEmitOrder();
    return pinnedRegisterConflicts.map(c => {
        let harmful = false;
        if (c.first.role === "w" && c.second.role === "w") {
            if (c.first.block === c.second.block) {
                harmful = true;
            } else if (order[c.first.block] !== undefined && order[c.second.block] !== undefined) {
                const early = order[c.first.block] < order[c.second.block] ? c.first : c.second;
                const late = early === c.first ? c.second : c.first;
                const lost = { firstByte: Math.max(early.firstByte, late.firstByte),
                               bytes: Math.min(early.firstByte + early.bytes, late.firstByte + late.bytes) - Math.max(early.firstByte, late.firstByte) };
                harmful = executionOrderProvable(early.block, late.block) &&
                          !pinnedRegisters.some(r => (r.role === "r" || r.role === "rm") && pinsOverlap(r, lost) &&
                                                     order[r.block] !== undefined && order[r.block] > order[early.block] && order[r.block] < order[late.block]);
                c = { first: early, second: late };
            }
        }
        return { first: c.first, second: c.second, harmful: harmful };
    });
}

/**
 * the first register window of `bytes` bytes (whole registers) that no pin (typed or default, reserved or not) covers and
 * the architectural windows (XFR2PSI/SUM32) do not take, for the "type another register" advice; null when there is none.
 */
function suggestFreeRegister(bytes) {
    const regs = Math.max(1, Math.ceil(bytes / numOfBytesPerRegister));
    for (let r = 0; r + regs <= numOfPruRegisters; r++) {
        const win = { firstByte: r * numOfBytesPerRegister, bytes: regs * numOfBytesPerRegister };
        let free = true;
        for (let b = win.firstByte; b < win.firstByte + win.bytes; b++) if (poolAfterPins[b] !== 0) free = false;
        if (free && !pinnedRegisters.some(p => pinsOverlap(p, win))) return "R" + r;
    }
    return null;
}

/**
 * A hand-off through a register (one block writes it, another transmits/publishes/shifts it) only works when the
 * writer runs first. A reader emitted before EVERY overlapping writer with no loop around both reads the register before it holds
 * the value. A reader that an earlier writer
 * already feeds is fine (consume A, publish A, consume B, publish B on one register), whatever runs after it. In a loop it is the
 * previous iteration's value: a one-iteration lag (the first iteration reads the uninitialised register, the last value is
 * never consumed), so it is exempt from the warning. Must be called after allocation (needs the emit order).
 */
function getPinnedHandOffOrderWarnings() {
    const order = pinnedEmitOrder();
    const inLoop = (name) => enclosingContainers(name).filter(c => moduleInstanceRegisterMap[c] && moduleInstanceRegisterMap[c].groupIsLoop);
    const out = [];
    for (const r of pinnedRegisters) {
        if ((r.role !== "r" && r.role !== "rm") || order[r.block] === undefined) continue;
        const writers = pinnedRegisters.filter(w => w.role === "w" && w.block !== r.block && pinsOverlap(w, r) && order[w.block] !== undefined);
        if (writers.some(w => order[w.block] < order[r.block])) continue;
        for (const w of writers) {
            const loopsOfW = inLoop(w.block);
            if (inLoop(r.block).some(c => loopsOfW.includes(c))) continue;
            out.push({ writer: w, reader: r });
        }
    }
    return out;
}

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
 * a request the pool could not satisfy is recorded here and reported by validation as an ERROR.
 * Before, pushInstruction returned -1 and every caller dropped it, so the block's instruction vanished from the asm
 * and the build stayed clean (a 24-stage running sum emitted 22 of its 24 ADDs).
 * @param {Object} instance - block that asked for registers
 * @param {number} numOfBytes - size of the request
 * @param {string} what - what the registers were for
 */
function recordAllocationFailure(instance, numOfBytes, what, contractFailure) {
    // a block that failed is revisited by every consumer; report each (block, request) once
    if (allocationFailures.some(f => f.block === instance.$name && f.what === what)) return;
    let freeBytes = 0;
    for (let i = 0; i < totalBytes; i++) if (pruByteArray[i] === 0) freeBytes++;
    allocationFailures.push({
        block: instance.$name,
        bytes: numOfBytes,
        what: what,
        contractFailure: contractFailure === true,
        freeBytes: freeBytes,
        pinnedBytes: pinnedByteCount,
        pinnedBy: pinnedRegisters.filter(p => p.reserved && p.firstByte < totalBytes).map(p => p.block + "." + p.field + "=" + p.token),
        budgetRegisters: numOfPruRegisters,
        budgetBytes: totalBytes
    });
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

// a connection names the SOURCE PORT it leaves from (conn.port === "output2"), and every output port a block
// allocates has its own register (byteOffsetOfOutput<N> / numOfBytesReqByOutput<N>). Reading only output1 would make
// a consumer wired to output2..N silently read output1's register. All consumer-side lookups go through these helpers.
let allocationFailures = [];  // register-pool exhaustion, one record per request that could not be placed; reported by validation
let unroutedConnections = [];  // consumers wired to an output port that owns no register; reported by validation, never rerouted to output1
let loopBoundaryViolations = []; // loop contents consumed outside loop; reported by validation

/** Number of output ports a block instance exposes (output1..outputN arrays), at least 1. */
function outputPortCount(inst) {
    let n = 1;
    while (n < 32 && inst["output" + (n + 1)] !== undefined) n++;
    return n;
}

/** Total consumer connections over every output port of a block instance. */
function outputConnectionCount(inst) {
    let total = 0;
    for (let n = 1; n <= outputPortCount(inst); n++) total += (inst["output" + n] || []).length;
    return total;
}

/** Every connection leaving any output port of a block instance. */
function allOutputConnections(inst) {
    let conns = [];
    for (let n = 1; n <= outputPortCount(inst); n++) conns = conns.concat(inst["output" + n] || []);
    return conns;
}

/** Output port number a connection leaves from ("output3" -> 3). A missing or malformed port name is a loud
 * Error naming the bad value (never a silent fallback to output1, which would read the wrong register). */
function sourcePortNumber(conn, owner) {
    const raw = conn && conn.port;
    const m = /^output(\d+)$/.exec(raw || "");
    if (!m) throw new Error("pru_register_allocator: invalid source output port '" + String(raw) + "'" + (owner ? " on " + owner : "") + "; expected 'outputN'");
    return parseInt(m[1], 10);
}

/** Registers (byteOffset, numBytes) allocated to output port N of a mapped block, or null when that port owns none. */
function outputPortAllocation(entry, port) {
    const off = entry["byteOffsetOfOutput" + port];
    const bytes = entry["numOfBytesReqByOutput" + port];
    return (off === undefined || off === -1 || !(bytes > 0)) ? null : { byteOffset: off, numBytes: bytes };
}

/** Releases every output port's registers of a mapped block. */
function disallocateAllOutputPorts(entry) {
    for (let port = 1; entry["byteOffsetOfOutput" + port] !== undefined; port++) {
        const alloc = outputPortAllocation(entry, port);
        if (alloc) disallocatePruRegisters(alloc.byteOffset, alloc.numBytes);
    }
}

/** Every allocated output register of a mapped block, in port order. */
function outputRegisterNotations(entry) {
    const regs = [];
    for (let port = 1; entry["byteOffsetOfOutput" + port] !== undefined; port++) {
        const alloc = outputPortAllocation(entry, port);
        const notation = alloc ? getPruRegister(alloc.byteOffset, alloc.numBytes) : -1;
        if (notation !== -1) regs.push(notation);
    }
    return regs;
}

/**
 * Register token a consumer reads for input <inputPort> wired to the source port named by `conn`.
 * Returns the source output port's own register; a missing/malformed port name or a port that owns no register is
 * recorded in unroutedConnections (so validation names the block and port) and yields a token that cannot assemble,
 * because substituting output1's register is the silent wrong-code defect this replaces.
 */
function sourceRegisterToken(consumer, inputPort, conn) {
    const source = conn.inst;
    let port;
    try {
        port = sourcePortNumber(conn, "'" + source.$name + "' -> '" + consumer.$name + "." + inputPort + "'");
    } catch (err) {
        unroutedConnections.push({ consumer: consumer.$name, inputPort: inputPort, source: source.$name, sourcePort: String(conn && conn.port) });
        return "UNROUTED_" + source.$name + "_" + String(conn && conn.port);
    }
    const alloc = outputPortAllocation(moduleInstanceRegisterMap[source.$name], port);
    if (!alloc) {
        unroutedConnections.push({ consumer: consumer.$name, inputPort: inputPort, source: source.$name, sourcePort: "output" + port });
        return "UNROUTED_" + source.$name + "_output" + port;
    }
    return getPruRegister(alloc.byteOffset, alloc.numBytes);
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
    // a preInit value is emitted in front of the loop and read on every pass, so it must own its register before
    // any body block is allocated. Reached lazily (through its first reader) it could be handed a register an earlier body
    // temporary had just released, and that temporary's next-pass load would overwrite it. Allocate them all first.
    for (const name of groupContents) {
        const mapped = (instance.preInitBlocks || []).includes(name) && moduleInstanceRegisterMap[name];
        if (!mapped || !('blockOutputCalculated' in mapped) || mapped.blockOutputCalculated === 1 || !('output1ArrayLength' in mapped)) continue;
        pushInstruction(systemModules[mapped.moduleName]?.$instances[mapped.instanceNum], null);
        if (mapped.output1ArrayLength !== -1) mapped.output1ArrayLength++;  // that call was not a consumer read
    }
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

    // exported blocks are the loop body's results for the outside world. A body whose only data
    // sink sits outside the loop (a post-loop store reading an exported accumulator) has no in-loop result
    // node, so without this pass the update block would be emitted after the loop instead of inside it.
    // Runs last on purpose: anything reachable from an in-loop sink keeps its existing emission order, and
    // pushInstruction skips whatever is already calculated.
    for (const instanceName of (instance.exportedBlocks || [])) {
        const entry = moduleInstanceRegisterMap[instanceName];
        if (!entry || entry.blockOutputCalculated === 1 || entry.conditionCalculated === 1) continue;
        const { moduleName, instanceNum } = entry;
        const childInstance = systemModules[moduleName]?.$instances[instanceNum];
        if (!childInstance) continue;
        pushInstruction(childInstance, null);
        if ("conditionCalculated" in moduleInstanceRegisterMap[instanceName]) {
            moduleInstanceRegisterMap[instanceName].conditionCalculated = 1;
        } else if ("blockOutputCalculated" in moduleInstanceRegisterMap[instanceName]) {
            moduleInstanceRegisterMap[instanceName].blockOutputCalculated = 1;
        }
        maxCycles = Math.max(maxCycles, moduleInstanceRegisterMap[instanceName].peakCycles);
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
        if (groupReturnAddrByteOffset === -1) recordAllocationFailure(instance, 2, "the group return address");
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
        for (const conn of allOutputConnections(inst)) {
            if (conn?.inst) queue.push(conn.inst);
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
 * may the registers of this block be released now?
 * Only the exact counter decides. output1ArrayLength is decremented on EVERY pushInstruction visit - including the
 * control-flow `prev` walk - so it is over-decremented and goes negative in a single-consumer chain, which made
 * `A_k = A_(k-1) + C_k` never release (a 24-stage running sum exhausted the pool). dataConsumersRemaining is decremented
 * once per data connection in the consumer's input loop, so 0 means every data consumer has read the value.
 * Callers release only AFTER the consumer's destination is allocated (see releaseConsumedInputs): a value released
 * earlier would be handed to the consumer as its own destination, and a macro that writes before it has finished
 * reading its input (Lookup Table reads R0.b2 and writes R0.b3) would corrupt itself.
 */
function releaseSafe(entry) {
    return entry.dataConsumersRemaining === 0;
}

/**
 * blocks whose whole instruction is ONE native PRU ALU instruction. The hardware reads every source before it
 * writes the destination, so such a block may reuse the register of an input it is the last consumer of
 * (`LSR R0, R0, R1.b0`), exactly as before. Every other block - every `m_*` macro and anything not listed - may write
 * its result before it has finished reading its inputs (Lookup Table reads R0.b2 and writes R0.b3), so it must not be
 * given a register released by its own inputs. The default is the safe side: an unknown opCode releases AFTER allocation.
 */
const IN_PLACE_SAFE_OPCODES = ["ADD", "ADC", "SUB", "SUC", "AND", "OR", "XOR", "NOT", "LSL", "LSR"];

function readsAllInputsBeforeWriting(instance) {
    return typeof instance.opCode === "string" && IN_PLACE_SAFE_OPCODES.includes(instance.opCode.toUpperCase());
}

/** Names of every loop/group block that contains `name`, innermost first. */
function enclosingContainers(name) {
    const chain = [];
    for (let c = containerOf[name]; c !== undefined && !chain.includes(c); c = containerOf[c]) chain.push(c);
    return chain;
}

/** checks if consumer reads producer from outside producer's loop/group */
function checkBoundary(producerName, consumerName, portName) {
    if (!producerName || !consumerName) return;
    const pContainers = enclosingContainers(producerName);
    const cContainers = enclosingContainers(consumerName);
    for (const c of pContainers) {
        if (!cContainers.includes(c)) {
            loopBoundaryViolations.push({
                consumer: consumerName,
                producer: producerName,
                container: c,
                port: portName
            });
        }
    }
}

/**
 * the loop body is emitted ONCE but runs loopCount times, so a value produced OUTSIDE a loop and read by a block
 * INSIDE it is read again on every iteration. Releasing it at its single textual consumer let the next block in the body
 * take the register, and iteration 2 read the clobbered byte. Returns the outermost container of `consumer` that does not
 * also contain `producer` (null when both sit in the same containers, i.e. the release is safe where it stands).
 */
function outermostForeignContainer(producerName, consumerName) {
    // a preInit block is listed in the loop's $groupContents but its instructions are moved in front of the loop
    // (extractPreInitInstructions), so for release purposes it is OUTSIDE that loop: it runs once and every iteration reads it.
    const hoisted = hoistedOutOf[producerName] || [];
    const producerChain = enclosingContainers(producerName).filter(c => !hoisted.includes(c));
    const foreign = enclosingContainers(consumerName).filter(c => !producerChain.includes(c));
    return foreign.length === 0 ? null : foreign[foreign.length - 1];
}

/** Releases the registers of every input of `instance` whose last data consumer has now been allocated. */
function releaseConsumedInputs(instance) {
    for (let iterator1 = 1; iterator1 <= instance.numOfInputPorts; iterator1++) {
        const inputInstanceName = instance["input" + iterator1]?.[0]?.inst?.$name;
        const entry = inputInstanceName && moduleInstanceRegisterMap[inputInstanceName];
        // registersReleased: a second release would zero bytes a later block (possibly this one) has since been given.
        if (entry && !entry.registersReleased && releaseSafe(entry)) {
            // an accumulator that took over a preInit register already waits for the end of that loop
            if (entry.holdUntilLoopEnd && enclosingContainers(instance.$name).includes(entry.holdUntilLoopEnd)) continue;
            const container = outermostForeignContainer(inputInstanceName, instance.$name);
            if (container === null) {
                disallocateAllOutputPorts(entry);
                entry.registersReleased = true;
            } else if (moduleInstanceRegisterMap[container]?.groupIsLoop) {
                if (entry.dataConsumersTotal === 1 && readsAllInputsBeforeWriting(instance) && (hoistedOutOf[inputInstanceName] || []).includes(container)) {
                    // incremental_spi: `ADC R0.b1, R0.b1, R0.b2` accumulates in the preInit register. Only when the ALU is the value's
                    // SOLE consumer (any other reader would see the accumulator on iteration 2). Released now so the
                    // ALU may take it over; settleHoistedInPlace() decides, once the destination is known, whether it did.
                    disallocateAllOutputPorts(entry); entry.registersReleased = true;
                    (hoistedInPlace[instance.$name] = hoistedInPlace[instance.$name] || []).push({ entry, container });
                } else {
                    // Live for the whole loop: released once the loop body has been emitted (releaseDeferredForLoop).
                    (deferredLoopReleases[container] = deferredLoopReleases[container] || []).push(entry);
                }
            }
            // A callable group can run from any call site, so a value it reads from outside is never released.
        }
    }
}

/** Byte indexes of every output register of a mapped block. */
function outputBytes(entry) {
    const bytes = [];
    for (let port = 1; entry["byteOffsetOfOutput" + port] !== undefined; port++) {
        const alloc = outputPortAllocation(entry, port);
        if (alloc) for (let i = alloc.byteOffset; i < alloc.byteOffset + alloc.numBytes; i++) bytes.push(i);
    }
    return bytes;
}

/**
 * after an ALU block released a preInit input to accumulate in it, check the destination really landed on that
 * register. If so the result is the loop's accumulator and nothing else in the body may take the register until the loop
 * has ended (a later constant would clobber it on iteration 2). If not, the preInit value was never overwritten, so it is
 * pinned again exactly as for any other consumer: a later block must not be given its register.
 */
function settleHoistedInPlace(instance) {
    const pending = hoistedInPlace[instance.$name];
    if (!pending) return;
    delete hoistedInPlace[instance.$name];
    const own = moduleInstanceRegisterMap[instance.$name];
    const ownBytes = own ? outputBytes(own) : [];
    for (const { entry, container } of pending) {
        const list = (deferredLoopReleases[container] = deferredLoopReleases[container] || []);
        if (outputBytes(entry).some(b => ownBytes.includes(b))) {
            own.holdUntilLoopEnd = container;
            list.push(own);
        } else {
            for (const b of outputBytes(entry)) pruByteArray[b] = 1;
            entry.registersReleased = false;
            list.push(entry);
        }
    }
}

/** [{preInit, update}] from a loop's accumulators (an array, or a JSON string of one).
 * Malformed entries are ignored here; loop_block.validate() rejects them. */
function parseAccumulatorBindings(value) {
    let list = value;
    if (list === undefined || list === null) return [];
    if (typeof list === "string") {
        if (list.trim() === "") return [];
        try {
            list = JSON.parse(list);
        } catch (e) {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
        if (entry && typeof entry.preInit === "string" && typeof entry.update === "string") {
            out.push({ preInit: entry.preInit, update: entry.update });
        }
    }
    return out;
}

/**
 * explicit accumulator binding (loop_block.accumulators). The update block's destination IS the preInit
 * block's register, so the update reads and writes the same bytes on every iteration (zero extra cycles), instead
 * of the allocator handing it a fresh register that recomputes preInit + x each pass. Anything less than an exact,
 * already-released, same-size preInit register is a loud allocation failure, never a silent fallback to 0 + x.
 */
function coalesceAccumulator(instance, binding, numBytes) {
    const fail = (why) => {
        recordAllocationFailure(instance, numBytes, "its accumulator register (accumulators: '" +
            binding.preInit + "' -> '" + instance.$name + "'): " + why, true);
        return -1;
    };
    const pre = moduleInstanceRegisterMap[binding.preInit];
    if (!pre) return fail("preInit block '" + binding.preInit + "' is not allocated");
    const alloc = outputPortAllocation(pre, 1);
    if (!alloc) return fail("preInit block '" + binding.preInit + "' owns no output register");
    if (alloc.numBytes !== numBytes) {
        return fail("preInit register is " + alloc.numBytes + " byte(s) but the update needs " + numBytes);
    }
    for (let b = alloc.byteOffset; b < alloc.byteOffset + alloc.numBytes; b++) {
        if (pruByteArray[b] !== 0) {
            return fail("preInit register byte " + b + " is still live (the preInit value has another consumer, so '" +
                instance.$name + "' cannot take it over)");
        }
    }
    for (let b = alloc.byteOffset; b < alloc.byteOffset + alloc.numBytes; b++) pruByteArray[b] = 1;
    return alloc.byteOffset;
}

/**
 * an ALU result is the loop's accumulator only in the incremental_spi shape: its LOW byte is the first byte of the
 * preInit value it took over, and it covers no byte of any other released preInit value. Any other overlap (a carry byte
 * landing on another preInit register, or a result starting inside one) would overwrite that value on every pass, so every
 * released preInit value is pinned again and the result is placed elsewhere. Returns the (possibly re-chosen) offset.
 */
function repinUnlessAccumulatorShape(instance, byteOffset, numBytes) {
    const pending = hoistedInPlace[instance.$name];
    if (!pending || byteOffset === -1) return byteOffset;
    const result = [];
    for (let b = byteOffset; b < byteOffset + numBytes; b++) result.push(b);
    const accumulates = pending.some(({ entry }) => {
        const own = outputBytes(entry);
        if (own.length === 0 || result[0] !== Math.min(...own)) return false;
        return pending.every(other => other.entry === entry || !outputBytes(other.entry).some(b => result.includes(b)));
    });
    if (accumulates || !pending.some(({ entry }) => outputBytes(entry).some(b => result.includes(b)))) return byteOffset;
    for (const b of result) pruByteArray[b] = 0;
    for (const { entry, container } of pending) {
        for (const b of outputBytes(entry)) pruByteArray[b] = 1;
        entry.registersReleased = false;
        (deferredLoopReleases[container] = deferredLoopReleases[container] || []).push(entry);
    }
    delete hoistedInPlace[instance.$name];
    return getFreeByteOffset(numBytes);
}

/** Releases the values a loop body only read, now that the loop has been emitted and none of them can be read again. */
function releaseDeferredForLoop(loopName) {
    for (const entry of deferredLoopReleases[loopName] || []) {
        if (entry.registersReleased || !releaseSafe(entry)) continue;
        disallocateAllOutputPorts(entry);
        entry.registersReleased = true;
    }
    deferredLoopReleases[loopName] = [];
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
        checkBoundary(prevPortInstanceName, instanceName, "prev");
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
        const inputConn = instance[inputPort + iterator1]?.[0];
        const inputInstance = inputConn?.inst;
        const inputInstanceName = inputInstance?.$name;
        
        if (inputInstanceName) {
            checkBoundary(inputInstanceName, instanceName, inputPort + iterator1);
            // Recursively process connected input
            let noOfBytesUsedByInput = pushInstruction(inputInstance, instance);
            // this connection is one data read of the source, counted exactly once, here.
            if (moduleInstanceRegisterMap[inputInstanceName].dataConsumersRemaining > 0) {
                moduleInstanceRegisterMap[inputInstanceName].dataConsumersRemaining--;
            }
            // the width that matters is the source PORT's, not output1's.
            // a missing/malformed source port leaves sourcePort null (never silent output1); the token
            // lookup below records it in unroutedConnections so validation names the block and port.
            let sourcePort = null;
            try {
                sourcePort = sourcePortNumber(inputConn, "'" + inputInstanceName + "' -> '" + instanceName + ".input" + iterator1 + "'");
            } catch (err) {
                // Recorded once by sourceRegisterToken below; keep null so the output1 fast path is never taken
                // for a connection whose source port name SysConfig did not provide.
            }
            if (sourcePort !== null && sourcePort !== 1) {
                noOfBytesUsedByInput = moduleInstanceRegisterMap[inputInstanceName]["numOfBytesReqByOutput" + sourcePort] || 0;
            }

            moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath = new Set([
                ...moduleInstanceRegisterMap[instanceName].connectedNodesInPeakCyclePath,
                ...moduleInstanceRegisterMap[inputInstanceName].connectedNodesInPeakCyclePath
            ]);
            
            // Update max bytes used
            maxBytesUsed = noOfBytesUsedByInput > maxBytesUsed ? noOfBytesUsedByInput : maxBytesUsed;
            
            if (sourcePort === 1) {
                // Get register notation for this input's output
                const _srcByteOffset = moduleInstanceRegisterMap[inputInstanceName].byteOffsetOfOutput1;
                const _srcNumBytes   = moduleInstanceRegisterMap[inputInstanceName].numOfBytesReqByOutput1;
                if (_srcNumBytes > 4) {
                    // 64-bit source: emit two consecutive registers (lo, hi)
                    const _loReg = getPruRegister(_srcByteOffset, 4);
                    const _hiReg = getPruRegister(_srcByteOffset + 4, 4);
                    inputValues = inputValues + _loReg + " , " + _hiReg + " , ";
                } else {
                    inputValues = inputValues + getPruRegister(_srcByteOffset, _srcNumBytes) + " , ";
                }
            } else {
                // Register notation for the output PORT this input is wired to (output2 and up)
                inputValues = inputValues + sourceRegisterToken(instance, inputPort + iterator1, inputConn) + " , ";
            }
        } else {
            // Unconnected input: provide dummy register to preserve macro argument positions
            inputValues = inputValues + "R0 , ";
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
    
    // a single native ALU instruction reads all sources before it writes, so it may take over the register of an
    // input it was the last consumer of; every other block releases only after its destination is allocated (below).
    if (readsAllInputsBeforeWriting(instance)) {
        releaseConsumedInputs(instance);
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
                if (byteOffset === -1) recordAllocationFailure(instance, instance.loopCountRegSize, "its loop counter");
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
                releaseDeferredForLoop(instanceName);

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
                releaseDeferredForLoop(instanceName);

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
                if (inputValues === "") {
                    instruction = `${instance.opCode} ${outputRegister}`;
                } else {
                    instruction = `${instance.opCode} ${outputRegister}, ${inputValues}`;
                }
            }
        }
        // Generate PRU instruction for regular blocks
        else {
            // Allocate registers for output
            // an explicitly bound accumulator reuses its preInit register instead of taking a fresh
            // one. repinUnlessAccumulatorShape still runs below: the coalesced bytes trivially satisfy its
            // accumulator shape, so the preInit settle logic keeps working unchanged.
            let byteOffset;
            if (accumulatorBindings[instanceName] !== undefined) {
                byteOffset = coalesceAccumulator(instance, accumulatorBindings[instanceName], maxBytesUsed);
                if (byteOffset === -1) return -1; // specific failure already recorded (validation reports it)
            } else {
                byteOffset = getFreeByteOffset(maxBytesUsed);
            }
            byteOffset = repinUnlessAccumulatorShape(instance, byteOffset, maxBytesUsed);

            if (byteOffset === -1) {
                recordAllocationFailure(instance, maxBytesUsed, "its result");
                return -1; // Failed to allocate registers (validation reports it as an error)
            }
            
            // Update register map with allocation info
            moduleInstanceRegisterMap[instanceName].byteOffsetOfOutput1 = byteOffset;
            moduleInstanceRegisterMap[instanceName].numOfBytesReqByOutput1 = maxBytesUsed;
            
            // Get output register notation
            // For 64-bit outputs (>4 bytes), emit two consecutive registers (lo, hi)
            let outputRegister;
            if (maxBytesUsed > 4) {
                const _outLoReg = getPruRegister(byteOffset, 4);
                const _outHiReg = getPruRegister(byteOffset + 4, 4);
                outputRegister = `${_outLoReg}, ${_outHiReg}`;
            } else {
                outputRegister = getPruRegister(byteOffset, maxBytesUsed);
            }
            // Blocks with a multi-result macro need distinct allocator-owned destinations
            // before their input and constant arguments.
            const macroOutputRegisters = [outputRegister];
            if (instance.multiOutputMacroArgs) {
                for (let output = 2; output <= instance.numOfOutputPorts; output++) {
                    const width = parseInt(instance["output" + output + "Size"] || maxBytesUsed);
                    const extraOffset = getFreeByteOffset(width);
                    if (extraOffset === -1) {
                        recordAllocationFailure(instance, width, "result output" + output);
                        return -1;
                    }
                    moduleInstanceRegisterMap[instanceName]["byteOffsetOfOutput" + output] = extraOffset;
                    moduleInstanceRegisterMap[instanceName]["numOfBytesReqByOutput" + output] = width;
                    macroOutputRegisters.push(getPruRegister(extraOffset, width));
                }
            }

            // Clean up input values string (remove trailing comma and space)
            if (inputValues.endsWith(" , ")) {
                inputValues = inputValues.slice(0, -3);
            }
            //create Instruction
            const instMod = systemModules[moduleInstanceRegisterMap[instanceName].moduleName];
            if (typeof instMod?.getInstruction === "function") {
                instruction = instMod.getInstruction(instance, outputRegister);
            } else if (inputValues === "") {
                instruction = `${instance.opCode} ${macroOutputRegisters.join(", ")}`;
            } else {
                instruction = `${instance.opCode} ${macroOutputRegisters.join(", ")}, ${inputValues}`;
            }
        }
    }
    // the destination (if any) is allocated now, so inputs whose last data consumer this was can be released
    // (a no-op for the ALU blocks that already released them above).
    releaseConsumedInputs(instance);
    settleHoistedInPlace(instance);
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
    unroutedConnections = [];
    allocationFailures = [];
    loopBoundaryViolations = [];
    pruByteArray = new Array(totalBytes).fill(0);

    // user-typed registers the blocks emit verbatim leave the pool before anything is allocated
    reservePinnedRegisters();
    loopCounterRegisters = {};  // Reset loop counter tracking
    groupReturnAddrByteOffset = -1;  // Reset group return address register
    containerOf = {};
    deferredLoopReleases = {};
    hoistedOutOf = {};
    hoistedInPlace = {};
    accumulatorBindings = {};
    for (const moduleName in systemModules) {
        for (const instance of systemModules[moduleName]?.$instances || []) {
            if (instance.$name && instance.$groupContents) {
                // $groupContents holds instance objects; the JSON clone turns them into names, as everywhere else here.
                for (const child of JSON.parse(JSON.stringify(instance)).$groupContents) containerOf[child] = instance.$name;
                for (const pre of JSON.parse(JSON.stringify(instance)).preInitBlocks || []) (hoistedOutOf[pre] = hoistedOutOf[pre] || []).push(instance.$name);
                // explicit accumulator bindings live on loops (infiniteLoop marks a loop container).
                if ('infiniteLoop' in instance) {
                    for (const b of parseAccumulatorBindings(instance.accumulators)) {
                        accumulatorBindings[b.update] = { preInit: b.preInit, container: instance.$name };
                    }
                }
            }
        }
    }
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
                // output1ArrayLength counts the consumer connections of EVERY output port (the name is historical):
                // a block whose only consumer hangs off output2 is not a result node, and its registers are released after the last one.
                const outputConnections = outputConnectionCount(instance);
                const outputArrayLength = outputConnections === 0 ? -1 : outputConnections;
                
                moduleInstanceRegisterMap[instanceName] = {
                    "blockOutputCalculated": 0,
                    "output1ArrayLength": outputArrayLength,
                    // exact count of data consumers that have not read this block yet (see releaseSafe)
                    "dataConsumersRemaining": outputConnections,
                    "dataConsumersTotal": outputConnections,
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
                    moduleInstanceRegisterMap[instanceName].groupIsLoop = true;
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
                    moduleInstanceRegisterMap[instanceName].groupIsLoop = true;
                }
                if(instance.$groupContents && !('infiniteLoop' in instance)){
                    let groupContents = JSON.parse(JSON.stringify(instance)).$groupContents
                    groupBlockInstanceNames = groupBlockInstanceNames.concat(groupContents);

                    groupMetadata.push({
                        groupName : instance.groupName || instanceName,
                        instanceName : instanceName,
                        groupContents : groupContents
                    });

                    // A group listed inside a loop's $groupContents is emitted outside the loop
                    // and never called. We reject this.
                    if (containerOf[instanceName]) {
                        loopBoundaryViolations.push({
                            consumer: "generator",
                            producer: instanceName,
                            container: containerOf[instanceName],
                            port: "$groupContents"
                        });
                    }
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
            // every output port that owns a register is listed, not just output1
            const regNotations = outputRegisterNotations(entry);
            if (regNotations.length > 0) {
                allocationMap[instanceName] = {
                    registers: regNotations,
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

    // the CTPPR0 write runs once at sysconfig_generated_start and on every group
    // CALL, ahead of the first block, so it adds to the worst case of either path. The
    // per-block peakCycles in the allocation table do not include it.
    const staticModule = systemModules["/pru_blocks/common/pru_blocks_static_module"];
    const ctSetupCycles = (staticModule && typeof staticModule.getConstantTableSetupCycles === "function")
        ? staticModule.getConstantTableSetupCycles() : 0;
    // getConstantTableSetupCycles() also counts the SPI CS idle `set r30` per pin; split it so the CTPPR0 wording stays exact.
    const csIdleCycles = (staticModule && typeof staticModule.getSpiCsIdleSetupCycles === "function")
        ? staticModule.getSpiCsIdleSetupCycles() : 0;
    const ctppr0Cycles = ctSetupCycles - csIdleCycles;
    overallPeakCycles += ctSetupCycles;

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
        comments.push(`; OVERALL PEAK CYCLES: ${overallPeakCycles + 1} cycles (worst-case timing) including group and non-group code${ctSetupCycles ? ` (includes ${[ctppr0Cycles ? `${ctppr0Cycles} cycles of CTPPR0 setup for c28` : "", csIdleCycles ? `${csIdleCycles} cycles of SPI CS idle-level setup` : ""].filter(Boolean).join(" and ")}, repeated on every group call; per-block cycle counts exclude it)` : ""}`);
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
        registers.push(...outputRegisterNotations(entry));
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
    getBlockRegisterAllocation,
    sourcePortNumber,
    getUnroutedConnections: () => unroutedConnections,
    getAllocationFailures: () => allocationFailures,
    getPinnedRegisters: () => pinnedRegisters,
    getPinnedRegisterConflicts: getPinnedConflictsClassified,
    suggestFreeRegister,
    getPinnedRegisterProblems: () => pinnedProblems,
    getPinnedHandOffOrderWarnings,
    getLoopBoundaryViolations: () => loopBoundaryViolations
}
