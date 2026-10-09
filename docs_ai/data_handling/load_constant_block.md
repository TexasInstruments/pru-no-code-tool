## Load Constant Block

### Purpose
Loads an immediate constant value into a register. This is typically the starting block in a data flow, providing initial values or configuration parameters.

### How It Works
1. **Enter Value**: Specify a constant value (0 to 0xFFFFFFFF)
2. **Auto-sizing**: Block automatically selects the appropriate instruction based on value size
3. **Output**: Provides the constant value to the next block

### Configuration
- **Constant Value**: Enter any value from 0 to 4,294,967,295 (0xFFFFFFFF)
  - Can be entered in decimal or hexadecimal format
  - Block automatically determines optimal instruction

### Technical Details (Additional Information)
**Generated Assembly** (auto-selected based on value size):
; For values 0-255 (8-bit):
LDI result, value                  ; 1 cycle

; For values 256-65535 (16-bit):
LDI result, value                  ; 1 cycle

; For values > 65535 (32-bit):
LDI32 result, value                ; 1 cycle (uses two instruction slots)

**Performance**: 1 PRU cycle

### Usage Notes
- No input connections - this is a source block
- Output can be connected to any block that accepts data input
- Value is loaded at the time this block executes in the flow
- Commonly used for:
  - Table indices
  - Counter initialization
  - Configuration values
  - Bit masks

### Terminology
- **LDI**: Load Immediate - instruction to load a constant into a register
- **LDI32**: Load 32-bit Immediate - instruction for full 32-bit constants
- **Immediate value**: Constant value embedded directly in the instruction

---


## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Load Constant block in a .syscfg file.

### Adding a Load Constant Instance

\`\`\`javascript
const load_constant_block = scripting.addModule("/pru_blocks/data_handling/load_constant_block", {}, false);
const ldi1 = load_constant_block.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| constant1 | Integer | 0 to 0xFFFFFFFF | 0 | Constant value to load |

### Example Configurations

**Load small value (8-bit, uses LDI):**
\`\`\`javascript
ldi1.$name = "Load_Small";
ldi1.constant1 = 0x55;           // 85 decimal
\`\`\`

**Load medium value (16-bit, uses LDI):**
\`\`\`javascript
ldi1.$name = "Load_Medium";
ldi1.constant1 = 0x1234;         // 4660 decimal
\`\`\`

**Load large value (32-bit, uses LDI32):**
\`\`\`javascript
ldi1.$name = "Load_Large";
ldi1.constant1 = 0xDEADBEEF;     // 3735928559 decimal
\`\`\`

**Load bit mask:**
\`\`\`javascript
ldi1.$name = "Bit_Mask";
ldi1.constant1 = 0xFF00FF00;     // Alternating byte mask
\`\`\`

**Load zero:**
\`\`\`javascript
ldi1.$name = "Zero_Value";
ldi1.constant1 = 0;
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect output to downstream block (e.g., arithmetic, UART TX, SPI)
scripting.connect(ldi1, "output1", arithmetic_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", ldi1, "prev");
scripting.connect(ldi1, "next", next_block, "prev");
\`\`\`

### Important Notes

1. **Source Block**: Load Constant has no input - it's a data source.

2. **Auto-sizing**: The block automatically selects LDI (1 cycle) for values ≤ 0xFFFF and LDI32 (2 cycles) for larger values.

3. **Output Size**: Output register size is automatically determined:
- 1 byte for values 0-255
- 2 bytes for values 256-65535
- 4 bytes for values > 65535

4. **Hexadecimal**: Values can be specified in hex (0x prefix) or decimal.