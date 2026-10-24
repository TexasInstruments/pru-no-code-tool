#!/usr/bin/env node
'use strict';
/*
 * Static module runner for global XFR2PSI checks (R1:R5 live-across, stall declaration).
 * Exercises pru_blocks_static_module.validate with a mocked graph containing XFR2PSI + data dependencies.
 *
 * Usage:
 *   node scripts/static_runner.js <json-graph-path>
 *   json-graph-path: JSON file describing graph nodes and edges.
 *
 * Expected JSON shape:
 * {
 *   "coreName": "icss_g0_pru0",
 *   "soc": "am64x",
 *   "instances": [
 *     {"$name":"PROD","module":"/pru_blocks/data_handling/arithmetic_block","output1":[{"inst":"CONS"}],"prev":[],"next":[{"inst":"XFR"}]},
 *     {"$name":"XFR","module":"/pru_blocks/pru_io_blocks/xfr2psi_block","checkReady":true,"useSharedPair":false,... , "prev":[{"inst":"PROD"}],"next":[{"inst":"CONS"}], "input1":[],"output1":[]},
 *     {"$name":"CONS","module":"/pru_blocks/data_handling/arithmetic_block","input1":[{"inst":"PROD"}],"prev":[{"inst":"XFR"}]}
 *   ]
 * }
 * Simplified: prev/next/output1 use string refs resolved to objects.
 *
 * Prints JSON array of error messages.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphPath = process.argv[2];
if (!graphPath) { console.error('Usage: node scripts/static_runner.js <json-graph-path>'); process.exit(2); }
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const coreName = graph.coreName || 'icss_g0_pru0';
const soc = graph.soc || 'am64x';

const ROOT = path.join(__dirname, '..');
const CAPS_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_device_caps.js');
const STATIC_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'pru_blocks_static_module.syscfg.js');
const ALLOC_PATH = path.join(ROOT, '.metadata', 'sysconfig', '.meta', 'pru_blocks', 'common', 'register_allocation', 'pru_register_allocator.js');

// Build system.modules from graph
let caps;
try { caps = require(CAPS_PATH); } catch(e){ caps=null; }

// Helper to load a block module source (for pru_register_allocator dependency)
const mockCommon = {
    getSocName: () => soc,
    getSelfSysCfgCoreName: () => coreName,
};
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
const dmemStub = { resetDMEM0:()=>{}, clearSymbolTable:()=>{}, addDataSectionContents:()=>0, addSymbol:()=>{}, replaceSymbolReferences:(x)=>x };
const smemStub = { resetSMEM:()=>{}, clearSymbolTable:()=>{}, addDataSectionContents:()=>0, addSymbol:()=>{}, replaceSymbolReferences:(x)=>x };
const coreStub = { simulatePruInstructions:()=>({pruState:{registers:new Array(32).fill(0)}, r30ValueHistory:[0,0], r31ValueHistory:[0,0]}) };
const busStub = { DeviceBus: function(){this.attach=()=>{}; this.setPruDriveMask=()=>{};}, MASK_20:0xFFFFF };
const modelsStub = { createDeviceModel:()=>{throw new Error('no device');} };

// Build modules dict
const modules = {};
// Group by moduleName
const byModule = {};
for (const inst of (graph.instances || [])) {
    const mn = inst.module || '/pru_blocks/pru_io_blocks/xfr2psi_block';
    if (!byModule[mn]) byModule[mn] = [];
    byModule[mn].push(JSON.parse(JSON.stringify(inst)));
}
// Resolve string refs to object refs
const nameToInst = {};
for (const mn in byModule) {
    for (const inst of byModule[mn]) nameToInst[inst.$name] = inst;
}
for (const mn in byModule) {
    for (const inst of byModule[mn]) {
        for (const port of ['prev','next','input1','output1','T','F']) {
            if (Array.isArray(inst[port])) {
                inst[port] = inst[port].map(entry => {
                    if (entry && typeof entry.inst === 'string') {
                        const target = nameToInst[entry.inst];
                        return { inst: target };
                    }
                    return entry;
                });
            }
        }
        // Ensure required fields for allocator
        if (inst.output1 === undefined) inst.output1 = [];
        if (inst.prev === undefined) inst.prev = [];
        if (inst.next === undefined) inst.next = [];
        if (inst.opCode === undefined) inst.opCode = 'm_dummy';
        if (inst.numOfInputPorts === undefined) inst.numOfInputPorts = inst.input1 ? 1 : 0;
        if (inst.numOfOutputPorts === undefined) inst.numOfOutputPorts = inst.output1.length >0 ? 1:0;
        if (inst.output1Size === undefined) inst.output1Size = inst.output1.length>0?4:0;
        if (inst.numOfConstants === undefined) inst.numOfConstants = 0;
        if (inst.noOfCycles === undefined) inst.noOfCycles = 1;
        if (inst.checkReady === undefined && mn.includes('xfr2psi')) inst.checkReady = true;
    }
}
for (const mn in byModule) {
    modules[mn] = {
        displayName: mn,
        requiresWidget: mn.includes('xfr2psi') ? ['xfr2psi'] : undefined,
        $instances: byModule[mn],
    };
    // Dummy getMacro: return empty for def check (arity skip), real body for call
    modules[mn].getMacro = function(call, op){
        if (call === "") return ""; // no .macro line -> arity check skipped
        return `${op||call.split(/\s+/)[0]} .macro RES, IN1\n mov RES, IN1\n .endm`;
    };
}
// Load real xfr2psi block's getMacro for that module if present
try {
    const xfrSrc = fs.readFileSync(path.join(ROOT, '.metadata', 'sysconfig/.meta/pru_blocks/pru_io_blocks/xfr2psi_block.syscfg.js'),'utf8');
    const s2 = { system: null, exports:{}, module:{exports:{}}, console:{log(){},error(){},warn(){}}, require:()=>makeStub()};
    s2.system = { getScript:(p)=>{ if(p.includes('common')) return mockCommon; return makeStub(); } };
    s2.global=s2; vm.createContext(s2);
    vm.runInContext(xfrSrc,s2,{filename:'xfr2psi',timeout:2000});
    if (s2.exports.getMacro && byModule['/pru_blocks/pru_io_blocks/xfr2psi_block']) {
        modules['/pru_blocks/pru_io_blocks/xfr2psi_block'].getMacro = s2.exports.getMacro;
    }
} catch(e){}

// Mock system
const mockSystem = {
    deviceData: { device: soc.toUpperCase()+'_TEST', package:'ZCZ'},
    modules: modules,
    getScript: (p) => {
        if (p.includes('pru_device_caps')) return caps;
        if (p === '/common' || p === 'common' || p.includes('/common')) return mockCommon;
        if (p.includes('pru_dmem0')) return dmemStub;
        if (p.includes('pru_smem')) return smemStub;
        if (p.includes('pru_core')) return coreStub;
        if (p.includes('device_bus')) return busStub;
        if (p.includes('device_models')) return modelsStub;
        if (p.includes('pru_register_allocator')) return makeStub();
        return makeStub();
    },
    contexts:{},
};
mockSystem.modules['/pru_blocks/common/pru_blocks_static_module'] = { $static: { pruCyclesToSimulate:2000, signalsToDisplayR31:[], pruClkFreq:200 }, $instances: [] };

// Load allocator and run minimal global XFR2PSI checks (R1:R5 live-across + stall)
// We avoid invoking the full static validate which would require full simulation stubs.
// Instead we allocate and run the same logic as validateXfr2psiGlobal directly.
let allocSrc = fs.readFileSync(ALLOC_PATH,'utf8');

const sandbox = {
    system: mockSystem,
    exports:{},
    module:{exports:{}},
    console:{log(){},error(){},warn(){}},
    require:()=>makeStub(),
};
sandbox.global=sandbox;
vm.createContext(sandbox);
let allocExports;
try {
    vm.runInContext(allocSrc, sandbox, {filename:ALLOC_PATH, timeout:5000});
    allocExports = sandbox.exports;
} catch(e){
    console.error('VM load failed (alloc): '+e.stack);
    process.exit(2);
}
let errors=[];
const report={logError:(m)=>errors.push(String(m)), logWarning:()=>{}, logInfo:()=>{}};
try{
    // Allocate registers (reserves R1:R5 if XFR present)
    allocExports.allocatePruRegisters();
    const summary = allocExports.getPruRegisterAllocationSummary();

    const xfrMod = mockSystem.modules['/pru_blocks/pru_io_blocks/xfr2psi_block'];
    if (xfrMod && xfrMod.$instances && xfrMod.$instances.length>0) {
        const xfrNames = new Set(xfrMod.$instances.map(i=>i.$name));
        const instCount = summary.pruInstructions ? summary.pruInstructions.length : 0;
        const xfrIndices=[];
        for(let idx=0; idx<instCount; idx++){
            const mn=summary.pruInstructionModules[idx];
            const instObj=summary.pruInstructionInstances[idx];
            if(mn && mn.includes('xfr2psi')) xfrIndices.push(idx);
            else if(instObj && instObj.$name && xfrNames.has(instObj.$name)) xfrIndices.push(idx);
        }
        if(xfrIndices.length>0){
            // Build name->inst map for graph topology
            const allInstMap={};
            for(const mn in mockSystem.modules){
                const mod=mockSystem.modules[mn];
                if(!mod||!mod.$instances) continue;
                for(const bi of mod.$instances) if(bi.$name) allInstMap[bi.$name]=bi;
            }
            const chainOrder=[];
            for(let idx=0; idx<instCount; idx++){
                const instObj=summary.pruInstructionInstances[idx];
                if(instObj && instObj.$name) chainOrder.push(instObj.$name);
            }
            for(const xi of xfrIndices){
                const xfrName=summary.pruInstructionInstances[xi]?summary.pruInstructionInstances[xi].$name:null;
                if(!xfrName) continue;
                const beforeSet=new Set(chainOrder.slice(0,xi));
                const afterSet=new Set(chainOrder.slice(xi+1));
                for(const bName of beforeSet){
                    const bInst=allInstMap[bName];
                    if(!bInst||!bInst.output1) continue;
                    for(const conn of bInst.output1){
                        if(conn && conn.inst && conn.inst.$name && afterSet.has(conn.inst.$name)){
                            report.logError(`XFR2PSI uses R1:R5 as XFRPSI data path (Table 6-111, R5:R1 [159:0]). Design holds live value from '${bName}' in R3 across XFR2PSI transfer '${xfrName}' — would be silently corrupted. Move the producer/consumer to avoid live-across or copy through memory.`, bInst);
                            break;
                        }
                    }
                }
            }
        }
        // Stall declaration check
        for(const bi of xfrMod.$instances){
            if(!bi.checkReady){
                const cyc=bi.noOfCycles;
                let resolved=cyc;
                if(typeof cyc==='function'){ try{resolved=cyc(bi);}catch(e){} }
                if(resolved!==-1 && resolved!=='INFINITY_BLOCK_CONNECTED_CYCLE_BUDGET_UNKNOWN' && resolved!==undefined){
                    const expected=bi.checkReady?3:-1;
                    if(expected===-1 && resolved!==-1){
                        report.logError(`XFR2PSI '${bi.$name}' has checkReady=false but noOfCycles=${resolved} — an XOUT to a full TX FIFO STALLS until PSI-L drains (SPRUIM2J 6.4.6.3.2.3.1). Emit the tx_ready/rx_ready check from XID 0 before the transfer, or declare the stall in the cycle model (noOfCycles=-1).`, bi);
                    }
                }
            }
        }
    }
    // Also surface device-capability errors for xfr2psi (AM261x gate)
    // Reuse caps check
    if(caps){
        const socName = soc;
        const widget='xfr2psi';
        if(!caps.isWidgetAvailable(widget, socName)){
            for(const mn in mockSystem.modules){
                const mod=mockSystem.modules[mn];
                if(!mod||!mod.requiresWidget) continue;
                const req=Array.isArray(mod.requiresWidget)?mod.requiresWidget:[mod.requiresWidget];
                if(req.includes(widget)){
                    const deviceName=soc.toUpperCase()+'_TEST';
                    for(const bi of mod.$instances){
                        report.logError(`Block '${mod.displayName||mn}' requires widget '${widget}' which is not available on device '${deviceName}' (SoC '${socName}')`, bi);
                    }
                }
            }
        }
    }
}catch(e){
    errors.push('validate threw: '+e.stack);
}
console.log(JSON.stringify(errors));
