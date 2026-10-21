#!/usr/bin/env node
/**
 * headless test: safety dual-channel monitor block.
 * Verifies the macro assembles (via pru_core) and that static
 * pin levels are classified correctly (SAFE vs TRIP vs DISC).
 * Dynamic OSSD pulse width vs discrepancy is proven via the
 * Python oracle; here we just ensure the firmware loop is
 * not vacuously passing (red tests).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { splitLabel } = require('../asm_label');

const SIM_DIR = path.join(__dirname, '..', '..', '.metadata/sysconfig/.meta/pru_blocks/common/simulation');
function loadScript(p) {
    const code = fs.readFileSync(p, 'utf8');
    const sandbox = { console, Math, parseInt, isNaN, eval, Uint8Array, Array, JSON, system: { getScript: (q)=> { const b=path.basename(q); if(!cache[b]) cache[b]=loadScript(path.join(SIM_DIR,b)); return cache[b]; } }, exports:{} };
    vm.createContext(sandbox); vm.runInContext(code, sandbox); return sandbox.exports;
}
const cache={};
const pruCore = loadScript(path.join(SIM_DIR,'pru_core.js'));

function makeStub(){ const fn=function(){return makeStub();}; return new Proxy(fn,{ get(_t,p){ if(p===Symbol.toPrimitive||p==='toString'||p==='valueOf') return ()=>''; if(p===Symbol.iterator) return undefined; if(p==='then') return undefined; return makeStub(); }, apply(){return makeStub();}}); }
function loadBlock(blockName){
    const file = path.join(__dirname,'..','..',`.metadata/sysconfig/.meta/pru_blocks/pru_io_blocks/${blockName}.syscfg.js`);
    const src=fs.readFileSync(file,'utf8');
    const sandbox={ system: makeStub(), exports:{}, module:{exports:{}}, require:()=>makeStub(), console:{log(){},error(){},warn(){}} };
    sandbox.global=sandbox; vm.createContext(sandbox); vm.runInContext(src,sandbox,{filename:file, timeout:5000});
    return (sandbox.exports && Object.keys(sandbox.exports).length) ? sandbox.exports : sandbox.module.exports;
}

function expand(macro, argsMap){
    const lines = macro.split('\n'); let params=[]; let hdr=-1;
    for(let i=0;i<lines.length;i++){ if(lines[i].includes('.macro')){ hdr=i; params=lines[i].split('.macro')[1].split(',').map(p=>p.trim()); break; } }
    if(hdr===-1) throw new Error('no macro header');
    const mapping={}; for(let i=0;i<params.length;i++){ if(argsMap[params[i]]!==undefined) mapping[params[i]]=argsMap[params[i]]; }
    const regs={'TEMP_REG1':'R28','TEMP_REG2':'R29','TEMP_REG3':'R26','TEMP_REG4':'R27'};
    const body = lines.slice(hdr+1); const out=[]; const stack=[true];
    for(let line of body){
        const t=line.trim();
        if(t.startsWith('.endm')) break;
        if(t.startsWith('.if ')){ let cond=t.slice(4).trim(); for(const [k,v] of Object.entries(mapping)) cond=cond.replace(new RegExp('\\b'+k+'\\b','g'),v); let isTrue=false; if(cond.includes('==')){ const [a,b]=cond.split('==').map(s=>s.trim()); isTrue=(a===b);} else if(cond.includes('!=')){const [a,b]=cond.split('!=').map(s=>s.trim()); isTrue=(a!==b);} else isTrue=(cond==='1'); stack.push(stack[stack.length-1]&&isTrue); continue; }
        if(t.startsWith('.else')){ const p=stack[stack.length-2]??true; stack[stack.length-1]=p && !stack[stack.length-1]; continue; }
        if(t.startsWith('.endif')){ stack.pop(); continue; }
        if(stack[stack.length-1]){ let pl=line; for(const [k,v] of Object.entries(mapping)) pl=pl.replace(new RegExp('\\b'+k+'\\b','g'),v); for(const [k,v] of Object.entries(regs)) pl=pl.replace(new RegExp('\\b'+k+'\\b','g'),v); out.push(pl); }
    }
    const uid=Math.floor(Math.random()*1e6);
    return out.map(l=>l.replace(/\?/g,'_'+uid));
}
function runSim(raw, cycles, r31Map){
    const proc=[]; const labels=[];
    for(let line of raw){ const parts=splitLabel(line); if(!parts) continue; if(parts.label&&!parts.rest){ proc.push('nop'); labels.push(parts.label); } else if(parts.label){ proc.push(parts.rest); labels.push(parts.label); } else { proc.push(parts.rest); labels.push(0);} }
    return pruCore.simulatePruInstructions(proc, labels, cycles, r31Map||{}, {}, null);
}

const mod = loadBlock('safety_dual_monitor_block');
if(!mod.getMacro) { console.error('block has no getMacro'); process.exit(1); }
const macro = mod.getMacro('m_safety_dual_monitor');
console.log('Macro length', macro.length);
if(!macro.includes('TEMP_REG1') || !macro.includes('TEMP_REG2')){ console.error('missing 2-TEMP_REG'); process.exit(1); }
if(!macro.includes('NOT A CERTIFIED SAFETY FUNCTION')){ console.error('missing disclaimer'); process.exit(1); }

// Helper to run monitor with fixed R31 bits
function runMonitor(chAVal, chBVal, disc, ossdMax){
    const args={ RES:'R4', CH_A:'0', CH_B:'1', DISC_CYCLES:String(disc), OSSD_MAX:String(ossdMax) };
    const raw = expand(macro, args);
    // R31: bit0=chA, bit1=chB . 3=both high, 0=both low, 1=A high B low etc.
    const r31 = (chAVal?1:0) | (chBVal?2:0);
    // History: keep constant for enough cycles to let loops finish (500 cycles)
    const cycles = 800;
    const result = runSim(raw, cycles, {0: r31<<0}); // naive: single entry. Better to use map with cycle->word? pru_core expects map cycle->word? Check simulator interface: r31HistoryMap is object mapping ?. We'll just set constant via empty map and rely on default 0? Let's instead drive via repeated cycles using r31HistoryMap array? Actually pru_core simulatePruInstructions takes r31HistoryMap as {cycle:word}. We'll supply all cycles.
    // Quick hack: build map for every cycle
    const map={}; for(let i=0;i<cycles;i++) map[i]=r31;
    const r2 = runSim(raw, cycles, map);
    return r2.pruState.registers[4] & 0xFFFFFFFF;
}

// But runMonitor above redo is cleaner: we need map param correctly.
// Call with proper map
function runWithMap(chAVal,chBVal){
    const args={ RES:'R4', CH_A:'0', CH_B:'1', DISC_CYCLES:'50', OSSD_MAX:'40' };
    let raw = expand(macro, args);
    raw.push('halt');
    const word = (chAVal?1:0)|(chBVal?2:0);
    const cycles=3000;
    const map={}; for(let i=0;i<cycles;i++) map[i]=word;
    const res = runSim(raw, cycles, map);
    return res.pruState.registers[4] & 0xFF;
}

let ok=true;
function assertEq(label, actual, expected){
    if(actual!==expected){ console.error(`FAIL ${label}: got ${actual} expected ${expected}`); ok=false; }
    else console.log(`PASS ${label}: ${actual}`);
}

function runDynamic(sequence){
    const args={ RES:'R4', CH_A:'0', CH_B:'1', DISC_CYCLES:'50', OSSD_MAX:'40' };
    let raw = expand(macro, args);
    raw.push('halt');
    const cycles=3000;
    const map={}; let idx=0; let cur=sequence[0].word;
    let nextChange=sequence[0].untilCycle;
    for(let c=0;c<cycles;c++){
        if(c>=nextChange && idx+1<sequence.length){
            idx++; cur=sequence[idx].word; nextChange=sequence[idx].untilCycle;
        }
        map[c]=cur;
    }
    const res = runSim(raw, cycles, map);
    return res.pruState.registers[4] & 0xFF;
}

assertEq('both high -> SAFE(0)', runWithMap(1,1), 0);
assertEq('both low long -> TRIP(1) [800 cycles >400]', runWithMap(0,0), 1);
// disagreement beyond window -> disc fault 2 . With static disagree, loop will timeout after 500 cycles -> fault
assertEq('A high B low long -> DISC_FAULT(2)', runWithMap(1,0), 2);
assertEq('A low B high long -> DISC_FAULT(2)', runWithMap(0,1), 2);
// dynamic: short OSSD pulse within both windows -> SAFE
assertEq('short OSSD pulse (20 cycles) tolerated -> SAFE(0)', runDynamic([{word:2, untilCycle:30},{word:3, untilCycle:3000}]), 0);
// dynamic: long pulse exceeding OSSD_MAX but still within DISC -> calibrated
(function(){
    const args={ RES:'R4', CH_A:'0', CH_B:'1', DISC_CYCLES:'60', OSSD_MAX:'40' };
    const raw=expand(macro, args);
    const cycles=4000;
    // 300 wall ~43 iter >40 => trip, DISC 60 => ~420 wall threshold, so 300 <420 => not disc
    const map={}; for(let c=0;c<cycles;c++){ map[c]= c<300?2:3; }
    const res=runSim(raw,cycles,map);
    const v=res.pruState.registers[4]&0xFF;
    assertEq('OSSD pulse 300 wall > OSSD 200 wall but < DISC 420 -> TRIP(1)', v, 1);
})();
// calibrated: DISC 50 iter ~350 wall, so 500 wall exceeds DISC => disc fault
assertEq('long disagree 500 wall > DISC 350 wall -> DISC_FAULT(2)', runDynamic([{word:2, untilCycle:500},{word:3, untilCycle:4000}]), 2);

if(!ok) process.exit(1);
console.log('All headless OSSD monitor checks passed');
