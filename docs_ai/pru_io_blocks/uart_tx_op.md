## UART TX Op (Per-Transmission Operation)

### Purpose
Transmits one UART frame using the ENDAT peripheral. This block handles only the
per-transmission work: frame construction, FIFO loading, start trigger, and wait for
TX complete. **The `UART Config` block (with TX Config enabled) must appear earlier in
the control flow** to set up the peripheral registers before this block is called.

### Generated Sequence
1. Per-command reinit (R31 bit 19) — clears FIFO and state machines (TRM-mandated order: reinit before de-asserting rx_en)
2. Poll reinit busy bit (R31[5/13/21] for CH0/CH1/CH2)
3. De-assert rx_en (R30.b3 = 0x00)
4. Channel select + clk_mode write to R30.w2
5. Frame construction — insert start bit, shift data bits, insert stop bit (LSB or MSB order)
6. FIFO load — 1–4 bytes for single-shot (dataBits ≤ 29); 4 bytes + continuous polling for dataBits 30–32; 4 bytes + byte 5 polling for dataBits 33–62
7. Start transmission (R31 bit 18 = tx_channel_go)
8. Wait for TX complete (poll R31[5/13/21] busy bit)

### No Peripheral Register Writes
No GPCFG, TXCFG, or CH_CFG0 writes — those are handled once by `UART Config`.
This means the op block is suitable for repeated calls in a loop with minimal overhead.

### Input Port
The input register size depends on the configured Data Bits:

| Data Bits | Input Port Type | Register(s) |
|-----------|-----------------|-------------|
| 1–32 bits | **32-bit** (input32) | 1 register (Rx) |
| 33–62 bits | **64-bit** (input64) | 2 consecutive registers (Rx:Rx+1) |

- **input1** (32-bit mode): data word to transmit in a single register
- **input1** (64-bit mode): data in two consecutive registers — lower 32 bits in the allocated register, upper bits in the next register

### Configuration
All TX parameters (channel, baud rate, bit order, start/stop polarity) are automatically
read from the paired `UART Config` block. Only `Data Bits` is set on this block directly,
since it determines the input port type (32-bit vs 64-bit) which the register allocator
needs to know at design time.

### Data Bits
- Number of payload bits to transmit (excluding start and stop bits)
- Range: 1–62
- dataBits ≤ 29: single-shot mode, 1–4 FIFO bytes
- dataBits 30–32: specific-bit mode, 4–5 FIFO bytes
- dataBits 33–62: continuous mode, 5+ FIFO bytes with polling

### Calculation Example
- UART Config: 192 MHz clock, 12 MHz baud, LSB first, start=1, stop=0
- Data Bits: 16 → frame = start(1) + 16 data bits + stop(0) = 18 bits → 3 FIFO bytes
- Frame size written to CH_CFG0 by config block: 18 (dataBits + 2)

### Terminology
- **Per-command Reinit**: Reinit triggered before every TX to clear FIFO and reset state machines
- **FIFO**: 32-bit TX FIFO in the ENDAT peripheral — data bytes pushed via R30[7:0]
- **tx_channel_go**: R31 bit 18 — triggers transmission of the loaded FIFO content
- **Busy bit**: R31[5/13/21] — 1 = last bit still on wire, 0 = TX complete
- **Single-shot**: TX_FRAME_SIZE set in CH_CFG0 — hardware stops after exactly that many bits
- **Continuous mode**: TX_FRAME_SIZE = 0 — hardware transmits until FIFO is empty

---

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the UART TX Op block in a .syscfg file.

**CRITICAL**: The UART TX Op block requires a paired `UART Config` block with TX enabled.
The op block reads all TX parameters (channel, baud rate, bit order, start/stop polarity)
from the config block automatically. Only `Data Bits` is set on the op block itself.

### Step 1 — Add and configure a UART Config block (TX enabled)

```javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();
uart_config1.$name     = "PRU_UART_CONFIG_0";
uart_config1.enableTX  = true;
uart_config1.enableRX  = false;        // TX-only or TX+RX — set as needed
uart_config1.txChannel         = 0;    // Channel 0 (GPO0=CLK, GPO1=DOUT, GPO2=OE)
uart_config1.txClockSource     = 0;    // 192 MHz (UART_CLK)
uart_config1.txBaudRate        = 12;   // 12 MHz
uart_config1.txStartBitPolarity = 1;   // Start bit = 1 (high)
uart_config1.txStopBitPolarity  = 0;   // Stop bit = 0 (low)
uart_config1.txBitSwap         = true; // LSB first (standard UART)
```

### Step 2 — Add and configure the UART TX Op block

```javascript
const uart_tx_op = scripting.addModule("/pru_blocks/pru_io_blocks/uart_tx_op", {}, false);
const uart_tx_op1 = uart_tx_op.addInstance();
uart_tx_op1.$name      = "PRU_UART_TX_OP_0";
uart_tx_op1.dataBits   = 16;            // 16 data payload bits
uart_tx_op1.uartConfig = uart_config1;  // Link to config block
```

### Step 3 — Connect control flow and data

```javascript
// Control flow: config must run before op
scripting.connect(uart_config1, "next", uart_tx_op1, "prev");

// Data: connect upstream data source to op input
scripting.connect(data_source_block, "output1", uart_tx_op1, "input1");

// Control flow out of op
scripting.connect(uart_tx_op1, "next", next_block, "prev");
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| dataBits | Integer | 1–62 | 8 | Number of data payload bits. Determines input port type (32-bit vs 64-bit) |

All other TX parameters (channel, baud rate, bit order, start/stop polarity) are
read from the paired `UART Config` block — do not duplicate them here.

### Input Port Type by Data Bits

| dataBits | Input Port | Notes |
|----------|------------|-------|
| 1–32 | 32-bit (input32) | Single register input |
| 33–62 | 64-bit (input64) | Two consecutive registers; upstream block must produce 64-bit output |

### Common Data Bit Configurations

| Protocol | Data Bits | Frame Bits (dataBits+2) | Mode |
|----------|-----------|------------------------|------|
| Standard UART 8-bit | 8 | 10 | Single-shot |
| 16-bit payload | 16 | 18 | Single-shot |
| 24-bit payload | 24 | 26 | Single-shot |
| 29-bit payload | 29 | 31 | Single-shot (max single-shot) |
| 30-bit payload | 30 | 32 | Specific-bit mode |
| 32-bit payload | 32 | 34 | Specific-bit mode |
| 33-bit payload | 33 | 35 | Continuous mode |

### Important Notes

1. **UART Config must appear before UART TX Op** in the control flow (connect config "next" to op "prev").

2. **dataBits > 32 activates continuous mode** — input port becomes 64-bit. The upstream data source block must produce a 64-bit output.

3. **No peripheral register writes in this block** — only per-command reinit, frame construction, FIFO load, and TX trigger. All register setup is in `UART Config`.

4. **uartConfig linkage is mandatory** — always set `uart_tx_op1.uartConfig = uart_config1` or the block will error during validation.

5. **All UART TX Op instances must use the same dataBits value** — `UART Config` uses the first instance's dataBits for TX_FRAME_SIZE configuration. Mismatched instances will generate incorrect assembly.