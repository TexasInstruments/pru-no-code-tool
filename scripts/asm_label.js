'use strict';
/**
 * asm_label.js - one shared splitter for `label: instr` lines.
 *
 * The TI PRU assembler (clpru) accepts a label followed by an instruction on
 * the same line (e.g. `pb_ws?: sub r1, r1, 1`). An expander that treats a
 * line as a label only when the whole trimmed line ends with ':' misreads
 * such a line as an instruction, never defines the label, and leaves a later
 * branch to it with an unresolved target.
 *
 * splitLabel(line) -> null when the line carries no code (blank or
 * comment-only), otherwise { label, rest } where `label` is the raw label
 * text or null and `rest` is the instruction text after the label ('' when the
 * line is a label alone). Callers apply their own `?` normalisation to both
 * halves. A label is an identifier ([A-Za-z0-9_?$]+) immediately followed by
 * ':' at the start of the trimmed line; a ':' inside an operand or after a
 * ';' comment is never a label.
 */
function splitLabel(line) {
  const t = String(line).trim();
  if (!t || t.startsWith(';')) return null;
  let code = t;
  const semi = code.indexOf(';');
  if (semi !== -1) code = code.slice(0, semi).trim();
  if (!code) return null;
  const m = code.match(/^([A-Za-z0-9_?$]+):(.*)$/);
  if (!m) return { label: null, rest: code };
  return { label: m[1], rest: m[2].trim() };
}

module.exports = { splitLabel };
