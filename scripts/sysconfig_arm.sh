#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
#
# end-to-end arm: drive the REAL TI SysConfig CLI over the XFR2SPIN
# fixtures, then assemble the generated firmware with the REAL clpru.
#
# Why this exists instead of a node harness that calls getMacro() directly:
# the rejected attempt at this item shipped a production macro that expanded to
# nothing, and passed its own tests because those tests called a non-production
# branch. The only way to prove the firmware a user actually gets contains the
# spinlock access is to run the generator that produces that firmware and grep
# its output. Everything here reads generated artifacts, never block source.
#
# Usage:  bash scripts/sysconfig_arm.sh [outdir]
# Exit 0 = every expectation met.
#
# Requires (paths overridable by env):
#   SYSCONFIG_CLI  default $HOME/ti/sysconfig_1.26.2/sysconfig_cli.sh
#   CLPRU          default $HOME/ti/ti-cgt-pru_2.3.3/bin/clpru
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="${1:-$ROOT/build_out/}"
FIX="$ROOT/scripts/fixtures/shared_resource_lock"
SYSCONFIG_CLI="${SYSCONFIG_CLI:-$HOME/ti/sysconfig_1.26.2/sysconfig_cli.sh}"
CLPRU="${CLPRU:-$HOME/ti/ti-cgt-pru_2.3.3/bin/clpru}"

# SysConfig 1.26.2 tightened the product schema (portTypes need an explicit
# `side`, and IO_NEXT/IO_PREV are built-ins that a product file must not
# redefine). .metadata/product.json still targets the older schema the shipping
# GUI uses, so this arm generates a schema-adapted COPY rather than editing the
# product file the tool ships with. Only the graphable port metadata differs;
# no block, template or macro is touched.
#
# It MUST live next to the original: `includePaths` and `components` in a
# product file resolve relative to that file, so a copy written elsewhere
# silently loses the /pru_blocks component (and with it the built-in
# IO_PREV/IO_NEXT port declarations). Removed again on exit so the arm leaves
# the working tree exactly as it found it.
PRODUCT="$ROOT/.metadata/product..generated.json"
trap 'rm -f "$PRODUCT"' EXIT

fail=0
note() { printf '%s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

for tool in "$SYSCONFIG_CLI" "$CLPRU"; do
  if [ ! -x "$tool" ]; then
    note "SKIP: required tool not executable: $tool"
    exit 127
  fi
done

mkdir -p "$OUTDIR"
node -e '
const fs=require("fs");
const p=eval("("+fs.readFileSync(process.argv[1],"utf8")+")");
const SIDES={IO_INPUT:"left",IO_OUTPUT:"right",IO_BRANCH_TRUE:"right",IO_BRANCH_FALSE:"right"};
for(const t of p.graphable.portTypes) t.side=SIDES[t.type];
for(const c of p.graphable.connectionTypes) if(c.end==="IO_NEXT") c.end="IO_PREV";
fs.writeFileSync(process.argv[2], JSON.stringify(p,null,4));
' "$ROOT/.metadata/product.json" "$PRODUCT" || { note "product adaptation failed"; exit 1; }

# generate <fixture> -> prints combined CLI output, leaves artifacts in $OUTDIR/<name>
generate() {
  local name="$1"
  rm -rf "${OUTDIR:?}/$name"
  mkdir -p "$OUTDIR/$name"
  ( cd "$ROOT" && "$SYSCONFIG_CLI" \
      --product "$PRODUCT" \
      --script "$FIX/$name.syscfg" \
      --output "$OUTDIR/$name" 2>&1 )
}

# --------------------------------------------------------------------------
# 1. The good design must generate cleanly AND the generated firmware must
#    carry the real spinlock access.
# --------------------------------------------------------------------------
out="$(generate locked_ok)"
if printf '%s' "$out" | grep -qiE '^error:|[0-9]+ error\(s\)'; then
  bad "locked_ok should generate without errors"; printf '%s\n' "$out" | sed 's/^/      | /'
else
  ok "locked_ok generates without errors"
fi

INC="$OUTDIR/locked_ok/pru_syscfg.inc"
ASM="$OUTDIR/locked_ok/pru_syscfg.asm"
if [ ! -f "$INC" ]; then
  bad "no generated pru_syscfg.inc"
else
  # --- requirement (a): grep the GENERATED output, not the block source -----
  grep -q 'ldi   R1.b0, LOCK_ID' "$INC" \
    && ok "generated .inc: flag selector load (R1.b0 = own_req_vector)" \
    || bad "generated .inc: MISSING selector load"

  grep -q 'xin   144, &R1.b3, 1' "$INC" \
    && ok "generated .inc: acquire XIN against device 144 (0x90)" \
    || bad "generated .inc: MISSING acquire XIN 0x90"

  grep -q 'xout  144, &R1.b0, 1' "$INC" \
    && ok "generated .inc: release XOUT against device 144 (0x90)" \
    || bad "generated .inc: MISSING release XOUT 0x90"

  grep -q 'and   RES, R1.b3, 1' "$INC" \
    && ok "generated .inc: ownership masked to the BIT R1.b3[0]" \
    || bad "generated .inc: ownership not masked to bit 0"

  # Eight NOPs, counted inside the release macro body only.
  nops="$(awk '/^m_xfr2spin_release \.macro/{f=1} f&&/^    nop$/{n++} f&&/\.endm/{print n+0; exit}' "$INC")"
  if [ "${nops:-0}" -eq 8 ]; then
    ok "generated .inc: exactly 8 NOPs after the release XOUT (got $nops)"
  else
    bad "generated .inc: expected 8 NOPs after release XOUT, got ${nops:-0}"
  fi

  # A macro that expands to nothing would still contain .macro/.endm; require
  # real instruction lines between them. This is the rejection-#2 guard.
  body="$(awk '/^m_xfr2spin_acquire \.macro/{f=1;next} f&&/\.endm/{exit} f&&!/^ *;/&&NF{print}' "$INC" | wc -l)"
  if [ "${body:-0}" -ge 4 ]; then
    ok "generated .inc: acquire macro body is non-empty ($body instruction lines)"
  else
    bad "generated .inc: acquire macro body is effectively EMPTY ($body lines)"
  fi
fi

# --------------------------------------------------------------------------
# 2. clpru must assemble the generated firmware, and the LISTING must show
#    encoded instruction words for the spinlock ops. An empty macro assembles
#    fine (that is how rejection #2 hid), so text alone is not enough.
# --------------------------------------------------------------------------
if [ -f "$ASM" ]; then
  ( cd "$OUTDIR/locked_ok" && "$CLPRU" --silicon_version=3 -i. --asm_listing -c pru_syscfg.asm >clpru.log 2>&1 )
  if [ $? -eq 0 ]; then
    ok "clpru assembles the generated firmware"
    LST="$OUTDIR/locked_ok/pru_syscfg.lst"
    # Encoded words: address + hex + mnemonic.
    enc() { grep -cE "^1 +[0-9a-f]{8} +[0-9A-F]{14} +$1" "$LST"; }
    [ "$(enc 'xin   144')" -ge 1 ] && ok "listing: XIN 0x90 encoded to a machine word" || bad "listing: no encoded XIN 0x90"
    [ "$(enc 'xout  144')" -ge 1 ] && ok "listing: XOUT 0x90 encoded to a machine word" || bad "listing: no encoded XOUT 0x90"
    n="$(enc 'nop')"
    [ "$n" -eq 8 ] && ok "listing: exactly 8 encoded NOPs (got $n)" || bad "listing: expected 8 encoded NOPs, got $n"
    [ "$(enc 'and   R[0-9]+, R1.b3, 1')" -ge 1 ] && ok "listing: ownership bit mask encoded" || bad "listing: no encoded ownership mask"
  else
    bad "clpru failed to assemble generated firmware"
    sed 's/^/      | /' "$OUTDIR/locked_ok/clpru.log"
  fi
fi

# --------------------------------------------------------------------------
# 3. Negative designs. Each MUST be rejected, and the message must be the one
#    that belongs to that fault - not merely "some error happened".
# --------------------------------------------------------------------------
expect_error() {
  local name="$1" pattern="$2" label="$3"
  local o
  o="$(generate "$name")"
  if printf '%s' "$o" | grep -qE "$pattern"; then
    ok "$label"
  else
    bad "$label -- expected /$pattern/, got:"
    printf '%s\n' "$o" | grep -iE '^(error|warn|info):' | sed 's/^/      | /'
  fi
}

expect_error unlocked_crosscore     'no XFR2SPIN acquire/release pair names it' 'cross-core write with no lock is rejected'
expect_error lockid_mismatch        'which no acquire in this design takes'    'release with a non-matching lock id is rejected'
expect_error release_no_acquire     'never acquires any lock'                  'release with no acquire is rejected'
expect_error release_before_acquire 'executes BEFORE the acquire'              'release ordered before its acquire is rejected'
expect_error icssm_unreachable      'xfr2spin|spinlock|not available|widget'   'acquire on a core that cannot reach the device is rejected'

echo
if [ "$fail" -eq 0 ]; then echo "sysconfig arm: ALL EXPECTATIONS MET"; else echo "sysconfig arm: FAILURES PRESENT"; fi
exit "$fail"
