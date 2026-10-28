## UART RX Op (Per-Reception Operation)

### Purpose
Receives one UART frame using the ENDAT peripheral. This block handles only the
per-reception work: assert rx_en, poll and accumulate all frameSize bits,
extract data, de-assert rx_en. **The `UART Config` block (with RX Config enabled)
must appear earlier in the control flow** to set up the peripheral registers before
this block is called.

### Generated Sequence
1. Assert rx_en for the configured channel (R30[26/25/24] for CH2/CH1/CH0)
2. Loop frameSize times: poll valid flag (R31[26/25/24]), read middle oversample bit from R31 byte, clear flag, accumulate into output register
3. Extract data — shift to align, remove start and stop bits, mask to data width
4. De-assert rx_en (R30.b3 = 0x00)

### No Peripheral Register Writes
No GPCFG, RXCFG, or CH_CFG0 writes — those are handled once by `UART Config`.
This means the op block is fast and suitable for repeated calls in a loop.

### Output Port
The output register size depends on the configured RX Frame Size:

| Frame Size | Data Bits | Output Port Type | Register(s) |
|------------|-----------|------------------|-------------|
| 3–32 bits  | 1–30 bits | **32-bit** (output32) | 1 register (Rx) |
| 33–64 bits | 31–62 bits | **64-bit** (output64) | 2 registers (Rx:Rx+1) |

- **output1** (32-bit mode): received data word in a single dynamically allocated register
- **output1** (64-bit mode): received data in two consecutive registers — lower 32 bits in the allocated register, upper bits in the next register

### Configuration
All parameters are automatically read from the paired `UART Config` block — no
duplicate settings needed here. Only `RX Frame Size` is set on this block directly,
since it determines the output port type (32-bit vs 64-bit) which the register
allocator needs to know at design time.

### RX Frame Size
- Total bits per frame = data bits + 2 (start bit + stop bit)
- Standard UART 8-bit: frameSize = 10
- 16-bit payload: frameSize = 18
- frameSize > 32 activates extended mode (two output registers, 64-bit output port)

### Calculation Example
- UART Config: 192 MHz clock, 12 MHz baud, 8x oversample
- RX Clock = 192 / (clockDiv+1) = 192 / 2 = 96 MHz
- Baud Rate = 96 MHz / 8 = 12 MHz ✓
- frameSize = 18 → 16 data bits → 32-bit output port (fits in one register)

### Terminology
- **Valid Flag**: R31 status bit set by hardware when an oversampled bit is ready to read
- **Middle Sample**: For 8x oversample the middle sample is bit 4 of the 8-sample window — most noise-immune point
- **Extended Mode**: frameSize ≥ 33 → data bits ≥ 31 → requires two consecutive output registers
- **rx_en**: R30[26:24] — enables reception on the selected channel; asserting it starts the hardware

---

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the UART RX Op block in a .syscfg file.

**CRITICAL**: The UART RX Op block requires a paired `UART Config` block with RX enabled.
The op block reads all RX parameters (channel, baud rate, oversample, bit order, start bit polarity)
from the config block automatically. Only `rxFrameSize` is set on the op block itself.

### Step 1 — Add and configure a UART Config block (RX enabled)

```javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();
uart_config1.$name    = "PRU_UART_CONFIG_0";
uart_config1.enableTX = false;         // TX-only or TX+RX — set as needed
uart_config1.enableRX = true;
uart_config1.rxChannel         = 2;    // Channel 2 (GPI11 = PERIF2_IN)
uart_config1.rxClockSource     = 0;    // 192 MHz (UART_CLK)
uart_config1.rxBaudRate        = 12;   // 12 MHz
uart_config1.rxOversampleSize  = 7;    // 8x oversample
uart_config1.rxStartBitPolarity = 1;   // Rising edge
uart_config1.rxBitSwap         = true; // LSB first (standard UART)
```

### Step 2 — Add and configure the UART RX Op block

```javascript
const uart_rx_op = scripting.addModule("/pru_blocks/pru_io_blocks/uart_rx_op", {}, false);
const uart_rx_op1 = uart_rx_op.addInstance();
uart_rx_op1.$name       = "PRU_UART_RX_OP_0";
uart_rx_op1.rxFrameSize = 18;          // 16 data bits + start + stop = 18
uart_rx_op1.uartConfig  = uart_config1; // Link to config block
```

### Step 3 — Connect control flow and data

```javascript
// Control flow: config must run before op
scripting.connect(uart_config1, "next", uart_rx_op1, "prev");

// Data: connect op output to downstream block
scripting.connect(uart_rx_op1, "output1", next_block, "input1");

// Control flow out of op
scripting.connect(uart_rx_op1, "next", next_block, "prev");
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| rxFrameSize | Integer | 3–64 | 10 | Total frame bits (dataBits + 2). Values > 32 use 64-bit output port |

All other RX parameters (channel, baud rate, oversample, bit order, start bit polarity) are
read from the paired `UART Config` block — do not duplicate them here.

### Output Port Type by Frame Size

| rxFrameSize | Data Bits | Output Port | Notes |
|-------------|-----------|-------------|-------|
| 3–32 | 1–30 | 32-bit (output32) | Single register output |
| 33–64 | 31–62 | 64-bit (output64) | Two consecutive registers; downstream block must accept 64-bit input |

### Common Frame Sizes

| Protocol | Data Bits | rxFrameSize |
|----------|-----------|-------------|
| Standard UART 8-bit | 8 | 10 |
| UART 16-bit payload | 16 | 18 |
| UART 24-bit payload | 24 | 26 |
| UART 30-bit payload | 30 | 32 |
| UART 31-bit payload (extended) | 31 | 33 |

### Important Notes

1. **UART Config must appear before UART RX Op** in the control flow (connect config "next" to op "prev").

2. **rxFrameSize > 32 activates extended mode** — output port becomes 64-bit. Downstream blocks must be wired to accept a 64-bit input.

3. **No peripheral register writes in this block** — only rx_en assert/de-assert and the bit polling loop. All register setup is in `UART Config`.

4. **uartConfig linkage is mandatory** — always set `uart_rx_op1.uartConfig = uart_config1` or the block will error during validation.