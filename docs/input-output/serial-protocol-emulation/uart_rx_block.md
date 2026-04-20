---

## UART RX Block (Hardware-Accelerated via ENDAT)

### Purpose

Configures the PRU-ICSS ENDAT peripheral hardware for UART reception and receives one complete UART frame. The block handles peripheral initialization, start-bit detection, oversampled bit collection, frame extraction, and outputs the received data.

### Features

- Hardware-accelerated reception using the ICSSG ENDAT peripheral
- Up to 12 Mbaud at 192 MHz clock with 8x oversample
- Three independent channels (CH0, CH1, CH2)
- Configurable oversampling (1x, 2x, 4x, 8x)
- LSB-first or MSB-first bit order
- Configurable start bit polarity
- Frame sizes 3–32 bits (1–30 data bits)

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| PRU Selection | PRU core (auto-detected, read-only) | PRU0, PRU1 |
| Channel Selection | ENDAT channel | CH0, CH1, CH2 |
| Clock Source | RX oversample clock source | 192 MHz (UART_CLK), 200 MHz (CORE_CLK) |
| Baud Rate (MHz) | Desired baud rate | Must divide evenly into (clock / oversample) |
| Oversample Size | Samples per bit | 1x, 2x, 4x, 8x |
| Start Bit Polarity | Edge that triggers frame start | Falling Edge (0), Rising Edge (1) |
| Frame Size (bits) | Total bits including start + stop | 3–32 |
| Bit Swap (LSB First) | Bit order | true (LSB first), false (MSB first) |

### Clock Divider Calculation

```
clockDivider = (clockSource / (baudRate × oversample)) - 1
```

Example: 192 MHz clock, 12 MHz baud, 8x oversample → divider = (192 / 96) - 1 = 1

### Valid Baud Rates (for 192 MHz, 8x oversample)

| Baud Rate | Clock Divider |
|-----------|---------------|
| 24 MHz | 0 |
| 12 MHz | 1 |
| 8 MHz | 2 |
| 6 MHz | 3 |
| 4 MHz | 5 |
| 3 MHz | 7 |
| 2 MHz | 11 |
| 1 MHz | 23 |

### Frame Size

```
frameSize = dataBits + 2   (1 start bit + N data bits + 1 stop bit)
```

Standard UART 8-bit: frameSize = 10

### How It Works

1. **Global Reinit** (R31 bit 19) — assert reinit first to clear TX/RX state machines
2. **Delay** — 20 NOP cycles to let reinit settle
3. **De-assert rx_en** — clear R30[26:24] after reinit has settled (TRM sequence)
4. **Configure GPCFG** — set peripheral interface mode for the selected PRU
5. **Configure RXCFG** — set clock divider, clock source, oversample size, start bit polarity
6. **Configure CHx_CFG0** — set frame size and bit order
7. **Assert rx_en** — enable the selected channel (R30 bit 24/25/26)
8. **Bit accumulation loop** — poll valid flag (R31[26:24]), read oversampled byte, extract middle sample, accumulate bits
9. **Data extraction** — remove start and stop bits, align data to bit 0
10. **Disable rx_en** — clear R30[26:24] after reception (TRM step 7 — resets all counters/flags)

### Output Port

- **output1**: Received data (4 bytes for ≤30 data bits)

### Oversample and Middle Bit Selection

| Oversample | Middle Sample Bit |
|-----------|-----------------|
| 1x | Bit 0 |
| 2x | Bit 0 |
| 4x | Bit 2 |
| 8x | Bit 4 |

### Performance

- ~25–30 cycles for peripheral configuration
- Variable reception time depending on baud rate and frame size
- Each bit: poll valid flag + read + clear + accumulate (~5–10 cycles per bit)
- Typical 10-bit frame: ~50–100 cycles total

### Important Notes

- The ENDAT peripheral is half-duplex — TX and RX cannot operate concurrently on the same channel
- Global reinit clears all pending RX data — any frame in progress is lost
- The valid flag (R31[26/25/24]) must be cleared after each bit read to prevent overflow
- rx_en is cleared at end of reception to reset counters cleanly for the next frame

---
