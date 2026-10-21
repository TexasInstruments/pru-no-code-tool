const fs=require('fs'), path=require('path'), vm=require('vm'), child=require('child_process'), {formatAsmLine}=require('./dual_oracle_harness');
function makeStub(){const fn=function(){return makeStub()}; return new Proxy(fn,{get(_t,p){if(p==='toString')return()=>'';return makeStub()},apply(){return makeStub()}})}
function loadBlock(n,d){const f=path.join(__dirname,'../.metadata/sysconfig/.meta/pru_blocks',d,n+'.syscfg.js');const s=fs.readFileSync(f,'utf8');const sb={system:makeStub(),exports:{},module:{exports:{}},require:()=>makeStub(),console:{log(){},error(){},warn(){}}};sb.global=sb;vm.createContext(sb);vm.runInContext(s,sb,{filename:f,timeout:5000});return (sb.exports&&Object.keys(sb.exports).length)?sb.exports:sb.module.exports}
function expand(macroStr,argsMap){const lines=macroStr.split('\n');let idx=-1,params=[];for(let i=0;i<lines.length;i++){const l=lines[i].trim();if(l.includes('.macro')){idx=i;params=l.split('.macro')[1].split(',').map(p=>p.trim());break;}}const mapping={};for(let i=0;i<params.length;i++){const p=params[i];if(argsMap[p]!==undefined)mapping[p]=argsMap[p];}const body=lines.slice(idx+1);const stack=[true];const out=[];for(let line of body){const t=line.trim();if(t.startsWith('.endm'))break;if(t.startsWith('.if ')){let cond=t.substring(4).trim();for(const[k,v]of Object.entries(mapping))cond=cond.split(k).join(v);let isTrue=false;if(cond.includes('==')){const parts=cond.split('==').map(p=>p.trim());isTrue=parts[0]===parts[1]}else isTrue=(cond==='1');const parent=stack[stack.length-1];stack.push(parent&&isTrue);continue}if(t.startsWith('.else')){const p=stack[stack.length-2]??true;stack[stack.length-1]=p&&!stack[stack.length-1];continue}if(t.startsWith('.endif')){stack.pop();continue}if(stack[stack.length-1]){let pl=line;for(const[k,v]of Object.entries(mapping))pl=pl.split(k).join(v);pl=pl.replace(/TEMP_REG1/g,'R28').replace(/TEMP_REG2/g,'R29').replace(/TEMP_REG3/g,'R26').replace(/TEMP_REG4/g,'R27');out.push(pl.replace(/\?/g,'_1'))}}return out.join('\n');}
const endat=loadBlock('endat_initiator_block','application_specific');
const macro=endat.getMacro('m_endat_read','m_endat_read');
// The asm-assembly step this script actually runs, factored out so a
// test can drive the SAME formatting path (formatAsmLine from the shared
// dual_oracle_harness export) without invoking clpru. extraLines (optional)
// are formatted by the identical call site. macroOverride (optional)
// replaces the block macro so a test can push a same-line-label body through
// the production expanded-macro formatAsmLine site.
function buildAsmText(extraLines, macroOverride){
  // 32-bit telegram geometry (st=12, mt=11): TOTAL_BITS = 32
  const expanded=expand(macroOverride||macro,{RES:'R4',MODE_CMD:'0x2A',TOTAL_BITS:'32',ST_BITS:'12',MT_BITS:'11',CLK_PIN:'0',DATA_TX_PIN:'1',DATA_RX_PIN:'2',DATA_EN_PIN:'3',HALF_PERIOD:'4',T1_CLOCKS:'2',TRT_CYCLES:'10',TREC_CYCLES:'20',TIMEOUT_CYCLES:'100'});
  return ['    ','    .text','    .global main','main:'].concat(expanded.split('\n').map(formatAsmLine)).concat((extraLines||[]).map(formatAsmLine)).concat(['    halt','    .end']).join('\n');
}
// the require.main body factored into main() with an
// injectable dir/writeFile/execSync so a test can drive the REAL main path -
// including its buildAsmText call site - and capture the exact asm it writes,
// without clpru (the base endat macro fails clpru E0300 pre-; a
// stubbed execSync makes that irrelevant here). extraLines are appended via
// the identical call site.
function main(io, extraLines){
  const log=(io&&io.log)||console.log;
  const dir=(io&&io.dir)||path.join(__dirname,'..','build_out','endat_build_test');
  const mkdir=(io&&io.mkdir)||fs.mkdirSync;
  const writeFile=(io&&io.writeFile)||fs.writeFileSync;
  const execSync=(io&&io.execSync)||child.execSync;
  const asmText=buildAsmText(extraLines);
  mkdir(dir,{recursive:true});
  const asmPath=path.join(dir,'endat_test.asm');
  writeFile(asmPath,asmText);
  const clpru='C:/ti/ti-cgt-pru_2.3.3/bin/clpru.exe';
  try{execSync('"'+clpru+'" -v4 --silicon_version=4 -o "'+path.join(dir,'endat_test.obj')+'" "'+asmPath+'"', {stdio:'inherit'}); log('EnDat clpru build OK'); return true;}catch(e){(io&&io.logErr||console.error)('EnDat clpru build FAILED'); return false;}
}
if(require.main===module){
  if(!main()) process.exit(1);
}
module.exports={buildAsmText, main};
