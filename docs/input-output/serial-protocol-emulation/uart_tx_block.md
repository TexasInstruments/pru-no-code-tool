---

## UART TX Op Block

### Purpose

Transmits one UART frame using the ENDAT peripheral. Handles only the per-transmission work: per-command reinit, frame construction, FIFO loading, start trigger, and wait for TX complete. **The `UART Config` block (with TX Config enabled) must appear earlier in the control flow** to set up the peripheral registers before this block is called.

### Features

- Hardware-accelerated transmission using the ICSSG ENDAT peripheral
- Three independent channels (CH0, CH1, CH2)
- 1–62 data bits per frame
- Single-shot mode (1–29 bits) and continuous FIFO mode (30–62 bits)
- LSB-first or MSB-first bit order (from UART Config block)
- Independent start and stop bit polarity control (from UART Config block)
- No peripheral register writes — only per-command reinit, frame construction, FIFO load, TX trigger

### Prerequisites

A `UART Config` block with **TX Config enabled** must be placed earlier in the control flow. All TX parameters (channel, baud rate, bit order, start/stop polarity) are read automatically from that block.

### Configuration

| Parameter | Description | Range |
|-----------|-------------|-------|
| Data Bits | Number of data payload bits (excluding start and stop bits) | 1–62 |

All other parameters are inherited from the paired `UART Config` block.

### Transmission Modes

| Data Bits | Frame Size | Mode | FIFO Strategy |
|-----------|------------|------|---------------|
| 1–29 | 3–31 bits | Single-shot | Pre-load 1–4 bytes, TX GO, wait for busy to clear |
| 30–32 | 32–34 bits | Specific-bit | 4 bytes pre-load + byte 5 via continuous polling (if needed) |
| 33–62 | 35–64 bits | Continuous | 4 bytes pre-load, TX GO, poll FIFO ≤2 to load remaining bytes |

Frame size = dataBits + 2. Total FIFO bytes = ceil(frameSize / 8).

### Generated Sequence

1. Per-command reinit (R31 bit 19) — clears FIFO and state machines (TRM-mandated order: reinit before de-asserting rx_en)
2. Poll reinit busy bit (R31[5/13/21] for CH0/CH1/CH2)
3. De-assert rx_en (R30.b3 = 0x00)
4. Channel select + clk_mode write to R30.w2
5. Frame construction — insert start bit, shift data bits, insert stop bit (LSB or MSB order)
6. FIFO load — 1–4 bytes for single-shot (dataBits ≤ 29); 4 bytes + continuous polling for dataBits 30–32; 4 bytes + byte 5+ polling for dataBits 33–62
7. Start transmission (R31 bit 18 = tx_channel_go)
8. Wait for TX complete (poll R31[5/13/21] busy bit)

### Input Port

| Data Bits | Input Port | Register(s) |
|-----------|------------|-------------|
| 1–32 bits | 32-bit (input32) | 1 register |
| 33–62 bits | 64-bit (input64) | 2 consecutive registers |

- **input1** (32-bit mode): data word to transmit in a single register
- **input1** (64-bit mode): lower 32 bits in the allocated register, upper bits in the next consecutive register

### Common Data Bit Configurations

| Protocol | Data Bits | Frame Bits | Mode |
|----------|-----------|------------|------|
| Standard UART 8-bit | 8 | 10 | Single-shot |
| 16-bit payload | 16 | 18 | Single-shot |
| 24-bit payload | 24 | 26 | Single-shot |
| 29-bit payload (max single-shot) | 29 | 31 | Single-shot |
| 30-bit payload | 30 | 32 | Specific-bit |
| 32-bit payload | 32 | 34 | Specific-bit |
| 33-bit payload | 33 | 35 | Continuous |

### Performance

- Single-shot (1–29 bits): ~6 + numFifoBytes cycles
- Continuous (30–62 bits): ~15 + (continuousBytes × 6) cycles

### Important Notes

- **UART Config must appear before UART TX Op** in the control flow
- **All UART TX Op instances must use the same Data Bits value** — uart_config uses the first instance's value for TX_FRAME_SIZE; mismatched instances generate incorrect assembly
- **dataBits** is only the data payload — start and stop bits are added automatically
- dataBits > 32 activates continuous mode — input port becomes 64-bit; the upstream data source block must produce a 64-bit output
- Standard UART convention: start bit = 1 (High/Mark), stop bit = 0 (Low/Space), LSB first

---
