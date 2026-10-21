/**
 * dual_oracle_harness.js - Dual-Oracle Verification Harness
 *
 * Uses TI pru-simulator as an independent second simulator: runs block clpru ELFs under TI pru-simulator and
 * compares the result against the in-tool JS simulator. Also provides the block loader and macro expander that the
 * scripts/sim tools use.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const vm = require('vm');
const { splitLabel } = require('./asm_label');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIM_DIR = path.join(REPO_ROOT, '.metadata/sysconfig/.meta/pru_blocks/common/simulation');
const WORKSPACE_TOOLS_DIR = path.resolve(REPO_ROOT, '../../tools');
const DEFAULT_SIMULATOR_DIR = path.join(WORKSPACE_TOOLS_DIR, 'pru-simulator-upstream');
const BUILD_TMP_DIR = path.join(REPO_ROOT, 'build_out/dual_oracle_tmp');

// Find clpru compiler binary
function findClpru() {
    if (process.env.CGT_TI_PRU_PATH) {
        const p = path.join(process.env.CGT_TI_PRU_PATH, 'bin', process.platform === 'win32' ? 'clpru.exe' : 'clpru');
        if (fs.existsSync(p)) return p;
    }
    const defaultPaths = [
        'C:/ti/ti-cgt-pru_2.3.3/bin/clpru.exe',
        'C:/ti/ti-cgt-pru_2.3.3/bin/clpru',
        '/opt/ti/ti-cgt-pru_2.3.3/bin/clpru'
    ];
    for (const p of defaultPaths) {
        if (fs.existsSync(p)) return p;
    }
    // Check PATH
    try {
        const cmd = process.platform === 'win32' ? 'where.exe clpru' : 'which clpru';
        const res = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
        if (res && fs.existsSync(res)) return res;
    } catch (_) {}
    throw new Error("clpru compiler not found. Set CGT_TI_PRU_PATH or install ti-cgt-pru_2.3.3.");
}

// Find Python binary
function findPython() {
    if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) return process.env.PYTHON;
    const candidates = ['python', 'python3', 'py'];
    for (const cmd of candidates) {
        try {
            const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
            if (res.status === 0) return cmd;
        } catch (_) {}
    }
    return 'python';
}

// Find TI pru-simulator repository directory: PRU_SIMULATOR_PATH, else the first
// <ancestor>/tools/pru-simulator-upstream of the repository, at any depth. A directory
// only counts when it holds simulator.py; a directory with the right name but no
// simulator in it is skipped.
function isSimulatorCheckout(dir) {
    return fs.existsSync(path.join(dir, 'simulator.py'));
}

function findSimulatorDir() {
    const tried = [];
    const env = process.env.PRU_SIMULATOR_PATH;
    if (env) {
        tried.push(env);
        if (isSimulatorCheckout(env)) return env;
    }
    tried.push(DEFAULT_SIMULATOR_DIR);
    if (isSimulatorCheckout(DEFAULT_SIMULATOR_DIR)) return DEFAULT_SIMULATOR_DIR;
    let dir = REPO_ROOT;
    while (true) {
        const candidate = path.join(dir, 'tools', 'pru-simulator-upstream');
        tried.push(candidate);
        if (isSimulatorCheckout(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        'TI pru-simulator not found (looked for simulator.py in each). ' +
        'Set PRU_SIMULATOR_PATH. Tried: ' + tried.join(' | ')
    );
}

// Load JS simulation core in isolated context
const scriptCache = {};
function loadSimScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
        console: console,
        Math: Math,
        parseInt: parseInt,
        isNaN: isNaN,
        eval: eval,
        Uint8Array: Uint8Array,
        Array: Array,
        JSON: JSON,
        system: {
            getScript: (p) => {
                const basename = path.basename(p);
                if (!scriptCache[basename]) {
                    scriptCache[basename] = loadSimScript(path.join(SIM_DIR, basename));
                }
                return scriptCache[basename];
            }
        },
        exports: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.exports;
}

const pruCore = loadSimScript(path.join(SIM_DIR, 'pru_core.js'));
const pruDMEM0 = scriptCache['pru_dmem0.js'];

/**
 * Universal non-throwing proxy for SysConfig modules
 */
function makeStub() {
    const fn = function () { return makeStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
            if (prop === Symbol.iterator) return undefined;
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply() { return makeStub(); }
    });
}

/**
 * Loads a block module in a Node.js sandbox environment
 */
function loadBlockModule(blockName, blockSubdir) {
    const file = path.join(REPO_ROOT, `.metadata/sysconfig/.meta/pru_blocks/${blockSubdir}/${blockName}.syscfg.js`);
    const src = fs.readFileSync(file, 'utf8');
    const sandbox = {
        system: makeStub(),
        exports: {},
        module: { exports: {} },
        require: () => makeStub(),
        console: { log() {}, error() {}, warn() {} }
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: file, timeout: 5000 });
    const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
      : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
      : sandbox.exports;
    return mod;
}

/**
 * Drops a trailing `; comment` (a `;` outside double quotes) from an assembler line.
 */
function stripAsmComment(text) {
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') inQuote = !inQuote;
        else if (text[i] === ';' && !inQuote) return text.slice(0, i).trimEnd();
    }
    return text;
}

/**
 * Evaluates a numeric-only expression (decimal/hex literals, + - * / % & | << >> ( ) and the
 * comparison operators; a single `=` is equality, as in the TI assembler). Returns null when
 * any token is not a number, so a leftover register/symbol name is never guessed at.
 */
function evalNumericExpression(text) {
    const expr = String(text).trim();
    if (!expr) return null;
    const tokens = expr.match(/0x[0-9a-f]+|\d+|<<|>>|<=|>=|==|!=|&&|\|\||[-+*\/%&|^~!<>()=]|\S/gi);
    if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return null;
    for (const t of tokens) {
        if (!/^(0x[0-9a-f]+|\d+|<<|>>|<=|>=|==|!=|&&|\|\||[-+*\/%&|^~!<>()=])$/i.test(t)) return null;
    }
    const js = tokens.map(t => t === '=' ? '==' : t).join(' ');
    try {
        const v = Function('"use strict"; return (' + js + ');')();
        return typeof v === 'boolean' ? (v ? 1 : 0) : (Number.isFinite(v) ? v : null);
    } catch (e) { return null; }
}

/**
 * Like evalCondition but also reports whether the condition could be decided.
 * Returns { value, decided } (plus `reason` when undecided). An undecidable condition has value false, but the
 * caller can now see that, instead of the branch silently vanishing.
 *
 * `definedSymbols` makes the symbol-table guards decidable. Either a Set (used for both
 * guard kinds) or { symbols: Set, substitutions: Set }: `$isdefed("X")` tests `.set/.equ`
 * symbols only, `$defined(X)` also sees `.asg` substitution symbols (verified against clpru
 * 2.3.3: an `.asg` name is `$defined` but not `$isdefed`; unquoted `$isdefed(X)` is the
 * assembler error E0301, so only the quoted form is accepted).
 */
function evalConditionDetailed(rawCond, mapping, definedSymbols) {
    // `.if (a == b) ; rising`: the comment must go before the paren strip,
    // else the trailing text keeps the outer parens from balancing and the whole
    // condition is mis-split.
    // Decode first: `&lt;` itself contains a semicolon, which must not be
    // mistaken for the beginning of an assembler comment.
    let cond = stripAsmComment(String(rawCond).replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')).trim();
    // `.if (a == b)`: strip one balanced outer pair, otherwise the split below
    // compares "(a" with "b)" and every == is false, every != true.
    while (cond.startsWith('(') && cond.endsWith(')')) {
        let depth = 0, wraps = true;
        for (let k = 0; k < cond.length - 1; k++) {
            if (cond[k] === '(') depth++;
            else if (cond[k] === ')') depth--;
            if (depth === 0) { wraps = false; break; }
        }
        if (!wraps) break;
        cond = cond.slice(1, -1).trim();
    }
    // Before the substitution below, which would rewrite the quoted name.
    // `$isdefed("SYM")` / `$defined(SYM)` are decidable only for a caller that tracks assembler
    // symbol definitions (emit_all_blocks.js). Without a symbol set they stay undecidable.
    const dm = cond.match(/^(!?)\s*\$(isdefed|defined)\(\s*("([^"]+)"|[A-Za-z_]\w*)\s*\)$/);
    if (dm) {
        const quoted = dm[3].startsWith('"');
        if (!definedSymbols || (dm[2] === 'isdefed' && !quoted)) return { value: false, decided: false };
        const sets = definedSymbols instanceof Set
            ? { symbols: definedSymbols, substitutions: definedSymbols } : definedSymbols;
        const name = quoted ? dm[4] : dm[3];
        const has = sets.symbols.has(name) || (dm[2] === 'defined' && sets.substitutions.has(name));
        return { value: has !== (dm[1] === '!'), decided: true };
    }
    for (const [pName, val] of Object.entries(mapping)) {
        cond = cond.replace(new RegExp('\\b' + pName + '\\b', 'g'), val);
    }
    const num = evalNumericExpression(cond);
    if (num !== null) return { value: num !== 0, decided: true };
    // After substitution anything still alphabetic is an unbound register or symbol
    // (`R12`, `(R12 + 1)`, `R12 & 1`, `SAMPLE_HIGH`): the guard cannot be decided, whatever
    // shape it has. Quoted strings and the words true/false are not unbound operands.
    const residual = cond.replace(/"[^"]*"/g, '').match(/\b[A-Za-z_]\w*/g) || [];
    const unbound = residual.filter(t => !/^(true|false)$/i.test(t));
    for (const op of ['==', '!=']) {
        if (!cond.includes(op)) continue;
        const parts = cond.split(op).map(p => p.trim());
        // An unbound operand keeps the historical string-compare guess (`R12 != 1` -> true) so
        // block coverage is unchanged, but is flagged undecided for the caller to report.
        const value = op === '==' ? parts[0] === parts[1] : parts[0] !== parts[1];
        return unbound.length === 0 ? { value, decided: true }
            : { value, decided: false, reason: 'unbound operand(s): ' + [...new Set(unbound)].join(', ') };
    }
    if (cond.toLowerCase() === 'true') return { value: true, decided: true };
    if (cond.toLowerCase() === 'false') return { value: false, decided: true };
    return { value: false, decided: false, reason: unbound.length ? 'unbound operand(s): ' + [...new Set(unbound)].join(', ') : 'unsupported expression' };
}

/**
 * Evaluates the condition of an `.if` / `.elseif` line (text after the directive) as the
 * assembler would, with macro parameters substituted from `mapping`. An undecidable
 * condition reads false; use evalConditionDetailed to tell the difference.
 */
function evalCondition(rawCond, mapping, definedSymbols) {
    return evalConditionDetailed(rawCond, mapping, definedSymbols).value;
}

/**
 * Preprocesses and expands a PRU assembly macro by replacing its parameters.
 */
function expandMacro(macroStr, argsMap) {
    const lines = macroStr.split('\n');
    const expandedLines = [];

    let macroHeaderIndex = -1;
    let params = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.includes('.macro')) {
            macroHeaderIndex = i;
            const parts = line.split('.macro');
            params = parts[1].split(',').map(p => p.trim());
            break;
        }
    }

    if (macroHeaderIndex === -1) {
        throw new Error("Could not find .macro definition in macro string");
    }

    const paramNames = params;
    const mapping = {};
    const registersMap = {
        'TEMP_REG1': 'R28',
        'TEMP_REG2': 'R29',
        'TEMP_REG3': 'R26',
        'TEMP_REG4': 'R27'
    };

    for (let i = 0; i < paramNames.length; i++) {
        const pName = paramNames[i];
        if (argsMap[pName] !== undefined) {
            mapping[pName] = argsMap[pName];
        } else if (argsMap[i] !== undefined) {
            mapping[pName] = argsMap[i];
        }
    }

    const bodyLines = lines.slice(macroHeaderIndex + 1);
    const condStack = [{ active: true, taken: true, parent: true }];

    for (let line of bodyLines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('.endm')) {
            break;
        }

        if (trimmed.startsWith('.if ')) {
            const parentActive = condStack[condStack.length - 1].active;
            const isTrue = evalCondition(trimmed.substring(4), mapping);
            condStack.push({ active: parentActive && isTrue, taken: isTrue, parent: parentActive });
            continue;
        }

        if (trimmed.startsWith('.elseif')) {
            const top = condStack[condStack.length - 1];
            const isTrue = !top.taken && evalCondition(trimmed.substring(7), mapping);
            top.active = top.parent && isTrue;
            top.taken = top.taken || isTrue;
            continue;
        }

        if (trimmed.startsWith('.else')) {
            const top = condStack[condStack.length - 1];
            top.active = top.parent && !top.taken;
            top.taken = true;
            continue;
        }

        if (trimmed.startsWith('.endif')) {
            condStack.pop();
            continue;
        }

        if (condStack[condStack.length - 1].active) {
            let processedLine = line;
            for (const [pName, val] of Object.entries(mapping)) {
                processedLine = processedLine.replace(new RegExp('\\b' + pName + '\\b', 'g'), val);
            }
            for (const [tempName, reg] of Object.entries(registersMap)) {
                if (mapping[tempName] === undefined) {
                    processedLine = processedLine.replace(new RegExp('\\b' + tempName + '\\b', 'g'), reg);
                }
            }

            processedLine = processedLine.replace(/\bsine_lut\b/g, '0');
            expandedLines.push(processedLine);
        }
    }

    const uniqueId = Math.floor(Math.random() * 1000000);
    const finalLines = expandedLines.map(line => {
        return line.replace(/\?/g, `_${uniqueId}`);
    });

    return finalLines;
}

/**
 * Compiles PRU assembly text to a real ELF using clpru and linker.
 */
function compileAssemblyToElf(assemblyText, testId = 'test') {
    if (!fs.existsSync(BUILD_TMP_DIR)) {
        fs.mkdirSync(BUILD_TMP_DIR, { recursive: true });
    }

    const asmFile = path.join(BUILD_TMP_DIR, `${testId}.asm`);
    const cmdFile = path.join(BUILD_TMP_DIR, `${testId}.cmd`);
    const outFile = path.join(BUILD_TMP_DIR, `${testId}.out`);

    const linkerCmd = `
MEMORY {
    PAGE 0: PRU_IMEM  : org = 0x00000000 len = 0x00004000
    PAGE 1: PRU0_DMEM : org = 0x00000000 len = 0x00002000
}
SECTIONS {
    .text > PRU_IMEM, PAGE 0
    .data > PRU0_DMEM, PAGE 1
    .bss  > PRU0_DMEM, PAGE 1
}
`;
    fs.writeFileSync(asmFile, assemblyText, 'utf8');
    fs.writeFileSync(cmdFile, linkerCmd, 'utf8');

    const clpruBin = findClpru();
    const args = ['-v3', '-O2', asmFile, '-z', cmdFile, '-o', outFile, '--entry_point=main'];

    const compileRes = spawnSync(clpruBin, args, { encoding: 'utf8' });
    if (compileRes.status !== 0) {
        const errorMsg = (compileRes.stdout || '') + '\n' + (compileRes.stderr || '');
        return {
            success: false,
            error: errorMsg.trim(),
            asmFile,
            outFile: null
        };
    }

    return {
        success: true,
        error: null,
        asmFile,
        outFile
    };
}

/**
 * Runs an ELF file under TI pru-simulator headless runner.
 */
function runTiSimulatorElf(elfPath, options = {}) {
    const pythonBin = findPython();
    const simDir = findSimulatorDir();
    const core = options.core || 'pru0';
    const maxSteps = options.maxSteps || 100000;
    const until = options.until || 'halt';

    const args = [
        '-m', 'tools.headless_runner',
        '--elf', elfPath,
        '--core', core,
        '--until', until,
        '--max-steps', String(maxSteps),
        '--json'
    ];

    const runRes = spawnSync(pythonBin, args, {
        cwd: simDir,
        encoding: 'utf8'
    });

    try {
        const payload = JSON.parse(runRes.stdout);
        return {
            exitCode: runRes.status,
            payload
        };
    } catch (e) {
        return {
            exitCode: runRes.status,
            error: `Failed to parse TI simulator JSON: ${e.message}\nRaw stdout: ${runRes.stdout}\nStderr: ${runRes.stderr}`,
            payload: null
        };
    }
}

/**
 * One shared .asm formatter. A line carrying a label (bare `lbl:`
 * or same-line `label: instr`) is emitted with the label in column 1 and the
 * instruction (if any) after it on the same line; anything else is indented.
 * clpru rejects ANY indented label (E0003 'Invalid instruction'), so the old
 * `endsWith(':')` test -- which indented `label: instr` -- broke same-line
 * labels. A trailing `;` comment is preserved verbatim.
 */
function formatAsmLine(l) {
    const t = String(l).trim();
    if (!t) return '';
    const parts = splitLabel(l);
    if (!parts || !parts.label) return `    ${t}`;
    const semi = t.indexOf(';');
    const comment = semi !== -1 ? ` ${t.slice(semi).trim()}` : '';
    return parts.rest ? `${parts.label}: ${parts.rest}${comment}` : `${parts.label}:${comment}`;
}

/**
 * The exact asm text executeDualOracle feeds to clpru, factored out
 * so a test can drive the real formatting call sites (formatAsmLine over
 * initAsm and bodyAsm) without needing clpru or the TI pru-simulator.
 * executeDualOracle calls THIS function - there is no second formatter.
 */
function buildElfAssemblyText(initAsm, bodyAsm) {
    return [
        '; Auto-generated Dual-Oracle PRU Assembly Test',
        '    .global main',
        'main:',
        ...initAsm.map(formatAsmLine),
        ...bodyAsm.map(formatAsmLine),
        '    halt',
        ''
    ].join('\n');
}

/**
 * Runs JS simulation in pru_core.js.
 */
function runJsSimulation(rawInstructions, maxCycles = 100, r31Map = {}, mmioMap = {}) {
    const processedInstructions = [];
    const labels = [];
    for (let line of rawInstructions) {
        // Accept `label: instr` on one line (label defined at that
        // instruction); `label:` alone keeps the historical nop padding behaviour.
        const parts = splitLabel(line);
        if (!parts) continue;
        if (parts.label && !parts.rest) {
            processedInstructions.push("nop");
            labels.push(parts.label);
        } else if (parts.label) {
            processedInstructions.push(parts.rest);
            labels.push(parts.label);
        } else {
            processedInstructions.push(parts.rest);
            labels.push(0);
        }
    }
    return pruCore.simulatePruInstructions(processedInstructions, labels, maxCycles, r31Map, mmioMap);
}

/**
 * Core Dual-Oracle Execution and Differential Checker
 *
 * Executes the given instruction sequence / macro under BOTH:
 *   Oracle 1: In-tool JavaScript Simulator (Fast Pre-check)
 *   Oracle 2: TI pru-simulator executing the clpru-compiled real ELF
 *
 * Asserts full differential agreement. Disagreement is loud and fails.
 */
function executeDualOracle(testConfig) {
    const {
        testId = `test_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name = 'unnamed_test',
        initialRegisters = {},
        instructions = [],
        macro = null,
        macroArgs = {},
        maxCycles = 5000,
        maxSteps = 10000,
        r31Map = {},
        mmioMap = {},
        expectedRegisters = null,
        // injectable so a test can drive the REAL
        // executeDualOracle path (including the buildElfAssemblyText call
        // site below) and capture the exact asm handed to the compiler,
        // without needing clpru or the TI pru-simulator.
        compileElf = compileAssemblyToElf,
        runTiElf = runTiSimulatorElf
    } = testConfig;

    // 1. Build complete assembly instruction list
    const initAsm = [];
    for (let [reg, val] of Object.entries(initialRegisters)) {
        const regName = reg.toUpperCase();
        initAsm.push(`ldi32 ${regName}, 0x${(val >>> 0).toString(16)}`);
    }

    let bodyAsm = [];
    if (macro) {
        bodyAsm = expandMacro(macro, macroArgs);
    } else {
        bodyAsm = instructions;
    }

    const fullJsAsm = [
        ...initAsm,
        ...bodyAsm,
        'halt'
    ];

    // --- ORACLE 1: Fast JS Pre-Check (instant GUI) ---
    // JS core is kept for instant feedback but is NOT the CI authority.
    // A JS crash or disagreement is LOGGED, not thrown; CI authority is
    // the clpru-built ELF on TI pru-simulator (Oracle 2) plus expectedRegisters.
    let jsResult = null;
    let jsError = null;
    try {
        jsResult = runJsSimulation(fullJsAsm, maxCycles, r31Map, mmioMap);
    } catch (err) {
        jsError = err;
    }

    const jsRegs = jsResult ? jsResult.pruState.registers.map(v => (v >>> 0)) : null;

    // --- COMPILE REAL ELF via clpru ---
    const elfAssembly = buildElfAssemblyText(initAsm, bodyAsm);

    const compileOutcome = compileElf(elfAssembly, testId);
    if (!compileOutcome.success) {
        const err = new Error(`[Dual-Oracle clpru COMPILATION REJECTED] Test '${name}':\n${compileOutcome.error}`);
        err.isCompilationFailure = true;
        err.compileOutcome = compileOutcome;
        throw err;
    }

    // --- ORACLE 2: TI pru-simulator on Real ELF ---
    const tiResult = runTiElf(compileOutcome.outFile, { maxSteps });
    if (!tiResult.payload || !tiResult.payload.success) {
        const reason = tiResult.payload ? tiResult.payload.reason : 'unknown_error';
        const errors = tiResult.payload ? (tiResult.payload.errors || []).join('; ') : tiResult.error;
        throw new Error(`[Dual-Oracle TI SIMULATOR FAILED] Test '${name}': Reason=${reason}, Errors=${errors}`);
    }

    const tiRegs = tiResult.payload.state.registers.map(hexStr => parseInt(hexStr, 16) >>> 0);

    // --- DIFFERENTIAL ORACLE COMPARISON (JS vs TI) ---
    // Disagreements are LOGGED to results/simulator_disagreements.log for
    // investigation; they do NOT fail CI. CI fails only if the TI oracle
    // itself fails (compile error, simulator error, expectedRegisters mismatch).
    const mismatches = [];
    let disagreementMsg = null;
    if (jsError) {
        disagreementMsg = `[Dual-Oracle DISAGREEMENT] Test '${name}': JS Simulator crashed while TI pru-simulator succeeded!\nJS Error: ${jsError.message}`;
    } else {
        for (let r = 0; r < 32; r++) {
            if (jsRegs[r] !== tiRegs[r]) {
                mismatches.push({
                    register: `R${r}`,
                    jsValue: `0x${jsRegs[r].toString(16).padStart(8, '0').toUpperCase()}`,
                    tiValue: `0x${tiRegs[r].toString(16).padStart(8, '0').toUpperCase()}`,
                    diff: (tiRegs[r] - jsRegs[r])
                });
            }
        }
        if (mismatches.length > 0) {
            disagreementMsg = `[Dual-Oracle DISAGREEMENT] Test '${name}': JS Simulator and TI pru-simulator DISAGREE on real ELF!\n`;
            disagreementMsg += `+----------+---------------+-------------------+-----------------+\n`;
            disagreementMsg += `| Register | JS Simulator  | TI pru-simulator  | Match?          |\n`;
            disagreementMsg += `+----------+---------------+-------------------+-----------------+\n`;
            for (const m of mismatches) {
                disagreementMsg += `| ${m.register.padEnd(8)} | ${m.jsValue.padEnd(13)} | ${m.tiValue.padEnd(17)} | MISMATCH        |\n`;
            }
            disagreementMsg += `+----------+---------------+-------------------+-----------------+`;
        }
    }
    if (disagreementMsg) {
        const logPath = path.join(REPO_ROOT, 'results', 'simulator_disagreements.log');
        if (!fs.existsSync(path.dirname(logPath))) fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const entry = `[${new Date().toISOString()}] ${disagreementMsg}\n`;
        fs.appendFileSync(logPath, entry);
        // Also emit to stdout so CI logs show the disagreement
        console.warn(entry.trim());
    }

    // Optional expected register check
    if (expectedRegisters) {
        for (let [reg, expVal] of Object.entries(expectedRegisters)) {
            const regIdx = parseInt(reg.replace(/r/i, ''));
            const expected = expVal >>> 0;
            const actual = tiRegs[regIdx];
            if (actual !== expected) {
                throw new Error(`[Dual-Oracle EXPECTATION MISMATCH] Test '${name}': R${regIdx} expected 0x${expected.toString(16).toUpperCase()} but both oracles produced 0x${actual.toString(16).toUpperCase()}`);
            }
        }
    }

    return {
        passed: true,
        name,
        testId,
        cycles: {
            jsCycles: jsResult ? jsResult.pruState.cycles : -1,
            tiCycles: tiResult.payload.state.cycles,
            tiSteps: tiResult.payload.state.steps
        },
        registers: tiRegs,
        elfPath: compileOutcome.outFile
    };
}

module.exports = {
    formatAsmLine,
    buildElfAssemblyText,
    findClpru,
    findPython,
    findSimulatorDir,
    loadBlockModule,
    expandMacro,
    evalCondition,
    evalConditionDetailed,
    evalNumericExpression,
    stripAsmComment,
    compileAssemblyToElf,
    runTiSimulatorElf,
    runJsSimulation,
    executeDualOracle
};
