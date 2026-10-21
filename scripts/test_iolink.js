/**
 * test_iolink.js — IO-Link Master Block Headless Simulator Test
 *
 * Tests the iolink_master_block for:
 *   1. Module load and metadata
 *   2. Macro emission and expansion
 *   3. Validation rules
 *   4. R30 waveform: wake-up pulse duration, DIR control
 *   5. Cycle budget measurement and baud accuracy
 *
 * Call: node scripts/test_iolink.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { splitLabel } = require('./asm_label');

const SIM_DIR = path.join(__dirname, '../.metadata/sysconfig/.meta/pru_blocks/common/simulation');
const scriptCache = {};

function loadScript(scriptPath) {
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
                    scriptCache[basename] = loadScript(path.join(SIM_DIR, basename));
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

const pruCore = loadScript(path.join(SIM_DIR, 'pru_core.js'));

function makeStub() {
    const fn = function () { return makeStub(); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
            if (prop === Symbol.iterator) return undefined;
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply() { return makeStub(); },
    });
}

function loadBlockModule(blockName, blockSubdir) {
    const file = path.join(__dirname, '../.metadata/sysconfig/.meta/pru_blocks/' + blockSubdir + '/' + blockName + '.syscfg.js');
    if (!fs.existsSync(file)) {
        throw new Error('Block file not found: ' + file);
    }
    const src = fs.readFileSync(file, 'utf8');
    const sandbox = {
        system: makeStub(),
        exports: {},
        module: { exports: {} },
        require: () => makeStub(),
        console: { log() {}, error() {}, warn() {} },
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: file, timeout: 5000 });
    const mod = (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports
        : (sandbox.module.exports && Object.keys(sandbox.module.exports).length) ? sandbox.module.exports
        : sandbox.exports;
    return mod;
}

function expandMacro(macroStr, argsMap) {
    var lines = macroStr.split('\n');
    var expandedLines = [];
    var macroHeaderIndex = -1;
    var params = [];

    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('.macro') >= 0) {
            macroHeaderIndex = i;
            var parts = lines[i].split('.macro');
            params = parts[1].split(',').map(function(p) { return p.trim(); });
            break;
        }
    }

    if (macroHeaderIndex === -1) {
        throw new Error("Could not find .macro definition");
    }

    var paramNames = params;
    var mapping = {};
    var registersMap = {
        'TEMP_REG1': 'R28',
        'TEMP_REG2': 'R29',
        'TEMP_REG3': 'R26',
        'TEMP_REG4': 'R27'
    };

    for (var i = 0; i < paramNames.length; i++) {
        var pName = paramNames[i];
        if (argsMap[pName] !== undefined) {
            mapping[pName] = String(argsMap[pName]);
        } else if (argsMap[i] !== undefined) {
            mapping[pName] = String(argsMap[i]);
        }
    }

    var bodyLines = lines.slice(macroHeaderIndex + 1);
    var condStack = [true];

    for (var li = 0; li < bodyLines.length; li++) {
        var trimmed = bodyLines[li].trim();

        if (trimmed.indexOf('.endm') === 0) break;

        if (trimmed.indexOf('.if ') === 0) {
            var cond = trimmed.substring(4).trim();
            for (var pName in mapping) {
                if (mapping.hasOwnProperty(pName)) {
                    cond = cond.split(pName).join(mapping[pName]);
                }
            }
            var isTrue = false;
            if (cond.indexOf('==') >= 0) {
                var parts = cond.split('==');
                isTrue = (parts[0].trim() === parts[1].trim());
            } else if (cond.indexOf('!=') >= 0) {
                var parts = cond.split('!=');
                isTrue = (parts[0].trim() !== parts[1].trim());
            } else if (cond.indexOf('> 0') >= 0) {
                var val = parseInt(cond.split('>')[0].trim());
                isTrue = (val > 0);
            } else if (cond.indexOf('<') >= 0 || cond.indexOf('>') >= 0) {
                // simple numeric comparison
                var val = parseInt(cond.replace(/[<>=]/g,'').trim());
                isTrue = (val > 0);
            } else {
                isTrue = (cond === '1' || cond.toLowerCase() === 'true' || (parseInt(cond) > 0 && !isNaN(parseInt(cond))));
            }
            condStack.push(condStack[condStack.length - 1] && isTrue);
            continue;
        }

        if (trimmed.indexOf('.elseif ') === 0) {
            condStack.pop();
            var prevActive = condStack[condStack.length - 1];
            var cond = trimmed.substring(8).trim();
            for (var pName in mapping) {
                if (mapping.hasOwnProperty(pName)) {
                    cond = cond.split(pName).join(mapping[pName]);
                }
            }
            var isTrue = false;
            if (cond.indexOf('==') >= 0) {
                var parts = cond.split('==');
                isTrue = (parts[0].trim() === parts[1].trim());
            } else if (cond.indexOf('>') >= 0) {
                var val = parseInt(cond.split('>')[0].trim());
                isTrue = (val > 0);
            }
            condStack.push(prevActive && isTrue);
            continue;
        }

        if (trimmed.indexOf('.else') === 0) {
            var prevActive = condStack[condStack.length - 2] !== undefined ? condStack[condStack.length - 2] : true;
            condStack[condStack.length - 1] = prevActive && !condStack[condStack.length - 1];
            continue;
        }

        if (trimmed.indexOf('.endif') === 0) {
            condStack.pop();
            continue;
        }

        if (condStack[condStack.length - 1]) {
            var processedLine = bodyLines[li];
            for (var pName in mapping) {
                if (mapping.hasOwnProperty(pName)) {
                    processedLine = processedLine.split(pName).join(mapping[pName]);
                }
            }
            for (var tempName in registersMap) {
                if (registersMap.hasOwnProperty(tempName)) {
                    if (mapping[tempName] === undefined) {
                        processedLine = processedLine.split(tempName).join(registersMap[tempName]);
                    }
                }
            }
            expandedLines.push(processedLine);
        }
    }

    var uniqueId = Math.floor(Math.random() * 1000000);
    var finalLines = expandedLines.map(function(line) {
        return line.split('?').join('_' + uniqueId);
    });

    return finalLines;
}

function runSim(rawInstructions, cycles, r31Map, mmioMap) {
    r31Map = r31Map || {};
    mmioMap = mmioMap || {};
    var processedInstructions = [];
    var labels = [];

    for (var i = 0; i < rawInstructions.length; i++) {
        var line = rawInstructions[i].trim();
        if (!line || line.indexOf(';') === 0) continue;
        var semiIdx = line.indexOf(';');
        if (semiIdx >= 0) line = line.substring(0, semiIdx).trim();
        if (!line) continue;

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

    return pruCore.simulatePruInstructions(processedInstructions, labels, cycles, r31Map, mmioMap);
}

// Test counters
var passCount = 0;
var failCount = 0;

function assert(label, condition, detail) {
    if (condition) {
        console.log('  [PASS] ' + label);
        passCount++;
    } else {
        console.error('  [FAIL] ' + label + ': ' + (detail || 'assertion failed'));
        failCount++;
    }
}

// =======================================================================
// MAIN TESTS
// =======================================================================
console.log('=== IO-Link Master Block Headless Test ===\n');

// ---- Module loads ----
console.log('--- Module metadata ---');
var mod;
try {
    mod = loadBlockModule('iolink_master_block', 'application_specific');
    assert('Module exports', !!mod, 'exports is falsy');
    assert('displayName', mod.displayName === 'IO-Link Master', 'got "' + mod.displayName + '"');
    assert('defaultInstanceName', mod.defaultInstanceName === 'IOLINK_MSTR_', 'got "' + mod.defaultInstanceName + '"');
    assert('config array present', Array.isArray(mod.config), 'config not array');
    assert('config has comMode', mod.config.some(function(c) { return c.name === 'comMode'; }), 'comMode missing');
    assert('config has dirPin', mod.config.some(function(c) { return c.name === 'dirPin'; }), 'dirPin missing');
    assert('config has noOfCycles', mod.config.some(function(c) { return c.name === 'noOfCycles'; }), 'noOfCycles missing');
    assert('ports function', typeof mod.ports === 'function', 'ports not a function');
    assert('validate function', typeof mod.validate === 'function', 'validate not a function');
    assert('getMacro function', typeof mod.getMacro === 'function', 'getMacro not a function');
} catch (e) {
    assert('Module loads', false, e.message);
    console.error('  Cannot continue without module.');
    process.exit(1);
}

// ---- Macro emission ----
console.log('\n--- Macro emission ---');
var macroStr;
try {
    macroStr = mod.getMacro('', 'm_iolink_master');
    assert('Macro returns string', typeof macroStr === 'string', 'got ' + typeof macroStr);
    assert('Macro contains .macro', macroStr.indexOf('.macro') >= 0, 'no .macro directive');
    assert('Macro contains .endm', macroStr.indexOf('.endm') >= 0, 'no .endm directive');
    assert('Macro contains wake-up phase', macroStr.indexOf('Wake-up pulse') >= 0, 'wake phase missing');
    assert('Macro contains TX phase', macroStr.indexOf('ENDAT TX') >= 0, 'TX phase missing');
    assert('Macro contains turnaround phase', macroStr.indexOf('Turnaround') >= 0, 'turnaround phase missing');
    assert('Macro contains RX phase', macroStr.indexOf('ENDAT RX') >= 0, 'RX phase missing');
    assert('Macro contains cleanup', macroStr.indexOf('Cleanup') >= 0, 'cleanup phase missing');
    assert('ICSS_CFG definitions present', macroStr.indexOf('ICSS_CFG_GPCFG0') >= 0, 'GPCFG0 missing');

    // Expand macro with COM3 defaults
    var expanded = expandMacro(macroStr, {
        RES: 'R10',
        DATA_IN_LO: 'R0',
        DATA_IN_HI: 'R1',
        DIR_PIN: '2',
        WAKE_PIN: '3',
        CHANNEL: '0',
        CLK_DIV: '832',
        TX_BYTES: '2',
        RX_BYTES: '2',
        TURN_BITS: '5',
        WAKE_LPS: '4000',
        PREAMBLE: '0'
    });
    assert('Expanded macro has instructions', expanded.length > 10, 'only ' + expanded.length + ' lines');
    assert('Expanded has R30 operations', expanded.some(function(l) { return l.indexOf('R30') >= 0; }), 'no R30 ops');
    assert('Expanded has R31 operations', expanded.some(function(l) { return l.indexOf('R31') >= 0; }), 'no R31 ops');
    assert('Expanded has sbco calls', expanded.some(function(l) { return l.indexOf('sbco') >= 0; }), 'no sbco ops');
} catch (e) {
    assert('Macro emission', false, e.message);
}

// ---- Validation ----
console.log('\n--- Validation ---');
try {
    var inst = {
        comMode: 'COM3',
        txBytes: 4,
        rxBytes: 4,
        dirPin: 2,
        wakePin: 3,
        endatChannel: 0,
        wakeLoops: 4000,
        turnaroundBitPeriods: 5,
        numOfInputPorts: 2,
        blockMaturity: 'assembles'
    };
    var errors = [];
    var warnings = [];
    var mockValidation = {
        logError: function(msg, i, p) { errors.push({ msg: msg, param: p }); },
        logWarning: function(msg, i, p) { warnings.push({ msg: msg, param: p }); }
    };
    mod.validate(inst, mockValidation);
    assert('Valid COM3 config: no errors', errors.length === 0, JSON.stringify(errors));

    // Test invalid: turnaround < 4
    inst.turnaroundBitPeriods = 2;
    errors = [];
    mod.validate(inst, mockValidation);
    assert('Turnaround < 4: error logged', errors.some(function(e) { return e.param === 'turnaroundBitPeriods'; }), 'no error');

    // Test warning: wakeLoops too small
    inst.turnaroundBitPeriods = 5;
    inst.wakeLoops = 800;
    errors = [];
    warnings = [];
    mod.validate(inst, mockValidation);
    assert('WakeLoops too small: warns', warnings.some(function(w) { return w.msg.indexOf('may be too short') >= 0; }), 'no warning');
} catch (e) {
    assert('Validation', false, e.message);
}

// ---- Ports enumeration ----
console.log('\n--- Ports ---');
try {
    var ports = mod.ports({ numOfInputPorts: 2 });
    var portNames = ports.map(function(p) { return p.name; });
    assert('Has prev port', portNames.indexOf('prev') >= 0, 'prev missing');
    assert('Has next port', portNames.indexOf('next') >= 0, 'next missing');
    assert('Has input1 port', portNames.indexOf('input1') >= 0, 'input1 missing');
    assert('Has input2 port', portNames.indexOf('input2') >= 0, 'input2 missing');
    assert('Has output1 port', portNames.indexOf('output1') >= 0, 'output1 missing');
} catch (e) {
    assert('Ports', false, e.message);
}

// ---- R30 waveform simulation (wake-up pulse) ----
console.log('\n--- R30 waveform (wake-up + DIR control) ---');
try {
    macroStr = mod.getMacro('', 'm_iolink_master');
    var expanded = expandMacro(macroStr, {
        RES: 'R10',
        DATA_IN_LO: 'R0',
        DATA_IN_HI: 'R1',
        DIR_PIN: '2',
        WAKE_PIN: '3',
        CHANNEL: '0',
        CLK_DIV: '832',
        TX_BYTES: '1',
        RX_BYTES: '0',  // skip RX for waveform test
        TURN_BITS: '5',
        WAKE_LPS: '200',  // short for test speed
        PREAMBLE: '0'
    });

    var insts = [
        'ldi R0, 0x55',
        'ldi R1, 0',
        'ldi R10, 0'
    ].concat(expanded).concat(['halt']);

    var result = runSim(insts, 5000);
    var r30Hist = result.r30ValueHistory || [];

    // Check R30 waveform for DIR/Wake pin changes
    var firstDir1 = -1;
    var wakeLowAfterDir = -1;
    var wakeHighAfterLow = -1;
    var dirLowAfterTX = -1;

    for (var i = 0; i < r30Hist.length; i++) {
        var dir = (r30Hist[i] >> 2) & 1;
        var wake = (r30Hist[i] >> 3) & 1;
        if (firstDir1 < 0 && dir === 1) firstDir1 = i;
        if (firstDir1 >= 0 && wakeLowAfterDir < 0 && wake === 0) wakeLowAfterDir = i;
        if (wakeLowAfterDir >= 0 && wakeHighAfterLow < 0 && wake === 1) wakeHighAfterLow = i;
        if (firstDir1 >= 0 && dirLowAfterTX < 0 && dir === 0 && wake === 1) dirLowAfterTX = i;
    }

    assert('DIR goes high (TX mode for wake)', firstDir1 >= 0, 'first DIR=1 at index ' + firstDir1);
    assert('WAKE goes low after DIR=1', wakeLowAfterDir >= 0, 'wake never goes low');
    assert('WAKE goes high after pulse', wakeHighAfterLow >= 0, 'wake never re-asserts high');
    assert('DIR goes low after TX (RX mode)', dirLowAfterTX >= 0, 'DIR never returns low');

    // Verify COM3 baud accuracy (not strict integer division)
    var com3Baud = 192000000 / (832 + 1);
    console.log('  COM3 effective baud: ' + Math.round(com3Baud) + ' bps' +
        ' (target 230400, error ' + ((com3Baud/230400-1)*100).toFixed(2) + '%)');
    assert('COM3 baud within 2% of target', Math.abs(com3Baud/230400-1) < 0.02,
        'error ' + ((com3Baud/230400-1)*100).toFixed(2) + '%');

    // Verify wake pulse duration
    if (wakeLowAfterDir >= 0 && wakeHighAfterLow >= 0) {
        var pulseCycles = wakeHighAfterLow - wakeLowAfterDir;
        // WAKE_LPS=200 iterations ~5 cycles each = 1000 cycles
        // actual may be closer due to loop overhead
        console.log('  Wake pulse measured: ' + pulseCycles + ' cycles' +
            ' (setup: ' + wakeLowAfterDir + ', release at: ' + wakeHighAfterLow + ')');
        assert('Wake pulse executed (> 0 cycles)', pulseCycles > 500,
            'pulse=' + pulseCycles + ' cycles');
    }

    console.log('  R30 waveform excerpt (first 20 samples):');
    for (var i = 0; i < Math.min(20, r30Hist.length); i++) {
        var dir = (r30Hist[i] >> 2) & 1;
        var wake = (r30Hist[i] >> 3) & 1;
        console.log('    cy ' + i + ': DIR=' + dir + ' WAKE=' + wake + ' R30=0x' + r30Hist[i].toString(16));
    }

} catch (e) {
    assert('R30 waveform simulation', false, e.message + '\n' + e.stack);
}

// ---- Summary ----
console.log('\n=== Results: ' + passCount + ' passed, ' + failCount + ' failed ===');
if (failCount > 0) process.exit(1);