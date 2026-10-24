"use strict";
// JS frame mirror for the EnDat 2.2 initiator.
// A convenience for the JS-simulator harness (test_headless_sim.js). The
// reference check is TI pru-simulator's EnDat encoder model run against the
// real clpru ELF (tests/test_endat_framing.py).
//
// Frame contract (HEIDENHAIN EnDat 2.2 Technical Information ID 383942 = H;
// TI MCU+ Motor Control SDK endat_drv.c = TI):
//   Transmission order (first -> last):
//     S              start bit, 1                          (H p.8; TRM start bit = 1)
//     F1             error 1, active high                  (H p.8)
//     F2             error 2, EnDat 2.2 commands only, sent inverted (H p.8-9)
//     P0..P(n-1)     position value, LSB first             (H p.8-9)
//     CRC4..CRC0     5-bit CRC, MSB first
//   CRC (TI endat_make_crc_pos): x^5+x^3+x+1 (taps 0x0B), preset 0x1F, over
//        F1 [F2] P0..P(n-1) in transmission order (start bit excluded), result
//        inverted.

function crc5Endat(bits) {
    let r = 0x1F;
    for (const b of bits) {
        const ex = ((r >> 4) & 1) ^ (b & 1);
        r = (r << 1) & 0x1F;
        if (ex) r ^= 0x0B; // x^3 + x + 1
    }
    return (r ^ 0x1F) >>> 0;
}

// Build a full telegram bit sequence from ST/MT payload.
// endat22: reply to an EnDat 2.2 position command (adds F2).
// corrupt: null | 'crc' (flip last CRC bit) | 'start' (flip S)
function buildFrame({ st, mt, stBits, mtBits, warn = false, err = false, endat22 = false, corrupt = null }) {
    const posBits = stBits + mtBits;
    const position = (((mt & ((1 << mtBits) - 1)) << stBits) | (st & ((1 << stBits) - 1))) >>> 0;
    const covered = [warn ? 1 : 0];                       // F1
    if (endat22) covered.push(err ? 0 : 1);               // F2, inverted
    for (let i = 0; i < posBits; i++) covered.push((position >>> i) & 1); // LSB first
    const crc = crc5Endat(covered);
    const bits = [1].concat(covered);
    bits.push((crc >>> 4) & 1, (crc >>> 3) & 1, (crc >>> 2) & 1, (crc >>> 1) & 1, crc & 1); // CRC MSB first
    if (corrupt === 'crc') bits[bits.length - 1] ^= 1;
    if (corrupt === 'start') bits[0] ^= 1;
    let raw = 0;
    for (const b of bits) raw = ((raw << 1) | b) >>> 0;
    return { bits, crc, position, raw, totalBits: bits.length };
}

// Extract logical fields from the raw accumulated register (MSB = first received).
function extractFields(raw, totalBits, stBits, mtBits, errorBits = 1) {
    raw = raw >>> 0;
    const start = (raw >>> (totalBits - 1)) & 1;
    const f1 = (raw >>> (totalBits - 2)) & 1;
    const f2 = errorBits === 2 ? (raw >>> (totalBits - 3)) & 1 : null;
    const posBits = stBits + mtBits;
    const top = totalBits - 2 - errorBits;
    let position = 0;
    for (let i = 0; i < posBits; i++) position |= ((raw >>> (top - i)) & 1) << i;
    position >>>= 0;
    return {
        start,
        f1,
        f2,
        position,
        st: position & ((1 << stBits) - 1),
        mt: (position >>> stBits) & ((1 << mtBits) - 1)
    };
}

// Recompute the CRC over the covered bits of a raw register (start bit and CRC excluded).
function crcOfRaw(raw, totalBits) {
    const bits = [];
    for (let i = totalBits - 2; i >= 5; i--) bits.push((raw >>> i) & 1);
    return crc5Endat(bits);
}

module.exports = { crc5Endat, buildFrame, extractFields, crcOfRaw };
