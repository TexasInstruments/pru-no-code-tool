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

### CS Idle Level, Fixed Timing Overhead and Program Memory

**CS is driven to its idle (HIGH) level once per entry into the generated code: at program start and at every group start.** R30 resets to 0, so without help the CS pin would be LOW until the first transaction released it, and that first transaction would have no assertion edge. The generated program therefore starts with one `set r30, r30, <CS pin>` per distinct controller-mode CS pin (the same prologue that programs CTPPR0 for c28 users, emitted after `sysconfig_generated_start:` and at every group start), so you do not need a separate PRU GPO block to idle CS. It costs one cycle per CS pin once per entry into the generated code and nothing per transaction: the fixed overhead below is unchanged. Measured on the TI pru-simulator running the real clpru ELF (16-bit packet, MODE0, CS = bit 5, no GPO block in the design): CS rises at cycle 2 (idle level), falls at cycle 4 (assertion) and rises at release. Without the prologue only the release rise was seen. Peripheral-mode blocks sample CS on R31 and never drive it. If a design shares one CS pin between several SPI blocks it is set once.

**Fixed overhead.** CS Setup Time and CS Hold Time add exactly ceil(ns x MHz / 1000) PRU cycles on top of a fixed instruction overhead (one nop per cycle, no loop overhead). Measured on the TI pru-simulator with 0 ns / 0 ns (CS assertion to the first SCLK edge, last SCLK edge to CS release; identical for 8, 16 and 32 bit packets):

| SPI Mode | CS assert -> first SCLK edge | last SCLK edge -> CS release |
|----------|------------------------------|------------------------------|
| MODE0, MODE2 | +6 | +3 |
| MODE1, MODE3 | +2 | +7 |

A configured time is therefore a minimum: the real gap is the overhead plus the converted cycles.

**Limits.** CS Setup Time and CS Hold Time are each one delay site and each convert to at most **256 PRU cycles** (1 KB of program memory); more is a validation error (1300 ns at 200 MHz is 260 cycles). Data Setup Time (0-10000 ns) is counted inside the SCLK half it precedes, so it adds no cycles and no program memory; validation requires that half to cover its fixed overhead plus Data Setup Time. The SCLK high / low pulse widths are not capped but every cycle of them is also a nop.

**Program memory (IRAM).** Every delay cycle is one 4-byte instruction. A controller block with both CS times at the cap (1280 ns at 200 MHz) and 100-cycle SCLK pulses links to about 2.9 KB of `.text` (2,888 bytes measured for a design of that block, a Load Constant and a PRU GPO; 2,888-2,904 across read / write / transfer and the four SPI modes, whatever the Data Setup Time); a PRU core has 12 KB, and six such blocks (17,228-17,300 bytes) overflow it (linker error #10099-D). In peripheral mode the CS Filter Cycles setting is a delay too: the glitch filter is unrolled at two sites, 8 bytes per filter cycle and block (255 cycles is about 2.1 KB; six such blocks link to 12,684 bytes and overflow). Validation warns when the estimated IRAM of all `pru_spi_*` blocks in the design exceeds 12 KB (when the peripheral CS Filter Cycles loops alone push it over, the warning says to lower CS Filter Cycles instead of quoting the controller-mode CS Setup / Hold, Data Setup and SCLK advice); the estimate is an upper bound for the SPI blocks only (other blocks of the design are not counted), so the linker stays the final check. How tight the bound is, per block: controller blocks are within 5% of the linked .text. For the peripheral modes it depends on CS Filter Cycles: at 100 or more, peripheral transfer is within 5% and peripheral read and write are the loosest at 1.07-1.08x (within 10%); at small filters the estimate is conservative, up to about 2x over, because the fixed body is rounded up while the filter contributes little (estimate / linked .text for read / write / transfer: filter 1 = 2.20x / 2.05x / 1.39x, filter 2 (the default) = 2.04x / 1.92x / 1.35x, filter 10 = 1.52x / 1.47x / 1.21x, filter 30 = 1.23x / 1.21x / 1.11x). It never under-estimates. CS Filter Cycles has a minimum of 1, so if the design still overflows with every filter at 1 the warning advises shortening the controller-mode widths instead.

**Release note.** CS Setup Time and CS Hold Time were previously emitted as raw numbers of PRU cycles; they are now nanoseconds converted to cycles (rounded up). At 200 MHz the defaults of this block (35 ns setup, 10 ns hold) now emit 7 and 2 cycles instead of 35 and 10. Designs that relied on the old longer gaps must raise the times. (The repository has no changelog file; release notes for this block live here.)

### Important Notes

- MODE2 and MODE3 initialize SCLK to HIGH before asserting CS
- CS Setup and Hold Times are in **nanoseconds**, auto-converted to PRU cycles based on PRU clock in Simulation Settings
- Requires an input connection (`input1`) for transmit data
- Output (`output1`) provides the received data

---
