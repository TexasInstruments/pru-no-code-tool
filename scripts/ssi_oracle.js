"use strict";
// External bitstream oracle for SSI initiator
// Generates deterministic SSI frames independent of PRU macro; used as reference.

function toGray(n){ return n ^ (n >>> 1); }
function fromGray(g){
    let n = g;
    for(let s = 16; s >=1; s>>=1) n ^= (n >>> s);
    return n >>>0;
}
function parityEven(v, bits){
    let p=0;
    for(let i=0;i<bits;i++) p ^= (v>>>i)&1;
    return p;
}

// Build SSI frame word (TOTAL_WIDTH bits, MSB first) from ST/MT payload
// layout: [ MT_BITS | ST_BITS | ERR? | PARITY?] where ST is LSBs of payload, MT above it
function buildFrame({st, mt, totalWidth, stBits, mtBits, parityEnable, parityType, errorBitEnable, grayCode, errorFlag}) {
    let payloadBits = stBits + mtBits;
    let payload = ((mt & ((1<<mtBits)-1)) << stBits) | (st & ((1<<stBits)-1));
    if (grayCode) {
        // gray encode only the ST+MT payload portion as one word
        let g = toGray(payload);
        payload = g & ((1 << payloadBits)-1);
    }
    // place payload at top of frame (shift left by error+parity)
    let extra = (errorBitEnable?1:0) + (parityEnable?1:0);
    let frame = payload << extra;
    let dataBits = payloadBits; // bits before error/parity
    if (errorBitEnable) {
        // error bit active high = 1 means OK (active low inverted is 0=error)
        // we set 1 for ok, 0 for error
        let errBit = errorFlag ? 0 : 1;
        frame |= (errBit << (parityEnable?1:0));
        dataBits += 1;
    }
    if (parityEnable) {
        let p = parityEven(frame >>>1, totalWidth-1); // even parity of all except parity bit
        if (parityType===1) p ^= 1; // odd
        frame |= p;
    }
    // mask to totalWidth
    frame &= (totalWidth>=32 ? 0xFFFFFFFF : ((1<<totalWidth)-1)>>>0);
    return frame >>>0;
}

function expandToR31History(frame, totalWidth, dataPin, clkPin) {
    // Simulator injects R31 value per instruction that reads R31.
    // Our macro reads R31 once per bit (qbbc R31, DATA_PIN). We provide array of R31 values
    // indexed by read order, not cycle. So history is bit sequence MSB first.
    const history = [];
    for(let i=totalWidth-1;i>=0;i--){
        let bit = (frame>>>i)&1;
        history.push(bit ? (1<<dataPin) : 0);
    }
    return history;
}

function extractFields(frame, totalWidth, stBits, mtBits, parityEnable, errorBitEnable, grayCode){
    let raw = frame;
    if(parityEnable) raw >>>=1;
    if(errorBitEnable) raw >>>=1;
    // raw now contains ST+MT payload (possibly gray)
    let stMask = (stBits>=32?0xFFFFFFFF:((1<<stBits)-1));
    let st = raw & stMask;
    let mt = (raw >>> stBits) & (mtBits>=32?0xFFFFFFFF:((1<<mtBits)-1));
    if(grayCode){
        let payloadBits = stBits+mtBits;
        let payload = raw & (payloadBits>=32?0xFFFFFFFF:((1<<payloadBits)-1));
        let bin = fromGray(payload);
        st = bin & stMask;
        mt = (bin >>> stBits) & (mtBits>=32?0xFFFFFFFF:((1<<mtBits)-1));
    }
    return {st, mt, raw};
}

module.exports = { toGray, fromGray, parityEven, buildFrame, expandToR31History, extractFields };
