/**
 * clpru build check for the SVPWM block macro.
 *
 * What it does:
 *   1. Expands the SVPWM block's PRU assembly macro (m_svpwm_duty) with real
 *      registers and writes it to build_out/svpwm_build_test/svpwm_block.asm.
 *   2. Assembles it with the TI clpru assembler (CGT_TI_PRU_PATH, or CLPRU
 *      naming the clpru executable, or the default install location).
 *   3. Fails on any assembler error and on any MULL instruction in the
 *      emitted code: PRU has no MULL, so constant multiplies must be
 *      shift-and-add sequences.
 *
 * Usage:  node scripts/verify_svpwm_build.js
 * Exit:   0 clean build, 1 assembler error or MULL found, 2 the block could
 *         not be loaded.
 *
 * NOTE on the SQRT3 multiplies: the SVPWM math needs sqrt(3)*Vbeta and
 * (sqrt(3)/2)*Vbeta etc. On PRU these MUST be emitted as shift-and-add
 * sequences against fixed-point constants, never as a multiply instruction.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { findClpru } = require("./dual_oracle_harness.js");

// CLPRU names the executable directly; otherwise CGT_TI_PRU_PATH or the
// default install location (findClpru).
const CLPRU = process.env.CLPRU || findClpru();

const OUTDIR = path.join(__dirname, "..", "build_out", "svpwm_build_test");
const ASM = path.join(OUTDIR, "svpwm_block.asm");

function emitAsm() {
  // The block lives in data_handling/ and exposes getMacro(call, opCode), which
  // returns the macro as a single string. The module ends with
  // `exports = svpwmModule`, rebinding the parameter, so require() yields an
  // empty object: it has to be evaluated and read back.
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
  // this gate vacuous. Expand it instead - substitute real registers, drop the
  // .macro wrapper, and emit the body under .text/.global main - so the
  // instructions are actually assembled.
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
  // clpru rejecting MULL is the authoritative gate; also scan the emitted
  // source so a MULL cannot slip through a misconfigured assembler path.
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