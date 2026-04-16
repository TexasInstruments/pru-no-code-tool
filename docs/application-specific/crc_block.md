---

## CRC Block (Cyclic Redundancy Check)

### Purpose

Calculates CRC checksums for error detection in data transmission and storage. Each block processes one input byte using a pre-computed 256-entry lookup table stored in PRU DMEM or SMEM, producing an updated CRC accumulator value. Chain multiple CRC blocks to process multi-byte messages.

### Features

- CRC8, CRC16, and CRC32 algorithms
- Configurable generator polynomial
- Table-driven — fast and deterministic (6–9 cycles per byte)
- 256-entry LUT auto-generated from polynomial at SysConfig time
- LUT stored in DMEM or SMEM
- Chainable — output of one CRC block feeds `init` of the next

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| CRC Type | Checksum width | CRC8, CRC16, CRC32 |
| CRC Polynomial | Generator polynomial (hex) | 0x00–0xFF (CRC8), 0x0000–0xFFFF (CRC16), 0x00000000–0xFFFFFFFF (CRC32) |
| CRC Initialization | Source of initial CRC value | Initialize with zeros, Initialize from CRC block |
| Lookup Table Memory Location | Where to store the 256-entry LUT | DMEM (Local, 8 KB), SMEM (Shared, 64 KB) |

### Ports

| Port | Display Name | Direction | Description |
|------|-------------|-----------|-------------|
| input1 | init | Input | Initial CRC value — connect Load Constant (0) for first byte, or previous CRC block output when chaining |
| input2 | data | Input | Data byte to process (must be 1 byte / 8 bits) |
| output1 | — | Output | Updated CRC value after processing the input byte |
| prev / next | — | Control | Standard flow control |

### Common Polynomials

| Standard | CRC Type | Polynomial |
|----------|----------|------------|
| CRC-8 (ATM) | CRC8 | 0x07 |
| CRC-8/MAXIM | CRC8 | 0x31 |
| CRC-8/SAE-J1850 | CRC8 | 0x1D |
| CRC-16/IBM (MODBUS) | CRC16 | 0x8005 |
| CRC-16/CCITT | CRC16 | 0x1021 |
| CRC-32 (Ethernet/ZIP) | CRC32 | 0x04C11DB7 |

### How It Works (Algorithm)

1. Initialize CRC accumulator to 0 (or to the previous CRC value when chaining)
2. For each data byte:
   - XOR with appropriate bits of the current CRC accumulator to form a table index
   - Look up the pre-computed value at that index
   - Update the accumulator using the table value
3. The final accumulator value is the checksum

### Generated Assembly

**CRC8:**
```assembly
LDI32   TEMP_REG1, <LUT_address>        ; Load LUT base address
XOR     TEMP_REG2.b0, crcInit, dataByte ; XOR init with data byte → index
LBBO    &crcResult, TEMP_REG1, TEMP_REG2.b0, 1  ; Lookup result (6 cycles total)
```

**CRC16:**
```assembly
LDI32   TEMP_REG1, <LUT_address>
LSR     TEMP_REG2.b0, crcInit, 8        ; Extract high byte
XOR     TEMP_REG2.b0, TEMP_REG2.b0, dataByte
LBBO    &crcResult, TEMP_REG1, TEMP_REG2.b0, 2
LSL     TEMP_REG2, crcInit, 8
XOR     crcResult, TEMP_REG2.w0, crcResult  ; (9 cycles total)
```

**CRC32:**
```assembly
LDI32   TEMP_REG1, <LUT_address>
LSR     TEMP_REG2.b0, crcInit, 24       ; Extract high byte
XOR     TEMP_REG2.b0, TEMP_REG2.b0, dataByte
LBBO    &crcResult, TEMP_REG1, TEMP_REG2.b0, 4
LSL     TEMP_REG2, crcInit, 8
XOR     crcResult, TEMP_REG2, crcResult  ; (9 cycles total)
```

### Performance

| CRC Type | Cycles per Byte | LUT Memory |
|----------|----------------|-----------|
| CRC8 | 6 | 256 bytes |
| CRC16 | 9 | 512 bytes |
| CRC32 | 9 | 1024 bytes |

### Single-Byte CRC

```
[Load Constant (0)] → init
[Data Source]       → data
[CRC Block]         → output1 = final checksum
```

### Multi-Byte CRC (Chaining)

```
[Load Constant (0)] → init ┐
[Byte 0 source]     → data ┘ [CRC Block 0] → output1
                                                ↓ init
                              [Byte 1 source] → data
                              [CRC Block 1]  → output1
                                                ↓ init
                              [Byte 2 source] → data
                              [CRC Block 2]  → output1 = final checksum
```

For the second block onwards, set **CRC Initialization** to `Initialize from CRC block` — this hides the CRC Type/Polynomial fields (inherited from the first block) and automatically reuses the same LUT.

### Validation Rules

- `init` (input1) must be connected
- If **CRC Initialization = zeros**, the connected block must provide a constant value of `0`
- If **CRC Initialization = from crc block**, input1 must come from another CRC block
- `data` (input2) must be connected and must be exactly **1 byte** (8 bits)
- Polynomial must be within range for the selected CRC type

### Memory Location

Use **SMEM** if multiple PRU cores share the same CRC table to save DMEM. Use **DMEM** for single-PRU designs where access speed matters. The LUT is shared between CRC blocks that use the same polynomial and type — only one copy is stored regardless of how many CRC blocks reference it.

---