# Simulation Settings

The **Simulation Settings** module lets you run a software simulation of your PRU block design without any hardware. You configure the PRU clock frequency, how many cycles to run, which output (GPO) signals to display, and what input (GPI) data to inject. After configuration, the tool executes your PRU instructions and shows the resulting waveforms in the Simulation tab.

---

## Configuration Parameters

### PRU Clock Frequency

Select the PRU core clock frequency that matches your target hardware:

| Frequency | Cycle Period |
|-----------|-------------|
| 200 MHz   | 5 ns/cycle  |
| 225 MHz   | 4.44 ns/cycle |
| 250 MHz   | 4 ns/cycle  |
| 300 MHz   | 3.33 ns/cycle |
| 333.333 MHz | 3 ns/cycle |

> **Important:** This value must match the **Core Clk** setting in your R5F or A53 PRUICSS driver configuration in SysConfig (`TI Drivers & Middleware → PRUICSS → Core Clk`). A mismatch causes incorrect timing for SPI, ADC, and other time-sensitive blocks.

---

### Number of PRU Cycles to Simulate

The total number of PRU clock cycles to execute. The default is **2000 cycles**. Increase this for longer transactions (e.g., multiple SPI frames) or if your waveform gets cut off before the transaction completes.

---

## Output Simulation — Select R30 (GPO) Signals

Use **"Select R30 (Output) Signals To Display In Simulation Window"** to choose which GPO pins appear in the waveform viewer. These are the signals driven by your PRU blocks — for example, SCLK, chip select (CS), and serial data out (SDO).

You can select any combination of `PRU_GPO_0` through `PRU_GPO_19`.

---

## Input Simulation — Select R31 (GPI) Signals

Use **"Select R31 (Input) Signals To Configure And Display In Simulation"** to select which GPI pins have simulated input data injected during the simulation run.

When you select a GPI pin, additional fields appear underneath it. For each pin you can choose between two input modes:

---

### Timestamp Mode

Define the exact PRU cycle numbers at which the bit value changes.

| Field | Description |
|-------|-------------|
| **GPI_N Input Cycles** | JSON array of cycle numbers where the bit changes. Example: `[38, 52, 66, 80]` |
| **GPI_N Input Values** | JSON array of bit values (0 or 1) at each timestamp. Example: `[1, 0, 1, 0]` |
| **GPI_N Repeat Last Bit** | When enabled, the final bit value is held for all remaining simulation cycles |

**Rules:**
- Cycle numbers must be positive integers (minimum 1) in strictly ascending order.
- Values array must be the same length as the cycles array.
- All values must be 0 or 1.

**Example — injecting the byte `0xAA` (10101010) over SPI with a 14-cycle bit period:**

```
Input Cycles: [38, 52, 66, 80, 94, 108, 122, 136]
Input Values: [1, 0, 1, 0, 1, 0, 1, 0]
```

Each bit is presented 14 cycles after the previous one (matching a 7-cycle high / 7-cycle low SCLK period at 200 MHz ≈ 70 ns/bit).

---

### Pattern Mode

Define a repeating bit pattern. The tool plays the pattern from a start cycle and repeats it a specified number of times.

| Field | Description |
|-------|-------------|
| **GPI_N Bit Pattern** | JSON array of bits to play. Example: `[0, 1, 1, 0, 1, 0, 0, 1]` |
| **GPI_N Pattern Start Cycle** | PRU cycle at which the pattern begins (minimum 1) |
| **GPI_N Pattern Repeat Count** | How many times the pattern repeats (minimum 1) |

**Rules:**
- Pattern array must not be empty and may only contain 0s and 1s.
- Start cycle must be a positive integer.

**Example — generating a clock-like signal:**

```
Bit Pattern:          [0, 0, 0, 1, 1, 1]
Pattern Start Cycle:  50
Pattern Repeat Count: 10
```

This produces 3 cycles LOW followed by 3 cycles HIGH, repeated 10 times (60 total cycles) starting at cycle 50.

---

## Example: SPI Loopback Simulation

This example shows how to use the simulation to verify that data read from an SPI device is correctly forwarded to an SPI write output — entirely in software, without hardware.

### What the design does

```
[Simulated GPI1 input] → [SPI Read block] → [SPI Write block] → [GPO4 output (SDO)]
```

1. The **SPI Read block** clocks in serial data from `PRU_GPI_1` (simulated).
2. The read data is passed directly to the **SPI Write block** via a block connection.
3. The SPI Write block drives the same data back out on `PRU_GPO_4` (SDO).
4. The Simulation tab shows both `PRU_GPO_0` (SCLK from the SPI Read block) and `PRU_GPO_4` (SDO from the SPI Write block), letting you verify the loopback visually.

### Step 1 — Add the blocks

Add the following three blocks to the canvas from the block library:

| Block | Location in library |
|-------|-------------------|
| **SPI Read** | PRU IO Blocks → SPI Read |
| **SPI Write** | PRU IO Blocks → SPI Write |
| **Flow Control** | Program Control → Flow Control |

---

### Step 2 — Configure each block

**SPI Read block** — leave all settings at their defaults:

| Pin | Default assignment |
|-----|--------------------|
| SCLK Signal | `PRU_GPO_0` |
| CS Signal | `PRU_GPO_1` |
| SDI Signal | `PRU_GPI_1` |

No changes are needed. The SPI Read block will clock in serial data from `PRU_GPI_1`, which is the pin we will simulate.

---

**SPI Write block** — change two pin assignments:

| Setting | Value |
|---------|-------|
| SDO Signal | `PRU_GPO_4` |
| CS Signal | `PRU_GPO_5` |

The SDO and CS are moved to GPO4/GPO5 so they do not conflict with the SPI Read block's SCLK (GPO0) and CS (GPO1) signals.

---

**Flow Control block** — leave at default settings. This block loops the PRU program back to the beginning so the SPI read/write sequence repeats continuously.

---

### Step 3 — Connect the blocks

Make the following two connections on the canvas:

1. **SPI Read `output1` → SPI Write `input1`**
   This passes the data received by the SPI Read block directly into the SPI Write block, creating the loopback.

2. **SPI Write `next` → Flow Control `prev`**
   This places the Flow Control block after the SPI Write block in the execution chain, causing the program to loop.

The resulting block chain is:

```
[SPI Read] --output1/input1--> [SPI Write] --next/prev--> [Flow Control]
```

### Step 4 — Configure Simulation Settings

**Output signals to display:**
- `PRU_GPO_0` — SCLK (generated by SPI Read)
- `PRU_GPO_4` — SDO (driven by SPI Write, mirrors the received data)

**Input signal to simulate:**
- Select `PRU_GPI_1` under **Select R31 (Input) Signals**
- Mode: **Timestamp Mode**

| Field | Value |
|-------|-------|
| GPI1 Input Cycles | `[38, 52, 66, 80, 94, 108, 122, 136]` |
| GPI1 Input Values | `[1, 0, 1, 0, 1, 0, 1, 0]` |

This injects the byte `0xAA` (binary `10101010`) onto GPI1. The cycle spacing of 14 cycles matches the default SPI Read clock period (7 cycles high + 7 cycles low) at 200 MHz.

**PRU Clock Frequency:** 200 MHz
**Cycles to Simulate:** 2000 (sufficient to capture one full 8-bit SPI frame)

### Step 5 — Run the simulation and check the results

On the Simulation tab you should see:
- **GPO0 (SCLK):** a square wave that toggles 8 times as the SPI Read block clocks in the 8 bits.
- **GPO4 (SDO):** the SPI Write block reproduces the same `0xAA` pattern on its output, confirming the loopback path works correctly.

---

## Terminology

| Term | Meaning |
|------|---------|
| **R30** | PRU output register — each bit drives a GPO pin |
| **R31** | PRU input register — each bit reflects a GPI pin state |
| **GPO** | General Purpose Output — a pin driven by the PRU |
| **GPI** | General Purpose Input — a pin read by the PRU |
| **Timestamp Mode** | Define signal transitions at specific PRU cycle numbers |
| **Pattern Mode** | Define a repeating bit sequence with a start cycle and repeat count |
| **SCLK** | Serial Clock — the clock signal generated by an SPI master block |
| **SDO / SDI** | Serial Data Out / Serial Data In — SPI data lines |
