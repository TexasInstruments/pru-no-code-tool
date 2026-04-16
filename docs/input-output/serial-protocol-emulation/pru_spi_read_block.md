---

## PRU SPI Read Block

### Purpose

Implements SPI (Serial Peripheral Interface) protocol to **receive** data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins.

### Features

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
| Packet Size | Number of bits to read | 8–32 |
| Endianness | Bit order | MSB first, LSB first |
| SCLK Signal | Clock pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SDI Signal | Data input pin | GPI 0–19 |
| CS Signal | Chip select pin | GPO 0–19 (Controller) / GPI 0–19 (Peripheral) |
| SCLK High Width | Clock HIGH duration (Controller) | PRU cycles (mode-dependent minimum) |
| SCLK Low Width | Clock LOW duration (Controller) | PRU cycles (mode-dependent minimum) |
| CS Setup Time | Delay after CS assertion (Controller) | 0–10000 ns |
| CS Hold Time | Delay before CS deassertion (Controller) | 0–10000 ns |
| Data Setup Time | Extra delay after clock edge before sampling (Controller) | 0–100 PRU cycles |
| CS Filter Cycles | CS glitch rejection (Peripheral) | 1–0xFFFFFFFF |

### SPI Modes

| Mode | CPOL | CPHA | Clock Idle | Sampling Edge |
|------|------|------|-----------|---------------|
| MODE0 | 0 | 0 | LOW | Rising |
| MODE1 | 0 | 1 | LOW | Falling |
| MODE2 | 1 | 0 | HIGH | Falling |
| MODE3 | 1 | 1 | HIGH | Rising |

### Minimum SCLK Widths (Controller, at 200 MHz PRU clock)

| Mode | Min High | Min Low | Max Frequency |
|------|----------|---------|---------------|
| MODE0 | 4 | 3 | 28.57 MHz |
| MODE1 | 1 | 6 | 28.57 MHz |
| MODE2 | 3 | 4 | 28.57 MHz |
| MODE3 | 6 | 1 | 28.57 MHz |

### How It Works

**Controller Mode:**
1. Assert CS (wait CS Setup Time)
2. Generate SCLK pulses — on each sampling edge, read SDI and store the bit
3. After all bits, wait CS Hold Time then deassert CS

**Peripheral Mode:**
1. Wait for CS assertion (filtered by CS Filter Cycles)
2. Follow controller's SCLK — sample SDI on the mode's sampling edge for each bit
3. Output the assembled word

### Pin Assignment by Mode

| Signal | Controller | Peripheral |
|--------|-----------|-----------|
| SCLK | Output (GPO) | Input (GPI) |
| SDI | Input (GPI) | Input (GPI) |
| CS | Output (GPO) | Input (GPI) |

All three pins must be unique.

### Setup and Hold Times

CS Setup Time and CS Hold Time are in **nanoseconds**, automatically converted to PRU cycles based on the PRU Clock Frequency in Simulation Settings. Data Setup Time is in PRU cycles and adds extra delay after the clock edge before sampling — useful for slow peripherals.

### Simulating Input Data

Use Simulation Settings to simulate SDI without hardware:
1. Select the SDI pin in "Select R31 (Input) Signals"
2. Configure Timestamp or Pattern Mode
3. Set transitions to align with the expected sampling edges for your chosen SPI mode and SCLK timing

---
