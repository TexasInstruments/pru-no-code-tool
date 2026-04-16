---

## Load Constant Block

### Purpose

The Load Constant block loads an immediate constant value into a register. This is typically the starting point in a data flow, providing initial values, configuration parameters, bit masks, or counter values.

### Features

- Load any value from 0 to 4,294,967,295 (0xFFFFFFFF)
- Automatic instruction selection based on value size
- No input connections required (source block)
- Supports decimal and hexadecimal input formats

### Configuration

| Parameter | Description | Range |
|-----------|-------------|-------|
| Constant Value | The value to load | 0 to 0xFFFFFFFF |

### How It Works

1. Enter the desired constant value
2. The block automatically determines the optimal instruction:
   - Values 0-65535: Uses `LDI` instruction (1 cycle)
   - Values > 65535: Uses `LDI32` instruction (2 cycles)
3. Output register is dynamically allocated
4. Value is available for connected downstream blocks

### Common Use Cases

- **Initializing counters**: Load starting value for loop counters
- **Bit masks**: Load mask values for AND/OR operations
- **Configuration values**: Provide pin numbers, addresses, or settings
- **Table indices**: Load starting index for look-up table access
- **Protocol constants**: Load baud rate divisors, frame sizes, etc.

### Example Usage

To mask SPI read data and keep only the lower 8 bits: Connect a Load Constant block (value: 0xFF) to input2 of a Bitwise AND block, and connect the SPI Read output to input1 of the Load Constant block. The AND block output will contain only the lower 8 bits of the SPI data.

---