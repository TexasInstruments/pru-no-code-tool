---

## BiSS-C Initiator Block

### Purpose

The BiSS-C Initiator block clocks a BiSS-C encoder's MA line from a PRU output pin and shifts the SLO data line into a 32-bit result register.

### Features

- Drives the MA clock on one R30 pin and samples SLO on one R31 pin
- Shifts `Data Length` bits (1 to 32), MSB first, into the output register
- MA idles high between frames

### Configuration

| Parameter | Description | Default | Range |
|-----------|-------------|---------|-------|
| CLK Pin | PRU output pin driving MA | `0` | 0-19 |
| DATA Pin | PRU input pin sampling SLO | `1` | 0-19, different from CLK Pin |
| Data Length | Number of bits shifted into the result | `32` | 1-32 |

### How It Works

For each bit the block pulls MA low, waits one instruction, drives MA high and samples SLO into the least significant bit of the result after shifting it left. The bit period is fixed by the instruction sequence (8 PRU cycles in the TI pru-simulator).

### Important Notes

- This is a shift register only. It does not handle the BiSS-C start/ACK/CDS bits, does not check the CRC-6, has no timeout, and the clock frequency is not configurable.
- Not validated on hardware; propagation-delay compensation for long cables is not implemented.
- SysConfig reports an error when Data Length is outside 1-32, when a pin is outside 0-19, or when CLK and DATA use the same pin.

### Example Usage

1. Place a BiSS-C Initiator block in the diagram.
2. Assign the CLK and DATA pins to match the wiring.
3. Connect the block's output to a block that consumes the raw frame, for example an IPC Shared Memory block.

---
