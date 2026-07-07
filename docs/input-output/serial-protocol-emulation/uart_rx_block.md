---

## UART RX Op Block

### Purpose

Receives one UART frame using the ENDAT peripheral. Handles only the per-reception work: assert rx_en, poll and accumulate all frame bits, extract data, de-assert rx_en. **The `UART Config` block (with RX Config enabled) must appear earlier in the control flow** to set up the peripheral registers before this block is called.

### Features

- Hardware-accelerated reception using the ICSSG ENDAT peripheral
- Three independent channels (CH0, CH1, CH2)
- Supports frame sizes 3–64 bits (1–62 data bits)
- LSB-first or MSB-first bit order (from UART Config block)
- Configurable oversampling (1x, 2x, 4x, 8x) (from UART Config block)
- No peripheral register writes — fast, suitable for repeated calls in a loop
- 32-bit output for ≤30 data bits; 64-bit output for 31–62 data bits (extended mode)

### Prerequisites

A `UART Config` block with **RX Config enabled** must be placed earlier in the control flow. All RX parameters (channel, baud rate, oversample size, bit order, start bit polarity) are read automatically from that block.

### Configuration

| Parameter | Description | Range |
|-----------|-------------|-------|
| RX Frame Size (bits) | Total bits per frame = data bits + 2 (start + stop) | 3–64 |

All other parameters are inherited from the paired `UART Config` block.

### Frame Size

```
frameSize = dataBits + 2   (1 start bit + N data bits + 1 stop bit)
```

| Protocol | Data Bits | RX Frame Size |
|----------|-----------|---------------|
| Standard UART 8-bit | 8 | 10 |
| UART 16-bit payload | 16 | 18 |
| UART 24-bit payload | 24 | 26 |
| UART 30-bit payload | 30 | 32 |
| UART 31-bit payload (extended) | 31 | 33 |

### Generated Sequence

1. Assert rx_en for the configured channel (R30[24/25/26] for CH0/CH1/CH2)
2. Loop frameSize times: poll valid flag (R31[24/25/26]), read middle oversample bit from R31 byte, clear flag, accumulate into output register
3. Extract data — shift to align, remove start and stop bits, mask to data width
4. De-assert rx_en (R30.b3 = 0x00)

### Output Port

| RX Frame Size | Data Bits | Output Port | Register(s) |
|---------------|-----------|-------------|-------------|
| 3–32 bits | 1–30 bits | 32-bit (output32) | 1 register |
| 33–64 bits | 31–62 bits | 64-bit (output64) | 2 consecutive registers |

- **output1** (32-bit mode): received data word in a single register
- **output1** (64-bit mode): lower 32 bits in the allocated register, upper bits in the next consecutive register

### Oversample Middle Bit Selection

| Oversample | Middle Sample Bit |
|-----------|-------------------|
| 1x | Bit 0 |
| 2x | Bit 0 |
| 4x | Bit 2 |
| 8x | Bit 4 |

### Performance

- ~10 + (frameSize × 5) cycles per reception
- No peripheral register writes overhead — only rx_en assert/de-assert and the bit polling loop

### Important Notes

- **UART Config must appear before UART RX Op** in the control flow
- **All UART RX Op instances must use the same RX Frame Size** — uart_config uses the first instance's value; mismatched instances generate incorrect assembly
- The valid flag (R31[24/25/26]) must be cleared after each bit read to prevent overflow
- rx_en is de-asserted at end of reception to reset counters cleanly for the next frame
- frameSize > 32 activates extended mode — output port becomes 64-bit; downstream blocks must accept 64-bit input

---
