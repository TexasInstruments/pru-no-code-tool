/**
 * Clpru build verifier for the SVPWM block macro.
 *
 * ============================================================================
 * IMPORTANT — AUTHORING CONSTRAINT:
 * Authored with NO shell and NO file-read access. This script was NOT run.
 * It is written to the shape described for scripts/verify_ssi_build.js (an
 * oracle + build-verifier pair emitting a .asm and invoking clpru), but the
 * author could not read that file, so the exact helper names it would share
 * are ASSUMED, not known. Every assumption is marked ASSUMPTION:. The
 * operator must reconcile the seams marked OPERATOR TODO and then run:
 *
 *     node scripts/verify_svpwm_build.js
 *
 * and paste the full transcript into docs/evidence/svpwm.md.
 * ============================================================================
 *
 * What this script does (when run):
 *   1. Emits the SVPWM block's PRU assembly macro to
 *      build_out/svpwm_build_test/svpwm_block.asm.
 *   2. Invokes the TI clpru assembler on it.
 *   3. Greps the assembler output for hard errors — specifically the
 *      PRU-forbidden MULL instruction, which clpru rejects (the hard rule:
 *      constant multiplies must be shift-and-add).
 *   4. Exits nonzero on any assembler error; prints the assembler transcript
 *      verbatim so it can be captured as evidence.
 *
 * NOTE on the SQRT3 multiplies: the SVPWM math needs sqrt(3)*Vbeta and
 * (sqrt(3)/2)*Vbeta etc. On PRU these MUST be emitted as shift-and-add
 * sequences against fixed-point constants, never as a multiply instruction.
 * This verifier's job is to prove the emitted macro honors that.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ASSUMPTION: the SSI verifier located clpru either on PATH or via an env var
// like CLPRU. Try both; error clearly if absent.
const CLPRU =
  process.env.CLPRU || "C:/ti/ti-cgt-pru_2.3.3/bin/clpru.exe"; // same path verify_ssi_build.js uses

const OUTDIR = path.join(__dirname, "..", "build_out", "svpwm_build_test");
const ASM = path.join(OUTDIR, "svpwm_block.asm");

function emitAsm() {
  // OPERATOR TODO(seam): the author could not read the block module, so the
  // exact require path and emitter entry point are placeholders. Replace with
  // the real one, mirroring verify_ssi_build.js. Expected shape assumed:
  //   const blk = require(".../svpwm_block.syscfg.js");
  //   const asm = blk.emitAsm({ deadtimeTicks: 32, tpwmTicks: 2000 });
  // If the block instead ships a static .asm template, copy it here.
  // RESOLVED 2026-08-28. Three corrections to the placeholder above:
  //  1. The block lives in data_handling/, not application_specific/.
  //  2. There is no emitAsm/emit entry point. Blocks expose getMacro(call, opCode)
  //     and return the macro as a single string - same as SSI and BiSS-C.
  //  3. The module ends with `exports = svpwmModule`, rebinding the parameter, so
  //     require() yields an empty object. It has to be evaluated and read back.
  const blockPath = path.join(
    __dirname, "..", ".metadata", "sysconfig", ".meta", "pru_blocks",
    "data_handling", "svpwm_block.syscfg.js"
  );
  if (!fs.existsSync(blockPath)) {
    console.error(`BUILD VERIFY ABORT: block not found at ${blockPath}`);
    process.exit(2);
  }
  const block = new Function(
    "exports",
    fs.readFileSync(blockPath, "utf8") + "\nreturn exports;"
  )({});
  if (typeof block.getMacro !== "function") {
    console.error("BUILD VERIFY ABORT: svpwm_block exposes no getMacro()");
    process.exit(2);
  }
  const emitter = () => block.getMacro("m_svpwm_duty", "m_svpwm_duty");
  const used = blockPath;
  // getMacro returns a `.macro`/`.endm` DEFINITION with symbolic operand names.
  // clpru will happily assemble a macro that is never invoked, which would make
  // this gate vacuous. Expand it the way build_out/ssi_build_test/ssi_test.asm
  // does - substitute real registers, drop the .macro wrapper, and emit the body
  // under .text/.global main - so the instructions are actually assembled.
  const REG = {
    OUT_A: "R10", OUT_B: "R11", OUT_C: "R12", SECTOR: "R13", SAMPLE: "R14",
    ALPHA: "R15", BETA: "R16",
    TEMP_REG1: "R28", TEMP_REG2: "R29", TEMP_REG3: "R26", TEMP_REG4: "R27",
  };
  let macro = emitter();
  for (const [name, reg] of Object.entries(REG)) macro = macro.split(name).join(reg);
  macro = macro.split("PERIOD").join("2000").split("DEADTIME").join("32");

  const body = macro
    .split("\n")
    .filter((l) => !l.includes(".macro") && !l.includes(".endm"))
    .map((l) => l.replace(/\?/g, "_1"))
    .join("\n");

  const asm = ["    .text", "    .global main", "main:", body, "    halt", ""].join("\n");
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(ASM, asm);
  console.log(`emitted ${ASM} from ${used} (${asm.length} bytes, macro expanded)`);
  return asm;
}

function assemble() {
  let out;
  try {
    out = execFileSync(CLPRU, [ASM], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    console.error("clpru exited nonzero. Transcript:\n" + out);
    process.exit(1);
  }
  console.log("clpru transcript:\n" + (out.trim() ? out : "(no output — clean assemble)"));
  return out;
}

function checkNoMull(asmText, clpruOut) {
  // Belt and suspenders: clpru rejecting MULL is the authoritative gate, but
  // also scan the emitted source so a simulator-authored macro can't slip a
  // MULL through a misconfigured assembler path.
  // Strip `;` comments before scanning. The macro documents its own shift-and-add
  // with the comment "sqrt(3)*beta, shift/add approximation (no fictitious MULL)",
  // and a raw text scan matched THAT - failing a clean build over a comment that
  // says the right thing. A checker that fires on its own documentation is a
  // false-positive generator.
  const codeOnly = asmText
    .split("\n")
    .map((l) => { const i = l.indexOf(";"); return i === -1 ? l : l.slice(0, i); })
    .join("\n");
  const mull = codeOnly.match(/\bMULL\b/i);
  if (mull) {
    console.error(
      "BUILD VERIFY FAIL: emitted assembly contains MULL. PRU has no MULL;\n" +
        "constant multiplies must be shift-and-add. Fix the block emitter."
    );
    process.exit(1);
  }
  if (/error/i.test(clpruOut)) {
    console.error("BUILD VERIFY FAIL: assembler reported errors (see transcript above).");
    process.exit(1);
  }
  console.log("BUILD VERIFY OK: no MULL, clpru clean");
}

if (require.main === module) {
  const asm = emitAsm();
  const out = assemble();
  checkNoMull(asm, out);
}