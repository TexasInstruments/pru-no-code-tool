---

## PRU SPI Write Block

### Purpose

Implements SPI (Serial Peripheral Interface) protocol to **transmit** data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins. This is a terminating block — it has no output port.

### Features

- Controller and Peripheral device modes
- All four SPI modes (MODE0–MODE3)
- Packet sizes 8–32 bits
- MSB-first or LSB-first bit order
- Configurable CS setup/hold times and data setup time (Controller)
- CS glitch filter (Peripheral)
- Calculated SPI clock frequency display
- Terminating block — no output data connection

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| Device Mode | SPI role | Controller, Peripheral |
| SPI Mode | Clock polarity and phase | MODE0, MODE1, MODE2, MODE3 |
| Packet Size | Number of bits to write | 8–32 |
| Endianness | Bit order | MSB first, LSB first |
| SCLK Signal | Clock pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SDO Signal | Data output pin | GPO 0–19 |
| CS Signal | Chip select pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SCLK High Width | Clock HIGH duration (Controller) | PRU cycles (mode-dependent minimum) |
| SCLK Low Width | Clock LOW duration (Controller) | PRU cycles (mode-dependent minimum) |
| CS Setup Time | Delay after CS assertion (Controller) | 0–10000 ns |
| CS Hold Time | Delay before CS deassertion (Controller) | 0–10000 ns |
| Data Setup Time | Extra data hold time after clock edge (Controller) | 0–100 PRU cycles |
| CS Filter Cycles | CS glitch rejection (Peripheral) | 1–0xFFFFFFFF |

### SPI Modes

| Mode | CPOL | CPHA | Clock Idle | Shifting Edge |
|------|------|------|-----------|---------------|
| MODE0 | 0 | 0 | LOW | Falling |
| MODE1 | 0 | 1 | LOW | Rising |
| MODE2 | 1 | 0 | HIGH | Rising |
| MODE3 | 1 | 1 | HIGH | Falling |

### Minimum SCLK Widths (Controller, at 200 MHz PRU clock)

| Mode | Min High | Min Low | Theoretical Max Frequency (zero delay compensation) | Practical Max Frequency |
|------|----------|---------|---------------|---------------|
| MODE0 | 2 | 6 | 25.00 MHz | 25.00 MHz |
| MODE1 | 4 | 3 | 28.57 MHz | 25.00 MHz |
| MODE2 | 6 | 1 | 28.57 MHz | 25.00 MHz |
| MODE3 | 3 | 4 | 28.57 MHz | 25.00 MHz |

**Note**: The theoretical column assumes zero delay compensation (d1=0, d2=0) and ideal peripheral response — not achievable in practice for MODE1–3. The practical column uses d1=0, d2=1 (8 cycles/bit total). See "Maximum Achievable Frequency" in the block's `getAIContext()`/long description for the full breakdown.

### How It Works

**Controller Mode:**
1. Assert CS (wait CS Setup Time)
2. For each bit: output bit on SDO, generate SCLK pulse (data shifts on the mode's shifting edge)
3. After all bits, wait CS Hold Time then deassert CS

**Peripheral Mode:**
1. Wait for CS assertion (filtered by CS Filter Cycles)
2. Follow controller's SCLK — output each bit on SDO synchronized to the mode's shifting edge

### Pin Assignment by Mode

| Signal | Controller | Peripheral |
|--------|-----------|-----------|
| SCLK | Output (GPO) | Input (GPI) |
| SDO | Output (GPO) | Output (GPO) |
| CS | Output (GPO) | Input (GPI) |

All three pins must be unique.

### Important Notes

- MODE2 and MODE3 initialize SCLK to HIGH (idle state) before asserting CS
- CS Setup and Hold Times are in **nanoseconds**, auto-converted to PRU cycles based on PRU clock frequency in Simulation Settings
- Requires an input connection — connect a Load Constant or other data source to `input1`
- This is a **terminating block** — no output port

---
