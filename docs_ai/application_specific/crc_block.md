## CRC Block (Cyclic Redundancy Check)

### Purpose
Calculates CRC checksums for error detection in data transmission and storage. CRC is a hash function that detects accidental changes to raw data.

### How It Works
1. **Input 1 (init)**: Connect CRC initialization value (either 0 from Load Constant or output from previous CRC block)
2. **Input 2 (data)**: Connect the data byte to process
3. **Process**: Uses table lookup and XOR operations to efficiently compute CRC
4. **Output**: Provides updated CRC value for next block or final checksum

### Configuration

**CRC Type**: Choose checksum size
- **CRC8**: 8-bit checksum (1 byte, 0-255)
- **CRC16**: 16-bit checksum (2 bytes, 0-65535)
- **CRC32**: 32-bit checksum (4 bytes, full 32-bit range)

**CRC Polynomial**: The generator polynomial in hexadecimal
- Defines the mathematical algorithm for CRC calculation
- Common polynomials:
  - CRC8: 0x07 (x⁸ + x² + x + 1)
  - CRC16: 0x8005 (x¹⁶ + x¹⁵ + x² + 1)
  - CRC32: 0x04C11DB7 (Ethernet/ZIP polynomial)

**CRC Initialization**: How to initialize the CRC accumulator
- **initialize_crc_result_with_zeros**: Start fresh calculation (connect LOAD_CONSTANT with value 0)
- **initialize_crc_result_from_crcblock**: Continue from previous CRC (chain CRC blocks)

### Technical Details (Additional Information)

**Generated Assembly** (CRC8 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- XOR    TEMP_REG2.b0, init, dataByte ; XOR init with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 1  ; Lookup (6 cycles)


**Generated Assembly** (CRC16 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- LSR    TEMP_REG2.b0, init, 8        ; Extract high byte
- XOR    TEMP_REG2.b0, TEMP_REG2.b0, dataByte  ; XOR with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 2   ; Lookup
- LSL    TEMP_REG2, init, 8           ; Shift init left
- XOR    result, TEMP_REG2.w0, result ; XOR with lookup (9 cycles)

**Generated Assembly** (CRC32 example):
- LDI32  TEMP_REG1, CRC_LUT_address   ; Load LUT address
- LSR    TEMP_REG2.b0, init, 24       ; Extract high byte
- XOR    TEMP_REG2.b0, TEMP_REG2.b0, dataByte  ; XOR with data
- LBBO   &result, TEMP_REG1, TEMP_REG2.b0, 4   ; Lookup
- LSL    TEMP_REG2, init, 8           ; Shift init left
- XOR    result, TEMP_REG2, result    ; XOR with lookup (9 cycles)

**Performance**:
- CRC8: 6 PRU cycles per byte
- CRC16: 9 PRU cycles per byte
- CRC32: 9 PRU cycles per byte

**Lookup Table**: Automatically generated 256-entry table based on polynomial
- CRC8: 256 bytes (256 × 1 byte)
- CRC16: 512 bytes (256 × 2 bytes)
- CRC32: 1024 bytes (256 × 4 bytes)
- Table stored in PRU DMEM
- Pre-computed at configuration time

### How CRC Works

**Algorithm Overview**:
1. Initialize CRC register (typically to 0)
2. For each data byte:
   - XOR with appropriate bits of current CRC
   - Use result as index into lookup table
   - Update CRC with table value
3. Final CRC value is the checksum

**Why Use CRC?**
- Detects single-bit errors
- Detects burst errors
- Fast computation using lookup tables
- Widely used in networking (Ethernet), storage (ZIP), and embedded systems

### Usage Notes
- Always initialize with zeros for first CRC calculation
- When processing multiple bytes, chain CRC blocks together
- Input data must be 1 byte (8 bits)
- The polynomial determines error detection capability
- Different standards use different polynomials - verify your protocol requirements
- LUT is shared between CRC blocks with same polynomial and type

### Terminology
- **CRC**: Cyclic Redundancy Check - error-detecting code
- **Checksum**: Result of CRC calculation used to verify data integrity
- **Polynomial**: Mathematical basis for CRC algorithm (e.g., 0x07, 0x8005)
- **Generator polynomial**: Divisor used in CRC calculation
- **LUT**: Lookup Table - pre-computed CRC values for each possible byte
- **DMEM**: PRU Data Memory where lookup table is stored
- **Chaining**: Connecting CRC blocks to process multiple bytes sequentially
- **Error detection**: Ability to detect corrupted or modified data

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the CRC block in a .syscfg file.

### Adding a CRC Instance

```javascript
const crc_block = scripting.addModule("/pru_blocks/application_specific/crc_block", {}, false);
const crc1 = crc_block.addInstance();
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| opCode | String | "m_calculate_crc8", "m_calculate_crc16", "m_calculate_crc32" | "m_calculate_crc8" | CRC algorithm type |
| crcPolynomial | Hex | Depends on CRC type | 0x07 | CRC polynomial (generator) |
| output1Size | String | "1", "2", "4" | "1" | Output size in bytes |

### Valid CRC Types and Polynomials

| CRC Type | Default Polynomial | Common Polynomials | Description |
|----------|-------------------|-------------------|-------------|
| CRC8 | 0x07 | 0x07, 0x31, 0x9B | 8-bit CRC (1 byte output) |
| CRC16 | 0x8005 | 0x8005, 0x1021, 0x8408 | 16-bit CRC (2 byte output) |
| CRC32 | 0x04C11DB7 | 0x04C11DB7, 0xEDB88320 | 32-bit CRC (4 byte output) |

### Example Configurations

**Standard CRC8:**
```javascript
crc1.$name = "CRC8_Check";
crc1.opCode = "m_calculate_crc8";
crc1.crcPolynomial = 0x07;
crc1.output1Size = "1";
```

**CRC16 for MODBUS:**
```javascript
crc1.$name = "CRC16_MODBUS";
crc1.opCode = "m_calculate_crc16";
crc1.crcPolynomial = 0x8005;
crc1.output1Size = "2";
```

**CRC32 for Ethernet:**
```javascript
crc1.$name = "CRC32_Ethernet";
crc1.opCode = "m_calculate_crc32";
crc1.crcPolynomial = 0x04C11DB7;
crc1.output1Size = "4";
```

### Connecting to Other Blocks

```javascript
// Connect data input
scripting.connect(data_source, "output1", crc1, "input1");

// Connect CRC output to downstream block
scripting.connect(crc1, "output1", next_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", crc1, "prev");
scripting.connect(crc1, "next", next_block, "prev");
```

### Important Notes

1. **Input Required**: input1 must be connected to provide data for CRC calculation.

2. **Polynomial Selection**: Choose appropriate polynomial for your protocol/standard.

3. **Output Size**: Must match CRC type (CRC8=1 byte, CRC16=2 bytes, CRC32=4 bytes).

4. **Lookup Table**: Block generates optimized lookup table for fast CRC calculation.