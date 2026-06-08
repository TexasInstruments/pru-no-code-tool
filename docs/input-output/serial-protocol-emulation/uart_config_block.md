---

## UART Config Block

### Purpose

Configures the PRU-ICSS ENDAT peripheral for UART TX, RX, or both. Run this block **once at init** before any `UART TX Op` or `UART RX Op` blocks. A single Global Reinit covers both TX and RX setup. Only one instance of this block is allowed per design.

### Features

- Combined TX + RX peripheral configuration in a single block
- TX and RX can use **different channels** (e.g. TX on CH0, RX on CH2)
- Independently enable TX Config, RX Config, or both
- Configurable baud rate, clock source, bit order, start/stop polarity
- RX: configurable oversampling (1x, 2x, 4x, 8x) for noise immunity
- TX: auto-detects single-shot vs continuous mode from the paired `UART TX Op` block
- Only one instance allowed per design (`maxInstances: 1`)

### Configuration

#### Common

| Parameter | Description | Options |
|-----------|-------------|---------|
| PRU Selection | PRU core (auto-detected, read-only) | PRU0, PRU1 |
| Enable TX Config | Show and apply TX configuration | true / false |
| Enable RX Config | Show and apply RX configuration | true / false |

At least one of TX or RX must be enabled.

#### TX Parameters (visible when Enable TX Config = true)

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| TX Channel | ENDAT channel for TX | CH0, CH1, CH2 |
| TX Clock Source | TX oversample clock | 192 MHz (UART_CLK), 200 MHz (CORE_CLK) |
| TX Baud Rate (MHz) | Desired TX baud rate | Must divide evenly into clock source |
| TX Clock Divider | Calculated divider (read-only) | (clockSource / baudRate) - 1 |
| TX Start Bit Polarity | Logic level of TX start bit | 0 (Low/Space), 1 (High/Mark) |
| TX Stop Bit Polarity | Logic level of TX stop bit | 0 (Low/Space), 1 (High/Mark) |
| TX Bit Swap (LSB First) | Bit transmission order | true (LSB first), false (MSB first) |
| TX Mode | Derived from UART TX Op's Data Bits (read-only) | Single-shot (≤29 bits), Continuous (≥30 bits) |

#### RX Parameters (visible when Enable RX Config = true)

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| RX Channel | ENDAT channel for RX | CH0, CH1, CH2 |
| RX Clock Source | RX oversample clock | 192 MHz (UART_CLK), 200 MHz (CORE_CLK) |
| RX Baud Rate (MHz) | Desired RX baud rate | Must divide evenly into (clock / oversample) |
| RX Clock Divider | Calculated divider (read-only) | (clockSource / (baudRate × oversample)) - 1 |
| RX Oversample Size | Samples per bit | 1x, 2x, 4x, 8x |
| RX Start Bit Polarity | Edge that triggers frame start | Falling Edge (0), Rising Edge (1) |
| RX Bit Swap (LSB First) | Bit reception order | true (LSB first), false (MSB first) |

### Clock Divider Calculations

**TX:**
```
txClockDivider = (clockSource / baudRate) - 1
```
Example: 192 MHz clock, 12 MHz baud → divider = (192 / 12) - 1 = 15

**RX:**
```
rxClockDivider = (clockSource / (baudRate × oversample)) - 1
```
Example: 192 MHz clock, 12 MHz baud, 8x oversample → divider = (192 / 96) - 1 = 1

### Generated Sequence

1. Global Reinit (R31 bit 19) FIRST — flushes FIFO and state machines (TRM-mandated: reinit before de-asserting rx_en)
2. Poll busy bit (R31 bit 5) — deterministic wait for reinit completion
3. De-assert rx_en (R30.b3 = 0x00) AFTER reinit — handles stuck rx_en from a previous run
4. GPCFG write — enables peripheral interface mode (once, shared by TX and RX)
5. *(if TX enabled)* TXCFG write, TX CH_CFG0 write (frame size + bit-swap), R30.w2 channel select + clk_mode=1
6. *(if RX enabled)* RXCFG write (clock divider, clock source, oversample, start bit polarity), RX CH_CFG0 write (frame size + bit-swap)

### Ports

This block has no data input or output ports — it only has `prev` and `next` control flow ports.

### Performance

~20 cycles for full peripheral configuration (TX + RX).

### Important Notes

- Only **one instance** of this block is allowed per design
- **Must appear before** any `UART TX Op` or `UART RX Op` blocks in the control flow
- RX frame size is read from the first `UART RX Op` instance's `RX Frame Size` setting
- TX data bits (used for TX_FRAME_SIZE / mode selection) are read from the first `UART TX Op` instance's `Data Bits` setting
- TX and RX can operate on different channels simultaneously (e.g. TX on CH0, RX on CH2)
- GPCFG is written once regardless of TX-only, RX-only, or both configurations

---
