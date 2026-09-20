---

## PRU SPI Transfer Block

### Purpose

Implements full-duplex SPI (Serial Peripheral Interface) in both Controller and Peripheral modes. Simultaneously transmits and receives data in a single transaction using bit-banging on PRU GPIO pins.

### Features

- Full-duplex: sends and receives data simultaneously
- Controller and Peripheral device modes
- All four SPI modes (MODE0–MODE3)
- Packet sizes 8–32 bits
- MSB-first or LSB-first bit order
- Configurable CS setup/hold times and data setup time (Controller)
- CS glitch filter (Peripheral)
- Calculated SPI clock frequency display

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| Device Mode | SPI role | Controller, Peripheral |
| SPI Mode | Clock polarity and phase | MODE0, MODE1, MODE2, MODE3 |
| Packet Size | Number of bits per transfer | 8–32 |
| Endianness | Bit order | MSB first, LSB first |
| SCLK Signal | Clock pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SDI Signal | Data input pin | GPI 0–19 |
| SDO Signal | Data output pin | GPO 0–19 |
| CS Signal | Chip select pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SCLK High Width | Clock HIGH duration (Controller) | PRU cycles (mode-dependent minimum) |
| SCLK Low Width | Clock LOW duration (Controller) | PRU cycles (mode-dependent minimum) |
| CS Setup Time | Delay after CS assertion (Controller) | 0–10000 ns |
| CS Hold Time | Delay before CS deassertion (Controller) | 0–10000 ns |
| Data Setup Time | Extra delay after clock edge (Controller) | 0–100 PRU cycles |
| CS Filter Cycles | CS glitch rejection (Peripheral) | 1–0xFFFFFFFF |

### SPI Modes

| Mode | CPOL | CPHA | Clock Idle | Shifting Edge | Sampling Edge |
|------|------|------|-----------|---------------|---------------|
| MODE0 | 0 | 0 | LOW | Falling | Rising |
| MODE1 | 0 | 1 | LOW | Rising | Falling |
| MODE2 | 1 | 0 | HIGH | Rising | Falling |
| MODE3 | 1 | 1 | HIGH | Falling | Rising |

### Minimum SCLK Widths (Controller, at 200 MHz PRU clock)

| Mode | Min High | Min Low | Theoretical Max Frequency (zero delay compensation) | Practical Max Frequency |
|------|----------|---------|---------------|---------------|
| MODE0 | 4 | 6 | 20.00 MHz | 7.69 MHz |
| MODE1 | 2 | 6 | 25.00 MHz | 7.69 MHz |
| MODE2 | 6 | 4 | 20.00 MHz | 7.69 MHz |
| MODE3 | 6 | 2 | 25.00 MHz | 7.69 MHz |

**Note**: The theoretical column assumes zero delay compensation (d1=0, d2=0) and ideal peripheral response — not achievable in practice. The practical column uses d1=9, d2=7 (26 cycles/bit total) for PRU-to-PRU loopback. See "Maximum Achievable Frequency" in the block's `getAIContext()`/long description for the full breakdown.

### How It Works

**Controller Mode:**
1. Assert CS (wait CS Setup Time)
2. For each bit: output bit on SDO on the shifting edge, sample SDI on the sampling edge
3. After all bits, wait CS Hold Time then deassert CS
4. Output holds the received word

**Peripheral Mode:**
1. Wait for CS assertion (filtered by CS Filter Cycles)
2. Follow controller's SCLK — output SDO on shifting edge, sample SDI on sampling edge concurrently

### Pin Assignment by Mode

| Signal | Controller | Peripheral |
|--------|-----------|-----------|
| SCLK | Output (GPO) | Input (GPI) |
| SDI | Input (GPI) | Input (GPI) |
| SDO | Output (GPO) | Output (GPO) |
| CS | Output (GPO) | Input (GPI) |

All four pins must be unique.

### Full-Duplex Timing Note

The peripheral must output its response data quickly enough after detecting the shifting edge for the controller to sample it on the sampling edge. If receiving corrupted data, increase the SCLK pulse width on the side that gives the peripheral more response time:
- MODE1/MODE3: Increase SCLK Low Width
- MODE0/MODE2: Increase SCLK High Width

### Important Notes

- MODE2 and MODE3 initialize SCLK to HIGH before asserting CS
- CS Setup and Hold Times are in **nanoseconds**, auto-converted to PRU cycles based on PRU clock in Simulation Settings
- Requires an input connection (`input1`) for transmit data
- Output (`output1`) provides the received data

---
