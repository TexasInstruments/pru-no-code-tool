---

## Hardware MAC Block (Multiply-Accumulate)

### Purpose

The Hardware MAC block utilizes the PRU's dedicated hardware Multiply-Accumulate (MAC) peripheral. It offloads 32-bit mathematical multiplication and accumulation from the main ALU, which is essential for execution speed in high-frequency motor control loops.

### Features

- 32-bit signed and unsigned multiplication with 64-bit accumulation
- Mapped directly to broadside coprocessor registers (`XIN`/`XOUT`)
- Standard 7-cycle execution latency under simulation
- High-efficiency execution bypassing main instruction ALU pipeline limits

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Operand A | The first multiplier input operand (R28 / TEMP_REG1) | Connected input port |
| Operand B | The second multiplier input operand (R29 / TEMP_REG2) | Connected input port |
| Accumulator | Optional value to be added to the multiplication product | Connected input port |
| Mode | Unsigned or Signed multiplication mode | `Signed`, `Unsigned` |

### How It Works

The block maps the two multiplier inputs to broadside coprocessor registers and triggers the hardware MAC calculation. The result is accumulated into a 64-bit internal register:
$$\text{Result} = (\text{Operand A} \times \text{Operand B}) + \text{Accumulator}$$
The result is then retrieved via `XIN` or standard broadside register read cycles.

### Important Notes

- Operands are loaded into standard temp registers (`TEMP_REG1` and `TEMP_REG2`) before triggering the hardware multiplier.
- The MAC multiplier widget executes in parallel with the PRU ALU; however, read/write stalls may occur if the result is read too early (the generator automatically inserts the necessary clock cycles/NOPs to ensure alignment).

### Example Usage

To compute a scaled feedback correction:
1. Connect a control error signal to `input1` (Operand A).
2. Connect a scaling gain constant to `input2` (Operand B).
3. Connect a bias offset value to `input3` (Accumulator).
The output will emit the combined, scaled correction value.

---
