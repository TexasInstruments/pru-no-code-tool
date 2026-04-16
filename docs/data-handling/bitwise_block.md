---

## Bitwise Block

### Purpose

The Bitwise block performs logical operations and bit shift operations on input values. It is essential for bit manipulation, masking, flag operations, and data formatting.

### Features

- Six bitwise operations: AND, OR, XOR, NOT, LSL, LSR
- Dynamic input count (1 or 2 based on operation)
- Visual shape changes to indicate operation type
- Configurable output size

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Bitwise Operation | The operation to perform | AND, OR, XOR, NOT, LSL, LSR |
| Output Size | Size of the result | Maximum of Inputs, 1 byte, 2 bytes, 4 bytes |

### Available Operations

#### AND (2 inputs)
- **Operation**: `result = input1 & input2`
- **Description**: Bitwise AND - bit is 1 only if both inputs are 1
- **Use case**: Masking bits, clearing specific bits
- **Example**: `0b1100 AND 0b1010 = 0b1000`

#### OR (2 inputs)
- **Operation**: `result = input1 | input2`
- **Description**: Bitwise OR - bit is 1 if either input is 1
- **Use case**: Setting bits, combining flags
- **Example**: `0b1100 OR 0b1010 = 0b1110`

#### XOR (2 inputs)
- **Operation**: `result = input1 ^ input2`
- **Description**: Bitwise XOR - bit is 1 if inputs differ
- **Use case**: Toggling bits, detecting changes, checksums
- **Example**: `0b1100 XOR 0b1010 = 0b0110`

#### NOT (1 input)
- **Operation**: `result = ~input1`
- **Description**: Bitwise complement - inverts all bits
- **Use case**: Creating inverse masks, logical negation
- **Example**: `NOT 0b00001111 = 0b11110000`

#### LSL - Logical Shift Left (2 inputs)
- **Operation**: `result = input1 << input2`
- **Description**: Shifts bits left, fills with zeros
- **Use case**: Multiplication by powers of 2, bit positioning
- **Example**: `0b00000011 LSL 2 = 0b00001100`

#### LSR - Logical Shift Right (2 inputs)
- **Operation**: `result = input1 >> input2`
- **Description**: Shifts bits right, fills with zeros
- **Use case**: Division by powers of 2, extracting high bits
- **Example**: `0b00001100 LSR 2 = 0b00000011`

### Example Usage

#### Masking (Extracting bits)
To extract the lower 4 bits from data: Connect your data source to input1 of a Bitwise AND block, and connect a Load Constant block (value: 0x0F) to input2. The output will contain only the lower 4 bits.

#### Setting flags
To set bit 3 in a flags register: Connect the current flags value to input1 of a Bitwise OR block, and connect a Load Constant block (value: 0x08) to input2. The output will have bit 3 set while preserving other bits.

#### Toggling bits
To toggle bit 0 (e.g., for LED blinking): Connect the current state to input1 of a Bitwise XOR block, and connect a Load Constant block (value: 0x01) to input2. Each execution will flip bit 0.

#### Packing data (combining bytes)
To combine a high byte and low byte into a 16-bit value: First, connect the high byte to a Bitwise LSL block with shift amount 8 (from a Load Constant). Then connect the shifted result and the low byte to a Bitwise OR block. The output is the combined 16-bit value.

#### Extracting fields
To extract the high byte from a 16-bit value: Connect the 16-bit value to input1 of a Bitwise LSR block, and connect a Load Constant block (value: 8) to input2. The output contains the high byte.

---