---

## UART TX Block (Hardware-Accelerated via ENDAT)

### Purpose

Configures the PRU-ICSS ENDAT peripheral hardware for UART transmission and sends one complete UART frame. The block handles peripheral initialization, frame construction, FIFO loading, and waits for transmission to complete.

### Features

- Hardware-accelerated transmission using the ICSSG ENDAT peripheral
- Up to 32 MHz baud at 192 MHz clock
- Three independent channels (CH0, CH1, CH2)
- 1–62 data bits per frame
- Single-shot mode (1–29 bits) and continuous FIFO mode (30–62 bits)
- LSB-first or MSB-first bit order
- Independent start and stop bit polarity control

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| PRU Selection | PRU core (auto-detected, read-only) | PRU0, PRU1 |
| Channel Selection | ENDAT channel | CH0, CH1, CH2 |
| Clock Source | TX clock source | 192 MHz (UART_CLK), 200 MHz (CORE_CLK) |
| Baud Rate (MHz) | Desired baud rate | Must divide evenly into clock source |
| Start Bit Polarity | Logic level of start bit | 0 (Low), 1 (High) |
| Stop Bit Polarity | Logic level of stop bit | 0 (Low), 1 (High) |
| Bit Swap (LSB First) | Bit order | true (LSB first), false (MSB first) |
| Data Bits | Number of data bits (NOT including start/stop) | 1–62 |

### Clock Divider Calculation

```
clockDivider = (clockSource / baudRate) - 1
```

Example: 192 MHz clock, 12 MHz baud → divider = (192 / 12) - 1 = 15

### Transmission Modes

| Data Bits | Frame Size | Mode | FIFO Strategy |
|-----------|------------|------|---------------|
| 1–29 | 3–31 bits | Single-shot | Pre-load 1–4 bytes, TX GO, wait for busy to clear |
| 30–62 | 32–64 bits | Continuous | Pre-load 4 bytes, TX GO, poll FIFO ≤2 to load remaining |

Frame size = dataBits + 2 (1 start + data bits + 1 stop). Total FIFO bytes = ceil(frameSize / 8).

### How It Works

1. **Global Reinit** (R31 bit 19) — clear FIFO and reset TX/RX state machines
2. **Delay** — 20 NOP cycles
3. **Configure GPCFG** — set peripheral interface mode for the selected PRU
4. **Configure TXCFG** — set clock divider and clock source
5. **Configure CHx_CFG0** — set frame size (single-shot) or 0 (continuous), and bit-swap flag
6. **Select channel** — write channel number to R30[17:16]
7. **Construct frame** — insert start and stop bits around the data, align for MSB/LSB order
8. **Load FIFO** — write bytes to R30[7:0] (each write pushes one byte into the TX FIFO)
9. **Start TX** — set R31 bit 18 (tx_channel_go)
10. **Continuous mode** — poll tx_fifo_sts (R31[4:2] for CH0) and load remaining bytes when FIFO ≤ 2
11. **Wait for completion** — poll tx_global_reinit_active/busy (R31 bit 5/13/21 for CH0/1/2)

### Input Ports

| Port | Used When | Description |
|------|-----------|-------------|
| input1 | Always | Lower 32 bits of data to transmit |
| input2 | dataBits > 32 only | Upper bits of data (continuous mode) |

### Performance

| Mode | Approximate Cycles |
|------|-------------------|
| Single-shot (1–29 bits) | ~25 + numFifoBytes |
| Continuous (30–62 bits) | ~30 + (continuousBytes × 6) |

### Important Notes

- **dataBits** is ONLY the data payload — the block automatically adds start and stop bits
- Frame size = dataBits + 2; total FIFO bytes = ceil(frameSize / 8)
- The ENDAT peripheral is half-duplex — TX and RX cannot operate concurrently on the same channel
- For dataBits > 32, connect two inputs: `input1` for lower 32 bits, `input2` for upper bits
- Standard UART convention: start bit = 0 (Low), stop bit = 1 (High), LSB first

---
