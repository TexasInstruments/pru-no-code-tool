---

## BiSS-C Initiator Block

### Purpose

The BiSS-C Initiator block interfaces with absolute rotary encoders using the BiSS-C synchronous serial protocol. It extracts high-resolution position feedback for closed-loop motion control.

### Features

- Emits synchronous clock pulses (MA) and samples input serial data (SLO)
- Integrates pre-compiled Motor Control SDK assembly routines (`bissc_read_data`)
- Performs 6-bit Cyclic Redundancy Check (CRC) verification using polynomial $0x43$ ($x^6 + x^1 + 1$)
- Accommodates frame data lengths up to 32 bits

### Configuration

| Parameter | Description | Default | Options |
|-----------|-------------|---------|---------|
| Clock Frequency | Clock frequency output on the MA line | `5MHz` | `1MHz`, `2.5MHz`, `5MHz` |
| CLK / DATA Pins | Physical PRU pins assigned to MA (output) and SLO (input) | `GPO0 / GPI1` | Standard GPIO map |
| Data Length | Expected bit-width of the position frame | `32` | `16`, `24`, `32` |

### How It Works

The block runs a synchronous serial shift loop:
1. Generates clock cycles on the MA pin.
2. Shifts incoming bits from the SLO pin into a register.
3. Decodes the frame structure: Ack (0), Start (1), CDS (0), Position Bits, Error/Warning, and CRC-6 checksum.
4. Performs CRC validation over the payload. If validation succeeds, outputs the position.

### Important Notes

- In the simulator, the CRC-6 calculation is verified against known-good reference vectors injected via the R31 input history.
- Physical propagation delay compensation parameters (for long cable runs) require SDK-level register setup outside the No-Code tool.

### Example Usage

To gather absolute position data:
1. Place a BiSS-C block in the diagram.
2. Assign the CLK and DATA pins corresponding to the physical wiring.
3. Connect the output of the block to the Feedback port of a PID block or an IPC Shared Memory block.

---
