## UART Config (Combined TX + RX Hardware Configuration)

### Purpose
Configures the PRU-ICSS ENDAT peripheral for UART TX, RX, or both. Run this block
**once at init**. A single Global Reinit covers both TX and RX setup.

Use the **UART TX Op** block (`uart_tx_op`) for per-transmission operations and the
**UART RX Op** block (`uart_rx_op`) for per-reception operations.

### Generated Sequence
1. Global Reinit (`r31` bit 19) FIRST — flushes FIFO and state machines (TRM-mandated order)
2. Poll busy bit — deterministic wait for reinit completion
3. De-assert `rx_en` AFTER reinit — handles stuck `rx_en` from a previous run
4. GPCFG write — enable peripheral interface mode (once, shared by TX and RX)
5. *(if TX enabled)* TXCFG write, TX `CH_CFG0` write, `r30.w2` channel select + `clk_mode=1`
6. *(if RX enabled)* RXCFG write, RX `CH_CFG0` write

### Important Constraints
- At least one of **Enable TX Config** or **Enable RX Config** must be enabled.
- Only one instance per design (`maxInstances: 1`).
- GPCFG is written once regardless of whether TX-only, RX-only, or both are enabled.
- TX and RX can use **different channels** (e.g., TX on CH0, RX on CH2).

---

## How to Configure (For AI / Scripting)

### Example `.syscfg` File (Reference)

```javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();

uart_config1.$name              = "PRU_UART_CONFIG_0";
uart_config1.txClockSource      = 1;    // 200 MHz (CORE_CLK)
uart_config1.txBaudRate         = 25;   // 25 MHz
uart_config1.txStartBitPolarity = 0;    // Low / Space
uart_config1.txStopBitPolarity  = 1;    // High / Mark
uart_config1.txBitSwap          = false; // MSB first
// Note: RX settings also configured in the same instance if RX is enabled
uart_config1.rxChannel          = 1;    // RX on Channel 1
uart_config1.rxClockSource      = 1;    // 200 MHz
uart_config1.rxBaudRate         = 25;
uart_config1.rxOversampleSize   = 3;    // 4x oversample
uart_config1.rxStartBitPolarity = 0;    // Falling edge
uart_config1.rxBitSwap          = false; // MSB first

uart_config1.$position = [0, 0];
```

### Step-by-Step Programmatic Setup

```javascript
const uart_config = scripting.addModule("/pru_blocks/pru_io_blocks/uart_config", {}, false);
const uart_config1 = uart_config.addInstance();

// Basic identification
uart_config1.$name = "PRU_UART_CONFIG_0";

// ----- TX Config -----
uart_config1.enableTX            = true;
uart_config1.txChannel           = 0;    // TX on Channel 0
uart_config1.txClockSource       = 0;    // 0 = 192 MHz (UART_CLK), 1 = 200 MHz (CORE_CLK)
uart_config1.txBaudRate          = 12;   // 12 MHz baud rate
uart_config1.txStartBitPolarity  = 1;    // 1 = Rising / High (Mark)
uart_config1.txStopBitPolarity   = 0;    // 0 = Low / Space
uart_config1.txBitSwap           = true; // true = LSB first (standard UART)

// ----- RX Config -----
uart_config1.enableRX            = true;
uart_config1.rxChannel           = 2;    // RX on Channel 2
uart_config1.rxClockSource       = 0;    // 192 MHz
uart_config1.rxBaudRate          = 12;   // 12 MHz
uart_config1.rxOversampleSize    = 7;    // 7 = 8x oversample (best noise immunity)
uart_config1.rxStartBitPolarity  = 1;    // 1 = Rising edge
uart_config1.rxBitSwap           = true; // true = LSB first
```

---

## Configuration Parameters

### Common / System

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| `pruSelect` | Integer | `0` (PRU0), `1` (PRU1) | Auto-detected from `system.getScript("/common")` coreName (`icss_g0_pru0` / `icss_g0_pru1`) | Which PRU core this config applies to |

### TX Config (only active if `enableTX = true`)

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| `enableTX` | Boolean | `true` / `false` | `true` | Enable TX peripheral setup |
| `txChannel` | Integer | `0`, `1`, `2` | `0` | ENDAT channel for TX |
| `txClockSource` | Integer | `0` (192 MHz UART_CLK), `1` (200 MHz CORE_CLK) | `0` | Clock source for TX |
| `txBaudRate` | Integer | Any positive value (MHz) | `12` | Desired TX baud rate. Clock (`192` or `200`) must be divisible by this value |
| `txClockDivider` | Read-only | Calculated | Calculated | `(clockSource / baudRate) - 1`. Read-only |
| `txStartBitPolarity` | Integer | `0` (Low/Space), `1` (High/Mark) | `1` | Polarity of TX start bit |
| `txStopBitPolarity` | Integer | `0` (Low/Space), `1` (High/Mark) | `0` | Polarity of TX stop bit |
| `txBitSwap` | Boolean | `true` (LSB first), `false` (MSB first) | `true` | Bit order |
| `txMode` | Read-only | `"Single-shot"` / `"Continuous"` | `"Single-shot"` | Auto-selected based on data bits (`<= 29` bits = single-shot, else continuous) |

### RX Config (only active if `enableRX = true`)

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| `enableRX` | Boolean | `true` / `false` | `true` | Enable RX peripheral setup |
| `rxChannel` | Integer | `0`, `1`, `2` | `2` | ENDAT channel for RX |
| `rxClockSource` | Integer | `0` (192 MHz UART_CLK), `1` (200 MHz CORE_CLK) | `0` | Clock source for RX |
| `rxBaudRate` | Integer | Any positive value (MHz) | `12` | Desired RX baud rate. Clock must be divisible by `(baudRate * oversample)` |
| `rxClockDivider` | Read-only | Calculated | Calculated | `(clockSource / (baudRate * oversample)) - 1` |
| `rxOversampleSize` | Integer | `0` (1x), `1` (2x), `3` (4x), `7` (8x) | `7` (8x) | Samples per bit |
| `rxStartBitPolarity` | Integer | `0` (Falling Edge), `1` (Rising Edge) | `1` | Edge that indicates RX frame start |
| `rxBitSwap` | Boolean | `true` (LSB first), `false` (MSB first) | `true` | Bit order |

---

## Validation Rules

- At least one of `enableTX` or `enableRX` must be `true`.
- For TX: `clockMHz % txBaudRate` must equal `0`. The divider (`(clock / baud) - 1`) must be in `[0, 65535]`.
- For RX: `clockMHz % (txBaudRate * oversampleMul)` must equal `0`. The divider (`(clock / (baud * oversample)) - 1`) must be in `[0, 65535]`.

---

## Important Design Notes

1. **Only one UART Config block per project** (`maxInstances: 1`).
2. **Must run before TX Op or RX Op blocks** — the op blocks assume the peripheral is configured.
3. **Global Reinit is mandatory** (TRM order: Global Reinit → Poll busy → GPCFG → CH config). The macro enforces this order.
4. **RX `rxFrameSize`** is set on the `uart_rx_op` instance (not here) — the config block only sets up the peripheral registers. The `rxFrameSize` value is read by `uart_rx_op` via `getConfigInst()` to determine output port size (`32-bit` vs `64-bit`).
5. **TX `dataBits`** is read by `uart_config` from `uart_tx_op` instances (`getTxDataBits()`) — this determines whether the macro generates single-shot (`<= 29` bits) or continuous mode code.
