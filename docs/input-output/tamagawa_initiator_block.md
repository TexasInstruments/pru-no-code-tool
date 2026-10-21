---

## Tamagawa Initiator Block

### Purpose

The Tamagawa Initiator block interfaces the PRU with Tamagawa absolute rotary encoders. It abstracts serial communication protocol framing and CRC validation, providing real-time absolute rotor position data.

### Features

- Leverages optimized Motor Control (MC) SDK routines (`tamagawa_read_data`)
- Integrates asynchronous serial communication at high baud rates (e.g. 2.5 Mbps)
- Reads absolute position and encoder status fields
- Rejects corrupt communication via automatic frame validation

### Configuration

| Parameter | Description | Default | Options |
|-----------|-------------|---------|---------|
| Baud Rate | Transmission frequency for the serial bus | `2.5M` | `2.5M`, `5M` |
| TX/RX Pins | Physical PRU GPIO signals mapped to the serial transceiver | `GPO5 / GPI5` | Standard GPIO map |
| Data ID | Parameter identifier to query from the encoder | `3` | `3` (position/turns/status) |

### How It Works

The block triggers a transmission transaction. It emits a Data ID query byte over the serial output pin, waits for the transceiver turnaround window, and receives the response frame containing:
- Data ID Echo (1 byte)
- Status Field (1 byte)
- Position Data (3 bytes, 24-bit absolute value)
- CRC verification checksum (1 byte)
The block unpacks the received packet and outputs the verified 24-bit position.

### Important Notes

- Standalone simulations validate frame byte parsing and state calculations, but the high-frequency 2.5 Mbps physical serial line transitions are not modeled in the logic step-simulator.
- The block requires the Motor Control SDK linkage in CCS/gmake during compilation.

### Example Usage

1. Configure the Tamagawa Initiator block with TX/RX pins mapped to your encoder transceiver interface.
2. Configure the Baud Rate to match your encoder specification.
3. Route the output port (`output1`) to a mathematical transform block or Host IPC Shared Memory variables.

---
