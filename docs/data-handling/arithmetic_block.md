---

## Arithmetic Block

### Purpose

The Arithmetic block performs mathematical operations on two input values. It supports addition and subtraction with optional carry/borrow handling for multi-precision arithmetic.

### Features

- Four arithmetic operations: ADD, ADC, SUB, SUC
- Carry/borrow flag support for extended precision
- Configurable output size
- Two input ports for operands

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Math Operation | The arithmetic operation to perform | ADD, ADC, SUB, SUC |
| Output Size | Size of the result | Maximum of Inputs, 1 byte, 2 bytes, 4 bytes |

### Available Operations

#### Addition (ADD)
- **Operation**: `result = input1 + input2`
- **Description**: Standard addition, ignores carry flag
- **Use case**: General-purpose addition

#### Addition with Carry (ADC)
- **Operation**: `result = input1 + input2 + carry`
- **Description**: Includes carry from previous operation
- **Use case**: Multi-precision arithmetic (adding numbers larger than 32 bits)

#### Subtract (SUB)
- **Operation**: `result = input1 - input2`
- **Description**: Standard subtraction, ignores borrow flag
- **Use case**: General-purpose subtraction

#### Subtract with Borrow (SUC)
- **Operation**: `result = input1 - input2 - borrow`
- **Description**: Includes borrow from previous operation
- **Use case**: Multi-precision subtraction

### Carry/Borrow Flags

The PRU maintains internal carry and borrow flags that are set or cleared by arithmetic operations:

- **Carry flag**: Set when addition overflows, cleared otherwise
- **Borrow flag**: Set when subtraction underflows, cleared otherwise

These flags enable multi-precision arithmetic. For example, to add two 64-bit numbers (A_high:A_low + B_high:B_low):

### Important Notes

- Both inputs must be connected (warning issued if not)
- Output size should accommodate expected result range
- Overflow wraps around (modulo 2^output_size) - no overflow detection
- Input order matters for subtraction: `input1 - input2`

### Example Usage

To add two constant values: Connect a Load Constant block (value: 10) to input1 of an Arithmetic ADD block, and connect another Load Constant block (value: 20) to input2. The output will be 30.

---